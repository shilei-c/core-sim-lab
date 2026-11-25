/**
 * 实时交易信号服务
 * ------------------------------------------------
 * 用与站内回测完全相同的「自由模式 / 激进版」内核，把策略状态推进到当前，
 * 输出每个币种的：当前动作（买/卖/持有/观望）、持仓与风控线、指标、K线收盘倒计时。
 *
 * - CORE：使用 lib/data.js 的行情缓存
 * - MMT / MERL / BABY / STX / BTC：使用 ranking.fetchCandles 拉取（OKX→Binance→Gate 降级）
 * - 实时价：优先用 live-ticker 的最新价覆盖当前进行中 K 线收盘价
 * 静态构建（build-static.js）直接调用 compute() 生成 data/signal.json。
 */
'use strict';

const engine = require('./engine');
const data = require('./data');
const ranking = require('./ranking');
const liveTicker = require('./live-ticker');

const COINS = ['CORE', 'MMT', 'MERL', 'BABY', 'STX', 'BTC'];

let cache = { status: 'computing', generatedAt: 0, coins: {} };
let computing = false;

function buildOne(symbol, candles, livePrice, sourceName) {
  const sig = engine.computeLiveSignal(candles, livePrice);
  if (!sig) return { symbol, error: 'K线不足（' + (candles ? candles.length : 0) + ' 根）' };
  return Object.assign({}, sig, {
    symbol,
    sourceName: sourceName || '—',
    priceSource: livePrice > 0 ? '实时价覆盖当前K线' : 'K线收盘价'
  });
}

/** 计算五币实时信号，返回可序列化对象 */
async function compute(force) {
  if (computing && !force) return cache;
  computing = true;
  const started = Date.now();
  let sourceKey = 'gate';
  try { sourceKey = await ranking.detectSource(); } catch (_) {}
  const sourceName = (ranking.SOURCE_META[sourceKey] || {}).name || sourceKey;

  // 实时价（CORE 来自 data.status()，四附币来自 live-ticker）
  let live = {};
  try { live.CORE = data.status().price; } catch (_) {}
  try {
    const lt = liveTicker.get(force);
    if (lt && lt.coins) live = Object.assign({}, live, lt.coins);
  } catch (_) {}

  const coins = {};
  for (const sym of COINS) {
    try {
      if (sym === 'CORE') {
        let candles = data.getCandles();
        if (!candles || candles.length < 40) { await data.fullRefresh(true); candles = data.getCandles(); }
        coins[sym] = buildOne(sym, candles, live.CORE || 0, (data.status().sourceName || sourceName));
      } else {
        const candles = await ranking.fetchCandles(sourceKey, sym);
        const lp = live[sym] && live[sym].price > 0 ? live[sym].price : 0;
        coins[sym] = buildOne(sym, candles, lp, sourceName);
      }
    } catch (e) {
      coins[sym] = { symbol: sym, error: String(e && e.message ? e.message : e) };
    }
  }

  cache = {
    status: 'ready',
    generatedAt: Date.now(),
    durationMs: Date.now() - started,
    sourceKey, sourceName,
    coins
  };
  computing = false;
  return cache;
}

function get(force) { return cache; }
function init() { compute().catch(() => {}); }

module.exports = { init, get, compute, COINS };
