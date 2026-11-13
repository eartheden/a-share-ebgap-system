/* A股股债利差系统 — 实时行情层
 *
 * 作用：把「当前值」从静态快照升级为实时值。
 *   1) 通过东方财富 JSONP 接口取五个宽基指数的盘中最新价；
 *   2) 用「实时价 / 锚点价」缩放蛋卷的最新 PE，得到盘中 PE-TTM
 *      （盈利在盘中不变，所以 PE 只随价格线性变化，这是严格成立的）；
 *   3) 盘中每 60 秒刷新，收盘后每 10 分钟检查一次是否进入新交易日。
 *
 * 依赖：data.js 的 meta.anchor（由 update-data.mjs 生成）
 * 暴露：window.EB_LIVE = { start(cb), snapshot(), status() }
 */
(function () {
  'use strict';

  var D = window.EB_DATA || {};
  var META = D.meta || {};
  var ANCHOR = META.anchor || null;
  var KEYS = ['hs300', 'sz50', 'zz500', 'zz1000', 'cyb'];

  /* 东财 secid 映射 */
  var SECIDS = {
    hs300: '1.000300',
    sz50: '1.000016',
    zz500: '1.000905',
    zz1000: '1.000852',
    cyb: '0.399006'
  };

  /* 选股页候选股：代码 → secid（6 开头为沪市，其余为深市） */
  var STOCK_CODES = [];
  var STOCK_SECIDS = {};
  (function () {
    var list = (window.EB_STOCKS && window.EB_STOCKS.candidates) || [];
    list.forEach(function (c) {
      if (!c || !c.code) return;
      var code = String(c.code);
      STOCK_CODES.push(code);
      STOCK_SECIDS[code] = (code.charAt(0) === '6' ? '1.' : '0.') + code;
    });
  })();

  var S = {
    phase: 'idle',      // idle | loading | live | closed | error
    at: null,           // 最近一次成功刷新的时间（Date）
    quoteTime: null,    // 交易所行情时间（字符串）
    points: null,       // {key: 当前点}
    stocks: {},         // {code: {price, pct, prevClose}}
    error: null,
    onUpdate: null,
    timer: null
  };

  /* ---------------- 北京时间 ---------------- */
  function bjNow() {
    var now = new Date();
    return new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 8 * 3600000);
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function bjMonth() {
    var d = bjNow();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
  }
  function bjClock(d) {
    var t = d || bjNow();
    return pad(t.getHours()) + ':' + pad(t.getMinutes());
  }
  /* A股交易时段：9:15-11:30 / 13:00-15:00（含集合竞价），仅工作日 */
  function isTrading() {
    var d = bjNow();
    var day = d.getDay();
    if (day === 0 || day === 6) return false;
    var hm = d.getHours() * 100 + d.getMinutes();
    return (hm >= 915 && hm <= 1130) || (hm >= 1300 && hm <= 1500);
  }

  /* ---------------- JSONP ---------------- */
  var seq = 0;
  function jsonp(url, timeout) {
    return new Promise(function (resolve, reject) {
      var name = 'EBQ_' + Date.now() + '_' + (++seq);
      var script = document.createElement('script');
      var done = false;

      function cleanup() {
        if (script.parentNode) script.parentNode.removeChild(script);
        try { delete window[name]; } catch (e) { window[name] = undefined; }
      }
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error('行情接口超时'));
      }, timeout || 8000);

      window[name] = function (data) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cleanup();
        resolve(data);
      };
      script.onerror = function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error('行情接口不可达'));
      };
      script.src = url + '&cb=' + name;
      document.head.appendChild(script);
    });
  }

  /* ---------------- 计算当前点 ---------------- */
  function anchorItem(key) {
    return ANCHOR && ANCHOR.items ? ANCHOR.items[key] : null;
  }

  /* 无实时行情时的兜底：直接用锚点（蛋卷最新 PE + 对应收盘价） */
  function buildFallbackPoints() {
    if (!ANCHOR) return null;
    var month = bjMonth();
    var bond = Number(ANCHOR.bond);
    var out = {};
    KEYS.forEach(function (k) {
      var a = anchorItem(k);
      if (!a || !(a.pe > 0)) return;
      var pe = Number(a.pe);
      out[k] = {
        d: month, close: Number(a.price), pe: pe,
        dy: Number(a.dy) || 0, bond: bond,
        ey: 100 / pe, erp: 100 / pe - bond
      };
    });
    return Object.keys(out).length ? out : null;
  }

  function buildLivePoints(quotes) {
    if (!ANCHOR) return null;
    var month = bjMonth();
    var bond = Number(ANCHOR.bond);
    var out = {};
    var hit = 0;

    KEYS.forEach(function (k) {
      var a = anchorItem(k);
      var q = quotes[k];
      if (!a || !q || !(q.price > 0) || !(a.pe > 0)) return;
      var base = Number(a.price) > 0 ? Number(a.price) : q.price;
      var pe = Number(a.pe) * q.price / base;
      var dy = (Number(a.dy) || 0) * base / q.price;
      if (!(pe > 0) || !isFinite(pe)) return;
      out[k] = {
        d: month,
        close: q.price,
        pe: pe,
        dy: dy,
        bond: bond,
        ey: 100 / pe,
        erp: 100 / pe - bond,
        pct: q.pct,
        prevClose: q.prevClose
      };
      hit += 1;
    });
    return hit ? out : null;
  }

  /* ---------------- 拉取行情 ---------------- */
  function fetchQuotes() {
    var ids = KEYS.map(function (k) { return SECIDS[k]; })
      .concat(STOCK_CODES.map(function (c) { return STOCK_SECIDS[c]; }))
      .join(',');
    var url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?secids=' + ids +
      '&fields=f2,f3,f12,f14,f18,f124&_=' + Date.now();
    return jsonp(url, 8000).then(function (j) {
      var diff = j && j.data && j.data.diff;
      if (!diff || !diff.length) throw new Error('行情返回为空');
      var out = {};
      var stocks = {};
      var stamp = null;
      diff.forEach(function (row) {
        var code = String(row.f12 || '');
        var price = Number(row.f2) / 100;
        var prev = Number(row.f18) / 100;
        if (!(price > 0)) return;
        var key = null;
        KEYS.forEach(function (k) {
          if (SECIDS[k].split('.')[1] === code) key = k;
        });
        if (key) {
          out[key] = {
            price: price,
            prevClose: prev > 0 ? prev : price,
            pct: Number(row.f3) / 100
          };
        } else if (STOCK_SECIDS[code]) {
          stocks[code] = {
            price: price,
            prevClose: prev > 0 ? prev : price,
            pct: Number(row.f3) / 100
          };
        }
        if (row.f124 && Number(row.f124) > 0) stamp = Number(row.f124);
      });
      if (!Object.keys(out).length) throw new Error('行情解析失败');
      S.stocks = stocks;
      S.quoteTime = stamp ? formatStamp(stamp) : null;
      return out;
    });
  }

  function formatStamp(sec) {
    var d = new Date(sec * 1000);
    var b = new Date(d.getTime() + d.getTimezoneOffset() * 60000 + 8 * 3600000);
    return b.getFullYear() + '-' + pad(b.getMonth() + 1) + '-' + pad(b.getDate()) +
      ' ' + pad(b.getHours()) + ':' + pad(b.getMinutes());
  }

  /* ---------------- 刷新 ---------------- */
  function refresh() {
    if (S.phase === 'loading') return Promise.resolve();
    S.phase = 'loading';
    emit();

    return fetchQuotes().then(function (quotes) {
      var pts = buildLivePoints(quotes);
      if (!pts) throw new Error('锚点缺失，无法换算 PE');
      S.points = pts;
      S.at = new Date();
      S.error = null;
      S.phase = isTrading() ? 'live' : 'closed';
      emit();
    }).catch(function (err) {
      S.error = err && err.message ? err.message : '行情获取失败';
      S.phase = 'error';
      S.points = buildFallbackPoints();
      emit();
    }).then(function () {
      schedule();
    });
  }

  function schedule() {
    if (S.timer) clearTimeout(S.timer);
    var wait = (S.phase === 'live') ? 60000 : 600000; // 盘中 1 分钟 / 其余 10 分钟
    S.timer = setTimeout(refresh, wait);
  }

  function emit() {
    if (typeof S.onUpdate === 'function') {
      try { S.onUpdate(); } catch (e) { /* 渲染异常不阻断轮询 */ }
    }
  }

  /* ---------------- 对外 ---------------- */
  window.EB_LIVE = {
    start: function (cb) {
      S.onUpdate = cb;
      S.points = buildFallbackPoints(); // 先给兜底值，页面立刻有数
      refresh();
      return this;
    },
    refresh: refresh,
    points: function () { return S.points; },
    stock: function (code) {
      var q = S.stocks && S.stocks[String(code)];
      return q && q.price > 0 ? q : null;
    },
    stocks: function () { return S.stocks; },
    status: function () {
      return {
        phase: S.phase,
        at: S.at,
        quoteTime: S.quoteTime,
        error: S.error,
        trading: isTrading(),
        anchorPeDate: ANCHOR ? ANCHOR.peDate : null,
        anchorBondDate: ANCHOR ? ANCHOR.bondDate : null
      };
    }
  };
})();
