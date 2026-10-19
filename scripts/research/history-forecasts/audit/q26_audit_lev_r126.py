"""Q26 leveraged/pegged instrument audit 2026-10-19: R12.6 re-score on spent B13a with the frozen config, without the
contaminated B13a series ((fH-A) and its comparators use each series' own history; (e) is a frozen Binance-dev
constant, so the frozen run without those series is the whole re-score).
usage: q26_audit_lev_r126.py <exclusions.json> <out_dir> [all]
"""
import json
import os
import sys
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import r126_twap as M  # noqa: E402

DS = os.environ.get("MEMBRANE_DATASETS", "/home/user/membrane-datasets")


def main(exfile, out, mode="clean"):
    bad = set(json.load(open(exfile))["B13a"]) if mode == "clean" else set()
    orig = M.b13_specs

    def b13_specs(acq, set_name):
        sp = orig(acq, set_name)
        keep = [s for s in sp if s["key"].replace("USDT", "") not in bad]
        print(f"audit filter {set_name}: {len(sp)} -> {len(keep)}", flush=True)
        return keep
    M.b13_specs = b13_specs
    M.cmd_run(SimpleNamespace(acq=f"{DS}/b13-kucoin-prices/b13a",
                              cfgdir=f"{DS}/history-forecasts/r12/r126-run-65ab9f63", out=out, workers=3))


if __name__ == "__main__":
    main(*sys.argv[1:])
