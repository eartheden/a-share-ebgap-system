/* ============================================================
   08 · 涨停热点数据地图  Limit-Up Sector Atlas  [实时版]
   ------------------------------------------------------------------
   数据来源：本地服务 /api/market/limitup（腾讯财经全市场实时快照）
   每次进入页面 / 手动刷新 / 盘中定时轮询都会重新聚合，前端不内置任何
   写死的行情数字。

   口径说明（诚实标注，不编造）：
     · 涨停/跌停 —— 按板块阈值判定：主板 10%、创业/科创 20%、北交 30%、
       ST 5%，允许 0.15% 误差；
     · 封单额 —— 快照无逐笔盘口，不可得。改用「主力净流入」(f62) 衡量
       资金强度，章节标题与文案已同步改为资金口径；
     · 连板数 —— 无历史 K 线，不做编造。改为「首板 / 20cm / ST」分层；
     · 行业 —— 行情源只给到「主板 / 创业板 / 科创板」板块级分类，
       因此板块榜按资金净流入聚合，行业细分不可得。
   ============================================================ */
(function () {
  'use strict';

  var API = '/api/market/limitup';
  var INDEX_API = '/api/market/index';
  var CACHE_KEY = 'eb_limitup_snapshot_v2';
  var POLL_MS = 60000;

  var S = {
    data: null,
    index: [],
    loading: false,
    error: null,
    at: null,
    src: '',
    timer: null,
    sort: { k: 'pct', asc: false }
  };

  function f2(v) { return (Number(v) || 0).toFixed(2); }
  function signed(v) { return (v > 0 ? '+' : '') + f2(v); }
  function num(v) { return (Number(v) || 0).toLocaleString('zh-CN'); }
  function pct(v) { return signed(v) + '%'; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function codeTag(c) {
    c = String(c || '');
    return (c.charAt(0) === '6' ? 'sh' : c.charAt(0) === '8' || c.charAt(0) === '4' ? 'bj' : 'sz') + c;
  }
  function boardName(code, name) {
    if (String(name || '').toUpperCase().indexOf('ST') >= 0) return 'ST';
    var c = String(code || '');
    if (c.slice(0, 2) === '30') return '创业板';
    if (c.slice(0, 2) === '68') return '科创板';
    return '主板';
  }

  /* ---------- 数据获取：实时优先，缓存兜底 ---------- */
  function readCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !o.list || !o.at) return null;
      return o;
    } catch (e) { return null; }
  }
  function writeCache(d) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch (e) { /* 忽略配额 */ }
  }

  function fetchJSON(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function load(force) {
    if (S.loading && !force) return Promise.resolve();
    S.loading = true;
    S.error = null;
    paintStatus();
    return Promise.all([
      fetchJSON(API + '?t=' + Date.now()),
      fetchJSON(INDEX_API + '?t=' + Date.now()).catch(function () { return null; })
    ]).then(function (res) {
      var d = res[0];
      if (!d || !d.ok || !Array.isArray(d.list)) throw new Error((d && d.error) || '数据格式异常');
      S.data = d;
      S.at = d.at;
      S.src = d.src || 'realtime';
      if (res[1] && res[1].data && res[1].data.diff) S.index = res[1].data.diff;
      writeCache({ at: d.at, list: d.list, limitUp: d.limitUp, limitDown: d.limitDown,
        up: d.up, down: d.down, flat: d.flat, amount: d.amount, upRatio: d.upRatio,
        dist: d.dist, sectors: d.sectors, inflowTop: d.inflowTop, total: d.total });
      S.loading = false;
      build(true);
    }).catch(function (e) {
      S.loading = false;
      S.error = e && e.message ? e.message : String(e);
      if (!S.data) S.data = readCache();
      paintStatus();
      build(true);
    });
  }

  /* ---------- 状态条 ---------- */
  function paintStatus() {
    var bar = document.getElementById('lu-status');
    if (!bar) return;
    var live = !!S.data && !S.error;
    var cls = S.loading ? 'loading' : live ? 'live' : 'error';
    bar.className = 'lu-status ' + cls;
    var dot = bar.querySelector('.lu-dot');
    var txt = bar.querySelector('.lu-txt');
    var sub = bar.querySelector('.lu-subtxt');
    var btn = bar.querySelector('.lu-refresh');
    if (dot) dot.textContent = '';
    if (txt) txt.textContent = S.loading ? '正在拉取实时行情' : live ? '实时行情已连接' : '实时源不可用 · 显示缓存';
    if (sub) sub.textContent = S.error
      ? (S.error + (S.at ? ' · 缓存 ' + S.at : ''))
      : (S.at ? '更新于 ' + S.at + ' · ' + String(S.src).toUpperCase() : '全市场快照');
    if (btn) btn.disabled = S.loading;
  }

  function statusHTML() {
    return '<div class="lu-status loading" id="lu-status">' +
      '<span class="lu-dot"></span>' +
      '<div class="lu-status-body"><div class="lu-txt">正在拉取实时行情</div>' +
      '<div class="lu-subtxt">连接本地行情服务…</div></div>' +
      '<button class="lu-refresh" id="lu-refresh" type="button">↻ 刷新</button></div>';
  }

  /* ---------- 章节片段 ---------- */
  function chapter(no, cn, h3, ask, en) {
    return '<div class="lu-ch lu-fade">' +
      '<div class="cn">CHAPTER ' + no + ' · ' + cn + '</div>' +
      '<h3>' + h3 + '</h3>' +
      '<p class="ask">' + ask + '</p>' +
      '<div class="en">' + en + '</div></div>';
  }
  function read(text) { return '<div class="lu-read lu-fade">' + text + '</div>'; }

  var d = function () { return S.data || { list: [], downList: [], sectors: [], inflowTop: [], dist: {}, index: [] }; };

  /* ---------- 封面 ---------- */
  function renderCover() {
    var x = d();
    var lu = x.limitUp || 0, ld = x.limitDown || 0;
    var ratio = x.upRatio || 0;
    var brand = lu >= ld ? '多头占优' : '空头占优';
    var highest = (x.list || []).reduce(function (m, s) { return Math.max(m, s.pct || 0); }, 0);
    var cards = [
      { k: '涨停家数', v: lu, u: '家', n: '全市场实时判定', cls: 'up' },
      { k: '跌停家数', v: ld, u: '家', n: ld > lu ? '空方力量更强' : '多方力量更强', cls: 'dn' },
      { k: '上涨家数占比', v: ratio, u: '%', n: '涨 ' + num(x.up || 0) + ' / 跌 ' + num(x.down || 0), cls: '' },
      { k: '最高涨幅', v: f2(highest), u: '%', n: '实时快照内最大值', cls: 'up' }
    ].map(function (c) {
      return '<div class="lu-stat ' + c.cls + '"><div class="k">' + c.k + '</div>' +
        '<div class="v">' + c.v + '<small>' + c.u + '</small></div>' +
        '<div class="n">' + esc(c.n) + '</div></div>';
    }).join('');

    var idxs = (S.index.length ? S.index : []).slice(0, 4).map(function (i) {
      var pc = Number(i.f3) || 0;
      return '<div class="lu-idx"><span class="nm">' + esc(i.f14) + '</span>' +
        '<span class="px">' + f2(i.f2) + '</span>' +
        '<span class="pc ' + (pc < 0 ? 'dn' : 'up') + '">' + pct(pc) + '</span></div>';
    }).join('');

    var head = lu + ' 家涨停，' + ratio + '% 个股上涨';
    var sub = '沪深京全市场 ' + num(x.total || 0) + ' 只：上涨 ' + num(x.up || 0) + ' 家、下跌 ' +
      num(x.down || 0) + ' 家、平盘 ' + num(x.flat || 0) + ' 家；涨停 ' + lu + ' 家、跌停 ' + ld +
      ' 家，全市场成交 ' + f2((x.amount || 0) / 10000) + ' 万亿。' + brand + '。';

    return '<div class="lu-cover lu-fade">' +
      '<div class="lu-cover-top">' +
        '<div style="flex:1;min-width:320px">' +
          '<div class="lu-eyebrow">LIMIT-UP ATLAS · <b>A 股涨停热点数据地图 · 实时</b></div>' +
          '<h2>' + esc(head) + '</h2>' +
          '<p class="lu-sub">' + esc(sub) + '</p>' +
        '</div>' +
        '<div class="lu-stamp"><div class="d1">' + esc((x.at || '').slice(5, 16) || '--') + '</div>' +
          '<div class="d2">' + esc(x.at || '等待更新') + '</div>' +
          '<div class="d3">实时快照</div></div>' +
      '</div>' +
      '<div class="lu-stats">' + cards + '</div>' +
      (idxs ? '<div class="lu-indexrow">' + idxs +
        '<div class="lu-idx"><span class="nm">全市场成交</span><span class="px">' + f2((x.amount || 0) / 10000) + ' 万亿</span>' +
        '<span class="pc" style="color:var(--lu-ink3);font-weight:400;font-size:11px">沪深京合计</span></div></div>' : '') +
      '<div class="lu-route">' +
        '<span><i>01</i>市场宽度：涨跌全貌</span>' +
        '<span><i>02</i>资金主线：钱去了哪里</span>' +
        '<span><i>03</i>强度分层：谁在领涨</span>' +
        '<span><i>04</i>资金热区：溢价给谁</span>' +
        '<span><i>05</i>全量名单：逐只核对</span>' +
      '</div>' +
    '</div>';
  }

  /* ---------- 01 市场宽度 ---------- */
  function renderBreadth() {
    var x = d();
    var up = x.up || 0, down = x.down || 0, flat = x.flat || 0;
    var tot = Math.max(1, up + down + flat);
    var upW = up / tot * 100, dnW = down / tot * 100, flW = flat / tot * 100;
    var dist = x.dist || {};
    var bp = '<div class="lu-bipolar">' +
      '<div class="lu-bp-row"><div class="lu-bp-lab">上涨 ' + num(up) + '</div>' +
        '<div class="lu-bp-track"><div class="lu-bp-up" style="width:' + upW.toFixed(2) + '%">' + upW.toFixed(1) + '%</div>' +
        '<div class="lu-bp-mid" style="width:' + flW.toFixed(2) + '%"></div>' +
        '<div class="lu-bp-dn" style="width:' + dnW.toFixed(2) + '%">下跌 ' + num(down) + ' · ' + dnW.toFixed(1) + '%</div></div></div>' +
      '</div>' +
      '<div class="lu-bipmeta">' +
        '<div><span>涨跌家数比</span><b>1 : ' + (down / Math.max(1, up)).toFixed(1) + '</b></div>' +
        '<div><span>涨停 : 跌停</span><b>' + (x.limitUp || 0) + ' : ' + (x.limitDown || 0) + '</b></div>' +
        '<div><span>情绪定位</span><b class="' + ((x.limitUp || 0) >= (x.limitDown || 0) ? 'warm' : 'cool') + '">' +
          ((x.limitUp || 0) >= (x.limitDown || 0) ? '偏暖' : '偏冷') + '</b></div>' +
      '</div>' +
      '<div class="lu-muted">' +
        '平盘 ' + num(flat) + ' 家。上涨占比 ' + (x.upRatio || 0) + '%，' +
        '涨停 ' + (x.limitUp || 0) + ' 家与跌停 ' + (x.limitDown || 0) + ' 家的对比，' +
        '是判断情绪冷暖的第一层读数。</div>';

    var rows = [
      ['涨停', dist.limitUp, 'up'], ['>7%', dist.gt7, 'up'], ['5~7%', dist['5to7'], 'up'],
      ['2~5%', dist['2to5'], 'up'], ['0~2%', dist['0to2'], 'up'], ['平', dist.flat, 'fl'],
      ['0~-2%', dist['0to2dn'], 'dn'], ['-2~-5%', dist['2to5dn'], 'dn'], ['-5~-7%', dist['5to7dn'], 'dn'],
      ['<-7%', dist.lt7dn, 'dn'], ['跌停', dist.limitDown, 'dn']
    ];
    var maxC = Math.max.apply(null, rows.map(function (r) { return r[1] || 0; }).concat([1]));
    var bars = rows.map(function (r) {
      var h = Math.sqrt((r[1] || 0) / maxC) * 100;
      return '<div class="lu-dist-c"><div class="num">' + num(r[1] || 0) + '</div>' +
        '<div class="bar ' + r[2] + '" style="height:' + h.toFixed(1) + '%"></div></div>';
    }).join('');
    var xs = rows.map(function (r) { return '<span>' + r[0] + '</span>'; }).join('');

    return '<div class="lu-2col">' +
      '<div class="lu-card lu-fade"><div class="lu-card-h"><h4>涨跌家数对比</h4>' +
        '<span class="h">全市场 ' + num(x.total || 0) + ' 只实时快照</span></div>' + bp + '</div>' +
      '<div class="lu-card lu-fade"><div class="lu-card-h"><h4>涨跌幅区间分布</h4>' +
        '<span class="h">柱高按平方根压缩，便于看清两端</span></div>' +
        '<div class="lu-dist">' + bars + '</div><div class="lu-dist-x">' + xs + '</div></div>' +
      '</div>';
  }

  /* ---------- 02 资金主线 ---------- */
  function renderSector() {
    var x = d();
    var sectors = (x.sectors || []).slice(0, 8);
    var maxIn = Math.max.apply(null, sectors.map(function (s) { return Math.abs(s.inflow) || 0; }).concat([0.01]));
    var srows = sectors.map(function (s) {
      var p = s.pct || 0;
      return '<div class="lu-sec-row"><span class="nm">' + esc(s.name) + '</span>' +
        '<span class="tr"><i style="width:' + (Math.abs(s.inflow) / maxIn * 100).toFixed(1) + '%"></i></span>' +
        '<span class="pc ' + (s.inflow < 0 ? 'dn' : '') + '">' + (s.inflow > 0 ? '+' : '') + f2(s.inflow) + ' 亿</span>' +
        '<span class="ld">' + (p > 0 ? '+' : '') + f2(p) + '% · 涨停 ' + (s.lu || 0) + ' 只</span></div>';
    }).join('');

    var top = (x.inflowTop || []).slice(0, 8);
    var cards = top.map(function (s) {
      return '<div class="lu-dcard"><div class="nm">' + esc(s.name) + '</div>' +
        '<div class="cd">' + codeTag(s.code) + ' · ' + esc(s.boardName || boardName(s.code, s.name)) + '</div>' +
        '<div class="pc">' + pct(s.pct) + '</div>' +
        '<div class="mt">净流入 ' + f2(s.inflow) + ' 亿 · 换手流通 ' + f2(s.fcap) + ' 亿</div></div>';
    }).join('');

    var lu = x.list || [];
    var bmap = {};
    lu.forEach(function (s) { var b = boardName(s.code, s.name); bmap[b] = (bmap[b] || 0) + 1; });
    var inds = Object.keys(bmap).sort(function (a, b) { return bmap[b] - bmap[a]; }).map(function (k) {
      var n = bmap[k];
      return '<div class="lu-ind ' + (n >= 10 ? 's3' : n >= 4 ? 's2' : '') + '"><div class="c">' + n + '<small>只</small></div>' +
        '<div class="n">' + esc(k) + '</div></div>';
    }).join('');

    return '<div class="lu-card lu-fade"><div class="lu-card-h"><h4>板块主力资金榜</h4>' +
        '<span class="h">按主力净流入聚合 · 实时快照，非申万行业细分</span></div>' + srows +
      '<div class="lu-muted">行情源仅提供板块级分类（主板 / 创业板 / 科创板），' +
      '行业细分与概念榜单在当前数据源下不可得，故以资金净流入与涨停家数替代展示。</div></div>' +
      '<div class="lu-card lu-fade" style="margin-top:16px"><div class="lu-card-h"><h4>涨停股板块分布</h4>' +
        '<span class="h">' + lu.length + ' 只涨停按上市板归类</span></div>' +
        '<div class="lu-indgrid">' + (inds || '<div class="lu-muted">暂无涨停股</div>') + '</div></div>' +
      '<div class="lu-card lu-fade" style="margin-top:16px"><div class="lu-card-h"><h4>资金流入 TOP 8</h4>' +
        '<span class="h">主力净流入 = 实时快照 f62 字段</span></div>' +
        '<div class="lu-diff">' + (cards || '<div class="lu-muted">暂无数据</div>') + '</div></div>';
  }

  /* ---------- 03 强度分层（替代不可得的连板梯队） ---------- */
  function renderLadder() {
    var lu = d().list || [];
    var g = { hi: [], mid: [], low: [], first: [] };
    lu.forEach(function (s) {
      var isST = String(s.name || '').toUpperCase().indexOf('ST') >= 0;
      if (s.board >= 20 && s.pct >= 19) g.hi.push(s);
      else if (s.board >= 20) g.mid.push(s);
      else if (isST) g.low.push(s);
      else g.first.push(s);
    });
    var meta = [
      { k: 'hi', b: '20cm', cls: 'hi', tip: '20% 涨停', arr: g.hi },
      { k: 'mid', b: '接近', cls: 'mid', tip: '20cm 未封', arr: g.mid },
      { k: 'low', b: 'ST', cls: 'mid', tip: '5% 涨停', arr: g.low },
      { k: 'first', b: '10cm', cls: '', tip: '主板涨停', arr: g.first }
    ];
    var rows = meta.map(function (m) {
      var chips = m.arr.slice(0, 16).map(function (s) {
        return '<span class="lu-chip ' + (m.cls === 'hi' ? 'hot' : '') + '"><b>' + esc(s.name) + '</b>' +
          '<span class="c">' + codeTag(s.code) + '</span>' +
          '<span class="s">' + pct(s.pct) + '</span></span>';
      }).join('');
      if (m.arr.length > 16) chips += '<span class="lu-chip mini">+' + (m.arr.length - 16) + ' 只</span>';
      return '<div class="lu-lrow ' + m.cls + '">' +
        '<div class="lu-ltag"><div class="b">' + m.b + '</div><div class="t">' + m.tip + '</div></div>' +
        '<div><div class="lu-lchips">' + (chips || '<span class="lu-muted">无</span>') + '</div>' +
        '<div class="lu-lmore">共 ' + m.arr.length + ' 只 · 占涨停 ' +
          (m.arr.length / Math.max(1, lu.length) * 100).toFixed(0) + '%</div></div></div>';
    }).join('');

    return '<div class="lu-card lu-fade"><div class="lu-card-h"><h4>涨停强度分层</h4>' +
      '<span class="h">按涨停幅度分层 · 实时判定</span></div>' +
      '<div class="lu-ladder">' + rows + '</div>' +
      '<div class="lu-note-inline"><b>口径：</b>连板数需要历史日 K 逐只核对，实时快照不提供该字段，' +
      '因此本节改为按当日涨停幅度分层展示，不做连板数的推断或编造。</div></div>';
  }

  /* ---------- 04 资金热区（替代不可得的封单额） ---------- */
  function renderSeal() {
    var top = (d().inflowTop || []).slice(0, 12);
    var maxS = Math.max.apply(null, top.map(function (s) { return Math.abs(s.inflow) || 0; }).concat([0.01]));
    var rows = top.map(function (s, i) {
      var ratio = (s.inflow) / Math.max(0.01, s.fcap) * 100;
      var strong = ratio >= 2;
      return '<div class="lu-seal-row ' + (strong ? 'strong' : 'weak') + '">' +
        '<div class="rk">' + (i + 1) + '</div>' +
        '<div class="nm"><b>' + esc(s.name) + '</b><span class="lu-flag ' + (strong ? 'a' : 'b') + '">' +
        (strong ? '强流入' : '温和') + '</span><span class="sub">' +
        esc(boardName(s.code, s.name)) + ' · ' + pct(s.pct) + '</span></div>' +
        '<div class="tr"><i style="width:' + (Math.abs(s.inflow) / maxS * 100).toFixed(1) + '%"></i></div>' +
        '<div class="am">' + f2(s.inflow) + ' 亿</div>' +
        '<div class="rt">' + f2(ratio) + '%</div></div>';
    }).join('');

    return '<div class="lu-card lu-fade"><div class="lu-card-h"><h4>主力净流入 TOP 12</h4>' +
      '<span class="h">净流入 = 实时快照 f62；占比 = 净流入 / 流通市值</span></div>' +
      '<div class="lu-seal-head"><div>#</div><div>个股</div><div>资金强度</div>' +
      '<div>净流入</div><div>占流通</div></div>' +
      '<div class="lu-seal">' + (rows || '<div class="lu-muted">暂无数据</div>') + '</div>' +
      '<div class="lu-note-inline"><b>口径：</b>封单额需逐笔盘口（买一挂单量），实时快照不提供，' +
      '本节改用主力净流入衡量资金强度，两者含义不同，请勿等同解读。</div></div>';
  }

  /* ---------- 05 全量名单 ---------- */
  var COLS = [
    { k: 'code', t: '代码' }, { k: 'name', t: '名称' }, { k: 'ind', t: '板块' },
    { k: 'price', t: '现价', num: 1 }, { k: 'pct', t: '涨幅', num: 1 },
    { k: 'board', t: '涨停幅', num: 1 }, { k: 'turnover', t: '换手', num: 1 },
    { k: 'amount', t: '成交额(亿)', num: 1 }, { k: 'inflow', t: '净流入(亿)', num: 1 },
    { k: 'fcap', t: '流通市值(亿)', num: 1 }
  ];

  function renderTable() {
    var arr = (d().list || []).slice().sort(function (a, b) {
      var x = a[S.sort.k], y = b[S.sort.k];
      if (typeof x === 'string') return S.sort.asc ? x.localeCompare(y) : y.localeCompare(x);
      return S.sort.asc ? (x || 0) - (y || 0) : (y || 0) - (x || 0);
    });
    var maxIn = Math.max.apply(null, arr.map(function (s) { return s.inflow || 0; }).concat([0.01]));
    var head = COLS.map(function (c) {
      var on = S.sort.k === c.k;
      return '<th data-k="' + c.k + '" class="' + (on ? 'on' : '') + (on && S.sort.asc ? ' asc' : '') +
        '" style="' + (c.num ? 'text-align:right' : '') + '">' + c.t + '</th>';
    }).join('');
    var body = arr.map(function (s) {
      return '<tr>' +
        '<td class="c">' + codeTag(s.code) + '</td>' +
        '<td class="n">' + esc(s.name) + '</td>' +
        '<td class="ind">' + esc(boardName(s.code, s.name)) + '</td>' +
        '<td class="num">' + f2(s.price) + '</td>' +
        '<td class="pc" style="text-align:right">' + pct(s.pct) + '</td>' +
        '<td class="num">' + f2(s.board) + '%</td>' +
        '<td class="num">' + f2(s.turnover) + '%</td>' +
        '<td class="num">' + f2(s.amount) + '</td>' +
        '<td class="num"><span class="bar" style="width:' + Math.max(2, Math.abs(s.inflow) / maxIn * 42).toFixed(0) + 'px"></span>' +
          f2(s.inflow) + '</td>' +
        '<td class="num">' + f2(s.fcap) + '</td>' +
        '</tr>';
    }).join('');

    return '<div class="lu-tbwrap lu-fade">' +
      '<div class="lu-tbhead"><h4>全量涨停名单 · <span id="lu-count">' + arr.length + '</span> 只</h4>' +
      '<span>点表头可排序 · 数据实时拉取</span></div>' +
      '<div style="max-height:640px;overflow:auto"><table class="lu-tb"><thead><tr>' + head + '</tr></thead>' +
      '<tbody>' + body + '</tbody></table></div></div>';
  }

  /* ---------- 06 结论 ---------- */
  function renderConcl() {
    var x = d();
    var lu = x.limitUp || 0, ld = x.limitDown || 0;
    var tone = lu >= ld ? '情绪偏暖，涨停多于跌停' : '情绪偏冷，跌停多于涨停';
    var rules = [
      { k: 'RULE 01', t: '先看宽度，再看涨停', p: '上涨占比 ' + (x.upRatio || 0) + '%、下跌 ' + num(x.down || 0) +
          ' 家，宽度决定仓位；涨停 ' + lu + ' 家只决定有没有可讲的故事。' },
      { k: 'RULE 02', t: '资金流向比涨幅更可靠', p: '涨幅可被脉冲拉出，主力净流入更能反映持续性。' +
          '关注资金榜前列是否集中在同一板块。' },
      { k: 'RULE 03', t: '20cm 与主板分层看', p: '20cm 涨停 ' + ((x.list || []).filter(function (s) { return s.board >= 20; }).length) +
          ' 只，主板 ' + ((x.list || []).filter(function (s) { return s.board === 10; }).length) +
          ' 只；两层的情绪含义不同，不要混为一谈。' }
    ].map(function (r) {
      return '<div class="lu-rule"><div class="k">' + r.k + '</div><div class="t">' + r.t + '</div>' +
        '<p>' + r.p + '</p></div>';
    }).join('');
    return '<div class="lu-concl lu-fade"><div class="eb">CONCLUSION · 实时解读</div>' +
      '<h4>' + tone + '</h4>' +
      '<p>数据更新于 ' + esc(x.at || '—') + '。涨停 ' + lu + ' 家、跌停 ' + ld + ' 家，' +
      '全市场成交 ' + f2((x.amount || 0) / 10000) + ' 万亿。以上为实时快照的客观统计，' +
      '不构成投资建议，也不预测次日走势。</p>' +
      '<div class="lu-rules">' + rules + '</div></div>';
  }

  function renderMeta() {
    return '<div class="lu-meta lu-fade"><b>数据口径与可追溯性</b><br>' +
      '数据源：本地服务 /api/market/limitup，底层为腾讯财经全市场实时快照，每次刷新现算，' +
      '前端不内置任何写死行情数字。<br>' +
      '· 涨停/跌停 —— 按板块阈值判定：主板 10%、创业/科创 20%、北交 30%、ST 5%，允许 0.15% 误差；<br>' +
      '· 涨跌幅分布 / 涨跌家数 / 成交额 —— 全市场逐只统计；<br>' +
      '· 主力净流入 —— 行情快照 f62 字段，用于替代不可得的封单额；<br>' +
      '· 连板数、封单额、申万行业细分 —— 当前数据源不提供，未做推断或编造；<br>' +
      '· 刷新 ———— 手动点击或盘中每 60 秒自动拉取，失败时自动回退到浏览器缓存并标注。<br>' +
      '本页仅用于研究展示，不构成投资建议。</div>';
  }

  /* ---------- 渲染 ---------- */
  function bodyHTML() {
    return renderCover() +
      chapter('01', '市场宽度', '涨停与下跌，看谁占上风',
        '先看「面」。宽度决定仓位，涨停家数只决定有没有故事可讲——两者背离时，仓位跟着宽度走。',
        'Where breadth stands') +
      read('<b>宽度优先：</b>上涨家数占比与涨跌家数比，是判断市场能否承接的第一读数；' +
        '涨停家数只说明局部有故事，不能替代整体宽度。') +
      renderBreadth() +
      chapter('02', '资金主线', '钱先去了哪里',
        '资金流向回答「强在哪里」，而不是「谁涨得多」。', 'Where the money went first') +
      read('<b>看钱不看价：</b>主力净流入是实时快照里的真实字段，' +
        '比单日涨幅更能反映资金是否愿意持续参与。') +
      renderSector() +
      chapter('03', '强度分层', '谁站在涨幅最前面',
        '按涨停幅度分层，看清 20cm 与主板的结构差异。', 'Who leads the move') +
      read('<b>分层看：</b>20cm 与主板涨停的情绪含义不同，' +
        '前者弹性大、风险也大，后者更接近普适的赚钱效应。') +
      renderLadder() +
      chapter('04', '资金热区', '市场愿意把溢价留给谁',
        '净流入告诉你钱愿意在哪些票上给更高确定性。', 'Who earns the premium') +
      read('<b>资金热区：</b>主力净流入占流通市值比例越高，说明资金介入越深；' +
        '但快照无法区分封单与对倒，需结合次日走势验证。') +
      renderSeal() +
      chapter('05', '全量名单', '逐只核对',
        '正文看结论，附录做核对。所有字段均可回溯到实时快照。', 'Verify, stock by stock') +
      renderTable() + renderConcl() + renderMeta();
  }

  var BUILT = false;
  function build(force) {
    var root = document.getElementById('v-limitup');
    if (!root) return;
    if (BUILT && !force) { bindTable(); paintStatus(); return; }
    var x = d();
    var html = statusHTML() + bodyHTML();
    root.innerHTML = '<div class="vhead"><h1>涨停热点数据地图 <span class="lu-live-tag">LIVE</span></h1>' +
      '<p class="sub">把市场宽度、资金主线、强度分层与涨停名单缝成一条「钱在买哪条线」的路线图。' +
      '数据实时拉取自本地行情服务，更新于 ' + esc(x.at || '等待更新') + '。</p></div>' + html;
    BUILT = true;
    bindTable();
    paintStatus();
    var btn = document.getElementById('lu-refresh');
    if (btn) btn.addEventListener('click', function () { load(true); });
    reveal();
  }

  function bindTable() {
    var root = document.getElementById('v-limitup');
    if (!root) return;
    root.querySelectorAll('.lu-tb thead th').forEach(function (th) {
      if (th.dataset.bound) return;
      th.dataset.bound = '1';
      th.addEventListener('click', function () {
        var k = th.dataset.k;
        if (S.sort.k === k) S.sort.asc = !S.sort.asc;
        else { S.sort.k = k; S.sort.asc = false; }
        var wrap = root.querySelector('.lu-tbwrap');
        if (wrap) {
          var tmp = document.createElement('div');
          tmp.innerHTML = renderTable();
          wrap.replaceWith(tmp.firstChild);
          bindTable();
        }
      });
    });
  }

  function reveal() {
    var root = document.getElementById('v-limitup');
    if (!root) return;
    var els = root.querySelectorAll('.lu-fade');
    if (!('IntersectionObserver' in window)) {
      els.forEach(function (e) { e.classList.add('in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -40px 0px', threshold: 0.05 });
    els.forEach(function (e) { io.observe(e); });
  }

  function startPolling() {
    if (S.timer) return;
    S.timer = setInterval(function () {
      if (!document.getElementById('v-limitup')) return;
      if (document.hidden) return;
      load(true);
    }, POLL_MS);
  }

  window.EB_LIMITUP = {
    render: function () {
      if (!document.getElementById('v-limitup')) return;
      if (!S.data) S.data = readCache();
      build(true);
      if (!S.data || !S.at || Date.now() - new Date(S.at.replace(/-/g, '/')).getTime() > POLL_MS) load(true);
      startPolling();
    },
    refresh: function () { return load(true); },
    data: function () { return S.data; }
  };
})();
