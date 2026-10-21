# Repeated-world experiment — DRAFT, not executed

Parent scientific review and an explicit freeze are required before execution. This document proposes a P6-interface surrogate, **not an OHLC path law**. Known-answer parity establishes implementation agreement only; it supplies no interval-coverage guarantee.

## Frozen candidate law

Each of 64 independent worlds has 32 iid blocks. Block b has 64 valid hourly origins (16 repetitions of each of the four Hadamard rows X) within a 720-position calendar block. All four states occur in every block; training blocks are identically distributed conditional on this balanced fixed design. Gaps are invalid. A 24-hour maturity horizon includes the final valid training origin at the cutoff; four test origins lie after qs.

```
U_b ~ N(0, 0.125² I_4)       E_b,r ~ Exp(rate=1)
          independent across blocks and independent of all E
lfut_b,r = X_r β + X_r U_b   depth_b,r = -exp(X_r β) × 0.5 × E_b,r

β = (log(0.08), 0.0625, -0.03125, 0.015625)
a = log1p((-0.02, -0.10, -0.20))  [shallow → deep]
true p(X,a) = exp(a / (exp(X β) × 0.5))
```

The Gaussian coefficient shock perturbs the noisy log-future-sigma regression target and is shared within a block. The depth innovation is conditionally independent of that shock. Consequently truth uses the fixed beta, **never a world OLS fit**. This is deliberately a regression-target/depth surrogate rather than a claim that independently generated targets and depths arise from one price path.

The source subject remains the exact original `fh_boot` AST loaded by the accepted deterministic instrument. The point estimate invokes the same function with all-one block weights and B=1, equivalent to the original unweighted regression/ECDF plug-in prediction. No helper rewrite is used as the subject.

## Paired bootstrap resolution sensitivity

Each world uses PCG64 world seed `2026102000+j` and independent bootstrap seed `2026103000+j`, j=0…63. The complete literal seed list is saved in `seed-plan.json` before execution. Every world gets 200 multinomial block-count vectors; original default B20 uses the first 20, and B200 uses all 200. The script asserts equality of the matched first 20 raw predictions. B20 versus B200 measures bootstrap Monte Carlo resolution sensitivity; it is not a method-winner comparison.

Caller source lines 507–526 apply `minimum.accumulate` along shallow-to-deep barriers, then `nanquantile` at .05/.25/.5/.75/.95 and `nanstd`. `caller-pins.json` hashes exactly those source lines and records that source provenance. The draft reproduces this packaging, including its NaN handling. The earlier deterministic fixture orders barriers differently because it tests `fh_boot` alone; it is unchanged.

## Retention and estimands

Retain every world, all four states, all three barriers, both complete raw replicate tensors, all block weights, block shocks, exponential innovations, seeds, true probabilities, point estimates, five packaged quantiles and bootstrap standard deviations. Nonfinite/singular raw replicates remain present. A world is never discarded because its interval is unavailable. Inclusion over all worlds counts unavailable intervals as no; interval availability is also reported explicitly. Width remains NaN when unavailable, making unavailability visible rather than silently averaging it away.

Report point bias, RMSE, MSE, .05/.95 interval inclusion and width for each fixed state/barrier cell, plus mean inclusion/width over the 12 fixed cells per world. Standard errors use independent worlds: sample SD/sqrt(world count). RMSE gets a delta-method world SE from squared-error variation. The 12 within-world cells do not multiply the effective number of worlds. These are Monte Carlo descriptive estimates with coarse uncertainty at W=64; no nominal coverage certification or finite-group coverage claim is tested. Report the raw available-world count beside each result.

## Budget stages and stop policy

First authorize **8 worlds only**, using the first eight prelisted seeds, to measure budget. Before any outcomes are observed, fix this resource-only gate: let t8 be the measured complete stage-8 invocation elapsed time, including startup. Project full-64 runtime as **8 × t8**, conservatively charging startup eight times. Advance eligibility requires **8 × t8 ≤ 96 seconds** (20% headroom below the 120-second cap), sampled peak RSS **strictly below 500 MiB**, and free disk **at least 2 GiB**. Forecast values, coverage values, and B20-versus-B200 metric values **must not affect this gate**. Passing the gate does not authorize execution: the parent must explicitly admit the full stage after auditing actual pilot resources. The full stage uses all 64 prelisted seeds, including the same first eight, and the unchanged law and metrics. No parameter/seed search, statistical early stopping or results-based tuning is allowed. A resource abort is recorded as partial evidence, never a completed scientific result.

Each invocation has an internal 120-second wall alarm, 120-second CPU limit, 500 MiB observed peak-RSS guard and 2 GiB free-disk reserve check before each world. The internal clock starts after imports; it is diagnostic and does not supply gate t8. The parent externally times the complete invocation, including startup/imports and final summary/manifest writes, and retains that wrapper receipt for the resource gate. The manifest retains each sampled RSS/free-disk observation, their observed peak/minimum, exact source/script/spec/helper/caller-pin/seed-plan hashes, and Python/NumPy/platform/thread metadata. Small input files are saved before a world starts; raw B20/B200 are saved as soon as each subject call returns; completed output records survive later failure. A mid-call abort preserves the current world's inputs and earlier completed calls. No packages, data acquisition, heavy parallel work or source edits are needed.

## Review-only commands

Do not run the draft until the parent approves the law and freezes the exact spec/script hashes. After approval, the parent supplies the SHA256 of `repeated-world-spec.json`:

```sh
OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 PYTHONDONTWRITEBYTECODE=1 /Users/EBmic/research-workspaces/history-forecasts-recovery-runtime/bin/python /Users/EBmic/research-workspaces/history-forecasts-recovery-evidence/r16-fh-bootstrap-validation-v1/repeated_world_draft.py --stage 8 --approved-freeze-sha256 <PARENT_APPROVED_SPEC_HASH>
```

Stage 64 is a separate parent decision. Existing output directories cannot be overwritten. The draft has passed four bounded unit tests (0.065 seconds), using only explicit fixture seeds 991001/992001 outside both registered seed ranges. The tests check analytic truth and depth independence from regression noise, scale and barrier ordering, matched weight prefixes without subject calls, and exact caller packaging/NaN scope without input mutation. These checks do not estimate statistical coverage. No registered world, budget pilot or full bootstrap sensitivity run has been executed.

## Analytic truth before any registered world

The intercept was changed once, before generating any registered world, from -0.125 to log(0.08). This fixed surrogate places mean depth magnitude near 4%, so the declared barriers span central and rare outcomes. It is not parameter search or an OHLC claim. `analytic-truth.json` retains unrounded analytic values.

| Hadamard state | sigma | mean depth magnitude | p(-2%) | p(-10%) | p(-20%) |
|---|---:|---:|---:|---:|---:|
| (1,1,1,1) | .08383928 | .04191964 | .61758476 | .08099299 | .00487748 |
| (1,1,-1,-1) | .08650062 | .04325031 | .62681036 | .08750462 | .00574543 |
| (1,-1,1,-1) | .07171154 | .03585577 | .56924537 | .05294754 | .00198256 |
| (1,-1,-1,1) | .07875971 | .03937986 | .59868401 | .06887290 | .00346017 |

Bounded unit command (does not call fh_boot or generate any registered seed):

```sh
OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 PYTHONDONTWRITEBYTECODE=1 /Users/EBmic/research-workspaces/history-forecasts-recovery-runtime/bin/python /Users/EBmic/research-workspaces/history-forecasts-recovery-evidence/r16-fh-bootstrap-validation-v1/test_repeated_world_draft.py
```
