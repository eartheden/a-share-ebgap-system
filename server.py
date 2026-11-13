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


def status_payload():
    c = load_conf()
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
    '你是一名严谨的 A 股短线交易研究员，服务于一个量化选股系统。'
    '你的职责不是从全市场挑股票，而是对系统已经用当日量价资金数据筛出的候选名单做复核与排序。'
    '硬性规则：'
    '1) 只能评价名单中出现的股票，绝不新增名单外的标的；'
    '2) 只能使用用户给你的数据做判断，不得编造财务报表、公告、新闻、题材或机构观点；'
    '3) 你的知识可能过期，若没有把握，判定为「可观察」并说明原因，不要为了给出结论而编造理由；'
    '4) 不做收益承诺、不给目标价预测，只给交易纪律层面的判断；'
    '5) 所有文字使用简体中文，简洁、具体、可执行。'
    '输出要求：只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释性前后缀。'
)


def build_user_prompt(payload):
    mkt = payload.get('mkt') or {}
    picks = payload.get('picks') or []
    lines = []
    lines.append('【当日市场】')
    lines.append('交易日 %s；行情判定：%s；市场温度 %s/100（涨 %s 家、跌 %s 家、涨停 %s 家、跌停 %s 家，两市成交 %.2f 亿）。'
                 % (payload.get('quoteDate', '—'), mkt.get('regime_label', '—'), mkt.get('temp', '—'),
                    mkt.get('up', '—'), mkt.get('down', '—'), mkt.get('zt', '—'), mkt.get('dt', '—'),
                    (mkt.get('amt') or 0) / 1e8))
    if mkt.get('idx'):
        lines.append('指数：' + '；'.join('%s %s (%+.2f%%)' % (i.get('name'), i.get('price'), i.get('pct'))
                                       for i in mkt['idx']))
    lines.append('')
    lines.append('【候选名单】以下 %d 只已通过硬性过滤（非 ST、上市满 60 日、成交额≥1.5 亿、未封涨停等），'
                 '六维分数由当日数据算出：D1 资金动能、D2 量价强度、D3 位置空间、D4 行业动能、D5 流动性、D6 质量安全。' % len(picks))
    for i, p in enumerate(picks, 1):
        lines.append(
            '%d. %s %s | 行业 %s | 现价 %.2f (%+.2f%%) | 综合 %.1f | D1-D6: %s,%s,%s,%s,%s,%s | '
            '主力净额 %.2f 亿（占成交额 %.1f%%）| 换手 %.1f%% | 量比 %.2f | 成交额 %.2f 亿 | 市值 %.0f 亿 | '
            '近60日 %+.1f%% | 年内 %+.1f%% | PE %s | ROE %s | 净利同比 %+.1f%%'
            % (i, p.get('code'), p.get('name'), p.get('ind'), p.get('price', 0), p.get('pct', 0),
               p.get('total', 0), p.get('d1'), p.get('d2'), p.get('d3'), p.get('d4'), p.get('d5'), p.get('d6'),
               (p.get('net') or 0) / 1e8, p.get('netRatio') or 0, p.get('turn') or 0, p.get('volRatio') or 0,
               (p.get('amt') or 0) / 1e8, (p.get('cap') or 0) / 1e8, p.get('d60') or 0, p.get('ytd') or 0,
               ('%.1f' % p['pe']) if (p.get('pe') or 0) > 0 else '亏损',
               ('%.1f%%' % p['roe']) if p.get('roe') else '—', p.get('npYoY') or 0))
    lines.append('')
    lines.append('【你的任务】')
    lines.append('1) 用一句话概括今天这批候选的共同特征与主要风险；')
    lines.append('2) 对名单里每一只给出判定：重点关注 / 可观察 / 建议剔除，并给出不超过 45 字的具体理由（必须引用上面给的数据，不要编造）；')
    lines.append('3) 给出最多 3 只你认为今天最值得优先关注的，说明排序逻辑（为什么它排在前面）；')
    lines.append('4) 指出你认为应该从名单中剔除的标的及原因；')
    lines.append('5) 给一句今天的执行纪律提醒（例如仓位、买入时机、什么情况放弃）。')
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
        """只接受本站页面发起的调用。

        服务绑在 127.0.0.1，但浏览器里任何一个网页都能向 localhost 发请求。
        没有这道闸，别人站点上的脚本就能悄悄改配置、或者用你的 Key 反复调模型烧钱。
        """
        origin = (self.headers.get('Origin') or '').strip()
        if not origin:
            return True    # curl 等本机命令行工具不带 Origin
        host = (self.headers.get('Host') or '').strip()
        return origin in ('http://%s' % host, 'https://%s' % host) or origin in (
            'http://127.0.0.1:%d' % self.server.server_port,
            'http://localhost:%d' % self.server.server_port,
        )

    def _bytes(self, body, code=200):
        self._cache_set = True
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith('/api/ai/status'):
            return self._json(status_payload())
        if self.path.startswith('/api/market/'):
            qs = urllib.parse.urlparse(self.path).query
            try:
                if self.path.startswith('/api/market/list'):
                    return self._json(market_list_payload(qs))
                if self.path.startswith('/api/market/index'):
                    return self._json(market_index_payload(qs))
                return self._json({'ok': False, 'error': 'unknown market endpoint'}, 404)
            except Exception as e:  # noqa: BLE001
                return self._json({'ok': False, 'error': '行情获取失败：%s' % e}, 502)
        if self.path.startswith('/api/paper/list'):
            return self._json({'ok': True, 'trades': paper_list()})
        if self.path.startswith('/api/advice/daily') or self.path.startswith('/api/advice/list'):
            qs = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(qs)
            date = (params.get('date') or [None])[0]
            limit = int((params.get('limit') or ['20'])[0])
            return self._json({'ok': True, 'advice': advice_get(date=date, limit=limit)})
        # 不把服务端源码本身当静态文件发出去
        p = self.path.split('?')[0]
        if p.endswith('.py') or '/.' in p or p.endswith('.db'):
            return self._json({'ok': False, 'error': 'not found'}, 404)
        return super().do_GET()

    def do_POST(self):
        if not self._origin_ok():
            return self._json({'ok': False, 'error': '拒绝跨站调用'}, 403)
        try:
            if self.path.startswith('/api/ai/config'):
                data = self._read_json()
                conf = load_conf()
                provider = (data.get('provider') or conf.get('provider') or 'deepseek').strip()
                preset = PROVIDERS.get(provider, {})
                if data.get('clear_key'):
                    conf.pop('api_key', None)
                elif data.get('api_key'):
                    # 留空表示「不改动已保存的 Key」，不做清空（清空请传 clear_key）
                    conf['api_key'] = str(data['api_key']).strip()
                conf['provider'] = provider
                conf['base_url'] = (data.get('base_url') or preset.get('base_url') or '').strip()
                conf['model'] = (data.get('model') or preset.get('model') or '').strip()
                save_conf(conf)
                return self._json({'ok': True, 'status': status_payload()})

            if self.path.startswith('/api/ai/review'):
                data = self._read_json()
                conf = load_conf()
                out = call_llm(conf, data)
                return self._json({'ok': True, **out})

            if self.path.startswith('/api/paper/buy'):
                return self._json(paper_buy(self._read_json()))

            if self.path.startswith('/api/paper/close'):
                return self._json(paper_close(self._read_json()))

            if self.path.startswith('/api/paper/tick'):
                return self._json(paper_tick(self._read_json()))

            if self.path.startswith('/api/paper/clear'):
                return self._json(paper_clear())

            if self.path.startswith('/api/advice/daily'):
                return self._json(advice_upsert(self._read_json()))

            return self._json({'ok': False, 'error': 'unknown endpoint'}, 404)
        except ValueError as e:
            return self._json({'ok': False, 'error': str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            return self._json({'ok': False, 'error': '服务器内部错误：%s' % e}, 500)

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
    'result_pct', 'pnl', 'created_at', 'updated_at',
]


def db_conn():
    conn = sqlite3.connect(DB, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def db_init():
    with db_conn() as c:
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
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                updated_at TEXT DEFAULT (datetime('now', 'localtime'))
            )''')
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


def rows_to_dicts(rows):
    return [{k: r[k] for k in TRADE_COLS if k in r.keys()} for r in rows]


def paper_list():
    with db_conn() as c:
        rows = c.execute(
            'SELECT * FROM paper_trades ORDER BY status = \'closed\', buy_at DESC').fetchall()
    return rows_to_dicts(rows)


def paper_buy(d):
    """开一笔模拟仓。同一代码已有持仓时拒绝重复开仓，返回已有记录。"""
    code = str(d.get('code') or '').strip()
    price = d.get('buy_price')
    if not code or not isinstance(price, (int, float)) or price <= 0:
        raise ValueError('缺少 code 或 buy_price')
    with db_conn() as c:
        dup = c.execute(
            'SELECT * FROM paper_trades WHERE code = ? AND status = \'open\'', (code,)).fetchone()
        if dup:
            return {'ok': True, 'duplicate': True, 'trade': rows_to_dicts([dup])[0]}
        cur = c.execute('''
            INSERT INTO paper_trades
            (code, name, ind, buy_price, buy_date, buy_at, shares, amt,
             suggest_low, suggest_high, stop, t1, t2, hold, pos_pct, score,
             status, cur_price)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'open', ?)
        ''', (
            code, d.get('name'), d.get('ind'), price, d.get('buy_date'), d.get('buy_at'),
            d.get('shares'), d.get('amt'),
            d.get('suggest_low'), d.get('suggest_high'),
            d.get('stop'), d.get('t1'), d.get('t2'),
            d.get('hold'), d.get('pos_pct'), d.get('score'), price,
        ))
        c.commit()
        row = c.execute('SELECT * FROM paper_trades WHERE id = ?', (cur.lastrowid,)).fetchone()
    return {'ok': True, 'duplicate': False, 'trade': rows_to_dicts([row])[0]}


def _finish(row, price, reason):
    result = (price / row['buy_price'] - 1) * 100 if row['buy_price'] else 0
    pnl = (price - row['buy_price']) * (row['shares'] or 0)
    return result, pnl


def paper_close(d):
    tid = d.get('id')
    price = d.get('price')
    if not tid or not isinstance(price, (int, float)) or price <= 0:
        raise ValueError('缺少 id 或 price')
    with db_conn() as c:
        row = c.execute(
            'SELECT * FROM paper_trades WHERE id = ? AND status = \'open\'', (tid,)).fetchone()
        if not row:
            raise ValueError('该笔持仓不存在或已平仓')
        result, pnl = _finish(row, price, d.get('reason'))
        c.execute('''
            UPDATE paper_trades SET status='closed', close_price=?, close_date=?,
                close_at=?, close_reason=?, result_pct=?, pnl=?, cur_price=?,
                updated_at=datetime('now','localtime')
            WHERE id = ?
        ''', (price, d.get('close_date'), d.get('close_at'), d.get('reason') or '手动平仓',
              result, pnl, price, tid))
        c.commit()
        row = c.execute('SELECT * FROM paper_trades WHERE id = ?', (tid,)).fetchone()
    return {'ok': True, 'trade': rows_to_dicts([row])[0]}


def paper_tick(d):
    """批量报送最新价：更新现价，触止损/止盈自动平仓。返回有变化的记录。"""
    quotes = d.get('quotes') or {}
    if not isinstance(quotes, dict):
        raise ValueError('quotes 必须是 {code: price} 字典')
    changed = []
    with db_conn() as c:
        rows = c.execute('SELECT * FROM paper_trades WHERE status = \'open\'').fetchall()
        for row in rows:
            price = quotes.get(row['code'])
            if not isinstance(price, (int, float)) or price <= 0:
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
                    WHERE id = ?
                ''', (price, d.get('date'), d.get('at'), reason, result, pnl, price, row['id']))
            else:
                c.execute(
                    'UPDATE paper_trades SET cur_price=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?',
                    (price, row['id']))
            changed.append(row['id'])
        c.commit()
    return {'ok': True, 'changed': changed, 'trades': paper_list()}


def paper_clear():
    with db_conn() as c:
        c.execute('DELETE FROM paper_trades')
        c.commit()
    return {'ok': True}


def advice_upsert(d):
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
    } for p in picks[:10]]
    with db_conn() as c:
        c.execute('''
            INSERT INTO daily_advice (date, regime, regime_label, temp, pos_text, note, picks, updated_at)
            VALUES (?,?,?,?,?,?,?, datetime('now','localtime'))
            ON CONFLICT(date) DO UPDATE SET
                regime=excluded.regime, regime_label=excluded.regime_label,
                temp=excluded.temp, pos_text=excluded.pos_text, note=excluded.note,
                picks=excluded.picks, updated_at=datetime('now','localtime')
        ''', (date, d.get('regime'), d.get('regime_label'), d.get('temp'),
              d.get('pos_text'), d.get('note'), json.dumps(slim, ensure_ascii=False)))
        c.commit()
    return {'ok': True}


def advice_get(date=None, limit=20):
    with db_conn() as c:
        if date:
            row = c.execute('SELECT * FROM daily_advice WHERE date = ?', (date,)).fetchone()
            rows = [row] if row else []
        else:
            rows = c.execute(
                'SELECT * FROM daily_advice ORDER BY date DESC LIMIT ?', (limit,)).fetchall()
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
    body = fetch_quote_host('/api/qt/clist/get?' + qs, timeout=6, cache_ttl=8)
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
    """统一入口：按 PRIMARY_SOURCE 决定先后，失败自动切换另一侧。"""
    params = urllib.parse.parse_qs(qs)
    pn = max(1, int(_f((params.get('pn') or ['1'])[0], 1)))
    pz = max(1, min(200, int(_f((params.get('pz') or ['100'])[0], 100))))

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


def main():
    port = DEFAULT_PORT
    if '--port' in sys.argv:
        port = int(sys.argv[sys.argv.index('--port') + 1])
    db_init()
    try:
        srv = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    except OSError as e:
        print('启动失败：端口 %d 已被占用（%s）' % (port, e))
        print('可能服务已经在跑了，先试：http://127.0.0.1:%d/' % port)
        print('换一个端口：python3 server.py --port 8900')
        sys.exit(1)
    print('A股股债利差系统 · 本地服务已启动')
    print('  地址：http://127.0.0.1:%d/' % port)
    print('  AI 状态：%s' % ('已配置 ' + status_payload()['provider_label'] if status_payload()['configured'] else '未配置（页面内粘贴 Key 即可）'))
    print('  配置文件：%s' % CONF)
    print('  数据库：%s（模拟持仓 + 每日建议）' % DB)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')


if __name__ == '__main__':
    main()
