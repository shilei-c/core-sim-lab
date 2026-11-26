'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const engine = require('./lib/engine');
const data = require('./lib/data');
const ranking = require('./lib/ranking');
const multicoin = require('./lib/multicoin');
const liveTicker = require('./lib/live-ticker');
const signal = require('./lib/signal');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png'
};

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(obj));
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

let cachedReport = { at: 0, data: null };
function getReport() {
  const now = Date.now();
  if (cachedReport.data && (now - cachedReport.at) < 5 * 60 * 1000) return cachedReport.data;
  cachedReport = { at: now, data: engine.backtestAll(data.getCandles()) };
  return cachedReport.data;
}

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const pathname = urlObj.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }

    // 每次 API 请求都尝试补采（云沙箱休眠唤醒后保证采集次数）
    data.requestCatchup();

    if (pathname === '/api/status') {
      return json(res, 200, Object.assign({ serverTime: Date.now() }, data.status()));
    }

    if (pathname === '/api/candles') {
      const candles = data.getCandles();
      const source = data.status();
      return json(res, 200, {
        source: source.sourceName,
        mode: source.mode,
        count: candles.length,
        lastUpdate: source.lastUpdate,
        candles: candles.slice(-400)
      });
    }

    if (pathname === '/api/backtest') {
      cachedReport = { at: 0, data: null };
      return json(res, 200, Object.assign({ generatedAt: Date.now(), source: data.status() }, getReport()));
    }

    if (pathname === '/api/refresh' && req.method === 'POST') {
      cachedReport = { at: 0, data: null };
      const s = await data.fullRefresh(true);
      return json(res, 200, { ok: true, source: s.sourceName, count: s.candles.length, status: data.status() });
    }

    // 采集接口：兼容 GET/POST 与尾部斜杠，方便外部 cron（如 cron-job.org 默认 GET）直接调用
    if (pathname.replace(/\/+$/, '') === '/api/collect' && (req.method === 'POST' || req.method === 'GET')) {
      const ok = await data.incrementalCollect();
      cachedReport = { at: 0, data: null };
      return json(res, 200, { ok, status: data.status() });
    }

    // 全市场扫描：自由模式近 1 年收益 TOP10（首次访问后台异步扫描，返回进度）
    if (pathname === '/api/ranking') {
      const force = urlObj.searchParams.get('refresh') === '1';
      return json(res, 200, ranking.get(force));
    }

    // 附加币种（MMT / MERL / BABY / STX）多窗口回测：与 CORE 结构一致，供收益总览与成交明细使用
    if (pathname === '/api/multicoin') {
      const force = urlObj.searchParams.get('refresh') === '1';
      return json(res, 200, multicoin.get(force));
    }

    // 顶部行情条：MMT / MERL / BABY / STX 实时价格与 24h 涨跌（多源降级，独立缓存）
    if (pathname === '/api/live-ticker') {
      const force = urlObj.searchParams.get('refresh') === '1';
      return json(res, 200, liveTicker.get(force));
    }

    // 实时交易信号（六币）：当前动作、持仓与风控线、K线收盘倒计时
    if (pathname === '/api/signal') {
      const force = urlObj.searchParams.get('refresh') === '1';
      return json(res, 200, signal.get(force));
    }

    if (pathname === '/api/engine' || pathname === '/engine.js') {
      return serveFile(res, path.join(__dirname, 'lib', 'engine.js'));
    }

    // 静态资源
    let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    rel = rel.replace(/(\.\.\/|\.\.\\)/g, '');
    const filePath = path.join(PUBLIC, rel);
    if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); res.end('Forbidden'); return; }
    return serveFile(res, filePath);
  } catch (e) {
    return json(res, 500, { error: String(e && e.message ? e.message : e) });
  }
});

data.init();
ranking.init();
multicoin.init();
liveTicker.init();
signal.init();
server.listen(PORT, '0.0.0.0', () => {
  console.log('CORE Simulator running on port ' + PORT);
});
