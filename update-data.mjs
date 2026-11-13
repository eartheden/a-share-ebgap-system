#!/usr/bin/env node
/* A股股债利差系统 — 数据更新脚本
 *
 * 用途：从公开数据源抓取最新行情，重新生成 data.js。
 * 用法：node update-data.mjs [--dry]
 *   --dry  只生成到 data.new.js，不覆盖正式文件
 *
 * 数据源：
 *   指数收盘价  东方财富 月K（真实成交价）
 *   指数 PE     蛋卷基金 指数估值（周度序列，取每月最后一个观测）
 *   指数股息率  蛋卷基金 当前值，历史按 PE 反推（假设分红率稳定）
 *   10Y 国债    东方财富 中债国债收益率（日度，取每月最后一个交易日）
 *
 * 重要口径：
 *   1) 历史序列只包含「已完整走完」的月份，不含当月未走完的月K，
 *      避免把盘中价和上一日估值拼成一行。
 *   2) 当前值单独放在 meta.anchor：蛋卷 PE 的最新可得值 + 该 PE 日期对应的收盘价。
 *      前端用「实时价格 / 锚点价格」缩放得到盘中 PE，再算 ERP。
 *   3) 免费可靠的历史 PE 自 2016-11 起可得，故序列起点为 2016-11。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry');

const UA = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
};

/* 五个宽基指数：key → 东财 secid / 蛋卷代码 */
const INDICES = [
  { key: 'hs300', name: '沪深300', code: '000300.SH', secid: '1.000300', danjuan: 'SH000300' },
  { key: 'sz50', name: '上证50', code: '000016.SH', secid: '1.000016', danjuan: 'SH000016' },
  { key: 'zz500', name: '中证500', code: '000905.SH', secid: '1.000905', danjuan: 'SH000905' },
  { key: 'zz1000', name: '中证1000', code: '000852.SH', secid: '1.000852', danjuan: 'SH000852' },
  { key: 'cyb', name: '创业板指', code: '399006.SZ', secid: '0.399006', danjuan: 'SZ399006' },
];

const START_MONTH = '2016-11'; // PE 序列可得的最早月份

/* ---------------- 工具 ---------------- */

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers: { ...UA, ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status} · ${url}`);
  return res.json();
}

const round = (x, n) => Math.round(x * 10 ** n) / 10 ** n;
const ymOf = (d) => String(d).slice(0, 7);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function localMonth(offset = 0) {
  const d = new Date();
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/* ---------------- 抓取：指数月K ---------------- */

async function fetchMonthlyClose(idx) {
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${idx.secid}` +
    `&klt=103&fqt=1&beg=20100101&end=20500101&fields1=f1,f2,f3&fields2=f51,f53`;
  const j = await getJSON(url);
  const klines = (j.data && j.data.klines) || [];
  const out = new Map();
  klines.forEach((line) => {
    const [date, close] = line.split(',');
    const v = Number(close);
    if (!Number.isFinite(v) || v <= 0) return;
    out.set(ymOf(date), { date, close: v }); // 同月覆盖，天然取月末
  });
  if (!out.size) throw new Error(`${idx.name} 月K为空`);
  return out;
}

/* ---------------- 抓取：指数日K（用于定位锚点价格） ---------------- */

async function fetchDailyClose(idx, sinceDate) {
  const beg = String(sinceDate).replace(/-/g, '');
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${idx.secid}` +
    `&klt=101&fqt=1&beg=${beg}&end=20500101&fields1=f1,f2&fields2=f51,f53`;
  const j = await getJSON(url);
  const klines = (j.data && j.data.klines) || [];
  const out = new Map();
  klines.forEach((line) => {
    const [date, close] = line.split(',');
    const v = Number(close);
    if (Number.isFinite(v) && v > 0) out.set(date, v);
  });
  return out;
}

/* 取 <= targetDate 的最后一个交易日收盘 */
function closeOnOrBefore(dailyMap, targetDate) {
  let best = null;
  dailyMap.forEach((close, date) => {
    if (date <= targetDate && (!best || date > best.date)) best = { date, close };
  });
  return best;
}

/* ---------------- 抓取：蛋卷 PE 历史 ---------------- */

async function fetchPEHistory(idx) {
  const url = `https://danjuanfunds.com/djapi/index_eva/pe_history/${idx.danjuan}?day=all`;
  const j = await getJSON(url);
  const arr = (j.data && j.data.index_eva_pe_growths) || [];
  if (!arr.length) throw new Error(`${idx.name} PE 历史为空`);

  // 周度 → 每月最后一个观测
  const byMonth = new Map();
  arr.forEach((x) => {
    const pe = Number(x.pe);
    if (!Number.isFinite(pe) || pe <= 0) return;
    const d = new Date(x.ts).toISOString().slice(0, 10);
    const ym = ymOf(d);
    const prev = byMonth.get(ym);
    if (!prev || d > prev.date) byMonth.set(ym, { date: d, pe });
  });
  return byMonth;
}

/* ---------------- 抓取：蛋卷当前估值 ---------------- */

async function fetchCurrentValuation(idx) {
  const url = `https://danjuanfunds.com/djapi/index_eva/detail/${idx.danjuan}`;
  const j = await getJSON(url);
  const d = (j.data && j.data) || {};
  const pe = Number(d.pe);
  const pb = Number(d.pb);
  const dy = Number(d.yeild) * 100; // 蛋卷返回小数
  if (!Number.isFinite(pe) || pe <= 0) throw new Error(`${idx.name} 当前 PE 异常`);
  return {
    pe,
    pb: Number.isFinite(pb) ? pb : null,
    dy: Number.isFinite(dy) ? dy : null,
    date: d.ts ? new Date(d.ts).toISOString().slice(0, 10) : null,
    pePercentile: Number.isFinite(Number(d.pe_percentile)) ? Number(d.pe_percentile) * 100 : null,
  };
}

/* ---------------- 抓取：10Y 国债 ---------------- */

async function fetchBondYield() {
  const base =
    'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_WEB_TREASURYYIELD' +
    '&columns=SOLAR_DATE,EMM00166466&pageSize=500&sortColumns=SOLAR_DATE&sortTypes=-1';
  const headers = { Referer: 'https://data.eastmoney.com/' };

  let all = [];
  for (let page = 1; page <= 20; page += 1) {
    const j = await getJSON(`${base}&pageNumber=${page}`, headers);
    const rows = (j.result && j.result.data) || [];
    if (!rows.length) break;
    all = all.concat(rows);
    if (rows.length < 500) break;
    await sleep(120);
  }
  if (!all.length) throw new Error('国债收益率抓取为空');

  const byMonth = new Map();
  let latest = null;
  all.forEach((r) => {
    const y = Number(r.EMM00166466);
    if (!Number.isFinite(y) || y <= 0) return;
    const date = String(r.SOLAR_DATE).slice(0, 10);
    const ym = ymOf(date);
    const prev = byMonth.get(ym);
    if (!prev || date > prev.date) byMonth.set(ym, { date, yield: y });
    if (!latest || date > latest.date) latest = { date, yield: y };
  });
  return { byMonth, latest };
}

/* ---------------- 主流程 ---------------- */

async function main() {
  console.log('开始抓取数据…\n');

  const bond = await fetchBondYield();
  const bondMap = bond.byMonth;
  console.log(`  10Y 国债     ${bondMap.size} 个月 · 最新 ${bond.latest.yield}%（${bond.latest.date}）`);

  const currentMonth = localMonth(0); // 当月未走完，不进历史序列

  const payload = {
    meta: {},
    bond: { unit: '%', label: '中债10年期国债到期收益率', series: [] },
    index: {},
  };

  const summaries = [];
  const anchorItems = {};
  let peDateLatest = null;

  for (const idx of INDICES) {
    const [closeMap, peMap, cur] = await Promise.all([
      fetchMonthlyClose(idx),
      fetchPEHistory(idx),
      fetchCurrentValuation(idx),
    ]);
    await sleep(200);

    /* 以 PE 可得月份为骨架，逐月补齐收盘价 */
    const months = [...peMap.keys()].filter((m) => m >= START_MONTH && m < currentMonth).sort();
    const rows = [];
    let lastClose = null;

    for (const m of months) {
      const peRec = peMap.get(m);
      const closeRec = closeMap.get(m);

      let close = closeRec ? closeRec.close : null;
      if (close === null) close = lastClose;
      if (close === null) continue;
      lastClose = close;

      rows.push({
        m,
        close: round(close, 2),
        pe: round(peRec.pe, 3),
        dy: round((cur.dy * cur.pe) / peRec.pe, 4), // 股息率 ∝ 1/PE
      });
    }

    if (rows.length < 24) throw new Error(`${idx.name} 有效月份仅 ${rows.length} 个，数据不足`);

    /* ---- 当前锚点：蛋卷最新 PE + 该 PE 日期对应的收盘价 ---- */
    const peDate = cur.date;
    if (!peDateLatest || peDate > peDateLatest) peDateLatest = peDate;
    let anchorPrice = null;
    if (peDate) {
      const since = new Date(peDate);
      since.setDate(since.getDate() - 20);
      const daily = await fetchDailyClose(idx, since.toISOString().slice(0, 10));
      const hit = closeOnOrBefore(daily, peDate);
      if (hit) anchorPrice = hit.close;
      await sleep(150);
    }
    if (anchorPrice === null) {
      // 兜底：用最近一个完整月的收盘价，误差有限
      anchorPrice = rows[rows.length - 1].close;
    }

    anchorItems[idx.key] = {
      price: round(anchorPrice, 2),
      pe: round(cur.pe, 4),
      pb: cur.pb,
      dy: Number.isFinite(cur.dy) ? round(cur.dy, 4) : round(rows[rows.length - 1].dy, 4),
    };

    payload.index[idx.key] = {
      name: idx.name,
      code: idx.code,
      pb: cur.pb,
      rows: rows.map((r) => [r.m, r.close, r.pe, r.dy]),
    };

    summaries.push({
      name: idx.name,
      n: rows.length,
      first: rows[0],
      last: rows[rows.length - 1],
      pePct: cur.pePercentile,
      valDate: cur.date,
      anchor: anchorItems[idx.key],
    });
  }

  /* 债券序列：以指数月份交集为准，保证每行都能取到国债值 */
  const allMonths = new Set();
  Object.values(payload.index).forEach((v) => v.rows.forEach((r) => allMonths.add(r[0])));
  const bondSeries = [...allMonths]
    .filter((m) => bondMap.has(m))
    .sort()
    .map((m) => [m, round(bondMap.get(m).yield, 4)]);

  payload.bond.series = bondSeries;

  /* 若某月国债缺失，从指数行里剔除，避免 NaN */
  const bondSet = new Set(bondSeries.map((x) => x[0]));
  Object.values(payload.index).forEach((v) => {
    v.rows = v.rows.filter((r) => bondSet.has(r[0]));
  });

  const lastBond = bondSeries[bondSeries.length - 1];

  payload.meta = {
    updatedAt: new Date().toISOString(),
    dataDate: peDateLatest,
    bondDate: lastBond[0],
    bondLatestDate: bond.latest.date,
    bondLatest: bond.latest.yield,
    startMonth: bondSeries[0][0],
    months: bondSeries.length,
    priceSource: '东方财富 月K 收盘价（真实成交）',
    peSource: '蛋卷基金 指数估值 PE-TTM（周度序列取月末）',
    bondSource: '东方财富 中债10年期国债到期收益率（日度）',
    dyNote: '股息率当前值取蛋卷，历史按 PE 反推（假设分红率稳定）',
    note: '历史序列只含已走完的月份；当前值由 meta.anchor 提供，前端按实时价格缩放 PE。',
    anchor: {
      peDate: peDateLatest,
      bondDate: bond.latest.date,
      bond: round(bond.latest.yield, 4),
      items: anchorItems,
    },
  };

  const js =
    '/* 数据文件：A股股债利差系统\n' +
    '   本文件由 update-data.mjs 自动生成，请勿手工编辑。\n' +
    '   指数收盘价：东方财富月K（真实成交价）\n' +
    '   指数 PE：蛋卷基金指数估值（周度序列取月末）\n' +
    '   10Y 国债：东方财富中债国债收益率（日度取月末）\n' +
    `   生成时间：${payload.meta.updatedAt}\n` +
    `   数据区间：${payload.meta.startMonth} ~ ${payload.meta.bondDate}（${payload.meta.months} 个月）\n` +
    '   当前锚点：meta.anchor（蛋卷 PE 日期 + 对应收盘价），前端用实时价格缩放。\n' +
    '   说明：免费可靠的历史 PE 自 2016-11 起可得，故序列起点为 2016-11。*/\n' +
    'window.EB_DATA = ' +
    JSON.stringify(payload) +
    ';\n';

  const target = path.join(__dirname, DRY ? 'data.new.js' : 'data.js');
  fs.writeFileSync(target, js, 'utf8');

  console.log('\n抓取结果：');
  console.log('─'.repeat(78));
  summaries.forEach((s) => {
    console.log(
      `  ${s.name.padEnd(8, ' ')} ${String(s.n).padStart(3)} 个月   ` +
        `${s.first.m} ${String(s.first.close).padStart(8)} → ${s.last.m} ${String(s.last.close).padStart(8)}   ` +
        `锚点 ${s.anchor.price} / PE ${s.anchor.pe}`,
    );
  });
  console.log('─'.repeat(78));
  console.log(`  10Y 国债   ${bond.latest.yield}%（${bond.latest.date}）`);
  console.log(`  估值日期   ${peDateLatest}`);
  console.log(`  输出文件   ${target}（${(js.length / 1024).toFixed(1)} KB）`);
  if (DRY) console.log('\n[dry-run] 未覆盖 data.js，请检查 data.new.js 后再正式运行。');
  else {
    console.log('\n完成。刷新浏览器即可看到新数据。');
    console.log('提示：历史序列按月更新；页面上的当前值由浏览器实时行情驱动，无需重跑本脚本。');
    console.log('      选股页（stocks.js）为人工整理的个股快照，不在本脚本自动更新范围内。');
  }
}

main().catch((err) => {
  console.error('\n更新失败：' + err.message);
  console.error('已保留原 data.js，未做任何修改。');
  process.exit(1);
});
