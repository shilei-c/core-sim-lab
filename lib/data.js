/**
 * 行情数据层：欧易 OKX 主数据源 + 多交易所备份 + 自动采集调度
 * - 后端代理请求，彻底规避浏览器跨域（CORS）问题
 * - 每次采集记录时间戳，支持"每日至少 5 次"的采集审计
 * - 网络不可达时降级为明确标注的演示数据，保证站点永远可用
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'market-cache.json');
const SYMBOL_OKX = 'CORE-USDT';
const SYMBOL_BINANCE = 'COREUSDT';
const SYMBOL_GATE = 'CORE_USDT';
const MAX_BARS = 2300;           // ≈ 383 天 4H K 线
const FETCH_TIMEOUT = 7000;
// 节点健康度：失败后冷却 10 分钟，避免每次采集都等待超时
const hostHealth = Object.create(null);
function hostDown(key, host) { return (hostHealth[key + '|' + host] || 0) > Date.now(); }
function markHost(key, host, ok) {
  hostHealth[key + '|' + host] = ok ? 0 : Date.now() + 10 * 60 * 1000;
}
function availableHosts(key) {
  const list = adapters[key].hosts;
  const healthy = list.filter(h => !hostDown(key, h));
  return healthy.length ? healthy : list; // 全部冷却时仍尝试一次，便于自动恢复
}

function nowTs() { return Date.now(); }
function dayKey(ts) {
  const d = new Date(ts);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

async function httpJson(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: Object.assign({ 'User-Agent': 'Mozilla/5.0 CoreSim/1.0' }, headers || {}),
      cache: 'no-store'
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

/* ---------------- 各交易所适配器 ---------------- */
const adapters = {
  okx: {
    name: 'OKX 欧易',
    hosts: ['https://www.okx.com', 'https://aws.okx.com'],
    async ticker(host) {
      const j = await httpJson(host + '/api/v5/market/ticker?instId=' + SYMBOL_OKX);
      if (j.code !== '0' || !j.data || !j.data[0]) throw new Error('OKX ticker 无数据');
      const d = j.data[0];
      const last = +d.last, open = +d.open24h;
      const change = (last && open) ? (last / open - 1) * 100 : 0;
      return { price: last, change24h: change, vol24h: +d.volCcy24h };
    },
    async candles(host, afterTs) {
      let url = host + '/api/v5/market/history-candles?instId=' + SYMBOL_OKX + '&bar=4H&limit=100';
      if (afterTs) url += '&after=' + afterTs;
      const j = await httpJson(url);
      if (j.code !== '0' || !Array.isArray(j.data)) throw new Error('OKX K线无数据');
      return j.data.map(r => ({
        t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5]
      })).filter(c => c.t > 0 && c.c > 0);
    }
  },
  binance: {
    name: 'Binance 币安（备份）',
    hosts: ['https://api.binance.com', 'https://data-api.binance.vision'],
    async ticker(host) {
      const j = await httpJson(host + '/api/v3/ticker/24hr?symbol=' + SYMBOL_BINANCE);
      if (!j || !j.lastPrice) throw new Error('Binance ticker 无数据');
      return { price: +j.lastPrice, change24h: +j.priceChangePercent, vol24h: +j.quoteVolume };
    },
    async candles(host, afterTs) {
      let url = host + '/api/v3/klines?symbol=' + SYMBOL_BINANCE + '&interval=4h&limit=1000';
      // Binance 用 endTime 向前翻页
      if (afterTs) url += '&endTime=' + (afterTs - 1);
      const j = await httpJson(url);
      if (!Array.isArray(j)) throw new Error('Binance K线无数据');
      return j.map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }))
        .filter(c => c.t > 0 && c.c > 0);
    }
  },
  gate: {
    name: 'Gate.io（备份）',
    hosts: ['https://api.gateio.ws'],
    async ticker(host) {
      const j = await httpJson(host + '/api/v4/spot/tickers?currency_pair=' + SYMBOL_GATE);
      if (!Array.isArray(j) || !j[0]) throw new Error('Gate ticker 无数据');
      return { price: +j[0].last, change24h: +j[0].change_percentage, vol24h: +j[0].quote_volume };
    },
    async candles(host, afterTs) {
      let url = host + '/api/v4/spot/candlesticks?currency_pair=' + SYMBOL_GATE + '&interval=4h&limit=1000';
      if (afterTs) url += '&to=' + Math.floor(afterTs / 1000);
      const j = await httpJson(url);
      if (!Array.isArray(j)) throw new Error('Gate K线无数据');
      // Gate 4H K 线字段顺序: [ts(秒), quoteVol, close, high, low, open, baseVol, closed]
      return j.map(r => ({ t: +r[0] * 1000, o: +r[5], h: +r[3], l: +r[4], c: +r[2], v: +r[6] }))
        .filter(c => c.t > 0 && c.c > 0);
    }
  }
};

const SOURCE_ORDER = ['okx', 'binance', 'gate'];

/* ---------------- 缓存状态 ---------------- */
let state = {
  candles: [],
  source: null,
  sourceName: '未连接',
  mode: 'loading',               // live | demo | loading
  ticker: { price: 0, change24h: 0, vol24h: 0 },
  lastUpdate: 0,
  pulls: [],                     // {ts, source, type, count}
  lastError: null,
  initializing: false,
  refreshing: false
};

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return false;
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (j && Array.isArray(j.candles) && j.candles.length) {
      state.candles = j.candles;
      state.source = j.source || null;
      state.sourceName = j.sourceName || '缓存';
      state.mode = j.mode || 'live';
      state.ticker = j.ticker || state.ticker;
      state.lastUpdate = j.lastUpdate || 0;
      state.pulls = Array.isArray(j.pulls) ? j.pulls : [];
      return true;
    }
  } catch (e) { state.lastError = String(e.message || e); }
  return false;
}

function saveCache() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const slim = {
      candles: state.candles.slice(-MAX_BARS),
      source: state.source,
      sourceName: state.sourceName,
      mode: state.mode,
      ticker: state.ticker,
      lastUpdate: state.lastUpdate,
      pulls: state.pulls.slice(-5000)
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(slim));
  } catch (e) { state.lastError = '写入缓存失败: ' + (e.message || e); }
}

function dedupeSort(arr) {
  const map = new Map();
  for (const c of arr) {
    if (!c || !Number.isFinite(c.t) || !Number.isFinite(c.c)) continue;
    map.set(c.t, c);
  }
  return Array.from(map.values()).sort((a, b) => a.t - b.t).slice(-MAX_BARS);
}

/* ---------------- 演示数据（仅在所有真实源不可用时启用，前端会明确标注） ---------------- */
function demoCandles() {
  const bars = 400 * 6;
  const out = [];
  let seed = 20231123;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  let price = 0.052;
  const end = Math.floor(nowTs() / 14400000) * 14400000;
  const start = end - bars * 14400000;
  for (let i = 0; i < bars; i++) {
    const drift = -0.00055 + Math.sin(i / 95) * 0.0035;
    const shock = (rnd() - 0.5) * 0.075;
    const ret = drift + shock;
    const open = price;
    price = Math.max(0.0025, open * (1 + ret));
    const hi = Math.max(open, price) * (1 + rnd() * 0.02);
    const lo = Math.min(open, price) * (1 - rnd() * 0.02);
    out.push({ t: start + i * 14400000, o: +open.toFixed(6), h: +hi.toFixed(6), l: +lo.toFixed(6), c: +price.toFixed(6), v: 1e6 + rnd() * 5e6 });
  }
  return out;
}

/* ---------------- 采集流程 ---------------- */
// 串行化采集，避免全量/增量并发写缓存导致采集记录互相覆盖
let collectQueue = Promise.resolve();
function serialize(task) {
  const run = collectQueue.then(task, task);
  collectQueue = run.catch(() => {});
  return run;
}
function todayPullCount() {
  const today = dayKey(nowTs());
  return state.pulls.filter(p => dayKey(p.ts) === today).length;
}

async function trySourceHistory(key) {
  const ad = adapters[key];
  let lastErr = null;
  for (const host of availableHosts(key)) {
    try {
      let all = [];
      let after = null;
      for (let page = 0; page < 30; page++) {
        const batch = await ad.candles(host, after);
        if (!batch.length) break;
        all = all.concat(batch);
        const oldest = Math.min.apply(null, batch.map(c => c.t));
        if (after && oldest >= after) break;
        after = oldest;
        if (all.length >= MAX_BARS) break;
      }
      const candles = dedupeSort(all);
      if (candles.length < 40) throw new Error('K线数量不足 ' + candles.length);
      let ticker = { price: candles[candles.length - 1].c, change24h: 0, vol24h: 0 };
      try { ticker = await ad.ticker(host); } catch (_) { /* K线已足够 */ }
      markHost(key, host, true);
      return { key, name: ad.name, candles, ticker };
    } catch (e) { lastErr = e; markHost(key, host, false); }
  }
  throw lastErr || new Error('无可用节点');
}

async function fullRefresh(force) {
  if (state.refreshing && !force) return state;
  state.refreshing = true;
  const errors = [];
  for (const key of SOURCE_ORDER) {
    try {
      const r = await trySourceHistory(key);
      state.candles = r.candles;
      state.source = key;
      state.sourceName = r.name;
      state.mode = 'live';
      state.ticker = r.ticker;
      state.lastUpdate = nowTs();
      state.lastError = null;
      state.pulls.push({ ts: state.lastUpdate, source: key, type: 'full', count: r.candles.length });
      saveCache();
      state.refreshing = false;
      return state;
    } catch (e) { errors.push(key + ': ' + (e.message || e)); }
  }
  // 全部失败：保留已有缓存；否则启用演示数据
  if (!state.candles.length) {
    state.candles = demoCandles();
    state.source = 'demo';
    state.sourceName = '演示数据（真实源暂不可达）';
    state.mode = 'demo';
    state.ticker = { price: state.candles[state.candles.length - 1].c, change24h: -0.42, vol24h: 0 };
    state.lastUpdate = nowTs();
    state.pulls.push({ ts: state.lastUpdate, source: 'demo', type: 'fallback', count: state.candles.length });
    saveCache();
  }
  state.lastError = errors.join(' | ');
  state.refreshing = false;
  return state;
}

/** 定时增量采集：拉取最新 ticker + 最近 K 线并合并，同时记一次采集审计 */
async function incrementalCollect() {
  const errors = [];
  for (const key of SOURCE_ORDER) {
    const ad = adapters[key];
    for (const host of availableHosts(key)) {
      try {
        let ticker = null, recent = null;
        try { ticker = await ad.ticker(host); } catch (_) {}
        recent = await ad.candles(host, null);
        if (!recent || !recent.length) throw new Error('无最新K线');
        state.candles = dedupeSort(state.candles.concat(recent));
        if (ticker) state.ticker = ticker;
        state.source = key;
        state.sourceName = ad.name;
        state.mode = 'live';
        state.lastUpdate = nowTs();
        state.lastError = null;
        state.pulls.push({ ts: state.lastUpdate, source: key, type: 'incremental', count: recent.length });
        if (state.pulls.length > 5000) state.pulls = state.pulls.slice(-5000);
        saveCache();
        markHost(key, host, true);
        return true;
      } catch (e) { errors.push(key + '/' + host + ': ' + (e.message || e)); markHost(key, host, false); }
    }
  }
  state.lastError = errors.join(' | ');
  return false;
}

function status() {
  const today = dayKey(nowTs());
  const todayPulls = state.pulls.filter(p => dayKey(p.ts) === today);
  return {
    symbol: 'CORE/USDT',
    source: state.source,
    sourceName: state.sourceName,
    mode: state.mode,
    price: state.ticker.price,
    change24h: +(state.ticker.change24h || 0).toFixed(2),
    vol24h: state.ticker.vol24h,
    lastUpdate: state.lastUpdate,
    candleCount: state.candles.length,
    pullsToday: todayPulls.length,
    requiredPullsPerDay: 5,
    schedule: '每 1 分钟自动采集（每日最高 1440 次）',
    recentPulls: state.pulls.slice(-12).reverse(),
    lastError: state.lastError
  };
}

/* ---------------- 初始化与调度 ---------------- */
let scheduler = null;
let lastRequestCatchup = 0;

async function init() {
  loadCache();
  // 首次全量同步，确保拿到可回测 12 个月的数据
  safeFullRefresh(true).catch(() => {});
  // 每 1 分钟自动采集 => 每日最高 1440 次（网站内置定时任务，服务存活时生效）
  if (!scheduler) {
    scheduler = setInterval(() => { safeIncremental().catch(() => {}); }, 60 * 1000);
    scheduler.unref && scheduler.unref();
  }
  // 启动后连续补采，确保当天 5 次配额在首小时内即可达标（云沙箱可能随时休眠）
  let k = 0;
  const quotaTimer = setInterval(() => {
    k++;
    if (todayPullCount() < 5 && k <= 10) safeIncremental().catch(() => {});
    else clearInterval(quotaTimer);
  }, 25 * 1000);
  quotaTimer.unref && quotaTimer.unref();
}

/** 请求驱动的补采：云沙箱休眠唤醒后，若当日次数不足 5 次则立即补采 */
function requestCatchup() {
  const now = nowTs();
  if (now - lastRequestCatchup < 20 * 60 * 1000) return; // 20 分钟节流
  const stale = now - state.lastUpdate > 4 * 3600 * 1000;
  if (stale || todayPullCount() < 5) {
    lastRequestCatchup = now;
    safeIncremental().catch(() => {});
  }
}

async function safeFullRefresh(force) { return serialize(() => fullRefresh(force)); }
async function safeIncremental() { return serialize(() => incrementalCollect()); }

module.exports = {
  init, status,
  fullRefresh: safeFullRefresh,
  incrementalCollect: safeIncremental,
  requestCatchup,
  getCandles: () => state.candles.slice(),
  getState: () => state,
  SAMPLE_INTERVAL_HOURS: 4
};
