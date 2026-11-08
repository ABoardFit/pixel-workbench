import type { Point, RGBA, Silhouette } from '../types';

const inBounds = (x: number, y: number, width: number, height: number) =>
  x >= 0 && y >= 0 && x < width && y < height;

/** Return transparent black outside the image; coordinates refer to native pixels. */
export function samplePixel(pixels: Uint8ClampedArray, width: number, height: number, x: number, y: number): RGBA {
  x = Math.floor(x); y = Math.floor(y);
  if (!inBounds(x, y, width, height)) return [0, 0, 0, 0];
  const i = (y * width + x) * 4;
  return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
}

/** Paint a continuous Bresenham segment in place, clipping brush pixels rather than clamping its center. */
export function paintStroke(pixels: Uint8ClampedArray, width: number, height: number, from: Point, to: Point, rgba: RGBA, size = 1): void {
  if (![from.x, from.y, to.x, to.y, size].every(Number.isFinite)) return;
  size = Math.max(1, Math.min(256, Math.round(size)));
  let x = Math.round(from.x), y = Math.round(from.y);
  const endX = Math.round(to.x), endY = Math.round(to.y);
  const dx = Math.abs(endX - x), dy = -Math.abs(endY - y);
  const sx = x < endX ? 1 : -1, sy = y < endY ? 1 : -1;
  let error = dx + dy;
  const offset = Math.floor(size / 2);
  // Pointer drags can leave the board. Only pixels actually crossed by the brush are written.
  for (;;) {
    for (let by = y - offset; by < y - offset + size; by++) {
      if (by < 0 || by >= height) continue;
      for (let bx = x - offset; bx < x - offset + size; bx++) {
        if (!inBounds(bx, by, width, height)) continue;
        pixels.set(rgba, (by * width + bx) * 4);
      }
    }
    if (x === endX && y === endY) break;
    const twice = error * 2;
    if (twice >= dy) { error += dy; x += sx; }
    if (twice <= dx) { error += dx; y += sy; }
  }
}

/** Snap to the nearest 45-degree ray; shorten its integer step count at the board edge. */
export function snapLineEnd(start: Point, end: Point, width: number, height: number): Point {
  const origin = { x: Math.round(start.x), y: Math.round(start.y) };
  const dx = end.x - origin.x, dy = end.y - origin.y;
  if (!Number.isFinite(dx + dy) || !inBounds(origin.x, origin.y, width, height)) return origin;
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  const ux = Math.round(Math.cos(angle * Math.PI / 4));
  const uy = Math.round(Math.sin(angle * Math.PI / 4));
  let steps = Math.max(0, Math.round((dx * ux + dy * uy) / (ux * ux + uy * uy)));
  if (ux > 0) steps = Math.min(steps, width - 1 - origin.x);
  if (ux < 0) steps = Math.min(steps, origin.x);
  if (uy > 0) steps = Math.min(steps, height - 1 - origin.y);
  if (uy < 0) steps = Math.min(steps, origin.y);
  return { x: origin.x + ux * steps, y: origin.y + uy * steps };
}

/** Snap a ruler on grid boundaries (0..width and 0..height inclusive), without touching artwork. */
export function snapRulerEnd(start: Point, end: Point, width: number, height: number): Point {
  return snapLineEnd(start, end, width + 1, height + 1);
}

/** Iterative four-connected exact RGBA fill. Returns the number of changed pixels. */
export function floodFill(pixels: Uint8ClampedArray, width: number, height: number, x: number, y: number, rgba: RGBA): number {
  x = Math.floor(x); y = Math.floor(y);
  if (!inBounds(x, y, width, height)) return 0;
  const target = samplePixel(pixels, width, height, x, y);
  const color = Uint8ClampedArray.from(rgba);
  if (target.every((v, i) => v === color[i])) return 0;
  const matches = (p: number) => target.every((v, channel) => pixels[p * 4 + channel] === v);
  // Color a cell when queued so it can never be queued twice, including enormous flat regions.
  const queue = new Int32Array(width * height);
  let read = 0, write = 0;
  const visit = (p: number) => { if (matches(p)) { pixels.set(color, p * 4); queue[write++] = p; } };
  visit(y * width + x);
  while (read < write) {
    const p = queue[read++], px = p % width;
    if (px > 0) visit(p - 1);
    if (px + 1 < width) visit(p + 1);
    if (p >= width) visit(p - width);
    if (p + width < width * height) visit(p + width);
  }
  return write;
}

/** Uniform silhouette RGB; retain source coverage multiplied by the requested color alpha. */
export function makeSilhouette(pixels: Uint8ClampedArray, rgba: RGBA): Uint8ClampedArray {
  const result = new Uint8ClampedArray(pixels.length);
  for (let i = 0; i < result.length; i += 4) {
    result[i] = rgba[0]; result[i + 1] = rgba[1]; result[i + 2] = rgba[2];
    result[i + 3] = Math.round(pixels[i + 3] * rgba[3] / 255);
  }
  return result;
}

/** Smallest nonzero-alpha rectangle, or null for an empty frame. */
export function getBounds(pixels: Uint8ClampedArray, width: number, height: number): { x: number; y: number; width: number; height: number } | null {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!pixels[(y * width + x) * 4 + 3]) continue;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

function overlayPixel(overlay: Silhouette, x: number, y: number): number {
  if (!overlay.visible || overlay.opacity <= 0 || !Number.isFinite(overlay.scale) || overlay.scale <= 0) return -1;
  const sx = Math.floor((x + 0.5 - overlay.x) / overlay.scale);
  const sy = Math.floor((y + 0.5 - overlay.y) / overlay.scale);
  return inBounds(sx, sy, overlay.width, overlay.height) ? (sy * overlay.width + sx) * 4 : -1;
}

/** Pixel-mask intersection over union within the board. Percent is in the range 0..100. */
export function measureOverlap(pixels: Uint8ClampedArray, width: number, height: number, overlay: Silhouette): { intersection: number; union: number; percent: number } {
  let intersection = 0, union = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const a = pixels[(y * width + x) * 4 + 3] > 0;
    const oi = overlayPixel(overlay, x, y);
    const b = oi >= 0 && overlay.pixels[oi + 3] > 0;
    if (a && b) intersection++;
    if (a || b) union++;
  }
  return { intersection, union, percent: union ? intersection / union * 100 : 0 };
}

/** Straight-alpha source-over; round only the resulting stored channels. */
function sourceOver(target: Uint8ClampedArray, ti: number, source: Uint8ClampedArray, si: number, opacity = 1): void {
  const sa = source[si + 3] / 255 * opacity;
  if (sa <= 0) return;
  const da = target[ti + 3] / 255, alpha = sa + da * (1 - sa);
  for (let c = 0; c < 3; c++) target[ti + c] = Math.round((source[si + c] * sa + target[ti + c] * da * (1 - sa)) / alpha);
  target[ti + 3] = Math.round(alpha * 255);
}

/** Composite back overlays, native frame, then front overlays without changing any input. */
export function compositeFrame(pixels: Uint8ClampedArray, width: number, height: number, overlays: Silhouette[]): Uint8ClampedArray {
  if (!overlays.some((overlay) => overlay.visible && overlay.opacity > 0)) return new Uint8ClampedArray(pixels);
  const result = new Uint8ClampedArray(width * height * 4);
  const drawOverlay = (overlay: Silhouette) => {
    const opacity = Math.max(0, Math.min(1, overlay.opacity));
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const oi = overlayPixel(overlay, x, y);
      if (oi >= 0) sourceOver(result, (y * width + x) * 4, overlay.pixels, oi, opacity);
    }
  };
  overlays.filter((overlay) => overlay.order === 'back').forEach(drawOverlay);
  for (let i = 0; i < result.length; i += 4) sourceOver(result, i, pixels, i);
  overlays.filter((overlay) => overlay.order === 'front').forEach(drawOverlay);
  return result;
}
