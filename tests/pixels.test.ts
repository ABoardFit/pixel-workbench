import { describe, expect, it } from 'vitest';
import { compositeFrame, floodFill, getBounds, paintStroke, samplePixel } from '../src/lib/pixels';
import type { Silhouette } from '../src/types';

describe('native pixel editing', () => {
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
});
