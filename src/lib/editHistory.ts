import type { RulerGuide, Silhouette } from '../types';

export interface OverlayState { overlays: Silhouette[]; selectedOverlayId: string | null }
export type EditCommand =
  | { kind: 'pixels'; label: string; assetId: string; frameId: string; before: Uint8ClampedArray; after: Uint8ClampedArray }
  | { kind: 'guides'; label: string; before: RulerGuide[]; after: RulerGuide[] }
  | { kind: 'overlays'; label: string; boardId: string; before: OverlayState; after: OverlayState }
  | { kind: 'duration'; label: string; assetId: string; frameId: string; before: number; after: number }
  | { kind: 'repeat'; label: string; assetId: string; before: number; after: number };
interface Entry { command: EditCommand; key?: string; time: number }

function merge(previous: EditCommand, next: EditCommand): EditCommand | null {
  if (previous.kind === 'overlays' && next.kind === 'overlays') return { ...next, before: previous.before };
  if (previous.kind === 'duration' && next.kind === 'duration') return { ...next, before: previous.before };
  if (previous.kind === 'repeat' && next.kind === 'repeat') return { ...next, before: previous.before };
  return null;
}

/** Chronological editing history. View changes never enter this timeline. */
export class EditHistory {
  private past: Entry[] = [];
  private future: Entry[] = [];
  private mayCoalesce = true;
  constructor(private limit = 40, private maxBytes = 64 * 1024 * 1024) {}
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  clear() { this.past = []; this.future = []; this.mayCoalesce = false; }
  push(command: EditCommand, key?: string, time = performance.now()): boolean {
    const hadRedo = this.future.length > 0;
    this.future = [];
    const previous = this.past.at(-1);
    const combined = this.mayCoalesce && !hadRedo && key && previous?.key === key && time - previous.time <= 500 ? merge(previous.command, command) : null;
    if (combined && previous) { previous.command = combined; previous.time = time; }
    else this.past.push({ command, key, time });
    this.mayCoalesce = true;
    while (this.past.length > this.limit || this.bytes() > this.maxBytes) this.past.shift();
    return this.past.length > 0;
  }
  undo(): EditCommand | undefined { this.mayCoalesce = false; const entry = this.past.pop(); if (entry) this.future.push(entry); return entry?.command; }
  redo(): EditCommand | undefined { this.mayCoalesce = false; const entry = this.future.pop(); if (entry) this.past.push(entry); return entry?.command; }
  private bytes(): number {
    const buffers = new Set<Uint8ClampedArray>(); let metadataBytes = 0;
    for (const { command } of [...this.past, ...this.future]) {
      if (command.kind === 'pixels') { buffers.add(command.before); buffers.add(command.after); }
      if (command.kind === 'overlays') for (const state of [command.before, command.after]) { for (const overlay of state.overlays) buffers.add(overlay.pixels); metadataBytes += state.overlays.length * 256; }
      if (command.kind === 'guides') metadataBytes += (command.before.length + command.after.length) * 160;
    }
    return [...buffers].reduce((total, pixels) => total + pixels.byteLength, metadataBytes);
  }
}
