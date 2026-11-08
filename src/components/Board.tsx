import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronLeft, ChevronRight, Copy, Crosshair, Layers2, Maximize, Pause, Play, Plus, X } from 'lucide-react';
import type { EditorBoard, Point, RGBA, Silhouette, SpriteAsset, Tool } from '../types';
import { compositeFrame, floodFill, paintStroke, samplePixel, snapLineEnd } from '../lib/pixels';
import { IconButton } from './UI';

interface Props {
  board: EditorBoard; asset: SpriteAsset; number: number; active: boolean; tool: Tool; rgba: RGBA; brushSize: number;
  grid: boolean; background: string; spaceHeld: boolean; fitOnMount: boolean;
  onActivate: () => void; onPatch: (patch: Partial<EditorBoard>) => void;
  onCommit: (frameId: string, before: Uint8ClampedArray, after: Uint8ClampedArray) => void;
  onPick: (color: RGBA) => void; onClose: () => void; onAppend: () => void; onDuplicate: () => void; onCapture: () => void;
  onOverlayChange: (id: string, patch: Partial<Silhouette>) => void; onFitDone: () => void; onPanGesture: () => void;
}
type Gesture =
  | { kind: 'paint'; frameId: string; tool: Tool; before: Uint8ClampedArray; pixels: Uint8ClampedArray; start: Point; last: Point }
  | { kind: 'pan'; startX: number; startY: number; panX: number; panY: number }
  | { kind: 'overlay'; id: string; startX: number; startY: number; x: number; y: number };

export default function Board(props: Props) {
  const { board, asset, number, active, tool, rgba, brushSize, grid, background } = props;
  const frame = asset.frames[Math.min(board.frameIndex, asset.frames.length - 1)];
  const viewport = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), gesture = useRef<Gesture | null>(null);
  const latest = useRef(props); latest.current = props;
  const [draftVersion, setDraftVersion] = useState(0), [cursor, setCursor] = useState<Point | null>(null);
  const selected = board.overlays.find(overlay => overlay.id === board.selectedOverlayId && overlay.visible);

  useLayoutEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    const current = gesture.current;
    const pixels = current?.kind === 'paint' && current.frameId === frame.id ? current.pixels : frame.pixels;
    const display = compositeFrame(pixels, asset.width, asset.height, board.overlays);
    ctx.putImageData(new ImageData(new Uint8ClampedArray(display), asset.width, asset.height), 0, 0);
  }, [frame, asset.width, asset.height, board.overlays, draftVersion]);

  const fit = () => {
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect) return;
    const raw = Math.min((rect.width - 40) / asset.width, (rect.height - 40) / asset.height);
    const zoom = Math.min(40, raw >= 1 ? Math.max(1, Math.floor(raw)) : Math.max(0.05, Math.floor(raw * 100) / 100));
    props.onPatch({ zoom, panX: 0, panY: 0 });
  };
  useEffect(() => {
    if (!props.fitOnMount) return;
    const handle = requestAnimationFrame(() => { fit(); props.onFitDone(); });
    return () => cancelAnimationFrame(handle);
  }, [props.fitOnMount]);

  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const { board: current, onPatch, onActivate } = latest.current;
      onActivate();
      const rect = node.getBoundingClientRect(), px = event.clientX - rect.left - rect.width / 2, py = event.clientY - rect.top - rect.height / 2;
      const zoom = Math.max(0.05, Math.min(40, current.zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15))), ratio = zoom / current.zoom;
      onPatch({ zoom, panX: px - (px - current.panX) * ratio, panY: py - (py - current.panY) * ratio });
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, []);

  function point(event: { clientX: number; clientY: number }, clamp = true): Point {
    const rect = viewport.current!.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left - rect.width / 2 - board.panX) / board.zoom + asset.width / 2);
    const y = Math.floor((event.clientY - rect.top - rect.height / 2 - board.panY) / board.zoom + asset.height / 2);
    return clamp ? { x: Math.min(asset.width - 1, Math.max(0, x)), y: Math.min(asset.height - 1, Math.max(0, y)) } : { x, y };
  }
  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 && event.button !== 1) return;
    props.onActivate();
    const pos = point(event, false);
    if (tool === 'pan' || props.spaceHeld || event.button === 1) {
      event.preventDefault(); props.onPanGesture();
      gesture.current = { kind: 'pan', startX: event.clientX, startY: event.clientY, panX: board.panX, panY: board.panY };
      event.currentTarget.setPointerCapture(event.pointerId); return;
    }
    if (tool === 'overlay' || event.altKey) {
      const overlay = selected ?? [...board.overlays].reverse().find(layer => layer.visible && pos.x >= layer.x && pos.y >= layer.y && pos.x < layer.x + layer.width * layer.scale && pos.y < layer.y + layer.height * layer.scale);
      if (!overlay) return;
      props.onPatch({ selectedOverlayId: overlay.id, playing: false });
      gesture.current = { kind: 'overlay', id: overlay.id, startX: event.clientX, startY: event.clientY, x: overlay.x, y: overlay.y };
      event.currentTarget.setPointerCapture(event.pointerId); return;
    }
    if (pos.x < 0 || pos.y < 0 || pos.x >= asset.width || pos.y >= asset.height) return;
    event.preventDefault(); props.onPatch({ playing: false });
    if (tool === 'picker') { props.onPick(samplePixel(frame.pixels, asset.width, asset.height, pos.x, pos.y)); return; }
    const before = new Uint8ClampedArray(frame.pixels), pixels = new Uint8ClampedArray(frame.pixels);
    if (tool === 'fill') { floodFill(pixels, asset.width, asset.height, pos.x, pos.y, rgba); props.onCommit(frame.id, before, pixels); return; }
    gesture.current = { kind: 'paint', tool, frameId: frame.id, before, pixels, start: pos, last: pos };
    paintStroke(pixels, asset.width, asset.height, pos, pos, tool === 'eraser' ? [0, 0, 0, 0] : rgba, brushSize);
    setDraftVersion(value => value + 1); event.currentTarget.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const raw = point(event, false);
    setCursor(raw.x >= 0 && raw.y >= 0 && raw.x < asset.width && raw.y < asset.height ? raw : null);
    const current = gesture.current;
    if (!current) return;
    if (current.kind === 'pan') { props.onPatch({ panX: current.panX + event.clientX - current.startX, panY: current.panY + event.clientY - current.startY }); return; }
    if (current.kind === 'overlay') { props.onOverlayChange(current.id, { x: Math.round(current.x + (event.clientX - current.startX) / board.zoom), y: Math.round(current.y + (event.clientY - current.startY) / board.zoom) }); return; }
    const pos = current.tool === 'line' && event.shiftKey ? raw : point(event);
    if (current.tool === 'line') {
      current.pixels.set(current.before);
      const end = event.shiftKey ? snapLineEnd(current.start, pos, asset.width, asset.height) : pos;
      paintStroke(current.pixels, asset.width, asset.height, current.start, end, rgba, brushSize);
    } else paintStroke(current.pixels, asset.width, asset.height, current.last, pos, current.tool === 'eraser' ? [0, 0, 0, 0] : rgba, brushSize);
    current.last = pos; setDraftVersion(value => value + 1);
  }
  function finish(event: ReactPointerEvent<HTMLDivElement>, cancel = false) {
    const current = gesture.current;
    if (!current) return;
    if (!cancel && current.kind === 'paint') { pointerMove(event); props.onCommit(current.frameId, current.before, new Uint8ClampedArray(current.pixels)); }
    gesture.current = null; setDraftVersion(value => value + 1);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  const canvasStyle = { width: asset.width * board.zoom, height: asset.height * board.zoom, transform: `translate(calc(-50% + ${board.panX}px), calc(-50% + ${board.panY}px))` };
  return <article className={`editor-board ${active ? 'is-active' : ''}`} aria-label={`${number}번 비교 칸`} onFocus={props.onActivate}>
    <header className="board-heading" onClick={props.onActivate}>
      <span className="board-number">{number}</span><span className="board-title" title={asset.name}>{asset.name}</span>
      <span className="board-dimensions">{asset.width} × {asset.height}</span><IconButton label={`${number}번 칸 닫기`} onClick={props.onClose}><X size={15} /></IconButton>
    </header>
    <div ref={viewport} className={`board-viewport tool-${props.spaceHeld ? 'pan' : tool}`} data-testid={`board-viewport-${board.id}`} style={{ backgroundColor: background === 'checker' ? '#1b2029' : background }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onPointerLeave={() => setCursor(null)} onContextMenu={event => event.preventDefault()}>
      <div className={`canvas-surface ${background === 'checker' ? 'checker-dark' : ''}`} style={canvasStyle}>
        <canvas ref={canvas} width={asset.width} height={asset.height} aria-label={`${number}번 칸 편집 캔버스`} data-testid={`board-canvas-${board.id}`} />
        {grid && board.zoom >= 5 && <div className="pixel-grid" style={{ backgroundSize: `${board.zoom}px ${board.zoom}px` }} />}
        {selected && <div className="overlay-selection" style={{ left: selected.x * board.zoom, top: selected.y * board.zoom, width: selected.width * selected.scale * board.zoom, height: selected.height * selected.scale * board.zoom }} />}
      </div>
      <div className="viewport-coordinate">{cursor ? `${cursor.x}, ${cursor.y}` : `${Math.round(board.zoom * 100)}%`}</div>
      <div className="viewport-actions" onPointerDown={event => event.stopPropagation()}><IconButton label="화면에 맞춤" onClick={fit}><Maximize size={15} /></IconButton><IconButton label="100% 보기" onClick={() => props.onPatch({ zoom: 1, panX: 0, panY: 0 })}><Crosshair size={15} /></IconButton></div>
    </div>
    <div className="board-transport">
      <IconButton label="이전 프레임" onClick={() => props.onPatch({ frameIndex: (board.frameIndex + asset.frames.length - 1) % asset.frames.length, playing: false })}><ChevronLeft size={16} /></IconButton>
      <IconButton label={board.playing ? '이 칸 일시정지' : '이 칸 재생'} className={board.playing ? 'playing' : ''} onClick={() => props.onPatch({ playing: !board.playing })}>{board.playing ? <Pause size={16} /> : <Play size={16} />}</IconButton>
      <IconButton label="다음 프레임" onClick={() => props.onPatch({ frameIndex: (board.frameIndex + 1) % asset.frames.length, playing: false })}><ChevronRight size={16} /></IconButton>
      <input type="range" aria-label={`${number}번 칸 프레임 이동`} min={0} max={asset.frames.length - 1} value={board.frameIndex} onChange={event => props.onPatch({ frameIndex: Number(event.target.value), playing: false })} />
      <span className="frame-count">{board.frameIndex + 1}<span> / {asset.frames.length}</span></span>
      <select aria-label={`${number}번 칸 재생 속도`} value={board.speed} onChange={event => props.onPatch({ speed: Number(event.target.value) })}>{[0.25, 0.5, 0.75, 1, 1.5, 2].map(speed => <option key={speed} value={speed}>{speed}×</option>)}</select>
    </div>
    <div className="board-bottom-actions"><button type="button" title="현재 프레임을 같은 파일의 새 비교 칸에 고정합니다. 수정 내용은 공유됩니다." onClick={props.onAppend}><Plus size={13} />옆에 고정</button><button type="button" title="현재 프레임을 독립된 이미지로 복제합니다." onClick={props.onDuplicate}><Copy size={13} />복제해 편집</button><button type="button" onClick={props.onCapture}><Layers2 size={13} />실루엣 잡기</button></div>
  </article>;
}
