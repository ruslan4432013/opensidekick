// Unit test for the local LLM activity ring (src/background/activity.js).
// Stubs chrome.storage.local with an in-memory Map and checks the ring bound,
// the write queue, the redaction of credentials, and the no-chrome fallback.

import { ACTIVITY_KEY } from "../src/common/constants.js";
import { recordCall, readActivity, clearActivity, redact, hostOf, countImages, MAX_ENTRIES } from "../src/background/activity.js";

let fail = 0;
const ok = (c, m) => {
  console.log((c ? "ok  : " : "FAIL: ") + m);
  if (!c) fail = 1;
};

const mem = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        return mem.has(key) ? { [key]: mem.get(key) } : {};
      },
      async set(items) {
        for (const [k, v] of Object.entries(items)) mem.set(k, v);
      },
      async remove(key) {
        mem.delete(key);
      },
    },
  },
};

// --- append + read order ---
await recordCall({ ts: 1, kind: "chat", model: "a" });
await recordCall({ ts: 2, kind: "probe:vision", model: "b" });
let log = await readActivity();
ok(log.length === 2 && log[0].ts === 1 && log[1].ts === 2, `two entries kept in order (got ${JSON.stringify(log.map((e) => e.ts))})`);

// --- the ring is bounded and drops the oldest ---
await clearActivity();
const many = [];
for (let i = 0; i < MAX_ENTRIES + 10; i++) many.push(recordCall({ ts: i }));
await Promise.all(many);
log = await readActivity();
ok(log.length === MAX_ENTRIES, `ring capped at ${MAX_ENTRIES} (got ${log.length})`);
ok(log[0].ts === 10 && log[log.length - 1].ts === MAX_ENTRIES + 9, `oldest entries dropped (first ts ${log[0].ts})`);

// --- concurrent writes never lose an entry (the queue serializes them) ---
await clearActivity();
await Promise.all([recordCall({ ts: 1 }), recordCall({ ts: 2 }), recordCall({ ts: 3 })]);
log = await readActivity();
ok(log.length === 3, `three concurrent writes all landed (got ${log.length})`);

// --- redaction ---
const secret = "sk-sp-SECRETVALUE123";
const msg = `Provider request failed (401): bad key ${secret} and also sk-anotherTOKEN456 leaked`;
const clean = redact(msg, secret);
ok(!clean.includes("SECRETVALUE123") && !clean.includes("anotherTOKEN456"), `secrets masked (${clean})`);
ok(clean.includes("***"), "masked positions keep a marker");
ok(redact("x".repeat(1000)).length === 300, "error strings capped at 300 chars");

// --- request counters ---
ok(hostOf({ baseUrl: "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1" }) === "token-plan.maas.qwencloudapi.com", "hostOf keeps only the host");
ok(hostOf({ baseUrl: "not a url" }) === "", "hostOf survives a bad url");
ok(countImages([{ content: "hi" }, { content: "x", images: [{}, {}] }]) === 2, "countImages sums message images");

// --- no chrome context: logging must be a silent no-op, never throw ---
delete globalThis.chrome;
await recordCall({ ts: 1 });
ok((await readActivity()).length === 0, "without chrome.storage nothing throws and nothing is read");

console.log(fail ? "\nSOME ACTIVITY TESTS FAILED" : "\nALL ACTIVITY TESTS PASSED");
process.exit(fail);
