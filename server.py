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
import os
import re
import socket
import sqlite3
import ssl
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import auth   # 会员系统：认证 / 会话 / 权限 / 数据隔离

ROOT = os.path.dirname(os.path.abspath(__file__))
CONF = os.path.expanduser('~/.ebgap-ai.json')
DB = os.path.join(ROOT, 'ebgap.db')
DEFAULT_PORT = 8899
MAX_BODY = 512 * 1024

PROVIDERS = {
    'deepseek': {'base_url': 'https://api.deepseek.com', 'model': 'deepseek-chat', 'label': 'DeepSeek'},
    'qwen': {'base_url': 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'model': 'qwen-plus', 'label': '通义千问'},
    'kimi': {'base_url': 'https://api.moonshot.cn/v1', 'model': 'moonshot-v1-8k', 'label': 'Kimi'},
    'custom': {'base_url': '', 'model': '', 'label': '自定义 OpenAI 兼容接口'},
}


def load_conf():
    if not os.path.exists(CONF):
        return {}
    try:
        with open(CONF, 'r', encoding='utf-8') as f:
            return json.load(f) or {}
    except Exception:
        return {}


def save_conf(data):
    tmp = CONF + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
    os.replace(tmp, CONF)


def masked(key):
    if not key:
        return ''
    if len(key) <= 6:
        return '*' * len(key)
    # 只露后 4 位：前 4 位往往也是厂商前缀，露出来没有辨识价值，只会多泄露信息
    return '****' + key[-4:]


def status_payload(user_id=None, db=None):
    """AI 配置状态。会员各自一套 Key：库里有就用库里的，没有则回退旧全局文件
    （老用户平滑迁移），都不存在时用环境变量。永不返回明文 Key。"""
    c = {}
    if user_id and db is not None:
        c = auth.load_ai_config(db, user_id)
        if not c.get('api_key'):
            # 旧全局 Key 只给「首个管理员」兜底（他是原单机使用者）；
            # 新注册的会员绝不能拿到别人的 Key，否则会替别人烧额度。
            first = db.execute("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").fetchone()
            if first and first['id'] == user_id:
                c = dict(load_conf())
    key = c.get('api_key') or os.environ.get('EBGAP_API_KEY', '')
    provider = c.get('provider') or ('deepseek' if key else '')
    preset = PROVIDERS.get(provider, {})
    return {
        'configured': bool(key),
        'provider': provider,
        'provider_label': preset.get('label', provider or '未配置'),
        'model': c.get('model') or preset.get('model', ''),
        'base_url': c.get('base_url') or preset.get('base_url', ''),
        'key_masked': masked(key),
        'providers': [{'id': k, 'label': v['label'], 'model': v['model'], 'base_url': v['base_url']}
                      for k, v in PROVIDERS.items()],
    }


SYSTEM_PROMPT = (
    '你是一名严谨的 A 股交易研究员，服务于一个量化选股系统。'
    '你的职责不是从全市场挑股票，而是对系统已经用当日量价资金数据筛出的候选名单做复核与排序。'
    '硬性规则：'
    '1) 只能评价名单中出现的股票，绝不新增名单外的标的；'
    '2) 只能使用用户给你的数据做判断，不得编造财务报表、公告、新闻、题材或机构观点；'
    '3) 你的知识可能过期，若没有把握，判定为「可观察」并说明原因，不要为了给出结论而编造理由；'
    '4) 不做收益承诺、不给目标价预测，只给交易纪律层面的判断；'
    '5) 必须严格按用户标注的「复核口径」（短线 / 中线 / 长线）判断，不要用短线情绪否定长线标的，也不要用长线估值放过短线的量价背离；'
    '6) 所有文字使用简体中文，简洁、具体、可执行。'
    '输出要求：只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释性前后缀。'
)

HORIZON_BRIEF = {
    'S': ('短线（建议持有 1–5 个交易日）',
          '重点看主力资金当日强度、量比与换手是否配合、所属行业当日热度、次日承接；'
          '不看中长期基本面，但要求没有硬伤，且不能是已经封板买不进的票。'),
    'M': ('中线（建议持有 10–30 个交易日）',
          '重点看 60 日趋势所处阶段（启动段优于中后段）、行业动能能否延续、资金是否持续流入、'
          'ROE 与净利增速是否拖后腿；容忍当日涨跌，不追已经加速的票。'),
    'L': ('长线（建议持有 60–180 个交易日）',
          '重点看 ROE 与净利增速的稳定性、PE/PB 相对行业的估值水平、市值与流动性、'
          '当前位置是否已透支；忽略当日量价与短期情绪，只排「业绩证伪、估值过贵、趋势未止跌」这三类雷。'),
}


def build_user_prompt(payload):
    mkt = payload.get('mkt') or {}
    picks = payload.get('picks') or []
    hz = payload.get('horizon') or {}
    hz_key = hz.get('key') or 'S'
    hz_label, hz_focus = HORIZON_BRIEF.get(hz_key, HORIZON_BRIEF['S'])
    lines = []
    lines.append('【本轮复核口径】%s' % hz_label)
    lines.append('判断重点：%s' % hz_focus)
    lines.append('')
    lines.append('【当日市场】')
    lines.append('交易日 %s；行情判定：%s；市场温度 %s/100（涨 %s 家、跌 %s 家、涨停 %s 家、跌停 %s 家，两市成交 %.2f 亿）。'
                 % (payload.get('quoteDate', '—'), mkt.get('regime_label', '—'), mkt.get('temp', '—'),
                    mkt.get('up', '—'), mkt.get('down', '—'), mkt.get('zt', '—'), mkt.get('dt', '—'),
                    (mkt.get('amt') or 0) / 1e8))
    if mkt.get('idx'):
        lines.append('指数：' + '；'.join('%s %s (%+.2f%%)' % (i.get('name'), i.get('price'), i.get('pct'))
                                       for i in mkt['idx']))
    lines.append('')
    lines.append('【候选名单】以下 %d 只已通过「%s」档的硬性过滤，'
                 '综合分是七维加权后按本档口径合成：D1 资金动能、D2 量价强度、D3 位置空间、'
                 'D4 行业动能、D5 流动性、D6 质量安全、D7 前瞻信号（吸筹潜伏/蓄势/未透支/行业轮动位，'
                 '短线权重最高，用于避免追当日涨幅榜）；V 为估值分（PE/PB 行业相对水平）。'
                 '注意：名单刻意排除了当日涨幅过大、位置过高的追高标的。'
                 % (len(picks), hz_label.split('（')[0]))
    for i, p in enumerate(picks, 1):
        fw = p.get('forward') or {}
        lines.append(
            '%d. %s %s | 行业 %s | 现价 %.2f (%+.2f%%) | 综合 %.1f | D1-D7: %s,%s,%s,%s,%s,%s,%s | V %s | '
            '前瞻细分[吸筹%s/蓄势%s/空间%s/轮动%s] | '
            '主力净额 %.2f 亿（占成交额 %.1f%%）| 换手 %.1f%% | 量比 %.2f | 成交额 %.2f 亿 | 市值 %.0f 亿 | '
            '近60日 %+.1f%% | 年内 %+.1f%% | PE %s | PB %s | ROE %s | 净利同比 %+.1f%%'
            % (i, p.get('code'), p.get('name'), p.get('ind'), p.get('price', 0), p.get('pct', 0),
               p.get('total', 0), p.get('d1'), p.get('d2'), p.get('d3'), p.get('d4'), p.get('d5'), p.get('d6'), p.get('d7', '—'),
               p.get('value', '—'),
               fw.get('absorb', '—'), fw.get('coil', '—'), fw.get('head', '—'), fw.get('rotation', '—'),
               (p.get('net') or 0) / 1e8, p.get('netRatio') or 0, p.get('turn') or 0, p.get('volRatio') or 0,
               (p.get('amt') or 0) / 1e8, (p.get('cap') or 0) / 1e8, p.get('d60') or 0, p.get('ytd') or 0,
               ('%.1f' % p['pe']) if (p.get('pe') or 0) > 0 else '亏损',
               ('%.2f' % p['pb']) if (p.get('pb') or 0) > 0 else '—',
               ('%.1f%%' % p['roe']) if p.get('roe') else '—', p.get('npYoY') or 0))
    lines.append('')
    lines.append('【你的任务】')
    lines.append('1) 用一句话概括这批「%s」候选的共同特征与主要风险；' % hz_label.split('（')[0])
    lines.append('2) 对名单里每一只给出判定：重点关注 / 可观察 / 建议剔除，并给出不超过 45 字的具体理由（必须引用上面给的数据，不要编造）；')
    lines.append('3) 给出最多 3 只你认为最值得优先关注的，说明排序逻辑（为什么它排在前面，必须符合本档持有周期）；')
    lines.append('4) 指出你认为应该从名单中剔除的标的及原因（按本档口径，不要用别的周期标准）；')
    lines.append('5) 给一句本档的执行纪律提醒（例如仓位、买入时机、什么情况放弃）。')
    lines.append('')
    lines.append('输出 JSON 结构（严格遵守字段名）：')
    lines.append(json.dumps({
        "market_read": "一句话概括 + 主要风险",
        "picks": [{"code": "6位代码", "name": "名称", "verdict": "重点关注|可观察|建议剔除",
                   "ai_score": 0, "reason": "不超过45字，引用具体数据", "risk": "不超过20字"}],
        "top": [{"code": "6位代码", "why_first": "不超过40字"}],
        "drop": [{"code": "6位代码", "why": "不超过30字"}],
        "plan": "一句话执行纪律"
    }, ensure_ascii=False))
    return '\n'.join(lines)


def call_llm(conf, payload):
    provider = conf.get('provider') or 'deepseek'
    preset = PROVIDERS.get(provider, {})
    base = (conf.get('base_url') or preset.get('base_url') or '').rstrip('/')
    model = conf.get('model') or preset.get('model')
    key = conf.get('api_key') or os.environ.get('EBGAP_API_KEY', '')
    if not base or not model:
        raise ValueError('未配置 base_url 或 model')
    if not key:
        raise ValueError('未配置 API Key')

    body = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': SYSTEM_PROMPT},
            {'role': 'user', 'content': build_user_prompt(payload)},
        ],
        'temperature': 0.2,
        'max_tokens': 3000,
        'response_format': {'type': 'json_object'},
    }
    req = urllib.request.Request(
        base + '/chat/completions',
        data=json.dumps(body).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        raw_err = e.read().decode('utf-8', 'replace')
        detail = ''
        try:
            j = json.loads(raw_err)
            detail = ((j.get('error') or {}).get('message') or '').strip()
        except Exception:
            detail = ' '.join(raw_err.split())[:160]
        msg = {401: 'API Key 无效或已过期', 402: '账户余额不足', 429: '请求过于频繁，请稍后再试',
               404: '接口地址或模型名不对'}.get(e.code, '模型接口返回 %d' % e.code)
        raise ValueError(msg + ('：' + detail if detail else ''))
    except urllib.error.URLError as e:
        raise ValueError('连不上模型接口：%s' % e.reason)

    data = json.loads(raw) if raw.strip().startswith(('{', '[')) else None
    if data is None:
        raise ValueError('模型接口返回的不是 JSON（可能是网关或代理错误页）：' + raw[:120].replace('\n', ' '))
    text = (data.get('choices') or [{}])[0].get('message', {}).get('content') or ''
    text = text.strip()
    if text.startswith('```'):
        text = text.split('```')[1] if '```' in text[3:] else text.strip('`')
        text = text.lstrip('json').strip()
    try:
        parsed = json.loads(text)
    except Exception:
        raise ValueError('模型没有返回合法 JSON，请重试')
    usage = data.get('usage') or {}
    return {'result': parsed, 'usage': usage, 'model': data.get('model') or model}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        if '/api/' in (args[0] if args else ''):
            sys.stderr.write('[api] ' + (fmt % args) + '\n')

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
        常被改写成内部地址，直接字符串比对会误判成「跨站」——所以按域名比对，
        并把反代标准头 X-Forwarded-Host / X-Forwarded-Proto 纳入可信来源。
        """
        origin = (self.headers.get('Origin') or '').strip()
        if not origin:
            return True    # curl 等本机命令行工具不带 Origin
        try:
            parts = urllib.parse.urlsplit(origin)
        except Exception:
            return False
        oh = (parts.netloc or '').lower()
        if not oh:
            return False
        oh_host = oh.split(':')[0]

        # 允许的域名：请求 Host + 反代转发头（都去掉端口只比域名）
        allowed = set()
        for h in (self.headers.get('Host'), self.headers.get('X-Forwarded-Host'),
                  self.headers.get('X-Forwarded-Server')):
            if h:
                allowed.add(h.strip().lower().split(':')[0])
        if oh_host in allowed:
            return True

        # 本机直连的两种写法（旧行为兼容）
        port = self.server.server_port
        if oh in ('127.0.0.1:%d' % port, 'localhost:%d' % port):
            return True

        # 托管环境兜底：平台注入 PORT 说明跑在反代后面，反代是唯一公网入口；
        # 会话 Cookie 已 HttpOnly + SameSite=Lax，所有业务 API 仍需登录鉴权，
        # 这里放宽同源判断不会引入越权，只是避免在反代头缺失时把正常用户挡在门外。
        if os.environ.get('PORT') and parts.scheme in ('http', 'https'):
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

    def _bytes(self, body, code=200):
        self._cache_set = True
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

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
            finally:
                conn.close()
        # 静态资源本身放行（登录页要能加载 HTML/JS/CSS）
        p = self.path.split('?')[0]
        if p.endswith('.py') or '/.' in p or p.endswith('.db'):
            return self._json({'ok': False, 'error': 'not found'}, 404)
        return super().do_GET()

    def _auth_get(self):
        """未登录也可访问的接口：只看当前是谁。"""
        conn, user = self._session()
        try:
            if self.path.startswith('/api/auth/me'):
                return self._json({'ok': True, 'user': auth.row_public(user) if user else None})
            return self._json({'ok': False, 'error': 'unknown auth endpoint'}, 404)
        finally:
            conn.close()

    def _authed_get(self, conn, user):
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
        if self.path.startswith('/api/advice/daily') or self.path.startswith('/api/advice/list'):
            qs = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(qs)
            date = (params.get('date') or [None])[0]
            limit = int((params.get('limit') or ['20'])[0])
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

    def _auth_post(self):
        conn = db_conn()
        try:
            data = self._read_json()
            if self.path.startswith('/api/auth/register'):
                u = auth.register(conn, data.get('username'), data.get('password'))
                conn.commit()
                return self._json({'ok': True, 'user': u})
            if self.path.startswith('/api/auth/login'):
                token, u = auth.login(conn, data.get('username'), data.get('password'))
                # 首个管理员登录时把改造前的老持仓/建议归属到自己名下，避免升级后「数据不见了」
                first_admin = conn.execute(
                    "SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").fetchone()
                migrated = auth.claim_legacy(conn, u['id'],
                                             bool(first_admin and first_admin['id'] == u['id']))
                conn.commit()
                return self._json_with_cookie(
                    {'ok': True, 'user': u, 'legacy_migrated': migrated}, token)
            if self.path.startswith('/api/auth/logout'):
                auth.logout(conn, self._token())
                conn.commit()
                return self._json_with_cookie({'ok': True}, None)   # 清 cookie
            return self._json({'ok': False, 'error': 'unknown auth endpoint'}, 404)
        finally:
            conn.close()

    def _authed_post(self, conn, user):
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

    # ---------- 管理员接口（仅 admin） ----------
    def _require_admin(self, user):
        if user['role'] != 'admin':
            return self._json({'ok': False, 'error': '需要管理员权限'}, 403)
        return None

    def _admin_get(self, conn, user):
        denied = self._require_admin(user)
        if denied:
            return denied
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

    def _admin_post(self, conn, user):
        denied = self._require_admin(user)
        if denied:
            return denied
        data = self._read_json()
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
            if row['role'] == 'admin' and want == 0:
                cnt = conn.execute("SELECT COUNT(*) FROM users WHERE role='admin' AND active=1").fetchone()[0]
                if cnt <= 1:
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
            want = 'admin' if data.get('role') == 'admin' else 'member'
            if row['role'] == 'admin' and want == 'member':
                cnt = conn.execute("SELECT COUNT(*) FROM users WHERE role='admin' AND active=1").fetchone()[0]
                if cnt <= 1:
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
            # 管理员直接建号（无需对方自行注册）
            u = auth.register(conn, data.get('username'), data.get('password'))
            if data.get('role') == 'admin':
                conn.execute("UPDATE users SET role='admin' WHERE id=?", (u['id'],))
                u['role'] = 'admin'
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

TRADE_COLS = [
    'id', 'code', 'name', 'ind', 'buy_price', 'buy_date', 'buy_at',
    'shares', 'amt', 'suggest_low', 'suggest_high', 'stop', 't1', 't2',
    'hold', 'pos_pct', 'score', 'status', 'cur_price',
    'close_price', 'close_date', 'close_at', 'close_reason',
    'result_pct', 'pnl', 'hz', 'note', 'created_at', 'updated_at',
]


def db_conn():
    conn = sqlite3.connect(DB, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def db_init():
    with db_conn() as c:
        # 会员系统：用户 / 会话 / AI 配置表，以及业务表的 user_id 隔离列
        auth.init_schema(c)
        c.execute('''
            CREATE TABLE IF NOT EXISTS paper_trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL,
                name TEXT,
                ind TEXT,
                buy_price REAL NOT NULL,
                buy_date TEXT,
                buy_at INTEGER,
                shares INTEGER,
                amt REAL,
                suggest_low REAL,
                suggest_high REAL,
                stop REAL,
                t1 REAL,
                t2 REAL,
                hold TEXT,
                pos_pct REAL,
                score REAL,
                status TEXT NOT NULL DEFAULT 'open',
                cur_price REAL,
                close_price REAL,
                close_date TEXT,
                close_at INTEGER,
                close_reason TEXT,
                result_pct REAL,
                pnl REAL,
                hz TEXT,
                note TEXT,
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                updated_at TEXT DEFAULT (datetime('now', 'localtime'))
            )''')
        # 老库补列：hz（档位 S/M/L）与 note（交易备注）是三档改造后新增的，
        # 直接 ALTER 比让用户删库重来稳妥。
        _ensure_cols(c, 'paper_trades', [('hz', 'TEXT'), ('note', 'TEXT')])
        c.execute('CREATE INDEX IF NOT EXISTS idx_paper_status ON paper_trades(status)')
        c.execute('''
            CREATE TABLE IF NOT EXISTS daily_advice (
                date TEXT PRIMARY KEY,
                regime TEXT,
                regime_label TEXT,
                temp REAL,
                pos_text TEXT,
                note TEXT,
                picks TEXT,
                updated_at TEXT DEFAULT (datetime('now', 'localtime'))
            )''')
        c.commit()


def _ensure_cols(c, table, cols):
    """给已存在的表补列（SQLite 的 ADD COLUMN 很便宜，不需要重建表）。"""
    have = {r['name'] for r in c.execute('PRAGMA table_info(%s)' % table).fetchall()}
    for name, ddl in cols:
        if name not in have:
            c.execute('ALTER TABLE %s ADD COLUMN %s %s' % (table, name, ddl))


def rows_to_dicts(rows):
    return [{k: r[k] for k in TRADE_COLS if k in r.keys()} for r in rows]


def paper_list(user_id):
    with db_conn() as c:
        rows = c.execute(
            "SELECT * FROM paper_trades WHERE user_id=? ORDER BY status = 'closed', buy_at DESC",
            (user_id,)).fetchall()
    return rows_to_dicts(rows)


def paper_buy(d, user_id):
    """开一笔模拟仓。

    幂等规则（防止迁移/重试产生重复记录）：
      1) 同一 code 已有 open 持仓 → 返回已有，不重复开仓；
      2) 迁移的历史记录带 buy_at，若库里已存在相同 (code, buy_at) 的记录
         （无论 open 还是 closed）→ 返回已有，不重复插入。
    这样即便 close 请求超时后前端重试迁移，也不会再建一条重复仓。
    """
    code = str(d.get('code') or '').strip()
    price = d.get('buy_price')
    if not code or not isinstance(price, (int, float)) or price <= 0:
        raise ValueError('缺少 code 或 buy_price')
    with db_conn() as c:
        dup = c.execute(
            "SELECT * FROM paper_trades WHERE user_id=? AND code = ? AND status = 'open'", (user_id, code)).fetchone()
        if not dup and d.get('buy_at'):
            dup = c.execute(
                'SELECT * FROM paper_trades WHERE user_id=? AND code = ? AND buy_at = ? ORDER BY id LIMIT 1',
                (user_id, code, d.get('buy_at'))).fetchone()
        if dup:
            return {'ok': True, 'duplicate': True, 'trade': rows_to_dicts([dup])[0]}
        cur = c.execute('''
            INSERT INTO paper_trades
            (code, name, ind, buy_price, buy_date, buy_at, shares, amt,
             suggest_low, suggest_high, stop, t1, t2, hold, pos_pct, score,
             hz, note, status, cur_price, user_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'open', ?, ?)
        ''', (
            code, d.get('name'), d.get('ind'), price, d.get('buy_date'), d.get('buy_at'),
            d.get('shares'), d.get('amt'),
            d.get('suggest_low'), d.get('suggest_high'),
            d.get('stop'), d.get('t1'), d.get('t2'),
            d.get('hold'), d.get('pos_pct'), d.get('score'),
            d.get('hz'), d.get('note'), price, user_id,
        ))
        c.commit()
        row = c.execute('SELECT * FROM paper_trades WHERE id = ?', (cur.lastrowid,)).fetchone()
    return {'ok': True, 'duplicate': False, 'trade': rows_to_dicts([row])[0]}


def _finish(row, price, reason):
    result = (price / row['buy_price'] - 1) * 100 if row['buy_price'] else 0
    pnl = (price - row['buy_price']) * (row['shares'] or 0)
    return result, pnl


def paper_close(d, user_id):
    tid = d.get('id')
    price = d.get('price')
    if not tid or not isinstance(price, (int, float)) or price <= 0:
        raise ValueError('缺少 id 或 price')
    with db_conn() as c:
        row = c.execute(
            "SELECT * FROM paper_trades WHERE user_id=? AND id = ? AND status = 'open'", (user_id, tid)).fetchone()
        if not row:
            raise ValueError('该笔持仓不存在或已平仓')
        result, pnl = _finish(row, price, d.get('reason'))
        c.execute('''
            UPDATE paper_trades SET status='closed', close_price=?, close_date=?,
                close_at=?, close_reason=?, result_pct=?, pnl=?, cur_price=?,
                updated_at=datetime('now','localtime')
            WHERE user_id=? AND id = ?
        ''', (price, d.get('close_date'), d.get('close_at'), d.get('reason') or '手动平仓',
              result, pnl, price, user_id, tid))
        c.commit()
        row = c.execute('SELECT * FROM paper_trades WHERE user_id=? AND id = ?', (user_id, tid)).fetchone()
    return {'ok': True, 'trade': rows_to_dicts([row])[0]}


def paper_tick(d, user_id):
    """批量报送最新价：更新现价，触止损/止盈自动平仓。返回有变化的记录。"""
    quotes = d.get('quotes') or {}
    if not isinstance(quotes, dict):
        raise ValueError('quotes 必须是 {code: price} 字典')
    changed = []
    with db_conn() as c:
        rows = c.execute("SELECT * FROM paper_trades WHERE user_id=? AND status = 'open'", (user_id,)).fetchall()
        for row in rows:
            price = quotes.get(row['code'])
            if not isinstance(price, (int, float)) or price <= 0:
                continue
            # 报价单位异常防护：上游偶发把「元」报成「分」（×100）或反之，
            # 若照单执行会把持仓全部误触止盈/止损（4.00 元 → 400 → +9900%）。
            # 单日不可能偏离买入价 5 倍或跌到 1/5，超出即视为脏数据，跳过该笔。
            bp = row['buy_price'] or 0
            if bp > 0 and (price > bp * 5 or price < bp * 0.2):
                continue
            reason = None
            if row['stop'] and price <= row['stop']:
                reason = '触发止损'
            elif row['t1'] and price >= row['t1']:
                reason = '达到目标 T1'
            if reason:
                result, pnl = _finish(row, price, reason)
                c.execute('''
                    UPDATE paper_trades SET status='closed', close_price=?, close_date=?,
                        close_at=?, close_reason=?, result_pct=?, pnl=?, cur_price=?,
                        updated_at=datetime('now','localtime')
                    WHERE user_id=? AND id = ?
                ''', (price, d.get('date'), d.get('at'), reason, result, pnl, price, user_id, row['id']))
            else:
                c.execute(
                    'UPDATE paper_trades SET cur_price=?, updated_at=datetime(\'now\',\'localtime\') WHERE user_id=? AND id=?',
                    (price, user_id, row['id']))
            changed.append(row['id'])
        c.commit()
    return {'ok': True, 'changed': changed, 'trades': paper_list(user_id)}


def paper_clear(user_id):
    with db_conn() as c:
        c.execute('DELETE FROM paper_trades WHERE user_id=?', (user_id,))
        c.commit()
    return {'ok': True}


def paper_update(d, user_id):
    """调整一笔持仓的计划：止损 / 目标 / 备注。

    只允许改「计划类」字段，不允许改买入价与股数——否则回测就失真了。
    止损高于目标、或止损不低于现价等明显不合理的设置直接拒绝，
    免得用户存进一个「下次 tick 立刻触发」的坑。
    """
    tid = d.get('id')
    if not tid:
        raise ValueError('缺少 id')
    fields = {}
    for k in ('stop', 't1', 't2'):
        if k not in d:
            continue
        v = d.get(k)
        if v is None or v == '':
            continue
        if not isinstance(v, (int, float)) or v <= 0:
            raise ValueError('%s 必须是大于 0 的数字' % k)
        fields[k] = float(v)
    if 'note' in d:
        fields['note'] = str(d.get('note') or '')[:200]
    if not fields:
        raise ValueError('没有需要更新的字段')
    if 'stop' in fields and 't1' in fields and fields['stop'] >= fields['t1']:
        raise ValueError('止损价必须低于第一目标价')
    with db_conn() as c:
        row = c.execute('SELECT * FROM paper_trades WHERE user_id=? AND id = ?', (user_id, tid)).fetchone()
        if not row:
            raise ValueError('该笔持仓不存在')
        stop = fields.get('stop', row['stop'])
        t1 = fields.get('t1', row['t1'])
        if stop and t1 and stop >= t1:
            raise ValueError('止损价必须低于第一目标价')
        if row['status'] == 'open' and fields.get('stop') and row['buy_price'] and fields['stop'] >= row['buy_price'] * 1.2:
            raise ValueError('止损价不能高于买入价的 120%，请确认是否填错')
        sets = ', '.join('%s = ?' % k for k in fields)
        c.execute(
            'UPDATE paper_trades SET %s, updated_at = datetime(\'now\', \'localtime\') WHERE user_id=? AND id = ?' % sets,
            tuple(fields.values()) + (user_id, tid))
        c.commit()
        row = c.execute('SELECT * FROM paper_trades WHERE user_id=? AND id = ?', (user_id, tid)).fetchone()
    return {'ok': True, 'trade': rows_to_dicts([row])[0]}


def advice_upsert(d, user_id):
    date = str(d.get('date') or '').strip()
    picks = d.get('picks')
    if not date or not isinstance(picks, list) or not picks:
        raise ValueError('缺少 date 或 picks')
    slim = [{
        'code': p.get('code'), 'name': p.get('name'), 'ind': p.get('ind'),
        'price': p.get('price'), 'score': p.get('score'),
        'suggest_low': p.get('suggest_low'), 'suggest_high': p.get('suggest_high'),
        'stop': p.get('stop'), 't1': p.get('t1'), 't2': p.get('t2'),
        'hold': p.get('hold'), 'pos_pct': p.get('pos_pct'),
        # 周期档：S 短线 / M 中线 / L 长线（三档各自 6/4/3 只，最多 15 条）
        'hz': p.get('hz'),
    } for p in picks[:15]]
    with db_conn() as c:
        # 每天每人一条：先删本用户当天旧记录，再插入（date 单列主键无法做复合唯一，
        # 这样避免改表主键，同时保证「同一用户同一天」只有一条）。
        c.execute('DELETE FROM daily_advice WHERE date=? AND user_id=?', (date, user_id))
        c.execute('''
            INSERT INTO daily_advice (date, regime, regime_label, temp, pos_text, note, picks, updated_at, user_id)
            VALUES (?,?,?,?,?,?,?, datetime('now','localtime'), ?)
        ''', (date, d.get('regime'), d.get('regime_label'), d.get('temp'),
              d.get('pos_text'), d.get('note'), json.dumps(slim, ensure_ascii=False), user_id))
        c.commit()
    return {'ok': True}


def advice_get(date=None, limit=20, user_id=None):
    with db_conn() as c:
        if date:
            row = c.execute('SELECT * FROM daily_advice WHERE date = ? AND user_id = ?', (date, user_id)).fetchone()
            rows = [row] if row else []
        else:
            rows = c.execute(
                'SELECT * FROM daily_advice WHERE user_id = ? ORDER BY date DESC LIMIT ?', (user_id, limit)).fetchall()
    out = []
    for r in rows:
        item = dict(r)
        try:
            item['picks'] = json.loads(item.get('picks') or '[]')
        except Exception:
            item['picks'] = []
        out.append(item)
    return out


# ---------------------------------------------------------------------------
# 行情中转：绕开本机 DNS / 代理的 fake-ip 干扰
#
# 背景：这台机器开着 VPN（Clash 类 fake-ip 模式），push2.eastmoney.com 被解析到
# 198.18.0.x 的假地址，浏览器直连会一直挂着不返回（表现为「接口不可达」）。
# 但用真实公网 IP 直连是通的。
#
# 做法：服务端自己用 DoH（阿里 223.5.5.5）查真实 A 记录，跳过 198.18.0.0/15
# 这类假地址，再用「连 IP、SNI 仍是域名」的方式发 HTTPS 请求。
# 浏览器只跟 127.0.0.1 通信，DNS 怎么配都不影响页面。
# ---------------------------------------------------------------------------

DOH_URL = 'https://223.5.5.5/resolve'
MARKET_HOST = 'push2.eastmoney.com'
FAKE_NETS = ('198.18.', '198.19.', '0.0.0.0', '127.')
TENCENT_RANK = ('https://proxy.finance.qq.com/cgi/cgi-bin/rank/hs/getBoardRankList'
                '?board_code=aStock&sort_type=PriceRatio&direct=down&offset=%d&count=%d')
TENCENT_QUOTE = 'https://qt.gtimg.cn/q=%s'
INDEX_CODES = 'sh000001,sz399001,sz399006,sh000300'
_dns_cache = {}     # host -> (ip, expire_ts)
_http_cache = {}    # path -> (payload_bytes, expire_ts)
_tencent_cache = {}  # {'at': ts, 'rows': [...], 'total': n}
_em_block_until = {'ts': 0}   # 东财接口失败后的熔断时间（60 秒内直接走备用源）


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """连到指定 IP，但 TLS 握手仍用真实域名做 SNI 与证书校验。"""

    def __init__(self, host, ip, port=443, timeout=8):
        super().__init__(host, port, timeout=timeout)
        self._ip = ip

    def connect(self):
        sock = socket.create_connection((self._ip, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def _is_fake(ip):
    return any(ip.startswith(p) for p in FAKE_NETS)


def resolve_real(host, ttl=600):
    """走 DoH 拿真实 IPv4；跳过 fake-ip 段。结果缓存 10 分钟。"""
    hit = _dns_cache.get(host)
    if hit and hit[1] > time.time():
        return hit[0]
    ip = None
    try:
        req = urllib.request.Request(
            DOH_URL + '?name=' + urllib.parse.quote(host) + '&type=A',
            headers={'Accept': 'application/dns-json'})
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read().decode('utf-8', 'replace'))
        for ans in data.get('Answer') or []:
            ipv4 = ans.get('data') or ''
            if ans.get('type') == 1 and not _is_fake(ipv4):
                ip = ipv4
                break
    except Exception:
        ip = None
    if not ip:
        # DoH 不通时退回系统解析，同样过滤假地址
        try:
            for info in socket.getaddrinfo(host, 443, socket.AF_INET):
                cand = info[4][0]
                if not _is_fake(cand):
                    ip = cand
                    break
        except Exception:
            pass
    if not ip:
        raise ValueError('无法解析 %s 的真实地址（可能是 VPN 的 fake-ip 拦截）' % host)
    _dns_cache[host] = (ip, time.time() + ttl)
    return ip


def _em_get(path, timeout):
    """按域名直连（让 VPN 按域名规则路由，fake-ip 也能正确映射）。"""
    conn = http.client.HTTPSConnection(MARKET_HOST, 443, timeout=timeout)
    try:
        conn.request('GET', path, headers={
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/145.0 Safari/537.36',
            'Referer': 'https://quote.eastmoney.com/',
            'Accept': '*/*',
        })
        resp = conn.getresponse()
        raw = resp.read()
        if resp.status != 200:
            raise ValueError('行情接口返回 HTTP %d' % resp.status)
        return raw
    finally:
        conn.close()


def fetch_quote_host(path, timeout=10, cache_ttl=8):
    """向东方财富行情主机发 GET，返回去掉 JSONP 包裹的原始字节。

    优先按域名直连（尊重 VPN 的域名分流规则，如 push2 的 DIRECT）；
    域名失败时退回 DoH 解析真实 IP + SNI 固定域名（应对 fake-ip 劫持）。"""
    key = path
    hit = _http_cache.get(key)
    if hit and hit[1] > time.time():
        return hit[0]
    try:
        raw = _em_get(path, timeout)
    except Exception:
        ip = resolve_real(MARKET_HOST)
        conn = _PinnedHTTPSConnection(MARKET_HOST, ip, timeout=timeout)
        try:
            conn.request('GET', path, headers={
                'Host': MARKET_HOST,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/145.0 Safari/537.36',
                'Referer': 'https://quote.eastmoney.com/',
                'Accept': '*/*',
            })
            resp = conn.getresponse()
            raw = resp.read()
            if resp.status != 200:
                raise ValueError('行情接口返回 HTTP %d' % resp.status)
        finally:
            conn.close()
    # 去掉 cb(...) 包裹，统一返回纯 JSON
    text = raw.decode('utf-8', 'replace').strip()
    if text.startswith('{') or text.startswith('['):
        body = text.encode('utf-8')
    elif '(' in text and text.endswith(');'):
        body = text[text.index('(') + 1:-2].encode('utf-8')
    else:
        raise ValueError('行情接口返回了非 JSON 内容')
    if cache_ttl:
        if len(_http_cache) > 300:
            _http_cache.clear()
        _http_cache[key] = (body, time.time() + cache_ttl)
    return body


# ---------------------------------------------------------------------------
# 备用行情源：腾讯财经
#
# 什么时候用：东方财富 push2 接口在当前网络被拦（TLS 能握手、根路径能通，
# 唯独 /api/qt/* 返回空响应）时，自动切到腾讯。
#
# 覆盖度：腾讯榜单接口一次给全 A 股 4600+ 只，字段比东财只多不少——
#   现价/涨跌幅/成交额/换手/量比/振幅/PE(TTM)/总市值/流通市值、
#   近 60 日涨幅 zdf_d60、年内涨幅 zdf_y、主力净流入 zljlr、主力 5 日流入。
# 缺：当日最高/最低/开盘（只影响 D2 的「收盘位置」一项，退化为中性 0.5）、
#     ROE/净利同比/行业（行业退化为板块：主板/创业板/科创板）。
# 做法：把腾讯字段翻译成东财的 f2/f3/f6… 字段名，前端解析逻辑一行不用改。
# ---------------------------------------------------------------------------

_EM_TYPE_TO_BOARD = {
    'GP-A': '主板', 'GP-A-CYB': '创业板', 'GP-A-KCB': '科创板', 'GP-A-BJ': '北交所',
}


def _f(v, default=0.0):
    try:
        x = float(v)
        return x if x == x else default   # 过滤 NaN
    except (TypeError, ValueError):
        return default


def _tencent_rank_page(offset, count=200):
    req = urllib.request.Request(
        TENCENT_RANK % (offset, count),
        headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                               'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0 Safari/537.36',
                 'Referer': 'https://gu.qq.com/'})
    with urllib.request.urlopen(req, timeout=10) as r:
        data = json.loads(r.read().decode('utf-8', 'replace'))
    d = data.get('data') or {}
    return d.get('rank_list') or [], int(d.get('total') or 0)


def _rank_to_em(item):
    """腾讯榜单行 → 东财 clist 行（字段名对齐前端 parseRow）。"""
    raw = str(item.get('code') or '')
    code = raw[2:] if raw[:2] in ('sh', 'sz') else raw
    price = _f(item.get('zxj'))
    pct = _f(item.get('zdf'))
    prev = price - _f(item.get('zd'))
    board = _EM_TYPE_TO_BOARD.get(str(item.get('stock_type')), '主板')
    return {
        'f2': price,                        # 现价
        'f3': pct,                          # 涨跌幅 %
        'f6': _f(item.get('turnover')) * 1e4,   # 成交额（万元 → 元）
        'f7': _f(item.get('zf')),           # 振幅 %
        'f8': _f(item.get('hsl')),          # 换手率 %
        'f10': _f(item.get('lb')),          # 量比
        'f12': code,
        'f14': item.get('name') or '',
        'f15': price,                       # 腾讯榜单无最高价，退化为现价
        'f16': price,                       # 同上，收盘位置按中性 0.5 处理
        'f17': prev,                        # 今开缺失，用昨收占位（仅展示用）
        'f18': prev,                        # 昨收
        'f20': _f(item.get('zsz')) * 1e8,   # 总市值（亿 → 元）
        'f21': _f(item.get('ltsz')) * 1e8,  # 流通市值
        'f24': _f(item.get('zdf_d60')),     # 近 60 日涨幅 %
        'f25': _f(item.get('zdf_y')),       # 年内涨幅 %
        'f26': 0,                           # 上市日期缺失
        'f37': 0,                           # ROE 缺失（质量分退化为中性）
        'f46': 0,                           # 净利同比缺失
        'f62': _f(item.get('zljlr')) * 1e4, # 主力净流入（万元 → 元）
        'f100': board,                      # 行业退化为板块
        'f115': _f(item.get('pe_ttm')),     # PE(TTM)
    }


def tencent_snapshot(ttl=60):
    """全市场快照（腾讯源），缓存 ttl 秒。返回 (rows, total)。"""
    now = time.time()
    if _tencent_cache.get('rows') and _tencent_cache.get('at', 0) + ttl > now:
        return _tencent_cache['rows'], _tencent_cache['total']
    first, total = _tencent_rank_page(0, 200)
    rows = [_rank_to_em(x) for x in first]
    pages = max(1, (total + 199) // 200)
    if pages > 1:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=6) as ex:
            futs = [ex.submit(_tencent_rank_page, i * 200, 200) for i in range(1, pages)]
            for fut in futs:
                try:
                    page, _ = fut.result()
                except Exception:
                    continue
                rows.extend(_rank_to_em(x) for x in page)
    seen, out = set(), []
    for r in rows:
        if not r['f12'] or r['f12'] in seen or r['f2'] <= 0:
            continue
        seen.add(r['f12'])
        out.append(r)
    _tencent_cache.update({'at': now, 'rows': out, 'total': len(out)})
    return out, len(out)


def _tencent_index_payload():
    """腾讯指数行情 → 东财 ulist.np 结构（f2/f3/f6/f12/f14/f124）。"""
    req = urllib.request.Request(
        TENCENT_QUOTE % INDEX_CODES,
        headers={'Referer': 'https://gu.qq.com/', 'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=8) as r:
        text = r.read().decode('gbk', 'replace')
    diff = []
    for line in text.split(';'):
        line = line.strip()
        if not line.startswith('v_') or '="' not in line:
            continue
        body = line.split('="', 1)[1].rstrip('"')
        p = body.split('~')
        if len(p) < 40:
            continue
        ts = None
        stamp = p[30] if len(p) > 30 else ''
        if len(stamp) >= 14 and stamp[:8].isdigit():
            try:
                import datetime as _dt
                d = _dt.datetime.strptime(stamp[:14], '%Y%m%d%H%M%S')
                ts = int(d.replace(tzinfo=_dt.timezone(_dt.timedelta(hours=8))).timestamp())
            except Exception:
                ts = None
        diff.append({
            'f2': _f(p[3]), 'f3': _f(p[32]), 'f6': _f(p[37]) * 1e4,
            'f12': p[2], 'f14': p[1], 'f124': ts,
        })
    return {'rc': 0, 'data': {'total': len(diff), 'diff': diff, 'src': 'tencent'}}


# 数据源优先级：tencent = 腾讯财经优先（东财不可达网络下的默认）；
# eastmoney = 东财优先（正常网络）。任一侧失败都会自动切另一侧。
PRIMARY_SOURCE = 'eastmoney'


def _em_list(qs):
    # 瞬时抖动重试一次：一次失败就熔断 60 秒会把整批数据打成腾讯源
    try:
        body = fetch_quote_host('/api/qt/clist/get?' + qs, timeout=8, cache_ttl=8)
    except Exception:
        time.sleep(0.2)
        body = fetch_quote_host('/api/qt/clist/get?' + qs, timeout=8, cache_ttl=0)
    obj = json.loads(body.decode('utf-8', 'replace'))
    obj.setdefault('data', {})['src'] = 'eastmoney'
    return obj


def _tx_list(pn, pz):
    rows, total = tencent_snapshot()
    start = (pn - 1) * pz
    return {'rc': 0, 'data': {
        'total': total, 'diff': rows[start:start + pz], 'src': 'tencent',
    }}


def _em_index(qs):
    body = fetch_quote_host('/api/qt/ulist.np/get?' + qs, timeout=6, cache_ttl=8)
    obj = json.loads(body.decode('utf-8', 'replace'))
    obj.setdefault('data', {})['src'] = 'eastmoney'
    return obj


def market_list_payload(qs):
    """统一入口：按 PRIMARY_SOURCE 决定先后，失败自动切换另一侧。

    选股引擎会显式传 src=em / src=tx：整批数据必须来自同一侧，
    否则东财行（有 ROE/PB/上市日期）和腾讯行（没有）混在一起，
    中长线档的财务门槛会误杀全部标的。
    """
    params = urllib.parse.parse_qs(qs)
    pn = max(1, int(_f((params.get('pn') or ['1'])[0], 1)))
    pz = max(1, min(200, int(_f((params.get('pz') or ['100'])[0], 100))))
    want = (params.get('src') or [''])[0].lower()
    if want == 'tx':
        return _tx_list(pn, pz)
    if want == 'em':
        return _em_list(qs)      # 显式指定时绕过 60 秒熔断，失败直接报错由前端整批换源

    if PRIMARY_SOURCE == 'tencent':
        try:
            return _tx_list(pn, pz)
        except Exception:
            pass
        return _em_list(qs)

    if time.time() >= _em_block_until['ts']:
        try:
            return _em_list(qs)
        except Exception:
            _em_block_until['ts'] = time.time() + 60
    return _tx_list(pn, pz)


def market_index_payload(qs):
    if PRIMARY_SOURCE == 'tencent':
        try:
            return _tencent_index_payload()
        except Exception:
            pass
        return _em_index(qs)

    if time.time() >= _em_block_until['ts']:
        try:
            return _em_index(qs)
        except Exception:
            _em_block_until['ts'] = time.time() + 60
    return _tencent_index_payload()


# ============================================================
# 涨停地图 · 全市场实时聚合接口
# 一次请求返回涨跌家数 / 涨停跌停名单 / 涨跌幅分布 / 行业资金 / 指数。
# 所有数字由实时行情快照现算，前端不再内置任何写死常量。
# 口径说明：快照无逐笔盘口，故「封单额」不可得，改用主力净流入（f62）
# 衡量资金强度；连板数同理无历史 K 线，不做编造，按涨幅分层展示。
# ============================================================
_LIMITUP_TTL = 20  # 秒；与行情源缓存错开，保证刷新有感知
_limitup_cache = {'at': 0, 'payload': None}


def _limit_board(code, name):
    """按板块返回涨停幅度阈值（%）。ST 5%，科创/创业 20%，北交 30%，其余 10%。"""
    name = name or ''
    if 'ST' in name.upper():
        return 5.0
    c = str(code)
    if c[:2] in ('68', '30'):
        return 20.0
    if c[:1] in ('8', '4', '9'):
        return 30.0
    return 10.0


def limitup_snapshot_payload():
    now = time.time()
    if _limitup_cache['payload'] and now - _limitup_cache['at'] < _LIMITUP_TTL:
        out = dict(_limitup_cache['payload'])
        out['cached'] = True
        return out

    rows, total = tencent_snapshot()

    up = down = flat = 0
    lu, ld = [], []
    dist = {'limitUp': 0, 'gt7': 0, '5to7': 0, '2to5': 0, '0to2': 0,
            'flat': 0, '0to2dn': 0, '2to5dn': 0, '5to7dn': 0, 'lt7dn': 0, 'limitDown': 0}
    amount = 0.0

    for r in rows:
        pct = r.get('f3')
        if not isinstance(pct, (int, float)):
            continue
        amount += _f(r.get('f6'))
        if pct > 0.005:
            up += 1
        elif pct < -0.005:
            down += 1
        else:
            flat += 1

        thr = _limit_board(r.get('f12'), r.get('f14'))
        is_lu = pct >= thr - 0.15
        is_ld = pct <= -thr + 0.15
        if is_lu:
            dist['limitUp'] += 1
        elif is_ld:
            dist['limitDown'] += 1
        elif pct > 7:
            dist['gt7'] += 1
        elif pct > 5:
            dist['5to7'] += 1
        elif pct > 2:
            dist['2to5'] += 1
        elif pct > 0:
            dist['0to2'] += 1
        elif pct == 0:
            dist['flat'] += 1
        elif pct > -2:
            dist['0to2dn'] += 1
        elif pct > -5:
            dist['2to5dn'] += 1
        elif pct > -7:
            dist['5to7dn'] += 1
        else:
            dist['lt7dn'] += 1

        item = {
            'code': r.get('f12'), 'name': r.get('f14'),
            'price': _f(r.get('f2')), 'pct': pct,
            'turnover': _f(r.get('f8')), 'fcap': _f(r.get('f21')) / 1e8,
            'amount': _f(r.get('f6')) / 1e8, 'inflow': _f(r.get('f62')) / 1e8,
            'ind': r.get('f100') or '其他', 'board': thr,
        }
        if is_lu:
            lu.append(item)
        if is_ld:
            ld.append(item)

    lu.sort(key=lambda x: (-x['pct'], -x['inflow']))
    ld.sort(key=lambda x: (x['pct'], x['inflow']))

    # 行业（板块）资金：按 f100 聚合涨停数与主力净流入
    ind_map = {}
    for r in rows:
        key = r.get('f100') or '其他'
        a = ind_map.setdefault(key, {'name': key, 'n': 0, 'lu': 0, 'inflow': 0.0, 'pctSum': 0.0, 'cnt': 0})
        a['n'] += 1
        a['inflow'] += _f(r.get('f62')) / 1e8
        if isinstance(r.get('f3'), (int, float)):
            a['pctSum'] += r['f3']
            a['cnt'] += 1
    for d in lu:
        if d['ind'] in ind_map:
            ind_map[d['ind']]['lu'] += 1
    sectors = [dict(v, pct=(v['pctSum'] / v['cnt'] if v['cnt'] else 0))
               for v in ind_map.values() if v['n'] >= 3]
    sectors.sort(key=lambda x: -x['inflow'])

    # 资金净流入 TOP（替代不可得的封单额）
    inflow_top = sorted(
        [{'code': r.get('f12'), 'name': r.get('f14'), 'pct': _f(r.get('f3')),
          'inflow': _f(r.get('f62')) / 1e8, 'fcap': _f(r.get('f21')) / 1e8,
          'ind': r.get('f100') or '其他'}
         for r in rows if isinstance(r.get('f3'), (int, float)) and r['f3'] > 0],
        key=lambda x: -x['inflow'])[:12]

    payload = {
        'ok': True, 'at': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(now)),
        'ts': int(now), 'src': 'tencent', 'cached': False,
        'total': total, 'covered': len(rows),
        'up': up, 'down': down, 'flat': flat,
        'limitUp': len(lu), 'limitDown': len(ld),
        'upRatio': round(up / max(1, up + down + flat) * 100, 1),
        'amount': amount / 1e8, 'dist': dist,
        'list': lu, 'downList': ld[:12],
        'sectors': sectors[:12], 'inflowTop': inflow_top,
    }
    _limitup_cache.update({'at': now, 'payload': payload})
    return payload


# ---------------- 股票搜索建议（名称 / 拼音 / 代码） ----------------
# 浏览器直连 searchapi.eastmoney.com 会被跨域拦，且各家网关对该域名不一定放行，
# 这里由后端代取。股票名称基本不变，缓存 1 小时足够。
_SUGGEST_HOST = 'searchapi.eastmoney.com'
_SUGGEST_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8'
_SUGGEST_TTL = 3600
_suggest_cache = {}


def _suggest_host_get(path, timeout=6):
    conn = http.client.HTTPSConnection(_SUGGEST_HOST, 443, timeout=timeout)
    try:
        conn.request('GET', path, headers={
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/145.0 Safari/537.36',
            'Referer': 'https://quote.eastmoney.com/',
            'Accept': '*/*',
        })
        resp = conn.getresponse()
        raw = resp.read()
        if resp.status != 200:
            raise ValueError('搜索接口返回 HTTP %d' % resp.status)
        return raw
    finally:
        conn.close()


def _is_a_share(code):
    """只保留沪深主板 / 创业板 / 科创板，与 stock.js 的 secidOf 口径一致。

    搜索结果里会混进基金、债券、港股、美股、指数，这些前端接不住，
    与其让它搜出来点了报错，不如在源头滤掉。"""
    if not (isinstance(code, str) and len(code) == 6 and code.isdigit()):
        return False
    if code.startswith('900'):   # 沪 B
        return False
    return code[0] in ('0', '3', '6')


def _mkt_label(code):
    if code.startswith('688'):
        return '科创板'
    if code.startswith('6'):
        return '沪市'
    if code[:3] in ('300', '301'):
        return '创业板'
    return '深市'


# ---------------- 个股分析数据代理 ----------------
# stock.js 原来在浏览器里直接 jsonp 东财，一旦本机到东财的直连被 VPN / fake-ip
# 干扰就整页报「数据接口不可达」。改为统一走本机代理：server 侧复用 DoH 解析 +
# SNI 固定域名的兜底通道，浏览器只需要能到 127.0.0.1:8899。
_EM_PROXY_HOSTS = (
    'push2.eastmoney.com',        # 实时行情 / 板块
    'push2his.eastmoney.com',     # 历史 K 线 / 资金流
    'datacenter-web.eastmoney.com',  # 财报 / 估值历史
)


def _upstream_get(url, timeout=12):
    """按 URL 抓东财上游，直连失败退 DoH 固定 IP，返回去掉 JSONP 包裹的纯 JSON。"""
    u = urllib.parse.urlsplit(url)
    host = (u.hostname or '').lower()
    if host not in _EM_PROXY_HOSTS:
        raise ValueError('上游主机不在白名单：%s' % host)
    path = u.path + ('?' + u.query if u.query else '')
    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/145.0 Safari/537.36',
        'Referer': 'https://quote.eastmoney.com/',
        'Accept': '*/*',
    }
    raw = None
    err = None
    try:
        conn = http.client.HTTPSConnection(host, 443, timeout=timeout)
        try:
            conn.request('GET', path, headers=headers)
            resp = conn.getresponse()
            raw = resp.read()
            if resp.status != 200:
                raise ValueError('%s 返回 HTTP %d' % (host, resp.status))
        finally:
            conn.close()
    except Exception as e:  # noqa: BLE001  直连挂了才走 DoH，别把这类网络异常吞掉不报
        err = e
    if raw is None:
        ip = resolve_real(host)
        conn = _PinnedHTTPSConnection(host, ip, timeout=timeout)
        try:
            conn.request('GET', path, headers=dict(headers, Host=host))
            resp = conn.getresponse()
            raw = resp.read()
            if resp.status != 200:
                raise ValueError('%s(DoH) 返回 HTTP %d' % (host, resp.status))
        finally:
            conn.close()
    text = raw.decode('utf-8', 'replace').strip()
    if text.startswith('{') or text.startswith('['):
        return text.encode('utf-8')
    if '(' in text and text.endswith(');'):
        return text[text.index('(') + 1:-2].encode('utf-8')
    raise ValueError('上游返回非 JSON（%s：%s）' % (host, err or '未知'))


def _tencent_symbol(code):
    return ('sh' if code[0] == '6' else 'sz') + code


def _tencent_quote_em(secid):
    """腾讯实时报价 → 东财 /api/qt/stock/get 的 data 结构。

    只在 push2 的 stock/get 被网络拦截时兜底。字段缩放口径与东财一致
    （价格 ×100、百分比 ×100），前端解析逻辑一行不用改。
    缺行业/概念/ROE 等 F10 字段：ROE 等前端本来就会优先用财报数据，行业标签置空。"""
    if not secid or '.' not in secid:
        raise ValueError('secid 格式错误')
    mkt, code = secid.split('.', 1)
    if mkt not in ('0', '1') or not (len(code) == 6 and code.isdigit()):
        raise ValueError('secid 超出 A 股范围：%s' % secid)
    req = urllib.request.Request(
        TENCENT_QUOTE % _tencent_symbol(code),
        headers={'Referer': 'https://gu.qq.com/', 'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=8) as r:
        text = r.read().decode('gbk', 'replace')
    body = ''
    for line in text.split(';'):
        line = line.strip()
        if line.startswith('v_' + _tencent_symbol(code)) and '="' in line:
            body = line.split('="', 1)[1].rstrip('"')
            break
    p = body.split('~')
    if len(p) < 50 or not p[3]:
        raise ValueError('腾讯报价返回不完整')

    def x100(v, k=1):
        # k 用于单位换算（万→元、亿→元），无数据统一回 '-'，与东财口径一致
        try:
            return int(round(float(v) * 100 * k))
        except (TypeError, ValueError):
            return '-'

    price = x100(p[3])
    if price == '-' or price <= 0:
        raise ValueError('该代码当前无有效报价（可能停牌或已退市）')
    ts = None
    stamp = p[30] if len(p) > 30 else ''
    if len(stamp) >= 14 and stamp[:8].isdigit():
        import datetime as _dt
        d = _dt.datetime.strptime(stamp[:14], '%Y%m%d%H%M%S')
        ts = int(d.replace(tzinfo=_dt.timezone(_dt.timedelta(hours=8))).timestamp())
    d = {
        'f57': code, 'f58': p[1], 'f59': 2,
        'f43': price, 'f60': x100(p[4]),
        'f46': x100(p[5]), 'f44': x100(p[33] if len(p) > 33 else ''),
        'f45': x100(p[34] if len(p) > 34 else ''),
        'f47': x100(p[36] if len(p) > 36 else ''),        # 手
        'f48': x100(p[37] if len(p) > 37 else '', 100),   # 万 → 元
        'f50': x100(p[49] if len(p) > 49 else ''),        # 量比
        'f86': ts,
        'f116': x100(p[45] if len(p) > 45 else '', 1000000),  # 亿 → 元
        'f117': x100(p[44] if len(p) > 44 else '', 1000000),
        'f162': x100(p[39] if len(p) > 39 else ''),  # PE(TTM)
        'f167': x100(p[46] if len(p) > 46 else ''),  # PB
        'f168': x100(p[38] if len(p) > 38 else ''),  # 换手 %
        'f170': x100(p[32] if len(p) > 32 else ''),  # 涨跌 %
        'f171': x100(p[43] if len(p) > 43 else ''),  # 振幅 %
    }
    # 东财对「无数据」的字段返回 '-'，前端 num() 会归一成 null
    return {'rc': 0, 'data': dict(d, src='tencent')}


def _tencent_ulist_em(secids_param, fltt=2):
    """腾讯批量报价 → 东财 /api/qt/ulist.np/get 的 diff 结构。

    覆盖 push2 的 ulist.np/get 与 stock/get 同样被网络拦截的场景。
    一次请求带全部代码，指数与个股都在同一只返回里。

    关键：单位必须跟请求的 fltt 一致，否则前端会把价格错当 100 倍：
      · fltt=2（picker / 虚拟持仓报价）：东财返回「元」float，直接用腾讯的 p[3]（元）
      · 不带 fltt（live.js 指数行情）：东财返回「分」整数，腾讯 p[3] 要 ×100
    之前这里无条件 ×100，导致 fltt=2 的现价被放大 100 倍，
    虚拟持仓全部误触止盈（4.00 元 → 400 → +9900%）。"""
    secids = [s for s in re.split(r'[,\s]+', secids_param or '') if s]
    syms, ok_secids = [], []
    for s in secids:
        m = re.match(r'^([01])\.(\d{6})$', s)
        if not m:
            continue
        mkt, code = m.group(1), m.group(2)
        syms.append(('sh' if mkt == '1' else 'sz') + code)
        ok_secids.append(s)
    if not syms:
        raise ValueError('secids 无法解析')
    req = urllib.request.Request(
        TENCENT_QUOTE % ','.join(syms),
        headers={'Referer': 'https://gu.qq.com/', 'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=8) as r:
        text = r.read().decode('gbk', 'replace')

    def conv(v):
        """fltt=2 → 元（float，保留 2 位）；否则 → 分（int）。"""
        try:
            f = float(v)
        except (TypeError, ValueError):
            return '-'
        return round(f, 2) if fltt == 2 else int(round(f * 100))

    rows = []
    for line in text.split(';'):
        line = line.strip()
        if not line.startswith('v_') or '="' not in line:
            continue
        p = line.split('="', 1)[1].rstrip('"').split('~')
        if len(p) < 32 or not p[3]:
            continue
        sym = line[2:line.index('=')].lstrip('v_')
        code = sym[2:]
        ts = None
        stamp = p[30] if len(p) > 30 else ''
        if len(stamp) >= 14 and stamp[:8].isdigit():
            import datetime as _dt
            d = _dt.datetime.strptime(stamp[:14], '%Y%m%d%H%M%S')
            ts = int(d.replace(tzinfo=_dt.timezone(_dt.timedelta(hours=8))).timestamp())
        rows.append({
            'f2': conv(p[3]),            # 现价
            'f3': conv(p[32]),           # 涨跌%
            'f12': code,
            'f14': p[1],
            'f18': conv(p[4]),           # 昨收
            'f124': ts,
            'src': 'tencent',
        })
    if not rows:
        raise ValueError('腾讯批量报价返回为空')
    return {'rc': 0, 'data': {'total': len(rows), 'diff': rows}}


def _tencent_kline(secid, lmt=240, fqt=1):
    """腾讯 K 线 → 东财 /api/qt/stock/kline/get 的 klines 结构。

    返回字段顺序与东财 fields2=f51..f57 一致：日期,开,收,高,低,成交量,...
    fqt=1（前复权）对应腾讯 qfqday；fqt=0 用 day。"""
    m = re.match(r'^([01])\.(\d{6})$', secid or '')
    if not m:
        raise ValueError('secid 无法解析')
    sym = ('sh' if m.group(1) == '1' else 'sz') + m.group(2)
    key = 'qfqday' if int(fqt or 0) == 1 else 'day'
    url = ('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=%s,day,,,%d,%s'
           % (sym, max(1, min(1000, int(lmt or 240))), 'qfq' if key == 'qfqday' else ''))
    req = urllib.request.Request(url, headers={
        'Referer': 'https://gu.qq.com/', 'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=10) as r:
        j = json.loads(r.read().decode('utf-8', 'replace'))
    node = (j.get('data') or {}).get(sym) or {}
    days = node.get(key) or node.get('day') or []
    klines = []
    for row in days:
        if len(row) < 6:
            continue
        # 东财 klines: 日期,开,收,高,低,成交量,成交额,振幅,涨跌幅,涨跌额,换手率
        klines.append(','.join([str(row[0]), str(row[1]), str(row[2]), str(row[3]),
                                str(row[4]), str(row[5]), '', '', '', '', '']))
    if not klines:
        raise ValueError('腾讯 K 线返回为空')
    return {'rc': 0, 'data': {'code': m.group(2), 'klines': klines, 'src': 'tencent'}}


def stock_proxy_payload(qs):
    params = urllib.parse.parse_qs(qs or '')
    url = (params.get('u') or [''])[0]
    if not url.startswith('https://'):
        return {'ok': False, 'error': '缺少或非法的 u 参数'}, 400
    # 同一 URL 短缓存：切回页面重绘、连续分析时省掉重复上游请求
    hit = _http_cache.get(url)
    if hit and hit[1] > time.time():
        return hit[0], 200
    try:
        body = _upstream_get(url)
    except Exception as e:  # noqa: BLE001
        # 实时报价在部分网络下被拦（直连 + DoH 都不通），切腾讯兜底并翻译成东财字段
        if 'secid=' in url and '/api/qt/stock/get' in url:
            m = re.search(r'secid=([0-9]+\.[0-9]{6})', url)
            if m:
                try:
                    body = json.dumps(_tencent_quote_em(m.group(1)), ensure_ascii=False).encode('utf-8')
                except Exception as e2:  # noqa: BLE001
                    return {'ok': False, 'error': '数据接口不可达（东财与备用源均失败：%s / %s）' % (e, e2)}, 502
            else:
                return {'ok': False, 'error': '数据接口不可达：%s' % e}, 502
        elif '/api/qt/ulist.np/get' in url and 'secids=' in url:
            m = re.search(r'secids=([^&]+)', url)
            mf = re.search(r'[?&]fltt=(\d+)', url)
            fltt = int(mf.group(1)) if mf else 1   # 东财缺省 fltt=1（分）
            try:
                body = json.dumps(_tencent_ulist_em(
                    urllib.parse.unquote(m.group(1)) if m else '', fltt=fltt
                ), ensure_ascii=False).encode('utf-8')
            except Exception as e2:  # noqa: BLE001
                return {'ok': False, 'error': '行情接口不可达（东财与备用源均失败：%s / %s）' % (e, e2)}, 502
        elif '/api/qt/clist/get' in url:
            # 全市场列表兜底：腾讯快照本来就是 clist 的 diff 结构，按 pn/pz 切片即可
            m_pn = re.search(r'[?&]pn=(\d+)', url)
            m_pz = re.search(r'[?&]pz=(\d+)', url)
            try:
                pn = max(1, int(m_pn.group(1))) if m_pn else 1
                pz = max(1, min(200, int(m_pz.group(1)))) if m_pz else 100
                body = json.dumps(_tx_list(pn, pz), ensure_ascii=False).encode('utf-8')
            except Exception as e2:  # noqa: BLE001
                return {'ok': False, 'error': '行情接口不可达（东财与备用源均失败：%s / %s）' % (e, e2)}, 502
        elif '/api/qt/stock/kline/get' in url:
            # K 线兜底：虚拟持仓抽屉的图表依赖它，东财 push2his 常被网络拦截
            m_sid = re.search(r'secid=([0-9]+\.[0-9]{6})', url)
            m_lmt = re.search(r'[?&]lmt=(\d+)', url)
            m_fqt = re.search(r'[?&]fqt=(\d+)', url)
            try:
                body = json.dumps(_tencent_kline(
                    m_sid.group(1) if m_sid else '',
                    lmt=int(m_lmt.group(1)) if m_lmt else 240,
                    fqt=int(m_fqt.group(1)) if m_fqt else 1,
                ), ensure_ascii=False).encode('utf-8')
            except Exception as e2:  # noqa: BLE001
                return {'ok': False, 'error': 'K 线接口不可达（东财与备用源均失败：%s / %s）' % (e, e2)}, 502
        else:
            return {'ok': False, 'error': '数据接口不可达：%s' % e}, 502
    if len(_http_cache) > 300:
        _http_cache.clear()
    _http_cache[url] = (body, time.time() + 30)
    return body, 200


def stock_suggest_payload(qs):
    params = urllib.parse.parse_qs(qs or '')
    kw = (params.get('q') or params.get('input') or [''])[0].strip()
    try:
        limit = max(1, min(12, int((params.get('limit') or ['8'])[0])))
    except (TypeError, ValueError):
        limit = 8
    if not kw:
        return {'ok': True, 'q': '', 'list': []}

    key = kw.lower()
    hit = _suggest_cache.get(key)
    if hit and time.time() - hit['at'] < _SUGGEST_TTL:
        return {'ok': True, 'q': kw, 'cached': True, 'list': hit['list'][:limit]}

    path = ('/api/suggest/get?input=%s&type=14&token=%s&count=30'
            % (urllib.parse.quote(kw), _SUGGEST_TOKEN))
    try:
        raw = _suggest_host_get(path)
        data = json.loads(raw.decode('utf-8', 'ignore') or '{}')
    except Exception as e:  # noqa: BLE001
        # 搜索挂掉不该挡住「直接输代码」这条主路径，返回空列表让前端口径降级
        return {'ok': False, 'q': kw, 'list': [], 'error': '搜索服务暂不可用：%s' % e}

    rows = ((data.get('QuotationCodeTable') or {}).get('Data')) or []
    out, seen = [], set()
    for r in rows:
        code = str(r.get('Code') or '').strip()
        name = str(r.get('Name') or '').strip()
        if not name or not _is_a_share(code) or code in seen:
            continue
        seen.add(code)
        out.append({
            'code': code,
            'name': name,
            'pinyin': str(r.get('PinYin') or '').upper(),
            'mkt': _mkt_label(code),
        })

    _suggest_cache[key] = {'at': time.time(), 'list': out}
    if len(_suggest_cache) > 800:   # 粗暴但够用的容量控制
        _suggest_cache.clear()
    return {'ok': True, 'q': kw, 'list': out[:limit]}


def main():
    port = DEFAULT_PORT
    if '--port' in sys.argv:
        port = int(sys.argv[sys.argv.index('--port') + 1])
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
    print('A股股债利差系统 · 服务已启动')
    print('  地址：http://%s:%d/' % (host, port))
    print('  AI 状态：%s' % ('已配置 ' + status_payload()['provider_label'] if status_payload()['configured'] else '未配置（页面内粘贴 Key 即可）'))
    print('  配置文件：%s' % CONF)
    print('  数据库：%s（模拟持仓 + 每日建议）' % DB)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')


if __name__ == '__main__':
    main()
