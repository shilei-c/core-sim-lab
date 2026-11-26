/**
 * 全市场扫描 · 自由模式近 1 年收益 TOP10
 * ------------------------------------------------
 * 扫描范围：欧易 OKX 现货 USDT 币种池（主流币 + 热门币，排除稳定币/杠杆代币）
 * 行情源：自动探测 OKX → Binance → Gate.io，使用当前可达的真实行情；
 *        部署环境访问不了欧易时，会自动降级到可达的真实源，结果中标注实际来源。
 * 回测：与网站完全相同的「自由模式 / 攻守兼备版」信号内核，近 365 天 4H K 线。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const engine = require('./engine');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'ranking-cache.json');
const TIMEOUT = 9000;
const WINDOW_DAYS = 365;
const TOP_N = 10;
const CONCURRENCY = 6;
const CACHE_TTL = 6 * 3600 * 1000;   // 6 小时后后台自动重算
const MIN_DAYS = 300;                 // 至少接近一年的历史才纳入排名

// 欧易 OKX 现货 USDT 交易币种池（排除稳定币、杠杆代币；大小写敏感，用于拼接各交易所 symbol）
const COINS = [
  'BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT',
  'BCH', 'LTC', 'TRX', 'TON', 'SHIB', 'PEPE', 'UNI', 'AAVE', 'ATOM', 'NEAR',
  'APT', 'SUI', 'ARB', 'OP', 'INJ', 'TIA', 'SEI', 'STX', 'FIL', 'ICP',
  'ETC', 'XLM', 'HBAR', 'VET', 'ALGO', 'EGLD', 'FTM', 'RUNE', 'KAVA', 'GRT',
  'IMX', 'SAND', 'MANA', 'AXS', 'CRV', 'MKR', 'LDO', 'SNX', 'COMP', 'YFI',
  '1INCH', 'ENS', 'BLUR', 'APE', 'ZEC', 'DASH', 'XMR', 'EOS', 'WAVES', 'ZIL',
  'KLAY', 'CELO', 'THETA', 'CHZ', 'BAT', 'MASK', 'PYTH', 'JUP', 'WIF', 'BONK',
  'FLOKI', 'ENA', 'FET', 'RNDR', 'OKB', 'HYPE', 'PI', 'PUMP', 'ZORA', 'AUCTION',
  'GALA', 'LUNC', 'LUNA', 'MMT', 'IRYS', 'ACE', 'ANIME', 'TNSR', 'VELO', 'CT',
  'KMNO', 'GRASS', 'PONS', 'LRC', 'WET', 'HUMA', 'ZK', 'ANIME', 'T', 'DOOD'
];

const SOURCE_META = {
  okx: { name: 'OKX 欧易', host: 'https://www.okx.com' },
  binance: { name: 'Binance 币安', host: 'https://api.binance.com' },
  gate: { name: 'Gate.io', host: 'https://api.gateio.ws' }
};

let cache = null;              // { generatedAt, sourceName, sourceKey, scanned, eligible, top, progress }
let computing = false;
let lastForce = 0;

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return false;
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (j && Array.isArray(j.top) && j.top.length) { cache = j; return true; }
  } catch (_) {}
  return false;
}

function saveCache() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch (_) {}
}

async function httpJson(url, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout || TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 CoreSim-Ranking/1.0' },
      cache: 'no-store'
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

/**
 * 探测当前「ticker 与 K线接口都可用」的真实行情源。
 * 关键：有些环境（如 GitHub Actions）OKX 的 ticker 可达，但 history-candles
 * 拉不到数据，若只测 ticker 会误选该源导致全市场扫描 eligible=0。
 * 因此必须同时用一个基准币验证 K 线接口确实能返回足量数据。
 */
async function detectSource() {
  const tests = [
    ['okx', 'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT'],
    ['binance', 'https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT'],
    ['gate', 'https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT']
  ];
  for (const [key, url] of tests) {
    try {
      const j = await httpJson(url, 5000);
      const tickerOk = (key === 'okx' && j && j.code === '0' && j.data && j.data.length) ||
        (key === 'binance' && j && j.lastPrice) ||
        (key === 'gate' && Array.isArray(j) && j.length);
      if (!tickerOk) continue;
      // 再验证 K 线接口：用它拉一个基准币，至少要有 60 根才算可用
      const cs = await fetchCandles(key, 'BTC');
      if (cs && cs.length >= 60) return key;
    } catch (_) { /* 该源 K线不可用，继续下一个源 */ }
  }
  return 'gate';
}

/** 拉取某币近 1 年 4H K 线（约 2190 根），按来源适配分页 */
async function fetchCandles(sourceKey, symbol) {
  let all = [];
  if (sourceKey === 'okx') {
    let after = null;
    for (let page = 0; page < 24; page++) {
      const url = SOURCE_META.okx.host + '/api/v5/market/history-candles?instId=' + symbol +
        '-USDT&bar=4H&limit=100' + (after ? '&after=' + after : '');
      const j = await httpJson(url);
      if (!j || j.code !== '0' || !Array.isArray(j.data) || !j.data.length) break;
      all = all.concat(j.data.map(r => ({
        t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5]
      })).filter(c => c.t > 0 && c.c > 0));
      after = j.data[j.data.length - 1][0];
      if (all.length >= 2250) break;
    }
  } else if (sourceKey === 'binance') {
    let endTime = null;
    for (let page = 0; page < 3; page++) {
      let url = SOURCE_META.binance.host + '/api/v3/klines?symbol=' + symbol +
        'USDT&interval=4h&limit=1000';
      if (endTime) url += '&endTime=' + (endTime - 1);
      const j = await httpJson(url);
      if (!Array.isArray(j) || !j.length) break;
      all = all.concat(j.map(r => ({
        t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5]
      })).filter(c => c.t > 0 && c.c > 0));
      endTime = +j[0][0];
      if (all.length >= 2250) break;
    }
  } else {
    let to = null;
    for (let page = 0; page < 3; page++) {
      let url = SOURCE_META.gate.host + '/api/v4/spot/candlesticks?currency_pair=' +
        symbol + '_USDT&interval=4h&limit=1000';
      if (to) url += '&to=' + to;
      const j = await httpJson(url);
      if (!Array.isArray(j) || !j.length) break;
      // Gate 字段顺序: [ts(秒), quoteVol, close, high, low, open, baseVol, closed]
      const batch = j.map(r => ({
        t: +r[0] * 1000, o: +r[5], h: +r[3], l: +r[4], c: +r[2], v: +r[6]
      })).filter(c => c.t > 0 && c.c > 0);
      all = all.concat(batch);
      to = Math.floor(Math.min.apply(null, batch.map(c => c.t)) / 1000) - 1;
      if (all.length >= 2250) break;
    }
  }
  const map = new Map();
  all.forEach(c => map.set(c.t, c));
  return Array.from(map.values()).sort((a, b) => a.t - b.t);
}

/**
 * 带重试的 K 线拉取：并发扫描时偶发超时/限流会让强币被静默跳过（曾导致 MMT 从榜首消失）。
 * 单币失败重试数次，确保排名稳定，不因网络抖动漏币。
 */
async function fetchCandlesRetry(key, symbol, attempts) {
  attempts = attempts || 3;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const c = await fetchCandles(key, symbol);
      if (c && c.length >= 80) return c;
      lastErr = new Error('bars=' + (c ? c.length : 0));
    } catch (e) { lastErr = e; }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 250 * (i + 1)));
  }
  throw lastErr || new Error('fetch failed');
}

/** 用自由模式（R1）跑近 1 年回测 */
function backtestOne(candles) {
  if (!candles || candles.length < 80) return null;
  const lastTs = candles[candles.length - 1].t;
  const from = lastTs - WINDOW_DAYS * 86400000;
  const idx = candles.findIndex(c => c.t >= from);
  if (idx < 0) return null;
  const warm = Math.max(0, idx - 40);   // 指标预热，不产生交易
  const slice = candles.slice(warm).filter(c => c.t >= from);
  if (slice.length < 80) return null;
  const r = engine.runStrategy(slice, engine.RULES[0]);  // R1 自由模式
  if (!Number.isFinite(r.returnPct) || r.days < MIN_DAYS) return null;
  const coinChange = r.startPrice > 0 ? (r.endPrice / r.startPrice - 1) * 100 : 0;
  return {
    returnPct: r.returnPct,
    coinChangePct: +coinChange.toFixed(2),
    finalEquity: r.finalEquity,
    maxDrawdownPct: r.maxDrawdownPct,
    trades: r.trades,
    winRatePct: r.winRatePct,
    dataDays: +r.days.toFixed(0),
    startPrice: r.startPrice,
    endPrice: r.endPrice
  };
}

/** 执行全市场扫描（异步，带进度），结果写入缓存 */
async function compute() {
  if (computing) return cache;
  computing = true;
  const started = Date.now();
  let sourceKey = await detectSource();
  let sourceName = (SOURCE_META[sourceKey] || {}).name || sourceKey;
  const prevTop = cache && Array.isArray(cache.top) ? cache.top : [];
  const prevEligible = cache && cache.eligible ? cache.eligible : 0;
  cache = {
    generatedAt: started,
    sourceKey, sourceName,
    scanned: 0, eligible: 0,
    progress: { done: 0, total: COINS.length },
    status: 'computing',
    top: prevTop
  };

  /** 用指定源扫描全部币种 */
  async function scanWithSource(key) {
    const rows = [];
    let cursor = 0;
    cache.sourceKey = key;
    cache.sourceName = (SOURCE_META[key] || {}).name || key;
    cache.progress = { done: 0, total: COINS.length };
    cache.scanned = 0;
    async function worker() {
      while (cursor < COINS.length) {
        const sym = COINS[cursor++];
        try {
          const candles = await fetchCandlesRetry(key, sym, 3);
          const r = backtestOne(candles);
          if (r) rows.push(Object.assign({ symbol: sym, okxInstId: sym + '-USDT' }, r));
        } catch (_) { /* 单币重试后仍失败才跳过，不影响整体 */ }
        cache.progress.done++;
        cache.scanned = cache.progress.done;
      }
    }
    const workers = [];
    for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
    return rows;
  }

  let rows = await scanWithSource(sourceKey);

  // 首选源颗粒无收（如 ticker 可达但 K线不可用）→ 依次降级换源重扫
  if (!rows.length) {
    for (const alt of ['okx', 'binance', 'gate']) {
      if (alt === sourceKey) continue;
      const altRows = await scanWithSource(alt);
      if (altRows.length) { rows = altRows; sourceKey = alt; sourceName = (SOURCE_META[alt] || {}).name || alt; break; }
    }
  }

  // 上一轮榜单里的强币若本轮因网络抖动缺席，单独重试补算——
  // 头部币种不稳定会让用户觉得榜单"不准"（MMT 曾因此从榜首消失）。
  if (prevTop.length) {
    const present = new Set(rows.map(r => r.symbol));
    for (const p of prevTop) {
      if (present.has(p.symbol)) continue;
      try {
        const c = await fetchCandlesRetry(sourceKey, p.symbol, 4);
        const r = backtestOne(c);
        if (r) { rows.push(Object.assign({ symbol: p.symbol, okxInstId: p.symbol + '-USDT' }, r)); present.add(p.symbol); }
      } catch (_) { /* 补算失败则跳过 */ }
    }
  }

  // 大面积拉取失败保护：本轮合格币骤降到不足上次的一半，说明这一轮行情源异常，
  // 继续发布会漏掉大量币种导致排名失真。此时沿用上一轮完整榜单。
  if (prevEligible >= 30 && rows.length < prevEligible * 0.5 && prevTop.length) {
    cache = Object.assign({}, cache, {
      generatedAt: Date.now(), status: 'ready',
      sourceKey, sourceName, scanned: COINS.length, eligible: rows.length,
      top: prevTop,
      note: '本轮仅 ' + rows.length + ' 币回测成功（上次 ' + prevEligible + '），疑行情源异常，暂沿用上一轮榜单。'
    });
    saveCache();
    computing = false;
    return cache;
  }

  // 按超额收益排序：超额收益 = 区间收益 − 币价涨跌（策略跑赢同期持有币价的幅度越大越靠前）
  const excess = r => Number(r.returnPct || 0) - Number(r.coinChangePct || 0);
  rows.sort((a, b) => excess(b) - excess(a));
  const top = rows.slice(0, TOP_N).map((r, i) => Object.assign({ rank: i + 1 }, r));

  // 本轮所有数据源都无结果：沿用上一轮榜单，绝不写入空榜单覆盖历史数据
  if (!top.length && prevTop.length) {
    cache = Object.assign({}, cache, {
      generatedAt: Date.now(), status: 'ready',
      sourceKey, sourceName, top: prevTop,
      note: '本次所有数据源均未取得有效K线，暂沿用上一轮榜单（' + sourceName + '）。'
    });
    computing = false;
    return cache;
  }

  cache = {
    generatedAt: Date.now(),
    durationMs: Date.now() - started,
    sourceKey, sourceName,
    scanned: COINS.length,
    eligible: rows.length,
    progress: { done: COINS.length, total: COINS.length },
    status: 'ready',
    top,
    note: '扫描欧易现货 USDT 币种池，按自由模式近 1 年超额收益（区间收益 − 币价涨跌）排序；收益为虚拟回测结果，不构成投资建议。'
  };
  saveCache();
  computing = false;
  return cache;
}

/** 对外接口：立即返回缓存；无缓存时后台开算并返回 computing 状态 */
function get(force) {
  const now = Date.now();
  const stale = !cache || (now - cache.generatedAt) > CACHE_TTL;
  if (force && now - lastForce > 60 * 1000) {
    lastForce = now;
    if (!computing) compute().catch(() => {});
  } else if (stale && !computing) {
    compute().catch(() => {});
  }
  if (!cache) {
    return { status: 'computing', generatedAt: now, progress: { done: 0, total: COINS.length }, top: [] };
  }
  return cache;
}

function init() {
  loadCache();
  setTimeout(() => { if (!computing) compute().catch(() => {}); }, 4000);
}

module.exports = { init, get, compute, isComputing: () => computing, COIN_COUNT: COINS.length, detectSource, fetchCandles, SOURCE_META };
