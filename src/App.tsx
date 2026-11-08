import { Component, useCallback, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronRight, Download, Eraser, FileImage, FlipHorizontal2, FolderOpen, Grid2X2, Hand, HelpCircle, ImagePlus, Layers2, Maximize2, Menu, Minus, Move, PaintBucket, Pencil, Pipette, Play, Plus, Redo2, Ruler, Save, Slash, Undo2, Upload, X } from 'lucide-react';
import type { EditorBoard, PixelFrame, RGBA, RulerGuide, Silhouette, SpriteAsset, Tool, WorkspaceProject } from './types';
import { flipPixelsHorizontal, makeSilhouette } from './lib/pixels';
import { EditHistory, type EditCommand, type OverlayState } from './lib/editHistory';
import { decodeGif, decodePng, encodeGif, encodePng, encodeSpriteSheet, splitSpriteSheet } from './lib/formats';
import { deserializeProject, serializeProject } from './lib/project';
import JoinedWorkspace from './components/JoinedWorkspace';
import Inspector from './components/Inspector';
import { IconButton, Modal, NumberField, PixelPreview } from './components/UI';

const id = () => crypto.randomUUID();
const emptyProject = (): WorkspaceProject => ({ version: 1, assets: [], boards: [], activeBoardId: null });
const tools: { id: Tool; label: string; shortcut: string; icon: typeof Hand }[] = [
  { id: 'pan', label: '화면 이동', shortcut: 'P', icon: Hand }, { id: 'pencil', label: '연필', shortcut: 'B', icon: Pencil },
  { id: 'line', label: '직선', shortcut: 'L', icon: Slash }, { id: 'eraser', label: '지우개', shortcut: 'E', icon: Eraser },
  { id: 'ruler', label: '룰러(자)', shortcut: 'R', icon: Ruler },
  { id: 'picker', label: '스포이트', shortcut: 'I', icon: Pipette }, { id: 'fill', label: '채우기', shortcut: 'F', icon: PaintBucket },
  { id: 'overlay', label: '실루엣 이동', shortcut: 'O', icon: Layers2 },
  { id: 'move', label: '그림 전체 이동', shortcut: 'V', icon: Move },
];
const hexFromColor = (rgba: RGBA) => '#' + rgba.slice(0, 3).map(value => Math.round(value).toString(16).padStart(2, '0')).join('');
const rgbaFromHex = (hex: string, alpha = 255): RGBA => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), alpha];
function download(blob: Blob, name: string) { const link = document.createElement('a'), url = URL.createObjectURL(blob); link.href = url; link.download = name; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
const fileBase = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*]/g, '-');
const inputFocused = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input, select, textarea, [contenteditable="true"]');
const textEditingFocused = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('textarea, [contenteditable="true"]')) return true;
  const input = target.closest('input');
  return !!input && !['range', 'color', 'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'hidden'].includes(input.type);
};
const pixelsEqual = (a: Uint8ClampedArray, b: Uint8ClampedArray) => a === b || a.length === b.length && !a.some((value, index) => value !== b[index]);
const overlayState = (board: EditorBoard): OverlayState => ({ overlays: board.overlays.map(layer => ({ ...layer })), selectedOverlayId: board.selectedOverlayId });
function overlaysEqual(a: OverlayState, b: OverlayState) {
  return a.overlays.length === b.overlays.length && a.overlays.every((layer, index) => {
    const next = b.overlays[index];
    return (['id', 'name', 'width', 'height', 'color', 'opacity', 'x', 'y', 'scale', 'order', 'visible'] as const).every(key => layer[key] === next[key]) && pixelsEqual(layer.pixels, next.pixels);
  });
}
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
  const [exportType, setExportType] = useState<'png' | 'gif' | 'sheet' | 'comparison'>('png'), [exportColumns, setExportColumns] = useState(4);
  const imageInput = useRef<HTMLInputElement>(null), sheetInput = useRef<HTMLInputElement>(null), projectInput = useRef<HTMLInputElement>(null);
  const editHistory = useRef(new EditHistory());
  const overlayGesture = useRef<{ boardId: string; overlayId: string; before: OverlayState } | null>(null);
  const clocks = useRef(new Map<string, { last: number; elapsed: number; cycles: number }>());
  const activeBoard = project.boards.find(board => board.id === project.activeBoardId) ?? project.boards[0];
  const activeAsset = project.assets.find(asset => asset.id === activeBoard?.assetId);
  const activeFrame = activeAsset?.frames[activeBoard?.frameIndex ?? 0];
  const selectedSilhouette = activeBoard?.overlays.find(layer => layer.id === activeBoard.selectedOverlayId && layer.visible);
  const joinedView = project.joinedView ?? { zoom: project.boards[0]?.zoom ?? 1, panX: project.boards[0]?.panX ?? 0, panY: project.boards[0]?.panY ?? 0 };
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
  function selectTool(value: Tool) {
    setTool(value);
    if (value === 'move' && activeBoard?.selectedOverlayId) patchBoard(activeBoard.id, { selectedOverlayId: null });
  }
  function selectSilhouette(overlayId: string) {
    if (!activeBoard) return;
    patchBoard(activeBoard.id, { selectedOverlayId: overlayId }); setTool('overlay');
  }
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
  function record(command: EditCommand, coalesceKey?: string) { editHistory.current.push(command, coalesceKey); setHistoryVersion(value => value + 1); }
  function commit(assetId: string, frameId: string, before: Uint8ClampedArray, after: Uint8ClampedArray, label = '도트 편집') {
    if (pixelsEqual(before, after)) return;
    record({ kind: 'pixels', label, assetId, frameId, before, after }); replaceFrame(assetId, frameId, after);
  }
  function writeOverlayState(boardId: string, state: OverlayState) {
    change(previous => ({ ...previous, boards: previous.boards.map(board => board.id === boardId ? { ...board, overlays: state.overlays.map(layer => ({ ...layer })), selectedOverlayId: state.selectedOverlayId } : board) }));
  }
  function editOverlayState(boardId: string, after: OverlayState, label: string, coalesceKey?: string) {
    const board = projectRef.current.boards.find(item => item.id === boardId); if (!board) return;
    const before = overlayState(board); if (overlaysEqual(before, after)) return;
    record({ kind: 'overlays', label, boardId, before, after }, coalesceKey); writeOverlayState(boardId, after);
  }
  function editGuides(after: RulerGuide[], label: string) {
    const before = (projectRef.current.guides ?? []).map(guide => ({ ...guide }));
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    record({ kind: 'guides', label, before, after: after.map(guide => ({ ...guide })) }); change(previous => ({ ...previous, guides: after }));
  }
  function changeDuration(assetId: string, frameId: string, after: number) {
    const frame = projectRef.current.assets.find(asset => asset.id === assetId)?.frames.find(frame => frame.id === frameId); if (!frame || frame.durationMs === after) return;
    record({ kind: 'duration', label: '프레임 시간', assetId, frameId, before: frame.durationMs, after }, `duration:${assetId}:${frameId}`);
    change(previous => ({ ...previous, assets: previous.assets.map(asset => asset.id === assetId ? { ...asset, frames: asset.frames.map(frame => frame.id === frameId ? { ...frame, durationMs: after } : frame) } : asset) }));
  }
  function changeRepeat(assetId: string, after: number) {
    const asset = projectRef.current.assets.find(asset => asset.id === assetId); if (!asset || asset.repeat === after) return;
    record({ kind: 'repeat', label: '반복 횟수', assetId, before: asset.repeat, after }, `repeat:${assetId}`);
    change(previous => ({ ...previous, assets: previous.assets.map(asset => asset.id === assetId ? { ...asset, repeat: after } : asset) }));
  }
  function applyCommand(command: EditCommand, redo: boolean) {
    if (command.kind === 'pixels') { replaceFrame(command.assetId, command.frameId, redo ? command.after : command.before); return; }
    if (command.kind === 'overlays') { writeOverlayState(command.boardId, redo ? command.after : command.before); return; }
    if (command.kind === 'guides') { const guides = redo ? command.after : command.before; change(previous => ({ ...previous, guides: guides.map(guide => ({ ...guide })) })); return; }
    const value = redo ? command.after : command.before;
    change(previous => ({ ...previous, assets: previous.assets.map(asset => asset.id !== command.assetId ? asset : command.kind === 'repeat' ? { ...asset, repeat: value } : { ...asset, frames: asset.frames.map(frame => frame.id === command.frameId ? { ...frame, durationMs: value } : frame) }) }));
  }
  function undo(redo = false) {
    if (overlayGesture.current) return;
    const command = redo ? editHistory.current.redo() : editHistory.current.undo(); if (!command) return;
    applyCommand(command, redo); setHistoryVersion(value => value + 1); tell(`${command.label} ${redo ? '다시 실행' : '실행 취소'}`);
  }
  function flipFrame() { if (activeAsset && activeFrame) commit(activeAsset.id, activeFrame.id, new Uint8ClampedArray(activeFrame.pixels), flipPixelsHorizontal(activeFrame.pixels, activeAsset.width, activeAsset.height), '프레임 좌우반전'); }
  function saveProject() { safe(() => { if (!projectRef.current.assets.length) return; download(serializeProject(projectRef.current), '도트-작업실.pixel.json'); tell('파일과 비교 설정을 편집 상태 파일에 저장했습니다.'); }); }
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
    try { const parsed = deserializeProject(await file.text()); clocks.current.clear(); editHistory.current.clear(); overlayGesture.current = null; setHistoryVersion(value => value + 1); setCaptured(null); setFitRequests(new Set()); change(() => parsed); tell('저장한 작업을 열었습니다.'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '작업 파일을 열지 못했습니다.'); }
    finally { setBusy(false); if (projectInput.current) projectInput.current.value = ''; }
  }

  function capture(boardId?: string) {
    const current = projectRef.current, board = current.boards.find(item => item.id === (boardId ?? current.activeBoardId)), asset = current.assets.find(item => item.id === board?.assetId);
    if (!board || !asset) return;
    const frame = asset.frames[board.frameIndex];
    setCaptured({ id: id(), name: `${current.boards.findIndex(item => item.id === board.id) + 1}번 칸 · ${fileBase(asset.name)} #${board.frameIndex + 1}`, width: asset.width, height: asset.height, pixels: makeSilhouette(frame.pixels, rgbaFromHex(silhouetteColor)), color: silhouetteColor, opacity: 0.5, x: 0, y: 0, scale: 1, order: 'front', visible: true });
    tell('실루엣을 잡았습니다. 겹칠 칸을 선택하고 추가하세요.'); setRightOpen(true);
  }
  function pasteSilhouette() {
    if (!activeBoard || !activeAsset || !captured) return;
    const layer = { ...captured, id: id(), pixels: new Uint8ClampedArray(captured.pixels), x: Math.round((activeAsset.width - captured.width) / 2), y: Math.round((activeAsset.height - captured.height) / 2) };
    editOverlayState(activeBoard.id, { overlays: [...activeBoard.overlays, layer], selectedOverlayId: layer.id }, '실루엣 추가'); setTool('overlay');
  }
  function changeOverlay(boardId: string, overlayId: string, patch: Partial<Silhouette>) {
    const board = projectRef.current.boards.find(item => item.id === boardId); if (!board) return;
    const after = { ...overlayState(board), overlays: board.overlays.map(layer => layer.id !== overlayId ? layer : { ...layer, ...patch, ...(patch.color ? { pixels: makeSilhouette(layer.pixels, rgbaFromHex(patch.color)) } : {}) }) };
    if (overlayGesture.current?.boardId === boardId && overlayGesture.current.overlayId === overlayId) { writeOverlayState(boardId, after); return; }
    const keys = Object.keys(patch), continuous = keys.every(key => ['x', 'y', 'opacity', 'scale', 'color'].includes(key));
    const label = patch.pixels ? '실루엣 좌우반전' : patch.opacity !== undefined ? '실루엣 불투명도' : patch.order ? '실루엣 앞뒤 순서' : patch.visible !== undefined ? '실루엣 표시' : '실루엣 설정';
    editOverlayState(boardId, after, label, continuous ? `overlay:${boardId}:${overlayId}:${keys.sort().join(',')}` : undefined);
  }
  function startOverlayGesture(boardId: string, overlayId: string) { const board = projectRef.current.boards.find(item => item.id === boardId); if (board) overlayGesture.current = { boardId, overlayId, before: overlayState(board) }; }
  function endOverlayGesture(boardId: string, overlayId: string, patch: Partial<Silhouette> | null, cancelled: boolean) {
    const transaction = overlayGesture.current; overlayGesture.current = null;
    if (!transaction || transaction.boardId !== boardId || transaction.overlayId !== overlayId) return;
    if (cancelled) { writeOverlayState(boardId, transaction.before); return; }
    const board = projectRef.current.boards.find(item => item.id === boardId); if (!board) return;
    const after = { ...overlayState(board), overlays: board.overlays.map(layer => layer.id === overlayId ? { ...layer, ...patch } : layer) };
    writeOverlayState(boardId, after);
    if (!overlaysEqual(transaction.before, after)) record({ kind: 'overlays', label: '실루엣 이동', boardId, before: transaction.before, after });
  }
  function deleteOverlay(overlayId: string) {
    const current = projectRef.current, board = current.boards.find(item => item.id === current.activeBoardId); if (!board) return;
    editOverlayState(board.id, { overlays: board.overlays.filter(layer => layer.id !== overlayId), selectedOverlayId: board.selectedOverlayId === overlayId ? null : board.selectedOverlayId }, '실루엣 삭제');
  }
  function flipOverlay(overlayId: string) {
    const current = projectRef.current, board = current.boards.find(item => item.id === current.activeBoardId), layer = board?.overlays.find(item => item.id === overlayId); if (!board || !layer) return;
    changeOverlay(board.id, overlayId, { pixels: flipPixelsHorizontal(layer.pixels, layer.width, layer.height) });
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

  const keyboard = useRef({ undo, saveProject, setTool: selectTool }); keyboard.current = { undo, saveProject, setTool: selectTool };
  useEffect(() => {
    let holdingSpace = false, spacePlaybackCandidate = false;
    const down = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const inDialog = !!document.querySelector('[role="dialog"]');
      if (event.code === 'Space' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const typing = inputFocused(event.target) || inDialog;
        if (!holdingSpace) { holdingSpace = true; spacePlaybackCandidate = !typing; spaceGesture.current = false; setSpaceHeld(true); }
        if (!typing) event.preventDefault();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === 's') { event.preventDefault(); if (!document.querySelector('[role="dialog"]')) keyboard.current.saveProject(); return; }
      if ((event.ctrlKey || event.metaKey) && (key === 'z' || key === 'y')) {
        if (inDialog || textEditingFocused(event.target)) return;
        event.preventDefault(); keyboard.current.undo(key === 'y' || event.shiftKey || event.altKey); return;
      }
      if (inputFocused(event.target) || document.querySelector('[role="dialog"]')) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const selected = tools.find(item => item.shortcut.toLowerCase() === key); if (selected) { event.preventDefault(); keyboard.current.setTool(selected.id); }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || !holdingSpace) return;
      if (spacePlaybackCandidate || spaceGesture.current) event.preventDefault();
      holdingSpace = false; setSpaceHeld(false);
      if (spacePlaybackCandidate && !spaceGesture.current && !inputFocused(event.target) && !document.querySelector('[role="dialog"]')) { const current = projectRef.current, board = current.boards.find(item => item.id === current.activeBoardId); if (board) patchBoard(board.id, { playing: !board.playing }); }
      spacePlaybackCandidate = false;
    };
    const blur = () => { holdingSpace = false; spacePlaybackCandidate = false; spaceGesture.current = false; setSpaceHeld(false); };
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
    if (exportType === 'png') download(encodePng(activeFrame.pixels, activeAsset.width, activeAsset.height), `${filename}-frame-${activeBoard.frameIndex + 1}.png`);
    else if (exportType === 'comparison') {
      const boards = project.boards, assets = boards.map(board => project.assets.find(asset => asset.id === board.assetId)!);
      const width = assets.reduce((sum, asset) => sum + asset.width, 0), height = Math.max(...assets.map(asset => asset.height));
      if (width * height > 32 * 1024 * 1024) throw new Error('비교 이미지가 너무 큽니다. 비교 칸을 줄여서 내보내 주세요.');
      const pixels = new Uint8ClampedArray(width * height * 4);
      let offsetX = 0;
      boards.forEach((board, index) => { const asset = assets[index], data = asset.frames[board.frameIndex].pixels; for (let row = 0; row < asset.height; row++) pixels.set(data.subarray(row * asset.width * 4, (row + 1) * asset.width * 4), (row * width + offsetX) * 4); offsetX += asset.width; });
      download(encodePng(pixels, width, height), '도트-비교.png');
    } else {
      const asset = activeAsset;
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
      <button type="button" className="header-button" onClick={() => projectInput.current?.click()}><FolderOpen size={16} /><span>편집 상태 열기</span></button>
      <button type="button" className="header-button" disabled={!project.assets.length} onClick={saveProject} title="파일과 비교 설정을 다음에 이어서 편집할 파일로 저장"><Save size={16} /><span>편집 상태 저장</span></button>
      <button type="button" className="export-button" disabled={!activeAsset} onClick={() => { setExportColumns(Math.min(4, activeAsset?.frames.length ?? 1)); setError(''); setDialog('export'); }}><Download size={16} /><span>이미지 저장</span></button>
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
        <section className="tools-section"><div className="section-heading"><h2>그리기</h2><div className="undo-controls"><IconButton label="편집 실행 취소" title="Ctrl+Z" disabled={!editHistory.current.canUndo} onClick={() => undo()}><Undo2 size={16} /></IconButton><IconButton label="편집 다시 실행" title="Ctrl+Alt+Z · Ctrl+Y · Ctrl+Shift+Z" disabled={!editHistory.current.canRedo} onClick={() => undo(true)}><Redo2 size={16} /></IconButton></div></div>
          <div className="tools-grid" role="toolbar" aria-label="그리기 도구">{tools.map(({ id: value, label, shortcut, icon: Icon }) => <button type="button" key={value} aria-label={`${label} (${shortcut})`} aria-pressed={tool === value} className={`tool-button tool-${value} ${tool === value ? 'selected' : ''}`} onClick={() => selectTool(value)} title={`${label} · ${shortcut}`}><Icon size={18} /><span>{label}</span><kbd>{shortcut}</kbd></button>)}</div>
          <button type="button" className="frame-flip-button" disabled={!activeFrame} onClick={flipFrame}><FlipHorizontal2 size={15} />현재 프레임 좌우반전</button>
          {(tool === 'line' || tool === 'ruler') && <div className="line-mode" role="group" aria-label="직선 모드"><button type="button" aria-pressed={tool === 'line'} onClick={() => setTool('line')}>도트선</button><button type="button" aria-pressed={tool === 'ruler'} onClick={() => setTool('ruler')}>룰러(자)</button></div>}
          {tool === 'ruler' && <div className="ruler-color-control"><span>현재 브러시 색으로 긋습니다</span><i style={{ background: hexFromColor(rgba), width: 17, height: 2 }} /></div>}
          <p className="tool-hint">{tool === 'ruler' ? <>픽셀 경계에 얇은 자를 긋습니다.<br /><kbd>Shift</kbd>로 가로·세로·45° 고정</> : tool === 'line' ? <><kbd>Shift</kbd>로 가로·세로·45° 고정</> : tool === 'pan' ? '드래그로 붙인 캔버스를 함께 이동' : tool === 'move' ? '현재 프레임 그림만 이동 · 실루엣은 고정' : tool === 'overlay' ? selectedSilhouette ? <>선택한 실루엣만 이동: {selectedSilhouette.name}</> : '오른쪽 목록에서 이동할 실루엣을 선택하세요' : tool === 'picker' ? '픽셀을 누르면 색과 투명도를 가져옵니다' : <><kbd>Space</kbd> + 드래그로 화면 이동</>}</p>
        </section>
        <section className="color-section"><h3>색상</h3><div className="color-picker-row"><label className="main-color" style={{ background: hexFromColor(rgba) }}><input type="color" aria-label="그리기 색상" value={hexFromColor(rgba)} onChange={event => setRGBA(rgbaFromHex(event.target.value, rgba[3]))} /></label><input className="hex-input" aria-label="색상 HEX" maxLength={7} value={hexText} spellCheck={false} onChange={event => { setHexText(event.target.value); if (/^#[\da-fA-F]{6}$/.test(event.target.value)) setRGBA(rgbaFromHex(event.target.value, rgba[3])); }} onBlur={() => setHexText(hexFromColor(rgba))} /></div>
          <label className="range-field"><span>불투명도<strong>{Math.round(rgba[3] / 255 * 100)}%</strong></span><input aria-label="그리기 불투명도" type="range" min={0} max={255} value={rgba[3]} onChange={event => setRGBA([rgba[0], rgba[1], rgba[2], Number(event.target.value)])} /></label>
          <label className="range-field"><span>브러시 크기<strong>{brushSize}px</strong></span><input aria-label="브러시 크기" type="range" min={1} max={32} value={brushSize} onChange={event => setBrushSize(Number(event.target.value))} /></label>
          <div className="quick-colors">{['#000000', '#ffffff', '#5e9eff', '#e4b968', '#895778', '#e2aa98', '#777b89', '#474255'].map(color => <button key={color} type="button" aria-label={`${color} 색 선택`} style={{ background: color }} onClick={() => setRGBA(rgbaFromHex(color, rgba[3]))} />)}</div>
        </section>
        <section className="view-section"><h3>작업 화면</h3><label className="checkbox-label"><input type="checkbox" checked={grid} onChange={event => setGrid(event.target.checked)} />픽셀 격자<span>500% 이상</span></label><label className="stacked-label">배경<select aria-label="작업 화면 배경" value={background} onChange={event => setBackground(event.target.value)}><option value="checker">체크무늬</option><option value="#171b23">어두운색</option><option value="#dfe3e9">밝은색</option><option value="#ffffff">흰색</option></select></label></section>
      </aside>
      <main className="main-workspace">
        <div className="workspace-heading"><div><span className="workspace-dot" /><h2>붙임 작업대</h2><span>{project.boards.length ? `${project.boards.length}칸` : '준비됨'}</span></div><div><span className="workspace-instruction">캔버스는 빈틈없이 · 재생은 칸마다</span><button type="button" disabled={!activeBoard || !activeAsset} onClick={() => activeBoard && activeAsset && appendBoard(activeAsset.id, activeBoard.frameIndex)}><Plus size={14} />비교 칸</button></div></div>
        {!project.boards.length ? <div className="empty-workspace"><div className="empty-pixel"><i /><i /><i /><i /><i /></div><h2>캔버스를 붙여 놓고 비교하세요</h2><p>PNG나 GIF를 끌어 놓으세요.<br />프레임을 빈틈없이 붙이고, 얇은 자와 실루엣으로 비교할 수 있어요.</p><div><button type="button" className="primary-button" onClick={() => imageInput.current?.click()}><ImagePlus size={17} />이미지 열기</button><button type="button" className="empty-new" onClick={() => setDialog('new')}>빈 캔버스로 시작</button></div><span className="local-only-note">파일은 브라우저 안에서만 처리합니다</span></div> : <JoinedWorkspace boards={project.boards} assets={project.assets} activeBoardId={activeBoard?.id ?? null} view={joinedView} guides={project.guides ?? []} tool={tool} rgba={rgba} rulerColor={hexFromColor(rgba)} brushSize={brushSize} grid={grid} background={background} spaceHeld={spaceHeld} fitRequestKey={[...fitRequests].sort().join('|')} onFitDone={() => setFitRequests(new Set())} onViewChange={view => change(previous => ({ ...previous, joinedView: view }))} onActivate={activate} onPatch={patchBoard} onCommit={commit} onPick={setRGBA} onClose={closeBoard} onAppend={board => appendBoard(board.assetId, board.frameIndex)} onDuplicate={duplicate} onCapture={capture} onOverlayChange={changeOverlay} onOverlayGestureStart={startOverlayGesture} onOverlayGestureEnd={endOverlayGesture} onGuideAdd={guide => editGuides([...(projectRef.current.guides ?? []), guide], '룰러 그리기')} onPanGesture={() => { spaceGesture.current = true; }} />}
        {activeAsset && activeBoard && <section className="filmstrip-section" aria-label="활성 파일 프레임 목록"><div className="filmstrip-heading"><h2>프레임</h2><span>{activeAsset.frames.length}장</span><div className="filmstrip-source">{activeAsset.name}</div><span className="filmstrip-tip">＋로 원하는 프레임을 옆에 고정</span></div><div className="filmstrip">{activeAsset.frames.map((frame, index) => <div key={frame.id} className={`frame-cell ${index === activeBoard.frameIndex ? 'selected' : ''}`}><button type="button" className="frame-thumbnail checker-light" aria-label={`${index + 1}번 프레임 선택`} aria-pressed={index === activeBoard.frameIndex} onClick={() => patchBoard(activeBoard.id, { frameIndex: index, playing: false })}><PixelPreview pixels={frame.pixels} width={activeAsset.width} height={activeAsset.height} /></button><div className="frame-cell-meta"><span>{index + 1}</span><small>{frame.durationMs}ms</small><IconButton label={`${index + 1}번 프레임을 옆에 고정`} onClick={() => appendBoard(activeAsset.id, index)}><Plus size={12} /></IconButton></div></div>)}</div></section>}
      </main>
      <aside className={`right-sidebar ${rightOpen ? 'mobile-open' : ''}`} aria-label="실루엣과 프레임 설정"><Inspector guides={project.guides ?? []} onGuideChange={(guideId, patch) => editGuides((projectRef.current.guides ?? []).map(guide => guide.id === guideId ? { ...guide, ...patch } : guide), '룰러 표시')} onGuideDelete={guideId => editGuides((projectRef.current.guides ?? []).filter(guide => guide.id !== guideId), '룰러 삭제')} onGuideClear={() => editGuides([], '룰러 모두 지우기')} boardNumber={activeBoard ? project.boards.findIndex(board => board.id === activeBoard.id) + 1 : 0} onFlip={flipOverlay} board={activeBoard} asset={activeAsset} captured={captured} color={silhouetteColor} onColor={setSilhouetteColor} onCapture={() => capture()} onPaste={pasteSilhouette} onSelect={selectSilhouette} onChange={(overlayId, patch) => activeBoard && changeOverlay(activeBoard.id, overlayId, patch)} onDelete={deleteOverlay} onDuration={durationMs => activeAsset && activeFrame && changeDuration(activeAsset.id, activeFrame.id, durationMs)} onRepeat={repeat => activeAsset && changeRepeat(activeAsset.id, repeat)} /></aside>
    </div>
    <footer className="app-status"><span><span className="status-dot" />로컬 작업</span><span className="status-shortcuts"><kbd>Space</kbd> 재생·정지<span>·</span><kbd>Space</kbd> + 드래그 이동<span>·</span>휠 확대</span><span>{activeAsset ? `${activeAsset.width} × ${activeAsset.height} px` : 'PNG · GIF · 스프라이트 시트'}</span></footer>
    {dialog === 'new' && <Modal title="새 캔버스" onClose={closeDialog} error={error}><p className="modal-description">투명한 캔버스에서 시작합니다.</p><label className="stacked-label">이름<input autoComplete="off" value={newSize.name} onChange={event => setNewSize(previous => ({ ...previous, name: event.target.value }))} /></label><div className="field-pair"><NumberField label="가로 (px)" value={newSize.width} min={1} max={2048} onChange={width => setNewSize(previous => ({ ...previous, width }))} /><NumberField label="세로 (px)" value={newSize.height} min={1} max={2048} onChange={height => setNewSize(previous => ({ ...previous, height }))} /></div><div className="size-presets">{[32, 64, 128, 160, 168, 256].map(size => <button key={size} type="button" className={newSize.width === size && newSize.height === size ? 'selected' : ''} onClick={() => setNewSize(previous => ({ ...previous, width: size, height: size }))}>{size}</button>)}</div><div className="modal-actions"><button type="button" className="secondary-button" onClick={closeDialog}>취소</button><button type="button" className="primary-button" onClick={createCanvas}>캔버스 만들기</button></div></Modal>}
    {dialog === 'sheet' && sheetAsset && <Modal title="스프라이트 시트 나누기" onClose={closeDialog} error={error} wide><div className="sheet-import-layout"><div className="sheet-preview checker-light"><PixelPreview pixels={sheetAsset.frames[0].pixels} width={sheetAsset.width} height={sheetAsset.height} /><span>{sheetAsset.width} × {sheetAsset.height}px</span></div><div><div className="field-pair"><NumberField label="프레임 가로" value={sheet.frameWidth} min={1} max={sheetAsset.width} onChange={frameWidth => setSheet(previous => ({ ...previous, frameWidth }))} /><NumberField label="프레임 세로" value={sheet.frameHeight} min={1} max={sheetAsset.height} onChange={frameHeight => setSheet(previous => ({ ...previous, frameHeight }))} /></div><div className="field-pair"><NumberField label="시작 X" value={sheet.offsetX} min={0} max={sheetAsset.width} onChange={offsetX => setSheet(previous => ({ ...previous, offsetX }))} /><NumberField label="시작 Y" value={sheet.offsetY} min={0} max={sheetAsset.height} onChange={offsetY => setSheet(previous => ({ ...previous, offsetY }))} /></div><div className="field-pair"><NumberField label="가로 간격" value={sheet.gapX} min={0} max={1024} onChange={gapX => setSheet(previous => ({ ...previous, gapX }))} /><NumberField label="세로 간격" value={sheet.gapY} min={0} max={1024} onChange={gapY => setSheet(previous => ({ ...previous, gapY }))} /></div><NumberField label="프레임 시간 (ms)" value={sheet.durationMs} min={10} max={60000} step={10} onChange={durationMs => setSheet(previous => ({ ...previous, durationMs }))} /><p className={`sheet-count ${validSheet ? '' : 'invalid'}`}>{validSheet ? `가로 ${sheetCols} × 세로 ${sheetRows} · 총 ${sheetCols * sheetRows}프레임` : '프레임 크기와 간격을 확인해 주세요. 최대 1024장까지 열 수 있어요.'}</p><p className="micro-help">왼쪽 위부터 가로 방향으로 읽습니다.<br />프레임보다 작은 가장자리 조각은 제외합니다.</p></div></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={closeDialog}>취소</button><button type="button" className="primary-button" disabled={!validSheet} onClick={importSheet}>프레임으로 열기</button></div></Modal>}
    {dialog === 'export' && activeAsset && <Modal title="이미지 저장" onClose={closeDialog} error={error}><div className="export-choices">{([{ value: 'png', name: '현재 프레임 PNG', description: '현재 칸의 프레임 한 장' }, { value: 'gif', name: '움직이는 GIF', description: '원래 프레임 시간과 순서' }, { value: 'sheet', name: '스프라이트 시트 PNG', description: '모든 프레임을 한 이미지로' }, { value: 'comparison', name: '비교 PNG', description: '원본 크기로 가로로 빈틈없이 붙이기' }] as const).map(option => <label key={option.value} className={exportType === option.value ? 'selected' : ''}><input type="radio" name="exportType" value={option.value} checked={exportType === option.value} onChange={() => setExportType(option.value)} /><span><strong>{option.name}</strong><small>{option.description}</small></span></label>)}</div>{exportType === 'sheet' && <NumberField label="한 줄의 프레임 수" value={exportColumns} min={1} max={activeAsset.frames.length} onChange={value => setExportColumns(Math.round(value))} />}<p className="export-aids-note">룰러와 실루엣은 화면 비교용이며 이미지에는 저장되지 않습니다.</p><p className="micro-help">PNG는 원래 픽셀과 투명도를 유지합니다.<br />GIF는 형식에 따라 색이나 반투명이 변환될 수 있어요.</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={closeDialog}>취소</button><button type="button" className="primary-button" onClick={exportFile}><Download size={16} />파일 내려받기</button></div></Modal>}
    {dialog === 'help' && <Modal title="도트 작업실 사용 방법" onClose={closeDialog} wide><div className="help-content"><section><h3>프레임을 나란히</h3><p>PNG·GIF를 열거나 작업대에 끌어 놓으세요. 프레임 아래의 ＋ 또는 <strong>옆에 고정</strong>으로 같은 원본의 프레임을 빈틈없이 붙입니다. 확대와 화면 이동은 모든 칸에 함께 적용되며, 재생과 프레임 선택은 따로 조절합니다. 수정 내용은 같은 파일을 보는 모든 칸에 공유됩니다. <strong>복제해 편집</strong>은 독립된 이미지 한 장을 만듭니다.</p><h3>실루엣으로 비교</h3><p>기준 프레임에서 <strong>실루엣 잡기</strong>를 누르고, 다른 칸을 선택한 뒤 <strong>이 칸에 실루엣 추가</strong>를 누르세요. 앞뒤 순서·불투명도·위치를 조절할 수 있습니다. 실루엣은 잡은 시점의 스냅샷입니다. 오른쪽 1단계에서 기준을 잡고, 2단계의 칸 번호와 미리보기로 겹칠 대상을 확인하세요. 선택한 실루엣만 좌우반전할 수도 있습니다. 실루엣과 자는 비교용이며 이미지에 저장되지 않습니다.</p><h3>그림과 실루엣 따로 이동</h3><p><strong>그림 전체 이동(V)</strong>으로 현재 프레임의 그림만 캔버스 안에서 옮깁니다. 실루엣과 자는 제자리에 남고, 그림이 잘리지 않는 범위에서 1픽셀 단위로 움직입니다. 오른쪽 목록에서 실루엣을 고르면 <strong>실루엣 이동(O)</strong>으로 전환되어 선택한 레이어만 옮깁니다. <strong>화면 이동(P)</strong>이나 Space+드래그는 작업대 화면을 함께 움직입니다.</p><h3>얇은 자로 비교</h3><p>직선 도구에서 <strong>룰러(자)</strong>를 고르거나 <kbd>R</kbd>을 누르세요. 여러 캔버스를 가로질러 픽셀 경계에 얇은 자를 그을 수 있습니다. 확대해도 얇게 유지되고, 새 자는 그리기 시작할 때의 브러시 색을 사용합니다. 오른쪽 목록에서 숨기거나 지울 수 있습니다.</p><h3>실행 취소와 좌우반전</h3><p><strong>Ctrl+Z</strong>로 도트·룰러·실루엣 편집을 최근 순서대로 되돌리고, <strong>Ctrl+Alt+Z</strong>로 다시 실행합니다. Ctrl+Y와 Ctrl+Shift+Z도 사용할 수 있습니다. 실루엣 드래그 한 번은 한 번에 되돌립니다. <strong>현재 프레임 좌우반전</strong>은 그림만, <strong>선택한 실루엣 좌우반전</strong>은 비교용 실루엣만 뒤집습니다. Space를 누른 채 드래그하면 어떤 도구에서든 잠시 화면을 옮기고, 놓으면 원래 도구로 돌아옵니다.</p><h3>작업 이어 하기</h3><p><strong>편집 상태 저장</strong>은 파일·픽셀·프레임 시간과 비교 칸·실루엣·자의 편집 설정을 따로 보관합니다. 실제 그림 파일은 <strong>이미지 저장</strong>에서 내려받으세요. 내려받은 작업 파일을 <strong>편집 상태 열기</strong>로 불러오세요. 파일은 서버에 업로드되지 않습니다.</p></section><section className="shortcut-list"><h3>단축키</h3>{tools.map(item => <div key={item.id}><kbd>{item.shortcut}</kbd><span>{item.label}</span></div>)}<div><kbd>Shift</kbd><span>직선을 가로·세로·45°로 고정</span></div><div><kbd>Space</kbd><span>누르고 놓으면 재생·정지</span></div><div><kbd>Space + 드래그</kbd><span>화면 이동</span></div><div><kbd>Alt + 드래그</kbd><span>선택한 실루엣 이동</span></div><div><kbd>Ctrl/⌘ + Z</kbd><span>최근 편집 실행 취소</span></div><div><kbd>Ctrl/⌘ + Alt + Z</kbd><span>다시 실행 (Y·Shift+Z도 가능)</span></div><div><kbd>Ctrl/⌘ + S</kbd><span>편집 상태 저장</span></div></section></div></Modal>}
  </div>;
}
