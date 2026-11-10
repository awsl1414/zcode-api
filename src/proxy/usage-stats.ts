/**
 * `getUsageStats` 的聚合器：requests.jsonl 的单遍倒序流式扫描，一次输出
 * 全部维度。
 *
 * 为什么不用内存仓：`RequestStore` 只有最近 `REQUEST_STORE_CAPACITY`（200）条，
 * 报表要的是「昨天 / 上周」；文件是全量保留的，唯一完整的数据源。为什么
 * 不落缓存：JSONL 流式扫描对几千条记录是毫秒级，每次现算免去失效问题（任务边界：
 * 实测慢了再议缓存方案）。
 *
 * 复用 `request-log.ts` 的两条底层纪律：
 *
 * - {@link readLinesBackward}：按块倒着读、跨块长行拼接、巨行丢弃。倒序扫的原因
 *   与历史分页相同——记录按收尾序追加，「最新」在文件尾；时间范围给了下界就能
 *   **提前停**：文件序 = `endedAt` 序（appendFileSync 在 `notify` 里同步执行，
 *   收尾序即落盘序），某条记录的收尾早于 `from`，比它更早落盘的记录必然也早于
 *   `from`，整段都可以不读。只有 `from` 早于文件头（或没给 `from`）才扫全文件。
 * - {@link parseRequestRecord}：同一个坏行判据（进程被杀的半行、写入中途的外部
 *   截断都跳过），聚合与历史读出对「什么算一条记录」的口径一致。
 *
 * 时间口径（自定，报告已写明）：
 *
 * - 记录归属看 **`startedAt`**：`from <= startedAt <= to`（双闭区间）才计数；
 *   开始于窗口前、结束在窗口内的跨界请求不计（与 `getRequestsHistory` 的
 *   `startedAt <= before` 游标口径同族）。
 * - 桶取整用 **UTC**：小时桶 `floor(startedAt / 3600_000)`，日桶
 *   `floor(startedAt / 86_400_000)`。不按宿主时区取整的理由：报表跨进程读
 *   （serve / 面板），桶起点必须是稳定值，DST 与时区设置不该改变它；
 *   展示层的本地化归 UI（后续批）。
 * - 空桶：`from` 与 `to` **都给了**才补零（报表画图需要连续横轴）；只给一边时
 *   只输出有数据的桶。补零有护栏：范围跨度超过 90 天不补小时桶、超过 10 年不补
 *   日桶（`from=1 to=now` 这类病态区间不该生成几万个空桶对象）。
 *
 * 维度口径（自定，报告已写明）：
 *
 * - `ok` / `failed`：`failed` = 有 `failedStage`（记录自己的失败旗标）**或**
 *   收尾状态 ≥ 400（`/v1/models`、`/mcp` 那类只记状态码的记录没有失败旗标，
 *   401/404 也算失败）；`ok` = 其余。
 * - `errors[]`：只聚合有 `failedStage` 的记录，按**产生点落下的**
 *   `RequestRecord.errorCode` 分组（stage × errorCode × count）。按错误消息前缀
 *   分类的做法已经删净：错误文案一改分类即断，而且分类词是内部实现词。缺码
 *   （旧记录 / 未归类）落 `other` 桶，不猜。
 *   状态码 ≥ 400 但没有失败旗标的记录（models/mcp 路径）进 `failed` 计数、不进
 *   `errors[]`——它们没有 stage/error 事实可归。`errorCount` = `errors[]` 计数之和。
 * - `schedule`（调度事件，全读产生点落下的结构化字段，零字符串匹配）：
 *   - `degraded` = `retry` 阶段 `event: "highspeed-fallback"`（加速卡失败切回
 *     coding-plan）；
 *   - `cooled` = `retry` 阶段 `event: "auth-rotation"`（auth 信号换号；冷却由
 *     `observeUpstream` 这个统一观测点落）；
 *   - `queueTimeout` = `errorCode === "queue-timeout"` 的失败（队列满不计入）。
 *   - 其余事件（drained 降档、`ticket-expired`）不单独成列。
 * - `cacheHit`（有效样本口径）：`samples` = `cacheReadTokens` **在场**（≠
 *   undefined）的记录数——「上游没报」与「0 命中」是两回事，分母只收前者以外；
 *   `readTokens` = 这些样本的缓存命中之和；`creationTokens` / `creationSamples` =
 *   `cacheCreationTokens` 在场的记录之和 / 条数（写桶与读桶的在场集合不必相同，
 *   分开累计；`creationSamples = 0` 是「上游一条写桶都没报」，UI 必须照这个事实
 *   说「未上报」，不能把缺席渲染成「写 0」）。小时桶里的 `cacheHitSamples` /
 *   `cacheReadTokens` 同一口径。
 * - 命中率（UI 用 `cacheHit` 的三个桶算）：
 *   `readTokens / (inputTokens + readTokens + creationTokens)`。
 *   为什么要第三块：上游 Anthropic 的 `input_tokens` 是**没命中缓存**的那部分输入
 *   （prompt 总量 = input + cache_read + cache_creation）。分母只算「读 + 写」
 *   时，在「写桶一条都没报」的数据上（真实日志 4994 条记录里 `cacheCreationTokens`
 *   0 条在场）分母只剩读，命中率恒等于 100%——一个永远 100% 的比率不是比率。
 *   真实数据上新公式是 97.5%。
 *   为什么 `inputTokens` 只累加**读桶在场**的记录：分子分母必须同一样本集合，
 *   否则更早版本落盘的记录（有 input、没有缓存桶）会把分母撑大、让命中率凭空
 *   变低，与上面「旧记录不进分母」是同一条纪律。
 * - 分组键缺值归 `-`：account / route 未定（早期失败）、apiKeyId 为空串
 *   （无归因）、旧记录没有 clientKind。`byProtocol` 用入站 `format`（openai /
 *   anthropic），直传与翻译一眼可分。
 * - 平均值只在有样本时给：`avgTotalMs` / `avgTps` / `avgTtfbMs` 是对应字段在场的
 *   记录的算术平均（undefined = 一个样本都没有，JSON 序列化时省略）。
 *
 * `heatmap` 是统计页热力图的唯一数据源（口径见 {@link UsageStatsHeatmap}）：
 * 日 / 周 / 累计三档粒度，格值 = token 总量 + `/mcp` 端点请求数。MCP 归因看请求
 * 记录里 `countDataPlane` 打的 `route` stage（{@link isMcpRecord}）——数的是
 * 「打了几次 `/mcp`」，不是「调了几个工具」（后者要解析 JSON-RPC 信封，记录里没有）。
 *
 * 四个补充维度（每个新字段都有真读点，不补无消费方的字段）：
 *
 * - `retries`：重试率。`samples` = `upstreamAttempts` **在场**的记录（旧记录没有
 *   这个键，不进分母）；`retried` = 其中尝试次数 > 1 的；`rate` = 两者之比（无样本
 *   时省略）。口径与 `retry` 阶段无关：那个阶段数的是「为什么重试」，这里数的是
 *   「上游到底被打了几次」，连接重试 / 加速卡退回 / captcha 重试 / 换号都算，
 *   所以 `retried` 可以大于 `schedule.degraded + schedule.cooled`。
 * - `queue`：acquire 排队耗时（`queueMs`，含 async 的票券等待，那类值可达数小时，
 *   所以额外给 `maxMs`）。`samples` = `queueMs` 在场；只给均值会把长尾吃掉。
 * - `bytes`：请求 / 响应字节（`requestBytes` 恒在；`responseBytes` 只在观测到的那
 *   些出口上写）。`ratio` 是**两侧都到场**的记录上 `responseBytes / requestBytes`
 *   的平均，也就是「输出字节 / 输入字节」的压缩/膨胀效果；不把总量相除，否则一条
 *   8.9 MB 的请求会把其余几百条的比值全捐掉。
 * - `byReasoningEffort`：推理强度分组（`reasoningEffort`，缺值归 `-` 桶，与其它
 *   分组同口径）。旧记录与「客户端没表达思考意图」的请求都落在 `-`，UI 要区分
 *   两者只能看 requests 数，本批不拆。
 */
import { parseRequestRecord, readLinesBackward, requestLogPath } from "./request-log.js";
import type { RequestRecord } from "./request-record.js";
import { isErrorCode } from "./error-codes.js";
import type { ErrorCode } from "./error-codes.js";

/** 小时桶宽（ms）。 */
const HOUR_MS = 3_600_000;
/** 日桶宽（ms）。 */
const DAY_MS = 86_400_000;
/** 空桶补零的护栏：跨度超过 90 天不补小时桶。 */
const HOURLY_FILL_MAX_SPAN_MS = 90 * DAY_MS;
/** 空桶补零的护栏：跨度超过 10 年不补日桶。 */
const DAILY_FILL_MAX_SPAN_MS = 3_650 * DAY_MS;

/** `getUsageStats` 命令的查询参数（控制面命令与直调共用）。 */
export interface UsageStatsQuery {
  /** 只统计 `startedAt >= from` 的记录（Unix ms）。缺省 = 从最早一条起。 */
  from?: number;
  /** 只统计 `startedAt <= to` 的记录（Unix ms）。缺省 = 到最新一条止。 */
  to?: number;
  /** 覆盖落盘路径（测试用；生产走 `requestLogPath()`）。 */
  path?: string;
}

/** 一个时间桶（hourly / daily 共用形状）。 */
export interface UsageStatsBucket {
  /** 桶起点（Unix ms，UTC 取整）。 */
  bucketStart: number;
  requests: number;
  ok: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  /** 缓存有效样本数（`cacheReadTokens` 在场的记录）。 */
  cacheHitSamples: number;
  cacheReadTokens: number;
}

/** 一个分组的统计行（byAccount / byRoute / byModel / byApiKey / byProtocol / byClientKind）。 */
export interface UsageStatsGroup {
  key: string;
  requests: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  /** `totalMs` 在场记录的平均；无样本为 undefined（序列化时省略）。 */
  avgTotalMs?: number;
  /** `tps` 在场记录的平均；无样本为 undefined。 */
  avgTps?: number;
}

export interface UsageStatsTotals {
  requests: number;
  ok: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  /** `ttfbMs` 在场记录的平均；无样本为 undefined。 */
  avgTtfbMs?: number;
  avgTps?: number;
  /** `errors[]` 计数之和（今天与 `failed` 的差 = 状态码 ≥ 400 但无失败旗标的记录）。 */
  errorCount: number;
  /**
   * 客户端自己断开的请求数（`clientAborted`，不算失败）。
   *
   * 它**不**从 `failed` 里扣除：「上游返回 5xx 之后客户端又断开」两个事实都成立，
   * `failed` 是「结果不成功」、这里是「归属」。排障时先看这一个数字：它高就是客户端
   * 侧的问题（用户点了停止 / 超时 / 网络），不是上游错误率。
   */
  aborted: number;
}

/**
 * 统计错误行：`kind` 字段就是 `RequestRecord.errorCode` 稳定键。
 *
 * 保留字段名 `kind` 是控制协议形状（CLI / 面板都读 `errors[].kind`），
 * 值不再是猜出来的内部词；用户层按 `errorCode.<code>` 查 i18n 用户词 + hint。
 */
export interface UsageStatsErrorRow {
  stage: string;
  /** 统一 errorCode 全表的一员；缺码的旧记录归 `other`（诚实兜底）。*/
  kind: ErrorCode;
  count: number;
}

export interface UsageStatsSchedule {
  /** 加速卡失败切回 coding-plan 的次数（retry 阶段 `event: "highspeed-fallback"`）。 */
  degraded: number;
  /** auth-failed 换号（触发冷却）的次数（retry 阶段 `event: "auth-rotation"`）。 */
  cooled: number;
  /** 排队没排上、等待空闲槽位超时的次数（产生点 `queue-timeout`，见文件头口径）。 */
  queueTimeout: number;
}

export interface UsageStatsCacheHit {
  /** 有效样本数：`cacheReadTokens` 在场的记录（区分「上游没报」与「0 命中」）。 */
  samples: number;
  /**
   * 有效样本（读桶在场）里**没命中缓存**的普通输入 token 之和。
   *
   * 命中率分母的第三块（口径见文件头）：漏掉它，写桶缺席时分母只剩读，比率恒
   * 100%。只累计读桶在场的记录，与分子同一样本集合。
   */
  inputTokens: number;
  readTokens: number;
  /** `cacheCreationTokens` 在场记录之和（写桶与读桶的在场集合不必相同）。 */
  creationTokens: number;
  /** `cacheCreationTokens` 在场的记录数。0 = 上游一条写桶都没报（UI 说「未上报」）。 */
  creationSamples: number;
}

/** 重试率（口径见文件头）。 */
export interface UsageStatsRetries {
  /** 有效样本：`upstreamAttempts` 在场的记录（旧记录没有这个键，不进分母）。 */
  samples: number;
  /** 其中尝试次数 > 1 的记录数。 */
  retried: number;
  /** 有效样本的尝试次数之和（含首次出线）。 */
  attempts: number;
  /** `retried / samples`；无样本时省略。 */
  rate?: number;
  /**
   * 换号（auth-failed 重放）次数合计：`retries` 的求和，与 `attempts` 分子不同——
   * 只数「换了账号」的那一类，加速卡退回 / captcha 重试不算。两个数字相减就是
   * 「同账号内的重试」。
   */
  rotations: number;
}

/** 排队耗时（`queueMs`，async 的票券等待也算在里面）。 */
export interface UsageStatsQueue {
  samples: number;
  totalMs: number;
  /** 平均值；无样本时省略。 */
  avgMs?: number;
  /** 最大值；无样本时省略。长尾（async 数小时）靠它才看得见。 */
  maxMs?: number;
}

/** 请求/响应字节与两者之比（压缩/膨胀效果）。 */
export interface UsageStatsBytes {
  /** `requestBytes` 在场数（字段恒在，理论上等于 records）。 */
  requestSamples: number;
  requestBytes: number;
  avgRequestBytes?: number;
  /** `responseBytes` 在场数（上游无 body 且无 `content-length`、或客户端中途取消时缺省）。 */
  responseSamples: number;
  responseBytes: number;
  avgResponseBytes?: number;
  /** 两侧都在场、且请求体非空（`requestBytes > 0`）的记录数（`ratio` 的分母）。 */
  ratioSamples: number;
  /** 这些记录上 `responseBytes / requestBytes` 的平均；无样本时省略。 */
  ratio?: number;
}

/**
 * 热力图的一格（日 / 周 / 累计共用形状）。
 *
 * 格值是「当日 / 当周 / 截至当日累计」的 token 总量（入 + 出）与 MCP 调用次数。
 * MCP 归因口径：`/mcp` 端点的请求——`countDataPlane`（server.ts）给这类
 * 记录打 `route` stage（`path` = `POST /mcp` 之类），数的是**请求数**（一次 JSON-RPC
 * 会话轮询算一次），不是工具调用数（那要解析 `/mcp` 信封，记录里没有）。
 */
export interface UsageStatsHeatCell {
  /** 桶起点（Unix ms，UTC 取整；周格是该周周一）。 */
  bucketStart: number;
  /** token 总量（inputTokens + outputTokens）。 */
  tokens: number;
  /** `/mcp` 端点请求数（口径见 {@link UsageStatsHeatCell}）。 */
  mcpCalls: number;
}

/**
 * 热力图聚合（统计页热力图的唯一数据源）。
 *
 * 三档粒度对应热力图的三个 tab：
 * - `daily`：日格（补零后的连续日桶，与 `daily` 桶同序）；
 * - `weekly`：周格聚合（周一起算，`bucketStart` = 周一 UTC 零点）；
 * - `cumulative`：累计（截至当日的累计总量，「总量分档」的分档对象）。
 *
 * MCP 计数归因自请求记录（`/mcp` 端点），三个粒度同一口径：daily 是当日次数、
 * weekly 是周内求和、cumulative 是截至当日累计。
 */
export interface UsageStatsHeatmap {
  daily: UsageStatsHeatCell[];
  weekly: UsageStatsHeatCell[];
  cumulative: UsageStatsHeatCell[];
}

export interface UsageStatsStats {
  totals: UsageStatsTotals;
  hourly: UsageStatsBucket[];
  daily: UsageStatsBucket[];
  /** 热力图聚合（日 / 周 / 累计三档粒度，见 {@link UsageStatsHeatmap}）。 */
  heatmap: UsageStatsHeatmap;
  byAccount: UsageStatsGroup[];
  byRoute: UsageStatsGroup[];
  byModel: UsageStatsGroup[];
  byApiKey: UsageStatsGroup[];
  byProtocol: UsageStatsGroup[];
  byClientKind: UsageStatsGroup[];
  /** 推理强度分组（`reasoningEffort`，缺值归 `-`）。 */
  byReasoningEffort: UsageStatsGroup[];
  errors: UsageStatsErrorRow[];
  schedule: UsageStatsSchedule;
  cacheHit: UsageStatsCacheHit;
  /** 重试率。 */
  retries: UsageStatsRetries;
  /** 排队耗时。 */
  queue: UsageStatsQueue;
  /** 字节与压缩效果。 */
  bytes: UsageStatsBytes;
  range: { from?: number; to?: number; records: number };
}

/** 分组累加器（输出形状之外的多余字段在收尾时剥掉）。 */
interface GroupAcc {
  requests: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  totalMsSum: number;
  totalMsN: number;
  tpsSum: number;
  tpsN: number;
}

/** 桶累加器与输出形状一致。 */
type BucketAcc = UsageStatsBucket;

/** 一遍扫描的全部累加状态（六个分组维度各一张 Map，互不混键）。 */
interface StatsAcc {
  totals: {
    requests: number;
    ok: number;
    failed: number;
    inputTokens: number;
    outputTokens: number;
    ttfbSum: number;
    ttfbN: number;
    tpsSum: number;
    tpsN: number;
    /** 客户端断开的请求数（`clientAborted`）。 */
    aborted: number;
  };
  hourly: Map<number, BucketAcc>;
  daily: Map<number, BucketAcc>;
  /** MCP 调用计数（`/mcp` 端点请求），键是日桶起点（与 `daily` 同键空间）。 */
  mcpDaily: Map<number, number>;
  byAccount: Map<string, GroupAcc>;
  byRoute: Map<string, GroupAcc>;
  byModel: Map<string, GroupAcc>;
  byApiKey: Map<string, GroupAcc>;
  byProtocol: Map<string, GroupAcc>;
  byClientKind: Map<string, GroupAcc>;
  /** 推理强度分组。 */
  byReasoningEffort: Map<string, GroupAcc>;
  errors: Map<string, number>;
  schedule: UsageStatsSchedule;
  cacheHit: UsageStatsCacheHit;
  /** 重试率累加。 */
  retries: UsageStatsRetries;
  /** 排队耗时累加（`totalMs` 是累计，`maxMs` 另行求）。 */
  queue: { samples: number; totalMs: number; maxMs: number | undefined };
  /** 字节累加（`ratioSum` 用于对每条记录先算比值再平均）。 */
  bytes: { requestSamples: number; requestBytes: number; responseSamples: number; responseBytes: number; ratioN: number; ratioSum: number };
  minStartedAt: number | undefined;
  maxEndedAt: number | undefined;
  records: number;
}

function newBucketAcc(bucketStart: number): BucketAcc {
  return { bucketStart, requests: 0, ok: 0, failed: 0, inputTokens: 0, outputTokens: 0, cacheHitSamples: 0, cacheReadTokens: 0 };
}

function newGroupAcc(): GroupAcc {
  return { requests: 0, failed: 0, inputTokens: 0, outputTokens: 0, totalMsSum: 0, totalMsN: 0, tpsSum: 0, tpsN: 0 };
}

/** 记录是否计数为失败（口径见文件头）。 */
function isFailedRecord(record: RequestRecord): boolean {
  return record.failedStage !== undefined || (record.status !== undefined && record.status >= 400);
}

/**
 * 这条记录是不是 `/mcp` 端点的请求（MCP 消耗归因）。
 *
 * `/mcp` 与 `/v1/models` 不走 `proxyRequest`，由 `countDataPlane`（server.ts）开一条
 * 只记状态码的记录，并打 `route` stage（`path` = `${method} ${path}`）。判据就是
 * 这个 stage 的 path 尾巴是 `/mcp`——`/v1/models` 的尾巴是 `/v1/models`，不混。
 */
function isMcpRecord(record: RequestRecord): boolean {
  for (const stage of record.stages) {
    if (stage.stage !== "route") continue;
    const path = stage.fields.path;
    if (typeof path === "string" && /(^|\s)\/mcp$/.test(path)) return true;
  }
  return false;
}

/** 分组键：undefined / 空串归 `-`（与 handler-log 的 ACCOUNT_MISSING 同一写法）。 */
function groupKey(value: string | undefined): string {
  if (value === undefined || value === "") return "-";
  return value;
}

/** 取或建一张分组 Map 里的累加器。 */
function groupAccOf(map: Map<string, GroupAcc>, key: string): GroupAcc {
  let group = map.get(key);
  if (group === undefined) {
    group = newGroupAcc();
    map.set(key, group);
  }
  return group;
}

/**
 * 一个数值字段（旧记录缺字段、坏行把数字写成字符串）：不是有限数就当「没观测」。
 *
 * 聚合器的输入是文件（`request-log.ts` 已经按同一套纪律筛过坏行），但**字段级**的
 * 类型不能指望：更早版本的记录没有这些键，手改过的文件里它们可能是字符串。
 * 不在这里收敛，
 * `undefined + 1` 会得到一个 NaN 并传染整张表。
 */
function finiteField(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

/** 把一条（已完成范围过滤的）记录折进一个分组累加器。 */
function foldRecord(group: GroupAcc, record: RequestRecord, failed: boolean): void {
  group.requests += 1;
  if (failed) group.failed += 1;
  group.inputTokens += record.inputTokens ?? 0;
  group.outputTokens += record.outputTokens ?? 0;
  if (record.totalMs !== undefined) {
    group.totalMsSum += record.totalMs;
    group.totalMsN += 1;
  }
  if (record.tps !== undefined) {
    group.tpsSum += record.tps;
    group.tpsN += 1;
  }
}

/** 把一条（已完成范围过滤的）记录折进一个时间桶。 */
function foldBucket(map: Map<number, BucketAcc>, bucketStart: number, record: RequestRecord, failed: boolean): void {
  let bucket = map.get(bucketStart);
  if (bucket === undefined) {
    bucket = newBucketAcc(bucketStart);
    map.set(bucketStart, bucket);
  }
  bucket.requests += 1;
  if (failed) bucket.failed += 1;
  else bucket.ok += 1;
  bucket.inputTokens += record.inputTokens ?? 0;
  bucket.outputTokens += record.outputTokens ?? 0;
  // 有效样本口径：在场才进分母，0 命中也是样本。
  if (record.cacheReadTokens !== undefined) {
    bucket.cacheHitSamples += 1;
    bucket.cacheReadTokens += record.cacheReadTokens;
  }
}

/** 把一条（已完成范围过滤的）记录折进全部累加器。 */
function accumulate(record: RequestRecord, acc: StatsAcc): void {
  const failed = isFailedRecord(record);
  acc.totals.requests += 1;
  if (failed) acc.totals.failed += 1;
  else acc.totals.ok += 1;
  acc.totals.inputTokens += record.inputTokens ?? 0;
  acc.totals.outputTokens += record.outputTokens ?? 0;
  // 客户端断开不计失败，只单独计数（口径见 UsageStatsTotals.aborted）。
  if (record.clientAborted === true) acc.totals.aborted += 1;
  // 重试率 / 排队 / 字节（有效样本口径：字段在场才进分母）。
  const attempts = finiteField(record.upstreamAttempts);
  if (attempts !== undefined) {
    acc.retries.samples += 1;
    acc.retries.attempts += attempts;
    if (attempts > 1) acc.retries.retried += 1;
  }
  // `retries` 是必填字段（旧记录也有），但它数的是「换号」，与上面的「尝试」不同：
  // 两个都累加，报表才能把「同账号重试」与「换号重放」拆开。
  acc.retries.rotations += finiteField(record.retries) ?? 0;
  const queueMs = finiteField(record.queueMs);
  if (queueMs !== undefined) {
    acc.queue.samples += 1;
    acc.queue.totalMs += queueMs;
    acc.queue.maxMs = acc.queue.maxMs === undefined ? queueMs : Math.max(acc.queue.maxMs, queueMs);
  }
  const requestBytes = finiteField(record.requestBytes);
  if (requestBytes !== undefined) {
    acc.bytes.requestSamples += 1;
    acc.bytes.requestBytes += requestBytes;
  }
  const responseBytes = finiteField(record.responseBytes);
  if (responseBytes !== undefined) {
    acc.bytes.responseSamples += 1;
    acc.bytes.responseBytes += responseBytes;
  }
  // 比值只在两侧都在场且请求体非空时算：除以 0 得到的 Infinity 会把均值变成
  // NaN（已发生的真实情形：`/v1/models` 这类无 body 的请求 requestBytes = 0）。
  if (requestBytes !== undefined && requestBytes > 0 && responseBytes !== undefined) {
    acc.bytes.ratioN += 1;
    acc.bytes.ratioSum += responseBytes / requestBytes;
  }
  if (record.ttfbMs !== undefined) {
    acc.totals.ttfbSum += record.ttfbMs;
    acc.totals.ttfbN += 1;
  }
  if (record.tps !== undefined) {
    acc.totals.tpsSum += record.tps;
    acc.totals.tpsN += 1;
  }
  acc.records += 1;
  if (acc.minStartedAt === undefined || record.startedAt < acc.minStartedAt) acc.minStartedAt = record.startedAt;
  const endBound = record.endedAt ?? record.startedAt;
  if (acc.maxEndedAt === undefined || endBound > acc.maxEndedAt) acc.maxEndedAt = endBound;

  // 时间桶（UTC 取整；startedAt 归属，见文件头口径）。
  foldBucket(acc.hourly, Math.floor(record.startedAt / HOUR_MS) * HOUR_MS, record, failed);
  foldBucket(acc.daily, Math.floor(record.startedAt / DAY_MS) * DAY_MS, record, failed);

  // MCP 调用计数（热力图 tooltip 的「MCP 消耗 N 次」，口径见文件头）。
  if (isMcpRecord(record)) {
    const day = Math.floor(record.startedAt / DAY_MS) * DAY_MS;
    acc.mcpDaily.set(day, (acc.mcpDaily.get(day) ?? 0) + 1);
  }

  // 六个分组维度（缺值归 `-`，口径见文件头）。
  foldRecord(groupAccOf(acc.byAccount, groupKey(record.account)), record, failed);
  foldRecord(groupAccOf(acc.byRoute, groupKey(record.route)), record, failed);
  foldRecord(groupAccOf(acc.byModel, groupKey(record.model)), record, failed);
  foldRecord(groupAccOf(acc.byApiKey, groupKey(record.apiKeyId)), record, failed);
  foldRecord(groupAccOf(acc.byProtocol, record.format), record, failed);
  foldRecord(groupAccOf(acc.byClientKind, groupKey(record.clientKind)), record, failed);
  // 推理强度分组（缺值归 `-`，与其它分组同口径）。
  foldRecord(groupAccOf(acc.byReasoningEffort, groupKey(record.reasoningEffort)), record, failed);

  // 调度事件（口径见文件头）。
  for (const stage of record.stages) {
    if (stage.stage !== "retry") continue;
    const event = stage.fields.event;
    if (event === "highspeed-fallback") acc.schedule.degraded += 1;
    else if (event === "auth-rotation") acc.schedule.cooled += 1;
  }
  // 排队超时读产生点的结构化 errorCode，不按消息前缀猜。
  if (record.errorCode === "queue-timeout") acc.schedule.queueTimeout += 1;

  // 错误表：只聚合有失败旗标的记录（口径见文件头）。分类键直接是产生点落下的
  // errorCode；更早版本落盘、没有该字段的记录与不认识的值归 `other`，不猜。
  if (record.failedStage !== undefined) {
    const code = isErrorCode(record.errorCode) ? record.errorCode : "other";
    const errorKey = `${record.failedStage}|${code}`;
    acc.errors.set(errorKey, (acc.errors.get(errorKey) ?? 0) + 1);
  }

  // 缓存（有效样本口径；输入 / 读 / 写三块分开累计）。
  if (record.cacheReadTokens !== undefined) {
    acc.cacheHit.samples += 1;
    acc.cacheHit.readTokens += record.cacheReadTokens;
    // 命中率分母要算上没命中缓存的普通输入。只在这批样本上累加（与分子同一
    // 样本集合），否则旧记录会把分母撑大、让命中率凭空变低（口径见文件头）。
    acc.cacheHit.inputTokens += record.inputTokens ?? 0;
  }
  if (record.cacheCreationTokens !== undefined) {
    acc.cacheHit.creationSamples += 1;
    acc.cacheHit.creationTokens += record.cacheCreationTokens;
  }
}

/** 分组累加器 → 输出行（请求多的在前，并列按键名稳定排序）。 */
function groupRows(groups: Map<string, GroupAcc>): UsageStatsGroup[] {
  const rows: UsageStatsGroup[] = [];
  for (const [key, acc] of groups) {
    const row: UsageStatsGroup = {
      key,
      requests: acc.requests,
      failed: acc.failed,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
    };
    if (acc.totalMsN > 0) row.avgTotalMs = acc.totalMsSum / acc.totalMsN;
    if (acc.tpsN > 0) row.avgTps = acc.tpsSum / acc.tpsN;
    rows.push(row);
  }
  rows.sort((a, b) => (b.requests - a.requests) || keyCompare(a.key, b.key));
  return rows;
}

function keyCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * 桶排序 + 空桶补零。
 *
 * 补零只在 `from` / `to` 都给出（且跨度在护栏内）时发生：报表画图需要连续横轴，
 * 但病态大区间不该生成几万个空对象。数据桶永远全部输出（补零只是**插入**缺失键）。
 */
function bucketRows(buckets: Map<number, BucketAcc>, from: number | undefined, to: number | undefined, width: number, fillMaxSpanMs: number): UsageStatsBucket[] {
  if (from !== undefined && to !== undefined && to - from <= fillMaxSpanMs) {
    const first = Math.floor(from / width) * width;
    const last = Math.floor(to / width) * width;
    for (let start = first; start <= last; start += width) {
      if (!buckets.has(start)) buckets.set(start, newBucketAcc(start));
    }
  }
  return [...buckets.values()].sort((a, b) => a.bucketStart - b.bucketStart);
}

/**
 * 热力图三档聚合（日 / 周 / 累计）。
 *
 * 输入是**补零后**的日桶序（`bucketRows` 的输出——热力图要连续的格子），MCP 计数
 * 另一张表（只记有调用的日，缺席即 0）。三档口径：
 *
 * - `daily`：一格 = 一天（格值 = 当日 token 总量 + 当日 `/mcp` 次数）；
 * - `weekly`：一格 = 一周（周一起算，`bucketStart` = 周一 UTC 零点；格值 = 周内
 *   各日求和——跨月的周整周归周一，与网格「周为列」的几何一致）；
 * - `cumulative`：一格 = 一天，格值 = **截至当日**的累计（含当日），「总量分档」
 *   按这列的末值（= 区间总量）取档。
 *
 * 周聚合只收有日格的周：补零后的日桶连续，周自然连续；周内的空日贡献 0。
 */
function heatmapCells(daily: UsageStatsBucket[], mcpDaily: Map<number, number>): UsageStatsHeatmap {
  const days: UsageStatsHeatCell[] = daily.map((bucket) => ({
    bucketStart: bucket.bucketStart,
    tokens: bucket.inputTokens + bucket.outputTokens,
    mcpCalls: mcpDaily.get(bucket.bucketStart) ?? 0,
  }));

  const weeks: UsageStatsHeatCell[] = [];
  let week: UsageStatsHeatCell | undefined;
  for (const day of days) {
    // UTC 星期几 → 距周一的天数（周一=0 … 周日=6）。
    const mondayOffset = (new Date(day.bucketStart).getUTCDay() + 6) % 7;
    const weekStart = day.bucketStart - mondayOffset * DAY_MS;
    if (week === undefined || week.bucketStart !== weekStart) {
      week = { bucketStart: weekStart, tokens: 0, mcpCalls: 0 };
      weeks.push(week);
    }
    week.tokens += day.tokens;
    week.mcpCalls += day.mcpCalls;
  }

  let tokens = 0;
  let mcpCalls = 0;
  const cumulative: UsageStatsHeatCell[] = days.map((day) => {
    tokens += day.tokens;
    mcpCalls += day.mcpCalls;
    return { bucketStart: day.bucketStart, tokens, mcpCalls };
  });

  return { daily: days, weekly: weeks, cumulative };
}

/**
 * 聚合一次用量统计（`getUsageStats` 的数据源）。
 *
 * 单遍倒序流式扫描（内存 O(桶数 + 分组数 + 错误行数)），坏行跳过，`from` 下界可
 * 提前停（见文件头）。参数不合法（非有限数 / ≤ 0）按缺省（不限）处理，与
 * `getRequestsHistory` 对非法游标的纪律一致。
 */
export function computeUsageStats(query: UsageStatsQuery = {}): UsageStatsStats {
  const from = typeof query.from === "number" && Number.isFinite(query.from) && query.from > 0 ? Math.floor(query.from) : undefined;
  const to = typeof query.to === "number" && Number.isFinite(query.to) && query.to > 0 ? Math.floor(query.to) : undefined;

  const acc: StatsAcc = {
    totals: { requests: 0, ok: 0, failed: 0, inputTokens: 0, outputTokens: 0, ttfbSum: 0, ttfbN: 0, tpsSum: 0, tpsN: 0, aborted: 0 },
    hourly: new Map(),
    daily: new Map(),
    mcpDaily: new Map(),
    byAccount: new Map(),
    byRoute: new Map(),
    byModel: new Map(),
    byApiKey: new Map(),
    byProtocol: new Map(),
    byClientKind: new Map(),
    byReasoningEffort: new Map(),
    errors: new Map(),
    schedule: { degraded: 0, cooled: 0, queueTimeout: 0 },
    cacheHit: { samples: 0, inputTokens: 0, readTokens: 0, creationTokens: 0, creationSamples: 0 },
    retries: { samples: 0, retried: 0, attempts: 0, rotations: 0 },
    queue: { samples: 0, totalMs: 0, maxMs: undefined },
    bytes: { requestSamples: 0, requestBytes: 0, responseSamples: 0, responseBytes: 0, ratioN: 0, ratioSum: 0 },
    minStartedAt: undefined,
    maxEndedAt: undefined,
    records: 0,
  };

  readLinesBackward(query.path ?? requestLogPath(), (line) => {
    const record = parseRequestRecord(line);
    if (record === null) return;
    // 提前停：文件序 = endedAt 序，这条的收尾早于 from ⇒ 更早的整段都出界。
    const endBound = record.endedAt ?? record.startedAt;
    if (from !== undefined && endBound < from) return true;
    // 范围过滤：startedAt ∈ [from, to]（双闭区间，口径见文件头）。
    if (to !== undefined && record.startedAt > to) return;
    if (from !== undefined && record.startedAt < from) return;
    accumulate(record, acc);
  });

  const errorRows: UsageStatsErrorRow[] = [];
  for (const [key, count] of acc.errors) {
    const sep = key.indexOf("|");
    const raw = key.slice(sep + 1);
    errorRows.push({ stage: key.slice(0, sep), kind: isErrorCode(raw) ? raw : "other", count });
  }
  errorRows.sort((a, b) => (b.count - a.count) || keyCompare(a.stage, b.stage) || keyCompare(a.kind, b.kind));

  const totals: UsageStatsTotals = {
    requests: acc.totals.requests,
    ok: acc.totals.ok,
    failed: acc.totals.failed,
    inputTokens: acc.totals.inputTokens,
    outputTokens: acc.totals.outputTokens,
    errorCount: errorRows.reduce((sum, row) => sum + row.count, 0),
    aborted: acc.totals.aborted,
  };
  if (acc.totals.ttfbN > 0) totals.avgTtfbMs = acc.totals.ttfbSum / acc.totals.ttfbN;
  if (acc.totals.tpsN > 0) totals.avgTps = acc.totals.tpsSum / acc.totals.tpsN;

  // 三个补充维度的收尾（无样本时省略派生值，与 `avgTtfbMs` 同一纪律）。
  const retries: UsageStatsRetries = {
    samples: acc.retries.samples,
    retried: acc.retries.retried,
    attempts: acc.retries.attempts,
    rotations: acc.retries.rotations,
  };
  if (acc.retries.samples > 0) retries.rate = acc.retries.retried / acc.retries.samples;

  const queue: UsageStatsQueue = { samples: acc.queue.samples, totalMs: acc.queue.totalMs };
  if (acc.queue.samples > 0) {
    queue.avgMs = acc.queue.totalMs / acc.queue.samples;
    if (acc.queue.maxMs !== undefined) queue.maxMs = acc.queue.maxMs;
  }

  const bytes: UsageStatsBytes = {
    requestSamples: acc.bytes.requestSamples,
    requestBytes: acc.bytes.requestBytes,
    responseSamples: acc.bytes.responseSamples,
    responseBytes: acc.bytes.responseBytes,
    ratioSamples: acc.bytes.ratioN,
  };
  if (acc.bytes.requestSamples > 0) bytes.avgRequestBytes = acc.bytes.requestBytes / acc.bytes.requestSamples;
  if (acc.bytes.responseSamples > 0) bytes.avgResponseBytes = acc.bytes.responseBytes / acc.bytes.responseSamples;
  if (acc.bytes.ratioN > 0) bytes.ratio = acc.bytes.ratioSum / acc.bytes.ratioN;

  const range: { from?: number; to?: number; records: number } = { records: acc.records };
  if (from !== undefined) {
    range.from = from;
  } else if (acc.records > 0) {
    range.from = acc.minStartedAt;
  }
  if (to !== undefined) {
    range.to = to;
  } else if (acc.records > 0) {
    range.to = acc.maxEndedAt;
  }

  const dailyRows = bucketRows(acc.daily, from, to, DAY_MS, DAILY_FILL_MAX_SPAN_MS);

  return {
    totals,
    hourly: bucketRows(acc.hourly, from, to, HOUR_MS, HOURLY_FILL_MAX_SPAN_MS),
    daily: dailyRows,
    heatmap: heatmapCells(dailyRows, acc.mcpDaily),
    byAccount: groupRows(acc.byAccount),
    byRoute: groupRows(acc.byRoute),
    byModel: groupRows(acc.byModel),
    byApiKey: groupRows(acc.byApiKey),
    byProtocol: groupRows(acc.byProtocol),
    byClientKind: groupRows(acc.byClientKind),
    byReasoningEffort: groupRows(acc.byReasoningEffort),
    errors: errorRows,
    schedule: acc.schedule,
    cacheHit: acc.cacheHit,
    retries,
    queue,
    bytes,
    range,
  };
}
