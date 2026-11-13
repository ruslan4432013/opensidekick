import assert from "node:assert/strict";
import vm from "node:vm";
import { executeTool } from "../src/background/tools.js";
import { checkJavascript } from "./javascript-cases.mjs";

const context = vm.createContext({ window: {} });
globalThis.chrome = {
  scripting: {
    executeScript: async ({ target, world, func, args }) => {
      assert.deepEqual(target, { tabId: 7 });
      assert.equal(world, "MAIN");
      const injected = vm.runInContext(`(${func.toString()})`, context);
      return [{ result: await injected(...args) }];
    },
  },
  tabs: { get: async () => ({ url: "https://fixture.test/" }) },
};
const run = code => executeTool("run_javascript", { code }, { getTabId: async () => 7 });
await checkJavascript(run);
// Simulate navigation after tabs.get but before injection into the page.
context.location = { hostname: "miro.com" };
assert.match((await run('window.clicked = true')).error, /pointer_action/);
assert.equal(context.window.clicked, undefined);
delete context.location;
// An existing Miro URL is rejected before any script injection.
const inject = chrome.scripting.executeScript;
chrome.tabs.get = async () => ({ url: "https://miro.com/app/board/test/" });
chrome.scripting.executeScript = async () => { throw new Error("must not inject"); };
assert.match((await run('window.clicked = true')).error, /pointer_action/);
chrome.tabs.get = async () => ({ url: "https://fixture.test/" });
chrome.scripting.executeScript = inject;
chrome.scripting.executeScript = async () => [];
assert.match((await run('return 1')).error, /No result/);
chrome.scripting.executeScript = async () => { throw new Error("restricted"); };
assert.match((await run('return 1')).error, /Could not run JavaScript here: restricted/);
console.log("PASS JavaScript sync compatibility, async results, concurrency, serialization and errors");
