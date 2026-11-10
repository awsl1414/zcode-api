/**
 * 出线模块与数据透传的三个坑。
 *
 * 用例只用本地 socket（mock 上游 + 本地代理 + 本地 SOCKS5），不碰真实网络。三件事
 * 各有用例钉住：
 *
 * 1. 压缩：代理只换 socket，不解压不重编码，所以 `Content-Encoding` 与响应字节
 *    必须与直连**逐字节**一致。
 * 2. SSE：分块的时间间隔不能被缓冲压平。用例真的数分块并量间隔。
 * 3. TLS：https 目标走 `CONNECT` 隧道，端到端加密。用例断言隧道里出现的是 TLS
 *    握手记录（`0x16 0x03`），而不是明文 HTTP 请求头；且代码里没有任何
 *    `rejectUnauthorized: false`。
 *
 * 三条都是对**线上字节**的断言，换成别的实现也不该让它们变松。
 *
 * @see 数据透传的三个坑
 */
import { describe, expect, test, afterAll } from "bun:test";
import { createServer as createNet, connect as connectNet, type Socket } from "node:net";
import { createServer as createHttp, request as httpRequest } from "node:http";
import {
  egressFor,
  egressForOptions,
  fetchVia,
  fetchWithEgress,
  proxyProtocol,
  proxyUrlWithAuth,
  requestVia,
} from "./egress.js";

// ---------------------------------------------------------------------------
// 本地夹具：mock 上游 / HTTP 代理 / SOCKS5 代理
// ---------------------------------------------------------------------------

interface Upstream {
  port: number;
  stop(): void;
  /** 命中次数（断言代理确实用了它）。*/
  hits(): number;
}

/** 起一个 mock 上游，`handler` 决定响应（流式、压缩都行）。*/
function startUpstream(handler: (req: Request) => Response | Promise<Response>): Upstream {
  let hits = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      hits += 1;
      return handler(req);
    },
  });
  const port = server.port;
  if (port === undefined) throw new Error("mock upstream did not bind a port");
  return { port, stop: () => server.stop(true), hits: () => hits };
}

/** 解析 absolute-form 请求行，并强制回环目标（夹具不碰真实网络）。*/
function loopbackTarget(line: string): URL {
  const target = new URL(line);
  if (target.hostname !== "127.0.0.1" && target.hostname !== "localhost") {
    throw new Error(`proxy fixture refuses a non-loopback target: ${target.hostname}`);
  }
  return target;
}

interface TestProxy {
  port: number;
  stats: { connects: number; forwards: number; requestLines: string[]; authorizations: Array<string | undefined> };
  close(): void;
}

/**
 * 本地 HTTP 代理：`CONNECT` 隧道（https 目标）+ absolute-form 转发（http 目标）。
 *
 * 转发时把上游的 `content-encoding` 与字节原样带过来，这样「经代理与直连逐字节一致」
 * 才是一个有意义的断言（代理自己不许重编码）。
 */
async function startHttpProxy(): Promise<TestProxy> {
  const stats: TestProxy["stats"] = { connects: 0, forwards: 0, requestLines: [], authorizations: [] };
  const server = createHttp((req, res) => {
    stats.forwards += 1;
    stats.requestLines.push(`${req.method} ${req.url ?? ""}`);
    stats.authorizations.push(req.headers["proxy-authorization"]);
    // 夹具只能访问回环：目标是本测试自己起的 mock 上游。白名单在
    // `loopbackTarget` 里强制，http 代理本身并不做这层检查。
    let target: URL;
    try {
      target = loopbackTarget(req.url ?? "");
    } catch {
      res.writeHead(403).end();
      return;
    }
    // 原字节转发（`decompress: false` 的等价物）：夹具搬的是任意字节（含测试用的
    // "假 gzip"），自己解压就不再是透明代理。
    const upstream = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: { ...req.headers, host: target.host },
        agent: false,
      },
      (up) => {
        const headers: Record<string, string> = {};
        for (const name of ["content-type", "content-encoding", "content-length"]) {
          const value = up.headers[name];
          if (typeof value === "string") headers[name] = value;
          else if (Array.isArray(value)) headers[name] = value.join(", ");
        }
        res.writeHead(up.statusCode ?? 502, headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  // Node 把 CONNECT 发到 `connect` 事件，不是 `request`：写在 request 里会永远收不到。
  server.on("connect", (req, client) => {
    stats.connects += 1;
    const [host, port] = (req.url ?? "").split(":");
    const upstream = connectNet(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : 0,
    stats,
    close: () => server.close(),
  };
}

interface TestSocks5 {
  port: number;
  stats: { conns: number; requests: string[] };
  close(): void;
}

/** 极简 SOCKS5（无认证）服务：CONNECT 之后直接双向管道。*/
async function startSocks5(): Promise<TestSocks5> {
  const stats = { conns: 0, requests: [] as string[] };
  const server = createNet((socket: Socket) => {
    stats.conns += 1;
    let stage: 0 | 1 | 2 = 0;
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0) {
        if (buffer.length < 2) return;
        const methods = buffer[1] ?? 0;
        if (buffer.length < 2 + methods) return;
        buffer = buffer.subarray(2 + methods);
        socket.write(Buffer.from([0x05, 0x00]));
        stage = 1;
      }
      if (stage === 1) {
        if (buffer.length < 5) return;
        const atyp = buffer[3];
        let host = "";
        let port = 0;
        let consumed = 0;
        if (atyp === 0x01) {
          if (buffer.length < 10) return;
          host = [...buffer.subarray(4, 8)].join(".");
          port = buffer.readUInt16BE(8);
          consumed = 10;
        } else if (atyp === 0x03) {
          const length = buffer[4] ?? 0;
          if (buffer.length < 5 + length + 2) return;
          host = buffer.subarray(5, 5 + length).toString();
          port = buffer.readUInt16BE(5 + length);
          consumed = 5 + length + 2;
        } else {
          socket.destroy();
          return;
        }
        stats.requests.push(`${host}:${port}`);
        const rest = buffer.subarray(consumed);
        buffer = Buffer.alloc(0);
        stage = 2;
        const upstream = connectNet(port, host, () => {
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.off("data", onData);
          if (rest.length > 0) upstream.write(rest);
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
        upstream.on("error", () => socket.destroy());
      }
    };
    socket.on("data", onData);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : 0,
    stats,
    close: () => server.close(),
  };
}

/** gzip 一段文本（翻译路径的用例要真压缩字节，假字节过不了 DecompressionStream）。*/
async function gzip(plain: string): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([plain]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

// ---------------------------------------------------------------------------
// fetchVia：注入的 fetchImpl 不能套代理
// ---------------------------------------------------------------------------

describe("fetchVia", () => {
  test("does not touch an injected fetchImpl (mock must not be bypassed)", async () => {
    const seen: RequestInit[] = [];
    const injected = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response("mock");
    }) as unknown as typeof fetch;

    const egress = egressFor("http://127.0.0.1:7890");
    const resp = await fetchVia(injected, "https://upstream.invalid/v1/messages", { method: "POST" }, egress);
    expect(await resp.text()).toBe("mock");
    // 一个字段都不许加：加了 agent/dispatcher，测试的 mock 就被代理绕过了。
    expect(seen).toEqual([{ method: "POST" }]);
  });

  test("no egress means a plain call", async () => {
    const seen: Array<RequestInit | undefined> = [];
    const injected = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(init);
      return new Response("plain");
    }) as unknown as typeof fetch;
    await fetchWithEgress(injected, "https://upstream.invalid/x", { method: "GET" }, undefined);
    expect(seen).toEqual([{ method: "GET" }]);
  });
});

// ---------------------------------------------------------------------------
// 统一路径：http 目标经代理走 absolute-form（RFC 9112 第 3.2.2 节）
// ---------------------------------------------------------------------------

describe("requestVia — http proxy", () => {
  test("http targets reach the proxy in absolute-form, not origin-form", async () => {
    const upstream = startUpstream(() => new Response("through-proxy"));
    const proxy = await startHttpProxy();
    cleanups.push(() => upstream.stop(), () => proxy.close());

    const url = `http://127.0.0.1:${upstream.port}/v1/messages`;
    const resp = await requestVia(url, { method: "POST", body: "{}" }, egressFor(`http://127.0.0.1:${proxy.port}`));

    expect(await resp.text()).toBe("through-proxy");
    expect(proxy.stats.forwards).toBe(1);
    // 代理看到的是整条绝对 URL：`HttpProxyAgent` 负责改写，出线层不用自己拼。
    expect(proxy.stats.requestLines[0]).toBe(`POST ${url}`);
    // 上游只被代理访问了一次，没有第二条直连通路。
    expect(upstream.hits()).toBe(1);
  });

  test("carries the proxy credentials as Proxy-Authorization", async () => {
    const upstream = startUpstream(() => new Response("authed"));
    const proxy = await startHttpProxy();
    cleanups.push(() => upstream.stop(), () => proxy.close());

    const egress = egressForOptions({
      proxyUrl: `http://127.0.0.1:${proxy.port}`,
      username: "user",
      password: "secret",
    });
    const resp = await requestVia(`http://127.0.0.1:${upstream.port}/x`, {}, egress);

    expect(await resp.text()).toBe("authed");
    const expected = `Basic ${Buffer.from("user:secret").toString("base64")}`;
    expect(proxy.stats.authorizations[0]).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 压缩字节与 Content-Encoding 原样透传
// ---------------------------------------------------------------------------

describe("压缩：字节与 Content-Encoding 原样透传", () => {
  test("proxied and direct responses carry identical bytes and content-encoding", async () => {
    // 上游返回 gzip 字节并声明 content-encoding。代理只换 socket，所以两边必须逐字节一致。
    const payload = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    const upstream = startUpstream(
      () => new Response(payload, { headers: { "content-encoding": "gzip", "content-type": "application/json" } }),
    );
    const proxy = await startHttpProxy();
    cleanups.push(() => upstream.stop(), () => proxy.close());

    const url = `http://127.0.0.1:${upstream.port}/v1/messages`;
    const direct = await fetch(url, { decompress: false } as RequestInit);
    const directBytes = new Uint8Array(await direct.arrayBuffer());

    const egress = egressFor(`http://127.0.0.1:${proxy.port}`);
    const proxied = await requestVia(url, { decompress: false } as RequestInit, egress);
    const proxiedBytes = new Uint8Array(await proxied.arrayBuffer());

    expect(proxy.stats.forwards).toBeGreaterThan(0);
    // 坑 1 的实质：字节相等、编码头相等。代理不许解压也不许重编码。
    expect(Array.from(proxiedBytes)).toEqual(Array.from(directBytes));
    expect(Array.from(proxiedBytes)).toEqual(Array.from(payload));
    expect(proxied.headers.get("content-encoding")).toBe(direct.headers.get("content-encoding"));
    expect(proxied.headers.get("content-encoding")).toBe("gzip");
  });

  test("translate mode decodes the coding and drops its stale headers", async () => {
    // 翻译路径要明文（fetch 的默认行为）：出线层解压，`content-encoding` /
    // `content-length` 必须一起去掉，否则下游会二次解压失败。
    const body = '{"ok":true}';
    const compressed = await gzip(body);
    const upstream = startUpstream(
      () => new Response(compressed, { headers: { "content-encoding": "gzip", "content-type": "application/json" } }),
    );
    const proxy = await startHttpProxy();
    cleanups.push(() => upstream.stop(), () => proxy.close());

    const egress = egressFor(`http://127.0.0.1:${proxy.port}`);
    const resp = await requestVia(`http://127.0.0.1:${upstream.port}/x`, {}, egress);

    expect(resp.headers.get("content-encoding")).toBeNull();
    expect(resp.headers.get("content-length")).toBeNull();
    expect(await resp.text()).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// SSE：分块节奏不被压平
// ---------------------------------------------------------------------------

describe("SSE：分块节奏不被压平", () => {
  test("proxied SSE keeps chunk boundaries instead of buffering them together", async () => {
    const GAP_MS = 40;
    const CHUNKS = 4;
    const upstream = startUpstream(() => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let index = 0; index < CHUNKS; index++) {
            controller.enqueue(encoder.encode(`data: {"i":${index}}\n\n`));
            await new Promise((resolve) => setTimeout(resolve, GAP_MS));
          }
          controller.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    const proxy = await startHttpProxy();
    cleanups.push(() => upstream.stop(), () => proxy.close());

    const url = `http://127.0.0.1:${upstream.port}/v1/messages`;
    const egress = egressFor(`http://127.0.0.1:${proxy.port}`);
    const resp = await requestVia(url, {}, egress);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");

    const reader = resp.body!.getReader();
    const arrivals: number[] = [];
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arrivals.push(Date.now());
      text += decoder.decode(value, { stream: true });
    }

    // 四块内容都在，且内容顺序没被打乱。
    for (let index = 0; index < CHUNKS; index++) expect(text).toContain(`{"i":${index}}`);
    // 关键断言：**不是**一次读完。缓冲压平会把 N 块合成 1 块。
    expect(arrivals.length).toBeGreaterThan(1);
    const span = arrivals[arrivals.length - 1]! - arrivals[0]!;
    // 首块到末块的跨度应接近 (CHUNKS-1)*GAP，明显大于 0，说明节奏被保留。
    expect(span).toBeGreaterThan(GAP_MS * (CHUNKS - 2));
  });
});

// ---------------------------------------------------------------------------
// TLS：端到端（CONNECT 隧道，无 MITM）
// ---------------------------------------------------------------------------

describe("TLS 端到端", () => {
  test("https targets use a CONNECT tunnel whose payload is a TLS handshake", async () => {
    // 假代理：回 200 之后把随后的字节收下来。若是明文转发，这里会看到 "POST /..."；
    // 端到端加密时看到的是 TLS 记录头 0x16 0x03。
    let sawConnect = "";
    let tunnelBytes = Buffer.alloc(0);
    const fakeProxy = createNet((socket) => {
      let buffer = Buffer.alloc(0);
      let established = false;
      socket.on("data", (chunk: Buffer) => {
        if (!established) {
          buffer = Buffer.concat([buffer, chunk]);
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) return;
          sawConnect = buffer.subarray(0, end).toString("latin1");
          established = true;
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          return;
        }
        tunnelBytes = Buffer.concat([tunnelBytes, chunk]);
        // 握手不会完成（假代理后面没有 TLS 服务），收到第一批字节就可以收工。
        socket.destroy();
      });
      socket.on("error", () => {
        // 连接被销毁是预期路径。
      });
    });
    await new Promise<void>((resolve) => fakeProxy.listen(0, "127.0.0.1", resolve));
    const address = fakeProxy.address();
    const proxyPort = typeof address === "object" && address !== null ? address.port : 0;
    cleanups.push(() => fakeProxy.close());

    const controller = new AbortController();
    const pending = requestVia(
      "https://upstream.example/v1/messages",
      { method: "POST", body: "{}", signal: controller.signal },
      egressFor(`http://127.0.0.1:${proxyPort}`),
    ).catch(() => undefined);
    // 握手不会完成，所以只等线上动作发生，不等响应。轮询而不是睡固定时间：
    // 固定窗口在 CI 的负载下会把「慢」误判成「没走隧道」。
    const deadline = Date.now() + 2000;
    while (tunnelBytes.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    await pending;

    expect(sawConnect).toContain("CONNECT upstream.example:443");
    // 隧道里出现的第一批字节是 TLS 握手记录，而不是 HTTP 请求明文。
    expect(tunnelBytes.length).toBeGreaterThan(0);
    expect(tunnelBytes[0]).toBe(0x16);
    expect(tunnelBytes[1]).toBe(0x03);
    expect(tunnelBytes.toString("latin1")).not.toContain("POST ");
  });

  test("never disables certificate verification", async () => {
    // 不提供「跳过证书校验」的开关，那会让代理变成 MITM 入口。
    // 这里直接读源码断言，防止以后有人为了"让自签代理跑通"加上它。
    const source = await Bun.file(`${import.meta.dir}/egress.ts`).text();
    expect(source).not.toContain("rejectUnauthorized");
    expect(source).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
  });
});

// ---------------------------------------------------------------------------
// SOCKS5：同一条 node:http(s).request 路径，agent 换成 SocksProxyAgent
// ---------------------------------------------------------------------------

describe("socks5 egress", () => {
  test("routes a request through a socks5 proxy via the node request path", async () => {
    const upstream = startUpstream(() => new Response("socks-ok"));
    const socks = await startSocks5();
    cleanups.push(() => upstream.stop(), () => socks.close());

    const url = `http://127.0.0.1:${upstream.port}/x`;
    const egress = egressFor(`socks5://127.0.0.1:${socks.port}`);
    const resp = await requestVia(url, {}, egress);

    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("socks-ok");
    // 真的走了 SOCKS5：握手发生且目标就是上游。
    expect(socks.stats.conns).toBeGreaterThan(0);
    expect(socks.stats.requests[0]).toBe(`127.0.0.1:${upstream.port}`);
    // 上游只被代理访问了一次（没有第二条直连通路）。
    expect(upstream.hits()).toBe(1);
  });

  test("accepts socks5h (remote DNS) alongside socks5", () => {
    expect(proxyProtocol("socks5://host:1080")).toBe("socks5:");
    expect(proxyProtocol("socks5h://host:1080")).toBe("socks5h:");
    expect(egressFor("socks5h://host:1080").proxyUrl).toBe("socks5h://host:1080");
  });
});

// ---------------------------------------------------------------------------
// 句柄缓存与 URL 处理
// ---------------------------------------------------------------------------

describe("egressFor cache", () => {
  test("reuses one agent per proxy url and separates differing credentials", () => {
    const first = egressFor("http://127.0.0.1:7890");
    const again = egressFor("http://127.0.0.1:7890");
    expect(first).toBe(again);

    const withAuth = egressFor(proxyUrlWithAuth({ proxyUrl: "http://127.0.0.1:7890", username: "u", password: "p" }));
    expect(withAuth).not.toBe(first);

    // 直连（没有代理）不造句柄。
    expect(egressForOptions(undefined)).toBeUndefined();
  });

  test("cache is bounded", () => {
    for (let index = 0; index < 20; index++) {
      expect(egressFor(`http://127.0.0.1:${7000 + index}`)).toBeDefined();
    }
    // 20 条不同 URL 之后，缓存里保留的是最近 16 条：最旧的一条重新创建。
    const oldest = egressFor("http://127.0.0.1:7000");
    const recent = egressFor("http://127.0.0.1:7019");
    expect(egressFor("http://127.0.0.1:7001")).not.toBe(oldest);
    expect(recent).toBe(egressFor("http://127.0.0.1:7019"));
  });

  test("carries proxy credentials into the url", () => {
    // 密码里的 `@` 与 `:` 必须转义，否则 URL 会被拆坏。
    expect(proxyUrlWithAuth({ proxyUrl: "http://127.0.0.1:7890", username: "user", password: "p@ss:word" })).toContain(
      "p%40ss%3Aword",
    );
    expect(egressForOptions({ proxyUrl: "http://127.0.0.1:7890", username: "user" })?.proxyUrl).toContain("user@");
  });
});
