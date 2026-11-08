import { describe, expect, it } from 'vitest';
import { decodeGif, encodeGif } from '../src/lib/formats';
import { parseGIF } from 'gifuct-js';
import { GIFEncoder } from 'gifenc';
import type { SpriteAsset } from '../src/types';

function assetWithColors(count: number, transparent: boolean): SpriteAsset {
  const width = count + (transparent ? 1 : 0), pixels = new Uint8ClampedArray(width * 4);
  for (let x = 0; x < count; x++) pixels.set([x, 17, 31, 255], x * 4);
  if (transparent) pixels.set([0, 255, 0, 0], count * 4);
  return { id: 'a', name: 'test', width, height: 1, repeat: -1, frames: [{ id: 'f', durationMs: 0, pixels }] };
}

describe('GIF format limits', () => {
  it.each([[256, false], [255, true]] as const)('retains %i supported colors without quantization (transparent=%s)', async (count, transparent) => {
    const source = assetWithColors(count, transparent), output = encodeGif(source);
    expect(output.quantized).toBe(false);
    const restored = decodeGif(await output.blob.arrayBuffer(), 'roundtrip');
    expect(restored.repeat).toBe(-1);
    expect(restored.frames[0].durationMs).toBe(0);
    expect(restored.frames[0].pixels.subarray(0, count * 4)).toEqual(source.frames[0].pixels.subarray(0, count * 4));
    if (transparent) expect(restored.frames[0].pixels[count * 4 + 3]).toBe(0);
  });
  it('only reduces the RGB palette when transparency leaves fewer than the required color slots', async () => {
    const output = encodeGif(assetWithColors(256, true));
    expect(output.quantized).toBe(true);
    const restored = decodeGif(await output.blob.arrayBuffer(), 'quantized');
    expect(restored.frames[0].pixels[256 * 4 + 3]).toBe(0);
    for (let x = 0; x < 256; x++) expect(restored.frames[0].pixels[x * 4 + 3]).toBe(255);
  });
  it('flags the unavoidable GIF partial-alpha conversion and keeps its transparent index separate', async () => {
    const source = assetWithColors(2, false);
    source.frames[0].pixels = Uint8ClampedArray.from([0, 0, 0, 127, 0, 0, 0, 128]);
    const encoded = encodeGif(source);
    expect(encoded.quantized).toBe(true);
    const restored = decodeGif(await encoded.blob.arrayBuffer(), 'alpha');
    expect([...restored.frames[0].pixels]).toEqual([0, 0, 0, 0, 0, 0, 0, 255]);
  });
  it('preserves finite repeat counts and refuses timing overflow instead of silently wrapping', async () => {
    const source = assetWithColors(1, false); source.repeat = 4; source.frames[0].durationMs = 90;
    const restored = decodeGif(await encodeGif(source).blob.arrayBuffer(), 'repeat');
    expect(restored.repeat).toBe(4); expect(restored.frames[0].durationMs).toBe(90);
    source.frames[0].durationMs = 655_360;
    expect(() => encodeGif(source)).toThrow(/655.35/);
  });
  it('reserves a transparent logical background from frame zero for mixed opaque/transparent animation', async () => {
    const source = assetWithColors(2, false);
    source.frames.push({ id: 'transparent-frame', durationMs: 200, pixels: Uint8ClampedArray.from([0, 0, 0, 0, 0, 255, 0, 255]) });
    const buffer = await encodeGif(source).blob.arrayBuffer();
    const raw = parseGIF(buffer);
    // A self-roundtrip alone can hide this bug: real decoders restore the first
    // logical background after disposal=2, so every GCE must identify slot zero.
    for (const frame of raw.frames) if ('image' in frame) {
      expect(frame.gce.extras.transparentColorGiven).toBe(true);
      expect(frame.gce.transparentColorIndex).toBe(0);
    }
    const restored = decodeGif(buffer, 'mixed');
    expect([...restored.frames[1].pixels]).toEqual([0, 0, 0, 0, 0, 255, 0, 255]);
  });
  it('reports reduced capacity honestly if a 256-color opaque frame precedes transparency', () => {
    const source = assetWithColors(256, false);
    source.frames.push({ id: 'empty', durationMs: 100, pixels: new Uint8ClampedArray(256 * 4) });
    expect(encodeGif(source).quantized).toBe(true);
  });
  it('imports a legacy opaque logical background according to its preceding GCE, matching native GIF decoders', () => {
    const encoder = GIFEncoder();
    encoder.writeFrame(new Uint8Array([0, 0, 0, 0]), 2, 2, { palette: [[255, 0, 0]], transparent: false, delay: 200, dispose: 2 });
    encoder.writeFrame(new Uint8Array([0, 0, 0, 1]), 2, 2, { palette: [[0, 0, 0], [0, 255, 0]], transparent: true, transparentIndex: 0, delay: 200, dispose: 2 });
    encoder.finish();
    const bytes = new Uint8Array(encoder.bytes());
    const restored = decodeGif(bytes.buffer, 'legacy');
    // Independently checked with Windows GDI+ and FFmpeg: disposal of the first
    // opaque frame restores its RED logical background, not transparent black.
    expect([...restored.frames[1].pixels]).toEqual([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255]);
  });
  it.each([[false, 0], [true, 0], [true, 2]] as const)('initializes a partial first image with transparency=%s and index=%i like native GIF decoders', (transparent, index) => {
    // Logical screen 2x2, red background index0, green index1, blue index2.
    // The first image is one green pixel at (1,1). LZW codes are clear,1,end.
    const bytes = Uint8Array.from([
      ...new TextEncoder().encode('GIF89a'), 2, 0, 2, 0, 0xf1, 0, 0,
      255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0,
      0x21, 0xf9, 4, 4 | (transparent ? 1 : 0), 10, 0, index, 0,
      0x2c, 1, 0, 1, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 1, 0, 0x3b,
    ]);
    const restored = decodeGif(bytes.buffer, 'partial-first');
    const background = transparent ? [0, 0, 0, 0] : [255, 0, 0, 255];
    expect([...restored.frames[0].pixels]).toEqual([...background, ...background, ...background, 0, 255, 0, 255]);
  });
});
