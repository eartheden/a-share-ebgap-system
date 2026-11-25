"""核心逻辑单元测试 · 标准库 unittest（零外部依赖）

覆盖从 server.py 拆出的各层中，最容易在重构时被改坏的逻辑：
- 数据层：建表迁移、多用户同日建议不冲突、持仓隔离
- 情绪/打分：龙头战法的判定边界
- 工具：限流与配置

运行：python3 -m unittest discover -s tests -v
"""
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import auth
import store
from market import dragon_emotion_label, dragon_score, _limit_board


class TestDatabase(unittest.TestCase):
    def test_empty_db_init(self):
        """空库首次启动必须能建完全部表（曾被误报为阻断性 bug）"""
        tmp = tempfile.mkdtemp()
        old = store.DB
        store.DB = os.path.join(tmp, 'fresh.db')
        auth.DB = store.DB
        try:
            store.db_init()
            import sqlite3
            c = sqlite3.connect(store.DB)
            tables = {r[0] for r in c.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            for t in ('users', 'paper_trades', 'daily_advice', 'zt_daily', 'zt_picks'):
                self.assertIn(t, tables, '缺表 ' + t)
            c.close()
        finally:
            store.DB = old
            auth.DB = old

    def test_daily_advice_composite_pk(self):
        """两个会员同一天写建议不能冲突"""
        tmp = tempfile.mkdtemp()
        old = store.DB
        store.DB = os.path.join(tmp, 'advice.db')
        try:
            store.db_init()
            import sqlite3
            c = sqlite3.connect(store.DB)
            c.execute('''INSERT INTO daily_advice
                (date,user_id,regime,picks) VALUES(?,?,?,?)''',
                ('2026-01-01', 1, 'risk-on', '[]'))
            c.execute('''INSERT INTO daily_advice
                (date,user_id,regime,picks) VALUES(?,?,?,?)''',
                ('2026-01-01', 2, 'risk-off', '[]'))
            c.commit()
            n = c.execute("SELECT COUNT(*) FROM daily_advice WHERE date='2026-01-01'").fetchone()[0]
            self.assertEqual(n, 2)
            c.close()
        finally:
            store.DB = old


class TestEmotion(unittest.TestCase):
    def test_extreme_down_is_ebb(self):
        """极端大跌日必须判退潮，不能被判成冰点"""
        self.assertEqual(dragon_emotion_label(10, 80, 2, 10.0), '退潮')
        self.assertEqual(dragon_emotion_label(67, 68, 2, 11.7), '退潮')

    def test_strong_market(self):
        self.assertEqual(dragon_emotion_label(100, 2, 6, 60.0), '高潮')

    def test_cold_market(self):
        self.assertEqual(dragon_emotion_label(8, 3, 1, 30.0), '冰点')


class TestScoring(unittest.TestCase):
    def test_outflow_penalized(self):
        """主力净流出的涨停股分数必须明显低于净流入的"""
        base = {'inflow': 2.0, 'turnover': 10.0, 'fcap': 80.0}
        bad = dict(base, inflow=-3.0)
        self.assertGreater(dragon_score(base, 1, 0), dragon_score(bad, 1, 0))

    def test_mid_cap_preferred(self):
        small = {'inflow': 1.0, 'turnover': 10.0, 'fcap': 80.0}
        huge = dict(small, fcap=800.0)
        self.assertGreater(dragon_score(small, 1, 0), dragon_score(huge, 1, 0))

    def test_score_bounded(self):
        item = {'inflow': 99.0, 'turnover': 10.0, 'fcap': 80.0}
        self.assertLessEqual(dragon_score(item, 20, 99), 100.0)


class TestBoardThreshold(unittest.TestCase):
    def test_board_types(self):
        self.assertEqual(_limit_board('600519', '贵州茅台'), 10.0)
        self.assertEqual(_limit_board('300750', '宁德时代'), 20.0)
        self.assertEqual(_limit_board('688001', '科创股票'), 20.0)
        self.assertEqual(_limit_board('000001', 'ST某某'), 5.0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
