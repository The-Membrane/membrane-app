# Next comparison after O86 — implementation DRAFT, no real execution

Use one nested, transparent conditional-distribution comparison: an NPZ-only pooled-depth bridge, a common-shape/state-scale control, and a state-specific-shape alternative. Keep raw fH as an external anchor. Freeze only the existing downside-imbalance-D median split, without fitting other axes or a joint state product. Retain all five horizons, all five barriers, the same24 seen assets and every adverse result. No untouched/blind claim, new input acquisition, hyperparameter search or automatic execution is authorized.

## Why this adds something, and what it cannot add

O81's XGB+shape arm barely improves pooled primary Brier and reverses by year. It already had the same past shape features. This proposal adds an interpretable distributional restriction, not newly discovered information: does forcing both issuance states to share one depth law after historical state-scale normalization harm paired predictive scores? It does not ask whether a bigger classifier can find another residual interaction. Evidence: `/Users/EBmic/membrane-board/knowledge/q26-model-inventory.md:464`, `:474`, `:476`.

O84 establishes a known-law pooling mechanism in a surrogate, not market causation. O86 identifies compatible conditional errors/shape differences but explicitly preserves asset/calendar/scale confounding and adverse H6/H12 and H168 cells. The comparison is exploratory and motivated after seeing these development results. References: `/Users/EBmic/membrane-board/knowledge/q26-model-inventory.md:521`, `:540`, `:588`, `:590`.

## Frozen data/support and clocks

Use the admitted five `horizon-{6,12,24,72,168}.npz` files. No producer import, OHLC scan or new series. Fix daily evaluation origins2024–2025 and eight quarter-start updates. Every training library is **own SID and own horizon**, using daily origins from2022 onward whose label endpoint `ts+H*3600 <= quarter_start`; historical row quarter provenance must also satisfy `quarter_cutoff<=ts`. No current-quarter outcome enters a library, scale estimate or CDF. No retrospective rewriting of historical issued features with a later fit.

The existing O86 feature-only2022/23 cut for each horizon assigns low when D-imbalance<=cut and high otherwise. Keep ties and unknowns. No new cut estimation or state selection. Current primary question is downside D only, chosen retrospectively after O86 and labeled as such. Other O86 axes remain prior evidence, not additional candidates searched here.

Effective annualized log sigma is lsf on `fH_fallback` rows and lsH otherwise. At historical origin i define `s_i=exp(l*_i)*sqrt(H/8760)` and `Z_i=future_log_min_i/s_i`. Both depth and quotient must be finite and s_i strictly positive. Keep signed depth, including nonnegative values. Stored float32 log scales only approximate the issued float64 scale. Original normalization and fallback evidence: `/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence/r17-conditional-depth-audit-v1/conditional_depth_v2.py:24`, `:124`; `/Users/EBmic/membrane-board/knowledge/q26-model-inventory.md:592`.

Training eligibility is issue_eligible & p_fH_valid & complete label & finite valid scale/quotient & known frozen state & strict maturity, on the same base row IDs for every new arm. Raw-fH availability is a deliberate common-support restriction, not necessary for defining an ECDF. Report every exclusion and state count rather than pretending identical effective sample sizes: the conditional CDF uses its state's subset; pooled estimators use both subsets. No state/outcome-conditioned resampling or choosing favorable rows.

## Three explicit estimators, with no free hyperparameters

For one SID, horizon and quarter, estimate `M_g=median(abs(Z_i))` from mature historical rows in state g, separately for g=low/high. Median is NumPy linear quantile0.5. It is a positive robust magnitude scale, not estimated future volatility or a claim of optimality. Do not center Z or fit an intercept. Use the same M_low/M_high in both normalized arms. Define **each training row's** `W_i=Z_i/M_{g_i}`. Build inclusive empirical CDFs:

- `F_Z(t) = mean( Z_i <= t )` over the identical eligible pooled library.
- `G_pool(t) = mean( W_i <= t )` over that library, with its historical empirical state proportions.
- `G_g(t) = mean( W_i <= t | g_i=g )` over its own-state subset.

At evaluation origin o, let `t=log1p(barrier)/s_o` and current known state g. Predictions are:

| Arm | Prediction | Purpose |
|---|---|---|
| Pooled-Z bridge | `F_Z(t)` | NPZ-only pooled ECDF under the same mature daily/complete library |
| State-scale/common-shape | `G_pool(t/M_g)` | Allow state magnitude scales, constrain normalized shape to be shared |
| State-scale/conditional-shape | `G_g(t/M_g)` | Release that common-shape restriction, with exactly the same scales |
| External raw-fH anchor | stored `p_fH` | Existing system reference, not an otherwise matched estimator |

Inclusive `<=` is frozen, matching barrier-event convention. No interpolation, bins, tree fit, slope constraint, smoothing, pseudocount or tuning. Empirical0/1 probabilities are genuine estimator boundary outputs: retain them, show event counts, and use explicitly EPS1e-6-bounded logloss controls rather than hiding them. They are not proof of impossible/certain events.

**Important cancellation:** within the conditional arm, the same positive M_g divides both training depths and query threshold, so `G_g(t/M_g)` is algebraically the own-state ECDF of Z at t. This is not evidence that scale estimation improved. The scale-control contrast is interpretable because pooled W normalizes **each historical row by its own state scale**, before mixing. A single rescale of pooled Z would leave mixed state levels in the reference, potentially fabricating a shape failure under a true scale-only law.

The proposal rejects a four-arm global/state-scale×global/state-CDF factorial for this first comparison. Mixing `F_pool` normalized by a global scale with `F_g` normalized by a state scale makes an apparent shape factor also change library normalization. Such algebra is computable but not an independent or causal decomposition. The three nested controls above expose the actual restriction more directly.

## Common fallback, estimability and support

Predeclare no arbitrary minimum-n tuning. A pooled-Z bridge is defined with at least one pooled eligible historical row and a finite query. Both low/high historical libraries must be nonempty, both M_g finite/positive, and all W transforms finite before B/C depart from A. Otherwise **B and C both equal A**, with explicit shared fallback reason and every library size. This includes an empty state, zero median magnitude, nonfinite scale or W transform. Unknown issuance state also routes B/C to A. No invalid state/library rows are silently removed from the common base library to rescue B/C. If A itself is undefined because the eligible pooled library is empty or the query normalization is invalid, **all A/B/C equal stored raw fH**, with a separate bridge fallback reason. Thus the normal mechanism comparison never gains a special raw-fH fallback available to only one arm.

A mathematically defined one-row or degenerate empirical library is not silently called reliable: report n, unique depths, distinct dates/28-day blocks and per-barrier historical event counts. There is no extra minimum-n knob. Retain whole-issuance paired scores and nonfallback-only sensitivity, showing their different supports. Zero predicted probability from a valid ECDF differs from unknown/empty-library fallback. The conditional-versus-pooled sample-size/variance penalty is part of this predictive comparison, not separately identified as a latent mechanism.

Where raw fH is unavailable, keep the issued origin and unavailable status without a matched score. Unknown future labels never affect issuance or a library before maturity, and never become non-events. All arms share exact issued/scored row IDs and paired label masks. Report all-baseline-available unknown-label paired Brier-difference endpoint bounds, in addition to complete-case scores. Do not use fallback to drop adverse strata.

## Why raw fH is external

The staged historical lsH values use their own issue quarter. The original fH historical library is restandardized under the **current** quarter's coefficient in the original producer, and the active S3-loaded historical low-path library permits up to floor(.05 H) missing lows, unlike the complete primary audit labels (qualified active-loader chain below). Staged daily origins also differ from the original hourly library. The pooled-Z bridge is therefore mandatory. A new arm beating raw fH could reflect these library/support/representation changes rather than conditional shape. Only the nested common-shape versus conditional-shape contrast directly tests this frozen empirical restriction. Source: `/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence/r17-event-pilot-v1/build_inputs.py:118`, `:120`, `:123`, `:135`; `/Users/EBmic/membrane-board/knowledge/q26-model-inventory.md:592`.

## Outputs and interpretation boundary

Primary developmental comparison: conditional-shape minus state-scale/common-shape Brier at24h/−10%. Retain all25 horizon/barrier cells for every arm and the same270 point views as O86: pooled/2024/2025,24 asset marginals, and frozen issued-volatility/downside-D/jump-D low/high/unknown groups by those calendar views. Only the downside-D cut enters predictions. Issued-volatility and jump cuts are existing frozen diagnostic views, not extra fitted candidates or a joint state product. Retain Brier, bounded logloss/clipping counts, O/E with explicit undefined status, predicted/observed means, event counts, n, issuance/missingness, per-fold library/scale/unique-depth support and paired loss differences. No best-cell selection or family ranking.

Uncertainty sensitivity has exactly six prespecified targets: at primary24h/−10%, paired C−B and C−A Brier differences, separately pooled2024/25,2024 and2025. Use the existing500 common year×28-day global-calendar-block draws, seed2026106000, on fixed predictions and identical paired rows. Preserve assets at each sampled date; do not refit CDFs or scales in draws. Other horizons/barriers/states/assets remain fully reported point evidence without added resampling targets. Report SD/5th/95th percentiles, defined/undefined counts and weighted denominators as conditional resampling sensitivities, not validated confidence intervals or power. Retain undefined draws without redraw. No outcome-driven extension of this scope. Row dependence and28year-blocks remain. Source: `/Users/EBmic/membrane-board/knowledge/q26-model-inventory.md:592`, `:594`.

Per-horizon ECDF probabilities are barrier-monotone by construction. They need not be ordered across horizons: retain exact common-origin cross-horizon reversal counts/maxima for all arms and raw fH, without projection. O81's cross-horizon weakness remains an explicit adverse check, not a solved property. Reference: `/Users/EBmic/membrane-board/knowledge/q26-model-inventory.md:476`.

A loss gain would establish a useful restriction release on these already-seen inputs only. It would not identify a causal pooling failure, cleanly separate scale misspecification from location/tail/mixture differences, or validate a forecast of future skew/jumps. Median-absolute normalization does not make every other distributional difference “skew.” State may proxy calendar, composition, scale error or unmeasured information. Few own-asset tail observations and smaller conditional libraries can hurt. No confident band, arbitrary liquidation-line interpolation, latent probability, actual oracle/liquidation mechanics, blind use, full277 expansion or deployment follows.

## Mandatory synthetic tests before any market-data fit or scoring

1. **Positive scale-only null:** use exactly repeated base W grids in two states, multiply them by different positive state scales, retain inclusive ties, and verify common-W/state-scale and state-W predictions coincide for every registered threshold. A pooled-Z bridge may differ; do not mislabel that as shape evidence. Repeat with unequal state counts that preserve each state's empirical base law.
2. **Non-scale alternative:** give states the same median absolute magnitude but different tails. For example magnitude grids `(1,1,1,1,2,2,2,2)` and `(.5,.5,1,1,2,2,4,4)` both have median1.5. At magnitude3, their exact event probabilities differ0 versus.25 while the equally weighted pooled law gives.125. Verify the conditional arm represents that difference and the common arm cannot. This is an instrument check, not real-data validation.
3. **Cancellation/timing:** verify state-ECDF normalization/query cancellation; no post-cutoff or current-quarter label changes affect any library/prediction; fixed cut unaffected by2024/25 labels; historical scale arrays are never rewritten.
4. **Boundary/failure support:** empty/unknown states, zero median, positive depths, finite underflow/overflow, ties, missing labels,0/1 predicted probabilities, signed float logloss, common B/C→A fallback and A→rawfH fallback, and all support counters. Test exact paired row IDs and inclusive label endpoint.
5. **Aggregation:** duplicated-row oracle for ECDF, metric arithmetic against explicit float formulas, common calendar-block grouping and undefined resampling replicates without redraw. Reference raw-fH score reconciliation remains unchanged.

## Minimal staged members and feasibility

Required NPZ members: `sid, ts, quarter_cutoff, issue_eligible, p_fH_valid, fH_fallback, Xbase, Xshape, future_log_min, label_valid, y, p_fH`. Prediction uses Xbase columns0/1 and Xshape column3. The existing issued-volatility diagnostic uses those same scale columns; jump-D diagnostic additionally reads Xshape column0. Neither diagnostic axis affects predictions. NPZ member granularity means accessing those columns decompresses the full existing member; no rewritten compact dataset is needed. `future_missing_hours` and `legacy_label_valid` are additional required support diagnostics (14 members total), not new prediction inputs. No `base_margin`, logloss-correction predictions, volume/BTC feature, raw OHLC or model fitting dependencies are required.

Authenticate the existing admission→monitor→build-launch→staging-request chain, all five NPZ pins, canonical cohort, source/runtime closure and frozen O86 cut artifact before array access. Source for that admission structure: `/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence/r17-conditional-depth-audit-v1/conditional_depth_v2.py:40`, `:66`, `:186`.

One horizon at a time, own-asset daily libraries and eight quarter boundaries keep maximum per-library history around four years of daily origins, rather than40000-expanded classifier rows. Sorting ECDFs and order-statistic medians need no optimizer, Torch or XGBoost. Proposed total resource budget:120seconds including process startup and final writes;1GB whole-job sampled RSS;2GiB (2147483648 bytes) reserve;10MB aggregate JSON. No restart automatically replenishes that budget. Freeze request/source/tests and resource observer first; measure actual resources, preserve partial aggregates and failures, and stop if caps bind. This is a feasibility estimate, not a measured runtime promise. Outputs remain local aggregate evidence; no NPZ/row export. Parent and separate refuter must review before any implementation execution.

## Status

The preceding proposal text is preserved as the design basis. Source and synthetic tests are now prepared in the owned comparison directory. Only synthetic fixtures have been evaluated. No admitted arrays, real CDF construction, real forecast scoring or Board change has run for this implementation task. Existing completed runs remain immutable.

## Final pre-execution engineering amendments

C's canonical computational definition is the inclusive own-state Z ECDF at t. It is equivalent to own-state W queried at t/M_g in exact real arithmetic, but arbitrary floating double division is not claimed bit-identical. Direct Z avoids artificial rescaling ties in the conditional arm. B always pools each row's W_i=Z_i/M_state_i, then queries t/M_current. Transformed query ties and statewise distinct-depth collapse counts remain recorded. Nonfinite normalized queries route both B/C to A, with explicit counts, rather than giving C a separate rescue.

One fixed negative control replaces D state labels by SHA256('Q26-R17-COND-NEGATIVE-v1:{sid}:{ts}').digest()[0]&1, using decimal integer sid/ts and UTF-8, shared across horizons. It uses exactly the same eligible D-known training row IDs and Z as the main controls. Hash B/C are diagnostics, not extra primary candidates. Retain their point contrast separately. There is no hash seed search.

Leave-one-asset-out is aggregate omission on fixed predictions, never a refit. Retain all24 omissions for pooled2024/25,2024 and2025 (72 rows), with main C−B/C−A and hash contrast. Primary comparison remains H24/−10%; a mean across barriers cannot replace it. Only the prescribed six primary calendar/contrast targets receive500-draw resampling.

All270 original point views remain. A separate matched main-A/B/C nonfallback-only point sensitivity has pooled/year views for each horizon; it excludes the union of main bridge and conditional fallback masks, not arm-specific rows. Unknown-label endpoint bounds remain. Invalid future quarter provenance fails closed for issuance rows, including exact own-quarter assignment on evaluation rows. It is not silently excluded to improve training support.

The source is NumPy-only and reuses the exact pinned O86 admission module on its original admitted request for source/runtime/provenance checks, without invoking its analysis stage. New source/test/design/cut pins are independently checked. This new question has a fresh parent-admitted120-second budget,1,000,000,000-byte sampled RSS limit,2147483648-byte (2GiB) reserve and10,000,000-byte output cap. Parent owns the outer timer. All arrays, CDF construction and real scoring remain NOT RUN at draft preparation.

Pre-freeze source qualification, resolved before execution: parent verified the active loader chain `build_inputs.py:236` → `r12_tail.py:213` (`M3.S3`) → `a3_touch.py:280` (`wmin`) → `a3_touch.py:172–186` (`window_min_null_rule`), with `NULL_FRAC=.05` at line77. This active S3 override permits up to floor(.05H) missing future lows, despite a different base Series implementation using plain np.min. This is a qualified fact about the active R17 producer path, not an assumption inferred from volatility-regression missing-return tolerance. The new candidates still require complete labels. Daily versus hourly origins and historical own-quarter versus current-quarter restandardization also keep rawfH an external anchor. No input arrays were read for this source qualification.
