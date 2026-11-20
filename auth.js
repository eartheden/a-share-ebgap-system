/* ============================================================
   会员系统（auth.js）· 鉴权壳 + 登录注册 + 管理员入口
   ------------------------------------------------------------
   页面加载即包装 fetch：任何 /api/* 返回 401 都自动回到登录页。
   boot() 先查 /api/auth/me：未登录显示门，登录后放行并注入用户栏。
   对外：window.EB_AUTH = { me, renderAdmin, logout, gate }
   ============================================================ */
(function () {
  'use strict';

  var me = null;          // 当前用户 {id, username, role, active}
  var gate, userBar;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- 全局 fetch 包装：401 统一回登录页 ---------- */
  var _fetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = String((input && input.url) || input || '');
    return _fetch(input, init).then(function (res) {
      if (res.status === 401 && url.indexOf('/api/auth/') < 0) {
        showGate('登录已过期，请重新登录');
      }
      return res;
    });
  };

  function api(path, body) {
    var opt = { cache: 'no-store' };
    if (body !== undefined) {
      opt.method = 'POST';
      opt.headers = { 'Content-Type': 'application/json' };
      opt.body = JSON.stringify(body);
    }
    return _fetch(path, opt).then(function (r) { return r.json(); });
  }

  /* ---------- 登录门 ---------- */
  function showGate(msg) {
    me = null;
    gate.hidden = false;
    document.body.classList.add('auth-locked');
    if (userBar) userBar.hidden = true;
    var navAdmin = document.querySelector('.navi-admin');
    if (navAdmin) navAdmin.hidden = true;
    renderGate(msg);
  }

  function renderGate(msg) {
    var mode = gate.dataset.mode || 'login';
    gate.innerHTML =
      '<div class="auth-card">' +
      '<div class="auth-brand"><div class="ab-mark">股</div>' +
      '<h1>A股股债利差系统</h1><p>EQUITY · BOND · GAP TERMINAL</p></div>' +
      '<div class="auth-tabs">' +
      '<button data-mode="login" class="' + (mode === 'login' ? 'on' : '') + '">登录</button>' +
      '<button data-mode="register" class="' + (mode === 'register' ? 'on' : '') + '">注册</button>' +
      '</div>' +
      '<form id="auth-form" autocomplete="on">' +
      '<div class="auth-field"><label>用户名</label>' +
      '<input id="auth-user" name="username" autocomplete="username" placeholder="请输入用户名" required></div>' +
      '<div class="auth-field"><label>密码</label>' +
      '<input id="auth-pass" name="password" type="password" autocomplete="' +
      (mode === 'login' ? 'current-password' : 'new-password') +
      '" placeholder="' + (mode === 'register' ? '至少 6 位' : '请输入密码') + '" required></div>' +
      (mode === 'register'
        ? '<div class="auth-hint">第一个注册的账号将成为系统管理员，负责管理其他会员。</div>' : '') +
      '<button class="auth-submit" type="submit" id="auth-submit">' +
      (mode === 'login' ? '登 录' : '注册并登录') + '</button>' +
      '<div class="auth-msg" id="auth-msg">' + esc(msg || '') + '</div>' +
      '</form>' +
      '<div class="auth-foot">会员数据相互隔离：你的持仓、建议与 AI 配置只有你自己能看到。<br>' +
      '本系统仅供研究与自我训练，不构成投资建议。</div>' +
      '</div>';

    gate.querySelectorAll('.auth-tabs button').forEach(function (b) {
      b.addEventListener('click', function () {
        gate.dataset.mode = b.dataset.mode;
        renderGate('');
      });
    });
    $('auth-form').addEventListener('submit', function (e) {
      e.preventDefault();
      submitAuth();
    });
    setTimeout(function () { var u = $('auth-user'); if (u) u.focus(); }, 60);
  }

  function submitAuth() {
    var mode = gate.dataset.mode || 'login';
    var username = ($('auth-user') || {}).value || '';
    var password = ($('auth-pass') || {}).value || '';
    var btn = $('auth-submit'), msg = $('auth-msg');
    btn.disabled = true;
    msg.className = 'auth-msg';
    msg.textContent = mode === 'login' ? '正在登录…' : '正在创建账号…';
    api('/api/auth/' + (mode === 'login' ? 'login' : 'register'), { username: username, password: password })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error || '操作失败');
        if (mode === 'register') {
          // 注册接口不下发 cookie：注册后自动登录一次
          return api('/api/auth/login', { username: username, password: password });
        }
        return res;
      })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error || '登录失败');
        me = res.user;
        gate.hidden = true;
        document.body.classList.remove('auth-locked');
        applyUser();
        if (window.EB_APP && EB_APP.show) EB_APP.show('overview');
      })
      .catch(function (e) {
        msg.className = 'auth-msg';
        msg.textContent = e.message || '操作失败，请重试';
        btn.disabled = false;
      });
  }

  /* ---------- 注入用户态 ---------- */
  function applyUser() {
    if (!userBar) return;
    userBar.hidden = false;
    $('user-name').textContent = me.username;
    $('user-role').textContent = me.role === 'admin' ? '管理员' : '会员';
    $('user-avatar').textContent = (me.username || '?').slice(0, 1);
    var navAdmin = document.querySelector('.navi-admin');
    if (navAdmin) navAdmin.hidden = me.role !== 'admin';
  }

  function logout() {
    api('/api/auth/logout', {}).then(function () {
      me = null;
      if (window.EB_APP && EB_APP.show) EB_APP.show('overview');
      showGate('已退出登录');
    });
  }

  /* ---------- 会员管理视图（由 app.js 的 RENDER.admin 调用） ---------- */
  var admQuery = '';

  function renderAdmin() {
    var host = $('v-admin');
    if (!host) return;
    if (!me || me.role !== 'admin') {
      host.innerHTML = '<div class="vhead"><h1>会员管理</h1></div>' +
        '<p class="foot-note">只有管理员可以查看此模块。</p>';
      return;
    }
    host.innerHTML =
      '<div class="vhead"><h1>会员管理</h1><span class="admin-tag">仅管理员可见</span></div>' +
      '<p class="sub">查看与管理系统会员。第一个注册的账号自动成为管理员；至少保留一名启用管理员。</p>' +
      '<div class="adm-kpis" id="adm-kpis"><div class="adm-kpi"><i>加载中</i><b>—</b></div></div>' +
      '<div class="adm-tools">' +
      '<input class="adm-search" id="adm-q" placeholder="搜索用户名">' +
      '<button class="adm-btn main" id="adm-create">+ 新建会员</button>' +
      '</div>' +
      '<div class="adm-table-wrap" id="adm-table"><div class="adm-empty">加载中…</div></div>';

    $('adm-q').addEventListener('input', function () { admQuery = this.value.trim().toLowerCase(); renderAdminTable(); });
    $('adm-create').addEventListener('click', function () { adminCreate(); });
    loadAdminData();
  }

  function loadAdminData() {
    api('/api/admin/stats').then(function (res) {
      if (!res.ok) return;
      var s = res.stats;
      var k = $('adm-kpis');
      if (k) k.innerHTML =
        kpi('会员总数', s.users) + kpi('启用中', s.active) +
        kpi('管理员', s.admins) + kpi('全站持仓', s.trades);
    });
    api('/api/admin/users').then(function (res) {
      if (!res.ok) return;
      window.__admUsers = res.users || [];
      renderAdminTable();
    });
    function kpi(l, v) { return '<div class="adm-kpi"><i>' + l + '</i><b>' + v + '</b></div>'; }
  }

  function renderAdminTable() {
    var box = $('adm-table');
    if (!box) return;
    var users = (window.__admUsers || []).filter(function (u) {
      return !admQuery || String(u.username).toLowerCase().indexOf(admQuery) >= 0;
    });
    if (!users.length) { box.innerHTML = '<div class="adm-empty">没有匹配的会员</div>'; return; }
    var rows = users.map(function (u) {
      var isSelf = me && u.id === me.id;
      return '<tr>' +
        '<td><div class="adm-name"><span class="av">' + esc((u.username || '?').slice(0, 1)) + '</span>' +
        '<span>' + esc(u.username) + (isSelf ? '（我）' : '') + '</span></div></td>' +
        '<td><span class="adm-badge ' + (u.role === 'admin' ? 'admin' : 'member') + '">' +
        (u.role === 'admin' ? '管理员' : '会员') + '</span></td>' +
        '<td><span class="adm-badge ' + (u.active ? 'on' : 'off') + '">' +
        (u.active ? '启用' : '已停用') + '</span></td>' +
        '<td class="mono">' + u.trades + ' 笔</td>' +
        '<td class="mono">' + (u.last_login ? new Date(u.last_login * 1000).toLocaleString('zh-CN') : '从未') + '</td>' +
        '<td><div class="adm-acts">' +
        (!isSelf ?
          '<button class="adm-btn" data-act="active" data-id="' + u.id + '" data-val="' + (u.active ? '0' : '1') + '">' +
          (u.active ? '停用' : '启用') + '</button>' +
          '<button class="adm-btn" data-act="role" data-id="' + u.id + '" data-val="' + (u.role === 'admin' ? 'member' : 'admin') + '">' +
          (u.role === 'admin' ? '降为会员' : '设为管理员') + '</button>' +
          '<button class="adm-btn" data-act="reset" data-id="' + u.id + '" data-name="' + esc(u.username) + '">重置密码</button>' +
          '<button class="adm-btn danger" data-act="delete" data-id="' + u.id + '" data-name="' + esc(u.username) + '">删除</button>'
          : '<span class="mono">—</span>') +
        '</div></td></tr>';
    }).join('');
    box.innerHTML = '<table class="adm-table"><thead><tr>' +
      '<th>用户名</th><th>角色</th><th>状态</th><th>持仓</th><th>最近登录</th><th>操作</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';

    box.querySelectorAll('[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var act = b.dataset.act, id = +b.dataset.id;
        if (act === 'active') return adminAct('/api/admin/user/active', { id: id, active: b.dataset.val === '1' });
        if (act === 'role') return adminAct('/api/admin/user/role', { id: id, role: b.dataset.val });
        if (act === 'reset') {
          var p = window.prompt('为会员「' + b.dataset.name + '」设置新密码（至少 6 位）：');
          if (p) adminAct('/api/admin/user/reset', { id: id, password: p });
          return;
        }
        if (act === 'delete') {
          if (window.confirm('确定删除会员「' + b.dataset.name + '」？其持仓、建议与 AI 配置会一并删除，不可恢复。')) {
            adminAct('/api/admin/user/delete', { id: id });
          }
        }
      });
    });
  }

  function adminAct(path, body) {
    api(path, body).then(function (res) {
      if (!res.ok) { window.alert(res.error || '操作失败'); return; }
      loadAdminData();
    });
  }

  function adminCreate() {
    var name = window.prompt('新会员用户名（字母/数字/下划线，1–20 字符）：');
    if (!name) return;
    var pwd = window.prompt('初始密码（至少 6 位）：');
    if (!pwd) return;
    var role = window.confirm('设为管理员？取消则创建普通会员。') ? 'admin' : 'member';
    api('/api/admin/user/create', { username: name, password: pwd, role: role }).then(function (res) {
      if (!res.ok) { window.alert(res.error || '创建失败'); return; }
      loadAdminData();
    });
  }

  /* ---------- 启动 ---------- */
  function boot() {
    gate = $('auth-gate');
    userBar = $('user-bar');
    $('user-logout').addEventListener('click', logout);
    api('/api/auth/me').then(function (res) {
      if (res.ok && res.user) {
        me = res.user;
        gate.hidden = true;
        document.body.classList.remove('auth-locked');
        applyUser();
      } else {
        showGate('');
      }
    }).catch(function () {
      showGate('无法连接本地服务，请确认服务已启动');
    });
  }

  window.EB_AUTH = {
    me: function () { return me; },
    renderAdmin: renderAdmin,
    logout: logout,
    gate: showGate
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
