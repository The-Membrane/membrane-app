"""
fetch_spike_episodes.py
-----------------------
Extends the spike episode analysis two ways:
  1. Full Aave V3 history (March 2022 → present) instead of the current window
  2. Multiple spike thresholds (10%, 15%, 20%, 25%) to test whether the
     0-repayment result holds as N grows

Requires: reserve_history_daily.csv (output of fetch_reserve_history.py)
          OR the existing aave_usdc_usdt_apr.csv for a quick-run version.

Output:
  spike_episodes_full.csv     — one row per episode per threshold
  spike_episode_summary.csv   — N, repayment rate, supply flow rate by threshold
"""

import csv
import json
from datetime import datetime, timedelta
from collections import defaultdict

# ── config ────────────────────────────────────────────────────────────────────
# Set USE_FULL_DATA = True once reserve_history_daily.csv is available.
# Falls back to the existing apr file for a quick sanity run.
USE_FULL_DATA   = True
FULL_DATA_FILE  = "reserve_history_daily.csv"
APR_FILE        = "aave_usdc_usdt_apr.csv"
LIQ_FILE        = "reserve_history_daily.csv"   # liquidity/debt after Script 1

THRESHOLDS      = [10, 15, 20, 25]   # borrow APR % to define a spike
LOOKBACK_DAYS   = 7                  # days before spike onset to measure baseline
LOOKAHEAD_DAYS  = 14                 # days after spike onset to measure response
MIN_SPIKE_GAP   = 14                 # minimum days between distinct episodes

OUTPUT_EPISODES = "spike_episodes_full.csv"
OUTPUT_SUMMARY  = "spike_episode_summary.csv"
# ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──


def load_apr_from_full_data(filepath: str) -> list[dict]:
    """Load APR data from reserve_history_daily.csv, averaging across symbols per day."""
    by_date = defaultdict(lambda: {"borrow_sum": 0.0, "supply_sum": 0.0, "n": 0})
    with open(filepath) as f:
        for row in csv.DictReader(f):
            d = row["date"]
            by_date[d]["borrow_sum"] += float(row["variable_borrow_pct"])
            by_date[d]["supply_sum"] += float(row["liquidity_rate_pct"])
            by_date[d]["n"] += 1

    rows = []
    for date, v in sorted(by_date.items()):
        rows.append({
            "date":       date,
            "borrow_apr": v["borrow_sum"] / v["n"],
            "supply_apr": v["supply_sum"] / v["n"],
        })
    return rows


def load_apr(filepath: str) -> list[dict]:
    rows = []
    with open(filepath) as f:
        for row in csv.DictReader(f):
            rows.append({
                "date":       row["date"],
                "borrow_apr": float(row["avg_borrow_apr"]),
                "supply_apr": float(row.get("avg_supply_apr", 0)),
            })
    return sorted(rows, key=lambda r: r["date"])


def load_liquidity(filepath: str) -> dict[str, dict]:
    """Returns {date: {liquidity, debt}} averaged across USDC and USDT."""
    by_date = defaultdict(lambda: {"liq_sum": 0.0, "debt_sum": 0.0, "n": 0})
    try:
        with open(filepath) as f:
            for row in csv.DictReader(f):
                d = row["date"]
                by_date[d]["liq_sum"]  += float(row["total_liquidity_raw"])
                by_date[d]["debt_sum"] += float(row["total_debt_raw"])
                by_date[d]["n"]        += 1
    except FileNotFoundError:
        print(f"  [WARN] {filepath} not found — liquidity flow analysis skipped")
        return {}

    return {
        date: {
            "total_liquidity": v["liq_sum"],
            "total_debt":      v["debt_sum"],
        }
        for date, v in by_date.items()
    }


def detect_episodes(apr_rows: list[dict], threshold: float) -> list[dict]:
    """
    Identify spike episodes:
    - A spike begins when avg_borrow_apr first crosses the threshold
    - A new episode requires MIN_SPIKE_GAP days of sub-threshold rates
    Returns list of episode dicts with onset date and peak APR.
    """
    episodes = []
    in_spike = False
    last_episode_end = None
    current_episode = None

    for row in apr_rows:
        date        = row["date"]
        borrow_apr  = row["borrow_apr"]

        if borrow_apr >= threshold:
            if not in_spike:
                # Check gap from last episode
                if last_episode_end and episodes:
                    gap = (datetime.strptime(date, "%Y-%m-%d") -
                           datetime.strptime(last_episode_end, "%Y-%m-%d")).days
                    if gap < MIN_SPIKE_GAP:
                        # Treat as continuation of prior episode
                        current_episode = episodes.pop()
                        in_spike = True
                        current_episode["peak_apr"] = max(
                            current_episode["peak_apr"], borrow_apr
                        )
                        current_episode["end_date"] = date
                        continue

                in_spike = True
                current_episode = {
                    "onset_date": date,
                    "end_date":   date,
                    "peak_apr":   borrow_apr,
                    "threshold":  threshold,
                }
            else:
                current_episode["peak_apr"] = max(current_episode["peak_apr"], borrow_apr)
                current_episode["end_date"] = date
        else:
            if in_spike:
                in_spike = False
                last_episode_end = current_episode["end_date"]
                episodes.append(current_episode)
                current_episode = None

    if in_spike and current_episode:
        episodes.append(current_episode)

    return episodes


def measure_episode(
    episode: dict,
    apr_rows: list[dict],
    liq_map: dict,
) -> dict:
    """
    For each episode, compute:
    - Duration (days)
    - Avg borrow APR during episode
    - Net supply change (onset vs end): positive = lenders added
    - Net debt change (onset vs end): negative = borrowers repaid
    - Pre-spike baseline APR (lookback window avg)
    """
    onset  = episode["onset_date"]
    end    = episode["end_date"]

    onset_dt = datetime.strptime(onset, "%Y-%m-%d")
    end_dt   = datetime.strptime(end,   "%Y-%m-%d")

    pre_start  = (onset_dt - timedelta(days=LOOKBACK_DAYS)).strftime("%Y-%m-%d")
    post_end   = (end_dt   + timedelta(days=LOOKAHEAD_DAYS)).strftime("%Y-%m-%d")

    # APR during episode
    episode_aprs = [
        r["borrow_apr"] for r in apr_rows
        if onset <= r["date"] <= end
    ]
    avg_episode_apr = sum(episode_aprs) / len(episode_aprs) if episode_aprs else None

    # Baseline APR (pre-spike window)
    baseline_aprs = [
        r["borrow_apr"] for r in apr_rows
        if pre_start <= r["date"] < onset
    ]
    baseline_apr = sum(baseline_aprs) / len(baseline_aprs) if baseline_aprs else None

    # Liquidity and debt flows (requires Script 1 output)
    onset_liq  = liq_map.get(onset,    {})
    end_liq    = liq_map.get(end,      {})
    post_liq   = liq_map.get(post_end, liq_map.get(end, {}))

    net_supply_during = (
        end_liq.get("total_liquidity", float("nan"))
        - onset_liq.get("total_liquidity", float("nan"))
    ) if onset_liq and end_liq else None

    net_debt_during = (
        end_liq.get("total_debt", float("nan"))
        - onset_liq.get("total_debt", float("nan"))
    ) if onset_liq and end_liq else None

    net_supply_post = (
        post_liq.get("total_liquidity", float("nan"))
        - end_liq.get("total_liquidity", float("nan"))
    ) if end_liq and post_liq else None

    net_debt_post = (
        post_liq.get("total_debt", float("nan"))
        - end_liq.get("total_debt", float("nan"))
    ) if end_liq and post_liq else None

    # Classification
    supply_positive_during = (net_supply_during > 0) if net_supply_during is not None else None
    borrow_negative_during = (net_debt_during < 0)   if net_debt_during   is not None else None

    return {
        **episode,
        "duration_days":         (end_dt - onset_dt).days + 1,
        "avg_episode_apr":       round(avg_episode_apr, 2) if avg_episode_apr else "",
        "baseline_apr":          round(baseline_apr, 2)    if baseline_apr    else "",
        "net_supply_during_B":   round(net_supply_during / 1e9, 3) if net_supply_during is not None else "",
        "net_debt_during_B":     round(net_debt_during   / 1e9, 3) if net_debt_during   is not None else "",
        "net_supply_post_B":     round(net_supply_post   / 1e9, 3) if net_supply_post   is not None else "",
        "net_debt_post_B":       round(net_debt_post     / 1e9, 3) if net_debt_post     is not None else "",
        "supply_positive_during": supply_positive_during,
        "borrow_repaid_during":   borrow_negative_during,
    }


def summarize(episodes: list[dict]) -> dict:
    n = len(episodes)
    if n == 0:
        return {"n_episodes": 0}

    supply_pos = [e for e in episodes if e["supply_positive_during"] is True]
    borrow_neg = [e for e in episodes if e["borrow_repaid_during"]   is True]

    return {
        "n_episodes":            n,
        "supply_positive_n":     len(supply_pos),
        "supply_positive_pct":   round(len(supply_pos) / n * 100, 1),
        "borrow_repaid_n":       len(borrow_neg),
        "borrow_repaid_pct":     round(len(borrow_neg) / n * 100, 1),
        "avg_duration_days":     round(sum(e["duration_days"] for e in episodes) / n, 1),
        "avg_peak_apr":          round(sum(e["peak_apr"] for e in episodes) / n, 1),
    }


def main():
    print("Loading APR data…")
    if USE_FULL_DATA:
        try:
            apr_rows = load_apr_from_full_data(FULL_DATA_FILE)
            print(f"  {len(apr_rows)} daily APR rows loaded from full data ({apr_rows[0]['date']} → {apr_rows[-1]['date']})")
        except FileNotFoundError:
            print(f"  {FULL_DATA_FILE} not found, falling back to {APR_FILE}")
            apr_rows = load_apr(APR_FILE)
    else:
        apr_rows = load_apr(APR_FILE)
    print(f"  {len(apr_rows)} daily APR rows loaded ({apr_rows[0]['date']} → {apr_rows[-1]['date']})\n")

    print("Loading liquidity/debt data…")
    liq_map = load_liquidity(LIQ_FILE)
    print(f"  {len(liq_map)} daily liquidity snapshots loaded\n")

    all_episodes = []
    summary_rows = []

    for threshold in THRESHOLDS:
        print(f"Detecting episodes at threshold = {threshold}% APR…")
        episodes = detect_episodes(apr_rows, threshold)
        print(f"  {len(episodes)} episodes detected")

        measured = [measure_episode(ep, apr_rows, liq_map) for ep in episodes]
        for ep in measured:
            all_episodes.append(ep)

        s = summarize(measured)
        s["threshold"] = threshold
        summary_rows.append(s)

        print(f"  Supply positive during: {s.get('supply_positive_pct', 'n/a')}%")
        print(f"  Borrow repaid during:   {s.get('borrow_repaid_pct',   'n/a')}%")
        print()

    # Write episodes
    ep_fields = [
        "threshold", "onset_date", "end_date", "duration_days",
        "peak_apr", "avg_episode_apr", "baseline_apr",
        "net_supply_during_B", "net_debt_during_B",
        "net_supply_post_B",   "net_debt_post_B",
        "supply_positive_during", "borrow_repaid_during",
    ]
    with open(OUTPUT_EPISODES, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=ep_fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(all_episodes)

    # Write summary
    sum_fields = [
        "threshold", "n_episodes",
        "supply_positive_n", "supply_positive_pct",
        "borrow_repaid_n",   "borrow_repaid_pct",
        "avg_duration_days", "avg_peak_apr",
    ]
    with open(OUTPUT_SUMMARY, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=sum_fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(summary_rows)

    print(f"Episodes written to {OUTPUT_EPISODES}")
    print(f"Summary  written to {OUTPUT_SUMMARY}")
    print()
    print("NOTE: net_supply/debt columns require reserve_history_daily.csv")
    print("(Script 1 output). Without it, flow columns will be blank but")
    print("episode detection and APR-based classification still runs.")


if __name__ == "__main__":
    main()
