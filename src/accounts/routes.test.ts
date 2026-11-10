/**
 * 内置路由表的用例。
 *
 * 这些断言的价值不在"跑一遍代码"，而在**把设计文档里的表格钉成可执行的契约**：
 * 端点、只签名哪条路由、哪条不吃 captcha、start-plan 不含 glm-5.3 —— 任何一项
 * 被"顺手改得看起来更合理"，上游会以 401 / 3012 / 静默降质回应，而不是编译错误。
 *
 * @see 内置路由表 · 各路由的模型集
 */
import { describe, it, expect } from "bun:test";
import { getRouteSpec, isRouteKind, ROUTE_KINDS, ROUTE_SPECS, routeBaseUrl } from "./routes.js";
import type { RouteKind } from "./types.js";

describe("路由表完整性", () => {
  it("四条路由齐全，无重复、无遗漏", () => {
    const alphabetical: RouteKind[] = [
      "coding-plan",
      "highspeed",
      "off-peak",
      "start-plan",
    ];
    expect(ROUTE_KINDS).toHaveLength(4);
    expect(new Set(ROUTE_KINDS).size).toBe(4);
    expect([...ROUTE_KINDS].sort()).toEqual(alphabetical);
    expect(Object.keys(ROUTE_SPECS).sort()).toEqual([...ROUTE_KINDS].sort());
  });

  it("每条的 kind 字段与键一致", () => {
    for (const kind of ROUTE_KINDS) {
      expect(getRouteSpec(kind).kind).toBe(kind);
    }
  });

  it("isRouteKind 只放行合法路由", () => {
    for (const kind of ROUTE_KINDS) expect(isRouteKind(kind)).toBe(true);
    for (const bogus of ["", "codingplan", "GLM-5.3", "off_peak", null, undefined, 42]) {
      expect(isRouteKind(bogus)).toBe(false);
    }
  });
});

describe("baseUrl（官方 builtin 模板）", () => {
  const expected: Record<RouteKind, { zai: string; bigmodel: string }> = {
    "coding-plan": {
      zai: "https://api.z.ai/api/anthropic",
      bigmodel: "https://open.bigmodel.cn/api/anthropic",
    },
    "start-plan": {
      zai: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
      bigmodel: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
    },
    "off-peak": {
      zai: "https://zcode.z.ai/api/v1/off-peak/anthropic",
      bigmodel: "https://zcode.z.ai/api/v1/off-peak/anthropic",
    },
    highspeed: {
      zai: "https://zcode.z.ai/api/v1/highspeed/anthropic",
      bigmodel: "https://zcode.z.ai/api/v1/highspeed/anthropic",
    },
  };

  it("两家 family 的地址逐条对得上", () => {
    for (const kind of ROUTE_KINDS) {
      expect(getRouteSpec(kind).baseUrl.zai).toBe(expected[kind].zai);
      expect(getRouteSpec(kind).baseUrl.bigmodel).toBe(expected[kind].bigmodel);
      expect(routeBaseUrl(kind, "zai")).toBe(expected[kind].zai);
      expect(routeBaseUrl(kind, "bigmodel")).toBe(expected[kind].bigmodel);
    }
  });

  it("派生路由与 start-plan 同在 zcode.z.ai 网关，coding-plan 分流到 family 域", () => {
    for (const kind of ["start-plan", "off-peak", "highspeed"] as const) {
      expect(getRouteSpec(kind).baseUrl.zai).toStartWith("https://zcode.z.ai/api/v1/");
    }
    expect(getRouteSpec("coding-plan").baseUrl.zai).toStartWith("https://api.z.ai/");
    expect(getRouteSpec("coding-plan").baseUrl.bigmodel).toStartWith("https://open.bigmodel.cn/");
  });

  it("没有尾斜杠（拼路径时会出现 //）", () => {
    for (const kind of ROUTE_KINDS) {
      for (const url of Object.values(getRouteSpec(kind).baseUrl)) {
        expect(url.endsWith("/")).toBe(false);
      }
    }
  });
});

describe("apiType / billing / derivesFrom", () => {
  it("四条路由都走 anthropic / plan 计费", () => {
    for (const kind of ROUTE_KINDS) {
      expect(getRouteSpec(kind).apiType).toBe("anthropic-messages");
      expect(getRouteSpec(kind).billing).toBe("plan");
    }
  });

  it("只有 off-peak / highspeed 是派生的，母体是 coding-plan", () => {
    expect(getRouteSpec("off-peak").derivesFrom).toBe("coding-plan");
    expect(getRouteSpec("highspeed").derivesFrom).toBe("coding-plan");
    for (const kind of ["coding-plan", "start-plan"] as const) {
      expect(getRouteSpec(kind).derivesFrom).toBeUndefined();
    }
  });
});

describe("叠加层", () => {
  it("只有 coding-plan 开签名，且它是唯一可挂加速卡的路由", () => {
    const signing = ROUTE_KINDS.filter((kind) => getRouteSpec(kind).layers.signing);
    expect(signing).toEqual(["coding-plan"]);
    const highspeedCapable = ROUTE_KINDS.filter((kind) => getRouteSpec(kind).layers.highspeed);
    expect(highspeedCapable).toEqual(["coding-plan"]);
  });

  it("只有 start-plan 开 captcha", () => {
    const captcha = ROUTE_KINDS.filter((kind) => getRouteSpec(kind).layers.captcha);
    expect(captcha).toEqual(["start-plan"]);
  });

  it("四条 ZCode 路由都开仿冒面（impersonation / sessionAffinity / traceHeaders）", () => {
    for (const kind of ["coding-plan", "start-plan", "off-peak", "highspeed"] as const) {
      const layers = getRouteSpec(kind).layers;
      expect(layers.impersonation).toBe(true);
      expect(layers.sessionAffinity).toBe(true);
      expect(layers.traceHeaders).toBe(true);
    }
  });

  it("只有 start-plan 由代理代填 system prompt 三块（网关 3012 检查）", () => {
    const injecting = ROUTE_KINDS.filter((kind) => getRouteSpec(kind).injectsZcodeSystemPrompt);
    expect(injecting).toEqual(["start-plan"]);
  });

  it("不开仿冒层的路由绝不代填 system prompt（不变式）", () => {
    for (const kind of ROUTE_KINDS) {
      const spec = getRouteSpec(kind);
      if (!spec.layers.impersonation) expect(spec.injectsZcodeSystemPrompt).toBe(false);
    }
  });
});

describe("requires（每条路由需要什么凭据）", () => {
  it("凭据类别与 apiKey 对 / JWT 要求逐条对得上", () => {
    expect(getRouteSpec("coding-plan").requires).toEqual({
      credentialKind: "zhipu-account",
      apiKeyPair: true,
      jwt: false,
      team: false,
    });
    expect(getRouteSpec("start-plan").requires).toEqual({
      credentialKind: "zhipu-account",
      apiKeyPair: false,
      jwt: true,
      team: false,
    });
    for (const kind of ["off-peak", "highspeed"] as const) {
      expect(getRouteSpec(kind).requires).toEqual({
        credentialKind: "zhipu-account",
        apiKeyPair: true,
        jwt: true,
        team: false,
      });
    }
  });

  it("没有路由强制要求 TEAM 身份（TEAM 是账号属性，不是路由属性）", () => {
    for (const kind of ROUTE_KINDS) {
      expect(getRouteSpec(kind).requires.team).toBe(false);
    }
  });
});

describe("模型集", () => {
  it("start-plan 不含 glm-5.3，含 flash / 5.2 / turbo", () => {
    const models = getRouteSpec("start-plan").modelIds;
    expect(models).not.toBeNull();
    expect(models).not.toContain("glm-5.3");
    expect(models).toContain("glm-5.3-flash");
    expect(models).toContain("glm-5.2");
    expect(models).toContain("glm-5-turbo");
  });

  it("coding-plan / off-peak / highspeed 都是 GLM-5.3 + Flash（小写 id）", () => {
    for (const kind of ["coding-plan", "off-peak", "highspeed"] as const) {
      expect(getRouteSpec(kind).modelIds).toEqual(["glm-5.3", "glm-5.3-flash"]);
      expect(getRouteSpec(kind).models).toBe("plan-catalog");
    }
  });

  it("所有显式模型 id 都是小写（大小写归一后的存储形态）", () => {
    for (const kind of ROUTE_KINDS) {
      for (const id of getRouteSpec(kind).modelIds ?? []) {
        expect(id).toBe(id.toLowerCase());
      }
    }
  });
});
