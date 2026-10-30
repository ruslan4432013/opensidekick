// Context compaction for the agent loop — the OpenCode / Claude Code
// "auto-compact" approach, adapted to a browser agent. There is no step cap:
// the loop runs until the model stops calling tools, and when the conversation
// grows past a size threshold, everything older than the newest turns is
// summarized into a single "checkpoint" message while the recent tail is kept
// verbatim. A run therefore continues for as long as the task needs without
// blowing the model's context window.
//
// Pure module (no chrome APIs) so it is unit-testable in Node, like
// sessions.js; agent.js does the calling and the bookkeeping.

import { stripImages } from "./sessions.js";

// Characters of conversation that trigger a compaction. A char budget is an
// approximation of tokens we can compute without a tokenizer; it deliberately
// counts images at a flat per-image cost, so a burst of screenshots compacts
// old history (whose screenshots are stale anyway) instead of silently
// inflating the prompt. 60k chars ≈ 15k tokens: low enough to stay inside
// 32k-context models with headroom, high enough that ordinary tasks never see
// a compaction at all.
export const COMPACT_AT_CHARS = 60_000;

// Messages kept verbatim beside the checkpoint. Twenty covers the current
// tool exchange plus several turns of context, which is what the model needs
// to continue smoothly; everything older is summarized.
export const KEEP_RECENT = 20;

// Flat char cost of one screenshot in the estimate (≈ 1.5k image tokens).
const IMAGE_CHARS = 6_000;

// The instruction appended after the transcript, modeled on OpenCode's
// compaction prompt: a fixed template with terse sections, so the checkpoint
// is predictable to consume for the model that continues the task.
const SUMMARY_PROMPT = `You MUST summarize the conversation above into a structured checkpoint that will be given to the same agent to resume the work. Use this exact format (you may omit sections that aren't applicable). Do not include the <template> tags in your response.

<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Requirements
- [constraints, preferences, requirements, and scope boundaries stated by the user, or "(none)"]

## Decisions
- [decisions already made and why, or "(none)"]

## Work State
Break the objective into smaller goals and report which are completed, which are being worked on, and which are blocked.
### Completed
- [goals that have been completed; otherwise "(none)"]

### Active
- [goals currently being worked on; otherwise "(none)"]

### Blocked
- [anything blocking progress, and why; otherwise "(none)"]

## Next Moves
1. [ordered list of next actions, or "(none)"]

## Key Page Facts
- [page URLs, element refs, tab state, values typed or read, and anything on the page that the next turns still depend on; or "(none)"]

## Important Context
- [facts the agent cannot continue without and cannot easily recover by re-reading the page; or "(none)"]
</template>

Rules:
- Write the summary in the language of the user's request.
- Keep each section concise. Use terse, single-line bullets, not prose paragraphs or nested lists.
- Preserve exact URLs, element refs, selectors, commands, error strings, and identifiers.
- Carry forward only requests that remain unanswered or need further action; do not repeat ones that newer history has resolved.
- Approaches that were tried and failed belong in Decisions, with the reason, so they are not retried.
- Do not mention the summary process or that context was compacted.
- Do not continue the task or call tools. Return only the summary.`;

// The checkpoint message that replaces the summarized history. `internal`
// keeps it out of transcripts (the panel shows a note instead), and `sensitive`
// carries the "this chat has been on a sensitive site" state across the
// compaction, which scanning tool URLs can no longer recover afterwards.
export function buildCheckpoint(summary, { sensitive = false, task = "" } = {}) {
  const taskLine = task ? `The user's original request:\n${task}\n\n` : "";
  return {
    role: "user",
    internal: true,
    ...(sensitive ? { sensitive: true } : {}),
    content:
      "<conversation-checkpoint>\n" +
      taskLine +
      String(summary || "").trim() +
      "\n</conversation-checkpoint>\n\n" +
      "This checkpoint summarizes everything older than the most recent turns. The messages that follow are those recent turns, kept verbatim. Continue the task from where it left off.",
  };
}

// Prompt characters of a conversation: text as-is, images at a flat cost, so
// the number tracks what the provider will actually be sent better than raw
// JSON length (base64 blobs would dominate it).
export function estimateChars(messages) {
  if (!Array.isArray(messages)) return 0;
  let images = 0;
  let text = 0;
  for (const m of messages) {
    if (!m) continue;
    images += (m.images && m.images.length) || 0;
    text += String(m.content || "").length;
    if (m.toolCalls && m.toolCalls.length) text += JSON.stringify(m.toolCalls).length;
  }
  return text + images * IMAGE_CHARS;
}

// Split a conversation into the part to summarize (`head`) and the part to
// keep verbatim (`tail`). The cut prefers a user message as the boundary —
// an exchange then starts the tail, and an assistant's tool calls always
// travel with their results, which every provider requires. When no user
// message falls at the boundary (long tool-only stretches), an assistant
// boundary is used, but never a leading orphaned tool result. Null when there
// is nothing worth summarizing.
export function planCompaction(messages, { keep = KEEP_RECENT } = {}) {
  if (!Array.isArray(messages) || messages.length <= keep) return null;
  let cut = messages.length - keep;
  // A tool result must not start the tail: move the owner assistant turn in.
  while (cut > 1 && messages[cut].role === "tool") cut--;
  // Prefer a user-message boundary slightly further back, but never shrink
  // the head to just the original request — that is nothing to summarize.
  let userCut = cut;
  while (userCut > 1 && messages[userCut].role !== "user") userCut--;
  if (userCut >= 2) cut = userCut;
  if (cut < 2) return null;
  return { head: messages.slice(0, cut), tail: messages.slice(cut) };
}

// The request for the summarizing model call: the whole conversation with
// images stripped (screenshots are stale and their tokens better spent on
// text), followed by the instruction. Sent unchanged prefix-first so a
// provider prompt cache still applies where one exists.
export function summaryRequest(messages) {
  return [...stripImages(messages), { role: "user", content: SUMMARY_PROMPT }];
}

// Did the provider reject the request as too long? Matched against the error
// text of OpenAI-style and Anthropic-style rejections. Used to compact and
// retry instead of failing the run (OpenCode's "overflow" trigger).
export function looksLikeContextOverflow(message) {
  return /context length|context_length|maximum context|too many tokens|prompt is too long|input.*too long|exceeds.*context|context window/i.test(
    String(message || ""),
  );
}
