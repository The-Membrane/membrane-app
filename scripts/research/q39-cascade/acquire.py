"""Q39 acquisition driver. Resumable; every phase caches under --work.

  python3 acquire.py days     --chain ethereum
  python3 acquire.py aave     --market aave-core-eth [--phases discover,logs,state]
  python3 acquire.py morpho   --chain ethereum
  python3 acquire.py comet    --chain ethereum
"""
from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import blocks  # noqa: E402
from rpc import Client  # noqa: E402

WORK = os.environ.get("Q39_WORK", "/home/user/q39work")
START_TS = 1609459200      # 2021-01-01 (aid-test span start; v1 dev starts 2023-01-01)
DATA_END_TS = 1791244800   # 2026-10-06 00:00Z (DATA_END = 2026-10-06T03:00Z; last daily origin)


def day_path(chain):
    return os.path.join(WORK, "days", f"{chain}.json")


def load_days(chain, start=START_TS):
    p = day_path(chain)
    d = {int(k): v for k, v in json.load(open(p)).items()}
    return {k: v for k, v in d.items() if k >= start}


def end_block(chain):
    p = os.path.join(WORK, "days", f"{chain}-end.json")
    if os.path.exists(p):
        return json.load(open(p))["block"]
    c = Client(chain)
    b = blocks.last_block_at_or_before(c, DATA_END_TS, 1, c.block_number(), {})
    json.dump({"ts": DATA_END_TS, "block": b}, open(p, "w"))
    return b


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("what")
    ap.add_argument("--chain")
    ap.add_argument("--market")
    ap.add_argument("--phases", default="discover,logs,state")
    ap.add_argument("--start", type=int, default=START_TS)
    a = ap.parse_args()
    os.makedirs(os.path.join(WORK, "days"), exist_ok=True)
    if a.what == "days":
        c = Client(a.chain)
        d = blocks.day_blocks(c, a.start, DATA_END_TS, day_path(a.chain))
        print(a.chain, len(d), "days; rpc", c.n_requests)
    elif a.what == "aave":
        import aave
        w = os.path.join(WORK, a.market)
        os.makedirs(w, exist_ok=True)
        ph = a.phases.split(",")
        meta = aave.discover(a.market, w)
        print(a.market, "pool deployed", meta["pool_deploy_block"], "reserves", len(meta["reserves"]), flush=True)
        if "logs" in ph:
            aave.fetch_logs(meta, w, end_block(meta["chain"]))
        days = load_days(meta["chain"], 1672531200) if ("state" in ph or "replay" in ph) else None
        if "state" in ph:
            aave.daily_state(meta, w, days)
        if "replay" in ph:
            aave.replay(meta, w, days)
    elif a.what == "morpho":
        import morpho
        w = os.path.join(WORK, f"morpho-{a.chain}")
        os.makedirs(w, exist_ok=True)
        ph = a.phases.split(",")
        if "logs" in ph:
            morpho.fetch(a.chain, w, end_block(a.chain))
        am = {"ethereum": "aave-core-eth", "base": "aave-base"}[a.chain]
        ameta = json.load(open(os.path.join(WORK, am, "meta.json")))
        mk = morpho.markets(a.chain, w, ameta)
        print("morpho", a.chain, len(mk["markets"]), "markets kept; dropped", mk["dropped"], flush=True)
        days = load_days(a.chain, 1672531200) if ("state" in ph or "replay" in ph) else None
        if "state" in ph:
            morpho.daily_state(a.chain, w, days, mk, ameta["oracle"])
        if "replay" in ph:
            morpho.replay(a.chain, w, days, mk)
    elif a.what == "comet":
        import comet
        w = os.path.join(WORK, f"comet-{a.chain}")
        os.makedirs(w, exist_ok=True)
        ph = a.phases.split(",")
        meta = comet.discover(a.chain, w)
        print("comet", a.chain, {k[:8]: v["bsym"] for k, v in meta["comets"].items()}, flush=True)
        if "logs" in ph:
            comet.fetch(meta, w, end_block(a.chain))
        if "state" in ph or "replay" in ph:
            days = load_days(a.chain, 1672531200)
            hold = comet.holders_by_day(meta, w, days)
            if "state" in ph:
                comet.daily_state(meta, w, days, hold)
            if "replay" in ph:
                comet.replay(meta, w, days, hold)
    else:
        raise SystemExit("unknown " + a.what)


if __name__ == "__main__":
    main()
