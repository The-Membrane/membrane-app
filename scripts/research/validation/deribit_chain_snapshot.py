#!/usr/bin/env python3
"""T5.2 -- raw Deribit option-chain snapshot (ETH, BTC).

Implements triccs/membrane-board `design/VALIDATION_PREREG.md` (commit 506e7c5), T5.2, in the layout
of membrane-datasets `deribit-chain/PROVENANCE.md`:

  <out>/deribit-chain/YYYY-MM-DD/<endpoint>_<ASSET>_<YYYYMMDDTHHMMSSZ>.json.gz

endpoint  = book         public/get_book_summary_by_currency?currency=<ASSET>&kind=option
            instruments  public/get_instruments?currency=<ASSET>&kind=option&expired=false
            index        public/get_index_price?index_name=<asset>_usd
Content = the raw response bytes, gzipped (mtime 0, no embedded name). No transformation. One capture
time (UTC seconds at run start) names all six files. All six responses are fetched and checked
(JSON with a `result`) before anything is written. A file is never overwritten. One row
(file, bytes, sha256) per file is appended to <out>/deribit-chain/YYYY-MM-DD/MANIFEST.md.

  python3 deribit_chain_snapshot.py --out <dir> [--commit]
"""
import argparse
import gzip
import io
import json
import os
import sys
import time

from t5_common import (code_provenance, commit_and_push, compact_stamp, get_with_retry, iso, repo_relpaths,
                       require_clean_code, sha256_bytes, utc_date, write_exclusive, _git)

API = "https://www.deribit.com/api/v2/public/"
ASSETS = ("ETH", "BTC")


def endpoints(asset):
    return [
        ("book", f"{API}get_book_summary_by_currency?currency={asset}&kind=option"),
        ("instruments", f"{API}get_instruments?currency={asset}&kind=option&expired=false"),
        ("index", f"{API}get_index_price?index_name={asset.lower()}_usd"),
    ]


def gzip_bytes(raw):
    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buf, mtime=0) as gz:
        gz.write(raw)
    return buf.getvalue()


MANIFEST_HEAD = ("# deribit-chain/{date} -- manifest\n\n"
                 "Raw Deribit public REST responses, gzipped, written by membrane-app "
                 "`scripts/research/validation/deribit_chain_snapshot.py` (prereg T5.2). "
                 "Capture time (UTC) is in each file name.\n\n"
                 "| file | bytes | sha256 |\n|---|---:|---|\n")


def snapshot(out_dir, get=None, clock=time.time, log=print):
    ts = int(clock())
    date, stamp = utc_date(ts), compact_stamp(ts)
    day_dir = os.path.join(out_dir, "deribit-chain", date)
    planned = []
    for asset in ASSETS:
        for name, url in endpoints(asset):
            fname = f"{name}_{asset}_{stamp}.json.gz"
            path = os.path.join(day_dir, fname)
            if os.path.exists(path):
                raise SystemExit(f"STOP: {path} exists; never overwritten")
            planned.append((fname, path, url))
    fetched = []
    for fname, path, url in planned:  # fetch + check everything before writing anything
        raw = get_with_retry(url, get=get)
        doc = json.loads(raw)
        if "result" not in doc or doc.get("error"):
            raise SystemExit(f"STOP: {fname}: Deribit returned no result (error: {doc.get('error')})")
        fetched.append((fname, path, gzip_bytes(raw)))
    os.makedirs(day_dir, exist_ok=True)
    manifest = os.path.join(day_dir, "MANIFEST.md")
    rows = []
    for fname, path, gz in fetched:
        try:
            write_exclusive(path, gz)
        except FileExistsError:
            raise SystemExit(f"STOP: {path} appeared during the run; not overwritten")
        rows.append((fname, len(gz), sha256_bytes(gz)))
    new = not os.path.exists(manifest)
    with open(manifest, "a") as f:
        if new:
            f.write(MANIFEST_HEAD.format(date=date))
        for fname, n, sha in rows:
            f.write(f"| `{fname}` | {n} | `{sha}` |\n")
    log(f"snapshot {iso(ts)}: {len(rows)} files -> {day_dir}")
    return ts, [os.path.join(day_dir, r[0]) for r in rows] + [manifest], rows


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="root that receives deribit-chain/ (the datasets repo for a "
                                                 "real snapshot)")
    ap.add_argument("--commit", action="store_true", help="git add/commit/push the new files + MANIFEST.md")
    a = ap.parse_args(argv)
    if a.commit:
        require_clean_code(code_provenance(__file__, ["t5_common.py"]))
        _git(a.out, "rev-parse", "--show-toplevel")
    ts, paths, rows = snapshot(a.out)
    for fname, n, sha in rows:
        print(f"  {fname} {n} {sha}")
    if a.commit:
        commit_and_push(a.out, repo_relpaths(a.out, paths), f"deribit-chain: snapshot {iso(ts)} (Q25)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
