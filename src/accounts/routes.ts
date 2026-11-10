/**
 * 内置路由表：5.0 里所有「出线事实」的唯一真源。
 *
 * 为什么路由是静态表、不接受用户自由拼装：端点、出线协议、鉴权形态、叠加层、
 * 准入要求、计费口径是**互相耦合**的。用户随手拼一个带仿冒层的路由
 * 就是自曝，拼一个没有 apiKey 对的 `coding-plan` 就是必然 401。所以
 * 组合合法性由代码保证，用户只能在合法集合里**收窄白名单**（凭据类型、路由白名单、
 * TEAM 身份这三类约束由 `manager.ts` 在写入时校验）。
 *
 * 表里的每个值都有官方依据（官方内置模板与 access type 的对应关系）：
 *
 *   官方 builtin 模板            access type                baseUrl
 *   zai-api                      zhipu-coding-plan-api-key  https://api.z.ai/api/anthropic
 *   bigmodel-api                 zhipu-coding-plan-api-key  https://open.bigmodel.cn/api/anthropic
 *   （start-plan / off-peak / highspeed 三家同在 zcode.z.ai 网关下）
 *
 * 按量计费的两个官方模板不在此表：项目只做免费套餐的多账号，按量计费是反向的
 * 使用场景，那条路由整个删掉了。
 */
import type {
  ApiType,
  Billing,
  LayerFlags,
  ModelCatalog,
  ProviderFamily,
  RouteKind,
  RouteRequires,
  RouteSpec,
} from "./types.js";

/**
 * 全 false 的层集合，`zcodeClientLayers` 的基底。
 *
 * 单列出来是为了让「哪一层关着」这件事在表里是显式的：每条 ZCode 路由只在
 * 基底上打开自己真正需要的层（见下面各条目的覆写），而不是从全开往下减。
 */
const NO_LAYERS: LayerFlags = {
  impersonation: false,
  signing: false,
  captcha: false,
  highspeed: false,
  sessionAffinity: false,
  traceHeaders: false,
};

/**
 * ZCode 客户端身份面（coding-plan / start-plan / off-peak / highspeed 共用）。
 *
 * 四条路由都是「伪装成 ZCode 桌面客户端」出线，所以仿冒头、会话亲和、归因头
 * 一律开启；差异只在签名（仅 coding-plan）、captcha（仅 start-plan）与加速卡
 * （仅 coding-plan 可挂）三项，见下面各条目的覆写。
 */
function zcodeClientLayers(overrides: Partial<LayerFlags>): LayerFlags {
  return {
    ...NO_LAYERS,
    impersonation: true,
    sessionAffinity: true,
    traceHeaders: true,
    ...overrides,
  };
}

/** 模型集：内部统一小写（官方目录写 `GLM-5.3`，比对上产前先归一）。*/
const PLAN_MODELS = ["glm-5.3", "glm-5.3-flash"] as const;

/**
 * `start-plan` 的模型集**不含** `glm-5.3`（官方 builtin 配置的完整枚举）。
 *
 * 这条事实是整个「优先 start-plan」策略的前提：请求 `glm-5.3` 时 start-plan
 * 直接出局，落到 coding-plan。并且**不做模型改写**：把 `glm-5.3` 改写成
 * `glm-5.3-flash` 塞进 start-plan 会静默降低输出质量。
 */
const START_PLAN_MODELS = ["glm-5.3-flash", "glm-5.2", "glm-5-turbo"] as const;

interface RouteSpecInput {
  kind: RouteKind;
  apiType: ApiType;
  baseUrl: Record<ProviderFamily, string>;
  layers: LayerFlags;
  requires: RouteRequires;
  derivesFrom?: RouteKind;
  billing: Billing;
  models: ModelCatalog;
  modelIds: readonly string[] | null;
  injectsZcodeSystemPrompt?: boolean;
}

function buildSpec(input: RouteSpecInput): RouteSpec {
  // 不开仿冒层的路由不允许代填 system prompt：两者同属仿冒面。这条不变式
  // 在**建表时**校验一次（边界处校验、下游不猜），而不是让请求链路每次
  // 带着一个 `layers.impersonation && …` 的守卫，或者等上游用异常形态回报。
  if (input.injectsZcodeSystemPrompt && !input.layers.impersonation) {
    throw new Error(`route "${input.kind}": injectsZcodeSystemPrompt requires layers.impersonation`);
  }
  return { injectsZcodeSystemPrompt: false, ...input };
}

/**
 * 四条内置路由。
 *
 * `sessionAffinity` / `traceHeaders` 四条全开：四条路由都走 ZCode 客户端身份面，
 * 会话亲和是「一账号一 session 命名空间」与粘性的实施点，归因头来自 `X-ZCode-*`
 * 同族。
 */
export const ROUTE_SPECS = {
  /**
   * 套餐编码主路由（个人 / 团队）。`apiKey` 对直连 family 的 anthropic 端点，
   * 唯一需要客户端签名 V4 的路由（proxy/client-signing.ts），也是唯一可挂加速卡
   * 的路由（highspeed 是它的派生入口）。
   */
  "coding-plan": buildSpec({
    kind: "coding-plan",
    apiType: "anthropic-messages",
    baseUrl: {
      zai: "https://api.z.ai/api/anthropic",
      bigmodel: "https://open.bigmodel.cn/api/anthropic",
    },
    layers: zcodeClientLayers({ signing: true, highspeed: true }),
    requires: { credentialKind: "zhipu-account", apiKeyPair: true, jwt: false, team: false },
    billing: "plan",
    models: "plan-catalog",
    modelIds: PLAN_MODELS,
  }),

  /**
   * 试用/领取的 start-plan：走 zcode.z.ai 网关，鉴权是 plan JWT，**不做签名**
   * （签名材料绑定 coding-plan 凭据），但要过验证码。
   *
   * `injectsZcodeSystemPrompt: true` 是四条 ZCode 路由里唯一的：zcode.z.ai 网关
   * 做内容检查，system 里看不到身份块就回 3012（见 types.ts 该字段的注释）。
   */
  "start-plan": buildSpec({
    kind: "start-plan",
    apiType: "anthropic-messages",
    baseUrl: {
      zai: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
      bigmodel: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
    },
    layers: zcodeClientLayers({ captcha: true }),
    requires: { credentialKind: "zhipu-account", apiKeyPair: false, jwt: true, team: false },
    billing: "plan",
    models: "plan-catalog",
    modelIds: START_PLAN_MODELS,
    injectsZcodeSystemPrompt: true,
  }),

  /**
   * 闲时通道 = async 子系统的推理侧：票券队列是准入，这条端点才是
   * 推理。鉴权同时要 plan JWT 与 apiKey 对（票券 settle 与上游鉴权各用一半），
   * 且权益必须继承同账号的 coding-plan 母体（派生的权益不能跨账号借）。
   */
  "off-peak": buildSpec({
    kind: "off-peak",
    apiType: "anthropic-messages",
    baseUrl: {
      zai: "https://zcode.z.ai/api/v1/off-peak/anthropic",
      bigmodel: "https://zcode.z.ai/api/v1/off-peak/anthropic",
    },
    layers: zcodeClientLayers({}),
    requires: { credentialKind: "zhipu-account", apiKeyPair: true, jwt: true, team: false },
    derivesFrom: "coding-plan",
    billing: "plan",
    models: "plan-catalog",
    modelIds: PLAN_MODELS,
  }),

  /**
   * 加速卡通道：用卡时临时切到这条路由（不是可长期驻留的路由）。准入由
   * coding-plan 权益 + 卡状态决定，请求带双 JWT（账号 JWT + 卡 JWT）。
   *
   * 注意 `layers.highspeed` 为 false：这里是「已经在 highspeed 上」，不是
   * 「可挂卡」，挂卡动作写在 coding-plan 那一侧。
   */
  highspeed: buildSpec({
    kind: "highspeed",
    apiType: "anthropic-messages",
    baseUrl: {
      zai: "https://zcode.z.ai/api/v1/highspeed/anthropic",
      bigmodel: "https://zcode.z.ai/api/v1/highspeed/anthropic",
    },
    layers: zcodeClientLayers({}),
    requires: { credentialKind: "zhipu-account", apiKeyPair: true, jwt: true, team: false },
    derivesFrom: "coding-plan",
    billing: "plan",
    models: "plan-catalog",
    modelIds: PLAN_MODELS,
  }),
} satisfies Record<RouteKind, RouteSpec>;

/**
 * 路由种类的稳定顺序。
 *
 * 用显式数组而不是 `Object.keys(ROUTE_SPECS)`：白名单归一化、控制面展示、
 * `routing.order` 校验都要一个确定性顺序（对象字面量的键序不该成为契约）。
 *
 * 请求侧的显式选档走 `X-ZCode-Route` 头（`proxy/handler-utils.ts::requestedRoute`）：
 * 值必须是这四个 kind 之一（小写化后比对），非法值 400 `route_unknown`；账号不允许
 * 该路由则 503 `route-not-allowed`。
 */
export const ROUTE_KINDS: readonly RouteKind[] = [
  "coding-plan",
  "start-plan",
  "off-peak",
  "highspeed",
];

/** 类型守卫：外部输入（配置文件 / 请求）里的字符串是否合法路由。*/
export function isRouteKind(value: unknown): value is RouteKind {
  return typeof value === "string" && (ROUTE_KINDS as readonly string[]).includes(value);
}

/** 取路由规格。调用方必须已经确认 kind 合法（见 {@link isRouteKind}）。*/
export function getRouteSpec(kind: RouteKind): RouteSpec {
  return ROUTE_SPECS[kind];
}

/** 某条路由在某 family 下的出线基准地址。*/
export function routeBaseUrl(kind: RouteKind, provider: ProviderFamily): string {
  return ROUTE_SPECS[kind].baseUrl[provider];
}
