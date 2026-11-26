/**
 * CORE 模拟交易 · 策略与回测引擎（前后端共用，UMD）
 * ---------------------------------------------------
 * 当前仅保留自由模式：只按信号交易，不限每日成交次数。
 * 信号内核为「趋势 + 动量」策略。
 *
 * 回测在无未来函数的 4H K 线上逐根推进，按收盘价成交，计入手续费与滑点。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoreEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const INITIAL_CAPITAL = 10000;      // 初始虚拟本金 10000 USDT
  const FEE_RATE = 0.0008;            // 欧易现货 taker 约 0.08%
  const SLIPPAGE = 0.0003;            // 单边滑点 0.03%
  const BAR_MS = 4 * 3600 * 1000;     // 4 小时

  // 攻守兼备版信号内核参数（六币联合寻优：CORE/MMT/MERL/BABY/STX/HYPE，兼顾收益与稳健）
  const FAST_PERIOD = 5;
  const SLOW_PERIOD = 55;
  const RSI_PERIOD = 14;
  const ATR_PERIOD = 14;
  const BREAKOUT_LOOKBACK = 10;   // 保留字段兼容；突破入场已关闭（追高为亏损主因）
  const ATR_STOP = 2.2;           // ATR 止损 2.2，避免高波动币被正常震荡扫出
  const USE_BREAKOUT = false;     // 关闭动量突破入场，仅保留均线金叉
  const TRAILING_STOP = 0.12;     // 移动止损 12%：趋势币落袋为安，减少回吐
  const COOLDOWN_BARS = 16;       // 卖出/止损后冷却 16 根 4H（约2.7天），避免下跌趋势中反复抄底被割
  const MAX_ADD = 0;              // 不加仓：单次满仓介入，不追高摊薄

  const RULES = [
    { id: 'R1', name: '自由模式', minTrades: 0, desc: '仅按信号交易，每日无交易次数限制' }
  ];
  const STRATEGY = {
    label: '攻守兼备版',
    fast: FAST_PERIOD, slow: SLOW_PERIOD, rsi: RSI_PERIOD,
    breakoutLookback: BREAKOUT_LOOKBACK, atrStop: ATR_STOP,
    maxAdd: MAX_ADD, addFraction: 0.5, entryFraction: 0.98,
    trailingStop: TRAILING_STOP, cooldownBars: COOLDOWN_BARS, useBreakout: USE_BREAKOUT,
    note: 'EMA5/55 金叉入场满仓，不加仓；2.2ATR 止损 + 12% 移动止损锁定利润，卖出冷却约2.7天避免震荡反复被割（六币联合寻优：CORE 全年收益与稳定性兼顾，MMT/MERL/BABY 同步改善）'
  };

  const WINDOWS = [
    { key: '7d', label: '最近 1 周', days: 7 },
    { key: '1m', label: '最近 1 个月', days: 30 },
    { key: '3m', label: '最近 3 个月', days: 90 },
    { key: '6m', label: '最近 6 个月', days: 180 },
    { key: '12m', label: '最近 12 个月', days: 365 }
  ];

  /* ---------------- 指标 ---------------- */
  function ema(values, period) {
    const out = new Array(values.length).fill(null);
    if (!values.length) return out;
    const k = 2 / (period + 1);
    let prev = values[0];
    out[0] = prev;
    for (let i = 1; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function rsi(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length <= period) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = values[i] - values[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    let avgGain = gain / period, avgLoss = loss / period;
    out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    for (let i = period + 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
  }

  function atr(candles, period) {
    const out = new Array(candles.length).fill(null);
    if (candles.length <= period) return out;
    let sum = 0;
    for (let i = 1; i <= period; i++) {
      const c = candles[i], p = candles[i - 1];
      sum += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    }
    let prev = sum / period;
    out[period] = prev;
    for (let i = period + 1; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      const tr = Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
      prev = (prev * (period - 1) + tr) / period;
      out[i] = prev;
    }
    return out;
  }

  /* ---------------- 信号（攻守兼备版） ----------------
   * EMA5/55 金叉入场、死叉/超买/趋势转弱离场；突破入场已关闭。
   * 每次信号附带中文原因，供"买入时点参考"展示。
   */
  function computeSignals(candles) {
    const closes = candles.map(c => c.c);
    const fast = ema(closes, FAST_PERIOD);
    const slow = ema(closes, SLOW_PERIOD);
    const rsi14 = rsi(closes, RSI_PERIOD);
    const a14 = atr(candles, ATR_PERIOD);
    const signals = new Array(candles.length).fill(0); // 1买 -1卖 0无
    const reasons = new Array(candles.length).fill('');
    for (let i = SLOW_PERIOD + 1; i < candles.length; i++) {
      const prevFast = fast[i - 1], prevSlow = slow[i - 1];
      const nowFast = fast[i], nowSlow = slow[i];
      const r = rsi14[i];
      if (r == null || a14[i] == null) continue;
      const golden = prevFast <= prevSlow && nowFast > nowSlow;
      const death = prevFast >= prevSlow && nowFast < nowSlow;
      // 动量突破：当前收盘价突破近 N 根最高价
      let breakout = false;
      if (i > BREAKOUT_LOOKBACK) {
        let hh = -Infinity;
        for (let j = i - BREAKOUT_LOOKBACK; j < i; j++) hh = Math.max(hh, candles[j].h);
        breakout = closes[i] > hh;
      }
      // 入场：仅 EMA5/55 均线金叉（RSI<82）；动量突破关闭
      if (golden && r < 82) {
        signals[i] = 1;
        reasons[i] = '均线金叉';
      }
      // 离场：死叉 / RSI>84 超买 / 趋势转弱
      else if (death || r > 84 || (nowFast < nowSlow && prevFast >= prevSlow)) {
        signals[i] = -1;
        reasons[i] = death ? '均线死叉' : (r > 84 ? 'RSI超买' : '趋势转弱');
      }
    }
    return { signals, reasons, atr: a14 };
  }

  /** 统一生成成交记录的时间字段：UTC 与北京时间（UTC+8），精确到分钟 */
  function timeFields(ts) {
    const pad = n => String(n).padStart(2, '0');
    const d = new Date(ts);
    const bj = new Date(ts + 8 * 3600 * 1000);
    return {
      ts,
      utc: d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()),
      beijing: bj.getUTCFullYear() + '-' + pad(bj.getUTCMonth() + 1) + '-' + pad(bj.getUTCDate()) + ' ' + pad(bj.getUTCHours()) + ':' + pad(bj.getUTCMinutes())
    };
  }

  /* ---------------- 单策略回测（攻守兼备版） ---------------- */
  /** 等距降采样：保留首尾点，最多返回 max 个点，控制 JSON 体积 */
  function sampleCurve(arr, max) {
    if (arr.length <= max) return arr;
    const step = (arr.length - 1) / (max - 1);
    const out = [];
    for (let i = 0; i < max; i++) out.push(arr[Math.round(i * step)]);
    return out;
  }

  function runStrategy(candles, rule) {
    const { signals, reasons, atr: A } = computeSignals(candles);
    let cash = INITIAL_CAPITAL, qty = 0;
    let peak = INITIAL_CAPITAL, maxDD = 0;
    let trades = 0, wins = 0, losses = 0;
    let lastBuyPrice = 0;
    let peakPrice = 0;       // 持仓期最高价，用于移动止损
    let cooldownLeft = 0;    // 卖出后冷却计数（根）
    const tradeLog = [];
    const tradeLedger = [];  // 完整成交流水：每一次买入/卖出的时间、方向、价格、数量、原因
    const buySignals = [];   // 买入时点参考：每次买入的时间/价格/信号原因
    const equityCurve = [];  // 策略权益曲线（资产）
    const priceCurve = [];   // 币价曲线（每根K线收盘价），供「币的价格曲线」图表使用

    // 账户金额（市值法）：现金 + 持仓数量 × 当前价。现金视作单价 1 的持仓。
    // 区间收益 = 期末金额 / 期初金额 − 1，其中期初金额 = 初始本金（满仓买入前）。
    // 数量与价格同时参与，与用户口径「当前价×数量 对比 期初价×数量」一致。
    function equityAt(price) {
      return cash + qty * price;
    }

    function buy(price, ts, fraction, reason) {
      const budget = cash * fraction;
      if (budget < 1 || price <= 0) return false;
      const execPx = price * (1 + SLIPPAGE);
      const fee = budget * FEE_RATE;
      const amount = (budget - fee) / execPx;
      if (amount <= 0) return false;
      cash -= budget;
      const oldQty = qty;
      qty += amount;
      lastBuyPrice = (oldQty * lastBuyPrice + amount * execPx) / qty;
      if (price > peakPrice) peakPrice = price;
      trades++;
      const rec = Object.assign(timeFields(ts), {
        price: +execPx.toFixed(8), amount: +amount.toFixed(4), reason: reason || '信号买入'
      });
      tradeLog.push(Object.assign({ side: 'buy' }, rec));
      tradeLedger.push(Object.assign({ side: 'buy' }, rec));
      buySignals.push(rec);
      return true;
    }

    function sell(price, ts, fraction, reason) {
      if (qty <= 0 || price <= 0) return false;
      const amount = qty * fraction;
      const execPx = price * (1 - SLIPPAGE);
      const gross = amount * execPx;
      const fee = gross * FEE_RATE;
      cash += gross - fee;
      qty -= amount;
      const pnl = (execPx - lastBuyPrice) * amount - fee;
      if (pnl > 0) wins++; else losses++;
      trades++;
      const sellRec = Object.assign({ side: 'sell' }, timeFields(ts), {
        price: +execPx.toFixed(8), amount: +amount.toFixed(4), pnl: +pnl.toFixed(4), reason: reason || '信号卖出'
      });
      tradeLog.push(sellRec);
      tradeLedger.push(sellRec);
      cooldownLeft = COOLDOWN_BARS;
      if (qty < 1e-9) { qty = 0; lastBuyPrice = 0; peakPrice = 0; }
      return true;
    }

    // 攻守兼备版不加仓：持仓期间不再追加，避免小币追高摊薄成本
    let addOnCount = 0;
    const MAX_ADD = 0;

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const px = c.c;
      const sig = signals[i];
      const why = reasons[i];

      // 1) 信号交易：空仓且不在冷却期则满仓介入；持仓且出现新买点、浮盈则顺势加仓
      const canEnter = cooldownLeft <= 0;
      if (sig === 1 && qty === 0 && canEnter) {
        buy(px, c.t, 0.98, why);
        addOnCount = 0;
      } else if (sig === 1 && qty > 0 && addOnCount < MAX_ADD && px > lastBuyPrice * 1.01) {
        // 顺势金字塔加仓：用剩余现金的一半
        if (buy(px, c.t, 0.5, why + '·加仓')) addOnCount++;
      } else if (sig === -1 && qty > 0) {
        sell(px, c.t, 1, why);
        addOnCount = 0;
      }

      // 2) 风控：ATR 止损 + 移动止损（从持仓最高价回撤 TRAILING_STOP）
      if (qty > 0) {
        let stopped = false;
        if (A[i] != null && px < lastBuyPrice - ATR_STOP * A[i]) {
          stopped = sell(px, c.t, 1, 'ATR止损');
        }
        if (!stopped && peakPrice > 0 && px < peakPrice * (1 - TRAILING_STOP)) {
          stopped = sell(px, c.t, 1, '移动止损');
        }
        if (stopped) addOnCount = 0;
        if (px > peakPrice) peakPrice = px;
      }
      if (cooldownLeft > 0) cooldownLeft--;

      const eq = equityAt(px);
      peak = Math.max(peak, eq);
      const dd = peak > 0 ? (peak - eq) / peak : 0;
      if (dd > maxDD) maxDD = dd;
      equityCurve.push({ t: c.t, v: +eq.toFixed(4) });
      priceCurve.push({ t: c.t, v: px });
    }

    const first = candles[0] ? candles[0].c : 0;
    const last = candles.length ? candles[candles.length - 1].c : 0;
    // 区间收益 = 期末账户金额（现金 + 数量×现价）/ 期初金额 − 1（市值金额法）
    const finalEquity = equityAt(last);
    const days = candles.length > 1 ? (candles[candles.length - 1].t - candles[0].t) / 86400000 : 0;
    const ret = finalEquity / INITIAL_CAPITAL - 1;
    const annualized = days > 1 ? Math.pow(1 + ret, 365 / days) - 1 : ret;

    return {
      rule: rule.id,
      ruleName: rule.name,
      initial: INITIAL_CAPITAL,
      finalEquity: +finalEquity.toFixed(2),
      returnPct: +(ret * 100).toFixed(2),
      annualizedPct: +(annualized * 100).toFixed(2),
      maxDrawdownPct: +(maxDD * 100).toFixed(2),
      trades,
      wins,
      losses,
      winRatePct: trades > 0 ? +((wins / (wins + losses || 1)) * 100).toFixed(1) : 0,
      days: +days.toFixed(1),
      startPrice: first,
      endPrice: last,
      coinChangePct: first > 0 ? +((last / first - 1) * 100).toFixed(2) : 0,
      equityCurve,
      priceCurve: sampleCurve(priceCurve, 500),
      tradeLog: tradeLog.slice(-60),
      // 完整成交流水（时间+价格），最新在前；最多保留 2000 条避免传输过大
      tradeLedger: tradeLedger.slice(-2000).reverse(),
      ledgerTotal: tradeLedger.length,
      buySignals: buySignals.slice(-12).reverse(),  // 最近的买入时点（北京时间），供前端参考
      buyTotal: buySignals.length,
      holdingQty: +qty.toFixed(4),
      cash: +cash.toFixed(2)
    };
  }

  /* ---------------- 多窗口回测 ---------------- */
  /**
   * @param {Array} candles 4H K线
   * @param {number} [livePrice] 最新实时价。若提供（>0），用它覆盖最后一根尚未走完的
   *   K线收盘价（并同步 high/low），使最近一笔成交贴近现价；历史各笔价格不受影响。
   */
  function backtestAll(candles, livePrice) {
    const sorted = (candles || []).slice().sort((a, b) => a.t - b.t);
    if (livePrice > 0 && sorted.length) {
      const li = sorted.length - 1;
      const last = sorted[li];
      sorted[li] = Object.assign({}, last, {
        c: livePrice,
        h: Math.max(last.h || livePrice, livePrice),
        l: Math.min(last.l || livePrice, livePrice)
      });
    }
    const lastTs = sorted.length ? sorted[sorted.length - 1].t : Date.now();
    const results = {};

    for (const w of WINDOWS) {
      const from = lastTs - w.days * 86400000;
      // 预留 40 根 4H K 线作为指标预热（不产生交易）
      const warmupIdx = Math.max(0, sorted.findIndex(c => c.t >= from) - 40);
      const slice = sorted.slice(warmupIdx).filter(c => c.t >= from);
      const rows = RULES.map(rule => {
        const r = runStrategy(slice.length >= 30 ? slice : sorted.slice(-Math.min(sorted.length, 30)), rule);
        return Object.assign({}, r, {
          actualStart: slice.length ? slice[0].t : (sorted[0] ? sorted[0].t : lastTs),
          actualEnd: slice.length ? slice[slice.length - 1].t : lastTs,
          requestedDays: w.days,
          dataDays: +r.days.toFixed(1),
          insufficient: r.days < w.days * 0.8
        });
      });
      results[w.key] = rows;
    }

    return {
      windows: WINDOWS, results, ranking: [], initialCapital: INITIAL_CAPITAL,
      rules: RULES, strategy: STRATEGY,
      livePriceApplied: livePrice > 0 ? +livePrice : null
    };
  }

  /* ---------------- 实时信号状态机 ----------------
   * 与回测使用完全相同的信号内核与参数，把策略状态逐根推进到「现在」：
   *  - confirmed：截至最后一根【已收盘】4H K线的持仓状态与动作
   *  - preview  ：把当前【进行中】K线的收盘价替换为实时价后的推演
   * 两者不一致时标记 willChange，提醒用户「收盘前信号可能变化」。
   */
  const ACTION_LABELS = {
    BUY: '买入', SELL: '卖出', ADD: '加仓', HOLD: '持有',
    WAIT_COOLDOWN: '冷却中', WAIT: '观望'
  };

  /** 用与 runStrategy 一致的逻辑重放一串 K 线，返回结束时的完整策略状态 */
  function replayState(candles) {
    const { signals, reasons, atr: A } = computeSignals(candles);
    const closes = candles.map(c => c.c);
    const fast = ema(closes, FAST_PERIOD);
    const slow = ema(closes, SLOW_PERIOD);
    const rsi14 = rsi(closes, RSI_PERIOD);
    let cash = INITIAL_CAPITAL, qty = 0, lastBuyPrice = 0, peakPrice = 0;
    let cooldownLeft = 0, addOnCount = 0, lastTradeTs = 0;
    const decisions = [];
    let last = null;

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i], px = c.c, sig = signals[i], why = reasons[i];
      let decision = null;

      function buy(fraction, reason, type) {
        const budget = cash * fraction;
        if (budget < 1 || px <= 0) return false;
        const execPx = px * (1 + SLIPPAGE);
        const fee = budget * FEE_RATE;
        const amount = (budget - fee) / execPx;
        if (amount <= 0) return false;
        cash -= budget;
        const oldQty = qty;
        qty += amount;
        lastBuyPrice = (oldQty * lastBuyPrice + amount * execPx) / qty;
        if (px > peakPrice) peakPrice = px;
        decision = Object.assign(timeFields(c.t), {
          action: type, reason, price: +execPx.toFixed(8)
        });
        lastTradeTs = c.t;
        return true;
      }
      function sell(reason, type) {
        if (qty <= 0 || px <= 0) return false;
        const execPx = px * (1 - SLIPPAGE);
        const gross = qty * execPx;
        cash += gross - gross * FEE_RATE;
        decision = Object.assign(timeFields(c.t), {
          action: type, reason, price: +execPx.toFixed(8)
        });
        lastTradeTs = c.t;
        qty = 0; lastBuyPrice = 0; peakPrice = 0;
        cooldownLeft = COOLDOWN_BARS;
        return true;
      }

      const canEnter = cooldownLeft <= 0;
      if (sig === 1 && qty === 0 && canEnter) {
        buy(0.98, why, 'BUY');
        addOnCount = 0;
      } else if (sig === 1 && qty > 0 && addOnCount < MAX_ADD && px > lastBuyPrice * 1.01) {
        if (buy(0.5, why + '·加仓', 'ADD')) addOnCount++;
      } else if (sig === -1 && qty > 0) {
        sell(why, 'SELL');
        addOnCount = 0;
      }

      if (qty > 0) {
        let stopped = false;
        if (A[i] != null && px < lastBuyPrice - ATR_STOP * A[i]) stopped = sell('ATR止损', 'SELL');
        if (!stopped && peakPrice > 0 && px < peakPrice * (1 - TRAILING_STOP)) stopped = sell('移动止损', 'SELL');
        if (stopped) addOnCount = 0;
        if (px > peakPrice) peakPrice = px;
      }
      if (cooldownLeft > 0) cooldownLeft--;

      if (!decision) {
        decision = Object.assign(timeFields(c.t), {
          action: qty > 0 ? 'HOLD' : (cooldownLeft > 0 ? 'WAIT_COOLDOWN' : 'WAIT'),
          reason: qty > 0 ? '持仓中，等待信号或风控' : (cooldownLeft > 0 ? '卖出后冷却中' : '空仓观望，等待金叉'),
          price: +px.toFixed(8)
        });
      }
      last = decision;
      decisions.push(decision);
      if (decisions.length > 40) decisions.shift();
    }

    const li = candles.length - 1;
    return {
      cash, qty, lastBuyPrice, peakPrice, cooldownLeft, addOnCount, lastTradeTs,
      lastDecision: last,
      recent: decisions.slice(-8).reverse(),
      atr: li >= 0 ? A[li] : null,
      fast: li >= 0 ? fast[li] : null,
      slow: li >= 0 ? slow[li] : null,
      rsi: li >= 0 ? rsi14[li] : null
    };
  }

  /**
   * 计算「此刻」的实时交易信号。
   * @param {Array} candles 4H K线（含或不含进行中那根均可，按时间戳识别）
   * @param {number} livePrice 最新实时价；>0 时替换进行中K线的收盘价
   */
  function computeLiveSignal(candles, livePrice) {
    const sorted = (candles || []).slice()
      .filter(c => c && Number.isFinite(c.t) && Number.isFinite(c.c) && c.c > 0)
      .sort((a, b) => a.t - b.t);
    if (sorted.length < 40) return null;

    const now = Date.now();
    const curBarStart = Math.floor(now / BAR_MS) * BAR_MS;
    const lastBar = sorted[sorted.length - 1];
    const inProgress = (lastBar.t + BAR_MS > now);   // 最后一根尚未走完
    const closed = inProgress ? sorted.slice(0, -1) : sorted.slice();
    if (closed.length < 30) return null;

    const px = Number(livePrice) > 0 ? Number(livePrice) : lastBar.c;
    const conf = replayState(closed);

    // 预览：把当前进行中K线按实时价「假设收盘」
    let previewCandles;
    if (inProgress) {
      previewCandles = closed.concat([Object.assign({}, lastBar, {
        c: px, h: Math.max(lastBar.h || px, px), l: Math.min(lastBar.l || px, px)
      })]);
    } else {
      previewCandles = closed.concat([{
        t: Math.max(curBarStart, lastBar.t + BAR_MS), o: lastBar.c,
        h: Math.max(lastBar.c, px), l: Math.min(lastBar.c, px), c: px, v: 0
      }]);
    }
    const prev = replayState(previewCandles);

    function actionOf(dec, refPrice) {
      if (!dec) return { action: 'WAIT', label: '观望', reason: '数据加载中', refPrice };
      return {
        action: dec.action,
        label: ACTION_LABELS[dec.action] || dec.action,
        reason: dec.reason,
        refPrice: +(dec.price || refPrice).toFixed(8),
        time: dec.beijing,
        ts: dec.ts
      };
    }

    const current = actionOf(prev.lastDecision, px);
    const confirmed = actionOf(conf.lastDecision, px);
    const changed = prev.lastDecision && conf.lastDecision &&
      (prev.lastDecision.action !== conf.lastDecision.action ||
       prev.lastDecision.reason !== conf.lastDecision.reason);
    current.willChange = !!changed;
    current.urgent = current.action === 'SELL' && /止损/.test(prev.lastDecision ? prev.lastDecision.reason : '');
    confirmed.willChange = !!changed;

    // 风控线（基于已确认的真实持仓）
    const atrStop = (conf.qty > 0 && conf.atr != null) ? conf.lastBuyPrice - ATR_STOP * conf.atr : null;
    const trailingStop = (conf.qty > 0 && conf.peakPrice > 0) ? conf.peakPrice * (1 - TRAILING_STOP) : null;
    const activeStop = (atrStop != null && trailingStop != null) ? Math.max(atrStop, trailingStop) : (atrStop != null ? atrStop : trailingStop);
    const risk = {
      holding: conf.qty > 0,
      entry: conf.lastBuyPrice > 0 ? +conf.lastBuyPrice.toFixed(8) : null,
      peak: conf.peakPrice > 0 ? +conf.peakPrice.toFixed(8) : null,
      atrStop: atrStop != null ? +atrStop.toFixed(8) : null,
      trailingStop: trailingStop != null ? +trailingStop.toFixed(8) : null,
      activeStop: activeStop != null ? +activeStop.toFixed(8) : null,
      distancePct: (activeStop != null && px > 0) ? +((px - activeStop) / px * 100).toFixed(2) : null,
      cooldownLeft: conf.cooldownLeft,
      addOnCount: conf.addOnCount
    };

    return {
      generatedAt: now,
      price: +px.toFixed(8),
      current, confirmed,
      risk,
      indicators: {
        fast: prev.fast != null ? +prev.fast.toFixed(8) : null,
        slow: prev.slow != null ? +prev.slow.toFixed(8) : null,
        rsi: prev.rsi != null ? +prev.rsi.toFixed(2) : null,
        atr: prev.atr != null ? +prev.atr.toFixed(8) : null,
        trend: (prev.fast != null && prev.slow != null) ? (prev.fast > prev.slow ? '多头' : '空头') : '—'
      },
      recent: conf.recent,
      strategy: STRATEGY,
      barCloseAt: curBarStart + BAR_MS,
      secondsToClose: Math.max(0, Math.round((curBarStart + BAR_MS - now) / 1000)),
      lastClosedAt: closed.length ? closed[closed.length - 1].t : 0,
      inProgress,
      barsUsed: sorted.length
    };
  }

  return {
    INITIAL_CAPITAL, FEE_RATE, SLIPPAGE, BAR_MS, RULES, WINDOWS, STRATEGY,
    ema, rsi, atr, computeSignals, runStrategy, backtestAll, computeLiveSignal
  };
});
