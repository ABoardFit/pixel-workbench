import { describe, expect, it } from 'vitest';
import { compositeFrame, makeSilhouette, paintStroke, snapLineEnd } from '../src/lib/pixels';
import type { Silhouette } from '../src/types';
import { decodeGif, decodePng, encodeGif, encodePng, encodeSpriteSheet, splitSpriteSheet } from '../src/lib/formats';
import { deserializeProject, serializeProject } from '../src/lib/project';
import { decompressFrames, parseGIF } from 'gifuct-js';
import { disposalGifFixture, expectedDisposalPixels, rgbaFixture } from './fixtures.mjs';

describe('independent editor regressions', () => {
  it('shortens an oblique Shift line at the first edge while keeping an exact diagonal', () => {
    const start = { x: 1, y: 1 };
    const endpoint = snapLineEnd(start, { x: 100, y: 61 }, 7, 4);
    expect(endpoint).toEqual({ x: 3, y: 3 });
    const pixels = new Uint8ClampedArray(7 * 4 * 4);
    paintStroke(pixels, 7, 4, start, endpoint, [19, 37, 83, 255]);
    const occupied: number[] = [];
    for (let p = 0; p < 28; p++) if (pixels[p * 4 + 3]) occupied.push(p);
    expect(occupied).toEqual([8, 16, 24]);
  });

  it.each([
    [{ x: 100, y: 1 }, { x: 4, y: 2 }],
    [{ x: -100, y: 1 }, { x: 0, y: 2 }],
    [{ x: 1, y: 100 }, { x: 2, y: 4 }],
    [{ x: 1, y: -100 }, { x: 2, y: 0 }],
    [{ x: 100, y: 90 }, { x: 4, y: 4 }],
    [{ x: -100, y: 90 }, { x: 0, y: 4 }],
    [{ x: 100, y: -90 }, { x: 4, y: 0 }],
    [{ x: -100, y: -90 }, { x: 0, y: 0 }],
  ])('keeps Shift-constrained endpoint on the selected ray %j', (pointer, expected) => {
    expect(snapLineEnd({ x: 2, y: 2 }, pointer, 5, 5)).toEqual(expected);
  });

  it('uses a single silhouette color with source coverage, as a detached snapshot', () => {
    const source = Uint8ClampedArray.from([17, 33, 65, 255, 201, 19, 91, 128, 7, 99, 13, 0]);
    const mask = makeSilhouette(source, [51, 102, 153, 255]);
    source[3] = 0;
    expect(Array.from(mask)).toEqual([51, 102, 153, 255, 51, 102, 153, 128, 51, 102, 153, 0]);
  });

  it('honors front/back, X/Y translation and opacity without modifying editable pixels', () => {
    const native = Uint8ClampedArray.from([200, 40, 20, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const before = new Uint8ClampedArray(native);
    const overlay: Silhouette = { id: 'mask', name: 'test', width: 1, height: 1,
      pixels: Uint8ClampedArray.from([20, 80, 220, 255]), color: '#1450dc', opacity: 0.5,
      x: 0, y: 0, scale: 1, order: 'front', visible: true };
    expect(Array.from(compositeFrame(native, 2, 2, [overlay]).slice(0, 4))).toEqual([110, 60, 120, 255]);
    expect(Array.from(compositeFrame(native, 2, 2, [{ ...overlay, order: 'back' }]).slice(0, 4))).toEqual([200, 40, 20, 255]);
    const shifted = compositeFrame(native, 2, 2, [{ ...overlay, x: 1, y: 1 }]);
    expect(Array.from(shifted.slice(12, 16))).toEqual([20, 80, 220, 128]);
    expect(native).toEqual(before);
  });
});

describe('independent format and project regressions', () => {
  it('decodes real GIF partial rectangles, restore-previous and clear-background with original timing', () => {
    const asset = decodeGif(disposalGifFixture().buffer, 'disposal.gif');
    expect([asset.width, asset.height]).toEqual([2, 2]);
    expect(asset.frames.map((frame) => frame.durationMs)).toEqual([70, 130, 190, 230]);
    expect(asset.frames.map((frame) => Array.from(frame.pixels))).toEqual(expectedDisposalPixels);
  });

  it('round-trips arbitrary RGBA PNG bytes including hidden transparent RGB', async () => {
    const original = Uint8ClampedArray.from(rgbaFixture.data);
    const blob = encodePng(original, 4, 4);
    const decoded = decodePng(await blob.arrayBuffer(), 'rgba.png');
    expect(decoded.frames[0].pixels).toEqual(original);
  });

  it('splits offset/gapped sheet in row-major order and exports original native pixels', async () => {
    const pixels = new Uint8ClampedArray(7 * 5 * 4);
    const colors = [[17, 33, 65, 255], [201, 19, 91, 128], [7, 99, 13, 0], [1, 222, 3, 255]];
    [[1, 1], [4, 1], [1, 3], [4, 3]].forEach(([left, top], frame) => {
      for (let dx = 0; dx < 2; dx++) pixels.set(colors[frame], (top * 7 + left + dx) * 4);
    });
    const asset = { id: 'sheet', name: 'offsets.png', width: 7, height: 5, repeat: 0,
      frames: [{ id: 'image', pixels, durationMs: 100 }] };
    const split = splitSpriteSheet(asset, { frameWidth: 2, frameHeight: 1, offsetX: 1, offsetY: 1, gapX: 1, gapY: 1, durationMs: 73 });
    expect(split.frames.map((frame) => Array.from(frame.pixels))).toEqual(colors.map((color) => [...color, ...color]));
    expect(split.frames.map((frame) => frame.durationMs)).toEqual([73, 73, 73, 73]);
    const exported = decodePng(await encodeSpriteSheet(split, 2).arrayBuffer(), 'export.png');
    expect([exported.width, exported.height]).toEqual([4, 2]);
    expect(Array.from(exported.frames[0].pixels)).toEqual(colors.flatMap((color) => [...color, ...color]));
  });

  it('exports transparent GIF without trailing old pixels or altering supported RGB colors', async () => {
    const asset = decodeGif(disposalGifFixture().buffer, 'fixture.gif');
    const exported = encodeGif(asset);
    expect(exported.quantized).toBe(false);
    const restored = decodeGif(await exported.blob.arrayBuffer(), 'roundtrip.gif');
    expect(restored.frames.map((frame) => Array.from(frame.pixels))).toEqual(expectedDisposalPixels);
    expect(restored.frames.map((frame) => frame.durationMs)).toEqual([70, 130, 190, 230]);
  });

  it('declares transparent clearing on every GIF frame when transparency appears later', async () => {
    const asset = { id: 'mixed', name: 'mixed.gif', width: 2, height: 1, repeat: 0, frames: [
      { id: 'opaque', durationMs: 70, pixels: Uint8ClampedArray.from([221, 12, 25, 255, 221, 12, 25, 255]) },
      { id: 'transparent', durationMs: 130, pixels: Uint8ClampedArray.from([0, 0, 0, 0, 7, 119, 31, 255]) },
    ] };
    const encoded = encodeGif(asset);
    expect(encoded.quantized).toBe(false);
    const parsed = parseGIF(await encoded.blob.arrayBuffer());
    const frames = parsed.frames.filter((frame) => 'image' in frame);
    expect(frames.map((frame) => frame.gce.extras.transparentColorGiven)).toEqual([true, true]);
    expect(frames.map((frame) => frame.gce.transparentColorIndex)).toEqual([0, 0]);
    expect(frames.map((frame) => frame.gce.extras.disposal)).toEqual([2, 2]);
    expect(decompressFrames(parsed, true).map((frame) => Array.from(frame.patch))).toEqual(asset.frames.map((frame) => Array.from(frame.pixels)));
  });

  it('restores independent paused board frames, exact pixels and overlay transforms from saved project', async () => {
    const asset = decodeGif(disposalGifFixture().buffer, 'fixture.gif');
    const overlay: Silhouette = { id: 'mask', name: 'saved mask', width: 1, height: 1,
      pixels: Uint8ClampedArray.from([55, 99, 222, 128]), color: '#3763de', opacity: 0.37,
      x: -3, y: 9, scale: 2, order: 'back', visible: true };
    const board = { id: 'boardA', assetId: asset.id, frameIndex: 2, playing: true, speed: 0.75,
      zoom: 13, panX: 17, panY: -6, overlays: [overlay], selectedOverlayId: overlay.id };
    const project = { version: 1 as const, assets: [asset], boards: [board, { ...board, id: 'boardB', frameIndex: 0, zoom: 0.05 }], activeBoardId: 'boardB' };
    const restored = deserializeProject(await serializeProject(project).text());
    expect(restored.assets[0].frames.map((frame) => Array.from(frame.pixels))).toEqual(expectedDisposalPixels);
    expect(restored.boards.map((board) => [board.id, board.frameIndex, board.playing])).toEqual([['boardA', 2, false], ['boardB', 0, false]]);
    expect(restored.boards[0].overlays[0]).toEqual(overlay);
    expect(restored.boards[0].panX).toBe(17);
    expect(restored.boards[0].panY).toBe(-6);
    expect(restored.boards[1].zoom).toBe(0.05);
    expect(restored.activeBoardId).toBe('boardB');
  });
});
