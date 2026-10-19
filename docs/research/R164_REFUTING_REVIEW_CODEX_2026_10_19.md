# R16.4 refuting review — CODEX CONTINUATION

**Status: review complete.** All 36 parent-run instrument tests pass; final intraday outputs and this
report were independently checked against the frozen inputs, source hashes and checkpoint rows.
**Author:** Codex chat `01a15640-8ca2-7022-8263-071b11476702`.
**Origin:** Claude Code session `session_01Vv8BNqd3QymKqE3KbgGfYF`, task “Refute R16.4 results”.
This is report-only review work. No new blind observations, production changes, or altered primary gates.

## Scope and interpretation

The original task asks whether a fixable step-model limitation explains Part A, whether noisy observed
group frequencies unfairly evaluate probability intervals, whether the reported tables reproduce,
whether the power ceiling is justified, and which UI statement the evidence supports.

The review distinguishes component misspecification from a programming defect. An hourly GARCH model
fixing a synthetic GARCH benchmark does not prove a production-kernel bug or superior market forecasts.

## A. Original recursive scores reproduce

Recomputed directly from published float16 predictions using the original joint finite-model mask:

| Horizon | Rows | rec12 BSS vs fH | rec12 BSS vs fixed12 |
|---|---:|---:|---:|
| 3 days | 585,060 | −0.0025629 | +0.0055344 |
| 7 days | 585,730 | −0.0055137 | +0.0121499 |

Published figures differ by less than 0.000003 BSS. **CONFIRMED:** the existing implementation has no
established advantage over fH, while feedback improves its fixed-scale ablation.
This does not establish that recursive path generation itself is a failed idea.

## B. Faster GARCH step: synthetic repair, no demonstrated real advantage

The reconstruction preserves all 28,800 published synthetic rows: 12 series, 720 forecast origins,
and the published 20,000-path truth estimates. Forecasts use 2,000 paths. Independent verification found
zero changed truth, fH, rec12 or support rows. All 720 origins use converged quarterly QMLE fits.

Deep levels are the original −25%, −30% and −40% band. R is predicted probability sum / truth sum.

| Horizon | HAR rec12 R | Fitted hourly GJR R | Known-parameter empirical-pair R | Exact-law R |
|---|---:|---:|---:|---:|
| 1 day | 0.362 | 0.986 | 1.007 | 0.975 |
| 3 days | 0.427 | 1.020 | 1.044 | 1.003 |
| 7 days | 0.589 | 1.059 | 1.087 | 1.000 |
| 30 days | 0.995 | 1.105 | 1.122 | 0.999 |

Fitted GJR improves deep-probability MAE over HAR in all 12 synthetic series at both 3 and 7 days.
The shared hourly simulator passes exact-law known-answer and future-prefix invariance tests.
**CONFIRMED:** the short-horizon synthetic limitation is fixable by a different step-model bundle.
**WEAKENED:** attributing it exclusively to slow HAR response. The bundle also changes variance fits,
residual normalization, sampling frequency and path construction. The synthetic DGP favors GARCH.
The 30-day result also rules out calling the change uniformly better.

### Real-development replay

Exact pinned blind5 inputs: 42 already-seen series, 2,631 selected origins on epoch days divisible by 28.
There are 104,310 paired scored rows. Twelve unavailable HAR origins account for 480 excluded stored rows.
Regenerated HAR differs from stored float16 probabilities by at most 0.0002421875, within expected rounding.
No additional prediction-pair exclusions occurred. Quarterly fits and prequarter pools are past-only.

| Horizon / band | GJR BSS vs fH | GJR R | fH R | Paired loss z |
|---|---:|---:|---:|---:|
| 3 days / all | −0.02578 | 1.078 | 0.969 | +0.770 |
| 3 days / deep | −0.00759 | 0.648 | 0.619 | +0.560 |
| 7 days / all | −0.04323 | 1.122 | 1.009 | +0.973 |
| 7 days / deep | +0.00231 | 0.983 | 0.838 | −0.104 |

Negative loss z favors GJR. All reported paired 90% intervals include zero. The all-level Brier point
estimates are worse, but this is not proof of worse population performance or a generic GARCH failure.
**No demonstrated real advantage:** do not promote this implementation over fH.
Improved aggregate deep calibration at 7 days is not an established Brier-skill gain.

A declared numerical sensitivity subtracts `p_hat*(1-p_hat)/999` from simulated forecast Brier losses,
the unbiased conditional finite-path variance estimate under independent paths at a fixed fitted model.
All-level adjusted BSS remains −0.02490 at 3 days and −0.04229 at 7 days. The estimated expected
finite-path Brier inflation is too small to reverse either negative point estimate. This sensitivity
does not bound realised Monte Carlo error or establish population superiority/inferiority. It does not
remove model, fitting, or data uncertainty.

### Recovered intraday HAR control

The original review's h3 control adds a 3-hour volatility input to the daily/weekly/monthly inputs.
It retains **12-hour simulation steps**; it is not an hourly simulator. The synthetic comparison
also retains the base12, h12 and h1 variants and their fixed-scale ablations.

The completed real-development h3 replay uses the same 104,310 scored rows as GJR and fH, with
zero additional exclusions. The inherited 12 unavailable HAR origins remain excluded.

| Horizon / band | h3 BSS vs fH | h3 R | Paired loss 90% interval |
|---|---:|---:|---:|
| 3 days / all | −0.001415 | 0.984 | [−0.000760, +0.001111] |
| 3 days / deep | −0.007526 | 0.479 | [−0.000052, +0.000492] |
| 7 days / all | −0.008687 | 1.035 | [−0.001228, +0.003610] |
| 7 days / deep | −0.008380 | 0.734 | [−0.000386, +0.001325] |

The narrower feature change supplies no demonstrated advantage over fH on this seen development
sample. The all-level point estimates are closer to fH than GJR's, but no paired h3-versus-GJR
superiority claim is tested here.

The full intraday synthetic replay preserves all 28,800 published rows and all truth/baseline values,
using 720 origins and 2,000 forecast paths. All ten frozen source hashes remain unchanged.

| Horizon | Original rec12 deep R | h12 recursive R | h3 recursive R | h1 recursive R | h3 deep MAE |
|---|---:|---:|---:|---:|---:|
| 1 day | 0.362 | 0.403 | 0.419 | 0.385 | 0.000318 |
| 3 days | 0.427 | 0.458 | 0.514 | 0.460 | 0.001398 |
| 7 days | 0.589 | 0.602 | 0.689 | 0.627 | 0.003663 |
| 30 days | 0.995 | 0.962 | 1.023 | 1.005 | 0.016865 |

At 3 and 7 days h3 reduces deep MAE from 0.001558 and 0.004304, respectively, but still substantially
underpredicts synthetic deep events. Its fixed-scale deep R is 0.535 and 0.632 at those horizons:
feedback does not uniformly improve aggregate calibration. The tested faster-input-window variants
do not repair the synthetic failure. The GJR bundle repairs much more of it, without establishing a real-data win.
These are development diagnostics, not evidence from a newly held-out benchmark.

## C. Ranges: observations are noisy, but a latent-probability claim is still unvalidated

The original target is **realised group frequency**, not an individual latent event probability.
With exact known p=0.5 and 101 independent Bernoulli observations, a [0.5,0.5] interval covers the latent p
with certainty but covers the realised frequency 0% of the time. Normal-SE widening yields 88.9% exact
frequency coverage. It is a predictive-frequency calculation, not a validated latent-probability interval.

For 7-day −10% altcoins, the median group contains 269 rows, 75 distinct origin days and 26 horizon-sized
calendar windows. The independent-Bernoulli plug-in median SE is 2.95 probability points; the centered
time-cluster sensitivity is 6.74 points. These proxies mix stochastic variation and model error.
Disjoint origin buckets also do not remove overlap across horizon boundaries.

Original reviewer noise calculations used uncentered y−p, admitting calibration bias into the variance.
Its deconvolution shrinkage used split covariance from all groups, including held-out outcomes.
Neither establishes an identified “63% noise share” or out-of-fold latent-probability interval coverage.
Single-asset two-way variances are now marked unavailable, including all 109 ETH/BTC groups in the
7-day −10% cell. Duplicate venue files do not create independent economic assets.

### Training weights versus evaluation target

The original CAL quantiles weight training groups by row count but its main coverage target weights
groups equally. Replaying genuine equal-group quantiles changes this mismatch on the same seen support:

| Altcoin cell | Original group coverage | Equal-group coverage | Original median group width | Equal-group median group width |
|---|---:|---:|---:|---:|
| 1 day −10% | 0.770 | 0.947 | 8.44 points | 11.46 points |
| 3 days −10% | 0.772 | 0.868 | 21.64 points | 31.52 points |
| 7 days −10% | 0.795 | 0.867 | 37.98 points | 49.47 points |

These are **group-width medians**, not row-width medians. Both row and group coverage are retained in
the artifact. Coverage improves at a width cost; a uniform nominal-coverage or narrow-range claim does
not follow. SE-widened compatibility also uses held-out outcomes and is explicitly nondeployable.

**CONFIRMED:** reported original group-frequency undercoverage and wide intervals.
**REFUTED:** treating that alone as a test of latent individual-probability interval coverage.
**SUPPORT INSUFFICIENT:** attributing most undercoverage solely to observation noise.

## D. Power: conditional limitation, not a universal impossibility result

The original one-day paired loss has two-way bootstrap SD 0.00018678. Calendar-only resampling gives
0.00018408; series-only gives 0.00002570. Calendar variation dominates this conditional diagnostic.
These are not additive variance shares and do not prove an unavoidable ceiling for every candidate.

The original power code scales a combined series/time z without extracting a time-only component.
Its width leg is an observed median indicator, not a simulation of joint width uncertainty.
The original NOT RUN remains under its existing construction, target and gate.

A **post-hoc development sensitivity**, not a replacement gate, uses the revised equal-group 1-day −15%
construction. Group coverage is 0.95276, median row width 3.589 points, two-way bootstrap SE 0.02061.
Normal-approximate one-sided minimum-90%-coverage power is 0.820. Applying the original equivalence
gate (90% ±5 points) to this revised construction gives only 0.037 power: overcoverage is penalized.
The original weighted construction's corresponding values are 0.552 and 0.110, respectively.

This is a potential **group-frequency prediction** claim to examine, not a validated latent CI or a
joint-width acceptance result. It needs a new explicit registration, adequate unseen counts, target
agreement and width uncertainty checks. Existing primary gates and reserve allocations remain intact.

## E. UI / scientific statement

Current evidence permits reporting historical, scoped empirical calibration summaries, identifying the
period, construction, target and observed coverage. This is not validation of a future conditional group
prediction range or authorization to surface one. It does not validate “high confidence this asset's
true probability is 10–20%.” Noise-aware diagnostics weaken the earlier impossibility interpretation,
but do not supply the missing conditional-probability uncertainty validation.

## Per-claim verdict and recommendation

| Original question | Verdict | Recommendation |
|---|---|---|
| Do the published recursive Brier comparisons reproduce? | CONFIRMED | Retain the reported lack of established advantage over fH. |
| Is the synthetic step limitation fixable? | CONFIRMED for a different GJR bundle; WEAKENED as a claim specifically about slow HAR response | Keep step-model development open; neither tested replacement earns promotion on real data. |
| Does raw group-frequency undercoverage refute latent-probability intervals? | REFUTED as that inference | Separate the prediction target from the latent-uncertainty target before registering a range claim. |
| Is most undercoverage identified as sampling noise? | WEAKENED; the decomposition is unidentifiable from these diagnostics | Use centered, dependence-aware sensitivities; do not publish a quantified noise share. |
| Does development power prove no range claim can work? | WEAKENED | Preserve the original NOT RUN. A revised one-sided group-frequency claim is a candidate for a separate registration, not a retrospective pass. |
| Is an individual “high confidence 10–20%” probability statement supported? | REFUTED as a claim of validation | Limit scientific reporting to historical scoped calibration summaries; no stronger UI statement follows. |

The next justified research decision is to specify the range estimand and acceptable width jointly,
then assess a separately registered test's unseen-data requirements. Do not replace fH, loosen the
existing gates, or spend a reserve on the basis of this review. Broader contamination and model-family
paths remain separate, unresolved work from the original research context.

## Local evidence and reproducibility

- Scope: `R164_REVIEW_SCOPE_2026_10_19.md` and the original Claude task.
- Synthetic GJR: `/private/tmp/r164-step-review-full.json`.
- Real GJR: `/private/tmp/r164-step-real-full/`, complete manifest and 42 checkpoint files.
- Range/noise/power: `/private/tmp/r164-range-noise-review-power.json`.
- Original-table replay: `/private/tmp/r164-main-cells-replay.json`.
- Numerical sensitivity: `/private/tmp/r164-mc-sensitivity.json`.
- Intraday source companion: `/private/tmp/r164-intraday-review-sources/PROVENANCE.json` and ten frozen source files.
- Real intraday HAR: `/private/tmp/r164-intraday-real-full/report.json` and 42 checkpoint files.
- Synthetic intraday HAR: `/private/tmp/r164-intraday-syn-full/synthetic.json`.
- Review code: `scripts/research/history-forecasts/r164_*review.py`, with corresponding synthetic unit tests.
  All 36 parent-run instrument tests pass. Independent source/output checks are recorded in this chat.
  No reserved prices were read.
