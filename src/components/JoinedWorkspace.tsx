import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronLeft, ChevronRight, Copy, Crosshair, Layers2, Maximize, Pause, Play, Plus, X } from 'lucide-react';
import type { EditorBoard, PixelFrame, Point, RGBA, RulerGuide, Silhouette, SpriteAsset, Tool } from '../types';
import { compositeFrame, floodFill, getBounds, paintStroke, samplePixel, snapLineEnd, snapRulerEnd, translatePixels } from '../lib/pixels';
import { IconButton } from './UI';

interface Props {
  boards: EditorBoard[]; assets: SpriteAsset[]; activeBoardId: string | null;
  view: { zoom: number; panX: number; panY: number }; guides: RulerGuide[];
  tool: Tool; rgba: RGBA; rulerColor: string; brushSize: number; grid: boolean; background: string; spaceHeld: boolean;
  fitRequestKey: string; onFitDone: () => void;
  onViewChange: (view: { zoom: number; panX: number; panY: number }) => void;
  onActivate: (id: string) => void; onPatch: (id: string, patch: Partial<EditorBoard>) => void;
  onCommit: (assetId: string, frameId: string, before: Uint8ClampedArray, after: Uint8ClampedArray, label?: string) => void;
  onPick: (color: RGBA) => void; onClose: (id: string) => void; onAppend: (board: EditorBoard) => void; onDuplicate: (board: EditorBoard) => void; onCapture: (id: string) => void;
  onOverlayChange: (boardId: string, overlayId: string, patch: Partial<Silhouette>) => void;
  onOverlayGestureStart: (boardId: string, overlayId: string) => void;
  onOverlayGestureEnd: (boardId: string, overlayId: string, patch: Partial<Silhouette> | null, cancelled: boolean) => void;
  onGuideAdd: (guide: RulerGuide) => void; onPanGesture: () => void;
}
interface Tile { board: EditorBoard; asset: SpriteAsset; frame: PixelFrame; offset: number }
type Gesture =
  | { kind: 'paint'; tile: Tile; tool: Tool; before: Uint8ClampedArray; pixels: Uint8ClampedArray; start: Point; last: Point }
  | { kind: 'move'; tile: Tile; before: Uint8ClampedArray; pixels: Uint8ClampedArray; startX: number; startY: number; zoom: number; bounds: NonNullable<ReturnType<typeof getBounds>>; dx: number; dy: number }
  | { kind: 'pan'; startX: number; startY: number; panX: number; panY: number }
  | { kind: 'overlay'; boardId: string; id: string; startX: number; startY: number; x: number; y: number; endX: number; endY: number }
  | { kind: 'ruler'; start: Point; end: Point; color: string };

function PixelCanvas({ tile, draft, revision, zoom, number }: { tile: Tile; draft: Uint8ClampedArray | null; revision: number; zoom: number; number: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const display = compositeFrame(draft ?? tile.frame.pixels, tile.asset.width, tile.asset.height, tile.board.overlays);
    ref.current?.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(display), tile.asset.width, tile.asset.height), 0, 0);
  }, [tile.frame, tile.asset.width, tile.asset.height, tile.board.overlays, draft, revision]);
  return <canvas ref={ref} width={tile.asset.width} height={tile.asset.height} style={{ width: tile.asset.width * zoom, height: tile.asset.height * zoom }} aria-label={`${number}번 칸 편집 캔버스`} data-testid={`board-canvas-${tile.board.id}`} />;
}

export default function JoinedWorkspace(props: Props) {
  const viewport = useRef<HTMLDivElement>(null), latest = useRef(props), gesture = useRef<Gesture | null>(null), pointerId = useRef<number | null>(null);
  latest.current = props;
  const [revision, setRevision] = useState(0), [cursor, setCursor] = useState<Point | null>(null);
  let offset = 0;
  const tiles = props.boards.flatMap(board => {
    const asset = props.assets.find(item => item.id === board.assetId); if (!asset) return [];
    const tile = { board, asset, frame: asset.frames[board.frameIndex], offset }; offset += asset.width; return [tile];
  });
  const width = offset, height = Math.max(1, ...tiles.map(tile => tile.asset.height)), { view } = props;
  const activeTile = tiles.find(tile => tile.board.id === props.activeBoardId) ?? tiles[0];
  const verticalEdges = new Map<number, number>();
  for (const tile of tiles) for (const x of [tile.offset, tile.offset + tile.asset.width]) verticalEdges.set(x, Math.max(verticalEdges.get(x) ?? 0, tile.asset.height));
  function fit() {
    const rect = viewport.current?.getBoundingClientRect(); if (!rect || !width) return;
    const raw = Math.min((rect.width - 48) / width, (rect.height - 48) / height);
    const zoom = Math.min(40, raw >= 1 ? Math.max(1, Math.floor(raw)) : Math.max(0.05, Math.floor(raw * 100) / 100));
    props.onViewChange({ zoom, panX: 0, panY: 0 });
  }
  useEffect(() => {
    if (!props.fitRequestKey) return;
    const handle = requestAnimationFrame(() => { fit(); props.onFitDone(); });
    return () => cancelAnimationFrame(handle);
  }, [props.fitRequestKey]);
  useEffect(() => {
    const node = viewport.current; if (!node) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); const current = latest.current.view;
      const rect = node.getBoundingClientRect(), px = event.clientX - rect.left - rect.width / 2, py = event.clientY - rect.top - rect.height / 2;
      const zoom = Math.max(0.05, Math.min(40, current.zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15))), ratio = zoom / current.zoom;
      latest.current.onViewChange({ zoom, panX: px - (px - current.panX) * ratio, panY: py - (py - current.panY) * ratio });
    };
    node.addEventListener('wheel', wheel, { passive: false }); return () => node.removeEventListener('wheel', wheel);
  }, []);
  useEffect(() => {
    const abort = () => {
      const current = gesture.current;
      if (current?.kind === 'overlay') latest.current.onOverlayGestureEnd(current.boardId, current.id, null, true);
      gesture.current = null; setRevision(value => value + 1);
      if (pointerId.current !== null && viewport.current?.hasPointerCapture(pointerId.current)) viewport.current.releasePointerCapture(pointerId.current);
      pointerId.current = null;
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && gesture.current) { event.preventDefault(); abort(); } };
    window.addEventListener('blur', abort); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('blur', abort); window.removeEventListener('keydown', key); };
  }, []);
  function world(event: { clientX: number; clientY: number }, boundary = false): Point {
    const rect = viewport.current!.getBoundingClientRect(), round = boundary ? Math.round : Math.floor;
    return { x: round((event.clientX - rect.left - rect.width / 2 - view.panX) / view.zoom + width / 2), y: round((event.clientY - rect.top - rect.height / 2 - view.panY) / view.zoom + height / 2) };
  }
  function local(point: Point, tile: Tile, clamp: boolean): Point {
    const raw = { x: point.x - tile.offset, y: point.y };
    return clamp ? { x: Math.min(tile.asset.width - 1, Math.max(0, raw.x)), y: Math.min(tile.asset.height - 1, Math.max(0, raw.y)) } : raw;
  }
  function tileAt(point: Point) { return tiles.find(tile => point.x >= tile.offset && point.x < tile.offset + tile.asset.width && point.y >= 0 && point.y < tile.asset.height); }
  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 && event.button !== 1) return;
    event.currentTarget.focus({ preventScroll: true });
    const point = world(event), tile = tileAt(point);
    const overlayMode = props.tool !== 'move' && (props.tool === 'overlay' || event.altKey);
    if (tile && !overlayMode) props.onActivate(tile.board.id);
    if (props.tool === 'pan' || props.spaceHeld || event.button === 1) {
      event.preventDefault(); props.onPanGesture(); gesture.current = { kind: 'pan', startX: event.clientX, startY: event.clientY, panX: view.panX, panY: view.panY };
    } else if (props.tool === 'ruler') {
      const raw = world(event, true); if (raw.x < 0 || raw.y < 0 || raw.x > width || raw.y > height) return;
      event.preventDefault(); gesture.current = { kind: 'ruler', start: raw, end: raw, color: props.rulerColor }; setRevision(value => value + 1);
    } else {
      if (!tile) return;
      const pos = local(point, tile, true), board = tile.board;
      if (props.tool === 'move') {
        const bounds = getBounds(tile.frame.pixels, tile.asset.width, tile.asset.height); if (!bounds) return;
        event.preventDefault(); props.onPatch(board.id, { playing: false, selectedOverlayId: null });
        const before = new Uint8ClampedArray(tile.frame.pixels);
        gesture.current = { kind: 'move', tile, before, pixels: new Uint8ClampedArray(before), startX: event.clientX, startY: event.clientY, zoom: view.zoom, bounds, dx: 0, dy: 0 };
        setRevision(value => value + 1);
      } else if (overlayMode) {
        // A board click can change the destination, but never chooses another layer implicitly.
        if (board.id !== activeTile?.board.id) { props.onActivate(board.id); return; }
        const layer = board.overlays.find(layer => layer.id === board.selectedOverlayId && layer.visible);
        if (!layer) return;
        event.preventDefault();
        props.onOverlayGestureStart(board.id, layer.id);
        props.onPatch(board.id, { selectedOverlayId: layer.id, playing: false });
        gesture.current = { kind: 'overlay', boardId: board.id, id: layer.id, startX: event.clientX, startY: event.clientY, x: layer.x, y: layer.y, endX: layer.x, endY: layer.y };
      } else {
        event.preventDefault(); props.onPatch(board.id, { playing: false });
        if (props.tool === 'picker') { props.onPick(samplePixel(tile.frame.pixels, tile.asset.width, tile.asset.height, pos.x, pos.y)); return; }
        const before = new Uint8ClampedArray(tile.frame.pixels), pixels = new Uint8ClampedArray(tile.frame.pixels);
        if (props.tool === 'fill') { floodFill(pixels, tile.asset.width, tile.asset.height, pos.x, pos.y, props.rgba); props.onCommit(tile.asset.id, tile.frame.id, before, pixels); return; }
        gesture.current = { kind: 'paint', tile, tool: props.tool, before, pixels, start: pos, last: pos };
        paintStroke(pixels, tile.asset.width, tile.asset.height, pos, pos, props.tool === 'eraser' ? [0, 0, 0, 0] : props.rgba, props.brushSize); setRevision(value => value + 1);
      }
    }
    pointerId.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const point = world(event, props.tool === 'ruler'); setCursor(point.x >= 0 && point.y >= 0 && point.x <= width && point.y <= height ? point : null);
    const current = gesture.current; if (!current) return;
    if (current.kind === 'pan') { props.onViewChange({ zoom: view.zoom, panX: current.panX + event.clientX - current.startX, panY: current.panY + event.clientY - current.startY }); return; }
    if (current.kind === 'overlay') { current.endX = Math.round(current.x + (event.clientX - current.startX) / view.zoom); current.endY = Math.round(current.y + (event.clientY - current.startY) / view.zoom); props.onOverlayChange(current.boardId, current.id, { x: current.endX, y: current.endY }); return; }
    if (current.kind === 'move') {
      const { bounds, tile } = current;
      let dx = Math.round((event.clientX - current.startX) / current.zoom);
      let dy = Math.round((event.clientY - current.startY) / current.zoom);
      if (event.shiftKey) {
        if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      dx = Math.max(-bounds.x, Math.min(tile.asset.width - bounds.x - bounds.width, dx));
      dy = Math.max(-bounds.y, Math.min(tile.asset.height - bounds.y - bounds.height, dy));
      if (dx === current.dx && dy === current.dy) return;
      current.dx = dx; current.dy = dy;
      current.pixels = translatePixels(current.before, tile.asset.width, tile.asset.height, dx, dy);
      setRevision(value => value + 1); return;
    }
    if (current.kind === 'ruler') {
      const raw = world(event, true); current.end = event.shiftKey ? snapRulerEnd(current.start, raw, width, height) : { x: Math.max(0, Math.min(width, raw.x)), y: Math.max(0, Math.min(height, raw.y)) };
    } else {
      const { tile } = current, raw = local(world(event), tile, false), pos = local(world(event), tile, true);
      if (current.tool === 'line') { current.pixels.set(current.before); const end = event.shiftKey ? snapLineEnd(current.start, raw, tile.asset.width, tile.asset.height) : pos; paintStroke(current.pixels, tile.asset.width, tile.asset.height, current.start, end, props.rgba, props.brushSize); }
      else paintStroke(current.pixels, tile.asset.width, tile.asset.height, current.last, pos, current.tool === 'eraser' ? [0, 0, 0, 0] : props.rgba, props.brushSize);
      current.last = pos;
    }
    setRevision(value => value + 1);
  }
  function finish(event: ReactPointerEvent<HTMLDivElement>, cancel = false) {
    const current = gesture.current; if (!current) return;
    if (!cancel) {
      pointerMove(event);
      if (current.kind === 'paint') props.onCommit(current.tile.asset.id, current.tile.frame.id, current.before, new Uint8ClampedArray(current.pixels));
      if (current.kind === 'move') props.onCommit(current.tile.asset.id, current.tile.frame.id, current.before, new Uint8ClampedArray(current.pixels), '그림 전체 이동');
      if (current.kind === 'ruler' && (current.start.x !== current.end.x || current.start.y !== current.end.y)) props.onGuideAdd({ id: crypto.randomUUID(), x1: current.start.x, y1: current.start.y, x2: current.end.x, y2: current.end.y, color: current.color, visible: true });
    }
    if (current.kind === 'overlay') props.onOverlayGestureEnd(current.boardId, current.id, cancel ? null : { x: current.endX, y: current.endY }, cancel);
    gesture.current = null; pointerId.current = null; setRevision(value => value + 1); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  const draft = gesture.current, selected = activeTile?.board.overlays.find(layer => layer.id === activeTile.board.selectedOverlayId && layer.visible);
  return <div className="joined-workspace">
    <div className="joined-board-controls" aria-label="비교 칸별 재생과 편집">
      {tiles.map((tile, index) => <article key={tile.board.id} className={`joined-control ${tile.board.id === props.activeBoardId ? 'is-active' : ''}`} aria-label={`${index + 1}번 비교 칸`} onPointerDown={() => props.onActivate(tile.board.id)} onFocus={() => props.onActivate(tile.board.id)}>
        <header className="board-heading"><span className="board-number">{index + 1}</span><button type="button" className="board-title" onClick={() => props.onActivate(tile.board.id)} title={tile.asset.name}>{tile.asset.name}</button><span className="board-dimensions">{tile.asset.width} × {tile.asset.height}</span><IconButton label={`${index + 1}번 칸 닫기`} onClick={() => props.onClose(tile.board.id)}><X size={15} /></IconButton></header>
        <div className="board-transport"><IconButton label="이전 프레임" onClick={() => props.onPatch(tile.board.id, { frameIndex: (tile.board.frameIndex + tile.asset.frames.length - 1) % tile.asset.frames.length, playing: false })}><ChevronLeft size={16} /></IconButton><IconButton label={tile.board.playing ? '이 칸 일시정지' : '이 칸 재생'} className={tile.board.playing ? 'playing' : ''} onClick={() => props.onPatch(tile.board.id, { playing: !tile.board.playing })}>{tile.board.playing ? <Pause size={16} /> : <Play size={16} />}</IconButton><IconButton label="다음 프레임" onClick={() => props.onPatch(tile.board.id, { frameIndex: (tile.board.frameIndex + 1) % tile.asset.frames.length, playing: false })}><ChevronRight size={16} /></IconButton><input aria-label={`${index + 1}번 칸 프레임 이동`} type="range" min={0} max={tile.asset.frames.length - 1} value={tile.board.frameIndex} onChange={event => props.onPatch(tile.board.id, { frameIndex: Number(event.target.value), playing: false })} /><span className="frame-count">{tile.board.frameIndex + 1}<span> / {tile.asset.frames.length}</span></span><select aria-label={`${index + 1}번 칸 재생 속도`} value={tile.board.speed} onChange={event => props.onPatch(tile.board.id, { speed: Number(event.target.value) })}>{[0.25, 0.5, 0.75, 1, 1.5, 2].map(speed => <option key={speed} value={speed}>{speed}×</option>)}</select></div>
        <div className="board-bottom-actions"><button type="button" onClick={() => props.onAppend(tile.board)}><Plus size={13} />옆에 고정</button><button type="button" onClick={() => props.onDuplicate(tile.board)}><Copy size={13} />복제해 편집</button><button type="button" onClick={() => props.onCapture(tile.board.id)}><Layers2 size={13} />실루엣 잡기</button></div>
      </article>)}
    </div>
    <div ref={viewport} tabIndex={0} aria-label="붙임 캔버스 편집 영역" className={`joined-viewport tool-${props.spaceHeld ? 'pan' : props.tool}`} data-testid="joined-viewport" style={{ backgroundColor: props.background === 'checker' ? '#1b2029' : props.background }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onPointerLeave={() => setCursor(null)} onContextMenu={event => event.preventDefault()}>
      <div className={`joined-strip ${props.background === 'checker' ? 'checker-dark' : ''}`} data-testid="joined-strip" style={{ width: width * view.zoom, height: height * view.zoom, transform: `translate(calc(-50% + ${view.panX}px), calc(-50% + ${view.panY}px))` }}>
        {tiles.map((tile, index) => <div key={tile.board.id} className={`joined-tile ${tile.board.id === props.activeBoardId ? 'is-active' : ''}`} data-testid={`board-viewport-${tile.board.id}`} style={{ width: tile.asset.width * view.zoom, height: tile.asset.height * view.zoom }}>
          <PixelCanvas tile={tile} draft={(draft?.kind === 'paint' || draft?.kind === 'move') && draft.tile.board.id === tile.board.id && draft.tile.frame.id === tile.frame.id ? draft.pixels : null} revision={revision} zoom={view.zoom} number={index + 1} />
          {props.grid && view.zoom >= 5 && <div className="pixel-grid" style={{ backgroundSize: `${view.zoom}px ${view.zoom}px` }} />}
        </div>)}
        {selected && activeTile && <div className="overlay-selection joined-overlay-selection" style={{ left: (activeTile.offset + selected.x) * view.zoom, top: selected.y * view.zoom, width: selected.width * selected.scale * view.zoom, height: selected.height * selected.scale * view.zoom }} />}
        <svg className="ruler-layer" data-testid="ruler-layer" width={width * view.zoom} height={height * view.zoom} viewBox={`0 0 ${width} ${height}`} aria-label="비교용 자 가이드">
          <g data-testid="canvas-boundaries" className="canvas-boundaries" stroke="#7da9da" strokeWidth={1}>
            <line data-testid="canvas-boundary-top" x1={0} y1={0} x2={width} y2={0} vectorEffect="non-scaling-stroke" />
            {[...verticalEdges].map(([x, edgeHeight]) => <line key={x} data-testid={`canvas-boundary-${x}`} x1={x} y1={0} x2={x} y2={edgeHeight} vectorEffect="non-scaling-stroke" stroke={activeTile && (x === activeTile.offset || x === activeTile.offset + activeTile.asset.width) ? '#93c7ff' : '#7da9da'} />)}
            {tiles.map(tile => <line key={tile.board.id} data-testid={`canvas-boundary-bottom-${tile.board.id}`} x1={tile.offset} y1={tile.asset.height} x2={tile.offset + tile.asset.width} y2={tile.asset.height} vectorEffect="non-scaling-stroke" stroke={tile.board.id === props.activeBoardId ? '#93c7ff' : '#7da9da'} />)}
          </g>
          {props.guides.filter(guide => guide.visible).map(guide => <line key={guide.id} data-testid={`ruler-guide-${guide.id}`} x1={guide.x1} y1={guide.y1} x2={guide.x2} y2={guide.y2} stroke={guide.color} strokeWidth={1} vectorEffect="non-scaling-stroke" />)}
          {draft?.kind === 'ruler' && <line data-testid="ruler-preview" x1={draft.start.x} y1={draft.start.y} x2={draft.end.x} y2={draft.end.y} stroke={draft.color} strokeWidth={1} vectorEffect="non-scaling-stroke" />}
        </svg>
      </div>
      <div className="viewport-coordinate">{cursor ? `${cursor.x}, ${cursor.y}` : `${width} × ${height} px`}<span>{Math.round(view.zoom * 100)}%</span></div>
      <div className="joined-stage-note">캔버스 붙임 · 확대와 이동을 함께 조절합니다</div>
      <div className="viewport-actions" onPointerDown={event => event.stopPropagation()}><label className="joined-zoom-field"><input type="number" aria-label="공통 확대 (%)" min={5} max={4000} value={Math.round(view.zoom * 100)} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 5 && value <= 4000) props.onViewChange({ ...view, zoom: value / 100 }); }} /><span>%</span></label><IconButton label="전체 캔버스 화면에 맞춤" onClick={fit}><Maximize size={15} /></IconButton><IconButton label="100% 보기" onClick={() => props.onViewChange({ zoom: 1, panX: 0, panY: 0 })}><Crosshair size={15} /></IconButton></div>
    </div>
  </div>;
}
