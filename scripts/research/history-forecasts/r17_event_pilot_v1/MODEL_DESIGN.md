# R17 exploratory event pilot — DRAFT, CODEX CONTINUATION

This is a retrospective development pilot on already-seen data. No market fit has run under this draft.
A parent-admitted READY request, frozen producer and input hashes are required by the CLI.
There are no inference, power, eligibility, promotion, causal-feature or actual-liquidation claims.
B19 and other blind/reserve observations are outside the pilot.

## Fixed target and information timing

Horizons: 6, 12, 24, 72 and 168 hours. Barriers: −40%, −20%, −10%, −5%, −2%, in that order.
The primary developmental decision cell is 24h/−10%. Preserve every other cell, arm, raw score and projected score.
The producer supplies complete-future-hourly-low-window labels. Invalid placeholders are never observations.
The old fH library retains its legacy up-to-5%-missing support rule, a baseline construction limitation distinct from complete evaluation labels.
Origins begin in 2022. Historical 2022–2023 origins supply initial training. Evaluate every calendar quarter in 2024–2025.
Earlier evaluation-quarter observations may enter later training only after labels mature.
Every origin keeps its original own-quarter feature cutoff. The trainer refuses a rewritten quarter cutoff.
Training requires issue eligibility, valid fH, valid complete label and ts+H hours ≤ evaluation quarter start.
No evaluated quarter supplies an immature training label. All wall-clock conventions are UTC.

## Four arms and controls

1. Raw fH baseline. A separately named epsilon-clipped baseline is an instrumentation control.
2. Fixed-logit-offset linear residual with twelve base features and log1p(barrier), the log price ratio corresponding to the barrier.
3. XGBoost fixed-logit-offset residual with the same base representation.
4. XGBoost residual with those inputs plus six explicit past shape features supplied by the producer.

Raw fH probability is used only as a clipped logit offset, never an additional free feature.
Offset epsilon is 1e−6. Independently recompute offsets and compare producer base_margin values.
All learned arms retain unrestricted raw probabilities and an equal-weight nondecreasing barrier PAV projection.
PAV establishes barrier order within a horizon only. It does not establish joint time-to-hit coherence.
Report all ten horizon-pair order diagnostics on exact common (sid,ts) origins for raw and projected arms and fH.
No cross-horizon projection is applied and violations are not dropped.

## Training recipe, fixed before outputs

Select at most 40,000 eligible training origins by increasing SHA256 UTF8 bytes of Q26-R17-TRAIN:sid:ts.
Use sid and ts tie breakers. Apply this cap before expanding each origin into five equally weighted barrier rows.
All arms use the same selected origin identities. Report their ordered identity digest and support counts.
No per-label resampling. A fold below 100 training origins or without both pooled binary classes is NOT FIT.
Such a fold preserves unchanged raw fH as an explicit fallback for all learned arms. Empty quarters remain in the audit.
A numerical optimizer/native failure is a failed run, not a silently substituted fallback.

For every learned arm, fit column medians on training rows only. An all-missing column has declared median zero.
Append one missing indicator per expanded input column. Imputation zero is a feature fallback, never a missing outcome.
The barrier column is included in the shared imputation/indicator recipe.
Linear standardization is fitted on imputed training inputs, including barrier and missing indicators. Constant standard deviations become one.
Linear objective: mean binary NLL with fH logit offset + (0.01/2) times squared slope norm.
The intercept is unpenalized. L-BFGS-B maxiter=300, ftol=1e−12, gtol=1e−7. Non-success is a hard error.
XGBoost uses shared imputation/indicators without standardization. Version3.4.1, binary:logistic, hist, depth3, eta0.05,128rounds.
min_child_weight20, lambda5, gamma0, subsample1, colsample_bytree1, max_bin128, nthread1, seed1701, base_score0.5.
Set base_margin at training AND prediction. No early stopping, tuning, monotonic constraints or seed search.
Adding explicit shape representations is not a claim of new information or demonstrated incremental skill.

## Scoring and evidence

Issuance is independent of future-label validity. Report issue-eligible rows, invalid baseline rows and unavailable labels separately.
All arms score the exact same valid labelled issued origins. Retain all five horizons and all five barriers.
Report pooled, 2024, 2025 and per-asset Brier, raw-baseline BSS, bounded logloss, events, probability sums, O/E and E/O.
Also report rows, series and UTC epoch-aligned seven-day bins. These counts are descriptive, not independent sample-size estimates.
Raw Brier uses exact raw fH probabilities. Logloss clips every arm to [1e−6,1−1e−6] and reports its clipping count.
Zero baseline Brier, zero expected events and zero observed events produce JSON null with explicit status, never NaN/Infinity.
For every cell and group, also bound paired Brier loss difference over every issued forecast, including unknown future labels.
For unknown y in {0,1}, difference is linear in y. Sum endpoint minima/maxima with observed complete-case differences, then divide by all issued rows.
These are deterministic missing-label sensitivity bounds, not confidence intervals. No missing-at-random assumption or partial-path hit inference is used.
Issue-eligible rows with invalid baseline have no paired forecasts. They remain explicit unavailable counts and are outside paired bounds.
No p-values, significance, power projection, candidate eligibility or learned-model ranking gate are computed.
Local prediction NPZs retain both raw and projected probabilities and label validity. They are local only.
After each successful horizon, atomic progress.json retains the exact aggregate score objects with complete=false and completed horizons.
A later exception writes bounded failure.json stage/horizon/error details without deleting earlier predictions or checkpoints.
Each learned fit prints horizon, quarter and arm to stderr before starting. Only reviewed aggregate evidence may be exported. Do not publish per-origin arrays or input retrieval manifests.

## Execution bounds and pending parent review

Require ≥2GiB free disk throughout. Whole run boundary1,200seconds, each learned fit ≤120seconds.
Spawn one fit child at a time. Monitor combined parent+fit-child RSS against1GiB during fits.
A parent outer monitor must additionally bound loading/scoring RSS and full-run wall time. Sampling is not native syscall containment.
The request remains DRAFT until the parent verifies source, tests, producer schema, fixed24-series input selection and data/provenance qualifications.
Current synthetic tests exercise real small XGBoost fits only, numerical gradients, split masks, projection and margin handling.

## Execution-only amendment before the first real fit — 2026-10-20

After an empty timed pipe poll, a fit child may send its reply and exit before the liveness check.
Re-poll the pipe immediately when the child is terminal. Consume a queued reply or retain the genuine no-result failure.
A deterministic mocked interleaving checks both cases. Model mathematics, hyperparameters, inputs and scores are unchanged.
