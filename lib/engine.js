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

  // 激进版信号内核参数（基于近1年/半年/3月五币回测寻优，兼顾收益与稳健性）
  const FAST_PERIOD = 8;
  const SLOW_PERIOD = 21;
  const RSI_PERIOD = 14;
  const ATR_PERIOD = 14;
  const BREAKOUT_LOOKBACK = 10;   // 保留字段兼容；寻优后突破入场已关闭（熊市追高亏损主因）
  const ATR_STOP = 2.2;           // ATR 止损放宽，避免震荡市频繁被扫
  const USE_BREAKOUT = false;     // 关闭动量突破入场，仅保留均线金叉
  const TRAILING_STOP = 0.12;     // 移动止损：从持仓期最高价回撤 12% 止盈/止损
  const COOLDOWN_BARS = 16;       // 卖出/止损后冷却 16 根 4H K 线（约2.7天）再入场

  const RULES = [
    { id: 'R1', name: '自由模式', minTrades: 0, desc: '仅按信号交易，每日无交易次数限制' }
  ];
  const STRATEGY = {
    label: '激进版',
    fast: FAST_PERIOD, slow: SLOW_PERIOD, rsi: RSI_PERIOD,
    breakoutLookback: BREAKOUT_LOOKBACK, atrStop: ATR_STOP,
    maxAdd: 2, addFraction: 0.5, entryFraction: 0.98,
    trailingStop: TRAILING_STOP, cooldownBars: COOLDOWN_BARS, useBreakout: USE_BREAKOUT,
    note: 'EMA8/21 金叉入场，满仓介入并顺势加仓；2.2ATR 止损 + 12% 移动止损锁定利润，卖出后冷却约2.7天再入场'
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

  /* ---------------- 信号（激进版） ----------------
   * 相较原版：EMA 5/13 更快响应、均线金叉 + 动量突破双入场、RSI 阈值放宽、
   * 死叉/超买/动量转弱离场。每次信号附带中文原因，供"买入时点参考"展示。
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
      // 入场：仅均线金叉（RSI 放宽到 82）；动量突破已关闭（寻优显示熊市追高为亏损主因）
      if (golden && r < 82) {
        signals[i] = 1;
        reasons[i] = '均线金叉';
      }
      // 离场：死叉 / 超买 / 跌破快线且已转弱
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

  /* ---------------- 单策略回测（激进版） ---------------- */
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

    function equityAt(price) { return cash + qty * price; }

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

    // 激进加仓阈值：持仓浮盈且再次出现买入信号时加仓（最多 2 次）
    let addOnCount = 0;
    const MAX_ADD = 2;

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
    const finalEquity = cash + qty * last;
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

  return {
    INITIAL_CAPITAL, FEE_RATE, SLIPPAGE, BAR_MS, RULES, WINDOWS, STRATEGY,
    ema, rsi, atr, computeSignals, runStrategy, backtestAll
  };
});
