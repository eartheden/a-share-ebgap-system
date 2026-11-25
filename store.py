"""数据层：数据库连接、建表迁移、虚拟持仓与每日建议的读写。

从 server.py 拆出（Phase 3），保持函数签名与行为完全不变。
依赖：标准库 sqlite3/time、同目录 auth 模块、由 core 注入的 DB 路径。
"""
import os
import sqlite3
import time

import auth

def _is_pos_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0


ROOT = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(ROOT, 'ebgap.db')

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
    conn.execute('PRAGMA foreign_keys = ON')
    conn.execute('PRAGMA busy_timeout = 5000')
    return conn


def _migrate_daily_advice_pk(c):
    """把改造前 date 单列主键的 daily_advice 迁移成 PRIMARY KEY (user_id, date)，
    确保多会员同一天写入各自建议时不会冲突。幂等，保留全部历史数据。"""
    cols = c.execute('PRAGMA table_info(daily_advice)').fetchall()
    pk_cols = [r['name'] for r in sorted(cols, key=lambda r: r['pk']) if r['pk'] > 0]
    if pk_cols == ['user_id', 'date']:
        return
    c.execute('''
        CREATE TABLE daily_advice_new (
            date TEXT NOT NULL,
            user_id INTEGER NOT NULL DEFAULT 0,
            regime TEXT,
            regime_label TEXT,
            temp REAL,
            pos_text TEXT,
            note TEXT,
            picks TEXT,
            updated_at TEXT DEFAULT (datetime('now', 'localtime')),
            PRIMARY KEY (user_id, date)
        )''')
    c.execute('''
        INSERT OR REPLACE INTO daily_advice_new
            (date, user_id, regime, regime_label, temp, pos_text, note, picks, updated_at)
        SELECT date, COALESCE(user_id, 0), regime, regime_label, temp, pos_text, note, picks, updated_at
        FROM daily_advice
    ''')
    c.execute('DROP TABLE daily_advice')
    c.execute('ALTER TABLE daily_advice_new RENAME TO daily_advice')
    c.execute('CREATE INDEX IF NOT EXISTS idx_daily_advice_user ON daily_advice(user_id)')


def db_init():
    with db_conn() as c:
        c.execute('PRAGMA journal_mode = WAL')
        # 先建业务表，再由 auth.init_schema(c) 建认证表并给老库补 user_id 列，
        # 防止全新空库首次启动时 ALTER TABLE paper_trades 报错崩溃。
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
                user_id INTEGER NOT NULL DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                updated_at TEXT DEFAULT (datetime('now', 'localtime'))
            )''')
        # 老库补列：hz（档位 S/M/L）与 note（交易备注）是三档改造后新增的，
        # 直接 ALTER 比让用户删库重来稳妥。
        _ensure_cols(c, 'paper_trades', [('hz', 'TEXT'), ('note', 'TEXT'), ('user_id', 'INTEGER NOT NULL DEFAULT 0')])
        c.execute('CREATE INDEX IF NOT EXISTS idx_paper_status ON paper_trades(status)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_paper_trades_user ON paper_trades(user_id)')
        # 龙头战法：市场情绪快照（全局）+ 每日候选（按用户隔离，虚拟交易是个人行为）
        c.execute('''
            CREATE TABLE IF NOT EXISTS zt_daily (
                date TEXT PRIMARY KEY,
                limit_up INTEGER DEFAULT 0,
                limit_down INTEGER DEFAULT 0,
                up_ratio REAL DEFAULT 0,
                amount REAL DEFAULT 0,
                max_board INTEGER DEFAULT 0,
                board_ladder TEXT,
                sector_top TEXT,
                emotion TEXT,
                lu_codes TEXT,
                created_at TEXT DEFAULT (datetime('now','localtime'))
            )''')
        _ensure_cols(c, 'zt_daily', [('lu_codes', 'TEXT')])
        c.execute('''
            CREATE TABLE IF NOT EXISTS zt_picks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                user_id INTEGER NOT NULL,
                code TEXT NOT NULL,
                name TEXT,
                ind TEXT,
                price REAL,
                pct REAL,
                turnover REAL,
                fcap REAL,
                amount REAL,
                inflow REAL,
                score REAL,
                board_num INTEGER DEFAULT 1,
                board_known INTEGER DEFAULT 0,
                flag TEXT DEFAULT 'pick',
                reason TEXT,
                created_at TEXT DEFAULT (datetime('now','localtime')),
                UNIQUE(date, user_id, code)
            )''')
        c.execute('CREATE INDEX IF NOT EXISTS idx_ztpicks_user_date ON zt_picks(user_id, date)')
        c.execute('''
            CREATE TABLE IF NOT EXISTS daily_advice (
                date TEXT NOT NULL,
                user_id INTEGER NOT NULL DEFAULT 0,
                regime TEXT,
                regime_label TEXT,
                temp REAL,
                pos_text TEXT,
                note TEXT,
                picks TEXT,
                updated_at TEXT DEFAULT (datetime('now', 'localtime')),
                PRIMARY KEY (user_id, date)
            )''')
        # 会员系统：用户 / 会话 / AI 配置表，以及老库补 user_id 列
        auth.init_schema(c)
        _migrate_daily_advice_pk(c)
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
    if not code or not _is_pos_num(price):
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
    if not tid or not _is_pos_num(price):
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
            if not _is_pos_num(price):
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
        if not _is_pos_num(v):
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
        # 周期档：S 短线 / M 中线 / L 长线（三档各自最多 12 只，总计最多 36 条）
        'hz': p.get('hz'),
    } for p in picks[:36]]
    with db_conn() as c:
        c.execute('''
            INSERT INTO daily_advice (date, regime, regime_label, temp, pos_text, note, picks, updated_at, user_id)
            VALUES (?,?,?,?,?,?,?, datetime('now','localtime'), ?)
            ON CONFLICT(user_id, date) DO UPDATE SET
                regime=excluded.regime, regime_label=excluded.regime_label,
                temp=excluded.temp, pos_text=excluded.pos_text,
                note=excluded.note, picks=excluded.picks,
                updated_at=datetime('now','localtime')
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

