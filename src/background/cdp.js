// Chrome DevTools Protocol integration via chrome.debugger.
//
// Powers the debugging tools (read_console / read_network). Attaching shows
// Chrome's "started debugging this browser" banner, so this is only used when
// the user turns on Advanced automation, and we detach at the end of each task.
//
// Buffers capture activity that happens AFTER attach — to see load-time errors,
// the agent can read once (attaching), reload, then read again.

const attached = new Map(); // tabId -> { console: [], network: Map(requestId -> rec) }
let listenerBound = false;

const MAX_CONSOLE = 500;
const MAX_NETWORK = 500;

export async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  bindListeners();
  await debuggerAttach(tabId);
  attached.set(tabId, { console: [], network: new Map() });
  // Enable the domains we read from. Some may fail on restricted pages — ignore.
  await sendCommand(tabId, "Runtime.enable").catch(() => {});
  await sendCommand(tabId, "Log.enable").catch(() => {});
  await sendCommand(tabId, "Network.enable").catch(() => {});
}

export async function readConsole(tabId, opts = {}) {
  const { onlyErrors = false, limit = 50 } = opts;
  await ensureAttached(tabId);
  let items = attached.get(tabId).console;
  if (onlyErrors) items = items.filter((i) => /error|warning/i.test(i.level || ""));
  return {
    ok: true,
    monitoring: true,
    messages: items.slice(-limit),
    note: items.length
      ? undefined
      : "No console messages captured yet. Console/network monitoring starts when you first read; reload the page (navigate) and read again to catch load-time messages.",
  };
}

export async function readNetwork(tabId, opts = {}) {
  const { urlPattern, limit = 50 } = opts;
  await ensureAttached(tabId);
  let items = [...attached.get(tabId).network.values()];
  if (urlPattern) {
    let re;
    try {
      re = new RegExp(urlPattern, "i");
    } catch {
      re = null;
    }
    if (re) items = items.filter((i) => re.test(i.url));
  }
  return {
    ok: true,
    monitoring: true,
    requests: items.slice(-limit),
    note: items.length ? undefined : "No network requests captured yet — reload the page and read again.",
  };
}

// True while the debugger is attached to this tab.
export function isAttached(tabId) {
  return attached.has(tabId);
}

// Dispatch real (trusted) key events through CDP's Input domain. Canvas
// editors such as Google Docs ignore the synthetic KeyboardEvents a content
// script can dispatch (isTrusted: false) and only react to input from the
// browser's own pipeline — which is what Input.dispatchKeyEvent feeds. Keys
// use the press_keys shape: modifiers first, main key last, e.g.
// ["Shift", "End"] or ["Control", "k"].
export async function sendKeyEvents(tabId, keys) {
  try {
    await ensureAttached(tabId);
  } catch (e) {
    return { ok: false, error: "Could not attach the debugger to send key input: " + (e.message || e) };
  }
  const tokens = (Array.isArray(keys) ? keys : String(keys || "").split("+"))
    .map((k) => String(k || "").trim())
    .filter(Boolean);
  if (!tokens.length) return { ok: false, error: "No keys provided." };

  const mods = [];
  let main = null;
  for (const t of tokens) {
    const canon = canonicalKey(t);
    const mod = MODIFIERS[canon];
    if (mod) mods.push(mod);
    else main = canon;
  }
  const mask = mods.reduce((m, mod) => m | mod.bits, 0);

  try {
    for (const mod of mods) {
      await keyEvent(tabId, "keyDown", { modifiers: mask, key: mod.key, code: mod.code, windowsVirtualKeyCode: mod.vk });
    }
    if (main) {
      const info = keyInfo(main);
      await keyEvent(tabId, "keyDown", { modifiers: mask, key: info.key, code: info.code, windowsVirtualKeyCode: info.vk });
      // A printable key with no modifiers also needs a char event to type.
      if (info.text && mask === 0) {
        await keyEvent(tabId, "char", { text: info.text, key: info.key });
      }
      await keyEvent(tabId, "keyUp", { modifiers: mask, key: info.key, code: info.code, windowsVirtualKeyCode: info.vk });
    }
    for (const mod of mods.reverse()) {
      await keyEvent(tabId, "keyUp", { modifiers: mask, key: mod.key, code: mod.code, windowsVirtualKeyCode: mod.vk });
    }
  } catch (e) {
    return { ok: false, error: "Key dispatch failed: " + (e.message || e) };
  }
  return { ok: true, pressed: tokens.join("+") };
}

async function keyEvent(tabId, type, params) {
  await sendCommand(tabId, "Input.dispatchKeyEvent", { type, ...params });
}

// Insert text as real (trusted) input into whatever element is focused — the
// CDP counterpart of typing. Rich canvas editors (Google Docs) ignore DOM
// value changes and synthetic events, but accept this the way they accept a
// real keystroke. Used by type_text when the target is a rich editor.
export async function insertText(tabId, text) {
  try {
    await ensureAttached(tabId);
    await sendCommand(tabId, "Input.insertText", { text: String(text ?? "") });
  } catch (e) {
    return { ok: false, error: "Could not insert text through the debugger: " + (e.message || e) };
  }
  return { ok: true };
}

// CDP modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8.
const MODIFIERS = {
  alt: { bits: 1, key: "Alt", code: "AltLeft", vk: 18 },
  control: { bits: 2, key: "Control", code: "ControlLeft", vk: 17 },
  meta: { bits: 4, key: "Meta", code: "MetaLeft", vk: 91 },
  shift: { bits: 8, key: "Shift", code: "ShiftLeft", vk: 16 },
};

const SPECIAL_KEYS = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9, text: "\t" },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
};
for (let i = 1; i <= 12; i++) {
  SPECIAL_KEYS["f" + i] = { key: "F" + i, code: "F" + i, vk: 111 + i };
}

// Spelling variants models use for the same key.
const KEY_ALIASES = {
  ctrl: "control", cmd: "meta", command: "meta", win: "meta", super: "meta",
  esc: "escape", del: "delete", pgup: "pageup", pgdn: "pagedown",
  arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right",
};

function canonicalKey(token) {
  const t = String(token || "").toLowerCase();
  return KEY_ALIASES[t] || t;
}

function keyInfo(token) {
  const special = SPECIAL_KEYS[token];
  if (special) return special;
  // A single printable character: letters report the uppercase virtual key
  // code, matching a real keyboard.
  if (token.length === 1) {
    const code = token.charCodeAt(0);
    const isLetter = code >= 97 && code <= 122;
    return {
      key: token,
      code: isLetter ? "Key" + token.toUpperCase() : token,
      vk: isLetter ? token.toUpperCase().charCodeAt(0) : code,
      text: token,
    };
  }
  // Unknown multi-character name: pass it through; browsers match on `key`.
  return { key: token, code: token, vk: 0 };
}

// Called at the end of every task so the debugger banner goes away.
export async function detachAll() {
  for (const tabId of [...attached.keys()]) {
    await debuggerDetach(tabId);
    attached.delete(tabId);
  }
}

// -------------------------------------------------------------------------

function bindListeners() {
  if (listenerBound) return;
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener((source) => attached.delete(source.tabId));
  listenerBound = true;
}

function onEvent(source, method, params) {
  const buf = attached.get(source.tabId);
  if (!buf) return;
  switch (method) {
    case "Runtime.consoleAPICalled": {
      const text = (params.args || []).map(remoteToText).join(" ");
      pushConsole(buf, { level: params.type, text: clip(text) });
      break;
    }
    case "Runtime.exceptionThrown": {
      const d = params.exceptionDetails || {};
      const text = (d.exception && (d.exception.description || d.exception.value)) || d.text || "Uncaught exception";
      pushConsole(buf, { level: "error", text: clip(text) });
      break;
    }
    case "Log.entryAdded": {
      const e = params.entry || {};
      pushConsole(buf, { level: e.level, text: clip(e.text), source: e.source, url: e.url && clip(e.url, 200) });
      break;
    }
    case "Network.requestWillBeSent": {
      const r = params.request || {};
      buf.network.set(params.requestId, { method: r.method, url: clip(r.url, 300), status: null });
      trim(buf.network, MAX_NETWORK);
      break;
    }
    case "Network.responseReceived": {
      const rec = buf.network.get(params.requestId);
      if (rec && params.response) {
        rec.status = params.response.status;
        rec.mimeType = params.response.mimeType;
      }
      break;
    }
    case "Network.loadingFailed": {
      const rec = buf.network.get(params.requestId);
      if (rec) {
        rec.status = "failed";
        rec.error = params.errorText;
      }
      break;
    }
  }
}

function pushConsole(buf, entry) {
  buf.console.push(entry);
  if (buf.console.length > MAX_CONSOLE) buf.console.splice(0, buf.console.length - MAX_CONSOLE);
}

function trim(map, max) {
  while (map.size > max) map.delete(map.keys().next().value);
}

function remoteToText(o) {
  if (!o) return "";
  if ("value" in o) return typeof o.value === "object" ? JSON.stringify(o.value) : String(o.value);
  return o.description || o.type || "";
}

function clip(s, n = 500) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function debuggerAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

function debuggerDetach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError; // ignore "not attached"
      resolve();
    });
  });
}

function sendCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });
}
