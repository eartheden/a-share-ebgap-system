"""AI 配置与调用层：配置读写、状态、prompt 构造、模型调用、认证限流。

从 server.py 拆出（Phase 3），保持函数签名与行为完全不变。
"""
import json
import os
import sys
import threading
import time
import urllib.request

import auth
from store import db_conn

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


def _is_pos_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v > 0


_auth_rate_lock = threading.Lock()
_auth_fails = {}   # key -> [fail_timestamps]
_AUTH_WINDOW = 300
_AUTH_MAX_FAILS = 10


def _rate_limited(key):
    cutoff = time.time() - _AUTH_WINDOW
    with _auth_rate_lock:
        ts_list = [t for t in _auth_fails.get(key, []) if t > cutoff]
        if ts_list:
            _auth_fails[key] = ts_list
        else:
            _auth_fails.pop(key, None)
        return len(ts_list) >= _AUTH_MAX_FAILS


def _record_auth_fail(key):
    now_ts = time.time()
    cutoff = now_ts - _AUTH_WINDOW
    with _auth_rate_lock:
        ts_list = [t for t in _auth_fails.get(key, []) if t > cutoff]
        ts_list.append(now_ts)
        _auth_fails[key] = ts_list
        if len(_auth_fails) > 2000:
            _auth_fails.clear()


def _clear_auth_fail(key):
    with _auth_rate_lock:
        _auth_fails.pop(key, None)


