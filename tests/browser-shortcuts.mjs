import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { encode } from 'fast-png';
import { disposalGifFixture } from './fixtures.mjs';

const root = path.resolve(import.meta.dirname, '..'), artifacts = path.join(root, '.test-results');
const baseURL = process.env.TEST_URL || 'http://127.0.0.1:5174/';
await fs.mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage(), errors = [];
page.on('pageerror', (error) => errors.push(error.message));
if (process.env.TEST_DIST === '1') {
  const prefix = new URL(baseURL).pathname.replace(/\/$/, '');
  await page.route(`${new URL(baseURL).origin}/**`, async (route) => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname).slice(prefix.length).replace(/^\/+/, '') || 'index.html';
    const filename = path.resolve(root, 'dist', relative);
    assert.ok(filename.startsWith(path.join(root, 'dist') + path.sep));
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    try { await route.fulfill({ contentType: mime[path.extname(filename)] || 'application/octet-stream', body: await fs.readFile(filename) }); }
    catch { await route.fulfill({ status: 404, body: 'Not found' }); }
  });
}
const raw = new Uint8Array(160 * 160 * 4);
for (let y = 30; y < 130; y++) for (let x = 30; x < 130; x++) raw.set([17, 51, 85, 255], (y * 160 + x) * 4);
raw.set([201, 19, 91, 128], (20 * 160 + 12) * 4);
raw.set([7, 99, 13, 0], (20 * 160 + 13) * 4);
raw.set([220, 99, 11, 255], (40 * 160 + 39) * 4);
const fixture = Buffer.from(encode({ width: 160, height: 160, channels: 4, depth: 8, data: raw }));
const canvas = (number = 1) => page.locator('canvas[data-testid^="board-canvas-"]').nth(number - 1);
const board = (number = 1) => page.getByRole('article', { name: `${number}번 비교 칸`, exact: true });
const pixels = (project) => project.assets.map((asset) => asset.frames.map((frame) => frame.pixels));
const overlays = (project) => project.boards.map((board) => board.overlays);
let serial = 0;
async function save() {
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: '편집 상태 저장', exact: true }).click();
  const download = await pending, filename = path.join(artifacts, `shortcuts-${++serial}.json`);
  await download.saveAs(filename);
  // Avoid bursts of repeated state downloads while exercising keyboard history.
  await new Promise((resolve) => setTimeout(resolve, 150));
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}
async function reset() {
  await page.goto(baseURL); await page.getByRole('heading', { name: '도트 작업실', exact: true }).waitFor();
  await page.getByLabel('PNG 또는 GIF 파일 선택').setInputFiles({ name: 'qa-shortcuts.png', mimeType: 'image/png', buffer: fixture });
  await canvas().waitFor();
  await page.getByLabel('공통 확대 (%)').fill('200');
  await page.waitForFunction(() => document.querySelector('canvas[data-testid^="board-canvas-"]').getBoundingClientRect().width === 320);
}
async function point(x, y) {
  const rect = await canvas().boundingBox(), width = await canvas().evaluate((node) => node.width), zoom = rect.width / width;
  return { x: rect.x + x * zoom, y: rect.y + y * zoom };
}
async function drag(from, to, shift = false) {
  const a = await point(...from), b = await point(...to);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 12 }); await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
}
async function tool(name) { const button = page.getByRole('button', { name, exact: true }); await button.click(); return button; }
async function shortcut(keys) { await page.getByRole('heading', { name: '도트 작업실', exact: true }).click(); await page.keyboard.press(keys); }
async function paint(x, y, color = '#abcdef') { await page.getByLabel('색상 HEX').fill(color); await tool('연필 (B)'); const p = await point(x, y); await page.mouse.click(p.x, p.y); }
async function guide(from = [30, 20], to = [90, 50]) { await tool('룰러(자) (R)'); await drag(from, to); }
async function noPlayback() { assert.equal(await page.getByRole('button', { name: '이 칸 일시정지', exact: true }).count(), 0, 'Space drag must not toggle playback'); }
function mirroredBase64(data, width, height) {
  const source = Buffer.from(data, 'base64'), result = Buffer.alloc(source.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) source.copy(result, (y * width + x) * 4, (y * width + width - x - 1) * 4, (y * width + width - x) * 4);
  return result.toString('base64');
}

try {
  await reset();
  const initial = await save();
  for (const name of ['화면 이동 (P)', '그림 전체 이동 (V)', '연필 (B)', '직선 (L)', '룰러(자) (R)', '지우개 (E)', '스포이트 (I)', '채우기 (F)', '실루엣 이동 (O)']) {
    const before = await save(), button = await tool(name);
    assert.equal(await button.evaluate((node) => node === document.activeElement), true, 'regression setup leaves focus on the selected toolbar button');
    await page.keyboard.down('Space'); await drag([80, 80], [86, 84]); await page.keyboard.up('Space');
    assert.equal(await button.getAttribute('aria-pressed'), 'true', `${name}: releasing Space restores the selected tool`);
    const after = await save();
    assert.deepEqual(pixels(after), pixels(initial), `${name}: temporary pan never paints pixels`);
    assert.deepEqual(after.guides ?? [], before.guides ?? [], `${name}: temporary pan never creates a ruler`);
    assert.ok(after.joinedView.panX > before.joinedView.panX && after.joinedView.panY > before.joinedView.panY, `${name}: Space drag works while the tool button has focus`);
    await noPlayback();
  }
  const beforeInputPan = await save(); await tool('연필 (B)');
  const inputSpace = page.getByLabel('색상 HEX'); await inputSpace.fill('#6633');
  await page.keyboard.down('Space');
  assert.ok((await inputSpace.inputValue()).includes(' '), 'Space still enters native text while the HEX field is focused');
  await drag([80, 80], [86, 84]); await page.keyboard.up('Space');
  const afterInputPan = await save();
  assert.deepEqual(pixels(afterInputPan), pixels(beforeInputPan), 'holding Space from a text field still pans when the canvas drag begins');
  assert.ok(afterInputPan.joinedView.panX > beforeInputPan.joinedView.panX && afterInputPan.joinedView.panY > beforeInputPan.joinedView.panY);
  await noPlayback();
  await inputSpace.fill('#12345'); await inputSpace.press('Space');
  assert.equal(await inputSpace.inputValue(), '#12345 ', 'typing a Space without a canvas drag keeps native text behavior');
  await noPlayback();
  await paint(8.5, 8.5);
  const releasedPaint = await save(); assert.notDeepEqual(pixels(releasedPaint), pixels(initial), 'after Space release a normal pencil click paints');
  await shortcut('Control+Z'); assert.deepEqual(pixels(await save()), pixels(initial));
  await shortcut('Control+Alt+Z'); assert.deepEqual(pixels(await save()), pixels(releasedPaint), 'Ctrl+Alt+Z redoes actual pixel changes');

  const field = page.getByLabel('색상 HEX');
  await field.focus(); await field.press('Control+A'); await field.press('Backspace'); await field.pressSequentially('#112233', { delay: 15 });
  await field.press('Control+Z'); assert.notEqual(await field.inputValue(), '#112233', 'focused text input keeps its native undo');
  assert.deepEqual(pixels(await save()), pixels(releasedPaint), 'native input undo never invokes editor pixel undo');
  await shortcut('Control+Z');
  await field.focus(); await field.press('Control+Alt+Z');
  assert.deepEqual(pixels(await save()), pixels(initial), 'focused input does not invoke editor redo');
  await shortcut('Control+Alt+Z'); assert.deepEqual(pixels(await save()), pixels(releasedPaint));

  await tool('연필 (B)'); await field.fill('#cc8844');
  const fromField = await point(9.5, 9.5); await page.mouse.click(fromField.x, fromField.y);
  // No intervening toolbar or heading click: canvas must have reclaimed keyboard focus.
  await page.keyboard.press('Control+Z');
  assert.deepEqual(pixels(await save()), pixels(releasedPaint), 'CtrlZ immediately after HEX→canvas drawing undoes pixels rather than the stale input');
  await shortcut('Control+Alt+Z');
  const afterFieldPaint = await save(), expectedFieldPixels = Buffer.from(releasedPaint.assets[0].frames[0].pixels, 'base64');
  expectedFieldPixels.set([204, 136, 68, 255], (9 * 160 + 9) * 4);
  assert.equal(afterFieldPaint.assets[0].frames[0].pixels, expectedFieldPixels.toString('base64'));

  // Chronological history interleaves pixels and guide metadata, without rewinding view/playback.
  await reset(); const base = await save();
  await paint(5.5, 5.5); const painted = await save();
  await tool('화면 이동 (P)'); await drag([80, 80], [87, 83]);
  await guide(); const guided = await save();
  await board().getByRole('button', { name: '이 칸 재생', exact: true }).click();
  await shortcut('Control+Z'); let current = await save();
  assert.deepEqual(current.guides ?? [], []); assert.deepEqual(pixels(current), pixels(painted));
  assert.deepEqual(current.joinedView, guided.joinedView, 'guide undo preserves view');
  assert.equal(await board().getByRole('button', { name: '이 칸 일시정지', exact: true }).count(), 1, 'guide undo preserves playback');
  await shortcut('Control+Z'); current = await save();
  assert.deepEqual(pixels(current), pixels(base), 'next undo restores the preceding pixel edit');
  assert.deepEqual(current.joinedView, guided.joinedView, 'pixel undo also preserves view');
  assert.equal(await board().getByRole('button', { name: '이 칸 일시정지', exact: true }).count(), 1, 'pixel undo preserves playback');
  await shortcut('Control+Alt+Z'); current = await save(); assert.deepEqual(pixels(current), pixels(painted)); assert.deepEqual(current.guides ?? [], []);
  await shortcut('Control+Alt+Z'); current = await save(); assert.deepEqual(current.guides, guided.guides, 'guide redo restores the same ID, RGB and boundary coordinates');
  await board().getByRole('button', { name: '이 칸 일시정지', exact: true }).click();
  await shortcut('Control+Z'); await paint(6.5, 5.5, '#cc6633'); const branched = await save();
  await shortcut('Control+Alt+Z'); assert.deepEqual(await save(), branched, 'a new edit invalidates the abandoned guide redo branch');

  await guide([30, 20], [90, 50]); await guide([40, 25], [100, 55]); const twoGuides = await save();
  await page.getByRole('button', { name: '1번 자 숨기기', exact: true }).click(); await shortcut('Control+Z'); assert.deepEqual((await save()).guides, twoGuides.guides);
  await shortcut('Control+Alt+Z'); assert.equal((await save()).guides[0].visible, false);
  await page.getByRole('button', { name: '2번 자 삭제', exact: true }).click(); await shortcut('Control+Z'); assert.equal((await save()).guides.length, 2);
  await page.getByRole('button', { name: '모든 자 지우기', exact: true }).click(); await shortcut('Control+Z'); assert.equal((await save()).guides.length, 2);
  await shortcut('Control+Alt+Z'); assert.equal((await save()).guides.length, 0);

  // Fractional view transforms still snap ruler endpoints to integer corners, including diagonals.
  await page.getByLabel('공통 확대 (%)').fill('235');
  await tool('화면 이동 (P)'); await drag([80, 80], [83.3, 82.2]);
  await tool('룰러(자) (R)'); await drag([35.2, 21.2], [63.8, 48.7], true);
  const fractional = await save(), corners = fractional.guides.at(-1);
  assert.ok([corners.x1, corners.y1, corners.x2, corners.y2].every(Number.isInteger));
  assert.equal(Math.abs(corners.x2 - corners.x1), Math.abs(corners.y2 - corners.y1), 'fractional view preserves exact45 integer-corner endpoints');

  // Silhouette commands share the same timeline; one pointer drag is exactly one undo entry.
  await reset(); await board().getByRole('button', { name: '옆에 고정', exact: true }).click();
  await board(1).locator('.board-heading').click(); await page.getByRole('button', { name: '현재 프레임 잡기', exact: true }).click();
  await board(2).locator('.board-heading').click(); await page.getByRole('button', { name: '이 칸에 실루엣 추가', exact: true }).click();
  const pasted = await save(); assert.deepEqual(pasted.boards.map((board) => board.overlays.length), [0, 1]);
  await shortcut('Control+Z'); assert.deepEqual(overlays(await save()), [[], []]);
  await shortcut('Control+Alt+Z'); assert.deepEqual(overlays(await save()), overlays(pasted));
  await tool('실루엣 이동 (O)'); await drag([240, 80], [248, 85]); const moved = await save();
  assert.deepEqual([moved.boards[1].overlays[0].x, moved.boards[1].overlays[0].y], [8, 5]);
  await shortcut('Control+Z'); assert.deepEqual(overlays(await save()), overlays(pasted), 'one undo restores the entire multi-event overlay drag');
  await shortcut('Control+Alt+Z'); assert.deepEqual(overlays(await save()), overlays(moved));
  const opacity = page.getByLabel('실루엣 불투명도'); await opacity.focus(); await opacity.press('ArrowRight');
  const faded = structuredClone(moved); faded.boards[1].overlays[0].opacity = 0.51;
  assert.equal(await opacity.inputValue(), '51');
  await page.keyboard.press('Control+Z'); assert.deepEqual(overlays(await save()), overlays(moved), 'CtrlZ immediately after a focused range change undoes editor metadata');
  await opacity.focus(); await page.keyboard.press('Control+Alt+Z'); assert.deepEqual(overlays(await save()), overlays(faded));
  await board(2).getByRole('button', { name: '이 칸 재생', exact: true }).click();
  const order = page.getByLabel('실루엣 앞뒤 순서'); await order.focus(); await order.selectOption('back');
  const behind = structuredClone(faded); behind.boards[1].overlays[0].order = 'back';
  await page.keyboard.press('Control+Z'); assert.deepEqual(overlays(await save()), overlays(faded), 'CtrlZ immediately after a focused select change undoes editor metadata');
  assert.equal(await board(2).getByRole('button', { name: '이 칸 일시정지', exact: true }).count(), 1, 'overlay undo preserves playback');
  await order.focus(); await page.keyboard.press('Control+Alt+Z'); assert.deepEqual(overlays(await save()), overlays(behind));
  await board(2).getByRole('button', { name: '이 칸 일시정지', exact: true }).click();
  await page.getByRole('button', { name: '1번 실루엣 삭제', exact: true }).click(); await shortcut('Control+Z'); assert.deepEqual(overlays(await save()), overlays(behind));
  await shortcut('Control+Alt+Z'); assert.deepEqual(overlays(await save()), [[], []]);
  assert.deepEqual(pixels(await save()), pixels(pasted), 'metadata history never alters any native asset RGBA');

  // Asymmetric native RGBA, transparent RGB and other animation frames stay exact through flips.
  await reset();
  await page.getByLabel('PNG 또는 GIF 파일 선택').setInputFiles({ name: 'qa-other-frames.gif', mimeType: 'image/gif', buffer: Buffer.from(disposalGifFixture()) });
  await board(2).waitFor();
  await board(1).locator('.board-heading').click(); await guide();
  await page.getByRole('button', { name: '현재 프레임 잡기', exact: true }).click();
  await board(2).locator('.board-heading').click(); await page.getByRole('button', { name: '이 칸에 실루엣 추가', exact: true }).click();
  await board(1).locator('.board-heading').click(); const beforeFlip = await save();
  const expectedMirror = mirroredBase64(beforeFlip.assets[0].frames[0].pixels, 160, 160);
  await page.getByRole('button', { name: /^현재 프레임 좌우\s*반전$/ }).click();
  const flipped = await save();
  assert.equal(flipped.assets[0].frames[0].pixels, expectedMirror);
  assert.deepEqual(flipped.assets[1], beforeFlip.assets[1], 'frame flip leaves every other animation frame unchanged');
  assert.deepEqual(overlays(flipped), overlays(beforeFlip), 'frame flip does not mirror silhouette editing aids');
  assert.deepEqual(flipped.guides, beforeFlip.guides);
  const flippedBytes = Buffer.from(expectedMirror, 'base64');
  assert.deepEqual(Array.from(flippedBytes.subarray((20 * 160 + 147) * 4, (20 * 160 + 148) * 4)), [201, 19, 91, 128]);
  assert.deepEqual(Array.from(flippedBytes.subarray((20 * 160 + 146) * 4, (20 * 160 + 147) * 4)), [7, 99, 13, 0]);
  await board(2).locator('.board-heading').click();
  await shortcut('Control+Z'); let acrossBoard = await save(); assert.deepEqual(pixels(acrossBoard), pixels(beforeFlip));
  assert.equal(acrossBoard.activeBoardId, acrossBoard.boards[1].id, 'global undo targets the edited frame without changing active board');
  await shortcut('Control+Alt+Z'); assert.deepEqual(pixels(await save()), pixels(flipped));
  await board(1).locator('.board-heading').click();
  await page.getByRole('button', { name: /^현재 프레임 좌우\s*반전$/ }).click();
  assert.deepEqual(pixels(await save()), pixels(beforeFlip), 'double frame flip is the exact identity');
  await board(2).locator('.board-heading').click(); const maskBefore = await save(), originalMask = maskBefore.boards[1].overlays[0];
  await page.getByRole('button', { name: /^선택한 실루엣 좌우\s*반전$/ }).click();
  const maskAfter = await save(), mirroredMask = maskAfter.boards[1].overlays[0];
  assert.equal(mirroredMask.pixels, mirroredBase64(originalMask.pixels, originalMask.width, originalMask.height));
  assert.deepEqual({ ...mirroredMask, pixels: '' }, { ...originalMask, pixels: '' }, 'silhouette flip preserves position, scale, order, opacity and identity');
  assert.deepEqual(pixels(maskAfter), pixels(maskBefore), 'silhouette flip never changes asset pixels');
  assert.deepEqual(maskAfter.guides, maskBefore.guides);
  await board(1).locator('.board-heading').click();
  await shortcut('Control+Z'); assert.deepEqual(overlays(await save()), overlays(maskBefore));
  await shortcut('Control+Alt+Z'); assert.deepEqual(overlays(await save()), overlays(maskAfter));
  await board(2).locator('.board-heading').click();
  await page.getByRole('button', { name: /^선택한 실루엣 좌우\s*반전$/ }).click();
  assert.deepEqual(overlays(await save()), overlays(maskBefore), 'double silhouette flip is the exact identity');
  await page.screenshot({ path: path.join(artifacts, 'shortcuts-history.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: focused-toolbar Space pan for all9 tools, CtrlZ/CtrlAltZ mixed timeline, native input undo, guide/silhouette history, fractional corner snapping and clean pixels.');
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'shortcuts-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally { await context.close(); await browser.close(); }
