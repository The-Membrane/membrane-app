# Deterministic validation of the original fH range bootstrap

This is a small algorithm instrument, independent of R17 forecasts. It checks the original `fh_boot` from frozen commit `6aa64254073119c76f2b9e7a713abd601756d872`; it makes no calibration, coverage, market-performance or forecast-validity claim.

## Subject and independence boundary

`validate_fh_boot.py:load_subject` verifies source HEAD, whole-file SHA256, exact function source SHA256 and function AST SHA256 against `source-pins.json`. It compiles the *original parsed function node*, not a rewritten helper. Only NumPy, builtins, and source-literal `BOOT_B=20` / `BOOT_BLOCK_H=720` enter the execution namespace. It never imports the research module, Torch or Numba, opens market data, writes source caches, or fits a market model. Original function source lines are 369–413. Interface construction follows `a6_touch.py:571–605` (Prep6) and `a2_touch.py:543–572` (PrepT/thresholds), inspected read-only.

```
pinned original AST                     independent oracle
fh_boot                                 literal eligible-origin loop
  calendar block XtX/Xty                  literal integer row duplication
  weighted solve                         np.linalg.lstsq on duplicated rows
  restandardize original depths          restandardize duplicated depths
  weighted sorted ECDF                   count(z <= threshold) / count(z)
                 └──── compare every B × origin × barrier ────┘
```

## Fixture

32 calendar blocks each span 720 row positions; each contributes 64 valid rows, leaving 656 gaps. Each block has one exact Hadamard design state; the four states cycle across blocks, so the global design is full rank and a one-block draw has exactly rank one. Log future sigma has a deterministic block residual `(block - 15)/128` in addition to a fixed linear state component; bootstrap fits are deliberately weight-sensitive. Tests explicitly require different valid replicate predictions.

There are four valid held-out state origins after `qs`, plus one invalid held-out origin. `T_h=24`, and the last eligible origin lies *exactly* at `qs - 24`. Additional valid origins immediately after that mature cutoff are poison candidates: the helper must exclude them even when their index precedes `qs`. Negative barriers divide by sigma times scale, matching the source threshold contract.

The default run exercises 20 fixed multinomial-return vectors (each integer, nonnegative, length 32, sum 32). One is all ones; nineteen select four consecutive full-rank state blocks with weights 2/6/10/14. The RNG stub validates the original call's `nb=32` and uniform probability vector. This distinguishes calendar blocks from packed eligible-row blocks.

## Six checks

1. Every entry of the default `(20, 5, 5)` prediction tensor matches the independent oracle within absolute `1e-14`, with identical NaN locations. All four valid states produce finite values; invalid origins remain NaN; valid replicates differ.
2. A singular first draw remains entirely NaN; a following valid draw still computes and matches the oracle.
3. 49 eligible rows return `None` without requesting a random draw.
4. Mutating all depths and future-log-sigma values strictly after the mature cutoff changes no output; held-out design rows remain fixed.
5. The row exactly at the mature cutoff is included: changing its depth changes predictions and matches the inclusive oracle.
6. Exact ECDF ties count as hits. Zero regression targets yield exact sigma one; equal depth/barrier values avoid cross-solver floating-point ambiguity.

## Reproduce

```sh
OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 PYTHONDONTWRITEBYTECODE=1 /Users/EBmic/research-workspaces/history-forecasts-recovery-runtime/bin/python /Users/EBmic/research-workspaces/history-forecasts-recovery-evidence/r16-fh-bootstrap-validation-v1/validate_fh_boot.py
```

The script refuses to start below 2 GiB free disk, limits CPU time to 30 seconds, and asserts elapsed time below 30 seconds and peak RSS below 500 MiB. Its fixed fixture requires only tens of MiB and writes no test artifacts. `test-results.txt` captures the local run, including measured runtime/RSS. All checks are deterministic; repeated-world Monte Carlo, source acquisition, datasets, R17 integration and publication are out of scope.

No source repository, shared board, app file, or dataset was edited. Parent review and rerun remain required before acceptance.
