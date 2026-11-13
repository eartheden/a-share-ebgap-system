/* A股股债利差系统 — 应用逻辑 */
(function () {
  'use strict';

  var D = window.EB_DATA;
  var KEYS = ['hs300', 'sz50', 'zz500', 'zz1000', 'cyb'];
  var NAMES = {};
  KEYS.forEach(function (k) { NAMES[k] = D.index[k].name; });

  var BONDMAP = {};
  D.bond.series.forEach(function (x) { BONDMAP[x[0]] = x[1]; });
  var DATES = D.bond.series.map(function (x) { return x[0]; });
  var HIST_LAST = DATES[DATES.length - 1];
  var CUR_DATE = HIST_LAST;
  var CUR_BOND = BONDMAP[CUR_DATE];

  /* 实时行情层（live.js）。取不到时回落到 data.js 的锚点值。 */
  function livePoint(key) {
    var L = window.EB_LIVE;
    if (!L || typeof L.points !== 'function') return null;
    var p = L.points();
    return p && p[key] ? p[key] : null;
  }
  function liveStatus() {
    var L = window.EB_LIVE;
    return L && typeof L.status === 'function' ? L.status() : { phase: 'idle' };
  }
  /* 当前时点随实时数据变化，CUR_DATE / CUR_BOND 需同步 */
  function syncCurrent() {
    var lp = livePoint('hs300');
    CUR_DATE = lp && lp.d ? lp.d : HIST_LAST;
    var b = lp && lp.bond;
    CUR_BOND = (b > 0) ? b : (BONDMAP[CUR_DATE] || BONDMAP[HIST_LAST]);
  }

  function mean(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
  var BOND_MEAN = mean(D.bond.series.map(function (x) { return x[1]; }));

  var C = {
    ink: '#14161a', ink2: '#4a515c', ink3: '#8b929c', ink4: '#b6bcc5',
    line: '#e4e1da', buy: '#1a7f5a', warn: '#a8761c', sell: '#c0442a',
    acc: '#2c5f8a', gold: '#c9a227'
  };

  /* ---------------- 状态 ---------------- */
  var S = {
    idx: 'hs300', win: 120, bondMode: 'real', showIdx: true,
    thr: { sell: 40, buy: 80, ey: 65 },
    risk: 'balanced',
    scBond: CUR_BOND, scPct: 80
  };

  /* ---------------- 序列构建 ---------------- */
  var CACHE = {};
  function series(key) {
    if (CACHE[key]) return CACHE[key];
    var rows = D.index[key].rows;
    var out = rows.map(function (r) {
      var b = BONDMAP[r[0]];
      return {
        d: r[0], close: r[1], pe: r[2], dy: r[3],
        bond: b, ey: 100 / r[2], erp: 100 / r[2] - b
      };
    });
    /* 当前点：盘中实时价 × 锚点 PE，独立于历史月末序列 */
    var lp = livePoint(key);
    if (lp) {
      if (out.length && out[out.length - 1].d === lp.d) out[out.length - 1] = lp;
      else out.push(lp);
    }
    CACHE[key] = out;
    return out;
  }
  function erpOf(o) { return S.bondMode === 'real' ? o.erp : o.ey - BOND_MEAN; }
  function erpArr(key, win) {
    var s = series(key), a = s.map(erpOf);
    return (win && win > 0 && win < a.length) ? a.slice(-win) : a;
  }
  function pct(arr, v) {
    var c = 0; for (var i = 0; i < arr.length; i++) if (arr[i] < v) c++;
    return c / arr.length * 100;
  }
  function sd(arr) { var m = mean(arr), s = 0; for (var i = 0; i < arr.length; i++) s += (arr[i] - m) * (arr[i] - m); return Math.sqrt(s / arr.length); }
  function quantile(arr, p) {
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var i = (a.length - 1) * p / 100, lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (i - lo);
  }
  function cur(key) { var s = series(key); return s[s.length - 1]; }
  function curErp(key) { return erpOf(cur(key)); }
  function curPct(key, win) { return pct(erpArr(key, win === undefined ? S.win : win), curErp(key)); }

  /* ---------------- 信号 ---------------- */
  function signal(p) {
    var b = S.thr.buy, sl = S.thr.sell, lo = Math.max(5, sl - 20);
    if (p >= Math.min(95, b + 10)) return { c: 'buy', t: 'ERP 极高分位', d: '利差处于自身历史高位；这只是估值观察信号，不等于已见底或应立即建仓。' };
    if (p >= b) return { c: 'buy', t: 'ERP 高分位', d: '相对利差进入高位区；需继续核验盈利收益率、利率归因和市场风险后再决定是否分批。' };
    if (p >= 50) return { c: 'warn', t: '中性偏强', d: '股略优于债，可均衡偏股，但未到重仓条件。' };
    if (p >= sl) return { c: 'warn', t: '中性偏弱', d: '性价比一般，股债均衡配置为主，不宜加杠杆。' };
    if (p >= lo) return { c: 'sell', t: '中性偏空', d: '股票相对债券吸引力转弱，宜降低权益仓位、增配固收。' };
    return { c: 'sell', t: '极度高估', d: '处于历史极低分位。历史上这一区间多为顶部区域，风险大于机会。' };
  }
  function f2(x, n) { return x.toFixed(n === undefined ? 2 : n); }
  function pctTxt(p) { return f2(p, 1) + '%'; }

  /* ---------------- 建仓判断：分位双确认 + 利率归因 ---------------- */
  var ENTRY_FIT = {
    hs300: { level: '适用度较高', cls: 'fit-good', note: '行业分散、盈利相对稳定，适合作为A股核心宽基估值参照。' },
    sz50: { level: '适用度较高', cls: 'fit-good', note: '偏大盘蓝筹，但金融权重较高，需同时看银行盈利与息差。' },
    zz500: { level: '适用度中等', cls: 'fit-mid', note: '周期与中型公司盈利波动较大，需验证盈利收益率没有被盈利高点扭曲。' },
    zz1000: { level: '适用度偏低', cls: 'fit-low', note: '小盘盈利波动和行业结构变化更强，单用ERP择时可靠性较低。' },
    cyb: { level: '不宜单独使用', cls: 'fit-low', note: '成长估值与盈利弹性较大，建议看自身估值和盈利趋势，不用ERP单独择时。' }
  };
  function entryAssessment(key, win) {
    var all = series(key), len = win && win > 0 ? win : all.length;
    var view = all.slice(-len), o = all[all.length - 1];
    var erps = view.map(function (x) { return x.erp; });
    var eys = view.map(function (x) { return x.ey; });
    var bonds = view.map(function (x) { return x.bond; });
    var pErp = pct(erps, o.erp), pEy = pct(eys, o.ey);
    var erpGap = o.erp - mean(erps);
    var eyGap = o.ey - mean(eys);
    var bondGap = -(o.bond - mean(bonds));
    var rateShare = erpGap > 0.05 ? bondGap / erpGap * 100 : 0;
    var rateDominant = erpGap > 0.05 && eyGap < 0 && bondGap > 0 && rateShare >= 70;
    var fit = ENTRY_FIT[key];
    var buyLine = S.thr.buy;
    var passERP = pErp >= buyLine;
    var passEY = pEy >= S.thr.ey;
    var passRate = !rateDominant;
    var eligible = key !== 'zz1000' && key !== 'cyb' && passERP && passEY && passRate;
    var cls, label, why, next;
    if (eligible) {
      cls = 'entry-green'; label = '估值双确认 · 可评估分批建仓';
      why = 'ERP ' + f2(pErp, 1) + ' 分位、盈利收益率 ' + f2(pEy, 1) + ' 分位，且利差上升并非主要由低利率造成。只表示中长期估值条件改善，不代表短线见底。';
      next = '下一步：再核对盈利预测、市场趋势与个人风险预算；条件仍成立时再考虑分批。';
    } else if (key === 'zz1000' || key === 'cyb') {
      cls = 'entry-red'; label = '不建议仅凭 ERP 建仓';
      why = fit.note + '当前ERP ' + f2(pErp, 1) + ' 分位、盈利收益率 ' + f2(pEy, 1) + ' 分位，只作提示，不作为独立入场信号。';
      next = '下一步：改看指数自身估值分位、成分股盈利趋势和风险偏好。';
    } else if (passERP && (!passEY || !passRate)) {
      cls = 'entry-amber'; label = '利差虽高 · 建仓条件未确认';
      why = 'ERP 已到 ' + f2(pErp, 1) + ' 分位，但盈利收益率仅 ' + f2(pEy, 1) + ' 分位' +
        (rateDominant ? '，且偏离均值主要由低利率贡献（模型归因约 ' + f2(rateShare, 0) + '%）' : '') +
        '。这可能是利率造成的分母幻觉，先不按利差单独建仓。';
      next = '观察条件：盈利收益率进入自身历史较高区（≥' + S.thr.ey + ' 分位），且盈利预期/趋势未继续恶化。';
    } else if (pErp >= Math.max(50, buyLine - 15)) {
      cls = 'entry-amber'; label = '接近建仓观察区 · 暂不抢跑';
      why = 'ERP ' + f2(pErp, 1) + ' 分位，距设定买入线还差 ' + f2(Math.max(0, buyLine - pErp), 1) + ' 个百分点；盈利收益率 ' + f2(pEy, 1) + ' 分位。';
      next = '观察条件：等待 ERP 进入买入线，盈利收益率确认改善后，再复核市场风险。';
    } else {
      cls = 'entry-muted'; label = '暂不新增 · 继续观察';
      why = 'ERP ' + f2(pErp, 1) + ' 分位，未到设定买入线 ' + buyLine + '；盈利收益率 ' + f2(pEy, 1) + ' 分位。该指标目前没有给出足够的相对估值优势。';
      next = '观察条件：ERP进入高分位并由盈利端确认；不把“暂不新增”理解为必须卖出现有持仓。';
    }
    return { key: key, name: NAMES[key], o: o, pErp: pErp, pEy: pEy,
      erpGap: erpGap, eyGap: eyGap, bondGap: bondGap, rateShare: rateShare,
      rateDominant: rateDominant, fit: fit, cls: cls, label: label,
      why: why, next: next, eligible: eligible };
  }

  function renderEntryBoard() {
    var items = KEYS.map(function (k) { return entryAssessment(k, 120); });
    var eligible = items.filter(function (x) { return x.eligible; }).length;
    document.getElementById('entry-threshold-note').textContent = 'ERP ≥ ' + S.thr.buy + ' / 盈利端 ≥ ' + S.thr.ey;
    document.getElementById('entry-board').innerHTML = items.map(function (a) {
      var levelText = a.pErp >= S.thr.buy ? 'ERP线达标' : 'ERP线未达';
      return '<article class="entry-tile ' + a.cls + '">' +
        '<div class="entry-tile-head"><div><span class="entry-index">' + a.name + '</span><small>ERP ' + f2(a.o.erp) + '% · PE ' + f2(a.o.pe) + 'x</small></div>' +
        '<b class="entry-pill">' + levelText + '</b></div>' +
        '<div class="entry-percentiles"><div><span>ERP 10年分位</span><b>' + f2(a.pErp, 1) + '%</b></div>' +
        '<div><span>盈利收益率分位</span><b>' + f2(a.pEy, 1) + '%</b></div></div>' +
        '<div class="entry-mini-track"><i style="width:' + a.pErp + '%"></i><b style="left:' + a.pErp + '%"></b><em style="left:' + S.thr.buy + '%"></em></div>' +
        '<div class="entry-status"><i></i><b>' + a.label + '</b></div>' +
        '<p>' + a.why + '</p><small class="entry-fit ' + a.fit.cls + '">' + a.fit.level + ' · ' + a.fit.note + '</small>' +
        '</article>';
    }).join('');
    var ok = eligible ? '当前有 ' + eligible + ' 个指数满足双确认' : '当前没有指数同时满足建仓双确认';
    document.getElementById('entry-summary').innerHTML = '<b>' + ok + '</b><span>条件为 ERP ≥ ' + S.thr.buy + ' 分位、盈利收益率 ≥ ' + S.thr.ey + ' 分位，且不是低利率主导；中证1000与创业板不使用该模型给自动建仓提示。</span>';
  }

  function renderEntryFocus() {
    var a = entryAssessment(S.idx, S.win);
    document.getElementById('entry-focus').innerHTML =
      '<div class="entry-focus-top"><div><span class="eyebrow">' + (S.win ? 'WINDOW ' + (S.win / 12) + 'Y' : 'FULL SAMPLE') + ' · ' + a.name + '</span>' +
      '<h2>当前建仓判断</h2></div><span class="entry-status-large ' + a.cls + '">' + a.label + '</span></div>' +
      '<div class="entry-focus-metrics"><div><span>当前 ERP</span><b>' + f2(a.o.erp) + '%</b></div>' +
      '<div><span>ERP 分位</span><b>' + f2(a.pErp, 1) + '%</b></div>' +
      '<div><span>盈利收益率</span><b>' + f2(a.o.ey) + '%</b></div>' +
      '<div><span>盈利收益率分位</span><b>' + f2(a.pEy, 1) + '%</b></div>' +
      '<div><span>10Y 国债</span><b>' + f2(a.o.bond, 3) + '%</b></div>' +
      '<div><span>指数适用度</span><b class="' + a.fit.cls + '">' + a.fit.level + '</b></div></div>' +
      '<div class="entry-explain"><b>为什么这么判断</b><p>' + a.why + '</p><p>' + a.next + '</p></div>' +
      '<div class="entry-source-note">依据：该指数自身月度历史分位；建仓评估固定使用实际 10 年期国债 ERP，不随曲线页“利率中性化”切换。历史序列取自东方财富收盘价与蛋卷基金 PE（自 2016-11 起）。当前双阈值：ERP ≥ ' + S.thr.buy + '、盈利收益率分位 ≥ ' + S.thr.ey + '。</div>';
  }

  function renderEntryMatrix() {
    var head = '<thead><tr><th>指数</th><th class="num">ERP</th><th class="num">ERP分位</th><th class="num">盈利收益率分位</th><th>利率归因</th><th>建仓提示</th><th>下一步观察</th></tr></thead><tbody>';
    var body = KEYS.map(function (k) {
      var a = entryAssessment(k, S.win);
      var attrib = a.rateDominant ? '低利率主导（约 ' + f2(a.rateShare, 0) + '%）' :
        (a.eyGap >= 0 ? '盈利端贡献正向' : '盈利端未改善');
      return '<tr><td><b>' + a.name + '</b><small class="entry-fit ' + a.fit.cls + '">' + a.fit.level + '</small></td>' +
        '<td class="num"><b>' + f2(a.o.erp) + '%</b></td><td class="num">' + f2(a.pErp, 1) + '%</td>' +
        '<td class="num">' + f2(a.pEy, 1) + '%</td><td>' + attrib + '</td>' +
        '<td><span class="entry-table-status ' + a.cls + '">' + a.label + '</span></td>' +
        '<td class="entry-next">' + a.next + '</td></tr>';
    }).join('');
    document.getElementById('entry-matrix').innerHTML = head + body + '</tbody>';
  }

  /* ================= 01 总览 ================= */
  function renderOverview() {
    var c = cur(S.idx), e = curErp(S.idx);
    var p = curPct(S.idx, 120), sg = signal(p);
    var stamp = document.getElementById('hero-stamp');
    if (stamp) stamp.innerHTML = liveStampHtml();
    document.querySelector('.hero-lab').textContent = NAMES[S.idx] + ' 股权风险溢价 ERP';
    document.getElementById('h-erp').textContent = f2(e);
    document.getElementById('h-sub').innerHTML =
      '盈利收益率 <b>' + f2(c.ey) + '%</b> − 10年期国债 <b>' + f2(c.bond, 3) + '%</b><span class="hero-pe">　·　PE(TTM) ' + f2(c.pe) + ' 倍</span>';
    document.getElementById('h-pct').textContent = pctTxt(p);
    var gfill = document.getElementById('h-gfill');
    gfill.style.width = p + '%';
    gfill.style.background = sg.c === 'buy' ? '#3aa87a' : sg.c === 'sell' ? '#c9563c' : '#c9a227';
    document.getElementById('h-gdot').style.left = 'calc(' + p + '% - 1px)';
    var sgel = document.getElementById('h-sig');
    sgel.textContent = sg.t;
    sgel.style.color = sg.c === 'buy' ? '#7fd4ae' : sg.c === 'sell' ? '#f09a86' : '#e8c96a';

    /* 归因 */
    var s = series(S.idx), n = s.length;
    var eyMean = mean(s.map(function (o) { return o.ey; }));
    var bondMean = mean(s.map(function (o) { return o.bond; }));
    var erpMean = eyMean - bondMean;
    var eyGap = c.ey - eyMean, bondGap = -(c.bond - bondMean), totGap = e - erpMean;
    var mx = Math.max(Math.abs(eyGap), Math.abs(bondGap), Math.abs(totGap), 0.01);
    function bar(gap) {
      var w = Math.abs(gap) / mx * 50;
      var left = gap >= 0 ? 50 : 50 - w;
      var col = gap >= 0 ? C.buy : C.sell;
      return '<div class="att-track"><div class="att-mid"></div>' +
        '<div class="att-bar" style="left:' + left + '%;width:' + w + '%;background:' + col + ';opacity:.85"></div></div>';
    }
    var shB = totGap !== 0 ? bondGap / totGap * 100 : 0;
    var html = '';
    html += '<div class="att-row"><div class="att-k">盈利收益率 1/PE</div>' + bar(eyGap) +
      '<div class="att-v ' + (eyGap >= 0 ? 'up' : 'dn') + '">' + (eyGap >= 0 ? '+' : '') + f2(eyGap) + ' pp</div></div>';
    html += '<div class="att-row"><div class="att-k">10年期国债（反向）</div>' + bar(bondGap) +
      '<div class="att-v ' + (bondGap >= 0 ? 'up' : 'dn') + '">' + (bondGap >= 0 ? '+' : '') + f2(bondGap) + ' pp</div></div>';
    html += '<div class="att-row"><div class="att-k"><b>合计偏离历史均值</b></div>' + bar(totGap) +
      '<div class="att-v"><b>' + (totGap >= 0 ? '+' : '') + f2(totGap) + ' pp</b></div></div>';
    var verdict;
    if (shB > 70) {
      verdict = '<b>这是分母幻觉。</b>当前利差 ' + f2(e) + '%，比 2010 年以来均值（' + f2(erpMean) + '%）高 ' + f2(totGap) +
        ' 个百分点。但拆开看：国债收益率比均值低 ' + f2(Math.abs(c.bond - bondMean)) + ' pp，' +
        '给利差贡献了 <b>+' + f2(bondGap) + ' pp</b>；而盈利收益率比均值低 ' + f2(Math.abs(eyGap)) +
        ' pp，反而<b>拖累 −' + f2(Math.abs(eyGap)) + ' pp</b>。' +
        '换句话说，这 ' + f2(totGap) + ' 个点的「便宜」全部由低利率贡献，还不够抵掉股票自身变贵的部分——' +
        '一旦利率回升，利差会快速压缩，股价一动不动也一样。';
    } else if (shB > 30) {
      verdict = '<b>分子分母各出一半力。</b>盈利收益率贡献 ' + f2(eyGap) + ' pp，国债收益率贡献 ' + f2(bondGap) +
        ' pp。这种结构比纯利率驱动更健康，但仍有相当部分依赖低利率环境。';
    } else {
      verdict = '<b>这是分子端的便宜。</b>利差抬升主要来自盈利收益率上升（PE 下降），利率贡献有限，属于真实的估值便宜。';
    }
    document.getElementById('attrib').innerHTML = html + '<div class="att-note">' + verdict + '</div>';

    /* 指数卡 */
    var ch = '';
    KEYS.forEach(function (k) {
      var o = cur(k), pp = curPct(k, 120), gg = signal(pp);
      ch += '<div class="icard ' + gg.c + '">' +
        '<div class="n">' + NAMES[k] + '</div>' +
        '<div class="v">' + f2(curErp(k)) + '<span style="font-size:13px;color:#8b929c">%</span></div>' +
        '<div class="p">分位 <b style="color:' + (gg.c === 'buy' ? C.buy : gg.c === 'sell' ? C.sell : C.warn) + '">' + pctTxt(pp) + '</b> · ' + gg.t + '</div>' +
        '<div class="bar"><i style="width:' + pp + '%;background:' + (gg.c === 'buy' ? C.buy : gg.c === 'sell' ? C.sell : C.warn) + '"></i></div>' +
        '<div class="kv"><span>PE(TTM)</span><b>' + f2(o.pe) + '</b></div>' +
        '<div class="kv"><span>股息率</span><b>' + f2(o.dy) + '%</b></div>' +
        '<div class="kv"><span>点位</span><b>' + f2(o.close, 0) + '</b></div>' +
        '</div>';
    });
    document.getElementById('cards').innerHTML = ch;
    renderEntryBoard();

    /* 排名图 */
    var data = KEYS.map(function (k) {
      var pp = curPct(k, 120), gg = signal(pp);
      return { name: NAMES[k], v: pp, c: gg.c === 'buy' ? C.buy : gg.c === 'sell' ? C.sell : C.warn };
    }).sort(function (a, b) { return a.v - b.v; });
    /* 迷你走势 */
    var sAll = series(S.idx), w = 36;
    var sv = sAll.slice(-w), se = sv.map(erpOf);
    var sMean = mean(se), sMin = Math.min.apply(null, se), sMax = Math.max.apply(null, se);
    var lastV = se[se.length - 1];
    var xs2 = sv.map(function (o) { return o.d; });
    document.getElementById('spark-title').textContent = NAMES[S.idx] + ' 利差 · 近 36 个月';
    document.getElementById('spark-hint').innerHTML =
      '当前 <b>' + f2(lastV) + '%</b>　·　36 月均值 ' + f2(sMean) + '%　·　区间 ' + f2(sMin) + '% ~ ' + f2(sMax) + '%';
    var ch0 = getChart('chart-spark');
    ch0.setOption({
      grid: { left: 8, right: 70, top: 18, bottom: 24, containLabel: true },
      xAxis: {
        type: 'category', boundaryGap: false, data: xs2,
        axisLine: { lineStyle: { color: C.line } }, axisTick: { show: false },
        axisLabel: {
          color: C.ink3, fontSize: 10.5, hideOverlap: true,
          formatter: function (v, i) {
            if (i === 0 || i === xs2.length - 1) return v.slice(2);
            var mm = v.slice(5);
            return (mm === '01' || mm === '04' || mm === '07' || mm === '10') ? v.slice(2) : '';
          }
        }
      },
      yAxis: {
        type: 'value', scale: true, splitNumber: 4,
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: '#f2efe9' } },
        axisLabel: { color: C.ink3, fontSize: 10.5, formatter: '{value}%' }
      },
      tooltip: {
        trigger: 'axis',
        formatter: function (ps) {
          var p0 = ps[0];
          return p0.axisValue + '<br/>利差 <b>' + f2(p0.value) + '%</b>';
        }
      },
      series: [{
        type: 'line', smooth: true, symbol: 'none',
        data: se,
        lineStyle: { width: 1.8, color: C.acc },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [{ offset: 0, color: 'rgba(44,95,138,.20)' }, { offset: 1, color: 'rgba(44,95,138,.02)' }]
          }
        },
        markLine: {
          silent: true, symbol: 'none',
          lineStyle: { color: C.ink4, type: 'dashed', width: 1 },
          label: { show: false },
          data: [{ yAxis: sMean }]
        },
        markPoint: {
          symbol: 'circle', symbolSize: 7,
          itemStyle: { color: C.acc, borderColor: '#fff', borderWidth: 1.5 },
          label: {
            show: true, position: 'right', fontSize: 11, fontWeight: 'bold', color: C.ink,
            formatter: f2(lastV) + '%'
          },
          data: [{ coord: [xs2.length - 1, lastV] }]
        }
      }]
    }, true);

    var ch1 = getChart('chart-rank');
    ch1.setOption({
      grid: { left: 84, right: 62, top: 12, bottom: 46 },
      xAxis: {
        type: 'value', max: 100, name: '分位(%)', nameLocation: 'middle', nameGap: 26,
        nameTextStyle: { color: C.ink3, fontSize: 11 },
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: '#f2efe9' } },
        axisLabel: { color: C.ink3, fontSize: 11, formatter: '{value}' }
      },
      yAxis: {
        type: 'category', data: data.map(function (x) { return x.name; }),
        axisLine: { lineStyle: { color: C.line } }, axisTick: { show: false },
        axisLabel: { color: C.ink2, fontSize: 12 }
      },
      tooltip: { trigger: 'item', formatter: function (p) { return p.name + '：分位 ' + f2(p.value, 1) + '%'; } },
      series: [{
        type: 'bar', barWidth: 16,
        data: data.map(function (x) { return { value: x.v, itemStyle: { color: x.c, borderRadius: [0, 3, 3, 0] } }; }),
        label: {
          show: true, position: 'right', fontSize: 11.5, fontWeight: 'bold', color: C.ink,
          formatter: function (p) { return f2(p.value, 1) + '%'; }
        },
        markLine: {
          silent: true, symbol: 'none',
          lineStyle: { color: C.ink4, type: 'dashed', width: 1 },
          label: { show: false },
          data: [{ xAxis: 50 }]
        }
      }]
    }, true);
  }

  /* ================= 02 曲线 ================= */
  function renderCurve() {
    var s = series(S.idx);
    var win = S.win > 0 ? S.win : s.length;
    var view = s.slice(-win);
    var ea = view.map(erpOf);
    var m = mean(ea), d = sd(ea);
    var p20 = quantile(ea, 20), p80 = quantile(ea, 80);
    var xs = view.map(function (o) { return o.d.slice(2).replace('-', '/'); });

    document.getElementById('curve-title').textContent = NAMES[S.idx] + ' 股权风险溢价' + (S.bondMode === 'neutral' ? '（利率中性化）' : '');
    document.getElementById('curve-hint').textContent =
      '窗口 ' + (S.win > 0 ? S.win / 12 + ' 年' : '全样本') + '　均值 ' + f2(m) + '%　标准差 ' + f2(d) +
      (S.bondMode === 'neutral' ? '　基准利率固定为 ' + f2(BOND_MEAN) + '%' : '');

    var seriesOpt = [{
      name: 'ERP(%)', type: 'line', showSymbol: false, smooth: false, z: 5,
      data: ea,
      lineStyle: { width: 2.2, color: C.acc },
      itemStyle: { color: C.acc },
      markLine: {
        silent: true, symbol: 'none',
        data: [
          { yAxis: m, lineStyle: { color: C.ink3, type: 'dashed', width: 1.1 }, label: { formatter: '均值 ' + f2(m), position: 'insideStartTop', fontSize: 10, color: C.ink3 } },
          { yAxis: m + d, lineStyle: { color: C.ink4, type: 'dotted', width: 1 }, label: { formatter: '+1σ ' + f2(m + d), position: 'insideStartTop', fontSize: 10, color: C.ink4 } },
          { yAxis: m - d, lineStyle: { color: C.ink4, type: 'dotted', width: 1 }, label: { formatter: '−1σ ' + f2(m - d), position: 'insideStartBottom', fontSize: 10, color: C.ink4 } },
          { yAxis: p80, lineStyle: { color: 'rgba(26,127,90,.55)', type: 'solid', width: 1 }, label: { formatter: '80分位 ' + f2(p80), position: 'insideEndTop', fontSize: 10, color: C.buy } },
          { yAxis: p20, lineStyle: { color: 'rgba(192,68,42,.55)', type: 'solid', width: 1 }, label: { formatter: '20分位 ' + f2(p20), position: 'insideEndBottom', fontSize: 10, color: C.sell } }
        ]
      },
      markPoint: {
        symbol: 'circle', symbolSize: 7, data: [{ coord: [xs.length - 1, ea[ea.length - 1]] }],
        itemStyle: { color: C.sell, borderColor: '#fff', borderWidth: 2 },
        label: {
          show: true, position: 'left', offset: [-5, 0], fontSize: 11.5, fontWeight: 'bold', color: C.ink,
          formatter: f2(ea[ea.length - 1])
        }
      }
    }];

    if (S.showIdx) {
      seriesOpt.push({
        name: '指数点位（右轴）', type: 'line', yAxisIndex: 1, showSymbol: false, z: 2,
        data: view.map(function (o) { return o.close; }),
        lineStyle: { width: 1.1, color: 'rgba(170,164,152,.95)' },
        itemStyle: { color: 'rgba(170,164,152,.95)' }
      });
    }

    function yearly(idx, val) {
      return idx === 0 || idx === xs.length - 1 || val.slice(-3) === '/01';
    }

    getChart('chart-curve').setOption({
      grid: { left: 58, right: S.showIdx ? 64 : 24, top: 42, bottom: 34 },
      legend: {
        show: S.showIdx, left: 58, top: 4, itemWidth: 16, itemHeight: 2, itemGap: 18,
        textStyle: { color: C.ink3, fontSize: 11 }
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: C.ink4 } },
        formatter: function (ps) {
          var o = view[ps[0].dataIndex];
          var t = '<b>' + o.d + '</b><br/>';
          t += 'ERP：<b>' + f2(erpOf(o)) + '%</b><br/>';
          t += 'PE(TTM)：' + f2(o.pe) + ' 倍<br/>';
          t += '盈利收益率：' + f2(o.ey) + '%<br/>';
          t += '10Y 国债：' + f2(o.bond, 3) + '%<br/>';
          t += '指数点位：' + f2(o.close, 0);
          return t;
        }
      },
      xAxis: {
        type: 'category', data: xs, boundaryGap: false,
        axisLine: { lineStyle: { color: C.line } }, axisTick: { show: false },
        axisLabel: { color: C.ink3, fontSize: 10.5, interval: yearly }
      },
      yAxis: [
        {
          type: 'value', scale: true,
          axisLine: { show: false }, axisTick: { show: false },
          splitLine: { lineStyle: { color: '#f2efe9' } },
          axisLabel: { color: C.ink3, fontSize: 11, formatter: '{value}%' }
        },
        {
          type: 'value', scale: true, show: S.showIdx,
          axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
          axisLabel: { color: C.ink4, fontSize: 10.5, formatter: function (v) { return v >= 10000 ? (v / 10000).toFixed(1) + '万' : v; } }
        }
      ],
      series: seriesOpt
    }, true);

    /* 拆解图 */
    getChart('chart-decomp').setOption({
      grid: { left: 52, right: 30, top: 42, bottom: 34 },
      legend: { left: 52, top: 4, itemWidth: 14, itemHeight: 8, itemGap: 20, textStyle: { color: C.ink3, fontSize: 11 } },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: C.ink4 } },
        formatter: function (ps) {
          var o = view[ps[0].dataIndex];
          return '<b>' + o.d + '</b><br/>盈利收益率 1/PE：' + f2(o.ey) + '%<br/>10Y 国债：' +
            f2(o.bond, 3) + '%<br/>利差 ERP：<b>' + f2(o.ey - o.bond) + '%</b>';
        }
      },
      xAxis: {
        type: 'category', data: xs, boundaryGap: false,
        axisLine: { lineStyle: { color: C.line } }, axisTick: { show: false },
        axisLabel: { color: C.ink3, fontSize: 10.5, interval: yearly }
      },
      yAxis: {
        type: 'value', scale: true,
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: '#f2efe9' } },
        axisLabel: { color: C.ink3, fontSize: 11, formatter: '{value}%' }
      },
      series: [
        {
          name: '10年期国债', type: 'line', stack: 'band', showSymbol: false, z: 3,
          data: view.map(function (o) { return o.bond; }),
          lineStyle: { width: 1.6, color: C.sell }, itemStyle: { color: C.sell },
          areaStyle: { color: 'rgba(192,68,42,.16)' }
        },
        {
          name: '盈利收益率（蓝带顶边）', type: 'line', stack: 'band', showSymbol: false, z: 4,
          data: view.map(function (o) { return o.ey - o.bond; }),
          lineStyle: { width: 2.2, color: C.acc }, itemStyle: { color: C.acc },
          areaStyle: { color: 'rgba(44,95,138,.18)' }
        }
      ]
    }, true);

    /* 最近 12 期表 */
    var last = view.slice(-12).reverse();
    var th = '<thead><tr><th>月份</th><th class="num">指数点位</th><th class="num">PE(TTM)</th>' +
      '<th class="num">盈利收益率</th><th class="num">10Y国债</th><th class="num">ERP</th><th class="num">窗口分位</th></tr></thead><tbody>';
    last.forEach(function (o) {
      var pp = pct(ea, erpOf(o));
      th += '<tr><td>' + o.d + '</td><td class="num">' + f2(o.close, 0) + '</td><td class="num">' + f2(o.pe) +
        '</td><td class="num">' + f2(o.ey) + '%</td><td class="num">' + f2(o.bond, 3) + '%</td>' +
        '<td class="num"><b>' + f2(erpOf(o)) + '%</b></td><td class="num">' + f2(pp, 1) + '%</td></tr>';
    });
    document.getElementById('tbl-recent').innerHTML = th + '</tbody>';
  }

  /* ================= 03 分位与信号 ================= */
  function renderSignal() {
    var p = curPct(S.idx, S.win), sg = signal(p);
    var b = S.thr.buy, s = S.thr.sell;
    renderEntryFocus();
    renderEntryMatrix();
    var lo = Math.max(5, s - 20);
    var zones = [
      { from: 0, to: lo, col: '#8f2c1a', t: '极度高估' },
      { from: lo, to: s, col: '#c0442a', t: '中性偏空' },
      { from: s, to: 50, col: '#c98a2a', t: '中性偏弱' },
      { from: 50, to: b, col: '#8f9a3a', t: '中性偏强' },
      { from: b, to: 100, col: '#1a7f5a', t: '低估 · 加仓' }
    ];
    var rh = '<div class="ruler-mark" style="left:' + p + '%"><span>' + f2(p, 1) + '%</span></div>' +
      '<div class="ruler-bands">';
    zones.forEach(function (z) {
      var w = z.to - z.from;
      if (w <= 0) return;
      rh += '<div class="ruler-band" style="width:' + w + '%;background:' + z.col + '">' + z.t + '</div>';
    });
    rh += '</div>';
    rh += '<div class="ruler-scale"><span>0 · 极度高估</span><span>25</span><span>50</span><span>75</span><span>100 · 极度低估</span></div>';
    document.getElementById('ruler').innerHTML = rh;

    document.getElementById('thr-row').innerHTML =
      '<div class="thr"><div class="thr-h"><span>买入阈值（严入）</span><b>' + b + ' 分位</b></div>' +
      '<input type="range" id="thr-buy" min="50" max="95" value="' + b + '"></div>' +
      '<div class="thr"><div class="thr-h"><span>卖出阈值（宽出）</span><b>' + s + ' 分位</b></div>' +
      '<input type="range" id="thr-sell" min="5" max="45" value="' + s + '"></div>' +
      '<div class="thr"><div class="thr-h"><span>盈利端二次确认</span><b>' + S.thr.ey + ' 分位</b></div>' +
      '<input type="range" id="thr-ey" min="40" max="90" step="5" value="' + S.thr.ey + '"></div>';
    document.getElementById('thr-buy').addEventListener('input', function () {
      S.thr.buy = +this.value; renderSignal(); renderOverview();
    });
    document.getElementById('thr-sell').addEventListener('input', function () {
      S.thr.sell = +this.value; renderSignal(); renderOverview();
    });
    document.getElementById('thr-ey').addEventListener('input', function () {
      S.thr.ey = +this.value; renderSignal(); renderOverview();
    });

    var o = cur(S.idx);
    document.getElementById('sig-out').innerHTML =
      '<div class="sigbox ' + sg.c + '">' +
      '<div class="k">' + NAMES[S.idx] + ' · 当前信号</div>' +
      '<div class="t">' + sg.t + '</div>' +
      '<div class="d">ERP ' + f2(curErp(S.idx)) + '%　分位 ' + pctTxt(p) + '<br>' + sg.d + '</div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:14px">' +
      ['PE(TTM) ' + f2(o.pe) + ' 倍', '股息率 ' + f2(o.dy) + '%', '点位 ' + f2(o.close, 0)].map(function (t) {
        return '<div style="background:#faf9f6;border-radius:6px;padding:10px;font-size:11.5px;color:#4a515c;text-align:center">' + t + '</div>';
      }).join('') + '</div>';

    var wins = [[36, '近 3 年'], [60, '近 5 年'], [120, '近 10 年'], [0, '全样本']];
    var wh = '<table class="tbl"><thead><tr><th>窗口</th><th class="num">利差均值</th><th class="num">当前分位</th><th>信号</th></tr></thead><tbody>';
    wins.forEach(function (w) {
      var arr = erpArr(S.idx, w[0]), pp = pct(arr, curErp(S.idx)), g = signal(pp);
      wh += '<tr><td>' + w[1] + '</td><td class="num">' + f2(mean(arr)) + '%</td>' +
        '<td class="num"><b>' + f2(pp, 1) + '%</b></td>' +
        '<td class="' + (g.c === 'buy' ? 'g' : g.c === 'sell' ? 'r' : 'y') + '">' + g.t + '</td></tr>';
    });
    document.getElementById('win-tbl').innerHTML = wh + '</tbody>';

    var mh = '<thead><tr><th>指数</th><th class="num">当前 ERP</th><th class="num">3年</th><th class="num">5年</th>' +
      '<th class="num">10年</th><th class="num">全样本</th><th>10年分位信号</th></tr></thead><tbody>';
    KEYS.forEach(function (k) {
      var e = curErp(k), g = signal(curPct(k, 120));
      mh += '<tr><td><b>' + NAMES[k] + '</b></td><td class="num">' + f2(e) + '%</td>';
      [36, 60, 120, 0].forEach(function (w) {
        mh += '<td class="num">' + f2(pct(erpArr(k, w), e), 1) + '%</td>';
      });
      mh += '<td class="' + (g.c === 'buy' ? 'g' : g.c === 'sell' ? 'r' : 'y') + '">' + g.t + '</td></tr>';
    });
    document.getElementById('tbl-matrix').innerHTML = mh + '</tbody>';
  }

  /* ================= 04 配置建议 ================= */
  var RISK = {
    conservative: { base: 25, slope: 0.40, name: '保守型' },
    balanced: { base: 45, slope: 0.60, name: '均衡型' },
    aggressive: { base: 60, slope: 0.80, name: '进取型' }
  };
  function allocOf(p, risk) {
    var r = RISK[risk];
    var v = r.base + r.slope * (p - 50);
    return Math.max(0, Math.min(100, v));
  }
  function renderAlloc() {
    var p = curPct(S.idx, S.win);
    var eq = allocOf(p, S.risk);
    var r = RISK[S.risk];
    var bondPct = Math.max(0, 100 - eq - 10);
    document.getElementById('alloc-out').innerHTML =
      '<div class="alloc-big"><div class="alloc-num">' + f2(eq, 0) + '<em>%</em></div>' +
      '<div class="alloc-split"><div style="font-size:12px;color:#8b929c;margin-bottom:8px">' +
      NAMES[S.idx] + ' 当前分位 ' + f2(p, 1) + '%　·　' + r.name + '　·　信号 ' + signal(p).t + '</div>' +
      '<div class="alloc-bar"><i style="width:' + eq + '%;background:#2c5f8a"></i>' +
      '<i style="width:' + bondPct + '%;background:#c9a227"></i>' +
      '<i style="width:' + (100 - eq - bondPct) + '%;background:#cfcac0"></i></div>' +
      '<div class="alloc-legend"><span><s style="background:#2c5f8a"></s>权益 ' + f2(eq, 0) + '%</span>' +
      '<span><s style="background:#c9a227"></s>债券 ' + f2(bondPct, 0) + '%</span>' +
      '<span><s style="background:#cfcac0"></s>现金 ' + f2(100 - eq - bondPct, 0) + '%</span></div></div></div>' +
      '<p style="font-size:12.5px;color:#4a515c;line-height:1.85;padding-top:14px;border-top:1px dashed #efece6">' +
      '仓位公式：<span class="mono" style="font-size:11.5px">' + r.base + '% + ' + r.slope + ' × (分位 − 50)</span>，' +
      '裁剪在 0–100%。分位 50 对应基准仓位 ' + r.base + '%，分位 80 对应 ' + f2(allocOf(80, S.risk), 0) +
      '%，分位 20 对应 ' + f2(allocOf(20, S.risk), 0) + '%。这是刻度尺，不是预测器。</p>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:14px;padding-top:14px;border-top:1px dashed #efece6">' +
      '<div><div style="font-size:10.5px;color:#8b929c">当前分位</div>' +
      '<div style="font-size:17px;font-weight:600;margin-top:2px">' + f2(p, 1) + '%</div></div>' +
      '<div><div style="font-size:10.5px;color:#8b929c">距买入阈值</div>' +
      '<div style="font-size:17px;font-weight:600;margin-top:2px;color:' + (p >= S.thr.buy ? C.buy : C.ink) + '">' +
      (p >= S.thr.buy ? '已触发' : f2(S.thr.buy - p, 1) + ' pp') + '</div></div>' +
      '<div><div style="font-size:10.5px;color:#8b929c">距卖出阈值</div>' +
      '<div style="font-size:17px;font-weight:600;margin-top:2px;color:' + (p < S.thr.sell ? C.sell : C.ink) + '">' +
      (p < S.thr.sell ? '已触发' : f2(p - S.thr.sell, 1) + ' pp') + '</div></div>' +
      '</div>';

    var pts = [];
    for (var i = 0; i <= 100; i += 1) { pts.push([i, +allocOf(i, S.risk).toFixed(1)]); }
    getChart('chart-alloc').setOption({
      grid: { left: 52, right: 30, top: 22, bottom: 46 },
      xAxis: {
        type: 'value', min: 0, max: 100, name: '分位(%)',
        nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: C.ink3, fontSize: 11 },
        axisLine: { lineStyle: { color: C.line } }, axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { color: C.ink3, fontSize: 10.5 }
      },
      yAxis: {
        type: 'value', max: 100,
        axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: '#f2efe9' } },
        axisLabel: { color: C.ink3, fontSize: 10.5, formatter: '{value}%' }
      },
      tooltip: {
        trigger: 'axis',
        formatter: function (ps) { return '分位 ' + ps[0].value[0] + '%<br/>建议权益仓位：<b>' + ps[0].value[1] + '%</b>'; }
      },
      series: [{
        type: 'line', data: pts, showSymbol: false, smooth: false,
        lineStyle: { width: 2.2, color: C.acc }, itemStyle: { color: C.acc },
        areaStyle: { color: 'rgba(44,95,138,.10)' },
        markLine: {
          silent: true, symbol: 'none', z: 2,
          lineStyle: { color: C.sell, type: 'dashed', width: 1.2 },
          label: { formatter: '当前分位 ' + f2(p, 1) + '%', position: 'end', fontSize: 10, color: C.sell },
          data: [{ xAxis: p }]
        },
        markPoint: {
          symbol: 'circle', symbolSize: 9, z: 5,
          data: [{ coord: [p, +allocOf(p, S.risk).toFixed(1)] }],
          itemStyle: { color: C.sell, borderColor: '#fff', borderWidth: 2 },
          label: { show: false }
        }
      }]
    }, true);

    /* 回测（序列较短时自动缩短起点，避免样本为 0） */
    var s = series(S.idx), out = [];
    var btStart = Math.min(60, Math.max(24, Math.floor(s.length * 0.35)));
    for (var j = btStart; j < s.length - 12; j++) {
      var w = s.slice(Math.max(0, j - 120), j).map(erpOf);
      var pp = pct(w, erpOf(s[j]));
      var fwd = (s[j + 12].close / s[j].close - 1) * 100;
      out.push({ p: pp, r: fwd });
    }
    var buckets = [[0, 20], [20, 40], [40, 60], [60, 80], [80, 100]];
    var agg = buckets.map(function (b) {
      var xs2 = out.filter(function (x) { return x.p >= b[0] && x.p < (b[1] === 100 ? 101 : b[1]); });
      var rr = xs2.map(function (x) { return x.r; });
      return {
        name: b[0] + '–' + b[1] + '%', n: xs2.length,
        avg: rr.length ? mean(rr) : 0,
        win: rr.length ? rr.filter(function (v) { return v > 0; }).length / rr.length * 100 : 0
      };
    });
    getChart('chart-bt').setOption({
      grid: { left: 56, right: 24, top: 24, bottom: 40 },
      xAxis: {
        type: 'category', data: agg.map(function (a) { return a.name; }),
        axisLine: { lineStyle: { color: C.line } }, axisTick: { show: false },
        axisLabel: { color: C.ink2, fontSize: 11 }
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: '#f2efe9' } },
        axisLabel: { color: C.ink3, fontSize: 10.5, formatter: '{value}%' }
      },
      tooltip: {
        trigger: 'item',
        formatter: function (p) {
          var a = agg[p.dataIndex];
          return '分位 ' + a.name + '<br/>样本 ' + a.n + ' 个月<br/>未来12月平均收益：<b>' + f2(a.avg, 1) + '%</b><br/>胜率：' + f2(a.win, 0) + '%';
        }
      },
      series: [{
        type: 'bar', barWidth: 42,
        data: agg.map(function (a) {
          return {
            value: +a.avg.toFixed(2),
            itemStyle: { color: a.avg >= 0 ? 'rgba(192,68,42,.72)' : 'rgba(26,127,90,.72)', borderRadius: 3 },
            label: { position: a.avg >= 0 ? 'top' : 'bottom' }
          };
        }),
        label: {
          show: true, fontSize: 11, fontWeight: 'bold', color: C.ink,
          formatter: function (p) { return (p.value >= 0 ? '+' : '') + p.value.toFixed(1) + '%'; }
        },
        markLine: { silent: true, symbol: 'none', lineStyle: { color: C.ink4, width: 1, type: 'dashed' }, label: { show: false }, data: [{ yAxis: 0 }] }
      }]
    }, true);

    var bh = '<thead><tr><th>利差分位区间</th><th class="num">样本月数</th><th class="num">未来12月平均收益</th><th class="num">胜率</th><th>读数</th></tr></thead><tbody>';
    agg.forEach(function (a, ai) {
      var lowSide = ai <= 1;
      var read;
      if (lowSide) read = a.avg < 0 ? '符合预期：分位低时后续收益为负' : '不符合预期：低分位反而录得正收益';
      else if (ai === 4) read = a.avg > 0 ? '符合预期：分位高时收益最好' : '不符合预期：高分位反而亏钱';
      else read = a.avg > 0 ? '正收益，方向正确但幅度有限' : '负收益，方向正确';
      bh += '<tr><td><b>' + a.name + '</b></td><td class="num">' + a.n + '</td>' +
        '<td class="num ' + (a.avg >= 0 ? 'r' : 'g') + '">' + (a.avg >= 0 ? '+' : '') + f2(a.avg, 1) + '%</td>' +
        '<td class="num">' + f2(a.win, 0) + '%</td>' +
        '<td style="white-space:normal;color:#4a515c">' + read + '</td></tr>';
    });
    document.getElementById('tbl-bt').innerHTML = bh + '</tbody>';
    document.getElementById('bt-hint').textContent =
      '基于真实月度序列的粗检验：每月末计算滚动分位，统计其后 12 个月指数收益。样本 ' + out.length + ' 个月。';
  }

  /* ================= 06 历史复盘 ================= */
  var HIST_CASES = [
    {
      key: '2014-06', date: '2014-06', label: '2014 年大底', tag: '历史性底部', tagCls: 'g',
      offSeries: true, snapshot: { close: 2165, pe: 8.0, bond: 4.05, erp: 8.2, pct: 99 },
      macro: '2014 年上半年，经济增速下行至 7.4%，PMI 持续在 50 附近徘徊。央行于 2014 年 4 月开始定向降准，货币宽松预期升温。房地产销售大幅下滑，市场情绪极度悲观，沪深300 在 2000 点附近横盘。',
      erpDesc: '沪深300 PE 降至约 8 倍，盈利收益率超过 12%，10 年期国债约 4.05%，ERP 达到 8.2%——为 2010 年以来最高值。分位接近 100%。',
      action: '信号在 2014 年 4-6 月持续触发，7 月开始降息预期进一步升温，11 月央行正式降息，牛市启动。',
      outcome: '其后 6 个月沪深300 上涨 +44.3%，12 个月上涨 +151.1%（至 2015 年 6 月牛市顶）。这是利差信号最成功的案例之一——但极值持续了约 5 个月才真正启动。',
      lesson: '利差到了极值不等于立刻涨，但耐心等待的回报极为丰厚。这也是「极值可以持续很久」的典型。',
      ret3m: '+19.3%', ret6m: '+44.3%', ret12m: '+151.1%', ret24m: '+32.7%'
    },
    {
      key: '2015-06', date: '2015-06', label: '2015 年牛市顶', tag: '历史性顶部', tagCls: 'r',
      offSeries: true, snapshot: { close: 4473, pe: 18.4, bond: 3.6, erp: 1.8, pct: 1 },
      macro: '杠杆牛市到达顶点。创业板 PE 超 100 倍，沪深300 PE 约 18 倍。场外配资规模庞大，监管开始清查。6 月 15 日开始大规模去杠杆，千股跌停频发。',
      erpDesc: '沪深300 PE 约 18.4 倍，盈利收益率仅 5.4%，10 年期国债约 3.6%，ERP 降至 1.8%——为 2010 年以来最低值。分位接近 0%。',
      action: '利差信号在 2015 年 3-6 月持续给出「极度高估」。但市场情绪亢奋，几乎无人理会。',
      outcome: '其后 3 个月沪深300 暴跌 -33.1%，12 个月仍亏损 -34.3%。千股跌停、国家队入场救市，成为中国股市最惨烈的记忆之一。',
      lesson: '利差极低分位是有效的顶部预警——但市场可以在极低分位维持几个月才崩。顶部信号比底部信号更难精确择时。',
      ret3m: '-33.1%', ret6m: '-45.7%', ret12m: '-34.3%', ret24m: '-16.8%'
    },
    {
      key: '2018-12', date: '2018-12', label: '2018 年贸易摩擦底', tag: '周期底部', tagCls: 'g',
      macro: '中美贸易摩擦持续升级，经济增速下行。社融增速大幅放缓，信用违约频发。股权质押风险暴露，市场恐慌情绪浓厚。10 月政策开始转向，但市场信心恢复缓慢。',
      erpDesc: '沪深300 PE 降至约 10.5 倍，盈利收益率约 9.5%，10 年期国债约 3.3%，ERP 达到 6.2%。10 年分位约 88%。',
      action: '利差信号在 2018 年 10 月就开始进入高分位区，但指数底部直到 12 月才确认，滞后约 2 个月。2019 年 1 月社融大超预期，春季行情启动。',
      outcome: '其后 3 个月上涨 +28.6%，12 个月上涨 +36.1%。春季行情快速且猛烈，但很多投资者在 10-11 月的恐慌中离场，错过了反弹。',
      lesson: '利差见顶先于指数见底，中间有 1-3 个月滞后。在分位已经很高时恐慌卖出，往往是最大的错误。',
      ret3m: '+28.6%', ret6m: '+27.2%', ret12m: '+36.1%', ret24m: '+52.5%'
    },
    {
      key: '2020-03', date: '2020-03', label: '2020 年疫情底', tag: '事件型底部', tagCls: 'g',
      macro: '新冠疫情全球爆发，恐慌情绪极度。美股 10 天内 4 次熔断，全球市场同步暴跌。国内春节后开盘即大幅低开，3 月随海外恐慌二次探底。',
      erpDesc: '沪深300 PE 约 11.5 倍，盈利收益率约 8.7%，10 年期国债约 2.6%，ERP 达到 6.1%。10 年分位约 82%。',
      action: '利差信号在 3 月中下旬触发，但这次市场恢复极快——美联储无限量 QE + 国内复工复产推进，V 型反弹。',
      outcome: '其后 3 个月上涨 +17.7%，12 个月上涨 +30.3%。核心资产（白酒、医药、新能源）在 2020 年下半年走出结构性行情。',
      lesson: '事件型底部的利差信号来得快去得也快。如果等「信号更明确」再进，可能错过最快的反弹阶段。',
      ret3m: '+17.7%', ret6m: '+26.2%', ret12m: '+30.3%', ret24m: '+18.4%'
    },
    {
      key: '2021-02', date: '2021-02', label: '2021 年核心资产顶', tag: '结构性顶部', tagCls: 'r',
      macro: '「茅指数」「宁组合」带领核心资产估值达历史高位。公募基金抱团严重，头部公司 PE 普遍超 60 倍。通胀预期升温，美债收益率快速上行。',
      erpDesc: '沪深300 PE 约 16.5 倍，盈利收益率约 6.1%，10 年期国债约 3.2%，ERP 降至 2.9%。10 年分位约 12%。',
      action: '利差信号给出「偏高估」提示，但分位未到极端低位（不像 2015 年的 0%），因此信号强度不如 2015 年明确。',
      outcome: '其后 3 个月下跌 -14.3%，12 个月下跌 -20.1%。核心资产抱团瓦解，但周期股反而走强——市场风格剧烈切换，而非全面崩盘。',
      lesson: '不是所有顶部都像 2015 年那样利差到极端低位。结构性高估时，利差信号可能偏弱——需要结合成分股估值离散度判断。',
      ret3m: '-14.3%', ret6m: '-17.8%', ret12m: '-20.1%', ret24m: '-13.6%'
    },
    {
      key: '2024-02', date: '2024-02', label: '2024 年流动性危机底', tag: '政策底', tagCls: 'g',
      macro: '雪球产品集中敲入、量化 DMA 策略爆仓、微盘股崩跌，流动性危机蔓延。监管紧急限制做空、汇金入市购买 ETF。市场在最恐慌时出现政策底。',
      erpDesc: '沪深300 PE 约 10.8 倍，盈利收益率约 9.3%，10 年期国债约 2.35%，ERP 达到 6.9%。10 年分位约 90%。',
      action: '利差信号在 2024 年 1 月就已进入高分位，2 月流动性危机加速出清后，政策强力介入，市场快速反弹。',
      outcome: '其后 3 个月上涨 +12.4%，至 2024 年 11 月受政策刺激进一步加速。但后续走势分化严重，小盘股恢复缓慢。',
      lesson: '流动性危机型底部的利差信号有效，但恢复路径不对称——大盘蓝筹先涨，中小盘可能长期低迷。',
      ret3m: '+12.4%', ret6m: '+18.9%', ret12m: '+22.7%', ret24m: '—'
    }
  ];

  var S_HIST = { idx: 'hs300', activeCase: 0 };

  function renderHistory() {
    var key = S_HIST.idx;
    var s = series(key);
    var erps = s.map(erpOf);
    var m = mean(erps), d = sd(erps);
    var p20 = quantile(erps, 20), p80 = quantile(erps, 80);
    var xs = s.map(function (o) { return o.d.slice(2).replace('-', '/'); });

    document.getElementById('hist-curve-title').textContent = NAMES[key] + ' ERP 全景与关键时点';
    document.getElementById('hist-table-hint').textContent = NAMES[key] + ' 口径 · 10 年滚动分位';
    document.getElementById('hist-dist-hint').textContent = NAMES[key] + ' 全样本 ' + s.length + ' 个月 · 纵轴为出现月数';

    /* 全景 ERP 曲线 + 关键时点标注 */
    var markLines = [
      { yAxis: m, lineStyle: { color: C.ink3, type: 'dashed', width: 1 }, label: { formatter: '均值 ' + f2(m), position: 'insideStartTop', fontSize: 10, color: C.ink3 } },
      { yAxis: m + d, lineStyle: { color: C.ink4, type: 'dotted', width: 1 }, label: { formatter: '+1σ', position: 'insideStartTop', fontSize: 10, color: C.ink4 } },
      { yAxis: m - d, lineStyle: { color: C.ink4, type: 'dotted', width: 1 }, label: { formatter: '−1σ', position: 'insideStartBottom', fontSize: 10, color: C.ink4 } },
      { yAxis: p80, lineStyle: { color: 'rgba(24,116,95,.5)', width: 1 }, label: { formatter: '80分位', position: 'insideEndTop', fontSize: 10, color: C.buy } },
      { yAxis: p20, lineStyle: { color: 'rgba(187,75,67,.5)', width: 1 }, label: { formatter: '20分位', position: 'insideEndBottom', fontSize: 10, color: C.sell } }
    ];
    var markPoints = HIST_CASES.map(function (c) {
      var i = s.findIndex(function (o) { return o.d === c.date; });
      if (i < 0) return null;
      return {
        coord: [i, erpOf(s[i])],
        symbol: 'pin', symbolSize: 38,
        itemStyle: { color: c.tagCls === 'g' ? C.buy : c.tagCls === 'r' ? C.sell : C.warn },
        label: { show: true, fontSize: 9, color: '#fff', formatter: c.label.slice(0, 4), fontWeight: 'bold' }
      };
    }).filter(Boolean);

    getChart('chart-hist-curve').setOption({
      grid: { left: 56, right: 30, top: 40, bottom: 34 },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: C.ink4 } },
        formatter: function (ps) {
          var o = s[ps[0].dataIndex];
          return '<b>' + o.d + '</b><br/>ERP：<b>' + f2(erpOf(o)) + '%</b><br/>PE：' + f2(o.pe) + ' 倍<br/>10Y国债：' + f2(o.bond, 2) + '%<br/>点位：' + f2(o.close, 0);
        }
      },
      xAxis: {
        type: 'category', data: xs, boundaryGap: false,
        axisLine: { lineStyle: { color: C.line } }, axisTick: { show: false },
        axisLabel: { color: C.ink3, fontSize: 10, interval: function (i, v) { return v.slice(-3) === '/01' || i === 0 || i === xs.length - 1; } }
      },
      yAxis: {
        type: 'value', scale: true,
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: '#f2efe9' } },
        axisLabel: { color: C.ink3, fontSize: 11, formatter: '{value}%' }
      },
      series: [{
        type: 'line', data: erps, showSymbol: false, smooth: false, z: 5,
        lineStyle: { width: 2, color: C.acc }, itemStyle: { color: C.acc },
        areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(49,107,157,.16)' }, { offset: 1, color: 'rgba(49,107,157,.02)' }] } },
        markLine: { silent: true, symbol: 'none', data: markLines },
        markPoint: { symbol: 'pin', data: markPoints }
      }]
    }, true);

    /* 时段切换 tabs */
    var tabsHtml = HIST_CASES.map(function (c, i) {
      return '<button class="hist-tab ' + (i === S_HIST.activeCase ? 'on' : '') + ' ' + c.tagCls + '" data-i="' + i + '"><b>' + c.label + '</b>' +
        '<span class="hist-tab-meta"><span class="hist-tab-tag ' + c.tagCls + '">' + c.tag + '</span>' +
        (c.offSeries ? '<span class="hist-tab-off">站外</span>' : '') + '</span></button>';
    }).join('');
    document.getElementById('hist-tabs').innerHTML = tabsHtml;
    document.getElementById('hist-tabs').querySelectorAll('.hist-tab').forEach(function (b) {
      b.addEventListener('click', function () {
        S_HIST.activeCase = +this.dataset.i;
        renderHistDetail();
        document.getElementById('hist-tabs').querySelectorAll('.hist-tab').forEach(function (x) { x.classList.remove('on'); });
        this.classList.add('on');
      });
    });
    renderHistDetail();

    /* 分位 → 收益映射（序列较短时自动缩短起点，窗口最长 120 个月） */
    var out = [];
    var startJ = Math.min(60, Math.max(24, Math.floor(s.length * 0.35)));
    for (var j = startJ; j < s.length - 3; j++) {
      var w = s.slice(Math.max(0, j - 120), j).map(erpOf);
      var pp = pct(w, erpOf(s[j]));
      var fwd3 = j + 3 < s.length ? (s[j + 3].close / s[j].close - 1) * 100 : null;
      var fwd6 = j + 6 < s.length ? (s[j + 6].close / s[j].close - 1) * 100 : null;
      var fwd12 = j + 12 < s.length ? (s[j + 12].close / s[j].close - 1) * 100 : null;
      var fwd24 = j + 24 < s.length ? (s[j + 24].close / s[j].close - 1) * 100 : null;
      out.push({ p: pp, r3: fwd3, r6: fwd6, r12: fwd12, r24: fwd24 });
    }
    var buckets = [[0, 20], [20, 40], [40, 60], [60, 80], [80, 100]];
    var agg = buckets.map(function (b) {
      var xs2 = out.filter(function (x) { return x.p >= b[0] && x.p < (b[1] === 100 ? 101 : b[1]); });
      function avg(f) { var vs = xs2.map(function (x) { return x[f]; }).filter(function (v) { return v !== null; }); return vs.length ? mean(vs) : null; }
      function win(f) { var vs = xs2.map(function (x) { return x[f]; }).filter(function (v) { return v !== null; }); return vs.length ? vs.filter(function (v) { return v > 0; }).length / vs.length * 100 : 0; }
      return {
        name: b[0] + '–' + b[1] + '%', n: xs2.length,
        r3: avg('r3'), r6: avg('r6'), r12: avg('r12'), r24: avg('r24'),
        win12: win('r12')
      };
    });
    document.getElementById('hist-bt-hint').textContent = NAMES[key] + ' · 样本 ' + out.length + ' 个月 · 真实序列';

    getChart('chart-hist-bt').setOption({
      grid: { left: 56, right: 24, top: 38, bottom: 40 },
      legend: { left: 56, top: 4, itemWidth: 14, itemHeight: 8, itemGap: 16, textStyle: { color: C.ink3, fontSize: 11 } },
      xAxis: {
        type: 'category', data: agg.map(function (a) { return a.name; }),
        axisLine: { lineStyle: { color: C.line } }, axisTick: { show: false },
        axisLabel: { color: C.ink2, fontSize: 11 }
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: '#f2efe9' } },
        axisLabel: { color: C.ink3, fontSize: 10.5, formatter: '{value}%' }
      },
      tooltip: {
        trigger: 'item',
        formatter: function (p) {
          var a = agg[p.dataIndex];
          return '分位 ' + a.name + '<br/>样本 ' + a.n + ' 个月<br/>3个月均收益：<b>' + (a.r3 === null ? '—' : f2(a.r3, 1) + '%') + '</b><br/>6个月均收益：<b>' + (a.r6 === null ? '—' : f2(a.r6, 1) + '%') + '</b><br/>12个月均收益：<b>' + (a.r12 === null ? '—' : f2(a.r12, 1) + '%') + '</b><br/>24个月均收益：<b>' + (a.r24 === null ? '—' : f2(a.r24, 1) + '%') + '</b><br/>12月胜率：' + f2(a.win12, 0) + '%';
        }
      },
      series: [
        { name: '3个月', type: 'bar', barWidth: 18, data: agg.map(function (a) { return a.r3 === null ? 0 : +a.r3.toFixed(2); }), itemStyle: { color: 'rgba(49,107,157,.35)', borderRadius: 3 } },
        { name: '6个月', type: 'bar', barWidth: 18, data: agg.map(function (a) { return a.r6 === null ? 0 : +a.r6.toFixed(2); }), itemStyle: { color: 'rgba(49,107,157,.55)', borderRadius: 3 } },
        { name: '12个月', type: 'bar', barWidth: 18, data: agg.map(function (a) { return a.r12 === null ? 0 : +a.r12.toFixed(2); }), itemStyle: { color: 'rgba(49,107,157,.8)', borderRadius: 3 } },
        { name: '24个月', type: 'bar', barWidth: 18, data: agg.map(function (a) { return a.r24 === null ? 0 : +a.r24.toFixed(2); }), itemStyle: { color: 'rgba(24,116,95,.7)', borderRadius: 3 } }
      ]
    }, true);

    var bh = '<thead><tr><th>利差分位区间</th><th class="num">样本</th>' +
      '<th class="num">3月均收益</th><th class="num">6月均收益</th><th class="num">12月均收益</th><th class="num">24月均收益</th><th class="num">12月胜率</th></tr></thead><tbody>';
    agg.forEach(function (a) {
      bh += '<tr><td><b>' + a.name + '</b></td><td class="num">' + a.n + '</td>' +
        '<td class="num ' + (a.r3 === null ? '' : a.r3 >= 0 ? 'r' : 'g') + '">' + (a.r3 === null ? '—' : (a.r3 >= 0 ? '+' : '') + f2(a.r3, 1) + '%') + '</td>' +
        '<td class="num ' + (a.r6 === null ? '' : a.r6 >= 0 ? 'r' : 'g') + '">' + (a.r6 === null ? '—' : (a.r6 >= 0 ? '+' : '') + f2(a.r6, 1) + '%') + '</td>' +
        '<td class="num ' + (a.r12 === null ? '' : a.r12 >= 0 ? 'r' : 'g') + '">' + (a.r12 === null ? '—' : (a.r12 >= 0 ? '+' : '') + f2(a.r12, 1) + '%') + '</td>' +
        '<td class="num ' + (a.r24 === null ? '' : a.r24 >= 0 ? 'r' : 'g') + '">' + (a.r24 === null ? '—' : (a.r24 >= 0 ? '+' : '') + f2(a.r24, 1) + '%') + '</td>' +
        '<td class="num">' + f2(a.win12, 0) + '%</td></tr>';
    });
    document.getElementById('tbl-hist-bt').innerHTML = bh + '</tbody>';

    /* 关键时点速览表 */
    var lookback = s.slice(-19, -1); // 排除当前点，取近 18 个月找本轮高点
    var peak = lookback.length ? lookback.reduce(function (a, b) { return b.close > a.close ? b : a; }) : null;
    var peakMonth = peak ? peak.d : null;
    var allPicks = HIST_CASES.map(function (c) { return c.date; });
    if (peakMonth) allPicks.push(peakMonth);
    allPicks.push(CUR_DATE);
    allPicks = allPicks.filter(function (d, i) { return allPicks.indexOf(d) === i; });
    var labelMap = {};
    HIST_CASES.forEach(function (c) { labelMap[c.date] = c.label; });
    if (peakMonth) labelMap[peakMonth] = '本轮高点';
    labelMap[CUR_DATE] = '当前';
    var h = '<thead><tr><th>时点</th><th>性质</th><th class="num">指数点位</th><th class="num">PE</th>' +
      '<th class="num">10Y国债</th><th class="num">ERP</th><th class="num">当时10年分位</th><th class="num">其后3月</th><th class="num">其后12月</th></tr></thead><tbody>';
    allPicks.forEach(function (d) {
      var i = s.findIndex(function (o) { return o.d === d; });
      if (i < 0) return;
      var o = s[i];
      var w = s.slice(Math.max(0, i - 119), i + 1).map(erpOf);
      var pp = pct(w, erpOf(o));
      var fwd3 = i + 3 < s.length ? (s[i + 3].close / o.close - 1) * 100 : null;
      var fwd12 = i + 12 < s.length ? (s[i + 12].close / o.close - 1) * 100 : null;
      var isCur = d === CUR_DATE;
      h += '<tr' + (isCur ? ' style="background:#fdfbf6"' : '') + '><td><b>' + d + '</b>' + (isCur ? ' <span style="font-size:10px;color:#a8761c">当前</span>' : '') +
        '</td><td style="color:#4a515c">' + (labelMap[d] || '—') + '</td>' +
        '<td class="num">' + f2(o.close, 0) + '</td><td class="num">' + f2(o.pe) + '</td>' +
        '<td class="num">' + f2(o.bond, 2) + '%</td><td class="num"><b>' + f2(erpOf(o)) + '%</b></td>' +
        '<td class="num">' + f2(pp, 1) + '%</td>' +
        '<td class="num ' + (fwd3 === null ? '' : fwd3 >= 0 ? 'r' : 'g') + '">' +
        (fwd3 === null ? '—' : (fwd3 >= 0 ? '+' : '') + f2(fwd3, 1) + '%') + '</td>' +
        '<td class="num ' + (fwd12 === null ? '' : fwd12 >= 0 ? 'r' : 'g') + '">' +
        (fwd12 === null ? '—' : (fwd12 >= 0 ? '+' : '') + f2(fwd12, 1) + '%') + '</td></tr>';
    });
    document.getElementById('tbl-history').innerHTML = h + '</tbody>';

    /* 极值分布 */
    var lo = Math.floor(Math.min.apply(null, erps) * 2) / 2, hi = Math.ceil(Math.max.apply(null, erps) * 2) / 2;
    var bins = [], step = 0.5;
    for (var v = lo; v < hi; v += step) bins.push({ a: v, b: v + step, n: 0 });
    erps.forEach(function (x) {
      for (var k = 0; k < bins.length; k++) if (x >= bins[k].a && x < bins[k].b) { bins[k].n++; break; }
    });
    var ce = curErp(key);
    getChart('chart-dist').setOption({
      grid: { left: 52, right: 24, top: 34, bottom: 50 },
      xAxis: {
        type: 'category', data: bins.map(function (b) { return f2(b.a, 1); }),
        name: 'ERP(%)', nameLocation: 'middle', nameGap: 28, nameTextStyle: { color: C.ink3, fontSize: 11 },
        axisLine: { lineStyle: { color: C.line } }, axisTick: { show: false },
        axisLabel: { color: C.ink3, fontSize: 10, interval: 1 }
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: '#f2efe9' } },
        axisLabel: { color: C.ink3, fontSize: 10.5 }
      },
      tooltip: {
        trigger: 'axis',
        formatter: function (ps) { var b = bins[ps[0].dataIndex]; return b.a.toFixed(1) + '% ~ ' + b.b.toFixed(1) + '%<br/>出现 <b>' + b.n + '</b> 个月'; }
      },
      series: [{
        type: 'bar', barWidth: '72%',
        data: bins.map(function (b) {
          var isCur = ce >= b.a && ce < b.b;
          return { value: b.n, itemStyle: { color: isCur ? C.sell : 'rgba(49,107,157,.4)', borderRadius: [2, 2, 0, 0] } };
        }),
        label: {
          show: true, position: 'top', distance: 6, fontSize: 10, fontWeight: 'bold', color: C.ink,
          formatter: function (p) { var b = bins[p.dataIndex]; return (ce >= b.a && ce < b.b) ? '当前 ' + f2(ce) : ''; }
        }
      }]
    }, true);
  }

  function renderHistDetail() {
    var c = HIST_CASES[S_HIST.activeCase];
    var key = S_HIST.idx;
    var s = series(key);
    var i = s.findIndex(function (o) { return o.d === c.date; });

    /* 序列内时点：用真实数据；早于序列起点的案例：用公开资料快照 */
    var snap = null;
    if (i >= 0) {
      var o = s[i];
      var w = s.slice(Math.max(0, i - 119), i + 1).map(erpOf);
      snap = {
        close: o.close, pe: o.pe, bond: o.bond,
        erp: erpOf(o), pct: pct(w, erpOf(o)), live: true
      };
    } else if (c.snapshot) {
      snap = {
        close: c.snapshot.close, pe: c.snapshot.pe, bond: c.snapshot.bond,
        erp: c.snapshot.erp, pct: c.snapshot.pct, live: false
      };
    }
    if (!snap) {
      document.getElementById('hist-detail').innerHTML = '<p>数据不可用</p>';
      return;
    }

    var retHtml = [
      ['其后 3 个月', c.ret3m], ['其后 6 个月', c.ret6m],
      ['其后 12 个月', c.ret12m], ['其后 24 个月', c.ret24m]
    ].map(function (r) {
      var isPos = r[1].indexOf('+') === 0;
      var isNA = r[1] === '—';
      return '<div class="hist-ret ' + (isNA ? '' : isPos ? 'pos' : 'neg') + '"><i>' + r[0] + '</i><b>' + r[1] + '</b></div>';
    }).join('');

    var offNote = snap.live ? '' :
      '<p class="hist-offnote">该时点早于本站数据起点（' + (D.meta && D.meta.startMonth ? D.meta.startMonth : '2016-11') +
      '），点位与 PE 取自公开资料，不参与本站曲线与分位计算。收益为沪深300 口径。</p>';

    document.getElementById('hist-detail').innerHTML =
      '<div class="hist-case">' +
      '<div class="hist-case-head">' +
      '<div class="hist-case-title"><h3>' + c.label + '</h3><span class="hist-tag ' + c.tagCls + '">' + c.tag + '</span></div>' +
      '<div class="hist-case-stats">' +
      '<div><span>日期</span><b>' + c.date + '</b></div>' +
      '<div><span>指数点位</span><b>' + f2(snap.close, 0) + '</b></div>' +
      '<div><span>PE(TTM)</span><b>' + f2(snap.pe) + '</b></div>' +
      '<div><span>10Y国债</span><b>' + f2(snap.bond, 2) + '%</b></div>' +
      '<div><span>ERP</span><b>' + f2(snap.erp) + '%</b></div>' +
      '<div><span>10年分位</span><b>' + f2(snap.pct, 1) + '%</b></div>' +
      '</div></div>' + offNote +
      '<div class="hist-ret-grid">' + retHtml + '</div>' +
      '<div class="hist-case-body">' +
      '<div class="hist-sec"><h4>宏观背景</h4><p>' + c.macro + '</p></div>' +
      '<div class="hist-sec"><h4>利差信号</h4><p>' + c.erpDesc + '</p></div>' +
      '<div class="hist-sec"><h4>市场反应</h4><p>' + c.action + '</p></div>' +
      '<div class="hist-sec"><h4>后续走势</h4><p>' + c.outcome + '</p></div>' +
      '<div class="hist-sec hl"><h4>复盘教训</h4><p>' + c.lesson + '</p></div>' +
      '</div></div>';
  }

  /* 选股引擎 v3：全市场每日重算，打分与渲染全部在 picker.js，这里只做入口委托 */
  function renderPickWrap() {
    if (window.EB_PICKER && typeof window.EB_PICKER.render === 'function') {
      window.EB_PICKER.render();
      /* 只有真正进入本页才判断要不要重抓；拖动权重/切模式不会触发全市场刷新 */
      if (typeof window.EB_PICKER.enter === 'function') window.EB_PICKER.enter();
      return;
    }
    var vp = document.getElementById('v-pick');
    if (vp) {
      vp.innerHTML = '<div class="card pk-statecard"><div class="pk-err"><b>选股引擎脚本未加载</b>' +
        '<p>请确认 picker.js 与 index.html 在同一目录并刷新页面；若仍失败，打开浏览器控制台查看加载错误。</p></div></div>';
    }
  }

  /* ---------------- 图表实例管理 ---------------- */
  var CHARTS = {};
  function getChart(id) {
    var el = document.getElementById(id);
    if (!el) return { setOption: function () { }, resize: function () { } };
    if (!CHARTS[id]) CHARTS[id] = echarts.init(el, null, { renderer: 'canvas' });
    return CHARTS[id];
  }
  function resizeAll() { Object.keys(CHARTS).forEach(function (k) { CHARTS[k].resize(); }); }

  /* ---------------- 视图路由 ---------------- */
  function renderStock() {
    if (window.EB_STOCK && typeof window.EB_STOCK.render === 'function') window.EB_STOCK.render();
  }
  var RENDER = {
    overview: renderOverview, curve: renderCurve, signal: renderSignal,
    alloc: renderAlloc,
    pick: renderPickWrap,
    stock: renderStock,
    history: renderHistory
  };
  var DONE = {};
  function show(v) {
    document.querySelectorAll('.view').forEach(function (e) { e.classList.remove('on'); });
    document.getElementById('v-' + v).classList.add('on');
    document.querySelectorAll('.navi').forEach(function (b) { b.classList.toggle('on', b.dataset.v === v); });
    S.view = v;
    RENDER[v]();
    setTimeout(resizeAll, 40);
    if (location.hash !== '#' + v) history.replaceState(null, '', '#' + v);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  window.addEventListener('hashchange', function () {
    var v = location.hash.replace('#', '');
    if (RENDER[v] && v !== S.view) show(v);
  });

  /* ---------------- 交互绑定 ---------------- */
  document.getElementById('nav').addEventListener('click', function (e) {
    var b = e.target.closest('.navi');
    if (b) show(b.dataset.v);
  });

  /* 曲线页指数切换 */
  var seg = document.getElementById('curve-idx');
  seg.innerHTML = KEYS.map(function (k) {
    return '<button data-k="' + k + '"' + (k === S.idx ? ' class="on"' : '') + '>' + NAMES[k] + '</button>';
  }).join('');
  seg.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    S.idx = b.dataset.k;
    seg.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x.dataset.k === S.idx); });
    renderCurve(); renderOverview(); renderSignal();
  });
  document.getElementById('curve-win').addEventListener('change', function () {
    S.win = +this.value; renderCurve();
  });
  document.getElementById('curve-bond').addEventListener('change', function () {
    S.bondMode = this.value; renderCurve();
  });
  document.getElementById('curve-showidx').addEventListener('change', function () {
    S.showIdx = this.checked; renderCurve();
  });

  /* 风险偏好 */
  document.getElementById('risk-seg').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    S.risk = b.dataset.r;
    this.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x.dataset.r === S.risk); });
    renderAlloc();
  });

  /* 历史复盘指数切换 */
  var histSeg = document.getElementById('hist-idx');
  if (histSeg) {
    histSeg.innerHTML = KEYS.map(function (k) {
      return '<button data-k="' + k + '"' + (k === S_HIST.idx ? ' class="on"' : '') + '>' + NAMES[k] + '</button>';
    }).join('');
    histSeg.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      S_HIST.idx = b.dataset.k;
      histSeg.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x.dataset.k === S_HIST.idx); });
      renderHistory();
    });
  }

  /* CSV */
  document.getElementById('btn-csv').addEventListener('click', function () {
    var s = series(S.idx);
    var rows = [['月份', '指数点位', 'PE_TTM', '股息率', '盈利收益率', '10Y国债', 'ERP']];
    s.forEach(function (o) {
      rows.push([o.d, o.close, o.pe, o.dy, o.erp + o.bond, o.bond, (S.bondMode === 'real' ? o.erp : o.ey - BOND_MEAN).toFixed(4)]);
    });
    var csv = '\ufeff' + rows.map(function (r) { return r.join(','); }).join('\n');
    var a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    a.download = 'ERP_' + NAMES[S.idx] + '_' + CUR_DATE + '.csv';
    a.click();
  });

  window.addEventListener('resize', function () { clearTimeout(window.__rz); window.__rz = setTimeout(resizeAll, 120); });

  /* ---------------- 侧栏：行情状态 ---------------- */
  function liveStampHtml() {
    var st = liveStatus();
    var an = (D.meta && D.meta.anchor) || {};
    var peBase = an.peDate || '—';
    if (st.phase === 'live') {
      return '<span class="ls-dot on"></span><b>盘中实时</b>' +
        (st.quoteTime ? ' ' + st.quoteTime.slice(11) : '') +
        '<i>PE 基准 ' + peBase + '，按实时价格缩放</i>';
    }
    if (st.phase === 'closed') {
      return '<span class="ls-dot off"></span><b>已收盘</b>' +
        (st.quoteTime ? ' ' + st.quoteTime.slice(0, 16) : '') +
        '<i>PE 基准 ' + peBase + '</i>';
    }
    if (st.phase === 'error') {
      return '<span class="ls-dot err"></span><b>行情接口不可达</b>' +
        '<i>显示离线锚点 · PE ' + peBase + '</i>';
    }
    return '<span class="ls-dot wait"></span><b>正在获取实时行情…</b>';
  }

  function updateSide() {
    var st = liveStatus();
    var badge = document.getElementById('sf-live');
    var bt = document.getElementById('sf-live-t');
    var bs = document.getElementById('sf-live-s');
    if (badge) {
      var cls = 'live-badge';
      var title, sub;
      if (st.phase === 'live') {
        cls += ' on-live';
        title = '盘中实时';
        sub = st.quoteTime ? st.quoteTime.slice(11) + ' 更新 · 每分钟刷新' : '每分钟刷新';
      } else if (st.phase === 'closed') {
        cls += ' on-closed';
        title = '已收盘';
        sub = st.quoteTime ? st.quoteTime.slice(0, 16) + ' 收盘价' : '显示最近收盘价';
      } else if (st.phase === 'error') {
        cls += ' on-error';
        title = '行情接口不可达';
        sub = (st.error || '取数失败') + ' · 已回落到离线锚点';
      } else {
        cls += ' on-loading';
        title = '获取行情中';
        sub = '正在连接行情源';
      }
      badge.className = cls;
      if (bt) bt.textContent = title;
      if (bs) bs.textContent = sub;
    }

    var bondEl = document.getElementById('sf-bond');
    if (bondEl) bondEl.textContent = f2(CUR_BOND, 3) + '%';

    var bondLab = document.getElementById('sf-bond-lab');
    if (bondLab) {
      var bd = (D.meta && D.meta.anchor && D.meta.anchor.bondDate) || '';
      bondLab.textContent = bd ? '10Y 国债 ' + bd.slice(5) : '10Y 国债';
    }

    var dateEl = document.getElementById('sf-date');
    if (dateEl) {
      var d = st.quoteTime ? st.quoteTime.slice(0, 10)
        : ((D.meta && D.meta.dataDate) || CUR_DATE);
      dateEl.textContent = d;
    }

    var noteEl = document.getElementById('sf-note');
    if (noteEl) {
      var an = (D.meta && D.meta.anchor) || {};
      noteEl.innerHTML = 'PE 基准 ' + (an.peDate || '—') +
        '<br>国债基准 ' + (an.bondDate || '—');
    }
  }

  /* ---------------- 启动 ---------------- */
  syncCurrent();
  updateSide();
  var boot = location.hash.replace('#', '').split('=')[0];
  show(RENDER[boot] ? boot : 'overview');

  /* 实时行情就绪后重算并重绘当前页 */
  if (window.EB_LIVE && typeof window.EB_LIVE.start === 'function') {
    window.EB_LIVE.start(function () {
      CACHE = {};
      syncCurrent();
      updateSide();
      if (S.view && RENDER[S.view]) {
        RENDER[S.view]();
        setTimeout(resizeAll, 30);
      }
    });
  }
})();
