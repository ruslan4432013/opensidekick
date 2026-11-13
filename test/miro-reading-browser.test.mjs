import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { executeTool } from '../src/background/tools.js';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.route('https://miro.com/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="a11y-dom-root"><button id="a11y-dom-explore" aria-expanded="false">Enhance accessibility support</button><div id="a11y-dom-contents" style="position:absolute;left:-10000px;top:0"></div></div><div id="panel" style="position:absolute;left:20px;top:50px;width:200px;height:200px;overflow:auto"><div style="height:2000px">Frames</div></div><canvas id="canvas" width="400" height="400" style="position:absolute;left:300px;top:50px"></canvas>' }));
  await page.goto('https://miro.com/app/board/fixture/');
  await page.evaluate(() => {
    window.chrome = { runtime: { onMessage: { addListener: f => window.handleMessage = f } } };
    window.expansions = 0;
    document.querySelector('#a11y-dom-explore').onclick = event => {
      window.expansions++;
      const toggle = event.target;
      setTimeout(() => {
      toggle.setAttribute('aria-expanded', 'true');
      const root = document.querySelector('#a11y-dom-contents');
      for (let i = 1; i <= 176; i++) {
        const object = document.createElement('div');
        object.id = 'a11y-dom-' + i;
        object.style.cssText = 'left:100px;top:200px';
        object.setAttribute('aria-label', 'Object ' + i + ' ' + 'текст '.repeat(100) + ', Text, ' + i + ' of 176');
        root.append(object);
      }
      const nested = document.createElement('div');
      nested.id = 'a11y-dom-999';
      nested.setAttribute('aria-label', 'Nested last object, Text, 1 of 1');
      root.lastChild.append(nested);
      }, 180);
    };
    const canvas = document.querySelector('#canvas');
    let pan = false, last;
    canvas.onmousedown = e => { pan = e.button === 1; last = e.clientX; e.preventDefault(); };
    canvas.onmousemove = e => {
      if (pan && e.buttons === 4) {
        const root = document.querySelector('#a11y-dom-contents');
        root.style.left = (parseFloat(root.style.left) + e.clientX - last) + 'px';
        last = e.clientX;
      }
    };
    canvas.onmouseup = () => { pan = false; };
  });
  await page.addScriptTag({ path: 'src/content/content-script.js' });
  const session = await page.context().newCDPSession(page);
  globalThis.chrome = {
    runtime: {},
    tabs: {
      get: async () => ({ id: 700, active: true, windowId: 1, url: page.url() }),
      sendMessage: async (_, msg) => page.evaluate(msg => new Promise(resolve => window.handleMessage(msg, {}, resolve)), msg),
      captureVisibleTab: async () => 'data:image/png;base64,' + (await page.screenshot()).toString('base64'),
    },
    debugger: {
      onEvent: { addListener() {} }, onDetach: { addListener() {} }, attach: (_, __, cb) => cb(),
      sendCommand: (_, method, params, cb) => session.send(method, params).then(cb),
    },
  };
  globalThis.createImageBitmap = async blob => {
    const png = Buffer.from(await blob.arrayBuffer());
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), close() {} };
  };
  const ctx = { getTabId: async () => 700, cdpAllowed: true, visionAllowed: true, signal: new AbortController().signal };
  const run = (name, args = {}) => executeTool(name, args, ctx);
  let part = await run('get_page_text', { offset: 0 });
  assert(part.ok, JSON.stringify(part));
  assert.equal(part.top_level_objects, 176);
  assert.equal(part.objects_including_children, 177);
  assert.equal(part.outline_complete, true);
  const first = part, chunks = [part.text];
  const repeat = await run('get_page_text', { snapshot_id: part.snapshot_id, offset: 0 });
  assert.equal(repeat.repeated, true);
  assert.equal(repeat.text, '');
  assert.equal(repeat.next_unread_offset, 20000);
  assert.equal((await run('get_page_text', { offset: 0 })).repeated, true);
  const reread = await run('get_page_text', { snapshot_id: first.snapshot_id, offset: 0, reread: true });
  assert.equal(reread.replayed, true);
  assert.equal(reread.text, first.text);
  assert.equal((await run('get_page_text', { snapshot_id: first.snapshot_id, offset: 0, reread: true })).text, '');
  while (part.next_offset !== null) {
    part = await run('get_page_text', { snapshot_id: part.snapshot_id, offset: part.next_offset });
    assert(part.ok, JSON.stringify(part));
    chunks.push(part.text);
  }
  assert.equal(part.all_text_delivered, true);
  assert.equal(chunks.join('').length, part.total_chars);
  assert(chunks.join('').includes('Nested last object'));
  assert.equal(await page.evaluate(() => window.expansions), 1);
  const gapCtx = { ...ctx };
  const gapFirst = await executeTool('get_page_text', { offset: 0 }, gapCtx);
  const gapId = gapFirst.snapshot_id;
  let gap = await executeTool('get_page_text', { snapshot_id: gapId, offset: 40000 }, gapCtx);
  assert.equal(gap.next_unread_offset, 20000);
  assert.equal(gap.all_text_delivered, false);
  gap = await executeTool('get_page_text', { snapshot_id: gapId, offset: 20000 }, gapCtx);
  assert.equal(gap.next_unread_offset, 60000);
  await page.$eval('#a11y-dom-176', el => el.setAttribute('aria-label', 'Changed, Frame, 176 of 176'));
  assert.equal((await run('get_page_text', { snapshot_id: first.snapshot_id, offset: 20000 })).ok, false);
  await page.$eval('#a11y-dom-175', el => el.remove());
  const incomplete = await run('get_page_text', { offset: 0 });
  assert.equal(incomplete.outline_complete, false);
  assert.deepEqual(incomplete.missing_groups, [{ parent: 'board', loaded: 175, expected: 176 }]);
  assert.equal((await run('get_page_text', { offset: -1 })).ok, false);
  const freshSession = await executeTool('get_page_text', { offset: 0 }, { ...ctx });
  assert.equal(freshSession.repeated, false);
  assert.notEqual(freshSession.snapshot_id, incomplete.snapshot_id);
  console.log('PASS all 176 offscreen objects and nested contents, pagination, duplicate suppression, stale snapshot and missing coverage');

  const scoped = await run('get_page_text', { object_id: '176', offset: 0 });
  assert.equal(scoped.scope, 'object');
  assert.equal(scoped.selected_objects, 2);
  assert(scoped.text.includes('Nested last object'));
  assert(!scoped.text.includes('Object 1 '));
  assert.equal((await run('get_page_text', { object_id: 'missing' })).ok, false);
  const nestedScope = await run('get_page_text', { snapshot_id: scoped.snapshot_id, object_id: '999', offset: 0 });
  assert.equal(nestedScope.ok, true);
  assert.equal(nestedScope.snapshot_id, scoped.snapshot_id);
  assert.equal(nestedScope.selected_objects, 1);
  const scopedAgain = await run('get_page_text', { snapshot_id: scoped.snapshot_id, object_id: '176', offset: 0, reread: true });
  assert.equal(scopedAgain.text, scoped.text);


  let shot = await run('take_screenshot');
  assert(shot.scroll_regions.some(r => r.max_scroll_top > 1000 && r.x === 120));
  let result = await run('pointer_action', { screenshot_id: shot.screenshot_id, action: 'scroll', x: 100, y: 100, delta_y: 300 });
  assert.equal(result.changed, true);
  assert((await page.$eval('#panel', el => el.scrollTop)) > 0);
  shot = await run('take_screenshot');
  const before = await page.$eval('#a11y-dom-contents', el => parseFloat(el.style.left));
  result = await run('pointer_action', { screenshot_id: shot.screenshot_id, action: 'pan', x: 400, y: 150, to_x: 500, to_y: 150 });
  assert.equal(result.changed, true);
  assert.equal(await page.$eval('#a11y-dom-contents', el => parseFloat(el.style.left)), before + 100);
  await page.$eval('#canvas', el => { el.onmousemove = null; });
  shot = await run('take_screenshot');
  result = await run('pointer_action', { screenshot_id: shot.screenshot_id, action: 'pan', x: 400, y: 150, to_x: 500, to_y: 150 });
  assert.equal(result.changed, null, 'unchanged outline cannot disprove canvas movement');
  assert.match(result.note, /Verify a fresh screenshot/);
  for (let i = 0; i < 3; i++) {
    shot = await run('take_screenshot');
    result = await run('pointer_action', { screenshot_id: shot.screenshot_id, action: 'scroll', x: 400, y: 150, delta_y: 100 });
    assert.equal(result.changed, false);
  }
  shot = await run('take_screenshot');
  result = await run('pointer_action', { screenshot_id: shot.screenshot_id, action: 'scroll', x: 400, y: 150, delta_y: 100 });
  assert.equal(result.ok, false);
  assert.match(result.error, /three attempts/);
  console.log('PASS targeted panel scrolling, middle-button canvas panning, actual movement and bounded no-progress navigation');

  const addVisual = () => {
    const root = document.getElementById('a11y-dom-contents');
    document.getElementById('a11y-dom-explore').setAttribute('aria-expanded', 'true');
    root.innerHTML = '<div id="a11y-dom-10001" aria-label="Empty, Grid, 1 of 1" style="width:400px;height:200px">Empty</div>';
    window.chrome = { runtime: { onMessage: { addListener: f => window.handleMessage = f } } };
  };
  await page.evaluate(addVisual);
  await page.addScriptTag({ path: 'src/content/content-script.js' });
  const inventory = await run('list_miro_objects');
  assert.equal(inventory.objects[0].type, 'Grid');
  assert.equal(inventory.objects[0].object_id, '10001');
  assert.equal((await run('inspect_miro_object', { object_id: '../evil' })).ok, false);
  assert.equal((await run('inspect_miro_object', { object_id: '88888' })).ok, false);
  assert.equal((await executeTool('inspect_miro_object', { object_id: '10001' }, { ...ctx, visionAllowed: false })).ok, false);
  let navigations = 0;
  chrome.tabs.update = async (_, options) => {
    navigations++;
    await page.goto(options.url);
    await page.evaluate(addVisual);
    await page.addScriptTag({ content: await readFile('src/content/content-script.js', 'utf8') });
  };
  chrome.tabs.onUpdated = { addListener() {}, removeListener() {} };
  chrome.tabs.get = async () => ({ id: 700, active: true, windowId: 1, url: page.url(), status: 'complete' });
  await page.evaluate(() => { const input = document.createElement('textarea'); document.body.append(input); input.focus(); });
  assert.match((await run('inspect_miro_object', { object_id: '10001' })).error, /Finish the focused editor/);
  assert.equal(navigations, 0);
  await page.evaluate(() => document.activeElement.blur());
  result = await run('inspect_miro_object', { object_id: '10001' });
  assert(result.ok, JSON.stringify(result));
  assert.equal(navigations, 1);
  assert.equal(new URL(page.url()).searchParams.get('moveToWidget'), '10001');
  assert.equal(result.object.object_id, '10001');
  assert(result.image.data.length > 100 && result.screenshot_id);
  assert.equal((await executeTool('inspect_miro_object', { object_id: '10001' }, { ...ctx, signal: AbortSignal.abort() })).ok, false);
  assert.equal(navigations, 1);
  console.log('PASS visual inventory, same-board focused screenshot, invalid IDs, Vision gate, active editor and cancellation');
} finally { await browser.close(); }
