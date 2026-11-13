/* A股股债利差系统 — AI 复核层
 *
 * 定位：不做全市场初筛（模型已经做了），只对量化模型筛出的 20 只候选做二次复核：
 *   重排优先级、写出可验证的理由、指出该剔除谁、给一句执行纪律。
 *
 * 通信：全部走本机 server.py 的 /api/ai/*，API Key 只存在本机文件，永不进入页面。
 * 缓存：按交易日 + 候选名单指纹缓存在 localStorage，同一天不重复花钱。
 */
(function () {
  'use strict';

  var CACHE_PREFIX = 'ebgap.ai.v1.';
  var MAX_PICKS = 20;

  var S = {
    status: null,
    loading: true,
    booted: false,
    running: false,
    pendingFp: null,
    result: null,
    resultFp: null,     // 当前 result 对应的名单指纹
    at: null,
    model: '',
    usage: null,
    error: null,
    cfgOpen: false,
    cfgProvider: 'deepseek',
    cfgBase: null,
    cfgModel: null,
    cfgKey: '',
    cfgMsg: null
  };

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function hhmm(d) {
    var t = d || new Date();
    return ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2);
  }
  function api(path, body) {
    var opt = body ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    } : {};
    var ctrl = null, timer = null;
    if (typeof AbortController !== 'undefined') {
      ctrl = new AbortController();
      opt.signal = ctrl.signal;
      timer = setTimeout(function () { ctrl.abort(); }, 100000);
    }
    function done() { if (timer) clearTimeout(timer); }
    return fetch('api/ai/' + path, opt).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) {
          throw new Error('本地服务返回了非 JSON 内容（HTTP ' + r.status + '），请确认用的是 server.py 启动的服务');
        }
        if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    }).then(function (v) { done(); return v; }, function (e) {
      done();
      if (e && e.name === 'AbortError') throw new Error('请求超时，模型接口长时间没有响应');
      throw e;
    });
  }

  function picker() { return window.EB_PICKER; }
  function payload() {
    var p = picker();
    if (!p || !p.payload) return null;
    return p.payload(MAX_PICKS);
  }
  function fingerprint(pl) {
    if (!pl) return '';
    var s = (pl.quoteDate || '') + '|' + (pl.mkt ? pl.mkt.temp : '');
    (pl.picks || []).forEach(function (x) { s += '|' + x.code + ':' + x.total; });
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return String(h);
  }

  /* ---------------- 缓存 ---------------- */
  function cacheRead(pl) {
    if (!pl) return null;
    var key = CACHE_PREFIX + (pl.quoteDate || '');
    try {
      var c = JSON.parse(localStorage.getItem(key) || 'null');
      if (c && c.hash === fingerprint(pl)) return c;
    } catch (e) { /* ignore */ }
    return null;
  }
  function cacheWrite(pl, res, model, usage) {
    if (!pl) return;
    var key = CACHE_PREFIX + (pl.quoteDate || '');
    try {
      localStorage.setItem(key, JSON.stringify({
        hash: fingerprint(pl), result: res, at: Date.now(), model: model, usage: usage
      }));
    } catch (e) { /* ignore */ }
    Object.keys(localStorage).forEach(function (k) {
      if (k.indexOf(CACHE_PREFIX) === 0 && k !== key) {
        var d = k.slice(CACHE_PREFIX.length);
        if (d < (pl.quoteDate || '')) localStorage.removeItem(k);
      }
    });
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    var box = el('pk-ai');
    if (!box) return;

    if (S.loading) {
      box.innerHTML = '<div class="ai-loading"><span class="pk-spin"></span>正在检测本机 AI 配置…</div>';
      return;
    }

    if (S.status && !S.status.configured) {
      box.innerHTML = renderConfig(true);
      bindConfig(box);
      return;
    }

    var pl = payload();
    var head = '<div class="card-h"><div><span class="eyebrow">AI REVIEW</span><h2>AI 复核</h2></div>' +
      '<span class="hint">' + (S.status
        ? esc(S.status.provider_label) + ' · ' + esc(S.status.model) + ' · Key ' + esc(S.status.key_masked)
        : '') +
      '　<button class="ai-link" id="ai-cfg-toggle">改用其他模型</button></span></div>';

    if (S.cfgOpen) {
      box.innerHTML = head + renderConfig(false);
      bindConfig(box);
      return;
    }

    var body;
    if (S.running) {
      body = '<div class="ai-loading"><span class="pk-spin"></span>AI 正在复核 ' + (pl ? pl.picks.length : 0) +
        ' 只候选，通常 10–25 秒…</div>';
    } else if (S.result) {
      body = renderResult(S.result, S.at, S.model, S.usage, pl);
    } else if (S.error) {
      body = '<div class="ai-err"><b>复核失败：' + esc(S.error) + '</b>' +
        '<button class="pk-btn" id="ai-run">重试</button></div>';
    } else {
      var n = pl ? pl.picks.length : 0;
      body = !pl
        ? '<div class="ai-cta"><p>等待行情数据加载完成后即可发起 AI 复核…</p></div>'
        : '<div class="ai-cta"><p>模型已经把全市场压到 ' + n + ' 只候选。让 AI 结合行业逻辑与量价结构做二次判断：重排优先级、指出该剔除的、给一句执行纪律。</p>' +
        '<div class="ai-cta-row"><button class="pk-btn pk-btn-main" id="ai-run">让 AI 复核今天的候选</button>' +
        '<span>只发送这 ' + n + ' 只的数值数据，不发任何个人信息；结果按交易日缓存，同一天不重复调用。</span></div></div>';
    }

    box.innerHTML = head + body;

    var run = el('ai-run');
    /* 不带 force：先查当日缓存，命中就直接显示，不重复花钱 */
    if (run) run.addEventListener('click', function () { runReview(false); });
    var tb = el('ai-cfg-toggle');
    if (tb) tb.addEventListener('click', function () { S.cfgOpen = true; render(); });
  }

  function presetOf(id) {
    var list = (S.status && S.status.providers) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return {};
  }

  function renderConfig(first) {
    var providers = (S.status && S.status.providers) || [];
    var opts = providers.map(function (p) {
      return '<option value="' + p.id + '"' + (S.cfgProvider === p.id ? ' selected' : '') + '>' + esc(p.label) + '</option>';
    }).join('');
    var pre = presetOf(S.cfgProvider);
    var sameAsSaved = S.status && S.status.provider === S.cfgProvider;
    var baseV = S.cfgBase != null ? S.cfgBase : (sameAsSaved ? (S.status.base_url || '') : (pre.base_url || ''));
    var modelV = S.cfgModel != null ? S.cfgModel : (sameAsSaved ? (S.status.model || '') : (pre.model || ''));
    var needKey = !(S.status && S.status.configured);
    return '<div class="ai-config">' +
      '<p class="ai-config-t">' + (first
        ? '要让 AI 参与选股，需要先配置一个模型接口。<b>Key 只保存在这台电脑的 <code>~/.ebgap-ai.json</code>，不会写进网页源码，也不会发给任何第三方服务器。</b>'
        : '修改模型配置：') + '</p>' +
      '<form class="ai-form" onsubmit="return false">' +
      '<label>服务商<select id="ai-provider">' + opts + '</select></label>' +
      '<label>API Key<input type="password" id="ai-key" placeholder="' + (needKey ? 'sk-...' : '已保存，留空则不修改') + '" autocomplete="off"></label>' +
      '<label>接口地址<input type="text" id="ai-base" placeholder="留空用默认" value="' + esc(baseV) + '"></label>' +
      '<label>模型名<input type="text" id="ai-model" placeholder="留空用默认" value="' + esc(modelV) + '"></label>' +
      '<button class="pk-btn pk-btn-main" id="ai-save">' + (needKey ? '保存并开始' : '保存') + '</button>' +
      '</form>' +
      '<p class="ai-config-note">DeepSeek Key 在 platform.deepseek.com 申请；选「自定义」时必须填写接口地址与模型名（任何 OpenAI 兼容 /chat/completions 接口均可）。' +
      (S.cfgMsg ? '<span class="ai-msg ' + (S.cfgMsg.ok ? 'ok' : 'bad') + '">' + esc(S.cfgMsg.text) + '</span>' : '') +
      '</p></div>';
  }

  function bindConfig(box) {
    var pv = el('ai-provider');
    if (pv) pv.addEventListener('change', function () {
      S.cfgProvider = pv.value;
      S.cfgBase = null;
      S.cfgModel = null;
      S.cfgMsg = null;
      render();
    });
    var save = el('ai-save');
    if (save) save.addEventListener('click', function () {
      var key = (el('ai-key') && el('ai-key').value || '').trim();
      var base = (el('ai-base') && el('ai-base').value || '').trim();
      var model = (el('ai-model') && el('ai-model').value || '').trim();
      var needKey = !(S.status && S.status.configured);
      if (needKey && !key) { S.cfgMsg = { ok: false, text: '请先粘贴 API Key' }; render(); return; }
      S.cfgBase = base;
      S.cfgModel = model;
      save.disabled = true;
      save.textContent = '保存中…';
      api('config', { provider: S.cfgProvider, api_key: key, base_url: base, model: model }).then(function (res) {
        S.status = res.status;
        S.cfgOpen = false;
        S.cfgMsg = null;
        S.cfgKey = '';
        render();
        runReview(false);
      }).catch(function (e) {
        S.cfgMsg = { ok: false, text: e.message };
        render();
      });
    });
  }

  function verdictCls(v) {
    if (!v) return 'ai-v-ob';
    if (v.indexOf('重点') >= 0) return 'ai-v-go';
    if (v.indexOf('剔除') >= 0) return 'ai-v-no';
    return 'ai-v-ob';
  }

  function renderResult(res, at, model, usage, pl) {
    var picks = (res.picks || []).slice().sort(function (a, b) { return (b.ai_score || 0) - (a.ai_score || 0); });
    var known = {};
    if (pl) pl.picks.forEach(function (p) { known[p.code] = p; });
    var rows = picks.filter(function (p) { return known[p.code]; }).map(function (p) {
      var k = known[p.code];
      return '<tr>' +
        '<td class="mono">' + esc(p.code) + '</td>' +
        '<td><b>' + esc(p.name || k.name) + '</b><em class="ai-ind">' + esc(k.ind) + '</em></td>' +
        '<td><span class="ai-verdict ' + verdictCls(p.verdict) + '">' + esc(p.verdict || '可观察') + '</span></td>' +
        '<td class="num"><b>' + (p.ai_score == null ? '—' : p.ai_score) + '</b><i class="ai-cmp">模型 ' + (k.total || 0).toFixed(1) + '</i></td>' +
        '<td class="ai-reason">' + esc(p.reason || '') + '</td>' +
        '<td class="ai-risk">' + esc(p.risk || '') + '</td>' +
        '</tr>';
    }).join('');

    var tops = (res.top || []).filter(function (t) { return known[t.code]; }).slice(0, 3).map(function (t, i) {
      var k = known[t.code];
      return '<div class="ai-top-item"><span>' + (i + 1) + '</span><b>' + esc(k.name) + '</b>' +
        '<em>' + esc(t.why_first || '') + '</em></div>';
    }).join('');

    var drops = (res.drop || []).filter(function (d) { return known[d.code]; }).map(function (d) {
      var k = known[d.code];
      return '<span class="ai-drop-chip">' + esc(k.name) + '<i>' + esc(d.why || '') + '</i></span>';
    }).join('');

    var missing = (pl ? pl.picks.length : 0) - picks.filter(function (p) { return known[p.code]; }).length;
    var tokens = usage && usage.total_tokens ? ' · ' + usage.total_tokens + ' tokens' : '';

    return '<div class="ai-meta">' + esc(model || (S.status && S.status.model) || '') + ' 复核于 ' + hhmm(at ? new Date(at) : new Date()) + tokens +
      '<button class="ai-link" id="ai-rerun">重新复核</button></div>' +
      '<p class="ai-read"><b>AI 判断：</b>' + esc(res.market_read || '—') + '</p>' +
      (res.plan ? '<p class="ai-plan"><b>执行纪律：</b>' + esc(res.plan) + '</p>' : '') +
      (tops ? '<div class="ai-tops"><div class="ai-tops-h">优先关注</div>' + tops + '</div>' : '') +
      (rows ? '<div class="tablewrap"><table class="tbl ai-table"><thead><tr><th>代码</th><th>名称</th><th>AI 判定</th><th class="num">AI 分</th><th>理由</th><th>风险</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '') +
      (drops ? '<div class="ai-drops"><b>建议剔除：</b>' + drops + '</div>' : '') +
      (missing > 0 ? '<p class="ai-miss">AI 未对 ' + missing + ' 只给出评价，可在下方自行判断。</p>' : '') +
      '<p class="ai-foot">AI 只看到这 ' + (pl ? pl.picks.length : 0) + ' 只的数值数据，看不到实时新闻与公告，判断可能滞后或出错；' +
      '它的作用是把你的注意力排个序，不是替你做决定。</p>';
  }

  /* ---------------- 流程 ---------------- */
  function runReview(force) {
    var pl = payload();
    if (!pl) return;
    if (!force) {
      var c = cacheRead(pl);
      if (c) { apply(c.result, c.at, c.model, c.usage); return; }
    }
    var fp = fingerprint(pl);
    S.running = true;
    S.error = null;
    S.pendingFp = fp;
    render();
    api('review', pl).then(function (res) {
      S.running = false;
      S.pendingFp = null;
      cacheWrite(pl, res.result, res.model, res.usage);
      var now = payload();
      /* 等待期间用户改了参数，名单已不是发出去那一份：结果作废，不能套到新名单上 */
      if (!now || fingerprint(now) !== fp) {
        var pk0 = picker();
        if (pk0 && pk0.setAI) pk0.setAI(null);
        S.result = null;
        S.resultFp = null;
        S.error = '候选名单在复核过程中发生了变化，本次结果已作废，请重新复核。';
        render();
        return;
      }
      apply(res.result, Date.now(), res.model, res.usage);
    }).catch(function (e) {
      S.running = false;
      S.pendingFp = null;
      S.error = e.message;
      render();
    });
  }

  function apply(result, at, model, usage) {
    S.result = result;
    S.at = at;
    S.model = model || '';
    S.usage = usage || null;
    S.error = null;
    /* 记住当前展示的结论对应哪份名单，否则名单一变就无法判断它是否已过期 */
    S.resultFp = fingerprint(payload());
    var byCode = {};
    (result.picks || []).forEach(function (p) { if (p && p.code) byCode[p.code] = p; });
    var pk = picker();
    if (pk && pk.setAI) pk.setAI({ byCode: byCode, at: at, model: S.model, plan: result.plan || '' });
    render();
    var rerun = el('ai-rerun');
    if (rerun) rerun.addEventListener('click', function () { runReview(true); });
  }

  /* 数据晚于首次 mount 才到：只有拿到候选后才能用名单指纹命中缓存，
     所以每次进页都要重试恢复一次，否则刷新页面后当日结果永远回不来、会重复花钱 */
  function restore() {
    if (S.result) return;
    var pl = payload();
    if (!pl) return;
    var c = cacheRead(pl);
    if (!c) return;
    S.result = c.result;
    S.resultFp = fingerprint(pl);
    S.at = c.at;
    S.model = c.model;
    S.usage = c.usage;
    S.error = null;
  }

  function mount() {
    if (!el('pk-ai')) return;

    if (!S.booted) {
      S.booted = true;
      api('status').then(function (st) {
        S.status = st;
        S.cfgProvider = st.provider || 'deepseek';
        S.loading = false;
        restore();
        if (S.result) apply(S.result, S.at, S.model, S.usage);
        else render();
      }).catch(function () {
        S.loading = false;
        S.status = null;
        render();
        var box = el('pk-ai');
        if (box) box.innerHTML = '<div class="ai-err"><b>连不上本机 AI 代理</b>' +
          '<p>请用「启动.command」启动服务（python3 server.py），而不是直接双击 index.html。' +
          '直接打开 html 文件时浏览器无法调用本地接口。</p></div>';
      });
      return;
    }

    if (S.loading) return;
    restore();
    if (S.result) apply(S.result, S.at, S.model, S.usage);
    else render();
  }

  /* 参数被改动后调用：名单变了就丢掉旧结论，避免拿旧 AI 判断套新名单 */
  function check() {
    var pl = payload();
    if (!pl || S.loading || S.running) return;
    var fp = fingerprint(pl);
    if (S.result && S.resultFp === fp) return;   /* 已是最新，不动 */
    var c = cacheRead(pl);
    if (c) { apply(c.result, c.at, c.model, c.usage); return; }
    if (S.result) {
      S.result = null;
      S.at = null;
      S.usage = null;
      S.resultFp = null;
      var pk = picker();
      if (pk && pk.setAI) pk.setAI(null);
      render();
    }
  }

  window.EB_AI = { mount: mount, run: runReview, check: check, state: S };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
