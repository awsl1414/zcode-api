// @ts-nocheck -- untyped happy-dom shims, same reason as captcha-happy.ts
/**
 * Guest-realm plumbing for the happy-dom captcha window.
 *
 * Guest code is supposed to run inside a `with` scope over the solve's own
 * window, but the Aliyun SDK reaches around it: indirect evals, prototype
 * patches applied through `window.eval`, and (under Bun) script tags that
 * execute against the host globalThis. Three things keep that boundary
 * usable, and all three are about the same question, so they live together:
 * the guest-side patch string, the Node host-realm bridge that maps the
 * window's globals onto globalThis, and the Bun-only alias pass that does the
 * same job with getters.
 *
 * Separate from captcha-happy.ts because the alias pass alone is a refcounted
 * lifecycle with a tombstone grace period and a host-descriptor snapshot; none
 * of that state is read by the solver.
 */
export function makeGuestEvalPatch(debug) {
  return `
(function() {
  try {
    Object.defineProperty(Event.prototype, "isTrusted", {
      get() { return true; },
      configurable: true
    });
  } catch (e) {}
  try {
    if (window.HTMLDocument) {
      Object.defineProperty(window.HTMLDocument, "name", { value: "HTMLDocument", configurable: true });
      Object.defineProperty(window.HTMLDocument.prototype, Symbol.toStringTag, { value: "HTMLDocument", configurable: true });
    }
  } catch (e) {}
  try {
    Object.defineProperty(window.Document.prototype, Symbol.toStringTag, { value: "HTMLDocument", configurable: true });
  } catch (e) {}
  // Guest errors are RECORDED, not printed: the Aliyun/FeiLin SDKs throw
  // benign uncaught TypeErrors inside happy-dom on every solve (imperfect DOM
  // emulation) while the solve still succeeds -- printing them flooded the
  // console with [WINDOW-ERROR] spam. They land in window.__capErrs (capped,
  // deduped) which solveTraceless surfaces only when a solve FAILS.
  // CAPTCHA_DEBUG=1 streams them live again.
  var __capDebug = ${debug ? "true" : "false"};
  function __capRecord(kind, msg, stack) {
    try {
      var m = String(msg || "?");
      var s = String(stack || "").split("\\n").slice(0, 2).join(" | ");
      if (!window.__capErrs) window.__capErrs = [];
      var last = window.__capErrs[window.__capErrs.length - 1];
      if (last && last.k === kind && last.m === m) {
        last.n = (last.n || 1) + 1;
      } else {
        window.__capErrs.push({ k: kind, m: m, s: s, n: 1 });
        if (window.__capErrs.length > 8) window.__capErrs.shift();
      }
      if (__capDebug) console.error("[" + kind + "]", m, s);
    } catch (e2) {}
  }
  try {
    window.addEventListener("unhandledrejection", function(e) {
      var r = e && e.reason;
      __capRecord("UH-REASON", (r && r.message) || typeof r, r && r.stack);
    });
  } catch (e) {}
  try {
    window.addEventListener("error", function(e) {
      __capRecord("WINDOW-ERROR", e && e.message, e && e.error && e.error.stack);
    });
  } catch (e) {}
  // ---- eval/Function parse-fail instrumentation (installed before pe chain) ----
  // Catches SyntaxError from guest-side eval()/new Function() (the dynamic pe.*
  // chunk is evaluated this way in some SDK paths). Host-side twin: the
  // PropertySymbol.evaluateScript wrapper in installEvalInstrumentation().
  function __capFailDump(kind, code) {
    try {
      var src = String(code || "");
      if (typeof window.__capDebugDump === "function") {
        window.__capDebugDump(window.__lastPeUrl || "?", src, kind);
      } else {
        console.error("[" + kind + "] url=" + (window.__lastPeUrl || "?") + " len=" + src.length + " head=" + JSON.stringify(src.slice(0, 300)) + " tail=" + JSON.stringify(src.slice(-100)));
      }
    } catch (e2) {}
  }
  try {
    var _origEval2 = window.eval;
    if (_origEval2) {
      window.eval = function(code) {
        try { return _origEval2.call(window, code); }
        catch (e) {
          if (e && (/unexpected|invalid|parse|syntax/i.test(String((e && e.message) || e)))) {
            __capFailDump("REALM-EVAL-FAIL", code);
          }
          throw e;
        }
      };
    }
  } catch (e) {}
  try {
    var _of = window.Function;
    if (_of) {
      var _WF = function() {
        var args = Array.prototype.slice.call(arguments);
        var body = args.length ? String(args[args.length - 1]) : "";
        try { return _of.apply(this, args); }
        catch (e) {
          if (e && (/unexpected|invalid|parse|syntax/i.test(String((e && e.message) || e)))) {
            __capFailDump("REALM-FN-FAIL", body);
          }
          throw e;
        }
      };
      _WF.prototype = _of.prototype;
      try { Object.defineProperty(_WF, "name", { value: "Function", configurable: true }); } catch (e) {}
      window.Function = _WF;
    }
  } catch (e) {}
})();
`;
}

/**
 * Host-realm aliases for the happy-dom window globals (see the call site in
 * solveTraceless). defineProperty so Node's getter-only globals (navigator)
 * are overridable; the saved descriptors are restored verbatim.
 */
// Globals that must stay the host's own even during a solve (the proxy's
// request path depends on them; `fetch` especially must remain the runtime's
// — the interceptor layer already routes guest traffic deliberately).
// HOST_CRITICAL_GLOBALS (defined below) is unioned in at INSTALL time: it
// carries the WHATWG fetch/stream family (Response/Headers/Request/...)
// and the JS intrinsics that the proxy hot path `instanceof`-checks against
// — shadowing any of them on a shared realm (in-process fallback) breaks
// concurrently served traffic. Module-scope const order makes a static
// union impossible here; the union is recomputed per install.
const GUEST_REALM_DENY = new Set([
  "process", "Buffer", "require", "module", "exports", "global", "globalThis",
  "fetch", "console", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "setImmediate", "clearImmediate", "queueMicrotask", "structuredClone", "crypto",
  "performance", "TextEncoder", "TextDecoder", "URL", "URLSearchParams",
  "AbortController", "AbortSignal", "atob", "btoa", "eval", "Function",
  "Worker", "SharedArrayBuffer", "Atomics",
]);
let _realmGlobalsOwner = null;
let _realmGlobalsRestore = null;
/**
 * Bridge the happy-dom window's own properties onto the host realm. The
 * Aliyun SDK escapes its `with` guest scope through indirect evals that
 * resolve bare identifiers (`window`, `XMLHttpRequest`, …) in the HOST
 * realm; under Bun those already resolve (guest host-realm execution) —
 * and under Bun the bridge MUST NOT run: on the in-process fallback the
 * host realm is the proxy's own, and the union'd DENY would still be a
 * change surface for nothing. Node-only by design (the off-Bun worker thread,
 * and off-Bun in-process fallback where the worker entry is missing). The
 * aliases live for the window's lifetime (createDom →
 * destroyDom); the DENY union keeps the proxy's own runtime globals
 * untouched even there.
 */
function installGuestRealmGlobals(w) {
  const saved = Object.create(null);
  let names;
  try {
    names = Object.getOwnPropertyNames(w);
  } catch (_) {
    names = [];
  }
  for (const name of names) {
    try {
      if (GUEST_REALM_DENY.has(name) || HOST_CRITICAL_GLOBALS.has(name)) continue;
      const value = w[name];
      const kind = typeof value;
      if (kind !== "function" && (kind !== "object" || value === null)) continue;
      if (name in saved) continue; // first descriptor wins
      saved[name] = Object.getOwnPropertyDescriptor(globalThis, name) ?? null;
      Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
    } catch (_) {}
  }
  return () => {
    for (const name of Object.keys(saved)) {
      try {
        const d = saved[name];
        if (d) Object.defineProperty(globalThis, name, d);
        else delete globalThis[name];
      } catch (_) {}
    }
  };
}
/** Idempotent per-window install: the aliases live for the window's lifetime
 *  (createDom → destroyDom), so pooled reuse needs no re-install. Node only —
 *  see installGuestRealmGlobals. */
export function ensureGuestRealmGlobals(w) {
  if (typeof Bun !== "undefined") return; // Bun host realm already resolves these
  if (_realmGlobalsOwner === w) return;
  if (_realmGlobalsRestore) _realmGlobalsRestore();
  _realmGlobalsRestore = installGuestRealmGlobals(w);
  _realmGlobalsOwner = w;
}
export function releaseGuestRealmGlobals(w) {
  if (_realmGlobalsOwner !== w) return;
  if (_realmGlobalsRestore) _realmGlobalsRestore();
  _realmGlobalsRestore = null;
  _realmGlobalsOwner = null;
}
/** Test seam: descriptor save/restore contract of the Node realm bridge. */
export function __realmGlobalsLifecycle(w) {
  const restore = installGuestRealmGlobals(w);
  return restore;
}

// Bun-only: alias the active window on globalThis (script tags run in the
// host realm under Bun). Every own enumerable window property is exposed as a
// getter so guest scripts resolving bare identifiers (window, document,
// XMLHttpRequest, Range, HTMLElement, ...) find them, exactly as Node's VM
// realm would. Removed again in destroyDom.
// Names that must NOT be shadowed on globalThis -- Bun/Node host internals the
// window happens to expose but the host runtime depends on.
const HOST_CRITICAL_GLOBALS = new Set([
  "process", "Bun", "console", "performance", "crypto", "fetch",
  "queueMicrotask", "structuredClone", "TextEncoder", "TextDecoder",
  // Timers stay pristine on globalThis so Bun internals keep real Node timer
  // objects (`.unref()`); guest code gets the window's registry lexically.
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  // NOTE: requestAnimationFrame/cancelAnimationFrame were removed from this
  // list (2026-09-06). Bun has no native rAF, so skipping the alias left a
  // bare `requestAnimationFrame` in the FeiLin bundle unresolvable (9 call
  // sites, only one `typeof`-guarded) -- the same silent fingerprint
  // degradation that `print` caused. Aliasing the window's implementation
  // shadows nothing on the host.
  // NOTE: `print` was removed from this list (2026-08-29). The polyfill
  // defines a harmless no-op on the window, but the alias pass skipped it,
  // so under Bun (guest scripts run in the HOST realm) the Aliyun pe risk
  // engine hit a bare `print` reference -> ReferenceError -> broken
  // fingerprint chain -> degraded solve success rate (711 WINDOW-ERRORs in
  // one day). Bun's host global has no native `print`, so aliasing the
  // stub shadows nothing critical.
  "URL", "URLSearchParams", "AbortController", "AbortSignal",
  "ReadableStream", "WritableStream", "TransformStream", "Blob", "File",
  "FormData", "Headers", "Request", "Response", "Event", "EventTarget",
  "MessageChannel", "MessagePort", "Buffer", "global", "globalThis",
  // JS intrinsics -- GlobalWindow re-exposes them as class fields; the host
  // versions are fine, so never shadow them.
  "Array", "ArrayBuffer", "Boolean", "DataView", "Date", "Error",
  "EvalError", "Float32Array", "Float64Array", "Function", "Infinity",
  "Int8Array", "Int16Array", "Int32Array", "Intl", "JSON", "Map", "Math",
  "NaN", "Number", "Object", "Promise", "RangeError", "ReferenceError",
  "RegExp", "Reflect", "Set", "String", "Symbol", "SyntaxError", "TypeError",
  "URIError", "Uint8Array", "Uint8ClampedArray", "Uint16Array", "Uint32Array",
  "WeakMap", "WeakSet", "decodeURI", "decodeURIComponent", "encodeURI",
  "encodeURIComponent", "escape", "isFinite", "isNaN", "parseFloat",
  "parseInt", "unescape", "eval",
]);
// Window methods that exist as prototype members, not own props -- the alias
// pass must include them so guest bare-name references resolve (moveBy,
// scrollTo, ... are referenced by the FeiLin fingerprint SDK).
const EXTRA_WINDOW_PROPS = [
  "moveBy", "moveTo", "resizeBy", "resizeTo", "scrollTo", "scrollBy", "scroll",
  "open", "close", "stop", "focus", "blur", "print", "alert", "confirm",
  "prompt", "getSelection", "find",
];
// Subset of the above that a real browser implements as no-op-ish window
// methods. When the tombstone expires these become harmless stubs instead of
// being deleted, so a straggling guest callback that still calls `moveBy()`
// completes silently rather than raising a fatal ReferenceError.
const INERT_WINDOW_METHODS = new Set(EXTRA_WINDOW_PROPS);

// Ref-count: the pool solves in parallel waves; each window must keep the
// aliases alive until the LAST concurrent window is destroyed, otherwise one
// destroyDom() pulls `window` out from under a sibling mid-solve.
let _aliasRefCount = 0;

// Post-teardown tombstone (see removeGlobalWindowAlias): how long window-
// sourced alias getters keep resolving -- to the CLOSED window -- after the
// last destroyDom. Guest (FeiLin) async fingerprint chains ride host
// machinery (fetch/promise continuations) and can outlive the window; a
// hard delete turns their next bare `Text`/`document` reference into an
// uncaught ReferenceError (v4.5.2 field report: "Text is not defined" from
// feilin005.js). The closed window's objects stay readable, so stragglers
// run harmlessly to completion; a new solve wave (generation bump) cancels
// the pending deletion entirely. The pristine host setTimeout captured at
// module load schedules it -- never the aliased one.
const ALIAS_TOMBSTONE_MS = 30_000;
let _aliasGeneration = 0;
let _tombstoneMs = ALIAS_TOMBSTONE_MS;
const _hostSetTimeout = globalThis.setTimeout;
// Every getter this module installs on the alias target (generic window
// forwarders, window/self/top/parent, dual timers, __capWindowFor). The
// host-global snapshot skips descriptors whose getter is in here: a wave
// that starts inside a previous wave's grace period finds OUR OWN stale
// accessors still on `g`, and saving them would "restore" window accessors
// at removal -- permanently pinning the first closed window (review-caught
// 2026-08-31). Host getters (Bun's navigator/self accessors) are never in
// this set and always flow to the restore path.
const _aliasGetters = new WeakSet<object>();

// Same save/restore contract for every HOST-EXISTING global the alias pass
// overwrites (see installGlobalWindowAlias for the rationale). Captured on the
// FIRST install of a wave (globals are pristine then), restored on the last
// remove.
let _savedHostGlobalDescriptors: Record<string, PropertyDescriptor> | undefined;

// Guest timer/console routing is LEXICAL (see the guest scope section above):
// bare `setTimeout`/`console` inside guest source resolve through the `with`
// scope to this window's own objects. No stack sniffing -- the previous
// `/alicdn/.test(new Error().stack)` predicate answered "who is calling?" when
// the question is "who owns this?", and got both directions wrong (immortal
// guest heartbeats; host timers stripped of `.unref`).
//
// So globalThis keeps the PRISTINE host timers at all times, and Bun internals
// (node:_http_server keep-alive, undici, AbortSignal.timeout) always get real
// Node timer objects with an intact ref/unref contract.

// Both take (g, w) explicitly so tests can drive the lifecycle against a
// sandbox global. `tombstoneMs` (tests only) shortens the grace period.
export function installGlobalWindowAlias(g, w, tombstoneMs?) {
  // Clamp a negative refcount: an unbalanced remove would otherwise land the
  // NEXT install at 0 instead of 1 and skip the host-global snapshot, so
  // teardown could never restore what it overwrote.
  if (_aliasRefCount < 0) _aliasRefCount = 0;
  _aliasRefCount += 1;
  _aliasGeneration += 1; // cancels any pending tombstone from a prior wave
  _tombstoneMs = typeof tombstoneMs === "number" ? tombstoneMs : ALIAS_TOMBSTONE_MS;
  // Build the alias name set FIRST, then snapshot every HOST-EXISTING global
  // in it BEFORE anything is aliased. The generic props loop below overwrites
  // them with window-forwarding accessors (GlobalWindow own props outside
  // HOST_CRITICAL_GLOBALS); a capture taken after it would save those
  // accessors and the post-remove restore would reinstate accessors onto a
  // closed window. The snapshot covers atob/btoa (client-signing's base64 --
  // field-reported ReferenceError), WebSocket, MessageEvent, CustomEvent,
  // navigator, self, ... -- every host global the window happens to expose.
  const props = new Set(Object.getOwnPropertyNames(w));
  for (const name of EXTRA_WINDOW_PROPS) props.add(name);
  // also walk the prototype chain one level (BrowserWindow getters like
  // navigator/location live there in some versions)
  for (const proto = Object.getPrototypeOf(w); proto && proto !== Object.prototype;) {
    for (const name of Object.getOwnPropertyNames(proto)) props.add(name);
    break;
  }
  if (_aliasRefCount === 1 && !_savedHostGlobalDescriptors) {
    const saved: Record<string, PropertyDescriptor> = {};
    for (const prop of props) {
      if (prop === "constructor" || HOST_CRITICAL_GLOBALS.has(prop)) continue;
      try {
        const d = Object.getOwnPropertyDescriptor(g, prop);
        // Skip OUR OWN stale accessors from a previous wave that was
        // cancelled mid-grace (retry ladder / pool bursts start the next
        // wave within the 30s tombstone): saving them would "restore"
        // window-forwarding accessors at removal and permanently pin the
        // first closed window on globalThis. They are window-sourced -- the
        // new wave's tombstone owns their cleanup. Host getters (Bun's
        // navigator/self accessors) are never in the WeakSet and keep
        // flowing to the restore path.
        if (d && d.get && _aliasGetters.has(d.get)) continue;
        if (d) saved[prop] = d;
      } catch (_) {}
    }
    for (const prop of ["window", "self", "top", "parent", "__capWindowFor"]) {
      try {
        const d = Object.getOwnPropertyDescriptor(g, prop);
        if (d && d.get && _aliasGetters.has(d.get)) continue;
        if (d && !saved[prop]) saved[prop] = d;
      } catch (_) {}
    }
    _savedHostGlobalDescriptors = saved;
  }
  for (const prop of props) {
    if (HOST_CRITICAL_GLOBALS.has(prop)) continue;
    try {
      const getter = function () { return w[prop]; };
      _aliasGetters.add(getter);
      Object.defineProperty(g, prop, {
        get: getter,
        set(v) {
          try { w[prop] = v; } catch (_) {}
        },
        configurable: true,
      });
    } catch (_) {}
  }
  // w.window/self may not exist as own props on this happy-dom build
  for (const prop of ["window", "self", "top", "parent"]) {
    try {
      const getter = function () { return w; };
      _aliasGetters.add(getter);
      Object.defineProperty(g, prop, { get: getter, configurable: true });
    } catch (_) {}
  }
  // Timers are deliberately NOT aliased: globalThis keeps Bun's pristine
  // functions so node:_http_server keep-alive, undici and AbortSignal.timeout
  // always receive real Node timer objects with an intact `.unref()`. Guest
  // code reaches the window's registry through the lexical `with` scope
  // instead, so its callbacks still die in happyDOM.close().
  // Dynamic catch-all: guest code occasionally references window methods that
  // only exist on the prototype (moveBy, scrollTo, ...) or lands mid-solve on
  // new props. Proxy fallback for any still-missing global property.
  try {
    const capGetter = function () { return w; };
    _aliasGetters.add(capGetter);
    Object.defineProperty(g, "__capWindowFor", {
      get: capGetter,
      configurable: true,
    });
  } catch (_) {}
}
export function removeGlobalWindowAlias(g, w) {
  _aliasRefCount -= 1;
  if (_aliasRefCount > 0) return;
  // Host-contract globals come back IMMEDIATELY: every HOST-EXISTING global
  // the wave overwrote -- atob/btoa (client-signing's JWT base64 -- the
  // field-reported ReferenceError), WebSocket/MessageEvent/navigator/self/...
  // The timers and console were never aliased, so nothing to restore there.
  const restored = new Set<string>();
  if (_savedHostGlobalDescriptors) {
    for (const [name, desc] of Object.entries(_savedHostGlobalDescriptors)) {
      try { Object.defineProperty(g, name, desc); } catch (_) {}
      restored.add(name);
    }
    _savedHostGlobalDescriptors = undefined;
  }
  // Window-sourced globals get a TOMBSTONE grace period instead of an
  // immediate delete (see the ALIAS_TOMBSTONE_MS comment). Collect what is
  // still accessor-aliased, EXCLUDING the restored set -- a restored host
  // descriptor may itself be a getter (Bun's navigator/self are accessors)
  // and must never be tombstone-deleted.
  const generation = _aliasGeneration;
  const names: string[] = [];
  try {
    for (const name of Object.getOwnPropertyNames(w)) {
      if (restored.has(name)) continue;
      try {
        if (Object.getOwnPropertyDescriptor(g, name)?.get) names.push(name);
      } catch (_) {}
    }
    for (const prop of ["window", "self", "top", "parent", "__capWindowFor"]) {
      if (restored.has(prop)) continue;
      try {
        if (Object.getOwnPropertyDescriptor(g, prop)?.get) names.push(prop);
      } catch (_) {}
    }
  } catch (_) {}
  try {
    const t = _hostSetTimeout(() => {
      if (generation !== _aliasGeneration || _aliasRefCount > 0) return;
      for (const name of names) {
        try {
          if (!Object.getOwnPropertyDescriptor(g, name)?.get) continue;
          // Do NOT `delete`: a straggler still reading the name would get a
          // ReferenceError, which is fatal in the host realm. Leave an inert
          // value instead -- the reference resolves, the call is a no-op, and
          // nothing keeps the closed window alive. The window methods guest
          // fingerprint code probes (moveBy/scrollTo/...) are no-ops in a real
          // browser anyway, so `undefined` is a faithful stand-in for the rest.
          const stub = INERT_WINDOW_METHODS.has(name) ? () => {} : undefined;
          Object.defineProperty(g, name, {
            value: stub,
            configurable: true,
            writable: true,
          });
        } catch (_) {}
      }
    }, _tombstoneMs);
    try {
      if (t && typeof t.unref === "function") t.unref();
    } catch (_) {}
  } catch (_) {}
}
