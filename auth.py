#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""会员系统 · 认证 / 会话 / 权限 / 数据隔离

设计要点：
  · 密码：PBKDF2-HMAC-SHA256 + 每用户随机盐，永不存明文（Python 标准库，无第三方依赖）
  · 会话：随机 token 存 sessions 表，通过 HttpOnly Cookie 下发；服务端可随时吊销
  · 首个注册的用户自动成为 admin，其余为 member；系统永远保留至少一个启用管理员
  · 业务数据（paper_trades / daily_advice / ai_config）带 user_id，逐用户隔离
  · 所有比对用 hmac.compare_digest 抗时序攻击
"""

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time

SESSION_TTL = 7 * 24 * 3600          # 7 天
COOKIE_NAME = 'ebgap_sid'
PBKDF2_ROUNDS = 180000
MIN_PASSWORD = 6
MAX_NAME = 20

# ============================================================
# RBAC 权限点定义（唯一真源）
# 每个「视图」与「API」都对应一个权限码。后端按码校验，前端按码渲染。
# 角色不硬编码判断，全部查 role_permissions 表——改权限不需要改代码。
# ============================================================
PERMISSIONS = [
    # 视图（导航菜单）
    ('view.overview', '总览面板', 'view'),
    ('view.curve', '利差曲线', 'view'),
    ('view.signal', '建仓提示', 'view'),
    ('view.alloc', '配置建议', 'view'),
    ('view.pick', '选股引擎', 'view'),
    ('view.paper', '虚拟持仓', 'view'),
    ('view.stock', '个股分析', 'view'),
    ('view.history', '历史复盘', 'view'),
    ('view.limitup', '涨停地图', 'view'),
    ('view.dragon', '龙头战法', 'view'),
    ('view.admin', '会员管理', 'view'),
    # 业务 API
    ('api.market', '行情数据', 'api'),
    ('api.stock', '个股数据', 'api'),
    ('api.paper', '虚拟持仓读写', 'api'),
    ('api.advice', '每日建议', 'api'),
    ('api.ai', 'AI 复核配置与调用', 'api'),
    # 管理 API
    ('api.admin.users', '会员管理', 'admin'),
    ('api.admin.roles', '角色权限管理', 'admin'),
]

# 默认角色拥有的权限（首次初始化写入 role_permissions）
DEFAULT_ROLE_PERMS = {
    'admin': [p[0] for p in PERMISSIONS],
    'member': [
        'view.overview', 'view.curve', 'view.signal', 'view.alloc',
        'view.pick', 'view.paper', 'view.stock', 'view.history', 'view.limitup', 'view.dragon',
        'api.market', 'api.stock', 'api.paper', 'api.advice', 'api.ai',
    ],
}
BUILTIN_ROLES = {
    'admin': ('系统管理员', '拥有全部权限，含会员与角色管理'),
    'member': ('普通会员', '可使用全部业务功能，不能管理会员与角色'),
}


def now():
    return int(time.time())


def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'),
                             bytes.fromhex(salt), PBKDF2_ROUNDS)
    return salt + '$' + dk.hex()


def verify_password(password, stored):
    try:
        salt, digest = stored.split('$', 1)
        dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'),
                                 bytes.fromhex(salt), PBKDF2_ROUNDS)
        return hmac.compare_digest(dk.hex(), digest)
    except Exception:
        return False


def init_schema(conn):
    """幂等建表 + 老库补列。user_id=0 表示「老数据/未归属」，仅供迁移，不对外可见。"""
    c = conn
    c.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'member',   -- admin | member
            active INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            last_login INTEGER
        )''')
    c.execute('''
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )''')
    c.execute('''
        CREATE TABLE IF NOT EXISTS ai_configs (
            user_id INTEGER PRIMARY KEY,
            provider TEXT, base_url TEXT, model TEXT, api_key TEXT
        )''')
    # ---------- RBAC：角色 / 权限点 / 角色-权限映射 ----------
    c.execute('''
        CREATE TABLE IF NOT EXISTS roles (
            code TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            builtin INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        )''')
    c.execute('''
        CREATE TABLE IF NOT EXISTS permissions (
            code TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            module TEXT NOT NULL,
            description TEXT
        )''')
    c.execute('''
        CREATE TABLE IF NOT EXISTS role_permissions (
            role_code TEXT NOT NULL,
            perm_code TEXT NOT NULL,
            PRIMARY KEY (role_code, perm_code),
            FOREIGN KEY(role_code) REFERENCES roles(code) ON DELETE CASCADE,
            FOREIGN KEY(perm_code) REFERENCES permissions(code) ON DELETE CASCADE
        )''')
    # 播种权限点（INSERT OR IGNORE：新增权限码后重启即可自动补入，不覆盖已有）
    for code, name, module in PERMISSIONS:
        c.execute('INSERT OR IGNORE INTO permissions(code,name,module) VALUES(?,?,?)',
                  (code, name, module))
    # 播种内置角色（admin / member），已存在则不覆盖用户改过的名字
    for code, (name, desc) in BUILTIN_ROLES.items():
        c.execute('INSERT OR IGNORE INTO roles(code,name,description,builtin,created_at) VALUES(?,?,?,1,?)',
                  (code, name, desc, now()))
    # 只有首次初始化（该角色还没有任何授权）时才写入默认权限，
    # 否则管理员 adjust 过的授权会在每次启动被覆盖回去。
    for code, perms in DEFAULT_ROLE_PERMS.items():
        has = c.execute('SELECT 1 FROM role_permissions WHERE role_code=? LIMIT 1', (code,)).fetchone()
        if not has:
            for perm in perms:
                c.execute('INSERT OR IGNORE INTO role_permissions(role_code,perm_code) VALUES(?,?)',
                          (code, perm))
    # 给业务表补 user_id（老记录=0，登录后的普通用户看不到）
    # 仅在目标表已存在时才补列，避免空库首次初始化时报错
    existing_tables = {
        r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    }
    for table in ('paper_trades', 'daily_advice'):
        if table not in existing_tables:
            continue
        have = {r['name'] for r in c.execute('PRAGMA table_info(%s)' % table).fetchall()}
        if 'user_id' not in have:
            c.execute('ALTER TABLE %s ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0' % table)
            c.execute('CREATE INDEX IF NOT EXISTS idx_%s_user ON %s(user_id)' % (table, table))


def user_count(c):
    return c.execute('SELECT COUNT(*) FROM users').fetchone()[0]


def row_public(row):
    return {
        'id': row['id'], 'username': row['username'], 'role': row['role'],
        'active': bool(row['active']),
        'created_at': row['created_at'], 'last_login': row['last_login'],
    }


def register(c, username, password):
    username = str(username or '').strip()
    password = str(password or '')
    if not username or len(username) > MAX_NAME:
        raise ValueError('用户名需 1–%d 个字符' % MAX_NAME)
    if not re_ascii(username):
        raise ValueError('用户名只能用字母、数字、下划线、点或短横线')
    if len(password) < MIN_PASSWORD:
        raise ValueError('密码至少 %d 位' % MIN_PASSWORD)
    if c.execute('SELECT 1 FROM users WHERE username=?', (username,)).fetchone():
        raise ValueError('这个用户名已被注册')
    n = user_count(c)
    role = 'admin' if n == 0 else 'member'   # 首个注册者即管理员
    cur = c.execute(
        'INSERT INTO users(username,password,role,active,created_at) VALUES(?,?,?,1,?)',
        (username, hash_password(password), role, now()))
    return row_public(c.execute('SELECT * FROM users WHERE id=?', (cur.lastrowid,)).fetchone())


def re_ascii(s):
    return all(ch.isascii() and (ch.isalnum() or ch in '._-') for ch in s)


def login(c, username, password):
    row = c.execute('SELECT * FROM users WHERE username=?', (str(username or '').strip(),)).fetchone()
    if not row or not row['active'] or not verify_password(str(password or ''), row['password']):
        raise ValueError('用户名或密码错误（或账号已被停用）')
    purge_expired(c)
    c.execute('UPDATE users SET last_login=? WHERE id=?', (now(), row['id']))
    token = secrets.token_urlsafe(32)
    c.execute('INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)',
              (token, row['id'], now(), now() + SESSION_TTL))
    return token, row_public(row)


def user_by_token(c, token):
    if not token:
        return None
    row = c.execute('''
        SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token=? AND s.expires_at>? AND u.active=1
    ''', (token, now())).fetchone()
    return row


def logout(c, token):
    if token:
        c.execute('DELETE FROM sessions WHERE token=?', (token,))


def change_password(c, user_id, old_password, new_password, keep_token=None):
    """会员自助改密码（管理员也一样走这里）。

    三点要求：
      1) 必须验原密码，否则任何拿到未锁屏浏览器的人都能直接改；
      2) 新密码长度不得低于注册时的下限，也不能和原密码相同；
      3) 改完把其它设备上的会话全部失效——密码换了，旧登录态就该作废。
         当前这台保留（keep_token），不然用户会被自己踢下线。
    """
    row = c.execute('SELECT * FROM users WHERE id=?', (user_id,)).fetchone()
    if not row:
        raise ValueError('账号不存在')
    old_password = str(old_password or '')
    if not verify_password(old_password, row['password']):
        raise ValueError('原密码不正确')
    new_password = str(new_password or '')
    if len(new_password) < MIN_PASSWORD:
        raise ValueError('新密码至少 %d 位' % MIN_PASSWORD)
    if new_password == old_password:
        raise ValueError('新密码不能和原密码相同')
    c.execute('UPDATE users SET password=? WHERE id=?', (hash_password(new_password), user_id))
    if keep_token:
        c.execute('DELETE FROM sessions WHERE user_id=? AND token<>?', (user_id, keep_token))
    else:
        c.execute('DELETE FROM sessions WHERE user_id=?', (user_id,))
    return True


def purge_expired(c):
    c.execute('DELETE FROM sessions WHERE expires_at<=?', (now(),))


# ---------- RBAC 权限查询 ----------
def permissions_of(c, role_code):
    """某角色的权限码集合。"""
    return {r['perm_code'] for r in c.execute(
        'SELECT perm_code FROM role_permissions WHERE role_code=?', (role_code,)).fetchall()}


def has_permission(c, user, perm_code):
    """用户是否拥有某权限点（唯一鉴权入口）。
    超级管理员角色 admin 拥有一切权限的语义由默认授权覆盖；
    若管理员手动取消某权限，这里也会如实返回 False。"""
    if not user or not user['active']:
        return False
    return perm_code in permissions_of(c, user['role'])


def require_permission(c, user, perm_code):
    """不满足则抛异常，由上层转成 403。"""
    if not has_permission(c, user, perm_code):
        raise PermissionError('没有权限：%s' % perm_code)


def count_users_with_permission(c, perm_code, exclude_id=None, active_only=True):
    """拥有某权限点的会员数（用于「至少保留一名管理员」这类保护）。"""
    sql = '''SELECT COUNT(DISTINCT u.id) FROM users u
             JOIN role_permissions rp ON rp.role_code=u.role
             WHERE rp.perm_code=?'''
    args = [perm_code]
    if active_only:
        sql += ' AND u.active=1'
    if exclude_id is not None:
        sql += ' AND u.id<>?'
        args.append(exclude_id)
    return c.execute(sql, args).fetchone()[0]


def all_roles(c):
    roles = []
    for r in c.execute('SELECT * FROM roles ORDER BY builtin DESC, code').fetchall():
        d = dict(r)
        d['builtin'] = bool(d['builtin'])
        d['permissions'] = sorted(permissions_of(c, d['code']))
        d['users'] = c.execute('SELECT COUNT(*) FROM users WHERE role=?', (d['code'],)).fetchone()[0]
        roles.append(d)
    return roles


def all_permissions(c):
    """按 PERMISSIONS 里的声明顺序返回（与导航/接口顺序一致），
    这样前端权限勾选面板的分组和条目读起来是业务顺序而不是字母序。"""
    order = {p[0]: i for i, p in enumerate(PERMISSIONS)}
    rows = [dict(r) for r in c.execute('SELECT * FROM permissions').fetchall()]
    rows.sort(key=lambda r: order.get(r['code'], 9999))
    return rows


KEEP_ADMIN_PERMS = ('api.admin.users', 'api.admin.roles', 'view.admin')


def set_role_permissions(c, role_code, perm_codes):
    """覆盖式设置角色权限。内置 admin 角色不能被清空到无任何权限，
    否则系统会失去管理能力（至少保留会员管理、角色管理、管理页面入口）。"""
    if not isinstance(perm_codes, list):
        raise ValueError('权限列表必须是数组')
    known = {p[0] for p in PERMISSIONS}
    wanted = {str(x) for x in perm_codes} & known
    if role_code == 'admin':
        wanted |= set(KEEP_ADMIN_PERMS)
    c.execute('DELETE FROM role_permissions WHERE role_code=?', (role_code,))
    for perm in wanted:
        c.execute('INSERT INTO role_permissions(role_code,perm_code) VALUES(?,?)',
                  (role_code, perm))
    return sorted(wanted)


def create_role(c, code, name, description=''):
    code = str(code or '').strip().lower()
    name = str(name or '').strip()
    if not re_ascii(code) or not name:
        raise ValueError('角色代码只能用字母数字下划线，名称不能为空')
    if c.execute('SELECT 1 FROM roles WHERE code=?', (code,)).fetchone():
        raise ValueError('角色代码已存在')
    c.execute('INSERT INTO roles(code,name,description,builtin,created_at) VALUES(?,?,?,0,?)',
              (code, name, str(description or '')[:100], now()))
    return dict(c.execute('SELECT * FROM roles WHERE code=?', (code,)).fetchone())


def delete_role(c, code):
    role = c.execute('SELECT * FROM roles WHERE code=?', (code,)).fetchone()
    if not role:
        raise ValueError('角色不存在')
    if role['builtin']:
        raise ValueError('内置角色不能删除')
    used = c.execute('SELECT COUNT(*) FROM users WHERE role=?', (code,)).fetchone()[0]
    if used:
        raise ValueError('还有 %d 个会员使用这个角色，请先改派' % used)
    c.execute('DELETE FROM role_permissions WHERE role_code=?', (code,))
    c.execute('DELETE FROM roles WHERE code=?', (code,))


def claim_legacy(c, user_id, is_first_admin):
    """把改造前 user_id=0 的老数据归属给首个管理员。
    原系统是单机单用户，这些记录都属于最初的使用者；不迁移的话
    升级后所有人都会发现「我的持仓不见了」。仅首个管理员执行一次。"""
    if not is_first_admin:
        return 0
    n = 0
    for table in ('paper_trades', 'daily_advice'):
        cur = c.execute('UPDATE %s SET user_id=? WHERE user_id=0 OR user_id IS NULL' % table, (user_id,))
        n += cur.rowcount
    return n


def load_ai_config(c, user_id):
    r = c.execute('SELECT * FROM ai_configs WHERE user_id=?', (user_id,)).fetchone()
    return dict(r) if r else {}


def save_ai_config(c, user_id, conf):
    c.execute('''INSERT INTO ai_configs(user_id,provider,base_url,model,api_key) VALUES(?,?,?,?,?)
                 ON CONFLICT(user_id) DO UPDATE SET provider=excluded.provider,
                   base_url=excluded.base_url, model=excluded.model, api_key=excluded.api_key''',
              (user_id, conf.get('provider'), conf.get('base_url'),
               conf.get('model'), conf.get('api_key')))
