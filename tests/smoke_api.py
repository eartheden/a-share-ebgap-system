"""接口冒烟测试 · 需要服务已在 8899 端口运行

用法：
    python3 server.py &          # 先起服务
    python3 tests/smoke_api.py   # 再跑冒烟

只依赖标准库，检查所有主要接口返回 200 且结构正确。
"""
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = 'http://127.0.0.1:8899'
ORIGIN = BASE

# (名称, 路径, 校验函数, 是否需要登录)
CASES = [
    ('登录页', '/', lambda b: b'<!DOCTYPE html>' in b, False),
    ('auth/me', '/api/auth/me', lambda j: j.get('ok') is True, False),
    ('market/index', '/api/market/index', lambda j: 'data' in j, True),
    ('market/list', '/api/market/list?pn=1&pz=3', lambda j: 'data' in j, True),
    ('market/limitup', '/api/market/limitup', lambda j: j.get('ok') is True, True),
    ('auth/login', '/api/auth/login', lambda j: j.get('ok') is True, False),
    ('paper/list', '/api/paper/list', lambda j: j.get('ok') is True, True),
    ('advice/list', '/api/advice/list?limit=2', lambda j: j.get('ok') is True, True),
    ('dragon/emotion', '/api/dragon/emotion?days=5', lambda j: j.get('ok') is True, True),
    ('dragon/list', '/api/dragon/list', lambda j: j.get('ok') is True, True),
    ('ai/status', '/api/ai/status', lambda j: 'provider' in j, True),
    ('stock/suggest', '/api/stock/suggest?q=600', lambda j: 'list' in j, True),
]


def call(path, method='GET', body=None, cookie=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json',
                                          'Origin': ORIGIN})
    if cookie:
        req.add_header('Cookie', cookie)
    with urllib.request.urlopen(req, timeout=15) as r:
        raw = r.read()
        set_cookie = r.headers.get('Set-Cookie')
        return raw, (set_cookie.split(';')[0] if set_cookie else cookie)


def main():
    ok_n = fail_n = 0
    print('接口冒烟测试 · %s\n' % BASE)
    # 先登录拿 cookie，后续需要鉴权的接口都用它
    try:
        raw, cookie = call('/api/auth/login', 'POST',
                           {'username': 'admin', 'password': 'admin123456'})
        login_payload = json.loads(raw)
        if not login_payload.get('ok'):
            print('登录失败，无法继续：', login_payload)
            sys.exit(1)
    except Exception as e:
        print('登录异常：', e)
        sys.exit(1)

    for name, path, check, need_auth in CASES:
        try:
            if path == '/api/auth/login':
                payload = login_payload
            else:
                raw, _ = call(path, cookie=cookie if need_auth else None)
                payload = (json.loads(raw)
                           if path.endswith(('.json', '')) and raw[:1] in (b'{', b'[')
                           else raw)
            good = check(payload)
        except Exception as e:
            good = False
            payload = str(e)
        flag = 'PASS' if good else 'FAIL'
        if good:
            ok_n += 1
        else:
            fail_n += 1
        print('[%s] %-16s %s' % (flag, name, path))
        if not good:
            print('       →', str(payload)[:160])
    print('\n结果 PASS %d / FAIL %d' % (ok_n, fail_n))
    sys.exit(1 if fail_n else 0)


if __name__ == '__main__':
    main()
