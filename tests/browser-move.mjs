import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { decode } from 'fast-png';

const root = path.resolve(import.meta.dirname, '..'), artifacts = path.join(root, '.test-results');
const baseURL = process.env.TEST_URL || 'http://127.0.0.1:5174/pixel-workbench/';
await fs.mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
const page = await context.newPage(), errors = [];
page.on('pageerror', (error) => errors.push(error.message));
if (process.env.TEST_DIST === '1') {
  const prefix = new URL(baseURL).pathname.replace(/\/$/, '');
  await page.route(`${new URL(baseURL).origin}/**`, async (route) => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname).slice(prefix.length).replace(/^\/+/, '') || 'index.html';
    const filename = path.resolve(root, 'dist', relative); assert.ok(filename.startsWith(path.join(root, 'dist') + path.sep));
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    try { await route.fulfill({ contentType: mime[path.extname(filename)] || 'application/octet-stream', body: await fs.readFile(filename) }); }
    catch { await route.fulfill({ status: 404, body: 'Not found' }); }
  });
}
const canvas = (number = 1) => page.locator('canvas[data-testid^="board-canvas-"]').nth(number - 1);
const board = (number = 1) => page.getByRole('article', { name: `${number}번 비교 칸`, exact: true });
const nativePixels = (project) => project.assets.map((asset) => asset.frames.map((frame) => frame.pixels));
const aids = (project) => ({ guides: project.guides, overlays: project.boards.map((board) => board.overlays) });
const data = Buffer.alloc(160 * 160 * 4);
for (let y = 50; y < 90; y++) for (let x = 40; x < 80; x++) data.set([17, 51, 85, 255], (y * 160 + x) * 4);
data.set([201, 19, 91, 128], (45 * 160 + 35) * 4);
data.set([220, 99, 11, 255], (95 * 160 + 82) * 4);
data.set([7, 99, 13, 0], (20 * 160 + 20) * 4);
const other = Buffer.from(data); other.set([33, 222, 77, 255], (55 * 160 + 45) * 4);
const fixture = { version: 1, assets: [{ id: 'qa-asset', name: 'qa-asymmetric-motion.png', width: 160, height: 160, repeat: 0,
  frames: [{ id: 'qa-frame-0', durationMs: 100, pixels: data.toString('base64') }, { id: 'qa-frame-1', durationMs: 130, pixels: other.toString('base64') }] }],
  boards: [0, 1].map((index) => ({ id: `qa-board-${index}`, assetId: 'qa-asset', frameIndex: 0, playing: false, speed: 1, zoom: 2, panX: 0, panY: 0, overlays: [], selectedOverlayId: null })),
  activeBoardId: 'qa-board-0', guides: [], joinedView: { zoom: 2, panX: 0, panY: 0 } };
let serial = 0;
async function download(click, extension) { const pending = page.waitForEvent('download'); await click(); const result = await pending, filename = path.join(artifacts, `move-${++serial}.${extension}`); await result.saveAs(filename); return fs.readFile(filename); }
async function save() { return JSON.parse((await download(() => page.getByRole('button', { name: '편집 상태 저장', exact: true }).click(), 'json')).toString()); }
async function load(project) {
  await page.getByLabel('작업 파일 선택').setInputFiles({ name: 'qa-move.pixel.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)) });
  await canvas(2).waitFor();
  await page.waitForFunction((zoom) => Math.abs(document.querySelector('canvas[data-testid^="board-canvas-"]').getBoundingClientRect().width - 160 * zoom) < 0.01, project.joinedView.zoom);
}
async function point(x, y) { const rect = await canvas().boundingBox(); return { x: rect.x + x * rect.width / 160, y: rect.y + y * rect.height / 160 }; }
async function gesture(from, moves, cancel = false) {
  const start = await point(...from); await page.mouse.move(start.x, start.y); await page.mouse.down();
  for (const move of moves) { const p = await point(...move); await page.mouse.move(p.x, p.y, { steps: 10 }); }
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
}
async function shiftGesture(delta, preview, shiftOnMove, shiftOnDrop) {
  const start = await point(60, 60);
  const end = await point(60 + delta[0], 60 + delta[1]);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  if (shiftOnMove) await page.keyboard.down('Shift');
  await page.mouse.move(end.x, end.y, { steps: 10 });
  // The orange pixel is outside both masks, so its preview location is observable.
  await page.waitForFunction(([x, y]) => {
    const node = document.querySelector('canvas[data-testid^="board-canvas-"]');
    const pixel = node.getContext('2d').getImageData(x, y, 1, 1).data;
    return pixel[0] === 220 && pixel[1] === 99 && pixel[2] === 11 && pixel[3] === 255;
  }, [92 + preview[0], 90 + preview[1]], { timeout: 3000 });
  if (shiftOnMove && !shiftOnDrop) await page.keyboard.up('Shift');
  if (!shiftOnMove && shiftOnDrop) await page.keyboard.down('Shift');
  await page.mouse.up();
  if (shiftOnDrop) await page.keyboard.up('Shift');
}
async function tool(name) { await page.getByRole('button', { name, exact: true }).click(); }
async function shortcut(keys) { await page.getByRole('heading', { name: '도트 작업실', exact: true }).click(); await page.keyboard.press(keys); }
function translated(base64, dx, dy) {
  const source = Buffer.from(base64, 'base64'), destination = Buffer.alloc(source.length);
  for (let y = 0; y < 160; y++) for (let x = 0; x < 160; x++) {
    const sx = x - dx, sy = y - dy;
    if (sx >= 0 && sx < 160 && sy >= 0 && sy < 160) source.copy(destination, (y * 160 + x) * 4, (sy * 160 + sx) * 4, (sy * 160 + sx + 1) * 4);
  }
  return destination.toString('base64');
}
function bounds(base64) {
  const rgba = Buffer.from(base64, 'base64'), occupied = [];
  for (let pixel = 0; pixel < 160 * 160; pixel++) if (rgba[pixel * 4 + 3]) occupied.push(pixel);
  return { left: Math.min(...occupied.map((pixel) => pixel % 160)), top: Math.min(...occupied.map((pixel) => Math.floor(pixel / 160))), right: Math.max(...occupied.map((pixel) => pixel % 160)), bottom: Math.max(...occupied.map((pixel) => Math.floor(pixel / 160))), count: occupied.length };
}
function assertMove(project, expected, baseline, label) {
  assert.equal(project.assets[0].frames[0].pixels, expected, label);
  assert.equal(project.assets[0].frames[1].pixels, baseline.assets[0].frames[1].pixels, 'another frame of the shared asset stays untouched');
  assert.deepEqual([project.assets[0].width, project.assets[0].height], [160, 160]);
  assert.deepEqual(aids(project), aids(baseline), 'moving artwork leaves every silhouette and ruler stationary');
  assert.deepEqual(project.joinedView, baseline.joinedView, 'moving artwork leaves the shared viewport stationary');
}

try {
  await page.goto(baseURL); await page.getByRole('heading', { name: '도트 작업실', exact: true }).waitFor(); await load(fixture);
  await page.getByLabel('색상 HEX').fill('#e53986'); await tool('룰러(자) (R)'); await gesture([150, 25], [[170, 40]]);
  await page.getByRole('button', { name: '현재 프레임 잡기', exact: true }).click();
  await page.getByRole('button', { name: '이 칸에 실루엣 추가', exact: true }).click();
  await page.getByLabel('실루엣 X', { exact: true }).fill('3'); await page.getByLabel('실루엣 Y', { exact: true }).fill('4');
  await page.getByRole('button', { name: '이 칸에 실루엣 추가', exact: true }).click();
  await page.getByLabel('실루엣 X', { exact: true }).fill('-4'); await page.getByLabel('실루엣 Y', { exact: true }).fill('-2');
  const before = await save(); assert.equal(before.boards[0].overlays.length, 2);

  await tool('그림 전체 이동 (V)'); await gesture([60.5, 60.5], [[67.5, 57.5]]);
  const firstPixels = translated(before.assets[0].frames[0].pixels, 7, -3), first = await save();
  assertMove(first, firstPixels, before, 'whole-art move translates exact RGBA bytes including partial alpha and hidden RGB');
  assert.deepEqual(await canvas(2).evaluate((node) => Array.from(node.getContext('2d').getImageData(47, 47, 1, 1).data)), [17, 51, 85, 255], 'a second pane of the same frame displays the moved artwork');
  await shortcut('Control+Z'); assertMove(await save(), before.assets[0].frames[0].pixels, before, 'one undo restores the entire multi-event drag');
  await shortcut('Control+Alt+Z'); assertMove(await save(), firstPixels, before, 'redo restores the exact move');

  // Travel to the boundary and back before releasing: preview must always read the immutable original.
  await tool('그림 전체 이동 (V)'); await gesture([60, 60], [[180, 150], [63, 58]]);
  const secondPixels = translated(firstPixels, 3, -2), second = await save(); assertMove(second, secondPixels, before, 'preview excursion cannot cumulatively clip or resample pixels');
  await shortcut('Control+Z'); assertMove(await save(), firstPixels, before, 'one undo restores the whole excursion drag');
  await shortcut('Control+Alt+Z'); assertMove(await save(), secondPixels, before, 'excursion redo is exact');

  await tool('그림 전체 이동 (V)'); await gesture([60, 60], [[-100, -100]]);
  const clampedPixels = translated(secondPixels, -45, -40), clamped = await save(); assertMove(clamped, clampedPixels, before, 'motion clamps to visible alpha bounds');
  assert.deepEqual(bounds(clampedPixels), { left: 0, top: 0, right: 47, bottom: 50, count: bounds(before.assets[0].frames[0].pixels).count });
  await shortcut('Control+Z'); assertMove(await save(), secondPixels, before, 'undo also restores hidden RGB clipped outside visible art bounds');

  await tool('그림 전체 이동 (V)'); await gesture([60, 60], [[65, 65]], true);
  assertMove(await save(), secondPixels, before, 'Escape cancels preview without committing');
  await shortcut('Control+Alt+Z'); assertMove(await save(), clampedPixels, before, 'a canceled drag keeps the prior redo branch');
  await shortcut('Control+Z'); await tool('그림 전체 이동 (V)'); await gesture([60, 60], []);
  assertMove(await save(), secondPixels, before, 'zero-delta gesture is a no-op');
  await shortcut('Control+Alt+Z'); assertMove(await save(), clampedPixels, before, 'a zero-delta gesture also keeps redo');
  await tool('그림 전체 이동 (V)'); await gesture([20, 20], [[-20, -20]]);
  assertMove(await save(), clampedPixels, before, 'dragging farther beyond a clamped edge is a no-op');
  await shortcut('Control+Z'); assertMove(await save(), secondPixels, before, 'edge no-op adds no extra undo entry');

  await page.getByRole('button', { name: '이미지 저장', exact: true }).click(); await page.locator('input[name="exportType"][value="png"]').check();
  const exported = decode(await download(() => page.getByRole('button', { name: '파일 내려받기', exact: true }).click(), 'png'));
  assert.deepEqual([exported.width, exported.height, exported.channels], [160, 160, 4]);
  assert.equal(Buffer.compare(Buffer.from(exported.data), Buffer.from(secondPixels, 'base64')), 0, 'PNG export saves moved native pixels without stationary editing aids');
  const saved = await save(); await load(saved); assert.deepEqual(await save(), saved, 'saved project preserves the moved native artwork and stationary aids');

  await tool('그림 전체 이동 (V)');
  const shiftCases = [
    { label: 'horizontal dominance', delta: [8, 3], preview: [8, 0], result: [8, 0], shiftOnMove: true, shiftOnDrop: true },
    { label: 'vertical dominance', delta: [3, -8], preview: [0, -8], result: [0, -8], shiftOnMove: true, shiftOnDrop: true },
    { label: 'horizontal tie', delta: [6, 6], preview: [6, 0], result: [6, 0], shiftOnMove: true, shiftOnDrop: true },
    // Clamping first would reduce X to 67 and Y to 69, picking the wrong axis.
    { label: 'axis selection before clamping', delta: [90, 80], preview: [67, 0], result: [67, 0], shiftOnMove: true, shiftOnDrop: true },
    { label: 'Shift released before drop', delta: [8, 3], preview: [8, 0], result: [8, 3], shiftOnMove: true, shiftOnDrop: false },
    { label: 'Shift pressed before drop', delta: [3, -8], preview: [3, -8], result: [0, -8], shiftOnMove: false, shiftOnDrop: true },
  ];
  for (const { label, delta, preview, result, shiftOnMove, shiftOnDrop } of shiftCases) {
    await shiftGesture(delta, preview, shiftOnMove, shiftOnDrop);
    assertMove(await save(), translated(secondPixels, ...result), saved, label);
    await shortcut('Control+Z');
    assertMove(await save(), secondPixels, saved, `${label}: one undo restores the full drag`);
  }

  await page.getByLabel('공통 확대 (%)').fill('235'); await tool('화면 이동 (P)'); await gesture([80, 80], [[83.3, 82.2]]);
  const fractionalBefore = await save(); await tool('그림 전체 이동 (V)'); await gesture([60.25, 60.25], [[64.25, 57.25]]);
  const fractional = await save(); assertMove(fractional, translated(secondPixels, 4, -3), fractionalBefore, 'fractional shared view converts pointer delta to the intended integer native displacement');
  await page.screenshot({ path: path.join(artifacts, 'move-ui.png'), fullPage: true });

  // Choosing a layer from the list must switch tools and move exactly that layer.
  await page.locator('.layer-select').nth(0).click();
  assert.equal(await page.getByRole('button', { name: '실루엣 이동 (O)', exact: true }).getAttribute('aria-pressed'), 'true');
  await gesture([60, 60], [[65, 62]]); const selectedFirst = await save();
  assert.deepEqual(nativePixels(selectedFirst), nativePixels(fractional));
  assert.deepEqual(selectedFirst.boards[0].overlays[1], fractional.boards[0].overlays[1]);
  assert.deepEqual([selectedFirst.boards[0].overlays[0].x, selectedFirst.boards[0].overlays[0].y], [8, 6]);
  await tool('그림 전체 이동 (V)'); await page.locator('.layer-select').nth(1).click();
  assert.equal(await page.getByRole('button', { name: '실루엣 이동 (O)', exact: true }).getAttribute('aria-pressed'), 'true');
  await gesture([60, 60], [[57, 66]]); const selectedSecond = await save();
  assert.deepEqual(nativePixels(selectedSecond), nativePixels(fractional));
  assert.deepEqual(selectedSecond.boards[0].overlays[0], selectedFirst.boards[0].overlays[0]);
  assert.deepEqual([selectedSecond.boards[0].overlays[1].x, selectedSecond.boards[0].overlays[1].y], [-7, 4]);
  assert.deepEqual(selectedSecond.guides, fractional.guides); assert.deepEqual(selectedSecond.joinedView, fractional.joinedView);
  const unselected = structuredClone(selectedSecond); unselected.boards[0].selectedOverlayId = null; await load(unselected);
  await tool('실루엣 이동 (O)'); await gesture([60, 60], [[65, 65]]);
  const noFallback = await save(); assert.deepEqual(aids(noFallback), aids(unselected), 'no selected layer means no implicit fallback to another silhouette');
  assert.deepEqual(nativePixels(noFallback), nativePixels(unselected));
  const crossBoard = structuredClone(selectedSecond);
  crossBoard.boards[1].overlays = [{ ...structuredClone(crossBoard.boards[0].overlays[0]), id: 'qa-destination-mask', x: 0, y: 0 }];
  crossBoard.boards[1].selectedOverlayId = 'qa-destination-mask'; crossBoard.activeBoardId = crossBoard.boards[0].id;
  await load(crossBoard); await tool('실루엣 이동 (O)'); await gesture([220, 60], [[225, 65]]);
  const activatedOnly = await save();
  assert.equal(activatedOnly.activeBoardId, activatedOnly.boards[1].id);
  assert.deepEqual(aids(activatedOnly), aids(crossBoard), 'first O drag into another canvas only activates it, even if it had an old selected mask');
  assert.deepEqual(nativePixels(activatedOnly), nativePixels(crossBoard));
  await page.locator('.layer-select').first().click(); await gesture([220, 60], [[225, 65]]);
  const explicitDestination = await save();
  assert.deepEqual(explicitDestination.boards[0].overlays, crossBoard.boards[0].overlays);
  assert.deepEqual([explicitDestination.boards[1].overlays[0].x, explicitDestination.boards[1].overlays[0].y], [5, 5], 'explicitly selecting the destination layer enables its own movement');
  assert.deepEqual(nativePixels(explicitDestination), nativePixels(crossBoard));
  assert.deepEqual(errors, []);
  console.log('PASS: exact bounded whole-art translation, Shift axis locking and modifier changes, immutable previews, shared-frame display, active-frame isolation, stationary aids/view, one-drag undo/redo, cancel/no-op history, fractional view, clean export/restore and selected-only silhouettes.');
} catch (error) { await page.screenshot({ path: path.join(artifacts, 'move-failure.png'), fullPage: true }).catch(() => {}); throw error; }
finally { await context.close(); await browser.close(); }
