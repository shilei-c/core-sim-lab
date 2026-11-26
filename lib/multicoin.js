/**
 * 附加币种回测：MMT / MERL / BABY / STX / HYPE
 * ------------------------------------------------
 * 为「策略收益总览」与「成交明细」提供 CORE 之外的多个币种。
 * 复用 ranking 的 K 线拉取与源探测（OKX → Binance → Gate 自动降级），
 * 用与站内完全相同的「自由模式 / 攻守兼备版」内核跑多窗口回测，
 * 因此返回结构与 /api/backtest 一致（含 tradeLedger、equityCurve 等）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const engine = require('./engine');
const ranking = require('./ranking');
const liveTicker = require('./live-ticker');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'multicoin-cache.json');
const CACHE_TTL = 6 * 3600 * 1000;   // 6 小时后台自动重算
const COINS = ['MMT', 'MERL', 'BABY', 'STX', 'HYPE'];

let cache = null;          // { generatedAt, sourceName, sourceKey, coins:{ [sym]: backtestAll } }
let computing = false;
let lastForce = 0;

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return false;
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    // 校验缓存覆盖当前全部币种（避免新增币种后旧缓存被当作有效而缺失新币）
    const complete = j && j.coins && COINS.every(sym => j.coins[sym] && j.coins[sym].results && Object.keys(j.coins[sym].results).length);
    if (complete) {
      cache = j;
      return true;
    }
  } catch (_) {}
  return false;
}

function saveCache() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch (_) {}
}

/** 异步计算各附加币回测（带进度），结果写入缓存 */
async function compute() {
  if (computing) return cache;
  computing = true;
  const started = Date.now();
  let sourceKey = 'gate';
  try { sourceKey = await ranking.detectSource(); } catch (_) {}
  const sourceName = (ranking.SOURCE_META[sourceKey] || {}).name || sourceKey;

  cache = {
    generatedAt: started,
    sourceKey, sourceName,
    status: 'computing',
    progress: { done: 0, total: COINS.length },
    coins: cache && cache.coins ? cache.coins : {}
  };

  // 读取各币实时价（若已就绪），用于覆盖最后一根未走完K线收盘价
  let livePrices = {};
  try {
    const lt = liveTicker.get();
    livePrices = (lt && lt.coins) || {};
  } catch (_) {}

  for (const sym of COINS) {
    try {
      const candles = await ranking.fetchCandles(sourceKey, sym);
      if (candles && candles.length >= 30) {
        const livePrice = livePrices[sym] && livePrices[sym].price > 0 ? livePrices[sym].price : 0;
        const report = engine.backtestAll(candles, livePrice);
        cache.coins[sym] = Object.assign({ symbol: sym, sourceName, candleCount: candles.length }, report);
      } else {
        cache.coins[sym] = { symbol: sym, error: 'K线不足（' + (candles ? candles.length : 0) + ' 根）', results: {}, windows: reportWindows() };
      }
    } catch (e) {
      cache.coins[sym] = { symbol: sym, error: String(e && e.message ? e.message : e), results: {}, windows: reportWindows() };
    }
    cache.progress.done++;
  }

  cache = Object.assign({}, cache, {
    generatedAt: Date.now(),
    durationMs: Date.now() - started,
    status: 'ready',
    progress: { done: COINS.length, total: COINS.length },
    sourceName, sourceKey
  });
  saveCache();
  computing = false;
  return cache;
}

function reportWindows() {
  return engine.WINDOWS.map(w => ({ key: w.key, label: w.label }));
}

/** 对外接口：立即返回缓存；无缓存时后台开算并返回 computing 状态 */
function get(force) {
  const now = Date.now();
  const stale = !cache || cache.status !== 'ready' || (now - cache.generatedAt) > CACHE_TTL;
  if (force && now - lastForce > 60 * 1000) {
    lastForce = now;
    if (!computing) compute().catch(() => {});
  } else if (stale && !computing) {
    compute().catch(() => {});
  }
  if (!cache) {
    return { status: 'computing', generatedAt: now, progress: { done: 0, total: COINS.length }, coins: {} };
  }
  return cache;
}

function init() {
  loadCache();
  setTimeout(() => { if (!computing) compute().catch(() => {}); }, 5000);
}

module.exports = {
  init, get, compute, COINS,
  isComputing: () => computing,
  getCoin: sym => cache && cache.coins ? cache.coins[sym] : null
};
