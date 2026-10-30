// Unit test for thinkingParams(): the Settings "thinking" switch mapped onto
// the field each provider family accepts. Pure function — no server needed.

import { thinkingParams } from "../src/background/providers.js";

let fail = 0;
const ok = (c, m) => {
  console.log((c ? "ok  : " : "FAIL: ") + m);
  if (!c) fail = 1;
};
const j = (v) => JSON.stringify(v);
const openai = (baseUrl) => ({ type: "openai", baseUrl });

// --- auto and empty send nothing at all ---
ok(thinkingParams(openai("https://x.test/v1"), "qwen3.8-flash", "auto") === null, "auto: no fields");
ok(thinkingParams(openai("https://x.test/v1"), "qwen3.8-flash", undefined) === null, "absent setting: no fields");

// --- Qwen family by model id, on any host (token-plan serves many families) ---
ok(j(thinkingParams(openai("https://token-plan.maas.qwencloudapi.com/compatible-mode/v1"), "qwen3.8-flash", "off")) === '{"enable_thinking":false}', "qwen model off: enable_thinking:false");
ok(j(thinkingParams(openai("https://token-plan.maas.qwencloudapi.com/compatible-mode/v1"), "qwen3.8-max", "on")) === '{"enable_thinking":true}', "qwen model on: enable_thinking:true");

// --- GLM and Kimi-thinking by model id ---
ok(j(thinkingParams(openai("https://x.test/v1"), "glm-4.6", "off")) === '{"thinking":{"type":"disabled"}}', "glm off: thinking.type disabled");
ok(j(thinkingParams(openai("https://x.test/v1"), "kimi-k2-thinking", "off")) === '{"thinking":{"type":"disabled"}}', "kimi-thinking off: thinking.type disabled");

// --- families with no off switch: leave the request untouched ---
ok(thinkingParams(openai("https://x.test/v1"), "deepseek-r1", "off") === null, "deepseek-r1: no switch, nothing sent");
ok(thinkingParams(openai("https://x.test/v1"), "kimi-k2", "off") === null, "plain kimi: no switch, nothing sent");

// --- unknown models send nothing (a stray field is a 400 on strict servers) ---
ok(thinkingParams(openai("https://x.test/v1"), "some-new-model", "off") === null, "unknown model: nothing sent");

// --- OpenRouter normalizes everything behind reasoning ---
const or = openai("https://openrouter.ai/api/v1");
ok(j(thinkingParams(or, "any-model", "off")) === '{"reasoning":{"effort":"none"}}', "openrouter off: reasoning.effort none");
ok(thinkingParams(or, "any-model", "on") === null, "openrouter on: default already thinks");

// --- Anthropic ---
const an = { type: "anthropic", baseUrl: "https://api.anthropic.com/v1" };
ok(j(thinkingParams(an, "claude-sonnet-4-5", "off")) === '{"thinking":{"type":"disabled"}}', "anthropic off: thinking disabled");
ok(thinkingParams(an, "claude-sonnet-4-5", "on") === null, "anthropic on: nothing forced");

// --- local servers by host ---
ok(j(thinkingParams(openai("http://localhost:11434/v1"), "qwen3:8b", "off")) === '{"think":false}', "ollama off: think:false");
ok(j(thinkingParams(openai("http://192.168.1.10:8000/v1"), "Qwen3-30B", "off")) === '{"chat_template_kwargs":{"enable_thinking":false,"thinking":false}}', "vllm off: template kwargs");

console.log(fail ? "\nSOME THINKING TESTS FAILED" : "\nALL THINKING TESTS PASSED");
process.exit(fail);
