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
