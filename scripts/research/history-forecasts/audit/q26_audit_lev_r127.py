"""Q26 leveraged/pegged instrument audit 2026-10-19: R12.7 re-score on spent B13b (dev: seen B13a).

modes
  frozen-clean   frozen lookup, B13b without the contaminated series (r127_alert.cmd_run, specs filtered)
  devclean       r127_alert.cmd_dev on B13a without its contaminated series -> clean lookup + B13a reference precision
  refit-clean    clean lookup applied to clean B13b
usage: q26_audit_lev_r127.py <mode> <exclusions.json> <out_dir>
"""
import json
import os
import shutil
import sys
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import r127_alert as M  # noqa: E402

DS = os.environ.get("MEMBRANE_DATASETS", "/home/user/membrane-datasets")
CFG = f"{DS}/history-forecasts/r12/r127-run-0c2da9d2"
DEVD = f"{DS}/history-forecasts/r12/r127-dev-0c2da9d2"


def patch(bad):
    orig = M.acq_specs

    def acq_specs(acq, manifest):
        sp = orig(acq, manifest)
        keep = [s for s in sp if s["key"].replace("USDT", "") not in bad]
        print(f"audit filter {manifest}: {len(sp)} -> {len(keep)} series", flush=True)
        return keep
    M.acq_specs = acq_specs


def main(mode, exfile, out):
    ex = json.load(open(exfile))
    os.makedirs(out, exist_ok=True)
    if mode in ("frozen-clean", "frozen-all"):
        patch(set(ex["B13b"]) if mode == "frozen-clean" else set())
        M.cmd_run(SimpleNamespace(acq=f"{DS}/b13-kucoin-prices/b13b", cfgdir=CFG, out=out, workers=4))
    elif mode == "devclean":
        patch(set(ex["B13a"]))
        dv = json.load(open(f"{DEVD}/dev-r127.json"))
        M.cmd_dev(SimpleNamespace(b13a=f"{DS}/b13-kucoin-prices/b13a", binance=None, out=out, workers=4,
                                  weeks_b13b=132))
    elif mode == "refit-clean":
        patch(set(ex["B13b"]))
        cfgd = os.path.join(out, "cfg")
        os.makedirs(cfgd, exist_ok=True)
        lk_src = os.path.join(os.path.dirname(out.rstrip("/")), "r127-devclean", "lookup-r127.json")
        shutil.copy(lk_src, os.path.join(cfgd, "lookup-r127.json"))
        cfg = json.load(open(f"{CFG}/frozen-r127-config.json"))
        cfg["inputs"]["lookup_sha256"] = M.sha_file(os.path.join(cfgd, "lookup-r127.json"))
        json.dump(cfg, open(os.path.join(cfgd, "frozen-r127-config.json"), "w"), indent=1)
        M.cmd_run(SimpleNamespace(acq=f"{DS}/b13-kucoin-prices/b13b", cfgdir=cfgd, out=out, workers=4))


if __name__ == "__main__":
    main(*sys.argv[1:4])
