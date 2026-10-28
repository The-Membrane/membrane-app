"""Q26-P1 R3T forward shadow -- the daily runner around the registered logger (REGISTRATION.md section 6).

RECORD-ONLY. This file computes no rule decision, no sigma trigger, no liquidation and no outcome. It only:
  1. checks that shadow_log.py and fetch_cf_rates.py next to it are byte-identical to the registered code
     (membrane-datasets history-forecasts/p1-step2/code/CODE-SHA256SUMS, sha256 cc095f72...; REGISTRATION.md
     sha256 6d68e6c2...), and that the checkout is the pinned commit;
  2. refuses to run before T_REG (2026-11-02T00:00Z);
  3. finds the missing days: from the seed day (T_REG - 32 days, the sigma seed of section 6) or the day after the last
     logged day, through the last complete UTC day (a day counts as complete at 00:30Z of the next day);
  4. runs the registered logger once for that range, with `python -I`;
  5. checks the hash chain and the day sequence of log.jsonl before and after, and prints count-only lines.

Usage: python3 -I q26_r3t_shadow.py run --out <membrane-datasets root> [--expect-commit <full sha>]
Store: <out>/forecasts/q26-r3t-shadow/ ({ETH,BTC}USDT-1h.json, rates.json, log.jsonl; layout owned by shadow_log.py).
Exit codes: 0 ok or nothing to do; 2 refused (before T_REG, code mismatch, commit mismatch); 1 failure.
"""
import argparse, datetime as dt, hashlib, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
T_REG = dt.datetime(2026, 11, 2, tzinfo=dt.timezone.utc)   # REGISTRATION.md section 0 (moves only by the R9 rule)
SEED_DAY = (T_REG - dt.timedelta(days=32)).date()            # 2026-10-01; run_forward.sh uses the same seed
DAY_LAG = dt.timedelta(minutes=30)                           # "daily after 00:30Z for the previous day"
STORE_REL = os.path.join("forecasts", "q26-r3t-shadow")
REGISTRATION_SHA256 = "6d68e6c26bf93d79261870a279d0ed9e078670aa60fd2d8db1e5c17433d70ffa"
CODE_SUMS_SHA256 = "cc095f72bb0be4183a59e97fe071abede5f6b212788987dbe7370b2050e1736c"
REGISTERED = {  # the two lines of CODE-SHA256SUMS this runner executes (also in r3t_shadow_SHA256SUMS)
    "shadow_log.py": "1fba179b36cce35ebfd470bf1b3cddafcb418647856b98d58951fb188c4e31b0",
    "fetch_cf_rates.py": "981033da14a666b2dfc6f41736911e9614680f9b3a09cb9d6acc2302a983bbe1",
}
EMPTY_SHA = hashlib.sha256(b"").hexdigest()


class Refused(Exception):
    pass


def sha(b):
    return hashlib.sha256(b).hexdigest()


def check_code(here=HERE):
    for name, want in REGISTERED.items():
        got = sha(open(os.path.join(here, name), "rb").read())
        if got != want:
            raise Refused(f"{name} differs from the registered code")
    sums = {}
    for line in open(os.path.join(here, "r3t_shadow_SHA256SUMS")):
        h, name = line.split()
        sums[name] = h
    if sums != REGISTERED:
        raise Refused("r3t_shadow_SHA256SUMS differs from the registered hashes")


def check_commit(expect, here=HERE):
    if not expect:
        return
    head = subprocess.run(["git", "-C", here, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    if head != expect:
        raise Refused("checkout is not the pinned commit")


def last_complete_day(now):
    return (now - DAY_LAG).date() - dt.timedelta(days=1)


def read_chain(log_path):
    """Verify log.jsonl: prev = sha256(previous line) (sha256(b'') for the first), dates consecutive from SEED_DAY.
    Returns (records, last date or None). Raises ValueError on any break."""
    if not os.path.exists(log_path) or os.path.getsize(log_path) == 0:
        return 0, None
    lines = open(log_path, "rb").read().splitlines()
    prev, day = b"", None
    for i, line in enumerate(lines):
        rec = json.loads(line)
        if rec.get("prev") != sha(prev):
            raise ValueError(f"hash chain broken at record {i + 1}")
        d = dt.date.fromisoformat(rec["date"])
        want = SEED_DAY if day is None else day + dt.timedelta(days=1)
        if d != want:
            raise ValueError(f"record {i + 1} has date {d}, expected {want}")
        prev, day = line, d
    return len(lines), day


def plan(log_path, now):
    """Return (start, end) dates to log, or None when nothing is due. Raises Refused before T_REG."""
    if now < T_REG:
        raise Refused(f"before T_REG {T_REG:%Y-%m-%dT%H:%MZ}")
    _, last = read_chain(log_path)
    start = SEED_DAY if last is None else last + dt.timedelta(days=1)
    end = last_complete_day(now)
    return (start, end) if start <= end else None


def summarize(log_path, start):
    recs = [json.loads(l) for l in open(log_path, "rb").read().splitlines()]
    new = [r for r in recs if dt.date.fromisoformat(r["date"]) >= start]
    n = len(new)
    return (f"{n} days, ETH hours {sum(r['ETH_hours'] for r in new)}/{24 * n}, "
            f"BTC hours {sum(r['BTC_hours'] for r in new)}/{24 * n}, rate rows {sum(r['rate_rows'] for r in new)}, "
            f"rate misses {sum(len(r['rate_misses']) for r in new)}")


def run(out, expect_commit=None, now=None, runner=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    store = os.path.join(out, STORE_REL)
    log_path = os.path.join(store, "log.jsonl")
    check_code()
    check_commit(expect_commit)
    p = plan(log_path, now)
    if p is None:
        _, last = read_chain(log_path)
        print(f"r3t run: none (through {last} already logged)")
    else:
        start, end = p
        os.makedirs(store, exist_ok=True)
        cmd = [sys.executable, "-I", os.path.join(HERE, "shadow_log.py"), store, start.isoformat(), end.isoformat()]
        (runner or (lambda c: subprocess.run(c, check=True)))(cmd)
        n, last = read_chain(log_path)
        if last != end:
            raise ValueError(f"log ends at {last}, expected {end}")
        print(f"r3t run: logged {start}..{end}, {summarize(log_path, start)}")
    n, last = read_chain(log_path)
    print(f"r3t checks: chain {n} records verified, code sums ok")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["run"])
    ap.add_argument("--out", required=True)
    ap.add_argument("--expect-commit")
    a = ap.parse_args(argv)
    try:
        return run(a.out, a.expect_commit)
    except Refused as e:
        print(f"r3t run: refused ({e})")
        return 2


if __name__ == "__main__":
    sys.exit(main())
