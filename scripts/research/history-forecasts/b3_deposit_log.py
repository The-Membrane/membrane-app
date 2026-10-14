#!/usr/bin/env python3
"""Q26 B3.9 prospective record: a daily per-deposit forecast log, in the style of the Q26 live touch log.

PROPOSED ONLY. B3.9 says the log needs the owner's approval before it runs, so this script refuses to run
without --dry-run, writes only into the --out directory given, and schedules nothing. A dry run builds one issue
from the frozen B3 outputs (the final panel of results-holdout.json at block 26,186,746) so the format, the hash
chain and the refusal guards can be reviewed.

  python3 b3_deposit_log.py --b3-out DIR --out SCRATCH_DIR --dry-run

Issue file `issues/YYYY-MM-DD.json` (UTC date of issuedAt): issuedAt, asof block and time, input sha256 values,
code sha, prevFile / prevSha256 (genesis = 64 zeros), and one row per (reserve, unit, cell): number, segment,
shipped rung, label, holdout outcome, capped text, history count. `issues/chain.jsonl` appends one line per
issue. Scoring (for a future scorer, not built): a row resolves once events through asof + h are acquired; y per
B-gradient G.3 on the intraday event path from the asof anchor (y_all rows are history only and never scored).
Addresses are public on-chain data; no identity is attached.
"""
import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import b3_segments as S  # noqa: E402

GENESIS = "0" * 64


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def build_issue(panel_final, meta, issued_at):
    rows = []
    for reserve, units in panel_final.items():
        for u in units:
            for cid, cv in u["cells"].items():
                rows.append({"reserve": reserve, "rank": u["rank"], "address": u["address"], "segment": u["segment"],
                             "balance_usd": u["balance_usd"], "cell": cid,
                             "p": cv["p"], "capped": cv["capped"], "capped_text": cv["capped_text"], "rung": cv["rung"],
                             "display": cv["display"], "label": cv.get("label_final"),
                             "holdout_outcome": cv.get("holdout_outcome"), "history": cv["history"],
                             "status": "history_only" if cid.startswith("all_") else "pending"})
    return {"issuedAt": issued_at, **meta, "rows": rows, "n_rows": len(rows)}


def write_issue(out_dir, issue, now_utc):
    """Refusal guards: one issue per UTC day, never a later-or-same day twice, never a clock going backwards,
    and an unbroken hash chain. Returns the issue path."""
    idir = os.path.join(out_dir, "issues")
    os.makedirs(idir, exist_ok=True)
    day = now_utc[:10]
    path = os.path.join(idir, f"{day}.json")
    chain = os.path.join(idir, "chain.jsonl")
    prev_file, prev_sha = None, GENESIS
    existing = sorted(f for f in os.listdir(idir) if f.endswith(".json"))
    if existing:
        if existing[-1][:10] >= day:
            raise SystemExit(f"STOP: an issue for {existing[-1][:10]} exists (same or later day than {day}).")
        prev_file = existing[-1]
        with open(chain) as f:
            links = [json.loads(x) for x in f if x.strip()]
        expect = GENESIS
        if [ln["file"] for ln in links] != existing:
            raise SystemExit("STOP: hash chain broken (file list).")
        for ln in links:                                   # every link: file hash and back-pointer
            with open(os.path.join(idir, ln["file"]), "rb") as f:
                h = sha256_bytes(f.read())
            if ln["sha256"] != h or ln["prevSha256"] != expect:
                raise SystemExit(f"STOP: hash chain broken at {ln['file']}.")
            expect = h
        prev_sha = expect
        with open(os.path.join(idir, prev_file)) as f:
            prev_issued = json.load(f)["issuedAt"]
        if prev_issued >= now_utc:
            raise SystemExit("STOP: clock went backwards.")
    issue = dict(issue, prevFile=prev_file, prevSha256=prev_sha)
    data = (json.dumps(issue, indent=1, ensure_ascii=False, allow_nan=False) + "\n").encode()
    with open(path, "wb") as f:
        f.write(data)
    with open(chain, "a") as f:
        f.write(json.dumps({"file": os.path.basename(path), "sha256": sha256_bytes(data), "prevSha256": prev_sha}) + "\n")
    return path


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--b3-out", required=True, help="directory holding the B3 results-holdout.json")
    ap.add_argument("--out", required=True)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    if not a.dry_run:
        raise SystemExit("STOP: B3.9 — the per-deposit log needs the owner's approval before it runs; use --dry-run.")
    hp = os.path.join(a.b3_out, "results-holdout.json")
    hold = json.load(open(hp))
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    meta = {"mode": "dry-run", "asof": {"block": S.LIVE_ASOF_BLOCK, "ts": S.LIVE_ASOF_TS},
            "inputs_sha256": {"results-holdout.json": S.sha256_file(hp),
                              "shipped-b3.json": hold["frozen_sha256"], "results.json": hold["results_sha256"]},
            "code": {"b3_deposit_log_sha256": S.sha256_file(os.path.abspath(__file__)), **S.code_meta()},
            "prereg": S.PREREG}
    issue = build_issue(hold["panel_final"], meta, now)
    p = write_issue(a.out, issue, now)
    print(f"dry run: {issue['n_rows']} rows -> {p}")


if __name__ == "__main__":
    main()
