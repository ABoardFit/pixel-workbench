// gifenc 1.0.3 does not ship declarations. These describe the public upstream API used here.
declare module 'gifenc' {
  export function quantize(pixels: Uint8Array | Uint8ClampedArray, maxColors: number, options?: { format?: 'rgb565' | 'rgb444' | 'rgba4444' }): number[][];
  export function applyPalette(pixels: Uint8Array | Uint8ClampedArray, palette: number[][], format?: 'rgb565' | 'rgb444' | 'rgba4444'): Uint8Array;
  export function GIFEncoder(): {
    writeFrame(indices: Uint8Array, width: number, height: number, options: {
      palette: number[][]; transparent?: boolean; transparentIndex?: number;
      delay?: number; repeat?: number; dispose?: number;
    }): void;
    finish(): void;
    bytes(): Uint8Array;
  };
}
