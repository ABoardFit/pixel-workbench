import { describe, expect, it } from 'vitest';
import { deserializeProject, serializeProject } from '../src/lib/project';
import type { WorkspaceProject } from '../src/types';

const fixture = (): WorkspaceProject => ({
  version: 1,
  assets: [{
    id: 'asset-a', name: '원본.gif', width: 2, height: 1, repeat: 3,
    frames: [
      { id: 'f0', pixels: Uint8ClampedArray.from([1, 2, 3, 0, 200, 100, 50, 128]), durationMs: 70 },
      { id: 'f1', pixels: Uint8ClampedArray.from([0, 0, 0, 255, 244, 12, 109, 253]), durationMs: 210 },
    ],
  }],
  boards: [{
    id: 'board-a', assetId: 'asset-a', frameIndex: 1, playing: true, speed: 1.5, zoom: 7, panX: -14, panY: 8,
    selectedOverlayId: 'overlay-a', overlays: [{
      id: 'overlay-a', name: '검 기준', width: 1, height: 1, pixels: Uint8ClampedArray.from([130, 0, 200, 120]),
      color: '#8200c8', opacity: 0.4, x: -2, y: 3, scale: 2.5, order: 'back', visible: true,
    }],
  }],
  activeBoardId: 'board-a',
});

describe('project persistence', () => {
  it('restores buffers, timing, overlay settings, and references exactly while pausing playback', async () => {
    const source = fixture();
    const restored = deserializeProject(await serializeProject(source).text());
    const expected = fixture(); expected.boards[0].playing = false;
    expect(restored).toEqual(expected);
    expect(restored.assets[0].frames[0].pixels).toBeInstanceOf(Uint8ClampedArray);
    expect(restored.assets[0].frames[0].pixels).not.toBe(source.assets[0].frames[0].pixels);
  });
  it('encodes buffers larger than function argument limits without spread conversion', async () => {
    const source = fixture();
    source.assets[0].width = 256; source.assets[0].height = 256;
    for (const frame of source.assets[0].frames) frame.pixels = Uint8ClampedArray.from({ length: 256 * 256 * 4 }, (_, i) => i % 256);
    const restored = deserializeProject(await serializeProject(source).text());
    expect(restored.assets[0].frames[1].pixels).toEqual(source.assets[0].frames[1].pixels);
  });
  it('can save a large-image board fitted to the UI minimum zoom', async () => {
    const project = fixture(); project.boards[0].zoom = 0.05;
    expect(deserializeProject(await serializeProject(project).text()).boards[0].zoom).toBe(0.05);
  });
  it('roundtrips ruler and joined-view metadata without baking any aid into asset pixels', async () => {
    const project = fixture();
    const originalPixels = project.assets[0].frames.map((frame) => frame.pixels.slice());
    project.guides = [
      { id: 'across-boards', x1: 0, y1: 0, x2: 320, y2: 160, color: '#00D2FF', visible: true },
      { id: 'hidden-outside', x1: -50, y1: -10, x2: 1000, y2: 50, color: '#ee7799', visible: false },
    ];
    project.joinedView = { zoom: 0.05, panX: -140, panY: 68 };
    const restored = deserializeProject(await serializeProject(project).text());
    expect(restored.guides).toEqual(project.guides);
    expect(restored.joinedView).toEqual(project.joinedView);
    for (let i = 0; i < originalPixels.length; i++) {
      expect(restored.assets[0].frames[i].pixels).toEqual(originalPixels[i]);
      expect(project.assets[0].frames[i].pixels).toEqual(originalPixels[i]);
    }
    expect(restored.boards[0].overlays[0].pixels).toEqual(project.boards[0].overlays[0].pixels);
  });
  it('loads old v1 projects without requiring or injecting ruler metadata', async () => {
    const project = deserializeProject(await serializeProject(fixture()).text());
    expect(project.version).toBe(1);
    expect(Object.hasOwn(project, 'guides')).toBe(false);
    expect(Object.hasOwn(project, 'joinedView')).toBe(false);
  });
  it.each([
    ['duplicate guide IDs', [{ id: 'g', x1: 0, y1: 0, x2: 1, y2: 1, color: '#aabbcc', visible: true }, { id: 'g', x1: 1, y1: 1, x2: 2, y2: 2, color: '#aabbcc', visible: false }]],
    ['nonfinite guide coordinates', [{ id: 'g', x1: 0, y1: null, x2: 1, y2: 1, color: '#aabbcc', visible: true }]],
    ['invalid guide colors', [{ id: 'g', x1: 0, y1: 0, x2: 1, y2: 1, color: 'red', visible: true }]],
    ['invalid guide visibility', [{ id: 'g', x1: 0, y1: 0, x2: 1, y2: 1, color: '#aabbcc', visible: 'false' }]],
  ])('rejects corrupt %s before restoring a project', async (_label, guides) => {
    const value = JSON.parse(await serializeProject(fixture()).text()); value.guides = guides;
    expect(() => deserializeProject(JSON.stringify(value))).toThrow(/프로젝트 파일이 올바르지 않습니다/);
  });
  it('rejects invalid shared-view settings while accepting absent optional fields', async () => {
    const value = JSON.parse(await serializeProject(fixture()).text());
    value.joinedView = { zoom: 0, panX: 0, panY: 0 };
    expect(() => deserializeProject(JSON.stringify(value))).toThrow(/확대 배율/);
  });
  it.each([
    ['unavailable asset', (value: Record<string, unknown>) => { (value.boards as { assetId: string }[])[0].assetId = 'missing'; }],
    ['invalid active board', (value: Record<string, unknown>) => { value.activeBoardId = 'missing'; }],
    ['duplicate asset ID', (value: Record<string, unknown>) => { (value.assets as unknown[]).push((value.assets as unknown[])[0]); }],
    ['missing frame data', (value: Record<string, unknown>) => { ((value.assets as { frames: { pixels: string }[] }[])[0].frames[0]).pixels = ''; }],
    ['invalid frame index', (value: Record<string, unknown>) => { (value.boards as { frameIndex: number }[])[0].frameIndex = 12; }],
  ])('rejects %s with a readable project error', async (_name, mutate) => {
    const value = JSON.parse(await serializeProject(fixture()).text());
    mutate(value);
    expect(() => deserializeProject(JSON.stringify(value))).toThrow(/프로젝트 파일이 올바르지 않습니다/);
  });
  it('rejects unsupported versions and malformed JSON', () => {
    expect(() => deserializeProject('{')).toThrow(/JSON/);
    expect(() => deserializeProject('{"version":2}')).toThrow(/버전/);
  });
});
