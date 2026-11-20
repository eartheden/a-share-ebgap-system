/* ============================================================
   09 · 虚拟持仓 · 模拟交易台  (paper.js)
   ------------------------------------------------------------
   从 picker.js 里抽出来的独立模块，负责：
     · 持仓数据的读写（本机 SQLite /api/paper/*，本地快照兜底）
     · 报价同步（东财 ulist → /api/paper/tick，服务端执行止损/止盈纪律）
     · 账户概览、纪律预警、持仓表、已平仓统计、行业分布、已实现曲线
     · 点开单只持仓 → K 线抽屉，图上标注买入点、止损线、目标线、建议买区
     · 一键跳到「个股分析」做深度分析
   对外接口：window.EB_PAPER
   ============================================================ */
(function () {
  'use strict';

  var LKEY = 'ebgap.paper.v1';       // 本地快照（离线兜底 / 老数据迁移）
  var MKEY = 'ebgap.paper.migrated.v1';
  var AUTO_MS = 30000;               // 页面可见时自动刷新报价

  var S = {
    trades: [],
    loaded: false,
    loading: false,
    error: null,
    quotes: {},           // code → { price, pct, at }
    quoteAt: null,
    filter: 'open',       // open | closed | all
    q: '',
    sort: { k: 'ret', dir: -1 },
    drawerId: null,
    chart: null,
    chartCode: null,
    busy: false,
    mounted: false
  };

  /* ---------------- 小工具 ---------------- */
  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v) { var n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : 0; }
  function fx(v, d) { var n = num(v); return isFinite(n) ? n.toFixed(d == null ? 2 : d) : '—'; }
  function pct(v, d) { return (v > 0 ? '+' : '') + fx(v, d == null ? 2 : d) + '%'; }
  function money(v) {
    var n = Math.round(num(v));
    var s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (n < 0 ? '-¥' : '¥') + s;
  }
  function clsFor(v) { return v > 0 ? 'up' : v < 0 ? 'down' : 'flat'; }
  function signedCls(v) { return v > 0 ? 'up' : v < 0 ? 'down' : 'flat'; }

  function ymd(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* 持有交易日：按工作日估算（不含周末，不扣法定节假日）。
     endStr 为空时算到今天——已平仓的记录要传平仓日，否则持有天数越看越长 */
  function tradingDays(dateStr, endStr) {
    var s = String(dateStr || '').replace(/\D/g, '');
    if (s.length !== 8) return 0;
    var d = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
    if (isNaN(d.getTime())) return 0;
    var e = String(endStr || '').replace(/\D/g, '');
    var now = e.length === 8
      ? new Date(+e.slice(0, 4), +e.slice(4, 6) - 1, +e.slice(6, 8))
      : new Date();
    now.setHours(0, 0, 0, 0);
    d.setHours(0, 0, 0, 0);
    var n = 0, guard = 0;
    while (d < now && guard++ < 3000) {
      d.setDate(d.getDate() + 1);
      var w = d.getDay();
      if (w !== 0 && w !== 6) n++;
    }
    return n;
  }

  /* 从「20–32 个交易日」这种文案里取上限，用于超期提醒 */
  function holdUpper(hold) {
    var m = String(hold || '').match(/\d+/g);
    if (!m || !m.length) return null;
    return Math.max.apply(null, m.map(Number));
  }

  function toast(msg, kind) {
    var box = document.getElementById('pp-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'pp-toast';
      box.className = 'pp-toast';
      document.body.appendChild(box);
    }
    box.className = 'pp-toast on' + (kind ? ' ' + kind : '');
    box.textContent = msg;
    clearTimeout(box._t);
    box._t = setTimeout(function () { box.className = 'pp-toast'; }, 2600);
  }

  /* 自定义确认框：不依赖原生 confirm（部分嵌入环境/无头浏览器会静默拦截，
     表现为「点了平仓没反应」）。返回 Promise<boolean>。 */
  function confirmDialog(msg, okText) {
    return new Promise(function (resolve) {
      var mask = document.createElement('div');
      mask.className = 'pp-confirm-mask';
      mask.innerHTML = '<div class="pp-confirm" role="alertdialog" aria-modal="true">' +
        '<div class="pp-confirm-msg"></div>' +
        '<div class="pp-confirm-act">' +
        '<button class="pp-btn pp-btn-ghost" data-c="0">取消</button>' +
        '<button class="pp-btn pp-btn-danger" data-c="1"></button></div></div>';
      mask.querySelector('.pp-confirm-msg').textContent = msg;
      mask.querySelector('[data-c="1"]').textContent = okText || '确认';
      function done(v) {
        document.removeEventListener('keydown', onKey);
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        resolve(v);
      }
      function onKey(e) { if (e.key === 'Escape') done(false); }
      mask.addEventListener('click', function (e) {
        if (e.target === mask) return done(false);
        var b = e.target.closest('[data-c]');
        if (b) done(b.dataset.c === '1');
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(mask);
      mask.querySelector('[data-c="1"]').focus();
    });
  }

  /* ---------------- 接口 ---------------- */
  function apiGet(path) {
    return fetch(path, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    });
  }
  function apiPost(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
  }

  /* 三档上线前的老记录没有 hz：按当时的持有计划文案反推一个，仅用于显示 */
  function guessHz(hold) {
    var m = String(hold || '').match(/\d+/g);
    if (!m || !m.length) return null;
    var hi = Math.max.apply(null, m.map(Number));
    if (!/交易日/.test(String(hold))) return null;
    return hi <= 6 ? 'S' : hi <= 40 ? 'M' : 'L';
  }

  function fromServer(t) {
    return {
      id: t.id, code: t.code, name: t.name, ind: t.ind,
      buyPrice: t.buy_price, buyDate: t.buy_date, buyAt: t.buy_at,
      shares: t.shares, amt: t.amt,
      suggestLow: t.suggest_low, suggestHigh: t.suggest_high,
      stop: t.stop, t1: t.t1, t2: t.t2, hold: t.hold, posPct: t.pos_pct,
      score: t.score, status: t.status, curPrice: t.cur_price,
      closePrice: t.close_price, closeDate: t.close_date, closeAt: t.close_at,
      closeReason: t.close_reason, result: t.result_pct, pnl: t.pnl,
      hz: t.hz || guessHz(t.hold), note: t.note
    };
  }
  function toServer(p) {
    return {
      code: p.code, name: p.name, ind: p.ind,
      buy_price: p.buyPrice, buy_date: p.buyDate, buy_at: p.buyAt,
      shares: p.shares, amt: p.amt,
      suggest_low: p.suggestLow, suggest_high: p.suggestHigh,
      stop: p.stop, t1: p.t1, t2: p.t2, hold: p.hold, pos_pct: p.posPct,
      score: p.score, hz: p.hz, note: p.note
    };
  }

  function localSnapshot() {
    try {
      var a = JSON.parse(localStorage.getItem(LKEY) || '[]');
      return Array.isArray(a) ? a : [];
    } catch (e) { return []; }
  }
  function saveLocal() {
    try { localStorage.setItem(LKEY, JSON.stringify(S.trades)); } catch (e) { /* ignore */ }
  }

  /* 老版本把记录存在浏览器里：首次连上数据库且库为空时补传一次 */
  function migrateLocal(rows) {
    var chain = Promise.resolve();
    rows.forEach(function (p) {
      chain = chain.then(function () {
        return apiPost('/api/paper/buy', toServer(p)).then(function (res) {
          if (!res || !res.ok || !res.trade || res.trade.status === 'closed') return null;
          return apiPost('/api/paper/close', {
            id: res.trade.id, price: p.closePrice || p.buyPrice,
            reason: p.closeReason || '历史记录迁移',
            close_date: p.closeDate, close_at: p.closeAt
          }).catch(function () { return null; });
        }).catch(function () { return null; });
      });
    });
    return chain.then(function () {
      try { localStorage.setItem(MKEY, '1'); } catch (e) { /* ignore */ }
    });
  }

  function load(force) {
    if (S.loading) return Promise.resolve();
    S.loading = true;
    if (!S.trades.length) S.trades = localSnapshot();
    return apiGet('/api/paper/list').then(function (res) {
      if (!res || !res.ok) throw new Error('接口返回异常');
      var migrated = false;
      try { migrated = localStorage.getItem(MKEY) === '1'; } catch (e) { /* ignore */ }
      if (!res.trades.length && S.trades.length && !migrated) {
        return migrateLocal(S.trades.slice()).then(function () {
          return apiGet('/api/paper/list');
        });
      }
      return res;
    }).then(function (res) {
      S.trades = ((res && res.trades) || []).map(fromServer);
      S.loaded = true;
      S.error = null;
      saveLocal();
      render();
      return syncQuotes();
    }).catch(function (e) {
      S.loaded = true;
      S.error = (e && e.message) || '数据库未连接';
      render();
    }).then(function () {
      S.loading = false;
    });
  }

  /* ---------------- 报价 ---------------- */
  function secidOf(code) {
    code = String(code || '');
    if (!/^\d{6}$/.test(code)) return null;
    if (code.charAt(0) === '6') return '1.' + code;
    if (/^[03]/.test(code)) return '0.' + code;
    return null;
  }

  function fetchQuotes(codes) {
    var ids = codes.map(secidOf).filter(Boolean);
    if (!ids.length) return Promise.resolve({});
    var u = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&secids=' + ids.join(',') +
      '&fields=f2,f3,f12,f14,f15,f16,f17,f18';
    return fetch('/api/stock/em?u=' + encodeURIComponent(u), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var out = {}, diff = (j && j.data && j.data.diff) || [];
        diff.forEach(function (d) {
          var p = num(d.f2);
          if (p > 0) out[String(d.f12)] = { price: p, pct: num(d.f3), high: num(d.f15), low: num(d.f16) };
        });
        return out;
      });
  }

  /* 推送一批已知价格（选股引擎抓完全市场后调用，省一次请求） */
  function pushPrices(map) {
    var hit = false;
    Object.keys(map || {}).forEach(function (code) {
      var p = num(map[code]);
      if (p > 0) { S.quotes[code] = { price: p, at: Date.now() }; hit = true; }
    });
    if (hit) return tick();
    return Promise.resolve();
  }

  var tickTimer = null;
  function tick() {
    if (tickTimer) return tickTimer;
    var open = S.trades.filter(function (t) { return t.status === 'open'; });
    if (!open.length) return Promise.resolve();
    var quotes = {}, has = false;
    open.forEach(function (t) {
      var q = S.quotes[t.code];
      if (q && q.price > 0) { quotes[t.code] = q.price; has = true; }
    });
    if (!has) return Promise.resolve();
    tickTimer = apiPost('/api/paper/tick', {
      quotes: quotes, date: ymd(new Date()), at: Date.now()
    }).then(function (res) {
      if (res && res.ok) {
        S.trades = (res.trades || []).map(fromServer);
        saveLocal();
        S.quoteAt = Date.now();
        render();
      }
    }).catch(function () { /* 离线就只显示本地价 */ }).then(function () {
      tickTimer = null;
    });
    return tickTimer;
  }

  /* 拉一次最新报价并让服务端执行止损/止盈纪律 */
  function syncQuotes() {
    var open = S.trades.filter(function (t) { return t.status === 'open'; });
    if (!open.length) { S.quoteAt = Date.now(); render(); return Promise.resolve(); }
    var codes = open.map(function (t) { return t.code; });
    return fetchQuotes(codes).then(function (map) {
      Object.keys(map).forEach(function (c) { S.quotes[c] = map[c]; });
      S.quoteAt = Date.now();
      return tick();
    }).catch(function () {
      return tick();
    }).then(function () { render(); });
  }

  function priceOf(t) {
    var q = S.quotes[t.code];
    if (q && q.price > 0) return q.price;
    if (num(t.curPrice) > 0) return num(t.curPrice);
    return num(t.buyPrice);
  }

  /* ---------------- 统计 ---------------- */
  function stats() {
    var open = [], closed = [];
    S.trades.forEach(function (t) { (t.status === 'open' ? open : closed).push(t); });

    var cost = 0, mv = 0, floatPnl = 0, dayPnl = 0;
    open.forEach(function (t) {
      var cur = priceOf(t);
      t._cur = cur;
      t._ret = (cur / t.buyPrice - 1) * 100;
      t._pnl = (cur - t.buyPrice) * t.shares;
      t._days = tradingDays(t.buyDate);
      cost += t.buyPrice * t.shares;
      mv += cur * t.shares;
      floatPnl += t._pnl;
      var q = S.quotes[t.code];
      if (q && isFinite(q.pct)) dayPnl += q.pct / 100 * cur * t.shares;
    });

    var realized = 0, wins = 0, winSum = 0, lossSum = 0, lossCnt = 0, holdSum = 0, best = null, worst = null;
    closed.forEach(function (t) {
      var r = num(t.result), p = num(t.pnl);
      t._ret = r; t._pnl = p;
      t._days = tradingDays(t.buyDate, t.closeDate);
      realized += p;
      holdSum += t._days;
      if (r > 0) { wins++; winSum += r; }
      else if (r < 0) { lossCnt++; lossSum += Math.abs(r); }
      if (!best || r > best._ret) best = t;
      if (!worst || r < worst._ret) worst = t;
    });

    return {
      open: open, closed: closed,
      cost: cost, mv: mv, floatPnl: floatPnl,
      floatRet: cost > 0 ? floatPnl / cost * 100 : 0,
      dayPnl: dayPnl,
      realized: realized,
      total: floatPnl + realized,
      winRate: closed.length ? wins / closed.length * 100 : null,
      avgWin: wins ? winSum / wins : null,
      avgLoss: lossCnt ? lossSum / lossCnt : null,
      /* 还没有亏损单时盈亏比是「无穷」，显示 ∞ 比 — 更诚实 */
      profitFactor: (winSum && lossSum) ? (winSum / wins) / (lossSum / lossCnt)
        : (winSum && !lossCnt ? Infinity : null),
      avgHold: closed.length ? holdSum / closed.length : null,
      best: best, worst: worst
    };
  }

  /* 纪律预警：接近止损 / 已过目标 / 持有超期 / 掉出今日名单 */
  function alertsOf(st) {
    var out = [];
    st.open.forEach(function (t) {
      var cur = t._cur, stop = num(t.stop), t1 = num(t.t1), t2 = num(t.t2);
      if (stop > 0) {
        var dStop = (cur - stop) / cur * 100;
        if (cur <= stop) out.push({ kind: 'stop', t: t, text: '现价 ' + fx(cur) + ' 已跌破止损 ' + fx(stop) + '，按纪律应离场（下次同步自动平仓）' });
        else if (dStop <= 2.2) out.push({ kind: 'stop', t: t, text: '现价 ' + fx(cur) + ' 距止损 ' + fx(stop) + ' 仅 ' + fx(dStop, 1) + '%，盯紧盘面' });
      }
      if (t2 > 0 && cur >= t2) out.push({ kind: 'goal', t: t, text: '已越过第二目标 ' + fx(t2) + '（' + pct(t._ret) + '），考虑分批止盈' });
      else if (t1 > 0 && cur >= t1) out.push({ kind: 'goal', t: t, text: '已达第一目标 ' + fx(t1) + '（' + pct(t._ret) + '），至少减半仓' });
      var hi = holdUpper(t.hold);
      if (hi && t._days > hi) out.push({ kind: 'time', t: t, text: '已持有 ' + t._days + ' 个交易日，超出建议的 ' + esc(t.hold) + '，逻辑没兑现就换股' });
      /* 「出榜」提醒已移除：选股名单只有十几只三档候选，持仓票大多本就不在其中，
         几乎每笔都会误报「掉出名单」，反而淹没真正的止损/超期提醒。 */
    });
    return out;
  }

  /* ---------------- 骨架 ---------------- */
  function mount() {
    var box = el('v-paper');
    if (!box || S.mounted) return;
    box.innerHTML =
      '<div class="vhead"><h1>虚拟持仓 · 模拟交易台</h1>' +
      '<p class="sub">从选股引擎的候选卡「虚拟买入」开仓，这里统一管理：按最新行情算浮动盈亏、自动执行止损与止盈纪律、' +
      '点开任意一笔就能看到 K 线与买入点标注，需要深挖时一键跳到个股分析。所有记录写在本机 SQLite（ebgap.db），不经过第三方。</p></div>' +
      '<div class="pp-topbar">' +
      '<button class="pp-btn pp-btn-main" id="pp-sync">同步最新报价</button>' +
      '<button class="pp-btn" id="pp-csv">导出 CSV</button>' +
      '<button class="pp-btn pp-btn-ghost pp-btn-danger" id="pp-clear">清空记录</button>' +
      '<span class="pp-note" id="pp-note"><i></i>—</span>' +
      '</div>' +
      '<div class="pp-kpis" id="pp-kpis"></div>' +
      '<div class="pp-alerts" id="pp-alerts"></div>' +
      '<div class="pp-toolbar">' +
      '<div class="pp-seg" id="pp-seg">' +
      '<button data-f="open" class="on">持仓中</button>' +
      '<button data-f="closed">已平仓</button>' +
      '<button data-f="all">全部</button>' +
      '</div>' +
      '<input class="pp-search" id="pp-q" placeholder="搜索名称 / 代码 / 行业">' +
      '<select id="pp-sort">' +
      '<option value="ret">按盈亏% 排</option>' +
      '<option value="pnl">按盈亏额 排</option>' +
      '<option value="days">按持有天数 排</option>' +
      '<option value="buy">按买入时间 排</option>' +
      '<option value="ind">按行业 排</option>' +
      '</select>' +
      '<span class="pp-count" id="pp-count">—</span>' +
      '</div>' +
      '<div id="pp-table"></div>' +
      '<div class="pp-cols" id="pp-cols"></div>' +
      '<div id="pp-closed"></div>' +
      '<div class="pp-drawer" id="pp-drawer"></div>';

    el('pp-sync').addEventListener('click', function () {
      var b = this;
      b.disabled = true; b.textContent = '同步中…';
      syncQuotes().then(function () {
        b.disabled = false; b.textContent = '同步最新报价';
        toast('报价已同步，纪律已执行');
      });
    });
    el('pp-csv').addEventListener('click', exportCsv);
    el('pp-clear').addEventListener('click', clearAll);

    el('pp-seg').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      S.filter = b.dataset.f;
      this.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x.dataset.f === S.filter); });
      render();
    });
    var q = el('pp-q');
    q.addEventListener('input', function () { S.q = this.value.trim(); renderTableOnly(); });
    el('pp-sort').addEventListener('change', function () {
      S.sort = { k: this.value, dir: this.value === 'buy' ? -1 : -1 };
      renderTableOnly();
    });

    /* 行内操作 + 点行打开抽屉（事件委托，避免每次渲染重复绑定） */
    box.addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (act) {
        e.stopPropagation();
        onAction(act.dataset.act, act.dataset.id, act.dataset.code);
        return;
      }
      var tr = e.target.closest('tr[data-id]');
      if (tr) openDrawer(+tr.dataset.id);
    });

    /* 抽屉：Esc 关闭、点遮罩关闭 */
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && S.drawerId) closeDrawer();
    });

    S.mounted = true;
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    mount();
    var st = stats();
    renderNote(st);
    renderKpis(st);
    renderAlerts(st);
    renderTableOnly(st);
    renderCols(st);
    renderClosed(st);
    /* 抽屉开着时：若这笔已被自动平仓（tick 触发止损/止盈），整块重建，
       否则会残留「调整计划 / 按现价平仓」表单，点了没反应。
       仍在持仓中则只刷新报价行，避免冲掉正在编辑的止损/备注。 */
    if (S.drawerId) {
      var d = byId(S.drawerId);
      if (!d || d.status !== 'open') refreshDrawer();
      else refreshDrawerQuote();
    }
  }

  function renderNote(st) {
    var box = el('pp-note');
    if (!box) return;
    var age = S.quoteAt ? Math.round((Date.now() - S.quoteAt) / 1000) : null;
    var text;
    if (S.error) text = '数据库未连接（' + S.error + '），当前显示浏览器缓存';
    else if (!S.trades.length) text = '还没有记录';
    else text = '报价' + (age == null ? '—' : age < 90 ? '刚刚同步' : Math.round(age / 60) + ' 分钟前同步') +
      ' · 自动同步间隔 ' + (AUTO_MS / 1000) + ' 秒';
    box.innerHTML = '<i></i>' + esc(text);
    box.classList.toggle('stale', !!(S.error || (age != null && age > AUTO_MS * 3 / 1000)));
  }

  function renderKpis(st) {
    var box = el('pp-kpis');
    if (!box) return;
    var winTxt = st.winRate == null ? '—' : fx(st.winRate, 0) + '%';
    var pfTxt = st.profitFactor == null ? '—' : (isFinite(st.profitFactor) ? fx(st.profitFactor, 2) : '∞');
    box.innerHTML =
      kpi('持仓市值', money(st.mv), st.open.length + ' 笔 · 成本 ' + money(st.cost), '') +
      kpi('浮动盈亏', money(st.floatPnl), '收益率 ' + pct(st.floatRet) + ' · 今日 ' + money(st.dayPnl), st.floatPnl > 0 ? 'up' : st.floatPnl < 0 ? 'down' : '') +
      kpi('已实现盈亏', money(st.realized), st.closed.length + ' 笔已平仓', st.realized > 0 ? 'up' : st.realized < 0 ? 'down' : '') +
      kpi('总盈亏', money(st.total), '浮动 + 已实现', st.total > 0 ? 'up' : st.total < 0 ? 'down' : '') +
      kpi('胜率 / 盈亏比', winTxt, '盈亏比 ' + pfTxt + (st.avgHold ? ' · 均持 ' + fx(st.avgHold, 0) + ' 日' : ''), '');

    function kpi(label, val, sub, tone) {
      return '<div class="pp-kpi ' + tone + '"><i>' + label + '</i>' +
        '<b class="' + tone + '">' + val + '</b><em>' + esc(sub) + '</em></div>';
    }
  }

  function renderAlerts(st) {
    var box = el('pp-alerts');
    if (!box) return;
    var list = alertsOf(st);
    if (!list.length) { box.innerHTML = ''; return; }
    box.innerHTML = list.slice(0, 6).map(function (a) {
      var lab = a.kind === 'stop' ? '止损' : a.kind === 'goal' ? '目标' : a.kind === 'time' ? '超期' : '出榜';
      return '<div class="pp-alert ' + (a.kind === 'stop' ? 'stop' : a.kind === 'goal' ? 'goal' : '') + '">' +
        '<span class="pp-alert-lab">' + lab + '</span>' +
        '<b>' + esc(a.t.name) + '</b><span>' + esc(a.text) + '</span>' +
        '<button class="pp-icon-btn" data-act="open" data-id="' + a.t.id + '">看图</button>' +
        '</div>';
    }).join('');
  }

  function rowsOf(st) {
    var rows = S.filter === 'open' ? st.open.slice()
      : S.filter === 'closed' ? st.closed.slice()
        : st.open.concat(st.closed);
    if (S.q) {
      var q = S.q.toLowerCase();
      rows = rows.filter(function (t) {
        return (t.name || '').toLowerCase().indexOf(q) >= 0 ||
          String(t.code).indexOf(q) >= 0 ||
          (t.ind || '').toLowerCase().indexOf(q) >= 0;
      });
    }
    var k = S.sort.k, dir = S.sort.dir;
    rows.sort(function (a, b) {
      var x, y;
      if (k === 'ret') { x = num(a._ret); y = num(b._ret); }
      else if (k === 'pnl') { x = num(a._pnl); y = num(b._pnl); }
      else if (k === 'days') { x = a._days || 0; y = b._days || 0; }
      else if (k === 'buy') { x = a.buyAt || 0; y = b.buyAt || 0; }
      else { return String(a.ind || '').localeCompare(String(b.ind || '')); }
      return (x - y) * dir;
    });
    return rows;
  }

  function renderTableOnly(st) {
    st = st || stats();
    var box = el('pp-table');
    var cnt = el('pp-count');
    if (!box) return;
    var rows = rowsOf(st);
    if (cnt) cnt.textContent = rows.length + ' / ' + S.trades.length + ' 条';

    if (!S.trades.length) {
      box.innerHTML = '<div class="pp-empty"><b>还没有模拟持仓。</b><br>' +
        '去「选股引擎」挑一只，点候选卡上的「虚拟买入」就会按建议仓位开仓，' +
        '之后在这里看浮动盈亏、K 线与买入点。<br>' +
        '<button class="pp-btn" data-act="go-pick">去选股引擎 →</button></div>';
      return;
    }
    if (!rows.length) {
      box.innerHTML = '<div class="pp-empty">这个筛选下没有记录，换个条件看看。</div>';
      return;
    }

    var head = '<div class="pp-tablewrap"><table class="pp-table"><thead><tr>' +
      '<th>标的</th><th class="num">买入</th><th class="num">现价</th><th class="num">盈亏</th>' +
      '<th class="num">持有</th><th class="num">距止损</th><th class="num">距目标</th><th>状态</th><th class="num">操作</th>' +
      '</tr></thead><tbody>';

    var body = rows.map(function (t) {
      var open = t.status === 'open';
      var cur = open ? priceOf(t) : num(t.closePrice);
      var ret = open ? (cur / t.buyPrice - 1) * 100 : num(t.result);
      var pnl = open ? (cur - t.buyPrice) * t.shares : num(t.pnl);
      var days = t._days;
      var stop = num(t.stop), t1 = num(t.t1);
      var dStop = open && stop > 0 ? (cur - stop) / cur * 100 : null;
      var dGoal = open && t1 > 0 ? (t1 - cur) / cur * 100 : null;
      var rowCls = '';
      if (open && dStop != null && dStop <= 2.2) rowCls = ' stop-row';
      else if (open && holdUpper(t.hold) && days > holdUpper(t.hold)) rowCls = ' warn-row';

      var flags = [];
      if (open && stop > 0 && cur <= stop) flags.push('<span class="pp-flag pp-flag-stop">破止损</span>');
      else if (open && dStop != null && dStop <= 2.2) flags.push('<span class="pp-flag pp-flag-stop">临界</span>');
      if (open && t1 > 0 && cur >= t1) flags.push('<span class="pp-flag pp-flag-goal">达目标</span>');
      if (open && holdUpper(t.hold) && days > holdUpper(t.hold)) flags.push('<span class="pp-flag pp-flag-time">超期</span>');
      if (!open) flags.push('<span class="pp-flag pp-flag-out">' + esc(t.closeReason || '已平仓') + '</span>');

      return '<tr class="' + rowCls + '" data-id="' + t.id + '">' +
        '<td><div class="pp-name"><b>' + esc(t.name) +
        (t.hz ? '<span class="pp-badge pp-badge-' + t.hz.toLowerCase() + '">' + ({ S: '短', M: '中', L: '长' }[t.hz] || t.hz) + '</span>' : '') +
        '</b><span>' + esc(t.code) + (t.ind ? ' · ' + esc(t.ind) : '') + '</span></div></td>' +
        '<td class="num">' + fx(t.buyPrice) + '<span class="pp-sub">' + esc(t.buyDate || '') + '</span></td>' +
        '<td class="num">' + fx(cur) + '</td>' +
        '<td class="num"><b class="' + signedCls(ret) + '">' + pct(ret) + '</b><span class="pp-sub">' + money(pnl) + '</span></td>' +
        '<td class="num">' + days + ' 日<span class="pp-sub">' + esc(t.hold || '—') + '</span></td>' +
        '<td class="num">' + (dStop == null ? '—' : fx(dStop, 1) + '%') + '</td>' +
        '<td class="num">' + (dGoal == null ? '—' : fx(dGoal, 1) + '%') + '</td>' +
        '<td>' + (flags.join(' ') || '<span class="pp-flag pp-flag-out">正常</span>') + '</td>' +
        '<td class="num"><div class="pp-row-act">' +
        '<button class="pp-icon-btn" data-act="open" data-id="' + t.id + '">图</button>' +
        '<button class="pp-icon-btn" data-act="analyze" data-id="' + t.id + '">分析</button>' +
        (open ? '<button class="pp-icon-btn sell" data-act="sell" data-id="' + t.id + '">平仓</button>' : '') +
        '</div></td></tr>';
    }).join('');

    box.innerHTML = head + body + '</tbody></table></div>';
  }

  function renderCols(st) {
    var box = el('pp-cols');
    if (!box) return;
    /* 每次重建面板都会换掉 #pp-eqchart 这个 DOM，旧实例必须先销毁，
       否则 setOption 画在一张已经脱离文档的画布上，页面就是空白 */
    if (S._eqChart) { try { S._eqChart.dispose(); } catch (e) { /* ignore */ } S._eqChart = null; }
    if (!st.open.length) { box.innerHTML = ''; return; }

    /* 行业分布：按持仓市值占比 */
    var byInd = {};
    st.open.forEach(function (t) {
      var k = t.ind || '未分类';
      byInd[k] = byInd[k] || { mv: 0, n: 0 };
      byInd[k].mv += priceOf(t) * t.shares;
      byInd[k].n++;
    });
    var total = st.mv || 1;
    var indRows = Object.keys(byInd).sort(function (a, b) { return byInd[b].mv - byInd[a].mv; })
      .slice(0, 6).map(function (k) {
        var p = byInd[k].mv / total * 100;
        return '<div class="pp-indrow"><div class="pp-indname">' +
          '<em>' + esc(k) + ' · ' + byInd[k].n + ' 笔</em>' +
          '<i><b style="width:' + p.toFixed(1) + '%"></b></i></div>' +
          '<span>' + p.toFixed(1) + '%</span></div>';
      }).join('');

    box.innerHTML =
      '<div class="pp-panel"><div class="pp-panel-h"><h3>行业分布</h3><span>按持仓市值</span></div>' +
      '<div class="pp-indbar">' + indRows + '</div></div>' +
      '<div class="pp-panel"><div class="pp-panel-h"><h3>已实现资金曲线</h3><span>按平仓日累计</span></div>' +
      '<div class="pp-chart" id="pp-eqchart"></div></div>';

    drawEquity(st);
  }

  function drawEquity(st) {
    var host = el('pp-eqchart');
    if (!host || !window.echarts) return;
    if (!st.closed.length) {
      host.innerHTML = '<div class="pp-loading">还没有平仓记录，曲线在平掉第一笔后出现</div>';
      return;
    }
    var pts = st.closed.slice().sort(function (a, b) {
      return String(a.closeDate || '').localeCompare(String(b.closeDate || ''));
    });
    /* 同一天平掉多笔就合并成一个点，否则横轴会出现重复日期 */
    var byDay = [], acc = 0;
    pts.forEach(function (t) {
      acc += num(t.pnl);
      var d = String(t.closeDate || '').slice(5) || '—';
      if (byDay.length && byDay[byDay.length - 1][0] === d) byDay[byDay.length - 1][1] = Math.round(acc);
      else byDay.push([d, Math.round(acc)]);
    });
    /* 补一个 0 起点：只有一天有平仓时，单点画不出线，看起来像坏了 */
    var data = [['起始', 0]].concat(byDay);
    if (!S._eqChart) S._eqChart = echarts.init(host, null, { renderer: 'canvas' });
    S._eqChart.resize();
    S._eqChart.setOption({
      animationDuration: 400,
      grid: { left: 46, right: 12, top: 14, bottom: 24 },
      tooltip: {
        trigger: 'axis', backgroundColor: 'rgba(10,16,28,.94)', borderColor: '#1d2a41',
        textStyle: { color: '#e8edf7', fontSize: 11 },
        formatter: function (a) { return a[0].axisValue + '<br/>累计 ' + money(a[0].data[1]); }
      },
      xAxis: {
        type: 'category', data: data.map(function (d) { return d[0]; }),
        axisLine: { lineStyle: { color: '#1d2a41' } },
        axisLabel: { color: '#8493af', fontSize: 10 },
        axisTick: { show: false }
      },
      yAxis: {
        type: 'value', scale: true,
        splitLine: { lineStyle: { color: 'rgba(29,42,65,.7)' } },
        axisLabel: { color: '#8493af', fontSize: 10 }
      },
      series: [{
        type: 'line', smooth: true, symbol: 'circle', symbolSize: 5,
        data: data.map(function (d) { return d[1]; }),
        lineStyle: { width: 2, color: '#38bdf8' },
        itemStyle: { color: '#38bdf8' },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [{ offset: 0, color: 'rgba(56,189,248,.28)' }, { offset: 1, color: 'rgba(56,189,248,0)' }]
          }
        }
      }]
    }, true);
  }

  function renderClosed(st) {
    var box = el('pp-closed');
    if (!box) return;
    if (!st.closed.length) { box.innerHTML = ''; return; }

    var best = st.best, worst = st.worst;
    box.innerHTML =
      '<div class="pp-closed-h"><h3>已平仓复盘</h3>' +
      '<span>' + st.closed.length + ' 笔 · 胜率 ' + (st.winRate == null ? '—' : fx(st.winRate, 0) + '%') +
      ' · 均盈 ' + (st.avgWin == null ? '—' : pct(st.avgWin, 1)) +
      ' · 均亏 ' + (st.avgLoss == null ? '—' : '-' + fx(st.avgLoss, 1) + '%') +
      ' · 盈亏比 ' + (st.profitFactor == null ? '—' : (isFinite(st.profitFactor) ? fx(st.profitFactor, 2) : '∞')) +
      ' · 最佳 ' + (best ? esc(best.name) + ' ' + pct(best._ret, 1) : '—') +
      '</span></div>' +
      '<div class="pp-tablewrap"><table class="pp-table"><thead><tr>' +
      '<th>标的</th><th class="num">买入 → 卖出</th><th class="num">持有</th>' +
      '<th class="num">收益</th><th class="num">金额</th><th>原因</th><th class="num">操作</th></tr></thead><tbody>' +
      st.closed.slice().sort(function (a, b) { return (b.closeAt || 0) - (a.closeAt || 0); }).map(function (t) {
        return '<tr data-id="' + t.id + '">' +
          '<td><div class="pp-name"><b>' + esc(t.name) +
          (t.hz ? '<span class="pp-badge pp-badge-' + t.hz.toLowerCase() + '">' + ({ S: '短', M: '中', L: '长' }[t.hz] || t.hz) + '</span>' : '') +
          '</b><span>' + esc(t.code) + '</span></div></td>' +
          '<td class="num">' + fx(t.buyPrice) + ' → ' + fx(t.closePrice) +
          '<span class="pp-sub">' + esc(t.buyDate || '') + ' → ' + esc(t.closeDate || '') + '</span></td>' +
          '<td class="num">' + (t._days || 0) + ' 日</td>' +
          '<td class="num"><b class="' + signedCls(t._ret) + '">' + pct(t._ret) + '</b></td>' +
          '<td class="num ' + signedCls(t._pnl) + '">' + money(t._pnl) + '</td>' +
          '<td><span class="pp-flag ' + (String(t.closeReason || '').indexOf('止损') >= 0 ? 'pp-flag-stop' :
            String(t.closeReason || '').indexOf('目标') >= 0 ? 'pp-flag-goal' : 'pp-flag-out') + '">' +
          esc(t.closeReason || '手动平仓') + '</span></td>' +
          '<td class="num"><div class="pp-row-act">' +
          '<button class="pp-icon-btn" data-act="open" data-id="' + t.id + '">图</button>' +
          '<button class="pp-icon-btn" data-act="analyze" data-id="' + t.id + '">分析</button>' +
          '</div></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  /* ---------------- 操作 ---------------- */
  function byId(id) {
    id = +id;
    for (var i = 0; i < S.trades.length; i++) if (S.trades[i].id === id) return S.trades[i];
    return null;
  }

  function onAction(act, id, code) {
    if (act === 'go-pick') {
      if (window.EB_APP && EB_APP.show) EB_APP.show('pick');
      else { var n = document.querySelector('.navi[data-v="pick"]'); if (n) n.click(); }
      return;
    }
    if (act === 'close-drawer') { closeDrawer(); return; }
    if (act === 'analyze-code') { goAnalyze(code); return; }
    var t = byId(id);
    if (!t) return;
    if (act === 'open') openDrawer(t.id);
    else if (act === 'analyze') goAnalyze(t.code);
    else if (act === 'sell') closeTrade(t);
  }

  function goAnalyze(code) {
    closeDrawer();
    if (window.EB_APP && EB_APP.show) EB_APP.show('stock');
    else { var n = document.querySelector('.navi[data-v="stock"]'); if (n) n.click(); }
    setTimeout(function () {
      if (window.EB_STOCK && EB_STOCK.runCode) EB_STOCK.runCode(code);
    }, 120);
  }

  function dispatchToPicker() {
    if (window.EB_PICKER && typeof EB_PICKER.render === 'function') EB_PICKER.render();
  }

  function closeTrade(t) {
    if (!t || t.status !== 'open') return;
    var cur = priceOf(t);
    var ret = (cur / t.buyPrice - 1) * 100;
    confirmDialog('按现价 ' + fx(cur) + ' 平掉「' + t.name + '」这笔模拟仓？\n' +
      '本笔盈亏 ' + pct(ret) + '（' + money((cur - t.buyPrice) * t.shares) + '）\n\n' +
      '这是虚拟交易，不涉及真实资金。', '确认平仓').then(function (yes) {
      if (!yes) return;
      doClose(t, cur, ret);
    });
  }

  function doClose(t, cur, ret) {
    var p = apiPost('/api/paper/close', {
      id: t.id, price: cur, reason: '手动平仓',
      close_date: ymd(new Date()), close_at: Date.now()
    });
    p.then(function (res) {
      if (res && res.ok && res.trade) {
        var idx = S.trades.findIndex(function (x) { return x.id === t.id; });
        if (idx >= 0) S.trades[idx] = fromServer(res.trade);
      } else {
        // 服务端没确认就本地标记，避免看起来「点了没反应」
        t.status = 'closed'; t.closePrice = cur; t.closeDate = ymd(new Date());
        t.closeReason = '手动平仓'; t.result = ret; t.pnl = (cur - t.buyPrice) * t.shares;
      }
      saveLocal(); render(); dispatchToPicker();
      toast('已平仓：' + t.name + ' ' + pct(ret));
      if (S.drawerId === t.id) closeDrawer();
    }).catch(function () {
      t.status = 'closed'; t.closePrice = cur; t.closeDate = ymd(new Date());
      t.closeReason = '手动平仓（离线）'; t.result = ret; t.pnl = (cur - t.buyPrice) * t.shares;
      saveLocal(); render(); dispatchToPicker();
      toast('本地已平仓（服务未连接）');
      if (S.drawerId === t.id) closeDrawer();
    });
  }

  function savePlan(t, fields) {
    return apiPost('/api/paper/update', Object.assign({ id: t.id }, fields)).then(function (res) {
      if (!res || !res.ok) throw new Error((res && res.error) || '保存失败');
      var idx = S.trades.findIndex(function (x) { return x.id === t.id; });
      if (idx >= 0) S.trades[idx] = fromServer(res.trade);
      saveLocal(); render();
      refreshDrawer();
      toast('计划已更新');
      return true;
    }).catch(function (e) {
      toast('保存失败：' + (e && e.message), 'bad');
      return false;
    });
  }

  function clearAll() {
    confirmDialog('清空全部模拟持仓与历史记录？数据库中的记录会一并删除，此操作不可恢复。', '确认清空')
      .then(function (yes) {
        if (!yes) return;
        var btn = el('pp-clear');
        btn.disabled = true; btn.textContent = '清空中…';
        apiPost('/api/paper/clear', {}).then(function (res) {
          btn.disabled = false; btn.textContent = '清空记录';
          if (!res || !res.ok) { toast('清空失败：数据库未确认', 'bad'); return; }
          S.trades = []; saveLocal(); render(); dispatchToPicker();
          toast('记录已清空');
        }).catch(function () {
          btn.disabled = false; btn.textContent = '清空记录';
          toast('清空失败：无法连接本地数据库', 'bad');
        });
      });
  }

  function exportCsv() {
    if (!S.trades.length) { toast('还没有可导出的记录', 'bad'); return; }
    var st = stats();
    var head = ['状态', '档位', '代码', '名称', '行业', '买入价', '买入日', '现价/卖出价', '股数', '成本', '盈亏额', '收益率%', '持有交易日', '建议持有', '止损', '目标T1', '目标T2', '平仓日', '平仓原因', '备注'];
    var lines = [head.join(',')];
    st.open.concat(st.closed).forEach(function (t) {
      var cur = t.status === 'open' ? priceOf(t) : num(t.closePrice);
      var ret = t.status === 'open' ? (cur / t.buyPrice - 1) * 100 : num(t.result);
      var pnl = t.status === 'open' ? (cur - t.buyPrice) * t.shares : num(t.pnl);
      lines.push([
        t.status === 'open' ? '持仓中' : '已平仓', t.hz || '', t.code, t.name, t.ind || '',
        fx(t.buyPrice), t.buyDate || '', fx(cur), t.shares || 0,
        fx(t.buyPrice * t.shares, 0), fx(pnl, 0), fx(ret, 2), t._days || 0,
        t.hold || '', fx(t.stop), fx(t.t1), fx(t.t2), t.closeDate || '', t.closeReason || '', t.note || ''
      ].map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(','));
    });
    var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'paper-trades-' + ymd(new Date()) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
    toast('已导出 ' + (st.open.length + st.closed.length) + ' 条记录');
  }

  /* ---------------- 详情抽屉 ---------------- */
  function openDrawer(id) {
    var t = byId(id);
    if (!t) return;
    S.drawerId = id;
    var box = el('pp-drawer');
    box.className = 'pp-drawer on';
    box.innerHTML = '<div class="pp-mask" data-act="close-drawer"></div>' +
      '<div class="pp-drawer-panel" role="dialog" aria-modal="true">' +
      '<div class="pp-dhead"><div class="pp-ttl"><b>' + esc(t.name) +
      (t.hz ? ' <span class="pp-badge pp-badge-' + t.hz.toLowerCase() + '">' + ({ S: '短线', M: '中线', L: '长线' }[t.hz] || t.hz) + '</span>' : '') +
      '</b><span>' + esc(t.code) + (t.ind ? ' · ' + esc(t.ind) : '') + ' · 买入 ' + fx(t.buyPrice) + '（' + esc(t.buyDate || '—') + '）</span></div>' +
      '<button class="pp-panel-x" data-act="close-drawer" aria-label="关闭">×</button></div>' +
      '<div class="pp-panel-body" id="pp-body"></div></div>';

    renderDrawerBody(t);
    document.body.style.overflow = 'hidden';
  }

  function closeDrawer() {
    var box = el('pp-drawer');
    if (box) { box.className = 'pp-drawer'; box.innerHTML = ''; }
    if (S.chart) { try { S.chart.dispose(); } catch (e) { /* ignore */ } S.chart = null; }
    S.drawerId = null;
    S.chartCode = null;
    document.body.style.overflow = '';
  }

  function refreshDrawer() {
    var t = byId(S.drawerId);
    if (t) renderDrawerBody(t);
  }

  function refreshDrawerQuote() {
    var t = byId(S.drawerId);
    var host = el('pp-quote');
    if (!t || !host) return;
    var open = t.status === 'open';
    if (!open) return;
    var cur = priceOf(t);
    var ret = (cur / t.buyPrice - 1) * 100;
    var pnl = (cur - t.buyPrice) * t.shares;
    var q = S.quotes[t.code] || {};
    host.innerHTML = '<b class="' + signedCls(ret) + '">' + fx(cur) + '</b>' +
      (isFinite(q.pct) ? '<em class="' + signedCls(q.pct) + '">' + pct(q.pct) + '</em>' : '') +
      '<span class="pp-quote-lab">现价</span>' +
      '<span class="pp-quote-lab">本笔 ' + pct(ret) + ' / ' + money(pnl) + '</span>';
  }

  function renderDrawerBody(t) {
    var host = el('pp-body');
    if (!host) return;
    var open = t.status === 'open';
    var cur = open ? priceOf(t) : num(t.closePrice);
    var ret = open ? (cur / t.buyPrice - 1) * 100 : num(t.result);
    var pnl = open ? (cur - t.buyPrice) * t.shares : num(t.pnl);
    var q = S.quotes[t.code] || {};

    host.innerHTML =
      '<div class="pp-quote" id="pp-quote"><b class="' + signedCls(ret) + '">' + fx(cur) + '</b>' +
      (isFinite(q.pct) && open ? '<em class="' + signedCls(q.pct) + '">' + pct(q.pct) + '</em>' : '') +
      '<span class="pp-quote-lab">' + (open ? '现价' : '卖出价 ' + esc(t.closeDate || '')) + '</span>' +
      '<span class="pp-quote-lab">本笔 ' + pct(ret) + ' / ' + money(pnl) + '</span></div>' +
      '<div class="pp-chart-lg" id="pp-kline"></div>' +
      '<div class="pp-statgrid">' +
      stat('买入价', fx(t.buyPrice)) +
      stat('成本金额', money(t.buyPrice * (t.shares || 0))) +
      stat('持股数', (t.shares || 0) + ' 股') +
      stat('持有交易日', (open ? tradingDays(t.buyDate) : t._days || 0) + ' 日') +
      stat('止损', fx(t.stop)) +
      stat('目标 T1', fx(t.t1)) +
      stat('目标 T2', fx(t.t2)) +
      stat('建议持有', esc(t.hold || '—')) +
      '</div>' +
      (open
        ? '<div class="pp-plan"><div class="pp-plan-h"><b>调整交易计划</b>' +
        '<span class="pp-hint">只改计划，不改买入价与股数</span></div>' +
        '<div class="pp-plan-grid">' +
        field('止损价', 'pp-in-stop', fx(t.stop)) +
        field('目标 T1', 'pp-in-t1', fx(t.t1)) +
        field('目标 T2', 'pp-in-t2', fx(t.t2)) +
        '</div>' +
        '<div class="pp-field" style="margin-top:10px"><label>交易备注</label>' +
        '<textarea id="pp-in-note" placeholder="为什么买、打算怎么卖、当时的判断依据…">' + esc(t.note || '') + '</textarea></div>' +
        '<div class="pp-plan-foot"><span class="pp-hint">改完点保存，服务端会做合理性校验</span>' +
        '<button class="pp-btn pp-btn-sm" data-act="save-plan" data-id="' + t.id + '">保存计划</button></div></div>'
        : '<div class="pp-plan"><div class="pp-plan-h"><b>平仓复盘</b><span class="pp-hint">' + esc(t.closeReason || '') + '</span></div>' +
        '<p style="margin:0;font-size:12.5px;color:var(--ink2)">买入 ' + fx(t.buyPrice) + ' → 卖出 ' + fx(t.closePrice) +
        '，收益 <b class="' + signedCls(t.result) + '">' + pct(t.result) + '</b>（' + money(t.pnl) + '）。' +
        (t.note ? '备注：' + esc(t.note) : '当时没有写备注。') + '</p></div>') +
      '<div class="pp-panel-act">' +
      '<button class="pp-btn" data-act="analyze-code" data-code="' + t.code + '">个股分析 →</button>' +
      (open ? '<button class="pp-btn pp-btn-danger" data-act="sell" data-id="' + t.id + '">按现价平仓</button>' : '') +
      '<button class="pp-btn pp-btn-ghost" data-act="close-drawer">关闭</button>' +
      '</div>';

    /* 卖出 / 个股分析 / 关闭 走 #v-paper 上的事件委托，这里不重复绑定，
       否则一次点击会弹两次 confirm。只有保存计划需要读输入框，单独绑。 */
    var saveBtn = host.querySelector('[data-act="save-plan"]');
    if (saveBtn) saveBtn.addEventListener('click', function () {
      var stop = parseFloat(el('pp-in-stop').value);
      var t1 = parseFloat(el('pp-in-t1').value);
      var t2 = parseFloat(el('pp-in-t2').value);
      var note = el('pp-in-note').value;
      var fields = { note: note };
      if (isFinite(stop) && stop > 0) fields.stop = stop;
      if (isFinite(t1) && t1 > 0) fields.t1 = t1;
      if (isFinite(t2) && t2 > 0) fields.t2 = t2;
      saveBtn.disabled = true;
      savePlan(t, fields).then(function () { saveBtn.disabled = false; });
    });

    drawKline(t);

    function stat(label, val) {
      return '<div class="pp-stat"><i>' + label + '</i><b>' + val + '</b></div>';
    }
    function field(label, id, val) {
      return '<div class="pp-field"><label>' + label + '</label>' +
        '<input id="' + id + '" type="number" step="0.01" value="' + (num(val) > 0 ? val : '') + '"></div>';
    }
  }

  /* K 线：买入点、止损/目标线、建议买区 */
  function drawKline(t) {
    var host = el('pp-kline');
    if (!host || !window.echarts) return;
    /* 同一只票并且画布还挂在当前节点上才复用；每次重建抽屉都会换 DOM，
       复用旧实例会得到一张空白图 */
    var reuse = S.chart && S.chartCode === t.code && S.chart.getDom() && S.chart.getDom().parentNode === host;
    if (reuse) { S.chart.resize(); return; }
    if (S.chart) { try { S.chart.dispose(); } catch (e) { /* ignore */ } S.chart = null; }
    host.innerHTML = '<div class="pp-loading"><span class="pp-spin"></span>正在拉取历史行情…</div>';

    fetchKline(t.code, 240).then(function (kl) {
      if (!kl.length) throw new Error('历史行情为空');
      /* 只画最近 120 根，但保证买入日落在窗口内 */
      var end = kl.length;
      var buyIdx = -1;
      for (var i = 0; i < kl.length; i++) if (kl[i].d >= String(t.buyDate || '')) { buyIdx = i; break; }
      var start = Math.max(0, Math.min(end - 120, buyIdx >= 0 ? buyIdx - 30 : end - 120));
      var seg = kl.slice(start);
      var dates = seg.map(function (x) { return x.d; });
      var ohlc = seg.map(function (x) { return [x.o, x.c, x.l, x.h]; });
      var vols = seg.map(function (x) { return x.v; });
      var idx = buyIdx >= 0 ? buyIdx - start : -1;

      /* 纵轴范围要把止损/目标价也包进来，否则 T2 之类画在图外看不见 */
      var lo = Infinity, hi = -Infinity;
      seg.forEach(function (x) {
        if (x.l < lo) lo = x.l;
        if (x.h > hi) hi = x.h;
      });
      [t.stop, t.t1, t.t2, t.buyPrice].forEach(function (v) {
        v = num(v);
        if (v > 0) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      });
      var pad = (hi - lo) * 0.06 || 1;

      host.innerHTML = '';
      S.chart = echarts.init(host, null, { renderer: 'canvas' });
      S.chartCode = t.code;

      /* 标签左右分开摆：止损在左，目标在右。
         四条线常常只差几个价位，全堆在同一侧会互相压住看不清。 */
      var marks = [];
      if (num(t.stop) > 0) marks.push({ yAxis: num(t.stop), color: '#ff4d6d', lab: '止损 ' + fx(t.stop), pos: 'insideStartTop' });
      if (num(t.t1) > 0) marks.push({ yAxis: num(t.t1), color: '#00e5a0', lab: 'T1 ' + fx(t.t1), pos: 'insideStartTop' });
      /* 第二目标只在图上画线不写字：和 T1 常只差几个价位，两个标签会叠在一起 */
      if (num(t.t2) > 0) marks.push({ yAxis: num(t.t2), color: '#5eead4', lab: null, pos: 'insideEndTop' });
      /* 买入线不写字：图上的琥珀色 pin 已经标了「买入」，再写一遍只会压住止损标签 */
      marks.push({ yAxis: num(t.buyPrice), color: '#f5b942', lab: null, pos: 'insideStartTop' });

      S.chart.setOption({
        animation: false,
        backgroundColor: 'transparent',
        grid: [
          { left: 8, right: 58, top: 16, height: 214 },
          { left: 8, right: 58, top: 246, height: 52 }
        ],
        axisPointer: { link: [{ xAxisIndex: 'all' }], lineStyle: { color: 'rgba(56,189,248,.4)' } },
        tooltip: {
          trigger: 'axis', backgroundColor: 'rgba(10,16,28,.94)', borderColor: '#1d2a41',
          textStyle: { color: '#e8edf7', fontSize: 11 },
          formatter: function (a) {
            var k = a.find(function (x) { return x.seriesName === 'K线'; });
            if (!k) return '';
            var v = k.data;
            return k.axisValue + '<br/>开 ' + fx(v[1]) + ' 收 ' + fx(v[2]) + '<br/>低 ' + fx(v[3]) + ' 高 ' + fx(v[4]);
          }
        },
        xAxis: [
          {
            type: 'category', data: dates, boundaryGap: true,
            axisLine: { lineStyle: { color: '#1d2a41' } },
            axisLabel: { color: '#8493af', fontSize: 10 },
            axisTick: { show: false }, splitLine: { show: false }
          },
          {
            type: 'category', data: dates, gridIndex: 1, boundaryGap: true,
            axisLine: { lineStyle: { color: '#1d2a41' } },
            axisLabel: { show: false }, axisTick: { show: false }
          }
        ],
        yAxis: [
          {
            position: 'right',
            min: +(lo - pad).toFixed(2), max: +(hi + pad).toFixed(2),
            splitLine: { lineStyle: { color: 'rgba(29,42,65,.6)' } },
            axisLabel: { color: '#8493af', fontSize: 10 },
            axisLine: { show: false }
          },
          { scale: true, gridIndex: 1, position: 'right', splitNumber: 2, axisLabel: { show: false }, splitLine: { show: false }, axisLine: { show: false } }
        ],
        series: [
          {
            name: 'K线', type: 'candlestick', data: ohlc,
            itemStyle: {
              color: '#ff4d6d', color0: '#00e5a0',
              borderColor: '#ff4d6d', borderColor0: '#00e5a0'
            },
            markLine: {
              symbol: ['none', 'none'], silent: true,
              data: marks.map(function (m) {
                return {
                  yAxis: m.yAxis,
                  lineStyle: { color: m.color, type: 'dashed', width: 1, opacity: .9 },
                  label: {
                    show: !!m.lab,
                    formatter: m.lab || '',
                    position: m.pos,
                    color: m.color,
                    fontSize: 10,
                    distance: 4,
                    padding: [2, 5],
                    borderRadius: 3,
                    backgroundColor: 'rgba(7,11,20,.78)'
                  }
                };
              })
            },
            markPoint: idx >= 0 ? {
              symbol: 'pin', symbolSize: 44, symbolOffset: [0, -4],
              itemStyle: { color: '#f5b942' },
              label: { formatter: '买入', color: '#2a1c02', fontSize: 10, fontWeight: 'bold' },
              data: [{ coord: [idx, num(t.buyPrice)], value: '买入' }]
            } : undefined,
            markArea: (num(t.suggestLow) > 0 && num(t.suggestHigh) > 0) ? {
              silent: true,
              itemStyle: { color: 'rgba(56,189,248,.06)' },
              label: { show: true, position: 'insideTopLeft', formatter: '建议买区', color: 'rgba(125,211,252,.65)', fontSize: 10 },
              data: [[{ yAxis: num(t.suggestLow) }, { yAxis: num(t.suggestHigh) }]]
            } : undefined
          },
          {
            name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: vols,
            itemStyle: {
              color: function (p) {
                var v = ohlc[p.dataIndex];
                return v && v[1] >= v[0] ? 'rgba(255,77,109,.45)' : 'rgba(0,229,160,.45)';
              }
            }
          }
        ]
      }, true);
    }).catch(function (e) {
      host.innerHTML = '<div class="pp-loading">历史行情获取失败：' + esc(e && e.message) + '</div>';
    });
  }

  function fetchKline(code, days) {
    var sid = secidOf(code);
    if (!sid) return Promise.reject(new Error('不支持的代码'));
    var u = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + sid +
      '&klt=101&fqt=1&beg=19900101&end=20500101&lmt=' + (days || 240) +
      '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57';
    return fetch('/api/stock/em?u=' + encodeURIComponent(u), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var kl = (j && j.data && j.data.klines) || [];
        return kl.map(function (line) {
          var a = line.split(',');
          return { d: a[0], o: +a[1], c: +a[2], h: +a[3], l: +a[4], v: +a[5] };
        });
      });
  }

  /* ---------------- 开仓（供选股引擎调用） ---------------- */
  function findOpen(code) {
    for (var i = 0; i < S.trades.length; i++) {
      if (S.trades[i].status === 'open' && S.trades[i].code === code) return S.trades[i];
    }
    return null;
  }

  function buy(pick, opts) {
    opts = opts || {};
    if (!pick || !pick.plan || !(pick.price > 0)) return;
    if (findOpen(pick.code)) { toast('「' + pick.name + '」已有持仓，不重复开仓', 'bad'); return; }

    /* 固定每次买入 100 手（1 手 = 100 股，即 10000 股）。
       不再按建议仓位算股数，也不管买得起买不起——虚拟交易，统一口径便于横向比较。 */
    var shares = 100 * 100;
    var pos = pick.plan.pos || 10;

    var t = {
      id: -Date.now(), code: pick.code, name: pick.name, ind: pick.ind,
      buyPrice: pick.price, buyDate: opts.quoteDate || ymd(new Date()), buyAt: Date.now(),
      shares: shares, amt: shares * pick.price,
      suggestLow: pick.plan.buyLow, suggestHigh: pick.plan.buyHigh,
      stop: pick.plan.stop, t1: pick.plan.t1, t2: pick.plan.t2, hold: pick.plan.hold,
      posPct: pos, score: pick.total, status: 'open', curPrice: pick.price,
      hz: opts.hz || pick.hzKey || null, note: ''
    };

    S.trades.unshift(t);
    saveLocal();
    render();

    apiPost('/api/paper/buy', toServer(t)).then(function (res) {
      if (res && res.ok && res.trade && !res.duplicate) {
        var idx = S.trades.findIndex(function (x) { return x.id === t.id; });
        if (idx >= 0) S.trades[idx] = fromServer(res.trade);
        saveLocal();
      }
      render();
      if (opts.onDone) opts.onDone();
    }).catch(function () {
      if (opts.onDone) opts.onDone();
    });

    toast('已模拟买入 ' + pick.name + ' 100 手（' + shares + ' 股，' + money(shares * pick.price) + '）');
  }

  /* ---------------- 入口 ---------------- */
  function enter() {
    mount();
    if (!S.loaded) return load();
    render();
    if (!S.quoteAt || Date.now() - S.quoteAt > 20000) return syncQuotes();
  }

  function render2() { render(); }

  /* 页面可见时定时刷新报价；不可见就跳过，避免无谓请求 */
  setInterval(function () {
    var v = el('v-paper');
    if (!v || !v.classList.contains('on')) return;
    if (!S.trades.some(function (t) { return t.status === 'open'; })) return;
    syncQuotes();
  }, AUTO_MS);

  /* 切到别的视图就把抽屉收掉，避免下次回来时它自己又弹出来 */
  document.addEventListener('eb:view', function (e) {
    if (!e.detail || e.detail.view !== 'paper') closeDrawer();
  });

  window.addEventListener('resize', function () {
    clearTimeout(window.__ppRz);
    window.__ppRz = setTimeout(function () {
      if (S.chart) { try { S.chart.resize(); } catch (e) { /* ignore */ } }
      if (S._eqChart) { try { S._eqChart.resize(); } catch (e) { /* ignore */ } }
    }, 160);
  });

  window.EB_PAPER = {
    render: render2,
    enter: enter,
    buy: buy,
    findOpen: findOpen,
    pushPrices: pushPrices,
    syncQuotes: syncQuotes,
    state: S
  };
})();
