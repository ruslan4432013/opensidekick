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
chrome.scripting.executeScript = async () => [];
assert.match((await run('return 1')).error, /No result/);
chrome.scripting.executeScript = async () => { throw new Error("restricted"); };
assert.match((await run('return 1')).error, /Could not run JavaScript here: restricted/);
console.log("PASS JavaScript sync compatibility, async results, concurrency, serialization and errors");
