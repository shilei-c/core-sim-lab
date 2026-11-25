'use strict';
/**
 * 静态站构建脚本
 * ------------------------------------------------
 * 在 Node 环境跑一遍全部数据计算（行情采集 + 回测 + 榜单 + 多币 + 实时价），
 * 把结果写成纯静态 JSON，连同页面资源一起输出到 docs/ 目录。
 * docs/ 交给 GitHub Pages 托管 —— 静态文件永不休眠，访客随时可打开。
 *
 * 容错：任一数据源或计算失败时，自动使用项目 data/ 下已有缓存兜底，
 * 保证每次构建都能产出完整可展示的站点。
 */
const fs = require('fs');
const path = require('path');
const engine = require('./lib/engine');
const data = require('./lib/data');
const ranking = require('./lib/ranking');
const multicoin = require('./lib/multicoin');
const liveTicker = require('./lib/live-ticker');

const ROOT = __dirname;
const DOCS = path.join(ROOT, 'docs');
const OUT_DATA = path.join(DOCS, 'data');
const CACHE = path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function writeJson(name, obj) {
  ensureDir(OUT_DATA);
  const text = JSON.stringify(obj);
  fs.writeFileSync(path.join(OUT_DATA, name), text);
  console.log('[build] wrote data/' + name + ' (' + text.length + ' bytes)');
}
function cacheFallback(cacheName, outName) {
  const src = path.join(CACHE, cacheName);
  const dst = path.join(OUT_DATA, outName);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    console.log('[build] fallback ' + outName + ' <- ' + cacheName);
  } else {
    console.warn('[build] missing cache ' + cacheName);
  }
}
function copyFile(src, dst) { fs.copyFileSync(src, dst); }

async function buildBacktest() {
  try {
    data.init();                       // 载入已有缓存（含定时器，已 unref 不阻塞退出）
    await data.fullRefresh(true);      // 强制全量刷新，串行等待完成
    const candles = data.getCandles();
    const livePrice = data.status().price;   // 最新实时价：覆盖最后一根未走完K线
    const report = engine.backtestAll(candles, livePrice);
    writeJson('backtest.json', Object.assign({ generatedAt: Date.now(), source: data.status() }, report));
    writeJson('status.json', Object.assign({ serverTime: Date.now() }, data.status()));
  } catch (e) {
    console.error('[build] backtest refresh failed:', e.message);
    try {
      const j = JSON.parse(fs.readFileSync(path.join(CACHE, 'market-cache.json'), 'utf8'));
      const fallbackPrice = (j.ticker && j.ticker.price) || (j.candles && j.candles.length ? j.candles[j.candles.length - 1].c : 0);
      const report = engine.backtestAll(j.candles, fallbackPrice);
      writeJson('backtest.json', Object.assign({ generatedAt: Date.now(), source: data.status() }, report));
      writeJson('status.json', Object.assign({ serverTime: Date.now() }, data.status()));
    } catch (e2) { console.error('[build] backtest fallback failed:', e2.message); }
  }
}

async function buildRanking() {
  try {
    const r = await ranking.compute();
    if (r && Array.isArray(r.top) && r.top.length) writeJson('ranking.json', r);
    else cacheFallback('ranking-cache.json', 'ranking.json');
  } catch (e) {
    console.error('[build] ranking failed:', e.message);
    cacheFallback('ranking-cache.json', 'ranking.json');
  }
}

async function buildMulticoin() {
  try {
    const m = await multicoin.compute();
    if (m && m.coins && Object.keys(m.coins).some(s => m.coins[s] && m.coins[s].results && Object.keys(m.coins[s].results).length))
      writeJson('multicoin.json', m);
    else cacheFallback('multicoin-cache.json', 'multicoin.json');
  } catch (e) {
    console.error('[build] multicoin failed:', e.message);
    cacheFallback('multicoin-cache.json', 'multicoin.json');
  }
}

async function buildLiveTicker() {
  try {
    const t = await liveTicker.compute(true);
    if (t && t.coins && Object.keys(t.coins).length) writeJson('live-ticker.json', t);
    else cacheFallback('live-ticker-cache.json', 'live-ticker.json');
  } catch (e) {
    console.error('[build] live-ticker failed:', e.message);
    cacheFallback('live-ticker-cache.json', 'live-ticker.json');
  }
}

function copyAssets() {
  ensureDir(DOCS);
  copyFile(path.join(PUBLIC, 'styles.css'), path.join(DOCS, 'styles.css'));
  copyFile(path.join(PUBLIC, 'app.js'), path.join(DOCS, 'app.js'));
  copyFile(path.join(ROOT, 'lib', 'engine.js'), path.join(DOCS, 'engine.js'));
  let html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  html = html.replace('href="/styles.css"', 'href="styles.css"')
             .replace('src="/engine.js"', 'src="engine.js"')
             .replace('src="/app.js"', 'src="app.js"');
  html = html.replace('<script src="engine.js"></script>',
    '<script>window.STATIC_SITE=true;</script>\n<script src="engine.js"></script>');
  fs.writeFileSync(path.join(DOCS, 'index.html'), html);
  fs.writeFileSync(path.join(DOCS, '.nojekyll'), '');   // GitHub Pages 禁用 Jekyll 处理
  console.log('[build] copied static assets -> docs/');
}

(async () => {
  console.log('[build] start ' + new Date().toISOString());
  copyAssets();
  await buildBacktest();
  await buildRanking();
  await buildLiveTicker();   // 先刷新实时价，供多币回测覆盖最后一根K线使用
  await buildMulticoin();
  console.log('[build] done -> ' + DOCS);
  process.exit(0);
})().catch(e => { console.error('[build] FATAL', e); process.exit(1); });
