"""Q26 leveraged/pegged instrument audit 2026-10-19: A6 on spent blind set 5 without its two instrument-fault pairs.

blind5 LUNAUSDT splices LUNA (Terra) and LUNA 2.0 (Binance relisted the ticker on 2022-05-31, x171,116 after a 438 h
gap); blind5 SUNUSDT carries the 1:1000 SUN redenomination of 2021-06-18 (97 h gap). A6 already reported the pooled
numbers without LUNA (A6 D1). This rerun of a6_touch.run_blind5 (frozen-a6.json, code unchanged since 712f1939)
sets the sensitivity exclusion to LUNA + SUN; the registered pooled block must reproduce the published one exactly.
Prediction CSVs are not written. usage: q26_audit_lev_a6.py <out_dir>
"""
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import a6_touch as A6  # noqa: E402

DS = os.environ.get("MEMBRANE_DATASETS", "/home/user/membrane-datasets")
RUN = f"{DS}/history-forecasts/a6/run-015512cb"


def main(out):
    os.makedirs(out, exist_ok=True)
    for f in ("frozen-a6.json", "frozen-a6.json.sha256", "results-dev.json"):
        shutil.copy(os.path.join(RUN, f), os.path.join(out, f))
    A6.SENSITIVITY_EXCLUDE = ("blind5:binance-LUNAUSDT", "blind5:binance-SUNUSDT")
    A6.write_rows = lambda *a, **k: None
    pub = json.load(open(os.path.join(RUN, "results-blind5.json")))
    A6.run_blind5(DS, out, {}, pub["blind5_commit"], workers=4, verify=False, require_clean=False)


if __name__ == "__main__":
    main(sys.argv[1])
