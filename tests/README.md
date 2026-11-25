# 测试

零外部依赖，只用 Python 标准库。

## 1. 单元测试（不需要启动服务）

```bash
python3 -m unittest discover -s tests -v
```

覆盖：空库建表、多用户同日建议不冲突、情绪判定边界、打分函数、涨跌停阈值。

## 2. 接口冒烟测试（需要先启动服务）

```bash
python3 server.py &          # 另开终端，或后台运行
python3 tests/smoke_api.py
```

覆盖 12 个主要接口的 200 响应与结构。测试用 admin 账号登录，
不会写入或修改数据（只读接口为主）。

## 3. 浏览器回归

`verifyFullSplit.js` 等 Playwright 脚本在临时目录维护，覆盖视图渲染与交互。
如需要可移入本目录并加入 playwright-core 依赖。

## 注意

- 测试数据库使用临时目录，不碰生产 `ebgap.db`
- 冒烟测试的 admin 密码写死为 `admin123456`，改密码后需同步更新本脚本
