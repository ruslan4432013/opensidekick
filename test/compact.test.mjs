import {
  COMPACT_AT_CHARS,
  KEEP_RECENT,
  buildCheckpoint,
  estimateChars,
  looksLikeContextOverflow,
  planCompaction,
  summaryRequest,
} from "../src/background/compact.js";

let fail = 0;
const ok = (c, m) => {
  console.log((c ? "ok  : " : "FAIL: ") + m);
  if (!c) fail = 1;
};

// --- estimateChars -----------------------------------------------------------

ok(estimateChars([{ role: "user", content: "hello" }]) === 5, "counts text chars");
ok(estimateChars([{ images: [{ data: "x".repeat(100000) }] }]) === 6000, "one image costs a flat 6000, not its base64 size");
ok(
  estimateChars([{ role: "assistant", content: "hi", toolCalls: [{ name: "click_element", args: { ref: 4 } }] }]) > 2,
  "tool call args count toward the estimate",
);
ok(estimateChars(null) === 0, "null conversation estimates as zero");

// --- planCompaction ----------------------------------------------------------

const msg = (role, extra = {}) => ({ role, content: "x".repeat(10), ...extra });
const long = (n) => Array.from({ length: n }, (_, i) => (i % 3 === 0 ? msg("user") : i % 3 === 1 ? msg("assistant", { toolCalls: [{ name: "t", args: {} }] }) : msg("tool")));

ok(planCompaction(long(10)) === null, "a conversation at or under the keep size has nothing to compact");
ok(planCompaction([]) === null, "empty conversation is safe");

const plan = planCompaction(long(60));
ok(!!plan, "a long conversation splits");
ok(plan.tail.length >= KEEP_RECENT, "the tail is at least the keep window");
ok(plan.head.length + plan.tail.length === 60, "head and tail reassemble the conversation");
ok(plan.head[0].role === "user", "the head starts with the original request, so the summary sees the task");
ok(["user", "assistant"].includes(plan.tail[0].role), "the tail never opens with an orphaned tool result");

// A tool result right at the cut must pull its assistant turn into the tail.
const orphanRisk = [...long(59), msg("assistant", { toolCalls: [{ name: "t", args: {} }] }), msg("tool")];
const plan2 = planCompaction(orphanRisk);
ok(plan2.tail[0].role !== "tool", "a tool result at the boundary does not open the tail");

// A user message just before the cut is preferred as the boundary.
const withUserNearCut = Array.from({ length: 45 }, (_, i) =>
  i === 23 ? msg("user") : i % 2 === 0 ? msg("assistant", { toolCalls: [{ name: "t", args: {} }] }) : msg("tool"),
);
const plan3 = planCompaction(withUserNearCut);
ok(plan3.tail[0].role === "user", "a user message at the boundary starts the tail (whole exchanges, tools attached)");

// A conversation whose only user message is the original task summarizes
// everything after it instead of giving up.
const toolHeavy = [msg("user"), ...Array.from({ length: 40 }, () => msg("assistant", { toolCalls: [{ name: "t", args: {} }] }))];
const plan4 = planCompaction(toolHeavy);
ok(!!plan4 && plan4.head[0].role === "user" && plan4.tail.length === 20, "tool-only stretch still compacts (assistant boundary)");
ok(plan4.tail[0].role === "assistant", "assistant boundary when no user message exists after the original request");

// --- summaryRequest ----------------------------------------------------------

const shotMsg = { role: "user", content: "Here is the screenshot:", images: [{ mediaType: "image/png", data: "zzz" }] };
const req = summaryRequest([{ role: "user", content: "task" }, shotMsg]);
ok(req.at(-1).role === "user" && /summarize/i.test(req.at(-1).content), "the instruction is the last user message");
ok(req.every((m) => !m.images), "the summary request carries no images");
ok(req[0].content === "task", "the transcript starts with the original request");
ok(summaryRequest([]).length === 1, "empty conversation still yields the instruction message");

// --- buildCheckpoint ---------------------------------------------------------

const cp = buildCheckpoint("## Objective\n- paint the doc", { sensitive: true, task: "Добавь разного цвета" });
ok(cp.role === "user" && cp.internal === true, "the checkpoint is an internal user message");
ok(cp.sensitive === true, "the sensitive flag rides on the checkpoint");
ok(cp.content.includes("<conversation-checkpoint>"), "the checkpoint wraps the summary");
ok(cp.content.includes("Добавь разного цвета"), "the original task is embedded verbatim");
ok(buildCheckpoint("s").sensitive === undefined, "no sensitive flag when none was passed");

// --- looksLikeContextOverflow ------------------------------------------------

ok(looksLikeContextOverflow("This model's maximum context length is 8192 tokens"), "matches OpenAI-style context length errors");
ok(looksLikeContextOverflow("prompt is too long: 105000 tokens > 100000 maximum"), "matches Anthropic-style rejections");
ok(looksLikeContextOverflow("Request exceeds the context window limit"), "matches context-window phrasing");
ok(!looksLikeContextOverflow("Failed to fetch"), "network failures are not overflow");
ok(!looksLikeContextOverflow(""), "empty message is not overflow");

// --- threshold sanity --------------------------------------------------------

ok(COMPACT_AT_CHARS === 60000, "threshold is 60k chars (≈15k tokens, fits 32k-context models)");
ok(KEEP_RECENT === 20, "keep window is the newest 20 messages");

console.log(fail ? "\nSOME COMPACT TESTS FAILED" : "\nALL COMPACT TESTS PASSED");
process.exit(fail);
