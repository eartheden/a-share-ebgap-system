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
    # 给业务表补 user_id（老记录=0，登录后的普通用户看不到）
    for table in ('paper_trades', 'daily_advice'):
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


def purge_expired(c):
    c.execute('DELETE FROM sessions WHERE expires_at<=?', (now(),))


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
