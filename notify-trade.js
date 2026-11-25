#!/usr/bin/env node
/**
 * 成交明细变动监控 → 企业微信群机器人推送
 *
 * 逻辑：
 *  1. 读取 docs/data/backtest.json 中 CORE 的最新一笔成交（五个区间一致，取 12m）。
 *  2. 用 "时间戳_方向" 作为成交指纹（价格会随实时价微调，不进指纹以免重复推送）。
 *  3. 与状态文件 data/trade-notify-state.json 中已推送指纹对比：
 *     - 首次运行（无状态文件）：只记录指纹，不推送历史成交。
 *     - 指纹变化：推送 markdown 消息到企业微信群机器人，成功后写回状态文件。
 *     - 指纹未变：什么都不做。
 *
 * 环境变量：
 *   WECOM_WEBHOOK  企业微信群机器人 Webhook 地址（必填，未配置则跳过推送）
 *   DRY_RUN=1      本地测试：只打印将要发送的内容，不真正发送、不写状态文件
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = __dirname;
const BACKTEST = path.join(ROOT, 'docs', 'data', 'backtest.json');
const STATE_FILE = path.join(ROOT, 'data', 'trade-notify-state.json');
const WEBHOOK = process.env.WECOM_WEBHOOK || '';
const DRY_RUN = process.env.DRY_RUN === '1';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return null; }
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve({ code: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.write(data);
    req.end();
  });
}

function buildMessage(t, generatedAt) {
  const side = t.side === 'buy' ? '🟢 买入' : '🔴 卖出';
  const pnlLine = (t.side === 'sell' && t.pnl != null)
    ? `\n> 本笔盈亏：<font color="${t.pnl >= 0 ? 'warning' : 'info'}">${t.pnl >= 0 ? '+' : ''}${t.pnl} USDT</font>`
    : '';
  const content = [
    '## CORE 模拟交易 · 新成交提醒',
    `> 时间：**${t.beijing || t.utc || '-'}**（北京时间）`,
    `> 方向：**${side}**`,
    `> 价格：**${t.price}** USDT`,
    `> 数量：${t.amount}`,
    `> 原因：${t.reason || '-'}` + pnlLine,
    `\n<font color="comment">成交明细为历史 4H K 线虚拟回测结果，非实盘交易，仅供参考。</font>`
  ].join('\n');
  return { msgtype: 'markdown', markdown: { content } };
}

(async () => {
  const bt = readJson(BACKTEST);
  if (!bt || !bt.results) { console.log('[notify] 无回测数据，跳过'); return; }

  // CORE 五区间最新成交一致，取 12m
  const rows = bt.results['12m'] || bt.results['1m'] || [];
  const latest = rows[0] && Array.isArray(rows[0].tradeLedger) ? rows[0].tradeLedger[0] : null;
  if (!latest) { console.log('[notify] 无成交记录，跳过'); return; }

  const fingerprint = `${latest.ts}_${latest.side}`;
  const state = readJson(STATE_FILE);
  const lastFp = state && state.fingerprint;

  if (lastFp === fingerprint) {
    console.log('[notify] 成交未变（' + fingerprint + '），无需推送');
    return;
  }

  // 首次运行：只记录基线，不推送历史成交
  if (!state) {
    if (DRY_RUN) {
      console.log('[notify][DRY_RUN] 首次运行，将记录基线指纹 ' + fingerprint + '，不推送');
    } else {
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        fingerprint, beijing: latest.beijing, side: latest.side, price: latest.price,
        recordedAt: Date.now(), note: '首次运行记录的基线成交'
      }, null, 2));
      console.log('[notify] 首次运行，已记录基线指纹 ' + fingerprint);
    }
    return;
  }

  const message = buildMessage(latest, bt.generatedAt);
  if (DRY_RUN) {
    console.log('[notify][DRY_RUN] 检测到新成交，将推送：');
    console.log(JSON.stringify(message, null, 2));
    return;
  }

  if (!WEBHOOK) {
    console.log('[notify] 检测到新成交但未配置 WECOM_WEBHOOK，跳过推送');
    return;
  }

  try {
    const res = await postJson(WEBHOOK, message);
    let ok = false;
    try { ok = JSON.parse(res.body).errcode === 0; } catch (_) {}
    if (res.code !== 200 || !ok) {
      console.error('[notify] 推送失败 HTTP', res.code, res.body);
      process.exitCode = 1;   // 让 Actions 步骤失败，便于发现；状态文件不更新，下次会重试
      return;
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      fingerprint, beijing: latest.beijing, side: latest.side, price: latest.price,
      notifiedAt: Date.now(), message: '已推送至企业微信群机器人'
    }, null, 2));
    console.log('[notify] 已推送新成交 ' + fingerprint);
  } catch (e) {
    console.error('[notify] 推送异常:', e.message);
    process.exitCode = 1;
  }
})();
