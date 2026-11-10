// @ts-nocheck -- ported from the proven Node happy-dom solver (solve-happy-lib.js)
/**
 * captcha-happy.ts -- in-process happy-dom Aliyun captcha solver.
 *
 * Ported from the production-proven standalone happy-dom solver to run
 * INSIDE the Bun process so the release binary stays self-contained:
 * no external Node.js, no canvas/playwright/Chromium.
 *
 * Mechanics:
 *  1. cookie priming of https://zcode.z.ai/ (5-min cache)
 *  2. CDN disk cache at ~/.zcode-captcha-cdn-cache/<sha1(url)> + in-mem cache
 *  3. installNativeToString (mask JS-implemented platform APIs as native)
 *  4. per-request client-hint / UA / origin / referer injection (interceptor)
 *  5. guest-side patches (Event.isTrusted, HTMLDocument naming, btoa)
 *  6. solve contract: initAliyunCaptcha + getInstance().startTracelessVerification()
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { installCanvasPolyfills } from "./captcha-polyfill-canvas.js";
import { createDomBuilder } from "./captcha-dom-build.js";
import { createInterceptorLayer } from "./captcha-interceptor.js";
import { installDomPolyfills } from "./captcha-polyfill-dom.js";
import {
  GUEST_SCOPE_ROOT,
  installEvalInstrumentation,
  installNativeToString,
  makeScopedFunction,
} from "./captcha-polyfill-native.js";
import {
  ensureGuestRealmGlobals,
  installGlobalWindowAlias,
  makeGuestEvalPatch,
  releaseGuestRealmGlobals,
  removeGlobalWindowAlias,
} from "./captcha-polyfill-guest-realm.js";

// -- Blocking fetch for sync XHR (self-contained builds) --------------------
// happy-dom implements sync XHR by spawning `process.argv[0] -e <script>`,
// which fails inside a compiled Bun binary (argv[0] is the binary; `-e` is
// not supported). We instead run the request on a worker thread that writes
// the result into a SharedArrayBuffer and wakes the blocked host thread via
// Atomics -- no child processes, no main-thread event loop dependency (a
// postMessage-based handshake would deadlock: the main thread is blocked).
const SYNC_FETCH_BUF_BYTES = 8 * 1024 * 1024;
const SYNC_FETCH_HEADER_BYTES = 64;
// A stalled sync XHR blocks its thread (Atomics.wait) — on the in-process
// fallback path that thread is the proxy's main event loop, so a stalled
// aliyuncs POST must not wedge every connection for half a minute (the
// worker path is additionally bounded by the outer terminate).
const SYNC_FETCH_TIMEOUT_MS = 12_000;
// SAB layout (Int32 words): [0]=state (0=wait,1=done,2=error), [1]=httpStatus,
// [2]=statusTextLen, [3]=headersJsonLen, [4]=setCookieJsonLen, [5]=bodyLen,
// [6..]=payload bytes (statusText, headersJson, setCookieJson, body)
let _syncFetchWorker: Worker | null = null;

const SYNC_WORKER_SRC = `
  const { parentPort } = require("node:worker_threads");
  const https = require("node:https");
  const http = require("node:http");
  const enc = new TextEncoder();
  // node:http(s) with Happy Eyeballs + manual redirect following (plain
  // fetch here wedges on IPv6-blackholed CDN answers — see the dispatcher
  // note in captcha-happy.ts; the eval worker must stay builtin-only).
  function requestOnce(url, init, timeoutMs) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const mod = u.protocol === "http:" ? http : https;
      const headers = Object.assign({}, init.headers || {});
      delete headers["accept-encoding"]; // no transparent decompression here
      const req = mod.request(u, {
        method: init.method || "GET",
        headers,
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
      }, resolve);
      // Idle-socket timer (resets on activity) + a TOTAL deadline: a
      // slow-drip response must not outlive the host's Atomics cap and
      // wedge the single-flight sync worker behind a zombie request.
      req.setTimeout(timeoutMs, () => req.destroy(new Error("socket idle timeout")));
      const total = setTimeout(() => req.destroy(new Error("headers timeout (total)")), timeoutMs);
      req.on("error", (err) => { clearTimeout(total); reject(err); });
      req.on("close", () => clearTimeout(total));
      if (init.body) req.end(Buffer.from(init.body));
      else req.end();
    });
  }
  async function robustFetch(url, init, timeoutMs) {
    let cur = url, method = init.method || "GET", body = init.body;
    for (let hop = 0; hop < 6; hop++) {
      const res = await requestOnce(cur, { method, headers: init.headers, body }, timeoutMs);
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        if (code === 301 || code === 302 || code === 303) { method = "GET"; body = undefined; }
        res.resume();
        cur = new URL(res.headers.location, cur).href;
        continue;
      }
      const chunks = [];
      for await (const c of res) chunks.push(c);
      return { res, body: Buffer.concat(chunks) };
    }
    throw new Error("too many redirects");
  }
  parentPort.on("message", (m) => {
    (async () => {
      const i32 = new Int32Array(m.sab);
      const u8 = new Uint8Array(m.sab);
      // Fixed-size header (bytes), NOT i32.length * 4 -- that is the whole SAB.
      const payloadAt = 64;
      const fail = (msg) => {
        const b = enc.encode(msg);
        u8.set(b, payloadAt);
        i32[5] = b.length; i32[1] = 0; i32[2] = 0; i32[3] = 0; i32[4] = 0;
        i32[0] = 2; Atomics.notify(i32, 0);
      };
      try {
        const { res, body } = await robustFetch(m.url, m.init, m.timeoutMs || 12000);
        const statusText = enc.encode(res.statusMessage || "");
        const headersJson = enc.encode(JSON.stringify(res.headers || {}));
        const setCookieJson = enc.encode(JSON.stringify(res.headers["set-cookie"] || []));
        let off = payloadAt;
        u8.set(statusText, off); i32[2] = statusText.length; off += statusText.length;
        u8.set(headersJson, off); i32[3] = headersJson.length; off += headersJson.length;
        u8.set(setCookieJson, off); i32[4] = setCookieJson.length; off += setCookieJson.length;
        u8.set(body, off); i32[5] = body.length;
        i32[1] = res.statusCode || 0;
        i32[0] = 1; Atomics.notify(i32, 0);
      } catch (err) {
        fail(String((err && err.message) || err));
      }
    })();
  });
`;

function ensureSyncFetchWorker(): Worker {
  if (_syncFetchWorker) return _syncFetchWorker;
  _syncFetchWorker = new Worker(SYNC_WORKER_SRC, { eval: true });
  return _syncFetchWorker;
}

function syncFetchBlocking(url: string, init: Record<string, unknown>, timeoutMs = SYNC_FETCH_TIMEOUT_MS): {
  status: number; statusText: string; headers: Record<string, string>;
  setCookie: string[]; body: Buffer;
} | { error: string } {
  try {
    const worker = ensureSyncFetchWorker();
    const sab = new SharedArrayBuffer(SYNC_FETCH_HEADER_BYTES + SYNC_FETCH_BUF_BYTES);
    const i32 = new Int32Array(sab);
    const u8 = new Uint8Array(sab);
    worker.postMessage({ sab, url, init, timeoutMs });
    const waitResult = Atomics.wait(i32, 0, 0, timeoutMs);
    if (waitResult === "timed-out") return { error: "sync fetch timeout" };
    const dec = new TextDecoder();
    const payloadAt = SYNC_FETCH_HEADER_BYTES;
    let off = payloadAt;
    const readSlice = (len: number) => {
      const slice = u8.subarray(off, off + len);
      off += len;
      return slice;
    };
    const statusText = dec.decode(readSlice(i32[2]));
    const headers = i32[3] ? (JSON.parse(dec.decode(readSlice(i32[3]))) as Record<string, string>) : {};
    const setCookie = i32[4] ? (JSON.parse(dec.decode(readSlice(i32[4]))) as string[]) : [];
    const body = Buffer.from(readSlice(i32[5]));
    if (i32[0] === 2) return { error: dec.decode(u8.subarray(payloadAt, payloadAt + i32[5])) || "sync fetch failed" };
    return { status: i32[1], statusText, headers, setCookie, body };
  } catch (err: any) {
    // A crashed worker must not poison later solves -- reset it.
    try { _syncFetchWorker?.terminate(); } catch {}
    _syncFetchWorker = null;
    return { error: `sync fetch error: ${err?.message ?? err}` };
  }
}

function shutdownSyncFetchWorker(): void {
  try { _syncFetchWorker?.terminate(); } catch {}
  _syncFetchWorker = null;
}

const CDN_CACHE_DIR = path.join(os.homedir(), ".zcode-captcha-cdn-cache");
const _memCdnCache = new Map();
// pe bundles rotate (pe.0xx...); every rotation would otherwise pin a fresh
// multi-hundred-KB body for the process lifetime (issue #50). Insertion-ordered
// FIFO -- the oldest rotation ages out first; disk cache still serves re-reads.
const MEM_CDN_CACHE_CAP = 16;

// -- AliyunCaptcha.js / pe bundle XHR-timeout patch --------------------------
// The captcha frontend hardcodes a 5s default XHR timeout for the requests it
// issues — including the traceless verify POST (`arguments[4]?arguments[4]:
// 5e3`, single occurrence per bundle, feeding both xhr.timeout and the
// Promise.race rejector). The helper exists in TWO bundles: AliyunCaptcha.js
// (`...:5e3;return e.timeout=i`) and the rotated pe VM bundles
// (`...:5e3,o=...;return r.timeout=a`) — the VERIFY POST goes through the pe
// copy, so both must be patched. On mobile networks the verify POST routinely
// exceeds 5s: the SDK times out and RE-SUBMITS the same certifyId (same host,
// then the -b failover host, then a config re-init + PUZZLE fallback). The
// first submit had already consumed the certifyId, so every retry reply F008
// (duplicate verify) — surfaced as "verify rejected {verifyCode:F008}" and,
// with deterministic mobile latency, all solveRetries attempts fail
// identically ("captcha failed after 4 attempts: duplicate certifyId (F008)",
// measured 2026-11-01). Raising the default to 30s (the solve deadline) lets
// the first submit complete: live repro with a 5.3s verify delay went from
// F008 + failover cascade to T001.
// Applied at every body entry point: rememberCdnBody (cache funnel: prewarm,
// disk refill), the async passthrough (pe bundles are NEVER cached — they
// rotate and flow straight back to happy-dom from solveFetch), and the sync
// passthrough. Fail-open: pattern absent (SDK update) logs once and serves
// unpatched; already-patched bodies pass through.
const SDK_XHR_TIMEOUT_PATTERN = "arguments[4]?arguments[4]:5e3";
const SDK_XHR_TIMEOUT_REPLACEMENT = "arguments[4]?arguments[4]:30e3";
// AliyunCaptcha.js + the rotated pe VM bundles only. FeiLin (fingerprint SDK)
// shares the /captcha-frontend/ prefix but has no xhr helper (verified 1.5.2)
// — including it would burn the once-per-process "pattern not found" warn on
// every solve and mask a real SDK drift.
const CAPTCHA_SCRIPT_PATCH_RE =
  /^https?:\/\/[^/]*alicdn\.com\/captcha-frontend\/(aliyunCaptcha\/AliyunCaptcha\.js|dynamicJS\/[^?]*\/pe\.\d+\.[^?]*\.js)(\?|$)/i;
let _sdkTimeoutPatchWarned = false;
export function __patchSdkXhrTimeout(body) {
  try {
    const src = typeof body === "string" ? body : body.toString("utf8");
    if (src.includes(SDK_XHR_TIMEOUT_REPLACEMENT)) return body;
    if (!src.includes(SDK_XHR_TIMEOUT_PATTERN)) {
      if (!_sdkTimeoutPatchWarned) {
        _sdkTimeoutPatchWarned = true;
        process.stderr.write(
          "[captcha] captcha-frontend js xhr-timeout pattern not found (SDK updated?) -- serving unpatched\n",
        );
      }
      return body;
    }
    return Buffer.from(
      src.split(SDK_XHR_TIMEOUT_PATTERN).join(SDK_XHR_TIMEOUT_REPLACEMENT),
      "utf8",
    );
  } catch (_) {
    return body;
  }
}

let _cookieCache = { cookies: [], ts: 0 };
const COOKIE_CACHE_TTL_MS = 5 * 60 * 1000;
/** 排障开关（保留的调参口）：`CAPTCHA_DEBUG=1` 打开求解过程日志。*/
const _DEBUG_BODIES = process.env.CAPTCHA_DEBUG_BODIES === "1";
const _DEBUG = _DEBUG_BODIES || /^(1|true|yes)$/i.test(process.env.CAPTCHA_DEBUG || "");

// -- Globals shared across solves --------------------------------------------
// Ring buffer: the stall detector reads only the newest entry and failure
// diagnostics the last ~12 entries of the CURRENT solve -- anything older is
// dead weight. Unbounded it grew for the process lifetime (issue #50).
const REQUEST_LOG_CAP = 256;
const _requestLog = [];
function noteRequest(entry) {
  _requestLog.push(entry);
  if (_requestLog.length > REQUEST_LOG_CAP) {
    _requestLog.splice(0, _requestLog.length - REQUEST_LOG_CAP);
  }
}
// Consecutive-stall tracker per pe bundle URL: the same cached pe version
// can stall every attempt (bad rotated VM variant / stale cache). After two
// stalls on one URL, evict its memory + disk cache entry so the next init
// fetches fresh bytes from the CDN instead of re-stalling on them.
const _stallCounts = new Map();
// Set after a stall: the next solve in this process fetches dynamicJS fresh
// (bypassing mem+disk cache) instead of re-using the bytes that just stalled.
let _bypassPeCacheOnce = false;

function noteStallAndMaybeEvict(peUrl) {
  try {
    if (!peUrl || !/dynamicJS\//.test(peUrl)) return;
    _bypassPeCacheOnce = true;
    const n = (_stallCounts.get(peUrl) || 0) + 1;
    _stallCounts.set(peUrl, n);
    if (n >= 2 && !_DEBUG) {
      process.stderr.write(`[pe-cache-evict] ${peUrl.split("/").pop()} stalled ${n}x -- evicting cache\n`);
    }
    if (n >= 2) {
      _memCdnCache.delete(peUrl);
      try { fs.unlinkSync(diskPathFor(peUrl)); } catch (_) {}
      _stallCounts.delete(peUrl);
    }
  } catch (_) {}
}

// -- Fingerprint -------------------------------------------------------------
function generateFingerprint() {
  const userAgent =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
  const uaMajor = "127";
  const uaFull = "127.0.0.0";
  const platform = "Linux x86_64";
  const screen = { w: 1280, h: 720, aw: 1280, ah: 720 };
  const webglUnmaskedVendor = "Google Inc. (Google)";
  const webglUnmaskedRenderer =
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)";
  const canvasImage =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  return { userAgent, uaMajor, uaFull, platform, screen, webglUnmaskedVendor, webglUnmaskedRenderer, canvasImage };
}

const fp = generateFingerprint();

// -- The interceptor layer: built once, closes over the solver state --------
// In-flight tracking for the stall detector: a slow-but-alive request (mobile
// verify/config POSTs run 5-10s cross-border) must not read as a stall — the
// whole request duration sits inside the interceptor's async handler, so
// try/finally around the body is an accurate counter. A permanently hung
// request only delays the stall verdict to the 30s solve deadline, which is the
// same outcome the detector was accelerating.
let _asyncRequestsInFlight = 0;

// The network layer takes the cache, the request log and the in-flight counter
// as arguments, so this is the only place that knows both sides.
const interceptorLayer = createInterceptorLayer({
  debug: _DEBUG,
  userAgent: fp.userAgent,
  uaMajor: fp.uaMajor,
  memCdnCache: _memCdnCache,
  memCdnCacheCap: MEM_CDN_CACHE_CAP,
  cdnCacheDir: CDN_CACHE_DIR,
  noteRequest,
  syncFetchBlocking,
  patchSdkXhrTimeout: __patchSdkXhrTimeout,
  scriptPatchRe: CAPTCHA_SCRIPT_PATCH_RE,
  inflight: {
    inc: () => { _asyncRequestsInFlight += 1; },
    dec: () => { _asyncRequestsInFlight -= 1; },
  },
});
const { makeInterceptor, rememberCdnBody, solveFetch, getCachedBody, diskPathFor, cdnDir } = interceptorLayer;

// -- Lexical guest scope: timer OWNERSHIP, not caller guessing --------------
// Under Bun, guest scripts execute in the HOST realm, so a bare `setTimeout`
// inside SDK code resolves to the host's. Host timers outlive the window:
// a stray FeiLin callback that re-arms its 2s heartbeat (feilin008.js:
// `tV = setInterval(tE, 2e3)`) after destroyDom keeps firing forever and
// eventually dereferences a torn-down global -- the field-reported
// "ReferenceError: moveBy is not defined" that killed the TUI (removed in 5.0;
// the crash shape still matters: it kills whichever entry hosts us).
//
// Guest timers must therefore land on the WINDOW registry, which happy-dom
// clears in happyDOM.close(). The previous approach decided this at CALL time
// by sniffing `new Error().stack` for a CDN frame, but a stack describes the
// call chain, not ownership, and it misjudges BOTH ways:
//   - false negative -- guest code built via `new Function` carries no CDN
//     frame, so its heartbeat escaped onto the immortal host lane;
//   - false positive -- host runtime code invoked beneath a guest frame was
//     handed a window timer with no `.unref()`, the v4.5.2 crash shape.
// Ownership is a property of where CODE COMES FROM, so we bind it lexically.
// Each guest script is evaluated inside `with (scope) { ... }`, where `scope`
// carries this window's timer methods. Identifier resolution is settled by the
// scope chain at parse time; no stack is ever consulted, so neither misjudgement
// is expressible. `with` (not an IIFE wrapper) because guest top-level `var` and
// `function` declarations must keep escaping to the global object -- an IIFE
// swallows them and `initAliyunCaptcha` never appears (measured: every solve
// timed out). The FeiLin/pe bundles have no top-level "use strict" (their
// `"use strict"` directives sit inside module functions, which is fine), so
// `with` parses; a script that did carry one would throw at parse time and take
// the unwrapped fallback path in installEvalInstrumentation.
const GUEST_TIMER_PROPS = ["setTimeout", "setInterval", "clearTimeout", "clearInterval"];

let _guestScopeSeq = 0;

/**
 * Create this window's guest scope and return the id the wrapper embeds.
 *
 * Holds the window's own timer methods (bound to the window), a `Function`
 * stand-in (see makeScopedFunction), and the window's console. The console
 * matters as much as the timers: the FeiLin SDK probes for devtools by
 * printing invisible `%c%d` format strings across every console method, ~1/sec
 * while solving. Resolved lexically it lands on the window's silent console;
 * left to the host it garbles the terminal UI's alternate screen with bare "NaN"
 * rows (the TUI itself is gone; stdout is still the user's terminal).
 */
function installGuestScope(w) {
  const root = (globalThis[GUEST_SCOPE_ROOT] ??= Object.create(null));
  const id = `w${++_guestScopeSeq}`;
  const scope = Object.create(null);
  for (const name of GUEST_TIMER_PROPS) {
    const fn = w[name];
    scope[name] = typeof fn === "function" ? fn.bind(w) : fn;
  }
  scope.Function = makeScopedFunction(w);
  if (!_DEBUG && w.console) scope.console = w.console;
  root[id] = scope;
  w.__capScopeId = id;
  return id;
}

/** Drop the scope when the window dies, so it cannot pin a closed window. */
function removeGuestScope(w) {
  try {
    const id = w && w.__capScopeId;
    const root = globalThis[GUEST_SCOPE_ROOT];
    if (id && root) delete root[id];
  } catch {}
}

// -- Browser-ish polyfills (ported from solve-core applyPolyfills) -----------
// Split across captcha-polyfill-dom.ts and captcha-polyfill-canvas.ts. The two
// sets touch disjoint prototypes (window/navigator/screen/document vs
// HTMLCanvasElement), so their relative order carries no meaning.
function applyPolyfills(w) {
  if (_DEBUG_BODIES) {
    installTrafficLogger(w);
  }
  installDomPolyfills(w, fp);
  installCanvasPolyfills(w, fp);
}

// -- Traffic logger (XHR/fetch URL capture per solve) -----------------------
function installTrafficLogger(w) {
  const origOpen = w.XMLHttpRequest.prototype.open;
  const origSend = w.XMLHttpRequest.prototype.send;
  w.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__capMethod = method;
    this.__capUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  w.XMLHttpRequest.prototype.send = function (body) {
    const url = String(this.__capUrl || "");
    const DEBUG_HOSTS = /(cloudauth-device|captcha-open|verify|upload|nocaptcha|aliyuncs)/i;
    if (DEBUG_HOSTS.test(url)) {
      this.addEventListener("load", () => {
        let respPreview = "";
        try {
          respPreview = String(this.responseText || "").slice(0, 3000);
        } catch (_) {}
        try {
          process.stderr.write(
            `\n===== XHR ${String(this.__capMethod || "?")} ${url}\n--- RESP (${respPreview.length}b) ---\n${respPreview}\n=====\n`,
          );
        } catch (_) {}
      });
    }
    return origSend.call(this, body);
  };
}

function safeJson(x) {
  try {
    if (x instanceof Error) return `Error: ${x.message}\n${(x.stack || "").slice(0, 1500)}`;
    const s = JSON.stringify(x);
    return s !== undefined && s.length < 3000 ? s : String(x);
  } catch (_) {
    return String(x);
  }
}

// -- Behavioral priming (FeiLin human-motion buffer) ------------------------
function simulateBehavior(w, durationMs = 600) {
  const { document, MouseEvent, KeyboardEvent, UIEvent } = w;
  if (!document || !MouseEvent) return;
  const fire = (type, ctor, opts) => {
    try {
      const Ctor = ctor || UIEvent;
      const ev = new Ctor(type, { bubbles: true, cancelable: true, view: w, ...opts });
      document.dispatchEvent(ev);
      if (document.body) document.body.dispatchEvent(ev);
    } catch (_) {}
  };
  let x = 140 + Math.random() * 30;
  let y = 110 + Math.random() * 20;
  const targetX = 540 + Math.random() * 40;
  const targetY = 380 + Math.random() * 30;
  const steps = 22;
  let i = 0;
  const start = Date.now();
  const moveStep = () => {
    if (i > steps) return;
    x += (targetX - x) * 0.16 + (Math.random() - 0.5) * 5;
    y += (targetY - y) * 0.16 + (Math.random() - 0.5) * 4;
    fire("mousemove", MouseEvent, {
      screenX: Math.round(x),
      screenY: Math.round(y),
      clientX: Math.round(x),
      clientY: Math.round(y),
      button: 0,
      buttons: 1,
    });
    i += 1;
    const done = Date.now() - start >= durationMs;
    if (i <= steps && !done) {
      // Window-registry timer: the drag chain only touches the window and
      // must die with it, not ride the dual dispatcher's host lane.
      w.setTimeout(moveStep, 26 + Math.floor(Math.random() * 32));
    } else {
      fire("mousedown", MouseEvent, { clientX: Math.round(x), clientY: Math.round(y), button: 0, buttons: 1 });
      fire("mouseup", MouseEvent, { clientX: Math.round(x), clientY: Math.round(y), button: 0, buttons: 0 });
      fire("click", MouseEvent, { clientX: Math.round(x), clientY: Math.round(y), button: 0 });
      try {
        fire("keyup", KeyboardEvent, { key: "a", code: "KeyA", keyCode: 65, which: 65 });
      } catch (_) {}
    }
  };
  moveStep();
}

function waitFor(cond, timeoutMs = 15_000, intervalMs = 40) {
  return new Promise((res, rej) => {
    const started = Date.now();
    const timer = setInterval(() => {
      let ok = false;
      try {
        ok = cond();
      } catch (_) {}
      if (ok) {
        clearInterval(timer);
        res();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        rej(new Error("timeout"));
      }
    }, intervalMs);
  });
}

// -- createDom --------------------------------------------------------------
// Window assembly lives in captcha-dom-build.ts; this module owns the state it
// needs and passes it in.
const domDeps = {
  fp,
  debug: _DEBUG,
  safeJson,
  cookieCache: {
    read: () => _cookieCache,
    write: (next) => { _cookieCache = next; },
  },
  cookieTtlMs: COOKIE_CACHE_TTL_MS,
  net: {
    solveFetch,
    getCachedBody,
    rememberCdnBody,
    diskPathFor,
    cdnDir,
    memCache: _memCdnCache,
  },
  makeInterceptor,
  takeBypassPeCache: () => {
    const bypass = _bypassPeCacheOnce;
    _bypassPeCacheOnce = false;
    return bypass;
  },
  installers: {
    applyPolyfills,
    installNativeToString,
    installGuestScope,
    installEvalInstrumentation,
    installGlobalWindowAlias,
    ensureGuestRealmGlobals,
  },
  guestEvalPatch: makeGuestEvalPatch(_DEBUG),
};
const createDom = createDomBuilder(domDeps);

// -- Heap reclaim at window-generation turnover -----------------------------
// A destroyed window leaves a large dead object graph behind (SDK instances,
// pe VM, intervals, XHR buffers). JSC only hands pages back to the OS on a
// FULL synchronous collection, so without this the serve process ratchets:
// every window generation's allocation peak becomes the permanent RSS floor
// (issue #50: 2.9 days -> 9.95GB resident). Throttled because pe-storm retry
// ladders destroy several windows back-to-back and Bun.gc(true) is a
// stop-the-world pass that gets heavier at large heaps.
const _gcStats = { calls: 0, lastAt: 0 };
function reclaimCaptchaHeap(minIntervalMs = GC_MIN_INTERVAL_MS) {
  try {
    const gc =
      (typeof Bun !== "undefined" && typeof Bun.gc === "function" && Bun.gc) ||
      (typeof globalThis.gc === "function" && globalThis.gc); // Node --expose-gc (tests)
    if (!gc) return; // no gc exposed (off-Bun runtimes without --expose-gc), skip
    const minMs = Number.isFinite(minIntervalMs) && minIntervalMs >= 0 ? minIntervalMs : GC_MIN_INTERVAL_MS;
    const now = Date.now();
    if (now - _gcStats.lastAt < minMs) return;
    _gcStats.lastAt = now;
    _gcStats.calls += 1;
    gc(true);
  } catch (_) {}
}

function destroyDom(win) {
  releaseGuestRealmGlobals(win);
  try {
    const cap = win.document.getElementById("cap");
    if (cap) cap.replaceChildren();
    win.happyDOM.close();
  } catch (_) {}
  try {
    global.__cookieContainer = null;
    global.__browserFrame = null;
  } catch (_) {}
  try {
    if (typeof Bun !== "undefined") removeGlobalWindowAlias(globalThis, win);
  } catch (_) {}
  // The scope holds window-bound timer functions; dropping it releases the
  // closed window and makes any straggler's `new Function` fall back to the
  // host constructor (harmless: the window registry is already cleared).
  removeGuestScope(win);
  try { shutdownSyncFetchWorker(); } catch (_) {}
  reclaimCaptchaHeap();
}

function extractVerifyParam(param) {
  let verifyParam = param;
  if (param && typeof param === "object") {
    verifyParam = param.verifyParam || param.data || param.param;
  }
  if (!verifyParam || String(verifyParam).length < 20) {
    throw new Error("solver returned empty param: " + JSON.stringify(param));
  }
  const str = String(verifyParam);
  // Strict validation: a REAL Aliyun verify param is ~280 chars of base64
  // JSON containing certifyId + sceneId + isSign + a long securityToken.
  // Len-76 junk like {"certifyId":"70bdb",...,"isSign":true} (no securityToken)
  // comes from a degraded SDK result path and WILL 3007 upstream -- never let
  // it out of the solver.
  if (str.length < 200) {
    throw new Error(
      "verify param too short (" + str.length + " chars) -- degraded result, refusing: " + str.slice(0, 80),
    );
  }
  try {
    const decoded = JSON.parse(Buffer.from(str, "base64").toString("utf8"));
    const secTok = decoded && (decoded.securityToken || decoded.SecurityToken);
    if (!secTok || String(secTok).length < 50) {
      throw new Error(
        "verify param missing securityToken -- refusing degraded result: " + str.slice(0, 80),
      );
    }
  } catch (err) {
    if (err instanceof SyntaxError || /securityToken/.test(String(err.message))) {
      throw err instanceof SyntaxError
        ? new Error("verify param not base64-JSON: " + str.slice(0, 80))
        : err;
    }
    throw err;
  }
  return str;
}

function handleCaptchaResult(result) {
  if (result && typeof result === "object" && result.verifyResult === false) {
    throw new Error(
      "verify rejected: " +
        JSON.stringify({ verifyCode: result.verifyCode, certifyId: result.certifyId }),
    );
  }
  return result;
}

// -- Window reuse pool ------------------------------------------------------
// Reusing one happy-dom window across solves cuts CPU ~48% (measured: 426ms vs
// 815ms per solve) by amortizing the DOM boot + SDK script load. On by
// default; opt out with CAPTCHA_WINDOW_REUSE=0 (or per-call
// solveTraceless({reuseWindow:false})). The window
// is discarded after `maxSolves` (each solve leaves SDK instance graphs
// resident in the window -- issue #50 measured tens of MB per solve), after
// any stall/failure (fresh InitCaptchaV3 rolls a new pe version), or after
// `maxIdleMs` idle. 8 keeps most of the amortization win while capping a
// generation's retention peak at ~1/3 of the old 25-solve default.
const _reusePool = { window: null, browserFrame: null, solves: 0, lastUsedAt: 0 };
const REUSE_MAX_SOLVES = 8;
const REUSE_MAX_IDLE_MS = 120_000;

// 求解预算与回收节奏。四个值都是逆向时试出来的耦合参数，没有环境变量入口：
// 单独调其中一个只会让通过率掉下来。
/** 一次求解的总 deadline；worker 路径也用同一个预算 terminate。*/
const SOLVE_TIMEOUT_MS = 30_000;
/** 两次强制 GC 之间的最小间隔：Bun.gc(true) 是 stop-the-world，且堆越大越慢。*/
const GC_MIN_INTERVAL_MS = 5_000;
/** pe-VM btoa tracer 的落盘路径（`CAPTCHA_DEBUG_BODIES=1` 时的轮换取证）。*/
const DBT_DUMP_PATH = "/tmp/pe-dbt.json";

function takeReusableWindow() {
  const p = _reusePool;
  if (!p.window) return null;
  if (p.solves >= REUSE_MAX_SOLVES) { discardReusableWindow(); return null; }
  if (Date.now() - p.lastUsedAt > REUSE_MAX_IDLE_MS) { discardReusableWindow(); return null; }
  return { window: p.window, browserFrame: p.browserFrame, reused: true };
}
function stageReusableWindow(window, browserFrame) {
  _reusePool.window = window;
  _reusePool.browserFrame = browserFrame;
  _reusePool.solves = 0;
  _reusePool.lastUsedAt = Date.now();
}
function discardReusableWindow() {
  const p = _reusePool;
  if (p.window) {
    try { destroyDom(p.window); } catch (_) {}
  }
  p.window = null;
  p.browserFrame = null;
  p.solves = 0;
}
function noteWindowSolved() {
  _reusePool.solves += 1;
  _reusePool.lastUsedAt = Date.now();
}

// -- Guest error capture (read side) ----------------------------------------
// GUEST_EVAL_PATCH records every guest window error into window.__capErrs
// (capped, deduped) instead of console-printing them: the Aliyun/FeiLin SDKs
// throw benign uncaught TypeErrors inside happy-dom on every solve and the
// solve still succeeds, so printing them is pure console spam. The buffer is
// surfaced only when a solve FAILS -- that's when guest errors are
// actionable. CAPTCHA_DEBUG=1 streams them live again as
// [WINDOW-ERROR]/[UH-REASON].
function guestErrorSummary(w, max = 4) {
  try {
    const errs = w && w.__capErrs;
    if (!errs || !errs.length) return "";
    const total = errs.reduce((a, e) => a + ((e && e.n) || 1), 0);
    const parts = errs.slice(0, max).map((e) => {
      const n = e && e.n && e.n > 1 ? `x${e.n}` : "";
      return `${(e && e.k) || "?"}${n}: ${String((e && e.m) || "?").slice(0, 120)}`;
    });
    return ` guestErrors(${total}): ${parts.join(" || ")}`;
  } catch (_) {
    return "";
  }
}

async function solveTraceless(opts) {
  const scene = opts.scene || "11xygtvd";
  const region = opts.region || "sgp";
  const prefix = opts.prefix || "no8xfe";
  // Overall solve deadline. On the in-process fallback path a hung solve
  // stalls the main event loop，所以早点失败、交给池的重试梯队；worker 路径用
  // 同一个预算 terminate。
  const timeoutMs = opts.timeoutMs ?? SOLVE_TIMEOUT_MS;

  const wantReuse = opts.reuseWindow ?? true;
  let dom;
  let reused = false;
  if (wantReuse) {
    dom = takeReusableWindow();
    if (dom) reused = true;
  }
  if (!dom) {
    dom = await createDom(region, prefix);
  }
  const { window: w, browserFrame } = dom;
  const solveStart = Date.now();
  let solveSucceeded = false;
  let keepWindow = false;
  try {
    await waitFor(() => typeof w.initAliyunCaptcha === "function", timeoutMs, 50);

    simulateBehavior(w, 600);

    const param = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const peUrl = (() => { try { return w.__lastPeUrl || "?"; } catch (_) { return "?"; } })();
        const reqs = _requestLog
          .filter((r) => r.at >= solveStart)
          .map((r) => `${(r.at - solveStart)}ms ${r.method} ${String(r.url).replace(/^https?:\/\//, "").slice(0, 60)}`)
          .slice(-12);
        reject(new Error(`captcha solve timeout pe=${peUrl.split("/").pop() || peUrl} reqs=${JSON.stringify(reqs)}`));
      }, timeoutMs);      // Fail-fast stall detector: healthy solves keep firing XHRs until
      // verify (~3s, gaps <2s). If no XHR starts for stallMs (12s default,
      // was 6s) and none are in flight, this pe-VM variant stalled (seen
      // across rotated pe.0xx versions) -- abort early so the caller can
      // retry with a fresh InitCaptchaV3 (new pe version).
      // 12s (was 6s): the detector keys on request STARTS, and the pe VM
      // legitimately chews CPU for >6s between XHRs on slow machines/mobile
      // (obfuscated 450KB VM + fingerprint) — those false stalls burned a
      // solve attempt for a healthy flow. In-flight requests skip the check
      // (a slow-but-alive mobile POST is progress, not a stall); this covers
      // the CPU-bound gap. A real stall now costs 12s of the 30s deadline
      // instead of 6s — acceptable vs burning attempts.
      const stallMs = opts.stallMs ?? 12_000;
      const stallTimer = setInterval(() => {
        const last = _requestLog[_requestLog.length - 1];
        // Skip while a request is in flight: a slow-but-alive mobile POST
        // (5-10s cross-border) is progress, not a stall (see makeInterceptor).
        if (last && Date.now() - last.at > stallMs && _asyncRequestsInFlight === 0) {
          const peUrl = (() => { try { return w.__lastPeUrl || "?"; } catch (_) { return "?"; } })();
          noteStallAndMaybeEvict(peUrl);
          const reqs = _requestLog
            .filter((r) => r.at >= solveStart)
            .map((r) => `${(r.at - solveStart)}ms ${r.method} ${String(r.url).replace(/^https?:\/\//, "").slice(0, 60)}`)
            .slice(-12);
          clearTimeout(timer);
          clearInterval(stallTimer);
          reject(new Error(`captcha solve stall pe=${peUrl.split("/").pop() || peUrl} lastXhr=${(last.at - solveStart)}ms reqs=${JSON.stringify(reqs)}`));
        }
      }, 500);
      const finish = (fn) => (value) => {
        clearTimeout(timer);
        clearInterval(stallTimer);
        fn(value);
      };
      try {
        w.initAliyunCaptcha({
          SceneId: scene,
          mode: "popup",
          region,
          prefix,
          language: "en",
          element: "#cap",
          button: "#btn",
          captchaLogoImg: "",
          showErrorTip: false,
          getInstance: (inst) => {
            try {
              (inst.startTracelessVerification || inst.show).call(inst);
            } catch (e) {
              finish(reject)(new Error(`start: ${e.message}`));
            }
          },
          success: (result) => {
            try {
              finish(resolve)(handleCaptchaResult(result));
            } catch (err) {
              finish(reject)(err);
            }
          },
          fail: (err) => finish(reject)(new Error(`fail: ${JSON.stringify(err)}`)),
          onError: (err) => finish(reject)(new Error(`onError: ${JSON.stringify(err)}`)),
        });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });

    // Success clears this pe's stall history so future isolated stalls can
    // still trigger eviction after two genuine consecutive failures. Also
    // clears the guest error buffer: a pooled window's next failure must
    // only report errors from solves after this success.
    try {
      const okPe = w.__lastPeUrl;
      if (okPe) _stallCounts.delete(okPe);
      w.__capErrs = [];
    } catch (_) {}

    // Dump the pe-VM btoa tracer when body logging is on (rotation forensics).
    if (_DEBUG_BODIES) {
      try {
        const dbt = w.__DBT || [];
        fs.writeFileSync(
          DBT_DUMP_PATH,
          JSON.stringify({ count: dbt.length, last: dbt.slice(-8), all: dbt }, null, 1),
        );
      } catch (_) {}
    }

    solveSucceeded = true;
    const out = extractVerifyParam(param);
    if (wantReuse) {
      if (reused) noteWindowSolved();
      else stageReusableWindow(w, browserFrame);
      keepWindow = true;
    }
    return out;
  } catch (err) {
    // Attach captured guest window errors to the failure -- the only situation
    // where they are actionable (a successful solve makes them irrelevant).
    const summary = guestErrorSummary(w);
    if (summary) {
      try {
        err.message = `${err && err.message ? err.message : String(err)} |${summary}`;
      } catch (_) {}
    }
    throw err;
  } finally {
    // Reuse mode: on success the window stays pooled (keepWindow) for the next
    // solve -- a ~48% CPU cut. On failure it is destroyed: a stalled window must
    // not poison later solves, and the retry rolls a fresh pe anyway.
    if (!keepWindow) {
      if (_reusePool.window === w) _reusePool.window = null;
      destroyDom(w);
    }
  }
}

/** Test/debug observability into the memory guards (issue #50). */
export function __captchaMemStats() {
  return {
    requestLogLength: _requestLog.length,
    requestLogCap: REQUEST_LOG_CAP,
    cdnCacheSize: _memCdnCache.size,
    cdnCacheCap: MEM_CDN_CACHE_CAP,
    reuseMaxSolves: REUSE_MAX_SOLVES,
    gcCalls: _gcStats.calls,
    gcLastAt: _gcStats.lastAt,
  };
}

export { solveTraceless, createDom, destroyDom, noteRequest, rememberCdnBody, reclaimCaptchaHeap };

// Test seams and the destroyDom half of the guest-realm lifecycle stay
// importable from this module: the worker entry imports solveTraceless only,
// but the test files name these paths.
export {
  __realmGlobalsLifecycle,
  installGlobalWindowAlias,
  removeGlobalWindowAlias,
} from "./captcha-polyfill-guest-realm.js";

/** Test seam: read the mem CDN cache (patched-body verification). */
export function __cdnCacheGet(url) {
  return _memCdnCache.get(url);
}
