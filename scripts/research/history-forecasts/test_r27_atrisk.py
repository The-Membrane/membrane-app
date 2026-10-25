"""Synthetic unit tests for r27_atrisk (episode state machine and first-firing logic). No real data is read."""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r27_atrisk as R  # noqa: E402

D0 = R.T_SC                     # a day boundary
HOUR, DAY = R.HOUR, R.DAY


def mk(path_close, path_low, spot=None, st=D0 - 2 * HOUR):
    cl, lo = np.asarray(path_close, float), np.asarray(path_low, float)
    sp = cl if spot is None else np.asarray(spot, float)

    def close_prev(c):
        b = (c - st) // HOUR - 1
        return cl[b] if 0 <= b < len(cl) else np.nan

    def low_at(c):
        b = (c - st) // HOUR
        return lo[b] if 0 <= b < len(lo) else np.nan

    def spot_at(c):
        b = (c - st) // HOUR - 1
        return sp[b] if 0 <= b < len(sp) else np.nan

    def feats(c):
        return (0.0, 0.0)
    return close_prev, low_at, spot_at, feats


def test_touch_episode_and_frozen_line():
    n = 24 * 3 + 4
    cl = np.full(n, 100.0)
    lo = np.full(n, 99.5)
    # line at 95 (k = -0.05): enters band at once; touch in bar opening at D0 + 30 h
    b_touch = 2 + 30
    lo[b_touch] = 94.0
    rows = [{"day": D0, "k": -0.05, "stop": None, "stop_kind": "act", "cont": False},
            {"day": D0 + DAY, "k": -0.02, "stop": None, "stop_kind": "act", "cont": True}]
    eps, chk = R.run_chain(rows, *mk(cl, lo))
    assert len(eps) == 1, eps
    e = eps[0]
    assert e["reason"] == "touch" and e["start"] == D0 and e["touch"] == D0 + 30 * HOUR
    assert abs(e["L"] - 95.0) < 1e-9              # frozen at the start, not the day-2 line (98)
    # no new episode on the touch day after the touch
    assert all(ci == 0 for ci, *_ in chk)
    n0 = sum(1 for x in chk if x[0] == 0)
    assert n0 == 31                                 # checks at h = 0 .. 30 (touch bar check included)


def test_exit_action_and_no_episode_far():
    n = 30
    cl = np.full(n, 100.0)
    lo = np.full(n, 99.9)
    cl[2 + 5:] = 120.0                               # distance jumps above 10 % -> exit
    rows = [{"day": D0, "k": -0.05, "stop": D0 + 10 * HOUR + 5, "stop_kind": "act", "cont": False}]
    eps, chk = R.run_chain(rows, *mk(cl, lo))
    # episode 1 exits at the check where the close of the previous bar is 120 (h = 6)
    assert eps[0]["reason"] == "exit" and eps[0]["end"] == D0 + 6 * HOUR
    assert len(eps) == 1                             # far afterwards; action at 10 h ends the day
    rows = [{"day": D0, "k": -0.20, "stop": None, "stop_kind": "act", "cont": False}]
    eps, chk = R.run_chain(rows, *mk(np.full(n, 100.0), np.full(n, 99.0)))
    assert eps == [] or all(e["reason"] != "touch" for e in eps)


def test_action_ends_episode():
    n = 30
    cl = np.full(n, 100.0)
    lo = np.full(n, 99.0)
    lo[2 + 12] = 90.0
    rows = [{"day": D0, "k": -0.03, "stop": D0 + 4 * HOUR, "stop_kind": "act", "cont": False}]
    eps, chk = R.run_chain(rows, *mk(cl, lo))
    assert len(eps) == 1 and eps[0]["reason"] == "act" and eps[0]["touch"] == -1


def test_spot_through():
    n = 30
    cl = np.full(n, 100.0)
    lo = np.full(n, 99.0)
    sp = np.full(n, 100.0)
    sp[2 + 2] = 96.0                                 # spot of the hour ending at D0 + 3 h is through the line (97)
    rows = [{"day": D0, "k": -0.03, "stop": None, "stop_kind": "act", "cont": False}]
    eps, chk = R.run_chain(rows, *mk(cl, lo, sp))
    th = [x[3] for x in chk]
    assert th[3] and not th[2] and not th[4]


def test_firing_first_and_ties():
    ep = np.array([0, 0, 0, 1, 1, 2])
    s = np.array([0.1, 0.5, 0.3, 0.2, 0.2, 0.9])
    F = R.Firing(ep, s, 4)
    thr = F._rank_from_sorted(np.searchsorted(F.ss, 0.2, side="left")) * np.ones(4, np.int64)
    j = F.first(thr)
    assert j.tolist() == [1, 3, 5, -1]
    thr = F._rank_from_sorted(np.searchsorted(F.ss, 0.6, side="left")) * np.ones(4, np.int64)
    assert F.first(thr).tolist() == [-1, -1, 5, -1]
    q = np.array([0, 0, 0, 0])
    sel = np.array([True, True, True, False])
    thr = R.match_ranks(F, sel, np.array([2]), q, 1)
    assert (F.first(thr) >= 0).sum() == 2           # top two by episode max: ep 2 (0.9), ep 0 (0.5)
    assert F.first(thr).tolist()[:3] == [1, -1, 5]


if __name__ == "__main__":
    for k, v in list(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
