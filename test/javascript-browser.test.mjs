import assert from "node:assert/strict";
import { chromium } from "playwright";
import { executeTool } from "../src/background/tools.js";
import { checkJavascript } from "./javascript-cases.mjs";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route("http://fixture.test/**", route => route.fulfill({
    contentType: "text/html",
    headers: route.request().url().endsWith('/trusted')
      ? { "Content-Security-Policy": "require-trusted-types-for 'script'" } : {},
    body: `<!doctype html><title>JavaScript fixture</title><body><script>
      window.dynamicCodeBlocked = false;
      try { new Function("return 1")(); } catch { window.dynamicCodeBlocked = true; }
      window.addEventListener("run-test-script", async () => {
        window.testResult = await window.injectedTool(window.testCode);
        window.testDone = true;
      });
    </script></body>`,
  }));
  globalThis.chrome = {
    scripting: {
      // Playwright evaluates the actual injected function in the page's main world.
      executeScript: async ({ func, args }) => {
        // Install the function via DevTools, but invoke from a normal page event.
        await page.evaluate(`window.injectedTool = (${func.toString()})`);
        await page.evaluate(code => {
          window.testCode = code;
          window.testDone = false;
          setTimeout(() => window.dispatchEvent(new Event("run-test-script")), 0);
        }, args[0]);
        await page.waitForFunction(() => window.testDone);
        return [{ result: await page.evaluate(() => window.testResult) }];
      },
    },
    tabs: { get: async () => ({ url: page.url() }) },
  };
  const run = code => executeTool("run_javascript", { code }, { getTabId: async () => 1 });
  for (const path of ["plain", "trusted"]) {
    await page.goto(`http://fixture.test/${path}`);
    if (path === "trusted") {
      assert.equal(await page.evaluate(() => window.dynamicCodeBlocked), true, "Trusted Types must block dynamic code before the tool installs its policy");
    }
    await checkJavascript(run);
    const dom = await run('await Promise.resolve(); document.body.innerHTML = "<p>async DOM</p>"; return document.body.textContent');
    assert.equal(dom.result, '"async DOM"');
    if (path === "trusted") assert.equal(await page.evaluate(() => !!trustedTypes.defaultPolicy), true);
    console.log(`PASS browser JavaScript: ${path}`);
  }
} finally {
  await browser.close();
}
