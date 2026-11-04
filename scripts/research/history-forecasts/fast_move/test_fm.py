"""Known-answer checks for fm.py on a synthetic price path (no network)."""
import json, os, tempfile, gzip, datetime as dt
import numpy as np
import fm

def make(n_days=200):
    t0 = fm.START_TS - 100*86400
    n = n_days*24; t = t0 + 3600*np.arange(n)
    price = np.full(n, 1000.0)
    # day 120 (inside the scored span): a slow slide of 0.4 %/h starting 00:00 for 30 h -> crosses the 5 %, 7.5 % and 10 % lines
    k0 = 120*24
    for i in range(30): price[k0+i] = 1000*(1-0.004*(i+1))
    price[k0+30:] = price[k0+29]
    K = {"t": t.astype(np.int64), "o": price.copy(), "h": price*1.0005, "l": price*0.9995, "c": price.copy()}
    K["G"] = (K["o"]+K["h"]+K["l"]+K["c"])/4
    return K

def test():
    K = make()
    # covariates: OI high in the top third exactly during the slide day (so L1 should fire earlier at d<=5 %)
    n = len(K["t"]); C = {"q_oi": np.full(n, 0.3), "d_oi": np.zeros(n), "tf": np.ones(n)}
    k0 = 120*24; C["q_oi"][k0-48:k0+48] = 0.9
    E = fm.episodes(K, C, "TEST"); fm.attach_cov(E, C, 0, n)
    touch = [e for e in E if e["end_kind"] == "touch" and not e["unreachable"]]
    # the 5 % line opened at day 120 00:00 is touched: the slide reaches 5 % after 12 h (0.4 %/h, low = 0.9995·price)
    e5 = [e for e in touch if e["open"] == K["t"][k0] and e["d0"] == 0.05][0]
    assert e5["k_touch"] - k0 in (12, 13), e5["k_touch"] - k0
    # episode starts at the first check with d <= 10 %: the line is 5 % away at open so d0 = 5 % <= band at the first check (bar k0 end)
    assert e5["k_start"] == k0
    f0 = fm.fire_index(e5, "R0"); f1 = fm.fire_index(e5, "L1")
    # R0 fires at d <= 3 %: after ~5 bars (price down 2 %, d = 1 - 0.95/0.98 ≈ 3.06 % -> 6th bar); L1 at d <= 5 %: at the first check
    assert f1 == 0 and f0 >= 4, (f0, f1)
    o0, o1 = fm.outcome(e5, f0), fm.outcome(e5, f1)
    assert o1[1] == 1 and o1[4] > o0[4], (o0, o1)
    # a 15 % line is never touched: episode ends by life or never enters the band -> no touch record for it
    assert not [e for e in touch if e["d0"] == 0.15]
    # matched B0: with one candidate alert per quarter the threshold grid returns a value in the grid
    fk = [fm.fire_index(e, "L1") for e in E if not e["unreachable"]]
    thr, qs = fm.match_b0([e for e in E if not e["unreachable"]], fk)
    assert all(0.03 <= v <= 0.1 for v in thr.values())
    print("test_fm: ok", {"episodes": len(E), "touches": len(touch), "R0_fire": f0, "L1_fire": f1, "leads": (o0[4], o1[4])})

if __name__ == "__main__":
    test()
