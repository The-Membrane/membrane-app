"""Known-answer checks for pl2_cells (synthetic, no network)."""
import json, math, os, tempfile
import numpy as np
import pl2_cells as P

def synth(n_h=24*400, spike_at=24*200, spike_len=24*5, spike_u=0.97, base_u=0.80, seed=1):
    rng = np.random.default_rng(seed)
    t0 = 1674777600
    t = t0 + 3600*np.arange(n_h)
    opt, base, s1, s2 = 0.90, 0.0, 0.027, 0.80
    u = np.clip(base_u + np.cumsum(rng.normal(0, 0.002, n_h)), 0.5, 0.89)
    u[spike_at:spike_at+spike_len] = spike_u
    r = P.util_to_rate(u, opt, base, s1, s2)
    # indexes: vbi grows at r, li at 0; stEthPerToken grows at 3 %/yr
    vbi = np.exp(np.cumsum(r*3600/P.YEAR_S)); li = np.ones(n_h)
    rows = [{"t": int(t[i]), "ts": int(t[i])+7, "r": {"WETH": {"vbr": int(r[i]*1e27), "vbi": int(vbi[i]*1e27), "li": int(1e27)}, "wstETH": {"li": int(li[i]*1e27)}},
             "px": {"WETH": int(3000e8), "wstETH": int(3000e8*1.2)}} for i in range(n_h)]
    strat = [{"T": int(t0 + 86400*d), "a": {"WETH": {"optimal": int(opt*1e27), "base": 0, "slope1": int(s1*1e27), "slope2": int(s2*1e27)}}} for d in range(0, n_h//24+2)]
    days = n_h//24 + 40
    lst = {"startTs": t0 - 40*86400, "stepSeconds": 86400, "columns": {"wstethStEthPerToken": [float(np.exp(0.03*d/365)) for d in range(days)]}}
    return rows, strat, lst, dict(t=t, u=u, r=r, spike_at=spike_at, spike_len=spike_len)

def test_labels_and_forecast():
    rows, strat, lst, g = synth()
    d = tempfile.mkdtemp()
    open(os.path.join(d, "hourly.jsonl"), "w").write("\n".join(json.dumps(x) for x in rows))
    open(os.path.join(d, "strategy_daily.jsonl"), "w").write("\n".join(json.dumps(x) for x in strat))
    json.dump(lst, open(os.path.join(d, "lst.json"), "w"))
    H = P.load_hourly(os.path.join(d, "hourly.jsonl")); S = P.load_strategy(os.path.join(d, "strategy_daily.jsonl")); rT, rV = P.load_wsteth_rate(os.path.join(d, "lst.json"))
    B = P.build(H, S, rT, rV)
    # utilization inversion reproduces the generator
    assert np.allclose(B["u"], g["u"], atol=1e-9), "rate->util inversion"
    assert np.allclose(B["y"][24*40:], 0.03, atol=2e-3), "staking yield reference ≈ 3 %/yr"
    # F1 +20pp over 7 d: the spike rate is 0.027+0.8*(0.07/0.10)=0.587 -> positives exactly for origins whose 7 d window holds a full 24 h run
    lab = B["labels"][("F1", "7d", 0.20)]
    pos = np.where(lab == 1)[0]
    # a 24 h run must lie fully inside (t0, t0+H]: first origin = spike_at - 168 + 23, last = spike end - 24 - 1
    assert pos.min() == g["spike_at"] - 168 + 23 and pos.max() == g["spike_at"] + g["spike_len"] - 24 - 1, (pos.min(), pos.max())
    # no positives at +20pp before the spike window
    assert np.nansum(B["labels"][("F1", "1d", 0.20)][: g["spike_at"] - 24]) == 0
    # F2 1 % over 7 d: decay during the 5-day spike = 0.587*5/365 - 0.03*5/365 ≈ 0.76 % -> below 1 %, so F2 7d 1% has no positives; 0.5 % has
    assert np.nansum(B["labels"][("F2", "7d", 0.01)]) == 0
    assert np.nansum(B["labels"][("F2", "7d", 0.005)]) > 0
    # forecast: fU is 1 when u already >= u*, monotone in distance
    F = P.forecasts(B, ("F1", "7d", 0.20))
    assert F["fU"][g["spike_at"] + 10] == 1.0
    # monotone in distance: closer utilization (same sigma) -> higher odds
    import math
    sig = 0.002; ustar = 0.925
    pf = lambda u0: min(1.0, 2 * (1 - P.Phi((ustar - u0) / (sig * math.sqrt(168)))))
    assert pf(0.80) < pf(0.85) < pf(0.90) <= 1.0 and 0 <= F["fU"][g["spike_at"] - 2000] <= 1
    # (a)/(e) are walk-forward: at the first scored origin they only use labels known by then
    v = np.where(F["valid"])[0]
    assert v.min() >= P.WARMUP_H
    r = P.bootstrap_cell(F, B["t"])
    assert r["class"] == "HISTORY COUNT" and r["positive_blocks"] <= 2, r["class"]
    print("test_pl2: ok", {k: r[k] for k in ("rows", "positives", "positive_blocks", "class")})

def test_stats_known_answer():
    # perfectly calibrated forecasts -> R 1, slope ≈ 1, AUC > 0.5
    rng = np.random.default_rng(0); n = 20000
    p = rng.uniform(0.02, 0.5, n); y = (rng.uniform(size=n) < p).astype(float)
    lp = P.logit(p); qs = np.quantile(lp, np.linspace(0, 1, 101)); sb = np.clip(np.searchsorted(qs, lp, side="right")-1, 0, 99)
    nb = np.bincount(sb, minlength=100).astype(float); yb = np.bincount(sb, weights=y, minlength=100); xb = np.bincount(sb, weights=lp, minlength=100)/nb
    b = P.slope_fit(xb, yb, nb); assert abs(b-1) < 0.08, b
    qa = np.quantile(p, np.linspace(0, 1, 201)); ab = np.clip(np.searchsorted(qa, p, side="right")-1, 0, 199)
    pos = np.bincount(ab, weights=y, minlength=200); neg = np.bincount(ab, minlength=200)-pos
    assert 0.6 < P.auc_from_bins(pos, neg) < 0.8
    print("test_stats: ok slope", round(b, 3))

if __name__ == "__main__":
    test_stats_known_answer(); test_labels_and_forecast()
