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
const signal = require('./lib/signal');

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

async function buildSignal() {
  try {
    const s = await signal.compute(true);
    if (s && s.coins && Object.keys(s.coins).length) writeJson('signal.json', s);
    else cacheFallback('signal-cache.json', 'signal.json');
  } catch (e) {
    console.error('[build] signal failed:', e.message);
    cacheFallback('signal-cache.json', 'signal.json');
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

/**
 * 构建后自检 + 自动补救：确保每小时重建都产出完整数据。
 * 关键数据为空时强制重算一次；补救后仍异常则返回问题列表，
 * 由主流程以非零码退出，阻止 workflow 提交空数据覆盖线上历史数据。
 */
async function verifyAndHeal() {
  const problems = [];

  // 1) 近 1 年 TOP10 榜单
  try {
    const r = JSON.parse(fs.readFileSync(path.join(OUT_DATA, 'ranking.json'), 'utf8'));
    if (!r.top || !r.top.length) {
      console.warn('[verify] ranking.json 为空，自动重算一次...');
      const r2 = await ranking.compute();
      if (r2 && r2.top && r2.top.length) {
        writeJson('ranking.json', r2);
        console.log('[verify] ranking 已恢复 ' + r2.top.length + ' 条');
      } else {
        cacheFallback('ranking-cache.json', 'ranking.json');
        problems.push('ranking.top 为空且重算无果');
      }
    } else {
      console.log('[verify] ranking ok (' + r.top.length + ' 条, ' + (r.sourceName || '-') + ')');
    }
  } catch (e) { problems.push('ranking 校验失败: ' + e.message); }

  // 2) 五币实时信号
  try {
    const s = JSON.parse(fs.readFileSync(path.join(OUT_DATA, 'signal.json'), 'utf8'));
    const keys = Object.keys(s.coins || {});
    const bad = keys.filter(k => !s.coins[k] || s.coins[k].error);
    if (!keys.length || bad.length === keys.length) {
      console.warn('[verify] signal.json 五币全部异常，自动重算一次...');
      const s2 = await signal.compute(true);
      const good = Object.keys((s2 && s2.coins) || {}).filter(k => s2.coins[k] && !s2.coins[k].error);
      if (good.length) {
        writeJson('signal.json', s2);
        console.log('[verify] signal 已恢复 ' + good.length + ' 币');
      } else problems.push('signal 五币全部异常且重算无果');
    } else {
      console.log('[verify] signal ok (' + keys.length + ' 币, 异常 ' + bad.length + ')');
    }
  } catch (e) { problems.push('signal 校验失败: ' + e.message); }

  // 3) 其余关键文件存在且非空
  for (const name of ['backtest.json', 'multicoin.json', 'live-ticker.json']) {
    try {
      if (fs.statSync(path.join(OUT_DATA, name)).size < 20) problems.push(name + ' 内容异常');
    } catch (_) { problems.push(name + ' 缺失'); }
  }

  return problems;
}

(async () => {
  console.log('[build] start ' + new Date().toISOString());
  copyAssets();
  await buildBacktest();
  await buildRanking();
  await buildLiveTicker();   // 先刷新实时价，供多币回测覆盖最后一根K线使用
  await buildMulticoin();
  await buildSignal();       // 实时交易信号（五币），依赖实时价与K线
  const problems = await verifyAndHeal();   // 自检 + 补救，确保这次重建数据完整
  console.log('[build] done -> ' + DOCS + (problems.length
    ? ' | 自检异常: ' + problems.join('; ')
    : ' | 自检通过'));
  // 关键数据不可用时以非零码退出，阻止 workflow 提交空数据覆盖线上历史数据
  process.exit(problems.length ? 1 : 0);
})().catch(e => { console.error('[build] FATAL', e); process.exit(1); });
