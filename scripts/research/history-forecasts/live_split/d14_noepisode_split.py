"""Q26-D14 follow-up (board MONITOR Q26-D14-LIVE1 "Next"): split the liquidated accounts that had no D14 episode by reason.
Ethereum only (the one chain with keyless archive state). Reads chain state with the D14 readers at two blocks per
liquidation: the block before the LiquidationCall and the D14 check block before it (from the public hourly lines).
PRINTS COUNTS ONLY. No address, hash or position key is printed or written. Membership in the D14 address list is
tested in memory and reported as a count.
Classes (first match wins): not_indexed, dust (debt < $100 at block-1), no_kstar (stable-only or pair: no downside
line), far_at_check (d = -k* > 10 % at the last D14 check), in_band_no_episode (0 < d <= 10 % at the check but no
episode state: a D14 gap), through_at_check (k* >= 0: already at or past the line at the check), unresolved (read failed)."""
import argparse, collections, datetime as dt, glob, gzip, json, os, sys, time
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(HERE, "..", "live"))
import q26_live_d14 as D   # noqa: E402

CFG = dict(D.CHAINS["ethereum"]); CFG["call"] = ["https://eth.drpc.org", "https://rpc.mevblocker.io"]; CFG["log"] = [("https://rpc.mevblocker.io", 50_000), ("https://eth.drpc.org", 10_000)]
POOL = CFG["pool"]


def hourly_checks(root):
    out = []
    for f in sorted(glob.glob(os.path.join(root, "aave-v3", "hourly", "*.jsonl"))):
        for l in open(f):
            r = json.loads(l); e = r.get("chains", {}).get("ethereum", {})
            if e.get("status") == "ok" and e.get("block"): out.append((r["c"], e["block"]))
    return sorted(out)


def d14_addresses(root):
    s = set()
    p = os.path.join(root, "private", "ethereum")
    for f in glob.glob(os.path.join(p, "addresses", "*")) + glob.glob(os.path.join(p, "addresses-bootstrap.txt.gz")) + [os.path.join(p, "active.txt")]:
        if not os.path.exists(f): continue
        op = gzip.open if f.endswith(".gz") else open
        for l in op(f, "rt"):
            l = l.strip().lower()
            if l.startswith("0x") and len(l) == 42: s.add(l)
    return s


def episode_keys(root):
    """position keys with any episode state or event (private; used for membership counts only)."""
    ks = set()
    for f in glob.glob(os.path.join(root, "private", "events", "*.jsonl")):
        for l in open(f):
            r = json.loads(l)
            if r.get("chain") == "ethereum": ks.add(r["key"])
    for l in open(os.path.join(root, "private", "ethereum", "state.jsonl")):
        ks.add(json.loads(l)["key"])
    return ks


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--root", required=True); ap.add_argument("--from-ts", type=int, default=1793390400)  # 2026-10-25 20:00Z
    ap.add_argument("--to-ts", type=int, default=None); ap.add_argument("--out"); ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    rpc = D.Rpc("ethereum", CFG, deadline=time.time() + 3 * 3600)
    head = rpc.head(); checks = hourly_checks(a.root)
    # block range of the window: first check block at/after from-ts, to head
    blo = next(b for c, b in checks if c >= a.from_ts); bhi = head if a.to_ts is None else next(b for c, b in checks if c >= a.to_ts)
    logs = rpc.logs(POOL, [D.TOPIC["LiquidationCall"]], blo, bhi)
    calls = [(int(x["blockNumber"], 16), D.topic_addr(x["topics"][3])) for x in logs]
    if a.limit: calls = calls[:a.limit]
    addrs = d14_addresses(a.root); ep = episode_keys(a.root)
    users = sorted({u for _, u in calls})
    res = {"window_blocks": [blo, bhi], "liquidation_calls": len(calls), "distinct_accounts": len(users), "repeat_calls": len(calls) - len(users), "classes": collections.Counter(),
           "classes_debt_usd": collections.Counter(), "by_asset_in_band": collections.Counter(), "had_episode_state": 0, "notes": []}
    first_block = {}
    for b, u in sorted(calls):
        first_block.setdefault(u, b)
    cache = {}; mcache = {}
    for u in users:
        b = first_block[u]
        if u not in addrs:
            res["classes"]["not_indexed"] += 1; continue
        key = D.pos_key("ethereum", u)
        if key in ep: res["had_episode_state"] += 1; continue      # these are the 104 "had an episode" accounts; not split here
        cb = max((blk for c, blk in checks if blk < b), default=None)
        try:
            cls = None; dbt = None; asset = None
            for tag, blk in (("liq", b - 1), ("check", cb)):
                if blk is None: continue
                if blk not in mcache: mcache[blk] = D.read_market(rpc, CFG, blk, cache)
                m = mcache[blk]; det = D.read_details(rpc, m, POOL, [u], blk).get(u)
                if det is None: cls = "unresolved"; break
                pm = D.position_metrics(m, det)
                if tag == "liq":
                    dbt = pm["debt_usd"]; asset = pm["asset"]
                    if dbt < D.MIN_DEBT_USD: cls = "dust"; break
                    if pm["kstar"] is None or pm["asset"] == "stable-only": cls = "no_kstar"; break
                else:
                    k = pm["kstar"]
                    if pm["debt_usd"] < D.MIN_DEBT_USD: cls = "dust_at_check"
                    elif k is None: cls = "no_kstar_at_check"
                    elif k >= 0: cls = "through_at_check"
                    elif -k > 0.10: cls = "far_at_check"
                    else: cls = "in_band_no_episode"; res["by_asset_in_band"][pm["asset"]] += 1
            if cls is None: cls = "no_check_block"
        except Exception as e:
            cls = "unresolved"; res["notes"].append(D.ADDR_RE.sub("0x?", str(e))[:120])
        res["classes"][cls] += 1
        if dbt: res["classes_debt_usd"][cls] += round(dbt)
    res["classes"] = dict(res["classes"]); res["classes_debt_usd"] = dict(res["classes_debt_usd"]); res["by_asset_in_band"] = dict(res["by_asset_in_band"]); res["notes"] = res["notes"][:5]
    print(json.dumps(res, indent=1))
    if a.out: json.dump(res, open(a.out, "w"), indent=1)


if __name__ == "__main__":
    main()
