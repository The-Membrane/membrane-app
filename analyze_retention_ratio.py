"""
analyze_retention_ratio.py
--------------------------
Analyzes lender withdrawal behavior to find the optimal retention emission
ratio relative to acquisition cost.

The key question: at what supply APR do seasoned lenders (180+ days) start
withdrawing at materially higher rates? That APR floor is what the retention
emission needs to defend. The cost of defending it relative to the acquisition
emission cost gives you the empirically-derived retention ratio.

Requires:
  lender_flows_raw.csv       (fetch_lender_flows.py output)
  lender_cohort_summary.csv  (fetch_lender_flows.py output)
  lender_flows_daily.csv     (fetch_lender_flows.py output)

Output:
  retention_ratio_analysis.csv   — withdrawal elasticity by APR and age cohort
  retention_ratio_summary.txt    — plain-text findings and recommended ratio
"""

import csv
import json
from collections import defaultdict
from datetime import datetime

COHORT_FILE  = "lender_cohort_summary.csv"
DAILY_FILE   = "lender_flows_daily.csv"
RAW_FILE     = "lender_flows_raw.csv"
OUTPUT_CSV   = "retention_ratio_analysis.csv"
OUTPUT_TXT   = "retention_ratio_summary.txt"

# Acquisition emission rate assumed (annualized % of deposited capital)
# Set this to your actual modeled acquisition emission APR
ACQUISITION_EMISSION_APR = 3.0   # e.g. 3% annualized on new deposits

# Age threshold for "seasoned" lenders (days)
SEASONED_THRESHOLD_DAYS = 30


def load_cohort(filepath: str) -> list[dict]:
    rows = []
    with open(filepath) as f:
        for r in csv.DictReader(f):
            rows.append({
                "apr_bucket":       r["supply_apr_bucket"],
                "age_bucket":       r["lender_age_bucket"],
                "n_users":          int(r["n_users"]),
                "n_withdrawals":    int(r["n_withdrawals"]),
                "deposited_M":      float(r["total_deposited_M"]),
                "withdrawn_M":      float(r["total_withdrawn_M"]),
                "withdrawal_pct":   float(r["withdrawal_pct"]),
            })
    return rows


def load_daily(filepath: str) -> list[dict]:
    rows = []
    with open(filepath) as f:
        for r in csv.DictReader(f):
            rows.append({
                "date":         r["date"],
                "net_flow_M":   float(r["net_flow_M"]),
                "supply_apr":   float(r["supply_apr"]),
                "apr_bucket":   r["apr_bucket"],
                "net_positive": r["net_positive"] == "True",
            })
    return sorted(rows, key=lambda r: r["date"])


def net_flow_by_apr(daily: list[dict]) -> dict:
    """
    Net lender flow (deposit - withdraw) aggregated by APR bucket.
    Positive = lenders adding capital at that APR level.
    Negative = lenders net withdrawing.
    """
    by_apr = defaultdict(lambda: {"net_M": 0.0, "n_days": 0,
                                   "pos_days": 0, "neg_days": 0})
    for r in daily:
        bkt = r["apr_bucket"]
        by_apr[bkt]["net_M"]    += r["net_flow_M"]
        by_apr[bkt]["n_days"]   += 1
        by_apr[bkt]["pos_days"] += 1 if r["net_positive"] else 0
        by_apr[bkt]["neg_days"] += 0 if r["net_positive"] else 1
    return dict(by_apr)


def withdrawal_elasticity(cohort: list[dict]) -> list[dict]:
    """
    For each APR bucket: compare withdrawal_pct of new vs seasoned lenders.
    A high ratio means seasoned lenders are MORE sensitive at that APR level.
    A low ratio means they're sticky — retention emission is less critical there.
    """
    # APR bucket order for sorting
    bucket_order = ["0–3%","3–5%","5–8%","8–12%","12–20%","20–35%","35%+"]

    # Pivot: {apr_bucket: {age_bucket: withdrawal_pct}}
    pivot = defaultdict(dict)
    for r in cohort:
        pivot[r["apr_bucket"]][r["age_bucket"]] = r["withdrawal_pct"]

    new_age_buckets      = ["0–7 days", "7–30 days"]
    seasoned_age_buckets = ["30–90 days", "90–180 days", "180+ days"]

    rows = []
    for apr in bucket_order:
        if apr not in pivot:
            continue
        age_data = pivot[apr]

        new_withdrawal = sum(age_data.get(a, 0) for a in new_age_buckets) / len(new_age_buckets)
        sea_withdrawal = sum(age_data.get(a, 0) for a in seasoned_age_buckets) / len(seasoned_age_buckets)

        # Elasticity: how much does seasoned withdrawal exceed new lender withdrawal?
        # If seasoned_pct > new_pct, older lenders are MORE likely to exit at this APR
        ratio = sea_withdrawal / new_withdrawal if new_withdrawal > 0 else None

        rows.append({
            "apr_bucket":              apr,
            "new_lender_withdraw_pct": round(new_withdrawal, 2),
            "seasoned_withdraw_pct":   round(sea_withdrawal, 2),
            "seasoned_vs_new_ratio":   round(ratio, 3) if ratio else "",
            "seasoned_more_likely":    (sea_withdrawal > new_withdrawal) if ratio else False,
        })
    return rows


def find_churn_floor(elasticity: list[dict]) -> str:
    """
    The APR level below which seasoned lenders withdraw at meaningfully higher
    rates than new lenders — this is the floor the retention emission must defend.
    """
    # Look for first APR bucket where seasoned withdrawal exceeds new significantly
    for r in elasticity:
        if r["seasoned_more_likely"] and r["seasoned_vs_new_ratio"] != "":
            if float(r["seasoned_vs_new_ratio"]) > 1.2:  # 20% more likely
                return r["apr_bucket"]
    return "not identified — check raw data"


def compute_retention_ratio(
    churn_floor_apr_mid: float,
    acquisition_apr: float,
) -> dict:
    """
    Given the APR floor below which seasoned lenders churn, and the
    acquisition emission rate, compute the empirically-justified retention ratio.

    Logic:
    - Retention emission must make up the yield gap between churn_floor and current rate
    - If current rate is above churn floor, no retention emission needed
    - The ratio = retention_emission_needed / acquisition_emission_rate
    """
    # At the churn floor, the protocol needs to top up supply APR to at least floor level
    # If acquisition emission is X%, retention needs to cover the gap
    # Simplified: ratio = churn_floor_apr / acquisition_apr, capped at 1.0
    raw_ratio = churn_floor_apr_mid / acquisition_apr
    capped    = min(raw_ratio, 1.0)  # retention never exceeds acquisition

    return {
        "churn_floor_apr":        churn_floor_apr_mid,
        "acquisition_emission":   acquisition_apr,
        "raw_ratio":              round(raw_ratio, 3),
        "recommended_ratio":      round(capped, 3),
        "recommended_pct":        f"{round(capped * 100, 1)}%",
    }


def main():
    print("Loading cohort data...")
    cohort = load_cohort(COHORT_FILE)
    print(f"  {len(cohort)} cohort rows\n")

    print("Loading daily flow data...")
    daily = load_daily(DAILY_FILE)
    print(f"  {len(daily)} daily rows ({daily[0]['date']} → {daily[-1]['date']})\n")

    # Net flow by APR bucket
    flow_by_apr = net_flow_by_apr(daily)

    # Withdrawal elasticity
    print("Computing withdrawal elasticity by APR bucket...")
    elasticity = withdrawal_elasticity(cohort)

    # Find churn floor
    churn_floor = find_churn_floor(elasticity)
    print(f"  Estimated churn floor APR bucket: {churn_floor}\n")

    # Write elasticity CSV
    fields = ["apr_bucket", "new_lender_withdraw_pct", "seasoned_withdraw_pct",
              "seasoned_vs_new_ratio", "seasoned_more_likely"]
    with open(OUTPUT_CSV, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(elasticity)
    print(f"Elasticity table → {OUTPUT_CSV}")

    # Net flow by APR summary
    print("\nNet lender flow by APR bucket:")
    print(f"{'APR bucket':<12} {'Net flow $M':>12} {'Days pos':>10} {'Days neg':>10} {'Pos rate':>10}")
    bucket_order = ["0–3%","3–5%","5–8%","8–12%","12–20%","20–35%","35%+"]
    for bkt in bucket_order:
        if bkt not in flow_by_apr:
            continue
        v = flow_by_apr[bkt]
        pos_rate = v["pos_days"] / v["n_days"] * 100 if v["n_days"] > 0 else 0
        print(f"{bkt:<12} {v['net_M']:>12.1f} {v['pos_days']:>10} {v['neg_days']:>10} {pos_rate:>9.1f}%")

    print("\nWithdrawal elasticity (seasoned vs new lenders):")
    print(f"{'APR bucket':<12} {'New withdraw%':>14} {'Seasoned%':>12} {'Ratio':>8} {'Seasoned>New':>14}")
    for r in elasticity:
        print(f"{r['apr_bucket']:<12} {r['new_lender_withdraw_pct']:>14.2f} "
              f"{r['seasoned_withdraw_pct']:>12.2f} {str(r['seasoned_vs_new_ratio']):>8} "
              f"{str(r['seasoned_more_likely']):>14}")

    # Compute retention ratio
    # Map churn floor bucket to midpoint APR
    bucket_midpoints = {
        "0–3%": 1.5, "3–5%": 4.0, "5–8%": 6.5,
        "8–12%": 10.0, "12–20%": 16.0, "20–35%": 27.5, "35%+": 40.0,
    }
    churn_mid = bucket_midpoints.get(churn_floor, 5.0)
    ratio_result = compute_retention_ratio(churn_mid, ACQUISITION_EMISSION_APR)

    # Write summary
    lines = [
        "RETENTION RATIO ANALYSIS",
        "=" * 60,
        "",
        f"Data range:               {daily[0]['date']} → {daily[-1]['date']}",
        f"Acquisition emission APR: {ACQUISITION_EMISSION_APR}%",
        f"Seasoned threshold:       {SEASONED_THRESHOLD_DAYS}+ days",
        "",
        "CHURN FLOOR",
        "-" * 40,
        f"APR bucket where seasoned lenders withdraw at >20% higher",
        f"rate than new lenders: {churn_floor}",
        f"Midpoint APR used for ratio computation: {churn_mid}%",
        "",
        "RETENTION RATIO",
        "-" * 40,
        f"Raw ratio (churn_floor / acquisition_emission): {ratio_result['raw_ratio']}",
        f"Recommended retention ratio (capped at 1.0):   {ratio_result['recommended_ratio']}",
        f"As a percentage of acquisition cost:           {ratio_result['recommended_pct']}",
        "",
        "INTERPRETATION",
        "-" * 40,
        f"The protocol should emit {ratio_result['recommended_pct']} of its acquisition",
        f"emission rate to seasoned lenders to defend the {churn_floor} APR floor.",
        f"Below this floor, seasoned lenders exit at materially higher rates",
        f"than new entrants, indicating rate-sensitivity that retention emissions",
        f"must offset.",
        "",
        "NET FLOW BY APR BUCKET",
        "-" * 40,
    ]

    for bkt in bucket_order:
        if bkt not in flow_by_apr:
            continue
        v = flow_by_apr[bkt]
        pos_rate = v["pos_days"] / v["n_days"] * 100 if v["n_days"] > 0 else 0
        lines.append(f"  {bkt:<10}  net={v['net_M']:>10.1f}M  "
                     f"positive {pos_rate:.0f}% of days")

    lines += [
        "",
        "NOTE: Set ACQUISITION_EMISSION_APR to your actual modeled",
        "acquisition emission rate to get a calibrated ratio.",
        "The 50% heuristic is conservative — empirical data may support",
        "a lower ratio if seasoned lenders are stickier than expected.",
    ]

    with open(OUTPUT_TXT, "w") as f:
        f.write("\n".join(lines))
    print(f"\nSummary → {OUTPUT_TXT}")


if __name__ == "__main__":
    main()
