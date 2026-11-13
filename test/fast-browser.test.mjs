import assert from "node:assert/strict";
import { chromium } from "playwright";
import { executeTool, TOOL_DEFS } from "../src/background/tools.js";
import { MSG } from "../src/common/constants.js";
import { MUTATING_TOOLS } from "../src/background/permissions.js";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route("http://fixture.test/**", route => route.fulfill({ body: "<html></html>", contentType: "text/html" }));
  await page.goto("http://fixture.test/");
  await page.setContent('<input id="a"><input id="b"><button id="go">Go</button>');
  await page.evaluate(() => {
    window.chrome = { runtime: { onMessage: { addListener: f => { window.handleMessage = f; } } } };
  });
  await page.addScriptTag({ path: "src/content/content-script.js" });
  globalThis.chrome = {
    tabs: {
      sendMessage: async (_id, msg) => page.evaluate(msg =>
        new Promise(resolve => window.handleMessage(msg, {}, resolve)), msg),
    },
  };
  const controller = new AbortController();
  const ctx = { getTabId: async () => 1, signal: controller.signal };
  const read = () => executeTool("read_page", {}, ctx);
  const initial = await read();
  // Element descriptions use tag names; obtain refs by their document order.
  const refs = initial.elements.slice(0, 2).map(e => e.ref);
  await page.evaluate(() => {
    document.querySelector("#a").addEventListener("input", e => { window.controlledValue = e.target.value; });
  });
  const start = performance.now();
  const result = await executeTool("fill_form", { fields: refs.map((ref, i) => ({ ref, value: String(i) })) }, ctx);
  assert.deepEqual(result.completed, refs);
  assert.equal(await page.evaluate(() => window.controlledValue), "0");
  const fresh = await executeTool("read_page", { settle: true }, ctx);
  assert(fresh.elements[0].ref > initial.elements.at(-1).ref);
  const stale = await executeTool("fill_form", { fields: [{ ref: refs[0], value: "stale" }] }, ctx);
  assert.equal(stale.ok, false);
  const nextRefs = fresh.elements.slice(0, 2).map(e => e.ref);
  await page.evaluate(() => document.querySelector("#a").addEventListener("input", () => document.querySelector("#b")?.remove()));
  const partial = await executeTool("fill_form", { fields: nextRefs.map(ref => ({ ref, value: "next" })) }, ctx);
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.completed, [nextRefs[0]]);
  await page.evaluate(() => {
    document.body.innerHTML = '<input id="a"><input id="b">';
    document.querySelector("#a").addEventListener("input", () => history.pushState({}, "", "/changed"));
  });
  const navigationRefs = (await read()).elements.slice(0, 2).map(e => e.ref);
  const moved = await executeTool("fill_form", { fields: navigationRefs.map(ref => ({ ref, value: "move" })) }, ctx);
  assert.equal(moved.ok, false);
  assert.deepEqual(moved.completed, [navigationRefs[0]]);
  assert.equal(await page.inputValue("#b"), "");
  controller.abort();
  const cancelled = await executeTool("fill_form", { fields: [{ ref: nextRefs[0], value: "cancelled" }] }, ctx);
  assert.equal(cancelled.ok, false);
  assert.equal(await page.inputValue("#a"), "move");
  assert(MUTATING_TOOLS.has("fill_form"));
  assert(TOOL_DEFS.find(t => t.name === "click_element").parameters.properties.include_page);
  console.log("PASS batch fill, native input events, fresh refs, stale refs, partial failure, cancellation");
  console.log("Browser scenario duration:", Math.round(performance.now() - start), "ms");
} finally {
  await browser.close();
}
