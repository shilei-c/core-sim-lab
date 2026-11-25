#!/usr/bin/env node
/**
 * 成交明细变动监控 → 个人微信推送（多通道自动识别）
 *
 * 逻辑：
 *  1. 读取 docs/data/backtest.json 中 CORE 的最新一笔成交（五个区间一致，取 12m）。
 *  2. 用 "时间戳_方向" 作为成交指纹（价格会随实时价微调，不进指纹以免重复推送）。
 *  3. 与状态文件 data/trade-notify-state.json 中已推送指纹对比：
 *     - 首次运行（无状态文件）：只记录指纹，不推送历史成交。
 *     - 指纹变化：推送消息，成功后写回状态文件。
 *     - 指纹未变：什么都不做。
 *
 * 推送通道（按优先级自动选第一个已配置的，个人微信优先）：
 *  1. SERVERCHAN_SENDKEY  Server酱 → 个人微信「Server酱」服务号（免费 5 条/天）
 *  2. PUSHPLUS_TOKEN      PushPlus 推送加 → 个人微信服务号（免费 200 条/天）
 *  3. WECOM_WEBHOOK       企业微信群机器人（旧通道，保留兼容）
 *  均未配置则跳过推送，不报错。
 *
 * 环境变量：
 *   SERVERCHAN_SENDKEY   Server酱 SendKey（SCT 开头；sctp 开头会自动走 ft07 域名）
 *   PUSHPLUS_TOKEN       PushPlus token
 *   WECOM_WEBHOOK        企业微信群机器人 Webhook 地址
 *   DRY_RUN=1            本地测试：只打印将要发送的内容，不真正发送、不写状态文件
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = __dirname;
const BACKTEST = path.join(ROOT, 'docs', 'data', 'backtest.json');
const STATE_FILE = path.join(ROOT, 'data', 'trade-notify-state.json');
const DRY_RUN = process.env.DRY_RUN === '1';

const SERVERCHAN_KEY = process.env.SERVERCHAN_SENDKEY || '';
const PUSHPLUS_TOKEN = process.env.PUSHPLUS_TOKEN || '';
const WECOM_WEBHOOK = process.env.WECOM_WEBHOOK || '';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return null; }
}

/** 通用 HTTP 请求：支持 JSON 与表单两种 body */
function request(url, body, form) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = form
      ? Buffer.from(new URLSearchParams(body).toString(), 'utf8')
      : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = form
      ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': data.length }
      : { 'Content-Type': 'application/json', 'Content-Length': data.length };
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers
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

/** 构造通用消息：标题 + Markdown 正文（个人微信与企业微信通用，不用专有标签） */
function buildMessage(t) {
  const side = t.side === 'buy' ? '买入' : '卖出';
  const pnlLine = (t.side === 'sell' && t.pnl != null)
    ? `\n- 本笔盈亏：**${t.pnl >= 0 ? '+' : ''}${t.pnl} USDT**`
    : '';
  const body = [
    `### CORE 模拟交易 · 新成交提醒`,
    `- 时间：**${t.beijing || t.utc || '-'}**（北京时间）`,
    `- 方向：**${side}**`,
    `- 价格：**${t.price}** USDT`,
    `- 数量：${t.amount}`,
    `- 原因：${t.reason || '-'}` + pnlLine,
    ``,
    `> 历史 4H K 线虚拟回测成交，非实盘交易，仅供参考。`
  ].join('\n');
  return { title: 'CORE 成交提醒 · ' + side, body };
}

/** 选择通道并返回 {name, send} */
function pickChannel() {
  if (SERVERCHAN_KEY) {
    return {
      name: 'Server酱（个人微信）',
      send: async (msg) => {
        // sctp 前缀的 Turbo key 走独立域名：https://{uid}.push.ft07.com/send/{key}.send
        let url;
        const m = SERVERCHAN_KEY.match(/^sctp(\d+)t/);
        if (m) url = `https://${m[1]}.push.ft07.com/send/${SERVERCHAN_KEY}.send`;
        else url = `https://sctapi.ftqq.com/${SERVERCHAN_KEY}.send`;
        const res = await request(url, { title: msg.title, desp: msg.body }, true);
        let ok = false, detail = '';
        try { const j = JSON.parse(res.body); ok = (j.code === 0); detail = 'code=' + j.code + (j.message ? ' ' + j.message : ''); }
        catch (_) { detail = res.body.slice(0, 120); }
        return { ok: res.code === 200 && ok, detail, url };
      }
    };
  }
  if (PUSHPLUS_TOKEN) {
    return {
      name: 'PushPlus（个人微信）',
      send: async (msg) => {
        const res = await request('https://www.pushplus.plus/send', {
          token: PUSHPLUS_TOKEN,
          title: msg.title,
          content: msg.body,
          template: 'markdown'
        });
        let ok = false, detail = '';
        try { const j = JSON.parse(res.body); ok = (j.code === 200); detail = 'code=' + j.code + (j.msg ? ' ' + j.msg : ''); }
        catch (_) { detail = res.body.slice(0, 120); }
        return { ok: res.code === 200 && ok, detail, url: 'https://www.pushplus.plus/send' };
      }
    };
  }
  if (WECOM_WEBHOOK) {
    return {
      name: '企业微信群机器人',
      send: async (msg) => {
        const res = await request(WECOM_WEBHOOK, {
          msgtype: 'markdown', markdown: { content: msg.title + '\n\n' + msg.body }
        });
        let ok = false, detail = '';
        try { const j = JSON.parse(res.body); ok = (j.errcode === 0); detail = 'errcode=' + j.errcode + (j.errmsg ? ' ' + j.errmsg : ''); }
        catch (_) { detail = res.body.slice(0, 120); }
        return { ok: res.code === 200 && ok, detail, url: WECOM_WEBHOOK.split('?')[0] };
      }
    };
  }
  return null;
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

  const msg = buildMessage(latest);
  const channel = pickChannel();

  if (DRY_RUN) {
    console.log('[notify][DRY_RUN] 检测到新成交');
    console.log('  通道:', channel ? channel.name : '未配置（将跳过）');
    console.log('  标题:', msg.title);
    console.log('  正文:\n' + msg.body);
    return;
  }

  if (!channel) {
    console.log('[notify] 检测到新成交但未配置任何推送通道（SERVERCHAN_SENDKEY / PUSHPLUS_TOKEN / WECOM_WEBHOOK），跳过');
    return;
  }

  try {
    console.log('[notify] 推送通道:', channel.name);
    const res = await channel.send(msg);
    if (!res.ok) {
      console.error('[notify] 推送失败', res.detail);
      process.exitCode = 1;   // 让 Actions 步骤失败，便于发现；状态文件不更新，下次会重试
      return;
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      fingerprint, beijing: latest.beijing, side: latest.side, price: latest.price,
      notifiedAt: Date.now(), channel: channel.name, message: '已推送'
    }, null, 2));
    console.log('[notify] 已推送新成交 ' + fingerprint + '（' + res.detail + '）');
  } catch (e) {
    console.error('[notify] 推送异常:', e.message);
    process.exitCode = 1;
  }
})();
