// @ts-nocheck -- untyped happy-dom shims, same reason as captcha-happy.ts
/**
 * Builds one solve's browser window: the happy-dom instance, its cookie jar,
 * the polyfill pass and the guest hooks, in the order the Aliyun SDK needs
 * them.
 *
 * The call order is what matters here. Polyfills and native-toString
 * masking land before the SDK script is parsed; the guest timer scope and the
 * eval funnel land before any script is wrapped; the host-realm bridge lands
 * before document.write, because the SDK script executes synchronously during
 * the parse and its indirect evals resolve in the host realm. Reordering any of
 * those breaks a solve in a way that only shows up as a timeout.
 *
 * Separate from captcha-happy.ts because it is the one place that assembles a
 * window, and it needs a dozen pieces from both the polyfill modules and the
 * solver. Those arrive through `deps` so this module never imports the solver.
 */
import { GlobalWindow as Window } from "happy-dom";
import WindowBrowserContext from "happy-dom/lib/window/WindowBrowserContext.js";
import crypto from "node:crypto";
import fs from "node:fs";

// The solve page: a div and a button for the captcha widget, plus the SDK
// script tag. Its synchronous execution during document.write is what the
// prewarm above exists for.
const HTML = `<!DOCTYPE html><html><head></head><body>
<div id="cap"></div><button id="btn"></button>
<script src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"></script>
</body></html>`;

export function createDomBuilder(deps) {
  const {
    fp,
    debug,
    safeJson,
    cookieCache,
    cookieTtlMs,
    net,
    makeInterceptor,
    takeBypassPeCache,
    installers,
    guestEvalPatch,
  } = deps;
  const { solveFetch, getCachedBody, rememberCdnBody, diskPathFor, cdnDir, memCache } = net;
  const {
    applyPolyfills,
    installNativeToString,
    installGuestScope,
    installEvalInstrumentation,
    installGlobalWindowAlias,
    ensureGuestRealmGlobals,
  } = installers;

  /** URL of the Aliyun captcha SDK script (the <script src> in the solve page). */
  const ALIYUN_CAPTCHA_JS = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";

  /**
   * Prewarm the captcha SDK script into the CDN cache (async, HE-routed, hard
   * deadline). The <script> executes SYNCHRONOUSLY during the document.write
   * parse — its beforeSyncRequest would otherwise hit the network through the
   * blocking-fetch worker, which is where IPv6-blackholed DNS answers wedge
   * (12s Atomics cap, solve deadline, 503). With the body cached, the sync
   * interceptor serves from memory and the network is never on the sync path.
   */
  async function prewarmCaptchaScript(): Promise<void> {
    if (getCachedBody(ALIYUN_CAPTCHA_JS)) return;
    try {
      const res = await solveFetch(ALIYUN_CAPTCHA_JS, { method: "GET" });
      if (res.ok) {
        const body = Buffer.from(await res.arrayBuffer());
        // Same parse validation the interceptors apply to cached .js bodies —
        // a captive-portal/HTML 200 must not poison the cache (the eviction
        // would then push the sync load back onto the network path this
        // prewarm exists to avoid).
        if (body.length > 0) {
          try { new Function(body.toString("utf8")); } catch (_) { return; }
          rememberCdnBody(ALIYUN_CAPTCHA_JS, body);
          try {
            fs.mkdirSync(cdnDir, { recursive: true });
            fs.writeFileSync(diskPathFor(ALIYUN_CAPTCHA_JS), body);
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  async function createDom(region, prefix) {
    await prewarmCaptchaScript();
    let cookies = [];
    const now = Date.now();
    if (cookieCache.read().ts > 0 && now - cookieCache.read().ts < cookieTtlMs) {
      cookies = cookieCache.read().cookies;
    } else {
      try {
        const res = await solveFetch("https://zcode.z.ai/", {
          headers: {
            "User-Agent": fp.userAgent,
            "sec-ch-ua": '"Chromium";v="' + fp.uaMajor + '", "Not)A;Brand";v="24"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Linux"',
            "Accept-Language": "en-US,en;q=0.9",
          },
        });
        cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
        cookieCache.write({ cookies, ts: Date.now() });
      } catch (_) {}
    }

    const interceptor = makeInterceptor(takeBypassPeCache());
    // Registered once per process -- adding it inside createDom leaked a new
    // EventEmitter listener per solve (MaxListenersExceededWarning + growth).
    if (!process.__capUnhandledRejectionHooked) {
      process.__capUnhandledRejectionHooked = true;
      process.on("unhandledRejection", (reason) => {
        if (!debug) return;
        try {
          const r = reason && reason.stack ? reason.stack : String(reason);
          process.stderr.write(`[host-unhandledRejection] ${typeof reason} ${JSON.stringify(reason).slice(0, 200)} ${r}\n`);
        } catch (_) {}
      });
      // Guest scripts (rotated pe/FeiLin bundles) can throw synchronous errors
      // that surface as uncaughtExceptions. Without a handler, happy-dom's
      // exception observer (or Bun's default) terminates the whole proxy --
      // a single bad pe version must only fail that one solve, not the server.
      process.on("uncaughtException", (err) => {
        try {
          const msg = err && err.message ? err.message : String(err);
          process.stderr.write(`[captcha-guest-uncaught] ${msg}\n`);
        } catch (_) {}
      });
    }
    // Guest console is silent unless CAPTCHAdebug -- piping every SDK log to
    // stderr spams journald and slows mints under systemd.
    const noop = () => {};
    const guestConsole = debug
      ? {
          log: (...a) => process.stderr.write(`[guest-log] ${a.map((x) => (typeof x === "object" ? safeJson(x) : String(x))).join(" ")}\n`),
          warn: (...a) => process.stderr.write(`[guest-warn] ${a.map((x) => (typeof x === "object" ? safeJson(x) : String(x))).join(" ")}\n`),
          error: (...a) => process.stderr.write(`[guest-err] ${a.map((x) => (typeof x === "object" ? safeJson(x) : String(x))).join(" ")}\n`),
          info: (...a) => process.stderr.write(`[guest-info] ${a.map((x) => (typeof x === "object" ? safeJson(x) : String(x))).join(" ")}\n`),
          debug: (...a) => process.stderr.write(`[guest-debug] ${a.map((x) => (typeof x === "object" ? safeJson(x) : String(x))).join(" ")}\n`),
          trace: (...a) => process.stderr.write(`[guest-trace] ${a.map((x) => (typeof x === "object" ? safeJson(x) : String(x))).join(" ")}\n`),
        }
      : { log: noop, warn: noop, error: noop, info: noop, debug: noop, trace: noop };
    const w = new Window({
      url: "https://zcode.z.ai/",
      console: guestConsole,
      settings: {
        enableJavaScriptEvaluation: true,
        enableImageFileLoading: true,
        suppressInsecureJavaScriptEnvironmentWarning: true,
        navigator: { userAgent: fp.userAgent },
        viewport: { width: fp.screen.w, height: fp.screen.h, devicePixelRatio: 1 },
        fetch: {
          disableSameOriginPolicy: true,
          interceptor,
        },
      },
    });

    // Reach into the frame for cookie container + frame ref (host side helpers).
    // WindowBrowserContext imported at module scope
    const browserFrame = new WindowBrowserContext(w).getBrowserFrame();
    global.__browserFrame = browserFrame;
    global.__cookieContainer = browserFrame.page.context.cookieContainer;

    // Cookie priming
    for (const raw of cookies) {
      try {
        const u = new URL("https://zcode.z.ai/");
        const parts = raw.split(";");
        const pair = parts[0].split("=");
        const cookie = {
          name: pair[0].trim(),
          value: pair.slice(1).join("=").trim(),
          url: u.origin,
          domain: u.hostname,
          path: "/",
        };
        for (const p of parts.slice(1)) {
          const kv = p.trim().split(/=(.*)/s);
          const k = (kv[0] || "").toLowerCase();
          if (k === "domain" && kv[1]) cookie.domain = kv[1];
          if (k === "path" && kv[1]) cookie.path = kv[1];
          if (k === "expires") cookie.expires = new Date(kv[1]).getTime();
          if (k === "max-age") cookie.maxAge = parseInt(kv[1], 10);
          if (k === "httponly") cookie.httpOnly = true;
          if (k === "secure") cookie.secure = true;
          if (k === "samesite") cookie.sameSite = kv[1];
        }
        browserFrame.page.context.cookieContainer.addCookies([cookie]);
      } catch (_) {}
    }

    const visitorId = crypto.randomUUID();
    const deviceMid = crypto.randomUUID();
    const pre = [
      { name: "zcode_visitor_id", value: visitorId, domain: "zcode.z.ai" },
      { name: "zcode_device_mid", value: deviceMid, domain: "zcode.z.ai" },
      { name: "visitor_id", value: visitorId, domain: "zcode.z.ai", httpOnly: true },
    ];
    for (const c of pre) {
      try {
        browserFrame.page.context.cookieContainer.addCookies([{ ...c, url: "https://zcode.z.ai", path: "/" }]);
      } catch (_) {}
    }

    // Apply polyfills + masking BEFORE the SDK script runs.
    // Bun compatibility: happy-dom's VM realm isolation doesn't apply under
    // Bun -- script tags execute against the host globalThis, where bare
    // `window`/`document`/`location` identifiers don't exist. Node needs none
    // of this (its VM context resolves them natively). We alias the current
    // solve's window on globalThis and remove the aliases when the window is
    // destroyed, so concurrent solves with window reuse stay consistent.
    applyPolyfills(w);
    installNativeToString(w);
    // Guest timer scope must exist BEFORE the eval hook wraps any script.
    installGuestScope(w);
    installEvalInstrumentation(w, {
      userAgent: fp.userAgent,
      diskPathFor,
      memCdnCache: memCache,
    });
    // Bun alias pass runs AFTER polyfills so polyfilled props (Option, Video,
    // alert, ...) are visible to guest scripts via globalThis too.
    const needsGlobalAlias = typeof Bun !== "undefined";
    if (needsGlobalAlias) {
      const g = globalThis;
      installGlobalWindowAlias(g, w);
    }
    if (w.Error) {
      w.Error.prepareStackTrace = Error.prepareStackTrace;
    }
    // Host-side recorder the guest dump helper calls: computes sha1 of the failing
    // source (guest realm has no node crypto) and re-checks the pe disk cache.
    w.__capDebugDump = (url, src, kind) => {
      try {
        const s = String(src || "");
        const sha1 = crypto.createHash("sha1").update(s).digest("hex");
        process.stderr.write(
          `\n[${kind}] url=${url} len=${s.length} sha1=${sha1}\n` +
            `  head300: ${JSON.stringify(s.slice(0, 300))}\n` +
            `  tail100: ${JSON.stringify(s.slice(-100))}\n`,
        );
        if (/^https?:/.test(String(url))) {
          (async () => {
            try {
              const res = await fetch(url, { headers: { "user-agent": fp.userAgent } });
              const fresh = Buffer.from(await res.arrayBuffer());
              process.stderr.write(
                `[${kind}-CACHE-COMPARE] cachedLen=${s.length} freshLen=${fresh.length} freshSha1=${crypto.createHash("sha1").update(fresh).digest("hex")} http=${res.status}\n`,
              );
              if (fresh.length > 0 && fresh.length !== s.length) {
                process.stderr.write(`[${kind}-MISMATCH] deleting ${diskPathFor(url)} (stale/truncated cache)\n`);
                try {
                  fs.unlinkSync(diskPathFor(url));
                } catch (_) {}
                memCache.delete(url);
              }
            } catch (fetchErr) {
              process.stderr.write(`[${kind}-CACHE-COMPARE-ERR] ${fetchErr.message}\n`);
            }
          })();
        }
      } catch (_) {}
    };
    w.eval(guestEvalPatch);

    // Host-realm guest globals must be live BEFORE document.write — the SDK
    // script evaluates synchronously during the parse and its indirect evals
    // resolve in the host realm (see installGuestRealmGlobals).
    ensureGuestRealmGlobals(w);

    // Write the page HTML (loads the SDK script)
    w.document.write(HTML);

    w.AliyunCaptchaConfig = { region, prefix };

    return { window: w, browserFrame };
  }
  return createDom;
}
