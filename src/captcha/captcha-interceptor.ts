// @ts-nocheck -- untyped happy-dom shims, same reason as captcha-happy.ts
/**
 * The network layer the happy-dom guest sees instead of a real one.
 *
 * Every frame request (script, XHR, fetch, image) arrives here as a happy-dom
 * request object. CDN bodies come from the mem+disk cache when present, the pe
 * bytecode bundles get their harvest hook, and everything else leaves over
 * undici with the fingerprint headers attached. Sync XHR is the exception: it
 * runs on the blocking worker thread (the sync-fetch worker in
 * captcha-happy.ts) because happy-dom's own implementation shells out to
 * `process.argv[0] -e`, which does not exist in a compiled binary.
 *
 * Separate from captcha-happy.ts because this is the only code that talks to
 * the network and the only code that needs the proxy / Happy-Eyeballs
 * dispatcher setup. The solver's cache, request log and in-flight counter stay
 * in the main module and arrive through `deps`, so nothing here imports the
 * solver back.
 */
import { PropertySymbol } from "happy-dom";
import { ProxyAgent, setGlobalDispatcher, Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

/** 求解请求的单次上限（默认 15s，见 `solveFetch` 的注释）。*/
const SOLVE_FETCH_TIMEOUT_MS = 15_000;

export function createInterceptorLayer(deps) {
  const {
    debug,
    userAgent,
    uaMajor,
    memCdnCache,
    memCdnCacheCap,
    cdnCacheDir,
    noteRequest,
    syncFetchBlocking,
    patchSdkXhrTimeout,
    scriptPatchRe,
    inflight,
  } = deps;

  const proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
  if (proxyUrl) {
    try {
      setGlobalDispatcher(new ProxyAgent(proxyUrl));
    } catch (_) {}
  }

  // Happy-Eyeballs dispatcher (2026-10-30): Alibaba CDN IPv6 is intermittently
  // blackholed (curl-6 → 000 @11s while curl-4 → 200 @2s) and neither undici
  // nor Bun races address families by default — a v6-first DNS answer wedged
  // every captcha solve until the outer deadlines killed it (persistent 503
  // captcha_solver_failed on IPv6-preferring networks). Only used when NO
  // proxy is configured
  // (a ProxyAgent global dispatcher already owns routing in that case).
  const happyEyeballsDispatcher = new UndiciAgent({
    connect: { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250 },
  });

  // Node-side global Happy Eyeballs: flips the net.connect default so the
  // runtime's own fetches (cookie priming, the sync-fetch worker, undici
  // internals) race address families too. Bun ignores these setters (its
  // node:net is a shim) — the explicit undiciFetch/node:https paths above
  // carry the fix there.
  try {
    if (typeof net.setDefaultAutoSelectFamily === "function") {
      net.setDefaultAutoSelectFamily(true);
      if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === "function") {
        net.setDefaultAutoSelectFamilyAttemptTimeout(250);
      }
    }
  } catch (_) {}

  /** Captcha solve fetch with HE routing + a hard deadline. Proxy-aware.
   *  默认 15s：aliyuncs 跨境 API 抖动明显超出 8s（同一分钟内实测 3.6–15s），
   *  上限不得低于观测到的尾巴；整体流程另由求解 deadline 兜住。*/
  async function solveFetch(url, init, timeoutMs = SOLVE_FETCH_TIMEOUT_MS): Promise<Response> {
    const signal = AbortSignal.timeout(timeoutMs);
    const merged = { ...init, signal };
    return proxyUrl ? fetch(url, merged) : undiciFetch(url, { ...merged, dispatcher: happyEyeballsDispatcher });
  }

  function diskPathFor(url) {
    return path.join(cdnCacheDir, crypto.createHash("sha1").update(String(url)).digest("hex"));
  }

  function sniffMime(url) {
    if (/\.js(\?|$)/i.test(url)) return "application/javascript";
    if (/\.css(\?|$)/i.test(url)) return "text/css";
    if (/\.png(\?|$)/i.test(url)) return "image/png";
    if (/\.(jpg|jpeg)(\?|$)/i.test(url)) return "image/jpeg";
    if (/\.json(\?|$)/i.test(url)) return "application/json";
    return "application/octet-stream";
  }

  // -- pe.* bytecode VM harvest hook (same as solve-core) ----------------------
  const peVmCallRegex =
    /55==A\?\(f=r\[n\+\+\],l=e\.pop\(\),h=e\.pop\(\),o=\[\],\w+\(f\)\.forEach\(function\(\)\{o\.unshift\(e\.pop\(\)\)\}\),p=null===h\?l\.apply\((\w+),o\):h\[l\]\.apply\(h,o\),r\[n\+\+\]&&e\.push\(p\)\):/;
  function patchPeBundle(buf, url) {
    if (process.env.PE_PATCH === "off") return buf;
    if (!/dynamicJS\/[^/]*\/pe\.\d+\./.test(url)) return buf;
    let src = buf.toString("utf8");
    if (src.includes("__DBT")) return buf;
    const m = src.match(peVmCallRegex);
    if (!m) return buf;
    const locals = m[1];
    const hook = `55==A?(f=r[n++],l=e.pop(),h=e.pop(),o=[],v(f).forEach(function(){o.unshift(e.pop())}),p=null===h?l.apply(${locals},o):h[l].apply(h,o),r[n++]&&e.push(p),function(){try{if(l===window.btoa||l===window.atob){window.__DBT=window.__DBT||[];var __sav=[];for(var __i=0;__i<e.length;__i++){var __vv=e[__i];if(typeof __vv==="string"){__sav.push("s:"+__vv)}else if(typeof __vv==="number"){__sav.push("n:"+__vv)}else if(typeof __vv==="boolean"){__sav.push("b:"+__vv)}else if(__vv&&typeof __vv.length==="number"){__sav.push("a:"+__vv.length)}else{__sav.push("t:"+typeof __vv)}}var __ls={};for(var __k2 in ${locals}){if(__k2!=="_"&&__k2!=="*"&&__k2!=="arguments"){try{var __lv=${locals}[__k2];if(typeof __lv==="string"){__ls[__k2]="s:"+__lv}else if(typeof __lv==="number"){__ls[__k2]="n:"+__lv}else if(__lv&&typeof __lv.length==="number"){__ls[__k2]="a:"+__lv.length}else{__ls[__k2]="t:"+typeof __lv}}catch(_e){}}}window.__DBT.push({call:"btoa",ip:n,args:o.map(function(__a){return typeof __a==="string"?"s:"+__a:typeof __a==="number"?"n:"+__a:typeof __a==="function"?"fn:"+(__a.name||"?"):typeof __a==="object"&&__a?"obj":typeof __a}),stack:__sav,locals:__ls,rlen:r.length,r:r})}}catch(_e){}}()):`;
    src = src.replace(m[0], hook);
    if (debug) process.stderr.write(`[loader-patch] ${url} (VM hook applied, locals=${locals})\n`);
    return Buffer.from(src, "utf8");
  }

  // -- CDN cache access --------------------------------------------------------
  function getCachedBody(url) {
    const mem = memCdnCache.get(url);
    if (mem) return mem;
    try {
      const p = diskPathFor(url);
      if (fs.existsSync(p)) {
        const body = fs.readFileSync(p);
        rememberCdnBody(url, body);
        return body;
      }
    } catch (_) {}
    return null;
  }

  // -- Request header injection (every frame request: XHR, fetch, scripts) ----
  function injectRequestHeaders(request) {
    const h = request.headers;
    try {
      h.set("sec-ch-ua", '"Chromium";v="' + uaMajor + '", "Not)A;Brand";v="24"');
      h.set("sec-ch-ua-mobile", "?0");
      h.set("sec-ch-ua-platform", '"Linux"');
      h.set("user-agent", userAgent);
      h.set("accept-language", "en-US,en;q=0.9");
      h.set("referer", "https://zcode.z.ai/");
      let origin = null;
      try {
        const u = new URL(request.url);
        const method = String(request.method || "GET").toUpperCase();
        const crossOrigin = u.origin !== "https://zcode.z.ai";
        if (crossOrigin || (method !== "GET" && method !== "HEAD")) {
          origin = "https://zcode.z.ai";
        }
      } catch (_) {}
      if (origin) h.set("origin", origin);
    } catch (_) {}
  }

  function cookieHeader(request, window, browserFrame) {
    try {
      const ctx = browserFrame.page.context;
      const u = new URL(request.url);
      if (request.credentials === "omit") return null;
      const cookies = ctx.cookieContainer.getCookies(u, false);
      if (cookies.length > 0) {
        return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      }
    } catch (_) {}
    return null;
  }

  function storeSetCookies(res, url) {
    try {
      const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      if (list.length) {
        const cookieContainer = global.__cookieContainer;
        if (cookieContainer) {
          for (const raw of list) {
            const u = new URL(url);
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
            try {
              cookieContainer.addCookies([cookie]);
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
  }

  function rememberCdnBody(url, body) {
    if (scriptPatchRe.test(String(url))) body = patchSdkXhrTimeout(body);
    memCdnCache.set(url, body);
    if (memCdnCache.size > memCdnCacheCap) {
      for (const key of memCdnCache.keys()) {
        memCdnCache.delete(key);
        if (memCdnCache.size <= memCdnCacheCap) break;
      }
    }
  }

  function makeInterceptor(bypassPeCache = false) {
    const skipPeCache = (url) => bypassPeCache && /dynamicJS\/.*\/pe\.\d+\./.test(url);
    return {
      async beforeAsyncRequest({ request, window: w }) {
        inflight.inc();
        try {
          return await handleAsyncRequest({ request, window: w, skipPeCache });
        } finally {
          inflight.dec();
        }
      },
      beforeSyncRequest(opts) {
        return handleSyncRequest({ ...opts, skipPeCache });
      },
    };
  }

  async function handleAsyncRequest({ request, window: w, skipPeCache }) {
    {
      const url = request.url;
      noteRequest({ at: Date.now(), method: request.method, url });
      injectRequestHeaders(request);
      if (/\balicdn\.com/i.test(url)) {
        let body = skipPeCache(url) ? null : getCachedBody(url);
        if (body && /\.js(\?|$)/i.test(url)) {
          try {
            new Function(body.toString("utf8"));
          } catch (parseErr) {
            process.stderr.write(`[cache-bad-js] ${url} len=${body.length} ${parseErr.message} -- refetch fresh\n`);
            memCdnCache.delete(url);
            try { fs.unlinkSync(diskPathFor(url)); } catch (_) {}
            body = null;
          }
        }
        // sync interceptor serves only from cache; the async interceptor
        // above warms the cache on first load, so misses fall through to
        // the async fetch path handled by happy-dom.
        if (body) {
          if (/dynamicJS\/[^/]*\/pe\.\d+\./.test(url)) {
            try { w.__lastPeUrl = url; } catch (_) {}
          }
          return new w.Response(patchPeBundle(Buffer.from(body), url), {
            status: 200,
            statusText: "OK",
            headers: { "content-type": sniffMime(url) },
          });
        }
      }
        // Passthrough via global fetch (undici; honors global ProxyAgent).
        try {
          const init = { method: request.method, headers: {} };
          request.headers.forEach((value, key) => {
            init.headers[key] = value;
          });
          const bs = new URL(url);
          const cookie = cookieHeader(request, w, global.__browserFrame);
          if (cookie) init.headers.cookie = cookie;
          let hasBody = false;
          try {
            if (request.body) {
              const ab = await request.arrayBuffer();
              if (ab && ab.byteLength > 0) {
                init.body = ab;
                hasBody = true;
              }
            }
          } catch (_) {}
          // solveFetch: Happy Eyeballs when direct (IPv6-blackhole-safe), plain
          // global fetch keeps ProxyAgent semantics when a proxy is set.
          const res = await solveFetch(url, init);
          let buf = Buffer.from(await res.arrayBuffer());
          // pe bundles reach the page ONLY through this passthrough (they rotate
          // and are never cached), so the xhr-timeout patch must hook here — the
          // cached-serve path is covered by rememberCdnBody.
          if (scriptPatchRe.test(url)) buf = patchSdkXhrTimeout(buf);
          storeSetCookies(res, url);
          if (debug && /captcha-open|verify\.|device\.saf|cloudauth-device|upload\./i.test(url) && buf.length && buf.length < 4096) {
            try {
              process.stderr.write(`[xhr-body] ${request.method} ${bs.hostname}${bs.pathname}-> ${res.status} ${buf.toString("utf8").slice(0, 1200)}\n`);
            } catch (_) {}
          }
          const headers = {};
          const ct = res.headers.get("content-type");
          if (ct) headers["content-type"] = ct;
          const logHost = bs.hostname;
          if (debug)
            process.stderr.write(
              `[xhr] ${request.method} ${logHost}${bs.pathname} -> ${res.status} (${buf.length}b)\n`,
            );
          return new w.Response(buf, {
            status: res.status,
            statusText: res.statusText || "",
            headers,
          });
        } catch (err) {
          if (debug) process.stderr.write(`[xhr-err] ${url}: ${err.message}\n`);
          return new w.Response("", { status: 503, statusText: "passthrough failed" });
        }
    }
  }

  function handleSyncRequest({ request, window: w, skipPeCache }) {
        const url = request.url;
        noteRequest({ at: Date.now(), method: request.method, url, sync: true });
        injectRequestHeaders(request);
        let body = null;
        if (/\balicdn\.com/i.test(url)) {
          body = skipPeCache(url) ? null : getCachedBody(url);
          if (body && /\.js(\?|$)/i.test(url)) {
            try {
              new Function(body.toString("utf8"));
            } catch (parseErr) {
              process.stderr.write(`[cache-bad-js:sync] ${url} len=${body.length} ${parseErr.message} -- refetch fresh\n`);
              memCdnCache.delete(url);
              try { fs.unlinkSync(diskPathFor(url)); } catch (_) {}
              body = null;
            }
          }
          // sync interceptor serves only from cache; the async interceptor
          // above warms the cache on first load, so misses fall through to
          // the async fetch path handled by happy-dom.
        }
        if (body) {
          if (/dynamicJS\/[^/]*\/pe\.\d+\./.test(url)) {
            try { w.__lastPeUrl = url; } catch (_) {}
          }
          return {
            status: 200,
            statusText: "OK",
            ok: true,
            url,
            redirected: false,
            headers: new w.Headers({ "content-type": sniffMime(url) }),
            body: patchPeBundle(Buffer.from(body), url),
            [PropertySymbol.virtualServerFile]: null,
          };
        }
        // Non-CDN sync request: serve it blocking via a worker thread. Never
        // fall through to happy-dom's own sync fetch -- it spawns a child
        // process with `process.argv[0] -e`, which breaks compiled binaries.
        const init = { method: request.method, headers: {} as Record<string, string> };
        request.headers.forEach((value, key) => {
          init.headers[key] = value;
        });
        const cookie = cookieHeader(request, w, global.__browserFrame);
        if (cookie) init.headers.cookie = cookie;
        try {
          if (request.body) {
            const ab = request.body;
            if (ab && (ab as any).byteLength > 0) init.body = ab;
          }
        } catch (_) {}
        const res = syncFetchBlocking(url, init as any) as any;
        if (res.error) {
          process.stderr.write(`[sync-xhr-err] ${url}: ${res.error}\n`);
          return new w.Response("", { status: 503, statusText: "sync fetch failed" });
        }
        try {
          for (const raw of res.setCookie || []) {
            const cookieContainer = global.__cookieContainer;
            if (!cookieContainer) break;
            const u = new URL(url);
            const parts = raw.split(";");
            const pair = parts[0].split("=");
            const cookie: any = {
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
            try { cookieContainer.addCookies([cookie]); } catch (_) {}
          }
        } catch (_) {}
        const hdrs: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers || {})) hdrs[k] = String(v);
        // Sync interceptor contract: PLAIN OBJECT with Buffer body (happy-dom's
        // SyncFetch reads `.body.toString()`); a window.Response here would
        // stringify its ReadableStream body and corrupt script loading.
        return {
          status: res.status,
          statusText: res.statusText || "",
          ok: res.status >= 200 && res.status < 300,
          url,
          redirected: false,
          headers: new w.Headers(hdrs),
          body: scriptPatchRe.test(url) ? patchSdkXhrTimeout(Buffer.from(res.body)) : Buffer.from(res.body),
          [PropertySymbol.virtualServerFile]: null,
        };
  }
  return {
    makeInterceptor,
    rememberCdnBody,
    solveFetch,
    getCachedBody,
    diskPathFor,
    sniffMime,
    patchPeBundle,
    cdnDir: cdnCacheDir,
  };
}
