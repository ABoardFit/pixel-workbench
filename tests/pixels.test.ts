import { describe, expect, it } from 'vitest';
import { compositeFrame, flipPixelsHorizontal, floodFill, getBounds, paintStroke, samplePixel, snapLineEnd, snapRulerEnd, translatePixels } from '../src/lib/pixels';
import type { Silhouette } from '../src/types';

describe('native pixel editing', () => {
  it('mirrors asymmetric odd-width rows with exact RGBA and is a detached, reversible operation', () => {
    const original = Uint8ClampedArray.from([
      17, 99, 31, 0, 201, 19, 91, 128, 40, 50, 60, 255,
      70, 80, 90, 1, 100, 110, 120, 254, 130, 140, 150, 0,
    ]);
    const before = original.slice();
    const flipped = flipPixelsHorizontal(original, 3, 2);
    expect([...flipped]).toEqual([
      40, 50, 60, 255, 201, 19, 91, 128, 17, 99, 31, 0,
      130, 140, 150, 0, 100, 110, 120, 254, 70, 80, 90, 1,
    ]);
    expect(flipPixelsHorizontal(flipped, 3, 2)).toEqual(before);
    expect(original).toEqual(before);
    expect(flipped.buffer).not.toBe(original.buffer);
    flipped[0] = 222;
    expect(original).toEqual(before);
  });
  it('draws a continuous diagonal including both endpoints without changing neighbors', () => {
    const pixels = new Uint8ClampedArray(7 * 7 * 4);
    paintStroke(pixels, 7, 7, { x: 1, y: 1 }, { x: 5, y: 5 }, [200, 30, 80, 255], 1);
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      expect(samplePixel(pixels, 7, 7, x, y)).toEqual(x === y && x >= 1 && x <= 5 ? [200, 30, 80, 255] : [0, 0, 0, 0]);
    }
  });
  it('ignores an off-board stroke rather than smearing it along the edge', () => {
    const pixels = new Uint8ClampedArray(4 * 4 * 4);
    paintStroke(pixels, 4, 4, { x: -2, y: 0 }, { x: -2, y: 3 }, [255, 0, 0, 255], 1);
    expect(pixels.every((value) => value === 0)).toBe(true);
    paintStroke(pixels, 4, 4, { x: -2, y: 1 }, { x: 2, y: 1 }, [255, 0, 0, 255], 1);
    expect(getBounds(pixels, 4, 4)).toEqual({ x: 0, y: 1, width: 3, height: 1 });
    expect(samplePixel(pixels, 4, 4, 3, 1)).toEqual([0, 0, 0, 0]);
  });
  it('centers an even brush consistently and erases the exact covered square', () => {
    const pixels = new Uint8ClampedArray(5 * 5 * 4);
    paintStroke(pixels, 5, 5, { x: 2, y: 2 }, { x: 2, y: 2 }, [10, 20, 30, 255], 2);
    expect(getBounds(pixels, 5, 5)).toEqual({ x: 1, y: 1, width: 2, height: 2 });
    paintStroke(pixels, 5, 5, { x: 2, y: 2 }, { x: 2, y: 2 }, [0, 0, 0, 0], 2);
    expect(getBounds(pixels, 5, 5)).toBeNull();
  });
  it('fills by four-connectivity and all RGBA channels, including alpha', () => {
    const pixels = Uint8ClampedArray.from([
      20, 30, 40, 0, 20, 30, 40, 128, 20, 30, 40, 0,
      20, 30, 40, 0, 20, 30, 40, 128, 20, 30, 40, 0,
      20, 30, 40, 128, 20, 30, 40, 0, 20, 30, 40, 128,
    ]);
    expect(floodFill(pixels, 3, 3, 0, 0, [100, 110, 120, 255])).toBe(2);
    expect(samplePixel(pixels, 3, 3, 0, 1)).toEqual([100, 110, 120, 255]);
    expect(samplePixel(pixels, 3, 3, 1, 2)).toEqual([20, 30, 40, 0]);
    expect(samplePixel(pixels, 3, 3, 1, 0)).toEqual([20, 30, 40, 128]);
    expect(floodFill(pixels, 3, 3, 0, 0, [100, 110, 120, 255])).toBe(0);
    expect(floodFill(pixels, 3, 3, -1, 0, [0, 0, 0, 0])).toBe(0);
  });
  it('fills a large flat image without recursion or queue overflow', () => {
    const pixels = new Uint8ClampedArray(300 * 300 * 4);
    expect(floodFill(pixels, 300, 300, 299, 299, [1, 2, 3, 255])).toBe(90_000);
    expect(samplePixel(pixels, 300, 300, 0, 0)).toEqual([1, 2, 3, 255]);
  });
  it('uses pixel-center nearest sampling when a reference is scaled by a fractional factor', () => {
    const overlay: Silhouette = {
      id: 'o', name: 'o', width: 2, height: 1,
      pixels: Uint8ClampedArray.from([255, 0, 0, 255, 0, 0, 255, 255]),
      color: '#ff0000', opacity: 1, x: 0, y: 0, scale: 1.5, order: 'front', visible: true,
    };
    const result = compositeFrame(new Uint8ClampedArray(3 * 4), 3, 1, [overlay]);
    expect([...result]).toEqual([255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255]);
  });
  it('allows ruler endpoints on the outer grid boundary while paint stops at the last pixel', () => {
    expect(snapRulerEnd({ x: 0, y: 0 }, { x: 200, y: 200 }, 160, 160)).toEqual({ x: 160, y: 160 });
    expect(snapLineEnd({ x: 0, y: 0 }, { x: 200, y: 200 }, 160, 160)).toEqual({ x: 159, y: 159 });
    expect(snapRulerEnd({ x: 160, y: 80 }, { x: 0, y: 80 }, 160, 160)).toEqual({ x: 0, y: 80 });
  });
  it('keeps a ruler diagonal exact at unequal edges and spans joined-board seams in global coordinates', () => {
    expect(snapRulerEnd({ x: 0, y: 0 }, { x: 500, y: 500 }, 320, 160)).toEqual({ x: 160, y: 160 });
    expect(snapRulerEnd({ x: 120, y: 80 }, { x: 250, y: 81 }, 320, 160)).toEqual({ x: 250, y: 80 });
    expect(snapRulerEnd({ x: 320, y: 160 }, { x: 0, y: -160 }, 320, 160)).toEqual({ x: 160, y: 0 });
  });
});

describe('whole-pixel translation', () => {
  const a = [11, 22, 33, 0], b = [201, 19, 91, 128], c = [40, 50, 60, 255];
  const d = [70, 80, 90, 254], e = [100, 110, 120, 1], f = [130, 140, 150, 0];
  const g = [21, 31, 41, 255], h = [51, 61, 71, 63], i = [81, 91, 101, 192];
  const empty = [0, 0, 0, 0];
  const image = () => Uint8ClampedArray.from([a, b, c, d, e, f, g, h, i].flat());

  it('moves right and down with exact hidden RGB and partial alpha, leaving transparent exposed edges', () => {
    const source = image(), before = source.slice();
    const translated = translatePixels(source, 3, 3, 1, 1);
    expect([...translated]).toEqual([
      empty, empty, empty,
      empty, a, b,
      empty, d, e,
    ].flat());
    expect(source).toEqual(before);
    expect(translated.buffer).not.toBe(source.buffer);
  });
  it('moves left and up and clips the correct opposite edges without changing channels', () => {
    const source = image(), before = source.slice();
    expect([...translatePixels(source, 3, 3, -1, -1)]).toEqual([
      e, f, empty,
      h, i, empty,
      empty, empty, empty,
    ].flat());
    expect(source).toEqual(before);
  });
  it('never wraps a clipped row into the next row when moving horizontally', () => {
    expect([...translatePixels(image(), 3, 3, 1, 0)]).toEqual([
      empty, a, b,
      empty, d, e,
      empty, g, h,
    ].flat());
    expect([...translatePixels(image(), 3, 3, -1, 0)]).toEqual([
      b, c, empty,
      e, f, empty,
      h, i, empty,
    ].flat());
  });
  it('returns a detached exact copy for a zero delta', () => {
    const source = image(), translated = translatePixels(source, 3, 3, 0, 0);
    expect(translated).toEqual(source);
    expect(translated.buffer).not.toBe(source.buffer);
    translated[0] = 222;
    expect(source[0]).toBe(11);
  });
  it.each([[3, 0], [-3, 0], [0, 3], [0, -3], [9, -20]])('returns a transparent canvas when the image is moved entirely outside (%i,%i)', (dx, dy) => {
    const source = image(), before = source.slice();
    expect(translatePixels(source, 3, 3, dx, dy)).toEqual(new Uint8ClampedArray(3 * 3 * 4));
    expect(source).toEqual(before);
  });
  it.each([[0.5, 0], [0, -0.5], [Number.NaN, 0], [0, Number.POSITIVE_INFINITY]])('rejects a noninteger delta instead of resampling artwork (%s,%s)', (dx, dy) => {
    expect(() => translatePixels(image(), 3, 3, dx, dy)).toThrow(/정수 픽셀/);
  });
  it('rejects dimensions that do not match the RGBA buffer', () => {
    expect(() => translatePixels(image(), 4, 3, 0, 0)).toThrow(/크기와 픽셀 수/);
  });
});
