/**
 * 调度与健康层的面板观测：状态要能解释给人看。
 *
 * `HealthEngine.onTransition` 是健康状态变化的唯一事件源，运行时装配点
 * （`accounts/runtime.ts`）已经把每条健康状态变化写进 LogBuffer（日志页「系统」tab）。
 * 这里补的是**结构化快照**：账号页要逐路由的 reason/until + auth-invalid 标红，
 * 路由页要熔断指示 + 退避窗口，统计页的「调度事件」维度要能按 type 查。
 *
 * 为什么单独一层而不是让每个视图读 LogBuffer 的行文本：日志行是给人读的字符串，
 * 拿它做判定等于依赖文案（错误分类学要解决的问题正是这个：状态语义混在展示文案里，
 * 文案一改判定就静默失效）。事件对象进这里，
 * 页面读的是稳定字段，`/api/state` 透出时也不带日志行的格式包袱。
 *
 * 探针窗口的**精确到期时刻**在引擎内部表（`HealthEngine` 的 `probeDueAt`，认领时
 * 还会顺手推后），本层不复制那份状态、也不反推一个假时间点：页面看到的是
 * `openedAt` + `probeBackoffs`（失败翻倍次数）+ 最近事件 detail，足够回答「还在
 * 退避、退了几档」，且与引擎的真值不会分叉。
 *
 * 容量：只留最近若干条（不是永久账本——历史在日志缓冲与 requests.jsonl 里），
 * 按事件时刻倒序给页面，避免每拍轮询把整份历史重新渲染一遍。
 */
import type { HealthTransition, HealthEngine } from "./health.js";
import type { RouteBreakerStatus, RouteKind } from "./types.js";

/** 结构化健康状态变化事件（页面可直接消费的字段）。*/
export interface ObservedHealthEvent extends HealthTransition {
  /** 稳定序号：同一条状态变化在快照里只有一个身份（页面增量游标用）。*/
  seq: number;
}

/** 一条路由当前的熔断观测（未熔断的路由不出现在列表里）。*/
export interface RouteBreakerView {
  route: RouteKind;
  status: RouteBreakerStatus;
  /** 熔断打开时刻（Unix ms）。*/
  openedAt: number;
  /** 探针失败导致的退避翻倍次数（2min→4min→8min… 的档位）。*/
  probeBackoffs: number;
  /** 最近一条该路由的状态变化事件序号（页面点开看 detail 用）。*/
  lastEventSeq: number;
}

/** `/api/state` 的调度/健康观测段。*/
export interface HealthObservation {
  /** 最近的健康状态变化（倒序，最多 {@link HEALTH_EVENT_CAPACITY} 条）。*/
  events: ObservedHealthEvent[];
  /** 当前打开的路由熔断（按路由稳定顺序，不受事件到达顺序影响）。*/
  breakers: RouteBreakerView[];
  /** 事件序号游标（下次给 `since` 做增量读）。*/
  cursor: number;
}

/** 事件缓冲容量：与 LogBuffer 同一量级，页面一屏读得完。*/
export const HEALTH_EVENT_CAPACITY = 50;

/** 熔断状态 → 事件类型（开/关各一次，探针结果单独记在事件表）。*/
function breakerStatusOf(event: HealthTransition): RouteBreakerStatus {
  // `detail` 的第一段就是 openBreaker/closeBreaker 写下的稳定状态串。
  return event.detail?.startsWith("gateway-broken") ? "gateway-broken" : "endpoint-broken";
}

/**
 * 订阅健康状态变化并维护当前熔断表。
 *
 * 每个 broker 一份（由 `createBroker` 装配），返回退订函数；监听器异常在
 * `HealthEngine.emit` 里已经吞掉，这里只做纯记账。
 */
export function observeHealth(health: HealthEngine): { snapshot(): HealthObservation; stop(): void } {
  const events: ObservedHealthEvent[] = [];
  const breakers = new Map<RouteKind, RouteBreakerView>();
  let seq = 0;

  const unsubscribe = health.onTransition((event) => {
    const observed: ObservedHealthEvent = { ...event, seq: seq++ };
    events.unshift(observed);
    if (events.length > HEALTH_EVENT_CAPACITY) events.length = HEALTH_EVENT_CAPACITY;

    if (event.type === "breaker-open") {
      breakers.set(event.route, {
        route: event.route,
        status: breakerStatusOf(event),
        openedAt: event.at,
        probeBackoffs: 0,
        lastEventSeq: observed.seq,
      });
    } else if (event.type === "breaker-close") {
      breakers.delete(event.route);
    } else if (event.type === "probe-result" && event.ok === false) {
      const view = breakers.get(event.route);
      if (view) {
        breakers.set(event.route, {
          ...view,
          probeBackoffs: view.probeBackoffs + 1,
          lastEventSeq: observed.seq,
        });
      }
    }
  });

  return {
    snapshot(): HealthObservation {
      // breakers 的视图对象逐份拷贝：页面改不到内部表，轮询也不会拿到活引用。
      const ordered = [...breakers.values()]
        .sort((a, b) => a.route.localeCompare(b.route))
        .map((view) => ({ ...view }));
      return { events: events.map((event) => ({ ...event })), breakers: ordered, cursor: seq };
    },
    stop(): void {
      unsubscribe();
    },
  };
}
