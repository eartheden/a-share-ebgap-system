#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""A股股债利差系统 · 本地服务 + AI 代理

用途：
  1) 静态托管本站（替代 python -m http.server）；
  2) 提供 /api/ai/* 本地代理，把「AI 复核」请求转发给大模型。

为什么要代理：API Key 直接写在前端 JS 里等于公开。这里 Key 只存在本机文件
（~/.ebgap-ai.json，权限 600），浏览器只和 127.0.0.1 通信，Key 永不进入页面源码。

启动：python3 server.py [--port 8899]
接口：
  GET  /api/ai/status          查询是否已配置（永远不返回明文 Key）
  POST /api/ai/config          保存 provider / base_url / model / api_key
  POST /api/ai/review          提交候选池，返回模型的复核 JSON
"""

import http.client
import json
import math
import os
import posixpath
import re
import socket
import sqlite3
import ssl
import stat
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import auth   # 会员系统：认证 / 会话 / 权限 / 数据隔离

# AI 配置/调用层已拆到 ai_core.py
from ai_core import *
from ai_core import _rate_limited, _record_auth_fail, _clear_auth_fail

ROOT = os.path.dirname(os.path.abspath(__file__))
CONF = os.path.expanduser('~/.ebgap-ai.json')
DB = os.path.join(ROOT, 'ebgap.db')
DEFAULT_PORT = 8899
MAX_BODY = 512 * 1024

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        # args[0] 可能是 HTTPStatus 枚举（send_error 走 log_error 时），
        # 直接 `in` 会抛 TypeError，把请求线程打断，表现为「端口在听但连接空响应」。
        # 统一转成字符串再判断，并且整段包在 try 里：日志绝不能影响请求处理。
        try:
            first = str(args[0]) if args else ''
            if '/api/' in first:
                sys.stderr.write('[api] ' + (fmt % args) + '\n')
        except Exception:
            pass

    def _json(self, obj, code=200):
        # obj 既可以是待序列化的对象，也可以是已编码好的 bytes（上游数据直通，不再二次转换）
        if isinstance(obj, (bytes, bytearray)):
            body = bytes(obj)
        else:
            body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self._cache_set = True
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > MAX_BODY:
            raise ValueError('请求体为空或过大')
        try:
            return json.loads(self.rfile.read(n).decode('utf-8'))
        except Exception:
            raise ValueError('请求体不是合法 JSON')

    def _origin_ok(self):
        """只接受本站页面发起的调用（抗 CSRF）。

        本机的威胁模型：服务绑在 127.0.0.1，任何网页都能向 localhost 发请求；
        没这道闸，别人站点的脚本就能改配置或拿你的 Key 调模型烧钱。

        云端托管时经过反向代理：浏览器 Origin 是公网域名，但后端看到的 Host
        可能被改写成内部地址，所以同时比对 Host / X-Forwarded-Host / X-Forwarded-Server
        及可选的环境变量 EBGAP_ALLOWED_ORIGINS（逗号分隔域名），不再无条件放行所有 http/https。
        """
        origin = (self.headers.get('Origin') or '').strip()
        if not origin:
            return True    # curl 等本机命令行工具不带 Origin
        if origin.lower() == 'null':
            return False
        try:
            parts = urllib.parse.urlsplit(origin)
        except Exception:
            return False
        if parts.scheme not in ('http', 'https'):
            return False
        oh = (parts.netloc or '').lower()
        if not oh:
            return False
        oh_host = (parts.hostname or '').lower()

        # 允许的域名：请求 Host + 反代转发头 + 显式配置（都去掉端口只比域名）
        allowed = set()
        for h in (self.headers.get('Host'), self.headers.get('X-Forwarded-Host'),
                  self.headers.get('X-Forwarded-Server')):
            if h:
                for item in h.split(','):
                    host_only = item.strip().lower().split(':')[0]
                    if host_only:
                        allowed.add(host_only)
        extra = os.environ.get('EBGAP_ALLOWED_ORIGINS', '')
        for item in extra.split(','):
            item = item.strip().lower()
            if item:
                if '://' in item:
                    item = urllib.parse.urlsplit(item).hostname or ''
                allowed.add(item.split(':')[0])
        if oh_host and oh_host in allowed:
            return True

        # 本机直连的两种写法（旧行为兼容）
        port = self.server.server_port
        if oh in ('127.0.0.1:%d' % port, 'localhost:%d' % port):
            return True
        return False

    # ---------- 会员会话 ----------
    def _token(self):
        """从 Cookie 取会话 token（HttpOnly，JS 读不到）。"""
        raw = self.headers.get('Cookie') or ''
        for part in raw.split(';'):
            k, _, v = part.strip().partition('=')
            if k == auth.COOKIE_NAME:
                return v
        return None

    def _session(self):
        """返回 (db连接, 用户行)；无效则 (conn, None)。调用方负责在 finally 关闭。"""
        conn = db_conn()
        try:
            return conn, auth.user_by_token(conn, self._token())
        except Exception:
            conn.close()
            raise

    def _set_cookie(self, token, delete=False):
        # Path=/ 覆盖全站；HttpOnly 防 XSS 窃取；SameSite=Lax 抗 CSRF；
        # 仅 https 或反代环境加 Secure（本机能用 http）。
        secure = '; Secure' if os.environ.get('PORT') else ''
        if delete:
            val = '%s=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax%s' % (auth.COOKIE_NAME, secure)
        else:
            val = '%s=%s; Path=/; Max-Age=%d; HttpOnly; SameSite=Lax%s' % (
                auth.COOKIE_NAME, token, auth.SESSION_TTL, secure)
        self.send_header('Set-Cookie', val)

    def _json_with_cookie(self, obj, cookie, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self._cache_set = True
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self._set_cookie(cookie, delete=(cookie is None))
        self.end_headers()
        self.wfile.write(body)

    def _need_auth(self):
        return self._json({'ok': False, 'error': '请先登录', 'unauthorized': True}, 401)

    def _forbidden(self, perm):
        return self._json({'ok': False, 'error': '没有权限：%s' % perm,
                           'forbidden': True, 'perm': perm}, 403)

    @staticmethod
    def _perm_for_path(path):
        """路径 → 所需权限点。集中映射，新增接口时只需在这里登记。"""
        if path.startswith('/api/admin/roles') or path.startswith('/api/admin/role'):
            return 'api.admin.roles'
        if path.startswith('/api/admin/'):
            return 'api.admin.users'
        if path.startswith('/api/market/'):
            return 'api.market'
        if path.startswith('/api/dragon/'):
            return 'api.market'
        if path.startswith('/api/stock/'):
            return 'api.stock'
        if path.startswith('/api/paper/'):
            return 'api.paper'
        if path.startswith('/api/advice/'):
            return 'api.advice'
        if path.startswith('/api/ai/'):
            return 'api.ai'
        return None

    def _check_perm(self, conn, user):
        """统一 RBAC 校验：查角色的权限集合，失败返回 403 响应，成功返回 None。"""
        perm = self._perm_for_path(self.path)
        if perm and not auth.has_permission(conn, user, perm):
            return self._forbidden(perm)
        return None

    def _bytes(self, body, code=200):
        self._cache_set = True
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    _STATIC_EXTS = ('.html', '.htm', '.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2')

    def list_directory(self, path):
        # 禁用目录列表浏览，防止枚举项目目录
        self._json({'ok': False, 'error': 'not found'}, 404)
        return None

    def do_GET(self):
        # 当前登录者（所有 /api/* 都要鉴权，除 /api/auth/* 自己）
        if self.path.startswith('/api/auth/'):
            return self._auth_get()
        if self.path.startswith('/api/'):
            conn, user = self._session()
            if not user:
                conn.close()
                return self._need_auth()
            try:
                return self._authed_get(conn, user)
            except ValueError as e:
                return self._json({'ok': False, 'error': str(e)}, 400)
            except Exception as e:  # noqa: BLE001
                return self._json({'ok': False, 'error': '服务器内部错误：%s' % e}, 500)
            finally:
                conn.close()
        # 静态资源白名单放行（登录页要能加载 HTML/JS/CSS）
        # 统一规范化路径并按扩展名白名单过滤，杜绝数据库备份、源码、脚本及隐藏目录泄漏。
        raw_p = urllib.parse.unquote(self.path.split('?')[0])
        norm_p = posixpath.normpath('/' + raw_p.lstrip('/')).lower()
        if norm_p == '/':
            return super().do_GET()
        segs = [s for s in norm_p.split('/') if s]
        if any(s.startswith('.') for s in segs) or not norm_p.endswith(self._STATIC_EXTS):
            return self._json({'ok': False, 'error': 'not found'}, 404)
        if '.db' in norm_p or '.bak' in norm_p or '/backup' in norm_p:
            return self._json({'ok': False, 'error': 'not found'}, 404)
        return super().do_GET()

    def _auth_get(self):
        """未登录也可访问的接口：只看当前是谁。"""
        conn, user = self._session()
        try:
            if self.path.startswith('/api/auth/me'):
                if not user:
                    return self._json({'ok': True, 'user': None, 'permissions': []})
                u = auth.row_public(user)
                return self._json({
                    'ok': True, 'user': u,
                    'permissions': sorted(auth.permissions_of(conn, user['role'])),
                })
            return self._json({'ok': False, 'error': 'unknown auth endpoint'}, 404)
        finally:
            conn.close()

    def _authed_get(self, conn, user):
        denied = self._check_perm(conn, user)
        if denied:
            return denied
        uid = user['id']
        if self.path.startswith('/api/ai/status'):
            return self._json(status_payload(uid, conn))
        if self.path.startswith('/api/market/'):
            qs = urllib.parse.urlparse(self.path).query
            try:
                if self.path.startswith('/api/market/list'):
                    return self._json(market_list_payload(qs))
                if self.path.startswith('/api/market/index'):
                    return self._json(market_index_payload(qs))
                if self.path.startswith('/api/market/limitup'):
                    return self._json(limitup_snapshot_payload())
                return self._json({'ok': False, 'error': 'unknown market endpoint'}, 404)
            except Exception as e:  # noqa: BLE001
                return self._json({'ok': False, 'error': '行情获取失败：%s' % e}, 502)
        if self.path.startswith('/api/stock/em'):
            qs = urllib.parse.urlparse(self.path).query
            body, code = stock_proxy_payload(qs)
            return self._json(body, code)
        if self.path.startswith('/api/stock/suggest'):
            qs = urllib.parse.urlparse(self.path).query
            return self._json(stock_suggest_payload(qs))
        if self.path.startswith('/api/paper/list'):
            return self._json({'ok': True, 'trades': paper_list(uid)})
        if self.path.startswith('/api/dragon/list'):
            qs = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(qs)
            date = (params.get('date') or [None])[0]
            return self._json({'ok': True, 'picks': dragon_list(uid, date)})
        if self.path.startswith('/api/dragon/emotion'):
            qs = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(qs)
            try: days = min(90, max(1, int((params.get('days') or ['30'])[0])))
            except Exception: days = 30
            return self._json({'ok': True, 'series': dragon_emotion_series(days)})
        if self.path.startswith('/api/advice/daily') or self.path.startswith('/api/advice/list'):
            qs = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(qs)
            date = (params.get('date') or [None])[0]
            try:
                limit = min(100, max(1, int((params.get('limit') or ['20'])[0])))
            except (TypeError, ValueError):
                limit = 20
            return self._json({'ok': True, 'advice': advice_get(date=date, limit=limit, user_id=uid)})
        if self.path.startswith('/api/admin/'):
            return self._admin_get(conn, user)
        return self._json({'ok': False, 'error': 'unknown endpoint'}, 404)

    def do_POST(self):
        if not self._origin_ok():
            return self._json({'ok': False, 'error': '拒绝跨站调用'}, 403)
        try:
            # 认证接口：无需登录
            if self.path.startswith('/api/auth/'):
                return self._auth_post()
            conn, user = self._session()
            if not user:
                conn.close()
                return self._need_auth()
            try:
                return self._authed_post(conn, user)
            finally:
                conn.close()
        except ValueError as e:
            return self._json({'ok': False, 'error': str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            return self._json({'ok': False, 'error': '服务器内部错误：%s' % e}, 500)

    def _client_ip(self):
        if os.environ.get('PORT'):
            xff = (self.headers.get('X-Forwarded-For') or '').split(',')[0].strip()
            if xff:
                return xff
        return self.client_address[0] if self.client_address else 'unknown'

    def _auth_post(self):
        conn = db_conn()
        try:
            data = self._read_json()
            ip = self._client_ip()
            if self.path.startswith('/api/auth/register'):
                rk = 'reg:' + ip
                if _rate_limited(rk):
                    return self._json({'ok': False, 'error': '注册请求过于频繁，请稍后再试'}, 429)
                try:
                    u = auth.register(conn, data.get('username'), data.get('password'))
                except ValueError:
                    _record_auth_fail(rk)
                    raise
                conn.commit()
                return self._json({'ok': True, 'user': u})
            if self.path.startswith('/api/auth/login'):
                uname = str(data.get('username') or '').strip().lower()
                lk_ip = 'login_ip:' + ip
                lk_user = 'login_u:' + uname
                if _rate_limited(lk_ip) or (uname and _rate_limited(lk_user)):
                    return self._json({'ok': False, 'error': '登录失败次数过多，请 5 分钟后再试'}, 429)
                try:
                    token, u = auth.login(conn, data.get('username'), data.get('password'))
                except ValueError:
                    _record_auth_fail(lk_ip)
                    if uname:
                        _record_auth_fail(lk_user)
                    raise
                _clear_auth_fail(lk_user)
                # 首个管理员登录时把改造前的老持仓/建议归属到自己名下，避免升级后「数据不见了」
                first_admin = conn.execute(
                    "SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").fetchone()
                migrated = auth.claim_legacy(conn, u['id'],
                                             bool(first_admin and first_admin['id'] == u['id']))
                conn.commit()
                return self._json_with_cookie(
                    {'ok': True, 'user': u, 'legacy_migrated': migrated,
                     'permissions': sorted(auth.permissions_of(conn, u['role']))}, token)
            if self.path.startswith('/api/auth/logout'):
                auth.logout(conn, self._token())
                conn.commit()
                return self._json_with_cookie({'ok': True}, None)   # 清 cookie
            if self.path.startswith('/api/auth/password'):
                # 自助改密码：只改自己，不接受任何 user_id 参数
                token = self._token()
                user = auth.user_by_token(conn, token)
                if not user:
                    return self._need_auth()
                auth.change_password(conn, user['id'],
                                     data.get('old_password'), data.get('new_password'),
                                     keep_token=token)
                conn.commit()
                return self._json({'ok': True})
            return self._json({'ok': False, 'error': 'unknown auth endpoint'}, 404)
        finally:
            conn.close()

    def _authed_post(self, conn, user):
        denied = self._check_perm(conn, user)
        if denied:
            return denied
        uid = user['id']
        if self.path.startswith('/api/ai/config'):
            data = self._read_json()
            conf = auth.load_ai_config(conn, uid)
            provider = (data.get('provider') or conf.get('provider') or 'deepseek').strip()
            preset = PROVIDERS.get(provider, {})
            if data.get('clear_key'):
                conf.pop('api_key', None)
            elif data.get('api_key'):
                conf['api_key'] = str(data['api_key']).strip()
            conf['provider'] = provider
            conf['base_url'] = (data.get('base_url') or preset.get('base_url') or '').strip()
            conf['model'] = (data.get('model') or preset.get('model') or '').strip()
            auth.save_ai_config(conn, uid, conf)
            conn.commit()
            return self._json({'ok': True, 'status': status_payload(uid, conn)})

        if self.path.startswith('/api/ai/review'):
            data = self._read_json()
            conf = auth.load_ai_config(conn, uid)
            if not conf.get('api_key'):
                # 只有首个管理员可沿用改造前的全局 Key；其他会员必须自己配置
                first = conn.execute("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").fetchone()
                if first and first['id'] == uid:
                    conf = load_conf()
            out = call_llm(conf, data)
            return self._json({'ok': True, **out})

        if self.path.startswith('/api/dragon/snapshot'):
            return self._json(dragon_snapshot(uid))
        if self.path.startswith('/api/paper/buy'):
            return self._json(paper_buy(self._read_json(), uid))
        if self.path.startswith('/api/paper/close'):
            return self._json(paper_close(self._read_json(), uid))
        if self.path.startswith('/api/paper/tick'):
            return self._json(paper_tick(self._read_json(), uid))
        if self.path.startswith('/api/paper/update'):
            return self._json(paper_update(self._read_json(), uid))
        if self.path.startswith('/api/paper/clear'):
            return self._json(paper_clear(uid))
        if self.path.startswith('/api/advice/daily'):
            return self._json(advice_upsert(self._read_json(), uid))
        if self.path.startswith('/api/admin/'):
            return self._admin_post(conn, user)
        return self._json({'ok': False, 'error': 'unknown endpoint'}, 404)

    # ---------- 管理员接口（按 RBAC 权限点校验，见 _check_perm） ----------
    def _admin_get(self, conn, user):
        # 权限已由 _check_perm 按 api.admin.* 权限点统一校验，不再硬编码 role=='admin'
        if self.path.startswith('/api/admin/roles') or self.path.startswith('/api/admin/permissions'):
            return self._json({'ok': True,
                               'roles': auth.all_roles(conn),
                               'permissions': auth.all_permissions(conn)})
        if self.path.startswith('/api/admin/users'):
            rows = conn.execute('''
                SELECT u.*,
                  (SELECT COUNT(*) FROM paper_trades p WHERE p.user_id=u.id) AS trades,
                  (SELECT COUNT(*) FROM sessions s WHERE s.user_id=u.id AND s.expires_at>?) AS online
                FROM users u ORDER BY u.id
            ''', (int(time.time()),)).fetchall()
            out = []
            for r in rows:
                d = auth.row_public(r)
                d['trades'] = r['trades']
                d['online'] = bool(r['online'])
                out.append(d)
            return self._json({'ok': True, 'users': out, 'total': len(out)})
        if self.path.startswith('/api/admin/stats'):
            total = conn.execute('SELECT COUNT(*) FROM users').fetchone()[0]
            active = conn.execute('SELECT COUNT(*) FROM users WHERE active=1').fetchone()[0]
            admins = conn.execute("SELECT COUNT(*) FROM users WHERE role='admin' AND active=1").fetchone()[0]
            # 只统计已归属会员的持仓；user_id=0 是改造前的老数据，任何会员都看不到
            trades = conn.execute('SELECT COUNT(*) FROM paper_trades WHERE user_id>0').fetchone()[0]
            return self._json({'ok': True, 'stats': {
                'users': total, 'active': active, 'admins': admins, 'trades': trades}})
        return self._json({'ok': False, 'error': 'unknown admin endpoint'}, 404)

    def _role_admin(self, conn, user, data):
        """角色与授权管理（需 api.admin.roles 权限）。"""
        p = self.path
        try:
            if p.startswith('/api/admin/role/create'):
                r = auth.create_role(conn, data.get('code'), data.get('name'), data.get('description'))
                conn.commit()
                return self._json({'ok': True, 'role': r})
            if p.startswith('/api/admin/role/delete'):
                auth.delete_role(conn, data.get('code'))
                conn.commit()
                return self._json({'ok': True})
            if p.startswith('/api/admin/role/perms'):
                perms = auth.set_role_permissions(conn, data.get('role'), data.get('permissions'))
                conn.commit()
                return self._json({'ok': True, 'permissions': perms})
            if p.startswith('/api/admin/role/assign'):
                # 改派会员角色：不能把自己降成没有管理权限的角色而锁死系统
                uid = data.get('id')
                code = data.get('role')
                if not conn.execute('SELECT 1 FROM roles WHERE code=?', (code,)).fetchone():
                    return self._json({'ok': False, 'error': '角色不存在'}, 400)
                if uid == user['id'] and code != user['role']:
                    # 允许，但要确保系统仍有人能管角色：检查改后该角色或其他管理员是否还有权限
                    others = conn.execute(
                        "SELECT COUNT(*) FROM users WHERE id<>? AND role IN "
                        "(SELECT role_code FROM role_permissions WHERE perm_code='api.admin.roles')",
                        (uid,)).fetchone()[0]
                    if not others:
                        return self._json({'ok': False, 'error': '至少保留一名能管理角色的管理员'}, 400)
                conn.execute('UPDATE users SET role=? WHERE id=?', (code, uid))
                conn.commit()
                return self._json({'ok': True})
            return self._json({'ok': False, 'error': 'unknown role endpoint'}, 404)
        except ValueError as e:
            return self._json({'ok': False, 'error': str(e)}, 400)

    def _admin_post(self, conn, user):
        # 角色权限管理：需要 api.admin.roles 权限点
        perm = self._perm_for_path(self.path)
        if perm and not auth.has_permission(conn, user, perm):
            return self._forbidden(perm)
        data = self._read_json()
        if self.path.startswith('/api/admin/role/'):
            return self._role_admin(conn, user, data)
        target = data.get('id')
        # create 不需要目标 id；其余 user/* 操作必须带有效 id
        is_create = self.path.startswith('/api/admin/user/create')
        row = conn.execute('SELECT * FROM users WHERE id=?', (target,)).fetchone() if target else None
        if self.path.startswith('/api/admin/user/') and not is_create:
            if not row:
                return self._json({'ok': False, 'error': '会员不存在'}, 404)

        if self.path.startswith('/api/admin/user/active'):
            if row['id'] == user['id']:
                return self._json({'ok': False, 'error': '不能停用自己'}, 400)
            want = 1 if data.get('active') else 0
            if want == 0 and auth.has_permission(conn, row, 'api.admin.users'):
                # 按权限点判断：不能停用到系统没有任何人能管理会员
                if auth.count_users_with_permission(conn, 'api.admin.users', exclude_id=target) <= 0:
                    return self._json({'ok': False, 'error': '至少保留一名启用的管理员'}, 400)
            conn.execute('UPDATE users SET active=? WHERE id=?', (want, target))
            if want == 0:
                conn.execute('DELETE FROM sessions WHERE user_id=?', (target,))  # 停用即踢下线
            conn.commit()
            return self._json({'ok': True, 'user': auth.row_public(
                conn.execute('SELECT * FROM users WHERE id=?', (target,)).fetchone())})

        if self.path.startswith('/api/admin/user/role'):
            if row['id'] == user['id']:
                return self._json({'ok': False, 'error': '不能改自己的角色'}, 400)
            want = str(data.get('role') or 'member')
            if not conn.execute('SELECT 1 FROM roles WHERE code=?', (want,)).fetchone():
                return self._json({'ok': False, 'error': '角色不存在'}, 400)
            # 改派前先看：目标当前是否拥有管理权限，改后系统是否还有人能管理
            if auth.has_permission(conn, row, 'api.admin.users'):
                new_role = conn.execute('SELECT * FROM roles WHERE code=?', (want,)).fetchone()
                fake = dict(row); fake['role'] = want
                if (not auth.has_permission(conn, fake, 'api.admin.users') and
                        auth.count_users_with_permission(conn, 'api.admin.users', exclude_id=target) <= 0):
                    return self._json({'ok': False, 'error': '至少保留一名管理员'}, 400)
            conn.execute('UPDATE users SET role=? WHERE id=?', (want, target))
            conn.commit()
            return self._json({'ok': True, 'user': auth.row_public(
                conn.execute('SELECT * FROM users WHERE id=?', (target,)).fetchone())})

        if self.path.startswith('/api/admin/user/reset'):
            pwd = str(data.get('password') or '')
            if len(pwd) < auth.MIN_PASSWORD:
                return self._json({'ok': False, 'error': '新密码至少 %d 位' % auth.MIN_PASSWORD}, 400)
            conn.execute('UPDATE users SET password=? WHERE id=?', (auth.hash_password(pwd), target))
            conn.execute('DELETE FROM sessions WHERE user_id=?', (target,))  # 改密后强制重新登录
            conn.commit()
            return self._json({'ok': True})

        if self.path.startswith('/api/admin/user/delete'):
            if row['id'] == user['id']:
                return self._json({'ok': False, 'error': '不能删除自己'}, 400)
            # 级联清理该会员的全部数据
            conn.execute('DELETE FROM paper_trades WHERE user_id=?', (target,))
            conn.execute('DELETE FROM daily_advice WHERE user_id=?', (target,))
            conn.execute('DELETE FROM ai_configs WHERE user_id=?', (target,))
            conn.execute('DELETE FROM sessions WHERE user_id=?', (target,))
            conn.execute('DELETE FROM users WHERE id=?', (target,))
            conn.commit()
            return self._json({'ok': True})

        if self.path.startswith('/api/admin/user/create'):
            # 管理员直接建号（无需对方自行注册）；角色必须存在于 roles 表
            want = str(data.get('role') or 'member')
            if not conn.execute('SELECT 1 FROM roles WHERE code=?', (want,)).fetchone():
                return self._json({'ok': False, 'error': '角色不存在'}, 400)
            u = auth.register(conn, data.get('username'), data.get('password'))
            if want != u['role']:
                conn.execute('UPDATE users SET role=? WHERE id=?', (want, u['id']))
                u['role'] = want
            conn.commit()
            return self._json({'ok': True, 'user': u})

        return self._json({'ok': False, 'error': 'unknown admin endpoint'}, 404)

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        # 静态资源（html/js/css）禁缓存，避免改版后浏览器拿旧脚本
        if not getattr(self, '_cache_set', False):
            p = self.path.split('?')[0].lower()
            if p.endswith(('.html', '.htm', '.js', '.css')) or p in ('/', ''):
                self.send_header('Cache-Control', 'no-store, must-revalidate')
                self.send_header('Pragma', 'no-cache')
        super().end_headers()


# ---------------------------------------------------------------------------
# 模拟持仓（虚拟买入） + 每日建议：SQLite 持久化
#
# 为什么放服务端而不是 localStorage：
#   localStorage 跟浏览器走，换浏览器/清缓存就丢；这里落在项目目录的 ebgap.db，
#   页面、命令行、别的设备（同机）看到的是同一份记录。
# 线程模型是 ThreadingHTTPServer，每次请求开一个短连接，用完即关，
# 不开共享连接，避免 sqlite 跨线程问题。
# ---------------------------------------------------------------------------

# 数据层已拆到 store.py（db_conn / paper_* / advice_* / db_init）
from store import *

# 行情层已拆到 market.py（DoH / 东财 / 腾讯 / 涨停快照）
from market import *

# 个股代理层已拆到 stock_proxy.py
from stock_proxy import *

def main():
    port = DEFAULT_PORT
    if '--port' in sys.argv:
        idx = sys.argv.index('--port')
        if idx + 1 >= len(sys.argv):
            print('参数错误：--port 后缺少端口号')
            sys.exit(2)
        try:
            port = int(sys.argv[idx + 1])
        except ValueError:
            print('参数错误：端口号必须是整数')
            sys.exit(2)
    # 云端发布：平台把端口塞进 PORT 环境变量，并要求监听 0.0.0.0。
    # 本机直接运行时不设 PORT，仍是 127.0.0.1:8899，行为跟以前完全一致。
    env_port = os.environ.get('PORT')
    env_host = os.environ.get('HOST')
    if env_port:
        port = int(env_port)
    host = env_host or ('0.0.0.0' if env_port else '127.0.0.1')
    db_init()
    try:
        srv = ThreadingHTTPServer((host, port), Handler)
    except OSError as e:
        print('启动失败：%s:%d 无法监听（%s）' % (host, port, e))
        print('可能服务已经在跑了，先试：http://127.0.0.1:%d/' % port)
        print('换一个端口：python3 server.py --port 8900')
        sys.exit(1)
    with db_conn() as c:
        first_admin = c.execute("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").fetchone()
        st = status_payload(first_admin['id'], c) if first_admin else status_payload()
    print('A股股债利差系统 · 服务已启动')
    print('  地址：http://%s:%d/' % (host, port))
    print('  AI 状态：%s' % ('已配置 ' + st['provider_label'] if st['configured'] else '未配置（页面内粘贴 Key 即可）'))
    print('  配置文件：%s' % CONF)
    print('  数据库：%s（模拟持仓 + 每日建议）' % DB)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')


if __name__ == '__main__':
    main()
