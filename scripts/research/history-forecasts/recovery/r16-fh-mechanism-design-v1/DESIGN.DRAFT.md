# Prospective fH mechanism diagnostic — DRAFT, not executed

This proposes one paired 2×2 synthetic diagnostic of the existing event-probability procedure. It is not an executable or admitted protocol, a model-winner test, an OHLC path law, or evidence of market performance. Original `r164_recursive.py` `fh_boot` lines 369–413 and caller packaging lines 507–526 remain the subject, unchanged.

## Fixed proposed factors and common innovations

Retain the prior balanced four-state Hadamard design, beta `(log(.08), .0625, -.03125, .015625)`, 32 independent calendar blocks, 64 valid origins per block, horizon 24, scale .5, and barriers −2%, −10%, −20%.

Cross HAR regression-target block-noise SD `{0, .125}` with depth shape `{homogeneous, heterogeneous}`. Within world j, draw independent standard-normal block coefficient shocks Z, independent origin innovations E ~ Exp(mean 1), and independent origin uniforms U. Share these literal arrays across all four conditions. Regression target is `X beta + noise_SD * X Z_block`; noise-zero removes stochastic coefficient noise while original weighted refitting still executes.

For homogeneous depths, innovation V=E. For heterogeneous depths, states 0 and 2 retain V=E; states 1 and 3 use V=M*E, with M=.25 when U<.5 and M=1.75 otherwise. Thus heterogeneous V is an equal mixture of exponentials with means .25 and 1.75, still mean one. Depth is `-exp(X beta)*.5*V`. Depth and coefficient-shock innovations are independent. This is a declared interface surrogate, not a claim these independently generated targets and depths arise from one price path.

Each world gets one shared 200-vector multinomial bootstrap-weight sequence. Every condition runs original B20 with the first 20 vectors and B200 with all 200; assert matched-prefix raw predictions equal. Use the original all-one-weight point estimate and unchanged monotone/quantile/SD packaging. Keep every condition, state, barrier, replicate, unavailable interval and failed-stage record.

## Known event truth and pooling discrepancy

Let `t=-log1p(k)/(exp(X beta)*.5)` for negative barrier k. Conditional hit probability is `exp(-t)` for homogeneous states, and `.5*exp(-t/.25)+.5*exp(-t/1.75)` for heterogeneous states 1 and 3. It always uses fixed beta, never a realized fitted coefficient.

Under heterogeneous shape and equal state frequencies, the population pooled standardized-depth survival is

```
S_pool(t) = .5*exp(-t) + .25*exp(-t/.25) + .25*exp(-t/1.75).
```

This corrected .5/.25/.25 mixture supplies an analytic pooling-asymptote discrepancy against each state's known conditional truth. In the noise-zero condition, the balanced design makes every weighted regression coefficient beta up to floating arithmetic; finite ECDF sampling remains. With increasing independent blocks, the noisy coefficient estimator also approaches beta. The finite 32-block noisy arm need not equal that asymptote.

## Discriminating observations and limits

B20/B200 paired changes diagnose finite-bootstrap quantile-resolution sensitivity; they do not prove B200 converged. Noise-zero/.125 contrasts expose sensitivity to this synthetic upstream HAR-estimation noise. Common/heterogeneous-shape contrasts, accompanied by the analytic pooled-versus-conditional discrepancy, probe the pooled standardized-depth assumption. Report all paired contrasts and interactions; do not allocate total error additively or infer general statistical causality from them.

Report point bias/RMSE, interval availability, inclusion and width for all 12 fixed state/barrier cells in each condition and B setting. Monte Carlo uncertainty uses independent worlds, not the dependent cells. Retain all outcomes and known rare-tail limitations. No tuning, preferred-model selection or market/production conclusion follows.

## Prospective seeds and resource admission

Use 64 new worlds: proposed PCG64 world seeds `2026104000+j` and independent bootstrap seeds `2026105000+j`, j=0..63. Within each world use explicitly separated child streams for Z, E and U, frozen before execution. These ranges do not reuse or select from the earlier worlds. All four conditions share the same generated arrays and weights. Freeze literal seed list, source/runtime pins, implementation, exact estimands and missing/undefined handling before any registered generation.

First admit only the first eight new worlds as a resource pilot. Freeze a resource-only outer-clock gate before seeing outcomes; proposed criterion is `8*t8 <= 96 seconds`, sampled peak RSS strictly below 500 MiB and free disk at least 2 GiB, with a 120-second externally guarded full invocation. t8 includes imports and final writes. Outcomes, coverage and B20/B200 differences cannot affect advancement. Full 64-world execution requires separate parent admission, retains the same first eight and unchanged law, and is not an independent repeat. A failure preserves partial evidence without resampling.

Four conditions imply roughly four times the previous 3.28-second internal workload (about 13 seconds), an estimate rather than measured admission evidence. No packages, market data, model revision or Board change is needed to prepare this diagnostic. No code or registered worlds have been executed for this draft.

## Implementation review status — prospective only

`mechanism.py`, `spec.json` and `test_mechanism.py` now implement this draft. No registered worlds or resource pilot have run. The literal 64+64 seeds and dependency hashes are in `spec.json`; the parent-owned outer wrapper separately pins script/spec and guards startup and final writes. This draft remains dependent on the absolute accepted sibling helper path and frozen source checkout; no portable deployment claim is made. Synthetic fixtures use world/weight seeds 991401+/992401+, outside all registered ranges, and include one bounded original-subject B1 fixture plus injected-failure evidence retention. Python-readable summary NaNs explicitly preserve unavailable widths; authoritative tensors remain in NPZ. Pair contrasts are per-world differences of error, squared error, availability, inclusion and width; interaction is noisy-heterogeneous minus zero-heterogeneous minus noisy-common plus zero-common. They are diagnostic contrasts, not additive causal error shares.
