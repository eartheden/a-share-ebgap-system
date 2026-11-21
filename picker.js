/* A股股债利差系统 — 每日短线选股引擎 v3.0
 *
 * 与旧版（stocks.js 手写 5 只股票 + 手填分数）的根本区别：
 *   1) 候选池 = 全 A 股 5500+ 只，每次刷新重新抓取实时行情，不预设标的；
 *   2) 六个维度全部由原始数据现算（资金/量价/位置/行业/流动性/质量），
 *      权重可调，调完立即重算，没有一处是手敲的分；
 *   3) 先判断「今天是什么行情」（进攻/均衡/防守），再决定选股偏好、
 *      候选数量和仓位纪律——所以每天推出来的股票会不一样；
 *   4) 每天的推荐落盘到 localStorage，可回看历史并计算至今收益。
 *
 * 数据源：东方财富 push2 公开行情接口（浏览器 JSONP 直连，本地计算）
 * 暴露：window.EB_PICKER = { render, refresh, state }
 */
(function () {
  'use strict';

  var API = 'https://push2.eastmoney.com';
  var FIELDS = [
    'f2', 'f3', 'f6', 'f7', 'f8', 'f10', 'f12', 'f14', 'f15', 'f16', 'f17',
    'f18', 'f20', 'f21', 'f23', 'f24', 'f25', 'f26', 'f37', 'f46', 'f62', 'f100', 'f115'
  ].join(',');
  var FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23'; // 深主板｜创业板｜沪主板｜科创板
  var PAGE = 100;
  var POOL_CONCURRENCY = 6;
  var POOL_LIMIT = 60;         // 候选池表格最多展示行数
  var CACHE_MS = 3 * 60 * 1000; // 内存行情缓存 3 分钟
  /* 选股历史：本地只当缓存，真正的真源是 daily_advice 表（带 user_id）。
     v4 起键按会员隔离，并且每次 loadAdvice 会用数据库里的记录回填，
     所以换台电脑登录也能看到自己的历史。 */
  function HKEY() { return window.EB_NS ? EB_NS.ukey('ebgap.pick.hist.v4') : 'ebgap.pick.hist.v4'; }

  var DIM = [
    { key: 'd1', name: '资金动能', short: '资金', desc: '主力净额及其占成交额比重' },
    { key: 'd2', name: '量价强度', short: '量价', desc: '涨幅、换手、量比、收盘位置' },
    { key: 'd3', name: '位置空间', short: '位置', desc: '近 60 日与年内涨幅所处位置' },
    { key: 'd4', name: '行业动能', short: '行业', desc: '所属行业当日平均涨幅排名' },
    { key: 'd5', name: '流动性', short: '流动', desc: '成交额与总市值的可交易区间' },
    { key: 'd6', name: '质量安全', short: '质量', desc: 'ROE、净利增速、PE 排雷' },
    { key: 'd7', name: '前瞻信号', short: '前瞻', desc: '吸筹潜伏、蓄势未透支，面向未来的启动概率' }
  ];

  /* ================= 三档持有周期 =================
     同一批行情，三套完全不同的选股逻辑。核心改造（2026-11-20）：
     原来的短线把 60% 权重压在 d1 资金动能 + d2 量价强度上，选出来的是
     「今天已经涨得好」的股票——那是追已实现的动量，等于接盘。
     现在新增 d7「前瞻信号」：用吸筹潜伏（资金进但价未大涨）、蓄势未透支
     （低振幅+位置低+换手温和）来估「未来启动概率」，成为短线第一权重。
       S 短线：赚启动的钱——资金潜伏 + 蓄势未涨，1–5 个交易日
       M 中线：赚趋势初段的钱——位置在启动区 + 前瞻确认，10–30 个交易日
       L 长线：赚业绩与估值的钱——ROE/估值为主，前瞻只作辅助，60–180 日
     权重 d1–d7 对应七维分数；vw 是「估值分」在合成里的固定占比。
     权重可被用户按档位单独调整，互不干扰。 */
  var HZ = {
    S: {
      key: 'S', label: '短线', short: '短',
      window: '1–5 个交易日',
      shortWin: '1–5 日',
      desc: '赚启动的钱：主力低位吸筹、量能温和放大、股价尚未透支，提前埋伏而非追涨。',
      discipline: '止损 −4.5% 左右，第一目标 +5.5%，破位就走，不隔夜恋战。',
      /* 前瞻 30 + 资金 18 + 位置 16 为主；追涨型的 d1/d2 合计从 60 降到 30 */
      w: { d1: 18, d2: 12, d3: 16, d4: 12, d5: 6, d6: 6, d7: 30 },
      vw: 0,
      topN: 6,
      buyLow: 0.015, buyHigh: 0.005, stop: 0.045, t1: 0.055, t2: 0.09,
      posBase: [15, 13, 11, 9, 7]
    },
    M: {
      key: 'M', label: '中线', short: '中',
      window: '10–30 个交易日（约 2–6 周）',
      shortWin: '10–30 日',
      desc: '赚趋势初段的钱：60 日位置仍在启动区、前瞻信号确认、行业景气能延续。',
      discipline: '止损 −8% 左右，第一目标 +12%，按周看，不被日内波动洗出去。',
      w: { d1: 10, d2: 7, d3: 24, d4: 16, d5: 10, d6: 11, d7: 22 },
      vw: 0.16,
      topN: 4,
      buyLow: 0.03, buyHigh: 0.01, stop: 0.08, t1: 0.12, t2: 0.20,
      posBase: [12, 10, 9, 8, 7]
    },
    L: {
      key: 'L', label: '长线', short: '长',
      window: '60–180 个交易日（约 3–9 个月）',
      shortWin: '60–180 日',
      desc: '赚业绩与估值的钱：ROE 稳定、估值不贵、位置未透支，前瞻仅作辅助。',
      discipline: '止损 −15% 左右，第一目标 +25%，按季报验证，分批建仓。',
      w: { d1: 5, d2: 3, d3: 16, d4: 5, d5: 9, d6: 54, d7: 8 },
      vw: 0.38,
      topN: 3,
      buyLow: 0.05, buyHigh: 0.02, stop: 0.15, t1: 0.25, t2: 0.45,
      posBase: [10, 9, 8, 7, 6]
    }
  };
  var HZ_ORDER = ['S', 'M', 'L'];

  /* 各档硬性门槛：同一只票在短线档合格，不代表能进长线名单 */
  /* maxPct：当日涨幅上限。追涨改造的关键门槛——短线涨幅 >6% 的票
     当日动能已兑现，次日追高期望为负，直接剔除而非靠打分微调。 */
  var HZ_RULE = {
    S: { minAmt: 1.5e8, maxTurn: 12, minCap: 20e8, minList: 60, maxD60: 45, minD60: -25, minPct: -5, maxPct: 6 },
    M: { minAmt: 1.0e8, maxTurn: 12, minCap: 40e8, minList: 180, maxD60: 45, minPct: -7, maxPct: 8, minRoe: 2, maxPe: 150, needProfit: true },
    L: { minAmt: 0.8e8, maxTurn: 12, minCap: 80e8, minList: 730, maxD60: 60, minD60: -40, minRoe: 8, maxPe: 60, minNp: -15, needProfit: true }
  };

  /* 仓位模式：只调整仓位系数与短线档候选数量，不再覆盖三档权重 */
  var REGIME = {
    offense: {
      label: '进攻模式', cls: 'off', temp: '市场普涨、赚钱效应强',
      posMul: 1.0, sTopN: 6, pos: '总仓位 60%–80%，单只 10%–15%',
      note: '行情偏强：短线档多给候选、仓位系数给足；中长线档数量不变，避免在情绪高点堆长期仓位。'
    },
    neutral: {
      label: '均衡模式', cls: 'neu', temp: '涨跌互现、结构分化',
      posMul: 0.85, sTopN: 5, pos: '总仓位 30%–50%，单只 8%–12%',
      note: '结构市：三档都按标准执行，短线档取 5 只，中长线档只留最优的少数标的。'
    },
    defense: {
      label: '防守模式', cls: 'def', temp: '下跌家数占优、情绪偏弱',
      posMul: 0.6, sTopN: 3, pos: '总仓位 10%–20%，单只 ≤8%',
      note: '弱势：短线档收缩到 3 只、仓位系数打六折；中长线档宁可空着，也不为了凑数降低门槛。'
    }
  };

  var S = {
    raw: null,          // 全市场原始数据
    scored: null,       // 打过分并排序
    indStats: null,     // 行业统计
    mkt: null,          // 大盘 / 宽度 / 温度
    regimeKey: 'neutral',
    mode: 'auto',       // auto | offense | neutral | defense
    loading: false,
    error: null,
    at: null,           // 最近一次成功抓取时间
    quoteDate: null,    // 行情所属交易日 YYYY-MM-DD
    src: null,          // 数据源：eastmoney | tencent
    /* 当前这批数据是否带财务字段（ROE/PB/上市日期）。腾讯源没有，
       中长线档必须自动降级，否则门槛会把全市场杀成 0 只 */
    fundamentals: true,
    prog: { done: 0, total: 0 },
    hz: 'S',                 // 当前查看的周期档：S 短线 | M 中线 | L 长线
    hzPicks: { S: [], M: [], L: [] },   // 三档各自的候选名单
    hzW: {
      S: { d1: 18, d2: 12, d3: 16, d4: 12, d5: 6, d6: 6, d7: 30 },
      M: { d1: 10, d2: 7, d3: 24, d4: 16, d5: 10, d6: 11, d7: 22 },
      L: { d1: 5, d2: 3, d3: 16, d4: 5, d5: 9, d6: 54, d7: 8 }
    },
    hzTopN: { S: 6, M: 4, L: 3 },
    hzTouched: { S: false, M: false, L: false },
    histHz: 'S',             // 历史跟踪默认看短线档
    filters: { ind: 'all', minScore: 0, inflow: false, q: '' },
    sort: { k: 'total', dir: -1 },
    hist: [],
    advice: null,       // 每日建议存档（来自数据库）
    ai: null,           // AI 复核结果 { byCode, at, model, plan }
    expanded: {},       // 展开的理由卡片
    timer: null
  };

  /* 记住上次看的是哪一档：刷新后不用每次重新点 */
  try {
    var _lastHz = localStorage.getItem('ebgap.pick.hz.v1');
    if (_lastHz === 'S' || _lastHz === 'M' || _lastHz === 'L') S.hz = _lastHz;
  } catch (e) { /* ignore */ }

  /* ================= 工具 ================= */
  var seq = 0;
  function jsonp(url, timeout) {
    // 统一走本机代理 /api/stock/em（原因见 stock.js 同名注释）
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, timeout || 12000);
    return fetch('/api/stock/em?u=' + encodeURIComponent(url), {
      headers: { Accept: 'application/json' }, signal: ctl.signal
    }).then(function (r) {
      clearTimeout(timer);
      return r.json().then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || '接口异常 HTTP ' + r.status);
        return j;
      });
    }, function (e) {
      clearTimeout(timer);
      throw new Error(e && e.name === 'AbortError' ? '接口超时' : '接口不可达');
    });
  }

  /* ================= 本机数据库 API（server.py 提供；不可用时回退 localStorage） ================= */
  var API_OK = null;   // null=未探测 true=可用 false=不可用（例如直接用 python -m http.server 起的站）

  function apiGet(path, timeout) {
    return Promise.race([
      fetch(path, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      }),
      new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, timeout || 4000); })
    ]);
  }

  function apiPost(path, body, timeout) {
    return Promise.race([
      fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      }).then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      }),
      new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, timeout || 6000); })
    ]);
  }

  function pool(items, limit, fn) {
    return new Promise(function (resolve, reject) {
      var out = new Array(items.length), idx = 0, active = 0, finished = 0, aborted = false;
      function launch() {
        if (aborted) return;
        if (finished === items.length) return resolve(out);
        while (active < limit && idx < items.length) {
          (function (k) {
            active++;
            fn(items[k], k).then(function (v) { out[k] = v; }, function (e) {
              if (!aborted) { aborted = true; reject(e); }
            }).then(function () { active--; finished++; launch(); });
          })(idx++);
        }
      }
      launch();
    });
  }

  function num(x) {
    var v = typeof x === 'number' ? x : parseFloat(x);
    return isFinite(v) ? v : 0;
  }
  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function fx(x, n) {
    if (!isFinite(x)) return '—';
    return Number(x).toFixed(n === undefined ? 2 : n);
  }
  function fAmt(y) {
    if (!isFinite(y) || y === 0) return '—';
    if (Math.abs(y) >= 1e12) return fx(y / 1e12, 2) + ' 万亿';
    if (Math.abs(y) >= 1e8) return fx(y / 1e8, 2) + ' 亿';
    return fx(y / 1e4, 0) + ' 万';
  }
  function signedPct(x, n) {
    if (!isFinite(x)) return '—';
    return (x > 0 ? '+' : '') + fx(x, n === undefined ? 2 : n) + '%';
  }
  function upCls(x) { return x > 0 ? 'pk-up' : (x < 0 ? 'pk-down' : 'pk-flat'); }
  function bjNow() {
    var now = new Date();
    return new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 8 * 3600000);
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  /* 把 UTC 秒级时间戳转成“本地字段表示北京时间”的 Date，供 ymd/hhmm 读取 */
  function bjDate(ts) {
    var d = new Date(ts * 1000);
    return new Date(d.getTime() + d.getTimezoneOffset() * 60000 + 8 * 3600000);
  }
  function hhmm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  /* 抓不到行情时给一句能看懂的话：本地服务 / 线上静态站的成因完全不一样，不要混着说 */
  function marketHintHtml() {
    var isLocal = /^(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])$/.test(location.hostname);
    if (!isLocal) {
      return '<p>线上版由浏览器直接请求东方财富公开行情接口，不经过任何中转。' +
        '如果处在代理 / VPN 环境，<code>push2.eastmoney.com</code> 的全市场列表接口经常被拦截' +
        '（K 线、指数接口可能仍然正常），换成直连网络或给该域名加直连规则即可。已抓到的缓存不受影响。</p>';
    }
    return '<p>行情经本地服务中转（server.py）获取：整批优先东方财富，失败自动整批切腾讯财经。' +
      '请确认服务是用<b>启动.command</b>或 <code>python3 server.py</code> 起的' +
      '（纯静态 http.server 没有中转能力），并确认网络能访问 qq.com / eastmoney。之前抓到的缓存不受影响。</p>';
  }
  function isTradingTime() {
    var d = bjNow(), wd = d.getDay();
    if (wd === 0 || wd === 6) return false;
    var hm = d.getHours() * 100 + d.getMinutes();
    return (hm >= 915 && hm <= 1135) || (hm >= 1300 && hm <= 1505);
  }
  function limitOf(code) {
    if (/^(30|68)/.test(code)) return 20;
    if (/^(8|4)/.test(code)) return 30;
    return 10;
  }

  /* ================= 数据抓取 ================= */
  /* 走本地服务端中转（server.py），但整批必须来自同一个源：
     东财行带 ROE/PB/上市日期，腾讯行没有；混着抓会让中长线档的财务门槛
     把全市场误杀成 0 只。所以先整批东财，任何一页失败就整批换腾讯。 */
  function clistQuery(pn, src) {
    return 'pn=' + pn + '&pz=' + PAGE + '&po=1&np=1&fltt=2&invt=2' +
      '&fid=f12&fs=' + FS + '&fields=' + FIELDS + (src ? '&src=' + src : '') + '&_=' + Date.now();
  }

  function fetchPage(pn, src) {
    return fetch('/api/market/list?' + clistQuery(pn, src), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('中转 http ' + r.status);
        return r.json();
      })
      .then(function (j) {
        if (!j || !j.data || !Array.isArray(j.data.diff)) throw new Error('中转返回为空');
        return j;
      });
  }

  function fetchPages(src) {
    return fetchPage(1, src).then(function (first) {
      var data = first.data;
      if (!data.diff.length) throw new Error('行情接口返回为空');
      var total = data.total || data.diff.length;
      var pages = Math.ceil(total / PAGE);
      S.prog = { done: 1, total: pages };
      renderState();

      var rows = data.diff.slice();
      var rest = [];
      for (var p = 2; p <= pages; p++) rest.push(p);

      return pool(rest, POOL_CONCURRENCY, function (pn) {
        return fetchPage(pn, src).then(function (j) {
          S.prog.done++;
          if (S.prog.done % 6 === 0) renderState();
          return j.data.diff;
        });
      }).then(function (chunks) {
        chunks.forEach(function (c) { rows = rows.concat(c); });
        return { rows: rows, src: data.src || (src === 'tx' ? 'tencent' : 'eastmoney') };
      });
    });
  }

  function pageUrl(pn) {
    return API + '/api/qt/clist/get?' + clistQuery(pn);
  }

  /* 工具栏右侧的数据源标记：让「用的哪路数据、缺了什么」一眼可见 */
  function renderSrc() {
    var box = document.querySelector('#v-pick .pk-tool-src');
    if (!box) return;
    if (S.src === 'tencent') {
      box.innerHTML = '<i></i>数据源：腾讯财经 · 本地计算（缺 ROE/PB/上市日期，' +
        '<b>财务门槛已关闭</b>，中长线档仅供参考）';
    } else if (S.src === 'eastmoney') {
      box.innerHTML = '<i></i>东方财富公开行情 · 本地计算';
    }
  }

  function parseRow(d) {
    var code = String(d.f12 || '');
    return {
      code: code,
      name: String(d.f14 || ''),
      price: num(d.f2), pct: num(d.f3), amt: num(d.f6), amp: num(d.f7),
      turn: num(d.f8), volRatio: num(d.f10),
      high: num(d.f15), low: num(d.f16), open: num(d.f17), prev: num(d.f18),
      cap: num(d.f20), floatCap: num(d.f21), pb: num(d.f23),
      d60: num(d.f24), ytd: num(d.f25), listDate: num(d.f26),
      roe: num(d.f37), npYoY: num(d.f46), net: num(d.f62),
      ind: String(d.f100 || '未分类'),
      pe: num(d.f115)
    };
  }

  function fetchMarket() {
    S.loading = true;
    S.error = null;
    S.prog = { done: 0, total: 0 };
    renderState();

    return fetchPages('em')
      .catch(function (emErr) {
        /* 东财任一页失败：整批改用腾讯，宁可少几个字段，也不要两份数据混在一起 */
        S.prog = { done: 0, total: 0 };
        renderState();
        return fetchPages('tx').catch(function (txErr) {
          throw new Error('东财与腾讯均失败：' + (emErr && emErr.message) + ' / ' + (txErr && txErr.message));
        });
      })
      .then(function (res) {
        var rows = res.rows;
        S.src = res.src;
        /* 腾讯源没有 ROE/PB/上市日期：中长线档据此走降级门槛，界面也会标注 */
        S.fundamentals = res.src === 'eastmoney';
        var seen = {};
        var out = [];
        rows.forEach(function (d) {
          var r = parseRow(d);
          if (!r.code || seen[r.code]) return;
          seen[r.code] = 1;
          out.push(r);
        });
        return Promise.all([Promise.resolve(out), fetchIndex()]);
      }).then(function (res) {
      S.raw = res[0];
      var idx = res[1] || {};
      S.at = new Date();
      S.quoteDate = idx.date || ymd(bjNow());
      S.mkt = buildMarket(S.raw, idx);
      S.indStats = buildIndustryStats(S.raw);
      S.loading = false;
      S.scored = null;
      renderSrc();
      compute();
      recordHistory();
      render();
      /* AI 卡片在数据未就绪时只显示占位，数据到位后让它重新渲染 */
      if (window.EB_AI && typeof window.EB_AI.mount === 'function') window.EB_AI.mount();
    }).catch(function (e) {
      S.loading = false;
      S.error = (e && e.message) || '数据抓取失败';
      renderState();
      render();
    });
  }

  function fetchIndex() {
    var q = 'fltt=2&secids=1.000001,0.399001,0.399006,1.000300' +
      '&fields=f2,f3,f6,f12,f14,f124&_=' + Date.now();
    // 与 fetchPage 同策略：中转优先，当次失败才退直连代理（ulist 被拦时代理有腾讯兜底）
    var req = fetch('/api/market/index?' + q, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('index http ' + r.status); return r.json(); })
      .catch(function () { return jsonp(API + '/api/qt/ulist.np/get?' + q, 10000); });
    return req.then(function (j) {
      var diff = (j && j.data && j.data.diff) || [];
      var out = { list: [], amt: 0, date: null, pct: 0 };
      var map = { '000001': '上证指数', '399001': '深证成指', '399006': '创业板指', '000300': '沪深300' };
      diff.forEach(function (d) {
        var key = String(d.f12);
        var pct = num(d.f3);
        out.list.push({ code: key, name: map[key] || String(d.f14), price: num(d.f2), pct: pct });
        if (key === '000001' || key === '399001') out.amt += num(d.f6);
        if (key === '000001' && d.f124) {
          out.date = ymd(bjDate(num(d.f124)));
        }
      });
      var pick = out.list.filter(function (x) { return x.code === '000300' || x.code === '399006'; });
      out.pct = pick.length ? pick.reduce(function (a, b) { return a + b.pct; }, 0) / pick.length : 0;
      return out;
    }).catch(function () { return null; });
  }

  /* ================= 市场温度 ================= */
  /* 分时成交额累计占比（A 股经验分布，U 型：早盘与尾盘密集、午间清淡）。
     用它把盘中累计成交额外推到全天；单纯按时间线性外推会低估早盘的成交速度，
     导致上午温度虚高、误判成进攻模式。 */
  var AMT_CURVE = [
    [570, 0], [575, 0.05], [585, 0.11], [600, 0.22], [630, 0.35],
    [660, 0.44], [690, 0.50], [779, 0.50], [780, 0.51], [810, 0.61],
    [840, 0.70], [870, 0.82], [890, 0.91], [900, 1]
  ];
  function tradedFraction(at) {
    var d = at || bjNow(), wd = d.getDay();
    if (wd === 0 || wd === 6) return 1;
    var hm = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
    if (hm <= AMT_CURVE[0][0]) return 0;
    if (hm >= AMT_CURVE[AMT_CURVE.length - 1][0]) return 1;
    for (var i = 1; i < AMT_CURVE.length; i++) {
      var a = AMT_CURVE[i - 1], b = AMT_CURVE[i];
      if (hm <= b[0]) {
        var r = (b[0] - a[0]) ? (hm - a[0]) / (b[0] - a[0]) : 1;
        return a[1] + (b[1] - a[1]) * r;
      }
    }
    return 1;
  }

  function buildMarket(rows, idx) {
    var up = 0, down = 0, flat = 0, zt = 0, dt = 0, amt = 0, valid = 0;
    rows.forEach(function (r) {
      if (!(r.price > 0) || !r.amt) return;
      valid++;
      amt += r.amt;
      if (r.pct > 0.05) up++; else if (r.pct < -0.05) down++; else flat++;
      var lim = limitOf(r.code);
      if (r.pct >= lim - 0.35) zt++;
      if (r.pct <= -(lim - 0.35)) dt++;
    });

    var breadth = valid ? up / valid : 0.5;
    var breadthScore = clamp(breadth * 130 - 20, 0, 100);
    var idxPct = idx && isFinite(idx.pct) ? idx.pct : 0;
    var idxScore = clamp(50 + idxPct * 22, 5, 95);
    var ztScore = clamp(35 + zt * 0.5 - dt * 1.6, 5, 95);
    var amtScore = 62;
    var prevAmt = prevAmount(amt);
    var frac = tradedFraction();
    if (prevAmt > 0 && frac > 0.03) {
      var projAmt = frac >= 0.98 ? amt : amt / frac;
      amtScore = clamp(50 + (projAmt / prevAmt - 1) * 110, 10, 92);
    }

    var temp = Math.round(0.35 * breadthScore + 0.3 * idxScore + 0.2 * ztScore + 0.15 * amtScore);
    temp = clamp(temp, 0, 100);

    return {
      up: up, down: down, flat: flat, valid: valid, zt: zt, dt: dt,
      amt: amt, idx: (idx && idx.list) || [], idxPct: idxPct,
      temp: temp,
      parts: { breadth: Math.round(breadthScore), idx: Math.round(idxScore), zt: Math.round(ztScore), amt: Math.round(amtScore) },
      breadthRatio: valid ? up / valid : 0,
      prevAmt: prevAmt, frac: frac
    };
  }

  function regimeOf(temp) {
    if (temp >= 64) return 'offense';
    if (temp >= 42) return 'neutral';
    return 'defense';
  }

  function amtKey() { return 'ebgap.amtlog.v3'; }
  function prevAmount(curAmt) {
    try {
      var log = JSON.parse(localStorage.getItem(amtKey()) || '{}');
      var today = S.quoteDate || ymd(bjNow());
      var keys = Object.keys(log).filter(function (k) { return k < today; }).sort();
      if (keys.length) return num(log[keys[keys.length - 1]]);
    } catch (e) { /* ignore */ }
    return 0;
  }
  function saveAmount() {
    if (!S.mkt || !(S.mkt.amt > 0)) return;
    /* 盘中存的是「折算到全天」的量。若直接存当时的半日成交额，
       次日就会拿这个偏小的数字当基准，量能比率被系统性放大、温度虚高。 */
    var frac = S.mkt.frac == null ? 1 : S.mkt.frac;
    var full = frac >= 0.98 ? S.mkt.amt : (frac > 0.03 ? S.mkt.amt / frac : 0);
    if (!(full > 0)) return;
    try {
      var log = JSON.parse(localStorage.getItem(amtKey()) || '{}');
      var today = S.quoteDate || ymd(bjNow());
      log[today] = full;
      var keys = Object.keys(log).sort();
      if (keys.length > 30) keys.slice(0, keys.length - 30).forEach(function (k) { delete log[k]; });
      localStorage.setItem(amtKey(), JSON.stringify(log));
    } catch (e) { /* ignore */ }
  }

  function buildIndustryStats(rows) {
    var map = {};
    rows.forEach(function (r) {
      if (!(r.price > 0) || !r.amt) return;
      var g = map[r.ind] || (map[r.ind] = { name: r.ind, n: 0, sumPct: 0, net: 0, amt: 0, up: 0, pes: [] });
      g.n++; g.sumPct += r.pct; g.net += r.net; g.amt += r.amt;
      if (r.pct > 0) g.up++;
      /* 行业 PE 中位数：长线档判断「贵不贵」必须有行业参照，
         否则银行 6 倍和软件 60 倍会被放在同一把尺子上 */
      if (r.pe > 0 && r.pe < 500) g.pes.push(r.pe);
    });
    var list = Object.keys(map).map(function (k) {
      var g = map[k];
      g.avgPct = g.n ? g.sumPct / g.n : 0;
      g.pctl = 0.5;
      g.pes.sort(function (a, b) { return a - b; });
      g.peMed = g.pes.length ? g.pes[Math.floor(g.pes.length / 2)] : null;
      delete g.pes;
      return g;
    }).filter(function (g) { return g.n >= 4; });
    list.sort(function (a, b) { return b.avgPct - a.avgPct; });
    var n = list.length;
    list.forEach(function (g, i) { g.rank = i + 1; g.pctl = n > 1 ? i / (n - 1) : 0.5; });
    var out = { list: list, map: {} };
    list.forEach(function (g) { out.map[g.name] = g; });
    return out;
  }

  /* ================= 六维打分 ================= */
  function scoreFund(r) {
    var ratio = r.amt > 0 ? r.net / r.amt * 100 : 0;
    var yi = r.net / 1e8;
    var s;
    if (ratio >= 10) s = 96;
    else if (ratio >= 6) s = 90;
    else if (ratio >= 3) s = 82;
    else if (ratio >= 1) s = 72;
    else if (ratio >= 0) s = 60;
    else if (ratio >= -1) s = 48;
    else if (ratio >= -3) s = 34;
    else s = 18;
    if (yi >= 3) s += 4; else if (yi >= 1) s += 2; else if (yi <= -3) s -= 6;
    /* 拉高出货修正：资金流入但当日已大涨，多半是拉高派发，不是启动吸筹 */
    if (ratio >= 1 && r.pct >= 6) s -= 20;
    else if (ratio >= 1 && r.pct >= 4) s -= 10;
    return { v: clamp(Math.round(s), 0, 100), ratio: ratio, yi: yi };
  }

  function scorePrice(r) {
    var p = r.pct, t = r.turn, vr = r.volRatio;
    /* 涨幅打分改为「面向未来」：温和上涨（0–3%）才是健康的启动态，
       大涨（>5%）意味着当日动能已兑现，次日追高的期望收益为负。
       2026-11-20 前这里给 3–7% 满分 92，是典型的追涨因子，已废止。 */
    var ps;
    if (p >= 0.5 && p <= 3) ps = 92;
    else if (p > 3 && p <= 5) ps = 74;
    else if (p >= 0 && p < 0.5) ps = 80;
    else if (p > 5 && p <= 7) ps = 52;
    else if (p >= -1.5 && p < 0) ps = 62;   // 小幅回调蓄势，不是坏事
    else if (p > 7) ps = 30;                  // 已大涨，明日透支
    else if (p >= -3 && p < -1.5) ps = 42;
    else ps = 25;

    /* 注意分支顺序：先判 t>10 的区间，否则会被 t>=2 全部吃掉（原先 15–25% 的降权是死代码） */
    var ts;
    if (t >= 3 && t <= 10) ts = 92;
    else if (t > 10 && t <= 15) ts = 78;
    else if (t > 15 && t <= 25) ts = 56;
    else if (t > 25) ts = 30;
    else if (t >= 2) ts = 78;
    else if (t >= 1) ts = 60;
    else ts = 40;

    var vs;
    if (vr >= 1.2 && vr <= 3) vs = 92;
    else if (vr > 3 && vr <= 5) vs = 74;
    else if (vr > 1 && vr < 1.2) vs = 68;
    else if (vr > 5 && vr <= 8) vs = 58;
    else if (vr >= 0.7) vs = 52;
    else vs = 38;
    if (vr > 8) vs = 45;

    var pos = r.high > r.low ? (r.price - r.low) / (r.high - r.low) : 0.5;
    var cps = pos >= 0.8 ? 92 : pos >= 0.6 ? 80 : pos >= 0.4 ? 64 : pos >= 0.2 ? 48 : 34;

    return {
      v: clamp(Math.round(0.38 * ps + 0.3 * ts + 0.16 * vs + 0.16 * cps), 0, 100),
      pos: pos, ps: ps, ts: ts, vs: vs
    };
  }

  function scorePosition(r) {
    var d = r.d60, s;
    if (d >= -5 && d <= 20) s = 90;
    else if (d > 20 && d <= 40) s = 78;
    else if (d >= -15 && d < -5) s = 72;
    else if (d > 40 && d <= 70) s = 60;
    else if (d >= -35 && d < -15) s = 55;
    else if (d > 70 && d <= 100) s = 45;
    else if (d > 100) s = 28;
    else s = 35;
    if (r.ytd > 150) s -= 10; else if (r.ytd > 100) s -= 5;
    if (r.ytd < -30 && d > 0) s += 6;
    return clamp(Math.round(s), 0, 100);
  }

  function scoreIndustry(r) {
    var st = S.indStats && S.indStats.map[r.ind];
    if (!st) return { v: 55, avgPct: 0, rank: 0, n: 0 };
    var s = 20 + 75 * (1 - st.pctl);
    if (st.net > 0) s += 4;
    if (st.avgPct < 0) s = Math.min(s, 55);
    if (st.n < 8) s -= 6;
    return { v: clamp(Math.round(s), 0, 100), avgPct: st.avgPct, rank: st.rank, n: (S.indStats.list || []).length };
  }

  function scoreLiquidity(r) {
    var amt = r.amt / 1e8, cap = r.cap / 1e8;
    /* 同上：先判大额区间，避免 amt>=1 把 >30 亿的部分全部吃掉 */
    var as;
    if (amt >= 2 && amt <= 30) as = 92;
    else if (amt > 30 && amt <= 80) as = 78;
    else if (amt > 80) as = 62;
    else if (amt >= 1) as = 78;
    else if (amt >= 0.5) as = 50;
    else as = 25;
    var cs = (cap >= 50 && cap <= 800) ? 92 : (cap > 800 && cap <= 2000) ? 78 : (cap >= 30 && cap < 50) ? 70 : (cap > 2000 && cap <= 5000) ? 60 : cap > 5000 ? 45 : 40;
    return Math.round(0.55 * as + 0.45 * cs);
  }

  function scoreQuality(r) {
    /* 腾讯源没有 ROE / 净利 / PE：缺失不等于很差，给中性分，
       否则整批票都会被当成「亏损 + 低质量」统一扣 24 分 */
    if (!S.fundamentals) return 50;
    var s = 50, roe = r.roe, np = r.npYoY, pe = r.pe;
    if (roe >= 15) s += 22; else if (roe >= 8) s += 12; else if (roe >= 3) s += 4; else if (roe < 0) s -= 18;
    if (np >= 50) s += (np > 300 ? 9 : 16); else if (np >= 15) s += 10; else if (np >= 0) s += 4; else if (np >= -30) s -= 12; else s -= 18;
    if (pe > 0 && pe <= 30) s += 9; else if (pe > 30 && pe <= 60) s += 2; else if (pe > 100) s -= 12; else if (pe <= 0) s -= 28;
    return clamp(Math.round(s), 0, 100);
  }

  /* 估值分：长线档的核心维度。
     绝对 PE + 行业相对 PE + PB + ROE/增速，四个角度合成，
     单看任何一个都会被「行业天然高估值」带偏。 */
  function scoreValue(r) {
    var st = S.indStats && S.indStats.map[r.ind];
    var peMed = st && st.peMed > 0 ? st.peMed : null;
    var s = 50;
    var soft = !S.fundamentals;   // 源里没有财务字段时，缺失不等于很差，不扣分

    if (!(r.pe > 0)) { if (!soft) s -= 30; }
    else if (r.pe <= 12) s += 20;
    else if (r.pe <= 20) s += 14;
    else if (r.pe <= 30) s += 6;
    else if (r.pe <= 50) s -= 5;
    else if (r.pe <= 80) s -= 15;
    else s -= 25;

    if (r.pe > 0 && peMed) {
      var rel = r.pe / peMed;
      if (rel <= 0.7) s += 18;
      else if (rel <= 0.9) s += 12;
      else if (rel <= 1.15) s += 5;
      else if (rel <= 1.5) s -= 6;
      else if (rel <= 2) s -= 15;
      else s -= 23;
    }

    if (r.pb > 0) {
      if (r.pb < 1) s += 10;
      else if (r.pb <= 2) s += 6;
      else if (r.pb <= 5) s += 0;
      else if (r.pb <= 8) s -= 8;
      else s -= 14;
    }

    if (!soft) {
      if (r.roe >= 20) s += 14;
      else if (r.roe >= 15) s += 10;
      else if (r.roe >= 10) s += 5;
      else if (r.roe < 5) s -= 10;

      if (r.npYoY >= 30) s += 10;
      else if (r.npYoY >= 10) s += 6;
      else if (r.npYoY < -20) s -= 12;
    }

    return clamp(Math.round(s), 0, 100);
  }

  /* ================= 前瞻信号 d7（2026-11-20 新增） =================
     为什么需要它：原来的 d1 资金 + d2 量价都是「今天已经发生」的数据，
     短线给到 60% 权重，等于每天买涨幅榜前列——那是追逐已兑现的动量，
     次日往往高开低走。前瞻信号只问一件事：
       「这只票现在是处在启动之前，还是已经涨完了？」
     全市场快照没有逐日 K 线，无法直接算波动收缩（VCP），
     但可以用以下几个当日可得的代理信号合成「启动概率」：

       ① 吸筹潜伏 absorb：主力净流入占比为正、而涨幅温和甚至小跌
          —— 资金在进但价格还没走，是最有价值的吸筹信号（低吸窗口）。
          反之资金流出却大涨（拉高出货）给最低分。
       ② 蓄势 coil：当日振幅小 + 换手温和 + 60 日位置不高
          —— 抛压轻、筹码稳，上涨阻力小；振幅/换手过大说明分歧已起。
       ③ 未透支 headroom：近 60 日涨幅低、年内涨幅不过分、收盘不在当日最高
          —— 上方套牢盘少、想象空间大；已翻倍的票再涨需要更多资金。
       ④ 行业轮动位 rotation：所处行业今日热度中等（不是最热）、但资金在流入
          —— 还没被市场充分挖掘，比「今日涨幅第一的行业」更有延续性。

     四个信号加权，输出 0–100。分数越高 = 越像「启动前夜」而非「上涨末端」。 */
  function scoreForward(r) {
    var ratio = r.amt > 0 ? r.net / r.amt * 100 : 0;   // 主力净额占成交额 %
    var p = r.pct, amp = r.amp, turn = r.turn, d = r.d60, ytd = r.ytd;

    /* ① 吸筹潜伏：资金进 + 价格没走 = 低吸窗口（核心信号，权重最高） */
    var absorb;
    if (ratio >= 3 && p >= -1.5 && p <= 2.5) absorb = 96;
    else if (ratio >= 1.5 && p >= -2 && p <= 3) absorb = 86;
    else if (ratio >= 0.5 && p >= -2 && p <= 3.5) absorb = 72;
    else if (ratio >= 3 && p > 3.5 && p <= 6) absorb = 55;   // 边拉边买，次优
    else if (ratio >= 0 && p > 6) absorb = 38;                // 拉高，警惕派发
    else if (ratio < -1 && p > 3) absorb = 15;                // 资金流出却大涨 = 拉高出货
    else if (ratio >= -1 && ratio < 0 && p <= 1) absorb = 48;
    else absorb = 35;

    /* ② 蓄势：振幅小 + 换手温和 + 位置低。振幅用 pct 兜底（腾讯源可能 amp=0） */
    var a = amp > 0 ? amp : Math.max(Math.abs(p), 1);
    var coil = 50;
    if (a <= 3) coil += 22;
    else if (a <= 5) coil += 12;
    else if (a <= 8) coil += 2;
    else if (a > 12) coil -= 18;
    if (turn >= 1 && turn <= 5) coil += 16;
    else if (turn > 5 && turn <= 8) coil += 6;
    else if (turn > 10) coil -= 12;
    else if (turn < 0.5) coil -= 8;                            // 无人问津也不是蓄势
    if (d >= -15 && d <= 15) coil += 12;
    else if (d > 15 && d <= 35) coil += 2;
    else if (d > 50) coil -= 15;
    coil = clamp(Math.round(coil), 0, 100);

    /* ③ 未透支：60 日 / 年内涨幅越小，上方空间越大；收盘不在最高位更好 */
    var head = 60;
    if (d >= -20 && d <= 10) head += 20;
    else if (d > 10 && d <= 25) head += 10;
    else if (d > 25 && d <= 45) head -= 5;
    else if (d > 45) head -= 22;
    else if (d < -35) head -= 8;                               // 深跌可能有基本面问题
    if (ytd > 120) head -= 18;
    else if (ytd > 60) head -= 8;
    var cp = r.high > r.low ? (r.price - r.low) / (r.high - r.low) : 0.5;
    if (cp >= 0.9) head -= 10;                                 // 收在当日最高，追高价
    head = clamp(Math.round(head), 0, 100);

    /* ④ 行业轮动位：热度中等偏上、但还没到最热，才是「即将轮到」 */
    var st = S.indStats && S.indStats.map[r.ind];
    var rotation = 55;
    if (st) {
      /* pctl 是该行业今日涨幅在全部行业中的分位（0 最弱、1 最热） */
      if (st.pctl >= 0.35 && st.pctl <= 0.7) rotation = 82;    // 温和走强，未过热
      else if (st.pctl > 0.7 && st.pctl <= 0.88) rotation = 68;
      else if (st.pctl > 0.88) rotation = 38;                  // 已是最热板块，拥挤
      else if (st.pctl >= 0.15 && st.pctl < 0.35) rotation = 62;
      else rotation = 42;                                      // 冷门，缺乏催化
      if ((st.net || 0) > 0) rotation += 6;                    // 行业资金在进
    }

    return {
      v: clamp(Math.round(0.40 * absorb + 0.28 * coil + 0.20 * head + 0.12 * rotation), 0, 100),
      absorb: absorb, coil: coil, head: head, rotation: rotation
    };
  }

  function listedDays(r) {
    var s = String(r.listDate || '');
    if (s.length !== 8) return null;
    var d = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
    return (Date.now() - d.getTime()) / 86400000;
  }

  /* 通用硬性排雷：与周期无关，只排「根本不能碰」的 */
  function baseReject(r) {
    if (!(r.price > 0)) return '停牌 / 无成交';
    if (/ST|退/.test(r.name)) return 'ST 或退市风险';
    if (/^[NC]/.test(r.name)) return '新股 / 次新';
    if (!(r.amt > 0)) return '无成交额';
    return null;
  }

  /* 周期专属门槛：这是三档名单真正拉开差距的地方。
     短线要「能进出、有量」，中线要「趋势没过热、基本面无雷」，
     长线要「好公司 + 好价格 + 活得久」。 */
  function horizonReject(r, k) {
    var g = HZ_RULE[k];
    var soft = !S.fundamentals;
    var days = listedDays(r);
    if (g.minList && days !== null && days < g.minList) {
      return g.minList >= 365 ? '上市不足 2 年' : '上市不足 ' + g.minList + ' 日';
    }
    if (r.amt < g.minAmt) return '成交额不足 ' + (g.minAmt / 1e8) + ' 亿';
    if (r.turn > g.maxTurn) return '换手 >' + g.maxTurn + '% 过热';
    if (r.cap < g.minCap) return '市值不足 ' + (g.minCap / 1e8) + ' 亿';
    if (g.minPct != null && r.pct <= g.minPct) return '当日破位（跌超 ' + (-g.minPct) + '%）';
    if (g.maxPct != null && r.pct > g.maxPct) return '当日已涨 >' + g.maxPct + '%（追高透支）';
    if (g.maxD60 != null && r.d60 > g.maxD60) return '60 日涨幅 >' + g.maxD60 + '%（位置过高）';
    if (g.minD60 != null && r.d60 < g.minD60) return '60 日跌幅 >' + (-g.minD60) + '%（趋势未止）';
    /* 腾讯源没有 ROE / 净利 / 上市日期：这几个门槛一旦照常执行，
       中长线档会把全市场杀成 0 只（0 值被当成「极差」）。
       此时只保留量价与规模这类真实可得的硬门槛，财务门槛关闭，
       并在数据源标记里写明「财务门槛已关闭」，不假装有数据。 */
    if (!soft) {
      if (g.minRoe != null && !(r.roe >= g.minRoe)) return 'ROE 低于 ' + g.minRoe + '%';
      if (g.minNp != null && isFinite(r.npYoY) && r.npYoY < g.minNp) return '净利同比 <-' + (-g.minNp) + '%';
      if (g.needProfit) {
        if (!(r.pe > 0)) return '当前亏损';
        if (r.pe > g.maxPe) return 'PE >' + g.maxPe + ' 倍';
      }
    } else if (g.needProfit && r.pe > 0 && r.pe > g.maxPe) {
      /* 有 PE 就顺手排掉明显贵的，没有就放过 */
      return 'PE >' + g.maxPe + ' 倍';
    }
    /* 短线不接已封板的票；中长线可以等回调，不在此剔除 */
    if (k === 'S' && r.pct >= limitOf(r.code) - 0.3 && r.price >= r.high) return '已封涨停，买不进';
    return null;
  }

  function bumpDrop(bag, why) {
    var k = why.replace(/（.*?）/g, '').replace(/，.*$/, '');
    bag[k] = (bag[k] || 0) + 1;
  }

  function dimScores(r) {
    var f = scoreFund(r), p = scorePrice(r), pos = scorePosition(r), ind = scoreIndustry(r);
    var liq = scoreLiquidity(r), q = scoreQuality(r), val = scoreValue(r);
    var fw = scoreForward(r);
    return {
      scores: { d1: f.v, d2: p.v, d3: pos, d4: ind.v, d5: liq, d6: q, d7: fw.v },
      value: val,
      netRatio: f.ratio, closePos: p.pos,
      indAvgPct: ind.avgPct, indRank: ind.rank, indCount: ind.n,
      forward: fw
    };
  }

  /* 合成某档的综合分：六维加权 + 估值固定占比（短 0 / 中 16% / 长 38%） */
  function composite(d, k) {
    var w = S.hzW[k] || HZ[k].w;
    var sum = 0, wSum = 0;
    DIM.forEach(function (x) {
      var ww = w[x.key] || 0;
      sum += d.scores[x.key] * ww;
      wSum += ww;
    });
    var base = wSum ? sum / wSum : 0;
    var vw = HZ[k].vw || 0;
    return Math.round((base * (1 - vw) + d.value * vw) * 10) / 10;
  }

  function topNOf(k) {
    var n = S.hzTopN[k];
    if (n == null) n = HZ[k].topN;
    /* 行情弱时只收缩短线档，中长线不因为一天的情绪被动砍名单 */
    if (k === 'S') {
      var cfg = REGIME[S.regimeKey];
      if (cfg && !S.hzTouched.S) n = Math.min(n, cfg.sTopN);
    }
    return clamp(n, 1, 12);
  }

  function shallow(o) {
    var r = {};
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k];
    return r;
  }

  function compute() {
    if (!S.raw) return;
    var active = S.hz;
    var universe = [], drops = { S: {}, M: {}, L: {} };
    var minScore = S.filters.minScore || 0;

    S.raw.forEach(function (r) {
      var base = baseReject(r);
      if (base) { HZ_ORDER.forEach(function (k) { bumpDrop(drops[k], base); }); return; }

      var d = dimScores(r);
      var hs = {}, okHz = {};
      HZ_ORDER.forEach(function (k) {
        var why = horizonReject(r, k);
        if (why) { okHz[k] = false; hs[k] = null; bumpDrop(drops[k], why); }
        else { okHz[k] = true; hs[k] = composite(d, k); }
      });
      if (!okHz.S && !okHz.M && !okHz.L) return;

      var s = {
        code: r.code, name: r.name, ind: r.ind, price: r.price, pct: r.pct,
        amt: r.amt, turn: r.turn, volRatio: r.volRatio, cap: r.cap, amp: r.amp,
        pe: r.pe, pb: r.pb, roe: r.roe, npYoY: r.npYoY,
        d60: r.d60, ytd: r.ytd, net: r.net, netRatio: d.netRatio,
        high: r.high, low: r.low, open: r.open,
        closePos: d.closePos, indAvgPct: d.indAvgPct, indRank: d.indRank, indCount: d.indCount,
        scores: d.scores, value: d.value, forward: d.forward,
        hs: hs, okHz: okHz,
        total: okHz[active] ? hs[active] : 0
      };
      universe.push(s);
    });

    /* 当前档的候选池（表格用），按当前档得分排序 */
    var pool = universe.filter(function (s) { return s.okHz[active]; });
    pool.sort(function (a, b) { return b.hs[active] - a.hs[active]; });
    pool.forEach(function (s, i) { s.rankAll = i + 1; });
    S.scored = pool;
    S.dropped = drops[active];
    S.allDropped = drops;
    S.universe = universe;

    /* 行情判定 */
    var temp = S.mkt ? S.mkt.temp : 50;
    S.autoKey = regimeOf(temp);
    S.regimeKey = S.mode === 'auto' ? S.autoKey : S.mode;

    /* 三档名单：各自排序、各自截断、各自生成交易计划 */
    HZ_ORDER.forEach(function (k) {
      var list = universe.filter(function (s) { return s.okHz[k]; });
      list.sort(function (a, b) { return b.hs[k] - a.hs[k]; });
      var eligible = minScore > 0 ? list.filter(function (s) { return s.hs[k] >= minScore; }) : list;
      S.hzPicks[k] = eligible.slice(0, topNOf(k)).map(function (base, i) {
        var s = shallow(base);
        s.hzKey = k;
        s.total = base.hs[k];
        s.rank = i + 1;
        s.reasons = buildReasons(s, k);
        s.risks = buildRisks(s, k);
        s.plan = buildPlan(s, k);
        return s;
      });
    });
    S.picks = S.hzPicks[active] || [];
    S.allPicks = [];
    HZ_ORDER.forEach(function (k) { S.allPicks = S.allPicks.concat(S.hzPicks[k]); });

    /* 行情更新后核对模拟持仓的止损/止盈纪律 */
    paperEval();
  }

  function bestHzOf(s) {
    var best = null, bv = -1;
    HZ_ORDER.forEach(function (k) {
      if (s.okHz[k] && s.hs[k] > bv) { bv = s.hs[k]; best = k; }
    });
    return best;
  }

  function posText(s) {
    if (s.d60 > 60) return '位置已偏高，属趋势延续型';
    if (s.d60 > 30) return '趋势已走了一段，属中后段';
    if (s.d60 < -15) return '仍在低位区，属超跌修复型';
    return '处在「启动—中段」区间';
  }

  function peText(s) {
    return s.pe > 0 ? fx(s.pe, 1) + ' 倍' : '亏损';
  }

  function indPeText(s) {
    var st = S.indStats && S.indStats.map[s.ind];
    return (st && st.peMed > 0) ? '，行业中位 ' + fx(st.peMed, 1) + ' 倍' : '';
  }

  /* 入选理由：同一只票在三档里该被什么理由说服，是不一样的。
     短线看资金/量价，中线看趋势/景气，长线看质量/估值。 */
  function buildReasons(s, k) {
    var out = [];
    /* 前瞻信号放在最前：短线/中线选它是因为「还没涨、将要启动」，
       而不是「今天涨得好」。文案直接说明是哪一种前瞻形态。 */
    if (s.forward) {
      var fw = s.forward, shape;
      if (fw.absorb >= 80) shape = '<b>资金低位吸筹</b>（净流入但股价未大涨），处于启动前夜';
      else if (fw.coil >= 75) shape = '<b>蓄势充分</b>（振幅小、换手温和、位置不高），抛压轻';
      else if (fw.head >= 75) shape = '<b>上方空间足</b>（60 日涨幅有限、未透支）';
      else shape = '前瞻分 <b>' + fw.v + '</b>，吸筹 ' + fw.absorb + ' / 蓄势 ' + fw.coil + ' / 空间 ' + fw.head;
      out.push({
        w: k === 'S' ? s.scores.d7 * 1.4 : k === 'M' ? s.scores.d7 * 1.15 : s.scores.d7 * 0.6,
        t: shape
      });
    }
    out.push({
      w: k === 'S' ? s.scores.d1 : k === 'M' ? s.scores.d1 * 0.7 : s.scores.d1 * 0.35,
      t: s.net >= 0
        ? '主力净流入 <b>' + fx(s.net / 1e8, 2) + ' 亿</b>，占成交额 <b>' + fx(s.netRatio, 1) + '%</b>'
        : '主力净流出 ' + fx(-s.net / 1e8, 2) + ' 亿，资金面偏弱'
    });
    out.push({
      w: k === 'S' ? s.scores.d2 : k === 'M' ? s.scores.d2 * 0.55 : 18,
      t: '涨 <b>' + signedPct(s.pct) + '</b>、换手 <b>' + fx(s.turn, 1) + '%</b>、量比 <b>' + fx(s.volRatio, 2) +
        '</b>，收盘站在当日振幅 <b>' + fx(s.closePos * 100, 0) + '%</b> 位置'
    });
    out.push({
      w: k === 'S' ? s.scores.d3 : k === 'M' ? s.scores.d3 * 1.15 : s.scores.d3 * 1.2,
      t: '近 60 日 <b>' + signedPct(s.d60) + '</b>、年内 <b>' + signedPct(s.ytd) + '</b>，' + posText(s)
    });
    if (s.indRank) {
      out.push({
        w: k === 'S' ? s.scores.d4 : s.scores.d4 * 1.1,
        t: '所属行业「' + esc(s.ind) + '」今日均值 <b>' + signedPct(s.indAvgPct) + '</b>，行业排名 <b>' +
          s.indRank + '/' + s.indCount + '</b>'
      });
    }
    /* 财务与估值两个维度：源里没有这些字段时整行不出，
       免得给用户一行全是「—」的「入选理由」 */
    if (S.fundamentals) out.push({
      w: k === 'L' ? s.scores.d6 * 1.25 : s.scores.d6,
      t: 'ROE <b>' + (isFinite(s.roe) ? fx(s.roe, 1) + '%' : '—') + '</b>、净利同比 <b>' +
        (isFinite(s.npYoY) ? signedPct(s.npYoY, 1) : '—') + '</b>、PE(TTM) <b>' + peText(s) + '</b>'
    });
    if (S.fundamentals) out.push({
      w: k === 'L' ? s.value * 1.3 : k === 'M' ? s.value * 0.9 : s.value * 0.5,
      t: '估值 PE <b>' + peText(s) + '</b>、PB <b>' + (s.pb > 0 ? fx(s.pb, 2) : '—') + '</b>' +
        indPeText(s) + '，估值分 <b>' + s.value + '</b>'
    });
    out.push({
      w: k === 'L' ? s.scores.d5 * 1.1 : s.scores.d5 * 0.8,
      t: '成交额 <b>' + fAmt(s.amt) + '</b>、总市值 <b>' + fx(s.cap / 1e8, 0) + ' 亿</b>，流动性够进出'
    });

    return out.sort(function (a, b) { return b.w - a.w; }).slice(0, 4).map(function (x) { return x.t; });
  }

  /* 风险提示也按周期换口径：长线不该因为「当天涨了 7%」被劝退，
     短线也不该因为「PE 60 倍」被判死刑（那是长线的顾虑）。 */
  function buildRisks(s, k) {
    var out = [];
    if (k === 'S') {
      if (s.turn > 15) out.push('换手 ' + fx(s.turn, 1) + '%，短线筹码拥挤');
      if (s.pct >= 7) out.push('当日已涨 ' + signedPct(s.pct) + '，追高溢价风险');
      if (s.d60 > 50) out.push('近 60 日已涨 ' + signedPct(s.d60) + '，位置偏高');
      if (s.pct >= limitOf(s.code) - 1.2) out.push('接近涨停，次日高开需谨慎');
      if (s.net < 0) out.push('主力当日净流出 ' + fx(-s.net / 1e8, 2) + ' 亿');
      if (S.fundamentals) {
        if (s.pe <= 0) out.push('当前亏损，纯资金驱动');
        else if (s.pe > 100) out.push('PE ' + fx(s.pe, 0) + ' 倍，估值透支');
      }
      if (s.cap < 50e8) out.push('市值 ' + fx(s.cap / 1e8, 0) + ' 亿，波动偏大');
      if (s.indAvgPct < 0) out.push('所属行业今日整体走弱');
      if (S.fundamentals && s.roe < 3) out.push('ROE 偏低，基本面支撑弱');
    } else if (k === 'M') {
      if (s.d60 > 40) out.push('近 60 日已涨 ' + signedPct(s.d60) + '，趋势进入后段');
      if (s.turn > 12) out.push('换手 ' + fx(s.turn, 1) + '%，短线筹码偏热');
      if (S.fundamentals) {
        if (s.pe > 80) out.push('PE ' + fx(s.pe, 0) + ' 倍，估值偏高');
      }
      if (s.net < 0) out.push('主力当日净流出 ' + fx(-s.net / 1e8, 2) + ' 亿，需看是否连续');
      if (S.fundamentals && s.roe < 5) out.push('ROE ' + fx(s.roe, 1) + '%，基本面支撑偏弱');
      if (s.indAvgPct < -1) out.push('所属行业今日整体走弱');
      if (s.cap < 60e8) out.push('市值 ' + fx(s.cap / 1e8, 0) + ' 亿，波动偏大');
    } else {
      if (S.fundamentals) {
        if (s.roe < 12) out.push('ROE ' + fx(s.roe, 1) + '%，低于长线优选线（15%）');
        if (s.pe > 40) out.push('PE ' + fx(s.pe, 0) + ' 倍，估值缺乏安全垫');
        if (isFinite(s.npYoY) && s.npYoY < 0) out.push('净利同比 ' + signedPct(s.npYoY, 1) + '，业绩在收缩');
      }
      if (s.d60 > 40) out.push('近 60 日已涨 ' + signedPct(s.d60) + '，建仓位置不便宜');
      if (s.cap < 150e8) out.push('市值 ' + fx(s.cap / 1e8, 0) + ' 亿，长线波动与流动性风险偏高');
      if (s.indAvgPct < -2) out.push('所属行业短期走弱，注意景气拐点');
    }
    /* 财务字段缺失时，这本身就是最该先看到的一条风险，放最前面 */
    if (!S.fundamentals && k !== 'S') out.unshift('数据源未提供财务字段，业绩与估值需自行核对');
    if (!out.length) {
      out.push(k === 'L' ? '未触发硬性风险项，但需按季报持续验证'
        : k === 'M' ? '未触发硬性风险项，但趋势中途可能出现 10% 级别回撤'
          : '未触发硬性风险项，但短线波动仍可能击穿止损');
    }
    return out.slice(0, 3);
  }

  /* 建议持有天数：不是拍一个固定值，而是按波动特征与所处位置推出来 */
  function holdPlan(s, k) {
    var amp = s.amp > 0 ? s.amp : Math.max(Math.abs(s.pct), 1.2);
    var lo, hi, basis;

    if (k === 'S') {
      var daily = clamp(amp * 0.6 + s.turn / 12, 1.0, 8);
      var need = (HZ.S.t1 * 100) / daily;
      lo = clamp(Math.round(need * 0.8), 1, 4);
      hi = clamp(Math.round(need * 1.4) + 1, lo + 1, 5);
      if (s.volRatio >= 2 && s.turn >= 3) { lo = 1; hi = Math.max(2, hi - 1); }
      basis = '日均振幅 ' + fx(amp, 1) + '%、换手 ' + fx(s.turn, 1) + '%，按 +' +
        fx(HZ.S.t1 * 100, 1) + '% 第一目标估需 ' + lo + '–' + hi + ' 个交易日' +
        (s.volRatio >= 2 ? '；量比 ' + fx(s.volRatio, 2) + '，节奏偏快' : '');
    } else if (k === 'M') {
      if (s.d60 > 35) {
        lo = 10; hi = 18;
        basis = '近 60 日已涨 ' + signedPct(s.d60, 1) + '，趋势到中后段，压缩到 2–4 周，见滞涨就减';
      } else if (s.d60 < 5) {
        lo = 20; hi = 32;
        basis = '近 60 日 ' + signedPct(s.d60, 1) + '，仍在启动前段，给 4–6 周等趋势展开';
      } else {
        lo = 14; hi = 24;
        basis = '近 60 日 ' + signedPct(s.d60, 1) + '，处在启动—中段，按 3–5 周持有';
      }
      if (s.pe > 60) {
        lo = Math.max(8, lo - 4);
        hi = Math.max(lo + 4, hi - 6);
        basis += '；PE ' + fx(s.pe, 0) + ' 倍偏高，缩短验证窗口';
      }
    } else {
      if (!S.fundamentals) {
        /* 没有财务数据就只按位置给区间，不编「ROE 0%、PE 0 倍」这种假依据 */
        if (s.d60 > 30) {
          lo = 60; hi = 90;
          basis = '缺财务数据，近 60 日 ' + signedPct(s.d60, 1) + ' 位置不低，先按 3–4 个月试仓';
        } else {
          lo = 90; hi = 150;
          basis = '缺财务数据，仅按位置给 4–7 个月区间，业绩需自行核对';
        }
      } else if (s.roe >= 15 && s.pe > 0 && s.pe <= 25) {
        lo = 120; hi = 180;
        basis = 'ROE ' + fx(s.roe, 1) + '%、PE ' + fx(s.pe, 1) + ' 倍，质优价低，按 6–9 个月拿';
      } else if (s.pe > 40 || s.d60 > 40) {
        lo = 60; hi = 90;
        basis = 'PE ' + peText(s) + '、近 60 日 ' + signedPct(s.d60, 1) + '，先按 3–4 个月验证，不加仓';
      } else {
        lo = 90; hi = 150;
        basis = 'ROE ' + fx(s.roe, 1) + '%、PE ' + fx(s.pe, 1) + ' 倍，按 4–7 个月持有，等季报验证';
      }
    }

    var approx = k === 'S'
      ? '约 ' + lo + '–' + hi + ' 天'
      : k === 'M'
        ? '约 ' + Math.max(2, Math.round(lo / 5)) + '–' + Math.round(hi / 5) + ' 周'
        : '约 ' + Math.round(lo / 21) + '–' + Math.round(hi / 21) + ' 个月';

    return { lo: lo, hi: hi, label: lo + '–' + hi + ' 个交易日', approx: approx, basis: basis };
  }

  function buildPlan(s, k) {
    var hz = HZ[k];
    var price = s.price;
    var hp = holdPlan(s, k);

    /* 已走完一大段的票，目标空间要打折，否则等于假设它还能再翻一倍 */
    var damp = 1 - clamp((Math.max(0, s.d60 - 30)) / 250, 0, 0.25);
    /* 波动大的票止损给宽一点，否则正常震荡就被扫出去 */
    var stopPct = hz.stop * clamp(0.8 + (s.amp || 2) / 25, 0.85, 1.35);

    var band = s.total >= 90 ? 0 : s.total >= 85 ? 1 : s.total >= 80 ? 2 : s.total >= 75 ? 3 : 4;
    var i = (s.rank || 1) - 1;
    var cfg = REGIME[S.regimeKey] || REGIME.neutral;
    var pos = Math.round(hz.posBase[band] * (1 - 0.06 * i) * cfg.posMul);
    pos = Math.max(pos, 3);

    return {
      buyLow: price * (1 - hz.buyLow),
      buyHigh: price * (1 + hz.buyHigh),
      stop: price * (1 - stopPct),
      t1: price * (1 + hz.t1 * damp),
      t2: price * (1 + hz.t2 * damp),
      hold: hp.label,
      holdNote: hp.approx,
      holdBasis: hp.basis,
      hz: k,
      pos: pos
    };
  }

  /* ================= 历史记录 ================= */
  /* 同一标签页换账号不刷新时，S.hist / S.advice / S.ai 里还是上一位会员的东西。
     行情数据（S.raw）是公共的，不用清；个人那几份必须清干净再重新拉。 */
  var pickScope = null;
  function syncScope() {
    var m = window.EB_AUTH && EB_AUTH.me && EB_AUTH.me();
    var u = (m && m.id) ? String(m.id) : 'anon';
    if (u === pickScope) return false;
    pickScope = u;
    S.hist = [];
    S.advice = null;
    S.ai = null;
    return true;
  }

  function loadHist() {
    try { S.hist = JSON.parse(localStorage.getItem(HKEY()) || '[]'); } catch (e) { S.hist = []; }
    if (!Array.isArray(S.hist)) S.hist = [];
    /* 丢掉未来日期的脏记录（早期时区计算错误会写入次日） */
    var today = ymd(bjNow());
    S.hist = S.hist.filter(function (h) { return h && h.date && h.date <= today; });
  }
  function saveHist() {
    if (!S.hist) return;
    try { localStorage.setItem(HKEY(), JSON.stringify(S.hist)); } catch (e) { /* ignore */ }
  }
  /* 用数据库里的每日建议回填本地历史：数据库是账号的真源，
     换设备/清缓存后也能把自己以前的名单和成绩看回来。 */
  function mergeAdviceIntoHist(rows) {
    if (!Array.isArray(rows) || !rows.length) return false;
    var changed = false;
    rows.forEach(function (a) {
      if (!a || !a.date || !a.picks || !a.picks.length) return;
      var day = {
        date: a.date,
        mode: a.regime,
        temp: a.temp,
        picks: a.picks.map(function (p) {
          return { code: p.code, name: p.name, price: p.price, score: p.score, ind: p.ind, hz: p.hz };
        })
      };
      var idx = -1;
      S.hist.forEach(function (h, i) { if (h && h.date === day.date) idx = i; });
      if (idx >= 0) S.hist[idx] = day; else S.hist.push(day);
      changed = true;
    });
    if (!changed) return false;
    S.hist.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    if (S.hist.length > 20) S.hist = S.hist.slice(0, 20);
    saveHist();
    return true;
  }
  function recordHistory() {
    if (!S.allPicks || !S.allPicks.length || !S.quoteDate) return;
    loadHist();
    var day = {
      date: S.quoteDate,
      mode: S.regimeKey,
      temp: S.mkt ? S.mkt.temp : null,
      /* 三档一起存档：同一天短线/中线/长线各自推荐了谁，后面才能分别验证 */
      picks: S.allPicks.map(function (s) {
        return { code: s.code, name: s.name, price: s.price, score: s.total, ind: s.ind, hz: s.hzKey };
      })
    };
    var found = false;
    S.hist = S.hist.map(function (h) {
      if (h.date === day.date) { found = true; return day; }
      return h;
    });
    if (!found) S.hist.push(day);
    S.hist.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    if (S.hist.length > 20) S.hist = S.hist.slice(0, 20);
    saveHist();
    saveAmount();
    pushAdvice();
  }

  /* ================= 每日建议（存数据库，按交易日 upsert） =================
     每次成功抓完行情、算完名单后，把当天的建议落库：
     行情判定 / 温度 / 仓位纪律 + 每只候选的建议买区、止损、目标、建议仓位。
     同一天重复刷新只是覆盖，不会堆多条。 */

  function pushAdvice() {
    if (!S.allPicks || !S.allPicks.length || !S.quoteDate) return;
    var cfg = REGIME[S.regimeKey];
    apiPost('/api/advice/daily', {
      date: S.quoteDate,
      regime: S.regimeKey,
      regime_label: cfg.label,
      temp: S.mkt ? S.mkt.temp : null,
      pos_text: cfg.pos,
      note: cfg.note,
      picks: S.allPicks.map(function (s) {
        return {
          code: s.code, name: s.name, ind: s.ind, price: s.price, score: s.total,
          suggest_low: s.plan.buyLow, suggest_high: s.plan.buyHigh,
          stop: s.plan.stop, t1: s.plan.t1, t2: s.plan.t2,
          hold: s.plan.hold, pos_pct: s.plan.pos, hz: s.hzKey
        };
      })
    }).then(function (res) {
      if (res && res.ok) loadAdvice();
    }).catch(function () { /* 服务不可用时跳过，下次刷新再试 */ });
  }

  function loadAdvice() {
    apiGet('/api/advice/list?limit=8').then(function (res) {
      if (!res || !res.ok) return;
      S.advice = res.advice || [];
      /* 数据库里这个账号的历史建议是最全的，回填本地后历史回看才跟账号走 */
      if (mergeAdviceIntoHist(S.advice)) renderHist();
      renderAdvice();
    }).catch(function () { /* 离线 */ });
  }

  function renderAdvice() {
    var box = el('pk-advice');
    if (!box) return;
    var hint = el('pk-advice-hint');
    var list = S.advice || [];
    if (!list.length) {
      box.innerHTML = '<p class="pk-empty">还没有存档的每日建议。点「刷新全市场数据」生成今日名单后，建议会自动写入本机数据库。</p>';
      if (hint) hint.textContent = '建议随行情生成，按交易日存档';
      return;
    }
    var today = list[0];
    if (hint) hint.textContent = '最近存档 ' + today.date + ' · 共 ' + list.length + ' 个交易日';

    var head =
      '<div class="pk-advice-head">' +
      '<div class="pk-advice-day"><i>建议日期</i><b>' + esc(today.date) + '</b></div>' +
      '<div><i>行情判定</i><b>' + esc(today.regime_label || '—') + '</b></div>' +
      '<div><i>市场温度</i><b>' + (today.temp == null ? '—' : fx(today.temp, 0) + ' / 100') + '</b></div>' +
      '<div><i>仓位纪律</i><b>' + esc(today.pos_text || '—') + '</b></div>' +
      '</div>' +
      (today.note ? '<p class="pk-advice-note">' + esc(today.note) + '</p>' : '');

    var rows = (today.picks || []).map(function (p, i) {
      /* 三档上线前的历史存档都没有 hz 字段：那批建议本来就是 1–2 日短线，按短线显示 */
      var hzKey = HZ[p.hz] ? p.hz : 'S';
      return '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td>' + (hzKey ? '<span class="pk-hzbadge pk-hzbadge-' + hzKey.toLowerCase() + '">' + HZ[hzKey].short + '</span>' : '—') + '</td>' +
        '<td><b>' + esc(p.name) + '</b><span class="pp-sub">' + esc(p.code) + ' · ' + esc(p.ind || '') + '</span></td>' +
        '<td class="num">' + fx(p.price, 2) + '</td>' +
        '<td class="num"><b>' + fx(p.score, 1) + '</b></td>' +
        '<td class="num">' + fx(p.suggest_low, 2) + '–' + fx(p.suggest_high, 2) + '</td>' +
        '<td class="num"><span class="pk-down">' + fx(p.stop, 2) + '</span></td>' +
        '<td class="num"><span class="pk-up">' + fx(p.t1, 2) + ' / ' + fx(p.t2, 2) + '</span></td>' +
        '<td class="num">' + (p.pos_pct == null ? '—' : fx(p.pos_pct, 0) + '%') + '</td>' +
        '<td>' + esc(p.hold || '') + '</td>' +
        '</tr>';
    }).join('');

    var tbl = '<div class="tablewrap"><table class="tbl pp-tbl"><thead><tr>' +
      '<th>#</th><th>周期</th><th>标的</th><th class="num">记录价</th><th class="num">本档分</th>' +
      '<th class="num">建议买入价</th><th class="num">建议止损</th><th class="num">建议止盈</th>' +
      '<th class="num">仓位</th><th>建议持有</th></tr></thead><tbody>' + rows + '</tbody></table></div>';

    var past = '';
    if (list.length > 1) {
      past = '<div class="pp-closed-h">历史建议</div>' + list.slice(1).map(function (a) {
        var names = (a.picks || []).map(function (p) { return esc(p.name); }).join('、');
        return '<div class="pp-closed"><b>' + esc(a.date) + '</b>' +
          '<span class="pp-sub">' + esc(a.regime_label || '') + ' · 温度 ' + (a.temp == null ? '—' : fx(a.temp, 0)) + '</span>' +
          '<span class="pp-sub">' + names + '</span></div>';
      }).join('');
    }

    box.innerHTML = head + tbl + past +
      '<div class="pp-foot">「建议买入价」为生成建议时现价附近的参考区间（-1.5% ~ +0.5%），非承诺成交价；记录写入本机 SQLite 数据库（ebgap.db）。</div>';
  }

  /* ================= 模拟持仓（已抽成独立模块） =================
     实现在 paper.js（06 虚拟持仓）：数据读写、报价同步、止损止盈纪律、
     账户统计与 K 线抽屉都在那边。这里只留选股卡片需要的三个入口：
       · paperOpenOf(code) 卡片判断是否已持仓
       · paperBuy(pick)    点「虚拟买入」开一笔
       · paperEval()       全市场行情到手后把持仓票的最新价推给模块
     两边状态通过 window.EB_PAPER 通信，picker 不再自己存持仓。 */
  function paperOpenOf(code) {
    return (window.EB_PAPER && window.EB_PAPER.findOpen) ? window.EB_PAPER.findOpen(code) : null;
  }

  function paperBuy(s) {
    if (!s || !s.plan || !(s.price > 0)) return;
    if (!window.EB_PAPER || !window.EB_PAPER.buy) return;
    if (paperOpenOf(s.code)) return;
    window.EB_PAPER.buy(s, {
      hz: s.hzKey,
      quoteDate: S.quoteDate || ymd(bjNow()),
      onDone: function () { renderTop(); }
    });
    /* 模块里是同步先落本地再发请求，这里立刻重绘卡片，
       按钮马上变成「已持仓」，不用等服务端返回 */
    renderTop();
  }

  function paperEval() {
    var P = window.EB_PAPER;
    if (!P || !P.pushPrices || !S.raw) return;
    var trades = (P.state && P.state.trades) || [];
    if (!trades.length) return;
    var map = {}, hit = false;
    trades.forEach(function (t) {
      if (t.status !== 'open') return;
      for (var i = 0; i < S.raw.length; i++) {
        if (S.raw[i].code === t.code) {
          if (S.raw[i].price > 0) { map[t.code] = S.raw[i].price; hit = true; }
          break;
        }
      }
    });
    if (hit) P.pushPrices(map);
  }

  /* ================= 渲染 ================= */
  function el(id) { return document.getElementById(id); }

  function renderState() {
    var box = el('pk-state');
    if (!box) return;

    if (S.loading) {
      var pct = S.prog.total ? Math.round(S.prog.done / S.prog.total * 100) : 4;
      box.innerHTML =
        '<div class="pk-loading">' +
        '<div class="pk-load-h"><span class="pk-spin"></span><b>正在拉取全市场行情</b>' +
        '<em>' + S.prog.done + ' / ' + (S.prog.total || '?') + ' 页</em></div>' +
        '<div class="pk-load-bar"><i style="width:' + pct + '%"></i></div>' +
        '<p>逐页读取 5500+ 只 A 股的价格、资金、估值与财务字段，通常 5–10 秒；数据在内存中缓存 3 分钟，期内切换页面不会重复抓取。</p>' +
        '</div>';
      return;
    }

    if (S.error) {
      box.innerHTML =
        '<div class="pk-err"><b>数据抓取失败：' + esc(S.error) + '</b>' +
        marketHintHtml() +
        '<button class="pk-btn" id="pk-retry">重新抓取</button></div>';
      var b = el('pk-retry');
      if (b) b.addEventListener('click', function () { fetchMarket(); });
      return;
    }

    if (!S.mkt) { box.innerHTML = '<div class="pk-loading"><p>等待数据…</p></div>'; return; }

    var cfg = REGIME[S.regimeKey];
    var m = S.mkt;
    var idxHtml = m.idx.map(function (x) {
      return '<div class="pk-idx"><i>' + esc(x.name) + '</i><b>' + fx(x.price, 2) + '</b>' +
        '<em class="' + upCls(x.pct) + '">' + signedPct(x.pct) + '</em></div>';
    }).join('');

    box.innerHTML =
      '<div class="pk-state-top">' +
      '<div class="pk-tempbox">' +
      '<div class="pk-temp-h"><span class="pk-badge pk-b-' + cfg.cls + '">' + cfg.label + '</span>' +
      '<em>' + (S.mode === 'auto' ? '按行情自动判定' : '手动锁定') + '</em></div>' +
      '<div class="pk-temp-num"><b>' + m.temp + '</b><i>市场温度</i></div>' +
      '<div class="pk-tempbar"><div class="pk-tempfill pk-tf-' + cfg.cls + '" style="width:' + m.temp + '%"></div>' +
      '<span class="pk-templine" style="left:42%"></span><span class="pk-templine" style="left:64%"></span></div>' +
      '<div class="pk-temp-scale"><span>0 极弱</span><span>42 均衡</span><span>64 偏强</span><span>100 极强</span></div>' +
      '</div>' +
      '<div class="pk-mkt">' + idxHtml +
      '<div class="pk-idx"><i>上涨 / 下跌</i><b>' + m.up + ' / ' + m.down + '</b><em class="pk-flat">' + m.flat + ' 平</em></div>' +
      '<div class="pk-idx"><i>涨停 / 跌停</i><b>' + m.zt + ' / ' + m.dt + '</b><em class="pk-flat">含 20cm</em></div>' +
      '<div class="pk-idx"><i>两市成交</i><b>' + fAmt(m.amt) + '</b><em class="pk-flat">' + (m.prevAmt ? '前日 ' + fAmt(m.prevAmt) : '无对比') + '</em></div>' +
      '</div></div>' +
      '<div class="pk-state-note"><b>今日策略：' + cfg.label + '</b>（' + cfg.temp + '）—— ' + cfg.note +
      '<span>建议仓位：' + cfg.pos + '　·　三档候选：短 ' + S.hzPicks.S.length + ' / 中 ' + S.hzPicks.M.length +
      ' / 长 ' + S.hzPicks.L.length + ' 只　·　数据时间 ' +
      (S.quoteDate || '') + ' ' + (S.at ? hhmm(S.at) : '') + '　·　全市场 ' + (S.raw ? S.raw.length : 0) +
      ' 只，通过任一档门槛 ' + (S.universe ? S.universe.length : 0) + ' 只</span></div>';
  }

  function prevPickMap() {
    var today = S.quoteDate || '';
    var map = {};
    /* 「连续」要按同档口径算：一只股昨天在短线榜、今天进长线榜，不该算连续 */
    (S.hist || []).forEach(function (h) {
      if (h.date >= today) return;
      (h.picks || []).forEach(function (p) {
        if ((p.hz || 'S') !== S.hz) return;
        if (!map[p.code]) map[p.code] = h.date;
      });
    });
    return map;
  }

  /* 三档总览：一屏看清每档推荐了谁、平均多少分、按什么纪律做 */
  function renderHzGrid() {
    var box = el('pk-hz-grid');
    if (!box) return;
    var warn = S.fundamentals === false
      ? '<div class="pk-hz-warn"><b>数据源降级</b>当前为腾讯源，没有 ROE / PB / 上市日期，' +
        '中线与长线档的财务门槛已自动关闭，名单只按量价与规模筛出，请自行补看基本面。</div>'
      : '';
    box.innerHTML = warn + HZ_ORDER.map(function (k) {
      var hz = HZ[k], list = S.hzPicks[k] || [];
      var avg = list.length ? list.reduce(function (a, b) { return a + b.total; }, 0) / list.length : null;
      var top = list.slice(0, 3).map(function (s, i) {
        return '<li><i>' + (i + 1) + '</i><b>' + esc(s.name) + '</b><em class="mono">' + s.code + '</em>' +
          '<span>' + fx(s.total, 1) + '</span></li>';
      }).join('');
      return '<div class="pk-hz pk-hz-' + k.toLowerCase() + (S.hz === k ? ' on' : '') + '">' +
        '<div class="pk-hz-h"><b>' + hz.label + '档</b><em>' + hz.window + '</em></div>' +
        '<p class="pk-hz-desc">' + hz.desc + '</p>' +
        '<div class="pk-hz-meta"><span>候选 <b>' + list.length + '</b> 只</span>' +
        '<span>均分 <b>' + (avg === null ? '—' : fx(avg, 1)) + '</b></span></div>' +
        '<ul class="pk-hz-list">' + (top || '<li class="pk-hz-none">本档暂无标的通过门槛</li>') + '</ul>' +
        '<div class="pk-hz-foot"><span>' + hz.discipline + '</span>' +
        '<button class="pk-mini" data-hz-go="' + k + '">查看名单 →</button></div>' +
        '</div>';
    }).join('');
    box.querySelectorAll('[data-hz-go]').forEach(function (b) {
      b.addEventListener('click', function () {
        setHorizon(b.dataset.hzGo);
        var t = el('pk-top');
        if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  function renderHzTabs() {
    var box = el('pk-hz-tabs');
    if (!box) return;
    box.innerHTML = HZ_ORDER.map(function (k) {
      var n = (S.hzPicks[k] || []).length;
      return '<button class="pk-hztab pk-hztab-' + k.toLowerCase() + (S.hz === k ? ' on' : '') + '" data-hz="' + k + '">' +
        '<b>' + HZ[k].label + '</b><em>' + HZ[k].shortWin + '</em><span>' + n + ' 只</span></button>';
    }).join('');
    box.querySelectorAll('.pk-hztab').forEach(function (b) {
      b.addEventListener('click', function () { setHorizon(b.dataset.hz); });
    });
  }

  function setHorizon(k) {
    if (!HZ[k] || S.hz === k) return;
    S.hz = k;
    try { localStorage.setItem('ebgap.pick.hz.v1', k); } catch (e) { /* ignore */ }
    /* 换档等于换一套选股逻辑：重算分数、名单、计划，并让 AI 复核按新口径重来 */
    compute();
    render();
    if (window.EB_AI && typeof window.EB_AI.check === 'function') window.EB_AI.check();
  }

  function renderTop() {
    var box = el('pk-top');
    if (!box) return;
    var k = S.hz, hz = HZ[k];
    var picks = S.hzPicks[k] || [];

    var title = el('pk-top-title');
    if (title) title.textContent = '今日候选 · ' + hz.label + ' · 建议持有 ' + hz.window;
    renderHzTabs();

    if (!picks.length) {
      var why = S.loading ? '正在计算…'
        : (S.filters.minScore > 0
          ? '「' + hz.label + '」档没有标的达到你设定的最低综合分 ' + S.filters.minScore + '——可以放宽门槛，或把这当作「这一档今天不适合出手」的信号。'
          : '「' + hz.label + '」档没有标的通过本档硬性门槛——空仓等待也是一种策略，切到其它档看看。');
      box.innerHTML = '<div class="pk-empty">' + why + '</div>';
      return;
    }

    var prevMap = prevPickMap();
    var repeat = 0;
    var heldMap = {};
    var PT = (window.EB_PAPER && window.EB_PAPER.state && window.EB_PAPER.state.trades) || [];
    PT.forEach(function (p) { if (p.status === 'open') heldMap[p.code] = 1; });

    box.innerHTML = picks.map(function (s, i) {
      var again = prevMap[s.code];
      if (again) repeat++;
      var dims = DIM.map(function (d) {
        var v = s.scores[d.key];
        return '<div class="pk-dim" title="' + d.name + '：' + d.desc + '">' +
          '<i>' + d.short + '</i>' +
          '<div class="pk-dim-bar"><b style="width:' + v + '%"></b></div>' +
          '<em>' + v + '</em></div>';
      }).join('');
      return '<div class="pk-card pk-card-' + k.toLowerCase() + '">' +
        '<div class="pk-card-h">' +
        '<span class="pk-rank">' + (i + 1 < 10 ? '0' : '') + (i + 1) + '</span>' +
        '<div class="pk-name"><b>' + esc(s.name) +
        (again ? '<span class="pk-again" title="上次上榜 ' + again + '">连续</span>' : '<span class="pk-new">新进</span>') +
        '</b><em>' + s.code + ' · ' + esc(s.ind) + '</em></div>' +
        '<span class="pk-hz-chip pk-hz-chip-' + k.toLowerCase() + '">' + hz.label + '</span>' +
        '<div class="pk-score"><b>' + fx(s.total, 1) + '</b><i>本档分</i></div>' +
        '</div>' +
        '<div class="pk-quote">' +
        '<b>' + fx(s.price, 2) + '</b><em class="' + upCls(s.pct) + '">' + signedPct(s.pct) + '</em>' +
        '<span class="' + (s.net >= 0 ? 'pk-up' : 'pk-down') + '">主力 ' + (s.net >= 0 ? '+' : '') + fAmt(s.net) + '</span>' +
        '</div>' +
        '<div class="pk-dims">' + dims + '</div>' +
        (S.ai && S.ai.byCode && S.ai.byCode[s.code]
          ? '<div class="pk-ai-line"><span class="ai-verdict ' + verdictCls(S.ai.byCode[s.code].verdict) + '">' +
            esc(S.ai.byCode[s.code].verdict || '可观察') + '</span><b>AI ' + (S.ai.byCode[s.code].ai_score == null ? '—' : S.ai.byCode[s.code].ai_score) +
            '</b><i>' + esc(S.ai.byCode[s.code].reason || '') + '</i></div>'
          : '') +
        '<ul class="pk-why">' + s.reasons.map(function (r) { return '<li>' + r + '</li>'; }).join('') + '</ul>' +
        '<div class="pk-levels">' +
        '<div><i>参考买区</i><b>' + fx(s.plan.buyLow, 2) + '–' + fx(s.plan.buyHigh, 2) + '</b></div>' +
        '<div><i>止损</i><b class="pk-down">' + fx(s.plan.stop, 2) + '</b></div>' +
        '<div><i>目标</i><b class="pk-up">' + fx(s.plan.t1, 2) + ' / ' + fx(s.plan.t2, 2) + '</b></div>' +
        '<div><i>建议持有</i><b>' + s.plan.hold + '</b></div>' +
        '<div><i>建议仓位</i><b>' + s.plan.pos + '%</b></div>' +
        '</div>' +
        '<div class="pk-hold-basis"><i>持有依据</i><span>' + esc(s.plan.holdBasis) + '</span>' +
        '<em>' + esc(s.plan.holdNote) + '</em></div>' +
        '<div class="pk-risk">风险 · ' + s.risks.join('　·　') + '</div>' +
        '<div class="pk-card-foot">' +
        (heldMap[s.code]
          ? '<span class="pp-held" title="可在下方「模拟持仓」中查看与管理">已模拟持仓 ✓</span>'
          : '<button class="pk-btn pk-btn-main pk-buy" data-code="' + s.code + '">虚拟买入</button>') +
        '<button class="pk-btn pk-go" data-code="' + s.code + '">深度分析 →</button>' +
        '<span>行业 ' + (s.indRank ? '#' + s.indRank : '—') + '　量比 ' + fx(s.volRatio, 2) + '　换手 ' + fx(s.turn, 1) + '%</span>' +
        '</div>' +
        '</div>';
    }).join('');

    box.querySelectorAll('.pk-go').forEach(function (b) {
      b.addEventListener('click', function () { gotoStock(b.dataset.code); });
    });
    box.querySelectorAll('.pk-buy').forEach(function (b) {
      b.addEventListener('click', function () {
        var s = null;
        (S.picks || []).forEach(function (x) { if (x.code === b.dataset.code) s = x; });
        paperBuy(s);
      });
    });
    var hint = el('pk-top-hint');
    if (hint) {
      hint.textContent = hz.label + '档 ' + picks.length + ' 只：新进 ' + (picks.length - repeat) + ' 只、延续 ' + repeat +
        ' 只 · 按「' + hz.window + '」口径评分 · 基准 ' + (S.quoteDate || '');
    }
  }

  function gotoStock(code) {
    if (window.EB_STOCK && typeof window.EB_STOCK.run === 'function') {
      if (location.hash !== '#stock') location.hash = '#stock';
      var inp = el('sa-code');
      if (inp) inp.value = code;
      setTimeout(function () { window.EB_STOCK.run(code); }, 60);
    } else {
      location.hash = '#stock';
    }
  }

  function renderTuner() {
    var box = el('pk-tuner');
    if (!box) return;
    var k = S.hz, w = S.hzW[k] || HZ[k].w;
    var sliders = DIM.map(function (d) {
      return '<div class="pk-tune-row">' +
        '<label>' + d.name + '<em>' + d.desc + '</em></label>' +
        '<input type="range" min="0" max="45" step="1" value="' + w[d.key] + '" data-w="' + d.key + '">' +
        '<b data-wv="' + d.key + '">' + w[d.key] + '%</b></div>';
    }).join('');

    var indOpts = ['<option value="all">全部行业</option>'];
    if (S.indStats) {
      S.indStats.list.slice(0, 40).forEach(function (g) {
        indOpts.push('<option value="' + esc(g.name) + '"' + (S.filters.ind === g.name ? ' selected' : '') + '>' +
          esc(g.name) + '（' + signedPct(g.avgPct) + '）</option>');
      });
    }

    box.innerHTML =
      '<div class="pk-tune-modes">' +
      '<span class="pk-tune-lab">权重档位</span>' +
      HZ_ORDER.map(function (h) {
        return '<button class="pk-seg pk-seg-hz' + (S.hz === h ? ' on' : '') + '" data-hz="' + h + '">' +
          HZ[h].label + '</button>';
      }).join('') +
      '<span class="pk-tune-hint">三档各自一套权重，互不影响；估值分（短 0% / 中 16% / 长 38%）固定计入，不占滑块</span>' +
      '</div>' +
      '<div class="pk-tune-modes pk-tune-regime">' +
      '<span class="pk-tune-lab">仓位模式</span>' +
      ['auto', 'offense', 'neutral', 'defense'].map(function (m) {
        var lab = m === 'auto' ? '自动跟随行情' : REGIME[m].label;
        return '<button class="pk-seg' + (S.mode === m ? ' on' : '') + '" data-mode="' + m + '">' + lab + '</button>';
      }).join('') +
      '<span class="pk-tune-hint">只影响仓位系数与短线档候选数量，不再覆盖三档权重</span>' +
      '</div>' +
      '<div class="pk-tune-grid">' + sliders + '</div>' +
      '<div class="pk-tune-foot">' +
      '<label>' + HZ[k].label + '档候选数 <input type="number" id="pk-topn" min="1" max="12" value="' + topNOf(k) + '"></label>' +
      '<label>最低综合分 <input type="number" id="pk-minscore" min="0" max="100" value="' + S.filters.minScore + '"></label>' +
      '<label>行业 <select id="pk-ind">' + indOpts.join('') + '</select></label>' +
      '<label>搜索 <input type="text" id="pk-q" placeholder="代码/名称" value="' + esc(S.filters.q) + '" style="width:96px"></label>' +
      '<label class="pk-chk"><input type="checkbox" id="pk-inflow"' + (S.filters.inflow ? ' checked' : '') + '>只看主力净流入</label>' +
      '<button class="pk-btn" id="pk-reset">恢复默认</button>' +
      '</div>';

    box.querySelectorAll('.pk-seg[data-hz]').forEach(function (b) {
      b.addEventListener('click', function () { setHorizon(b.dataset.hz); });
    });
    box.querySelectorAll('.pk-seg[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        S.mode = b.dataset.mode;
        compute(); render();
      });
    });
    box.querySelectorAll('input[type=range]').forEach(function (r) {
      r.addEventListener('input', function () {
        S.hzW[k][r.dataset.w] = +r.value;
        S.hzTouched[k] = true;
        var lab = box.querySelector('[data-wv="' + r.dataset.w + '"]');
        if (lab) lab.textContent = r.value + '%';
        debounceCompute();
      });
    });
    var topn = el('pk-topn');
    if (topn) topn.addEventListener('change', function () {
      S.hzTopN[k] = clamp(+topn.value || HZ[k].topN, 1, 12);
      S.hzTouched[k] = true;
      compute(); render();
    });
    var ms = el('pk-minscore');
    if (ms) ms.addEventListener('change', function () { S.filters.minScore = clamp(+ms.value || 0, 0, 100); compute(); render(); });
    var ind = el('pk-ind');
    if (ind) ind.addEventListener('change', function () { S.filters.ind = ind.value; renderPool(); });
    var inf = el('pk-inflow');
    if (inf) inf.addEventListener('change', function () { S.filters.inflow = inf.checked; renderPool(); });
    var q = el('pk-q');
    if (q) q.addEventListener('input', function () { S.filters.q = q.value.trim(); renderPool(); });
    var rst = el('pk-reset');
    if (rst) rst.addEventListener('click', function () {
      S.mode = 'auto';
      S.hz = 'S';
      HZ_ORDER.forEach(function (h) {
        S.hzW[h] = {};
        DIM.forEach(function (d) { S.hzW[h][d.key] = HZ[h].w[d.key]; });
        S.hzTopN[h] = HZ[h].topN;
        S.hzTouched[h] = false;
      });
      S.filters = { ind: 'all', minScore: 0, inflow: false, q: S.filters.q };
      compute(); render();
    });
  }

  var computeTimer = null;
  function debounceCompute() {
    clearTimeout(computeTimer);
    computeTimer = setTimeout(function () {
      compute(); renderTop(); renderPool(); renderHzGrid(); renderHzTabs();
      if (window.EB_AI && typeof window.EB_AI.check === 'function') window.EB_AI.check();
    }, 120);
  }

  /* ================= 给 AI 复核层的接口 ================= */
  function payloadForAI(limit) {
    if (!S.scored || !S.scored.length) return null;
    var m = S.mkt || {};
    return {
      quoteDate: S.quoteDate,
      horizon: {
        key: S.hz,
        label: HZ[S.hz].label,
        window: HZ[S.hz].window,
        hold: S.hzPicks[S.hz].length ? S.hzPicks[S.hz][0].plan.hold : HZ[S.hz].window
      },
      mkt: {
        regime: S.regimeKey,
        regime_label: (REGIME[S.regimeKey] || {}).label || '',
        temp: m.temp, up: m.up, down: m.down, zt: m.zt, dt: m.dt, amt: m.amt,
        idx: (m.idx || []).map(function (x) { return { name: x.name, price: x.price, pct: x.pct }; })
      },
      picks: S.scored.slice(0, limit || 20).map(function (s) {
        return {
          code: s.code, name: s.name, ind: s.ind, price: s.price, pct: s.pct,
          total: s.hs[S.hz], value: s.value,
          d1: s.scores.d1, d2: s.scores.d2, d3: s.scores.d3,
          d4: s.scores.d4, d5: s.scores.d5, d6: s.scores.d6, d7: s.scores.d7,
          forward: s.forward ? {
            absorb: s.forward.absorb, coil: s.forward.coil,
            head: s.forward.head, rotation: s.forward.rotation
          } : null,
          net: s.net, netRatio: s.netRatio, turn: s.turn, volRatio: s.volRatio,
          amt: s.amt, cap: s.cap, d60: s.d60, ytd: s.ytd, pe: s.pe, pb: s.pb,
          roe: s.roe, npYoY: s.npYoY, hz: S.hz
        };
      })
    };
  }

  function setAI(ai) {
    S.ai = ai || null;
    renderTop();
  }

  function verdictCls(v) {
    if (!v) return 'ai-v-ob';
    if (String(v).indexOf('重点') >= 0) return 'ai-v-go';
    if (String(v).indexOf('剔除') >= 0) return 'ai-v-no';
    return 'ai-v-ob';
  }

  function poolVal(s, k) {
    if (k === 'rank') return s.rankAll || 999999;
    if (k === 'total') return s.hs[S.hz] || 0;
    if (k === 'value') return s.value;
    if (k === 'hz') { var b = bestHzOf(s); return b ? HZ[b].label : ''; }
    if (/^d[1-6]$/.test(k)) return s.scores[k];
    return s[k];
  }

  /* 只返回排好序的副本：绝不原地重排 S.scored，
     否则用户在表头点一下 PE 排序，发给 AI 的 Top20 就变成了「PE 最低的 20 只」 */
  function poolRows() {
    if (!S.scored) return [];
    var f = S.filters;
    var rows = S.scored.filter(function (s) {
      if (s.hs[S.hz] < f.minScore) return false;
      if (f.ind !== 'all' && s.ind !== f.ind) return false;
      if (f.inflow && s.net <= 0) return false;
      if (f.q && (s.code.indexOf(f.q) < 0 && s.name.indexOf(f.q) < 0)) return false;
      return true;
    });
    var k = S.sort.k, dir = S.sort.dir;
    if (!(k === 'total' && dir === -1)) {
      rows.sort(function (a, b) {
        var x = poolVal(a, k), y = poolVal(b, k);
        if (typeof x === 'string' || typeof y === 'string') {
          return String(x).localeCompare(String(y)) * dir;
        }
        return ((x || 0) - (y || 0)) * dir;
      });
    }
    return rows;
  }

  function renderPool() {
    var tbl = el('tbl-pk-pool');
    if (!tbl) return;
    var rows = poolRows();
    var topCodes = {};
    (S.picks || []).forEach(function (p) { topCodes[p.code] = 1; });
    var hint = el('pk-pool-hint');
    if (hint) {
      hint.textContent = (S.scored ? HZ[S.hz].label + '档 · ' + S.scored.length + ' 只通过本档门槛 · 当前筛选后 ' + rows.length + ' 只'
        : '等待数据') + (S.dropped ? ' · 剔除：' + Object.keys(S.dropped).map(function (k) { return k + ' ' + S.dropped[k]; }).join('、') : '');
    }
    if (!rows.length) {
      tbl.innerHTML = '<tbody><tr><td style="padding:20px;color:#8b929c">「' + HZ[S.hz].label + '」档没有符合条件的标的，试着切档、放宽最低综合分或行业筛选。</td></tr></tbody>';
      return;
    }
    var shown = rows.slice(0, POOL_LIMIT);
    var cols = [
      { k: 'rank', t: '#', num: true },
      { k: 'code', t: '代码' },
      { k: 'name', t: '名称' },
      { k: 'ind', t: '行业' },
      { k: 'price', t: '现价', num: true },
      { k: 'pct', t: '涨跌', num: true },
      { k: 'total', t: HZ[S.hz].label + '分', num: true },
      { k: 'd1', t: '资金', num: true },
      { k: 'd2', t: '量价', num: true },
      { k: 'd3', t: '位置', num: true },
      { k: 'd4', t: '行业', num: true },
      { k: 'd5', t: '流动', num: true },
      { k: 'd6', t: '质量', num: true },
      { k: 'value', t: '估值', num: true },
      { k: 'net', t: '主力净额', num: true },
      { k: 'turn', t: '换手', num: true },
      { k: 'volRatio', t: '量比', num: true },
      { k: 'd60', t: '60日', num: true },
      { k: 'pe', t: 'PE', num: true },
      { k: 'hz', t: '适用' }
    ];
    var head = '<thead><tr>' + cols.map(function (c) {
      var on = S.sort.k === c.k ? ' class="pk-th-on"' : '';
      return '<th data-k="' + c.k + '"' + on + '>' + c.t + (S.sort.k === c.k ? (S.sort.dir < 0 ? ' ↓' : ' ↑') : '') + '</th>';
    }).join('') + '<th>操作</th></tr></thead>';

    var body = shown.map(function (s, i) {
      var v = function (k) {
        if (k === 'd1' || k === 'd2' || k === 'd3' || k === 'd4' || k === 'd5' || k === 'd6') return s.scores[k];
        return s[k];
      };
      var href = bestHzOf(s);
      return '<tr class="' + (topCodes[s.code] ? 'pk-tr-top' : '') + '">' +
        '<td class="num">' + (s.rankAll || (i + 1)) + '</td>' +
        '<td class="mono">' + s.code + '</td>' +
        '<td><b>' + esc(s.name) + '</b></td>' +
        '<td>' + esc(s.ind) + '</td>' +
        '<td class="num">' + fx(s.price, 2) + '</td>' +
        '<td class="num ' + upCls(s.pct) + '">' + signedPct(s.pct) + '</td>' +
        '<td class="num"><b>' + fx(s.hs[S.hz], 1) + '</b></td>' +
        ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map(function (k) {
          return '<td class="num pk-cell">' + s.scores[k] + '<i style="width:' + s.scores[k] + '%"></i></td>';
        }).join('') +
        '<td class="num pk-cell">' + s.value + '<i style="width:' + s.value + '%"></i></td>' +
        '<td class="num ' + (s.net >= 0 ? 'pk-up' : 'pk-down') + '">' + (s.net >= 0 ? '+' : '') + fx(s.net / 1e8, 2) + ' 亿</td>' +
        '<td class="num">' + fx(s.turn, 1) + '%</td>' +
        '<td class="num">' + fx(s.volRatio, 2) + '</td>' +
        '<td class="num ' + upCls(s.d60) + '">' + signedPct(s.d60, 1) + '</td>' +
        '<td class="num">' + (s.pe > 0 ? fx(s.pe, 1) : '亏损') + '</td>' +
        '<td>' + (href ? '<span class="pk-hzbadge pk-hzbadge-' + href.toLowerCase() + '" title="该股在三档里的相对强项">' + HZ[href].short + '</span>' : '—') + '</td>' +
        '<td><button class="pk-mini pk-go" data-code="' + s.code + '">分析</button></td>' +
        '</tr>';
    }).join('');

    tbl.innerHTML = head + '<tbody>' + body + '</tbody>';
    tbl.querySelectorAll('th[data-k]').forEach(function (th) {
      th.addEventListener('click', function () {
        var k = th.dataset.k;
        if (S.sort.k === k) S.sort.dir = -S.sort.dir;
        else { S.sort.k = k; S.sort.dir = k === 'code' || k === 'name' || k === 'ind' ? 1 : -1; }
        renderPool();
      });
    });
    tbl.querySelectorAll('.pk-go').forEach(function (b) {
      b.addEventListener('click', function () { gotoStock(b.dataset.code); });
    });
  }

  function renderHist() {
    var box = el('pk-hist');
    if (!box) return;
    if (!S.hist || !S.hist.length) {
      box.innerHTML = '<p class="pk-hist-empty">还没有历史记录。每天打开本页并成功刷新一次，当天的名单就会存进你账号的数据库，换台电脑登录也能回来核对表现。</p>';
      return;
    }
    var now = {};
    (S.raw || []).forEach(function (r) { now[r.code] = r.price; });

    var hf = S.histHz || 'S';
    var totalPicks = 0, totalRet = 0, wins = 0, counted = 0, dayCount = 0;
    /* 当天名单还没有「后续表现」可比：用当前价算它自己的收益永远≈0，
       会稀释平均收益、把胜率拉向中性。统计只计已过交易日的记录。 */
    var todayQ = S.quoteDate || ymd(bjNow());
    var daysHtml = S.hist.map(function (h) {
      var all = h.picks || [];
      var dayCounts = { S: 0, M: 0, L: 0 };
      all.forEach(function (p) { dayCounts[p.hz || 'S']++; });
      var list = all.filter(function (p) { return hf === 'all' || (p.hz || 'S') === hf; });
      if (!list.length) return '';
      dayCount++;

      var rets = [];
      var isToday = h.date >= todayQ;
      var items = list.map(function (p) {
        totalPicks++;
        var cur = isToday ? null : now[p.code];
        var ret = (cur > 0 && p.price > 0) ? (cur / p.price - 1) * 100 : null;
        if (ret !== null) { rets.push(ret); totalRet += ret; if (ret > 0) wins++; counted++; }
        var pk = p.hz || 'S';
        return '<span class="pk-hchip" data-code="' + p.code + '">' +
          '<i class="pk-hchip-hz pk-hzbadge-' + pk.toLowerCase() + '">' + HZ[pk].short + '</i>' +
          esc(p.name) +
          '<em class="' + (ret === null ? 'pk-flat' : upCls(ret)) + '">' +
          (ret === null ? (isToday ? '当日' : '—') : signedPct(ret)) + '</em></span>';
      }).join('');
      var avg = rets.length ? rets.reduce(function (a, b) { return a + b; }, 0) / rets.length : null;
      var cfg = REGIME[h.mode] || REGIME.neutral;
      return '<div class="pk-hist-day">' +
        '<div class="pk-hist-h"><b>' + h.date + '</b>' +
        '<span class="pk-badge pk-b-' + cfg.cls + '">' + cfg.label + '</span>' +
        '<em>' + (h.temp !== null ? '温度 ' + h.temp + ' · ' : '') +
        '短 ' + dayCounts.S + ' / 中 ' + dayCounts.M + ' / 长 ' + dayCounts.L + '</em>' +
        '<b class="pk-hist-avg ' + (avg === null ? 'pk-flat' : upCls(avg)) + '">' +
        (avg === null ? (isToday ? '当日待验证' : '—') : '均值 ' + signedPct(avg)) + '</b></div>' +
        '<div class="pk-hist-list">' + items + '</div></div>';
    }).join('');

    var filterHtml = '<div class="pk-hist-filter">' +
      '<span>统计口径</span>' +
      ['S', 'M', 'L', 'all'].map(function (k) {
        var lab = k === 'all' ? '全部' : HZ[k].label;
        return '<button class="pk-hist-fbtn' + (hf === k ? ' on' : '') + '" data-hf="' + k + '">' + lab + '</button>';
      }).join('') +
      '<em>' + (hf === 'all' ? '三档混在一起看，只作粗略参考' : HZ[hf].label + '档 · 建议持有 ' + HZ[hf].window) + '</em>' +
      '</div>';

    var avgAll = counted ? totalRet / counted : 0;
    var winRate = counted ? wins / counted * 100 : 0;
    box.innerHTML = filterHtml +
      '<div class="pk-hist-sum">' +
      '<div><i>累计推荐</i><b>' + totalPicks + ' 只</b></div>' +
      '<div><i>已可验证</i><b>' + counted + ' 只</b></div>' +
      '<div><i>至今平均</i><b class="' + (counted ? upCls(avgAll) : 'pk-flat') + '">' + (counted ? signedPct(avgAll) : '—') + '</b></div>' +
      '<div><i>上涨比例</i><b>' + (counted ? fx(winRate, 0) + '%' : '—') + '</b></div>' +
      '<div><i>记录天数</i><b>' + dayCount + ' 天</b></div>' +
      '</div>' +
      '<p class="pk-hist-note">收益 =（最新价 − 当日记录价）/ 当日记录价，按你打开本页时的行情计算，未计手续费与滑点，也不代表实盘可实现。当天名单标「当日」、暂不计入统计。短线档看次日表现就有意义，中长线档需要更长验证期——不要用几天的涨跌去否定一个 3 个月的判断。</p>' +
      (daysHtml || '<p class="pk-empty">该档还没有历史记录，切回其它档看看。</p>');

    box.querySelectorAll('.pk-hist-fbtn').forEach(function (b) {
      b.addEventListener('click', function () { S.histHz = b.dataset.hf; renderHist(); });
    });
    box.querySelectorAll('.pk-hchip').forEach(function (c) {
      c.addEventListener('click', function () { gotoStock(c.dataset.code); });
    });
  }

  /* ================= 入口 ================= */
  function stale() {
    if (!S.raw || !S.at) return true;
    return (Date.now() - S.at.getTime()) > CACHE_MS;
  }

  function render() {
    if (!el('v-pick')) return;
    syncScope();
    loadHist();
    loadAdvice();
    renderState();
    renderHzGrid();
    renderTop();
    renderAdvice();
    renderTuner();
    renderPool();
    renderHist();
  }

  /* 只在「真正进入这一页」时判断要不要抓数据。
     render() 会被拖权重、切模式、筛行业等操作反复调用，绝不能在里触发全市场重抓。 */
  function enter() {
    if (S.loading) return;
    if (!S.raw) {
      if (!S.error && !S.autoTried) { S.autoTried = true; fetchMarket(); }
      return;
    }
    if (stale()) fetchMarket();
  }

  function refresh(force) {
    if (S.loading) return;
    if (force) S.at = null;
    S.autoTried = true;
    fetchMarket();
  }

  /* 刷新按钮 */
  var refreshBtn = document.getElementById('pk-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () {
      refreshBtn.textContent = '正在刷新…';
      refreshBtn.disabled = true;
      refresh(true);
      setTimeout(function () {
        refreshBtn.textContent = '刷新全市场数据';
        refreshBtn.disabled = false;
      }, 1200);
    });
  }

  /* 盘中每 4 分钟自动刷新一次（非交易时段不动） */
  setInterval(function () {
    if (!el('v-pick') || !document.getElementById('v-pick').classList.contains('on')) return;
    if (isTradingTime() && !S.loading && stale()) fetchMarket();
  }, 4 * 60 * 1000);

  window.EB_PICKER = {
    render: render,
    enter: enter,
    refresh: refresh,
    state: S,
    payload: payloadForAI,
    setAI: setAI,
    setHorizon: setHorizon,   /* 供外部切换周期档：'S' | 'M' | 'L' */
    horizons: HZ,
    frac: tradedFraction,   /* 供自测/排查：传入 Date 可查任意时点的累计成交占比 */
    paper: { buy: paperBuy, eval: paperEval, open: paperOpenOf }   /* 模拟持仓已抽到 paper.js，这里只留选股侧入口 */
  };
})();
