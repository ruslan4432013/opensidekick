import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { executeTool, documentState, runSequence } from '../src/background/tools.js';
import { recordCall, readActivity } from '../src/background/activity.js';
import { runAgent } from '../src/background/agent.js';
const browser = await chromium.launch({ headless: true });
const fixture = `<!doctype html><style>body{margin:0} #cell{position:absolute;left:80px;top:70px;width:220px;height:50px} #drag{position:absolute;left:80px;top:200px;width:50px;height:50px;background:blue}</style>
<canvas id="board" width="600" height="180" aria-label="Test grid"></canvas><input id="cell" aria-label="Cell" readonly hidden><div id="drag" aria-label="Move shape"></div><input id="other" style="position:absolute;top:300px">
<script>const cell=document.querySelector('#cell');const board=document.querySelector('#board');const paint=board.getContext('2d');paint.strokeRect(80,70,220,50);board.ondblclick=()=>{cell.hidden=false;cell.readOnly=false;cell.focus()};cell.ondblclick=()=>{cell.readOnly=false;cell.focus()};cell.onkeydown=e=>{if(e.key==='Escape'){cell.readOnly=true;cell.blur()}};
const drag=document.querySelector('#drag');let moving=false;drag.onmousedown=()=>moving=true;document.onmousemove=e=>{if(moving){drag.style.left=(e.clientX-25)+'px';drag.style.top=(e.clientY-25)+'px'}};document.onmouseup=()=>moving=false;</script>`;
try {
  for (const [dpr, width] of [[1, 800], [2, 1000]]) {
    const context = await browser.newContext({ viewport: { width, height: 600 }, deviceScaleFactor: dpr });
    const page = await context.newPage();
    await page.route('http://fixture.test/**', r => r.fulfill({ contentType: 'text/html', body: fixture }));
    await page.goto('http://fixture.test/');
    await page.evaluate(() => { window.chrome = { runtime: { onMessage: { addListener: f => window.handleMessage = f } } }; });
    await page.addScriptTag({ path: 'src/content/content-script.js' });
    const session = await context.newCDPSession(page);
    const stored = {};
    globalThis.chrome = {
      storage: { local: { get: async key => ({ [key]: stored[key] }), set: async values => Object.assign(stored, values) } },
      runtime: {},
      tabs: {
        get: async () => ({ id: dpr, active: true, url: page.url(), windowId: 1 }),
        sendMessage: async (_, msg) => page.evaluate(msg => new Promise(resolve => window.handleMessage(msg, {}, resolve)), msg),
        captureVisibleTab: async () => 'data:image/png;base64,' + (await page.screenshot()).toString('base64'),
      },
      debugger: {
        onEvent: { addListener() {} }, onDetach: { addListener() {} },
        attach: (_, __, cb) => cb(),
        sendCommand: (_, method, params, cb) => session.send(method, params).then(cb).catch(error => {
          chrome.runtime.lastError = error; cb(); delete chrome.runtime.lastError;
        }),
      },
    };
    globalThis.createImageBitmap = async blob => {
      const png = Buffer.from(await blob.arrayBuffer());
      return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), close() {} };
    };
    const ctx = { getTabId: async () => dpr, cdpAllowed: true, visionAllowed: true, signal: new AbortController().signal };
    const run = (name, args = {}) => executeTool(name, args, ctx);
    const shot = await run('take_screenshot');
    assert(shot.ok, JSON.stringify(shot));
    assert.equal(shot.width, width * dpr);
    const actions = [
      { name: 'pointer_action', args: { screenshot_id: shot.screenshot_id, action: 'double_click', x: 150 * dpr, y: 90 * dpr } },
      { name: 'insert_text', args: { text: 'Canvas cell' } },
      { name: 'press_keys', args: { keys: ['Escape'] } },
    ];
    const start = performance.now();
    const result = await runSequence({ actions }, { state: () => documentState(ctx), interrupted: () => false, progress() {}, perform: step => run(step.name, step.args) });
    assert(result.ok, JSON.stringify(result));
    assert.equal(await page.inputValue('#cell'), 'Canvas cell');
    assert.equal(await page.$eval('#cell', el => el.readOnly), true);
    console.log(`PASS canvas double click → insert → Escape, DPR ${dpr}, ${shot.width}×${shot.height}; browser-only ${Math.round(performance.now() - start)} ms`);
    const fresh = await run('take_screenshot');
    assert((await run('pointer_action', { screenshot_id: fresh.screenshot_id, action: 'drag', x: 105*dpr, y: 225*dpr, to_x: 305*dpr, to_y: 225*dpr })).ok);
    assert.equal(await page.$eval('#drag', el => el.offsetLeft), 280);
    assert.equal((await run('pointer_action', actions[0].args)).ok, false);
    const beforeMove = await run('take_screenshot');
    await page.$eval('#cell', el => el.style.left = '400px');
    assert.equal((await run('pointer_action', { ...actions[0].args, screenshot_id: beforeMove.screenshot_id })).ok, false);
    assert.equal((await executeTool('pointer_action', actions[0].args, { ...ctx, visionAllowed: false })).ok, false);

    // Pointer input must not open a permission card for canvas targets or sensitive
    // labels, whether the action is standalone or a sequence step.
    for (const [mode, label, sequence] of [
      ['auto', '', false], ['auto', 'Buy now', false], ['auto', '', true],
      ['auto', 'Buy now', true], ['ask', '', false], ['ask', 'Buy now', true], ['plan', '', false], ['plan', 'Buy now', true],
    ]) {
      await page.evaluate(label => {
        const target = document.createElement('div');
        target.id = 'pointer-fixture'; target.textContent = label;
        target.style.cssText = 'position:fixed;left:450px;top:400px;width:150px;height:50px;background:gray';
        window.pointerClicks = 0; target.onclick = () => window.pointerClicks++;
        document.body.append(target);
      }, label);
      const history = [{ role: 'user', content: 'Click the test target' }];
      let modelCalls = 0, permissionCalls = 0;
      globalThis.fetch = async () => {
        let call;
        if (modelCalls === 0) call = { name: 'take_screenshot', args: {} };
        else if (modelCalls === 1) {
          const shot = JSON.parse(history.find(m => m.role === 'tool' && m.name === 'take_screenshot').content);
          assert(shot.screenshot_id, JSON.stringify(shot));
          const step = { name: 'pointer_action', args: { screenshot_id: shot.screenshot_id, action: 'click', x: 480*dpr, y: 420*dpr } };
          call = sequence ? { name: 'browser_sequence', args: { actions: [step] } } : step;
        } else { assert.equal(modelCalls, 2); call = { name: 'finish', args: { summary: 'Done' } }; }
        modelCalls++;
        return new Response('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'pointer'+modelCalls, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] }) + '\n\ndata: [DONE]\n\n');
      };
      await runAgent({ conversation: history, initialTabId: dpr, signal: new AbortController().signal,
        config: { activeModel: 'fixture', settings: { autonomy: mode, siteAccess: 'all', enableCdp: true, enableVision: true }, sitePermissions: {} },
        provider: { name: 'Fixture', baseUrl: 'http://fixture.invalid/v1', type: 'openai' },
        emit() {}, requestPermission: async () => { permissionCalls++; return 'decline'; },
      });
      assert.equal(permissionCalls, 0, `${mode}: ${label}, sequence=${sequence}`);
      assert.equal(await page.evaluate(() => window.pointerClicks), 1);
      await page.locator('#pointer-fixture').evaluate(el => el.remove());
    }
    console.log('PASS pointer without prompts in Auto/Ask/Plan, sensitive/unlabelled targets and sequence parity');

    // Exercise the real agent loop and its permission gate with a deterministic
    // local model response, including navigation while approval is pending.
    await page.$eval('#cell', el => { el.readOnly = false; el.style.left = '80px'; el.value = ''; });
    async function agentScenario(mode, sequence = true) {
      await page.evaluate(() => history.replaceState({}, '', '/'));
      await page.$eval('#cell', el => { el.value = ''; el.readOnly = false; });
      const refs = (await run('read_page')).elements;
      const ref = refs.find(e => e.name === 'Cell').ref;
      const steps = [{ name: 'type_text', args: { ref, text: 'Agent value' } }, { name: 'press_keys', args: { keys: ['Escape'] } }];
      if (mode === 'deny_second') {
        const buttonRef = refs.find(e => e.name === 'Buy now').ref;
        steps[1] = { name: 'click_element', args: { ref: buttonRef } };
      }
      if (!sequence) steps.at(-1).args.include_page = true;
      const queue = sequence ? [{ name: 'browser_sequence', args: { actions: steps } }] : steps;
      queue.push({ name: 'finish', args: { summary: 'Done' } });
      let calls = 0, prompts = 0;
      const events = [], conversation = [{ role: 'user', content: 'Fill the test cell' }];
      const steering = [];
      const abort = new AbortController();
      globalThis.fetch = async () => {
        const call = queue[calls++];
        assert(call, 'Unexpected model request');
        return new Response('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call'+calls, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] }) + '\n\ndata: [DONE]\n\n');
      };
      const started = performance.now();
      await runAgent({ conversation, initialTabId: dpr, signal: abort.signal, steering,
        config: { activeModel: 'fixture', settings: { autonomy: ['success', 'deny_second'].includes(mode) ? 'auto' : 'ask', siteAccess: 'all', enableCdp: true, enableVision: true }, sitePermissions: {} },
        provider: { name: 'Fixture', baseUrl: 'http://fixture.invalid/v1', type: 'openai' },
        emit: e => { events.push(e); if(e.kind === 'sequence_progress' && e.completed === 1) { if(mode === 'stop') abort.abort(); if(mode === 'steering') steering.push('Stop editing'); } },
        requestPermission: async () => { prompts++; if(mode === 'navigate') await page.evaluate(() => history.pushState({}, '', '/changed')); return ['deny', 'deny_second'].includes(mode) ? 'decline' : 'once'; },
      });
      const output = conversation.find(m => m.role === 'tool' && m.name === 'browser_sequence');
      const result = output && JSON.parse(output.content);
      if (mode === 'deny' || mode === 'navigate') {
        assert.equal(await page.inputValue('#cell'), ''); assert.equal(result.completed, 0); assert(prompts);
      } else {
        assert.equal(await page.inputValue('#cell'), 'Agent value');
        if (sequence) assert.equal(result.completed, ['stop','steering','deny_second'].includes(mode) ? 1 : 2);
      }
      if(sequence && mode === 'success') { assert(result.page?.ok); assert(events.some(e=>e.kind==='sequence_progress' && e.completed===2)); }
      return { calls, ms: Math.round(performance.now()-started) };
    }
    const single = await agentScenario('success', false);
    const batched = await agentScenario('success');
    assert.equal(single.calls, 3); assert.equal(batched.calls, 2);
    for (const mode of ['deny', 'navigate', 'stop', 'steering']) await agentScenario(mode);
    console.log(`PASS real agent permissions, navigation during approval, Stop, steering, final observation; fixture model calls ${single.calls} → ${batched.calls}; elapsed ${single.ms} → ${batched.ms} ms (no model latency)`);
    await page.evaluate(() => {
      const button = document.createElement('button'); button.textContent = 'Buy now';
      button.onclick = () => window.bought = true;
      document.body.append(button);
    });
    await agentScenario('deny_second');
    assert.equal(await page.evaluate(() => !!window.bought), false);
    await page.evaluate(() => {
      for(let i=0; i<150; i++) {
        const button=document.createElement('button'); button.textContent='Long label '.repeat(20)+i; document.body.append(button);
      }
    });
    const large = await agentScenario('success');
    assert.equal(large.calls, 2);
    await recordCall({ kind: 'test:flush' , ms: 0 });
    const activity = await readActivity();
    assert(activity.some(row => row.kind === 'browser' && row.tool === 'type_text' && Number.isFinite(row.ms)));
    assert(activity.some(row => row.kind === 'browser' && row.tool === 'read_page'));
    assert(activity.some(row => row.kind === 'chat'));
    assert.equal(JSON.stringify(activity).includes('Agent value'), false);
    // A replaced field must never inherit the old ref, even at the same position.
    await page.evaluate(() => {
      document.body.innerHTML = '<input id="a"><input id="b">';
      document.querySelector('#a').oninput = () => { document.querySelector('#b').outerHTML = '<input id="b">'; };
    });
    const fields = (await run('read_page')).elements.slice(0, 2).map(e => e.ref);
    const fieldSteps = fields.map(ref => ({ name: 'type_text', args: { ref, text: 'updated' } }));
    const partial = await runSequence({ actions: fieldSteps }, { state: () => documentState(ctx), interrupted: () => false, progress() {}, perform: step => run(step.name, step.args) });
    assert.equal(partial.completed, 1); assert.equal(partial.ok, false);
    assert.equal(await page.inputValue('#b'), '');
    await run('read_page');
    assert.equal((await run('type_text', fieldSteps[0].args)).ok, false);
    if (dpr === 2) {
      chrome.tabs.captureVisibleTab = async () => 'data:image/png;base64,' + (await page.screenshot({ scale: 'css' })).toString('base64');
      const resized = await run('take_screenshot');
      assert.equal(resized.width, width);
      const box = await page.locator('#b').boundingBox();
      assert((await run('pointer_action', { screenshot_id: resized.screenshot_id, action: 'click', x: box.x + 10, y: box.y + 10 })).ok);
      assert((await run('insert_text', { text: 'scaled' })).ok);
      assert.equal(await page.inputValue('#b'), 'scaled');
    }
    await page.evaluate(() => document.body.style.minHeight = '2000px');
    const scrollShot = await run('take_screenshot');
    assert(scrollShot.ok);
    assert((await run('pointer_action', { screenshot_id: scrollShot.screenshot_id, action: 'scroll', x: 500 * (scrollShot.width / width), y: 400 * (scrollShot.height / 600), delta_y: 200 })).ok);
    await page.waitForFunction(() => scrollY > 0);
    assert.equal((await run('pointer_action', { screenshot_id: scrollShot.screenshot_id, action: 'click', x: 10, y: 10 })).ok, false);
    console.log('PASS replaced field, stale ref, screenshot coordinate scaling and trusted scrolling');
    // Miro-host fixture exercises routing in the real agent, not just the
    // coordinate helper. Record actual trusted event positions in the page.
    await page.route('https://miro.com/**', r => r.fulfill({ contentType: 'text/html', body: fixture }));
    for (const [zoom, imageScale] of [[1, 'device'], [0.8, 'css']]) {
      await page.goto('https://miro.com/app/board/coordinate-fixture/');
      await page.evaluate(zoom => {
        document.body.style.zoom = zoom;
        window.chrome = { runtime: { onMessage: { addListener: f => window.handleMessage = f } } };
        window.pointerPositions = [];
        const status = document.createElement('div'); status.id = 'animated-status'; status.style.cssText = 'position:fixed;left:500px;top:450px;width:10px;height:10px'; document.body.append(status);
        document.addEventListener('dblclick', e => window.pointerPositions.push({ x: e.clientX, y: e.clientY, trusted: e.isTrusted }), true);
      }, zoom);
      await page.addScriptTag({ path: 'src/content/content-script.js' });
      chrome.tabs.captureVisibleTab = async () => {
        await page.locator('#animated-status').evaluate(el => el.style.width = (parseInt(el.style.width) + 1) + 'px');
        return 'data:image/png;base64,' + (await page.screenshot({ scale: imageScale })).toString('base64');
      };
      const history = [{ role: 'user', content: 'Edit the first Miro cell' }];
      let calls = 0;
      globalThis.fetch = async (_, options) => {
        const request = JSON.parse(options.body);
        assert(!request.tools.some(t => t.function.name === 'run_javascript'));
        assert(request.tools.some(t => t.function.name === 'pointer_action'));
        assert(request.messages[0].content.includes('On Miro'));
        const screenshot = history.find(m => m.role === 'tool' && m.name === 'take_screenshot');
        const shot = screenshot && JSON.parse(screenshot.content);
        const click = shot && { screenshot_id: shot.screenshot_id, action: 'double_click', x: 150 * zoom * shot.width / width, y: 90 * zoom * shot.height / 600 };
        const steps = [
          { name: 'run_javascript', args: { code: 'window.syntheticClick = true' } },
          { name: 'take_screenshot', args: {} },
          { name: 'browser_sequence', args: { actions: [
            { name: 'pointer_action', args: click },
            { name: 'insert_text', args: { text: 'Miro coordinate test' } },
            { name: 'press_keys', args: { keys: ['Escape'] } },
          ] } },
          { name: 'take_screenshot', args: {} },
          { name: 'finish', args: { summary: 'Verified' } },
        ];
        const call = steps[calls++]; assert(call);
        return new Response('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'miro'+calls, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] }) + '\n\ndata: [DONE]\n\n');
      };
      await runAgent({ conversation: history, initialTabId: dpr, signal: new AbortController().signal,
        config: { activeModel: 'fixture', settings: { autonomy: 'auto', siteAccess: 'all', enableJsTool: true, enableCdp: true, enableVision: true }, sitePermissions: {} },
        provider: { name: 'Fixture', baseUrl: 'http://fixture.invalid/v1', type: 'openai' }, emit() {},
        requestPermission: async () => { throw new Error('Unexpected permission prompt'); },
      });
      assert.equal(JSON.parse(history.find(m => m.name === 'run_javascript' && m.role === 'tool').content).ok, false);
      assert.equal(await page.evaluate(() => !!window.syntheticClick), false);
      const result = JSON.parse(history.find(m => m.name === 'browser_sequence' && m.role === 'tool').content);
      assert(result.ok, JSON.stringify(result));
      assert.equal(await page.inputValue('#cell'), 'Miro coordinate test');
      assert.equal(await page.$eval('#cell', el => el.readOnly), true);
      const [actual] = await page.evaluate(() => window.pointerPositions);
      assert(actual.trusted);
      assert(Math.abs(actual.x - 150*zoom) <= 1 && Math.abs(actual.y - 90*zoom) <= 1);
      const denied = await run('run_javascript', { code: 'window.syntheticClick = true' });
      assert.equal(denied.ok, false);
      console.log(`PASS Miro routing and actual trusted double click: DPR=${dpr}, zoom=${zoom}, image=${imageScale}, expected=(${150*zoom},${90*zoom}), actual=(${actual.x},${actual.y}); correct cell edited`);
    }
    await context.close();
  }
} finally { await browser.close(); }
