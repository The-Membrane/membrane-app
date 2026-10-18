#!/usr/bin/env python3
"""Replay one live issue file offline with a given code checkout (HISTORY_TOUCH_LIVE.md D8 check).

  python3 replay_issue.py --code-dir <scripts/research/history-forecasts of any pin> --datasets <root> --out <file>
      [--file YYYY-MM-DD.json] [--short-fh]

Copies the live dir to a temp root, removes the replayed file (and later ones) with their chain lines, cuts every
round/Binance store to the byte length the issue recorded (append-only gzip members, sha256 re-checked) and the
round fetch log to the coverage it recorded, then calls that checkout's q26_live_issue.issue at the recorded
issuedAt with the recorded flags, code meta and store-update record. Writes the new issue bytes to --out. Reads
--datasets only. Running the old pin and the new pin in the same environment shows whether the new code changes
any existing byte (OpenBLAS kernels differ across CPUs, so a runner-made file can differ in the last bits).
"""
import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
from unittest import mock

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--code-dir", required=True)
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--file", default=None, help="issue file to replay (default: the last one)")
    ap.add_argument("--short-fh", action="store_true")
    a = ap.parse_args(argv)
    sys.path.insert(0, os.path.join(os.path.abspath(a.code_dir), "live"))
    import q26_live_common as C
    import q26_live_issue as I
    real = os.path.join(a.datasets, C.LIVE_REL)
    files = C.list_issue_files(os.path.join(real, C.ISSUES_SUB))
    names = [n for _, n in files]
    name = a.file or names[-1]
    pos = names.index(name)
    with open(os.path.join(real, C.ISSUES_SUB, name), "rb") as f:
        old = json.loads(f.read())
    with tempfile.TemporaryDirectory() as tmp:
        for d in ("price-history", "deribit-dvol", "binance-klines", "history-forecasts"):
            os.symlink(os.path.realpath(os.path.join(a.datasets, d)), os.path.join(tmp, d))
        ldir = os.path.join(tmp, C.LIVE_REL)
        shutil.copytree(real, ldir)
        for n in names[pos:]:
            os.remove(os.path.join(ldir, C.ISSUES_SUB, n))
        chain = os.path.join(ldir, C.ISSUES_SUB, "chain.jsonl")
        with open(chain, "rb") as f:
            lines = f.read().splitlines(keepends=True)
        with open(chain, "wb") as f:
            f.write(b"".join(lines[:pos]))
        for meta in list(old["inputs"]["roundStores"].values()) + list(old["inputs"]["binanceStores"].values()):
            p = os.path.join(ldir, meta["path"])
            with open(p, "rb") as f:
                b = f.read()[:meta["bytes"]]
            if hashlib.sha256(b).hexdigest() != meta["sha256"]:
                raise SystemExit(f"STOP: store prefix of {meta['path']} does not match the issue record")
            with open(p, "wb") as f:
                f.write(b)
        cov = {x: m["coveredThrough"] for x, m in old["inputs"]["roundStores"].items()}
        flog = os.path.join(ldir, C.ROUNDS_SUB, "fetch-log.jsonl")
        with open(flog, "rb") as f:
            keep = [ln for ln in f.read().splitlines(keepends=True)
                    if not (json.loads(ln).get("kind") == "chainlink"
                            and int(json.loads(ln)["coveredThrough"]) > cov[json.loads(ln)["asset"]])]
        with open(flog, "wb") as f:
            f.write(b"".join(keep))
        upd = ({"rpc": old["rpc"], **old["storeUpdates"]}, old["storeUpdateErrors"])
        inp = old["inputs"]

        def pair(k):
            return (inp[k]["path"], inp[k]["sha256"]) if k in inp else None
        kw = dict(frozen_a5=pair("frozenA5"), basis_final=pair("basisFinal"), frozen_a6=pair("frozenA6"),
                  basis_final_a6=pair("basisFinalA6"), display_a6=pair("displayA6"))
        if a.short_fh:
            kw["short_fh"] = True
        with mock.patch.object(C, "update_all_stores", lambda *x, **k: upd):
            path, _, _ = I.issue(tmp, tmp, None, clock=lambda: old["issuedAt"], code=old["code"],
                                 log=lambda *x: None, **kw)
        with open(path, "rb") as f:
            raw = f.read()
    with open(a.out, "wb") as f:
        f.write(raw)
    print(f"replayed {name}: {len(raw)} bytes, sha256 {hashlib.sha256(raw).hexdigest()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
