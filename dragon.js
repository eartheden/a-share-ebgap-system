/* ============================================================
   11 · 龙头战法 · 情绪周期与选股清单  (dragon.js)
   ------------------------------------------------------------
   纯自有数据：每次点「生成今日清单」由后端抓一次涨停快照，
   打分落库，然后展示情绪周期看板 + 候选清单 + 一键虚拟买入。
   虚拟买入复用 paper.js 的 EB_PAPER.buy()，持仓口径与选股引擎完全一致。
   对外接口：window.EB_DRAGON
   ============================================================ */
(function () {
  'use strict';

  var S = { loaded: false, loading: false, series: [], picks: [], meta: null, error: null };

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fx(v, d) { var n = Number(v); return isFinite(n) ? n.toFixed(d == null ? 2 : d) : '—'; }
  function pct(v) { var n = Number(v); return isFinite(n) ? (n > 0 ? '+' : '') + n.toFixed(2) + '%' : '—'; }
  function api(path, body) {
    var opt = { cache: 'no-store' };
    if (body !== undefined) {
      opt.method = 'POST';
      opt.headers = { 'Content-Type': 'application/json' };
      opt.body = JSON.stringify(body);
    }
    return fetch(path, opt).then(function (r) { return r.json(); });
  }

  var EMOTION_CLS = { '冰点': 'ice', '启动': 'start', '发酵': 'ferment', '高潮': 'peak', '退潮': 'ebb' };

  function render() {
    var v = el('v-dragon');
    if (!v) return;
    if (!v.dataset.built) {
      v.innerHTML =
        '<div class="dg-head">' +
        '<div><h1>龙头战法</h1><p class="dg-sub">用自有数据验证情绪周期 · 生成选股清单 · 一键虚拟买入</p></div>' +
        '<button class="dg-btn main" id="dg-gen">生成今日清单</button>' +
        '</div>' +
        '<div class="dg-note">数据来自每日涨停快照。连板数按「连续出现在涨停名单的天数」推断，封单额不可得时用资金净流入替代——不编造数据。</div>' +
        '<div class="dg-kpis" id="dg-kpis"></div>' +
        '<div class="dg-grid">' +
        '<section class="dg-card"><div class="dg-card-h"><h2>情绪周期</h2><span id="dg-emotion-now"></span></div>' +
        '<div id="dg-emotion" class="dg-emotion"></div></section>' +
        '<section class="dg-card"><div class="dg-card-h"><h2>情绪趋势</h2><span>近 30 个交易日</span></div>' +
        '<div id="dg-trend" class="dg-trend"></div></section>' +
        '</div>' +
        '<section class="dg-card"><div class="dg-card-h"><h2>候选清单</h2><span id="dg-pick-meta"></span></div>' +
        '<div id="dg-picks" class="dg-picks"></div></section>';
      v.dataset.built = '1';
      $('dg-gen').addEventListener('click', generate);
    }
    paint();
    if (!S.loaded) load();
  }

  function $(id) { return document.getElementById(id); }

  function load() {
    if (S.loading) return;
    S.loading = true;
    Promise.all([
      api('/api/dragon/emotion?days=30'),
      api('/api/dragon/list')
    ]).then(function (res) {
      S.series = (res[0] && res[0].series) || [];
      S.picks = (res[1] && res[1].picks) || [];
      S.loaded = true; S.error = null;
      paint();
    }).catch(function (e) {
      S.error = e && e.message || '加载失败'; S.loaded = true; paint();
    }).then(function () { S.loading = false; });
  }

  function generate() {
    var btn = $('dg-gen');
    if (!btn) return;
    btn.disabled = true; btn.textContent = '生成中…';
    api('/api/dragon/snapshot', {}).then(function (res) {
      if (!res || !res.ok) throw new Error((res && res.error) || '生成失败');
      S.meta = res;
      S.picks = res.picks || [];
      return api('/api/dragon/emotion?days=30');
    }).then(function (res) {
      S.series = (res && res.series) || S.series;
      S.loaded = true; S.error = null; paint();
    }).catch(function (e) {
      S.error = e && e.message || '生成失败'; paint();
    }).then(function () {
      btn.disabled = false; btn.textContent = '生成今日清单';
    });
  }

  function paint() {
    var kbox = $('dg-kpis'); if (!kbox) return;
    var m = S.meta || (S.series[0]) || {};
    var emo = m.emotion || '—';
    kbox.innerHTML =
      kpi('当日情绪', emo, EMOTION_CLS[emo] || '') +
      kpi('涨停家数', m.limit_up != null ? m.limit_up : '—') +
      kpi('最高连板', m.max_board != null ? m.max_board + ' 板' : '—') +
      kpi('两市成交', m.amount != null ? fx(m.amount, 0) + ' 亿' : '—');
    var nowTag = $('dg-emotion-now');
    if (nowTag) nowTag.textContent = S.meta ? (S.meta.date + ' 生成') : (S.series[0] ? S.series[0].date : '暂无数据');

    paintEmotion();
    paintTrend();
    paintPicks();
  }

  function kpi(label, value, cls) {
    return '<div class="dg-kpi ' + (cls || '') + '"><i>' + esc(label) + '</i><b>' + esc(value) + '</b></div>';
  }

  function paintEmotion() {
    var box = $('dg-emotion'); if (!box) return;
    var stages = ['冰点', '启动', '发酵', '高潮', '退潮'];
    var cur = (S.meta && S.meta.emotion) || (S.series[0] && S.series[0].emotion) || '';
    var idx = stages.indexOf(cur);
    box.innerHTML = stages.map(function (s, i) {
      var cls = 'dg-stage ' + (EMOTION_CLS[s] || '');
      if (i === idx) cls += ' on';
      else if (idx >= 0 && i < idx) cls += ' past';
      return '<div class="' + cls + '"><b>' + s + '</b><span>' +
        ['轻仓试错', '首板启动', '跟随主线', '只减不加', '空仓观望'][i] + '</span></div>';
    }).join('');
  }

  function paintTrend() {
    var box = $('dg-trend'); if (!box) return;
    var arr = S.series.slice().reverse();
    if (!arr.length) { box.innerHTML = '<p class="dg-empty">还没有数据，点「生成今日清单」开始累积</p>'; return; }
    var color = { '冰点': '#85B7EB', '启动': '#5DCAA5', '发酵': '#FAC775', '高潮': '#F09595', '退潮': '#B4B2A9' };
    var max = Math.max.apply(null, arr.map(function (d) { return d.limit_up || 0; }).concat([1]));
    box.innerHTML = '<div class="dg-bars">' + arr.map(function (d) {
      var h = Math.round((d.limit_up || 0) / max * 100);
      return '<div class="dg-bar-wrap" title="' + esc(d.date) + ' · 涨停 ' + (d.limit_up || 0) +
        ' · ' + esc(d.emotion || '') + '"><div class="dg-bar" style="height:' + Math.max(4, h) + '%;background:' +
        (color[d.emotion] || '#888780') + '"></div></div>';
    }).join('') + '</div><div class="dg-trend-foot"><span>' + esc(arr[0].date) +
      '</span><span>涨停家数 · 颜色代表情绪阶段</span><span>' + esc(arr[arr.length - 1].date) + '</span></div>';
  }

  function paintPicks() {
    var box = $('dg-picks'), meta = $('dg-pick-meta');
    if (!box) return;
    if (!S.picks.length) {
      box.innerHTML = '<p class="dg-empty">' + (S.error ? esc(S.error) : '还没有候选，点「生成今日清单」') + '</p>';
      if (meta) meta.textContent = '';
      return;
    }
    if (meta) meta.textContent = S.picks.length + ' 只 · 按分数排序';
    box.innerHTML = '<table class="dg-table"><thead><tr>' +
      '<th>评分</th><th>名称 / 代码</th><th>连板</th><th>涨幅</th><th>换手</th><th>资金流</th><th>入选理由</th><th></th>' +
      '</tr></thead><tbody>' + S.picks.map(function (p) {
      var sc = Number(p.score) || 0;
      var cls = sc >= 70 ? 'high' : (sc >= 55 ? 'mid' : 'low');
      return '<tr>' +
        '<td><span class="dg-score ' + cls + '">' + fx(sc, 0) + '</span></td>' +
        '<td><b>' + esc(p.name) + '</b><br><span class="dg-code">' + esc(p.code) + '</span></td>' +
        '<td>' + (p.board_num > 1 ? '<span class="dg-board">' + p.board_num + ' 板</span>' : '首板') + '</td>' +
        '<td class="dg-up">' + pct(p.pct) + '</td>' +
        '<td>' + fx(p.turnover, 1) + '%</td>' +
        '<td>' + fx(p.inflow, 2) + ' 亿</td>' +
        '<td class="dg-reason">' + esc(p.reason) + '</td>' +
        '<td><button class="dg-btn mini" data-code="' + esc(p.code) + '">虚拟买入</button></td>' +
        '</tr>';
    }).join('') + '</tbody></table>';

    box.querySelectorAll('[data-code]').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = S.picks.filter(function (x) { return x.code === b.dataset.code; })[0];
        if (p) buyOne(p, b);
      });
    });
  }

  function buyOne(p, btn) {
    if (!window.EB_PAPER || typeof EB_PAPER.buy !== 'function') {
      window.alert('虚拟持仓模块未加载'); return;
    }
    if (EB_PAPER.findOpen && EB_PAPER.findOpen(p.code)) {
      window.alert('「' + p.name + '」已有持仓，不重复开仓'); return;
    }
    var price = Number(p.price) || 0;
    if (!(price > 0)) { window.alert('该股无有效价格'); return; }
    var stop = +(price * 0.95).toFixed(2);
    var t1 = +(price * 1.08).toFixed(2);
    var t2 = +(price * 1.15).toFixed(2);
    var pick = {
      code: p.code, name: p.name, ind: p.ind, price: price,
      plan: { pos: 10, buyLow: +(price * 0.99).toFixed(2), buyHigh: +(price * 1.005).toFixed(2),
              stop: stop, t1: t1, t2: t2, hold: '短线 1-3 日' }
    };
    btn.disabled = true; btn.textContent = '买入中…';
    try {
      EB_PAPER.buy(pick);
      btn.textContent = '已买入';
      setTimeout(function () { btn.disabled = false; btn.textContent = '虚拟买入'; }, 1200);
    } catch (e) {
      btn.disabled = false; btn.textContent = '虚拟买入';
      window.alert('买入失败：' + (e && e.message || e));
    }
  }

  function enter() {
    render();
    if (!S.loaded) load();
  }

  window.EB_DRAGON = {
    render: render, enter: enter,
    state: S,
    reload: function () { S.loaded = false; load(); }
  };
})();
