"""Unit tests for a2_fetch_binance.py: grid builder, serialization, checks, paging and retries.

Run: python3 -m unittest scripts/research/history-forecasts/test_a2_fetch_binance.py
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import a2_fetch_binance as A  # noqa: E402

H = A.STEP_MS
T0 = 1502942400000  # 2017-08-17T04:00Z


def kline(open_ms, o="10.00000000", h="12.50000000", lo="9.00000000", c="11.00000000", v="100.10000000"):
    return [open_ms, o, h, lo, c, v, open_ms + H - 1, "0", 1, "0", "0", "0"]


class TestNormDecimal(unittest.TestCase):
    def test_trailing_zeros(self):
        self.assertEqual(A.norm_decimal("4261.48000000"), "4261.48")
        self.assertEqual(A.norm_decimal("0.00000000"), "0")
        self.assertEqual(A.norm_decimal("100.00000000"), "100")
        self.assertEqual(A.norm_decimal("100"), "100")
        self.assertEqual(A.norm_decimal("0.00001230"), "0.0000123")

    def test_rejects_non_decimal(self):
        for bad in ("1e-8", "", "abc", "01.5", 1.5, None, "NaN"):
            with self.assertRaises(ValueError):
                A.norm_decimal(bad)


class TestBuildGrid(unittest.TestCase):
    def test_gap_and_end_extension(self):
        rows = [kline(T0), kline(T0 + H, c="11.5"), kline(T0 + 3 * H, lo="8.25000000")]
        g = A.build_grid(rows, end_open_ms=T0 + 5 * H)
        self.assertEqual(g["startTs"], T0 // 1000)
        self.assertEqual(g["count"], 6)
        self.assertEqual(g["columns"]["close"], ["11", "11.5", None, "11", None, None])
        self.assertEqual(g["columns"]["low"][3], "8.25")
        for c in A.COLUMNS:  # a missing hour is null in every column
            self.assertEqual([i for i, v in enumerate(g["columns"][c]) if v is None], [2, 4, 5])
        self.assertEqual(g["rows"], 3)
        self.assertEqual(g["lastOpenTs"], (T0 + 3 * H) // 1000)

    def test_drops_rows_after_end(self):
        rows = [kline(T0 + i * H) for i in range(5)]
        g = A.build_grid(rows, end_open_ms=T0 + 2 * H)
        self.assertEqual(g["count"], 3)
        self.assertEqual(g["rows"], 3)

    def test_rejects_duplicate_unsorted_misaligned_schema(self):
        with self.assertRaises(ValueError):
            A.build_grid([kline(T0), kline(T0)], end_open_ms=T0 + H)
        with self.assertRaises(ValueError):
            A.build_grid([kline(T0 + H), kline(T0)], end_open_ms=T0 + H)
        with self.assertRaises(ValueError):
            A.build_grid([kline(T0 + 1000)], end_open_ms=T0 + H)
        bad = kline(T0)
        bad[4] = "1e3"
        with self.assertRaises(ValueError):
            A.build_grid([bad], end_open_ms=T0)
        bad = kline(T0)
        bad[6] = T0 + H  # close time must be open + 1 h - 1 ms
        with self.assertRaises(ValueError):
            A.build_grid([bad], end_open_ms=T0)

    def test_order_problems(self):
        self.assertEqual(A.order_problems([1, 2, 2, 1, 3]), {"duplicate_opens": 1, "unsorted_opens": 1})


class TestSerialize(unittest.TestCase):
    def test_round_trip_and_key_order(self):
        rows = [kline(T0, v="123456789.12345678"), kline(T0 + 2 * H)]
        g = A.build_grid(rows, end_open_ms=T0 + 2 * H)
        data = A.serialize_grid("ETHUSDT", g, "2026-10-13T00:00:00Z", A.source_text("ETHUSDT"))
        d = json.loads(data)
        self.assertEqual(list(d), ["asset", "source", "startTs", "stepSeconds", "count", "columns", "fetchedAt"])
        self.assertEqual(list(d["columns"]), list(A.COLUMNS))
        self.assertEqual(d["asset"], "ETH/USDT")
        self.assertEqual(d["stepSeconds"], 3600)
        self.assertEqual(d["count"], 3)
        self.assertEqual(d["columns"]["close"], [11, None, 11])
        self.assertEqual(d["columns"]["high"], [12.5, None, 12.5])
        # the exact decimal text survives in the file
        exact = json.loads(data, parse_float=str, parse_int=str)
        self.assertEqual(exact["columns"]["volume"][0], "123456789.12345678")
        # the reader returns the same grid
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "x.json"
            p.write_bytes(data)
            back = A.load_grid_file(p)
            self.assertEqual(back["columns"], g["columns"])
            self.assertEqual(back["startTs"], g["startTs"])


class TestChecks(unittest.TestCase):
    def test_null_runs_and_years(self):
        self.assertEqual(A.null_runs([None, 1, None, None, 2, None]), [(0, 1), (2, 2), (5, 1)])
        self.assertEqual(A.null_runs([1, 2]), [])
        start = 1609455600  # 2020-12-31T23:00Z
        self.assertEqual(A.nulls_by_year(start, [None, None, 1]), {"2020": 1, "2021": 1})

    def test_coverage_longest_gap(self):
        rows = [kline(T0), kline(T0 + 3 * H), kline(T0 + 4 * H), kline(T0 + 7 * H)]
        g = A.build_grid(rows, end_open_ms=T0 + 7 * H)
        c = A.coverage(g)
        self.assertEqual(c["null_hours"], 4)
        self.assertEqual(c["longest_gap_hours"], 2)
        self.assertEqual(c["longest_gap_start"], A.iso_utc(T0 // 1000 + 3600))  # earliest of the equal runs
        self.assertEqual(c["first_open"], "2017-08-17T04:00:00Z")
        self.assertTrue(c["nulls_aligned_across_columns"])

    def test_value_checks(self):
        rows = [
            kline(T0),
            kline(T0 + H, o="10", h="10.5", lo="10.6", c="10.4"),  # low > min(o, c) and low > high
            kline(T0 + 2 * H, o="10", h="10.2", lo="9", c="10.3"),  # high < max(o, c)
            kline(T0 + 3 * H, v="0.00000000"),
        ]
        g = A.build_grid(rows, end_open_ms=T0 + 4 * H)
        v = A.value_checks(g)
        self.assertEqual(v["low_gt_min_open_close"], 1)
        self.assertEqual(v["high_lt_max_open_close"], 1)
        self.assertEqual(v["low_gt_high"], 1)
        self.assertEqual(v["zero_values"]["volume"], 1)
        self.assertEqual(sum(v["negative_values"].values()), 0)

    def test_cross_check(self):
        rows = [kline(T0 + i * H, c=c) for i, c in enumerate(["100", "100.005", "100.02", "100"])]
        g = A.build_grid(rows, end_open_ms=T0 + 4 * H)
        ref = {"startTs": T0 // 1000 + 3600, "stepSeconds": 3600, "count": 4,
               "columns": {"binance": [100.0, 100.0, None, 100.0]}}
        x = A.cross_check(g, ref, "close", "binance")
        # ref index 0..3 = our 1..4: 100.005 vs 100 (0.005 %), 100.02 vs 100 (0.02 %), 100 vs None, None vs 100
        self.assertEqual(x["hours_both_present"], 2)
        self.assertEqual(x["hours_rel_diff_gt_0.01pct"], 1)
        self.assertEqual(x["ref_null_ours_present"], 1)
        self.assertEqual(x["ours_null_ref_present"], 1)
        self.assertEqual(x["hours_exact_equal"], 0)


class FakeApi:
    """Serves /api/v3/klines pages from a synthetic kline list; optional failures first."""

    def __init__(self, opens, fail=()):
        self.rows = [kline(o) for o in opens]
        self.fail = list(fail)
        self.urls = []

    def __call__(self, url):
        self.urls.append(url)
        if self.fail:
            return self.fail.pop(0), b'{"code":-1003}', {"retry-after": "60"}
        q = dict(kv.split("=") for kv in url.split("?", 1)[1].split("&"))
        start, limit = int(q["startTime"]), int(q["limit"])
        page = [r for r in self.rows if r[0] >= start][:limit]
        return 200, json.dumps(page).encode(), {"x-mbx-used-weight-1m": "7"}


class TestFetch(unittest.TestCase):
    def setUp(self):
        self.sleeps = []
        self.tmp = tempfile.TemporaryDirectory()
        self.work = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def http(self, api):
        clock = iter(range(10**6))
        return A.Http(opener=api, sleep=self.sleeps.append, clock=lambda: next(clock) * 0.0)

    def test_paging_gap_end_and_cache(self):
        n = 2 * A.LIMIT + 300
        opens = [T0 + i * H for i in range(n) if i != 1500]  # one missing hour
        end = T0 + (n - 10) * H
        api = FakeApi(opens)
        pages = A.fetch_pair(self.work, self.http(api), "ETHUSDT", T0 - 4 * H, end_open_ms=end)
        self.assertEqual(len(pages), 3)
        self.assertEqual(pages[1]["startTime"], pages[0]["lastOpen"] + H)
        rows = A.pair_rows(self.work, A.pair_pages(self.work, "ETHUSDT", T0 - 4 * H, end_open_ms=end))
        g = A.build_grid(rows, end_open_ms=end)
        self.assertEqual(g["count"], n - 9)
        self.assertEqual([i for i, v in enumerate(g["columns"]["close"]) if v is None], [1500])
        # second run: everything from the cache, no request
        api2 = FakeApi(opens)
        A.fetch_pair(self.work, self.http(api2), "ETHUSDT", T0 - 4 * H, end_open_ms=end)
        self.assertEqual(api2.urls, [])
        # the raw sha256 in the log matches the bytes on disk
        for rec in pages:
            raw = A.raw_path(self.work, "ETHUSDT", rec["startTime"]).read_bytes()
            self.assertEqual(A.sha256_bytes(raw), rec["sha256"])

    def test_short_page_before_end_stops(self):
        api = FakeApi([T0 + i * H for i in range(10)])
        with self.assertRaises(A.FetchStop):
            A.fetch_pair(self.work, self.http(api), "ETHUSDT", T0, end_open_ms=T0 + 20 * H)

    def test_retry_429_then_ok(self):
        api = FakeApi([T0 + i * H for i in range(3)], fail=[429, 418])
        h = self.http(api)
        A.fetch_pair(self.work, h, "ETHUSDT", T0, end_open_ms=T0 + 2 * H)
        self.assertEqual(h.retries, 2)
        self.assertEqual(h.requests, 3)
        self.assertEqual(self.sleeps.count(A.RETRY_WAIT_S), 2)

    def test_retry_limit_stops(self):
        api = FakeApi([T0], fail=[429] * (A.MAX_RETRIES + 1))
        h = self.http(api)
        with self.assertRaises(A.FetchStop):
            A.fetch_pair(self.work, h, "ETHUSDT", T0, end_open_ms=T0)
        self.assertEqual(h.requests, A.MAX_RETRIES + 1)
        self.assertEqual(h.retries, A.MAX_RETRIES)

    def test_other_4xx_stops_at_once(self):
        api = FakeApi([T0], fail=[400])
        h = self.http(api)
        with self.assertRaises(A.FetchStop):
            A.fetch_pair(self.work, h, "ETHUSDT", T0, end_open_ms=T0)
        self.assertEqual(h.requests, 1)

    def test_pacing(self):
        t = [0.0]
        slept = []

        def sleep(s):
            slept.append(s)
            t[0] += s
        h = A.Http(opener=FakeApi([T0]), sleep=sleep, clock=lambda: t[0])
        h.get(A.page_url("ETHUSDT", T0))
        h.get(A.page_url("ETHUSDT", T0))
        self.assertAlmostEqual(slept[0], 1.0 / A.MAX_REQUESTS_PER_SECOND)
        self.assertLessEqual(A.MAX_REQUESTS_PER_SECOND, 5)


if __name__ == "__main__":
    unittest.main()
