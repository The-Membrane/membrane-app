"""Offline tests for the R3T forward shadow runner (no network).

  python3 -m unittest scripts/research/history-forecasts/live/test_q26_r3t_shadow.py -v
"""
import datetime as dt, hashlib, json, os, sys, tempfile, types, unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import q26_r3t_shadow as R  # noqa: E402
import shadow_log as S  # noqa: E402  (the registered logger, imported only to drive it offline)

UTC = dt.timezone.utc


def fake_klines(url):
    a = int(url.split("startTime=")[1].split("&")[0])
    return json.dumps([[a + 3600_000 * h, "1", "2", "0.5", "1.5", "10", 0, "0", 0, "0", "0", "0"] for h in range(24)]).encode()


def fake_run(cmd, **kw):
    if cmd[:2] == ["git", "-C"]:
        return types.SimpleNamespace(stdout="f" * 40 + "\n")
    day, out = cmd[-3], cmd[-1]  # fetch_cf_rates.py ethereum_v3 <day> <day> <out>
    ts = int(dt.datetime.fromisoformat(day).replace(tzinfo=UTC).timestamp()) + 86000
    rows = [{"date": day, "reserve": s, "block": 1, "ts": ts, "liquidityRate_ray": "1", "variableBorrowRate_ray": "2",
             "liquidityIndex": "3", "variableBorrowIndex": "4"} for s in ["USDC", "USDT"]]
    json.dump({"source": "fake", "misses": [], "rows": rows}, open(out, "w"))
    return types.SimpleNamespace(stdout="")


def in_process_runner(cmd):
    store, a, b = cmd[-3:]
    d = dt.date.fromisoformat(a)
    with mock.patch.object(S, "get", fake_klines), mock.patch.object(S.subprocess, "run", fake_run), \
            mock.patch("builtins.print"):
        while d <= dt.date.fromisoformat(b):
            S.log_day(store, d.isoformat()); d += dt.timedelta(days=1)


class Runner(unittest.TestCase):
    def test_code_is_registered(self):
        R.check_code()  # raises Refused if the two files drift from CODE-SHA256SUMS

    def test_seed_day(self):
        self.assertEqual(R.SEED_DAY, dt.date(2026, 10, 1))

    def test_refuses_before_t_reg(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(R.Refused):
                R.plan(os.path.join(td, "log.jsonl"), dt.datetime(2026, 11, 1, 23, 59, tzinfo=UTC))
            self.assertEqual(R.main(["run", "--out", td]) if dt.datetime.now(UTC) < R.T_REG else 2, 2)
            self.assertFalse(os.path.exists(os.path.join(td, R.STORE_REL)))

    def test_last_complete_day(self):
        self.assertEqual(R.last_complete_day(dt.datetime(2026, 11, 2, 0, 29, tzinfo=UTC)), dt.date(2026, 10, 31))
        self.assertEqual(R.last_complete_day(dt.datetime(2026, 11, 2, 0, 37, tzinfo=UTC)), dt.date(2026, 11, 1))

    def test_seed_backfill_then_daily_then_none(self):
        with tempfile.TemporaryDirectory() as td, mock.patch("builtins.print"):
            log = os.path.join(td, R.STORE_REL, "log.jsonl")
            R.run(td, now=dt.datetime(2026, 11, 2, 0, 37, tzinfo=UTC), runner=in_process_runner)
            n, last = R.read_chain(log)
            self.assertEqual((n, last), (32, dt.date(2026, 11, 1)))  # 2026-10-01 .. 2026-11-01
            R.run(td, now=dt.datetime(2026, 11, 4, 0, 37, tzinfo=UTC), runner=in_process_runner)  # one missed day
            self.assertEqual(R.read_chain(log), (34, dt.date(2026, 11, 3)))
            self.assertIsNone(R.plan(log, dt.datetime(2026, 11, 4, 12, 0, tzinfo=UTC)))
            rec = json.loads(open(log, "rb").read().splitlines()[-1])
            for k in ["sigma", "decision", "trigger", "outcome", "liquidation"]:  # record-only
                self.assertFalse(any(k in key.lower() for key in rec), k)
            d = json.load(open(os.path.join(td, R.STORE_REL, "ETHUSDT-1h.json")))
            self.assertEqual(d["count"], 34 * 24)

    def test_broken_chain_is_detected(self):
        with tempfile.TemporaryDirectory() as td, mock.patch("builtins.print"):
            R.run(td, now=dt.datetime(2026, 11, 2, 0, 37, tzinfo=UTC), runner=in_process_runner)
            log = os.path.join(td, R.STORE_REL, "log.jsonl")
            lines = open(log, "rb").read().splitlines()
            rec = json.loads(lines[3]); rec["ETH_hours"] = 23
            lines[3] = json.dumps(rec, sort_keys=True).encode()
            open(log, "wb").write(b"\n".join(lines) + b"\n")
            with self.assertRaises(ValueError):
                R.read_chain(log)

    def test_first_prev_is_empty_hash(self):
        self.assertEqual(R.EMPTY_SHA, hashlib.sha256(b"").hexdigest())


if __name__ == "__main__":
    unittest.main()
