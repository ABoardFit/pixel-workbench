import type { EditorBoard, PixelFrame, RulerGuide, Silhouette, SpriteAsset, WorkspaceProject } from '../types';

const MAX_TOTAL_BYTES = 268_435_456;
const MAX_ITEMS = 2048;
type RecordValue = Record<string, unknown>;
function fail(message: string): never { throw new Error(`프로젝트 파일이 올바르지 않습니다. ${message}`); }

function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 정보를 확인해 주세요.`);
  return value as RecordValue;
}
function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) fail(`${label} 목록이 없거나 너무 큽니다.`);
  return value;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096) fail(`${label} 값이 올바르지 않습니다.`);
  return value;
}
function numeric(value: unknown, label: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    fail(`${label} 값이 올바르지 않습니다.`);
  }
  return value;
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`${label} 값이 올바르지 않습니다.`);
  return value;
}
function unique(ids: string[], label: string): void {
  if (new Set(ids).size !== ids.length) fail(`${label} 식별자가 중복되어 있습니다.`);
}

function encodePixels(pixels: Uint8ClampedArray): string {
  const chunks: string[] = [];
  for (let i = 0; i < pixels.length; i += 8192) {
    let part = '';
    for (let p = i; p < Math.min(i + 8192, pixels.length); p++) part += String.fromCharCode(pixels[p]);
    chunks.push(part);
  }
  return btoa(chunks.join(''));
}

/** Lossless JSON project. Typed pixel buffers use base64 rather than lossy Canvas readback. */
export function serializeProject(project: WorkspaceProject): Blob {
  const serialized = {
    ...project,
    assets: project.assets.map((asset) => ({ ...asset, frames: asset.frames.map((frame) => ({ ...frame, pixels: encodePixels(frame.pixels) })) })),
    boards: project.boards.map((board) => ({ ...board, playing: false, overlays: board.overlays.map((overlay) => ({ ...overlay, pixels: encodePixels(overlay.pixels) })) })),
  };
  const json = JSON.stringify(serialized);
  // Apply the same dimensions, reference, and buffer checks to locally generated saves.
  deserializeProject(json);
  return new Blob([json], { type: 'application/json' });
}

/** Validate schema and references before restoring editable typed arrays; playback always starts paused. */
export function deserializeProject(jsonText: string): WorkspaceProject {
  if (typeof jsonText !== 'string' || jsonText.length > MAX_TOTAL_BYTES * 1.5) fail('파일이 너무 큽니다.');
  let value: unknown;
  try { value = JSON.parse(jsonText); } catch { fail('JSON 내용을 읽을 수 없습니다.'); }
  const root = record(value, '프로젝트');
  if (root.version !== 1) fail('지원하지 않는 프로젝트 버전입니다.');
  let totalBytes = 0;
  const size = (obj: RecordValue) => {
    const width = numeric(obj.width, '가로 크기', 1, 8192, true), height = numeric(obj.height, '세로 크기', 1, 8192, true);
    if (width * height > 16_777_216) fail('이미지의 픽셀 수가 너무 큽니다.');
    return { width, height };
  };
  const decodePixels = (data: unknown, bytes: number) => {
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) fail('전체 픽셀 데이터가 너무 큽니다.');
    if (typeof data !== 'string' || data.length !== Math.ceil(bytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) fail('픽셀 데이터의 길이나 인코딩이 올바르지 않습니다.');
    let binary: string;
    try { binary = atob(data); } catch { fail('픽셀 데이터를 읽을 수 없습니다.'); }
    if (binary.length !== bytes) fail('이미지 크기와 픽셀 수가 맞지 않습니다.');
    const pixels = new Uint8ClampedArray(bytes);
    for (let i = 0; i < bytes; i++) pixels[i] = binary.charCodeAt(i);
    return pixels;
  };
  const assets: SpriteAsset[] = list(root.assets, '이미지').map((item) => {
    const obj = record(item, '이미지'), { width, height } = size(obj);
    const frames: PixelFrame[] = list(obj.frames, '프레임').map((item) => {
      const frame = record(item, '프레임');
      return {
        id: text(frame.id, '프레임 식별자'),
        durationMs: numeric(frame.durationMs, '프레임 시간', 0, 86_400_000),
        pixels: decodePixels(frame.pixels, width * height * 4),
      };
    });
    if (!frames.length) fail('이미지에 프레임이 없습니다.');
    unique(frames.map((frame) => frame.id), '프레임');
    return { id: text(obj.id, '이미지 식별자'), name: text(obj.name, '이미지 이름'), width, height, frames, repeat: numeric(obj.repeat, '반복 횟수', -1, 65535, true) };
  });
  unique(assets.map((asset) => asset.id), '이미지');
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const boards: EditorBoard[] = list(root.boards, '보드').map((item) => {
    const obj = record(item, '보드'), assetId = text(obj.assetId, '보드 이미지');
    const asset = assetsById.get(assetId);
    if (!asset) fail('보드가 없는 이미지를 참조하고 있습니다.');
    const overlays: Silhouette[] = list(obj.overlays, '실루엣').map((item) => {
      const overlay = record(item, '실루엣'), { width, height } = size(overlay);
      if (overlay.order !== 'front' && overlay.order !== 'back') fail('실루엣의 앞뒤 순서가 올바르지 않습니다.');
      const color = text(overlay.color, '실루엣 색');
      if (!/^#[0-9a-f]{6}$/i.test(color)) fail('실루엣 색은 HEX 색상이어야 합니다.');
      return {
        id: text(overlay.id, '실루엣 식별자'), name: text(overlay.name, '실루엣 이름'), width, height,
        pixels: decodePixels(overlay.pixels, width * height * 4), color,
        opacity: numeric(overlay.opacity, '실루엣 투명도', 0, 1),
        x: numeric(overlay.x, '실루엣 X', -1_000_000, 1_000_000), y: numeric(overlay.y, '실루엣 Y', -1_000_000, 1_000_000),
        scale: numeric(overlay.scale, '실루엣 배율', 0.01, 256), order: overlay.order,
        visible: boolean(overlay.visible, '실루엣 표시'),
      };
    });
    unique(overlays.map((overlay) => overlay.id), '실루엣');
    const selectedOverlayId = obj.selectedOverlayId === null ? null : text(obj.selectedOverlayId, '선택 실루엣');
    if (selectedOverlayId !== null && !overlays.some((overlay) => overlay.id === selectedOverlayId)) fail('선택 실루엣을 찾을 수 없습니다.');
    boolean(obj.playing, '재생 상태');
    return {
      id: text(obj.id, '보드 식별자'), assetId,
      frameIndex: numeric(obj.frameIndex, '선택 프레임', 0, asset.frames.length - 1, true), playing: false,
      speed: numeric(obj.speed, '재생 속도', 0.01, 100), zoom: numeric(obj.zoom, '확대 배율', 0.05, 256),
      panX: numeric(obj.panX, '이동 X', -1_000_000, 1_000_000), panY: numeric(obj.panY, '이동 Y', -1_000_000, 1_000_000),
      overlays, selectedOverlayId,
    };
  });
  unique(boards.map((board) => board.id), '보드');
  // Optional v1 metadata: guides live in joined-workspace coordinates and never
  // enter an asset's RGBA buffer. Keep guides outside the current board extent
  // so temporarily removing or rearranging boards does not discard them.
  const guides: RulerGuide[] | undefined = root.guides === undefined ? undefined : list(root.guides, '눈금선').map((item) => {
    const guide = record(item, '눈금선'), color = text(guide.color, '눈금선 색');
    if (!/^#[0-9a-f]{6}$/i.test(color)) fail('눈금선 색은 HEX 색상이어야 합니다.');
    return {
      id: text(guide.id, '눈금선 식별자'),
      x1: numeric(guide.x1, '눈금선 시작 X', -1_000_000, 1_000_000),
      y1: numeric(guide.y1, '눈금선 시작 Y', -1_000_000, 1_000_000),
      x2: numeric(guide.x2, '눈금선 끝 X', -1_000_000, 1_000_000),
      y2: numeric(guide.y2, '눈금선 끝 Y', -1_000_000, 1_000_000),
      color, visible: boolean(guide.visible, '눈금선 표시'),
    };
  });
  if (guides) unique(guides.map((guide) => guide.id), '눈금선');
  let joinedView: WorkspaceProject['joinedView'];
  if (root.joinedView !== undefined) {
    const view = record(root.joinedView, '이어 보기');
    joinedView = {
      zoom: numeric(view.zoom, '이어 보기 확대 배율', 0.05, 256),
      panX: numeric(view.panX, '이어 보기 이동 X', -1_000_000, 1_000_000),
      panY: numeric(view.panY, '이어 보기 이동 Y', -1_000_000, 1_000_000),
    };
  }
  const activeBoardId = root.activeBoardId === null ? null : text(root.activeBoardId, '활성 보드');
  if (activeBoardId !== null && !boards.some((board) => board.id === activeBoardId)) fail('활성 보드를 찾을 수 없습니다.');
  const project: WorkspaceProject = { version: 1, assets, boards, activeBoardId };
  if (guides !== undefined) project.guides = guides;
  if (joinedView !== undefined) project.joinedView = joinedView;
  return project;
}
