// Browser-control tools exposed to the model, plus their execution against the
// active tab. Tool schemas are provider-agnostic (plain JSON Schema); the
// provider layer converts them to the right wire format.

import { normalizeTarget } from "./permissions.js";
import { MSG } from "../common/constants.js";
import { readConsole, readNetwork, isAttached, ensureAttached, sendKeyEvents, insertText, pointerInput } from "./cdp.js";

export function isMiroUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return host === "miro.com" || host.endsWith(".miro.com");
  } catch { return false; }
}

export const MIRO_INPUT_GUIDANCE = "On Miro, for reading or summarizing FIRST use get_page_text(offset:0), then follow snapshot_id and next_offset until all_text_delivered. It includes offscreen objects and nested frames; the Frames sidebar and viewport are NOT the full board. Do not scroll, find or repeat screenshots to collect text. Preserve per-page facts and IDs. Report missing_groups and image/embed/grid limitations honestly. For navigation, scroll uses wheel events over the actual panel; pan uses middle-button dragging on canvas without moving objects. If changed:false, retarget from a fresh screenshot instead of repeating. On Miro, run_javascript is unavailable. Use take_screenshot, then pointer_action with that screenshot_id for clicks, double-clicks and drags. Coordinates are pixels in the original screenshot: do not divide by DPR or apply Miro's canvas zoom yourself. Use insert_text for the focused editor and press_keys for keyboard input. Take a new screenshot after panning, zooming or an uncertain UI change, and verify the visible result. If pointer_action is unavailable, ask to enable Advanced automation and Vision; do not emulate clicks with JavaScript.";

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
      "On Miro, reads the complete accessible board in pages, including offscreen objects. Start with offset:0; continue with snapshot_id and next_offset until all_text_delivered. Never scroll to get the next text page.",
    parameters: { type: "object", properties: { offset: { type: "integer", minimum: 0 }, snapshot_id: { type: "string" },
      object_id: { type: "string", description: "Miro object ID from the board text. Read only that object and its descendants to recover details without rereading the whole board. Coverage then applies only to this object." },
      reread: { type: "boolean", description: "Miro only: recover a previously read page after context compaction. At most one explicit reread per page." } }, additionalProperties: false },
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
      "installed automatically before the code runs. Supports await; use return " +
      "to provide the final value. Use Promise.all for independent async operations " +
      "or Promise.allSettled to collect successes and failures. This does not " +
      "parallelize CPU work or DOM changes.",
    parameters: {
      type: "object",
      properties: { code: { type: "string", description: "Async JavaScript function body to run in the page. Supports await; use return to return a value." } },
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

const PAGE_ACTIONS = new Set(["click_element", "type_text", "select_option", "form_input", "navigate", "double_click", "right_click", "hover_element", "drag_element", "press_keys", "scroll", "pointer_action", "insert_text", "open_tab", "switch_tab"]);
const pointerProperties = {
  screenshot_id: { type: "string" },
  action: { type: "string", enum: ["click", "double_click", "drag", "pan", "scroll"] },
  x: { type: "number" }, y: { type: "number" },
  to_x: { type: "number" }, to_y: { type: "number" },
  delta_x: { type: "number" }, delta_y: { type: "number" },
};
TOOL_DEFS.push({
  name: "pointer_action", visionOnly: true, cdpOnly: true,
  description: "Trusted pointer action using pixels from a recent viewport screenshot. Stop and take another screenshot if layout, zoom or scroll changes. Drag moves objects with the left button; pan moves canvas with the middle button. Both require to_x/to_y. Scroll uses delta_x/delta_y in CSS pixels at the pointer target. Check changed and a fresh screenshot; sent events alone do not prove movement.",
  parameters: { type: "object", properties: pointerProperties, required: ["screenshot_id", "action", "x", "y"], additionalProperties: false },
}, {
  name: "insert_text", cdpOnly: true,
  description: "Insert text into the currently focused editable field or canvas editor using trusted browser input. Does not submit or change focus. Use type_text to replace a normal field by ref.",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
});
export const SEQUENCE_ACTIONS = new Set(["click_element", "double_click", "type_text", "insert_text", "press_keys", "select_option", "scroll", "drag_element", "pointer_action"]);
const sequenceSteps = TOOL_DEFS.filter(t => SEQUENCE_ACTIONS.has(t.name)).map(t => ({
  type: "object", properties: { name: { type: "string", enum: [t.name] }, args: t.parameters },
  required: ["name", "args"], additionalProperties: false,
}));
TOOL_DEFS.push({
  name: "browser_sequence",
  description: "Run 1–20 known actions sequentially with the same permission checks as single actions. No navigation, JavaScript, nested batches or tab switching. Stops at the first error or new user message. Returns per-step results, completed count, zero-based stopped_at (null on success), and a fresh page. Prefer fill_form for ordinary text fields. Do not batch unknown UI branches.",
  parameters: { type: "object", properties: { actions: { type: "array", minItems: 1, maxItems: 20, items: { anyOf: sequenceSteps } } }, required: ["actions"], additionalProperties: false },
});

// Capture validity is private to a task; model-supplied metadata is never trusted.
const captures = new WeakMap();
const stalledNavigation = new WeakMap();
const readingSessions = new WeakMap();
export async function documentState(ctx, includeGeometry = false) {
  const tabId = await ctx.getTabId();
  const tab = await chrome.tabs.get(tabId);
  const state = await csSend(tabId, { type: "cs_document_token", includeGeometry });
  return { ...state, tabId, active: tab.active !== false, pending: !!tab.pendingUrl };
}
function validArguments(value, schema) {
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "object") return value && typeof value === "object" && !Array.isArray(value) &&
    (schema.required || []).every(key => Object.hasOwn(value, key)) &&
    Object.entries(value).every(([key, item]) => schema.properties?.[key]
      ? validArguments(item, schema.properties[key]) : schema.additionalProperties !== false);
  if (schema.type === "array") return Array.isArray(value) && value.every(item => validArguments(item, schema.items));
  if (schema.type === "integer") return Number.isInteger(value);
  if (schema.type === "number") return Number.isFinite(value);
  return !schema.type || typeof value === schema.type;
}
export function sameDocument(current, baseline) {
  return current?.ok && !current.pending && current.tabId === baseline.tabId &&
    current.token === baseline.token && current.url === baseline.url && current.active === baseline.active;
}
export function validateSequence(args, offered = TOOL_DEFS) {
  if (!Array.isArray(args?.actions) || args.actions.length < 1 || args.actions.length > 20) return "Expected 1–20 actions.";
  for (const step of args.actions) {
    if (!step || !SEQUENCE_ACTIONS.has(step.name) || !offered.some(t => t.name === step.name)) return "Sequence contains an unavailable action.";
    const definition = TOOL_DEFS.find(t => t.name === step.name);
    if (!validArguments(step.args, definition.parameters)) return `Invalid arguments for ${step.name}.`;
    if (step.name === "pointer_action" && ["drag", "pan"].includes(step.args.action) &&
        ![step.args.to_x, step.args.to_y].every(Number.isFinite)) return "Drag requires destination coordinates.";
  }
  return null;
}
export async function runSequence(args, { state, interrupted, perform, progress }) {
  const results = [];
  let baseline;
  let failure;
  try {
    baseline = await state();
    if (!baseline?.ok || baseline.pending) throw new Error("Cannot identify a stable document.");
    for (let index = 0; index < args.actions.length; index++) {
      progress(index, results.filter(r => r.ok).length);
      if (interrupted()) { failure = "Interrupted by Stop or a new user message."; break; }
      const current = await state();
      if (!sameDocument(current, baseline)) {
        failure = "Page or tab changed; observe it again before continuing."; break;
      }
      let result;
      try { result = await perform(args.actions[index], index, baseline); }
      catch (error) { result = { ok: false, error: error.message || String(error) }; }
      results.push({ index, ...result });
      if (!result?.ok) { failure = result?.error || "Action failed."; break; }
      progress(index + 1, results.length);
      if (!sameDocument(await state(), baseline)) { failure = "Page or tab changed after action; observe it again."; break; }
    }
  } catch (error) { failure = error.message || String(error); }
  const completed = results.filter(r => r.ok).length;
  return { ok: !failure, results, completed, stopped_at: failure ? completed : null, ...(failure ? { error: failure } : {}) };
}

// Compare only boxes covering the intended coordinates. Animated cursors or
// status indicators elsewhere on a canvas must not invalidate every capture.
function layoutAt(layout, point) {
  return JSON.stringify((layout || []).filter(([, x, y, width, height]) =>
    point.x >= x && point.x < x + width && point.y >= y && point.y < y + height));
}

async function pointerTarget(ctx, args) {
  if (!ctx.cdpAllowed || !ctx.visionAllowed) return { ok: false, error: "Advanced automation and Vision are required." };
  const capture = captures.get(ctx);
  const state = await documentState(ctx, true);
  if (!capture || capture.id !== args.screenshot_id || !state.ok || !state.active || state.pending ||
      capture.tabId !== state.tabId || capture.token !== state.token || capture.url !== state.url ||
      JSON.stringify(capture.viewport) !== JSON.stringify(state.viewport) || capture.geometry !== state.geometry) {
    return { ok: false, error: "Screenshot is stale or belongs to a different tab. Capture a fresh screenshot." };
  }
  const point = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= capture.width || y >= capture.height) throw new Error("Coordinates must be inside the screenshot.");
    return { x: x * state.viewport.width / capture.width, y: y * state.viewport.height / capture.height };
  };
  try {
    const from = point(args.x, args.y);
    const to = ["drag", "pan"].includes(args.action) ? point(args.to_x, args.to_y) : null;
    for (const position of [from, ...(to ? [to] : [])]) {
      const atCapture = layoutAt(capture.layout, position);
      if (atCapture !== layoutAt(capture.layoutBefore, position) || atCapture !== layoutAt(state.layout, position)) {
        throw new Error("Screenshot geometry changed at the target. Capture a fresh screenshot.");
      }
    }
    if (!["click", "double_click", "drag", "pan", "scroll"].includes(args.action)) throw new Error("Unknown pointer action.");
    if (args.action === "scroll" && ![args.delta_x ?? 0, args.delta_y ?? 0].every(Number.isFinite)) throw new Error("Scroll deltas must be finite.");
    const target = await csSend(state.tabId, { type: "cs_inspect_target", x: from.x, y: from.y });
    return { ...target, tabId: state.tabId, from, to };
  } catch (error) { return { ok: false, error: error.message }; }
}
export async function inspectTarget(ctx, name, args) {
  if (name === "pointer_action") return pointerTarget(ctx, args);
  if (name === "insert_text") return csSend(await ctx.getTabId(), { type: "cs_inspect_focus" });
  return csSend(await ctx.getTabId(), { type: "cs_inspect_target", ref: args.ref });
}

for (const tool of TOOL_DEFS) {
  if (PAGE_ACTIONS.has(tool.name)) {
    tool.parameters.properties.include_page = {
      type: "boolean",
      description: "Return the fresh page with this action; prefer true to avoid a separate read_page call.",
    };
  }
}
TOOL_DEFS.push({
  name: "fill_form",
  description: "Fill known text fields sequentially in one call, without submitting. Returns completed refs and the fresh page. Stops on the first failure.",
  parameters: {
    type: "object",
    properties: {
      fields: {
        type: "array", minItems: 1, maxItems: 50,
        items: {
          type: "object",
          properties: { ref: { type: "integer" }, value: { type: "string" } },
          required: ["ref", "value"], additionalProperties: false,
        },
      },
    },
    required: ["fields"], additionalProperties: false,
  },
});

export async function executeTool(name, args, ctx) {
  if (ctx.signal?.aborted) return { ok: false, error: "Cancelled" };
  if (name === "read_page" && args.settle) {
    return csSend(await ctx.getTabId(), { type: "cs_settled_page", expectedOrigin: args.expectedOrigin });
  }
  if (name !== "fill_form") return executeAction(name, args, ctx);
  const fields = args.fields;
  if (!Array.isArray(fields) || !fields.length || fields.length > 50 ||
      fields.some(f => !Number.isInteger(f.ref) || typeof f.value !== "string")) {
    return { ok: false, error: "Expected 1–50 fields with integer ref and string value.", completed: [] };
  }
  const tabId = await ctx.getTabId();
  const initial = await csSend(tabId, { type: "cs_validate_fields", fields });
  if (!initial?.ok || !initial.token) return { ok: false, error: "Cannot identify the current document.", completed: [] };
  const completed = [];
  for (const field of fields) {
    if (ctx.signal?.aborted) return { ok: false, error: "Cancelled", completed };
    const result = await csSend(tabId, {
      type: MSG.CS_ACT, action: "type", ref: field.ref, text: field.value,
      documentToken: initial.token, documentUrl: initial.url,
    });
    if (!result?.ok) return { ...result, ok: false, completed };
    completed.push(field.ref);
    // Let framework updates run before resolving the next element.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return { ok: true, completed };
}

async function executeAction(name, args, ctx) {
  switch (name) {
    case "pointer_action": {
      const target = await pointerTarget(ctx, args);
      if (!target.ok) return target;
      const navigation = ["scroll", "pan"].includes(args.action);
      const miro = isMiroUrl((await chrome.tabs.get(target.tabId)).url);
      if (navigation && miro && (stalledNavigation.get(ctx) || 0) >= 3) {
        return { ok: false, error: "Stopped navigation after three attempts with no observed movement. Read the board with get_page_text, or finish with the navigation limitation; do not repeat scrolling." };
      }
      const message = { type: "cs_navigation_state", ...target.from };
      const before = navigation ? await csSend(target.tabId, message) : null;
      const result = await pointerInput(target.tabId, args.action, target.from, target.to, args, ctx.signal);
      // Canvas panning may not generate a DOM scroll or resize event.
      if (navigation || args.action === "drag") captures.delete(ctx);
      if (navigation && result.ok && !ctx.signal?.aborted) {
        const after = await csSend(target.tabId, { ...message, before: before?.state });
        let changed = before?.ok && after?.ok && before.observable ? before.state !== after.state : null;
        // Miro can repaint its canvas without updating the accessible outline.
        // Unchanged DOM during a pan is not evidence of a stationary canvas.
        if (miro && args.action === "pan" && changed === false) changed = null;
        if (miro && changed !== null) stalledNavigation.set(ctx, changed ? 0 : (stalledNavigation.get(ctx) || 0) + 1);
        return { ...result, changed, target: before?.target, css_point: target.from,
          note: changed === false ? "No movement observed. Do not repeat this target: take a new screenshot and retarget the actual scrollable panel, or use pan on canvas. For board text use get_page_text."
            : changed === null ? "Events sent; movement could not be measured. Verify a fresh screenshot."
              : "Navigation changed. Capture a fresh screenshot before the next pointer action." };
      }
      return result;
    }
    case "insert_text": {
      if (!ctx.cdpAllowed) return { ok: false, error: "Advanced automation is required." };
      if (typeof args.text !== "string") return { ok: false, error: "text must be a string." };
      const focus = await inspectTarget(ctx, name, args);
      if (!focus.ok) return focus;
      return insertText(await ctx.getTabId(), args.text);
    }
    case "read_page":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_READ_PAGE });
    case "get_page_text":
      if (!readingSessions.has(ctx)) readingSessions.set(ctx, crypto.randomUUID());
      return await csSend(await ctx.getTabId(), { type: MSG.CS_GET_TEXT, offset: args.offset,
        snapshot_id: args.snapshot_id, reread: args.reread, object_id: args.object_id, reading_session: readingSessions.get(ctx) });
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
      const focus = await csSend(tabId, { type: MSG.CS_ACT, action: "focus", ref: args.ref });
      if (!focus?.ok) return focus;
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
  await waitForLoad(tabId, 15000, ctx.signal);
  const tab = await chrome.tabs.get(tabId);
  return { ok: true, url: tab.url, title: tab.title };
}

async function openTab(ctx, url) {
  const full = normalizeTarget(url);
  if (!full) return { ok: false, error: "OpenSidekick opens tabs to http(s) addresses only." };
  const tab = await chrome.tabs.create({ url: full, active: true });
  ctx.setTabId(tab.id);
  await waitForLoad(tab.id, 15000, ctx.signal);
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
    if (isMiroUrl((await chrome.tabs.get(tabId)).url)) return { ok: false, error: MIRO_INPUT_GUIDANCE };
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [String(code || "")],
      func: async (src) => {
        try {
          // Recheck inside the target document: navigation may race injection.
          if (typeof location !== "undefined" && /(^|\.)miro\.com\.?$/i.test(location.hostname)) {
            return { ok: false, error: "On Miro use take_screenshot and pointer_action, not run_javascript." };
          }
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
          // Await before serialization so returned promises and rejections are handled.
          const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          const out = await new AsyncFunction(src)();
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
  captures.delete(ctx);
  const direct = await fetchDirectImage(tab.url || "");
  if (direct) {
    return { ok: true, url: tab.url, image: direct, note: "Loaded the full-resolution image from this tab." };
  }

  try {
    // Attach before measuring: the debugger banner can resize the viewport.
    if (ctx.cdpAllowed) await ensureAttached(tabId);
    // captureVisibleTab grabs the active tab of the window as a PNG data URL.
    const before = await documentState(ctx, true);
    if (!before.ok || !before.active || before.pending) return { ok: false, error: "Activate the stable target tab before capturing." };
    if (before.viewport.scale !== 1) return { ok: false, error: "Reset browser pinch zoom before capturing actionable coordinates." };
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const after = await documentState(ctx, true);
    if (!sameDocument(after, before) || before.geometry !== after.geometry ||
        JSON.stringify(before.viewport) !== JSON.stringify(after.viewport)) {
      return { ok: false, error: "Page or viewport changed during capture; retry." };
    }
    const data = dataUrl.split(",")[1];
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const capture = { id: crypto.randomUUID(), width: bitmap.width, height: bitmap.height, ...after, layoutBefore: before.layout };
    bitmap.close();
    captures.set(ctx, capture);
    return { ok: true, url: tab.url, screenshot_id: capture.id, width: capture.width, height: capture.height,
      viewport: capture.viewport, tab_id: tabId, document_token: capture.token,
      scroll_regions: (after.scroll_regions || []).map(region => ({ ...region,
        x: region.x * capture.width / capture.viewport.width, y: region.y * capture.height / capture.viewport.height })),
      image: { mediaType: "image/png", data }, note: "Viewport screenshot; pointer coordinates and scroll_regions centers use these image pixels. To scroll a panel, use its scroll_regions center rather than guessing. Canvas navigation uses pan." };
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

function waitForLoad(tabId, timeoutMs = 15000, signal) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      // The optional page read handles DOM settling.
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
    // In case it's already complete.
    chrome.tabs.get(tabId).then((t) => {
      if (t && t.status === "complete") finish();
    }).catch(finish);
  });
}
