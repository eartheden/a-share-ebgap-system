/* A股股债利差系统 — 个股基本面档案模块
 *
 * 目标：把「这家公司到底是干什么的」讲清楚，并给出有依据的基本面评价。
 * 覆盖：公司名片 / 业务拆解 / 行业地位 / 股东分布 / 治理与管理层 / 股本与分红
 *      / 未来前景 / 基本面总评 / 风险红旗 / 与量化结论交叉验证 / 观察清单
 *
 * 数据源（东方财富 datacenter-web，JSONP callback=）：
 *   RPT_F10_BASIC_ORGINFO    公司基本资料（含简介、地址、人员、行业）
 *   RPT_F10_FN_MAINOP        主营构成（按产品 / 按地区，含分部毛利率）
 *   RPT_F10_INDUSTRY_RANK    所在行业全部公司排名 + 行业均值
 *   RPT_F10_EH_HOLDERS       十大股东
 *   RPT_F10_EH_FREEHOLDERS   十大流通股东
 *   RPT_HOLDERNUM_DET        股东户数历史
 *   RPT_SHAREBONUS_DET       分红方案
 *   RPT_F10_EH_EQUITY        股本结构
 *
 * 设计原则：完全异步、非阻塞。F10 接口慢或全挂，只显示「资料暂不可用」，
 * 不影响原有六维量化分析；所有评价都引用页面上真实数字，不做无依据的行业预测。
 */
(function () {
  'use strict';

  /* ================= 基础工具 ================= */

  var SEQ = 0;
  function jsonp(url, timeout) {
    return new Promise(function (resolve, reject) {
      var name = 'EBF_' + Date.now() + '_' + (++SEQ);
      var el = document.createElement('script');
      var done = false;
      function cleanup() {
        if (el.parentNode) el.parentNode.removeChild(el);
        try { delete window[name]; } catch (e) { window[name] = undefined; }
      }
      var timer = setTimeout(function () {
        if (done) return;
        done = true; cleanup(); reject(new Error('timeout'));
      }, timeout || 10000);
      window[name] = function (data) {
        if (done) return;
        done = true; clearTimeout(timer); cleanup(); resolve(data);
      };
      el.onerror = function () {
        if (done) return;
        done = true; clearTimeout(timer); cleanup(); reject(new Error('network'));
      };
      el.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'callback=' + name;
      document.head.appendChild(el);
    });
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function n(x) { var v = Number(x); return isFinite(v) ? v : null; }
  function f0(x) { return (x === null || !isFinite(x)) ? '—' : Number(x).toFixed(0); }
  function f1(x) { return (x === null || !isFinite(x)) ? '—' : Number(x).toFixed(1); }
  function f2(x) { return (x === null || !isFinite(x)) ? '—' : Number(x).toFixed(2); }
  function sgn(x, d) { return (x === null || !isFinite(x)) ? '—' : (x > 0 ? '+' : '') + Number(x).toFixed(d === undefined ? 1 : d); }
  function yi(x) {
    if (x === null || !isFinite(x)) return '—';
    var v = x / 1e8;
    return (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)) + ' 亿';
  }
  function wan(x) { return (x === null || !isFinite(x)) ? '—' : f1(x / 1e4) + ' 万'; }
  // 股东变动：接口给的是带符号股数（如 -1690207 / 282600）或「不变 / 新进」，统一换算成万股
  function holderChg(ch) {
    if (!ch || ch === '不变') return '<span class="muted">不变</span>';
    if (/新进/.test(ch)) return '<span class="up">新进</span>';
    var v = n(ch);
    if (v === null) return '<span class="muted">' + esc(ch) + '</span>';
    var t = wan(Math.abs(v)) + '股';
    return v < 0 ? '<span class="dn">减持 ' + t + '</span>' : '<span class="up">增持 ' + t + '</span>';
  }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function dt(s) { return s ? String(s).slice(0, 10).replace(/-/g, '.') : '—'; }
  function cut(s, len) {
    if (!s) return '';
    var t = String(s).replace(/\s+/g, ' ').trim();
    return t.length > len ? t.slice(0, len) + '…' : t;
  }
  function val(v, unit) { return (v === null || v === undefined || v === '') ? '—' : esc(v) + (unit || ''); }

  /* ================= 数据抓取 ================= */

  function dc(report, sortCol, size, seccode) {
    var filter = encodeURIComponent('(SECUCODE="' + seccode + '")');
    var url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=' + report +
      '&columns=ALL&filter=' + filter + '&pageNumber=1&pageSize=' + size +
      '&sortColumns=' + sortCol + '&sortTypes=-1&source=HSF10&client=PC';
    return jsonp(url, 10000).then(function (j) {
      return (j && j.result && j.result.data) ? j.result.data : [];
    }).catch(function () { return []; });
  }

  function fetchAll(code, seccode) {
    return Promise.all([
      dc('RPT_F10_BASIC_ORGINFO', 'SECUCODE', 1, seccode),
      dc('RPT_F10_FN_MAINOP', 'REPORT_DATE', 80, seccode),
      dc('RPT_F10_INDUSTRY_RANK', 'REPORT_DATE', 60, seccode),
      dc('RPT_F10_EH_HOLDERS', 'END_DATE', 20, seccode),
      dc('RPT_F10_EH_FREEHOLDERS', 'END_DATE', 20, seccode),
      dc('RPT_HOLDERNUM_DET', 'END_DATE', 10, seccode),
      dc('RPT_SHAREBONUS_DET', 'REPORT_DATE', 12, seccode),
      dc('RPT_F10_EH_EQUITY', 'END_DATE', 5, seccode)
    ]).then(function (r) {
      // 必须在这里把原始报表行整理成 evaluate / htmlFull 期望的结构；
      // 否则 evaluate 拿到的是数组，读 mo.products 会直接抛错。
      return {
        org: r[0][0] || null,
        mainop: groupMainop(r[1] || []),
        rank: parseRank(r[2] || [], code),
        holders: parseHolders(r[3] || []),
        free: r[4] || [],
        holderNum: parseHolderNum(r[5] || []),
        bonus: r[6] || [],
        equity: r[7][0] || null
      };
    });
  }

  /* ================= 数据整理 ================= */

  function groupMainop(rows) {
    if (!rows.length) return null;
    var latest = String(rows[0].REPORT_DATE || '').slice(0, 10);
    var prev = null;
    for (var i = 0; i < rows.length; i++) {
      var d = String(rows[i].REPORT_DATE || '').slice(0, 10);
      if (d < latest) { prev = d; break; }
    }
    function pick(date, type) {
      var out = [];
      rows.forEach(function (r) {
        if (String(r.REPORT_DATE || '').slice(0, 10) !== date) return;
        if (String(r.MAINOP_TYPE) !== type) return;
        var inc = n(r.MAIN_BUSINESS_INCOME);
        if (inc === null || inc <= 0) return;
        out.push({
          name: String(r.ITEM_NAME || '其他'),
          income: inc,
          ratio: (n(r.MBI_RATIO) || 0) * 100,
          gross: (n(r.GROSS_RPOFIT_RATIO) || 0) * 100,
          cost: n(r.MAIN_BUSINESS_COST)
        });
      });
      out.sort(function (a, b) { return b.income - a.income; });
      return out;
    }
    var byType = {};
    ['1', '2', '3'].forEach(function (t) { byType[t] = pick(latest, t); });
    var byTypePrev = {};
    if (prev) ['1', '2', '3'].forEach(function (t) { byTypePrev[t] = pick(prev, t); });

    // 产品口径优先用 type2，没有再用 type1；地区口径用 type3
    var products = byType['2'].length > 1 ? byType['2'] : byType['1'];
    var productsPrev = (byTypePrev['2'].length > 1 ? byTypePrev['2'] : byTypePrev['1']) || [];
    return {
      date: latest, prevDate: prev,
      products: products, productsPrev: productsPrev,
      regions: byType['3'], overview: byType['1']
    };
  }

  function parseRank(rows, code) {
    if (!rows.length) return null;
    var avg = null, me = null, list = [];
    rows.forEach(function (r) {
      var c = String(r.CORRE_SECURITY_CODE || '');
      if (c === 'HYJZ') { avg = r; return; }
      if (c === code) me = r;
      if (n(r.TMC_RANK) > 0) list.push(r);
    });
    if (!me && avg) {
      // 有些股票不出现在排行榜行里，用行业均值行兜底取行业信息
      me = avg;
    }
    var num = n(me && me.STOCK_NUM) || (list.length || 1);
    return { avg: avg, me: me, list: list, num: num, name: (me || {}).INDUSTRY_NAME || '' };
  }

  function parseHolders(rows) {
    if (!rows.length) return { date: '', list: [], total: null, orgCount: 0, hasNorth: null, hasNominee: null };
    var latest = String(rows[0].END_DATE || '').slice(0, 10);
    var list = [], total = 0, orgCount = 0, hasNorth = null, hasNominee = null;
    rows.forEach(function (r) {
      if (String(r.END_DATE || '').slice(0, 10) !== latest) return;
      var ratio = n(r.HOLD_NUM_RATIO) || 0;
      total += ratio;
      if (String(r.IS_HOLDORG) === '1') orgCount++;
      var name = String(r.HOLDER_NAME || '');
      // 「香港中央结算有限公司」才是陆股通（北向资金）；
      // 「HKSCC NOMINEES LIMITED」是 A+H 公司的 H 股名义持有人，不是北向资金，
      // 两者若混为一谈，会把「陆股通减持」误判成「未见减持」。
      if (/香港中央结算有限公司/.test(name)) hasNorth = r;
      else if (/HKSCC|NOMINEES/i.test(name)) hasNominee = r;
      list.push({
        rank: n(r.HOLDER_RANK), name: name, ratio: ratio,
        num: n(r.HOLD_NUM), change: String(r.HOLD_NUM_CHANGE || ''),
        changeRatio: n(r.CHANGE_RATIO), isOrg: String(r.IS_HOLDORG) === '1'
      });
    });
    list.sort(function (a, b) { return (a.rank || 99) - (b.rank || 99); });
    return { date: latest, list: list, total: total, orgCount: orgCount, hasNorth: hasNorth, hasNominee: hasNominee };
  }

  function parseHolderNum(rows) {
    return (rows || []).map(function (r) {
      return {
        date: String(r.END_DATE || '').slice(0, 10),
        num: n(r.HOLDER_NUM), ratio: n(r.HOLDER_NUM_RATIO),
        avgCap: n(r.AVG_MARKET_CAP), avgHold: n(r.AVG_HOLD_NUM)
      };
    }).filter(function (x) { return x.num !== null; });
  }

  // 十大流通股东的占比口径与十大股东不同：字段名是 FREE_HOLDNUM_RATIO（占流通股），
  // 不能复用 HOLD_NUM_RATIO，否则全部读成 0。
  function parseFreeHolders(rows) {
    if (!rows.length) return { date: '', list: [], total: null, orgCount: 0 };
    var latest = String(rows[0].END_DATE || '').slice(0, 10);
    var list = [], total = 0, orgCount = 0;
    rows.forEach(function (r) {
      if (String(r.END_DATE || '').slice(0, 10) !== latest) return;
      var ratio = n(r.FREE_HOLDNUM_RATIO) !== null ? n(r.FREE_HOLDNUM_RATIO) : (n(r.HOLD_NUM_RATIO) || 0);
      total += ratio;
      if (String(r.IS_HOLDORG) === '1') orgCount++;
      list.push({
        rank: n(r.HOLDER_RANK), name: String(r.HOLDER_NAME || ''),
        ratio: ratio, num: n(r.HOLD_NUM), change: String(r.HOLD_NUM_CHANGE || ''),
        isOrg: String(r.IS_HOLDORG) === '1'
      });
    });
    list.sort(function (a, b) { return (a.rank || 99) - (b.rank || 99); });
    return { date: latest, list: list, total: total, orgCount: orgCount };
  }

  /* ================= 基本面评价引擎 ================= */

  function evaluate(F, A) {
    var org = F.org || {};
    var mo = F.mainop;
    var rk = F.rank;
    var hd = F.holders;
    var hf = parseFreeHolders(F.free || []);
    var hn = F.holderNum;
    var flags = [];       // {level:'red'|'yellow'|'green', text}
    var notes = [];

    function flag(level, text) { flags.push({ level: level, text: text }); }

    /* ---- 业务拆解 ---- */
    var topProduct = mo && mo.products.length ? mo.products[0] : null;
    var topRatio = topProduct ? topProduct.ratio : null;
    var topPrev = null;
    if (topProduct && mo.productsPrev.length) {
      for (var p = 0; p < mo.productsPrev.length; p++) {
        if (mo.productsPrev[p].name === topProduct.name) { topPrev = mo.productsPrev[p]; break; }
      }
    }
    var grossJump = (topProduct && topPrev) ? topProduct.gross - topPrev.gross : null;
    var regionTop = mo && mo.regions.length ? mo.regions[0] : null;

    /* ---- 行业地位 ---- */
    var ind = { name: rk ? rk.name : (A.quote.industry || '—'), num: rk ? rk.num : null, me: rk && rk.me, avg: rk && rk.avg };
    var rankCap = n(ind.me && ind.me.TMC_RANK), rankRev = n(ind.me && ind.me.TOI_RANK), rankProfit = n(ind.me && ind.me.NETPROFIT_RANK);
    var revMultiple = (ind.avg && n(ind.me.TOTAL_OPERATE_INCOME) && n(ind.avg.TOTAL_OPERATE_INCOME)) ?
      n(ind.me.TOTAL_OPERATE_INCOME) / n(ind.avg.TOTAL_OPERATE_INCOME) : null;
    var profitMultiple = (ind.avg && n(ind.me.NETPROFIT) && n(ind.avg.NETPROFIT)) ?
      n(ind.me.NETPROFIT) / n(ind.avg.NETPROFIT) : null;

    /* ---- 治理 ---- */
    var indep = org.INDEDIRECTORS ? String(org.INDEDIRECTORS).split(/[,，、]/).filter(function (x) { return x.trim(); }) : [];
    var chairman = org.CHAIRMAN || '', president = org.PRESIDENT || '', legal = org.LEGAL_PERSON || '';
    var actual = org.ACTUAL_HOLDER || '';
    var dual = !!(chairman && president && chairman === president);
    var empNum = n(org.EMP_NUM);

    /* ---- 红旗检测（这是最重要的定性补充） ---- */
    var netMargin = n(A.net);
    if (netMargin !== null && netMargin > 45 && !A.isFin) {
      flag('red', '净利率 ' + f1(netMargin) + '%，对一家非金融制造企业而言显著偏离常态（历史上该类公司多在 10–25%）。' +
        '需核实三季报是否包含并表口径变化、资产处置或公允价值收益，否则当前 PE 的分母可能被放大。');
    }
    var profitYoY = n(A.profitYoY), revYoY = n(A.revYoY);
    if (profitYoY !== null && profitYoY > 300) {
      flag('red', '归母净利同比 ' + sgn(profitYoY, 0) + '%，属爆发式增长，很大程度来自低基数与价格弹性，' +
        '不能线性外推到下一年度。');
    }
    if (grossJump !== null && grossJump > 15) {
      flag('red', '第一大业务「' + topProduct.name + '」毛利率从 ' + f1(topPrev.gross) + '% 升至 ' +
        f1(topProduct.gross) + '%（+' + f1(grossJump) + ' pct），这是典型的景气顶部特征，' +
        '而非可持续的结构性改善。');
    } else if (grossJump !== null && grossJump > 8) {
      flag('yellow', '第一大业务毛利率同比提升 ' + f1(grossJump) + ' pct，需确认是产品结构升级还是涨价周期。');
    }
    if (topRatio !== null && topRatio > 80) {
      flag('red', '「' + topProduct.name + '」贡献 ' + f1(topRatio) + '% 的营收，业务高度集中于单一品类，' +
        '该品类价格一旦反转，业绩弹性会双向放大。');
    } else if (topRatio !== null && topRatio > 60) {
      flag('yellow', '第一大业务占比 ' + f1(topRatio) + '%，集中度偏高。');
    }
    if (hn.length >= 3) {
      var first = hn[0], last = hn[Math.min(hn.length - 1, 3)];
      var growth = (last.num > 0) ? (first.num / last.num - 1) * 100 : null;
      if (growth !== null && growth > 80) {
        flag('red', '股东户数从 ' + dt(last.date) + ' 的 ' + wan(last.num) + '户增至 ' + dt(first.date) + ' 的 ' +
          wan(first.num) + '户（+' + f0(growth) + '%），筹码持续分散、户均市值下降，' +
          '是散户在高位大量接盘的典型形态。');
      } else if (first.ratio !== null && first.ratio > 20) {
        flag('yellow', '最新一期股东户数环比 ' + sgn(first.ratio, 1) + '%，筹码在分散。');
      }
    }
    if (hd.total !== null && hd.total < 30) {
      flag('yellow', '前十大股东合计仅 ' + f1(hd.total) + '%，股权分散，缺少绝对控股股东，' +
        '既意味着市场化程度高，也意味着控制权与长期战略稳定性偏弱。');
    }
    if (hd.hasNorth) {
      var ch = String(hd.hasNorth.HOLD_NUM_CHANGE || '');
      if (/^-/.test(ch)) flag('yellow', '陆股通（香港中央结算有限公司）最新一期减持 ' +
        wan(Math.abs(n(ch))) + '股，北向资金阶段性流出。');
      else flag('green', '陆股通位列前十大股东，最新一期未见减持。');
    }
    if (hd.hasNominee) {
      notes.push('前十大股东中的 HKSCC NOMINEES 是 H 股名义持有人（A+H 两地上市的股份登记账户），' +
        '持股比例计入总股本但不等于北向资金；陆股通看的是「香港中央结算有限公司」那一行。');
    }
    if (A.isFin === false && n(A.debt) !== null && n(A.debt) < 30) {
      flag('green', '资产负债率 ' + f1(A.debt) + '%，杠杆低，抗周期能力强。');
    }
    if (n(A.cashCover) !== null && n(A.cashCover) >= 1) {
      flag('green', '经营现金流 / 净利润 ' + f2(A.cashCover) + '，利润有现金支撑。');
    } else if (n(A.cashCover) !== null) {
      flag('yellow', '经营现金流 / 净利润 ' + f2(A.cashCover) + '，利润含金量不足，留意应收账款与存货。');
    }
    if (F.bonus && F.bonus.length >= 3) flag('green', '近年有连续现金分红记录（最近 ' + F.bonus.length + ' 次方案可查）。');

    /* ---- 五维基本面打分 ---- */
    // 1) 业务清晰度
    var s1 = 40;
    if (org.MAIN_BUSINESS) s1 += 18;
    if (org.ORG_PROFILE) s1 += 12;
    if (mo && mo.products.length >= 3) s1 += 15;
    else if (mo && mo.products.length >= 2) s1 += 9;
    if (mo && mo.regions.length >= 2) s1 += 8;
    if (topRatio !== null && topRatio > 85) s1 -= 8; // 过于单一，谈不上"清晰多元"
    s1 = clamp(s1, 0, 100);

    // 2) 行业地位
    var s2 = 50;
    function rankScore(rk2, num) {
      if (!rk2 || rk2 <= 0 || !num || num <= 0) return 55;
      return clamp((1 - (rk2 - 1) / num) * 100, 10, 100);
    }
    if (rk && rk.me && String(rk.me.CORRE_SECURITY_CODE || '') === A.quote.code) {
      s2 = rankScore(rankCap, ind.num) * 0.30 + rankScore(rankRev, ind.num) * 0.35 + rankScore(rankProfit, ind.num) * 0.35;
      if (profitMultiple !== null && profitMultiple > 2) s2 += 6;
      if (revMultiple !== null && revMultiple > 2) s2 += 4;
    }
    s2 = clamp(s2, 0, 100);

    // 3) 成长可持续性（爆发式增长要扣分，这是与量化模型最大的分歧点）
    var s3 = 70;
    function growthScore(g) {
      if (g === null) return 65;
      if (g < 0) return 35;
      if (g < 15) return 72;
      if (g < 40) return 90;
      if (g < 80) return 86;
      if (g < 150) return 66;
      if (g < 300) return 45;
      return 28;
    }
    s3 = growthScore(revYoY) * 0.45 + growthScore(profitYoY) * 0.55;
    if (grossJump !== null && grossJump > 15) s3 -= 18;
    else if (grossJump !== null && grossJump > 8) s3 -= 8;
    if (topRatio !== null && topRatio > 80) s3 -= 12;
    if (netMargin !== null && netMargin > 45 && !A.isFin) s3 -= 15;
    s3 = clamp(s3, 0, 100);

    // 4) 盈利质量稳定性
    // 单位口径：stock.js 的 deductRatio 与 debt 是百分数（如 85、42），cashCover 才是比率。
    // 这里把扣非占比统一换算成 0–1 比率，否则 85 会被当成 0.85 以上的「优秀」永远给满分。
    var cc = n(A.cashCover);
    var drRaw = n(A.deductRatio);
    var dr = drRaw === null ? null : drRaw / 100;
    var db = n(A.debt);
    var s4 = (cc === null ? 65 : (cc >= 1 ? 90 : cc >= 0.8 ? 74 : 52)) * 0.35 +
      (dr === null ? 65 : (dr >= 0.9 ? 90 : dr >= 0.8 ? 75 : 55)) * 0.30 +
      (db === null ? 65 : (db < 30 ? 90 : db < 60 ? 72 : 48)) * 0.35;
    if (A.fin && A.fin.length >= 3) {
      var gs = A.fin.slice(0, 4).map(function (r) { return n(r.gross); }).filter(function (v) { return v !== null; });
      if (gs.length >= 3) {
        var mx = Math.max.apply(null, gs), mn = Math.min.apply(null, gs);
        if (mx - mn > 20) s4 -= 12;
      }
    }
    s4 = clamp(s4, 0, 100);

    // 5) 治理与股东结构
    var s5 = 62;
    var actualRatio = null;
    if (actual && hd.list.length) {
      for (var ai = 0; ai < hd.list.length; ai++) {
        if (hd.list[ai].name.indexOf(actual) >= 0) { actualRatio = hd.list[ai].ratio; break; }
      }
    }
    s5 += actualRatio === null ? 0 : (actualRatio >= 20 ? 20 : actualRatio >= 10 ? 10 : -8);
    s5 += hd.total === null ? 0 : (hd.total >= 50 ? 14 : hd.total >= 30 ? 6 : -10);
    if (indep.length >= 3) s5 += 6;
    if (dual) s5 -= 5;
    if (hn.length >= 2 && hn[0].ratio !== null && hn[0].ratio > 20) s5 -= 15;
    if (hd.hasNorth && /^-/.test(String(hd.hasNorth.HOLD_NUM_CHANGE || ''))) s5 -= 6;
    s5 = clamp(s5, 0, 100);

    var totalScore = s1 * 0.15 + s2 * 0.25 + s3 * 0.25 + s4 * 0.20 + s5 * 0.15;
    var dims = [
      { k: '业务清晰度', v: s1, w: 15 }, { k: '行业地位', v: s2, w: 25 },
      { k: '成长可持续性', v: s3, w: 25 }, { k: '盈利质量稳定性', v: s4, w: 20 },
      { k: '治理与股东结构', v: s5, w: 15 }
    ];

    var grade, gradeText;
    if (totalScore >= 78) { grade = '扎实'; gradeText = '业务结构、行业位置与财务质量三者基本自洽，属于可以放进长期观察池的公司。'; }
    else if (totalScore >= 65) { grade = '优缺点分明'; gradeText = '优势与短板都很清晰，是否值得配置取决于下面几个变量能不能兑现。'; }
    else if (totalScore >= 50) { grade = '有明显短板'; gradeText = '量化分数与基本面事实之间存在明显张力，建议对量化结论打折后再用。'; }
    else { grade = '存在硬伤'; gradeText = '基本面存在结构性隐患，不适合仅凭估值便宜就参与。'; }

    // 评语：必须引用具体数字，不写套话
    var summaryBits = [];
    if (rk && rk.me && ind.num) {
      summaryBits.push('在' + ind.name + '的 ' + f0(ind.num) + ' 家公司里，净利排第 ' + f0(rankProfit) +
        '、营收排第 ' + f0(rankRev) + '、市值排第 ' + f0(rankCap));
    }
    if (topProduct) {
      summaryBits.push('营收有 ' + f1(topRatio) + '% 来自「' + topProduct.name + '」' +
        (topProduct.gross ? '，该业务毛利率 ' + f1(topProduct.gross) + '%' : ''));
    }
    if (revMultiple !== null) summaryBits.push('营收是行业均值的 ' + f1(revMultiple) + ' 倍');
    var redCount = flags.filter(function (x) { return x.level === 'red'; }).length;
    if (redCount) summaryBits.push('同时有 ' + redCount + ' 项需要警惕的结构性信号（见下方红旗）');

    /* ---- 未来前景：顺风 / 逆风 / 待验证 ---- */
    var tail = [], head = [], verify = [];
    if (rk && rk.me && rankProfit && ind.num && rankProfit <= ind.num * 0.2) {
      tail.push('盈利规模位于行业前 20%（净利第 ' + f0(rankProfit) + '/' + f0(ind.num) + '），规模效应与议价能力是实打实的。');
    }
    if (profitMultiple !== null && profitMultiple > 2) {
      tail.push('净利润是行业均值的 ' + f1(profitMultiple) + ' 倍，若景气延续，利润弹性会继续领先同行。');
    }
    if (mo && mo.regions.length >= 2) {
      tail.push('收入覆盖 ' + mo.regions.length + ' 个地区口径，第一大市场「' + regionTop.name + '」占 ' +
        f1(regionTop.ratio) + '%，具备一定的全球化分销网络。');
    }
    if (A.quote.concepts && A.quote.concepts.length) {
      tail.push('所属题材包含「' + A.quote.concepts.slice(0, 3).join('、') + '」，这些方向若形成产业趋势，公司有映射空间。');
    }
    if (F.bonus && F.bonus.length >= 3) tail.push('有连续分红记录，说明现金流与股东回报意识相对稳定。');
    if (!tail.length) tail.push('公开数据中暂未找到可量化的顺风因素，前景判断需要外部行业调研补充。');

    if (topRatio !== null && topRatio > 70) {
      head.push('业务过度集中于「' + topProduct.name + '」（' + f1(topRatio) + '%），该品类的价格周期基本决定公司业绩。');
    }
    if (netMargin !== null && netMargin > 40 && !A.isFin) {
      head.push('净利率 ' + f1(netMargin) + '% 处在极端水平，一旦价格回落，利润率与利润额会同向收缩，形成「戴维斯双杀」。');
    }
    if (profitYoY !== null && profitYoY > 200) {
      head.push('同比 ' + sgn(profitYoY, 0) + '% 的高增长自带高基数，下一年度增速大概率显著回落，市场会提前对此定价。');
    }
    if (hn.length >= 2 && hn[0].ratio !== null && hn[0].ratio > 15) {
      head.push('股东户数仍在快速增长（最近一期 ' + sgn(hn[0].ratio, 1) + '%），筹码结构不利于形成稳定的中长期持有盘。');
    }
    if (A.dims && A.dims.d5 < 45) {
      head.push('主力资金近 20 日持续净流出，与筹码分散相互印证，短期缺乏增量买盘。');
    }
    if (!head.length) head.push('公开数据里暂无明确逆风信号，但仍需关注行业整体景气变化。');

    verify.push('下一份财报的毛利率能否守住 ' + f1(n(A.gross) || 0) + '%（当前值），这是判断本轮盈利是不是周期高点的第一指标。');
    if (topProduct) verify.push('「' + topProduct.name + '」的营收占比与单价走势：占比若从 ' + f1(topRatio) + '% 回落，说明结构在改善；若继续升，说明依赖加深。');
    verify.push('股东户数是否见顶回落（当前 ' + wan(hn.length ? hn[0].num : null) + '户）：户数停止增长通常是筹码重新集中的先行信号。');
    verify.push('经营现金流 / 净利润能否回到 1 以上（当前 ' + f2(A.cashCover) + '），验证利润的含金量。');
    if (hd.hasNorth) verify.push('陆股通持仓变化：最新一期为' + (/^-/.test(String(hd.hasNorth.HOLD_NUM_CHANGE || '')) ? '减持' : '未减持') + '，可作为外资态度的跟踪项；注意 HKSCC NOMINEES 是 H 股名义持有人，不要混为一谈。');

    /* ---- 与量化结论交叉验证 ---- */
    var cross = [];
    if (A.dims && A.dims.d1 >= 85 && (netMargin > 40 || (profitYoY !== null && profitYoY > 200))) {
      cross.push('量化模型给估值 ' + f0(A.dims.d1) + ' 分（PE 分位 ' + f0(A.pePct) + '%），但基本面显示当前盈利可能处在周期高点。' +
        '低 PE 是用被放大的 E 算出来的，不等于安全边际。建议把估值分视为「待验证」，而不是买入理由。');
    }
    if (A.dims && A.dims.d3 >= 85 && profitYoY !== null && profitYoY > 200) {
      cross.push('成长维度 ' + f0(A.dims.d3) + ' 分来自 ' + sgn(profitYoY, 0) + '% 的同比增速，其中相当部分是低基数效应。' +
        '基本面给成长可持续性 ' + f0(s3) + ' 分，两者差距就是「数字很好看」与「能不能持续」之间的距离。');
    }
    if (A.dims && A.dims.d5 < 45 && hn.length >= 2 && hn[0].ratio > 15) {
      cross.push('资金面 ' + f0(A.dims.d5) + ' 分与股东户数 ' + sgn(hn[0].ratio, 1) + '% 的增长指向同一件事：机构在减、散户在接。两条独立证据互相印证。');
    }
    if (!cross.length) cross.push('基本面与六维量化结论没有明显冲突，可以正常参考量化评分。');

    return {
      org: org, mainop: mo, rank: ind, holders: hd, freeHolders: hf, holderNum: hn, bonus: F.bonus || [],
      equity: F.equity, concepts: A.quote.concepts || [], code: A.quote.code,
      topProduct: topProduct, topPrev: topPrev, grossJump: grossJump,
      revMultiple: revMultiple, profitMultiple: profitMultiple,
      indep: indep, dual: dual, empNum: empNum, actual: actual, actualRatio: actualRatio,
      flags: flags, dims: dims, score: totalScore, grade: grade, gradeText: gradeText,
      summaryBits: summaryBits, tail: tail, head: head, verify: verify, cross: cross,
      notes: notes
    };
  }

  /* ================= 渲染：公司名片 ================= */

  function htmlIdentity(B) {
    var o = B.org;
    if (!o) return '';
    var items = [
      ['公司全称', o.ORG_NAME],
      ['主营业务', cut(o.MAIN_BUSINESS, 46)],
      ['所属行业', o.EM2016 || B.rank.name],
      ['所在地', o.PROVINCE],
      ['上市 / 成立', dt(o.LISTING_DATE) + ' / ' + dt(o.FOUND_DATE)],
      ['员工', B.empNum !== null ? f0(B.empNum) + ' 人' : null],
      ['实际控制人', o.ACTUAL_HOLDER]
    ];
    return '<div class="card sa-fid">' +
      '<div class="sa-fid-top"><span class="sa-fid-lab">公司名片</span>' +
      '<span class="sa-fid-code">' + esc(o.SECURITY_TYPE || '') +
      (o.STR_CODEH ? ' · H股 ' + esc(o.STR_CODEH) : '') + '</span>' +
      '<a class="sa-fid-jump" href="#" data-jump="sa-fund-full">查看完整基本面档案 ↓</a></div>' +
      '<div class="sa-fid-grid">' + items.map(function (x) {
        return '<div class="sa-fid-i"><i>' + x[0] + '</i><b>' + (x[1] ? esc(x[1]) : '—') + '</b></div>';
      }).join('') + '</div></div>';
  }

  /* ================= 渲染：完整档案 ================= */

  function faSec(title, hint, body) {
    return '<section class="fa-sec"><div class="fa-sec-h"><h3>' + title + '</h3>' +
      (hint ? '<span>' + hint + '</span>' : '') + '</div>' + body + '</section>';
  }
  function faKv(k, v, cls) {
    return '<div class="fa-kv"><i>' + k + '</i><b class="' + (cls || '') + '">' + v + '</b></div>';
  }
  function faTable(head, rows) {
    if (!rows.length) return '<div class="fa-empty">该口径暂无披露数据</div>';
    return '<div class="tablewrap"><table class="tbl fa-tbl"><thead><tr>' +
      head.map(function (h) { return '<th' + (h.num ? ' class="num"' : '') + '>' + h.t + '</th>'; }).join('') +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function htmlFull(B, A) {
    var o = B.org || {};
    var parts = [];

    /* 1 公司做什么 */
    var p1 = '';
    if (o.ORG_PROFILE) p1 += '<p class="fa-prose">' + esc(cut(o.ORG_PROFILE, 420)) + '</p>';
    if (o.BUSINESS_SCOPE) p1 += '<p class="fa-prose dim">' + esc(cut(o.BUSINESS_SCOPE, 300)) + '</p>';
    var basicRows = [
      faKv('公司全称', val(o.ORG_NAME)),
      faKv('英文名', val(o.ORG_NAME_EN)),
      faKv('曾用名', val(o.FORMERNAME)),
      faKv('主营业务', val(o.MAIN_BUSINESS)),
      faKv('东财行业', val(o.EM2016)),
      faKv('证监会行业', val(o.INDUSTRYCSRC1)),
      faKv('所属板块', val(o.BOARD_NAME_LEVEL)),
      faKv('上市板块', val(o.SECURITY_TYPE)),
      faKv('上市日期', dt(o.LISTING_DATE)),
      faKv('成立日期', dt(o.FOUND_DATE)),
      faKv('注册资本', n(o.REG_CAPITAL) !== null ? f2(n(o.REG_CAPITAL)) + ' 万元' : '—'),
      faKv('统一社会信用代码', val(o.REG_NUM))
    ].join('');
    p1 += '<div class="fa-kvs">' + basicRows + '</div>';

    if (B.mainop) {
      var mo = B.mainop;
      var prows = mo.products.slice(0, 8).map(function (p, i) {
        var prev = null;
        mo.productsPrev.forEach(function (x) { if (x.name === p.name) prev = x; });
        var d = prev ? p.ratio - prev.ratio : null;
        return '<tr><td>' + (i + 1) + '</td><td>' + esc(p.name) + '</td>' +
          '<td class="num">' + yi(p.income) + '</td><td class="num">' + f1(p.ratio) + '%</td>' +
          '<td class="num">' + (d === null ? '—' : sgn(d, 1) + ' pct') + '</td>' +
          '<td class="num">' + f1(p.gross) + '%</td></tr>';
      }).join('');
      p1 += '<div class="fa-sub">业务构成 <span>' + dt(mo.date) + ' 报告期 · 按产品 / 业务口径</span></div>' +
        faTable([{ t: '#' }, { t: '业务' }, { t: '收入', num: 1 }, { t: '占比', num: 1 }, { t: '占比变化', num: 1 }, { t: '毛利率', num: 1 }], prows);
      p1 += '<div id="fa-mix" class="fa-chart"></div>';

      if (mo.regions.length) {
        var rrows = mo.regions.slice(0, 8).map(function (p) {
          return '<tr><td>' + esc(p.name) + '</td><td class="num">' + yi(p.income) + '</td>' +
            '<td class="num">' + f1(p.ratio) + '%</td><td class="num">' + f1(p.gross) + '%</td></tr>';
        }).join('');
        p1 += '<div class="fa-sub">地区构成 <span>同一报告期 · 按地区口径</span></div>' +
          faTable([{ t: '地区' }, { t: '收入', num: 1 }, { t: '占比', num: 1 }, { t: '毛利率', num: 1 }], rrows);
      }
      if (B.topProduct && B.topPrev) {
        p1 += '<div class="fa-insight"><b>结构变化：</b>「' + esc(B.topProduct.name) + '」占比 ' +
          f1(B.topPrev.ratio) + '% → ' + f1(B.topProduct.ratio) + '%，毛利率 ' +
          f1(B.topPrev.gross) + '% → ' + f1(B.topProduct.gross) + '%' +
          (B.grossJump !== null ? '（' + sgn(B.grossJump, 1) + ' pct）' : '') +
          '。量与价同时上行，是本期业绩爆发的主要来源。</div>';
      }
    }
    parts.push(faSec('公司做什么', '业务与主营构成', p1));

    /* 2 公司位置与联系 */
    var p2 = '<div class="fa-kvs">' + [
      faKv('注册地 / 省份', val(o.PROVINCE)),
      faKv('注册地址', val(o.REG_ADDRESS)),
      faKv('办公地址', val(o.ADDRESS)),
      faKv('邮政编码', val(o.ADDRESS_POSTCODE)),
      faKv('公司网址', val(o.ORG_WEB)),
      faKv('联系电话', val(o.ORG_TEL)),
      faKv('传真', val(o.ORG_FAX)),
      faKv('投资者邮箱', val(o.ORG_EMAIL)),
      faKv('员工人数', B.empNum !== null ? f0(B.empNum) + ' 人' : '—'),
      faKv('审计机构', val(cut(o.ACCOUNTFIRM_NAME, 60))),
      faKv('法律顾问', val(cut(o.LAW_FIRM, 60)))
    ].join('') + '</div>';
    if (o.ADDRESS && /北京|上海|深圳|广州|杭州|苏州|合肥|西安|成都|南京|武汉|无锡/.test(o.ADDRESS)) {
      p2 += '<div class="fa-insight">注册与办公所在地为' +
        esc(String(o.ADDRESS).match(/北京|上海|深圳|广州|杭州|苏州|合肥|西安|成都|南京|武汉|无锡/)[0]) +
        '，属于国内半导体 / 电子产业的主要集聚区之一，人才与供应链配套相对完整。</div>';
    }
    parts.push(faSec('公司位置与联系', '注册地、办公地、中介机构', p2));

    /* 3 行业地位 */
    var p3 = '';
    if (B.rank.me) {
      var me = B.rank.me, avg = B.rank.avg;
      var isSelf = String(me.CORRE_SECURITY_CODE || '') === B.code;
      var rrows = [
        ['总市值', yi(n(me.TOTAL_MARKET_CAP)), f0(n(me.TMC_RANK)), avg ? yi(n(avg.TOTAL_MARKET_CAP)) : '—'],
        ['流通市值', yi(n(me.FREE_MARKET_CAP)), f0(n(me.FMC_RANK)), avg ? yi(n(avg.FREE_MARKET_CAP)) : '—'],
        ['营业收入', yi(n(me.TOTAL_OPERATE_INCOME)), f0(n(me.TOI_RANK)), avg ? yi(n(avg.TOTAL_OPERATE_INCOME)) : '—'],
        ['净利润', yi(n(me.NETPROFIT)), f0(n(me.NETPROFIT_RANK)), avg ? yi(n(avg.NETPROFIT)) : '—']
      ];
      p3 += '<div class="fa-rankhead"><span class="fa-indname">' + esc(B.rank.name) + '</span>' +
        '<span class="fa-indnum">共 ' + f0(B.rank.num) + ' 家可比公司</span></div>' +
        faTable([{ t: '指标' }, { t: '本公司' }, { t: '行业排名', num: 1 }, { t: '行业均值', num: 1 }],
          rrows.map(function (r) {
            return '<tr><td>' + r[0] + '</td><td class="num">' + r[1] + '</td>' +
              '<td class="num">' + (isSelf ? r[2] : '—') + '</td><td class="num">' + r[3] + '</td></tr>';
          }).join(''));
      if (B.revMultiple !== null || B.profitMultiple !== null) {
        p3 += '<div class="fa-insight">营收是行业均值的 <b>' + f1(B.revMultiple) + ' 倍</b>，净利润是 <b>' +
          f1(B.profitMultiple) + ' 倍</b>。' +
          (B.profitMultiple > B.revMultiple ? '利润率显著高于同行，说明产品结构或本轮价格弹性是主要差异来源。' : '规模与盈利基本同步。') +
          '</div>';
      }
      var leaders = (B.rank.list || []).slice().sort(function (a, b) {
        return (n(a.TMC_RANK) || 999) - (n(b.TMC_RANK) || 999);
      }).slice(0, 5).map(function (x) { return esc(x.CORRE_SECURITY_NAME); });
      if (leaders.length) p3 += '<div class="fa-peers"><b>行业市值前列：</b>' + leaders.join(' · ') + '</div>';
    } else {
      p3 = '<div class="fa-empty">行业排名数据暂不可用</div>';
    }
    parts.push(faSec('行业地位', '同行业量化对比', p3));

    /* 4 股东分布 */
    var p4 = '';
    if (B.holders.list.length) {
      var hrows = B.holders.list.slice(0, 10).map(function (h) {
        return '<tr><td class="num">' + f0(h.rank) + '</td><td>' + esc(cut(h.name, 42)) +
          (h.isOrg ? '<em class="fa-org">机构</em>' : '') + '</td>' +
          '<td class="num">' + f2(h.ratio) + '%</td><td class="num">' + wan(h.num) + '股</td>' +
          '<td class="num">' + holderChg(h.change) + '</td></tr>';
      }).join('');
      p4 += '<div class="fa-sub">十大股东 <span>' + dt(B.holders.date) + '</span></div>' +
        faTable([{ t: '#' }, { t: '股东名称' }, { t: '持股比例', num: 1 }, { t: '持股数', num: 1 }, { t: '变动', num: 1 }], hrows);
      p4 += '<div class="fa-kvs fa-kvs-tight">' + [
        faKv('前十大合计', f1(B.holders.total) + '%'),
        faKv('机构席位数', f0(B.holders.orgCount) + ' / ' + B.holders.list.length),
        faKv('实际控制人', val(B.actual)),
        faKv('实控人持股', B.actualRatio !== null ? f2(B.actualRatio) + '%' : '未进前十 / 未披露')
      ].join('') + '</div>';
    }
    if (B.freeHolders && B.freeHolders.list.length) {
      var frows = B.freeHolders.list.slice(0, 10).map(function (h) {
        return '<tr><td class="num">' + f0(h.rank) + '</td><td>' + esc(cut(h.name, 42)) +
          (h.isOrg ? '<em class="fa-org">机构</em>' : '') + '</td>' +
          '<td class="num">' + f2(h.ratio) + '%</td><td class="num">' + wan(h.num) + '股</td>' +
          '<td class="num">' + holderChg(h.change) + '</td></tr>';
      }).join('');
      p4 += '<div class="fa-sub">十大流通股东 <span>' + dt(B.freeHolders.date) + ' · 占比按流通股口径</span></div>' +
        faTable([{ t: '#' }, { t: '股东名称' }, { t: '占流通股', num: 1 }, { t: '持股数', num: 1 }, { t: '变动', num: 1 }], frows);
      p4 += '<div class="fa-insight">前十大流通股东合计持有流通股的 <b>' + f1(B.freeHolders.total) + '%</b>，' +
        '其中机构席位 ' + f0(B.freeHolders.orgCount) + ' 个。' +
        (B.freeHolders.orgCount >= 5 ? '机构参与度高，流通盘筹码相对集中。' : '机构席位偏少，流通盘更偏产业资本与个人投资者主导。') +
        '这一栏与上面的「十大股东」并列看，能区分「总股本层面的控制权」和「实际可交易筹码」两件事。</div>';
    }
    if (B.holderNum.length) {
      var nrows = B.holderNum.slice(0, 6).map(function (h) {
        return '<tr><td>' + dt(h.date) + '</td><td class="num">' + wan(h.num) + '户</td>' +
          '<td class="num ' + (h.ratio > 0 ? 'dn' : 'up') + '">' + sgn(h.ratio, 2) + '%</td>' +
          '<td class="num">' + (h.avgCap !== null ? wan(h.avgCap) + '元' : '—') + '</td></tr>';
      }).join('');
      p4 += '<div class="fa-sub">股东户数变化 <span>户数增加 = 筹码分散</span></div>' +
        faTable([{ t: '报告期' }, { t: '股东户数', num: 1 }, { t: '环比', num: 1 }, { t: '户均市值', num: 1 }], nrows) +
        '<div id="fa-hn" class="fa-chart fa-chart-s"></div>';
      if (B.holderNum.length >= 2) {
        var a = B.holderNum[0], b = B.holderNum[B.holderNum.length - 1];
        var g = b.num > 0 ? (a.num / b.num - 1) * 100 : null;
        p4 += '<div class="fa-insight">股东户数从 ' + wan(b.num) + '户（' + dt(b.date) + '）变为 ' +
          wan(a.num) + '户（' + dt(a.date) + '）' +
          (g !== null ? '，累计 ' + sgn(g, 0) + '%' : '') +
          '；户均持股市值随之下降，通常对应行情后段的散户化过程。</div>';
      }
    }
    if (B.equity) {
      p4 += '<div class="fa-kvs fa-kvs-tight">' + [
        faKv('总股本', wan(n(B.equity.TOTAL_SHARES)) + '股'),
        faKv('流通股', wan(n(B.equity.UNLIMITED_SHARES)) + '股'),
        faKv('限售股占比', f2(n(B.equity.LIMITED_SHARES_RATIO)) + '%'),
        faKv('最近变动原因', val(B.equity.CHANGE_REASON))
      ].join('') + '</div>';
    }
    if (B.notes && B.notes.length) {
      p4 += '<div class="fa-footnote">口径提示：' + B.notes.map(esc).join(' ') + '</div>';
    }
    parts.push(faSec('股东分布', '十大股东、股东户数与股本结构', p4 || '<div class="fa-empty">股东数据暂不可用</div>'));

    /* 5 治理与管理层 */
    var p5 = '<div class="fa-kvs">' + [
      faKv('董事长', val(o.CHAIRMAN)),
      faKv('法定代表人', val(o.LEGAL_PERSON)),
      faKv('总经理 / 总裁', val(o.PRESIDENT)),
      faKv('董事会秘书', val(o.SECRETARY)),
      faKv('证券事务代表', val(o.SECPRESENT)),
      faKv('实际控制人', val(o.ACTUAL_HOLDER)),
      faKv('独立董事', indepText(B.indep)),
      faKv('员工人数', B.empNum !== null ? f0(B.empNum) + ' 人' : '—')
    ].join('') + '</div>';
    var gov = [];
    if (B.dual) gov.push('董事长同时兼任总经理 / 法定代表人，决策效率高但制衡偏弱。');
    else gov.push('董事长与总经理分设，职务分工上有基本制衡。');
    if (B.indep.length >= 3) gov.push('披露独立董事 ' + B.indep.length + ' 名，董事会构成符合常规治理要求。');
    else if (B.indep.length) gov.push('披露独立董事 ' + B.indep.length + ' 名。');
    if (B.actualRatio !== null && B.actualRatio < 10) gov.push('实际控制人持股仅 ' + f2(B.actualRatio) + '%，控制权基础偏薄。');
    if (B.holders.total !== null && B.holders.total < 30) gov.push('前十大合计 ' + f1(B.holders.total) + '%，股权高度分散。');
    p5 += '<div class="fa-insight"><b>治理结构：</b>' + esc(gov.join(' ')) + '</div>';
    p5 += '<p class="fa-footnote">公开数据接口仅提供现任人员名单与职务，未包含完整履历、任期与薪酬。' +
      '如需评估管理层能力，建议另行查阅年报「董事、监事、高级管理人员」章节。</p>';
    parts.push(faSec('治理与管理层', '现任人员与治理特征', p5));

    /* 6 股本与分红 */
    var p6 = '';
    if (B.bonus.length) {
      var brows = B.bonus.slice(0, 6).map(function (b) {
        return '<tr><td>' + dt(b.REPORT_DATE) + '</td><td>' + esc(b.IMPL_PLAN_PROFILE || '—') + '</td>' +
          '<td class="num">' + (n(b.PRETAX_BONUS_RMB) !== null ? f2(n(b.PRETAX_BONUS_RMB)) + ' 元/10股' : '—') + '</td>' +
          '<td>' + esc(b.ASSIGN_PROGRESS || '—') + '</td></tr>';
      }).join('');
      p6 += faTable([{ t: '报告期' }, { t: '分配方案' }, { t: '税前派息', num: 1 }, { t: '进度' }], brows);
      var years = B.bonus.map(function (b) { return String(b.REPORT_DATE || '').slice(0, 4); });
      p6 += '<div class="fa-insight">可查到 ' + B.bonus.length + ' 次分配方案' +
        (years.length > 1 ? '，覆盖 ' + years[years.length - 1] + '–' + years[0] + ' 年度' : '') +
        '。分红连续性反映现金流的稳定性，但派息金额随盈利波动，不宜当作固定收益看待。</div>';
    } else p6 = '<div class="fa-empty">暂无分红记录或数据不可用</div>';
    parts.push(faSec('股本与分红', '历史分配方案', p6));

    /* 7 未来前景 */
    var p7 = '<div class="fa-outlook">' +
      '<div class="fa-col pro"><h4>顺风因素</h4><ul>' +
      B.tail.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>' +
      '<div class="fa-col con"><h4>逆风因素</h4><ul>' +
      B.head.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>' +
      '</div>' +
      '<div class="fa-verify"><h4>下一份财报要盯的三到五件事</h4><ol>' +
      B.verify.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ol></div>' +
      '<p class="fa-footnote">前景部分是基于公开财务、业务结构与股东数据的规则化推演，不含行业景气调研、订单与产能验证、管理层访谈，也不构成盈利预测。</p>';
    parts.push(faSec('未来前景', '顺风 / 逆风 / 待验证', p7));

    /* 8 红旗 */
    var p8 = '';
    if (B.flags.length) {
      p8 = '<div class="fa-flags">' + B.flags.map(function (x) {
        return '<div class="fa-flag ' + x.level + '"><i>' +
          (x.level === 'red' ? '警示' : x.level === 'yellow' ? '留意' : '正面') +
          '</i><span>' + esc(x.text) + '</span></div>';
      }).join('') + '</div>';
    } else p8 = '<div class="fa-empty">未检测到明显异常信号</div>';
    parts.push(faSec('结构性信号', '自动检测，按严重程度排序', p8));

    /* 9 基本面总评 */
    var barHtml = B.dims.map(function (d) {
      return '<div class="fa-bar"><i>' + d.k + ' <em>' + d.w + '%</em></i>' +
        '<div class="fa-bar-t"><span style="width:' + f1(d.v) + '%"></span></div>' +
        '<b>' + f0(d.v) + '</b></div>';
    }).join('');
    var p9 = '<div class="fa-verdict"><div class="fa-score"><b>' + f1(B.score) + '</b><span>基本面评分</span>' +
      '<em>' + esc(B.grade) + '</em></div>' +
      '<div class="fa-score-body"><p class="fa-sum">' + esc(B.gradeText) + '</p>' +
      '<p>' + B.summaryBits.map(esc).join('；') + '。</p>' +
      '<div class="fa-bars">' + barHtml + '</div></div></div>';
    p9 += '<div class="fa-cross"><h4>与六维量化结论的交叉验证</h4><ul>' +
      B.cross.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
    p9 += '<p class="fa-footnote">基本面评分是独立于六维量化模型的第二套判断，权重为业务清晰度 15 / 行业地位 25 / 成长可持续性 25 / 盈利质量 20 / 治理 15。' +
      '它专门用来识别「数字好看但结构脆弱」的情况，与量化分不一致时应优先看这里的理由。</p>';
    parts.push(faSec('基本面总评', '独立评分 · 与量化结论对照', p9));

    return '<div class="card sa-fund"><div class="card-h"><h2>基本面档案</h2>' +
      '<span class="hint">资料来自东方财富 F10 公开数据 · 异步加载</span></div>' +
      parts.join('') + '</div>';
  }

  function indepText(list) {
    if (!list.length) return '—';
    return list.slice(0, 4).map(esc).join('、') + (list.length > 4 ? ' 等 ' + list.length + ' 人' : '');
  }

  /* ================= 图表 ================= */

  var FCHARTS = {};
  function fchart(id) {
    var el = document.getElementById(id);
    if (!el || !window.echarts) return null;
    var ins = FCHARTS[id];
    if (ins) {
      if (ins.getDom && ins.getDom() === el) return ins;
      try { ins.dispose(); } catch (e) { /* ignore */ }
      delete FCHARTS[id];
    }
    FCHARTS[id] = echarts.init(el, null, { renderer: 'canvas' });
    return FCHARTS[id];
  }

  function drawCharts(B) {
    var mix = fchart('fa-mix');
    if (mix && B.mainop && B.mainop.products.length > 1) {
      var seg = B.mainop.products.slice(0, 7);
      mix.setOption({
        grid: { left: 8, right: 20, top: 10, bottom: 6, containLabel: true },
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' },
          formatter: function (ps) {
            var d = seg[ps[0].dataIndex];
            return d.name + '<br/>收入 <b>' + yi(d.income) + '</b><br/>占比 ' + f1(d.ratio) +
              '%<br/>毛利率 ' + f1(d.gross) + '%';
          } },
        xAxis: { type: 'value', axisLabel: { color: '#8b929c', fontSize: 10, formatter: function (v) { return (v / 1e8).toFixed(0) + '亿'; } },
          splitLine: { lineStyle: { color: '#f2efe9' } } },
        yAxis: { type: 'category', inverse: true, data: seg.map(function (x) { return cut(x.name, 10); }),
          axisLabel: { color: '#5b6470', fontSize: 10.5 }, axisLine: { show: false }, axisTick: { show: false } },
        series: [{
          type: 'bar', barWidth: '58%',
          data: seg.map(function (x, i) {
            return { value: x.income, itemStyle: { color: ['#2c5f8a', '#3f7fa8', '#5b9ab8', '#7fb3c9', '#a1c8d8', '#bdd9e4', '#d6e6ed'][i], borderRadius: [0, 3, 3, 0] } };
          })
        }]
      }, true);
    }
    var hn = fchart('fa-hn');
    if (hn && B.holderNum.length >= 3) {
      var rows = B.holderNum.slice(0, 8).reverse();
      hn.setOption({
        grid: { left: 8, right: 16, top: 14, bottom: 6, containLabel: true },
        tooltip: { trigger: 'axis', formatter: function (ps) {
          var d = rows[ps[0].dataIndex]; return d.date + '<br/>股东户数 <b>' + wan(d.num) + '户</b>';
        } },
        xAxis: { type: 'category', data: rows.map(function (x) { return x.date.slice(2, 7); }),
          axisLabel: { color: '#8b929c', fontSize: 9.5 }, axisLine: { lineStyle: { color: '#e4e1da' } }, axisTick: { show: false } },
        yAxis: { type: 'value', scale: true, axisLabel: { color: '#8b929c', fontSize: 9.5, formatter: function (v) { return (v / 1e4).toFixed(0) + '万'; } },
          splitLine: { lineStyle: { color: '#f2efe9' } } },
        series: [{ type: 'line', smooth: true, symbolSize: 6,
          data: rows.map(function (x) { return x.num; }),
          lineStyle: { color: '#c0442a', width: 2 }, itemStyle: { color: '#c0442a' },
          areaStyle: { color: 'rgba(192,68,42,.10)' } }]
      }, true);
    }
    requestAnimationFrame(function () {
      resizeFund();
    });
  }

  function resizeFund() {
    Object.keys(FCHARTS).forEach(function (k) {
      try { FCHARTS[k].resize(); } catch (e) { /* ignore */ }
    });
  }

  /* ================= 对外接口 ================= */

  var TOKEN = 0;
  function load(code, A) {
    var my = ++TOKEN;
    var seccode = code + (/^6/.test(code) ? '.SH' : '.SZ');
    var idBox = document.getElementById('sa-fund-id');
    var fullBox = document.getElementById('sa-fund-full');
    if (!fullBox) return;

    function skeleton(txt) {
      return '<div class="card sa-fund-load"><span class="sa-spin"></span><span>' + txt + '</span></div>';
    }
    if (idBox) { idBox.innerHTML = skeleton('正在读取公司资料…'); idBox.removeAttribute('hidden'); }
    fullBox.innerHTML = skeleton('正在整理业务构成、行业地位与股东资料…');

    fetchAll(code, seccode).then(function (F) {
      if (my !== TOKEN) return; // 用户已经切换到另一只股票
      var ok = !!(F.org || (F.mainop && F.mainop.products.length) ||
        (F.rank && F.rank.list.length) || (F.holders && F.holders.list.length) ||
        F.holderNum.length || F.bonus.length || F.equity);
      if (!ok) {
        if (idBox) { idBox.innerHTML = ''; idBox.setAttribute('hidden', ''); }
        fullBox.innerHTML = '<div class="card sa-fund-load err">公司资料接口暂不可用，基本面档案跳过；上方六维量化分析不受影响。</div>';
        return;
      }
      var B = evaluate(F, A);
      if (idBox) {
        idBox.innerHTML = htmlIdentity(B);
        idBox.removeAttribute('hidden');
      }
      fullBox.innerHTML = htmlFull(B, A);
      drawCharts(B);
    }).catch(function (e) {
      if (window.console && console.warn) console.warn('[EB_FUND] load failed:', e && e.stack || e);
      if (my !== TOKEN) return;
      if (idBox) { idBox.innerHTML = ''; idBox.setAttribute('hidden', ''); }
      fullBox.innerHTML = '<div class="card sa-fund-load err">公司资料加载失败，基本面档案跳过；上方六维量化分析不受影响。</div>';
    });
  }

  /* 页内跳转不用 hash 锚点，避免改写 location.hash 干扰视图路由 */
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('[data-jump]') : null;
    if (!a) return;
    e.preventDefault();
    var el = document.getElementById(a.getAttribute('data-jump'));
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  /* 视口变化 / 视图重新显示时重算档案内图表尺寸 */
  window.addEventListener('resize', function () {
    clearTimeout(window.__faRz);
    window.__faRz = setTimeout(resizeFund, 140);
  });

  window.EB_FUND = { load: load, resize: resizeFund };
})();
