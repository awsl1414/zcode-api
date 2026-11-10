/*
 * app-accounts-plan-cards.js — 账号详情的额度模型与套餐卡渲染。
 *
 * 这一层回答两个问题：「这个账号的额度长什么样」（`planCardsOf` 的卡序列）与
 * 「一张卡怎么画」（桶行 / 窗口行 / 订阅产品行）。数据形状来自服务端额度摘要，
 * 展示口径对齐官方客户端：
 *
 *   - 分组键 = `plan_id`（一个 plan 一张卡），卡名 = 套餐实例名；无归属的桶单独
 *     成一张「未归属额度」卡，不兜底复制也不静默丢（官方 tripwire 语义）。
 *   - 状态词三态（已过期 / 待生效 / 生效中）只看当前期：过期判 `status` 与
 *     `endsAt`，待生效看 entitlement 的 `effectiveAt`。
 *   - coding 平面的用量窗口与订阅产品是**同一张卡**：卡名取订阅接口的
 *     `productName`，产品身份没采到就退回描述词并如实说明，不编造。
 *
 * **百分比语义**（契约）：条与行内数字都回答「还剩多少可用」。
 * coding 窗口的 `percentage` 是**已用**占比，进条前必须经 `remainingPercentOf`
 * 反转；credits 桶本来就是剩余语义（`remainingUnits / totalUnits`）。任何新入口
 * 先归一成剩余再调 `buildMeter`，否则条长与数字反向。
 *
 * 表格的额度列只从这里取派生值（卡序列、coding 平面判定、数据龄）：一份额度数据
 * 两个展示面，派生逻辑只有这一份；行的 DOM 归 `app-accounts-table.js`。
 */
(function (App) {
  "use strict";

  var create = App.dom.create;
  var t = App.i18n.t;
  var formatCountdown = App.format.countdown;
  var formatUnits = App.format.units;
  var formatDate = App.format.date;
  var formatShortDateTime = App.format.shortDateTime;
  var formatDateTime = App.format.dateTime;
  var formatClock = App.format.clock;

  /* ---- 百分比换算与额度条（条与数字同说「剩余」的语义契约）-------------- */

  /**
   * 已用百分比 → **剩余**百分比（上游 `percentage` 是已用占比，必须反转）。
   *
   * 官方展示端也是 `100 - percentage`（`getQuotaRemainingPercentage`），两边口径
   * 一致。缺百分比时返回 `null` 而不是 0：0% 剩余与「没采样」是两件事。
   */
  function remainingPercentOf(window_) {
    if (!window_ || typeof window_.percentage !== "number" || !isFinite(window_.percentage)) return null;
    return Math.max(0, Math.min(100, 100 - window_.percentage));
  }

  /**
   * 剩余额度的三档配色：>50% 绿、20-50% 琥珀、<20% 红。
   *
   * 琥珀是过程态例外（components.css 的 `.meter__fill--warn` 块头有依据，AGENTS.md
   * 登记）：健康徽章仍只绿 / 红，这里回答的是「还剩多少可用」，是量而不是能不能。
   */
  function toneOf(percent) {
    if (typeof percent !== "number") return "";
    if (percent > 50) return "ok";
    if (percent >= 20) return "warn";
    return "danger";
  }

  /**
   * 一根额度条：宽度是纯几何（内联百分比，不受间距档约束），颜色来自三档 token。
   *
   * **percent 入参语义 = 剩余占比 0-100**（契约）：条长回答
   * 「还剩多少可用」，与 toneOf 三档同一口径。所有入口必须先把各自的百分比
   * 归一成剩余再进来——已知的两类来源：
   *   - coding 窗口 `percentage` 是**已用**占比，经 `remainingPercentOf`
   *     反转（`100 - percentage`）后才进条；
   *   - credits 余额桶直接用 `remainingUnits / totalUnits`（本来就是剩余语义）。
   * 行内文本（额度格「剩 X/Y」、卡上「N% 剩余」）与条同口径：条长与数字
   * 必须同向，「X/Y」的分子必须点名是剩余（裸「X/Y」会被读成
   * 「已用 X」，条长就跟读出来的数字对不上）。
   *
   * 取整后夹在 0-100：上游百分比可能是 `68.4` 或越界值（`normalizeQuotaPercentage`
   * 只在上游侧钳一次，控制面透传后仍可能超）。
   */
  function buildMeter(percent) {
    var meter = create("span", "meter");
    var fill = create("span", "meter__fill meter__fill--" + toneOf(percent));
    fill.style.width = Math.max(0, Math.min(100, Math.round(percent))) + "%";
    meter.appendChild(fill);
    return meter;
  }

  /* ---- 账号详情的额度模型（套餐卡按官方样式重做）------------------------- */

  /** 桶是否已过期（渲染时判，不是采样时的 status）。*/
  function balanceExpired(balance, now) {
    return typeof balance.expiresAt === "number" && balance.expiresAt <= now;
  }

  /** 套餐实例是否已过期：上游 status 原值 expired，或 ends_at 已过。*/
  function planExpired(plan, now) {
    if (plan.status === "expired") return true;
    return typeof plan.endsAt === "number" && plan.endsAt <= now;
  }

  /**
   * 套餐的「待生效」时刻（官方 `resolvePendingStartPlanEffectiveTime`
   * 同口径）：任一 entitlement 的 `effectiveAt` 在未来 → 取最近的那个未来时刻。
   * `effectiveAt === 0` 是「立即生效」哨兵，不算未来；没有未来权益返回 `null`。
   */
  function planPendingAt(plans, now) {
    var soonest = null;
    for (var i = 0; i < plans.length; i++) {
      var entitlements = plans[i].entitlements || [];
      for (var j = 0; j < entitlements.length; j++) {
        var at = entitlements[j].effectiveAt;
        if (typeof at !== "number" || at <= 0 || at <= now) continue;
        if (soonest === null || at < soonest) soonest = at;
      }
    }
    return soonest;
  }

  /**
   * 详情大窗的套餐卡序列（官方 `resolveStartPlanQuotaCardEntries` 同口径）。
   *
   * 分组键 = `plan_id`（一个 plan 一张卡），卡片名 = 套餐实例的 `name`（如
   * 「ZCODE GLOBAL BUILD」「ZCode Start Plan」——拿桶名当卡名会让同一套餐拆成几张卡）。
   * 桶按 `planId` 精确归属到卡片；**无归属桶单独暴露**（一张「未归属额度」卡），
   * 不做兜底复制也不静默丢（官方 tripwire 语义）。
   *
   * coding 平面的用量窗口与订阅产品是**同一张卡**：卡名取官方订阅接口的
   * `productName`，状态词按当前期判据投影，续期/到期另列；卡体仍是那几行 5 小时 /
   * 每周额度窗口。产品身份采样失败时如实退回「用量窗口」描述词 + 「产品信息未采到」
   * 提示，不编造产品名、不丢窗口数据。只在账号真的服务 coding 平面时出现
   * （见 `servesCodingPlane` 的求证注释）。
   */
  function planCardsOf(account) {
    var quota = account.quota;
    if (!quota) return [];
    var now = Date.now();
    var cards = [];
    var index = {};
    // 套餐实例先成卡（同 plan_id 多实例合一张：分组键是 plan_id）。
    for (var i = 0; i < quota.plans.length; i++) {
      var plan = quota.plans[i];
      var key = "plan:" + plan.planId;
      var card = index[key];
      if (!card) {
        card = {
          key: key,
          /* 套餐卡都出自 credits 平面（billing/balance），恒属体验体系；
             订阅体系只有窗口卡。 */
          kind: "experience",
          name: plan.name,
          status: "active",
          pendingAt: null,
          expiresAt: null,
          plans: [],
          buckets: [],
          windows: null,
        };
        index[key] = card;
        cards.push(card);
      }
      card.plans.push(plan);
    }
    // 状态词三态：已过期 > 待生效 > 生效中。多实例合卡时全部过期
    // 才算过期，待生效取最近的未来生效时刻。
    for (var c = 0; c < cards.length; c++) {
      var merged = cards[c];
      if (merged.plans.every(function (p) { return planExpired(p, now); })) {
        merged.status = "expired";
      } else {
        merged.pendingAt = planPendingAt(merged.plans, now);
        if (merged.pendingAt !== null) merged.status = "pending";
      }
      // 到期时间 = 还会到期的最近时刻（都过了就留最晚的，「已过期」卡也要说出
      // 过期时间，任务口径）。
      for (var p2 = 0; p2 < merged.plans.length; p2++) {
        var endsAt = merged.plans[p2].endsAt;
        if (typeof endsAt !== "number") continue;
        if (merged.status !== "expired" && endsAt <= now) continue;
        if (merged.expiresAt === null || endsAt < merged.expiresAt) merged.expiresAt = endsAt;
      }
    }
    // 桶归属：plan_id 精确匹配；剩下的单独暴露（不静默丢）。
    var unattributed = [];
    for (var b = 0; b < quota.balances.length; b++) {
      var balance = quota.balances[b];
      var owner = balance.planId !== undefined ? index["plan:" + balance.planId] : undefined;
      if (owner) owner.buckets.push(balance);
      else unattributed.push(balance);
    }
    if (unattributed.length > 0) {
      cards.push({
        key: "unattributed",
        kind: "experience",
        name: t("accounts.quota.unattributed"),
        status: "active",
        pendingAt: null,
        expiresAt: null,
        plans: [],
        buckets: unattributed,
        windows: null,
      });
    }
    if (servesCodingPlane(account.routes) && quota.windows.length > 0) {
      /* 产品名只认订阅接口采回的 productName；采样 unknown 时卡头退回描述词
         「用量窗口」，并在卡片里说明「产品信息未采到」——不编造产品名。 */
      var product = quota.subscription;
      var hasProduct = !!(product && product.productName);
      var effective = !!(product && (
        (product.kind === "personal" && product.status === "VALID" && product.inCurrentPeriod === true) ||
        (product.kind === "team" && product.status === "EFFECTIVE" && product.memberGrantStatus === "VALID")
      ));
      cards.push({
        key: "windows",
        kind: "subscription",
        name: hasProduct ? product.productName : t("accounts.quota.section.windows"),
        // 当前期有效 / 已过期 / 状态未知三态：服务端原值不认识时不猜有效性。
        status: hasProduct ? (effective ? "active" : "expired") : "unknown",
        pendingAt: null,
        expiresAt: product && typeof product.expireTime === "number" ? product.expireTime : null,
        plans: [],
        buckets: [],
        windows: quota.windows,
        product: product || null,
      });
    }
    return cards;
  }

  /** 订阅卡状态词：当前期有效 / 已过期 / 产品信息未采到。*/
  function subscriptionStatus(card) {
    if (card.status === "active") return t("accounts.quota.subscription.active");
    if (card.status === "expired") return t("accounts.quota.subscription.expired");
    return t("accounts.quota.subscription.unknown");
  }

  /**
   * 订阅产品信息行：形态（团队/个人）、续期与到期。卡头已有状态词，
   * 这里不重复画状态标签。
   *
   * 只画上游真的给了的字段：团队接口没有 renewTime 就不画续期（官方
   * `bigmodelSubscriptionProvider.ts:45` 明确为 null）；未采到产品身份只画一行
   * 诚实说明，窗口行照常在卡体里。
   */
  function subscriptionDetailsOf(card) {
    var list = create("div", "plan-card__subscription");
    var product = card.product;
    if (!product || !product.productName) {
      list.appendChild(create("div", "plan-card__subscription-line", t("accounts.quota.subscription.unknown")));
      return list;
    }
    var kind = product.kind === "team"
      ? t("accounts.quota.subscription.team")
      : t("accounts.quota.subscription.personal");
    list.appendChild(create("span", "plan-card__subscription-line", kind));
    if (typeof product.renewTime === "number") {
      list.appendChild(create("span", "plan-card__subscription-line", t("accounts.quota.subscription.renew", { time: formatShortDateTime(product.renewTime) })));
    }
    if (typeof product.expireTime === "number") {
      list.appendChild(create("span", "plan-card__subscription-line", t("accounts.quota.subscription.expire", { time: formatShortDateTime(product.expireTime) })));
    }
    if (product.billingCycle) {
      list.appendChild(create("span", "plan-card__subscription-line", t("accounts.quota.subscription.cycle", { cycle: product.billingCycle })));
    }
    return list;
  }

  /** 桶的剩余百分比（0-100；总量缺失时 `null`，不显示 0%）。*/
  function bucketRemainingPercent(balance) {
    if (!(balance.totalUnits > 0)) return null;
    return Math.max(0, Math.min(100, (balance.remainingUnits / balance.totalUnits) * 100));
  }

  /**
   * 桶行的数值（数值 = 剩余 / 总量）：`剩 X/Y`（单位进 `title`）。
   *
   * 分子点名「剩」（契约）：这行的分子是 remainingUnits（剩余），裸
   * 「X/Y」会被读成「已用 X」，条（= 剩余占比）就跟读出来的数字反向对不上。
   * 单位不进正文：430px 的卡列放不下「数值 + 重置」两格还带单位（实测截断），
   * 单位在段标题（「可用 X token」）与本格 `title` 里可核对。
   */
  function bucketAmountText(balance) {
    return t("accounts.quota.remainingPair", {
      value: formatUnits(balance.remainingUnits),
      total: formatUnits(balance.totalUnits),
    });
  }

  /** 桶行数值的全值（title 用）：带单位。*/
  function bucketAmountTitle(balance) {
    var text = bucketAmountText(balance);
    return balance.unitType ? text + " " + balance.unitType : text;
  }

  /**
   * 桶行的重置文案（period 只作「刷新周期」文案）：
   *
   *   - daily →「每日重置 23:59」：每日重置的桶只报**时刻**——它每天重置，
   *     日期是冗余的（「每日」已经说了什么时候）；
   *   - one_time →「一次性 11/10 09:00」：一次性授予报**到期时刻**（死线）；
   *   - period 未知 → 只给时刻（不猜周期词）。
   */
  function bucketResetText(balance) {
    if (balance.period === "daily") {
      return typeof balance.expiresAt === "number"
        ? t("accounts.quota.cycle.daily") + " " + formatClock(balance.expiresAt)
        : t("accounts.quota.cycle.daily");
    }
    if (balance.period === "one_time") {
      return typeof balance.expiresAt === "number"
        ? t("accounts.quota.cycle.once") + " " + formatShortDateTime(balance.expiresAt)
        : t("accounts.quota.cycle.once");
    }
    return typeof balance.expiresAt === "number" ? formatShortDateTime(balance.expiresAt) : "";
  }

  /**
   * 模型桶行：一行一桶，名 = `show_name`（GLM-5.3 / GLM-5.3-Flash
   * 各一行）→ 条（= 剩余占比）→ 数值（剩 X/总量 Y）→ 重置时刻。
   * 桶序保持服务端序（官方口径）。过期桶灰显、不画条（余量已经不归它了）。
   */
  function buildBucketRows(buckets) {
    var list = create("div", "plan-card__buckets");
    var now = Date.now();
    for (var i = 0; i < buckets.length; i++) {
      var balance = buckets[i];
      var expired = balanceExpired(balance, now);
      var row = create("div", expired ? "plan-card__bucket plan-card__bucket--expired" : "plan-card__bucket");
      row.appendChild(create("span", "plan-card__bucket-label", balance.name));
      var percent = bucketRemainingPercent(balance);
      if (!expired && percent !== null) row.appendChild(buildMeter(percent));
      else row.appendChild(create("span", null, ""));
      var amount = create("span", "plan-card__bucket-amount", bucketAmountText(balance));
      amount.title = bucketAmountTitle(balance);
      row.appendChild(amount);
      row.appendChild(create("span", "plan-card__bucket-reset", bucketResetText(balance)));
      list.appendChild(row);
    }
    return list;
  }

  /**
   * 类型标签：体验 / 订阅套餐。类型不由 period 派生，卡序列里的
   * 两类来源是确定的（套餐卡恒体验、窗口卡恒订阅），这里保留 fail-open：未知
   * 类型不画标签（卡头只剩套餐名）。
   */
  function planKindTag(kind) {
    if (kind === "subscription") return create("span", "tag tag--accent", t("accounts.plan.kind.subscription"));
    if (kind === "experience") return create("span", "tag", t("accounts.plan.kind.experience"));
    return null;
  }

  /**
   * 一张套餐卡（按官方样式）：卡头（类型 + 名 + 时间 meta + 状态词）→
   * 模型桶行。余额卡与窗口卡共用这个壳，卡体按 `card.windows` 分叉。
   *
   * 状态词三态：待生效（`effectiveAt > now`，显示生效时间）/ 生效中 /
   * 已过期（显示过期时间）。时间 meta 与状态词并存（官方口径：「过期时间」非空
   * 即显示，不与状态词互斥）。订阅卡另带产品信息行，窗口行保留不变。
   */
  function buildPlanCard(card) {
    var box = create("div", card.status === "expired" ? "plan-card plan-card--expired" : "plan-card");

    var head = create("div", "plan-card__head");
    var kind = planKindTag(card.kind);
    if (kind) head.appendChild(kind);
    if (card.name) head.appendChild(create("span", "plan-card__name", card.name));
    if (card.status === "pending" && card.pendingAt !== null) {
      head.appendChild(create("span", "plan-card__meta", t("accounts.quota.effectiveAt", { time: formatShortDateTime(card.pendingAt) })));
    } else if (card.expiresAt !== null) {
      head.appendChild(create("span", "plan-card__meta", t("accounts.quota.expires", { time: formatShortDateTime(card.expiresAt) })));
    }
    if (card.status === "pending") {
      head.appendChild(create("span", "tag", t("accounts.quota.pending")));
    } else if (card.status === "expired") {
      head.appendChild(create("span", "tag", t("accounts.quota.expired")));
    } else if (!card.windows) {
      head.appendChild(create("span", "tag tag--ok", t("accounts.quota.active")));
    }
    box.appendChild(head);

    if (card.windows) {
      // 订阅产品级状态词；体验卡的三态在上面，窗口卡不重复画。
      if (card.product || card.status === "unknown") {
        head.appendChild(create("span", "tag " + (card.status === "active" ? "tag--ok" : ""), subscriptionStatus(card)));
      }
      box.appendChild(subscriptionDetailsOf(card));
      box.appendChild(buildWindowRows(card.windows));
      return box;
    }
    box.appendChild(buildBucketRows(card.buckets));
    return box;
  }

  /**
   * 窗口行：一行一窗口，四格——名 / 剩余百分比 / 条 / 重置。
   *
   * 重置时间的口径对齐官方（`formatQuotaResetTime` 的 `adaptive`）：5 小时窗给
   * **倒计时**（这个窗里能行动的就是这几个小时），周 / 月窗给**日期**（提前几天
   * 看到就够，精确到分是噪声）。
   */
  function buildWindowRows(windows) {
    var list = create("div", "plan-card__windows");
    for (var i = 0; i < windows.length; i++) {
      var window_ = windows[i];
      var percent = remainingPercentOf(window_);
      var row = create("div", "plan-card__window");

      var label = windowLabel(window_);
      row.appendChild(create("span", label.known ? "plan-card__window-label" : "plan-card__window-label mono", label.text));
      /* 「已用 / 总量」对放 `title`（总量没有上游字段，由 usage+remaining 反推，
         两者缺一就不算）。行内四格按官方口径只放百分比与重置，把这对数字铺进同一
         行会把重置时间挤掉；鼠标停上去仍能读到原始量。 */
      var pair = windowAmountPair(window_);
      if (pair) row.title = pair;

      row.appendChild(
        create(
          "span",
          "plan-card__window-pct quota-pct--" + toneOf(percent),
          percent === null ? t("accounts.quota.none") : t("accounts.quota.percent", { value: Math.round(percent) }),
        ),
      );

      if (percent === null) row.appendChild(create("span", null, ""));
      else row.appendChild(buildMeter(percent));

      row.appendChild(create("span", "plan-card__window-reset", resetTextOf(window_)));
      list.appendChild(row);
    }
    return list;
  }

  /**
   * 窗口的「已用 / 总量」对：coding 窗口没有上游总量字段，总量 = usage +
   * remaining 反推（官方同口径）。两者缺一就返回 `null`——把窗口身份
   * `number` 当总量（4.28亿 / 5 恒 ≥ 1）。
   *
   * 这对数字**点名分子**（「已用 … / 总量 …」）。行内的百分比与条是
   * 剩余语义，裸的「X / Y」会被读成同向——两个数字必须各自报出自己的口径。
   */
  function windowAmountPair(window_) {
    if (typeof window_.usage !== "number" || typeof window_.remaining !== "number") return null;
    return t("accounts.quota.usedPair", {
      used: formatUnits(window_.usage),
      total: formatUnits(window_.usage + window_.remaining),
    });
  }

  /** 窗口的重置文案：5 小时窗给倒计时、其余给日期；没给 `nextResetTime` 就空着。*/
  function resetTextOf(window_) {
    if (typeof window_.nextResetTime !== "number") return "";
    if (isFiveHourWindow(window_)) {
      return t("accounts.quota.reset", { time: formatCountdown(window_.nextResetTime - Date.now()) });
    }
    return formatDate(window_.nextResetTime);
  }

  /**
   * 窗口身份 → 人话（官方四格口径求证）：
   *
   *   官方 `StatusCards.tsx` 的取值：
   *     fiveHour    = findUsageLimit(limits, "TOKENS_LIMIT", 3, 5)  →「5 小时剩余」
   *     weekly      = findUsageLimit(limits, "TOKENS_LIMIT", 6)     →「每周剩余」
   *     monthlyTool = findUsageLimit(limits, "TIME_LIMIT", 5, 1)    →「工具调用」
   *     serverMcp   = snapshot.mcpQuota.aggregate                  →「ZCode MCP」
   *
   * 前三个能在 `limits[]` 里拿到，第四个在官方是** entitlement 快照的独立字段**
   * （`MCP_USAGE_QUOTA_LIMIT_TYPE` 的合成 type），我们的控制面协议只搬
   * `limits[]`，没有这一项。所以：
   *
   *   - TOKENS_LIMIT / CREDIT_LIMIT + unit=3 & number=5 → 5 小时剩余
   *   - TOKENS_LIMIT / CREDIT_LIMIT + unit=6             → 每周剩余
   *   - TIME_LIMIT                                       → 工具调用
   *   - 其余（含 MCP_USAGE_LIMIT 与未知 type）           → 原样显示 type（fail-open）
   *
   * CREDIT_LIMIT 与 TOKENS_LIMIT 等价是官方 `isSameLimitCategory` 的结论（zai 业务
   * 后端 Team Plan 用 CREDIT_LIMIT、bigmodel 用 TOKENS_LIMIT，unit/number 语义一致）。
   * `unit` 缺省（上游没给这个字段）时只有 TIME_LIMIT 能命名，token 窗退回原样——
   * 5 小时窗与每周窗同名会误导，不猜。
   */
  function windowLabel(window_) {
    var tokenWindow = window_.type === "TOKENS_LIMIT" || window_.type === "CREDIT_LIMIT";
    if (tokenWindow && window_.unit === 3 && window_.number === 5) {
      return { text: t("accounts.window.fiveHour"), known: true };
    }
    if (tokenWindow && window_.unit === 6) return { text: t("accounts.window.weekly"), known: true };
    if (window_.type === "TIME_LIMIT") return { text: t("accounts.window.tool"), known: true };
    return { text: window_.type, known: false };
  }

  /** 5 小时窗（unit=3 & number=5）：重置时间的展示口径与其它窗口不同。*/
  function isFiveHourWindow(window_) {
    return (window_.type === "TOKENS_LIMIT" || window_.type === "CREDIT_LIMIT") && window_.unit === 3 && window_.number === 5;
  }

  /* ---- coding 平面判定（用量窗口只属于 coding-plan）--------------------- */

  /**
   * 账号是否服务 coding 平面的路由（求证结论）。
   *
   * monitor 平面的窗口（TOKENS_LIMIT / CREDIT_LIMIT / TIME_LIMIT）是 **coding-plan**
   * 的用量语义：官方客户端只有 coding-plan 连接才查
   * `/api/monitor/usage/quota/limit`（`findCodingPlanQuotaLimit`），start-plan
   * 连接只读 `billing/balance`（`bigmodelUsageQuotaProvider.getStartPlanSnapshot`），
   * 从不消费窗口。我们的采集层对每个账号都打一次 monitor 端点（routes-quota.ts
   * 不分路由），于是窗口名单里没有 coding 路由的账号也会带上窗口——那份数据
   * 描述的是同一凭据的 coding-plan 用量，与它实际服务的 start-plan 无关
   * （start-plan 没有窗口，只有余额桶）。展示层按路由过滤：
   * `off-peak` / `highspeed` 是 coding-plan 的派生入口（`quota-rules.ts` 的规则），
   * 额度就是母体那套窗口，所以三个 coding 平面路由都算。
   */
  function servesCodingPlane(routes) {
    for (var i = 0; i < routes.length; i++) {
      if (routes[i] === "coding-plan" || routes[i] === "off-peak" || routes[i] === "highspeed") return true;
    }
    return false;
  }

  /* ---- 套餐段：段壳、体系分区、活动段 ------------------------------------ */

  /** 段标题行：段名 + 右侧补充（可用量 / 活动标签）。*/
  function buildSectionTitle(title, right) {
    var row = create("div", "detail__section-title");
    row.appendChild(create("span", null, title));
    if (right) row.appendChild(right);
    return row;
  }

  /** 套餐条目：名字 + 状态标签一行，下面若干行说明（到期 / 总量 / 领取时间）。*/
  function buildPlanEntry(name, tags, lines) {
    var entry = create("div", "detail__plan");
    var head = create("div", "detail__plan-head");
    head.appendChild(create("span", "detail__plan-name", name));
    for (var i = 0; i < tags.length; i++) head.appendChild(tags[i]);
    entry.appendChild(head);
    for (var j = 0; j < lines.length; j++) entry.appendChild(create("div", "detail__plan-line", lines[j]));
    return entry;
  }

  /**
   * 「套餐」段（体系分区）：卡头 + 卡片序列。
   *
   * 段标题右侧的可用合计只累加未过期桶：过期桶不虚增可用量（`availabilityNote`）。
   * 套餐为空时不画空卡——一行安静说明（空态），窗口段照常在卡序列里。
   * 数据龄：数据比一个采样周期旧时，段内一行轻量标注（刷新后随新载荷消失）。
   *
   * 体系分区：同一账号可同时持有体验套餐（Start Plan）与编程套餐（Coding
   * Plan，上游实锤），两类卡并存时按体系分区、各带小标题（官方词「体验套餐」/
   * 「编程套餐」）；单体系时退回平铺网格，不加多余层级（保持既有视觉）。分区只做
   * 段内分组渲染——卡片内部结构归 `planCardsOf` / `buildPlanCard`（订阅卡的产品名
   * 与续期字段在那里，这里不碰）。
   */
  function buildPlansSection(account) {
    var section = create("div", "detail__section");
    var quota = account.quota;
    var cards = planCardsOf(account);
    section.appendChild(buildSectionTitle(t("accounts.quota.section.plans"), availabilityNote(quota ? quota.balances : [])));
    var age = sampleAgeNote(quota);
    if (age) section.appendChild(create("div", "detail__note detail__note--quiet", age));
    if (cards.length === 0) {
      section.appendChild(create("div", "detail__note detail__note--quiet", t("accounts.quota.noPlans")));
      return section;
    }
    var coding = [];
    var experience = [];
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].kind === "subscription") coding.push(cards[i]);
      else experience.push(cards[i]);
    }
    // 单体系（含未知 kind 全落一体验侧的 fail-open）不加层级：平铺网格就是现状视觉。
    if (coding.length === 0 || experience.length === 0) {
      section.appendChild(buildCardGrid(cards));
      return section;
    }
    var groups = create("div", "plan-groups");
    groups.appendChild(buildPlanGroup(t("accounts.plan.group.experience"), experience));
    groups.appendChild(buildPlanGroup(t("accounts.plan.group.coding"), coding));
    section.appendChild(groups);
    return section;
  }

  /** 卡片网格（`.plan-cards` 双列）：分区与平铺共用同一个网格类与同一批卡。*/
  function buildCardGrid(cards) {
    var grid = create("div", "plan-cards");
    for (var i = 0; i < cards.length; i++) grid.appendChild(buildPlanCard(cards[i]));
    return grid;
  }

  /** 一个体系分区：小标题（官方词）+ 卡片网格。*/
  function buildPlanGroup(title, cards) {
    var group = create("div", "plan-group");
    group.appendChild(create("div", "plan-group__title", title));
    group.appendChild(buildCardGrid(cards));
    return group;
  }

  /**
   * 数据龄标注：采样龄超过一个采样周期才显示「上次采样 X 分钟前」
   * （tooltip 或轻量标注），刷新后随新载荷更新。数据旧不可怕，不知道旧才可怕。
   *
   * 「一个采样周期」是配置值（`accounts.quota.pollSeconds`），服务端随额度摘要
   * 一起下发（面板猜不得）；缺省按默认 300s（`DEFAULT_ACCOUNTS_QUOTA` 同值）。
   * 分钟向下取整（「X 分钟前」的惯例口径）。
   */
  function sampleAgeNote(quota) {
    if (!quota || typeof quota.sampledAt !== "number") return null;
    var ageMs = Date.now() - quota.sampledAt;
    var pollMs = (typeof quota.pollSeconds === "number" ? quota.pollSeconds : 300) * 1000;
    if (ageMs <= pollMs) return null;
    return t("accounts.quota.sampledAgo", { minutes: Math.floor(ageMs / 60000) });
  }

  /**
   * 合计可用量（桶的 remainingUnits 求和；单位取第一个有值的桶）。
   *
   * 过期桶不虚增可用量：与采样层 credits 合计同口径。它只看
   * 桶、不看窗口——窗口的额度是「速率」不是「存量」，加进 token 合计就是错的类型。
   */
  function availabilityNote(balances) {
    if (balances.length === 0) return null;
    var remaining = 0;
    var unit = "";
    var now = Date.now();
    for (var i = 0; i < balances.length; i++) {
      var balance = balances[i];
      if (balanceExpired(balance, now)) continue;
      remaining += balance.remainingUnits;
      if (!unit && balance.unitType) unit = balance.unitType;
    }
    var amount = formatUnits(remaining);
    if (unit) amount += " " + unit;
    return create("span", "detail__section-note", t("accounts.quota.available", { amount: amount }));
  }

  /** 活动套餐的状态标签：与抢活动段共用时间窗 + 台账的八种状态词。*/
  function campaignTags(campaign) {
    var normalized = {
      planId: campaign.planId,
      startsAt: typeof campaign.startsAt === "number" ? campaign.startsAt / 1000 : undefined,
      endsAt: typeof campaign.endsAt === "number" ? campaign.endsAt / 1000 : undefined,
      effectiveAt: effectiveAtOf(campaign),
      ledgerState: campaign.status === "claimed" ? "claimed" : campaign.status === "expired" ? "expired" : undefined,
    };
    var state = App.claimActivityState.stateOf(normalized, { planHolds: {} });
    return [create("span", state === "claimed" ? "tag tag--ok" : "tag", App.claimActivityState.label(state, normalized))];
  }

  /** 权益里最早的生效时刻（Unix ms → 秒）；没有时刻时不加这一项。*/
  function effectiveAtOf(campaign) {
    var entitlements = campaign.entitlements || [];
    var earliest = undefined;
    for (var i = 0; i < entitlements.length; i++) {
      var at = entitlements[i].effectiveAt;
      if (typeof at !== "number" || at <= 0) continue;
      if (earliest === undefined || at < earliest) earliest = at;
    }
    return typeof earliest === "number" ? earliest / 1000 : undefined;
  }

  /** 「本期活动」段：发现层活动，标题右侧是官方活动标签。*/
  function buildCampaignsSection(campaigns) {
    var section = create("div", "detail__section");
    section.appendChild(buildSectionTitle(t("accounts.quota.section.campaigns"), create("span", "tag", t("accounts.quota.campaignTag"))));
    for (var i = 0; i < campaigns.length; i++) {
      var campaign = campaigns[i];
      var lines = [];
      if (typeof campaign.startsAt === "number" && typeof campaign.endsAt === "number") {
        lines.push(t("accounts.quota.campaignTime", { start: formatDateTime(campaign.startsAt), end: formatDateTime(campaign.endsAt) }));
      }
      for (var j = 0; j < campaign.entitlements.length; j++) {
        var entitlement = campaign.entitlements[j];
        lines.push(entitlement.showName + " " + formatUnits(entitlement.grantUnits) + " " + entitlement.unitType);
      }
      section.appendChild(buildPlanEntry(campaign.name, campaignTags(campaign), lines));
    }
    return section;
  }

  App.accountsPlans = {
    /* 卡序列：详情大窗的套餐段与表格额度列的「+N」计数共用。*/
    planCardsOf: planCardsOf,
    buildPlansSection: buildPlansSection,
    buildCampaignsSection: buildCampaignsSection,
    /* 类型标签：详情卡头与窗体头部的 planKinds 共用。*/
    planKindTag: planKindTag,
    /* 百分比与额度条：表格额度列、套餐卡的桶行 / 窗口行共用。*/
    buildMeter: buildMeter,
    remainingPercentOf: remainingPercentOf,
    balanceExpired: balanceExpired,
    servesCodingPlane: servesCodingPlane,
    /* 数据龄：额度列的 tooltip 与套餐段的轻量标注共用同一段文案。*/
    sampleAgeNote: sampleAgeNote,
    /* 段标题行：详情大窗的健康段与本模块的套餐段共用。*/
    sectionTitle: buildSectionTitle,
  };
})(window.__zcodeApp = window.__zcodeApp || {});
