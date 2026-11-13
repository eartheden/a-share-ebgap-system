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
  var HKEY = 'ebgap.pick.hist.v3';

  var DIM = [
    { key: 'd1', name: '资金动能', short: '资金', desc: '主力净额及其占成交额比重' },
    { key: 'd2', name: '量价强度', short: '量价', desc: '涨幅、换手、量比、收盘位置' },
    { key: 'd3', name: '位置空间', short: '位置', desc: '近 60 日与年内涨幅所处位置' },
    { key: 'd4', name: '行业动能', short: '行业', desc: '所属行业当日平均涨幅排名' },
    { key: 'd5', name: '流动性', short: '流动', desc: '成交额与总市值的可交易区间' },
    { key: 'd6', name: '质量安全', short: '质量', desc: 'ROE、净利增速、PE 排雷' }
  ];

  var W_BASE = { d1: 28, d2: 22, d3: 16, d4: 14, d5: 10, d6: 10 };
  var REGIME = {
    offense: {
      label: '进攻模式', cls: 'off', temp: '市场普涨、赚钱效应强',
      w: { d1: 26, d2: 26, d3: 14, d4: 16, d5: 8, d6: 10 },
      topN: 6, pos: '总仓位 60%–80%，单只 10%–15%',
      note: '资金与量价权重上调，优先「主力进 + 量能起 + 行业领涨」的进攻型标的；可容忍位置略高。'
    },
    neutral: {
      label: '均衡模式', cls: 'neu', temp: '涨跌互现、结构分化',
      w: { d1: 28, d2: 22, d3: 16, d4: 14, d5: 10, d6: 10 },
      topN: 5, pos: '总仓位 30%–50%，单只 8%–12%',
      note: '标准权重，要求资金与量价同时成立；位置和行业动能作为过滤器，不做单边押注。'
    },
    defense: {
      label: '防守模式', cls: 'def', temp: '下跌家数占优、情绪偏弱',
      w: { d1: 32, d2: 14, d3: 18, d4: 10, d5: 12, d6: 14 },
      topN: 3, pos: '总仓位 10%–20%，单只 ≤8%',
      note: '资金与质量权重上调、量价权重下调，只做逆势有主力承接的少数标的；宁可少选也不硬凑。'
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
    prog: { done: 0, total: 0 },
    weights: null,      // 当前生效权重（可被用户改）
    topN: null,
    filters: { ind: 'all', minScore: 0, inflow: false, q: '' },
    sort: { k: 'total', dir: -1 },
    hist: [],
    paper: [],          // 模拟持仓（虚拟买入，存本机 SQLite）
    advice: null,       // 每日建议存档（来自数据库）
    ai: null,           // AI 复核结果 { byCode, at, model, plan }
    expanded: {},       // 展开的理由卡片
    timer: null
  };

  /* ================= 工具 ================= */
  var seq = 0;
  function jsonp(url, timeout) {
    return new Promise(function (resolve, reject) {
      var name = 'EBPK_' + Date.now() + '_' + (++seq);
      var script = document.createElement('script');
      var done = false;
      function cleanup() {
        if (script.parentNode) script.parentNode.removeChild(script);
        try { delete window[name]; } catch (e) { window[name] = undefined; }
      }
      var timer = setTimeout(function () {
        if (done) return;
        done = true; cleanup(); reject(new Error('接口超时'));
      }, timeout || 12000);
      window[name] = function (data) {
        if (done) return;
        done = true; clearTimeout(timer); cleanup(); resolve(data);
      };
      script.onerror = function () {
        if (done) return;
        done = true; clearTimeout(timer); cleanup(); reject(new Error('接口不可达'));
      };
      script.src = url + '&cb=' + name;
      document.head.appendChild(script);
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
  /* 走本地服务端中转（server.py 默认腾讯财经优先，失败自动切东财；
     东财恢复可达时把 server.py 里 PRIMARY_SOURCE 改成 'eastmoney' 即可切回），
     中转不可用（比如用 python -m http.server 起的站）再退回浏览器直连 JSONP。 */
  var RELAY = true;

  function clistQuery(pn) {
    return 'pn=' + pn + '&pz=' + PAGE + '&po=1&np=1&fltt=2&invt=2' +
      '&fid=f12&fs=' + FS + '&fields=' + FIELDS + '&_=' + Date.now();
  }

  function fetchPage(pn) {
    var q = clistQuery(pn);
    if (RELAY) {
      return fetch('/api/market/list?' + q, { cache: 'no-store' })
        .then(function (r) {
          if (!r.ok) throw new Error('中转 http ' + r.status);
          return r.json();
        })
        .then(function (j) {
          if (!j || !j.data) throw new Error('中转返回为空');
          if (j.data.src) S.src = j.data.src;
          return j;
        })
        .catch(function () {
          RELAY = false;   // 中转不可用，本次及之后都走直连
          return jsonp(API + '/api/qt/clist/get?' + q, 12000);
        });
    }
    return jsonp(API + '/api/qt/clist/get?' + q, 12000);
  }

  function pageUrl(pn) {
    return API + '/api/qt/clist/get?' + clistQuery(pn);
  }

  /* 工具栏右侧的数据源标记：让「用的哪路数据」一眼可见 */
  function renderSrc() {
    var box = document.querySelector('#v-pick .pk-tool-src');
    if (!box) return;
    if (S.src === 'tencent') {
      box.innerHTML = '<i></i>数据源：腾讯财经 · 本地计算（行业维度按板块近似）';
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

    return fetchPage(1).then(function (first) {
      var data = first && first.data;
      if (!data || !data.diff || !data.diff.length) throw new Error('行情接口返回为空');
      var total = data.total || data.diff.length;
      var pages = Math.ceil(total / PAGE);
      S.prog = { done: 1, total: pages };
      renderState();

      var rows = data.diff.slice();
      var rest = [];
      for (var p = 2; p <= pages; p++) rest.push(p);

      return pool(rest, POOL_CONCURRENCY, function (pn) {
        return fetchPage(pn).then(function (j) {
          S.prog.done++;
          if (S.prog.done % 6 === 0) renderState();
          var d = j && j.data && j.data.diff;
          return Array.isArray(d) ? d : [];
        });
      }).then(function (chunks) {
        chunks.forEach(function (c) { rows = rows.concat(c); });
        return rows;
      });
    }).then(function (rows) {
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
    var req = RELAY
      ? fetch('/api/market/index?' + q, { cache: 'no-store' })
          .then(function (r) { if (!r.ok) throw new Error('index http ' + r.status); return r.json(); })
          .catch(function () { return jsonp(API + '/api/qt/ulist.np/get?' + q, 10000); })
      : jsonp(API + '/api/qt/ulist.np/get?' + q, 10000);
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
      var g = map[r.ind] || (map[r.ind] = { name: r.ind, n: 0, sumPct: 0, net: 0, amt: 0, up: 0 });
      g.n++; g.sumPct += r.pct; g.net += r.net; g.amt += r.amt;
      if (r.pct > 0) g.up++;
    });
    var list = Object.keys(map).map(function (k) {
      var g = map[k];
      g.avgPct = g.n ? g.sumPct / g.n : 0;
      g.pctl = 0.5;
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
    return { v: clamp(Math.round(s), 0, 100), ratio: ratio, yi: yi };
  }

  function scorePrice(r) {
    var p = r.pct, t = r.turn, vr = r.volRatio;
    var ps;
    if (p >= 3 && p <= 7) ps = 92;
    else if (p > 7) ps = 74;
    else if (p >= 1.5) ps = 82;
    else if (p >= 0) ps = 66;
    else if (p >= -1.5) ps = 55;
    else if (p >= -3) ps = 40;
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
    var s = 50, roe = r.roe, np = r.npYoY, pe = r.pe;
    if (roe >= 15) s += 22; else if (roe >= 8) s += 12; else if (roe >= 3) s += 4; else if (roe < 0) s -= 18;
    if (np >= 50) s += (np > 300 ? 9 : 16); else if (np >= 15) s += 10; else if (np >= 0) s += 4; else if (np >= -30) s -= 12; else s -= 18;
    if (pe > 0 && pe <= 30) s += 9; else if (pe > 30 && pe <= 60) s += 2; else if (pe > 100) s -= 12; else if (pe <= 0) s -= 28;
    return clamp(Math.round(s), 0, 100);
  }

  /* 硬性排雷：返回剔除原因，null 表示保留 */
  function rejectReason(r) {
    if (!(r.price > 0)) return '停牌 / 无成交';
    if (/ST|退/.test(r.name)) return 'ST 或退市风险';
    if (/^[NC]/.test(r.name)) return '新股 / 次新';
    if (r.listDate) {
      var s = String(r.listDate);
      if (s.length === 8) {
        var d = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
        if ((Date.now() - d.getTime()) / 86400000 < 60) return '上市不足 60 日';
      }
    }
    if (r.amt < 1.5e8) return '成交额不足 1.5 亿';
    if (r.turn > 25) return '换手率过热（>25%）';
    if (r.pct <= -5) return '当日破位（跌超 5%）';
    if (r.pct >= limitOf(r.code) - 0.3 && r.price >= r.high) return '已封涨停，买不进';
    return null;
  }

  function compute() {
    if (!S.raw) return;
    var w = S.weights || W_BASE;
    var wSum = DIM.reduce(function (a, d) { return a + (w[d.key] || 0); }, 0) || 100;
    var all = [], dropped = {};

    S.raw.forEach(function (r) {
      var why = rejectReason(r);
      if (why) {
        var k = why.replace(/（.*?）/g, '').replace(/，.*$/, '');
        dropped[k] = (dropped[k] || 0) + 1;
        return;
      }
      var f = scoreFund(r), p = scorePrice(r), pos = scorePosition(r), ind = scoreIndustry(r);
      var liq = scoreLiquidity(r), q = scoreQuality(r);
      var scores = { d1: f.v, d2: p.v, d3: pos, d4: ind.v, d5: liq, d6: q };
      var total = 0;
      DIM.forEach(function (d) { total += scores[d.key] * (w[d.key] || 0); });
      total = total / wSum;
      var s = {
        code: r.code, name: r.name, ind: r.ind, price: r.price, pct: r.pct,
        amt: r.amt, turn: r.turn, volRatio: r.volRatio, cap: r.cap,
        pe: r.pe, pb: r.pb, roe: r.roe, npYoY: r.npYoY,
        d60: r.d60, ytd: r.ytd, net: r.net, netRatio: f.ratio,
        high: r.high, low: r.low, open: r.open,
        closePos: p.pos, indAvgPct: ind.avgPct, indRank: ind.rank, indCount: ind.n,
        scores: scores, total: Math.round(total * 10) / 10
      };
      s.reasons = buildReasons(s);
      s.risks = buildRisks(s);
      all.push(s);
    });

    all.sort(function (a, b) { return b.total - a.total; });
    /* 记下全市场排名：表格里显示真实名次，而不是排序后的行号 */
    all.forEach(function (s, i) { s.rankAll = i + 1; });
    S.scored = all;
    S.dropped = dropped;

    /* 行情判定 */
    var temp = S.mkt ? S.mkt.temp : 50;
    var autoKey = regimeOf(temp);
    S.autoKey = autoKey;
    S.regimeKey = S.mode === 'auto' ? autoKey : S.mode;
    var cfg = REGIME[S.regimeKey];
    if (!S.weightsTouched) S.weights = cloneW(cfg.w);
    if (!S.topNTouched) S.topN = cfg.topN;
    /* 「最低综合分」是全局门槛：既筛候选池，也筛今日名单 */
    var minScore = S.filters.minScore || 0;
    var pool2 = minScore > 0 ? all.filter(function (s) { return s.total >= minScore; }) : all;
    S.picks = pool2.slice(0, S.topN).map(function (s, i) {
      s.rank = i + 1;
      s.plan = buildPlan(s);
      return s;
    });
    all.forEach(function (s) { if (s.rank === undefined) s.rank = null; });
    /* 行情更新后核对模拟持仓的止损/止盈纪律 */
    paperEval();
  }

  function cloneW(w) {
    return { d1: w.d1, d2: w.d2, d3: w.d3, d4: w.d4, d5: w.d5, d6: w.d6 };
  }

  function buildReasons(s) {
    var out = [];
    var funds = [];
    if (s.net > 0) {
      funds.push({ w: s.scores.d1, t: '主力净流入 <b>' + fx(s.net / 1e8, 2) + ' 亿</b>，占成交额 <b>' + fx(s.netRatio, 1) + '%</b>' });
    } else {
      funds.push({ w: s.scores.d1 - 20, t: '主力净流出 ' + fx(-s.net / 1e8, 2) + ' 亿，资金面偏弱' });
    }
    out.push(funds[0]);

    out.push({
      w: s.scores.d2,
      t: '涨 <b>' + signedPct(s.pct) + '</b>、换手 <b>' + fx(s.turn, 1) + '%</b>、量比 <b>' + fx(s.volRatio, 2) +
        '</b>，收盘站在当日振幅 <b>' + fx(s.closePos * 100, 0) + '%</b> 位置'
    });
    out.push({
      w: s.scores.d3,
      t: '近 60 日 <b>' + signedPct(s.d60) + '</b>、年内 <b>' + signedPct(s.ytd) + '</b>，' +
        (s.d60 > 60 ? '位置已偏高，属趋势延续型' : s.d60 < -15 ? '仍在低位区，属超跌修复型' : '处在「启动—中段」区间')
    });
    if (s.indRank) {
      out.push({
        w: s.scores.d4,
        t: '所属行业「' + esc(s.ind) + '」今日均值 <b>' + signedPct(s.indAvgPct) + '</b>，行业排名 <b>' +
          s.indRank + '/' + s.indCount + '</b>'
      });
    }
    out.push({
      w: s.scores.d6,
      t: 'ROE <b>' + (s.roe ? fx(s.roe, 1) + '%' : '—') + '</b>、净利同比 <b>' + (isFinite(s.npYoY) ? signedPct(s.npYoY, 1) : '—') +
        '</b>、PE(TTM) <b>' + (s.pe > 0 ? fx(s.pe, 1) + ' 倍' : '亏损') + '</b>'
    });
    out.push({
      w: s.scores.d5,
      t: '成交额 <b>' + fAmt(s.amt) + '</b>、总市值 <b>' + fx(s.cap / 1e8, 0) + ' 亿</b>，流动性够进出'
    });

    return out.sort(function (a, b) { return b.w - a.w; }).slice(0, 4).map(function (x) { return x.t; });
  }

  function buildRisks(s) {
    var out = [];
    if (s.turn > 15) out.push('换手 ' + fx(s.turn, 1) + '%，短线筹码拥挤');
    if (s.pct >= 7) out.push('当日已涨 ' + signedPct(s.pct) + '，追高溢价风险');
    if (s.d60 > 50) out.push('近 60 日已涨 ' + signedPct(s.d60) + '，位置偏高');
    if (s.pct >= limitOf(s.code) - 1.2) out.push('接近涨停，次日高开需谨慎');
    if (s.net < 0) out.push('主力当日净流出 ' + fx(-s.net / 1e8, 2) + ' 亿');
    if (s.pe <= 0) out.push('当前亏损，纯资金驱动');
    else if (s.pe > 100) out.push('PE ' + fx(s.pe, 0) + ' 倍，估值透支');
    if (s.cap < 50e8) out.push('市值 ' + fx(s.cap / 1e8, 0) + ' 亿，波动偏大');
    if (s.indAvgPct < 0) out.push('所属行业今日整体走弱');
    if (s.roe < 3) out.push('ROE 偏低，基本面支撑弱');
    if (!out.length) out.push('未触发硬性风险项，但短线波动仍可能击穿止损');
    return out.slice(0, 3);
  }

  function buildPlan(s) {
    var price = s.price;
    var base = s.total >= 90 ? 15 : s.total >= 85 ? 13 : s.total >= 80 ? 11 : s.total >= 75 ? 9 : 7;
    var i = (s.rank || 1) - 1;
    var pos = Math.round(base * (1 - 0.06 * i));
    if (S.regimeKey === 'defense') pos = Math.round(pos * 0.6);
    else if (S.regimeKey === 'neutral') pos = Math.round(pos * 0.85);
    pos = Math.max(pos, 3);
    return {
      buyLow: price * 0.985,
      buyHigh: price * 1.005,
      stop: price * 0.955,
      t1: price * 1.055,
      t2: price * 1.09,
      hold: '1–2 个交易日',
      pos: pos
    };
  }

  /* ================= 历史记录 ================= */
  function loadHist() {
    try { S.hist = JSON.parse(localStorage.getItem(HKEY) || '[]'); } catch (e) { S.hist = []; }
    if (!Array.isArray(S.hist)) S.hist = [];
    /* 丢掉未来日期的脏记录（早期时区计算错误会写入次日） */
    var today = ymd(bjNow());
    S.hist = S.hist.filter(function (h) { return h && h.date && h.date <= today; });
  }
  function recordHistory() {
    if (!S.picks || !S.picks.length || !S.quoteDate) return;
    loadHist();
    var day = {
      date: S.quoteDate,
      mode: S.regimeKey,
      temp: S.mkt ? S.mkt.temp : null,
      picks: S.picks.map(function (s) {
        return { code: s.code, name: s.name, price: s.price, score: s.total, ind: s.ind };
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
    try { localStorage.setItem(HKEY, JSON.stringify(S.hist)); } catch (e) { /* ignore */ }
    saveAmount();
    pushAdvice();
  }

  /* ================= 每日建议（存数据库，按交易日 upsert） =================
     每次成功抓完行情、算完名单后，把当天的建议落库：
     行情判定 / 温度 / 仓位纪律 + 每只候选的建议买区、止损、目标、建议仓位。
     同一天重复刷新只是覆盖，不会堆多条。 */

  function pushAdvice() {
    if (!S.picks || !S.picks.length || !S.quoteDate) return;
    var cfg = REGIME[S.regimeKey];
    apiPost('/api/advice/daily', {
      date: S.quoteDate,
      regime: S.regimeKey,
      regime_label: cfg.label,
      temp: S.mkt ? S.mkt.temp : null,
      pos_text: cfg.pos,
      note: cfg.note,
      picks: S.picks.map(function (s) {
        return {
          code: s.code, name: s.name, ind: s.ind, price: s.price, score: s.total,
          suggest_low: s.plan.buyLow, suggest_high: s.plan.buyHigh,
          stop: s.plan.stop, t1: s.plan.t1, t2: s.plan.t2,
          hold: s.plan.hold, pos_pct: s.plan.pos
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
      return '<tr>' +
        '<td>' + (i + 1) + '</td>' +
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
      '<th>#</th><th>标的</th><th class="num">记录价</th><th class="num">综合分</th>' +
      '<th class="num">建议买入价</th><th class="num">建议止损</th><th class="num">建议止盈</th>' +
      '<th class="num">仓位</th><th>持有</th></tr></thead><tbody>' + rows + '</tbody></table></div>';

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

  /* ================= 模拟持仓（虚拟买入） =================
     每笔按「10 万虚拟本金 × 建议仓位」开仓，按 100 股整数倍成交。
     纪律与卡片计划一致：现价触及止损自动平仓、达到 T1 自动止盈，也可手动平仓。

     存储：优先写入本机 SQLite（server.py 的 /api/paper/*），
     localStorage 只留一份快照做离线兜底；服务不可用时退回纯本地模式。
     首次连接时若库是空的而本地有旧记录，自动把旧记录迁移入库。 */
  var PKEY = 'ebgap.paper.v1';
  var PAPER_CAPITAL = 100000;

  function localPaperSnapshot() {
    try {
      var arr = JSON.parse(localStorage.getItem(PKEY) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function savePaper() {
    try { localStorage.setItem(PKEY, JSON.stringify(S.paper)); } catch (e) { /* ignore */ }
  }

  /* 数据库行（snake_case）→ 页面对象（camelCase） */
  function fromServerTrade(t) {
    return {
      id: t.id, code: t.code, name: t.name, ind: t.ind,
      buyPrice: t.buy_price, buyDate: t.buy_date, buyAt: t.buy_at,
      shares: t.shares, amt: t.amt,
      suggestLow: t.suggest_low, suggestHigh: t.suggest_high,
      stop: t.stop, t1: t.t1, t2: t.t2, hold: t.hold, posPct: t.pos_pct,
      score: t.score, status: t.status, curPrice: t.cur_price,
      closePrice: t.close_price, closeDate: t.close_date, closeAt: t.close_at,
      closeReason: t.close_reason, result: t.result_pct, pnl: t.pnl
    };
  }

  function toServerTrade(p) {
    return {
      code: p.code, name: p.name, ind: p.ind,
      buy_price: p.buyPrice, buy_date: p.buyDate, buy_at: p.buyAt,
      shares: p.shares, amt: p.amt,
      suggest_low: p.suggestLow, suggest_high: p.suggestHigh,
      stop: p.stop, t1: p.t1, t2: p.t2, hold: p.hold, pos_pct: p.posPct,
      score: p.score
    };
  }

  function loadPaper() {
    /* 先用本地快照立即渲染，再向数据库校对 */
    S.paper = localPaperSnapshot();
    apiGet('/api/paper/list').then(function (res) {
      if (!res || !res.ok) return;
      API_OK = true;
      if (!res.trades.length && S.paper.length) {
        migratePaper(S.paper.slice());
        return;
      }
      S.paper = res.trades.map(fromServerTrade);
      savePaper();
      renderPaper();
      renderTop();
    }).catch(function () { API_OK = false; });
  }

  /* 把 localStorage 时代的旧记录逐条迁进数据库（只迁一次） */
  function migratePaper(local) {
    var open = local.filter(function (p) { return p.status === 'open'; });
    var closed = local.filter(function (p) { return p.status === 'closed'; });
    var chain = Promise.resolve();
    open.forEach(function (p) {
      chain = chain.then(function () {
        return apiPost('/api/paper/buy', toServerTrade(p)).catch(function () { return null; });
      });
    });
    closed.forEach(function (p) {
      chain = chain.then(function () {
        return apiPost('/api/paper/buy', toServerTrade(p)).then(function (res) {
          if (!res || !res.ok || res.duplicate || !res.trade) return null;
          return apiPost('/api/paper/close', {
            id: res.trade.id, price: p.closePrice || p.buyPrice,
            reason: p.closeReason || '历史记录迁移',
            close_date: p.closeDate, close_at: p.closeAt
          }).catch(function () { return null; });
        }).catch(function () { return null; });
      });
    });
    chain.then(function () {
      return apiGet('/api/paper/list');
    }).then(function (res) {
      if (res && res.ok) {
        S.paper = res.trades.map(fromServerTrade);
        savePaper();
      }
      renderPaper();
      renderTop();
    });
  }

  function rawPriceOf(code) {
    if (!S.raw) return 0;
    for (var i = 0; i < S.raw.length; i++) {
      if (S.raw[i].code === code) return S.raw[i].price;
    }
    return 0;
  }

  function paperOpenOf(code) {
    for (var i = 0; i < S.paper.length; i++) {
      if (S.paper[i].status === 'open' && S.paper[i].code === code) return S.paper[i];
    }
    return null;
  }

  function paperBuy(s) {
    if (!s || !s.plan || !(s.price > 0)) return;
    if (paperOpenOf(s.code)) return;
    var capital = Math.round(PAPER_CAPITAL * s.plan.pos / 100);
    var shares = Math.floor(capital / s.price / 100) * 100;
    if (shares < 100) shares = 100;   // 高价股至少一手
    var p = {
      id: Date.now(), code: s.code, name: s.name, ind: s.ind,
      buyPrice: s.price, buyDate: S.quoteDate || ymd(bjNow()), buyAt: Date.now(),
      shares: shares, amt: shares * s.price,
      suggestLow: s.plan.buyLow, suggestHigh: s.plan.buyHigh,
      stop: s.plan.stop, t1: s.plan.t1, t2: s.plan.t2, hold: s.plan.hold,
      posPct: s.plan.pos, score: s.total, status: 'open', curPrice: s.price
    };
    if (API_OK !== false) {
      apiPost('/api/paper/buy', toServerTrade(p)).then(function (res) {
        if (res && res.ok && res.trade) {
          API_OK = true;
          if (!res.duplicate) {
            p.id = res.trade.id;
            S.paper.unshift(p);
          }
        } else {
          S.paper.unshift(p);   // 服务端异常也先落本地，不丢用户操作
        }
        savePaper();
        renderPaper();
        renderTop();
      }).catch(function () {
        API_OK = false;
        S.paper.unshift(p);
        savePaper();
        renderPaper();
        renderTop();
      });
    } else {
      S.paper.unshift(p);
      savePaper();
      renderPaper();
      renderTop();
    }
  }

  function finishPaper(p, price, reason) {
    p.status = 'closed';
    p.closePrice = price;
    p.closeDate = S.quoteDate || ymd(bjNow());
    p.closeAt = Date.now();
    p.closeReason = reason;
    p.result = (price / p.buyPrice - 1) * 100;
    p.pnl = (price - p.buyPrice) * p.shares;
  }

  function paperClose(id, reason) {
    var p = null;
    S.paper.forEach(function (x) { if (x.id === id && x.status === 'open') p = x; });
    if (!p) return;
    var cur = rawPriceOf(p.code) || p.curPrice || p.buyPrice;
    if (API_OK !== false) {
      apiPost('/api/paper/close', {
        id: id, price: cur, reason: reason || '手动平仓',
        close_date: S.quoteDate || ymd(bjNow()), close_at: Date.now()
      }).then(function (res) {
        if (res && res.ok && res.trade) {
          API_OK = true;
          var t = fromServerTrade(res.trade);
          var idx = S.paper.findIndex(function (x) { return x.id === id; });
          if (idx >= 0) S.paper[idx] = t;
        } else {
          finishPaper(p, cur, reason || '手动平仓');
        }
        savePaper();
        renderPaper();
        renderTop();
      }).catch(function () {
        API_OK = false;
        finishPaper(p, cur, reason || '手动平仓');
        savePaper();
        renderPaper();
        renderTop();
      });
    } else {
      finishPaper(p, cur, reason || '手动平仓');
      savePaper();
      renderPaper();
      renderTop();
    }
  }

  /* 每次行情更新后核对持仓纪律；数据不是最新的时不动作 */
  function paperEval() {
    if (!S.raw || !S.paper || !S.paper.length) return;
    if (API_OK !== false) {
      var quotes = {};
      var has = false;
      S.paper.forEach(function (p) {
        if (p.status !== 'open') return;
        var cur = rawPriceOf(p.code);
        if (cur > 0) { quotes[p.code] = cur; has = true; }
      });
      if (!has) return;
      apiPost('/api/paper/tick', {
        quotes: quotes, date: S.quoteDate || ymd(bjNow()), at: Date.now()
      }).then(function (res) {
        if (res && res.ok) {
          API_OK = true;
          S.paper = res.trades.map(fromServerTrade);
          savePaper();
          renderPaper();
          renderTop();
        }
      }).catch(function () { API_OK = false; paperEvalLocal(); });
    } else {
      paperEvalLocal();
    }
  }

  /* 离线模式：本地判定止损/止盈（旧逻辑） */
  function paperEvalLocal() {
    if (!S.raw || !S.paper || !S.paper.length) return;
    var changed = false;
    S.paper.forEach(function (p) {
      if (p.status !== 'open') return;
      var cur = rawPriceOf(p.code);
      if (!(cur > 0)) return;
      p.curPrice = cur;
      if (cur <= p.stop) { finishPaper(p, cur, '触发止损'); changed = true; }
      else if (cur >= p.t1) { finishPaper(p, cur, '达到目标 T1'); changed = true; }
    });
    if (changed) savePaper();
  }

  function ppMoney(v) {
    var n = Math.round(v);
    var s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (n < 0 ? '-¥' : '¥') + s;
  }

  function renderPaper() {
    var box = el('pk-paper');
    if (!box) return;
    var open = S.paper.filter(function (p) { return p.status === 'open'; });
    var closed = S.paper.filter(function (p) { return p.status === 'closed'; });

    var floatPnl = 0, openCnt = 0;
    open.forEach(function (p) {
      var cur = rawPriceOf(p.code) || p.curPrice || p.buyPrice;
      p.curPrice = cur;
      floatPnl += (cur - p.buyPrice) * p.shares;
      openCnt++;
    });
    var wins = closed.filter(function (p) { return p.result > 0; }).length;
    var avg = closed.length ? closed.reduce(function (a, p) { return a + p.result; }, 0) / closed.length : 0;
    var totPnl = closed.reduce(function (a, p) { return a + (p.pnl || 0); }, 0);

    var hint = el('pk-paper-hint');
    if (hint) {
      var storeNote = API_OK === false ? ' · 数据库未连接，暂存浏览器' : ' · 已存本机数据库';
      hint.textContent = openCnt
        ? '持仓 ' + openCnt + ' 笔 · 浮动 ' + ppMoney(floatPnl) + '（按最新行情）· 触止损自动平仓' + storeNote
        : '点候选卡片上的「虚拟买入」按建议计划开一笔模拟仓，止损/达标自动平仓' + storeNote;
    }

    if (!S.paper.length) {
      box.innerHTML = '<p class="pk-empty">还没有模拟持仓。在上方候选卡片区点「<b>虚拟买入</b>」，系统会按 10 万虚拟本金 × 建议仓位开一笔模拟仓，并按卡片上的止损/目标价自动执行纪律。所有记录写入本机 SQLite 数据库（ebgap.db），换浏览器也不丢。</p>';
      return;
    }

    var sumHtml =
      '<div class="pk-hist-sum">' +
      '<div><i>持仓中</i><b>' + openCnt + ' 笔</b></div>' +
      '<div><i>浮动盈亏</i><b class="' + (openCnt ? upCls(floatPnl) : 'pk-flat') + '">' + (openCnt ? ppMoney(floatPnl) : '—') + '</b></div>' +
      '<div><i>已平仓</i><b>' + closed.length + ' 笔</b></div>' +
      '<div><i>胜率</i><b>' + (closed.length ? fx(wins / closed.length * 100, 0) + '%' : '—') + '</b></div>' +
      '<div><i>平均收益</i><b class="' + (closed.length ? upCls(avg) : 'pk-flat') + '">' + (closed.length ? signedPct(avg) : '—') + '</b></div>' +
      '<div><i>累计盈亏</i><b class="' + (closed.length ? upCls(totPnl) : 'pk-flat') + '">' + (closed.length ? ppMoney(totPnl) : '—') + '</b></div>' +
      '</div>';

    var openHtml = '';
    if (open.length) {
      openHtml = '<div class="tablewrap"><table class="tbl pp-tbl"><thead><tr>' +
        '<th>标的</th><th>买入</th><th class="num">现价</th><th class="num">盈亏</th>' +
        '<th class="num">建议买区</th><th class="num">止损 / 目标</th><th>计划</th><th></th></tr></thead><tbody>' +
        open.map(function (p) {
          var ret = (p.curPrice / p.buyPrice - 1) * 100;
          var pnl = (p.curPrice - p.buyPrice) * p.shares;
          var near = p.curPrice <= p.stop * 1.02;
          var suggest = (p.suggestLow > 0 && p.suggestHigh > 0)
            ? fx(p.suggestLow, 2) + '–' + fx(p.suggestHigh, 2)
            : '—';
          return '<tr>' +
            '<td><b>' + esc(p.name) + '</b><span class="pp-sub">' + p.code + '</span></td>' +
            '<td>' + fx(p.buyPrice, 2) + '<span class="pp-sub">' + p.buyDate + '</span></td>' +
            '<td class="num">' + fx(p.curPrice, 2) + '</td>' +
            '<td class="num"><b class="' + upCls(ret) + '">' + signedPct(ret) + '</b><span class="pp-sub">' + ppMoney(pnl) + '</span></td>' +
            '<td class="num">' + suggest + '</td>' +
            '<td class="num">' + fx(p.stop, 2) + ' <span class="pk-down">/</span> ' + fx(p.t1, 2) + '</td>' +
            '<td>' + (near ? '<span class="pp-warn">接近止损</span> · ' : '') + esc(p.hold || '') + '</td>' +
            '<td><button class="pk-mini pp-sell" data-id="' + p.id + '">卖出</button></td>' +
            '</tr>';
        }).join('') + '</tbody></table></div>';
    }

    var closedHtml = '';
    if (closed.length) {
      closedHtml = '<div class="pp-closed-h">已平仓</div>' + closed.map(function (p) {
        var cls = p.closeReason === '触发止损' ? 'pp-r-stop' : (p.closeReason.indexOf('目标') >= 0 ? 'pp-r-win' : 'pp-r-man');
        return '<div class="pp-closed">' +
          '<b>' + esc(p.name) + '</b>' +
          '<span class="pp-sub">' + p.buyDate + ' → ' + p.closeDate + '</span>' +
          '<span class="pp-reason ' + cls + '">' + esc(p.closeReason) + '</span>' +
          '<b class="' + upCls(p.result) + '">' + signedPct(p.result) + '</b>' +
          '<span class="pp-sub">' + ppMoney(p.pnl || 0) + '</span>' +
          '</div>';
      }).join('');
    }

    box.innerHTML = sumHtml + openHtml + closedHtml +
      '<div class="pp-foot">每笔虚拟本金 = 10 万 × 建议仓位，按 100 股整数倍成交；未计手续费与滑点。' +
      '记录写入本机 SQLite 数据库（ebgap.db）。' +
      '<button class="pk-mini" id="pk-paper-clear">清空记录</button></div>';

    box.querySelectorAll('.pp-sell').forEach(function (b) {
      b.addEventListener('click', function () { paperClose(+b.dataset.id, '手动平仓'); });
    });
    var clr = box.querySelector('#pk-paper-clear');
    if (clr) clr.addEventListener('click', function () {
      if (!confirm('确定清空全部模拟持仓与历史记录？数据库中的记录会一并删除，此操作不可恢复。')) return;
      S.paper = [];
      savePaper();
      renderPaper();
      renderTop();
      if (API_OK !== false) {
        apiPost('/api/paper/clear', {}).catch(function () { /* 下次加载会再校对 */ });
      }
    });
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
        '<p>行情经本地服务中转（server.py）获取：默认腾讯财经，失败自动切东方财富。请确认服务是用<b>启动.command</b>或 <code>python3 server.py</code> 起的（纯静态 http.server 没有中转能力），并确认网络能访问 qq.com / eastmoney。之前抓到的缓存不受影响。</p>' +
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
      '<span>建议仓位：' + cfg.pos + '　·　今日候选 ' + S.topN + ' 只　·　数据时间 ' +
      (S.quoteDate || '') + ' ' + (S.at ? hhmm(S.at) : '') + '　·　全市场 ' + (S.raw ? S.raw.length : 0) + ' 只，过滤后进入评分 ' +
      (S.scored ? S.scored.length : 0) + ' 只</span></div>';
  }

  function prevPickMap() {
    var today = S.quoteDate || '';
    var map = {};
    (S.hist || []).forEach(function (h) {
      if (h.date >= today) return;
      h.picks.forEach(function (p) { if (!map[p.code]) map[p.code] = h.date; });
    });
    return map;
  }

  function renderTop() {
    var box = el('pk-top');
    if (!box) return;
    if (!S.picks || !S.picks.length) {
      var why = S.loading ? '正在计算…' : (S.filters.minScore > 0 && S.scored && S.scored.length
        ? '当前没有标的达到你设定的最低综合分 ' + S.filters.minScore + '——可以放宽门槛，或把这当作「今天不适合做短线」的信号。'
        : '当前没有标的通过全部硬性过滤条件——这本身是「今天不适合做短线」的信号，空仓等待也是一种策略。');
      box.innerHTML = '<div class="pk-empty">' + why + '</div>';
      return;
    }
    var cfg = REGIME[S.regimeKey];
    var prevMap = prevPickMap();
    var repeat = 0;
    var heldMap = {};
    (S.paper || []).forEach(function (p) { if (p.status === 'open') heldMap[p.code] = 1; });
    box.innerHTML = S.picks.map(function (s, i) {
      var again = prevMap[s.code];
      if (again) repeat++;
      var dims = DIM.map(function (d) {
        var v = s.scores[d.key];
        return '<div class="pk-dim" title="' + d.name + '：' + d.desc + '">' +
          '<i>' + d.short + '</i>' +
          '<div class="pk-dim-bar"><b style="width:' + v + '%"></b></div>' +
          '<em>' + v + '</em></div>';
      }).join('');
      return '<div class="pk-card">' +
        '<div class="pk-card-h">' +
        '<span class="pk-rank">' + (i + 1 < 10 ? '0' : '') + (i + 1) + '</span>' +
        '<div class="pk-name"><b>' + esc(s.name) +
        (again ? '<span class="pk-again" title="上次上榜 ' + again + '">连续</span>' : '<span class="pk-new">新进</span>') +
        '</b><em>' + s.code + ' · ' + esc(s.ind) + '</em></div>' +
        '<div class="pk-score"><b>' + fx(s.total, 1) + '</b><i>综合分</i></div>' +
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
        '<div><i>持有</i><b>' + s.plan.hold + '</b></div>' +
        '<div><i>建议仓位</i><b>' + s.plan.pos + '%</b></div>' +
        '</div>' +
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
      hint.textContent = '今日 ' + S.picks.length + ' 只：新进 ' + (S.picks.length - repeat) + ' 只、延续 ' + repeat +
        ' 只 · 评分基准 ' + (S.quoteDate || '');
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
    var w = S.weights || W_BASE;
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
      ['auto', 'offense', 'neutral', 'defense'].map(function (k) {
        var lab = k === 'auto' ? '自动跟随行情' : REGIME[k].label;
        return '<button class="pk-seg' + (S.mode === k ? ' on' : '') + '" data-mode="' + k + '">' + lab + '</button>';
      }).join('') +
      '<span class="pk-tune-hint">切换模式会同时改变权重、候选数量与仓位纪律；手动改动权重后按你的参数计算</span>' +
      '</div>' +
      '<div class="pk-tune-grid">' + sliders + '</div>' +
      '<div class="pk-tune-foot">' +
      '<label>候选数量 <input type="number" id="pk-topn" min="1" max="12" value="' + S.topN + '"></label>' +
      '<label>最低综合分 <input type="number" id="pk-minscore" min="0" max="100" value="' + S.filters.minScore + '"></label>' +
      '<label>行业 <select id="pk-ind">' + indOpts.join('') + '</select></label>' +
      '<label>搜索 <input type="text" id="pk-q" placeholder="代码/名称" value="' + esc(S.filters.q) + '" style="width:96px"></label>' +
      '<label class="pk-chk"><input type="checkbox" id="pk-inflow"' + (S.filters.inflow ? ' checked' : '') + '>只看主力净流入</label>' +
      '<button class="pk-btn" id="pk-reset">恢复默认</button>' +
      '</div>';

    box.querySelectorAll('.pk-seg').forEach(function (b) {
      b.addEventListener('click', function () {
        S.mode = b.dataset.mode;
        S.weightsTouched = false;
        S.topNTouched = false;
        compute(); render();
      });
    });
    box.querySelectorAll('input[type=range]').forEach(function (r) {
      r.addEventListener('input', function () {
        S.weights[r.dataset.w] = +r.value;
        S.weightsTouched = true;
        var lab = box.querySelector('[data-wv="' + r.dataset.w + '"]');
        if (lab) lab.textContent = r.value + '%';
        debounceCompute();
      });
    });
    var topn = el('pk-topn');
    if (topn) topn.addEventListener('change', function () { S.topN = clamp(+topn.value || 5, 1, 12); S.topNTouched = true; compute(); render(); });
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
      S.mode = 'auto'; S.weightsTouched = false; S.topNTouched = false;
      S.filters = { ind: 'all', minScore: 0, inflow: false, q: S.filters.q };
      S.weights = null; S.topN = null;
      compute(); render();
    });
  }

  var computeTimer = null;
  function debounceCompute() {
    clearTimeout(computeTimer);
    computeTimer = setTimeout(function () {
      compute(); renderTop(); renderPaper(); renderPool();
      if (window.EB_AI && typeof window.EB_AI.check === 'function') window.EB_AI.check();
    }, 120);
  }

  /* ================= 给 AI 复核层的接口 ================= */
  function payloadForAI(limit) {
    if (!S.scored || !S.scored.length) return null;
    var m = S.mkt || {};
    return {
      quoteDate: S.quoteDate,
      mkt: {
        regime: S.regimeKey,
        regime_label: (REGIME[S.regimeKey] || {}).label || '',
        temp: m.temp, up: m.up, down: m.down, zt: m.zt, dt: m.dt, amt: m.amt,
        idx: (m.idx || []).map(function (x) { return { name: x.name, price: x.price, pct: x.pct }; })
      },
      picks: S.scored.slice(0, limit || 20).map(function (s) {
        return {
          code: s.code, name: s.name, ind: s.ind, price: s.price, pct: s.pct,
          total: s.total, d1: s.scores.d1, d2: s.scores.d2, d3: s.scores.d3,
          d4: s.scores.d4, d5: s.scores.d5, d6: s.scores.d6,
          net: s.net, netRatio: s.netRatio, turn: s.turn, volRatio: s.volRatio,
          amt: s.amt, cap: s.cap, d60: s.d60, ytd: s.ytd, pe: s.pe, roe: s.roe, npYoY: s.npYoY
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
    if (/^d[1-6]$/.test(k)) return s.scores[k];
    return s[k];
  }

  /* 只返回排好序的副本：绝不原地重排 S.scored，
     否则用户在表头点一下 PE 排序，发给 AI 的 Top20 就变成了「PE 最低的 20 只」 */
  function poolRows() {
    if (!S.scored) return [];
    var f = S.filters;
    var rows = S.scored.filter(function (s) {
      if (s.total < f.minScore) return false;
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
      hint.textContent = (S.scored ? S.scored.length + ' 只通过硬性过滤 · 当前筛选后 ' + rows.length + ' 只'
        : '等待数据') + (S.dropped ? ' · 剔除：' + Object.keys(S.dropped).map(function (k) { return k + ' ' + S.dropped[k]; }).join('、') : '');
    }
    if (!rows.length) {
      tbl.innerHTML = '<tbody><tr><td style="padding:20px;color:#8b929c">没有符合条件的标的，试着放宽最低综合分或行业筛选。</td></tr></tbody>';
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
      { k: 'total', t: '综合', num: true },
      { k: 'd1', t: '资金', num: true },
      { k: 'd2', t: '量价', num: true },
      { k: 'd3', t: '位置', num: true },
      { k: 'd4', t: '行业', num: true },
      { k: 'd5', t: '流动', num: true },
      { k: 'd6', t: '质量', num: true },
      { k: 'net', t: '主力净额', num: true },
      { k: 'turn', t: '换手', num: true },
      { k: 'volRatio', t: '量比', num: true },
      { k: 'd60', t: '60日', num: true },
      { k: 'pe', t: 'PE', num: true }
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
      return '<tr class="' + (topCodes[s.code] ? 'pk-tr-top' : '') + '">' +
        '<td class="num">' + (s.rankAll || (i + 1)) + '</td>' +
        '<td class="mono">' + s.code + '</td>' +
        '<td><b>' + esc(s.name) + '</b></td>' +
        '<td>' + esc(s.ind) + '</td>' +
        '<td class="num">' + fx(s.price, 2) + '</td>' +
        '<td class="num ' + upCls(s.pct) + '">' + signedPct(s.pct) + '</td>' +
        '<td class="num"><b>' + fx(s.total, 1) + '</b></td>' +
        ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map(function (k) {
          return '<td class="num pk-cell">' + s.scores[k] + '<i style="width:' + s.scores[k] + '%"></i></td>';
        }).join('') +
        '<td class="num ' + (s.net >= 0 ? 'pk-up' : 'pk-down') + '">' + (s.net >= 0 ? '+' : '') + fx(s.net / 1e8, 2) + ' 亿</td>' +
        '<td class="num">' + fx(s.turn, 1) + '%</td>' +
        '<td class="num">' + fx(s.volRatio, 2) + '</td>' +
        '<td class="num ' + upCls(s.d60) + '">' + signedPct(s.d60, 1) + '</td>' +
        '<td class="num">' + (s.pe > 0 ? fx(s.pe, 1) : '亏损') + '</td>' +
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
      box.innerHTML = '<p class="pk-hist-empty">还没有历史记录。每天打开本页并成功刷新一次，当天的推荐名单就会存到本机（localStorage），下次可以回来核对表现。</p>';
      return;
    }
    var now = {};
    (S.raw || []).forEach(function (r) { now[r.code] = r.price; });

    var totalPicks = 0, totalRet = 0, wins = 0, counted = 0;
    /* 当天名单还没有「后续表现」可比：用当前价算它自己的收益永远≈0，
       会稀释平均收益、把胜率拉向中性。统计只计已过交易日的记录。 */
    var todayQ = S.quoteDate || ymd(bjNow());
    var daysHtml = S.hist.map(function (h) {
      var rets = [];
      var isToday = h.date >= todayQ;
      var items = h.picks.map(function (p) {
        totalPicks++;
        var cur = isToday ? null : now[p.code];
        var ret = (cur > 0 && p.price > 0) ? (cur / p.price - 1) * 100 : null;
        if (ret !== null) { rets.push(ret); totalRet += ret; if (ret > 0) wins++; counted++; }
        return '<span class="pk-hchip" data-code="' + p.code + '">' + esc(p.name) +
          '<em class="' + (ret === null ? 'pk-flat' : upCls(ret)) + '">' +
          (ret === null ? (isToday ? '当日' : '—') : signedPct(ret)) + '</em></span>';
      }).join('');
      var avg = rets.length ? rets.reduce(function (a, b) { return a + b; }, 0) / rets.length : null;
      var cfg = REGIME[h.mode] || REGIME.neutral;
      return '<div class="pk-hist-day">' +
        '<div class="pk-hist-h"><b>' + h.date + '</b>' +
        '<span class="pk-badge pk-b-' + cfg.cls + '">' + cfg.label + '</span>' +
        '<em>' + (h.temp !== null ? '温度 ' + h.temp : '') + ' · ' + h.picks.length + ' 只</em>' +
        '<b class="pk-hist-avg ' + (avg === null ? 'pk-flat' : upCls(avg)) + '">' +
        (avg === null ? (isToday ? '当日待验证' : '—') : '均值 ' + signedPct(avg)) + '</b></div>' +
        '<div class="pk-hist-list">' + items + '</div></div>';
    }).join('');

    var avgAll = counted ? totalRet / counted : 0;
    var winRate = counted ? wins / counted * 100 : 0;
    box.innerHTML =
      '<div class="pk-hist-sum">' +
      '<div><i>累计推荐</i><b>' + totalPicks + ' 只</b></div>' +
      '<div><i>已可验证</i><b>' + counted + ' 只</b></div>' +
      '<div><i>至今平均</i><b class="' + (counted ? upCls(avgAll) : 'pk-flat') + '">' + (counted ? signedPct(avgAll) : '—') + '</b></div>' +
      '<div><i>上涨比例</i><b>' + (counted ? fx(winRate, 0) + '%' : '—') + '</b></div>' +
      '<div><i>记录天数</i><b>' + S.hist.length + ' 天</b></div>' +
      '</div>' +
      '<p class="pk-hist-note">收益 =（最新价 − 当日记录价）/ 当日记录价，按你打开本页时的行情计算，未计手续费与滑点，也不代表实盘可实现。当天名单标「当日」、暂不计入统计，要等下一个交易日才有可比表现。记录只存在本机浏览器。</p>' +
      daysHtml;

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
    if (!S.weights) S.weights = W_BASE;
    if (!S.topN) S.topN = 5;
    loadHist();
    loadPaper();
    loadAdvice();
    renderState();
    renderTop();
    renderPaper();
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
    frac: tradedFraction,   /* 供自测/排查：传入 Date 可查任意时点的累计成交占比 */
    paper: { buy: paperBuy, close: paperClose, eval: paperEval }   /* 模拟持仓接口，也可供外部调试 */
  };
})();
