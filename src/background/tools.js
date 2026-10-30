// Browser-control tools exposed to the model, plus their execution against the
// active tab. Tool schemas are provider-agnostic (plain JSON Schema); the
// provider layer converts them to the right wire format.

import { normalizeTarget } from "./permissions.js";
import { MSG } from "../common/constants.js";
import { readConsole, readNetwork, isAttached, sendKeyEvents, insertText } from "./cdp.js";

export const TOOL_DEFS = [
  {
    name: "read_page",
    description:
      "Read the current page. Returns the page title, URL, a text summary, and a " +
      "list of interactive elements each with a numeric 'ref' id you can use with " +
      "click_element, type_text, and select_option. Call this before acting so you " +
      "know what is on the page.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_page_text",
    description:
      "Get the full readable text content of the current page (article/main text). " +
      "Use for reading, summarizing, or extracting information.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "find",
    description:
      "Find text on the current page: counts the occurrences, scrolls to and " +
      "selects the first match, and returns a short snippet around it. Use it " +
      "to locate content before acting.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "The text to search for." } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "click_element",
    description: "Click an interactive element by its ref id from read_page.",
    parameters: {
      type: "object",
      properties: { ref: { type: "integer", description: "The element ref id." } },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "type_text",
    description:
      "Type text into an input, textarea, or editable element by its ref id. " +
      "Set submit=true to press Enter afterwards (e.g. to run a search). Rich " +
      "canvas editors (Google Docs) only accept text sent as real input, which " +
      "needs Advanced automation enabled in Settings.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "integer", description: "The element ref id." },
        text: { type: "string", description: "The text to type." },
        submit: { type: "boolean", description: "Press Enter after typing." },
      },
      required: ["ref", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "select_option",
    description: "Choose an option in a <select> dropdown by its ref id.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "integer", description: "The <select> element ref id." },
        value: { type: "string", description: "Option value or visible label to select." },
      },
      required: ["ref", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "form_input",
    description:
      "Set the value of a form field identified by CSS selector or by its " +
      "name/id/placeholder/aria-label — no ref needed. Fires input/change " +
      "events so React and other frameworks pick the value up. Prefer " +
      "type_text when you have a ref from read_page.",
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector, or the field's name/id/placeholder/aria-label." },
        value: { type: "string", description: "The value to set. Empty string clears the field." },
      },
      required: ["selector", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "navigate",
    description:
      "Open a URL in a new browser tab (the current tab is left untouched) and " +
      "continue working there. Provide a full URL; https:// is added automatically " +
      "if the scheme is missing. 'back' / 'forward' use the current tab's history.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "URL, or 'back' / 'forward'." } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "scroll",
    description: "Scroll the page: by direction, to absolute page coordinates, or an element into view.",
    parameters: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["up", "down", "top", "bottom"],
          description: "Scroll direction.",
        },
        ref: { type: "integer", description: "Optional element ref to scroll into view." },
        x: { type: "integer", description: "Absolute horizontal page coordinate (alternative to direction)." },
        y: { type: "integer", description: "Absolute vertical page coordinate (alternative to direction)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "take_screenshot",
    description:
      "Capture a screenshot of the visible part of the current page and attach it " +
      "as an image so you can SEE the page — layout, canvas/image content, or " +
      "anything not captured by read_page's text. Requires a vision-capable model. " +
      "Use when the text map isn't enough to understand or locate something.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    visionOnly: true,
  },
  {
    name: "zoom",
    description:
      "Capture a zoomed-in screenshot of a region of the page, centered on the " +
      "given pixel coordinates from the take_screenshot image. Use it to read " +
      "small text or inspect a detail. Read-only: actions still use refs.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "integer", description: "X center of the region, in screenshot pixels." },
        y: { type: "integer", description: "Y center of the region, in screenshot pixels." },
        scale: { type: "number", description: "Zoom factor (default 2, between 1.5 and 5)." },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
    visionOnly: true,
  },
  {
    name: "hover_element",
    description: "Hover the pointer over an element by ref (reveals menus/tooltips).",
    parameters: {
      type: "object",
      properties: { ref: { type: "integer", description: "The element ref id." } },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "double_click",
    description: "Double-click an element by ref.",
    parameters: {
      type: "object",
      properties: { ref: { type: "integer", description: "The element ref id." } },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "right_click",
    description: "Right-click (open the context menu on) an element by ref.",
    parameters: {
      type: "object",
      properties: { ref: { type: "integer", description: "The element ref id." } },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "drag_element",
    description:
      "Drag one element onto another (pointer-based drag-and-drop). Best-effort; " +
      "works on most modern drag interfaces.",
    parameters: {
      type: "object",
      properties: {
        from_ref: { type: "integer", description: "Ref of the element to drag." },
        to_ref: { type: "integer", description: "Ref of the drop target element." },
      },
      required: ["from_ref", "to_ref"],
      additionalProperties: false,
    },
  },
  {
    name: "press_keys",
    description:
      "Press a key or keyboard shortcut, e.g. ['Enter'] or ['Control','k']. " +
      "Sent to the focused element, or the element with the given ref. With " +
      "Advanced automation enabled the keys are sent as real browser input, " +
      "which canvas editors like Google Docs require — they ignore synthetic " +
      "key events.",
    parameters: {
      type: "object",
      properties: {
        keys: { type: "array", items: { type: "string" }, description: "Keys; last is the main key, earlier ones are modifiers (Control, Shift, Alt, Meta)." },
        ref: { type: "integer", description: "Optional element to focus first." },
      },
      required: ["keys"],
      additionalProperties: false,
    },
  },
  {
    name: "run_javascript",
    description:
      "Run JavaScript in the current page and get the result. Use `return` to " +
      "return a value, e.g. `return document.title` or " +
      "`return [...document.querySelectorAll('a')].map(a => a.href)`. Powerful " +
      "escape hatch for reading or manipulating the page when the other tools " +
      "aren't enough. Works on pages that enforce Trusted Types CSP " +
      "(Google Docs and other Google apps): the required bypass policy is " +
      "installed automatically before the code runs.",
    parameters: {
      type: "object",
      properties: { code: { type: "string", description: "JavaScript to run in the page. Use return to return a value." } },
      required: ["code"],
      additionalProperties: false,
    },
    jsOnly: true,
  },
  {
    name: "read_console",
    description:
      "Read recent browser console messages for the page (logs, warnings, errors, " +
      "uncaught exceptions). Monitoring starts when first called; reload the page " +
      "and read again to catch load-time errors. Useful for debugging.",
    parameters: {
      type: "object",
      properties: {
        only_errors: { type: "boolean", description: "Return only warnings and errors." },
        limit: { type: "integer", description: "Max messages to return (default 50)." },
      },
      additionalProperties: false,
    },
    cdpOnly: true,
  },
  {
    name: "read_network",
    description:
      "Read recent network requests the page made (method, URL, status). Monitoring " +
      "starts when first called; reload to capture load-time requests. Useful for " +
      "debugging failed API calls.",
    parameters: {
      type: "object",
      properties: {
        url_pattern: { type: "string", description: "Optional regex to filter request URLs." },
        limit: { type: "integer", description: "Max requests to return (default 50)." },
      },
      additionalProperties: false,
    },
    cdpOnly: true,
  },
  {
    name: "wait",
    description: "Wait a number of seconds for the page to update or content to load.",
    parameters: {
      type: "object",
      properties: { seconds: { type: "number", description: "Seconds to wait (max 10)." } },
      required: ["seconds"],
      additionalProperties: false,
    },
  },
  {
    name: "list_tabs",
    description: "List the open tabs in the current window (id, title, url, active).",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "open_tab",
    description: "Open a new tab with the given URL and switch the agent's focus to it.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "URL to open." } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "switch_tab",
    description: "Switch the agent's focus to an existing tab by its id (from list_tabs).",
    parameters: {
      type: "object",
      properties: { tab_id: { type: "integer", description: "The tab id." } },
      required: ["tab_id"],
      additionalProperties: false,
    },
  },
  {
    name: "close_tab",
    description:
      "Close a tab by its id from list_tabs. Defaults to the agent's current " +
      "tab; call list_tabs / switch_tab afterwards to pick a new focus.",
    parameters: {
      type: "object",
      properties: { tab_id: { type: "integer", description: "The tab id to close." } },
      additionalProperties: false,
    },
  },
  {
    name: "finish",
    description:
      "Call this when the task is complete or cannot proceed. Provide a short " +
      "summary of the result for the user.",
    parameters: {
      type: "object",
      properties: { summary: { type: "string", description: "Summary of the outcome." } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

// ctx: { getTabId, setTabId }  — the agent owns the "focused" tab id and can
// change it (open_tab / switch_tab), so tools read/write it through ctx.
export async function executeTool(name, args, ctx) {
  switch (name) {
    case "read_page":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_READ_PAGE });
    case "get_page_text":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_GET_TEXT });
    case "find":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_FIND, text: args.text });
    case "click_element":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_ACT, action: "click", ref: args.ref });
    case "type_text":
      return await typeText(ctx, args);
    case "select_option":
      return await csSend(await ctx.getTabId(), {
        type: MSG.CS_ACT,
        action: "select",
        ref: args.ref,
        value: args.value,
      });
    case "form_input":
      return await csSend(await ctx.getTabId(), {
        type: MSG.CS_ACT,
        action: "fill",
        selector: args.selector,
        value: args.value,
      });
    case "hover_element":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_ACT, action: "hover", ref: args.ref });
    case "double_click":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_ACT, action: "dblclick", ref: args.ref });
    case "right_click":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_ACT, action: "contextmenu", ref: args.ref });
    case "drag_element":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_ACT, action: "drag", ref: args.from_ref, toRef: args.to_ref });
    case "press_keys":
      return await pressKeys(ctx, args);
    case "take_screenshot":
      return await screenshot(ctx);
    case "zoom":
      return await zoomScreenshot(ctx, args);
    case "run_javascript":
      return await runJavascript(ctx, args.code);
    case "read_console":
      return await readConsole(await ctx.getTabId(), { onlyErrors: !!args.only_errors, limit: args.limit });
    case "read_network":
      return await readNetwork(await ctx.getTabId(), { urlPattern: args.url_pattern, limit: args.limit });
    case "scroll":
      return await csSend(await ctx.getTabId(), {
        type: MSG.CS_ACT,
        action: "scroll",
        direction: args.direction || "down",
        ref: args.ref,
        x: args.x,
        y: args.y,
      });
    case "navigate":
      return await navigate(ctx, args.url);
    case "wait":
      return await waitSeconds(args.seconds);
    case "list_tabs":
      return await listTabs();
    case "open_tab":
      return await openTab(ctx, args.url);
    case "switch_tab":
      return await switchTab(ctx, args.tab_id);
    case "close_tab":
      return await closeTab(ctx, args.tab_id);
    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}

// Models sometimes send a shortcut as one string ("ctrl+k") despite the array
// schema. Split it so the page handler sees the shape it expects.
function normalizeKeys(keys) {
  if (Array.isArray(keys)) return keys;
  if (typeof keys === "string") {
    return keys.split("+").map((s) => s.trim()).filter(Boolean);
  }
  return keys;
}

// press_keys: real CDP key events when possible. Canvas editors (Google Docs,
// Figma, …) ignore the synthetic KeyboardEvents a content script can dispatch
// (isTrusted: false); Input.dispatchKeyEvent feeds the browser's trusted
// input pipeline instead, which those editors respond to. Attaching the
// debugger shows Chrome's banner, so it is only done when the user has
// Advanced automation on (the same setting that exposes read_console /
// read_network), or when it is already attached from one of those tools.
async function pressKeys(ctx, args) {
  const tabId = await ctx.getTabId();
  const keys = normalizeKeys(args.keys);
  if (ctx.cdpAllowed || isAttached(tabId)) {
    if (args.ref != null) {
      // Focus the target element first; CDP keys land in whatever is focused.
      await csSend(tabId, { type: MSG.CS_ACT, action: "focus", ref: args.ref });
    }
    return sendKeyEvents(tabId, keys);
  }
  const out = await csSend(tabId, { type: MSG.CS_ACT, action: "keys", keys, ref: args.ref });
  // Without Advanced automation the keys are synthetic, and a canvas editor
  // will silently ignore them — the tool still reports success, which once
  // dead-ended a whole run on Google Docs. Tell the model so it can ask the
  // user to flip the setting (or finish) instead of burning steps retrying.
  if (out && out.ok) {
    out.note =
      "Synthetic key events. If nothing happened on the page, the site may only " +
      "accept real input (Google Docs and other canvas editors do): ask the user " +
      "to enable Advanced automation in Settings and retry.";
  }
  return out;
}

// type_text: plain fields keep the content-script path (it replaces the value
// and fires the events React and friends need). Rich contenteditable regions
// driven by a canvas editor (Google Docs) ignore DOM changes, so with Advanced
// automation on the text is inserted through the debugger's trusted input
// pipeline instead, and submit presses a real Enter.
async function typeText(ctx, args) {
  const tabId = await ctx.getTabId();
  // Focus also reports what kind of element we are dealing with; a failed
  // focus (missing ref, element gone) is the same error the type action
  // would have raised, so it can be returned directly.
  const focus = await csSend(tabId, { type: MSG.CS_ACT, action: "focus", ref: args.ref });
  if (!focus || focus.ok === false) return focus;
  const rich = focus.typable === "rich";
  if (rich && (ctx.cdpAllowed || isAttached(tabId))) {
    const res = await insertText(tabId, String(args.text ?? ""));
    if (res.ok === false) return res;
    if (args.submit) await sendKeyEvents(tabId, ["Enter"]);
    return { ok: true, typed: String(args.text ?? "").slice(0, 80), submitted: !!args.submit };
  }
  const out = await csSend(tabId, {
    type: MSG.CS_ACT,
    action: "type",
    ref: args.ref,
    text: args.text,
    submit: !!args.submit,
  });
  if (out && out.ok && rich) {
    out.note =
      "Synthetic input. Rich canvas editors (Google Docs) usually ignore it: ask " +
      "the user to enable Advanced automation in Settings for real text input.";
  }
  return out;
}

// Show/update or hide the on-page activity overlay for a tab. Best-effort:
// silently no-ops on restricted pages where the content script can't run.
export async function setOverlay(tabId, state, label) {
  try {
    await ensureContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, { type: MSG.CS_OVERLAY, state, label });
  } catch {
    /* restricted page or tab gone */
  }
}

// Ensure the content script is present in a tab; inject it if the page loaded
// before the extension (or for tabs the manifest match missed).
export async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: MSG.CS_PING });
    if (pong && pong.ok) return true;
  } catch {
    /* not injected yet */
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content/content-script.js"],
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function csSend(tabId, msg) {
  await ensureContentScript(tabId);
  try {
    const res = await chrome.tabs.sendMessage(tabId, msg);
    return res ?? { ok: false, error: "No response from page." };
  } catch (e) {
    return {
      ok: false,
      error:
        "Could not reach the page. It may be a restricted page (chrome://, the " +
        "Chrome Web Store, or a PDF), or it navigated away.",
    };
  }
}

async function navigate(ctx, target) {
  // Why every URL opens a new tab instead of reloading the current one: the
  // current tab may hold the user's unsaved work (forms, editors), and a
  // back/forward-free new tab keeps their page exactly where it was. A fresh
  // tab has no history, so back/forward still apply to the current tab.
  if (target !== "back" && target !== "forward") {
    return await openTab(ctx, target);
  }
  const tabId = await ctx.getTabId();
  if (target === "back") {
    await chrome.tabs.goBack(tabId).catch(() => {});
  } else {
    await chrome.tabs.goForward(tabId).catch(() => {});
  }
  await waitForLoad(tabId);
  const tab = await chrome.tabs.get(tabId);
  return { ok: true, url: tab.url, title: tab.title };
}

async function openTab(ctx, url) {
  const full = normalizeTarget(url);
  if (!full) return { ok: false, error: "OpenSidekick opens tabs to http(s) addresses only." };
  const tab = await chrome.tabs.create({ url: full, active: true });
  ctx.setTabId(tab.id);
  await waitForLoad(tab.id);
  const updated = await chrome.tabs.get(tab.id);
  return { ok: true, tab_id: tab.id, url: updated.url, title: updated.title };
}

async function switchTab(ctx, tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    ctx.setTabId(tabId);
    return { ok: true, tab_id: tabId, url: tab.url, title: tab.title };
  } catch {
    return { ok: false, error: `No tab with id ${tabId}.` };
  }
}

async function closeTab(ctx, tabId) {
  const id = tabId != null ? tabId : await ctx.getTabId();
  try {
    await chrome.tabs.remove(id);
  } catch {
    return { ok: false, error: `No tab with id ${id}.` };
  }
  return { ok: true, closed_tab_id: id };
}

// Crop a zoomed region out of a viewport screenshot. The crop comes from the
// same image take_screenshot would return, so the model's pixel coordinates
// line up with what it just saw.
async function zoomScreenshot(ctx, args) {
  const tabId = await ctx.getTabId();
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, error: "No active tab to capture." };
  }
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const binary = atob(dataUrl.split(",")[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));

    const scale = Math.min(Math.max(Number(args.scale) || 2, 1.5), 5);
    const cropW = Math.max(150, Math.round(bitmap.width / scale));
    const cropH = Math.max(150, Math.round(bitmap.height / scale));
    const cx = Math.min(Math.max(Math.round(Number(args.x) || 0), 0), bitmap.width - 1);
    const cy = Math.min(Math.max(Math.round(Number(args.y) || 0), 0), bitmap.height - 1);
    const cropX = Math.max(0, Math.min(Math.round(cx - cropW / 2), bitmap.width - cropW));
    const cropY = Math.max(0, Math.min(Math.round(cy - cropH / 2), bitmap.height - cropH));

    const canvas = new OffscreenCanvas(cropW, cropH);
    const g = canvas.getContext("2d");
    g.drawImage(bitmap, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let out = "";
    for (let i = 0; i < buf.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    }
    return {
      ok: true,
      url: tab.url,
      image: { mediaType: "image/png", data: btoa(out) },
      note: `Zoomed ${scale}x, centered on (${cx}, ${cy}) of the last screenshot.`,
    };
  } catch (e) {
    return {
      ok: false,
      error:
        "Could not capture a zoomed screenshot (restricted page, or the tab isn't visible): " +
        (e.message || e),
    };
  }
}

async function runJavascript(ctx, code) {
  const tabId = await ctx.getTabId();
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [String(code || "")],
      func: (src) => {
        try {
          // Pages that enforce Trusted Types via CSP
          // (require-trusted-types-for 'script' — Google Docs and other
          // Google apps) block the Function constructor and DOM string
          // assignments ("This document requires 'TrustedScript'
          // assignment"). A default policy makes the browser route those
          // strings through it, so we install a pass-through one before
          // compiling. No-op on pages without Trusted Types (the policy is
          // then never consulted); on pages whose CSP allowlists policy
          // names this throws and is ignored — the original page error is
          // surfaced below as usual.
          try {
            if (window.trustedTypes && !trustedTypes.defaultPolicy) {
              trustedTypes.createPolicy("default", {
                createScript: (s) => s,
                createHTML: (s) => s,
                createURL: (s) => s,
                createScriptURL: (s) => s,
              });
            }
          } catch { /* allowlisted policy names: keep going */ }
          // Function body so `return` works; runs in the page's global scope.
          const out = new Function(src)();
          let serialized;
          try {
            serialized = out === undefined ? "undefined" : JSON.stringify(out);
          } catch {
            serialized = String(out);
          }
          return { ok: true, result: serialized === undefined ? String(out) : serialized };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      },
    });
    const r = results && results[0] && results[0].result;
    if (!r) return { ok: false, error: "No result (restricted page, or the script couldn't run)." };
    if (r.ok === false) return { ok: false, error: "JavaScript error: " + r.error };
    // The URL lets chat history spot a sensitive page read this way.
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    return { ok: true, url: tab ? tab.url : undefined, result: String(r.result).slice(0, 4000) };
  } catch (e) {
    return { ok: false, error: "Could not run JavaScript here: " + (e.message || e) };
  }
}

async function screenshot(ctx) {
  const tabId = await ctx.getTabId();
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, error: "No active tab to capture." };
  }

  // If the tab is itself a direct image (e.g. someone opened a .jpg/.png URL),
  // send the actual full-resolution image instead of a viewport screenshot.
  // A viewport shot of an image document is the picture shrunk onto the
  // browser's gray backdrop, which reads poorly for the model.
  const direct = await fetchDirectImage(tab.url || "");
  if (direct) {
    return { ok: true, url: tab.url, image: direct, note: "Loaded the full-resolution image from this tab." };
  }

  try {
    // captureVisibleTab grabs the active tab of the window as a PNG data URL.
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const data = dataUrl.split(",")[1];
    return { ok: true, url: tab.url, image: { mediaType: "image/png", data }, note: "Screenshot captured." };
  } catch (e) {
    return {
      ok: false,
      error:
        "Could not capture a screenshot (restricted page, or the tab isn't visible): " +
        (e.message || e),
    };
  }
}

const IMAGE_URL_RE = /^https?:\/\/[^?#]+\.(jpe?g|png|gif|webp|bmp|avif)(\?[^#]*)?(#.*)?$/i;
// Model-accepted image media types; other formats fall back to a screenshot.
const MODEL_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// When a tab points straight at an image, fetch its bytes and return
// { mediaType, data } for direct attachment. Returns null (→ fall back to a
// screenshot) if it isn't a fetchable, model-supported image.
async function fetchDirectImage(url) {
  if (!IMAGE_URL_RE.test(url)) return null;
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return null;
    const blob = await res.blob();
    const mediaType = (blob.type || "").toLowerCase();
    if (!MODEL_IMAGE_TYPES.has(mediaType)) return null;
    // Guard against very large payloads (data URI base64 ≈ 1.37× bytes).
    if (blob.size > 12 * 1024 * 1024) return null;
    const buf = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < buf.length; i += chunk) {
      binary += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
    }
    return { mediaType, data: btoa(binary) };
  } catch {
    return null;
  }
}

async function listTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return {
    ok: true,
    tabs: tabs.map((t) => ({ tab_id: t.id, title: t.title, url: t.url, active: t.active })),
  };
}

async function waitSeconds(seconds) {
  const ms = Math.min(Math.max(Number(seconds) || 1, 0), 10) * 1000;
  await new Promise((r) => setTimeout(r, ms));
  return { ok: true, waited_seconds: ms / 1000 };
}

function waitForLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      // Small settle delay so client-side rendering can start.
      setTimeout(resolve, 400);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
    // In case it's already complete.
    chrome.tabs.get(tabId).then((t) => {
      if (t && t.status === "complete") finish();
    });
  });
}
