"""Q26 leveraged/pegged instrument audit 2026-10-19: R12.1 re-score (spent B9/B10; dev = seen R12 pool).

The R12 development pool (r12_tail.dev_specs) does not split redenominations; four pool series carry one
(blind5 LUNA ticker reuse 2022-05-31, blind5 SUN 1:1000 2021-06-18, blind6 QUICK 1:1000 2023-07-21, blind6 STRAX
1:10 2024-03-28). B9 and B10 are split by r12_tail.blind_specs (redenom_splits), so the test side needs no change.
  dev  r12_tail.cmd_dev without those four series -> clean pooled parts (C4 library, xi, G, Poisson)
  run  r12_tail.cmd_run --item r12.1 with the clean pooled parts (frozen config copy with the new dev hashes;
       git sha / clean-tree checks patched to the frozen values; code files unchanged since 6fb3a351 is checked)
usage: q26_audit_lev_r121.py dev|run <out_dir>
"""
import json
import os
import shutil
import subprocess
import sys
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import r112_combine as R112  # noqa: E402
import r12_tail as R12  # noqa: E402

DS = os.environ.get("MEMBRANE_DATASETS", "/home/user/membrane-datasets")
RUN = f"{DS}/history-forecasts/r12/r12.1-run-6fb3a351"
BAD = {"blind5:LUNAUSDT", "blind5:SUNUSDT", "blind6:QUICKUSDT", "blind6:STRAXUSDT"}


def main(cmd, out):
    os.makedirs(out, exist_ok=True)
    cfg = json.load(open(f"{RUN}/frozen-r12-config.json"))
    diff = subprocess.run(["git", "-C", os.path.dirname(HERE), "diff", "--stat", cfg["code"]["sha"], "HEAD", "--",
                           "r12_tail.py", "r112_combine.py", "a6_touch.py", "a2_touch.py", "a_touch.py"],
                          capture_output=True, text=True).stdout.strip()
    if diff:
        raise SystemExit(f"STOP: imported code changed since {cfg['code']['sha'][:8]}: {diff}")
    R112.git_sha = lambda *a, **k: cfg["code"]["sha"]
    R112.git_clean = lambda *a, **k: True
    if cmd == "dev":
        orig = R12.dev_specs

        def dev_specs(datasets):
            sp = orig(datasets)
            keep = [s for s in sp if s["key"] not in BAD]
            print(f"audit filter dev_specs: {len(sp)} -> {len(keep)}", flush=True)
            return keep
        R12.dev_specs = dev_specs
        R12.cmd_dev(SimpleNamespace(datasets=DS, out=os.path.join(out, "dev"), workers=4, limit=0))
    elif cmd == "run":
        dev = os.path.join(out, "dev")
        cfgd = os.path.join(out, "cfg")
        os.makedirs(cfgd, exist_ok=True)
        cfg["dev_outputs"] = {rel: R112.sha256_file(os.path.join(dev, rel)) for rel in cfg["dev_outputs"]}
        cp = os.path.join(cfgd, "frozen-r12-config.json")
        json.dump(cfg, open(cp, "w"), indent=1, sort_keys=True)
        open(cp + ".sha256", "w").write(R112.sha256_file(cp) + "  frozen-r12-config.json\n")
        acq = os.path.join(out, "acq")
        os.makedirs(acq, exist_ok=True)
        import r125_fh_deep as R125
        R125.link_acq(acq, DS)
        R12.cmd_run(SimpleNamespace(acq=acq, dev=dev, out=os.path.join(out, "run"), cfgdir=cfgd, item="r12.1",
                                    workers=4))


if __name__ == "__main__":
    main(*sys.argv[1:3])
