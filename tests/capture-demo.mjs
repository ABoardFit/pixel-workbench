// Optional local demo capture. The selected artwork is never copied into the app.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const source = process.env.TEST_GIF_PATH;
assert.ok(source, 'Set TEST_GIF_PATH to a local eight-direction GIF for this optional capture.');
const output = path.resolve(import.meta.dirname, '..', '.test-results', 'workbench-demo.png');
await fs.mkdir(path.dirname(output), { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const board = (number) => page.getByRole('article', { name: `${number}번 비교 칸`, exact: true });
try {
  await page.goto(process.env.TEST_URL || 'http://127.0.0.1:5174/');
  await page.getByRole('heading', { name: '도트 작업실', exact: true }).waitFor();
  await page.getByLabel('PNG 또는 GIF 파일 선택').setInputFiles(source);
  await page.getByRole('button', { name: '5번 프레임을 옆에 고정', exact: true }).waitFor();
  await page.getByRole('button', { name: '5번 프레임을 옆에 고정', exact: true }).click();
  await board(1).locator('.board-heading').click();
  await page.getByRole('button', { name: '현재 프레임 잡기', exact: true }).click();
  await board(2).locator('.board-heading').click();
  await page.getByRole('button', { name: '이 칸에 실루엣 추가', exact: true }).click();
  const opacity = page.getByLabel('실루엣 불투명도');
  await opacity.focus(); await opacity.press('Home');
  for (let step = 0; step < 30; step++) await opacity.press('ArrowRight');
  await page.getByLabel('실루엣 앞뒤 순서').selectOption('front');
  await page.getByLabel('색상 HEX').fill('#e53986');
  await page.getByRole('button', { name: '룰러(자) (R)', exact: true }).click();
  const firstCanvas = page.locator('canvas[data-testid^="board-canvas-"]').first();
  const bounds = await firstCanvas.boundingBox(), nativeWidth = await firstCanvas.evaluate((node) => node.width), zoom = bounds.width / nativeWidth;
  await page.mouse.move(bounds.x + 20 * zoom, bounds.y + 70 * zoom); await page.mouse.down();
  await page.mouse.move(bounds.x + 300 * zoom, bounds.y + 70 * zoom, { steps: 10 }); await page.mouse.up();
  await page.locator('[data-testid^="ruler-guide-"]').first().waitFor();
  assert.equal(await page.locator('[data-testid^="ruler-guide-"]').first().getAttribute('stroke'), '#e53986');
  await board(2).locator('.board-heading').click();
  const dismiss = page.getByRole('button', { name: '알림 닫기', exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
  await page.waitForFunction(() => [...document.querySelectorAll('canvas[data-testid^="board-canvas-"]')].length === 2 && [...document.querySelectorAll('canvas[data-testid^="board-canvas-"]')].every((node) => {
    const viewport = document.querySelector('[data-testid="joined-viewport"]').getBoundingClientRect(), canvas = node.getBoundingClientRect();
    return canvas.left >= viewport.left && canvas.right <= viewport.right && canvas.top >= viewport.top && canvas.bottom <= viewport.bottom;
  }));
  assert.equal(await board(1).getByLabel('1번 칸 프레임 이동').inputValue(), '0');
  assert.equal(await board(2).getByLabel('2번 칸 프레임 이동').inputValue(), '4');
  assert.equal(await opacity.inputValue(), '30');
  await page.screenshot({ path: output, fullPage: true });
  console.log(`Captured optional local demo: ${output}`);
} finally {
  await context.close();
  await browser.close();
}
