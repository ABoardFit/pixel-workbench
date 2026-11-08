import { decode as readPng, encode as writePng } from 'fast-png';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { parseGIF, decompressFrames } from 'gifuct-js';
import type { ParsedFrame } from 'gifuct-js';
import type { PixelFrame, SpriteAsset } from '../types';

const MAX_PIXELS = 16_777_216;
const MAX_TOTAL_PIXELS = 67_108_864;
const MAX_FRAMES = 2048;
const id = () => crypto.randomUUID();

function dimensions(width: number, height: number, frameCount = 1): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > MAX_PIXELS) {
    throw new Error('이미지 크기는 가로·세로 1~8192픽셀, 총 1,677만 픽셀 이내여야 합니다.');
  }
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > MAX_FRAMES || width * height * frameCount > MAX_TOTAL_PIXELS) {
    throw new Error('프레임이 너무 많거나 이미지 전체가 너무 큽니다. 프레임 수나 크기를 줄여 주세요.');
  }
}

function validateAsset(asset: SpriteAsset): void {
  dimensions(asset.width, asset.height, asset.frames.length);
  if (!Number.isInteger(asset.repeat) || asset.repeat < -1 || asset.repeat > 65535) throw new Error('GIF 반복 횟수는 -1~65535 범위의 정수여야 합니다.');
  for (const frame of asset.frames) {
    if (frame.pixels.length !== asset.width * asset.height * 4) throw new Error('프레임의 픽셀 수와 이미지 크기가 맞지 않습니다.');
    if (!Number.isFinite(frame.durationMs) || frame.durationMs < 0) throw new Error('프레임 재생 시간이 올바르지 않습니다.');
  }
}

function pngDecoderInput(buffer: ArrayBuffer): { bytes: Uint8Array; transparency?: Uint16Array } {
  const view = new DataView(buffer), bytes = new Uint8Array(buffer);
  // fast-png 6.x incorrectly treats RGB tRNS's three color samples as three
  // pixel-alpha values. Only 1- and 2-pixel RGB files trigger that upstream bug.
  if (view.getUint8(25) !== 2 || view.getUint32(16) * view.getUint32(20) >= 3) return { bytes };
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset), end = offset + length + 12;
    if (end > bytes.length) throw new Error('PNG 청크의 길이가 올바르지 않습니다.');
    if (view.getUint32(offset + 4) === 0x74524e53) {
      if (length !== 6) throw new Error('RGB PNG의 투명 색상 키가 올바르지 않습니다.');
      let crc = 0xffffffff;
      for (let i = offset + 4; i < offset + length + 8; i++) {
        crc ^= bytes[i];
        for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
      }
      if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(offset + length + 8)) throw new Error('PNG 투명 색상 키의 CRC가 올바르지 않습니다.');
      const result = new Uint8Array(bytes.length - length - 12);
      result.set(bytes.subarray(0, offset)); result.set(bytes.subarray(end), offset);
      return { bytes: result, transparency: Uint16Array.from([view.getUint16(offset + 8), view.getUint16(offset + 10), view.getUint16(offset + 12)]) };
    }
    offset = end;
  }
  return { bytes };
}

/** Decode GIF patches into independent full-canvas RGBA frames, applying the preceding disposal first. */
export function decodeGif(buffer: ArrayBuffer, name: string): SpriteAsset {
  try {
    if (buffer.byteLength > 100 * 1024 * 1024) throw new Error('100MB 이하의 GIF를 선택해 주세요.');
    const gif = parseGIF(buffer);
    if (gif.header.signature !== 'GIF') throw new Error('GIF 파일 형식이 아닙니다.');
    const rawFrames = gif.frames.filter((frame) => 'image' in frame);
    const { width, height } = gif.lsd;
    dimensions(width, height, rawFrames.length);
    for (const raw of rawFrames) {
      if (!('image' in raw)) continue;
      const rect = raw.image.descriptor;
      if (rect.width < 1 || rect.height < 1 || rect.left + rect.width > width || rect.top + rect.height > height) {
        throw new Error('GIF 프레임의 영역이 전체 이미지 크기를 벗어납니다.');
      }
    }
    const patches = decompressFrames(gif, true);
    const logicalColor = gif.gct?.[gif.lsd.backgroundColorIndex];
    const logicalBackground = logicalColor ? [...logicalColor, 255] : [0, 0, 0, 0];
    const transparentBackground = [0, 0, 0, 0];
    const canvas = new Uint8ClampedArray(width * height * 4);
    const clearRect = (rect: ParsedFrame['dims'], color: number[]) => {
      for (let y = rect.top; y < rect.top + rect.height; y++) {
        for (let x = rect.left; x < rect.left + rect.width; x++) canvas.set(color, (y * width + x) * 4);
      }
    };
    clearRect({ top: 0, left: 0, width, height }, patches[0].transparentIndex !== undefined ? transparentBackground : logicalBackground);
    const frames: PixelFrame[] = [];
    let previous: ParsedFrame | undefined, restore: Uint8ClampedArray | undefined;
    for (let index = 0; index < patches.length; index++) {
      const patch = patches[index];
      if (previous?.disposalType === 2) clearRect(previous.dims, previous.transparentIndex !== undefined ? transparentBackground : logicalBackground);
      if (previous?.disposalType === 3 && restore) canvas.set(restore);
      restore = patch.disposalType === 3 ? canvas.slice() : undefined;
      for (let y = 0; y < patch.dims.height; y++) for (let x = 0; x < patch.dims.width; x++) {
        const pi = (y * patch.dims.width + x) * 4;
        if (patch.patch[pi + 3] === 0) continue;
        const ci = ((y + patch.dims.top) * width + x + patch.dims.left) * 4;
        canvas.set(patch.patch.subarray(pi, pi + 4), ci);
      }
      const raw = rawFrames[index];
      // gifuct replaces an explicitly zero GCE delay with 100ms; retain the actual stored value.
      const durationMs = raw && 'gce' in raw && raw.gce ? raw.gce.delay * 10 : 100;
      frames.push({ id: id(), pixels: canvas.slice(), durationMs });
      previous = patch;
    }
    let repeat = -1;
    for (const frame of gif.frames) {
      if (!('application' in frame)) continue;
      const app = frame.application;
      if (/^(NETSCAPE2\.0|ANIMEXTS1\.0)$/.test(app.id) && app.blocks.length >= 3 && app.blocks[0] === 1) {
        repeat = app.blocks[1] | app.blocks[2] << 8;
      }
    }
    return { id: id(), name, width, height, frames, repeat };
  } catch (error) {
    throw new Error(`GIF를 읽지 못했습니다. ${error instanceof Error ? error.message : '파일을 확인해 주세요.'}`);
  }
}

/** Read RGB and alpha bytes directly. No Canvas conversion or premultiplication is involved. */
export function decodePng(buffer: ArrayBuffer, name: string): SpriteAsset {
  try {
    if (buffer.byteLength < 33 || buffer.byteLength > 100 * 1024 * 1024) throw new Error('올바른 100MB 이하 PNG를 선택해 주세요.');
    const view = new DataView(buffer);
    if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) throw new Error('PNG 파일 형식이 아닙니다.');
    // Check the IHDR before the decoder allocates its decompressed image.
    dimensions(view.getUint32(16), view.getUint32(20));
    const input = pngDecoderInput(buffer);
    const image = readPng(input.bytes, { checkCrc: true });
    const { width, height, channels, depth, data, palette } = image;
    const transparency = input.transparency ?? image.transparency;
    if (depth === 16) throw new Error('16비트 PNG는 지원하지 않습니다. 원본을 8비트 PNG로 저장해 주세요.');
    if (channels < 1 || channels > 4) throw new Error('지원하지 않는 PNG 색상 형식입니다.');
    const pixels = new Uint8ClampedArray(width * height * 4);
    const rowBytes = Math.ceil(width * channels * depth / 8);
    const readSample = (x: number, y: number, channel = 0) => {
      if (depth === 8) return data[(y * width + x) * channels + channel];
      const bit = x * channels * depth + channel * depth;
      return (data[y * rowBytes + (bit >> 3)] >> (8 - depth - (bit % 8))) & ((1 << depth) - 1);
    };
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (palette) {
        const entry = palette[readSample(x, y)];
        if (!entry) throw new Error('PNG 색상표의 인덱스가 올바르지 않습니다.');
        pixels.set([entry[0], entry[1], entry[2], entry[3] ?? 255], i);
      } else if (channels === 1 || channels === 2) {
        const raw = readSample(x, y), gray = Math.round(raw * 255 / ((1 << depth) - 1));
        const alpha = channels === 2 ? readSample(x, y, 1) : transparency?.[0] === raw ? 0 : 255;
        pixels.set([gray, gray, gray, alpha], i);
      } else {
        const r = readSample(x, y, 0), g = readSample(x, y, 1), b = readSample(x, y, 2);
        const alpha = channels === 4 ? readSample(x, y, 3) : transparency && transparency[0] === r && transparency[1] === g && transparency[2] === b ? 0 : 255;
        pixels.set([r, g, b, alpha], i);
      }
    }
    return { id: id(), name, width, height, repeat: 0, frames: [{ id: id(), pixels, durationMs: 200 }] };
  } catch (error) {
    throw new Error(`PNG를 읽지 못했습니다. ${error instanceof Error ? error.message : '파일을 확인해 주세요.'}`);
  }
}

export interface SheetOptions {
  frameWidth: number; frameHeight: number; offsetX?: number; offsetY?: number;
  gapX?: number; gapY?: number; durationMs?: number;
}

/** Crop whole cells in row order from the first image frame; offsets and gaps are native pixels. */
export function splitSpriteSheet(asset: SpriteAsset, options: SheetOptions): SpriteAsset {
  validateAsset(asset);
  const { frameWidth, frameHeight, offsetX = 0, offsetY = 0, gapX = 0, gapY = 0, durationMs = 200 } = options;
  dimensions(frameWidth, frameHeight);
  if (![offsetX, offsetY, gapX, gapY].every((value) => Number.isInteger(value) && value >= 0) || !Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error('여백과 간격은 0 이상의 정수, 재생 시간은 0 이상의 숫자로 입력해 주세요.');
  }
  if (offsetX + frameWidth > asset.width || offsetY + frameHeight > asset.height) throw new Error('첫 프레임이 이미지 범위를 벗어납니다.');
  const columns = Math.floor((asset.width - offsetX + gapX) / (frameWidth + gapX));
  const rows = Math.floor((asset.height - offsetY + gapY) / (frameHeight + gapY));
  dimensions(frameWidth, frameHeight, columns * rows);
  const frames: PixelFrame[] = [];
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const pixels = new Uint8ClampedArray(frameWidth * frameHeight * 4);
    const left = offsetX + column * (frameWidth + gapX), top = offsetY + row * (frameHeight + gapY);
    for (let y = 0; y < frameHeight; y++) {
      const si = ((top + y) * asset.width + left) * 4;
      pixels.set(asset.frames[0].pixels.subarray(si, si + frameWidth * 4), y * frameWidth * 4);
    }
    frames.push({ id: id(), pixels, durationMs });
  }
  return { ...asset, id: id(), name: `${asset.name.replace(/\.[^.]+$/, '')} · ${frames.length}프레임`, width: frameWidth, height: frameHeight, frames };
}

/** Lossless 8-bit RGBA PNG, including the RGB channels of transparent pixels. */
export function encodePng(pixels: Uint8ClampedArray, width: number, height: number): Blob {
  dimensions(width, height);
  if (pixels.length !== width * height * 4) throw new Error('PNG 크기와 픽셀 수가 맞지 않습니다.');
  const encoded = writePng({ width, height, data: pixels, depth: 8, channels: 4 });
  return new Blob([new Uint8Array(encoded)], { type: 'image/png' });
}

/** Export a lossless row-major sheet; unused trailing cells are transparent. */
export function encodeSpriteSheet(asset: SpriteAsset, columns: number): Blob {
  validateAsset(asset);
  if (!Number.isInteger(columns) || columns < 1 || columns > asset.frames.length) throw new Error('열 수는 1 이상 프레임 수 이하의 정수여야 합니다.');
  const rows = Math.ceil(asset.frames.length / columns), width = asset.width * columns, height = asset.height * rows;
  dimensions(width, height);
  const pixels = new Uint8ClampedArray(width * height * 4);
  asset.frames.forEach((frame, index) => {
    const x = index % columns * asset.width, y = Math.floor(index / columns) * asset.height;
    for (let row = 0; row < asset.height; row++) pixels.set(frame.pixels.subarray(row * asset.width * 4, (row + 1) * asset.width * 4), ((y + row) * width + x) * 4);
  });
  return encodePng(pixels, width, height);
}

/** Encode full frames with per-frame palettes. Quantization is skipped whenever the GIF capacity suffices. */
export function encodeGif(asset: SpriteAsset): { blob: Blob; quantized: boolean } {
  validateAsset(asset);
  const encoder = GIFEncoder();
  let quantized = false;
  // The logical background must be transparent from the first frame, even when
  // that particular frame is fully opaque. Otherwise disposal=2 leaves its RGB
  // background behind subsequent transparent frames in browsers/native decoders.
  const needsTransparentSlot = asset.frames.some((frame) => {
    for (let i = 3; i < frame.pixels.length; i += 4) if (frame.pixels[i] < 128) return true;
    return false;
  });
  for (const frame of asset.frames) {
    const { pixels } = frame;
    if (frame.durationMs > 655_350) throw new Error('GIF의 프레임당 최대 재생 시간은 655.35초입니다. 시간을 줄여 주세요.');
    const transparent = needsTransparentSlot;
    let opaqueCount = 0;
    const colors = new Map<number, number>();
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] !== 0 && pixels[i + 3] !== 255) quantized = true;
      if (pixels[i + 3] < 128) continue;
      opaqueCount++;
      const rgb = pixels[i] << 16 | pixels[i + 1] << 8 | pixels[i + 2];
      if (!colors.has(rgb) && colors.size < 257) colors.set(rgb, colors.size);
    }
    const capacity = transparent ? 255 : 256;
    const palette: number[][] = transparent ? [[0, 0, 0]] : [];
    const indices = new Uint8Array(asset.width * asset.height);
    if (colors.size <= capacity) {
      for (const rgb of colors.keys()) palette.push([rgb >> 16, rgb >> 8 & 255, rgb & 255]);
      for (let p = 0; p < indices.length; p++) {
        const i = p * 4;
        indices[p] = pixels[i + 3] < 128 ? 0 : colors.get(pixels[i] << 16 | pixels[i + 1] << 8 | pixels[i + 2])! + (transparent ? 1 : 0);
      }
    } else {
      quantized = true;
      // Exclude transparent RGB from the color estimator; it must not consume an opaque palette slot.
      const opaque = new Uint8Array(opaqueCount * 4);
      let oi = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] >= 128) {
        opaque.set([pixels[i], pixels[i + 1], pixels[i + 2], 255], oi); oi += 4;
      }
      const reduced = quantize(opaque, capacity, { format: 'rgb565' });
      palette.push(...reduced);
      const mapped = applyPalette(pixels, reduced, 'rgb565');
      for (let p = 0; p < indices.length; p++) indices[p] = pixels[p * 4 + 3] < 128 ? 0 : mapped[p] + (transparent ? 1 : 0);
    }
    if (palette.length === 0) palette.push([0, 0, 0]);
    encoder.writeFrame(indices, asset.width, asset.height, {
      palette, transparent, transparentIndex: 0, delay: frame.durationMs,
      repeat: asset.repeat, dispose: 2,
    });
  }
  encoder.finish();
  return { blob: new Blob([new Uint8Array(encoder.bytes())], { type: 'image/gif' }), quantized };
}
