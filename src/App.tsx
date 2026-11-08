import { Component, useCallback, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronRight, Download, Eraser, FileImage, FolderOpen, Grid2X2, Hand, HelpCircle, ImagePlus, Layers2, Maximize2, Menu, Minus, PaintBucket, Pencil, Pipette, Play, Plus, Redo2, Save, Slash, Undo2, Upload, X } from 'lucide-react';
import type { EditorBoard, PixelFrame, RGBA, Silhouette, SpriteAsset, Tool, WorkspaceProject } from './types';
import { compositeFrame, makeSilhouette } from './lib/pixels';
import { decodeGif, decodePng, encodeGif, encodePng, encodeSpriteSheet, splitSpriteSheet } from './lib/formats';
import { deserializeProject, serializeProject } from './lib/project';
import Board from './components/Board';
import Inspector from './components/Inspector';
import { IconButton, Modal, NumberField, PixelPreview } from './components/UI';

const id = () => crypto.randomUUID();
const emptyProject = (): WorkspaceProject => ({ version: 1, assets: [], boards: [], activeBoardId: null });
const tools: { id: Tool; label: string; shortcut: string; icon: typeof Hand }[] = [
  { id: 'pan', label: '화면 이동', shortcut: 'P', icon: Hand }, { id: 'pencil', label: '연필', shortcut: 'B', icon: Pencil },
  { id: 'line', label: '직선', shortcut: 'L', icon: Slash }, { id: 'eraser', label: '지우개', shortcut: 'E', icon: Eraser },
  { id: 'picker', label: '스포이트', shortcut: 'I', icon: Pipette }, { id: 'fill', label: '채우기', shortcut: 'F', icon: PaintBucket },
  { id: 'overlay', label: '실루엣 이동', shortcut: 'O', icon: Layers2 },
];
const hexFromColor = (rgba: RGBA) => '#' + rgba.slice(0, 3).map(value => Math.round(value).toString(16).padStart(2, '0')).join('');
const rgbaFromHex = (hex: string, alpha = 255): RGBA => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), alpha];
function download(blob: Blob, name: string) { const link = document.createElement('a'), url = URL.createObjectURL(blob); link.href = url; link.download = name; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
const fileBase = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*]/g, '-');
const inputFocused = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input, select, textarea, [contenteditable="true"]');
interface HistoryEntry { before: Uint8ClampedArray; after: Uint8ClampedArray; sequence: number }
interface History { undo: HistoryEntry[]; redo: HistoryEntry[] }
type Dialog = 'new' | 'sheet' | 'export' | 'help' | null;

class ErrorBoundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error(error, info); }
  render() { return this.state.error ? <main className="fatal-error"><h1>화면을 여는 중 문제가 생겼어요.</h1><p>저장한 작업 파일이 있다면 다시 열어 이어서 작업할 수 있습니다.</p><button type="button" onClick={() => location.reload()}>작업실 다시 열기</button></main> : this.props.children; }
}
export default function App() { return <ErrorBoundary><Workbench /></ErrorBoundary>; }

function Workbench() {
  const [project, setProject] = useState<WorkspaceProject>(emptyProject), projectRef = useRef(project); projectRef.current = project;
  const [tool, setTool] = useState<Tool>('pencil'), [rgba, setRGBA] = useState<RGBA>([31, 38, 51, 255]), [hexText, setHexText] = useState('#1f2633');
  const [brushSize, setBrushSize] = useState(1), [grid, setGrid] = useState(false), [background, setBackground] = useState('checker');
  const [dialog, setDialog] = useState<Dialog>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [leftOpen, setLeftOpen] = useState(false), [rightOpen, setRightOpen] = useState(false), [spaceHeld, setSpaceHeld] = useState(false), spaceGesture = useRef(false);
  const [captured, setCaptured] = useState<Silhouette | null>(null), [silhouetteColor, setSilhouetteColor] = useState('#5a9bff');
  const [fitRequests, setFitRequests] = useState<Set<string>>(new Set()), [historyVersion, setHistoryVersion] = useState(0);
  const [newSize, setNewSize] = useState({ width: 64, height: 64, name: '새 이미지' });
  const [sheetAsset, setSheetAsset] = useState<SpriteAsset | null>(null), [sheet, setSheet] = useState({ frameWidth: 64, frameHeight: 64, offsetX: 0, offsetY: 0, gapX: 0, gapY: 0, durationMs: 100 });
  const [exportType, setExportType] = useState<'png' | 'gif' | 'sheet' | 'comparison'>('png'), [exportColumns, setExportColumns] = useState(4), [includeOverlays, setIncludeOverlays] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null), sheetInput = useRef<HTMLInputElement>(null), projectInput = useRef<HTMLInputElement>(null);
  const histories = useRef(new Map<string, History>()), historySequence = useRef(0);
  const clocks = useRef(new Map<string, { last: number; elapsed: number; cycles: number }>());
  const activeBoard = project.boards.find(board => board.id === project.activeBoardId) ?? project.boards[0];
  const activeAsset = project.assets.find(asset => asset.id === activeBoard?.assetId);
  const activeFrame = activeAsset?.frames[activeBoard?.frameIndex ?? 0];
  const historyKey = activeAsset && activeFrame ? `${activeAsset.id}:${activeFrame.id}` : '';
  const currentHistory = histories.current.get(historyKey);
  void historyVersion;

  const change = useCallback((update: (previous: WorkspaceProject) => WorkspaceProject) => setProject(previous => { const next = update(previous); projectRef.current = next; return next; }), []);
  const closeDialog = useCallback(() => setDialog(null), []);
  const tell = useCallback((message: string) => setNotice(message), []);
  useEffect(() => { if (!notice) return; const timeout = window.setTimeout(() => setNotice(''), 5500); return () => clearTimeout(timeout); }, [notice]);
  useEffect(() => setHexText(hexFromColor(rgba)), [rgba]);
  function safe(action: () => void) { try { action(); } catch (caught) { setError(caught instanceof Error ? caught.message : '작업을 처리하지 못했습니다. 파일과 입력값을 확인해 주세요.'); } }

  const patchBoard = useCallback((boardId: string, patch: Partial<EditorBoard>) => {
    if (patch.frameIndex !== undefined || patch.playing === false) clocks.current.delete(boardId);
    change(previous => ({ ...previous, boards: previous.boards.map(board => board.id === boardId ? { ...board, ...patch } : board) }));
  }, [change]);
  function activate(boardId: string) { change(previous => previous.activeBoardId === boardId ? previous : { ...previous, activeBoardId: boardId }); }
  function boardFor(asset: SpriteAsset, frameIndex = 0): EditorBoard { return { id: id(), assetId: asset.id, frameIndex, playing: false, speed: 1, zoom: 1, panX: 0, panY: 0, overlays: [], selectedOverlayId: null }; }
  function requestFit(boardIds: string[]) { setFitRequests(previous => new Set([...previous, ...boardIds])); }
  function addAsset(asset: SpriteAsset) {
    const board = boardFor(asset), hasRoom = projectRef.current.boards.length < 8;
    change(previous => ({ ...previous, assets: [...previous.assets, asset], boards: hasRoom ? [...previous.boards, board] : previous.boards, activeBoardId: hasRoom ? board.id : previous.activeBoardId }));
    if (hasRoom) requestFit([...projectRef.current.boards.map(item => item.id), board.id]); else tell('파일 목록에 추가했습니다. 비교 칸을 닫은 뒤 열 수 있어요.');
  }
  function appendBoard(assetId: string, frameIndex: number) {
    const asset = projectRef.current.assets.find(item => item.id === assetId);
    if (!asset) return;
    if (projectRef.current.boards.length >= 8) { tell('비교 칸은 최대 8개입니다. 사용하지 않는 칸을 닫아 주세요.'); return; }
    const board = boardFor(asset, frameIndex);
    change(previous => ({ ...previous, boards: [...previous.boards, board], activeBoardId: board.id })); requestFit([...projectRef.current.boards.map(item => item.id), board.id]);
  }
  function openAsset(asset: SpriteAsset) { const existing = projectRef.current.boards.find(board => board.assetId === asset.id); if (existing) activate(existing.id); else appendBoard(asset.id, 0); }
  function duplicate(board: EditorBoard) {
    const asset = projectRef.current.assets.find(item => item.id === board.assetId); if (!asset) return;
    const frame = asset.frames[board.frameIndex];
    addAsset({ ...asset, id: id(), name: `${fileBase(asset.name)} 복사.png`, frames: [{ ...frame, id: id(), pixels: new Uint8ClampedArray(frame.pixels) }], repeat: 0 });
    tell('독립된 프레임을 만들었습니다. 이 복사본만 편집됩니다.');
  }
  function closeBoard(boardId: string) { clocks.current.delete(boardId); const remainingIds = projectRef.current.boards.filter(board => board.id !== boardId).map(board => board.id); change(previous => { const boards = previous.boards.filter(board => board.id !== boardId); return { ...previous, boards, activeBoardId: previous.activeBoardId === boardId ? boards.at(-1)?.id ?? null : previous.activeBoardId }; }); requestFit(remainingIds); }
  function replaceFrame(assetId: string, frameId: string, pixels: Uint8ClampedArray) { change(previous => ({ ...previous, assets: previous.assets.map(asset => asset.id === assetId ? { ...asset, frames: asset.frames.map(frame => frame.id === frameId ? { ...frame, pixels: new Uint8ClampedArray(pixels) } : frame) } : asset) })); }
  function trimHistory() {
    const entries = () => [...histories.current.values()].flatMap(history => [...history.undo, ...history.redo]);
    let bytes = entries().reduce((sum, entry) => sum + entry.before.byteLength + entry.after.byteLength, 0);
    while (bytes > 64 * 1024 * 1024) {
      let oldest: { history: History; list: 'undo' | 'redo'; entry: HistoryEntry } | null = null;
      for (const history of histories.current.values()) for (const list of ['undo', 'redo'] as const) for (const entry of history[list]) if (!oldest || entry.sequence < oldest.entry.sequence) oldest = { history, list, entry };
      if (!oldest) break;
      oldest.history[oldest.list] = oldest.history[oldest.list].filter(entry => entry !== oldest!.entry); bytes -= oldest.entry.before.byteLength + oldest.entry.after.byteLength;
    }
  }
  function commit(assetId: string, frameId: string, before: Uint8ClampedArray, after: Uint8ClampedArray) {
    if (!before.some((value, index) => value !== after[index])) return;
    const key = `${assetId}:${frameId}`, history = histories.current.get(key) ?? { undo: [], redo: [] };
    history.undo.push({ before, after, sequence: ++historySequence.current }); history.undo = history.undo.slice(-40); history.redo = []; histories.current.set(key, history); trimHistory();
    replaceFrame(assetId, frameId, after); setHistoryVersion(value => value + 1);
  }
  function undo(redo = false) {
    const current = projectRef.current, board = current.boards.find(item => item.id === current.activeBoardId), asset = current.assets.find(item => item.id === board?.assetId), frame = asset?.frames[board?.frameIndex ?? 0];
    if (!board || !asset || !frame) return;
    const history = histories.current.get(`${asset.id}:${frame.id}`); if (!history) return;
    const entry = (redo ? history.redo : history.undo).pop(); if (!entry) return;
    (redo ? history.undo : history.redo).push(entry); patchBoard(board.id, { playing: false }); replaceFrame(asset.id, frame.id, redo ? entry.after : entry.before); setHistoryVersion(value => value + 1);
  }
  function saveProject() { safe(() => { if (!projectRef.current.assets.length) return; download(serializeProject(projectRef.current), '도트-작업실.pixel.json'); tell('현재 파일과 비교 칸, 실루엣을 저장했습니다.'); }); }
  async function importFiles(files: FileList | File[] | null, asSheet = false) {
    if (!files?.length) return;
    setBusy(true); setError('');
    try {
      for (const file of Array.from(files)) {
        if (file.size > 64 * 1024 * 1024) throw new Error('64MB 이하의 이미지 파일을 선택해 주세요.');
        const buffer = await file.arrayBuffer(), bytes = new Uint8Array(buffer), isGif = bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70, isPng = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78;
        if (!isGif && !isPng) throw new Error(`${file.name}: PNG 또는 GIF 파일을 선택해 주세요.`);
        const asset = isGif ? decodeGif(buffer, file.name) : decodePng(buffer, file.name);
        if (asSheet) { if (!isPng) throw new Error('스프라이트 시트는 PNG 파일을 선택해 주세요.'); setSheetAsset(asset); setSheet({ frameWidth: Math.min(64, asset.width), frameHeight: Math.min(64, asset.height), offsetX: 0, offsetY: 0, gapX: 0, gapY: 0, durationMs: 100 }); setDialog('sheet'); break; }
        addAsset(asset);
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : '이미지를 열지 못했습니다. 파일이 손상되지 않았는지 확인해 주세요.'); }
    finally { setBusy(false); if (imageInput.current) imageInput.current.value = ''; if (sheetInput.current) sheetInput.current.value = ''; }
  }
  async function loadProject(file?: File) {
    if (!file) return; setBusy(true); setError('');
    try { const parsed = deserializeProject(await file.text()); clocks.current.clear(); histories.current.clear(); setHistoryVersion(value => value + 1); setCaptured(null); setFitRequests(new Set()); change(() => parsed); tell('저장한 작업을 열었습니다.'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '작업 파일을 열지 못했습니다.'); }
    finally { setBusy(false); if (projectInput.current) projectInput.current.value = ''; }
  }

  function capture(boardId?: string) {
    const current = projectRef.current, board = current.boards.find(item => item.id === (boardId ?? current.activeBoardId)), asset = current.assets.find(item => item.id === board?.assetId);
    if (!board || !asset) return;
    const frame = asset.frames[board.frameIndex];
    setCaptured({ id: id(), name: `${fileBase(asset.name)} #${board.frameIndex + 1}`, width: asset.width, height: asset.height, pixels: makeSilhouette(frame.pixels, rgbaFromHex(silhouetteColor)), color: silhouetteColor, opacity: 0.5, x: 0, y: 0, scale: 1, order: 'front', visible: true });
    tell('실루엣을 잡았습니다. 겹칠 칸을 선택하고 추가하세요.'); setRightOpen(true);
  }
  function pasteSilhouette() {
    if (!activeBoard || !activeAsset || !captured) return;
    const layer = { ...captured, id: id(), pixels: new Uint8ClampedArray(captured.pixels), x: Math.round((activeAsset.width - captured.width) / 2), y: Math.round((activeAsset.height - captured.height) / 2) };
    patchBoard(activeBoard.id, { overlays: [...activeBoard.overlays, layer], selectedOverlayId: layer.id }); setTool('overlay');
  }
  function changeOverlay(boardId: string, overlayId: string, patch: Partial<Silhouette>) {
    change(previous => ({ ...previous, boards: previous.boards.map(board => board.id !== boardId ? board : { ...board, overlays: board.overlays.map(layer => {
      if (layer.id !== overlayId) return layer;
      return { ...layer, ...patch, ...(patch.color ? { pixels: makeSilhouette(layer.pixels, rgbaFromHex(patch.color)) } : {}) };
    }) }) }));
  }

  useEffect(() => {
    let handle = 0;
    const tick = (now: number) => {
      const current = projectRef.current, patches = new Map<string, Partial<EditorBoard>>();
      for (const board of current.boards) {
        if (!board.playing) { clocks.current.delete(board.id); continue; }
        const asset = current.assets.find(item => item.id === board.assetId); if (!asset) continue;
        const clock = clocks.current.get(board.id) ?? { last: now, elapsed: 0, cycles: 0 };
        clock.elapsed += Math.min(1000, Math.max(0, now - clock.last)) * board.speed; clock.last = now;
        let index = board.frameIndex, playing = true, count = 0;
        while (clock.elapsed >= Math.max(10, asset.frames[index].durationMs) && count++ < 500) {
          clock.elapsed -= Math.max(10, asset.frames[index].durationMs); index++;
          if (index >= asset.frames.length) { index = 0; clock.cycles++; const maxCycles = asset.repeat === -1 ? 1 : asset.repeat > 0 ? asset.repeat + 1 : Infinity; if (clock.cycles >= maxCycles) { index = asset.frames.length - 1; playing = false; break; } }
        }
        clocks.current.set(board.id, clock); if (index !== board.frameIndex || !playing) patches.set(board.id, { frameIndex: index, playing });
      }
      if (patches.size) change(previous => ({ ...previous, boards: previous.boards.map(board => patches.has(board.id) ? { ...board, ...patches.get(board.id) } : board) }));
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick); return () => cancelAnimationFrame(handle);
  }, [change]);

  const keyboard = useRef({ undo, saveProject, setTool }); keyboard.current = { undo, saveProject, setTool };
  useEffect(() => {
    let holdingSpace = false;
    const down = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === 's') { event.preventDefault(); if (!document.querySelector('[role="dialog"]')) keyboard.current.saveProject(); return; }
      if (inputFocused(event.target) || document.querySelector('[role="dialog"]')) return;
      if ((event.ctrlKey || event.metaKey) && (key === 'z' || key === 'y')) { event.preventDefault(); keyboard.current.undo(key === 'y' || event.shiftKey); return; }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.code === 'Space' && !(event.target instanceof HTMLElement && event.target.closest('button'))) { event.preventDefault(); if (!holdingSpace) { holdingSpace = true; spaceGesture.current = false; setSpaceHeld(true); } return; }
      const selected = tools.find(item => item.shortcut.toLowerCase() === key); if (selected) { event.preventDefault(); keyboard.current.setTool(selected.id); }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || !holdingSpace) return;
      holdingSpace = false; setSpaceHeld(false);
      if (!spaceGesture.current && !document.querySelector('[role="dialog"]')) { const current = projectRef.current, board = current.boards.find(item => item.id === current.activeBoardId); if (board) patchBoard(board.id, { playing: !board.playing }); }
    };
    const blur = () => { holdingSpace = false; setSpaceHeld(false); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, [patchBoard]);

  function createCanvas() { safe(() => {
    const { width, height } = newSize; if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 2048 || height > 2048) throw new Error('캔버스의 가로와 세로를 1~2048 사이의 정수로 입력해 주세요.');
    addAsset({ id: id(), name: `${newSize.name.trim() || '새 이미지'}.png`, width, height, frames: [{ id: id(), durationMs: 100, pixels: new Uint8ClampedArray(width * height * 4) }], repeat: 0 }); setDialog(null);
  }); }
  const sheetCols = sheetAsset ? Math.max(0, Math.floor((sheetAsset.width - sheet.offsetX + sheet.gapX) / (sheet.frameWidth + sheet.gapX))) : 0;
  const sheetRows = sheetAsset ? Math.max(0, Math.floor((sheetAsset.height - sheet.offsetY + sheet.gapY) / (sheet.frameHeight + sheet.gapY))) : 0;
  const validSheet = !!sheetAsset && Object.values(sheet).every(value => Number.isFinite(value) && Number.isInteger(value)) && sheet.frameWidth > 0 && sheet.frameHeight > 0 && sheet.offsetX >= 0 && sheet.offsetY >= 0 && sheet.gapX >= 0 && sheet.gapY >= 0 && sheetCols * sheetRows >= 1 && sheetCols * sheetRows <= 1024;
  function importSheet() { safe(() => { if (!sheetAsset || !validSheet) return; addAsset(splitSpriteSheet(sheetAsset, sheet)); setDialog(null); setSheetAsset(null); }); }
  function exportFile() { safe(() => {
    if (!activeBoard || !activeAsset || !activeFrame) return;
    const filename = fileBase(activeAsset.name);
    const withLayers = (frame: PixelFrame, board = activeBoard, asset = activeAsset) => includeOverlays ? compositeFrame(frame.pixels, asset.width, asset.height, board.overlays) : frame.pixels;
    if (exportType === 'png') download(encodePng(withLayers(activeFrame), activeAsset.width, activeAsset.height), `${filename}-frame-${activeBoard.frameIndex + 1}.png`);
    else if (exportType === 'comparison') {
      const boards = project.boards, columns = Math.min(boards.length, 2), assets = boards.map(board => project.assets.find(asset => asset.id === board.assetId)!);
      const cellW = Math.max(...assets.map(asset => asset.width)), cellH = Math.max(...assets.map(asset => asset.height)), width = cellW * columns, height = cellH * Math.ceil(boards.length / columns);
      if (width * height > 32 * 1024 * 1024) throw new Error('비교 이미지가 너무 큽니다. 비교 칸을 줄여서 내보내 주세요.');
      const pixels = new Uint8ClampedArray(width * height * 4);
      boards.forEach((board, index) => { const asset = assets[index], frame = asset.frames[board.frameIndex], data = withLayers(frame, board, asset), x = (index % columns) * cellW + Math.floor((cellW - asset.width) / 2), y = Math.floor(index / columns) * cellH + Math.floor((cellH - asset.height) / 2); for (let row = 0; row < asset.height; row++) pixels.set(data.subarray(row * asset.width * 4, (row + 1) * asset.width * 4), ((y + row) * width + x) * 4); });
      download(encodePng(pixels, width, height), '도트-비교.png');
    } else {
      const asset = includeOverlays ? { ...activeAsset, frames: activeAsset.frames.map(frame => ({ ...frame, pixels: withLayers(frame) })) } : activeAsset;
      if (exportType === 'sheet') download(encodeSpriteSheet(asset, Math.min(asset.frames.length, Math.max(1, Math.round(exportColumns)))), `${filename}-sheet.png`);
      else { const result = encodeGif(asset); download(result.blob, `${filename}.gif`); if (result.quantized) tell('GIF에 맞춰 색상 또는 반투명을 변환했습니다. 편집 중인 원본은 그대로입니다.'); }
    }
    setDialog(null);
  }); }

  return <div className="workbench" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); if (event.dataTransfer.files.length === 1 && event.dataTransfer.files[0].name.toLowerCase().endsWith('.json')) void loadProject(event.dataTransfer.files[0]); else void importFiles(event.dataTransfer.files); } }}>
    <input ref={imageInput} type="file" accept="image/png,image/gif,.png,.gif" multiple className="file-input" aria-label="PNG 또는 GIF 파일 선택" onChange={event => void importFiles(event.target.files)} />
    <input ref={sheetInput} type="file" accept="image/png,.png" className="file-input" aria-label="스프라이트 시트 PNG 선택" onChange={event => void importFiles(event.target.files, true)} />
    <input ref={projectInput} type="file" accept=".json,application/json" className="file-input" aria-label="작업 파일 선택" onChange={event => void loadProject(event.target.files?.[0])} />
    <header className="app-header">
      <IconButton label="파일과 도구 패널" className="mobile-only" onClick={() => setLeftOpen(value => !value)}><Menu size={20} /></IconButton>
      <div className="brand"><span className="brand-mark"><i /><i /><i /><i /></span><h1>도트 작업실</h1></div>
      <div className="header-divider" />
      <button className="primary-button" type="button" disabled={busy} onClick={() => imageInput.current?.click()}><Upload size={16} />{busy ? '불러오는 중…' : '이미지 열기'}</button>
      <button type="button" className="header-button" onClick={() => setDialog('new')}><Plus size={16} /><span>새 캔버스</span></button>
      <div className="header-spacer" />
      <button type="button" className="header-button" onClick={() => projectInput.current?.click()}><FolderOpen size={16} /><span>작업 열기</span></button>
      <button type="button" className="header-button" disabled={!project.assets.length} onClick={saveProject}><Save size={16} /><span>작업 저장</span></button>
      <button type="button" className="export-button" disabled={!activeAsset} onClick={() => { setIncludeOverlays(false); setExportColumns(Math.min(4, activeAsset?.frames.length ?? 1)); setError(''); setDialog('export'); }}><Download size={16} /><span>내보내기</span></button>
      <IconButton label="사용 방법과 단축키" className="desktop-help" onClick={() => setDialog('help')}><HelpCircle size={19} /></IconButton>
      <IconButton label="실루엣 패널" className="mobile-only" onClick={() => setRightOpen(value => !value)}><Layers2 size={19} /></IconButton>
    </header>
    {(error || notice) && <div className={`message-bar ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>{error ? <span>문제 발생</span> : <Check size={15} />}<p>{error || notice}</p><IconButton label="알림 닫기" onClick={() => { setError(''); setNotice(''); }}><X size={16} /></IconButton></div>}
    <div className="app-body">
      {(leftOpen || rightOpen) && <button type="button" className="mobile-scrim" aria-label="패널 닫기" onClick={() => { setLeftOpen(false); setRightOpen(false); }} />}
      <aside className={`left-sidebar ${leftOpen ? 'mobile-open' : ''}`} aria-label="파일과 그리기 도구">
        <div className="panel-heading"><h2>파일</h2><span className="count-pill">{project.assets.length}</span><IconButton label="이미지 추가" onClick={() => imageInput.current?.click()}><Plus size={15} /></IconButton></div>
        <div className="asset-list">
          {!project.assets.length && <p className="library-empty">열어 둔 파일이 여기에 모입니다.</p>}
          {project.assets.map(asset => <button key={asset.id} type="button" className={`asset-row ${asset.id === activeAsset?.id ? 'selected' : ''}`} onClick={() => openAsset(asset)}><span className="asset-thumbnail checker-light"><PixelPreview pixels={asset.frames[0].pixels} width={asset.width} height={asset.height} /></span><span className="asset-row-copy"><strong title={asset.name}>{asset.name}</strong><small>{asset.width} × {asset.height}<span>{asset.frames.length}프레임</span></small></span></button>)}
        </div>
        <button type="button" className="import-sheet" onClick={() => sheetInput.current?.click()}><Grid2X2 size={15} />스프라이트 시트 열기<ChevronRight size={14} /></button>
        <section className="tools-section"><div className="section-heading"><h2>그리기</h2><div className="undo-controls"><IconButton label="그리기 실행 취소" disabled={!currentHistory?.undo.length} onClick={() => undo()}><Undo2 size={16} /></IconButton><IconButton label="그리기 다시 실행" disabled={!currentHistory?.redo.length} onClick={() => undo(true)}><Redo2 size={16} /></IconButton></div></div>
          <div className="tools-grid" role="toolbar" aria-label="그리기 도구">{tools.map(({ id: value, label, shortcut, icon: Icon }) => <button type="button" key={value} aria-label={`${label} (${shortcut})`} aria-pressed={tool === value} className={`tool-button ${tool === value ? 'selected' : ''}`} onClick={() => setTool(value)} title={`${label} · ${shortcut}`}><Icon size={18} /><span>{label}</span><kbd>{shortcut}</kbd></button>)}</div>
          <p className="tool-hint">{tool === 'line' ? <><kbd>Shift</kbd>로 가로·세로·45° 고정</> : tool === 'pan' ? '드래그로 화면 이동 · 휠로 확대' : tool === 'overlay' ? '실루엣을 선택하고 드래그하세요' : tool === 'picker' ? '픽셀을 누르면 색과 투명도를 가져옵니다' : <><kbd>Space</kbd> + 드래그로 화면 이동</>}</p>
        </section>
        <section className="color-section"><h3>색상</h3><div className="color-picker-row"><label className="main-color" style={{ background: hexFromColor(rgba) }}><input type="color" aria-label="그리기 색상" value={hexFromColor(rgba)} onChange={event => setRGBA(rgbaFromHex(event.target.value, rgba[3]))} /></label><input className="hex-input" aria-label="색상 HEX" maxLength={7} value={hexText} spellCheck={false} onChange={event => { setHexText(event.target.value); if (/^#[\da-fA-F]{6}$/.test(event.target.value)) setRGBA(rgbaFromHex(event.target.value, rgba[3])); }} onBlur={() => setHexText(hexFromColor(rgba))} /></div>
          <label className="range-field"><span>불투명도<strong>{Math.round(rgba[3] / 255 * 100)}%</strong></span><input aria-label="그리기 불투명도" type="range" min={0} max={255} value={rgba[3]} onChange={event => setRGBA([rgba[0], rgba[1], rgba[2], Number(event.target.value)])} /></label>
          <label className="range-field"><span>브러시 크기<strong>{brushSize}px</strong></span><input aria-label="브러시 크기" type="range" min={1} max={32} value={brushSize} onChange={event => setBrushSize(Number(event.target.value))} /></label>
          <div className="quick-colors">{['#000000', '#ffffff', '#5e9eff', '#e4b968', '#895778', '#e2aa98', '#777b89', '#474255'].map(color => <button key={color} type="button" aria-label={`${color} 색 선택`} style={{ background: color }} onClick={() => setRGBA(rgbaFromHex(color, rgba[3]))} />)}</div>
        </section>
        <section className="view-section"><h3>작업 화면</h3><label className="checkbox-label"><input type="checkbox" checked={grid} onChange={event => setGrid(event.target.checked)} />픽셀 격자<span>500% 이상</span></label><label className="stacked-label">배경<select aria-label="작업 화면 배경" value={background} onChange={event => setBackground(event.target.value)}><option value="checker">체크무늬</option><option value="#171b23">어두운색</option><option value="#dfe3e9">밝은색</option><option value="#ffffff">흰색</option></select></label></section>
      </aside>
      <main className="main-workspace">
        <div className="workspace-heading"><div><span className="workspace-dot" /><h2>비교 작업대</h2><span>{project.boards.length ? `${project.boards.length}칸` : '준비됨'}</span></div><div><span className="workspace-instruction">각 칸의 재생과 확대는 따로 조절됩니다</span><button type="button" disabled={!activeBoard || !activeAsset} onClick={() => activeBoard && activeAsset && appendBoard(activeAsset.id, activeBoard.frameIndex)}><Plus size={14} />비교 칸</button></div></div>
        {!project.boards.length ? <div className="empty-workspace"><div className="empty-pixel"><i /><i /><i /><i /><i /></div><h2>프레임을 펼쳐 놓고 비교하세요</h2><p>PNG나 GIF를 끌어 놓으세요.<br />멈춘 프레임을 나란히 놓고, 직접 그리거나 실루엣으로 겹쳐 볼 수 있어요.</p><div><button type="button" className="primary-button" onClick={() => imageInput.current?.click()}><ImagePlus size={17} />이미지 열기</button><button type="button" className="empty-new" onClick={() => setDialog('new')}>빈 캔버스로 시작</button></div><span className="local-only-note">파일은 브라우저 안에서만 처리합니다</span></div> : <div className={`boards-grid count-${project.boards.length}`}>
          {project.boards.map((board, index) => { const asset = project.assets.find(item => item.id === board.assetId); if (!asset) return null; return <Board key={board.id} board={board} asset={asset} number={index + 1} active={board.id === activeBoard?.id} tool={tool} rgba={rgba} brushSize={brushSize} grid={grid} background={background} spaceHeld={spaceHeld} fitOnMount={fitRequests.has(board.id)} onFitDone={() => setFitRequests(previous => { const next = new Set(previous); next.delete(board.id); return next; })} onActivate={() => activate(board.id)} onPatch={patch => patchBoard(board.id, patch)} onCommit={(frameId, before, after) => commit(asset.id, frameId, before, after)} onPick={setRGBA} onClose={() => closeBoard(board.id)} onAppend={() => appendBoard(asset.id, board.frameIndex)} onDuplicate={() => duplicate(board)} onCapture={() => capture(board.id)} onOverlayChange={(overlayId, patch) => changeOverlay(board.id, overlayId, patch)} onPanGesture={() => { spaceGesture.current = true; }} />; })}
        </div>}
        {activeAsset && activeBoard && <section className="filmstrip-section" aria-label="활성 파일 프레임 목록"><div className="filmstrip-heading"><h2>프레임</h2><span>{activeAsset.frames.length}장</span><div className="filmstrip-source">{activeAsset.name}</div><span className="filmstrip-tip">＋로 원하는 프레임을 옆에 고정</span></div><div className="filmstrip">{activeAsset.frames.map((frame, index) => <div key={frame.id} className={`frame-cell ${index === activeBoard.frameIndex ? 'selected' : ''}`}><button type="button" className="frame-thumbnail checker-light" aria-label={`${index + 1}번 프레임 선택`} aria-pressed={index === activeBoard.frameIndex} onClick={() => patchBoard(activeBoard.id, { frameIndex: index, playing: false })}><PixelPreview pixels={frame.pixels} width={activeAsset.width} height={activeAsset.height} /></button><div className="frame-cell-meta"><span>{index + 1}</span><small>{frame.durationMs}ms</small><IconButton label={`${index + 1}번 프레임을 옆에 고정`} onClick={() => appendBoard(activeAsset.id, index)}><Plus size={12} /></IconButton></div></div>)}</div></section>}
      </main>
      <aside className={`right-sidebar ${rightOpen ? 'mobile-open' : ''}`} aria-label="실루엣과 프레임 설정"><Inspector board={activeBoard} asset={activeAsset} captured={captured} color={silhouetteColor} onColor={setSilhouetteColor} onCapture={() => capture()} onPaste={pasteSilhouette} onSelect={overlayId => activeBoard && patchBoard(activeBoard.id, { selectedOverlayId: overlayId })} onChange={(overlayId, patch) => activeBoard && changeOverlay(activeBoard.id, overlayId, patch)} onDelete={overlayId => activeBoard && patchBoard(activeBoard.id, { overlays: activeBoard.overlays.filter(layer => layer.id !== overlayId), selectedOverlayId: activeBoard.selectedOverlayId === overlayId ? null : activeBoard.selectedOverlayId })} onDuration={durationMs => activeAsset && activeFrame && change(previous => ({ ...previous, assets: previous.assets.map(asset => asset.id === activeAsset.id ? { ...asset, frames: asset.frames.map(frame => frame.id === activeFrame.id ? { ...frame, durationMs } : frame) } : asset) }))} onRepeat={repeat => activeAsset && change(previous => ({ ...previous, assets: previous.assets.map(asset => asset.id === activeAsset.id ? { ...asset, repeat } : asset) }))} /></aside>
    </div>
    <footer className="app-status"><span><span className="status-dot" />로컬 작업</span><span className="status-shortcuts"><kbd>Space</kbd> 재생·정지<span>·</span><kbd>Space</kbd> + 드래그 이동<span>·</span>휠 확대</span><span>{activeAsset ? `${activeAsset.width} × ${activeAsset.height} px` : 'PNG · GIF · 스프라이트 시트'}</span></footer>
    {dialog === 'new' && <Modal title="새 캔버스" onClose={closeDialog} error={error}><p className="modal-description">투명한 캔버스에서 시작합니다.</p><label className="stacked-label">이름<input autoComplete="off" value={newSize.name} onChange={event => setNewSize(previous => ({ ...previous, name: event.target.value }))} /></label><div className="field-pair"><NumberField label="가로 (px)" value={newSize.width} min={1} max={2048} onChange={width => setNewSize(previous => ({ ...previous, width }))} /><NumberField label="세로 (px)" value={newSize.height} min={1} max={2048} onChange={height => setNewSize(previous => ({ ...previous, height }))} /></div><div className="size-presets">{[32, 64, 128, 160, 168, 256].map(size => <button key={size} type="button" className={newSize.width === size && newSize.height === size ? 'selected' : ''} onClick={() => setNewSize(previous => ({ ...previous, width: size, height: size }))}>{size}</button>)}</div><div className="modal-actions"><button type="button" className="secondary-button" onClick={closeDialog}>취소</button><button type="button" className="primary-button" onClick={createCanvas}>캔버스 만들기</button></div></Modal>}
    {dialog === 'sheet' && sheetAsset && <Modal title="스프라이트 시트 나누기" onClose={closeDialog} error={error} wide><div className="sheet-import-layout"><div className="sheet-preview checker-light"><PixelPreview pixels={sheetAsset.frames[0].pixels} width={sheetAsset.width} height={sheetAsset.height} /><span>{sheetAsset.width} × {sheetAsset.height}px</span></div><div><div className="field-pair"><NumberField label="프레임 가로" value={sheet.frameWidth} min={1} max={sheetAsset.width} onChange={frameWidth => setSheet(previous => ({ ...previous, frameWidth }))} /><NumberField label="프레임 세로" value={sheet.frameHeight} min={1} max={sheetAsset.height} onChange={frameHeight => setSheet(previous => ({ ...previous, frameHeight }))} /></div><div className="field-pair"><NumberField label="시작 X" value={sheet.offsetX} min={0} max={sheetAsset.width} onChange={offsetX => setSheet(previous => ({ ...previous, offsetX }))} /><NumberField label="시작 Y" value={sheet.offsetY} min={0} max={sheetAsset.height} onChange={offsetY => setSheet(previous => ({ ...previous, offsetY }))} /></div><div className="field-pair"><NumberField label="가로 간격" value={sheet.gapX} min={0} max={1024} onChange={gapX => setSheet(previous => ({ ...previous, gapX }))} /><NumberField label="세로 간격" value={sheet.gapY} min={0} max={1024} onChange={gapY => setSheet(previous => ({ ...previous, gapY }))} /></div><NumberField label="프레임 시간 (ms)" value={sheet.durationMs} min={10} max={60000} step={10} onChange={durationMs => setSheet(previous => ({ ...previous, durationMs }))} /><p className={`sheet-count ${validSheet ? '' : 'invalid'}`}>{validSheet ? `가로 ${sheetCols} × 세로 ${sheetRows} · 총 ${sheetCols * sheetRows}프레임` : '프레임 크기와 간격을 확인해 주세요. 최대 1024장까지 열 수 있어요.'}</p><p className="micro-help">왼쪽 위부터 가로 방향으로 읽습니다.<br />프레임보다 작은 가장자리 조각은 제외합니다.</p></div></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={closeDialog}>취소</button><button type="button" className="primary-button" disabled={!validSheet} onClick={importSheet}>프레임으로 열기</button></div></Modal>}
    {dialog === 'export' && activeAsset && <Modal title="내보내기" onClose={closeDialog} error={error}><div className="export-choices">{([{ value: 'png', name: '현재 프레임 PNG', description: '현재 칸의 프레임 한 장' }, { value: 'gif', name: '움직이는 GIF', description: '원래 프레임 시간과 순서' }, { value: 'sheet', name: '스프라이트 시트 PNG', description: '모든 프레임을 한 이미지로' }, { value: 'comparison', name: '비교 PNG', description: '열어 둔 비교 칸을 나란히' }] as const).map(option => <label key={option.value} className={exportType === option.value ? 'selected' : ''}><input type="radio" name="exportType" value={option.value} checked={exportType === option.value} onChange={() => setExportType(option.value)} /><span><strong>{option.name}</strong><small>{option.description}</small></span></label>)}</div>{exportType === 'sheet' && <NumberField label="한 줄의 프레임 수" value={exportColumns} min={1} max={activeAsset.frames.length} onChange={value => setExportColumns(Math.round(value))} />}<label className="checkbox-label export-overlays"><input type="checkbox" checked={includeOverlays} onChange={event => setIncludeOverlays(event.target.checked)} />비교용 실루엣도 포함</label><p className="micro-help">PNG는 원래 픽셀과 투명도를 유지합니다.<br />GIF는 형식에 따라 색이나 반투명이 변환될 수 있어요.</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={closeDialog}>취소</button><button type="button" className="primary-button" onClick={exportFile}><Download size={16} />파일 내려받기</button></div></Modal>}
    {dialog === 'help' && <Modal title="도트 작업실 사용 방법" onClose={closeDialog} wide><div className="help-content"><section><h3>프레임을 나란히</h3><p>PNG·GIF를 열거나 작업대에 끌어 놓으세요. 프레임 아래의 ＋ 또는 <strong>옆에 고정</strong>으로 같은 원본의 프레임을 나란히 놓습니다. 수정 내용은 같은 파일을 보는 모든 칸에 공유됩니다. <strong>복제해 편집</strong>은 독립된 이미지 한 장을 만듭니다.</p><h3>실루엣으로 비교</h3><p>기준 프레임에서 <strong>실루엣 잡기</strong>를 누르고, 다른 칸을 선택한 뒤 <strong>이 칸에 실루엣 추가</strong>를 누르세요. 앞뒤 순서·불투명도·위치를 조절할 수 있습니다. 실루엣은 잡은 시점의 스냅샷입니다.</p><h3>작업 이어 하기</h3><p><strong>작업 저장</strong>은 파일·픽셀·프레임 시간·비교 칸·실루엣을 함께 저장합니다. 내려받은 작업 파일을 <strong>작업 열기</strong>로 불러오세요. 파일은 서버에 업로드되지 않습니다.</p></section><section className="shortcut-list"><h3>단축키</h3>{tools.map(item => <div key={item.id}><kbd>{item.shortcut}</kbd><span>{item.label}</span></div>)}<div><kbd>Shift</kbd><span>직선을 가로·세로·45°로 고정</span></div><div><kbd>Space</kbd><span>누르고 놓으면 재생·정지</span></div><div><kbd>Space + 드래그</kbd><span>화면 이동</span></div><div><kbd>Alt + 드래그</kbd><span>선택한 실루엣 이동</span></div><div><kbd>Ctrl/⌘ + Z</kbd><span>그리기 실행 취소</span></div><div><kbd>Ctrl/⌘ + Y</kbd><span>그리기 다시 실행</span></div><div><kbd>Ctrl/⌘ + S</kbd><span>작업 저장</span></div></section></div></Modal>}
  </div>;
}
