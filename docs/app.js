'use strict';
(function () {
  const $ = id => document.getElementById(id);
  let report = null;
  let multiReport = null;            // MMT / MERL / BABY / STX / BTC 回测数据
  let marketData = null;
  let marketPollCount = 0;
  let multiPollCount = 0;
  let currentWindow = '3m';
  let currentCoin = 'CORE';          // 成交明细当前展示币种
  let signalReport = null;           // 实时信号数据
  let signalCoin = 'CORE';           // 实时信号当前展示币种
  let directCandles = {};            // 浏览器直连拉取的K线缓存 {coin: candles}
  const COLORS = { R1: '#0a84ff' };
  const NAMES = { R1: '自由模式' };
  const COIN_COLORS = { CORE: '#0a84ff', MMT: '#bf5af2', MERL: '#ff9f0a', BABY: '#30d158', STX: '#ff453a', BTC: '#f7931a' };
  const COINS = ['CORE', 'MMT', 'MERL', 'BABY', 'STX', 'BTC'];

  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(t._timer); t._timer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function fmtMoney(v) {
    return Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPrice(v) {
    if (!v) return '—';
    return v < 1 ? '$' + Number(v).toFixed(6) : '$' + Number(v).toFixed(4);
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function signCls(v) { return v > 0 ? 'up' : (v < 0 ? 'down' : ''); }

  // 部署网关要求每个请求携带 sharecode（本地访问时为空，不影响）
  const shareCode = new URLSearchParams(location.search).get('sharecode') || '';
  const STATIC_SITE = window.STATIC_SITE === true;   // GitHub Pages 静态站：读预生成 JSON
  function withCode(path) {
    if (!shareCode) return path;
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'sharecode=' + encodeURIComponent(shareCode);
  }
  // 静态站把 API 路径映射到 data/ 下的预生成文件；动态站仍走 /api/*
  const STATIC_PATHS = {
    '/api/backtest': 'data/backtest.json',
    '/api/status': 'data/status.json',
    '/api/ranking': 'data/ranking.json',
    '/api/multicoin': 'data/multicoin.json',
    '/api/live-ticker': 'data/live-ticker.json',
    '/api/signal': 'data/signal.json'
  };
  async function api(path, opts) {
    let url = path;
    if (STATIC_SITE) {
      const base = path.split('?')[0];
      url = STATIC_PATHS[base] || path;
      url = url + '?t=' + Date.now();   // 绕过静态托管缓存
    } else {
      url = withCode(path);
    }
    const res = await fetch(url, Object.assign({ cache: 'no-store' }, opts || {}));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function renderStatus(s) {
    const badge = $('sourceBadge');
    badge.className = 'source-badge ' + (s.mode === 'demo' ? 'demo' : (s.mode === 'live' ? 'live' : ''));
    $('sourceText').textContent = s.sourceName || '未连接';
    if (window._okxDirect) {
      badge.className = 'source-badge live';
      $('sourceText').textContent = 'OKX 欧易直连';
    }
    $('tickerPrice').textContent = fmtPrice(s.price);
    const ch = $('tickerChange');
    ch.textContent = (s.change24h > 0 ? '+' : '') + Number(s.change24h || 0).toFixed(2) + '% (24h)';
    ch.className = 'ticker-change ' + signCls(s.change24h);
    $('pullsToday').innerHTML = (s.pullsToday ?? 0) + '<span class="unit"> 次</span>';
    const reqPulls = $('reqPulls');   // 该展示项已下线，元素可能不存在；保留兼容避免空指针
    if (reqPulls) reqPulls.textContent = s.requiredPullsPerDay || 5;

    const log = $('pullLog');
    const pulls = s.recentPulls || [];
    if (!pulls.length) { log.textContent = '暂无采集记录'; }
    else {
      log.innerHTML = pulls.map(p => {
        const label = p.type === 'full' ? '全量同步' : (p.type === 'fallback' ? '降级数据' : '增量采集');
        return '<div class="pull-item"><div><span class="pull-time">' + fmtTime(p.ts) + '</span>' +
          '<span class="pull-type ' + p.type + '">' + label + '</span></div>' +
          '<div class="pull-meta">' + (p.source || '').toUpperCase() + ' · ' + (p.count || 0) + ' 根K线</div></div>';
      }).join('');
    }
  }

  function renderOverview() {
    if (!report) return;
    let best = null;
    for (const w of report.windows) {
      const rows = report.results[w.key] || [];
      for (const r of rows) {
        if (!best || r.returnPct > best.returnPct) best = Object.assign({}, r, { windowLabel: w.label });
      }
    }
    if (!best) return;
    $('bestReturn').textContent = (best.returnPct > 0 ? '+' : '') + best.returnPct.toFixed(2) + '%';
    $('bestReturn').className = 'stat-value big ' + signCls(best.returnPct);
    $('bestRuleTag').textContent = NAMES[best.rule] || best.rule;
    $('bestPeriod').textContent = best.windowLabel + ' · ' + COINS.length + ' 币中最高';
  }

  /** 取某币在指定窗口的自由模式（R1）回测结果 */
  function coinResult(coin, win) {
    const src = coin === 'CORE' ? report : (multiReport && multiReport.coins && multiReport.coins[coin]);
    if (!src || !src.results || !src.results[win]) return null;
    const rows = src.results[win];
    return (rows.find(r => r.rule === 'R1') || rows[0] || null);
  }

  function renderTable() {
    const w = (report && report.windows || []).find(x => x.key === currentWindow);
    $('tableTitle').textContent = (w ? w.label : '') + ' · ' + COINS.length + ' 币回测结果';
    const items = COINS.map(coin => ({ coin, r: coinResult(coin, currentWindow) })).filter(x => x.r);
    if (!items.length) {
      $('dataNote').textContent = '—';
      $('resultBody').innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--sub)">加载中…</td></tr>';
      return;
    }
    const insufficient = items.some(x => x.r.insufficient);
    const daysList = items.map(x => x.r.dataDays).filter(Boolean);
    $('dataNote').textContent = daysList.length
      ? '实际数据 ' + Math.min.apply(null, daysList) + '–' + Math.max.apply(null, daysList) + ' 天' + (insufficient ? '（历史不足，仅供参考）' : '')
      : '—';
    // 按超额收益降序排列：超额收益 = 区间收益 − 币价涨跌（策略跑赢同期持有币价的幅度越大越靠前）
    const excess = r => Number(r.returnPct || 0) - Number(r.coinChangePct || 0);
    const sorted = items.slice().sort((a, b) => excess(b.r) - excess(a.r));
    $('resultBody').innerHTML = sorted.map(({ coin, r }, idx) => {
      const p = idx + 1;
      const coinChg = Number(r.coinChangePct || 0);
      return '<tr>' +
        '<td><div class="rule-cell"><span class="rule-dot" style="background:' + COIN_COLORS[coin] + '"></span><div><span class="rn">' + coin + '/USDT</span>' +
        '<span class="rd">自由模式</span></div></div></td>' +
        '<td class="' + (r.returnPct > 0 ? 'return-pos' : r.returnPct < 0 ? 'return-neg' : '') + '">' + (r.returnPct > 0 ? '+' : '') + r.returnPct.toFixed(2) + '%</td>' +
        '<td class="coin-chg ' + signCls(coinChg) + '">' + (coinChg > 0 ? '+' : '') + coinChg.toFixed(2) + '%</td>' +
        '<td class="col-dd">' + r.maxDrawdownPct.toFixed(2) + '%</td>' +
        '<td>' + r.trades + '</td>' +
        '<td><span class="rank-pill p' + p + '">' + p + '</span></td>' +
        '</tr>';
    }).join('');
  }

  /**
   * 多币综合积分榜：对 1周/1个月/3个月/6个月/12个月 五个区间，
   * 各自按超额收益（区间收益 − 币价涨跌）排名，第1名 N 分、第2名 N-1 分…最后1名1分（N=币数）；
   * 五区间得分累加为总分，按总分由高到低排名（同分按超额收益合计降序）。
   */
  const SCORE_WINDOWS = [
    { key: '7d', label: '1周' },
    { key: '1m', label: '1个月' },
    { key: '3m', label: '3个月' },
    { key: '6m', label: '6个月' },
    { key: '12m', label: '12个月' }
  ];
  function renderScoreTable() {
    const body = $('scoreBody');
    if (!body) return;
    const excess = r => Number(r.returnPct || 0) - Number(r.coinChangePct || 0);
    // 全部币种在五个区间都有数据才渲染，避免加载中给出误导性积分
    const ready = COINS.every(c => SCORE_WINDOWS.every(w => coinResult(c, w.key)));
    if (!ready) {
      $('scoreMeta').textContent = '多币数据同步中…';
      body.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--sub)">回测数据加载中…</td></tr>';
      return;
    }
    // perCoin: { coin -> { total, excessSum, wins: {winKey:{score, rank}} } }
    const perCoin = {};
    COINS.forEach(c => { perCoin[c] = { total: 0, excessSum: 0, wins: {} }; });
    SCORE_WINDOWS.forEach(w => {
      const ranked = COINS.map(c => ({ coin: c, r: coinResult(c, w.key) }))
        .sort((a, b) => excess(b.r) - excess(a.r));
      ranked.forEach((x, i) => {
        const score = COINS.length - i;   // 第1名 N 分…第 N 名1分（N=币数）
        const rank = i + 1;
        perCoin[x.coin].wins[w.key] = { score, rank };
        perCoin[x.coin].total += score;
        perCoin[x.coin].excessSum += excess(x.r);
      });
    });
    const rankedCoins = COINS.slice().sort((a, b) =>
      perCoin[b].total - perCoin[a].total || perCoin[b].excessSum - perCoin[a].excessSum);
    const maxTotal = COINS.length * SCORE_WINDOWS.length;
    $('scoreMeta').textContent = '五区间累计 · 满分 ' + maxTotal + ' 分';
    body.innerHTML = rankedCoins.map((coin, idx) => {
      const p = idx + 1;
      const pc = perCoin[coin];
      const cells = SCORE_WINDOWS.map(w => {
        const s = pc.wins[w.key];
        return '<td class="score-cell"><span class="score-num n' + s.score + '">' + s.score + '</span>' +
          '<span class="score-rank">第' + s.rank + '</span></td>';
      }).join('');
      return '<tr>' +
        '<td><span class="rank-pill p' + p + '">' + p + '</span></td>' +
        '<td><div class="rule-cell"><span class="rule-dot" style="background:' + COIN_COLORS[coin] + '"></span>' +
        '<span class="rn">' + coin + '/USDT</span></div></td>' +
        cells +
        '<td class="score-total">' + pc.total + '<span class="score-total-unit">分</span></td>' +
        '</tr>';
    }).join('');
  }

  function renderSignals() {
    if (!report) return;
    // 策略说明横幅（保留）
    const st = report.strategy;
    if (st && $('strategyNote')) {
      $('strategyNote').textContent = st.note || '';
    }
    // 按用户要求：不再逐条显示买入时点记录，引导至下方完整成交明细栏目
    const list = $('signalList');
    if (list) {
      list.innerHTML = '<div class="signal-empty">逐笔买入时间与价格请查看下方「自由模式 · 每次成交明细」栏目</div>';
    }
  }

  function renderTrades() {
    // 更新币种切换按钮状态
    document.querySelectorAll('.coin-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.coin === currentCoin);
    });
    const r1 = coinResult(currentCoin, currentWindow);
    const w = (report && report.windows || []).find(x => x.key === currentWindow);
    $('tradesTitle').textContent = (w ? w.label : '') + ' · ' + currentCoin + '/USDT 自由模式成交明细';
    const src = currentCoin === 'CORE' ? report : (multiReport && multiReport.coins && multiReport.coins[currentCoin]);

    // 附加币首次同步中
    if (!r1 && currentCoin !== 'CORE' && multiReport && multiReport.status === 'computing') {
      $('tradesMeta').textContent = '数据同步中…';
      $('tradesBody').innerHTML = '<tr><td colspan="5" class="trades-empty">' + currentCoin + ' 数据首次同步中，请稍候…</td></tr>';
      return;
    }
    const ledger = (r1 && r1.tradeLedger) ? r1.tradeLedger : [];
    const total = (r1 && r1.ledgerTotal != null) ? r1.ledgerTotal : ledger.length;
    const buyTotal = (r1 && r1.buyTotal != null) ? r1.buyTotal : 0;
    const srcName = src && src.sourceName ? ' · ' + src.sourceName : '';
    const liveNote = (r1 && r1.livePriceApplied > 0) ? ' · 最近一笔已按实时价 ' + fmtPrice(r1.livePriceApplied) + ' 重算' : '';
    $('tradesMeta').textContent = '共 ' + total + ' 笔成交 · 其中买入 ' + buyTotal + ' 笔' + srcName + liveNote;

    const body = $('tradesBody');
    if (!ledger.length) {
      body.innerHTML = '<tr><td colspan="5" class="trades-empty">' + (r1 ? '该区间暂无成交记录' : '数据加载中…') + '</td></tr>';
      return;
    }
    body.innerHTML = ledger.map(t => {
      const isBuy = t.side === 'buy';
      const sideLabel = isBuy ? '买入' : '卖出';
      const amt = Number(t.amount || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
      return '<tr>' +
        '<td class="trade-time">' + (t.beijing || fmtTime(t.ts)) + '</td>' +
        '<td><span class="trade-side ' + t.side + '">' + sideLabel + '</span></td>' +
        '<td class="trade-px ' + t.side + '">' + fmtPrice(t.price) + '</td>' +
        '<td class="trade-amt">' + amt + '</td>' +
        '<td class="trade-reason">' + (t.reason || '—') + '</td>' +
        '</tr>';
    }).join('');
  }

  /** 全市场自由模式近 1 年收益 TOP10 榜单 */
  function renderMarket(d) {
    if (!d) return;
    const meta = $('marketMeta');
    const prog = $('marketProgress');
    const body = $('marketBody');
    if (!body) return;

    if (d.status === 'computing') {
      const p = d.progress || { done: 0, total: 100 };
      const pct = p.total ? Math.round(p.done / p.total * 100) : 0;
      prog.hidden = false;
      $('marketProgressBar').style.width = pct + '%';
      $('marketProgressText').textContent = '正在扫描 ' + p.total + ' 个币种 · 已完成 ' + p.done + '（' + pct + '%）';
      meta.textContent = '首次扫描中，约需 1–3 分钟';
      if (!d.top || !d.top.length) {
        body.innerHTML = '<tr><td colspan="7" class="market-empty">正在扫描币种池，请稍候…</td></tr>';
      }
      return;
    }

    prog.hidden = true;
    // 按超额收益降序重排并重新编号排名（区间收益 − 币价涨跌，跑赢币价越多越靠前）
    const excess = x => Number(x.returnPct || 0) - Number(x.coinChangePct || 0);
    const rows = (d.top || []).slice().sort((a, b) => excess(b) - excess(a))
      .map((x, i) => Object.assign({}, x, { rank: i + 1 }));
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="7" class="market-empty">暂无可排名结果（历史数据不足）</td></tr>';
      meta.textContent = '—';
      return;
    }
    const medals = ['🥇', '🥈', '🥉'];
    const pctText = v => (v > 0 ? '+' : '') + Number(v || 0).toFixed(2) + '%';
    const cls = v => (v > 0 ? 'm-pos' : (v < 0 ? 'm-neg' : ''));
    body.innerHTML = rows.map(x =>
      '<tr>' +
      '<td class="m-rank">' + (medals[x.rank - 1] || '') + ' ' + x.rank + '</td>' +
      '<td><span class="m-sym">' + x.symbol + '/USDT</span><span class="m-sub">欧易 ' + x.okxInstId + '</span></td>' +
      '<td class="' + cls(x.returnPct) + '">' + pctText(x.returnPct) + '</td>' +
      '<td class="' + cls(x.coinChangePct) + '">' + pctText(x.coinChangePct) + '</td>' +
      '<td class="col-excess ' + cls(excess(x)) + '">' + pctText(excess(x)) + '</td>' +
      '<td>' + Number(x.maxDrawdownPct).toFixed(2) + '%</td>' +
      '<td>' + x.trades + '</td>' +
      '</tr>').join('');
    const dt = new Date(d.generatedAt);
    const pad = n => String(n).padStart(2, '0');
    meta.textContent = '扫描 ' + d.scanned + ' 币 · 有效 ' + d.eligible + ' 币 · ' +
      (d.sourceName || '真实行情') + ' · ' + pad(dt.getHours()) + ':' + pad(dt.getMinutes()) + ' 更新';
  }

  async function loadMarket() {
    try {
      const d = await api('/api/ranking');
      marketData = d;
      renderMarket(d);
      if (d.status === 'computing' && marketPollCount < 90) {
        marketPollCount++;
        setTimeout(loadMarket, 4000);
      } else {
        marketPollCount = 0;
      }
    } catch (e) {
      const body = $('marketBody');
      if (body) body.innerHTML = '<tr><td colspan="7" class="market-empty">榜单加载失败：' + e.message + '</td></tr>';
      $('marketMeta').textContent = '—';
    }
  }

  /** 加载附加币（MMT / MERL / BABY / STX / BTC）回测数据；首次后台同步时轮询直到就绪 */
  async function loadMulti(force) {
    try {
      const d = await api('/api/multicoin' + (force ? '?refresh=1' : ''));
      multiReport = d;
      renderTable();
      renderScoreTable();   // 积分榜依赖多币数据，多币就绪后重算
      renderTrades();
      drawChart();   // 币价曲线依赖多币数据，加载后需重绘
      if (d.status === 'computing' && multiPollCount < 60) {
        multiPollCount++;
        setTimeout(() => loadMulti(false), 4000);
      } else {
        multiPollCount = 0;
      }
    } catch (e) {
      // 附加币加载失败不影响 CORE 主流程
    }
  }

  function drawChart() {
    const canvas = $('equityChart');
    const empty = $('chartEmpty');
    const legend = $('chartLegend');
    // 收集各币当前窗口的价格曲线（起点归一化为 100）
    const series = [];
    for (const coin of COINS) {
      const r = coinResult(coin, currentWindow);
      const pc = r && r.priceCurve && r.priceCurve.filter(p => p.v > 0);
      if (!pc || pc.length < 2) continue;
      const base = pc[0].v;
      series.push({
        coin,
        color: COIN_COLORS[coin],
        price: r.endPrice,
        pts: pc.map(p => ({ t: p.t, v: p.v / base * 100 }))
      });
    }
    // 图例（含当前价格）
    if (legend) {
      legend.innerHTML = series.map(s =>
        '<span><i style="background:' + s.color + '"></i>' + s.coin + ' <b style="font-weight:600;color:var(--ink)">' + fmtPrice(s.price) + '</b></span>'
      ).join('');
    }
    if (!series.length) { canvas.style.display = 'none'; empty.hidden = false; return; }
    canvas.style.display = 'block'; empty.hidden = true;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const pad = { l: 50, r: 12, t: 12, b: 24 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    let allV = [];
    series.forEach(s => s.pts.forEach(p => allV.push(p.v)));
    let minV = Math.min.apply(null, allV), maxV = Math.max.apply(null, allV);
    minV = Math.min(minV, 100); maxV = Math.max(maxV, 100);
    const range = Math.max(maxV - minV, 1);
    minV = Math.floor((minV - range * 0.08) / 10) * 10;
    maxV = Math.ceil((maxV + range * 0.08) / 10) * 10;

    const n = Math.max.apply(null, series.map(s => s.pts.length));
    const x = i => pad.l + (i / (n - 1 || 1)) * iw;
    const y = v => pad.t + ih - ((v - minV) / (maxV - minV)) * ih;

    // 网格 + Y 轴（指数刻度）
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const v = minV + (maxV - minV) * i / 4;
      const yy = y(v);
      ctx.strokeStyle = '#ececf0'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
      ctx.fillStyle = '#a1a1a6';
      ctx.fillText(v.toFixed(0), pad.l - 8, yy);
    }
    // 基准线（起点=100）
    ctx.save();
    ctx.setLineDash([4, 4]); ctx.strokeStyle = '#c7c7cc';
    ctx.beginPath(); ctx.moveTo(pad.l, y(100)); ctx.lineTo(W - pad.r, y(100)); ctx.stroke();
    ctx.restore();

    // 各币归一化价格曲线
    series.forEach(s => {
      ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      s.pts.forEach((p, i) => { if (i === 0) ctx.moveTo(x(i), y(p.v)); else ctx.lineTo(x(i), y(p.v)); });
      ctx.stroke();
    });

    // X 轴日期（用最长的那条曲线取时间）
    const base = series.reduce((a, b) => a.pts.length >= b.pts.length ? a : b).pts;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = '#a1a1a6';
    [0, 0.25, 0.5, 0.75, 1].forEach(f => {
      const i = Math.min(base.length - 1, Math.round(f * (n - 1)));
      if (base[i]) ctx.fillText(fmtTime(base[i].t).split(' ')[0], x(i), H - pad.b + 6);
    });
  }

  function renderAll() {
    renderStatus(report ? report.source : { sourceName: '—', mode: 'loading' });
    renderOverview(); renderTable(); renderScoreTable(); drawChart(); renderSignals(); renderTrades();
  }

  async function loadBacktest() {
    try {
      const r = await api('/api/backtest');
      report = r;
      renderAll();
    } catch (e) { toast('回测数据加载失败：' + e.message); }
  }
  async function loadStatus() {
    try { renderStatus(await api('/api/status')); } catch (_) {}
  }

  // 顶部行情条：各附加币实时价格与 24h 涨跌
  function renderLiveTickers(d) {
    const map = [
      { sym: 'MMT', price: 'mmtPrice', change: 'mmtChange', src: 'mmtSource' },
      { sym: 'MERL', price: 'merlPrice', change: 'merlChange', src: 'merlSource' },
      { sym: 'BABY', price: 'babyPrice', change: 'babyChange', src: 'babySource' },
      { sym: 'STX', price: 'stxPrice', change: 'stxChange', src: 'stxSource' },
      { sym: 'BTC', price: 'btcPrice', change: 'btcChange', src: 'btcSource' }
    ];
    for (const m of map) {
      const c = d.coins && d.coins[m.sym];
      const pe = $(m.price), ce = $(m.change), se = $(m.src);
      if (!pe || !ce) continue;
      if (c && c.price > 0) {
        pe.textContent = fmtPrice(c.price);
        ce.textContent = (c.change24h > 0 ? '+' : '') + Number(c.change24h || 0).toFixed(2) + '% (24h)';
        ce.className = 'ticker-change ' + signCls(c.change24h);
        if (se) se.textContent = (c.stale ? '缓存 · ' : '') + (c.sourceName || '实时行情');
      } else if (d.status === 'computing') {
        pe.textContent = '…';
        ce.textContent = '同步中';
        ce.className = 'ticker-change';
        if (se) se.textContent = '实时行情';
      } else {
        pe.textContent = '—';
        ce.textContent = '暂不可达';
        ce.className = 'ticker-change';
        if (se) se.textContent = '行情源暂不可达';
      }
    }
  }
  let livePollCount = 0;
  async function loadLiveTickers() {
    try {
      const d = await api('/api/live-ticker');
      window._liveTickers = d;
      renderLiveTickers(d);
      if (d.status === 'computing' && livePollCount++ < 20) {
        setTimeout(loadLiveTickers, 3000);   // 首次同步中，轮询至就绪
      }
    } catch (_) {}
  }

  async function refresh() {
    const btn = $('refreshBtn');
    btn.classList.add('spin');
    try {
      if (STATIC_SITE) {
        // 静态站没有后端：重新拉取已生成的最新数据，并尝试浏览器直连 OKX 重算
        await loadBacktest();
        await loadMulti(false);
        await loadMarket();
        await loadStatus();
        await loadLiveTickers();
        await loadSignal();
        await tryOkxDirect();
        toast('已重新载入最新数据（每 15 分钟自动更新）');
      } else {
        await api('/api/refresh', { method: 'POST' });
        await loadBacktest();
        loadMulti(true);
        loadLiveTickers();
        toast('数据与回测结果已更新');
      }
    } catch (e) { toast('刷新失败：' + e.message); }
    finally { btn.classList.remove('spin'); }
  }

  /**
   * 浏览器端直连 OKX：若用户所在网络可访问欧易，则直接拉取 12 个月 4H K 线，
   * 在浏览器内用同一引擎重算回测，实现真正的"欧易真实行情"优先。
   * 网络不可达时静默降级到后端采集数据，不影响页面可用性。
   */
  async function tryOkxDirect() {
    const hosts = ['https://www.okx.com', 'https://aws.okx.com'];
    for (const host of hosts) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        const priceRes = await fetch(host + '/api/v5/market/ticker?instId=CORE-USDT', { signal: ctrl.signal, cache: 'no-store' });
        if (!priceRes.ok) throw new Error('ticker HTTP ' + priceRes.status);
        const pj = await priceRes.json();
        if (pj.code !== '0' || !pj.data || !pj.data[0]) throw new Error('ticker empty');
        const tk = pj.data[0];
        const price = +tk.last, open = +tk.open24h;
        const change = open ? (price / open - 1) * 100 : 0;

        // 分页拉取 12 个月 4H K 线（约 22 页，每页 100 根）
        let all = [], after = '';
        for (let page = 0; page < 24; page++) {
          const url = host + '/api/v5/market/history-candles?instId=CORE-USDT&bar=4H&limit=100' + (after ? '&after=' + after : '');
          const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
          const j = await r.json();
          if (j.code !== '0' || !j.data || !j.data.length) break;
          all = all.concat(j.data.map(row => ({ t: +row[0], o: +row[1], h: +row[2], l: +row[3], c: +row[4], v: +row[5] })));
          after = j.data[j.data.length - 1][0];
          if (all.length >= 2250) break;
        }
        clearTimeout(timer);
        if (all.length < 100) throw new Error('K线不足');
        const map = new Map();
        all.forEach(c => map.set(c.t, c));
        const candles = Array.from(map.values()).sort((a, b) => a.t - b.t);

        // 用欧易数据在浏览器内重算全部回测；用 ticker 实时价覆盖最后一根未走完K线
        const local = window.CoreEngine.backtestAll(candles, price);
        report = Object.assign({}, local, {
          generatedAt: Date.now(),
          source: Object.assign({}, report ? report.source : {}, {
            source: 'okx', sourceName: 'OKX 欧易（浏览器直连）', mode: 'live',
            price, change24h: +change.toFixed(2), candleCount: candles.length, lastUpdate: Date.now()
          })
        });
        window._okxDirect = true;
        window._okxPrice = price;
        renderAll();
        toast('已直连 OKX 欧易，回测已按欧易真实行情重算');
        return true;
      } catch (_) { /* 该节点不可达，继续尝试下一个 */ }
    }
    return false;
  }

  /* ============ 实时交易信号 ============ */
  function fmtCountdown(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h > 0 ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  function priceText(v) {
    if (!(v > 0)) return '—';
    return v < 1 ? Number(v).toFixed(6) : Number(v).toFixed(4);
  }
  function actionClass(a) {
    return 'act-' + String(a || 'WAIT').toLowerCase().replace(/_/g, '_');
  }

  function currentSignal() {
    if (!signalReport || !signalReport.coins) return null;
    return signalReport.coins[signalCoin] || null;
  }

  function renderSignal() {
    const box = $('signalAction');
    if (!box) return;
    document.querySelectorAll('#signalCoinSwitch .coin-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.coin === signalCoin);
    });
    const s = currentSignal();
    if (!s || s.error) {
      box.textContent = '—'; box.className = 'signal-action act-wait';
      $('signalReason').textContent = s && s.error ? ('信号计算失败：' + s.error) : '信号数据加载中…';
      return;
    }
    const cur = s.current || {};
    box.textContent = cur.label || '—';
    box.className = 'signal-action ' + actionClass(cur.action);
    $('signalReason').textContent = cur.reason || '—';
    $('signalPrice').textContent = priceText(s.price);
    $('signalTime').textContent = (cur.time ? '动作时间 ' + cur.time : '');

    const urgent = $('signalUrgent');
    if (urgent) urgent.hidden = !cur.urgent;
    const wc = $('signalWillChange');
    if (wc) wc.hidden = !cur.willChange;

    // 倒计时实时刷新
    updateCountdown();

    const risk = s.risk || {};
    $('sigPosition').textContent = risk.holding ? '持仓中' : '空仓';
    $('sigEntry').textContent = risk.entry ? priceText(risk.entry) : '—';
    $('sigAtrStop').textContent = risk.atrStop ? priceText(risk.atrStop) : '—';
    $('sigTrailStop').textContent = risk.trailingStop ? priceText(risk.trailingStop) : '—';
    const dist = $('sigDistance');
    if (risk.distancePct != null) {
      dist.textContent = (risk.distancePct > 0 ? '+' : '') + Number(risk.distancePct).toFixed(2) + '%';
      dist.className = 'sig-v ' + signCls(risk.distancePct);
    } else { dist.textContent = '—'; dist.className = 'sig-v'; }
    $('sigCooldown').textContent = risk.cooldownLeft > 0 ? (risk.cooldownLeft + ' 根（约' + (risk.cooldownLeft * 4 / 24).toFixed(1) + '天）') : '—';
    const ind = s.indicators || {};
    $('sigEma').textContent = (ind.fast && ind.slow) ? (priceText(ind.fast) + ' / ' + priceText(ind.slow)) : '—';
    $('sigRsi').textContent = (ind.rsi != null) ? (Number(ind.rsi).toFixed(1) + ' · ' + (ind.trend || '—')) : '—';

    const cf = s.confirmed || {};
    $('signalConfirmed').textContent = (cf.label || '—') + (cf.reason ? '（' + cf.reason + '）' : '') + (cf.time ? ' @ ' + cf.time : '');

    const gen = s.generatedAt ? new Date(s.generatedAt) : null;
    const src = s.priceSource ? ' · ' + s.priceSource : '';
    $('signalMeta').textContent = (s.sourceName || '实时行情') + src + (gen ? ' · ' + p2(gen.getHours()) + ':' + p2(gen.getMinutes()) + ' 更新' : '');
  }
  function p2(n) { return String(n).padStart(2, '0'); }
  function updateCountdown() {
    const s = currentSignal();
    const el = $('signalCountdown');
    if (!el || !s || s.error || !s.barCloseAt) return;
    const left = Math.max(0, Math.round((s.barCloseAt - Date.now()) / 1000));
    el.textContent = fmtCountdown(left);
    $('signalBarState').textContent = s.inProgress ? '当前K线进行中 · 收盘后信号才稳定' : '等待下一根K线开始';
  }

  async function loadSignal() {
    try {
      const d = await api('/api/signal');
      signalReport = d;
      renderSignal();
    } catch (_) {}
  }

  /** 浏览器直连交易所拉取某币最近 400 根 4H K线（多源降级），用于实时重算信号 */
  async function fetchDirectCandles(symbol) {
    const hosts = ['https://www.okx.com', 'https://aws.okx.com'];
    const apis = [
      {
        key: 'okx', hosts,
        build: (host, after) => host + '/api/v5/market/history-candles?instId=' + symbol + '-USDT&bar=4H&limit=100' + (after ? '&after=' + after : ''),
        parse: j => (j && j.code === '0' && Array.isArray(j.data)) ? j.data.map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] })) : null,
        next: j => (j.data && j.data.length) ? j.data[j.data.length - 1][0] : null
      },
      {
        key: 'binance', hosts: ['https://api.binance.com', 'https://data-api.binance.vision'],
        build: (host, end) => host + '/api/v3/klines?symbol=' + symbol + 'USDT&interval=4h&limit=500' + (end ? '&endTime=' + (end - 1) : ''),
        parse: j => Array.isArray(j) ? j.map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] })) : null,
        next: () => null
      },
      {
        key: 'gate', hosts: ['https://api.gateio.ws'],
        build: (host) => host + '/api/v4/spot/candlesticks?currency_pair=' + symbol + '_USDT&interval=4h&limit=500',
        parse: j => Array.isArray(j) ? j.map(r => ({ t: +r[0] * 1000, o: +r[5], h: +r[3], l: +r[4], c: +r[2], v: +r[6] })) : null,
        next: () => null
      }
    ];
    for (const apiDef of apis) {
      for (const host of apiDef.hosts) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 7000);
          let all = [], cursor = null;
          for (let page = 0; page < 5; page++) {
            const url = apiDef.build(host, cursor);
            const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const j = await r.json();
            const batch = apiDef.parse(j);
            if (!batch || !batch.length) break;
            all = all.concat(batch);
            if (apiDef.key !== 'okx') break;
            cursor = apiDef.next(j);
            if (!cursor || all.length >= 400) break;
          }
          clearTimeout(timer);
          const map = new Map();
          all.forEach(c => { if (c.t > 0 && c.c > 0) map.set(c.t, c); });
          const candles = Array.from(map.values()).sort((a, b) => a.t - b.t);
          if (candles.length >= 40) return { candles, source: apiDef.key };
        } catch (_) { /* 该节点不可达，继续 */ }
      }
    }
    return null;
  }

  /** 浏览器直连重算：拉最新K线+实时价，用同一引擎算信号，让信号不依赖静态更新 */
  async function refreshSignalDirect() {
    const E = window.CoreEngine;
    if (!E || !E.computeLiveSignal) return false;
    let touched = 0;
    for (const sym of COINS) {
      try {
        const got = await fetchDirectCandles(sym);
        if (!got) continue;
        directCandles[sym] = got.candles;
        // 实时价：优先用已有的 ticker 数据
        let price = 0;
        if (sym === 'CORE') {
          price = (window._okxPrice && window._okxPrice > 0) ? window._okxPrice : 0;
        } else {
          const lt = window._liveTickers && window._liveTickers.coins && window._liveTickers.coins[sym];
          if (lt && lt.price > 0) price = lt.price;
        }
        if (!price) price = got.candles[got.candles.length - 1].c;
        const sig = E.computeLiveSignal(got.candles, price);
        if (sig && signalReport && signalReport.coins) {
          sig.symbol = sym;
          sig.sourceName = '浏览器直连 · ' + got.source.toUpperCase();
          sig.priceSource = '实时价覆盖当前K线';
          signalReport.coins[sym] = sig;
          touched++;
        }
      } catch (_) { /* 单币失败不影响其他 */ }
    }
    if (touched) {
      signalReport = Object.assign({}, signalReport, { generatedAt: Date.now(), status: 'ready' });
      renderSignal();
      toast('实时信号已按交易所最新K线重算（' + touched + '/' + COINS.length + ' 币）');
    }
    return touched > 0;
  }

  const sigSwitch = $('signalCoinSwitch');
  if (sigSwitch) {
    sigSwitch.addEventListener('click', e => {
      const b = e.target.closest('.coin-tab'); if (!b) return;
      signalCoin = b.dataset.coin;
      renderSignal();
    });
  }
  setInterval(updateCountdown, 1000);
  setInterval(loadSignal, 60000);              // 静态基线每分钟重载
  setInterval(refreshSignalDirect, 60000);     // 浏览器直连每60秒重算

  $('windowTabs').addEventListener('click', e => {
    const b = e.target.closest('.seg'); if (!b) return;
    document.querySelectorAll('.seg').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); currentWindow = b.dataset.key;
    renderTable(); drawChart(); renderSignals(); renderTrades();
  });
  $('refreshBtn').addEventListener('click', refresh);
  const coinSwitch = $('coinSwitch');
  if (coinSwitch) {
    coinSwitch.addEventListener('click', e => {
      const b = e.target.closest('.coin-tab'); if (!b) return;
      currentCoin = b.dataset.coin;
      renderTrades();
    });
  }
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawChart, 150); });

  loadBacktest().then(() => tryOkxDirect());
  loadMulti();
  loadMarket();
  loadStatus();
  loadLiveTickers();
  loadSignal();
  setInterval(loadStatus, 60000);
  setInterval(loadLiveTickers, 60000);

  // 每 15 分钟自动刷新一次收益数据（云端在 1/16/31/46 分重建，页面延后 2 分钟拉取，页面打开时生效）
  // 用 UTC getter 读取平移 +8h 后的时间，等价于北京时间，避免本地时区差异
  function schedulePeriodicBacktest() {
    const offset = 8 * 3600 * 1000;
    const bjNow = Date.now() + offset;              // 以 UTC 刻度表示的“北京时间”
    const bj = new Date(bjNow);
    // 下一个 15 分钟边界（00/15/30/45）+ 2 分钟，给 Actions 留出生成与发布时间
    const nextBoundary = (Math.floor(bj.getUTCMinutes() / 15) + 1) * 15;
    const target = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate(), bj.getUTCHours(), nextBoundary, 2, 0);
    const delay = Math.max(1000, target - bjNow);
    setTimeout(async () => {
      try { await loadBacktest(); toast('收益数据已按每 15 分钟定时自动刷新'); } catch (_) {}
      loadMulti(true);                               // 同步刷新 MMT / MERL / BABY / STX / BTC 回测
      loadLiveTickers();                             // 同步刷新实时价格
      loadSignal();                                  // 同步刷新实时交易信号
      schedulePeriodicBacktest();                    // 调度下一次
    }, delay);
  }
  schedulePeriodicBacktest();
})();
