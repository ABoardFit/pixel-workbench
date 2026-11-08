import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { encode, decode } from 'fast-png';
import { parseGIF, decompressFrames } from 'gifuct-js';
import { rgbaFixture, disposalGifFixture } from './fixtures.mjs';

const baseURL = process.env.TEST_URL || 'http://127.0.0.1:5173';
const root = path.resolve(import.meta.dirname, '..');
const artifacts = path.join(root, '.test-results');
await fs.mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
});
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
if (process.env.TEST_DIST === '1') {
  const prefix = new URL(baseURL).pathname.replace(/\/$/, '');
  await page.route(`${new URL(baseURL).origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    let relative = decodeURIComponent(url.pathname).slice(prefix.length).replace(/^\/+/, '') || 'index.html';
    const filename = path.resolve(root, 'dist', relative);
    assert.ok(filename.startsWith(path.join(root, 'dist') + path.sep), 'static route remains inside dist');
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
    try { await route.fulfill({ status: 200, contentType: types[path.extname(filename)] || 'application/octet-stream', body: await fs.readFile(filename) }); }
    catch { await route.fulfill({ status: 404, body: 'Not found' }); }
  });
}

async function download(click, filename) {
  const pending = page.waitForEvent('download');
  await click();
  const result = await pending;
  const target = path.join(artifacts, filename);
  await result.saveAs(target);
  assert.equal(await result.failure(), null);
  return fs.readFile(target);
}

async function importBytes(bytes, name, mimeType) {
  await page.getByLabel('PNG 또는 GIF 파일 선택').setInputFiles({ name, mimeType, buffer: Buffer.from(bytes) });
}

function pixels(pngBytes) {
  const png = decode(pngBytes);
  assert.equal(png.channels, 4);
  return { width: png.width, height: png.height, data: Array.from(png.data) };
}

const board = (number) => page.getByRole('article', { name: `${number}번 비교 칸`, exact: true });
const canvas = (number) => page.locator('canvas[data-testid^="board-canvas-"]').nth(number - 1);
async function activate(number) { await board(number).locator('.board-heading').click(); }
async function nativePoint(number, x, y) {
  const bounds = await canvas(number).boundingBox();
  const size = await canvas(number).evaluate((node) => ({ width: node.width, height: node.height }));
  assert.ok(bounds, 'canvas has a visible bounds');
  return { x: bounds.x + (x + 0.5) * bounds.width / size.width, y: bounds.y + (y + 0.5) * bounds.height / size.height };
}
async function clickPixel(number, x, y) { const p = await nativePoint(number, x, y); await page.mouse.click(p.x, p.y); }
async function displayPixel(number, x, y) {
  const p = await nativePoint(number, x, y), image = decode(await page.screenshot());
  const offset = (Math.floor(p.y) * image.width + Math.floor(p.x)) * image.channels;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2], image.channels === 4 ? image.data[offset + 3] : 255];
}
async function drag(number, from, to, shift = false) {
  const a = await nativePoint(number, ...from), b = await nativePoint(number, ...to);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
}
async function setRange(locator, value) {
  await locator.focus();
  await locator.press('Home');
  // Native range keyboard input exercises the same React controls as a user.
  const minimum = Number(await locator.getAttribute('min'));
  for (let n = minimum; n < value; n++) await locator.press('ArrowRight');
}
async function assertValue(locator, expected) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await locator.inputValue() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(await locator.inputValue(), expected);
}
async function exportFile(type = 'png', extra = async () => {}) {
  await page.getByRole('button', { name: '이미지 저장', exact: true }).click();
  await page.locator(`input[name="exportType"][value="${type}"]`).check();
  await extra();
  return download(() => page.getByRole('button', { name: '파일 내려받기', exact: true }).click(), `export-${Date.now()}.${type === 'gif' ? 'gif' : 'png'}`);
}
async function save() { return JSON.parse((await download(() => page.getByRole('button', { name: '편집 상태 저장', exact: true }).click(), `project-${Date.now()}.json`)).toString()); }
const frameBytes = (project, asset = 0, frame = 0) => Array.from(Buffer.from(project.assets[asset].frames[frame].pixels, 'base64'));
async function reset() { await page.reload(); await page.getByRole('heading', { name: '도트 작업실', exact: true }).waitFor(); }

try {
  await page.goto(baseURL);
  await page.getByRole('heading', { name: '도트 작업실', exact: true }).waitFor();
  await importBytes(encode({ ...rgbaFixture, channels: 4, depth: 8 }), 'qa-colors.png', 'image/png');
  await canvas(1).waitFor();
  assert.deepEqual(pixels(await exportFile()).data, Array.from(rgbaFixture.data), 'PNG export preserves every native RGBA byte');
  assert.deepEqual(pixels(await exportFile('sheet')).data, Array.from(rgbaFixture.data), 'default single-frame sheet export is valid');
  await page.getByRole('button', { name: '스포이트 (I)', exact: true }).click();
  await clickPixel(1, 1, 0);
  await assertValue(page.getByLabel('색상 HEX'), '#c9135b');
  await assertValue(page.getByLabel('그리기 불투명도'), '128');
  await page.getByRole('button', { name: '화면 이동 (P)', exact: true }).click();
  await drag(1, [1, 1], [2, 2]);
  const panned = await save();
  assert.notEqual(panned.joinedView.panX, 0);
  assert.deepEqual(frameBytes(panned), Array.from(rgbaFixture.data), 'pan never paints pixels');
  await page.getByRole('button', { name: '연필 (B)', exact: true }).click();
  await page.getByRole('button', { name: '전체 캔버스 화면에 맞춤', exact: true }).click();
  await page.getByRole('button', { name: '100% 보기', exact: true }).click();
  assert.deepEqual(pixels(await exportFile()).data, Array.from(rgbaFixture.data), 'viewport control clicks never paint');
  await page.getByRole('button', { name: '전체 캔버스 화면에 맞춤', exact: true }).click();
  await page.getByRole('button', { name: '지우개 (E)', exact: true }).click();
  await clickPixel(1, 0, 0);
  const erased = pixels(await exportFile()).data;
  assert.deepEqual(erased.slice(0, 4), [0, 0, 0, 0], 'eraser writes fully transparent pixels');
  assert.deepEqual(erased.slice(4), Array.from(rgbaFixture.data).slice(4), 'eraser only affects the selected native pixel');
  await page.getByRole('button', { name: /^((그리기|편집) )?실행 취소$/ }).click();
  assert.deepEqual(pixels(await exportFile()).data, Array.from(rgbaFixture.data), 'eraser undo restores exact source colors and alpha');
  await page.screenshot({ path: path.join(artifacts, 'editor-loaded.png'), fullPage: true });

  await reset();
  await importBytes(encode({ width: 7, height: 4, data: new Uint8Array(7 * 4 * 4), channels: 4, depth: 8 }), 'qa-line.png', 'image/png');
  await canvas(1).waitFor();
  await page.getByLabel('색상 HEX').fill('#f12345');
  await page.getByRole('button', { name: '직선 (L)', exact: true }).click();
  await drag(1, [1, 1], [10, 7], true);
  let line = pixels(await exportFile()).data;
  const occupied = [];
  for (let i = 0; i < 28; i++) if (line[i * 4 + 3]) occupied.push(i);
  assert.deepEqual(occupied, [8, 16, 24], 'Shift drag beyond unequal edges keeps exact45 diagonal');
  await page.getByRole('button', { name: /^((그리기|편집) )?실행 취소$/ }).click();
  assert.ok(pixels(await exportFile()).data.every((value) => value === 0), 'undo removes one complete line');
  await page.getByRole('button', { name: /^((그리기|편집) )?다시 실행$/ }).click();
  assert.deepEqual(pixels(await exportFile()).data, line, 'redo restores exact original line');

  await reset();
  await importBytes(disposalGifFixture(), 'qa-disposal.gif', 'image/gif');
  await canvas(1).waitFor();
  await setRange(board(1).getByLabel('1번 칸 프레임 이동'), 2);
  await board(1).getByRole('button', { name: '옆에 고정', exact: true }).click();
  await canvas(2).waitFor();
  assert.equal(await board(2).getByLabel('2번 칸 프레임 이동').inputValue(), '2');
  await setRange(board(1).getByLabel('1번 칸 프레임 이동'), 0);
  await board(1).getByRole('button', { name: '다음 프레임', exact: true }).click();
  await assertValue(board(1).getByLabel('1번 칸 프레임 이동'), '1');
  await board(1).getByRole('button', { name: '이전 프레임', exact: true }).click();
  await assertValue(board(1).getByLabel('1번 칸 프레임 이동'), '0');
  await board(1).getByRole('button', { name: '이 칸 재생', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="1번 칸 프레임 이동"]').value !== '0');
  assert.equal(await board(2).getByLabel('2번 칸 프레임 이동').inputValue(), '2', 'pinned board freezes independently');
  await board(1).getByRole('button', { name: '이 칸 일시정지', exact: true }).click();
  await setRange(board(1).getByLabel('1번 칸 프레임 이동'), 0);
  await board(1).getByRole('button', { name: '이 칸 재생', exact: true }).click();
  await board(1).getByRole('button', { name: '이 칸 일시정지', exact: true }).waitFor();
  await board(1).getByRole('button', { name: '이 칸 재생', exact: true }).waitFor({ timeout: 5000 });
  await assertValue(board(1).getByLabel('1번 칸 프레임 이동'), '3');
  await assertValue(board(2).getByLabel('2번 칸 프레임 이동'), '2');
  await setRange(board(1).getByLabel('1번 칸 프레임 이동'), 0);
  await page.getByLabel('색상 HEX').fill('#102030');
  await clickPixel(1, 0, 0);
  await page.getByLabel('색상 HEX').fill('#abcdef');
  await clickPixel(2, 0, 0);
  const edited = await save();
  assert.deepEqual(frameBytes(edited, 0, 0).slice(0, 4), [16, 32, 48, 255]);
  assert.deepEqual(frameBytes(edited, 0, 2).slice(0, 4), [171, 205, 239, 255]);
  await setRange(board(2).getByLabel('2번 칸 프레임 이동'), 1);
  await setRange(board(2).getByLabel('2번 칸 프레임 이동'), 2);
  await activate(2);
  assert.deepEqual(pixels(await exportFile()).data, frameBytes(edited, 0, 2), 'second pane edits survive frame switching');
  await activate(1);
  await page.getByRole('button', { name: '현재 프레임 잡기', exact: true }).click();
  await activate(2);
  await page.getByRole('button', { name: '이 칸에 실루엣 추가', exact: true }).click();
  await setRange(page.getByLabel('실루엣 불투명도'), 100);
  await page.getByLabel('실루엣 X', { exact: true }).fill('1');
  await page.getByLabel('실루엣 Y', { exact: true }).fill('0');
  assert.deepEqual(await displayPixel(2, 1, 0), [90, 155, 255, 255], 'front silhouette translates in native X/Y');
  await page.getByLabel('실루엣 Y', { exact: true }).fill('1');
  assert.deepEqual(await displayPixel(2, 1, 1), [90, 155, 255, 255], 'silhouette Y moves independently of X');
  assert.deepEqual(await displayPixel(2, 1, 0), [255, 0, 0, 255]);
  await page.getByLabel('실루엣 Y', { exact: true }).fill('0');
  await setRange(page.getByLabel('실루엣 불투명도'), 25);
  assert.deepEqual(await displayPixel(2, 1, 0), [214, 39, 64, 255], 'opacity is applied once over the editable image');
  await page.getByLabel('실루엣 앞뒤 순서').selectOption('back');
  assert.deepEqual(await displayPixel(2, 1, 0), [255, 0, 0, 255], 'back silhouette stays behind opaque native pixels');
  assert.deepEqual(pixels(await exportFile('png')).data, frameBytes(edited, 0, 2), 'raster PNG always excludes visible comparison aids');
  const saved = await save();
  assert.deepEqual(frameBytes(saved, 0, 2), frameBytes(edited, 0, 2), 'overlay controls do not overwrite editable pixels');
  const gif = await exportFile('gif');
  const parsed = parseGIF(gif.buffer.slice(gif.byteOffset, gif.byteOffset + gif.byteLength));
  const patches = decompressFrames(parsed, true);
  assert.deepEqual(patches.map((frame) => frame.delay), [70, 130, 190, 230]);
  assert.deepEqual(patches.map((frame) => Array.from(frame.patch)), saved.assets[0].frames.map((_, index) => frameBytes(saved, 0, index)));
  await reset();
  await page.getByLabel('작업 파일 선택').setInputFiles({ name: 'restored.pixel.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) });
  await canvas(2).waitFor();
  const restored = await save();
  assert.deepEqual(restored, saved, 'project restore keeps pane frames, pixels and overlay settings');
  await page.screenshot({ path: path.join(artifacts, 'editor-comparison.png'), fullPage: true });
  await board(2).getByRole('button', { name: '복제해 편집', exact: true }).click();
  await canvas(3).waitFor();
  await page.getByRole('button', { name: '연필 (B)', exact: true }).click();
  await page.getByLabel('색상 HEX').fill('#789abc');
  await clickPixel(3, 0, 0);
  const cloned = await save();
  assert.deepEqual(frameBytes(cloned, 0, 2), frameBytes(saved, 0, 2), 'independent duplicate edits leave source pane unchanged');
  assert.deepEqual(frameBytes(cloned, 1, 0).slice(0, 4), [120, 154, 188, 255]);

  await reset();
  const sheetPixels = new Uint8Array(7 * 5 * 4);
  const colors = [[17, 33, 65, 255], [201, 19, 91, 128], [7, 99, 13, 0], [1, 222, 3, 255]];
  [[1, 1], [4, 1], [1, 3], [4, 3]].forEach(([left, top], index) => {
    for (let x = 0; x < 2; x++) sheetPixels.set(colors[index], (top * 7 + left + x) * 4);
  });
  await page.getByLabel('스프라이트 시트 PNG 선택').setInputFiles({ name: 'qa-offset-sheet.png', mimeType: 'image/png', buffer: Buffer.from(encode({ width: 7, height: 5, channels: 4, depth: 8, data: sheetPixels })) });
  for (const [label, value] of [['프레임 가로', 2], ['프레임 세로', 1], ['시작 X', 1], ['시작 Y', 1], ['가로 간격', 1], ['세로 간격', 1], ['프레임 시간 (ms)', 73]]) await page.getByLabel(label, { exact: true }).fill(String(value));
  await page.getByRole('button', { name: '프레임으로 열기', exact: true }).click();
  await canvas(1).waitFor();
  const sheetProject = await save();
  assert.equal(sheetProject.assets[0].frames.length, 4);
  assert.deepEqual(sheetProject.assets[0].frames.map((_, index) => frameBytes(sheetProject, 0, index)), colors.map((color) => [...color, ...color]));
  const sheetExport = pixels(await exportFile('sheet', () => page.getByLabel('한 줄의 프레임 수').fill('2')));
  assert.deepEqual([sheetExport.width, sheetExport.height], [4, 2]);
  assert.deepEqual(sheetExport.data, colors.flatMap((color) => [...color, ...color]));
  assert.deepEqual(errors, []);
  console.log('PASS: browser imports, RGBA picking, independent playback/panes, two-pane edits, Shift edge line, pan, undo/redo, silhouettes, PNG/sheet/GIF exports and project restore.');
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await context.close();
  await browser.close();
}
