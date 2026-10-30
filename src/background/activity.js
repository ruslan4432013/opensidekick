// Local LLM activity log — the extension's black box. Every model call that
// goes through callModel() appends one compact entry to a bounded ring kept in
// chrome.storage.local. Nothing is ever sent anywhere: the only exits are the
// options page's download button and the browser console.
//
// Entry shape (what an analyzer should expect):
//   { ts, kind, model, provider, type, host, msgs, images, tools,   // request
//     ms, ok, stop?, chars?, calls?, usage?,                        // outcome
//     httpStatus?, error? }                                         // failure
// kind is "chat" for agent turns, "probe:<stage>" for the options Test
// button. usage is { prompt, completion, total, cached? } when the provider
// streamed token accounting back.

import { ACTIVITY_KEY } from "../common/constants.js";

export const MAX_ENTRIES = 500;

// The log must never carry a credential. Mask the exact apiKey if one is
// handed to us, then anything token-shaped, and cap the string so a fat error
// body can't bloat the ring.
export function redact(text, secret) {
  let out = String(text || "");
  if (secret && out.includes(secret)) out = out.split(secret).join("***");
  return out.replace(/\bsk-[A-Za-z0-9._-]{6,}/g, "sk-***").slice(0, 300);
}

export const hostOf = (provider) => {
  try {
    return new URL(provider.baseUrl).host;
  } catch {
    return "";
  }
};

export const countImages = (messages) =>
  (messages || []).reduce((n, m) => n + ((m.images && m.images.length) || 0), 0);

// storage.local is absent in node tests and anywhere the extension has no
// context; logging must never be the reason a call fails.
const store = () =>
  typeof chrome !== "undefined" && chrome.storage && chrome.storage.local ? chrome.storage.local : null;

// Writes are chained, so two calls finishing at once can't interleave their
// read-modify-write and silently drop an entry from the ring.
let queue = Promise.resolve();

export function recordCall(entry) {
  const s = store();
  if (!s) return Promise.resolve();
  queue = queue
    .then(async () => {
      try {
        const raw = await s.get(ACTIVITY_KEY);
        const log = Array.isArray(raw[ACTIVITY_KEY]) ? raw[ACTIVITY_KEY] : [];
        log.push(entry);
        await s.set({ [ACTIVITY_KEY]: log.slice(-MAX_ENTRIES) });
      } catch {
        // Quota or corruption: start the ring over rather than break the agent.
        try {
          await s.set({ [ACTIVITY_KEY]: [entry] });
        } catch {}
      }
    })
    .catch(() => {});
  return queue;
}

export async function readActivity() {
  const s = store();
  if (!s) return [];
  const raw = await s.get(ACTIVITY_KEY);
  return Array.isArray(raw[ACTIVITY_KEY]) ? raw[ACTIVITY_KEY] : [];
}

export async function clearActivity() {
  const s = store();
  if (s) await s.remove(ACTIVITY_KEY);
}
