/**
 * 实时行情模块：为顶部行情条提供 MMT / MERL / BABY / STX 的最新价与 24h 涨跌
 * - 与 CORE 主链路（lib/data.js）完全隔离，互不影响
 * - 多交易所降级：OKX → Binance → Gate.io，节点失败后冷却，避免反复超时
 * - 后台每 60 秒刷新一次；首次访问时若未就绪，前端自动轮询
 * - 网络不可达时保留上次缓存并明确标注数据源 / 缓存时间
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'live-ticker-cache.json');
const COINS = ['MMT', 'MERL', 'BABY', 'STX'];
const FETCH_TIMEOUT = 7000;
const COOLDOWN = 10 * 60 * 1000;

/* ---------------- 各交易所 ticker 适配器 ---------------- */
const ADAPTERS = {
  okx: {
    name: 'OKX 欧易',
    hosts: ['https://www.okx.com', 'https://aws.okx.com'],
    url: h => h + '/api/v5/market/ticker?instId={SYM}-USDT',
    parse(j) {
      if (j.code !== '0' || !j.data || !j.data[0]) throw new Error('OKX ticker 无数据');
      const d = j.data[0];
      const last = +d.last, open = +d.open24h;
      return { price: last, change24h: (last && open) ? (last / open - 1) * 100 : 0 };
    }
  },
  binance: {
    name: 'Binance 币安',
    hosts: ['https://api.binance.com', 'https://data-api.binance.vision'],
    url: h => h + '/api/v3/ticker/24hr?symbol={SYM}USDT',
    parse(j) {
      if (!j || !j.lastPrice) throw new Error('Binance ticker 无数据');
      return { price: +j.lastPrice, change24h: +j.priceChangePercent };
    }
  },
  gate: {
    name: 'Gate.io',
    hosts: ['https://api.gateio.ws'],
    url: h => h + '/api/v4/spot/tickers?currency_pair={SYM}_USDT',
    parse(j) {
      if (!Array.isArray(j) || !j[0] || !j[0].last) throw new Error('Gate ticker 无数据');
      return { price: +j[0].last, change24h: +j[0].change_percentage };
    }
  }
};
const SOURCE_ORDER = ['okx', 'binance', 'gate'];

/* ---------------- 节点健康度（本模块独立，不影响 CORE） ---------------- */
const hostHealth = Object.create(null);
function hostDown(key, host) { return (hostHealth[key + '|' + host] || 0) > Date.now(); }
function markHost(key, host, ok) { hostHealth[key + '|' + host] = ok ? 0 : Date.now() + COOLDOWN; }
function availableHosts(key) {
  const list = ADAPTERS[key].hosts;
  // 全部冷却时跳过该源（冷却到期后 hostDown 自动失效，会重新尝试），避免每次刷新都卡在超时上
  return list.filter(h => !hostDown(key, h));
}

async function httpJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 CoreSim/1.0' },
      cache: 'no-store'
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

/** 单交易所拉取某币 ticker */
async function tickerFrom(key, sym) {
  const ad = ADAPTERS[key];
  let lastErr = null;
  for (const host of availableHosts(key)) {
    try {
      const url = ad.url(host).replace('{SYM}', sym);
      const p = ad.parse(await httpJson(url));
      if (!(p.price > 0)) throw new Error('无效价格');
      markHost(key, host, true);
      return { price: p.price, change24h: +(p.change24h || 0).toFixed(2), source: key, sourceName: ad.name };
    } catch (e) {
      markHost(key, host, false);
      lastErr = key + ': ' + (e && e.message ? e.message : e);
    }
  }
  throw new Error(lastErr || '无可用节点');
}

/* ---------------- 缓存状态 ---------------- */
let cache = {
  status: 'computing',
  generatedAt: 0,
  sourceName: '—',
  coins: {}
};
let computing = false;

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (j && j.coins) cache = Object.assign({}, cache, j, { status: 'ready' });
  } catch (_) { /* 缓存损坏则忽略 */ }
}
function saveCache() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch (_) { /* 忽略写盘失败 */ }
}

/** 拉取两币实时行情，写入缓存 */
async function compute(force) {
  if (computing && !force) return cache;
  computing = true;
  const now = Date.now();
  const coins = {};
  const errors = [];
  for (const sym of COINS) {
    let got = null;
    for (const key of SOURCE_ORDER) {
      try {
        const p = await tickerFrom(key, sym);
        got = Object.assign({}, p, { symbol: sym + '/USDT', ts: now });
        break;
      } catch (e) { errors.push(sym + '/' + (e && e.message ? e.message : e)); }
    }
    if (got) coins[sym] = got;
    else {
      // 全部失败：保留上次成功值并标注 stale
      const prev = cache.coins && cache.coins[sym];
      coins[sym] = prev && prev.price > 0
        ? Object.assign({}, prev, { stale: true })
        : { price: 0, change24h: 0, symbol: sym + '/USDT', error: '行情源暂不可达', ts: now };
    }
  }
  cache = {
    status: 'ready',
    generatedAt: now,
    sourceName: (coins.MMT && coins.MMT.sourceName) || '—',
    coins,
    lastError: errors.length ? errors.join(' | ') : null
  };
  saveCache();
  computing = false;
  return cache;
}

function get(force) {
  if (force) compute(true).catch(() => {});   // 强制刷新异步执行，立即返回当前缓存
  return cache;
}

let timer = null;
function init() {
  loadCache();
  compute().catch(() => {});                   // 启动后立即后台拉一次
  if (!timer) {
    timer = setInterval(() => { compute().catch(() => {}); }, 60 * 1000);
    timer.unref && timer.unref();
  }
}

module.exports = { init, get, compute, COINS };
