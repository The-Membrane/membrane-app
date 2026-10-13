#!/usr/bin/env python3
"""T2 — Would curators have been warned in time? (preregistered event study)

Preregistration: triccs/membrane-board design/VALIDATION_PREREG.md, commit 506e7c5, "## T2".
Three incidents (sdeUSD 2025, msY/AZND 2026, Oct 10 2025), four scored indicators
(I1p, I2, I3, I4) with thresholds fixed in the prereg, I5 descriptive only.

Step 1 (acquisition) is t2_fetch_defillama.py; its files are frozen with sha256 in the
incident PROVENANCE.md before this script runs. This script only reads frozen files.

    python3 -I t2_curator_warnings.py --datasets ../membrane-datasets --out ../membrane-datasets/validation/t2

stdlib + numpy only.
"""
import argparse, bisect, csv, glob, hashlib, json, math, os, re, sys
from collections import defaultdict
from datetime import datetime, timezone

import numpy as np

HOUR, DAY = 3600, 86400
QUARTER_DAYS = 91.3125
WINDOW_FAR = 60 * DAY      # [T0 - 60d, ...
WINDOW_NEAR = 9 * DAY      # ..., T0 - 9d]
MERGE_GAP = 7 * DAY        # runs separated by < 7 days merge
MIN_CALM_DAYS = 28.0
MAX_FFR_PER_QUARTER = 1.0

# Indicator thresholds (prereg T2.2; fixed, never tuned)
I1P_DRAWDOWN = (995, 1000)          # rate <= 0.995 x running max  (>= 0.5 % below)
I2_TOP_SHARE = (1, 2)               # top-1 borrow shares >= 50 % of total
I3_GAP = 0.02                       # oracle / market - 1 >= 2 %
I3_HOURS, I3_DAILY_POINTS = 24, 2
I4_UTIL = (9, 10)                   # borrow / supply >= 90 %
I4_HOURS, I4_DAILY_POINTS = 72, 3
I4_UNCHANGED = 30 * DAY

# Holds: how long one observation stands for (beyond it the time is unobserved)
HOLD_HOURLY = HOUR
HOLD_DAILY = int(1.5 * DAY)
HOLD_WEEKLY = int(10.5 * DAY)
MARKET_MAX_AGE = 6 * HOUR           # market sample usable at grid time h if h - ts < 6 h

USDC_PER_TOKEN_SCALE = 10 ** 24     # Morpho oracle price is 1e36 * 10^(loanDec - collDec) = 1e24 for USDC(6)/18-dec


def utc(s):
    return int(datetime.strptime(s, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc).timestamp())


def iso(t):
    if t is None:
        return None
    return datetime.fromtimestamp(int(t), timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


T0 = {
    "sdeUSD": utc("2025-11-11T14:47Z"),   # block 23,776,680, findings.json:77-78
    "AZND": utc("2026-07-31T19:06Z"),     # block 25,654,823
    "msY": utc("2026-07-31T19:13Z"),      # block 25,654,860
    "ETH": utc("2025-10-10T21:00Z"),      # oct10 evidence.json meta.excluded.crashWindowUtc start
    "BTC": utc("2025-10-10T21:00Z"),
    "stETH": utc("2025-10-10T21:00Z"),
    "USDe": utc("2025-10-10T21:00Z"),
}
SDEUSD_LOCKOUT_REF = utc("2025-11-04T06:43Z")  # secondary, reported, not deciding
INCIDENTS = {
    "sdeUSD 2025": ["sdeUSD"],
    "msY/AZND 2026": ["AZND", "msY"],
    "Oct 10 2025": ["ETH", "BTC", "stETH", "USDe"],
}
SCORED = ["I1p", "I2", "I3", "I4"]

# Every interpretive choice, fixed in this file before the first indicator run.
DECISIONS = [
    {"id": "D1", "topic": "time and T0",
     "decision": "All times unix UTC. T0 is the prereg minute at :00 s. Observations at or after T0 are dropped and fired/observed intervals are clipped at T0, so no post-T0 data enters any indicator. The sdeUSD secondary reference (2025-11-04 06:43) is evaluated the same way with data clipped at that time.",
     "reason": "Most literal reading of T2.1; an event study must not use post-event data."},
    {"id": "D2", "topic": "observed time",
     "decision": "Each observation stands from its timestamp until the next observation of the same input, capped at a hold (hourly grid 1 h, daily rows 1.5 d, weekly series 10.5 d). Time beyond the cap is unobserved. Observed time is the union of these intervals over points where every input of the indicator exists. Calm days = observed time before T0 - 60d, in days.",
     "reason": "'All observed time before T0 - 60d' (T2.2) needs a span per observation; the caps are 1.5x the native cadence so a missing sample is not counted as observed."},
    {"id": "D3", "topic": "persistence and fire time",
     "decision": "'>= 24 consecutive hours (hourly data)' = 24 consecutive observed hourly grid points with the condition true and no unobserved gap between them; the indicator fires from the 24th point on (not back-dated to the run start) and stays fired while the condition holds. Daily data: I3 fires at the 2nd consecutive daily point, I4 at the 3rd; I4 hourly at the 72nd hourly point. I1p and I2 have no persistence (fire at every point where the condition holds). For I4 the persistence applies to utilization; 'hardcoded' is tested at the same point.",
     "reason": "Causal and conservative: a curator only knows the duration condition is met once it has elapsed; back-dating would lengthen lead times."},
    {"id": "D4", "topic": "episodes, warned, lead, calm fires",
     "decision": "Fired points form intervals [t, end); touching intervals form runs; runs whose gap (next start - previous end) is < 7 d merge into one episode. Warned >= 9 d iff an episode [s, e) has s <= T0 - 9d and e > T0 - 60d. Lead = T0 - s of the earliest episode with s < T0 and e > T0 - 60d (true start kept even if before T0 - 60d). Calm episode start = an episode with s < T0 - 60d (an episode that starts in calm and runs into the window counts as a calm fire). FFR = calm starts / (calm days / 91.3125); measurable iff calm days >= 28.",
     "reason": "Literal transcription of T2.2 'Firing episode', 'Warned >= 9 days', 'Calm period'."},
    {"id": "D5", "topic": "oracle normalization (I3)",
     "decision": "Morpho oracle price() / 1e24 = USDC per collateral token (price is scaled 1e36 x 10^(6 - 18); sdeUSD, msY and AZND are 18-decimal, USDC 6). Compared with the DefiLlama USD price taking 1 USDC = 1 USD (no USDC/USD conversion).",
     "reason": "The prereg lists no USDC series as an I3 input; USDC's deviation is far below the 2 % threshold. Literal reading of 'oracle / market - 1'."},
    {"id": "D6", "topic": "sdeUSD oracle path (I3)",
     "decision": "sdeUSD oracle = sdeusd-usdc-market.json series[].oraclePrice (weekly), using only samples before the cutoff (T0, or the secondary reference), linearly interpolated in time between them, the last one held for up to 10.5 d (unobserved before the first sample). Cross-checked against the Morpho API hourly collateralValue/collateral in e2-stream-nov-2025.json positions (reported, not used).",
     "reason": "The oracle is sdeUSD convertToAssets x a RedStone deUSD_FUNDAMENTAL feed that answered exactly 1.0 from 2025-05-14; both move smoothly, so interpolation is the closest reconstruction of the on-chain value at each hour."},
    {"id": "D7", "topic": "which market price series (I3)",
     "decision": "For each token both the on-chain address key and, where the datasets already name one, the coingecko key were pulled from coins.llama.fi. Primary key = the key with the most samples in [first oracle observation, T0) (a count, value-blind); ties go to the address key. All samples of the primary key from every listed file (the frozen pull, sdeusd-price-defillama.json, e2-stream-nov-2025.json marketPrices) are unioned, de-duplicated by timestamp (frozen pull first). The other key is computed as a sensitivity and does not decide. The market price at time h is the latest sample with h - 6 h < ts <= h; otherwise unobserved. A token with no listed key is 'not testable' for I3.",
     "reason": "T2.2 names two sdeUSD files with two different DefiLlama keys; a value-blind coverage rule picks one before any gap is computed. The causal 6 h hold bridges DefiLlama's ~hourly jitter and short gaps without inventing prices."},
    {"id": "D8", "topic": "msY / AZND I3 cadence",
     "decision": "I3 for msY and AZND is evaluated at the rows[] points (the oracle's ~daily cadence) with the 'on 2 consecutive daily points' rule; market price per D7 at the row timestamp.",
     "reason": "The oracle input (rows[]) is daily, so the daily rule of T2.2 is the literal one."},
    {"id": "D9", "topic": "reverting oracle",
     "decision": "A row whose oraclePrice is 'REVERT' has no oracle answer: I3 is unobserved there, and for I4 a reverting oracle is NOT 'an oracle answer unchanged for >= 30 days' (hardcoded = false; the 30-day run of equal answers is broken by a REVERT). Sensitivity (not deciding): REVERT treated as the last answer.",
     "reason": "Literal: price() reverting returns no answer. Conservative: it does not let a revert count as a frozen price."},
    {"id": "D10", "topic": "Oct 10 I3 inputs",
     "decision": "ETH, BTC: price-history columns oracle (Chainlink, round in force at hour end) and binance (USDT-quoted close), point time = hour end (startTs + 3600 (i+1)), gap = oracle / binance - 1, no USDT correction; null = unobserved. stETH: Aave prices (w)stETH by exchange rate x ETH/USD, i.e. holds stETH at 1.00 ETH, so gap = 1.00 / (stETH/ETH market) - 1 using depeg-history series.stethEth. USDe: gap = 1.00 / (USDe/USD market) - 1 using series.usde. depeg-history is put on an hourly grid with the D7 6 h causal hold.",
     "reason": "As instructed for the Oct 10 I3 test; the literal Chainlink-vs-Binance and 1.00-reference comparisons."},
    {"id": "D11", "topic": "I1p",
     "decision": "Fires at a point iff convertToAssets <= 0.995 x the running maximum over all observed points from the series start up to and including that point (integer arithmetic on the 1e18 values). sdeUSD weekly series[].collateralRate, msY daily rows[].collateralConvertToAssets1e18. AZND and the Oct 10 assets: not testable (no input named in T2.2).",
     "reason": "Literal reading of 'rate >= 0.5 % below its running maximum'."},
    {"id": "D12", "topic": "I2 reconstruction",
     "decision": "sdeUSD: replay all events[] in (block, logIndex) order (AccrueInterest adds interest to supply and borrow assets and feeShares to supply shares; Supply/Withdraw; Borrow/Repay; Liquidate removes repaidShares + badDebtShares from the borrower and the total, repaidAssets + badDebtAssets from borrow, badDebtAssets from supply), sampled at every whole hour (state after events with ts <= h), from the first whole hour after market creation. msY/AZND: per-borrower borrow shares from marketEvents (Borrow +, Repay -, Liquidate -repaidShares -badDebtShares) for blocks <= the row block; totalBorrowShares = their sum (exact: only these events change it; the rows carry no share totals); borrower debt = shares / totalBorrowShares x row.totalBorrowAssets; free liquidity = row.totalSupplyAssets - row.totalBorrowAssets. Fires iff top-1 shares >= 50 % of total AND free liquidity < top-1 debt. Morpho virtual shares ignored (<= 1e-6 relative). Stored (last-booked) totals are used without accruing to the sample instant (accrual moves supply and borrow equally, so free liquidity is unchanged). marketEvents carry no timestamp: event times (reporting only) come from linear block->time interpolation between rows[] (block, ts) points, extrapolated at 12 s/block beyond the ends.",
     "reason": "T2.2 'borrower debt rebuilt from market Borrow/Repay/Liquidate share events, market totals from the same files'. Hourly sampling for sdeUSD matches the I4 'rebuilt hourly' grid and ignores intra-hour transients."},
    {"id": "D13", "topic": "I4 hardcoded",
     "decision": "Hardcoded at time h iff (a) fixed-price oracle: no feeds and no vaults in the oracle configuration recorded in the datasets (sdeUSD oracleGetters: BASE_FEED_1 and BASE_VAULT set -> not fixed; msY findings: baseFeed1 set -> not fixed; AZND findings: feeds none, vaults none, price 1e24 constant -> fixed), OR (b) the Morpho oracle price() answer itself (not a sub-feed) is unchanged in its own sample series for >= 30 days: h - (time of the first sample of the current run of identical answers) >= 30 d, and, on the weekly sdeUSD series, the next sample after h (if any, among samples before the cutoff) is also identical (otherwise the answer at h is not known to be unchanged). Utilization = borrow / supply (0 when supply = 0), >= 90 % checked in integers.",
     "reason": "As instructed: 'check from the oracle series itself'. The next-sample condition is the conservative reading for a weekly series."},
    {"id": "D14", "topic": "not testable / not applicable",
     "decision": "Oct 10: I1p not testable (no convertToAssets input named), I2 not testable (no per-account data), I4 not applicable (Aave oracles move; never fires, counted as 'did not fire'). AZND: I1p not testable.",
     "reason": "T2.2 table."},
    {"id": "D15", "topic": "pass line reading",
     "decision": "PASS iff for some I in {I1p, I2, I3, I4}: I is warned >= 9 d in >= 2 incidents (an incident is warned when any of its assets is warned against its own T0) AND every asset where I is warned (in any incident) has a measurable calm FFR <= 1 per quarter. The lenient reading (count only incidents with at least one warned asset whose FFR passes) is reported and does not decide.",
     "reason": "'on every asset that carries those warnings' read literally and conservatively."},
    {"id": "D16", "topic": "I5",
     "decision": "Dated elements of findings.json timeline[] and outsideTheChain[] whose text matches the fixed pattern (Elixir|Accountable|Main ?Street|Mu Digital|sunset|attest*|verification) are listed with their stated date and precision; lead vs T0 only when the date has day precision. Descriptive; no pass weight.",
     "reason": "T2.2: I5 is descriptive only, from findings.json text."},
]


# ----------------------------------------------------------------------------- generic engine

def persist(T, E, O, C, n):
    """fired[i] iff the run of consecutive observed condition-true points ending at i has length >= n.
    Points i-1, i are consecutive iff E[i-1] >= T[i] (no unobserved gap)."""
    fired, run = [False] * len(T), 0
    for i in range(len(T)):
        if O[i] and C[i]:
            run = run + 1 if (run > 0 and E[i - 1] >= T[i]) else 1
        else:
            run = 0
        fired[i] = run >= n
    return fired


def to_runs(T, E, fired):
    runs = []
    for i in range(len(T)):
        if not fired[i]:
            continue
        if runs and runs[-1][1] >= T[i]:
            runs[-1][1] = max(runs[-1][1], E[i])
        else:
            runs.append([T[i], E[i]])
    return runs


def merge_episodes(runs, gap=MERGE_GAP):
    eps = []
    for s, e in sorted(runs):
        if eps and s - eps[-1][1] < gap:
            eps[-1][1] = max(eps[-1][1], e)
        else:
            eps.append([s, e])
    return eps


def window_stats(eps, t0):
    """Warned / lead / calm-start logic of T2.2 for episodes [s, e) against T0."""
    far, near = t0 - WINDOW_FAR, t0 - WINDOW_NEAR
    warned = any(s <= near and e > far for s, e in eps)
    in_window = [(s, e) for s, e in eps if s < t0 and e > far]
    lead = (t0 - min(s for s, _ in in_window)) / DAY if in_window else None
    calm_starts = sum(1 for s, _ in eps if s < far)
    return warned, in_window, lead, calm_starts


def evaluate(T, E, O, C, n, t0):
    """Core T2 evaluation for one indicator x asset. Lists are aligned per point, sorted by T."""
    keep = [i for i in range(len(T)) if T[i] < t0]
    T = [T[i] for i in keep]
    E = [min(E[i], t0) for i in keep]
    O = [bool(O[i]) for i in keep]
    C = [bool(C[i]) and bool(O[i]) for i in keep]
    fired = persist(T, E, O, C, n)
    runs = to_runs(T, E, fired)
    eps = merge_episodes(runs)
    warned, in_window, lead, calm_starts = window_stats(eps, t0)
    far = t0 - WINDOW_FAR
    calm_s = sum(max(0, min(E[i], far) - T[i]) for i in range(len(T)) if O[i])
    obs_s = sum(E[i] - T[i] for i in range(len(T)) if O[i])
    calm_days = calm_s / DAY
    measurable = calm_days >= MIN_CALM_DAYS
    ffr = (calm_starts / (calm_days / QUARTER_DAYS)) if calm_days > 0 else None
    first_obs = next((T[i] for i in range(len(T)) if O[i]), None)
    if warned:
        status = "warned >= 9d"
    elif in_window:
        status = "fired < 9 days before T0"
    else:
        status = "did not fire"
    return {
        "testable": True,
        "T0": iso(t0),
        "points": len(T), "observedPoints": sum(O), "observedDays": round(obs_s / DAY, 3),
        "firstObserved": iso(first_obs),
        "episodes": [{"start": iso(s), "end": iso(e), "days": round((e - s) / DAY, 3), "startsInCalm": s < far} for s, e in eps],
        "firstFire": iso(eps[0][0]) if eps else None,
        "leadDays": round(lead, 3) if lead is not None else None,
        "warned9d": warned,
        "status": status,
        "calmDays": round(calm_days, 3),
        "calmEpisodeStarts": calm_starts,
        "falseFireRatePerQuarter": round(ffr, 4) if ffr is not None else None,
        "measurable": measurable,
        "ffrOk": bool(measurable and ffr is not None and ffr <= MAX_FFR_PER_QUARTER),
        "_fired": fired, "_T": T,
    }


def not_testable(reason, t0):
    return {"testable": False, "reason": reason, "T0": iso(t0), "episodes": [], "firstFire": None, "leadDays": None,
            "warned9d": False, "status": "not testable", "calmDays": None, "calmEpisodeStarts": None,
            "falseFireRatePerQuarter": None, "measurable": False, "ffrOk": False}


def strip(r):
    return {k: v for k, v in r.items() if not k.startswith("_")}


def ends_with_hold(T, hold, last_end=None):
    E = []
    for i, t in enumerate(T):
        nxt = T[i + 1] if i + 1 < len(T) else (last_end if last_end is not None else t + hold)
        E.append(min(nxt, t + hold))
    return E


def latest_within(sts, svals, t, max_age):
    j = bisect.bisect_right(sts, t) - 1
    if j >= 0 and t - sts[j] < max_age:
        return svals[j]
    return None


def hourly_grid(start, end):
    h = -(-start // HOUR) * HOUR
    return list(range(h, end, HOUR))


# ----------------------------------------------------------------------------- inputs

class Inputs:
    def __init__(self, root):
        self.root = root
        self.used = {}

    def load(self, rel):
        p = os.path.join(self.root, rel)
        b = open(p, "rb").read()
        self.used[rel] = {"bytes": len(b), "sha256": hashlib.sha256(b).hexdigest()}
        return json.loads(b)


def frozen_pull_samples(doc):
    """{key: [(ts, price)]} from a t2_fetch_defillama.py file (all chunk bodies)."""
    out = {}
    for key, v in doc["keys"].items():
        pts = []
        for r in v["requests"]:
            for c in (r["body"].get("coins") or {}).values():
                pts += [(int(p["timestamp"]), float(p["price"])) for p in c["prices"]]
        out[key.lower()] = pts
    return out


def union_samples(*lists):
    seen, out = set(), []
    for lst in lists:
        for t, p in lst:
            if t not in seen:
                seen.add(t)
                out.append((t, p))
    out.sort()
    return [t for t, _ in out], [p for _, p in out]


def choose_key(cands, t_from, t_to):
    """D7: the key with the most samples in [t_from, t_to); ties -> address key (listed first)."""
    counts = {k: sum(1 for t in ts if t_from <= t < t_to) for k, (ts, _) in cands.items()}
    best = max(cands, key=lambda k: (counts[k], k.startswith("ethereum:")))
    return best, counts


# ----------------------------------------------------------------------------- Morpho replay (I2, I4)

class MarketReplay:
    """Morpho Blue market state from its event log (totals + per-borrower borrow shares)."""

    def __init__(self):
        self.S = self.Ss = self.B = self.Bs = 0
        self.shares = defaultdict(int)

    def apply(self, e):
        n = e["name"]
        if n == "AccrueInterest":
            i = int(e["interest"])
            self.B += i
            self.S += i
            self.Ss += int(e.get("feeShares", 0) or 0)
        elif n == "Supply":
            self.S += int(e["assets"]); self.Ss += int(e["shares"])
        elif n == "Withdraw":
            self.S -= int(e["assets"]); self.Ss -= int(e["shares"])
        elif n == "Borrow":
            s = int(e["shares"])
            self.B += int(e["assets"]); self.Bs += s
            self.shares[e["onBehalf"].lower()] += s
        elif n == "Repay":
            s = int(e["shares"])
            self.B = max(0, self.B - int(e["assets"])); self.Bs -= s
            self.shares[e["onBehalf"].lower()] -= s
        elif n == "Liquidate":
            rs, bds = int(e["repaidShares"]), int(e.get("badDebtShares", 0) or 0)
            bda = int(e.get("badDebtAssets", 0) or 0)
            self.B = max(0, self.B - int(e["repaidAssets"]))
            self.B = max(0, self.B - bda)
            self.S -= bda
            self.Bs -= rs + bds
            self.shares[e["borrower"].lower()] -= rs + bds

    def top1(self):
        if not self.shares:
            return None, 0
        a = max(self.shares, key=lambda k: self.shares[k])
        return a, self.shares[a]


def i2_condition(S, B, Bs, top):
    """Top-1 holds >= 50 % of borrow (shares) AND free liquidity S - B < top-1 debt (= top/Bs x B). Integers."""
    if Bs <= 0 or top <= 0 or B <= 0:
        return False
    return 2 * top >= Bs and (S - B) * Bs < top * B


def util_ge_90(S, B):
    return S > 0 and 10 * B >= 9 * S


def block_time_interp(rows):
    """Linear block -> unix time from rows[] (block, ts); 12 s/block beyond the ends."""
    bx = np.array([r["block"] for r in rows], dtype=float)
    ty = np.array([r["ts"] for r in rows], dtype=float)

    def f(b):
        if b < bx[0]:
            return int(round(ty[0] - (bx[0] - b) * 12))
        if b > bx[-1]:
            return int(round(ty[-1] + (b - bx[-1]) * 12))
        return int(round(float(np.interp(b, bx, ty))))
    # leave-one-out residual on interior rows (how good the interpolation is)
    res = [abs(float(np.interp(bx[i], [bx[i - 1], bx[i + 1]], [ty[i - 1], ty[i + 1]])) - ty[i]) for i in range(1, len(bx) - 1)]
    return f, {"method": "linear interpolation between rows[] (block, ts) points; 12 s/block outside",
               "leaveOneOutMaxErrorMin": round(max(res) / 60, 2) if res else None,
               "leaveOneOutMedianErrorMin": round(float(np.median(res)) / 60, 2) if res else None}


# ----------------------------------------------------------------------------- per-incident computation

def hardcoded_series(sample_ts, sample_vals, fixed_price, next_must_match):
    """D13: returns f(h) -> bool. sample_vals are exact oracle answers (str) or None for REVERT/missing."""
    run_start = []
    for i, v in enumerate(sample_vals):
        if v is not None and i > 0 and sample_vals[i - 1] == v:
            run_start.append(run_start[-1])
        else:
            run_start.append(sample_ts[i])

    def f(h):
        if fixed_price:
            return True
        k = bisect.bisect_right(sample_ts, h) - 1
        if k < 0 or sample_vals[k] is None:
            return False
        if next_must_match and k + 1 < len(sample_vals) and sample_vals[k + 1] != sample_vals[k]:
            return False
        return h - run_start[k] >= I4_UNCHANGED
    return f


def oracle_path(series, cutoff):
    """D6 + D1: sdeUSD oracle (USDC per sdeUSD) at time h from weekly series[].oraclePrice samples with ts < cutoff:
    linear interpolation between bracketing samples, the last sample held for up to HOLD_WEEKLY after it, None before the first."""
    pts = [(r["ts"], int(r["oraclePrice"]) / USDC_PER_TOKEN_SCALE) for r in series
           if r["ts"] < cutoff and r.get("oraclePrice") not in (None, "", "REVERT")]
    oT = np.array([t for t, _ in pts], dtype=float)
    oV = np.array([v for _, v in pts])

    def f(h):
        if not len(oT) or h < oT[0] or h - oT[-1] >= HOLD_WEEKLY:
            return None
        return float(np.interp(h, oT, oV))
    return f, (int(oT[0]) if len(oT) else None)


def hardcoded_before(series, fixed, cutoff):
    """D13 on the weekly sdeUSD series using only samples with ts < cutoff (D1)."""
    ss = [r for r in series if r["ts"] < cutoff]
    return hardcoded_series([r["ts"] for r in ss],
                            [(r["oraclePrice"] if r.get("oraclePrice") not in (None, "", "REVERT") else None) for r in ss],
                            fixed, next_must_match=True)


def run_sdeusd(inp, out_dir, csvs):
    t0 = T0["sdeUSD"]
    mk = inp.load("curator-incidents/sdeusd-2025/sdeusd-usdc-market.json")
    old = inp.load("curator-incidents/sdeusd-2025/sdeusd-price-defillama.json")
    e2 = inp.load("position-alerts/e2-stream-nov-2025.json")
    pull = inp.load("curator-incidents/sdeusd-2025/sdeusd-price-defillama-2025-02-01_2025-12-01-1h.json")
    inp.load("curator-incidents/sdeusd-2025/deusd-price-defillama-2025-02-01_2025-12-01-1h.json")  # hashed; context only
    inp.load("curator-incidents/sdeusd-2025/findings.json")
    series = sorted(mk["series"], key=lambda r: r["ts"])
    res, checks = {}, {}

    # ---- I1p (weekly collateralRate)
    T = [r["ts"] for r in series]
    E = ends_with_hold(T, HOLD_WEEKLY)
    O, C, runmax, rows = [], [], 0, []
    for r in series:
        v = r.get("collateralRate")
        ok = v not in (None, "", "REVERT") and int(v) > 0
        cond = False
        if ok:
            v = int(v)
            runmax = max(runmax, v)
            cond = v * I1P_DRAWDOWN[1] <= runmax * I1P_DRAWDOWN[0]
        O.append(ok); C.append(cond)
        rows.append([iso(r["ts"]), r["ts"], int(ok), (v / 1e18 if ok else ""), (runmax / 1e18 if runmax else ""),
                     (1 - v / runmax if ok and runmax else ""), int(cond)])
    r1 = evaluate(T, E, O, C, 1, t0)
    for row, f in zip(rows, r1["_fired"] + [False] * (len(rows) - len(r1["_fired"]))):
        row.append(int(f))
    csvs["sdeUSD-I1p.csv"] = (["t_utc", "ts", "observed", "convertToAssets", "running_max", "drawdown", "cond", "fired"],
                              [rw for rw in rows if rw[1] < t0])
    res["I1p"] = r1

    # ---- replay events (I2, I4) sampled hourly
    ev = sorted(mk["events"], key=lambda e: (e["block"], e["logIndex"]))
    grid = hourly_grid(series[0]["ts"], t0)
    rep, j = MarketReplay(), 0
    states = []
    for h in grid:
        while j < len(ev) and ev[j]["ts"] <= h:
            rep.apply(ev[j]); j += 1
        a, top = rep.top1()
        states.append((h, rep.S, rep.B, rep.Bs, a, top))
    # checks: replay to the end vs stored totals and positions; weekly series vs replay
    full = MarketReplay()
    by_block = []
    for e in ev:
        full.apply(e)
        by_block.append((e["block"], full.S, full.B))
    st = mk["stored"]
    checks["replayVsStoredAtHead"] = {k: int(st[k]) - v for k, v in (("S", full.S), ("Ss", full.Ss), ("B", full.B), ("Bs", full.Bs))}
    pos_diff = [int(p["borrowShares"]) - full.shares.get(p["address"].lower(), 0) for p in mk["positions"]]
    checks["replayVsPositionsBorrowSharesMaxAbsDiff"] = max(abs(x) for x in pos_diff)
    checks["borrowersWithNegativeShares"] = sum(1 for v in full.shares.values() if v < 0)
    bb = [b for b, _, _ in by_block]
    dS, dB = [], []
    for r in series:
        if r["ts"] >= t0:
            continue
        k = bisect.bisect_right(bb, r["block"]) - 1
        S_, B_ = (by_block[k][1], by_block[k][2]) if k >= 0 else (0, 0)
        dS.append(abs(int(r["supply"]) - S_)); dB.append(abs(int(r["borrow"]) - B_))
    checks["replayVsWeeklySeriesBeforeT0"] = {"points": len(dS), "maxAbsSupplyDiffUSDC": max(dS) / 1e6, "maxAbsBorrowDiffUSDC": max(dB) / 1e6,
                                              "note": "series[] supply/borrow vs replayed stored totals at the same block"}

    T = [s[0] for s in states]
    E = [h + HOUR for h in T]
    O = [True] * len(T)
    C2 = [i2_condition(S, B, Bs, top) for (_, S, B, Bs, _, top) in states]
    r2 = evaluate(T, E, O, C2, 1, t0)
    res["I2"] = r2
    rows2 = []
    for (h, S, B, Bs, a, top), c, f in zip(states, C2, r2["_fired"]):
        debt = top * B / Bs if Bs > 0 else 0
        rows2.append([iso(h), h, 1, S / 1e6, B / 1e6, (S - B) / 1e6, a or "", (top / Bs if Bs > 0 else ""), debt / 1e6, int(c), int(f)])
    csvs["sdeUSD-I2.csv"] = (["t_utc", "ts", "observed", "supply_usdc", "borrow_usdc", "free_liquidity_usdc", "top1_borrower",
                              "top1_share", "top1_debt_usdc", "cond", "fired"], rows2)

    # ---- I4 (hourly utilization + hardcoded from series[].oraclePrice)
    og = mk["oracleGetters"]
    zero = "0x" + "0" * 64
    fixed = all(og.get(k, zero) == zero for k in ("BASE_FEED_1()", "BASE_FEED_2()", "QUOTE_FEED_1()", "QUOTE_FEED_2()", "BASE_VAULT()", "QUOTE_VAULT()"))
    hc = hardcoded_before(series, fixed, t0)
    U = [util_ge_90(S, B) for (_, S, B, _, _, _) in states]
    H = [hc(h) for h in T]
    fired_u = persist(T, E, O, U, I4_HOURS)
    C4 = [fu and hh for fu, hh in zip(fired_u, H)]
    r4 = evaluate(T, E, O, C4, 1, t0)
    r4["oracleFixedPrice"] = fixed
    r4["hoursUtilSustained"] = sum(fired_u)
    r4["hoursHardcoded"] = sum(H)
    res["I4"] = r4
    rows4 = [[iso(h), h, 1, (B / S if S else 0), int(u), int(fu), int(hh), int(c), int(f)]
             for (h, S, B, _, _, _), u, fu, hh, c, f in zip(states, U, fired_u, H, C4, r4["_fired"])]
    csvs["sdeUSD-I4.csv"] = (["t_utc", "ts", "observed", "utilization", "util_ge_90", "util_sustained_72h", "hardcoded", "cond", "fired"], rows4)

    # ---- I3 (hourly oracle vs market)
    oracle_at, o_first = oracle_path(series, t0)
    cands_raw = frozen_pull_samples(pull)
    addr = "ethereum:0x5c5b196abe0d54485975d1ec29617d42d9198326"
    cg = "coingecko:elixir-staked-deusd"
    old_pts = []
    for k, c in old["coins"].items():
        if k.lower() == addr:
            old_pts += [(int(p["timestamp"]), float(p["price"])) for p in c["prices"]]
    e2_pts = defaultdict(list)
    for name, s in e2["marketPrices"].items():
        e2_pts[s["key"].lower()] += [(int(a), float(b)) for a, b in s["series"]]
    cands = {
        addr: union_samples(cands_raw.get(addr, []), old_pts, e2_pts.get(addr, [])),
        cg: union_samples(cands_raw.get(cg, []), e2_pts.get(cg, [])),
    }
    primary, counts = choose_key(cands, o_first, t0)
    i3 = {}
    for key, (sts, svals) in cands.items():
        if not sts:
            i3[key] = not_testable("not listed on DefiLlama", t0)
            continue
        g = hourly_grid(max(o_first, sts[0]), t0)
        Tg, Og, Cg, rows3 = [], [], [], []
        for h in g:
            m = latest_within(sts, svals, h, MARKET_MAX_AGE)
            o = oracle_at(h)
            ok = m is not None and o is not None and m > 0
            c = ok and (o / m - 1) >= I3_GAP
            Tg.append(h); Og.append(ok); Cg.append(c)
            rows3.append([iso(h), h, int(ok), o if o is not None else "", m if m is not None else "", (o / m - 1) if ok else "", int(c)])
        r = evaluate(Tg, [h + HOUR for h in Tg], Og, Cg, I3_HOURS, t0)
        r["marketKey"] = key
        r["marketSamplesBeforeT0"] = counts[key]
        for rw, f in zip(rows3, r["_fired"]):
            rw.append(int(f))
        if key == primary:
            csvs["sdeUSD-I3.csv"] = (["t_utc", "ts", "observed", "oracle_usdc", "market_usd", "gap", "cond", "fired"], rows3)
        i3[key] = r
    res["I3"] = i3[primary]
    res["I3"]["marketKeyRule"] = {"primary": primary, "samplesBeforeT0ByKey": counts}
    sens = {"I3_otherMarketKey": {k: strip(v) for k, v in i3.items() if k != primary}}

    # oracle cross-check vs the Morpho API hourly oracle (e2-stream positions)
    diffs = []
    oT = np.array([r["ts"] for r in series if r.get("oraclePrice") not in (None, "", "REVERT")], dtype=float)
    oV = np.array([int(r["oraclePrice"]) / USDC_PER_TOKEN_SCALE for r in series if r.get("oraclePrice") not in (None, "", "REVERT")])
    for p in e2["positions"]:
        if p["marketId"].lower() != mk["market"].lower():
            continue
        for hh in p["history"]:
            if hh.get("collateral") and hh["collateral"] > 0 and hh.get("collateralValue") is not None and hh["ts"] < t0:
                impl = hh["collateralValue"] / hh["collateral"]
                o = float(np.interp(hh["ts"], oT, oV))
                diffs.append(abs(impl / o - 1))
    checks["oracleInterpVsMorphoApiHourly"] = {"points": len(diffs), "maxAbsRelDiff": max(diffs) if diffs else None,
                                               "medianAbsRelDiff": float(np.median(diffs)) if diffs else None}

    # secondary reference (not deciding): same point sets clipped at the lockout time
    sec = {}
    hc_ref = hardcoded_before(series, fixed, SDEUSD_LOCKOUT_REF)
    for name, (TT, EE, OO, CC, n) in {
        "I1p": ([r["ts"] for r in series], ends_with_hold([r["ts"] for r in series], HOLD_WEEKLY), O_I1p(series), C_I1p(series), 1),
        "I2": (T, E, O, C2, 1),
        "I4": (T, E, O, [fu and hc_ref(h) for fu, h in zip(fired_u, T)], 1),
    }.items():
        rr = evaluate(TT, EE, OO, CC, n, SDEUSD_LOCKOUT_REF)
        sec[name] = {"leadDays": rr["leadDays"], "warned9d": rr["warned9d"], "status": rr["status"], "firstFire": rr["firstFire"]}
    # I3 vs ref with the primary key
    sts, svals = cands[primary]
    oracle_ref, o_first_ref = oracle_path(series, SDEUSD_LOCKOUT_REF)
    g = hourly_grid(max(o_first_ref, sts[0]), SDEUSD_LOCKOUT_REF)
    Og, Cg = [], []
    for h in g:
        m = latest_within(sts, svals, h, MARKET_MAX_AGE)
        o = oracle_ref(h)
        ok = m is not None and o is not None and m > 0
        Og.append(ok); Cg.append(ok and (o / m - 1) >= I3_GAP)
    rr = evaluate(g, [h + HOUR for h in g], Og, Cg, I3_HOURS, SDEUSD_LOCKOUT_REF)
    sec["I3"] = {"leadDays": rr["leadDays"], "warned9d": rr["warned9d"], "status": rr["status"], "firstFire": rr["firstFire"]}
    return res, checks, sens, sec


def O_I1p(series):
    return [r.get("collateralRate") not in (None, "", "REVERT") and int(r["collateralRate"]) > 0 for r in series]


def C_I1p(series):
    out, runmax = [], 0
    for r in series:
        v = r.get("collateralRate")
        if v in (None, "", "REVERT") or int(v) <= 0:
            out.append(False); continue
        v = int(v); runmax = max(runmax, v)
        out.append(v * I1P_DRAWDOWN[1] <= runmax * I1P_DRAWDOWN[0])
    return out


def run_morpho_rows(inp, asset, rel, pull_rel, market_keys, fixed_price, csvs, revert_as_last=False, write_csv=True):
    """msY / AZND from rows[] (daily) + marketEvents."""
    t0 = T0[asset]
    d = inp.load(rel)
    rows = sorted(d["rows"], key=lambda r: r["block"])
    ev = sorted(d["marketEvents"], key=lambda e: (e["block"], e["logIndex"]))
    bt, bt_info = block_time_interp(rows)
    T = [r["ts"] for r in rows]
    E = ends_with_hold(T, HOLD_DAILY)
    res, checks = {}, {"blockTime": bt_info}

    # ---- I1p
    if asset == "msY":
        O, C, runmax, out = [], [], 0, []
        for r in rows:
            v = r.get("collateralConvertToAssets1e18")
            ok = v not in (None, "", "REVERT") and int(v) > 0
            c = False
            if ok:
                v = int(v); runmax = max(runmax, v)
                c = v * I1P_DRAWDOWN[1] <= runmax * I1P_DRAWDOWN[0]
            O.append(ok); C.append(c)
            out.append([iso(r["ts"]), r["ts"], int(ok), v / 1e18 if ok else "", runmax / 1e18 if runmax else "",
                        (1 - v / runmax) if ok and runmax else "", int(c)])
        r1 = evaluate(T, E, O, C, 1, t0)
        for rw, f in zip(out, r1["_fired"]):
            rw.append(int(f))
        if write_csv:
            csvs[f"{asset}-I1p.csv"] = (["t_utc", "ts", "observed", "convertToAssets", "running_max", "drawdown", "cond", "fired"], [rw for rw in out if rw[1] < t0])
        res["I1p"] = r1
    else:
        res["I1p"] = not_testable("no convertToAssets input (AZND is not an ERC-4626; T2.2: 'AZND: none')", t0)

    # ---- I2
    rep, j = MarketReplay(), 0
    O, C, out = [], [], []
    neg = 0
    for r in rows:
        while j < len(ev) and ev[j]["block"] <= r["block"]:
            rep.apply(ev[j]); j += 1
        assert rep.Bs == sum(rep.shares.values())
        neg += sum(1 for v in rep.shares.values() if v < 0)
        S, B = int(r["totalSupplyAssets"]), int(r["totalBorrowAssets"])
        a, top = rep.top1()
        c = i2_condition(S, B, rep.Bs, top)
        O.append(True); C.append(c)
        debt = top * B / rep.Bs if rep.Bs > 0 else 0
        out.append([iso(r["ts"]), r["ts"], r["block"], 1, S / 1e6, B / 1e6, (S - B) / 1e6, a or "",
                    (top / rep.Bs if rep.Bs > 0 else ""), debt / 1e6, int(c)])
    r2 = evaluate(T, E, O, C, 1, t0)
    for rw, f in zip(out, r2["_fired"]):
        rw.append(int(f))
    if write_csv:
        csvs[f"{asset}-I2.csv"] = (["t_utc", "ts", "block", "observed", "supply_usdc", "borrow_usdc", "free_liquidity_usdc", "top1_borrower",
                                    "top1_share", "top1_debt_usdc", "cond", "fired"], [rw for rw in out if rw[1] < t0])
    borrowers = sorted({e["onBehalf"].lower() for e in ev if e["name"] == "Borrow"})
    first_borrow = {}
    for e in ev:
        if e["name"] == "Borrow":
            first_borrow.setdefault(e["onBehalf"].lower(), bt(e["block"]))
    top_at_first = None
    if r2["episodes"]:
        k = next(i for i, f in enumerate(r2["_fired"]) if f)
        top_at_first = {"row": iso(T[k]), "address": out[k][7], "share": out[k][8], "debtUSDC": out[k][9], "freeLiquidityUSDC": out[k][6],
                        "firstBorrowInterpolatedUtc": iso(first_borrow.get(out[k][7]))}
    r2["topBorrowerAtFirstFire"] = top_at_first
    r2["borrowersEver"] = len(borrowers)
    res["I2"] = r2
    checks["borrowerSharesNegativeCount"] = neg
    checks["sharesToAssets"] = "rows[] carry no totalBorrowShares: totalBorrowShares rebuilt as the sum of borrower shares from Borrow/Repay/Liquidate events (exact), debt = shares / total x row.totalBorrowAssets"

    # ---- oracle answers per row
    raw = [r.get("oraclePrice") for r in rows]
    vals = [(v if v not in (None, "", "REVERT") else None) for v in raw]
    if revert_as_last:
        last = None
        for i, v in enumerate(vals):
            if v is None and raw[i] == "REVERT":
                vals[i] = last
            elif v is not None:
                last = v
    checks["oracleRevertRows"] = sum(1 for v in raw if v == "REVERT")
    checks["oracleDistinctAnswers"] = len({v for v in raw if v not in (None, "", "REVERT")})

    # ---- I3 (daily points)
    pull = inp.load(pull_rel)
    cands_raw = frozen_pull_samples(pull)
    cands = {k: union_samples(cands_raw.get(k, [])) for k in market_keys}
    listed = {k: bool(v[0]) for k, v in cands.items()}
    first_oracle = next((T[i] for i in range(len(T)) if vals[i] is not None), T[0])
    live = {k: v for k, v in cands.items() if v[0]}
    sens = {}
    if not live:
        res["I3"] = not_testable("not listed on DefiLlama (keys: " + ", ".join(market_keys) + ")", t0)
    else:
        primary, counts = choose_key(live, first_oracle, t0)
        i3 = {}
        for key, (sts, svals) in live.items():
            O, C, out3 = [], [], []
            for i, r in enumerate(rows):
                m = latest_within(sts, svals, r["ts"], MARKET_MAX_AGE)
                o = int(vals[i]) / USDC_PER_TOKEN_SCALE if vals[i] is not None else None
                ok = m is not None and o is not None and m > 0
                c = ok and (o / m - 1) >= I3_GAP
                O.append(ok); C.append(c)
                out3.append([iso(r["ts"]), r["ts"], r["block"], int(ok), o if o is not None else ("REVERT" if raw[i] == "REVERT" else ""),
                             m if m is not None else "", (o / m - 1) if ok else "", int(c)])
            r3 = evaluate(T, E, O, C, I3_DAILY_POINTS, t0)
            for rw, f in zip(out3, r3["_fired"]):
                rw.append(int(f))
            r3["marketKey"] = key
            r3["marketSamplesBeforeT0"] = counts[key]
            r3["marketSamplesFirstLast"] = [iso(sts[0]), iso(sts[-1])]
            if key == primary and write_csv:
                csvs[f"{asset}-I3.csv"] = (["t_utc", "ts", "block", "observed", "oracle_usdc", "market_usd", "gap", "cond", "fired"], [rw for rw in out3 if rw[1] < t0])
            i3[key] = r3
        res["I3"] = i3[primary]
        res["I3"]["marketKeyRule"] = {"primary": primary, "samplesBeforeT0ByKey": counts, "listed": listed}
        sens["I3_otherMarketKey"] = {k: strip(v) for k, v in i3.items() if k != primary}
        if not sens["I3_otherMarketKey"]:
            sens.pop("I3_otherMarketKey")

    # ---- I4 (daily utilization, hardcoded)
    hc = hardcoded_series(T, vals, fixed_price, next_must_match=False)
    U = [util_ge_90(int(r["totalSupplyAssets"]), int(r["totalBorrowAssets"])) for r in rows]
    O = [True] * len(rows)
    fu = persist(T, E, O, U, I4_DAILY_POINTS)
    H = [hc(t) for t in T]
    C4 = [a and b for a, b in zip(fu, H)]
    r4 = evaluate(T, E, O, C4, 1, t0)
    r4["oracleFixedPrice"] = fixed_price
    r4["rowsUtilSustained"] = sum(1 for t, x in zip(T, fu) if x and t < t0)
    r4["rowsHardcoded"] = sum(1 for t, x in zip(T, H) if x and t < t0)
    out4 = []
    for r, u, a, b, c, f in zip(rows, U, fu, H, C4, r4["_fired"] + [False] * len(rows)):
        S, B = int(r["totalSupplyAssets"]), int(r["totalBorrowAssets"])
        out4.append([iso(r["ts"]), r["ts"], r["block"], 1, (B / S if S else 0), int(u), int(a), r.get("oraclePrice") or "", int(b), int(c), int(f)])
    if write_csv:
        csvs[f"{asset}-I4.csv"] = (["t_utc", "ts", "block", "observed", "utilization", "util_ge_90", "util_sustained_3pts", "oracle_price_raw",
                                    "hardcoded", "cond", "fired"], [rw for rw in out4 if rw[1] < t0])
    res["I4"] = r4
    if asset == "AZND":
        checks["azndOracleAllRows1e24"] = all(v == "1000000000000000000000000" for v in raw)
    return res, checks, sens


def hourly_from_samples(sts, svals, t_from, t_to):
    g = hourly_grid(t_from, t_to)
    return g, [latest_within(sts, svals, h, MARKET_MAX_AGE) for h in g]


def daily_aggregate(T, O, gaps, C, fired):
    agg = {}
    for t, o, g, c, f in zip(T, O, gaps, C, fired):
        day = iso(t)[:10]
        a = agg.setdefault(day, [0, 0, 0, None, None])
        a[0] += int(o); a[1] += int(c and o); a[2] += int(f)
        if o and g is not None:
            a[3] = g if a[3] is None else max(a[3], g)
            a[4] = g if a[4] is None else min(a[4], g)
    return [[d, *v] for d, v in sorted(agg.items())]


def run_oct10(inp, csvs):
    res = {}
    inp.load("oct10-2025/evidence.json")
    for asset, rel in (("ETH", "price-history/eth-usd-1h.json"), ("BTC", "price-history/btc-usd-1h.json")):
        t0 = T0[asset]
        d = inp.load(rel)
        st, step = d["startTs"], d["stepSeconds"]
        orc, bnc = d["columns"]["oracle"], d["columns"]["binance"]
        T, O, C, G = [], [], [], []
        for i in range(d["count"]):
            t = st + step * (i + 1)  # close = hour end
            ok = orc[i] is not None and bnc[i] is not None and bnc[i] > 0
            g = (orc[i] / bnc[i] - 1) if ok else None
            T.append(t); O.append(ok); C.append(ok and g >= I3_GAP); G.append(g)
        r = evaluate(T, [t + HOUR for t in T], O, C, I3_HOURS, t0)
        r["inputs"] = "Chainlink oracle (hour-end round) vs Binance USDT close"
        n = len(r["_T"])
        csvs[f"{asset}-I3-daily.csv"] = (["day", "hours_observed", "hours_cond", "hours_fired", "max_gap", "min_gap"],
                                         daily_aggregate(T[:n], O[:n], G[:n], C[:n], r["_fired"]))
        res[asset] = {"I1p": not_testable("no convertToAssets input named in T2.2 for Oct 10", t0),
                      "I2": not_testable("no per-account data for Oct 10 (T2.2)", t0),
                      "I3": r,
                      "I4": dict(not_testable("not applicable: Aave oracles move, never fires (T2.2)", t0), status="did not fire (not applicable)", testable=False, notApplicable=True)}
    dep = inp.load("position-alerts/depeg-history.json")
    for asset, key in (("stETH", "stethEth"), ("USDe", "usde")):
        t0 = T0[asset]
        s = sorted((int(a), float(b)) for a, b in dep["series"][key])
        sts, svals = [a for a, _ in s], [b for _, b in s]
        g, mv = hourly_from_samples(sts, svals, sts[0], t0)
        O = [m is not None and m > 0 for m in mv]
        G = [(1.0 / m - 1) if ok else None for m, ok in zip(mv, O)]
        C = [ok and x >= I3_GAP for ok, x in zip(O, G)]
        r = evaluate(g, [h + HOUR for h in g], O, C, I3_HOURS, t0)
        r["inputs"] = ("1.00 ETH reference (Aave exchange-rate pricing) vs depeg-history stethEth" if asset == "stETH"
                       else "1.00 USD reference vs depeg-history usde")
        n = len(r["_T"])
        csvs[f"{asset}-I3-daily.csv"] = (["day", "hours_observed", "hours_cond", "hours_fired", "max_gap", "min_gap"],
                                         daily_aggregate(g[:n], O[:n], G[:n], C[:n], r["_fired"]))
        res[asset] = {"I1p": not_testable("no convertToAssets input named in T2.2 for Oct 10", t0),
                      "I2": not_testable("no per-account data for Oct 10 (T2.2)", t0),
                      "I3": r,
                      "I4": dict(not_testable("not applicable: Aave oracles move, never fires (T2.2)", t0), status="did not fire (not applicable)", testable=False, notApplicable=True)}
    return res


# ----------------------------------------------------------------------------- I5

I5_PATTERN = re.compile(r"\b(Elixir|Accountable|Main ?Street|Mu Digital|sunset|attest\w*|verification)\b", re.I)
I5_ISSUER_ASSET = {"elixir": "sdeUSD", "accountable": "msY", "mainstreet": "msY", "mudigital": "AZND"}
DATE_RE = re.compile(r"(\d{4}-\d{2}(?:-\d{2})?)")


TESTABLE_INPUTS = {
    ("sdeUSD", "I1p"): "sdeusd-usdc-market.json series[].collateralRate (weekly)",
    ("msY", "I1p"): "msy-usdc-alpha-delta.json rows[].collateralConvertToAssets1e18 (daily)",
    ("sdeUSD", "I2"): "sdeusd-usdc-market.json events[] replay (totals + borrower shares), hourly",
    ("msY", "I2"): "msy-usdc-alpha-delta.json marketEvents[] borrower shares + rows[] totals (daily)",
    ("AZND", "I2"): "aznd-usdc-alpha-asia.json marketEvents[] borrower shares + rows[] totals (daily)",
    ("sdeUSD", "I3"): "series[].oraclePrice (weekly, interpolated) vs DefiLlama sdeUSD price (hourly grid)",
    ("msY", "I3"): "rows[].oraclePrice vs DefiLlama msY price at row times (daily)",
    ("AZND", "I3"): "rows[].oraclePrice vs DefiLlama AZND price at row times (daily)",
    ("ETH", "I3"): "price-history eth-usd-1h oracle vs binance (hourly)",
    ("BTC", "I3"): "price-history btc-usd-1h oracle vs binance (hourly)",
    ("stETH", "I3"): "depeg-history stethEth vs the 1.00 ETH reference (hourly grid)",
    ("USDe", "I3"): "depeg-history usde vs the 1.00 USD reference (hourly grid)",
    ("sdeUSD", "I4"): "events[] replay utilization (hourly) + series[].oraclePrice hardcoded test",
    ("msY", "I4"): "rows[] utilization + rows[].oraclePrice hardcoded test (daily)",
    ("AZND", "I4"): "rows[] utilization (daily) + fixed-price oracle (no feeds, no vaults)",
}


def run_i5(inp):
    out = []
    for inc, rel, assets in (("sdeUSD 2025", "curator-incidents/sdeusd-2025/findings.json", ["sdeUSD"]),
                             ("msY/AZND 2026", "curator-incidents/msy-aznd-2026/findings.json", ["AZND", "msY"])):
        d = inp.load(rel)
        for arr in ("timeline", "outsideTheChain"):
            for i, el in enumerate(d.get(arr, [])):
                text = " ".join(str(el.get(k, "")) for k in ("fact", "what", "source"))
                hits = sorted({m.group(0) for m in I5_PATTERN.finditer(text)})
                if not hits:
                    continue
                dsrc = str(el.get("utc") or el.get("ts") or el.get("source") or "")
                m = DATE_RE.search(dsrc)
                date = m.group(1) if m else None
                prec = "day" if date and len(date) == 10 else ("month" if date else None)
                leads = {}
                concerns = sorted({I5_ISSUER_ASSET[k.lower().replace(" ", "")] for k in hits if k.lower().replace(" ", "") in I5_ISSUER_ASSET} & set(assets)) or assets
                if prec == "day":
                    t = int(datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())
                    leads = {a: round((T0[a] - t) / DAY, 2) for a in concerns}
                out.append({"incident": inc, "file": rel, "path": f"{arr}[{i}]", "concerns": concerns, "date": date, "datePrecision": prec,
                            "dateField": dsrc, "keywords": hits, "text": (el.get("fact") or el.get("what") or "")[:400],
                            "source": el.get("source"), "leadDaysVsT0_dayStart": leads})
    return {"note": "Descriptive only (T2.2). No false-fire rate is measurable, so I5 carries no PASS weight.", "events": out,
            "Oct 10 2025": "no findings.json for this incident: nothing listed"}


# ----------------------------------------------------------------------------- pass line

def pass_line(assets):
    per_ind, reasons = {}, {}
    for I in SCORED:
        inc_warned, carriers, cells = {}, [], {}
        for inc, al in INCIDENTS.items():
            rs = {a: assets[a][I] for a in al}
            warned_assets = [a for a in al if rs[a]["warned9d"]]
            inc_warned[inc] = bool(warned_assets)
            carriers += [(inc, a) for a in warned_assets]
            if warned_assets:
                bad = [a for a in warned_assets if not rs[a]["ffrOk"]]
                if not bad:
                    cell = "warned >= 9d; calm FFR measurable and <= 1/quarter on " + ", ".join(warned_assets)
                else:
                    parts = []
                    for a in bad:
                        parts.append(f"{a}: " + ("calm not measurable" if not rs[a]["measurable"] else
                                                 f"too many calm fires ({rs[a]['falseFireRatePerQuarter']}/quarter)"))
                    cell = "warned >= 9d on " + ", ".join(warned_assets) + "; " + "; ".join(parts)
            elif all(not rs[a]["testable"] and not rs[a].get("notApplicable") for a in al):
                cell = "not testable (" + "; ".join(f"{a}: {rs[a]['reason']}" for a in al) + ")"
            elif any(rs[a]["status"] == "fired < 9 days before T0" for a in al):
                cell = "fired < 9 days before T0 (" + ", ".join(f"{a}: {rs[a]['status']}" for a in al) + ")"
            else:
                cell = "did not fire (" + ", ".join(f"{a}: {rs[a]['status']}" for a in al) + ")"
            cells[inc] = cell
        n_warned = sum(inc_warned.values())
        all_ok = all(assets[a][I]["ffrOk"] for _, a in carriers)
        lenient = sum(1 for inc, al in INCIDENTS.items() if any(assets[a][I]["warned9d"] and assets[a][I]["ffrOk"] for a in al))
        per_ind[I] = {"incidentsWarned": n_warned, "warnedIncidents": [k for k, v in inc_warned.items() if v],
                      "warningCarriers": [f"{a} ({inc})" for inc, a in carriers], "allCarriersFfrOk": all_ok,
                      "passesConservative": n_warned >= 2 and all_ok, "passesLenientReading": lenient >= 2,
                      "byIncident": cells}
        reasons[I] = cells
    verdict = "PASS" if any(v["passesConservative"] for v in per_ind.values()) else "FAIL"
    lenient_verdict = "PASS" if any(v["passesLenientReading"] for v in per_ind.values()) else "FAIL"
    return {"verdict": verdict, "indicators": per_ind, "lenientReadingVerdict_notDeciding": lenient_verdict,
            "readingsAgree": verdict == lenient_verdict,
            "consequence": "FAIL -> the freeze vote ranks before the curator lockout panel (MODELS_PLAN decision)" if verdict == "FAIL"
            else "PASS -> the curator lockout panel is supported by this existence check"}


# ----------------------------------------------------------------------------- main

def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    inp = Inputs(a.datasets)
    csvs = {}

    sde, sde_checks, sde_sens, sde_sec = run_sdeusd(inp, a.out, csvs)
    # D13 (a): fixed-price oracle = no feeds and no vaults, from the oracle configuration in findings.json
    mf = inp.load("curator-incidents/msy-aznd-2026/findings.json")["markets"]
    fixed = {m: not any(k.lower().startswith(("basefeed", "quotefeed", "basevault", "quotevault")) for k in mf[m]["oracle"])
             and mf[m]["oracle"].get("feeds", "none") == "none" and mf[m]["oracle"].get("vaults", "none") == "none"
             for m in ("msY/USDC", "AZND/USDC")}
    msy, msy_checks, msy_sens = run_morpho_rows(inp, "msY", "curator-incidents/msy-aznd-2026/msy-usdc-alpha-delta.json",
                                                "curator-incidents/msy-aznd-2026/msy-price-defillama-2026-04-01_2026-08-15-1h.json",
                                                ["ethereum:0x890a5122aa1da30fec4286de7904ff808f0bd74a"], fixed["msY/USDC"], csvs)
    msy_rev, _, _ = run_morpho_rows(inp, "msY", "curator-incidents/msy-aznd-2026/msy-usdc-alpha-delta.json",
                                    "curator-incidents/msy-aznd-2026/msy-price-defillama-2026-04-01_2026-08-15-1h.json",
                                    ["ethereum:0x890a5122aa1da30fec4286de7904ff808f0bd74a"], fixed["msY/USDC"], csvs, revert_as_last=True, write_csv=False)
    aznd, aznd_checks, aznd_sens = run_morpho_rows(inp, "AZND", "curator-incidents/msy-aznd-2026/aznd-usdc-alpha-asia.json",
                                                   "curator-incidents/msy-aznd-2026/aznd-price-defillama-2026-03-01_2026-08-15-1h.json",
                                                   ["ethereum:0x52c66b5e7f8fde20843de900c5c8b4b0f23708a0", "coingecko:mu-digital-aznd"], fixed["AZND/USDC"], csvs)
    inp.load("curator-incidents/msy-aznd-2026/msusd-price-defillama-2026-04-01_2026-08-15-1h.json")  # hashed; context only
    oct10 = run_oct10(inp, csvs)
    i5 = run_i5(inp)

    assets = {"sdeUSD": sde, "msY": msy, "AZND": aznd, **oct10}
    for asset, inds in assets.items():
        for I, r in inds.items():
            if r.get("testable"):
                r["reason"] = "inputs present: " + TESTABLE_INPUTS.get((asset, I), TESTABLE_INPUTS.get(("*", I), ""))
    verdict = pass_line(assets)

    results = {
        "test": "T2 — Would curators have been warned in time?",
        "prereg": {"repo": "triccs/membrane-board", "file": "design/VALIDATION_PREREG.md", "commit": "506e7c5", "section": "T2"},
        "kind": "retrospective event study (n = 3 incidents: an existence check, not a rate)",
        "computedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "code": {p: sha(os.path.join(os.path.dirname(os.path.abspath(__file__)), p))
                 for p in ("t2_curator_warnings.py", "t2_fetch_defillama.py")},
        "constants": {"windowDays": [60, 9], "mergeGapDays": 7, "quarterDays": QUARTER_DAYS, "minCalmDays": MIN_CALM_DAYS,
                      "maxFfrPerQuarter": MAX_FFR_PER_QUARTER, "I1pDrawdown": 0.005, "I2TopShare": 0.5, "I3Gap": I3_GAP,
                      "I3Persistence": {"hourly": I3_HOURS, "dailyPoints": I3_DAILY_POINTS}, "I4Util": 0.9,
                      "I4Persistence": {"hourly": I4_HOURS, "dailyPoints": I4_DAILY_POINTS}, "I4UnchangedDays": 30},
        "T0": {k: iso(v) for k, v in T0.items()},
        "inputs": inp.used,
        "runLog": {
            "firstRun": {"at": "2026-10-13T00:05:06Z", "codeSha256": "ff090c5cbf3528022b03222c78d5a8f838bafa2f2f0ffef92d44b7d457c3d7da", "verdict": "FAIL"},
            "changesAfterFirstRun": [
                "sdeUSD oracle path (I3) and the I4 hardcoded test now read only weekly oracle samples dated before the cutoff (T0 or the secondary reference), the last held <= 10.5 d, so no post-cutoff sample is used (D1); before, the last pre-T0 week was interpolated toward the first post-T0 sample. D6/D13 wording updated to match. No indicator value, episode, lead or rate changed (the oracle was flat at 1.0705667 from 2025-11-06).",
                "msY/AZND fixed-price flags (D13 a) are now derived in code from findings.json markets[*].oracle (AZND: feeds none, vaults none -> fixed; msY: baseFeed1 set -> not fixed) instead of literal True/False arguments with the same values. No output changed.",
                "Reporting only: every testable indicator x asset now carries a 'reason' naming its inputs (T2 asks for testable yes/no + reason).",
                "I5 (descriptive only): lead vs T0 is now given only for the asset the issuer text concerns (Elixir -> sdeUSD, Accountable/Main Street -> msY, Mu Digital -> AZND) instead of every asset of the incident.",
            ],
            "thresholdsOrWindowsChanged": False,
        },
        "decisions": DECISIONS,
        "incidents": {inc: {a: {I: strip(assets[a][I]) for I in SCORED} for a in al} for inc, al in INCIDENTS.items()},
        "sdeUSD_secondaryLockoutRef_notDeciding": {"ref": iso(SDEUSD_LOCKOUT_REF), "byIndicator": sde_sec},
        "I5": i5,
        "sensitivity_notDeciding": {
            "sdeUSD": sde_sens, "AZND": aznd_sens, "msY": msy_sens,
            "msY_revertAsLastAnswer": {I: {k: strip(msy_rev[I]).get(k) for k in ("status", "warned9d", "leadDays", "episodes", "calmEpisodeStarts", "falseFireRatePerQuarter", "measurable")} for I in ("I3", "I4")},
        },
        "checks": {"sdeUSD": sde_checks, "msY": msy_checks, "AZND": aznd_checks},
        "passLine": verdict,
        "verdict": verdict["verdict"],
    }
    # CSVs
    out_files = {}
    for name, (hdr, rows) in sorted(csvs.items()):
        p = os.path.join(a.out, name)
        with open(p, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(hdr)
            for r in rows:
                w.writerow([(f"{x:.8g}" if isinstance(x, float) else x) for x in r])
        out_files[name] = p
    rp = os.path.join(a.out, "results.json")
    with open(rp, "w") as f:
        json.dump(results, f, indent=1)
        f.write("\n")
    out_files["results.json"] = rp
    # PROVENANCE
    lines = ["# validation/t2 — provenance", "",
             "Outputs of preregistered test T2 (`triccs/membrane-board` `design/VALIDATION_PREREG.md` @506e7c5, \"## T2\"):",
             "would curators have been warned >= 9 days before three loss incidents. Retrospective event study, n = 3.", "",
             f"- **Code:** `The-Membrane/membrane-app` branch `research/validation-pilots`, `scripts/research/validation/t2_curator_warnings.py`"
             f" (sha256 `{results['code']['t2_curator_warnings.py']}`), acquisition `t2_fetch_defillama.py` (sha256 `{results['code']['t2_fetch_defillama.py']}`).",
             f"- **Run:** `python3 -I scripts/research/validation/t2_curator_warnings.py --datasets <membrane-datasets> --out <membrane-datasets>/validation/t2` at {results['computedAt']}.",
             f"- **Verdict:** {results['verdict']} (details and every decision in `results.json`).",
             "- **Inputs:** every input file with bytes and sha256 is in `results.json` `inputs`; the DefiLlama pulls were frozen first",
             "  (rows in `curator-incidents/sdeusd-2025/PROVENANCE.md` and `curator-incidents/msy-aznd-2026/PROVENANCE.md`).",
             "- **CSV:** one file per asset x indicator. sdeUSD I2/I3/I4 are hourly; msY/AZND are per rows[] point (~daily); sdeUSD I1p is weekly;",
             "  Oct 10 I3 files are daily aggregates of the hourly evaluation (hours observed / condition / fired, max and min gap).", "",
             "| file | bytes | sha256 |", "|---|---:|---|"]
    for name in sorted(out_files):
        p = out_files[name]
        lines.append(f"| `{name}` | {os.path.getsize(p)} | `{sha(p)}` |")
    with open(os.path.join(a.out, "PROVENANCE.md"), "w") as f:
        f.write("\n".join(lines) + "\n")
    print(json.dumps({"verdict": results["verdict"], "summary": summarize(results)}, indent=1))


def summarize(results):
    rows = []
    for inc, al in results["incidents"].items():
        for a, inds in al.items():
            for I, r in inds.items():
                rows.append(f"{inc} | {a} | {I} | {r['status']} | lead {r['leadDays']} | calm {r['calmDays']}d starts {r['calmEpisodeStarts']} FFR {r['falseFireRatePerQuarter']} meas {r['measurable']}")
    return rows


if __name__ == "__main__":
    main()
