/* ============================================================
   会员系统（auth.js）· 鉴权壳 + 登录注册 + 管理员入口
   ------------------------------------------------------------
   页面加载即包装 fetch：任何 /api/* 返回 401 都自动回到登录页。
   boot() 先查 /api/auth/me：未登录显示门，登录后放行并注入用户栏。
   对外：window.EB_AUTH = { me, renderAdmin, logout, gate }
   ============================================================ */
(function () {
  'use strict';

  var me = null;             // 当前用户 {id, username, role, active}
  var myPerms = [];          // 当前用户的权限码集合（来自数据库 role_permissions）
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

  /* ---------- RBAC：按权限码判断，不再看 role 字符串 ---------- */
  function has(perm) { return myPerms.indexOf(perm) >= 0; }

  /* 按 data-perm 显隐所有导航项：菜单由数据库授权决定，前端不硬编码角色 */
  function applyNav() {
    document.querySelectorAll('#nav .navi').forEach(function (b) {
      var p = b.dataset.perm;
      var ok = !p || has(p);
      b.hidden = !ok;          // CSS 有 .navi[hidden]{display:none!important} 兜底
      if (!ok && b.classList.contains('on')) b.classList.remove('on');
    });
  }

  /* ---------- 登录门 ---------- */
  function showGate(msg) {
    me = null;
    myPerms = [];
    gate.hidden = false;
    document.body.classList.add('auth-locked');
    if (userBar) userBar.hidden = true;
    applyNav();
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
        myPerms = res.permissions || [];
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
    if (userBar) {
      userBar.hidden = false;
      $('user-name').textContent = me.username;
      // 角色名只作展示；能不能看到某模块完全由 applyNav() 按权限决定
      $('user-role').textContent = me.role === 'admin' ? '管理员' : '会员';
      $('user-avatar').textContent = (me.username || '?').slice(0, 1);
    }
    applyNav();
    ensureViewPermitted();
  }

  /* 登录后当前停留的视图可能没授权（HTML 默认停在总览），
     按权限把用户送到第一个可访问的页面，避免落在空白页。 */
  function ensureViewPermitted() {
    var cur = document.querySelector('.view.on');
    var curName = cur && cur.id.indexOf('v-') === 0 ? cur.id.slice(2) : '';
    if (curName && (curName === 'admin' ? has('view.admin') : has('view.' + curName))) return;
    var first = document.querySelector('#nav .navi:not([hidden])');
    if (first && first.dataset.v && window.EB_APP && EB_APP.show) EB_APP.show(first.dataset.v);
  }

  function logout() {
    api('/api/auth/logout', {}).then(function () {
      me = null;
      myPerms = [];
      if (window.EB_APP && EB_APP.show) EB_APP.show('overview');
      showGate('已退出登录');
    });
  }

  /* ---------- 会员管理视图（由 app.js 的 RENDER.admin 调用） ---------- */
  var admQuery = '';

  var admTab = 'users';

  function renderAdmin() {
    var host = $('v-admin');
    if (!host) return;
    if (!has('view.admin')) {
      host.innerHTML = '<div class="vhead"><h1>会员管理</h1></div>' +
        '<p class="foot-note">你当前的角色没有访问此模块的权限。</p>';
      return;
    }
    var canRoles = has('api.admin.roles');
    host.innerHTML =
      '<div class="vhead"><h1>会员与权限</h1><span class="admin-tag">RBAC 权限控制</span></div>' +
      '<p class="sub">角色与权限点存在数据库中，菜单和数据接口都按权限码校验；改授权即时生效（对方重新登录后）。</p>' +
      '<div class="adm-tabs">' +
      '<button data-tab="users" class="' + (admTab === 'users' ? 'on' : '') + '">会员管理</button>' +
      (canRoles ? '<button data-tab="roles" class="' + (admTab === 'roles' ? 'on' : '') + '">角色与权限</button>' : '') +
      '</div>' +
      '<div id="adm-body"></div>';

    host.querySelectorAll('.adm-tabs button').forEach(function (b) {
      b.addEventListener('click', function () { admTab = b.dataset.tab; renderAdmin(); });
    });

    if (admTab === 'roles' && canRoles) renderRoles();
    else renderUsersPanel();
  }

  function renderUsersPanel() {
    var body = $('adm-body');
    if (!body) return;
    body.innerHTML =
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

  /* 角色与权限：从数据库读取角色、权限点，勾选后覆盖式授权 */
  function renderRoles() {
    var body = $('adm-body');
    if (!body) return;
    body.innerHTML = '<div class="adm-empty">正在加载角色与权限…</div>';
    Promise.all([
      api('/api/admin/roles'),
      api('/api/admin/users')
    ]).then(function (rs) {
      var roles = (rs[0] && rs[0].roles) || [];
      var perms = (rs[0] && rs[0].permissions) || [];
      var users = (rs[1] && rs[1].users) || [];
      window.__admRoles = roles;
      var mods = {};
      /* 分组按「页面导航 → 业务接口 → 管理接口」排列，组内沿用后端返回的
         声明顺序（与导航/接口顺序一致），比按权限码字母序更好读。 */
      var MOD_ORDER = ['view', 'api', 'admin'];
      var byMod = {};
      perms.forEach(function (p) { (byMod[p.module] = byMod[p.module] || []).push(p); });
      MOD_ORDER.concat(Object.keys(byMod).filter(function (m) { return MOD_ORDER.indexOf(m) < 0; }))
        .forEach(function (m) { if (byMod[m]) mods[m] = byMod[m]; });
      var modName = { view: '页面导航', api: '业务接口', admin: '管理接口' };

      body.innerHTML =
        '<div class="adm-role-grid">' +
        roles.map(function (r) {
          var boxes = Object.keys(mods).map(function (m) {
            return '<div class="adm-perm-mod"><b>' + (modName[m] || m) + '</b>' +
              mods[m].map(function (p) {
                /* admin 角色必须保留会员与角色管理权限，后端会强制补齐，这里锁死勾选避免误导 */
                var locked = (r.code === 'admin' &&
                  (p.code === 'api.admin.users' || p.code === 'api.admin.roles' || p.code === 'view.admin'));
                var on = locked || r.permissions.indexOf(p.code) >= 0;
                return '<label class="adm-perm' + (locked ? ' locked' : '') + '">' +
                  '<input type="checkbox" data-perm="' + p.code +
                  '" data-role="' + r.code + '"' + (on ? ' checked' : '') +
                  (locked ? ' disabled' : '') + '>' +
                  '<span>' + esc(p.name) + '</span><em>' + p.code + '</em></label>';
              }).join('') + '</div>';
          }).join('');
          return '<div class="adm-role-card" data-role="' + r.code + '">' +
            '<div class="adm-role-h"><div><b>' + esc(r.name) + '</b>' +
            '<span class="mono">' + r.code + ' · ' + r.users + ' 名会员</span></div>' +
            (r.builtin ? '<span class="adm-badge admin">内置</span>' :
              '<button class="adm-btn danger" data-delrole="' + r.code + '">删除</button>') +
            '</div>' +
            '<div class="adm-role-perms">' + boxes + '</div>' +
            '<div class="adm-role-foot"><button class="adm-btn main" data-saveperms="' + r.code + '">保存授权</button>' +
            '<span class="mono">' + r.permissions.length + ' / ' + perms.length + ' 项权限</span></div>' +
            '</div>';
        }).join('') + '</div>' +
        '<div class="adm-tools" style="margin-top:18px">' +
        '<input id="adm-newrole-code" placeholder="新角色代码，如 analyst">' +
        '<input id="adm-newrole-name" placeholder="角色名称，如 分析师">' +
        '<button class="adm-btn main" id="adm-addrole">+ 新建角色</button>' +
        '<span class="mono">会员改派角色：回到「会员管理」标签，用「角色」按钮切换</span>' +
        '</div>' +
        '<div class="adm-tools" id="adm-assign-box">' +
        '<select id="adm-assign-user">' + users.map(function (u) {
          return '<option value="' + u.id + '">' + esc(u.username) + '（' + esc(u.role) + '）</option>';
        }).join('') + '</select>' +
        '<select id="adm-assign-role">' + roles.map(function (r) {
          return '<option value="' + r.code + '">' + esc(r.name) + '</option>';
        }).join('') + '</select>' +
        '<button class="adm-btn" id="adm-assign-go">改派角色</button>' +
        '</div>';

      body.querySelectorAll('[data-saveperms]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var code = btn.dataset.saveperms;
          var picked = [].map.call(body.querySelectorAll('input[data-role="' + code + '"]:checked'),
            function (i) { return i.dataset.perm; });
          api('/api/admin/role/perms', { role: code, permissions: picked }).then(function (res) {
            if (!res.ok) { window.alert(res.error || '保存失败'); return; }
            renderRoles();
          });
        });
      });
      body.querySelectorAll('[data-delrole]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (!window.confirm('确定删除角色「' + btn.dataset.delrole + '」？')) return;
          api('/api/admin/role/delete', { code: btn.dataset.delrole }).then(function (res) {
            if (!res.ok) { window.alert(res.error || '删除失败'); return; }
            renderRoles();
          });
        });
      });
      $('adm-addrole').addEventListener('click', function () {
        var code = $('adm-newrole-code').value.trim(), name = $('adm-newrole-name').value.trim();
        if (!code || !name) { window.alert('请填写角色代码和名称'); return; }
        api('/api/admin/role/create', { code: code, name: name }).then(function (res) {
          if (!res.ok) { window.alert(res.error || '创建失败'); return; }
          renderRoles();
        });
      });
      $('adm-assign-go').addEventListener('click', function () {
        api('/api/admin/role/assign', {
          id: +$('adm-assign-user').value, role: $('adm-assign-role').value
        }).then(function (res) {
          if (!res.ok) { window.alert(res.error || '改派失败'); return; }
          renderRoles();
        });
      });
    });
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
    /* 统一视图守卫：按 view.<视图> 权限码校验，任何视图（不只 admin）
       只要数据库没授权就踢回第一个有权限的页面。后端 API 权限是最终防线。 */
    document.addEventListener('eb:view', function (e) {
      if (!e.detail || !e.detail.view) return;
      var need = 'view.' + e.detail.view;
      if (!has(need)) {
        var first = document.querySelector('#nav .navi:not([hidden])');
        var fallback = first ? first.dataset.v : 'overview';
        if (e.detail.view !== fallback && window.EB_APP && EB_APP.show) {
          EB_APP.show(fallback);
        }
      }
    });
    api('/api/auth/me').then(function (res) {
      if (res.ok && res.user) {
        me = res.user;
        myPerms = res.permissions || [];
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
    perms: function () { return myPerms.slice(); },
    has: has,
    renderAdmin: renderAdmin,
    logout: logout,
    gate: showGate
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
