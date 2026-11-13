/* A股股债利差系统 — 个股分析模块
 *
 * 输入 6 位 A 股代码，拉取公开行情、K线、财报、估值历史、资金流与行业估值，
 * 从「估值 / 盈利质量 / 成长 / 技术 / 资金 / 风险」六个维度打分，
 * 输出可执行的操作建议（动作、价位、仓位、触发条件）。
 *
 * 数据源（东方财富公开接口，JSONP）：
 *   实时快照   push2.eastmoney.com/api/qt/stock/get
 *   日K        push2his.eastmoney.com/api/qt/stock/kline/get（前复权）
 *   资金流     push2his.eastmoney.com/api/qt/stock/fflow/daykline/get
 *   主要财务   datacenter-web.eastmoney.com RPT_F10_FINANCE_MAINFINADATA
 *   估值历史   datacenter-web.eastmoney.com RPT_VALUEANALYSIS_DET（日频）
 *   相关板块   push2.eastmoney.com/api/qt/slist/get
 *
 * 定位：量化体检工具。评分是规则化的相对判断，不预测涨跌，不构成投资建议。
 */
(function () {
  'use strict';

  /* ================= 基础工具 ================= */

  var SEQ = 0;
  function jsonp(url, timeout) {
    return new Promise(function (resolve, reject) {
      var name = 'EBJ_' + Date.now() + '_' + (++SEQ);
      var el = document.createElement('script');
      var done = false;
      function cleanup() {
        if (el.parentNode) el.parentNode.removeChild(el);
        try { delete window[name]; } catch (e) { window[name] = undefined; }
      }
      var timer = setTimeout(function () {
        if (done) return;
        done = true; cleanup(); reject(new Error('数据接口超时，请检查网络'));
      }, timeout || 12000);
      window[name] = function (data) {
        if (done) return;
        done = true; clearTimeout(timer); cleanup(); resolve(data);
      };
      el.onerror = function () {
        if (done) return;
        done = true; clearTimeout(timer); cleanup();
        reject(new Error('数据接口不可达，请检查网络'));
      };
      // 不同数据源的回调参数名不同：datacenter 用 callback，行情接口用 cb
      var pname = url.indexOf('datacenter-web') >= 0 ? 'callback' : 'cb';
      el.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + pname + '=' + name;
      document.head.appendChild(el);
    });
  }

  function num(x) { var v = Number(x); return isFinite(v) ? v : null; }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function f1(x) { return (x === null || x === undefined || !isFinite(x)) ? '—' : Number(x).toFixed(1); }
  function f2(x) { return (x === null || x === undefined || !isFinite(x)) ? '—' : Number(x).toFixed(2); }
  function f0(x) { return (x === null || x === undefined || !isFinite(x)) ? '—' : Number(x).toFixed(0); }
  function sgn(x, n) {
    if (x === null || x === undefined || !isFinite(x)) return '—';
    return (x > 0 ? '+' : '') + Number(x).toFixed(n === undefined ? 2 : n);
  }
  function yi(x) { // 元 → 亿元
    if (x === null || !isFinite(x)) return '—';
    var v = x / 1e8;
    return (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)) + ' 亿';
  }
  function pctile(arr, v) {
    if (!arr.length || !isFinite(v)) return null;
    var c = 0;
    for (var i = 0; i < arr.length; i++) if (arr[i] < v) c++;
    return c / arr.length * 100;
  }
  function median(arr) {
    if (!arr.length) return null;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function secidOf(code) {
    if (!/^\d{6}$/.test(code)) return null;
    if (code.charAt(0) === '6') return '1.' + code;
    if (/^[03]/.test(code)) return '0.' + code;
    return null;
  }
  // 6 位但不在支持范围内时，给出针对性提示，而不是笼统说「请输入 6 位代码」
  function codeMsg(code) {
    if (!/^\d{6}$/.test(code)) return '请输入 6 位数字代码，例如 600519、000001、300750';
    if (/^[84]/.test(code)) return '暂不支持北交所与股转系统代码（8 / 4 开头），目前仅覆盖沪深主板、创业板与科创板';
    if (/^900/.test(code)) return '暂不支持 B 股代码（900 开头），请改用对应 A 股代码';
    if (/^(1|5)/.test(code)) return '这是基金 / ETF 代码，本模块只分析个股，请换用 6 位股票代码';
    return '未找到该代码对应的股票，请确认代码是否正确（如 600519、000001、300750）';
  }
  function secucodeOf(code) {
    return code + (code.charAt(0) === '6' ? '.SH' : '.SZ');
  }

  /* ================= 数据抓取 ================= */

  function fetchQuote(sid) {
    var f = 'f43,f44,f45,f46,f47,f48,f50,f57,f58,f59,f60,f84,f85,f86,f92,f116,f117,' +
      'f127,f128,f129,f162,f167,f168,f169,f170,f171,f173,f183,f184,f185,f186,f187,f188,f189';
    return jsonp('https://push2.eastmoney.com/api/qt/stock/get?secid=' + sid + '&fields=' + f)
      .then(function (j) {
        var d = j && j.data;
        if (!d || !d.f58 || !d.f57) throw new Error('未找到该代码对应的股票');
        var dec = (d.f59 === undefined || d.f59 === null) ? 2 : d.f59;
        var p = Math.pow(10, dec);
        var price = num(d.f43) ? d.f43 / p : null;
        var prev = num(d.f60) ? d.f60 / p : null;
        if (!price || price <= 0) price = prev;
        if (!price) throw new Error('该代码当前无有效报价（可能停牌或已退市）');
        return {
          code: String(d.f57), name: String(d.f58),
          price: price, prevClose: prev,
          open: num(d.f46) ? d.f46 / p : null,
          high: num(d.f44) ? d.f44 / p : null,
          low: num(d.f45) ? d.f45 / p : null,
          chgPct: num(d.f170) ? d.f170 / 100 : null,
          amp: num(d.f171) ? d.f171 / 100 : null,
          volRatio: num(d.f50) ? d.f50 / 100 : null,
          vol: num(d.f47), amount: num(d.f48),
          totalShare: num(d.f84), floatShare: num(d.f85),
          mktCap: num(d.f116), floatCap: num(d.f117),
          pe: num(d.f162) ? d.f162 / 100 : null,
          pb: num(d.f167) ? d.f167 / 100 : null,
          turnover: num(d.f168) ? d.f168 / 100 : null,
          bps: num(d.f92),
          industry: d.f127 ? String(d.f127) : '',
          region: d.f128 ? String(d.f128) : '',
          concepts: d.f129 ? String(d.f129).split(',') : [],
          roe: num(d.f173),
          revenue: num(d.f183), revYoY: num(d.f184), profitYoY: num(d.f185),
          grossMargin: num(d.f186), netMargin: num(d.f187), debtRatio: num(d.f188),
          listDate: d.f189 ? String(d.f189) : '',
          ts: num(d.f86)
        };
      });
  }

  function fetchKline(sid, years) {
    var d = new Date();
    d.setFullYear(d.getFullYear() - (years || 3));
    var beg = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    var url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + sid +
      '&klt=101&fqt=1&beg=' + beg + '&end=20500101' +
      '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
    return jsonp(url).then(function (j) {
      var kl = (j && j.data && j.data.klines) || [];
      if (kl.length < 30) throw new Error('历史行情不足，无法做技术分析');
      return kl.map(function (line) {
        var a = line.split(',');
        return {
          d: a[0], o: +a[1], c: +a[2], h: +a[3], l: +a[4],
          v: +a[5], amt: +a[6], amp: +a[7], chg: +a[8], chgPct: +a[9], turn: +a[10]
        };
      });
    });
  }

  function fetchFin(code) {
    var url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA' +
      '&columns=ALL&pageSize=9&pageNumber=1&sortColumns=REPORT_DATE&sortTypes=-1' +
      '&filter=' + encodeURIComponent('(SECUCODE="' + secucodeOf(code) + '")');
    return jsonp(url, 14000).then(function (j) {
      var rows = (j && j.result && j.result.data) || [];
      return rows.map(function (r) {
        return {
          date: String(r.REPORT_DATE || '').slice(0, 10),
          name: r.REPORT_DATE_NAME || '',
          type: r.REPORT_TYPE || '',
          eps: num(r.EPSJB), bps: num(r.BPS),
          revenue: num(r.TOTALOPERATEREVE),
          profit: num(r.PARENTNETPROFIT),
          deduct: num(r.KCFJCXSYJLR),
          revYoY: num(r.TOTALOPERATEREVETZ),
          profitYoY: num(r.PARENTNETPROFITTZ),
          deductYoY: num(r.KCFJCXSYJLRTZ),
          qRevYoY: num(r.DJD_TOI_YOY),
          qProfitYoY: num(r.DJD_DPNP_YOY),
          roe: num(r.ROEJQ), roic: num(r.ROIC),
          gross: num(r.XSMLL), net: num(r.XSJLL),
          debt: num(r.ZCFZL), current: num(r.LD), quick: num(r.SD),
          ocfPerShare: num(r.MGJYXJJE),
          ocfToRev: num(r.JYXJLYYSR),
          notice: String(r.NOTICE_DATE || '').slice(0, 10)
        };
      });
    }).catch(function () { return []; });
  }

  function fetchVal(code) {
    var base = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_VALUEANALYSIS_DET' +
      '&columns=SECURITY_CODE,TRADE_DATE,CLOSE_PRICE,PE_TTM,PB_MRQ,PS_TTM,TOTAL_MARKET_CAP,BOARD_NAME' +
      '&pageSize=1000&sortColumns=TRADE_DATE&sortTypes=-1' +
      '&filter=' + encodeURIComponent('(SECURITY_CODE="' + code + '")');
    var pages = [1, 2];
    return Promise.all(pages.map(function (p) {
      return jsonp(base + '&pageNumber=' + p, 14000).then(function (j) {
        return (j && j.result && j.result.data) || [];
      }).catch(function () { return []; });
    })).then(function (arrs) {
      var out = [];
      arrs.forEach(function (rows) {
        rows.forEach(function (r) {
          var pe = num(r.PE_TTM), pb = num(r.PB_MRQ);
          if (pe === null && pb === null) return;
          out.push({
            d: String(r.TRADE_DATE || '').slice(0, 10),
            pe: pe, pb: pb,
            close: num(r.CLOSE_PRICE),
            cap: num(r.TOTAL_MARKET_CAP)
          });
        });
      });
      // 去重并按日期倒序
      var seen = {}, uniq = [];
      out.forEach(function (x) { if (!seen[x.d]) { seen[x.d] = 1; uniq.push(x); } });
      uniq.sort(function (a, b) { return a.d < b.d ? 1 : -1; });
      return uniq;
    }).catch(function () { return []; });
  }

  function fetchFlow(sid) {
    var url = 'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=' + sid +
      '&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&lmt=0';
    return jsonp(url).then(function (j) {
      var kl = (j && j.data && j.data.klines) || [];
      return kl.map(function (line) {
        var a = line.split(',');
        return {
          d: a[0],
          main: num(a[1]),       // 主力净流入（元）
          small: num(a[2]),
          mid: num(a[3]),
          big: num(a[4]),
          huge: num(a[5]),
          mainPct: num(a[6])
        };
      });
    }).catch(function () { return []; });
  }

  function fetchBoard(quote, sid) {
    var url = 'https://push2.eastmoney.com/api/qt/slist/get?spt=3&fltt=2&invt=2' +
      '&fields=f12,f13,f14,f3&secid=' + sid + '&pn=1&pz=40';
    return jsonp(url).then(function (j) {
      var diff = (j && j.data && j.data.diff) || [];
      var list = Array.isArray(diff) ? diff : Object.keys(diff).map(function (k) { return diff[k]; });
      var hit = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].f14 === quote.industry) { hit = list[i]; break; }
      }
      if (!hit) return null;
      var bk = '90.' + hit.f12;
      return jsonp('https://push2.eastmoney.com/api/qt/stock/get?secid=' + bk + '&fields=f58,f162,f167')
        .then(function (jj) {
          var d = jj && jj.data;
          if (!d) return null;
          return {
            name: String(d.f58 || hit.f14),
            pe: num(d.f162) ? d.f162 / 100 : null,
            pb: num(d.f167) ? d.f167 / 100 : null
          };
        });
    }).catch(function () { return null; });
  }

  /* ================= 技术指标 ================= */

  function smaAt(arr, n, idx) {
    if (idx + 1 < n) return null;
    var s = 0;
    for (var i = idx - n + 1; i <= idx; i++) s += arr[i];
    return s / n;
  }

  function emaSeries(arr, n) {
    var k = 2 / (n + 1), out = [], prev = null;
    for (var i = 0; i < arr.length; i++) {
      prev = prev === null ? arr[i] : arr[i] * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  }

  function calcIndicators(k) {
    var closes = k.map(function (x) { return x.c; });
    var vols = k.map(function (x) { return x.v; });
    var n = closes.length;
    var last = n - 1;

    var ma = {};
    [5, 10, 20, 60, 120, 250].forEach(function (w) { ma[w] = smaAt(closes, w, last); });

    // MACD(12,26,9)
    var e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
    var dif = e12.map(function (v, i) { return v - e26[i]; });
    var dea = emaSeries(dif, 9);
    var macd = {
      dif: dif[last], dea: dea[last],
      hist: (dif[last] - dea[last]) * 2,
      difPrev: dif[last - 1], deaPrev: dea[last - 1],
      histPrev: (dif[last - 1] - dea[last - 1]) * 2
    };

    // RSI(14) Wilder
    var rsi = null;
    if (n > 15) {
      var gain = 0, loss = 0;
      for (var i = n - 14; i < n; i++) {
        var ch = closes[i] - closes[i - 1];
        if (ch >= 0) gain += ch; else loss -= ch;
      }
      var ag = gain / 14, al = loss / 14;
      rsi = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }

    // BOLL(20,2)
    var boll = null, bollPos = null;
    if (n >= 20) {
      var m20 = smaAt(closes, 20, last), s = 0;
      for (var j = n - 20; j < n; j++) s += (closes[j] - m20) * (closes[j] - m20);
      var sd = Math.sqrt(s / 20);
      boll = { mid: m20, up: m20 + 2 * sd, low: m20 - 2 * sd, sd: sd };
      bollPos = (closes[last] - boll.low) / (boll.up - boll.low || 1);
    }

    // 波动率 / 回撤
    var rets = [];
    for (var r = Math.max(1, n - 250); r < n; r++) {
      if (closes[r - 1] > 0) rets.push(closes[r] / closes[r - 1] - 1);
    }
    var mean = rets.reduce(function (a, b) { return a + b; }, 0) / (rets.length || 1);
    var vari = rets.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (rets.length || 1);
    var vol = Math.sqrt(vari) * Math.sqrt(252) * 100;

    var peak = -Infinity, mdd = 0;
    for (var m = Math.max(0, n - 250); m < n; m++) {
      if (closes[m] > peak) peak = closes[m];
      var dd = (closes[m] / peak - 1) * 100;
      if (dd < mdd) mdd = dd;
    }

    // 量能
    var vol5 = 0, vol60 = 0;
    for (var v5 = n - 5; v5 < n; v5++) vol5 += vols[v5];
    vol5 /= 5;
    var c60 = 0;
    for (var v6 = Math.max(0, n - 60); v6 < n; v6++) { vol60 += vols[v6]; c60++; }
    vol60 /= (c60 || 1);

    // 区间高低
    function hiLow(days) {
      var seg = k.slice(Math.max(0, n - days));
      var hi = -Infinity, lo = Infinity;
      seg.forEach(function (x) { if (x.h > hi) hi = x.h; if (x.l < lo) lo = x.l; });
      return { hi: hi, lo: lo };
    }
    var r60 = hiLow(60), r120 = hiLow(120), r250 = hiLow(250);

    // 区间涨跌幅
    function retOf(days) {
      if (n <= days) return null;
      var base = closes[n - 1 - days];
      return base > 0 ? (closes[last] / base - 1) * 100 : null;
    }

    return {
      ma: ma, macd: macd, rsi: rsi, boll: boll, bollPos: bollPos,
      vol: vol, mdd: mdd, vol5: vol5, vol60: vol60,
      hi60: r60.hi, lo60: r60.lo, hi120: r120.hi, lo120: r120.lo,
      hi250: r250.hi, lo250: r250.lo,
      ret20: retOf(20), ret60: retOf(60), ret250: retOf(250)
    };
  }

  /* ================= 六维评分 ================= */

  /* D1 估值（22 分权重） */
  function scoreValuation(v) {
    var notes = [];
    if (v.loss) {
      return { s: 15, notes: ['公司当前为亏损状态（PE 为负），估值指标失效，无法用估值给分'] };
    }
    if (v.pe === null || v.pePct === null) {
      return { s: 50, notes: ['缺少足够的估值历史，估值维度取中性分'] };
    }
    var s = 100 - clamp(v.pePct, 0, 100);

    if (v.pePct <= 20) notes.push('PE ' + f1(v.pe) + ' 倍，处于近 5 年 ' + f0(v.pePct) + '% 分位，属历史偏低区');
    else if (v.pePct >= 80) notes.push('PE ' + f1(v.pe) + ' 倍，处于近 5 年 ' + f0(v.pePct) + '% 分位，属历史偏高区');
    else notes.push('PE ' + f1(v.pe) + ' 倍，处于近 5 年 ' + f0(v.pePct) + '% 分位，估值居中');

    if (v.pbPct !== null && v.pbPct >= 85) {
      s -= 8;
      notes.push('PB ' + f2(v.pb) + ' 倍，处 ' + f0(v.pbPct) + '% 分位，净资产端同样不便宜');
    }
    if (!v.isFin && v.peg !== null && v.peg > 0) {
      if (v.peg < 1) { s += 6; notes.push('PEG ' + f2(v.peg) + '，成长性能支撑当前估值'); }
      else if (v.peg > 2) { s -= 10; notes.push('PEG ' + f2(v.peg) + '，估值已明显透支盈利增速'); }
    }
    if (v.pe > 80) { s -= 12; notes.push('绝对 PE 超过 80 倍，对盈利波动极其敏感'); }
    if (v.indPe && v.indPe > 0) {
      var rel = (v.pe / v.indPe - 1) * 100;
      if (rel <= -15) { s += 5; notes.push('低于行业平均 ' + f0(-rel) + '%（行业 ' + f1(v.indPe) + ' 倍）'); }
      else if (rel >= 40) { s -= 6; notes.push('高于行业平均 ' + f0(rel) + '%（行业 ' + f1(v.indPe) + ' 倍）'); }
      else notes.push('与行业平均基本相当（行业 ' + f1(v.indPe) + ' 倍）');
    }
    return { s: clamp(s, 0, 100), notes: notes };
  }

  /* D2 盈利质量（20 分权重） */
  function scoreQuality(q) {
    var notes = [];
    function band(x, tiers) {
      if (x === null || x === undefined || !isFinite(x)) return null;
      for (var i = 0; i < tiers.length; i++) if (x >= tiers[i][0]) return tiers[i][1];
      return tiers[tiers.length - 1][1];
    }
    var roeS = band(q.roe, [[20, 100], [15, 86], [10, 70], [5, 50], [-1e9, 28]]);
    var netS = band(q.net, [[20, 92], [12, 78], [6, 62], [2, 46], [-1e9, 26]]);
    var dedS = band(q.deductRatio, [[95, 95], [85, 80], [70, 60], [50, 42], [-1e9, 28]]);
    // 金融业没有「毛利率」概念，经营现金流也不可比，这两项跳过
    var grossS = q.isFin ? null : band(q.gross, [[45, 92], [30, 78], [18, 62], [8, 46], [-1e9, 32]]);
    var cashS = q.isFin ? null : band(q.cashCover, [[1.2, 95], [0.8, 78], [0.5, 58], [0.2, 40], [-1e9, 24]]);

    var parts = [];
    if (roeS !== null) { parts.push([roeS, 0.30]); notes.push('ROE（加权）' + f1(q.roe) + '%' + (q.roe >= 15 ? '，股东回报处于优秀区间' : q.roe >= 10 ? '，盈利能力中等' : '，资本回报偏低')); }
    if (grossS !== null) { parts.push([grossS, 0.15]); notes.push('毛利率 ' + f1(q.gross) + '%' + (q.gross >= 40 ? '，产品定价能力强' : q.gross >= 20 ? '，毛利水平一般' : '，毛利空间薄')); }
    if (netS !== null) { parts.push([netS, 0.15]); notes.push('净利率 ' + f1(q.net) + '%'); }
    if (dedS !== null) { parts.push([dedS, 0.20]); notes.push('扣非/归母 ' + f0(q.deductRatio) + '%' + (q.deductRatio >= 90 ? '，利润主要来自主业' : '，非经常性损益占比偏高')); }
    if (cashS !== null) { parts.push([cashS, 0.20]); notes.push('经营现金流/净利润 ' + f2(q.cashCover) + (q.cashCover >= 1 ? '，利润有现金支撑' : '，利润含金量不足')); }
    if (q.isFin) notes.push('金融业不适用毛利率与经营现金流指标，已从评分中剔除');

    if (!parts.length) return { s: 50, notes: ['缺少财务数据，盈利质量取中性分'] };
    var tw = parts.reduce(function (a, b) { return a + b[1]; }, 0);
    var s = parts.reduce(function (a, b) { return a + b[0] * b[1]; }, 0) / tw;
    return { s: clamp(s, 0, 100), notes: notes };
  }

  /* D3 成长性（13 分权重） */
  function scoreGrowth(g) {
    var notes = [];
    function band(x, tiers) {
      if (x === null || x === undefined || !isFinite(x)) return null;
      for (var i = 0; i < tiers.length; i++) if (x >= tiers[i][0]) return tiers[i][1];
      return tiers[tiers.length - 1][1];
    }
    var revS = band(g.revYoY, [[30, 100], [15, 85], [5, 70], [0, 55], [-10, 40], [-1e9, 22]]);
    var proS = band(g.profitYoY, [[30, 100], [15, 85], [5, 70], [0, 55], [-10, 40], [-1e9, 22]]);
    var dedS = band(g.deductYoY, [[30, 100], [15, 85], [5, 70], [0, 55], [-10, 40], [-1e9, 22]]);

    var parts = [];
    if (revS !== null) { parts.push([revS, 0.35]); notes.push('营收同比 ' + sgn(g.revYoY, 1) + '%'); }
    if (proS !== null) { parts.push([proS, 0.40]); notes.push('归母净利同比 ' + sgn(g.profitYoY, 1) + '%'); }
    if (dedS !== null) { parts.push([dedS, 0.25]); notes.push('扣非净利同比 ' + sgn(g.deductYoY, 1) + '%'); }

    if (!parts.length) return { s: 50, notes: ['缺少同比数据，成长性取中性分'] };
    var tw = parts.reduce(function (a, b) { return a + b[1]; }, 0);
    var s = parts.reduce(function (a, b) { return a + b[0] * b[1]; }, 0) / tw;

    // 多期趋势：最近 4 期净利同比是否逐期改善
    var seq = g.profitSeq.filter(function (x) { return x !== null; });
    if (seq.length >= 3) {
      var up = 0;
      for (var i = 1; i < seq.length; i++) if (seq[i] > seq[i - 1]) up++;
      var trend = up / (seq.length - 1);
      if (trend >= 0.66) { s += 8; notes.push('最近 ' + seq.length + ' 期净利增速持续改善'); }
      else if (trend <= 0.33) { s -= 8; notes.push('最近 ' + seq.length + ' 期净利增速逐期走弱'); }
    }
    if (g.qProfitYoY !== null) notes.push('单季净利同比 ' + sgn(g.qProfitYoY, 1) + '%');
    return { s: clamp(s, 0, 100), notes: notes };
  }

  /* D4 技术面（20 分权重） */
  function scoreTechnical(t) {
    var notes = [];
    var s = 0;
    var ma = t.ma, price = t.price;

    // 1) 均线排列 25
    var hasAll = ma[5] && ma[10] && ma[20] && ma[60];
    if (hasAll) {
      if (ma[5] > ma[10] && ma[10] > ma[20] && ma[20] > ma[60]) { s += 25; notes.push('均线多头排列（MA5>MA10>MA20>MA60），中期趋势向上'); }
      else if (ma[5] < ma[10] && ma[10] < ma[20] && ma[20] < ma[60]) { s += 3; notes.push('均线空头排列，中期趋势向下'); }
      else { s += 13; notes.push('均线交织，方向未明'); }
    } else s += 12;

    // 2) 价格位置 20
    if (ma[20]) { s += price > ma[20] ? 10 : 2; }
    else s += 5;
    if (ma[60]) { s += price > ma[60] ? 10 : 2; }
    else s += 5;
    if (ma[20] && ma[60]) {
      notes.push('股价' + (price > ma[20] ? '站上' : '跌破') + ' MA20（' + f2(ma[20]) + '），' +
        (price > ma[60] ? '站上' : '跌破') + ' MA60（' + f2(ma[60]) + '）');
    }

    // 3) MACD 20 —— 零轴上方的金叉才是趋势延续，零轴下方的金叉只是下跌中的反弹，分值必须区分
    var m = t.macd;
    if (m.dif > m.dea && m.hist > 0) {
      if (m.dif > 0) { s += m.hist > m.histPrev ? 20 : 16; }
      else { s += m.hist > m.histPrev ? 13 : 11; }
      notes.push('MACD 位于零轴' + (m.dif > 0 ? '上方' : '下方') + '且金叉，柱体' + (m.hist > m.histPrev ? '放大' : '收敛') +
        (m.dif > 0 ? '' : '（零轴下方金叉，属超跌反弹性质，不是趋势反转）'));
    } else if (m.dif > m.dea) { s += 13; notes.push('MACD 金叉但柱体为负'); }
    else { s += m.hist < 0 && m.hist < m.histPrev ? 3 : 8; notes.push('MACD 死叉，短期动能偏弱'); }

    // 4) RSI 15
    if (t.rsi === null) s += 8;
    else if (t.rsi >= 45 && t.rsi <= 65) { s += 15; notes.push('RSI ' + f0(t.rsi) + '，处于健康区间'); }
    else if (t.rsi > 65 && t.rsi <= 75) { s += 10; notes.push('RSI ' + f0(t.rsi) + '，偏强但未极端'); }
    else if (t.rsi > 75) { s += 3; notes.push('RSI ' + f0(t.rsi) + '，进入超买区，短线追高风险大'); }
    else if (t.rsi >= 30) { s += 7; notes.push('RSI ' + f0(t.rsi) + '，偏弱'); }
    else { s += 11; notes.push('RSI ' + f0(t.rsi) + '，处于超卖区，存在反弹可能但趋势未确认'); }

    // 5) 布林 10
    if (t.bollPos === null) s += 5;
    else if (t.bollPos > 0.5 && t.bollPos < 0.9) s += 10;
    else if (t.bollPos >= 0.9) { s += 5; notes.push('股价贴近布林上轨，短期乖离偏大'); }
    else if (t.bollPos > 0.2) s += 6;
    else { s += 3; notes.push('股价贴近布林下轨，弱势'); }

    // 6) 量能 10
    var vr = t.vol60 > 0 ? t.vol5 / t.vol60 : 1;
    var up5 = t.ret20 !== null && t.ret20 > 0;
    if (vr > 1.3 && up5) { s += 10; notes.push('近 5 日量能放大至 60 日均量的 ' + f1(vr) + ' 倍，量价配合'); }
    else if (vr > 1.0) s += 7;
    else if (vr < 0.7) { s += 3; notes.push('近 5 日量能萎缩至 60 日均量的 ' + f1(vr) + ' 倍，关注度下降'); }
    else s += 5;

    return { s: clamp(s, 0, 100), notes: notes };
  }

  /* D5 资金面（10 分权重） */
  function scoreFund(f, floatCap) {
    var notes = [];
    if (!f.length) return { s: 50, notes: ['无资金流数据'] };
    var recent = f.slice(-20);
    function sum(arr, n) {
      var seg = arr.slice(-n);
      return seg.reduce(function (a, b) { return a + (b.main || 0); }, 0);
    }
    var m5 = sum(recent, 5), m20 = sum(recent, 20);
    var posDays = recent.filter(function (x) { return (x.main || 0) > 0; }).length;
    var posRatio = posDays / recent.length;

    var r5 = floatCap > 0 ? m5 / floatCap * 100 : 0;
    var r20 = floatCap > 0 ? m20 / floatCap * 100 : 0;

    var s = 50;
    if (r20 > 1) s = 90; else if (r20 > 0.3) s = 78; else if (r20 > 0) s = 64;
    else if (r20 > -0.3) s = 46; else if (r20 > -1) s = 32; else s = 18;

    if (r5 > 0 && r20 > 0) s += 8; else if (r5 < 0 && r20 < 0) s -= 8;
    s += (posRatio - 0.5) * 20;

    notes.push('近 5 日主力净' + (m5 >= 0 ? '流入 ' : '流出 ') + yi(Math.abs(m5)));
    notes.push('近 20 日主力净' + (m20 >= 0 ? '流入 ' : '流出 ') + yi(Math.abs(m20)) +
      (floatCap > 0 ? '，占流通市值 ' + f2(Math.abs(r20)) + '%' : ''));
    notes.push('20 日中有 ' + posDays + ' 天净流入（' + f0(posRatio * 100) + '%）');

    return { s: clamp(s, 0, 100), notes: notes };
  }

  /* D6 风险（15 分权重，分越高越安全） */
  function scoreRisk(r) {
    var notes = [];
    var volS = r.vol >= 60 ? 30 : r.vol >= 45 ? 50 : r.vol >= 32 ? 70 : r.vol >= 22 ? 86 : 96;
    var mddS = r.mdd <= -50 ? 30 : r.mdd <= -35 ? 50 : r.mdd <= -22 ? 70 : r.mdd <= -12 ? 86 : 96;
    var valS = r.pePct === null ? 60 : (r.pePct >= 90 ? 30 : r.pePct >= 75 ? 58 : r.pePct >= 40 ? 82 : 92);

    var s;
    if (r.isFin) {
      // 金融业负债率天然在 90% 左右，不能按一般企业标准衡量
      s = volS * 0.38 + mddS * 0.37 + valS * 0.25;
      notes.push('金融业杠杆结构特殊，资产负债率不纳入风险扣分');
    } else {
      var debtS = r.debt === null ? 60 : r.debt >= 80 ? 30 : r.debt >= 65 ? 55 : r.debt >= 45 ? 78 : 94;
      s = volS * 0.28 + mddS * 0.28 + debtS * 0.22 + valS * 0.22;
      if (r.debt !== null) notes.push('资产负债率 ' + f1(r.debt) + '%' + (r.debt >= 65 ? '，杠杆偏高' : r.debt <= 40 ? '，杠杆低' : ''));
    }

    notes.unshift('年化波动率 ' + f1(r.vol) + '%，近一年最大回撤 ' + f1(r.mdd) + '%');
    if (r.pePct !== null && r.pePct >= 90) notes.push('估值分位 ' + f0(r.pePct) + '%，估值本身即是一项风险');
    if (r.mdd <= -35) notes.push('过去一年出现过 ' + f0(-r.mdd) + '% 的深度回撤，波动承受要求高');

    return { s: clamp(s, 0, 100), notes: notes };
  }

  /* ================= 结论与操作建议 ================= */

  var LADDER = [
    { min: 80, k: 'strong-buy', label: '值得重仓研究', short: '六维共振，具备中线配置价值' },
    { min: 71, k: 'buy', label: '可以分批建仓', short: '多数维度偏正面，可用试探仓位参与' },
    { min: 62, k: 'hold', label: '偏多，等更好价格', short: '基本面或趋势有一项不足，不宜追高' },
    { min: 50, k: 'watch', label: '中性观望', short: '多空因素接近，缺乏明确优势' },
    { min: 38, k: 'reduce', label: '偏弱，逢反弹减仓', short: '多个维度落后，反弹是减仓机会' },
    { min: -1, k: 'sell', label: '回避', short: '综合评分低，性价比与趋势均不佳' }
  ];

  var ORDER = ['strong-buy', 'buy', 'hold', 'watch', 'reduce', 'sell'];

  function downgrade(k, steps) {
    var i = ORDER.indexOf(k);
    return ORDER[Math.min(ORDER.length - 1, i + steps)];
  }

  function decide(total, dims, ctx) {
    var v = LADDER.find(function (x) { return total >= x.min; }) || LADDER[LADDER.length - 1];
    var key = v.k;
    var reasons = [];

    // 「重仓」档需要成长性配合，且至少四个维度达到 70 分，避免单靠防御性指标冲高分
    if (key === 'strong-buy') {
      var strong = Object.keys(dims).filter(function (k) { return dims[k] >= 70; }).length;
      if (dims.d3 < 55 || strong < 4) {
        key = 'buy';
        reasons.push('成长性 ' + f0(dims.d3) + ' 分，未达重仓所需的成长配合，结论降为分批建仓');
      }
    }

    if (ctx.loss) {
      if (ORDER.indexOf(key) < ORDER.indexOf('watch')) {
        key = 'watch';
        reasons.push('公司处于亏损状态，无论其他维度多好都不给买入结论');
      }
    }
    // 趋势否决：跌破 MA60 且 MA20 在 MA60 之下，说明中期趋势明确向下。
    // 这种位置「便宜」往往只是下跌的中继，直接给分批建仓容易买在半山腰，压到「等更好价格」。
    if (ctx.bearTrend && ORDER.indexOf(key) < ORDER.indexOf('hold')) {
      key = 'hold';
      reasons.push('股价位于 MA60 之下且均线空头排列，中期趋势未修复，估值便宜不等于跌势结束，结论压到「等更好价格」');
    }
    if (dims.d1 < 30 && ORDER.indexOf(key) <= ORDER.indexOf('buy')) {
      key = downgrade(key, 1);
      reasons.push('估值处于历史极高位（D1 ' + f0(dims.d1) + ' 分），压制结论');
    }
    if (dims.d4 < 30 && dims.d5 < 40 && ORDER.indexOf(key) <= ORDER.indexOf('hold')) {
      key = downgrade(key, 1);
      reasons.push('技术面破位且资金持续流出，右侧信号未出现');
    }
    if (dims.d6 < 35 && ORDER.indexOf(key) <= ORDER.indexOf('hold')) {
      key = downgrade(key, 1);
      reasons.push('风险维度得分过低（D6 ' + f0(dims.d6) + ' 分），不适合提高仓位');
    }

    var final = LADDER.find(function (x) { return x.k === key; }) || v;
    return { key: key, label: final.label, short: final.short, notes: reasons };
  }

  /* ================= 主分析流程 ================= */

  function analyze(code) {
    var sid = secidOf(code);
    if (!sid) return Promise.reject(new Error(codeMsg(code)));

    return fetchQuote(sid).then(function (quote) {
      return Promise.all([
        fetchKline(sid, 3),
        fetchFin(code),
        fetchVal(code),
        fetchFlow(sid),
        fetchBoard(quote, sid)
      ]).then(function (res) {
        return build(quote, res[0], res[1], res[2], res[3], res[4]);
      });
    });
  }

  function build(q, kline, fin, val, flow, board) {
    var ind = calcIndicators(kline);
    var last = kline[kline.length - 1];
    // 立刻把收盘日期存成独立变量，避免后续任何同名 var 覆盖 last 导致「undefined 收盘」
    var lastDate = (last && last.d) ? last.d : '';
    var price = q.price || last.c;

    /* ---- 估值 ---- */
    // 统一用 PE(TTM)：优先取估值序列最新一条，保证与历史分位同口径
    var v0 = val[0] || null;
    var pe = (v0 && v0.pe > 0) ? v0.pe : (q.pe > 0 ? q.pe : null);
    var pb = (v0 && v0.pb > 0) ? v0.pb : (q.pb > 0 ? q.pb : null);
    var loss = !(pe > 0);
    var peSeries = val.map(function (x) { return x.pe; }).filter(function (x) { return x > 0; });
    var pbSeries = val.map(function (x) { return x.pb; }).filter(function (x) { return x > 0; });
    var pe5 = peSeries.slice(0, Math.min(1250, peSeries.length));
    var pb5 = pbSeries.slice(0, Math.min(1250, pbSeries.length));

    var pePct = loss ? null : pctile(pe5, pe);
    var pbPct = (pb > 0 && pb5.length) ? pctile(pb5, pb) : null;
    var peMedian5 = median(pe5);

    /* ---- 财务 ---- */
    var latest = fin[0] || null;
    var roe = (latest && latest.roe !== null) ? latest.roe : q.roe;
    var gross = (latest && latest.gross !== null) ? latest.gross : q.grossMargin;
    var net = (latest && latest.net !== null) ? latest.net : q.netMargin;
    var debt = (latest && latest.debt !== null) ? latest.debt : q.debtRatio;
    var deductRatio = (latest && latest.profit > 0 && latest.deduct !== null)
      ? latest.deduct / latest.profit * 100 : null;
    var ocf = (latest && latest.ocfPerShare !== null && latest.eps) ? latest.ocfPerShare : null;
    var cashCover = null;
    if (ocf !== null && latest && latest.eps && latest.eps > 0) cashCover = ocf / latest.eps;
    else if (latest && latest.ocfToRev !== null && net > 0) cashCover = latest.ocfToRev / (net / 100);

    var profitSeq = fin.slice(0, 4).map(function (x) { return x.profitYoY; }).reverse();

    /* ---- 成长 ---- */
    var revYoY = (latest && latest.revYoY !== null) ? latest.revYoY : q.revYoY;
    var profitYoY = (latest && latest.profitYoY !== null) ? latest.profitYoY : q.profitYoY;
    var deductYoY = latest ? latest.deductYoY : null;
    var qProfitYoY = latest ? latest.qProfitYoY : null;

    /* ---- PEG ---- */
    var peg = (pe > 0 && profitYoY && profitYoY > 0) ? pe / profitYoY : null;

    /* ---- 行业类型：金融业的多项指标口径不同 ---- */
    var IND_NAME = q.industry || '';
    var isFin = /银行|保险|证券|多元金融|信托|租赁/.test(IND_NAME);

    /* ---- 评分 ---- */
    var d1 = scoreValuation({ pe: pe, pb: pb, pePct: pePct, pbPct: pbPct, peg: peg, indPe: board ? board.pe : null, loss: loss, isFin: isFin });
    var d2 = scoreQuality({ roe: roe, gross: gross, net: net, deductRatio: deductRatio, cashCover: cashCover, isFin: isFin });
    var d3 = scoreGrowth({ revYoY: revYoY, profitYoY: profitYoY, deductYoY: deductYoY, profitSeq: profitSeq, qProfitYoY: qProfitYoY });
    var d4 = scoreTechnical({
      ma: ind.ma, macd: ind.macd, rsi: ind.rsi, bollPos: ind.bollPos,
      vol5: ind.vol5, vol60: ind.vol60, ret20: ind.ret20, price: price
    });
    var d5 = scoreFund(flow, q.floatCap);
    var d6 = scoreRisk({ vol: ind.vol, mdd: ind.mdd, debt: debt, pePct: pePct, isFin: isFin });

    var W = { d1: 22, d2: 20, d3: 13, d4: 20, d5: 10, d6: 15 };
    var dims = { d1: d1.s, d2: d2.s, d3: d3.s, d4: d4.s, d5: d5.s, d6: d6.s };
    var total = (d1.s * W.d1 + d2.s * W.d2 + d3.s * W.d3 + d4.s * W.d4 + d5.s * W.d5 + d6.s * W.d6) / 100;

    var verdict = decide(total, dims, {
      loss: loss,
      bearTrend: !!(ind.ma[20] && ind.ma[60] && price < ind.ma[60] && ind.ma[20] < ind.ma[60])
    });

    /* ---- 关键价位 ---- */
    var supports = [];
    if (ind.ma[20] && ind.ma[20] < price) supports.push({ v: ind.ma[20], t: 'MA20' });
    if (ind.ma[60] && ind.ma[60] < price) supports.push({ v: ind.ma[60], t: 'MA60' });
    if (ind.lo60 < price) supports.push({ v: ind.lo60, t: '近 60 日低点' });
    if (ind.lo120 < price) supports.push({ v: ind.lo120, t: '近 120 日低点' });
    supports.sort(function (a, b) { return b.v - a.v; });

    var resists = [];
    if (ind.hi60 > price) resists.push({ v: ind.hi60, t: '近 60 日高点' });
    if (ind.hi120 > price) resists.push({ v: ind.hi120, t: '近 120 日高点' });
    if (ind.hi250 > price) resists.push({ v: ind.hi250, t: '52 周高点' });
    if (ind.boll && ind.boll.up > price) resists.push({ v: ind.boll.up, t: '布林上轨' });
    resists.sort(function (a, b) { return a.v - b.v; });

    var stop = supports.length ? supports[0].v * 0.985 : price * 0.92;
    if (stop < price * 0.90) stop = price * 0.90; // 单笔止损幅度上限 10%

    // 估值中枢价：PE 处在极低分位时不能直接用中位数回归。
    // 低 PE 常常来自「盈利正处在周期高点」（E 被放大），此时把 PE 拉回中位数会推出一个荒唐的天价。
    var fairPrice = null;
    if (peMedian5 > 0 && pe > 0 && (pePct === null || pePct >= 15)) {
      var peRatio = peMedian5 / pe;
      if (peRatio <= 2.0) fairPrice = price * peRatio;
    }

    var targetPrice = null, targetKind = '';
    // 目标价必须落在可交易区间：不超过近 120 日高点，也不超过现价 1.4 倍
    var capHi = Math.min(price * 1.4, ind.hi120 > price ? ind.hi120 : price * 1.4);
    if (fairPrice && fairPrice > price * 1.02) {
      targetPrice = Math.min(fairPrice, capHi);
      targetKind = targetPrice < fairPrice - 0.01 ? '估值中枢（按近端压力收敛）' : '估值中枢';
    }
    if (!targetPrice || targetPrice < price * 1.05) {
      // 退化到技术压力：取第一个至少有 8% 空间的压力位，太近的均线不配当目标价
      var tCand = resists.slice();
      if (ind.ma[20] && ind.ma[20] > price) tCand.push({ v: ind.ma[20], t: 'MA20' });
      if (ind.ma[60] && ind.ma[60] > price) tCand.push({ v: ind.ma[60], t: 'MA60' });
      tCand.sort(function (a, b) { return a.v - b.v; });
      var pick = tCand.filter(function (r) { return r.v >= price * 1.08 && r.v <= capHi; })[0];
      if (pick) { targetPrice = pick.v; targetKind = pick.t; }
      else if (tCand.length) {
        // 这里不能再用变量名 last：build() 顶部的 var last = kline[...] 是同一函数作用域，
        // 用 var 重名会覆盖它，导致末尾 lastDate: last.d 变成 undefined（页面显示「undefined 收盘」）。
        var lastRes = tCand.filter(function (r) { return r.v > price * 1.02; })[0];
        if (lastRes) { targetPrice = Math.min(lastRes.v, capHi); targetKind = lastRes.t; }
      }
    }

    // 突破加仓参考：优先取「不远于 15% 的最近压力位」，否则退化为 MA60，避免给出 +60% 的荒谬触发价
    var nearR = resists.filter(function (r) { return r.v > price * 1.02 && r.v <= price * 1.15; });
    var breakout;
    if (nearR.length) breakout = nearR[0].v;
    else if (ind.ma[60] && ind.ma[60] > price) breakout = ind.ma[60];
    else breakout = price * 1.08;

    var upside = targetPrice ? (targetPrice / price - 1) * 100 : null;
    var downside = (stop / price - 1) * 100;

    /* ---- 仓位与计划 ---- */
    var posCap;
    if (verdict.key === 'strong-buy') posCap = 20;
    else if (verdict.key === 'buy') posCap = 12;
    else if (verdict.key === 'hold') posCap = 6;
    else if (verdict.key === 'watch') posCap = 0;
    else posCap = 0;

    var plan = [];
    if (verdict.key === 'strong-buy' || verdict.key === 'buy') {
      plan.push('第一批：现价 ' + f2(price) + ' 附近建 ' + (posCap * 0.4).toFixed(0) + '% 仓位（占总资产）');
      if (supports.length) plan.push('第二批：回踩 ' + f2(supports[0].v) + '（' + supports[0].t + '）不破再加 ' + (posCap * 0.4).toFixed(0) + '%');
      plan.push('第三批：有效突破 ' + f2(breakout) + ' 并站稳后补足剩余仓位');
      plan.push('止损：收盘跌破 ' + f2(stop) + '（' + f1(downside) + '%）离场，不摊平');
    } else if (verdict.key === 'hold') {
      plan.push('暂不追高：现价只做小仓位试探（不超过 ' + posCap + '%）');
      if (supports.length) plan.push('更好的买点：回踩 ' + f2(supports[0].v) + '（' + supports[0].t + '）附近');
      plan.push('止损：收盘跌破 ' + f2(stop) + '（' + f1(downside) + '%）');
    } else if (verdict.key === 'watch') {
      plan.push('空仓等待：当前没有足够的安全边际');
      plan.push('观察条件：站上 ' + f2(ind.ma[60] || price) + '（MA60）且量能放大，或估值分位回落至 50% 以下');
      if (resists.length) plan.push('若已持仓，' + f2(resists[0].v) + '（' + resists[0].t + '）附近是减仓参考位');
    } else {
      plan.push('不参与：综合评分偏低，等待基本面或趋势出现实质改善');
      if (resists.length) plan.push('已持仓者：反弹至 ' + f2(resists[0].v) + '（' + resists[0].t + '）附近考虑减仓');
      plan.push('回避条件：跌破 ' + f2(stop) + ' 应坚决离场');
    }

    /* ---- 正面 / 负面清单 ---- */
    // 每条说明本身有褒贬，不能按「维度分高就全是正面」粗暴归堆：
    // 估值 92 分的股票也可能有「PB 处于 89% 分位、不便宜」这种负面事实，必须归到反面清单里。
    function noteSign(t) {
      // 先处理容易误判的组合：「历史偏低区」是好事，「资本回报偏低」是坏事
      if (/历史偏低|估值偏低|处于低位|分位.*偏低/.test(t)) return 1;
      if (/回报偏低|偏低|较弱|较差|较高|不足|不便宜|偏贵|偏高|高估|泡沫|偏弱|走弱|走差|跌破|死叉|净流出|流出|回撤|下滑|下降|亏损|减速|收窄|减弱|承压|过高|恶化|不佳|未明|交织|偏离|透支|放缓|见顶|滞涨|商誉|质押|减持|缩水|转差|同比 -/.test(t)) return -1;
      // 个位数的同比增速算不上「支持买入的理由」，归为中性
      var gm = t.match(/同比 \+([\d.]+)%/);
      if (gm && parseFloat(gm[1]) < 10) return 0;
      if (/便宜|低估|优秀|领先|较强|定价能力|稳健|改善|增长|提速|加速|金叉|站上|零轴上方|净流入|有现金支撑|充足|健康|充裕|扩张|新高|超额|修复|转正|回升|占优|龙头|持续|同比 \+/.test(t)) return 1;
      return 0;
    }
    var dimList = [
      { k: '估值', s: d1.s, w: 22, n: d1.notes },
      { k: '盈利', s: d2.s, w: 20, n: d2.notes },
      { k: '成长', s: d3.s, w: 13, n: d3.notes },
      { k: '技术', s: d4.s, w: 20, n: d4.notes },
      { k: '资金', s: d5.s, w: 10, n: d5.notes },
      { k: '风险', s: d6.s, w: 15, n: d6.notes }
    ];

    // 两条说明如果引用了同一个数字（比如都在说 36% 的回撤），就只留一条，避免凑数
    function numsOf(t) {
      var m = String(t).match(/\d+(?:\.\d+)?/g) || [];
      return m.map(function (x) { var v = String(parseFloat(x)); return v.length >= 2 ? v : ''; });
    }
    function dupNum(t, list) {
      var a = numsOf(t);
      for (var i = 0; i < list.length; i++) {
        var b = numsOf(list[i]);
        for (var j = 0; j < a.length; j++) if (a[j] && b.indexOf(a[j]) >= 0) return true;
      }
      return false;
    }

    // 正面：从得分高的维度里挑正向描述，先给最强的维度说话
    var pros = [];
    dimList.slice().sort(function (a, b) { return b.s - a.s; }).forEach(function (o) {
      if (o.s < 58) return; // 得分不及格的维度，即使某句措辞偏正面也不该拿来当买入理由
      var got = 0;
      o.n.forEach(function (t) {
        if (pros.length < 5 && got < 2 && noteSign(t) > 0 && pros.indexOf(t) < 0 && !dupNum(t, pros)) { pros.push(t); got++; }
      });
    });
    // 全盘都弱时，正面清单会空掉，这时放宽到「不算差的维度」里找亮点
    if (pros.length < 2) {
      dimList.slice().sort(function (a, b) { return b.s - a.s; }).forEach(function (o) {
        if (o.s < 45) return;
        o.n.forEach(function (t) {
          if (pros.length < 3 && noteSign(t) > 0 && pros.indexOf(t) < 0) pros.push(t);
        });
      });
    }

    // 负面：不限维度，按「权重 × 失分」排序，越致命的越靠前
    var cand = [];
    var seen = [];
    dimList.forEach(function (o) {
      var got = 0;
      o.n.forEach(function (t) {
        if (noteSign(t) < 0 && got < 2 && !dupNum(t, seen)) {
          cand.push({ t: t, pain: o.w * (100 - o.s) / 100 });
          seen.push(t);
          got++;
        }
      });
    });
    cand.sort(function (a, b) { return b.pain - a.pain; });
    var cons = [];
    cand.forEach(function (x) { if (cons.length < 5 && cons.indexOf(x.t) < 0) cons.push(x.t); });

    // 反面理由太少时，用最弱的两个维度的原话补齐，避免出现「只有一条风险」的失真观感
    if (cons.length < 3) {
      dimList.slice().sort(function (a, b) { return a.s - b.s; }).forEach(function (o) {
        if (o.s > 60) return;
        o.n.forEach(function (t) {
          if (cons.length < 3 && cons.indexOf(t) < 0 && pros.indexOf(t) < 0) cons.push(t);
        });
      });
    }

    if (!pros.length) pros.push('没有明显占优的维度，各项指标均处中性或偏弱区间');
    if (!cons.length) cons.push('主要风险来自市场系统性波动，个股层面暂无明显硬伤');

    return {
      quote: q, kline: kline, ind: ind, fin: fin, val: val, flow: flow, board: board,
      pe: pe, pb: pb, loss: loss, pePct: pePct, pbPct: pbPct, peMedian5: peMedian5, peg: peg, isFin: isFin,
      roe: roe, gross: gross, net: net, debt: debt, deductRatio: deductRatio, cashCover: cashCover,
      revYoY: revYoY, profitYoY: profitYoY, deductYoY: deductYoY, qProfitYoY: qProfitYoY,
      dims: dims, weights: W, total: total, verdict: verdict,
      supports: supports, resists: resists, stop: stop, targetPrice: targetPrice,
      targetKind: targetKind, breakout: breakout,
      fairPrice: fairPrice, upside: upside, downside: downside,
      posCap: posCap, plan: plan, pros: pros.slice(0, 5), cons: cons.slice(0, 5),
      dimNotes: { d1: d1.notes, d2: d2.notes, d3: d3.notes, d4: d4.notes, d5: d5.notes, d6: d6.notes },
      price: price, lastDate: lastDate
    };
  }

  /* ================= 渲染 ================= */

  var DIM_DEF = [
    { k: 'd1', name: '估值', w: 22, color: '#316b9d' },
    { k: 'd2', name: '盈利质量', w: 20, color: '#18745f' },
    { k: 'd3', name: '成长', w: 13, color: '#2f8f7a' },
    { k: 'd4', name: '技术', w: 20, color: '#a86b15' },
    { k: 'd5', name: '资金', w: 10, color: '#6f5aa0' },
    { k: 'd6', name: '风险', w: 15, color: '#4e5d6e' }
  ];

  var CHARTS = {};
  function chart(id) {
    var el = document.getElementById(id);
    if (!el || !window.echarts) return null;
    var ins = CHARTS[id];
    // 每次分析都会用 innerHTML 重建整块结果，旧实例绑定的 DOM 已被丢弃。
    // 若继续往旧实例 setOption，新 DOM 里永远不会有 canvas —— 表现为「换一只股票后图表全空」。
    if (ins) {
      if (ins.getDom && ins.getDom() === el) return ins;
      try { ins.dispose(); } catch (e) { /* ignore */ }
      delete CHARTS[id];
    }
    CHARTS[id] = echarts.init(el, null, { renderer: 'canvas' });
    return CHARTS[id];
  }

  function dimBarsHtml(A) {
    return DIM_DEF.map(function (d) {
      var v = A.dims[d.k];
      return '<div class="sa-dim">' +
        '<div class="sa-dim-h"><span>' + d.name + '</span><em>' + d.w + '%</em></div>' +
        '<div class="sa-dim-bar"><i style="width:' + v.toFixed(1) + '%;background:' + d.color + '"></i></div>' +
        '<div class="sa-dim-v">' + f0(v) + '</div></div>';
    }).join('');
  }

  function kv(k, v, cls) {
    return '<div class="sa-kv"><i>' + k + '</i><b class="' + (cls || '') + '">' + v + '</b></div>';
  }

  function renderResult(A) {
    var q = A.quote;
    var vk = A.verdict.key;
    var up = q.chgPct;

    var dateTxt = A.lastDate || '最新交易日';
    var head =
      '<div class="sa-head card">' +
      '<div class="sa-head-l">' +
      '<div class="sa-name">' + q.name + '<span>' + q.code + '</span></div>' +
      '<div class="sa-tags">' +
      (q.industry ? '<span class="sa-tag">' + q.industry + '</span>' : '') +
      (q.region ? '<span class="sa-tag ghost">' + q.region + '</span>' : '') +
      q.concepts.slice(0, 4).map(function (c) { return '<span class="sa-tag ghost">' + c + '</span>'; }).join('') +
      '</div></div>' +
      '<div class="sa-head-r">' +
      '<div class="sa-price ' + (up >= 0 ? 'up' : 'dn') + '">' + f2(A.price) + '</div>' +
      '<div class="sa-chg ' + (up >= 0 ? 'up' : 'dn') + '">' + sgn(up, 2) + '%</div>' +
      '<div class="sa-meta">' + dateTxt + ' 收盘 · 市值 ' + yi(q.mktCap) + '</div>' +
      '</div></div>';

    // 公司名片：F10 异步加载完成后填入，接口不可用时保持空白，不阻塞下方六维结论
    var fundId = '<div id="sa-fund-id" hidden></div>';

    var verdictCard =
      '<div class="sa-verdict card ' + vk + '">' +
      '<div class="sa-vscore"><b>' + f1(A.total) + '</b><span>综合评分</span></div>' +
      '<div class="sa-vbody">' +
      '<div class="sa-vlabel">' + A.verdict.label + '</div>' +
      '<p>' + A.verdict.short + '。' + (A.verdict.notes.length ? A.verdict.notes.join('；') + '。' : '') + '</p>' +
      '</div>' +
      '<div class="sa-vtarget">' +
      '<div><i>目标价' + (A.targetKind ? '（' + A.targetKind + '）' : '') + '</i><b>' + (A.targetPrice ? f2(A.targetPrice) : '—') + '</b></div>' +
      '<div><i>空间</i><b class="' + (A.upside >= 0 ? 'up' : 'dn') + '">' + (A.upside === null ? '—' : sgn(A.upside, 1) + '%') + '</b></div>' +
      '<div><i>止损</i><b class="dn">' + f2(A.stop) + '</b></div>' +
      '</div></div>';

    var dimCard =
      '<div class="card sa-dims-card">' +
      '<div class="card-h"><h2>六维体检</h2><span class="hint">权重按「判断是否值得买入」设定，非等权</span></div>' +
      '<div class="sa-dims-wrap">' +
      '<div class="sa-dims-list">' + dimBarsHtml(A) + '</div>' +
      '<div id="sa-radar" class="sa-radar"></div>' +
      '</div></div>';

    var valCard =
      '<div class="card sa-panel">' +
      '<div class="card-h"><h2>估值</h2><span class="hint">D1 · ' + f0(A.dims.d1) + ' 分</span></div>' +
      '<div class="sa-kvs">' +
      kv('PE(TTM)', A.pe > 0 ? f2(A.pe) + ' 倍' : '亏损') +
      kv('PE 近 5 年分位', A.pePct === null ? '—' : f0(A.pePct) + '%') +
      kv('PB', A.pb ? f2(A.pb) + ' 倍' : '—') +
      kv('PB 近 5 年分位', A.pbPct === null ? '—' : f0(A.pbPct) + '%') +
      kv('PEG', A.peg ? f2(A.peg) : '—') +
      kv('行业平均 PE', A.board && A.board.pe ? f1(A.board.pe) + ' 倍' : '—') +
      '</div>' +
      '<div class="sa-pctbar">' +
      '<div class="sa-pctbar-lab"><span>历史低位</span><span>中位</span><span>历史高位</span></div>' +
      '<div class="sa-pctbar-track">' +
      (A.pePct === null ? '' : '<i style="left:' + clamp(A.pePct, 0, 100).toFixed(1) + '%"></i>') +
      '</div></div>' +
      '<ul class="sa-notes">' + A.dimNotes.d1.map(function (n) { return '<li>' + n + '</li>'; }).join('') + '</ul>' +
      '</div>';

    var finCard =
      '<div class="card sa-panel">' +
      '<div class="card-h"><h2>盈利与财务</h2><span class="hint">D2 · ' + f0(A.dims.d2) + ' 分</span></div>' +
      '<div class="sa-kvs">' +
      kv('ROE（加权）', A.roe !== null ? f1(A.roe) + '%' : '—') +
      kv('毛利率', A.isFin ? '不适用' : (A.gross !== null ? f1(A.gross) + '%' : '—')) +
      kv('净利率', A.net !== null ? f1(A.net) + '%' : '—') +
      kv('扣非/归母', A.deductRatio !== null ? f0(A.deductRatio) + '%' : '—') +
      kv('现金流/净利', A.isFin ? '不适用' : (A.cashCover !== null ? f2(A.cashCover) : '—')) +
      kv('资产负债率', A.debt !== null ? f1(A.debt) + '%' : '—') +
      '</div>' +
      '<ul class="sa-notes">' + A.dimNotes.d2.map(function (n) { return '<li>' + n + '</li>'; }).join('') + '</ul>' +
      '</div>';

    var growCard =
      '<div class="card sa-panel">' +
      '<div class="card-h"><h2>成长性</h2><span class="hint">D3 · ' + f0(A.dims.d3) + ' 分</span></div>' +
      '<div class="sa-kvs">' +
      kv('营收同比', A.revYoY === null ? '—' : sgn(A.revYoY, 1) + '%', A.revYoY >= 0 ? 'up' : 'dn') +
      kv('归母净利同比', A.profitYoY === null ? '—' : sgn(A.profitYoY, 1) + '%', A.profitYoY >= 0 ? 'up' : 'dn') +
      kv('扣非同比', A.deductYoY === null ? '—' : sgn(A.deductYoY, 1) + '%', A.deductYoY >= 0 ? 'up' : 'dn') +
      kv('单季净利同比', A.qProfitYoY === null ? '—' : sgn(A.qProfitYoY, 1) + '%', A.qProfitYoY >= 0 ? 'up' : 'dn') +
      '</div>' +
      '<ul class="sa-notes">' + A.dimNotes.d3.map(function (n) { return '<li>' + n + '</li>'; }).join('') + '</ul>' +
      '</div>';

    var techCard =
      '<div class="card sa-panel">' +
      '<div class="card-h"><h2>技术面</h2><span class="hint">D4 · ' + f0(A.dims.d4) + ' 分</span></div>' +
      '<div class="sa-kvs">' +
      kv('MA20', A.ind.ma[20] ? f2(A.ind.ma[20]) : '—') +
      kv('MA60', A.ind.ma[60] ? f2(A.ind.ma[60]) : '—') +
      kv('RSI(14)', A.ind.rsi === null ? '—' : f0(A.ind.rsi)) +
      kv('MACD', A.ind.macd.hist > 0 ? '红柱 ' + f2(A.ind.macd.hist) : '绿柱 ' + f2(A.ind.macd.hist)) +
      kv('20 日涨跌', A.ind.ret20 === null ? '—' : sgn(A.ind.ret20, 1) + '%', A.ind.ret20 >= 0 ? 'up' : 'dn') +
      kv('60 日涨跌', A.ind.ret60 === null ? '—' : sgn(A.ind.ret60, 1) + '%', A.ind.ret60 >= 0 ? 'up' : 'dn') +
      '</div>' +
      '<ul class="sa-notes">' + A.dimNotes.d4.map(function (n) { return '<li>' + n + '</li>'; }).join('') + '</ul>' +
      '</div>';

    var fundCard =
      '<div class="card sa-panel">' +
      '<div class="card-h"><h2>资金面</h2><span class="hint">D5 · ' + f0(A.dims.d5) + ' 分</span></div>' +
      '<div id="sa-flow" class="sa-flow"></div>' +
      '<ul class="sa-notes">' + A.dimNotes.d5.map(function (n) { return '<li>' + n + '</li>'; }).join('') + '</ul>' +
      '</div>';

    var riskCard =
      '<div class="card sa-panel">' +
      '<div class="card-h"><h2>风险</h2><span class="hint">D6 · ' + f0(A.dims.d6) + ' 分（越高越安全）</span></div>' +
      '<div class="sa-kvs">' +
      kv('年化波动率', f1(A.ind.vol) + '%') +
      kv('近一年最大回撤', f1(A.ind.mdd) + '%') +
      kv('52 周区间', f2(A.ind.lo250) + ' ~ ' + f2(A.ind.hi250)) +
      kv('当前位置', f0((A.price - A.ind.lo250) / (A.ind.hi250 - A.ind.lo250 || 1) * 100) + '%') +
      '</div>' +
      '<ul class="sa-notes">' + A.dimNotes.d6.map(function (n) { return '<li>' + n + '</li>'; }).join('') + '</ul>' +
      '</div>';

    var priceCard =
      '<div class="card">' +
      '<div class="card-h"><h2>关键价位</h2><span class="hint">支撑 / 压力由均线与区间高低点推得</span></div>' +
      '<div class="sa-levels">' +
      '<div class="sa-level-col"><h4>压力位</h4>' +
      (A.resists.length ? A.resists.slice(0, 3).map(function (r) {
        return '<div class="sa-level"><i>' + r.t + '</i><b>' + f2(r.v) + '</b><em class="up">' + sgn((r.v / A.price - 1) * 100, 1) + '%</em></div>';
      }).join('') : '<div class="sa-level empty">已在区间高位，上方无近端压力</div>') +
      '</div>' +
      '<div class="sa-level-col now"><h4>现价</h4>' +
      '<div class="sa-level"><i>最新</i><b>' + f2(A.price) + '</b><em></em></div>' +
      '<div class="sa-level"><i>止损参考</i><b class="dn">' + f2(A.stop) + '</b><em class="dn">' + f1(A.downside) + '%</em></div>' +
      '</div>' +
      '<div class="sa-level-col"><h4>支撑位</h4>' +
      (A.supports.length ? A.supports.slice(0, 3).map(function (r) {
        return '<div class="sa-level"><i>' + r.t + '</i><b>' + f2(r.v) + '</b><em class="dn">' + sgn((r.v / A.price - 1) * 100, 1) + '%</em></div>';
      }).join('') : '<div class="sa-level empty">下方缺少近端支撑，注意失控风险</div>') +
      '</div>' +
      '</div></div>';

    var planCard =
      '<div class="card sa-plan">' +
      '<div class="card-h"><h2>操作建议</h2><span class="hint">建议仓位上限 ' + A.posCap + '%（占总资产）</span></div>' +
      A.plan.map(function (p, i) {
        return '<div class="sa-plan-row"><i>0' + (i + 1) + '</i><span>' + p + '</span></div>';
      }).join('') +
      '</div>';

    var prosCons =
      '<div class="sa-pc">' +
      '<div class="card sa-pros"><div class="card-h"><h2>支持买入的理由</h2></div><ul>' +
      A.pros.map(function (p) { return '<li>' + p + '</li>'; }).join('') + '</ul></div>' +
      '<div class="card sa-cons"><div class="card-h"><h2>反对买入的理由</h2></div><ul>' +
      A.cons.map(function (p) { return '<li>' + p + '</li>'; }).join('') + '</ul></div>' +
      '</div>';

    var klineCard =
      '<div class="card">' +
      '<div class="card-h"><h2>近 120 个交易日走势</h2><span class="hint">前复权 · MA20 / MA60</span></div>' +
      '<div id="sa-kline" class="sa-kline"></div>' +
      '</div>';

    var finTable = renderFinTable(A.fin);

    // 基本面档案：独立异步模块，加载慢或接口全部失败也只跳过自己
    var fundFull = '<div id="sa-fund-full"></div>';

    var note =
      '<div class="card sa-note-card">' +
      '<div class="card-h"><h2>口径与局限</h2></div>' +
      '<p><b>数据来源：</b>东方财富公开行情与财报接口。行情截至 ' + dateTxt +
      ' 收盘；财务数据为 ' + (A.fin[0] ? A.fin[0].name : '最新报告期') + '（公告日 ' + (A.fin[0] ? A.fin[0].notice : '—') + '）。</p>' +
      '<p><b>评分口径：</b>六维加权（估值 22 / 盈利质量 20 / 成长 13 / 技术 20 / 资金 10 / 风险 15）。' +
      '估值分位基于该股自身近 5 年日频 PE-TTM 序列；技术指标用前复权日线计算；资金面用主力净流入占流通市值比。</p>' +
      '<p><b>基本面档案：</b>上方「公司名片」与下方「基本面档案」是独立异步加载的第二套判断，资料取自东方财富 F10 公开数据' +
      '（公司资料、主营构成、行业排名、十大股东与流通股东、股东户数、分红、股本结构）。管理层一栏只提供现任人员名单与职务，' +
      '不含履历、任期与薪酬；未来前景是基于公开财务与业务结构的规则化推演，不含行业景气调研、订单与产能验证，也不构成盈利预测。' +
      'F10 接口不可用时该档案会跳过并提示，上方六维量化结论不受影响。</p>' +
      '<p><b>模型边界：</b>评分是规则化的相对判断，不含行业景气度调研、管理层能力评估、订单与产能验证，也不预测短期涨跌。' +
      '高分红、强周期、次新股等特殊类型的评分会失真，需人工复核。目标价由「PE 回到近 5 年中位数」与「近端技术压力位」取较低者推得，不是预测值。</p>' +
      '<p class="red"><b>本页不构成投资建议。</b>任何买卖决策请自行核验最新公告、业绩预告、行业数据，并结合自身风险承受能力。</p>' +
      '</div>';

    return head + fundId + verdictCard + dimCard +
      '<div class="sa-grid2">' + valCard + finCard + '</div>' +
      '<div class="sa-grid2">' + growCard + techCard + '</div>' +
      '<div class="sa-grid2">' + fundCard + riskCard + '</div>' +
      priceCard + planCard + prosCons + klineCard + finTable + fundFull + note;
  }

  function renderFinTable(fin) {
    if (!fin.length) return '';
    var rows = fin.slice(0, 6);
    var h = '<thead><tr><th>报告期</th><th class="num">营收</th><th class="num">归母净利</th>' +
      '<th class="num">营收同比</th><th class="num">净利同比</th><th class="num">ROE</th>' +
      '<th class="num">毛利率</th><th class="num">负债率</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      h += '<tr><td><b>' + (r.name || r.date) + '</b></td>' +
        '<td class="num">' + yi(r.revenue) + '</td>' +
        '<td class="num">' + yi(r.profit) + '</td>' +
        '<td class="num ' + (r.revYoY >= 0 ? 'up' : 'dn') + '">' + (r.revYoY === null ? '—' : sgn(r.revYoY, 1) + '%') + '</td>' +
        '<td class="num ' + (r.profitYoY >= 0 ? 'up' : 'dn') + '">' + (r.profitYoY === null ? '—' : sgn(r.profitYoY, 1) + '%') + '</td>' +
        '<td class="num">' + (r.roe === null ? '—' : f1(r.roe) + '%') + '</td>' +
        '<td class="num">' + (r.gross === null ? '—' : f1(r.gross) + '%') + '</td>' +
        '<td class="num">' + (r.debt === null ? '—' : f1(r.debt) + '%') + '</td></tr>';
    });
    return '<div class="card"><div class="card-h"><h2>财务趋势</h2><span class="hint">最近 ' + rows.length + ' 个报告期</span></div>' +
      '<div class="tablewrap"><table class="tbl">' + h + '</tbody></table></div></div>';
  }

  function drawCharts(A) {
    // 雷达
    var radar = chart('sa-radar');
    if (radar) {
      radar.setOption({
        radar: {
          indicator: DIM_DEF.map(function (d) { return { name: d.name, max: 100 }; }),
          radius: '64%', center: ['50%', '54%'],
          axisName: { color: '#68788a', fontSize: 11 },
          splitLine: { lineStyle: { color: '#e6ecf2' } },
          splitArea: { areaStyle: { color: ['#fafcfd', '#fff'] } },
          axisLine: { lineStyle: { color: '#e6ecf2' } }
        },
        series: [{
          type: 'radar',
          data: [{
            value: DIM_DEF.map(function (d) { return Math.round(A.dims[d.k]); }),
            areaStyle: { color: 'rgba(44,95,138,.16)' },
            lineStyle: { color: '#2c5f8a', width: 2 },
            itemStyle: { color: '#2c5f8a' }
          }]
        }]
      }, true);
    }

    // 资金流
    var flow = chart('sa-flow');
    if (flow && A.flow.length) {
      var seg = A.flow.slice(-20);
      flow.setOption({
        grid: { left: 8, right: 8, top: 18, bottom: 4, containLabel: true },
        xAxis: {
          type: 'category',
          data: seg.map(function (x) { return x.d.slice(5); }),
          axisLine: { lineStyle: { color: '#e4e1da' } }, axisTick: { show: false },
          axisLabel: { color: '#8b929c', fontSize: 9, interval: 3 }
        },
        yAxis: {
          type: 'value', axisLine: { show: false }, axisTick: { show: false },
          splitLine: { lineStyle: { color: '#f2efe9' } },
          axisLabel: { color: '#8b929c', fontSize: 9, formatter: function (v) { return (v / 1e8).toFixed(1) + '亿'; } }
        },
        tooltip: {
          trigger: 'axis',
          formatter: function (ps) {
            var i = ps[0].dataIndex;
            return seg[i].d + '<br/>主力净流入 <b>' + yi(seg[i].main) + '</b>';
          }
        },
        series: [{
          type: 'bar', barWidth: '62%',
          data: seg.map(function (x) {
            return { value: x.main, itemStyle: { color: x.main >= 0 ? '#c0442a' : '#1a7f5a', borderRadius: [2, 2, 0, 0] } };
          })
        }]
      }, true);
    }

    // K 线
    var kl = chart('sa-kline');
    if (kl) {
      var seg2 = A.kline.slice(-120);
      var closes = A.kline.map(function (x) { return x.c; });
      var offset = A.kline.length - seg2.length;
      function maLine(n) {
        var out = [];
        for (var i = 0; i < seg2.length; i++) {
          var idx = offset + i;
          out.push(smaAt(closes, n, idx));
        }
        return out;
      }
      kl.setOption({
        grid: { left: 8, right: 12, top: 26, bottom: 8, containLabel: true },
        legend: { top: 0, itemWidth: 14, itemHeight: 8, textStyle: { color: '#8b929c', fontSize: 10 } },
        xAxis: {
          type: 'category', data: seg2.map(function (x) { return x.d; }),
          axisLine: { lineStyle: { color: '#e4e1da' } }, axisTick: { show: false },
          axisLabel: { color: '#8b929c', fontSize: 9.5 }
        },
        yAxis: {
          scale: true, axisLine: { show: false }, axisTick: { show: false },
          splitLine: { lineStyle: { color: '#f2efe9' } },
          axisLabel: { color: '#8b929c', fontSize: 9.5 }
        },
        tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
        series: [
          {
            name: 'K线', type: 'candlestick',
            data: seg2.map(function (x) { return [x.o, x.c, x.l, x.h]; }),
            itemStyle: {
              color: '#c0442a', color0: '#1a7f5a',
              borderColor: '#c0442a', borderColor0: '#1a7f5a'
            }
          },
          { name: 'MA20', type: 'line', data: maLine(20), smooth: true, showSymbol: false, lineStyle: { width: 1.4, color: '#a8761c' } },
          { name: 'MA60', type: 'line', data: maLine(60), smooth: true, showSymbol: false, lineStyle: { width: 1.4, color: '#2c5f8a' } }
        ]
      }, true);
    }

    // 结果区刚由 hidden 切为可见，首帧拿到的宽度可能还是 0，下一帧补一次 resize
    requestAnimationFrame(function () {
      ['sa-radar', 'sa-flow', 'sa-kline'].forEach(function (k) {
        if (CHARTS[k]) { try { CHARTS[k].resize(); } catch (e) { /* ignore */ } }
      });
    });
  }

  /* ================= 交互 ================= */

  var LAST = null;
  var REQ = 0;   // 请求序号：连续换股时，只允许最后一次请求写入结果，防止慢响应覆盖新股票

  function setLoading(on, txt) {
    var el = document.getElementById('sa-loading');
    if (!el) return;
    el.hidden = !on;
    // 注意：不能取 el.querySelector('span')，那是转圈的图标，会被文字覆盖掉
    var t = document.getElementById('sa-loading-txt');
    if (on && txt && t) t.textContent = txt;
  }
  function showError(msg) {
    var el = document.getElementById('sa-error');
    if (!el) return;
    el.hidden = false;
    el.innerHTML = '<b>分析失败</b><span>' + msg + '</span>';
    // 出错时收起上一次的结果，避免错误提示和旧结论同时挂在页面上
    var box = document.getElementById('sa-result');
    if (box) box.hidden = true;
  }
  function clearError() {
    var el = document.getElementById('sa-error');
    if (el) el.hidden = true;
  }

  // 渲染量化结果，并异步挂载基本面档案。
  // 抽成同一入口，保证「直接分析」与「切回页面重绘 LAST」两条路径行为一致。
  function paint(A, code) {
    var box = document.getElementById('sa-result');
    box.innerHTML = renderResult(A);
    box.hidden = false;
    drawCharts(A);
    if (window.EB_FUND && typeof window.EB_FUND.load === 'function') {
      window.EB_FUND.load(code || A.quote.code, A);
    }
  }

  function run(code) {
    code = String(code || '').replace(/\D/g, '');
    if (code.length !== 6) {
      showError('请输入 6 位股票代码，例如 600519、000001、300750');
      return;
    }
    if (!secidOf(code)) {
      showError(codeMsg(code));
      return;
    }
    clearError();
    var box = document.getElementById('sa-result');
    box.hidden = true;
    setLoading(true, '正在拉取行情、财报与估值历史…');

    var my = ++REQ;
    analyze(code).then(function (A) {
      if (my !== REQ) return; // 用户已切到别的股票，丢弃这次慢响应
      LAST = A;
      setLoading(false);
      paint(A, code);
      var inp = document.getElementById('sa-code');
      if (inp) inp.value = code;
      try {
        history.replaceState(null, '', '#stock=' + code);
      } catch (e) { /* ignore */ }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }).catch(function (err) {
      if (my !== REQ) return;
      setLoading(false);
      showError(err && err.message ? err.message : '分析失败，请稍后重试');
    });
  }

  function quickList() {
    return [
      { c: '600519', n: '贵州茅台' },
      { c: '000001', n: '平安银行' },
      { c: '300750', n: '宁德时代' },
      { c: '601872', n: '招商轮船' },
      { c: '600036', n: '招商银行' }
    ];
  }

  function mount() {
    var quick = document.getElementById('sa-quick');
    if (quick && !quick.dataset.done) {
      quick.dataset.done = '1';
      quick.innerHTML = '<span class="sa-quick-lab">试试：</span>' + quickList().map(function (x) {
        return '<button class="sa-chip" data-code="' + x.c + '">' + x.n + ' <em>' + x.c + '</em></button>';
      }).join('');
      quick.addEventListener('click', function (e) {
        var b = e.target.closest('.sa-chip');
        if (b) run(b.dataset.code);
      });
    }
    var btn = document.getElementById('sa-go');
    if (btn && !btn.dataset.done) {
      btn.dataset.done = '1';
      btn.addEventListener('click', function () { run(document.getElementById('sa-code').value); });
    }
    var inp = document.getElementById('sa-code');
    if (inp && !inp.dataset.done) {
      inp.dataset.done = '1';
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') run(this.value);
      });
      inp.addEventListener('input', function () {
        this.value = this.value.replace(/\D/g, '').slice(0, 6);
      });
    }
  }

  function renderView() {
    mount();
    // 视图从隐藏切回时，档案内的 ECharts 需要按当前可见宽度重算尺寸
    setTimeout(function () {
      if (window.EB_FUND && typeof window.EB_FUND.resize === 'function') window.EB_FUND.resize();
    }, 60);
    // 支持 #stock=600519 直接定位
    var m = /#stock=(\d{6})/.exec(location.hash);
    if (m && (!LAST || LAST.quote.code !== m[1])) run(m[1]);
    else if (LAST) {
      var box = document.getElementById('sa-result');
      if (box && box.hidden) paint(LAST, LAST.quote.code);
    }
  }

  window.addEventListener('resize', function () {
    clearTimeout(window.__saRz);
    window.__saRz = setTimeout(function () {
      Object.keys(CHARTS).forEach(function (k) {
        try { CHARTS[k].resize(); } catch (e) { /* ignore */ }
      });
    }, 140);
  });

  window.EB_STOCK = { render: renderView, run: run, mount: mount };
})();
