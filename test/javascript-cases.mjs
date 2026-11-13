import assert from "node:assert/strict";

export async function checkJavascript(run) {
  for (const [code, expected] of [
    ['return 42', '42'],
    ['return { value: "sync" }', '{"value":"sync"}'],
    ['', 'undefined'],
    ['return await Promise.resolve("awaited")', '"awaited"'],
    ['return Promise.resolve({ value: "resolved" })', '{"value":"resolved"}'],
    ['return Promise.allSettled([Promise.resolve(1), Promise.reject("failed")])', '[{"status":"fulfilled","value":1},{"status":"rejected","reason":"failed"}]'],
    ['const circular = {}; circular.self = circular; return circular', '[object Object]'],
    ['return "x".repeat(5000)', '"' + 'x'.repeat(3999)],
  ]) {
    const result = await run(code);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result, expected);
    assert.equal(typeof result.url, "string");
  }
  // Resolve the first operation only once the second has started: no timing assertions.
  const concurrent = await run(`
    let release;
    const first = new Promise(resolve => { release = resolve; });
    const second = Promise.resolve().then(() => { release("first"); return "second"; });
    return await Promise.all([first, second]);
  `);
  assert.equal(concurrent.ok, true);
  assert.equal(concurrent.result, '["first","second"]');
  for (const code of ['return (', 'throw new Error("sync failure")', 'await Promise.reject(new Error("async failure"))', 'return Promise.reject("returned failure")']) {
    const result = await run(code);
    assert.equal(result.ok, false);
    assert.match(result.error, /^JavaScript error: /);
    if (code.includes('sync failure')) assert.match(result.error, /sync failure/);
    if (code.includes('async failure')) assert.match(result.error, /async failure/);
    if (code.includes('returned failure')) assert.match(result.error, /returned failure/);
  }
}
