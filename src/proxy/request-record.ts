/**
 * 一次请求的记录。
 *
 * 把「一个请求」做成对象，而不是分散在多处：阶段时间线在 `LogEntry.fields` 的多条
 * 日志行里，状态码 / TTFB / token / tps 在 `printRow` 的九个位置参数里，用量在
 * `observer.onRequestEnd` 的另一个对象里，三份数据格式不同，都不代表「这个请求」
 * 本身：加一个字段要改三处，读的人还得自己把三份拼回去。
 *
 * 这里把「一个请求」做成对象。`proxyRequest` 建它，各阶段往上填，收尾时算总耗时，
 * 之后终端表格、API key 用量、面板请求页读的都是同一条记录。换号重放复用同一条
 * 记录，只把 `retries` 加一：用户看到的是「一次请求」。
 *
 * 与 `log/buffer.ts` 的分工：`LogBuffer` 按时间顺序存**系统日志**（账号、抽卡、
 * 领取、配置），读取方问「刚才发生了什么」；`RequestStore` 按 `reqId` 存**请求
 * 记录**，读取方问「这一次请求经历了什么」。两者的容量、淘汰方式与过滤维度都不同，
 * 所以是两个并列的存储，谁也不写进谁。
 *
 * 本文件不做格式化，也不做聚合：渲染在 `handler-log.ts`，聚合留给读取方。
 */
import type { RouteKind } from "../accounts/types.js";
import type { ClientKind } from "./client-kind.js";
import { reasoningEffortFromBody } from "./reasoning-effort.js";
import type { ReasoningEffort } from "./reasoning-effort.js";
import type { Format } from "../translator/types.js";
import type { ErrorCode } from "./error-codes.js";

/** 请求阶段的明细条目。时间线展示用，点开某条请求才需要。*/
export interface RequestStage {
  stage: string;
  /** 相对请求开始的毫秒数。*/
  atMs: number;
  /** 该阶段的专属字段。*/
  fields: Record<string, unknown>;
}

/**
 * 一次请求的全部事实。
 *
 * 字段分四段填：入站（读 body 时）→ 调度（拿到租约时）→ 出线（发请求前）→ 响应
 * （首字节与流结束时）。可变的理由就是这个：处理过程中逐步补齐，收尾之后才完整。
 */
export interface RequestRecord {
  reqId: string;
  startedAt: number;
  endedAt?: number;

  // ---- 入站 ----
  format: Format;
  /**
   * 入站客户端归类（`client-kind.ts`，intake 阶段判定）。
   *
   * 只由请求头判定（面板自报头 / User-Agent / Claude Code 的自报信号），body 不
   * 参与。缺省 = 更早版本落盘的行或没有走归类写入点的路径；聚合时
   * 归到 "-" 桶（区分「老记录」与「other」）。
   */
  clientKind?: ClientKind;
  model: string;
  stream: boolean;
  /**
   * 客户端这一轮要求的推理强度（`reasoning-effort.ts`，四档）。
   *
   * 三套协议各有自己的词汇，都收敛到这一个字段：OpenAI chat 的 `reasoning_effort`、
   * Responses 的 `reasoning.effort`、Anthropic 的 `thinking.budget_tokens` /
   * `output_config.effort`。口径是**客户端要求的**，不是我们改写后发往上游的值
   * （见模块文件头）。
   *
   * 写入点：三条 intake（`handler.ts` / `responses-handler.ts` / `async/handler.ts`）。
   * 读取点：`usage-stats.ts` 的 `byReasoningEffort` 分组、`cli/logs.ts::formatRecordHead`
   * （`effort=`）。表格那一列（终端与面板）直接渲染这个值：
   * 面板 SSE（`routes-events.ts`）推的就是这条记录本身，不需要再加一条通路。
   * `undefined` = 客户端没表达任何思考意图（旧记录同样缺这个键，聚合归 `-`）。
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * 面板覆盖命中的档位（`provider/effort-override.ts`）。
   *
   * 与 `reasoningEffort` 的分工：那个字段永远是**客户端原始要求**（记录口径不变），
   * 这个字段只在面板 `reasoning.mode: override` 且模型在作用范围内时落
   * resolve 的结果——即 body 实际被改写成的那一档。两个都在时，日志页能同时
   * 看到「客户端要什么」与「我们发了什么」。
   *
   * 写入点：同 `reasoningEffort` 的三条 intake（resolve 命中才写）。
   * `undefined` = 透传模式，或请求的模型不在覆盖作用范围（非 reasoning 模型、
   * 未知模型）。读取点：日志页详情（`app-view-logs.js`）。
   */
  reasoningEffortOverride?: "low" | "high" | "max" | "off";
  /** 读入的原始请求体字节数（改写前）。*/
  requestBytes: number;
  /**
   * 本进程实际经手的一份响应体字节数（流式按块累计）。
   *
   * 口径随出口而变，聚合与排障都需要知道是哪一份（字段名不承诺「压缩后」或
   * 「解压后」）：
   *
   * - 直传流式：上游原始字节（压缩态），统计旁路读的就是客户端拿到的那一份；
   * - 翻译流式：翻译后的 SSE 字节（上游字节在翻译器内部，出了翻译器就不可观测）；
   * - 批量翻译：上游 JSON 文本的 UTF-8 字节；
   * - 直传非流式：字节流过时计数（`countingPassthrough`，不缓冲）；上游没有 body 时
   *   回退到 `content-length`；
   * - 异步/闲时通道：桥接 SSE 字节。
   *
   * 写入点：`handler-log.ts::observeStream`（流式）、`response-translation.ts::translatedBatchResponse`
   * 与 `handler-utils.ts::countingPassthrough` / `noteDeclaredResponseBytes`（批量直传）、
   * `response-translation.ts::upstreamErrorPassthrough`（错误体）、`responses-handler.ts` 的批量
   * 与错误出口。读取点：`usage-stats.ts` 的 `bytes` 聚合（压缩/膨胀效果）、
   * `cli/logs.ts::formatRecordHead`（`resp=…B`）。
   */
  responseBytes?: number;
  /**
   * 这次 intake 补了 `config.defaultModel`（body 没带 `model` 且配置非空）。
   *
   * 只有真注入了才是 `true`：`record.model` 本身已经是注入后的值（记录口径是
   * 「实际出线的形状」，见 `default-model.ts` 文件头），没有这个标记，「model 是
   * 客户端带的还是我们补的」在记录上不可分辨 —— 排查「客户端到底发了什么」时
   * 得靠人肉对 dump。换号重放不重跑注入分支，这个值由首次读取落定后保持。
   */
  modelInjected?: boolean;

  // ---- 调度 ----
  account?: string;
  route?: RouteKind;
  /**
   * acquire 的耗时（排队 + 选号）。
   *
   * 字段名是 `queueMs`（broker 租约排队计时）；读取点：`usage-stats.ts` 的
   * `queue` 聚合（均值/峰值）、`cli/logs.ts::formatRecordHead`。
   *
   * 写入点：`handler.ts` / `responses-handler.ts` 的 acquire 之后（`Date.now() -
   * acquireStartedAt`）、`async/handler.ts` 的票券 ready（覆盖「选号 + takeTicket +
   * 排队」全程，闲时通道可能长达数小时）。
   */
  queueMs?: number;
  /**
   * 换号次数（一次请求最多换一次）。
   *
   * 只数「换账号」：同一账号上的加速卡退回 / captcha 重试 / 连接重试都不加它，
   * 那些计入 {@link upstreamAttempts}。
   *
   * 读取点：`usage-stats.ts` 的 `retries.rotations`（换号合计）。只写不读的字段
   * 只会白占 JSONL 字节，所以每个新键都必须带一个真读点。
   */
  retries: number;
  /**
   * 这次逻辑请求一共向上游发出了几次尝试（含第一次）。
   *
   * 与 {@link retries} 的分工是「换了几次号」vs「打了几次上游」：一次成功的请求
   * 恒为 1；连接级重试（`dispatchWithConnectRetry`）、加速卡失败退回、captcha
   * 挑战重试、auth-failed 换号重放、异步票券过期重取都会让它变大。排障时
   * 「上游到底被打了几次」是「为什么慢/为什么额度少了一格」的直接影响因素。
   *
   * 写入点：`handler.ts` / `responses-handler.ts` 的 `dispatch()`（每次出线进一次，
   * 含连接重试的每一次）、`async/handler.ts` 的桥接 ready（票券第 N 次重取 = 第 N 次
   * 上游出线）。读取点：`usage-stats.ts` 的 `retries` 聚合（重试率）、
   * `cli/logs.ts` 的头部与摘要行。
   *
   * `undefined` = 更早版本落盘的行或请求根本没走到出线（绝大多数失败
   * 出口）；聚合的分母只收「在场」的样本。
   */
  upstreamAttempts?: number;

  // ---- 出线 ----
  upstreamFormat?: Format;
  upstreamUrl?: string;
  signed?: boolean;
  headerCount?: number;

  // ---- 响应 ----
  status?: number;
  /**
   * 首字节耗时。
   *
   * 流式请求取第一块 SSE 到达的时刻（那才是客户端真的开始等的地方），批量请求取
   * 上游响应头到达的时刻。两个来源都有各自的阶段字段（`upstream-resp` 记响应头，
   * `stream-end` 记首块）。
   */
  ttfbMs?: number;
  totalMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /**
   * 上游报告的缓存命中（prompt cache read）token 数。
   *
   * 语义是**在场即有效**：`undefined` = 上游没报这个桶（或旧记录），`0` = 上游
   * 明确报了「0 命中」——两者是不同的样本，聚合的缓存命中率分母只收前者以外的
   * （见 `usage-stats.ts`）。Anthropic 出线上游恒为 Anthropic 形状
   * （`usage.cache_read_input_tokens`，流式在 `message_start` 帧），翻译路径经
   * `anthropicUsageToOpenAI` 折成 `prompt_tokens_details.cached_tokens`。
   */
  cacheReadTokens?: number;
  /** 上游报告的缓存写入（cache creation）token 数。在场语义同上。*/
  cacheCreationTokens?: number;
  /** 生成速率（token/s），只在生成窗口内算，与表格那一列同源。*/
  tps?: number;
  /**
   * 本进程实际要解的压缩编码（`identity` = 未压缩）。
   *
   * 直传路径就是上游给的那个值；翻译路径上游给的是压缩字节，但本进程读的是解压后
   * 的 SSE，所以那边记 `identity`。
   */
  contentEncoding?: string;

  // ---- 失败 ----
  /** 失败发生在哪个阶段。*/
  failedStage?: string;
  /** 失败原文（detail，排障用；用户展示不读它，见 {@link errorCode}）。*/
  error?: string;
  /**
   * 错误**产生时**落下的结构化身份（`ERROR_CODES` 全表）。
   *
   * 三出口同源：健康层（`signalKindOfErrorCode`）、统计层（`usage-stats` 按它分组）、
   * 用户层（i18n `errorCode.<code>` / `.hint` 与 CLI）都只读这一个字段，零字符串
   * 匹配、零二次分类。`undefined` = 更早版本落盘的行或没走到失败出口；
   * 聚合归 `other` 桶（诚实兜底，见 `usage-stats.ts`）。
   */
  errorCode?: ErrorCode;
  /**
   * 空流软拒绝——上游 200 但零输出（流式 0 events / 非流式非
   * Message 信封）。可筛标记：面板请求页 / 日志检索「上游软拒绝」用它，与
   * 「客户端主动断开」（{@link clientAborted}）和「上游报错」都区分。
   *
   * 写入点：`handler-log.ts::observeStream` 的空流检测、
   * `response-translation.ts::translatedBatchResponse` 的非 Message 分支。只在该条件下落
   * `true`（不写 `false`），语义同 {@link clientAborted}。
   */
  zeroOutput?: true;
  /**
   * 这次请求是**客户端自己断开的**（不是上游失败）。
   *
   * 为什么必须与失败分开：客户端断开时上游那条 fetch 也报错（`lease.signal` 跟随
   * 客户端 abort），记录上看起来和「上游 5xx / 连接失败」一模一样。区分它们
   * 是排障的第一问（「grep 到的 200 条失败到底有多少是我们自己的问题」），也是
   * 统计里唯一不该算进上游错误率的那一类。
   *
   * 写入点：`handler.ts::proxyRequest` 的 finally（客户端在交接前后断开）、
   * `handler-log.ts::observeStream`（流式输出中途断开 —— 只有它知道流是不是被
   * 取消的，判定用调用方传进来的 `signal`）、`async/handler.ts` 的 finally。
   * 读取点：`usage-stats.ts` 的 `totals.aborted`、`cli/logs.ts` 的头部/摘要行。
   *
   * 只在该条件下落 `true`（不写 `false`）：`undefined` = 客户端没断（含旧记录）。
   */
  clientAborted?: boolean;

  // ---- 阶段明细（点开才用）----
  stages: RequestStage[];

  /** 归因到哪条 API key（`""` = 没有归因）。*/
  apiKeyId: string;
}

/** 记录条目容量。FIFO 淘汰，够面板与 `logs` 翻最近的请求。*/
export const REQUEST_STORE_CAPACITY = 200;

/**
 * `peekBody` 在请求体没写 `model` 时的占位。
 *
 * 它不能参与模型能力过滤：占位符不是模型 id，拿去判「这条路由支不支持」会得到
 * 「不支持」，从而把每个不带 model 的请求都判成 400。
 */
export const UNKNOWN_MODEL = "-";

/**
 * 只回答「这次请求是什么形状」：模型、是否流式，以及客户端要求的推理强度。
 *
 * 它读 body 的第一件事就要做（路由选择、模型能力过滤、表格的推理强度列都靠它），
 * 所以解析失败与字段缺失一律降级成占位值，绝不抛错：真正的 body 校验在下游各自做。
 *
 * 三个字段共用**同一次** `JSON.parse`：`reasoningEffort` 若单独再 parse 一遍，
 * 大请求体（实机见过 8.9 MB 的 glm-5.3 会话）就多付一次全量解析的成本。
 */
export function peekBody(
  body: string | undefined,
): Pick<RequestRecord, "model" | "stream"> & { reasoningEffort?: ReasoningEffort } {
  if (!body) return { model: UNKNOWN_MODEL, stream: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { model: UNKNOWN_MODEL, stream: false };
  }
  const p = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const reasoningEffort = reasoningEffortFromBody(p);
  return {
    model: typeof p.model === "string" ? p.model : UNKNOWN_MODEL,
    stream: p.stream === true,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
}

/**
 * 登记一个阶段。
 *
 * `atMs` 在这里算（相对 `startedAt`），调用方不用自己算耗时：阶段内的「多久」本来
 * 就是相对请求开始的位置，时间线上直接拿它排序与画图。
 */
export function addStage(record: RequestRecord, stage: string, fields: Record<string, unknown>): void {
  record.stages.push({ stage, atMs: Math.max(0, Date.now() - record.startedAt), fields });
}

/**
 * 记住失败发生在哪个阶段、原因是什么。
 *
 * 同时落两处是有意的：`failedStage` / `error` 给汇总表按阶段筛失败用，`stages` 里的
 * 那一条给时间线定位用。只写一处就会让另一个视图说「这个请求没有异常」。
 *
 * `errorCode` 由**产生点**传进来：所有失败出口都必须带一个稳定身份，
 * 不给就落 `other`（诚实兜底，不猜）。`error` 原文始终是 detail，不会被身份覆盖。
 */
export function failStage(record: RequestRecord, stage: string, error: string, errorCode?: ErrorCode): void {
  record.failedStage = stage;
  record.error = error;
  record.errorCode = errorCode ?? "other";
  addStage(record, stage, { error });
}

/** 给已有失败记录（流式旁路等后到的信号）补统一身份，覆盖兜底码。*/
export function noteErrorCode(record: RequestRecord, errorCode: ErrorCode): void {
  record.errorCode = errorCode;
}

/**
 * 记一次上游出线尝试。
 *
 * 单独成一个函数而不是各处写 `record.upstreamAttempts = (record.upstreamAttempts ?? 0) + 1`：
 * 「什么算一次尝试」是这条字段唯一的语义，写散在四个出口里迟早漂移（连接重试算不算？
 * 换号重放算不算？）。答案在这里：**每调用一次 `dispatch()` 就算一次**，因为那正是
 * 一次真实的上游 fetch。
 */
export function noteUpstreamAttempt(record: RequestRecord): void {
  record.upstreamAttempts = (record.upstreamAttempts ?? 0) + 1;
}

/**
 * 标记「这次请求是客户端自己断开的」。
 *
 * 只落 `true`：`undefined` 与 `false` 在记录上没有区别（旧记录也没有这个键），
 * 写 `false` 只会让 JSONL 每行都多一个键。
 */
export function markClientAborted(record: RequestRecord): void {
  record.clientAborted = true;
}

/**
 * 标记「上游 200 空流软拒绝」。
 *
 * 语义同 {@link markClientAborted}：只落 `true`，`undefined` = 不是空流。
 */
export function markZeroOutput(record: RequestRecord): void {
  record.zeroOutput = true;
}

/** `RequestStore.begin` 的入参：开一条记录时已经确定的那几项。*/
export interface RequestBegin {
  reqId: string;
  format: Format;
  /** 归因到哪条 key（`""` = 没有归因）。*/
  apiKeyId: string;
}

/**
 * 请求记录的持有者。
 *
 * 谁读它：终端表格不去（`printRow` 直接拿手上的 record）、API key 用量不去（收尾
 * 那一次 `onRequestEnd(record)`）、面板请求页与第二阶段之后的事件流会读。所以这里
 * 只管存取与变更通知，不解释记录内容。
 */
export class RequestStore {
  /** 插入有序：`Map` 的迭代顺序就是 FIFO 顺序，淘汰取最前面那个。*/
  private readonly records = new Map<string, RequestRecord>();
  private readonly listeners = new Set<(record: RequestRecord) => void>();
  /** 收尾订阅：「这条记录不再会变」的落盘时机，与实时通知分开。*/
  private readonly finalizers = new Set<(record: RequestRecord) => void>();

  constructor(private readonly capacity = REQUEST_STORE_CAPACITY) {}

  /** 新建一条记录并登记。字段先给占位值，处理过程中逐步补齐。*/
  begin(input: RequestBegin): RequestRecord {
    const record: RequestRecord = {
      reqId: input.reqId,
      startedAt: Date.now(),
      format: input.format,
      model: UNKNOWN_MODEL,
      stream: false,
      requestBytes: 0,
      retries: 0,
      stages: [],
      apiKeyId: input.apiKeyId,
    };
    this.records.set(input.reqId, record);
    this.trim();
    return record;
  }

  /** 按 reqId 取。已经过了 200 条之外的请求取不到，这是有意的上限。*/
  get(reqId: string): RequestRecord | undefined {
    return this.records.get(reqId);
  }

  /** 最近 N 条，新的在前。*/
  recent(limit: number): RequestRecord[] {
    if (limit <= 0) return [];
    const all = [...this.records.values()];
    const out: RequestRecord[] = [];
    for (let i = all.length - 1; i >= 0 && out.length < limit; i -= 1) out.push(all[i]!);
    return out;
  }

  clear(): void {
    this.records.clear();
  }

  /**
   * 启动时灌入从 JSONL 读回的历史。
   *
   * 只影响 `recent()` / `get()` 的可见内容，不触发持久化：启动时读文件、写完再被
   * 自己的 `onChange` 追加一遍，等于每次启动都把历史复制一份。
   *
   * 入参按写入顺序（旧 → 新）给。`Map` 的迭代顺序就是 FIFO 顺序，反着灌会让
   * `recent()` 把最旧的那条当最新的，`capacity` 也会淘汰掉刚读回来的记录。
   *
   * 这里不再校验字段形状：JSONL 的坏行在 `request-log.ts::readRequestRecords`
   * 那个 I/O 边界上已经筛掉了，到了这里就是一份记录数组。
   */
  hydrate(records: readonly RequestRecord[]): void {
    for (const record of records) {
      this.records.delete(record.reqId);
      this.records.set(record.reqId, record);
    }
    this.trim();
  }

  /** 订阅变更（SSE 用）。返回取消订阅函数。*/
  onChange(listener: (record: RequestRecord) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 广播一条记录的变化。
   *
   * 触发点：请求收尾（`proxyRequest` 的 `finally`，以及 `/v1/models` 与 `/mcp` 的
   * `countDataPlane`）。订阅方是面板的请求事件 SSE 与记账——它们要的是**实时**
   * 事件（响应交回客户端的那一刻就能看到）。流式请求在这一刻还没跑完统计旁路
   * （`stream-end` 阶段与 token 要等流走完），所以订阅方不能把通知当「完整记录」
   * 用；完整的时机是 {@link finalize}。
   *
   * 阶段中不广播：那需要在 11 处 `addStage` 之后各加一次 `touch`，取舍见
   * `request-log.ts`。
   */
  notify(record: RequestRecord): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(record);
      } catch {
        // 有意吞错：订阅方是 SSE 推送与记账，任何一个抛错都不能让一条已经
        // 处理完的请求变成失败。订阅方自己的错误由它自己记。
      }
    }
  }

  /**
   * 宣告一条记录不再会变。
   *
   * 与 {@link notify} 的分工：`notify` 是「请求交回客户端了」的实时事件（SSE/记账），
   * `finalize` 是「记录完整了」的落盘事件。流式请求的两个时刻差一整个流的时长——
   * token / 缓存桶 / `stream-end` 阶段都在流收尾才写进记录。订阅方：
   *
   * - `openRequestStore` 的落盘（request-log.ts）：流式记录在文件里必须带全用量；
   *   挂在 `notify` 上的话文件里的流式行永远缺 token（2026-11-08 实机复现过；
   *   面板内存视图不受影响——它读的是同一个可变对象）。
   *
   * 触发点与非流式路径：`notify` 的同一批收尾点（`finally` / `countDataPlane`）；
   * 流式路径：`observeStream` 的流收尾（经调用方传入的 `onFinal`）。一条请求
   * `finalize` **恰好一次**：调用方用 deferred 槽保证流式路径不在交接时提前调。
   */
  finalize(record: RequestRecord): void {
    for (const listener of [...this.finalizers]) {
      try {
        listener(record);
      } catch {
        // 有意吞错：落盘失败不能把一次已经处理完的请求变成错误。
      }
    }
  }

  /** 订阅收尾（落盘用）。返回取消订阅函数。*/
  onFinalize(listener: (record: RequestRecord) => void): () => void {
    this.finalizers.add(listener);
    return () => {
      this.finalizers.delete(listener);
    };
  }

  private trim(): void {
    while (this.records.size > this.capacity) {
      const oldest = this.records.keys().next();
      if (oldest.done) return;
      this.records.delete(oldest.value);
    }
  }
}

/**
 * 进程级默认实例。
 *
 * 存在的理由与 `getDefaultApiKeyManager()` 一样：`proxyRequest` 的调用方很多（三个
 * 路由文件 + 测试），要求每一处都先建一个 store 只会让「忘了传」变成静默丢记录。
 * `server.ts` 与三个入口显式传自己的实例，默认值兜住其余调用方。
 */
let defaultStore: RequestStore | null = null;

export function getDefaultRequestStore(): RequestStore {
  if (!defaultStore) defaultStore = new RequestStore();
  return defaultStore;
}

/**
 * 进程启动时刻的短标识。
 *
 * 混进 reqId 是因为计数器是模块级变量、重启归零，而 `requests.jsonl` 是 append：
 * 没有它，同一个文件里会出现多个 `#001`（实测 105 行只有 9 个不同 id）。
 *
 * **取 base36 时间戳的前 6 位。** 关键是取**高位**而不是低位：
 *
 * - `slice(-4)`（后 4 位）的取值空间是 36^4 ms ≈ **28 分钟**一个周期，两次重启
 *   间隔 28 分钟的整数倍就会撞出同一个前缀 —— 而 JSONL 是跨天累积的，这个窗口
 *   太容易命中。
 * - `slice(0, 6)` 是时间戳的高位，**永不回绕**；它的粒度是 36^(8-6) = 1296 ms ≈
 *   1.3 秒，也就是「两次重启不会在 1.3 秒内发生」。
 *
 * 再长就没必要了：7 位让 id 多一个字符，而 1.3 秒的窗口已经足够（重启是个慢操作，
 * 光进程启动就不止 1.3 秒）。
 */
const BOOT_ID = Date.now().toString(36).slice(0, 6);

let reqCounter = 0;

/**
 * 一个逻辑请求的编号（`#a1b2-001`，进程标识 + 进程内序号）。
 *
 * 编号跟请求走，不跟日志走：`/v1/messages` 与 `/v1/responses` 共用这一个计数器，
 * 所以终端上看到的时序与编号顺序一致，`logs --req` 也只会指到一条请求。
 *
 * 进程前缀解决的是重启后的歧义：`requests.jsonl` 是 append，只用进程内
 * 序号的话，文件里会堆起一批同号的 `#001`。
 */
export function nextReqId(): string {
  return `#${BOOT_ID}-${String(++reqCounter).padStart(3, "0")}`;
}
