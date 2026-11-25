"""行情数据层：DoH 穿透、东财/腾讯双源、市场列表/指数、涨停快照。

从 server.py 拆出（Phase 3），保持函数签名与行为完全不变。
全局缓存（_dns_cache/_http_cache/_tencent_cache 等）在本模块内共享单例。
"""
import http.client
import json
import os
import socket
import ssl
import threading
import time
import urllib.parse
import urllib.request

from store import db_conn

DOH_URL = 'https://223.5.5.5/resolve'
MARKET_HOST = 'push2.eastmoney.com'
FAKE_NETS = ('198.18.', '198.19.', '0.0.0.0', '127.')
TENCENT_RANK = ('https://proxy.finance.qq.com/cgi/cgi-bin/rank/hs/getBoardRankList'
                '?board_code=aStock&sort_type=PriceRatio&direct=down&offset=%d&count=%d')
TENCENT_QUOTE = 'https://qt.gtimg.cn/q=%s'
INDEX_CODES = 'sh000001,sz399001,sz399006,sh000300'
_cache_lock = threading.Lock()
_tencent_fetch_lock = threading.Lock()
_limitup_fetch_lock = threading.Lock()
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
    with _cache_lock:
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
    with _cache_lock:
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
    with _cache_lock:
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
        with _cache_lock:
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
    with _cache_lock:
        if _tencent_cache.get('rows') and _tencent_cache.get('at', 0) + ttl > now:
            return _tencent_cache['rows'], _tencent_cache['total']
    with _tencent_fetch_lock:
        now = time.time()
        with _cache_lock:
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
        with _cache_lock:
            _tencent_cache.update({'at': time.time(), 'rows': out, 'total': len(out)})
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
    data = obj.get('data')
    if not isinstance(data, dict):
        raise ValueError('东财行情列表返回为空')
    data['src'] = 'eastmoney'
    return obj


def _tx_list(pn, pz):
    rows, total = tencent_snapshot()
    start = (pn - 1) * pz
    return {'rc': 0, 'data': {
        'total': total, 'diff': rows[start:start + pz], 'src': 'tencent',
    }}


_DEFAULT_INDEX_QS = 'fltt=2&secids=1.000001,0.399001,0.399006,1.000300&fields=f2,f3,f6,f12,f14,f124'


def _em_index(qs):
    params = urllib.parse.parse_qs(qs or '')
    if not params.get('secids'):
        qs = _DEFAULT_INDEX_QS + ('&' + qs if qs else '')
    body = fetch_quote_host('/api/qt/ulist.np/get?' + qs, timeout=6, cache_ttl=8)
    obj = json.loads(body.decode('utf-8', 'replace'))
    data = obj.get('data')
    if not isinstance(data, dict) or not data.get('diff'):
        raise ValueError('东财指数返回为空')
    data['src'] = 'eastmoney'
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

    with _cache_lock:
        blocked = time.time() < _em_block_until['ts']
    if not blocked:
        try:
            return _em_list(qs)
        except Exception:
            with _cache_lock:
                _em_block_until['ts'] = time.time() + 60
    return _tx_list(pn, pz)


def market_index_payload(qs):
    if PRIMARY_SOURCE == 'tencent':
        try:
            return _tencent_index_payload()
        except Exception:
            pass
        return _em_index(qs)

    with _cache_lock:
        blocked = time.time() < _em_block_until['ts']
    if not blocked:
        try:
            return _em_index(qs)
        except Exception:
            with _cache_lock:
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
    with _cache_lock:
        if _limitup_cache['payload'] and now - _limitup_cache['at'] < _LIMITUP_TTL:
            out = dict(_limitup_cache['payload'])
            out['cached'] = True
            return out
    with _limitup_fetch_lock:
        now = time.time()
        with _cache_lock:
            if _limitup_cache['payload'] and now - _limitup_cache['at'] < _LIMITUP_TTL:
                out = dict(_limitup_cache['payload'])
                out['cached'] = True
                return out
        return _compute_limitup_snapshot(now)


def _compute_limitup_snapshot(now):
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
    with _cache_lock:
        _limitup_cache.update({'at': now, 'payload': payload})
    return payload


# ============================================================
# 龙头战法 · 情绪数据落库与选股（纯自有数据，不用外部数据源）
# ------------------------------------------------------------
# 数据来自上面的涨停快照；每天收盘后抓一次存进 zt_daily / zt_picks。
# 连板数没有现成字段，用「该股连续出现在涨停名单的天数」推断——
# 这是自有数据能做到的最接近版本，宁可保守也不编造。
# ============================================================

def dragon_emotion_label(lu, ld, max_board, up_ratio):
    """把当日情绪映射成五阶段之一：冰点/启动/发酵/高潮/退潮。
    先识别退潮（大面积跌停或普跌），避免弱市高潮/普跌日被提前判成发酵或冰点。"""
    if ld >= 20 or (ld >= 12 and up_ratio < 35):
        return '退潮'
    if lu >= 80 or max_board >= 6:
        return '高潮'
    if lu < 15 or max_board <= 2:
        return '冰点'
    if lu < 30 and max_board <= 3:
        return '启动'
    return '发酵'


def dragon_score(item, board_num, sector_lu):
    """首板/连板候选打分（0-100）。因子全是快照里真实存在的字段：
    资金净流入、换手率、流通盘（小盘更容易连板）、板块联动。
    封单额拿不到，所以用资金流替代；不做编造。"""
    s = 40.0
    inflow = item.get('inflow') or 0          # 亿元
    turnover = item.get('turnover') or 0      # %
    fcap = item.get('fcap') or 0              # 亿元
    if inflow >= 2: s += 20
    elif inflow >= 1: s += 14
    elif inflow >= 0.5: s += 9
    elif inflow > 0: s += 4
    else: s -= 8                              # 净流出还涨停，封板质量差
    if 3 <= turnover <= 20: s += 12
    elif turnover > 30: s -= 6                # 换手过高，分歧大
    elif turnover < 1: s += 4
    if 20 <= fcap <= 200: s += 10             # 中小盘优先
    elif fcap < 20: s += 5
    elif fcap > 500: s -= 6                   # 大盘股连板难
    s += min(10, board_num * 3)               # 连板高度加分
    s += min(8, sector_lu * 2)                # 板块联动加分
    return round(max(0, min(100, s)), 1)


def dragon_snapshot(user_id):
    """抓一次实时快照 → 算分数 → 落库 → 返回本次结果。
    供前端「生成今日清单」按钮调用；服务端不主动定时，避免非交易时段空跑。"""
    payload = limitup_snapshot_payload()
    if not payload.get('ok'):
        return {'ok': False, 'error': '行情快照获取失败'}
    today = time.strftime('%Y-%m-%d', time.localtime())
    lu = payload.get('list') or []
    sectors = payload.get('sectors') or []

    # 板块涨停数映射
    sec_map = {}
    for d in sectors:
        sec_map[d.get('name')] = d.get('lu') or 0

    # 连板数推断：按「实际记录的交易日快照」序列往前接续（兼容周末与法定长假），
    # 优先读取 zt_daily.lu_codes（全量涨停代码），老记录没有 lu_codes 时回退到当前用户的 zt_picks。
    # 必须排除今天——今天正在生成，避免重复点击把连板数算高。
    from datetime import date as _date
    with db_conn() as c:
        daily_rows = c.execute('''
            SELECT date, lu_codes FROM zt_daily WHERE date < ?
            ORDER BY date DESC LIMIT 15
        ''', (today,)).fetchall()
        user_pick_dates = {}
        for r in c.execute('''
            SELECT DISTINCT code, date FROM zt_picks WHERE user_id=? AND date < ?
            ORDER BY date DESC
        ''', (user_id, today)).fetchall():
            user_pick_dates.setdefault(r['code'], set()).add(r['date'])

    # 把历史快照日整理成 (date_str, lu_code_set_or_None) 倒序序列
    snap_days = []
    for r in daily_rows:
        codes = None
        if r['lu_codes']:
            try:
                codes = set(json.loads(r['lu_codes']))
            except Exception:
                codes = None
        snap_days.append((r['date'], codes))
    history_days = len(snap_days)

    def _gap_days(d1, d2):
        try:
            return abs((_date.fromisoformat(d1) - _date.fromisoformat(d2)).days)
        except Exception:
            return 999

    def board_of(code):
        """返回 (连板数, 是否可信)。历史不足或上一条快照距离太远（>10 天）时返回 (1, False)，
        UI 显示「未知」而不是「首板」。"""
        if not history_days:
            return 1, False
        # 最近的快照日距今天超过 10 天（长期未抓快照）→ 无法判断是否连板
        if _gap_days(today, snap_days[0][0]) > 10:
            return 1, False
        n = 1
        prev_d = today
        for d_str, lu_set in snap_days:
            if _gap_days(prev_d, d_str) > 10:
                break
            hit = (code in lu_set) if lu_set is not None else (d_str in user_pick_dates.get(code, ()))
            if not hit:
                break
            n += 1
            prev_d = d_str
        return min(n, 12), True

    picks = []
    for item in lu:
        code = item.get('code')
        if not code:
            continue
        bn, board_known = board_of(code)
        sc = dragon_score(item, bn, sec_map.get(item.get('ind'), 0))
        reasons = []
        if (item.get('inflow') or 0) >= 1: reasons.append('资金净流入靠前')
        if 3 <= (item.get('turnover') or 0) <= 20: reasons.append('换手健康')
        if 20 <= (item.get('fcap') or 0) <= 200: reasons.append('中小盘易连板')
        if board_known and bn > 1: reasons.append('%d 连板' % bn)
        if sec_map.get(item.get('ind'), 0) >= 3: reasons.append('板块联动')
        # 主力净流出却涨停 → 明确标风险，不让用户以为是漏数据
        if (item.get('inflow') or 0) <= 0: reasons.append('主力净流出·封板质量差')
        picks.append({
            'code': code, 'name': item.get('name'), 'ind': item.get('ind'),
            'price': item.get('price'), 'pct': item.get('pct'),
            'turnover': item.get('turnover'), 'fcap': item.get('fcap'),
            'amount': item.get('amount'), 'inflow': item.get('inflow'),
            'score': sc, 'board_num': bn, 'board_known': board_known,
            'flag': 'risk' if (item.get('inflow') or 0) <= 0 else 'pick',
            'reason': '、'.join(reasons[:4]) or ('首板' if board_known else '连板待确认'),
        })
    picks.sort(key=lambda x: -x['score'])
    # 优选取评分前 10；净流出的风险票另外全留（即使分低也要让用户看见）。
    normal = [p for p in picks if p['flag'] == 'pick'][:10]
    risk = [p for p in picks if p['flag'] == 'risk']
    picks = normal + risk

    max_board = max([p['board_num'] for p in picks] or [1])
    board_ok = any(p.get('board_known') for p in picks)
    # 连板不可信时，不能拿恒为 1 的 max_board 去判情绪，否则永远判成「冰点」。
    # 这种时候只用涨停家数 / 跌停家数 / 涨跌比来判，宁可粗略也不误导。
    if board_ok:
        emotion = dragon_emotion_label(
            payload.get('limitUp') or 0, payload.get('limitDown') or 0,
            max_board, payload.get('upRatio') or 0)
    else:
        lu_n = payload.get('limitUp') or 0
        ld_n = payload.get('limitDown') or 0
        up_r = payload.get('upRatio') or 0
        if ld_n >= 20 or (ld_n >= 12 and up_r < 35):
            emotion = '退潮'
        else:
            emotion = '冰点' if lu_n < 20 else ('启动' if lu_n < 40 else ('发酵' if lu_n < 70 else '高潮'))

    lu_codes_json = json.dumps([item.get('code') for item in lu if item.get('code')], ensure_ascii=False)
    with db_conn() as c:
        c.execute('''INSERT OR REPLACE INTO zt_daily
            (date, limit_up, limit_down, up_ratio, amount, max_board,
             board_ladder, sector_top, emotion, lu_codes)
            VALUES (?,?,?,?,?,?,?,?,?,?)''', (
            today, payload.get('limitUp') or 0, payload.get('limitDown') or 0,
            payload.get('upRatio') or 0, payload.get('amount') or 0,
            max_board,
            json.dumps([{'code': p['code'], 'name': p['name'],
                         'board': p['board_num']}
                        for p in picks if p['board_num'] > 1], ensure_ascii=False),
            json.dumps(sectors[:5], ensure_ascii=False),
            emotion, lu_codes_json))
        c.execute('DELETE FROM zt_picks WHERE date=? AND user_id=?', (today, user_id))
        for p in picks:
            c.execute('''INSERT INTO zt_picks
                (date, user_id, code, name, ind, price, pct, turnover, fcap,
                 amount, inflow, score, board_num, board_known, flag, reason)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', (
                today, user_id, p['code'], p['name'], p['ind'], p['price'],
                p['pct'], p['turnover'], p['fcap'], p['amount'], p['inflow'],
                p['score'], p['board_num'], 1 if p.get('board_known') else 0,
                p.get('flag','pick'), p['reason']))
        c.commit()

    return {'ok': True, 'date': today, 'emotion': emotion,
            'limit_up': payload.get('limitUp') or 0,
            'limit_down': payload.get('limitDown') or 0,
            'up_ratio': payload.get('upRatio') or 0,
            'amount': payload.get('amount') or 0,
            'max_board': max_board, 'picks': picks}


def dragon_list(user_id, date=None, days=1):
    """查某个用户的候选清单，默认最近一日。"""
    with db_conn() as c:
        if date:
            rows = c.execute('SELECT * FROM zt_picks WHERE user_id=? AND date=? ORDER BY score DESC',
                             (user_id, date)).fetchall()
        else:
            rows = c.execute('''SELECT * FROM zt_picks WHERE user_id=? AND date >=
                (SELECT MAX(date) FROM zt_picks WHERE user_id=?) ORDER BY score DESC''',
                (user_id, user_id)).fetchall()
        return [{k: r[k] for k in r.keys() if k != 'user_id'} for r in rows]


def dragon_emotion_series(days=30):
    """情绪序列：给看板画趋势用。"""
    with db_conn() as c:
        rows = c.execute('''SELECT date, limit_up, limit_down, up_ratio, amount,
            max_board, emotion, board_ladder FROM zt_daily
            ORDER BY date DESC LIMIT ?''', (days,)).fetchall()
    return [{k: r[k] for k in r.keys()} for r in rows]


# ---------------- 股票搜索建议（名称 / 拼音 / 代码） ----------------
# 浏览器直连 searchapi.eastmoney.com 会被跨域拦，且各家网关对该域名不一定放行，
# 这里由后端代取。股票名称基本不变，缓存 1 小时足够。
