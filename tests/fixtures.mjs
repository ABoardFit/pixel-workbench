// Tiny, synthetic fixtures with independently specified pixels; no character art.
export const rgbaFixture = {
  width: 4,
  height: 4,
  data: new Uint8Array([
    17, 33, 65, 255, 201, 19, 91, 128, 7, 99, 13, 0, 0, 255, 0, 255,
    0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0,
  ]),
};

// GIF89a with partial rectangles and disposal=3 followed by disposal=2.
// The tiny encoder clears before every pixel, keeping LZW codes at 3 bits.
// Palette indexes: transparent=0, red=1, green=2, blue=3.
export function disposalGifFixture() {
  const bytes = [...new TextEncoder().encode('GIF89a'), 2, 0, 2, 0, 0xf1, 0, 0,
    0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255];
  function frame({ left = 0, top = 0, width = 2, height = 2, pixels, disposal, delay }) {
    bytes.push(0x21, 0xf9, 4, (disposal << 2) | 1, delay, 0, 0, 0,
      0x2c, left, 0, top, 0, width, 0, height, 0, 0, 2);
    const codes = pixels.flatMap((pixel) => [4, pixel]).concat(5);
    const packed = [];
    let bits = 0, available = 0;
    for (const code of codes) {
      bits |= code << available;
      available += 3;
      while (available >= 8) { packed.push(bits & 255); bits >>>= 8; available -= 8; }
    }
    if (available) packed.push(bits & 255);
    bytes.push(packed.length, ...packed, 0);
  }
  frame({ pixels: [1, 1, 1, 1], disposal: 1, delay: 7 });
  frame({ width: 1, height: 1, pixels: [3], disposal: 3, delay: 13 });
  frame({ left: 1, top: 1, width: 1, height: 1, pixels: [2], disposal: 2, delay: 19 });
  frame({ width: 1, height: 1, pixels: [0], disposal: 1, delay: 23 });
  bytes.push(0x3b);
  return new Uint8Array(bytes);
}

export const expectedDisposalPixels = [
  [255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255],
  [0, 0, 255, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255],
  [255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255],
  [255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0],
];
