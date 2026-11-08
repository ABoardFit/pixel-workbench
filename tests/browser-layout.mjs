import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { encode } from 'fast-png';

const root = path.resolve(import.meta.dirname, '..');
const artifacts = path.join(root, '.test-results');
const baseURL = process.env.TEST_URL || 'http://127.0.0.1:5174/';
await fs.mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
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
const board = (number) => page.getByRole('article', { name: `${number}번 비교 칸`, exact: true });
const canvas = (number) => page.locator('canvas[data-testid^="board-canvas-"]').nth(number - 1);
async function fits(count) {
  await page.waitForFunction((count) => {
    const canvases = [...document.querySelectorAll('canvas[data-testid^="board-canvas-"]')];
    const viewport = document.querySelector('[data-testid="joined-viewport"]').getBoundingClientRect();
    return canvases.length === count && canvases.every((node, index) => {
      const canvas = node.getBoundingClientRect();
      if (index && Math.abs(canvases[index - 1].getBoundingClientRect().right - canvas.left) > 1) return false;
      return canvas.left >= viewport.left && canvas.right <= viewport.right && canvas.top >= viewport.top && canvas.bottom <= viewport.bottom;
    });
  }, count, { timeout: 5000 });
  return Promise.all(Array.from({ length: count }, (_, index) => canvas(index + 1).boundingBox()));
}

try {
  await page.goto(baseURL);
  await page.getByRole('heading', { name: '도트 작업실', exact: true }).waitFor();
  const data = new Uint8Array(160 * 160 * 4);
  for (let y = 0; y < 160; y++) for (let x = 0; x < 160; x++) {
    // Visible colored border makes any clipping apparent in the evidence image.
    if (x < 2 || y < 2 || x >= 158 || y >= 158 || (x >= 60 && x < 100)) data.set([43, 113, 221, 255], (y * 160 + x) * 4);
  }
  await page.getByLabel('PNG 또는 GIF 파일 선택').setInputFiles({ name: 'qa-160-layout.png', mimeType: 'image/png', buffer: Buffer.from(encode({ width: 160, height: 160, channels: 4, depth: 8, data })) });
  await page.waitForFunction(() => document.querySelector('canvas[data-testid^="board-canvas-"]')?.getBoundingClientRect().width > 160);
  // Ensure adding a second pane really requires a smaller shared scale.
  await page.getByLabel('공통 확대 (%)').fill('300');
  await page.waitForFunction(() => document.querySelector('canvas[data-testid^="board-canvas-"]').getBoundingClientRect().width === 480);
  const [single] = await fits(1);
  await board(1).getByRole('button', { name: '옆에 고정', exact: true }).click();
  const pair = await fits(2);
  console.log(`Layout widths: single=${single.width}, pair=${pair.map((box) => box.width).join('/')}`);
  assert.ok(single.width > pair[0].width, 'old pane must refit to the narrower two-pane layout');
  assert.equal(pair[0].width, pair[1].width, 'matching 160px images start at matching comparison scales');
  await page.screenshot({ path: path.join(artifacts, 'layout-two-panes.png'), fullPage: true });

  await page.getByTestId('joined-viewport').hover();
  await page.mouse.wheel(0, -100);
  await page.waitForFunction((width) => document.querySelector('canvas[data-testid^="board-canvas-"]').getBoundingClientRect().width > width, pair[0].width);
  assert.equal((await canvas(2).boundingBox()).width, (await canvas(1).boundingBox()).width, 'zoom stays shared across the continuous strip');

  await board(2).getByRole('button', { name: '2번 칸 닫기', exact: true }).click();
  const [reopened] = await fits(1);
  assert.ok(reopened.width > pair[0].width, 'closing a pane refits the remaining pane to available space');
  await board(1).getByRole('button', { name: '복제해 편집', exact: true }).click();
  const copies = await fits(2);
  assert.equal(copies[0].width, copies[1].width, 'independent duplicate also refits all comparison panes');
  assert.deepEqual(errors, []);
  console.log('PASS: touching 160px images refit after pin, close and independent duplicate; pan/zoom belongs to the shared strip.');
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'layout-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await context.close();
  await browser.close();
}
