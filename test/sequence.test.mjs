import assert from 'node:assert/strict';
import { runSequence, validateSequence, TOOL_DEFS } from '../src/background/tools.js';
const actions = [0, 1, 2].map(ref => ({ name: 'click_element', args: { ref } }));
assert.equal(validateSequence({ actions }), null);
for (const bad of [[], Array(21).fill(actions[0]), [{ name: 'browser_sequence', args: {} }], [{ name: 'run_javascript', args: { code: '1' } }], [{ name: 'type_text', args: { ref: 1 } }], [{ name: 'click_element', args: { ref: '1' } }]]) {
  assert(validateSequence({ actions: bad }));
}
assert(validateSequence({ actions: [{ name: 'insert_text', args: { text: 'x' } }] }, TOOL_DEFS.filter(t => !t.cdpOnly)));
const original = { ok: true, token: 'doc', url: 'https://test/', tabId: 1, active: true };
for (const mode of ['success', 'denied', 'stop', 'steering', 'navigation', 'tab', 'replacement', 'exception']) {
  let current = { ...original }, interrupted = false, calls = 0;
  const result = await runSequence({ actions }, {
    state: async () => current, interrupted: () => interrupted, progress: () => {},
    perform: async () => {
      calls++;
      if (calls === 2 && mode === 'denied') return { ok: false, error: 'Permission denied' };
      if (calls === 2 && mode === 'exception') throw new Error('lost connection');
      if (calls === 1) {
        if (['stop', 'steering'].includes(mode)) interrupted = true;
        if (mode === 'navigation') current = { ...current, url: 'https://test/next' };
        if (mode === 'replacement') current = { ...current, token: 'new' };
        if (mode === 'tab') current = { ...current, active: false };
      }
      return { ok: true };
    },
  });
  if (['denied', 'exception'].includes(mode)) assert.equal(result.results.length, 2);
  assert.equal(result.completed, mode === 'success' ? 3 : 1, mode);
  assert.equal(result.ok, mode === 'success', mode);
  assert.equal(result.stopped_at, mode === 'success' ? null : 1, mode);
  assert.equal(calls, mode === 'success' ? 3 : ['denied', 'exception'].includes(mode) ? 2 : 1, mode);
}
console.log('PASS sequence validation, permission failure, partial execution, Stop, steering, navigation, document and tab changes');

// Cancelling a trusted drag must release the mouse even after partial movement.
const { pointerInput } = await import('../src/background/cdp.js');
const abortDrag = new AbortController();
const mouseEvents = [];
globalThis.chrome = {
  runtime: {},
  debugger: {
    onEvent: { addListener() {} }, onDetach: { addListener() {} },
    attach: (_, __, done) => done(),
    sendCommand: (_, method, params, done) => {
      if (method === 'Input.dispatchMouseEvent') {
        mouseEvents.push(params);
        if (params.type === 'mouseMoved' && params.buttons === 1) abortDrag.abort();
      }
      done({});
    },
  },
};
assert.equal((await pointerInput(41, 'drag', { x: 1, y: 1 }, { x: 50, y: 50 }, {}, abortDrag.signal)).ok, false);
assert.equal(mouseEvents.at(-1).type, 'mouseReleased');
assert.equal(mouseEvents.at(-1).buttons, 0);
console.log('PASS cancellation releases a partially dragged pointer');
