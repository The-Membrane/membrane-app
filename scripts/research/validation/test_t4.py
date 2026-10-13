#!/usr/bin/env python3
"""Self-test for t4_rate_spike_churn.py (prereg T4) on tiny synthetic inputs.

Checks: id parsing, chain ordering (block, logIdx) over file order, the balance replay with the
max(0, .) clip, open-at-00:00Z counts, the full-exit thresholds (inclusive), the 90-day return
check (inclusive, strictly after in chain order), spike/base/buffer classification, episode
merging, the block resampler and the excess formulas.

Run: python3 scripts/research/validation/test_t4.py   (or pytest)
"""
import csv
import datetime as dt
import gzip
import math
import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import t4_rate_spike_churn as t4  # noqa: E402

D0 = t4.dnum(dt.date(2023, 1, 27))
DAY = 86400


def ts(day, sec=0):
    return (D0 + day) * DAY + sec


def write_events(path, rows, kind):
    with gzip.open(path, "wt", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "timestamp", "datetime_utc", "user", "reserve", "amount_native", "amount_usd", "event"])
        for block, log, t, user, res, amt in rows:
            w.writerow(["%d:0:0xabc%d:%d:%d" % (block, block, log, log), t,
                        dt.datetime.fromtimestamp(t, dt.timezone.utc).isoformat(), user, res, amt, amt,
                        "borrows" if kind == "borrow" else "repays"])


# ---------------------------------------------------------------------------- scenario
EXIT_A_TS = ts(2, 0)              # exactly 00:00:00Z of day 2
EXIT_D_TS = ts(1, 3600)
BORROWS = [
    # block, logIdx, ts, user, reserve, amount
    (100, 5, ts(0, 36000), "0xa", "USDC", "2000"),
    (101, 1, ts(0, 36100), "0xb", "USDC", "1000"),            # exactly the floor
    (102, 1, ts(0, 36200), "0xc", "USDC", "999.999999"),      # just under the floor
    (103, 1, ts(0, 36300), "0xd", "USDC", "100000"),
    (104, 1, ts(0, 36400), "0xe", "USDC", "100000"),
    (105, 1, ts(0, 36500), "0xf", "USDT", "5000"),
    (106, 1, ts(0, 36600), "0xg", "USDT", "2000"),
    (107, 1, ts(0, 36700), "0xh", "USDT", "1500"),
    (300, 10, ts(1, 7200), "0xf", "USDT", "3000"),            # same block as F's repay, LATER log -> return
    (400, 2, ts(1, 9000), "0xg", "USDT", "10"),               # same block as G's repay, EARLIER log -> not a return
    (500, 1, ts(3, 100), "0xh", "USDT", "1500"),              # H returns; clip must have absorbed interest
    (601, 1, EXIT_A_TS + 90 * DAY, "0xa", "USDC", "1"),       # exactly +90d -> return (inclusive)
    (600, 1, EXIT_D_TS + 90 * DAY + 1, "0xd", "USDC", "5"),   # +90d+1s -> not a return
]
REPAYS = [
    (470, 3, EXIT_A_TS, "0xa", "USDC", "1990"),               # 2000 -> 10 <= max(50, 20): exit
    (201, 1, ts(1, 3000), "0xb", "USDC", "960"),              # 1000 -> 40 <= 50: exit
    (202, 1, ts(1, 3100), "0xc", "USDC", "999.999999"),       # pre < floor: no exit
    (203, 1, EXIT_D_TS, "0xd", "USDC", "99000"),              # 100000 -> 1000 <= 1% * 100000: exit (inclusive)
    (204, 1, ts(1, 3700), "0xe", "USDC", "98999.999999"),     # 100000 -> 1000.000001 > 1000: no exit
    (300, 7, ts(1, 7200), "0xf", "USDT", "5000"),             # listed after the borrow in file, earlier log
    (400, 8, ts(1, 9000), "0xg", "USDT", "2010"),             # 2010 -> 0: exit, non-returning
    (450, 1, ts(1, 9500), "0xh", "USDT", "1600"),             # 1500 -> max(0, -100) = 0: exit
]


def load_scenario():
    tmp = tempfile.mkdtemp()
    b, r = os.path.join(tmp, "b.csv.gz"), os.path.join(tmp, "r.csv.gz")
    write_events(b, BORROWS, "borrow")
    write_events(r, REPAYS, "repay")
    return t4.load_events([(b, "borrow"), (r, "repay")])


def run(floor, last_day=5, lo=2):
    evs = load_scenario()
    daily, exits, ever = t4.replay(evs, floor, D0, D0 + last_day, count_from_day=D0 + lo)
    t4.attach_returns(daily, exits, t4.borrow_index(evs))
    return evs, daily, exits, ever


def test_parse_id():
    assert t4.parse_id("16497271:75:0xdead:163:4") == (16497271, 75, "0xdead", 163, 4)
    assert t4.to_micro("1e-06") == 1 and t4.to_micro("914827.649243") == 914827649243


def test_chain_order_uses_log_index_not_file_order():
    evs = load_scenario()
    assert t4.ordering_diagnostics(evs)["timestamp_inversions_in_chain_order"] == 0
    f = [(e["block"], e["log"], e["kind"]) for e in evs if e["user"] == "0xf"]
    assert f == [(105, 1, t4.BORROW), (300, 7, t4.REPAY), (300, 10, t4.BORROW)]


def test_full_exit_thresholds():
    M = t4.MICRO
    fl = 1000 * M
    assert t4.is_full_exit(1000 * M, 50 * M, fl)              # floor inclusive, 50 inclusive
    assert not t4.is_full_exit(1000 * M, 50 * M + 1, fl)
    assert not t4.is_full_exit(1000 * M - 1, 0, fl)           # below floor
    assert t4.is_full_exit(100000 * M, 1000 * M, fl)          # 1% inclusive
    assert not t4.is_full_exit(100000 * M, 1000 * M + 1, fl)
    assert t4.is_full_exit(9000 * M, 50 * M, 10000 * M) is False


def test_replay_open_counts_exits_returns_floor_1000():
    evs, daily, exits, ever = run(1000)
    M = t4.MICRO
    assert daily[("USDC", D0)]["open"] == 0
    # 00:00Z day 1: A 2000, B 1000 (floor inclusive), D 100000, E 100000; C (999.999999) not open
    assert daily[("USDC", D0 + 1)]["open"] == 4
    assert daily[("USDC", D0 + 1)]["open_usd_micro"] == 203000 * M
    # day 1 exits: B (no later borrow) and D (borrow only at +90d+1s) -> both non-returning
    v = daily[("USDC", D0 + 1)]
    assert (v["exits"], v["nonret_exits"], v["ret_exits"]) == (2, 2, 0)
    assert v["nonret_usd_micro"] == (1000 + 100000) * M      # debt that left = pre-repay B
    assert v["exits_sod_open"] == 2
    # 00:00Z day 2: A 2000, D 1000 (post-exit residual still >= floor), E 1000.000001
    assert daily[("USDC", D0 + 2)]["open"] == 3
    assert daily[("USDC", D0 + 2)]["open_usd_micro"] == 4000 * M + 1
    # A's exit at exactly 00:00:00Z belongs to day 2 and returns at exactly +90d
    v = daily[("USDC", D0 + 2)]
    assert (v["exits"], v["ret_exits"], v["nonret_exits"]) == (1, 1, 0)
    # USDT: F exits then returns in the same block (later log); G's earlier same-block borrow is
    # not a return; H's over-repay clips to 0 and is an exit that returns on day 3
    assert daily[("USDT", D0 + 1)]["open"] == 3 and daily[("USDT", D0 + 1)]["open_usd_micro"] == 8500 * M
    v = daily[("USDT", D0 + 1)]
    assert (v["exits"], v["ret_exits"], v["nonret_exits"]) == (3, 2, 1)
    assert v["nonret_usd_micro"] == 2010 * M
    assert daily[("USDT", D0 + 2)]["open"] == 1 and daily[("USDT", D0 + 2)]["open_usd_micro"] == 3000 * M
    # H: clip absorbed the 100 of interest, so the day-3 borrow of 1500 gives B = 1500 (not 1400)
    assert daily[("USDT", D0 + 4)]["open"] == 2 and daily[("USDT", D0 + 4)]["open_usd_micro"] == 4500 * M
    by_user = {x["user"]: x for x in exits}
    assert set(by_user) == {"0xa", "0xb", "0xd", "0xf", "0xg", "0xh"}
    assert by_user["0xa"]["returned"] and by_user["0xf"]["returned"] and by_user["0xh"]["returned"]
    assert not by_user["0xb"]["returned"] and not by_user["0xd"]["returned"] and not by_user["0xg"]["returned"]
    # open at 00:00Z on some day in [day 2, day 5]: A, D, E, F, H (not B, C, G)
    assert {k[0] for k in ever} == {"0xa", "0xd", "0xe", "0xf", "0xh"}


def test_replay_floor_10000():
    evs, daily, exits, ever = run(10000)
    assert daily[("USDC", D0 + 1)]["open"] == 2                       # D, E only
    v = daily[("USDC", D0 + 1)]
    assert (v["exits"], v["nonret_exits"]) == (1, 1)                  # D only; B's pre < 10,000
    assert daily[("USDT", D0 + 1)]["exits"] == 0


def test_spike_base_classification():
    apr = {d: 5.0 for d in range(41)}
    apr[20] = 12.0                                                    # APY 12.75%
    cls = t4.classify_days(apr)
    spike = sorted(d for d, c in cls.items() if c == "spike")
    assert spike == [20, 21]                                          # day 21 via APY(d-1)
    base = sorted(d for d, c in cls.items() if c == "base")
    assert base == list(range(0, 13)) + list(range(29, 41))           # +/-7 buffer
    buf = sorted(d for d, c in cls.items() if c == "buffer")
    assert buf == list(range(13, 20)) + list(range(22, 29))
    # threshold on APY = exp(APR/100) - 1, inclusive at 10%: APR 100*ln(1.1) = 9.5310...
    lo = t4.classify_days({0: 9.53, 1: 9.53})
    hi = t4.classify_days({0: 9.532, 1: 1.0})
    assert lo[1] != "spike" and hi[0] == "spike" and hi[1] == "spike"
    assert abs(t4.apy_from_apr(100 * math.log(1.1)) - 0.10) < 1e-12


def test_episode_merging():
    assert t4.build_episodes([1, 2, 5, 9, 10]) == [[1, 2, 5], [9, 10]]   # 2 gap days merged, 3 not
    assert t4.build_episodes([3]) == [[3]]
    assert t4.build_episodes([]) == []


def test_block_resample_and_stats():
    rng = np.random.default_rng(1)
    idx = t4.block_resample_idx(rng, 65, 30)
    assert len(idx) == 65 and idx.min() >= 0 and idx.max() <= 64
    assert all(idx[i + 1] - idx[i] == 1 for i in range(29))          # first block is consecutive
    base = {"exits": 10.0, "open": 1000.0, "nonret_usd": 50.0, "open_usd": 1e6}
    eps = {"exits": np.array([5.0]), "open": np.array([100.0]), "nonret_usd": np.array([300.0]),
           "open_usd": np.array([1e5]), "apr_frac": np.array([0.05])}
    s = t4.stats(base, eps)
    assert abs(s["h_base"] - 0.01) < 1e-15 and abs(s["h_spike"] - 0.05) < 1e-15
    assert abs(s["hazard_ratio"] - 5.0) < 1e-12 and abs(s["excess_full_exits"] - 4.0) < 1e-12
    assert abs(s["excess_nonret_usd"] - (300 - 5e-5 * 1e5)) < 1e-9
    assert abs(s["annualized_interest_lost_usd_per_yr"] - 295 * 0.05) < 1e-9
    assert abs(s["protocol_share_rf10_modelled_usd_per_yr"] - 0.1 * 295 * 0.05) < 1e-9


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("ok", fn.__name__)
    print("%d tests passed" % len(tests))
