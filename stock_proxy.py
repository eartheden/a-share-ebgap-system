"""个股数据代理层：东财/腾讯行情、K线、财务、估值、搜索建议。

从 server.py 拆出（Phase 3），保持函数签名与行为完全不变。
复用 market 层的 DoH 穿透与缓存工具。
"""
import http.client
import json
import re
import time
import urllib.parse
import urllib.request

from market import (fetch_quote_host, _f, _is_fake, resolve_real,
                    _PinnedHTTPSConnection, _cache_lock, _http_cache,
                    _tx_list, TENCENT_QUOTE)

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
    with _cache_lock:
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
    with _cache_lock:
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
    with _cache_lock:
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

    with _cache_lock:
        _suggest_cache[key] = {'at': time.time(), 'list': out}
        if len(_suggest_cache) > 800:   # 粗暴但够用的容量控制
            _suggest_cache.clear()
    return {'ok': True, 'q': kw, 'list': out[:limit]}


