// @ts-nocheck -- untyped happy-dom shims, same reason as captcha-happy.ts
/**
 * Make the shimmed platform APIs look native to the guest.
 *
 * The FeiLin SDK sweeps `Function.prototype.toString` over every platform
 * builtin it can reach and flags anything that does not answer
 * "[native code]". Two host-side hooks cover that: installNativeToString
 * masks the shimmed functions, and the eval funnel wraps every guest script
 * in a `with` scope so bare timer identifiers resolve to the solve's own
 * window. A guest heartbeat that escapes to the host lane outlives its window
 * and keeps the process awake.
 *
 * Separate from captcha-happy.ts because both hooks sit between happy-dom and
 * the guest and are the only code that reasons about the guest realm's scope
 * chain. The solver's state reaches them as arguments, never as imports.
 */
import { PropertySymbol } from "happy-dom";
import crypto from "node:crypto";
import fs from "node:fs";

// Guest scopes are keyed per window so concurrent solves never share timers:
// the wrapper reads `globalThis[GUEST_SCOPE_ROOT][id]` at RUN time, and each
// window gets its own id. A plain object (not a Map) because the wrapper text
// indexes it directly from guest source.
export const GUEST_SCOPE_ROOT = "__capGuestScopes";

/**
 * A `Function` stand-in for guest scope. `new Function(body)` compiles in the
 * GLOBAL scope, so a generated function would see the host timers again and
 * re-open the escape hatch (measured: its heartbeat outlived window close).
 * This variant re-wraps the generated body in the same `with` scope, so code
 * the pe bytecode VM generates at runtime inherits the window's timers too.
 * `eval` needs no equivalent: it inherits the caller's scope chain already.
 */
export function makeScopedFunction(w) {
  const Scoped = function (...args) {
    const body = args.length ? String(args[args.length - 1]) : "";
    const params = args.slice(0, -1).map(String).join(",");
    const id = w.__capScopeId;
    const source =
      `return function(${params}){with(globalThis.${GUEST_SCOPE_ROOT}[${JSON.stringify(id)}]){\n${body}\n}}`;
    return Function(source)();
  };
  // Guest fingerprint code sweeps name/toString over platform builtins.
  Scoped.prototype = Function.prototype;
  try {
    Object.defineProperty(Scoped, "name", { value: "Function", configurable: true });
    Object.defineProperty(Scoped, "toString", {
      value: () => "function Function() { [native code] }",
      configurable: true,
      writable: true,
    });
  } catch {}
  return Scoped;
}

/**
 * Wrap guest source so bare timer identifiers resolve to `w`'s registry.
 *
 * A bare `with (...) { ... }` statement, not a function wrapper, and that choice
 * carries both of the properties this needs:
 *
 * - **Top-level declarations keep escaping.** `with` introduces an object
 *   environment, not a variable one, so guest `var`/`function` declarations
 *   still land on the global object. A function wrapper swallows them and
 *   `initAliyunCaptcha` never appears -- every solve then timed out waiting
 *   for it (measured: ok=0 fail=3).
 *
 * - **The completion value still flows out.** happy-dom's JavaScriptCompiler
 *   hands `evaluateScript` a `(function anonymous($happy_dom){...})` expression
 *   and calls whatever comes back. `eval` yields a statement's completion
 *   value, and a block completes with its last expression statement, so the
 *   compiler's function expression is returned through the `with` unchanged.
 *   (Declarations produce no completion value, so a script ending in one is
 *   also fine -- the preceding expression's value stands.)
 */
function wrapGuestSource(code, filename, scopeId) {
  const sourceUrl = filename && /^https?:/.test(String(filename)) ? `\n//# sourceURL=${filename}` : "";
  const scopeRef = `globalThis.${GUEST_SCOPE_ROOT}[${JSON.stringify(scopeId)}]`;
  // The leading newline keeps guest line numbers aligned with the CDN
  // original; the trailing one guards a source ending in a line comment.
  return `with(${scopeRef}){\n${code}\n}${sourceUrl}`;
}

// -- Parse-fail instrumentation (host side) ---------------------------------
// Wraps happy-dom's VM eval funnel (window[PropertySymbol.evaluateScript]).
// Every script tag / compiled module / dynamic chunk that happy-dom parses
// passes through here with options.filename = source URL, so any SyntaxError
// is dumped with URL + length + head/tail + sha1, and the disk cache is
// re-validated against a fresh CDN fetch when the URL is an http(s) file.
//
// `deps` is what the hook needs from the solver (user agent for the re-fetch,
// the CDN cache path and the in-mem cache to evict); passing it keeps this
// module free of captcha-happy.ts state and of the import cycle that would
// follow.
export function installEvalInstrumentation(w, deps) {
  const { userAgent, diskPathFor, memCdnCache } = deps;
  const sym = PropertySymbol && PropertySymbol.evaluateScript;
  if (!sym || typeof w[sym] !== "function") {
    process.stderr.write("[instr] no evaluateScript symbol, host hook skipped\n");
    return;
  }
  const orig = w[sym];
  w[sym] = function (code, options) {
    const scopeId = w.__capScopeId;
    try {
      // Guest scripts run inside this window's `with` scope (wrapGuestSource):
      // this funnel is the single entry point for every script tag, compiled
      // module and dynamic pe/FeiLin chunk, so wrapping here covers them all.
      // Our own GUEST_EVAL_PATCH goes through w.eval() and is unaffected.
      if (scopeId) {
        try {
          return orig.call(this, wrapGuestSource(String(code ?? ""), options && options.filename, scopeId), options);
        } catch (scopeErr) {
          // Only a wrapper-induced parse failure (e.g. a top-level "use
          // strict" making `with` illegal) falls back -- a genuine error from
          // the guest body must propagate to the diagnostics path below.
          if (!(scopeErr instanceof SyntaxError)) throw scopeErr;
          process.stderr.write(
            `[instr] guest scope rejected (${scopeErr.message.slice(0, 80)}), evaluating unwrapped\n`,
          );
        }
      }
      return orig.call(this, code, options);
    } catch (err) {
      try {
        const src = String(code || "");
        const filename = (options && options.filename) || "?";
        const sha1 = crypto.createHash("sha1").update(src).digest("hex");
        process.stderr.write(
          `\n[EVAL-PARSE-FAIL] file=${filename} len=${src.length} sha1=${sha1}\n` +
            `  head300: ${JSON.stringify(src.slice(0, 300))}\n` +
            `  tail100: ${JSON.stringify(src.slice(-100))}\n` +
            `  err: ${err && err.message}\n`,
        );
        if (/^https?:/.test(filename)) {
          (async () => {
            try {
              const res = await fetch(filename, { headers: { "user-agent": userAgent } });
              const fresh = Buffer.from(await res.arrayBuffer());
              process.stderr.write(
                `[EVAL-CACHE-COMPARE] cachedLen=${src.length} freshLen=${fresh.length} freshSha1=${crypto.createHash("sha1").update(fresh).digest("hex")} http=${res.status}\n`,
              );
              if (fresh.length > 0 && fresh.length !== src.length) {
                process.stderr.write(`[EVAL-CACHE-MISMATCH] deleting ${diskPathFor(filename)} (stale/truncated cache)\n`);
                try {
                  fs.unlinkSync(diskPathFor(filename));
                } catch (_) {}
                memCdnCache.delete(filename);
              }
            } catch (fetchErr) {
              process.stderr.write(`[EVAL-CACHE-COMPARE-ERR] ${fetchErr.message}\n`);
            }
          })();
        }
      } catch (e2) {}
      throw err;
    }
  };
}

// -- Mask JS-implemented platform APIs as native (FeiLin toString sweep) -----
export function installNativeToString(w) {
  const realToString = Function.prototype.toString;
  const nativeRe = /\[native code\]/;
  const mask = (fn) => {
    if (typeof fn !== "function") return;
    try {
      if (nativeRe.test(realToString.call(fn))) return;
      const name = fn.name || "";
      const nativeStr = `function ${name}() { [native code] }`;
      Object.defineProperty(fn, "toString", {
        value: () => nativeStr,
        configurable: true,
        writable: true,
      });
    } catch (_) {}
  };
  const seen = new w.Set();
  const maskObj = (obj, depth) => {
    if (
      !obj ||
      (typeof obj !== "object" && typeof obj !== "function") ||
      depth > 5
    )
      return;
    // Skip host-realm objects (under Bun, installGlobalWindowAlias exposes
    // Bun internals via window getters; sweeping them crashes on native
    // internal-field slots). happy-dom objects live in the window realm.
    try {
      if (obj.constructor && obj.constructor.prototype !== Object.prototype) {
        const ctorName = obj.constructor.name;
        if (/^(WriteStream|ReadStream|Socket|Process|Timeout|Immediate)$/.test(ctorName)) return;
      }
    } catch (_) {}
    if (seen.has(obj)) return;
    try {
      seen.add(obj);
    } catch (_) {
      return;
    }
    let names = [];
    try {
      names = Object.getOwnPropertyNames(obj);
    } catch (_) {
      return;
    }
    for (const name of names) {
      if (name === "toString" || name === "constructor") continue;
      let desc;
      try {
        desc = Object.getOwnPropertyDescriptor(obj, name);
      } catch (_) {
        continue;
      }
      if (!desc) continue;
      if (typeof desc.value === "function") {
        mask(desc.value);
      } else if (typeof desc.get === "function") {
        mask(desc.get);
        try {
          const v = desc.get.call(obj);
          if (typeof v === "function") mask(v);
          // Probing a getter can hand back a promise that is already rejected
          // (WHATWG stream `closed`/`ready` reject when the receiver is the
          // prototype, not an instance). Nobody awaits these, so without a
          // sink each probe surfaced as an unhandledRejection during every
          // solve -- noise that buried real diagnostics.
          else if (v && typeof v.then === "function") v.catch(() => {});
        } catch {}
      }
      if (depth < 3) {
        try {
          const v = desc.value;
          if (v && (typeof v === "function" || typeof v === "object"))
            maskObj(v, depth + 1);
        } catch (_) {}
      }
    }
  };
  const targets = [
    w,
    w.navigator,
    w.document,
    w.Document && w.Document.prototype,
    w.Element && w.Element.prototype,
    w.HTMLElement && w.HTMLElement.prototype,
    w.Node && w.Node.prototype,
    w.EventTarget && w.EventTarget.prototype,
    w.HTMLCanvasElement && w.HTMLCanvasElement.prototype,
    w.XMLHttpRequest && w.XMLHttpRequest.prototype,
    w.Event && w.Event.prototype,
    w.Window && w.Window.prototype,
  ].filter(Boolean);
  for (const t of targets) {
    try {
      maskObj(t, 0);
    } catch (_) {}
  }
}
