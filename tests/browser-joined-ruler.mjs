import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import gifenc from 'gifenc';
import { decode } from 'fast-png';
import { parseGIF, decompressFrames } from 'gifuct-js';

const root = path.resolve(import.meta.dirname, '..');
const { GIFEncoder } = gifenc;
const artifacts = path.join(root, '.test-results');
const baseURL = process.env.TEST_URL || 'http://127.0.0.1:5174/';
await fs.mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
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

const canvases = () => page.locator('canvas[data-testid^="board-canvas-"]');
const board = (number) => page.getByRole('article', { name: `${number}번 비교 칸`, exact: true });
const assetPixels = (project) => project.assets.map((asset) => asset.frames.map((frame) => Buffer.from(frame.pixels, 'base64').toString('hex')));
let serial = 0;
async function download(click, extension) {
  const pending = page.waitForEvent('download'); await click();
  const result = await pending, filename = path.join(artifacts, `joined-${++serial}.${extension}`);
  await result.saveAs(filename); assert.equal(await result.failure(), null);
  return fs.readFile(filename);
}
async function save() { return JSON.parse((await download(() => page.getByRole('button', { name: '편집 상태 저장', exact: true }).click(), 'json')).toString()); }
async function exportImage(type) {
  await page.getByRole('button', { name: '이미지 저장', exact: true }).click();
  assert.equal(await page.getByLabel('비교용 실루엣도 포함').count(), 0, 'raster export cannot opt into baking editing aids');
  await page.locator(`input[name="exportType"][value="${type}"]`).check();
  if (type === 'sheet') await page.getByLabel('한 줄의 프레임 수').fill('2');
  return download(() => page.getByRole('button', { name: '파일 내려받기', exact: true }).click(), type === 'gif' ? 'gif' : 'png');
}
function assertRgba(bytes, width, height, expected, label) {
  const image = decode(bytes);
  assert.deepEqual([image.width, image.height, image.channels], [width, height, 4], label);
  const mismatch = image.data.findIndex((value, index) => value !== expected[index]);
  assert.equal(mismatch, -1, `${label}: first different channel at byte ${mismatch}`);
}
async function ranges(locator, value) { await locator.focus(); await locator.press('Home'); for (let i = 0; i < value; i++) await locator.press('ArrowRight'); }
async function geometry() { return canvases().evaluateAll((nodes) => nodes.map((node) => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, nativeWidth: node.width }; })); }
async function assertSeams(count) {
  await page.waitForFunction((count) => {
    const nodes = [...document.querySelectorAll('canvas[data-testid^="board-canvas-"]')];
    return nodes.length === count && nodes.every((node, i) => !i || Math.abs(nodes[i - 1].getBoundingClientRect().right - node.getBoundingClientRect().left) <= 1);
  }, count);
  const boxes = await geometry();
  for (let i = 1; i < boxes.length; i++) {
    assert.ok(Math.abs(boxes[i - 1].right - boxes[i].left) <= 1, 'actual canvases touch with no hidden card gutters');
    assert.ok(Math.abs(boxes[0].top - boxes[i].top) <= 1, 'native canvas tops share a common world origin');
    assert.ok(Math.abs(boxes[0].width / boxes[0].nativeWidth - boxes[i].width / boxes[i].nativeWidth) < 0.001, 'every canvas uses the same zoom');
  }
  return boxes;
}
async function worldPoint(x, y) { const first = (await geometry())[0], zoom = first.width / first.nativeWidth; return { x: first.left + x * zoom, y: first.top + y * zoom }; }
async function dragWorld(from, to, shift = false) {
  const a = await worldPoint(...from), b = await worldPoint(...to);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
}
async function hairline() {
  const guides = page.locator('[data-testid^="ruler-guide-"]');
  await guides.first().waitFor();
  const strokes = await guides.evaluateAll((nodes) => nodes.map((node) => {
    const style = getComputedStyle(node), matrix = node.getScreenCTM();
    return { css: parseFloat(style.strokeWidth), effective: style.vectorEffect === 'non-scaling-stroke' ? parseFloat(style.strokeWidth) : parseFloat(style.strokeWidth) * Math.hypot(matrix.a, matrix.b), visible: style.visibility !== 'hidden' && style.display !== 'none' };
  }));
  assert.ok(strokes.length > 0 && strokes.every((stroke) => stroke.visible && Math.abs(stroke.effective - 1) < 0.01), 'ruler remains a visible one-CSS-pixel hairline regardless of stage zoom');
}
async function renderedPixel(x, y) {
  const point = await worldPoint(x, y), screenshot = decode(await page.screenshot());
  const offset = (Math.floor(point.y) * screenshot.width + Math.floor(point.x)) * screenshot.channels;
  return [screenshot.data[offset], screenshot.data[offset + 1], screenshot.data[offset + 2], screenshot.channels === 4 ? screenshot.data[offset + 3] : 255];
}
async function alignedGuide(guide) {
  const actual = await page.locator('[data-testid^="ruler-guide-"]').first().evaluate((line) => {
    const point = new DOMPoint(Number(line.getAttribute('x1')), Number(line.getAttribute('y1'))).matrixTransform(line.getScreenCTM());
    return { x: point.x, y: point.y };
  });
  const expected = await worldPoint(guide.x1, guide.y1);
  assert.ok(Math.abs(actual.x - expected.x) <= 1 && Math.abs(actual.y - expected.y) <= 1, 'ruler stays aligned to native pixel boundaries during shared transforms');
}
async function restore(project) {
  await page.getByLabel('작업 파일 선택').setInputFiles({ name: 'qa-view.pixel.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)) });
  await page.waitForFunction(({ zoom, visible }) => {
    const canvas = document.querySelector('canvas[data-testid^="board-canvas-"]');
    return canvas && Math.abs(canvas.getBoundingClientRect().width / canvas.width - zoom) < 0.001 && document.querySelectorAll('[data-testid^="ruler-guide-"]').length === visible;
  }, { zoom: project.joinedView.zoom, visible: project.guides.filter((guide) => guide.visible).length });
}
async function rasterHairline(project, horizontal) {
  for (const zoom of [4, 8]) {
    const view = { zoom, panX: 0, panY: 76 * zoom };
    const guides = project.guides.map((guide) => ({ ...guide, color: '#ff00ff', visible: guide.id === horizontal.id }));
    await restore({ ...project, joinedView: view, guides: guides.map((guide) => ({ ...guide, visible: false })) });
    const hidden = decode(await page.screenshot());
    await restore({ ...project, joinedView: view, guides });
    const visible = decode(await page.screenshot()), point = await worldPoint(164, 4);
    const x = Math.round(point.x), center = Math.round(point.y), changedRows = [];
    for (let y = center - 10; y <= center + 10; y++) {
      const hi = (y * hidden.width + x) * hidden.channels, vi = (y * visible.width + x) * visible.channels;
      if ([0, 1, 2].some((channel) => Math.abs(hidden.data[hi + channel] - visible.data[vi + channel]) > 10)) changedRows.push(y);
    }
    assert.ok(changedRows.length >= 1 && changedRows.length <= 2, `actual screenshot at ${zoom}x must cover only 1–2 CSS pixel rows, got ${changedRows.length}`);
    console.log(`Raster hairline ${zoom}x: ${changedRows.length} changed CSS pixel row(s).`);
    // Isolate the always-visible SVG boundary only for measuring its screen coverage.
    // This never changes application metadata, image pixels, or saved project data.
    const boundaries = page.getByTestId('canvas-boundaries');
    await boundaries.evaluate((node) => { node.style.visibility = 'hidden'; });
    const withoutBoundary = decode(await page.screenshot());
    await boundaries.evaluate((node) => { node.style.removeProperty('visibility'); });
    const seam = await worldPoint(160, 8), sy = Math.round(seam.y), centerX = Math.round(seam.x), changedColumns = [];
    for (let sx = centerX - 10; sx <= centerX + 10; sx++) {
      const bi = (sy * visible.width + sx) * visible.channels, hi = (sy * withoutBoundary.width + sx) * withoutBoundary.channels;
      if ([0, 1, 2].some((channel) => Math.abs(visible.data[bi + channel] - withoutBoundary.data[hi + channel]) > 10)) changedColumns.push(sx);
    }
    assert.ok(changedColumns.length >= 1 && changedColumns.length <= 2, `actual seam boundary at ${zoom}x must cover only 1–2 CSS pixel columns, got ${changedColumns.length}`);
    console.log(`Raster boundary ${zoom}x: ${changedColumns.length} changed CSS pixel column(s).`);
  }
}

try {
  const encoder = GIFEncoder(), palette = [[0, 0, 0], [17, 51, 85], [23, 119, 53]], nativeFrames = [];
  for (let frame = 0; frame < 2; frame++) {
    const indices = new Uint8Array(160 * 160);
    for (let y = 10; y < 150; y++) for (let x = 10 + frame * 10; x < 150 - frame * 10; x++) indices[y * 160 + x] = frame + 1;
    const rgba = new Uint8Array(160 * 160 * 4);
    indices.forEach((index, pixel) => { if (index) rgba.set([...palette[index], 255], pixel * 4); });
    nativeFrames.push(rgba);
    encoder.writeFrame(indices, 160, 160, { palette, transparent: true, transparentIndex: 0, dispose: 2, delay: frame ? 130 : 70, repeat: 0 });
  }
  encoder.finish();
  await page.goto(baseURL);
  await page.getByRole('heading', { name: '도트 작업실', exact: true }).waitFor();
  await page.getByLabel('PNG 또는 GIF 파일 선택').setInputFiles({ name: 'qa-joined-160.gif', mimeType: 'image/gif', buffer: Buffer.from(encoder.bytes()) });
  await canvases().first().waitFor();
  await page.getByRole('button', { name: '2번 프레임을 옆에 고정', exact: true }).click();
  await page.waitForFunction(() => {
    const viewport = document.querySelector('[data-testid="joined-viewport"]').getBoundingClientRect();
    const nodes = [...document.querySelectorAll('canvas[data-testid^="board-canvas-"]')];
    return nodes.length === 2 && nodes.every((node) => { const box = node.getBoundingClientRect(); return box.left >= viewport.left && box.right <= viewport.right; });
  });
  await assertSeams(2);
  assert.equal(await page.getByTestId('canvas-boundary-160').count(), 1, 'one shared seam has exactly one boundary stroke');
  const before = await save();
  assert.deepEqual(before.boards.map((board) => board.frameIndex), [0, 1]);
  await board(1).getByRole('button', { name: '이 칸 재생', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="1번 칸 프레임 이동"]').value === '1');
  assert.equal(await board(2).getByLabel('2번 칸 프레임 이동').inputValue(), '1', 'a pinned frame stays independently frozen during joined playback');
  await board(1).getByRole('button', { name: '이 칸 일시정지', exact: true }).click();
  await ranges(board(1).getByLabel('1번 칸 프레임 이동'), 0);
  await board(2).locator('.board-heading').click();
  const baselines = {};
  for (const type of ['png', 'gif', 'sheet', 'comparison']) baselines[type] = await exportImage(type);
  assertRgba(baselines.png, 160, 160, nativeFrames[1], 'PNG is independent native frame without even default boundary strokes');
  const combined = new Uint8Array(320 * 160 * 4);
  for (let y = 0; y < 160; y++) for (let frame = 0; frame < 2; frame++) combined.set(nativeFrames[frame].subarray(y * 160 * 4, (y + 1) * 160 * 4), (y * 320 + frame * 160) * 4);
  assertRgba(baselines.sheet, 320, 160, combined, 'sheet contains only original frame pixels');
  assertRgba(baselines.comparison, 320, 160, combined, 'comparison contains only original frame pixels');
  const decodedGif = decompressFrames(parseGIF(baselines.gif.buffer.slice(baselines.gif.byteOffset, baselines.gif.byteOffset + baselines.gif.byteLength)), true);
  decodedGif.forEach((frame, index) => assert.equal(Buffer.compare(Buffer.from(frame.patch), Buffer.from(nativeFrames[index])), 0, 'GIF contains only original pixels'));
  assert.deepEqual(decodedGif.map((frame) => frame.delay), [70, 130]);
  assert.equal(await page.getByRole('button', { name: /^((그리기|편집) )?실행 취소$/ }).isEnabled(), false);

  // A boundary-to-boundary guide crosses the physical seam, in global native pixels.
  await page.getByLabel('색상 HEX').fill('#18b377');
  await page.getByRole('button', { name: '룰러(자) (R)', exact: true }).click();
  await dragWorld([150, 30], [170, 46], true);
  await hairline();
  const withGuide = await save();
  assert.deepEqual(assetPixels(withGuide), assetPixels(before), 'ruler creates zero pixel changes in every asset frame');
  assert.equal(withGuide.guides.length, 1);
  assert.equal(await page.getByRole('button', { name: /^((그리기|편집) )?실행 취소$/ }).isEnabled(), true, 'ruler metadata is undoable while all raster buffers stay unchanged');
  const guide = withGuide.guides[0];
  assert.equal(guide.color, '#18b377', 'guide snapshots the currently selected brush RGB');
  assert.equal(await page.locator('[data-testid^="ruler-guide-"]').first().evaluate((line) => getComputedStyle(line).stroke), 'rgb(24, 179, 119)');
  assert.deepEqual([guide.x1, guide.y1], [150, 30]);
  assert.ok([guide.x1, guide.y1, guide.x2, guide.y2].every(Number.isInteger), 'guide endpoints lie on pixel boundaries');
  assert.ok(guide.x2 > 160 && Math.abs(guide.x2 - guide.x1) === Math.abs(guide.y2 - guide.y1), 'Shift guide remains an exact45 diagonal while crossing the seam');
  await alignedGuide(guide);

  const priorWheelWidth = (await geometry())[0].width;
  await page.getByTestId('joined-viewport').hover(); await page.mouse.wheel(0, -100);
  await page.waitForFunction((width) => document.querySelector('canvas[data-testid^="board-canvas-"]').getBoundingClientRect().width > width, priorWheelWidth);
  const beforePan = await assertSeams(2); await hairline(); await alignedGuide(guide);
  await page.getByRole('button', { name: '화면 이동 (P)', exact: true }).click();
  await dragWorld([80, 80], [88, 84]);
  const moved = await assertSeams(2);
  assert.ok(Math.abs(moved[1].left - moved[0].right) <= 1);
  assert.ok(moved[0].left > beforePan[0].left && moved[0].top > beforePan[0].top, 'shared pan visibly moves the whole continuous stage');
  assert.ok(Math.abs((moved[0].left - beforePan[0].left) - (moved[1].left - beforePan[1].left)) < 0.01, 'both images move by the same CSS distance');
  await hairline(); await alignedGuide(guide);

  await board(1).locator('.board-heading').click();
  await page.getByRole('button', { name: '현재 프레임 잡기', exact: true }).click();
  await board(2).locator('.board-heading').click();
  await page.getByRole('button', { name: '이 칸에 실루엣 추가', exact: true }).click();
  await ranges(page.getByLabel('실루엣 불투명도'), 30);
  await page.getByLabel('실루엣 앞뒤 순서').selectOption('front');
  assert.deepEqual(await renderedPixel(190.5, 30.5), [43, 130, 114, 255], '30% front silhouette is visibly composited on screen');
  await page.getByLabel('실루엣 앞뒤 순서').selectOption('back');
  assert.deepEqual(await renderedPixel(190.5, 30.5), [23, 119, 53, 255], 'back silhouette stays behind opaque editable pixels');
  await page.getByLabel('실루엣 앞뒤 순서').selectOption('front');
  await ranges(page.getByLabel('실루엣 불투명도'), 100);
  assert.deepEqual(await renderedPixel(190.5, 30.5), [90, 155, 255, 255], 'opaque front silhouette uses its single chosen color');
  await ranges(page.getByLabel('실루엣 불투명도'), 30);
  const withAids = await save();
  assert.deepEqual(assetPixels(withAids), assetPixels(before), 'shared pan/zoom and silhouette placement never bake pixels');
  assert.equal(withAids.boards[1].overlays.length, 1);
  for (const type of ['png', 'gif', 'sheet', 'comparison']) assert.deepEqual(await exportImage(type), baselines[type], `${type} export always excludes visible ruler and silhouette aids`);
  await page.screenshot({ path: path.join(artifacts, 'joined-ruler-aids.png'), fullPage: true });

  // The ordinary raster line is still a paint action and has one undo step.
  await page.getByLabel('색상 HEX').fill('#abcdef');
  await page.getByRole('button', { name: '직선 (L)', exact: true }).click();
  await dragWorld([30.5, 30.5], [35.5, 34.5], true);
  const painted = await save();
  assert.notDeepEqual(assetPixels(painted), assetPixels(before), 'ordinary dot line edits actual pixels');
  await page.getByRole('button', { name: /^((그리기|편집) )?실행 취소$/ }).click();
  assert.deepEqual(assetPixels(await save()), assetPixels(before), 'dot-line undo restores every native RGBA byte');

  // Layout changes retain the exact physical seam at realistic sprite dimensions.
  await page.getByRole('button', { name: '1번 프레임을 옆에 고정', exact: true }).click();
  await assertSeams(3);
  await board(3).getByRole('button', { name: '3번 칸 닫기', exact: true }).click();
  await assertSeams(2);
  await page.setViewportSize({ width: 1280, height: 850 }); await assertSeams(2);
  await page.setViewportSize({ width: 1600, height: 1000 }); await assertSeams(2);
  await page.getByRole('button', { name: '룰러(자) (R)', exact: true }).click();
  await page.getByLabel('색상 HEX').fill('#e53986');
  await dragWorld([150, 4], [170, 4], true);
  const horizontalProject = await save(), horizontal = horizontalProject.guides.at(-1);
  assert.equal(horizontalProject.guides[0].color, '#18b377', 'changing brush RGB leaves an existing guide color intact');
  assert.equal(horizontal.color, '#e53986', 'the next guide uses the newly selected brush RGB');
  assert.equal(horizontal.y1, 4); assert.equal(horizontal.y2, 4);
  await rasterHairline(horizontalProject, horizontal);
  await restore(horizontalProject);
  await page.getByRole('button', { name: '1번 자 숨기기', exact: true }).click();
  await page.locator(`[data-testid="ruler-guide-${guide.id}"]`).waitFor({ state: 'detached' });
  assert.equal((await save()).guides[0].visible, false, 'hide toggles a guide independently of raster image data');
  await page.getByRole('button', { name: '1번 자 보이기', exact: true }).click();
  await page.locator(`[data-testid="ruler-guide-${guide.id}"]`).waitFor();
  await page.getByRole('button', { name: '1번 자 삭제', exact: true }).click();
  assert.deepEqual((await save()).guides.map((guide) => guide.id), [horizontal.id]);
  await page.getByRole('button', { name: '모든 자 지우기', exact: true }).click();
  assert.equal((await save()).guides.length, 0);
  assert.equal(await page.locator('[data-testid^="ruler-guide-"]').count(), 0);
  assert.equal(await page.getByTestId('canvas-boundary-160').count(), 1, 'clearing guides leaves the base canvas boundary intact');
  assert.deepEqual(assetPixels(await save()), assetPixels(before), 'hairline zoom and visibility tests leave all asset pixels untouched');
  assert.deepEqual(errors, []);
  console.log('PASS: touching 160px canvases, shared view transforms, seam-crossing boundary ruler, 1CSSpx strokes, unbaked aid-free exports and raster line undo.');
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'joined-ruler-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await context.close(); await browser.close();
}
