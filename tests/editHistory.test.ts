import { describe, expect, it } from 'vitest';
import { EditHistory } from '../src/lib/editHistory';
import type { EditCommand, OverlayState } from '../src/lib/editHistory';
import type { RulerGuide, Silhouette } from '../src/types';

const duration = (before: number, after: number): EditCommand => ({
  kind: 'duration', label: `${before}→${after}ms`, assetId: 'asset-a', frameId: 'frame-a', before, after,
});
const pixel = (before: Uint8ClampedArray, after: Uint8ClampedArray, label: string): EditCommand => ({
  kind: 'pixels', label, assetId: 'asset-a', frameId: 'frame-a', before, after,
});
function shadow(x: number): Silhouette {
  return { id: 'shadow-a', name: '기준', width: 1, height: 1, pixels: Uint8ClampedArray.from([70, 20, 180, 128]), color: '#4614b4', opacity: 0.5, x, y: 0, scale: 1, order: 'front', visible: true };
}

describe('chronological editing history', () => {
  it('undoes and redoes mixed artwork, guides, overlays, timing, and repeat edits in one chronological order', () => {
    const history = new EditHistory();
    const before = Uint8ClampedArray.from([11, 22, 33, 0]), after = Uint8ClampedArray.from([40, 50, 60, 128]);
    const guide: RulerGuide = { id: 'g', x1: 0, y1: 0, x2: 160, y2: 0, color: '#ff7799', visible: true };
    const empty: OverlayState = { overlays: [], selectedOverlayId: null };
    const placed: OverlayState = { overlays: [shadow(4)], selectedOverlayId: 'shadow-a' };
    const commands: EditCommand[] = [
      pixel(before, after, '한 점 그리기'),
      { kind: 'guides', label: '눈금선 추가', before: [], after: [guide] },
      { kind: 'overlays', label: '실루엣 추가', boardId: 'board-b', before: empty, after: placed },
      duration(100, 200),
      { kind: 'repeat', label: '반복 횟수', assetId: 'asset-a', before: 0, after: 3 },
    ];
    const state = { pixels: before, guides: [] as RulerGuide[], overlay: empty, duration: 100, repeat: 0 };
    const apply = (command: EditCommand, side: 'before' | 'after') => {
      switch (command.kind) {
        case 'pixels': state.pixels = command[side]; break;
        case 'guides': state.guides = command[side]; break;
        case 'overlays': state.overlay = command[side]; break;
        case 'duration': state.duration = command[side]; break;
        case 'repeat': state.repeat = command[side]; break;
      }
    };
    const checkpoints = [structuredClone(state)];
    for (const command of commands) {
      history.push(command); apply(command, 'after'); checkpoints.push(structuredClone(state));
    }
    for (let index = commands.length - 1; index >= 0; index--) {
      const command = history.undo();
      expect(command?.label).toBe(commands[index].label);
      apply(command!, 'before'); expect(state).toEqual(checkpoints[index]);
    }
    expect(history.canUndo).toBe(false); expect(history.canRedo).toBe(true);
    for (let index = 0; index < commands.length; index++) {
      const command = history.redo();
      expect(command?.label).toBe(commands[index].label);
      apply(command!, 'after'); expect(state).toEqual(checkpoints[index + 1]);
    }
    expect(history.canUndo).toBe(true); expect(history.canRedo).toBe(false);
  });

  it('discards every abandoned redo after a new edit, including commands of a different type', () => {
    const history = new EditHistory();
    history.push(duration(100, 200));
    history.push({ kind: 'repeat', label: '반복', assetId: 'asset-a', before: 0, after: 2 });
    history.undo();
    history.push({ kind: 'guides', label: '눈금선', before: [], after: [] });
    expect(history.canRedo).toBe(false); expect(history.redo()).toBeUndefined();
    expect(history.undo()?.kind).toBe('guides');
    expect(history.undo()).toMatchObject({ kind: 'duration', before: 100, after: 200 });
    expect(history.undo()).toBeUndefined();
  });

  it('coalesces repeated property updates to the initial value and latest value', () => {
    const history = new EditHistory();
    history.push(duration(100, 120), 'duration:asset-a:frame-a', 100);
    history.push(duration(120, 150), 'duration:asset-a:frame-a', 200);
    history.push(duration(150, 170), 'duration:asset-a:frame-a', 300);
    expect(history.undo()).toMatchObject({ before: 100, after: 170 });
    expect(history.canUndo).toBe(false);
    expect(history.redo()).toMatchObject({ before: 100, after: 170 });
  });

  it('also coalesces overlay changes without losing the original transform', () => {
    const history = new EditHistory();
    const initial: OverlayState = { overlays: [shadow(0)], selectedOverlayId: 'shadow-a' };
    const middle: OverlayState = { overlays: [shadow(2)], selectedOverlayId: 'shadow-a' };
    const final: OverlayState = { overlays: [shadow(9)], selectedOverlayId: 'shadow-a' };
    history.push({ kind: 'overlays', label: '실루엣 X', boardId: 'board-a', before: initial, after: middle }, 'overlay:shadow-a:x', 100);
    history.push({ kind: 'overlays', label: '실루엣 X', boardId: 'board-a', before: middle, after: final }, 'overlay:shadow-a:x', 200);
    expect(history.undo()).toMatchObject({ kind: 'overlays', before: initial, after: final });
    expect(history.canUndo).toBe(false);
  });

  it('coalesces repeat edits but keeps different field keys and separated gestures distinct', () => {
    const history = new EditHistory();
    history.push({ kind: 'repeat', label: '반복', assetId: 'asset-a', before: 0, after: 2 }, 'repeat:asset-a', 100);
    history.push({ kind: 'repeat', label: '반복', assetId: 'asset-a', before: 2, after: 4 }, 'repeat:asset-a', 200);
    history.push(duration(100, 120), 'duration:frame-a', 250);
    history.push(duration(120, 140), 'different-field', 300);
    history.push(duration(140, 160), 'different-field', 1000);
    expect(history.undo()).toMatchObject({ before: 140, after: 160 });
    expect(history.undo()).toMatchObject({ before: 120, after: 140 });
    expect(history.undo()).toMatchObject({ before: 100, after: 120 });
    expect(history.undo()).toMatchObject({ kind: 'repeat', before: 0, after: 4 });
    expect(history.undo()).toBeUndefined();
  });

  it('does not coalesce pixel edits even if a caller supplies the same property key', () => {
    const history = new EditHistory(), a = new Uint8ClampedArray(4), b = Uint8ClampedArray.from([1, 2, 3, 4]), c = Uint8ClampedArray.from([4, 3, 2, 1]);
    history.push(pixel(a, b, '첫 획'), 'same-key', 100);
    history.push(pixel(b, c, '다음 획'), 'same-key', 200);
    expect(history.undo()?.label).toBe('다음 획'); expect(history.undo()?.label).toBe('첫 획');
  });

  it('keeps a new same-field gesture after undo/redo separate even inside the coalescing window', () => {
    const history = new EditHistory();
    history.push(duration(100, 120), 'duration:frame-a', 100);
    history.undo(); history.redo();
    history.push(duration(120, 140), 'duration:frame-a', 200);
    expect(history.undo()).toMatchObject({ before: 120, after: 140 });
    expect(history.undo()).toMatchObject({ before: 100, after: 120 });
    expect(history.undo()).toBeUndefined();
  });

  it('starts a new branch without merging it into an earlier gesture of the same property', () => {
    const history = new EditHistory();
    history.push(duration(100, 120), 'duration:frame-a', 100);
    history.push({ kind: 'repeat', label: '반복', assetId: 'asset-a', before: 0, after: 2 });
    history.undo();
    history.push(duration(120, 140), 'duration:frame-a', 200);
    expect(history.undo()).toMatchObject({ before: 120, after: 140 });
    expect(history.undo()).toMatchObject({ before: 100, after: 120 });
    expect(history.canRedo).toBe(true);
  });

  it('evicts the oldest edit at the count limit without resurrecting it through redo', () => {
    const history = new EditHistory(2);
    history.push(duration(100, 120)); history.push(duration(120, 140)); history.push(duration(140, 160));
    expect(history.undo()).toMatchObject({ before: 140, after: 160 });
    expect(history.undo()).toMatchObject({ before: 120, after: 140 });
    expect(history.undo()).toBeUndefined();
    expect(history.redo()).toMatchObject({ before: 120, after: 140 });
    expect(history.redo()).toMatchObject({ before: 140, after: 160 });
    expect(history.redo()).toBeUndefined();
  });

  it('counts shared pixel snapshots once and evicts the oldest command only when another buffer exceeds the budget', () => {
    const history = new EditHistory(40, 12);
    const a = new Uint8ClampedArray(4), b = new Uint8ClampedArray(4), c = new Uint8ClampedArray(4), d = new Uint8ClampedArray(4);
    history.push(pixel(a, b, 'A→B')); history.push(pixel(b, c, 'B→C'));
    expect(history.undo()?.label).toBe('B→C'); expect(history.undo()?.label).toBe('A→B');
    history.redo(); history.redo(); history.push(pixel(c, d, 'C→D'));
    expect(history.undo()?.label).toBe('C→D'); expect(history.undo()?.label).toBe('B→C');
    expect(history.undo()).toBeUndefined();
  });

  it('releases discarded redo buffers before assessing the budget of a new branch', () => {
    const history = new EditHistory(40, 12);
    const a = new Uint8ClampedArray(4), b = new Uint8ClampedArray(4), c = new Uint8ClampedArray(4), d = new Uint8ClampedArray(4);
    history.push(pixel(a, b, 'A→B')); history.push(pixel(b, c, 'B→C')); history.undo();
    history.push(pixel(b, d, 'B→D'));
    expect(history.canRedo).toBe(false);
    expect(history.undo()?.label).toBe('B→D'); expect(history.undo()?.label).toBe('A→B');
    expect(history.undo()).toBeUndefined();
  });

  it('does not retain an over-budget command or leave a stale redo chain', () => {
    const history = new EditHistory(40, 8);
    history.push(duration(100, 120)); history.undo();
    expect(history.push(pixel(new Uint8ClampedArray(8), new Uint8ClampedArray(8), '너무 큰 편집'))).toBe(false);
    expect(history.canUndo).toBe(false); expect(history.canRedo).toBe(false);
    expect(history.undo()).toBeUndefined(); expect(history.redo()).toBeUndefined();
  });

  it('includes large silhouette buffers in its memory limit and clears both history directions', () => {
    const history = new EditHistory(40, 1000);
    const large = { ...shadow(0), width: 20, height: 20, pixels: new Uint8ClampedArray(20 * 20 * 4) };
    expect(history.push({ kind: 'overlays', label: '큰 실루엣', boardId: 'board-a', before: { overlays: [], selectedOverlayId: null }, after: { overlays: [large], selectedOverlayId: large.id } })).toBe(false);
    history.push(duration(100, 120)); history.push(duration(120, 140)); history.undo(); history.clear();
    expect(history.canUndo).toBe(false); expect(history.canRedo).toBe(false);
    expect(history.undo()).toBeUndefined(); expect(history.redo()).toBeUndefined();
    expect(history.push(duration(140, 160))).toBe(true);
    expect(history.undo()).toMatchObject({ before: 140, after: 160 });
  });
});
