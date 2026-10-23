# O189 — Daily versus block-frozen weighted CAL — CODEX CONTINUATION

Status: SOURCE/GENERATED QUALIFICATION ONLY. EMPIRICAL DAILY POLICY EVALUATION IS NOT ADMITTED. No canonical reserve-rule exception has been established. Input possession, source tests and resource checks do not authorize decoding or evaluating the new DAILY policy.

## Question and frozen scope

Does issuance-day updating of the existing weighted CAL rule improve its descriptive group-frequency interval score relative to the accepted 182-day block-frozen F rule? This is a clock-policy contrast, not a new point learner, an individual probability interval, a future-price band, or an original R16.4 blind result.

Use both original altcoin primary cells, H24/k5/−15% and H72/k7/−25%, in the unchanged accepted O140 native row order. The possession reviewer reports two selected-row NPZ files totaling about 5.77 MB. Another agent owns exact possession/authentication. Required row fields are p, binary y, sg, day, block, past_bins, original_bins, clock_target, saved F eligibility and saved F endpoints. Private detail must supply the authenticated fold records, including the original held-SG/block past-derived edges. No new raw series, point fit, simulation or probability forecast is needed.

## Fixed bins: the critical source boundary

For each held fold (g,b), recover its sealed original F edges. Define lp=log(clip(p,1e−5,1−1e−5)). Apply `np.searchsorted(edges,lp)` with original default left side to ALL native rows when forming either F or DAILY training groups. Never use each training row's own saved past_bins as the held fold's training bin. Those saved bins came from different issuance folds and are only the target-partition control. Never recompute edges at a daily cutoff. On the held rows, re-binning must match saved past_bins exactly.

## Issuance and maturity

All cutoffs are UTC integer-day starts. Preserve the original 182-day blocks: start_b=17532+182*b. Let h=H/24, so h=1 for H24 and h=3 for H72.

- F training: other-SG rows satisfying `sg!=g` and `day+h<start_b`.
- DAILY training at issue day d: other-SG rows satisfying `sg!=g` and `day+h<d`.
- Equality is excluded. A label with `day+h==d` cannot enter at day-start d under the preserved source convention. Do not silently replace `<` with `<=`.
- At the block start, the two training masks coincide. Later DAILY cutoffs may add matured other-SG rows, including partial groups in the current calendar block. They never add held-SG rows or any not-yet-mature outcome.
- No intra-day updates, retrospective target-derived cutoffs, rolling-window selection or target-dependent fit timing. This is a day-resolution saved-clock contrast. It does not independently prove full hourly timestamps, raw label formation or upstream historical forecast availability.

This compares two information clocks. Their training quantity and regime composition necessarily differ. The result cannot isolate a unique causal regime or leakage mechanism.

## Unchanged weighted rule

For either arm, group its currently eligible training rows by the HELD fold's bin, their original SG and their original 182-day block. Include only rows already mature at that cutoff. For each group, preserve original within-group accumulation order and compute n, sum_y and sum_p. Retain groups with sum_p>0. Use rho=sum_y/max(sum_p,1e−12), with weight n. A zero observed event sum remains a valid zero ratio. Do not add pseudo-events or a new floor.

Require at least 10 positive-forecast-mass groups, as the original kernel does. This is not 10 groups containing observed events. Sort ratios using the original wquant arithmetic and interpolate at 0.05 and 0.95 over cumulative row-count weights. Endpoints remain clip(p*q05,0,1) and clip(p*q95,0,1). Do not change weights to equal groups or equal assets, alter clipping or the 1e−12 denominator floor, or tune quantiles.

The source implementation may assign one canonical gid to the full fixed-bin/SG/block pool and use bincount with the selected mask. It must preserve original row order within each group. Optimization must reconcile with literal selected-row grouping, including tie/zero/partial-group fixtures.

## Baseline gate, support and missingness

Reconstruct ONLY F, not the future-looking Rclock or Roriginal training arms. Its original fold eligibility and fixed target bins must match the sealed O140 arrays exactly. Endpoints must reconcile within 5e−13 absolute tolerance. Do not proceed on baseline failure or enlarge this tolerance after data.

Primary target is the original F eligible AND clock_target mask, separately for each cell. Preserve every native row and all warmup/unavailable counts. Verify DAILY availability on every primary-target row rather than assuming it. If DAILY is unavailable there, mark the full-target primary comparison incomplete/refused. Do not restrict the primary denominator to an endpoint-success intersection. Counts of extra DAILY availability outside the primary target are diagnostic, not a new primary cohort. Folds whose sealed original edges are None remain unavailable/warmup throughout the block for DAILY as well. They cannot obtain newly learned bins mid-block. The primary F-eligible target remains fixed by original prediction/group-count eligibility.

## Evaluation and interpretation

Preserve the original evaluation groups: saved target bins, SG and182-day block. Daily-varying endpoints are averaged within these same groups. Compare the group's realized frequency with its averaged endpoints using the original 90% interval-score arithmetic, inclusive coverage tolerance 1e−12, row-median width and lower/upper miss counts. Do not replace this with daily event-interval coverage.

Retain every original scope, including empty scopes: all, each SG, each calendar block and each SG/block. SG labels are bookkeeping exclusions, not certified independent economic entities. Report F and DAILY on identical primary rows, and DAILY-minus-F differences. Decompose interval score additively into width, lower-miss penalty and upper-miss penalty in probability points. All-group primary interval score weights groups equally, exactly as the original metric. Do not substitute row-weighted scores merely because CAL quantiles use row-count weights.

Lower score is better. Report both primary cells and all weak views. Retain the original descriptive box: equal-group coverage target 0.90, coverage range 0.85–0.95 and median row width at most 10 probability points. Report every criterion separately, without choosing the favorable metric after the run or calling the diagnostic a model PASS. If either primary cell does not improve, do not claim a two-cell improvement. Even lower scores do not establish nominal coverage, significance, power, a serving policy or unseen skill. The analysis remains selected spent-development evidence. No latent individual-probability or liquidation guarantee follows.

## Source qualification before empirical access

Required generated cases: block-start equality; strict H24/H72 maturity equality and next-day availability; invariance to changes in held-SG or future labels; partial-current-block groups; training-row own-bin versus held-fold-bin counterexample; original weighted interpolation/floor and zero-event groups; nine-versus-10-group availability; empty folds/scopes; no-success-intersection handling; and exact width/lower/upper score decomposition. A separate checker must independently derive masks, ratios, quantiles and metrics on known answers.

The implementation and checker may complete source/generated qualification only. A fresh parent-sealed resource request alone cannot authorize saved-array decoding for this new DAILY policy. First satisfy the two-unseen-reserve/revision-registration gate, or obtain an explicit prospective owner ruling resolving the classification/exception; none has been identified. Authenticate selected arrays, private fold details, original source pins and runtime before loading; rehash used inputs after. Save F/DAILY endpoints, exact eligibility/target masks and bounded per-cutoff receipts privately, preserving row identity/order. Learned edges and operational identities are never public evidence.

Only after that scientific reserve gate is resolved may a finite phase be separately considered after generated timing/size checks. Reuse the existing one-attempt supervisor rather than building another collector framework. A prospective starting envelope is 600s total wall,512MiB OS-observed child peak checked postrun,32MiB whole output,512MiB free reserve and64KiB per log. These are proposals pending source/resource review, not automatic permission or continuous memory containment. No automatic retry, old allowance reuse, new provider request or reserved data access.

## Original holds and distinction from R13.5r

The original step/refuting review is complete. O140's adverse strict-chronological weighted result and O141's width accounting remain history. Daily updates have not been evaluated by those block-frozen results. This diagnostic does not alter original Part A/B NOT RUN status. Ruling10 and the R16.4-specific rule require two unseen sets before revision development. DAILY forms new endpoint forecasts using additional realized outcomes, unlike deterministic error accounting of already-issued endpoints. Existing O114/O140 admissions and O141’s untested-clock observation do not establish a general exception. Treat empirical DAILY evaluation as unadmitted revision development until the gate is resolved. It is not enough to call it a diagnostic. Any future model/serving revision still needs its own registration and the reserve rule. R17 inference/identity/calibration/admission holds remain unchanged.

R13.5r is a different unfinished training-contamination/upstream-encoder attribution path, requiring full-class encoded training evidence or an explicitly labeled reproducible rebuild. This daily CAL contrast neither refits that decoder nor resolves its contamination. Do not repeat test-side stablecoin deletion, original GJR synthetic grids, cap/floor patches, O172's failed EWMA touch replacement, or O188's cancelling constant-scale change.

## Exact source anchors

- `membrane-app:scripts/research/history-forecasts/weighted-causal-primary-pair/q26-weighted-causal-primary-pair.py:17–31`: weighted interpolation, training grouping, denominator floor and row-count weights.
- Same source `:72–101`: fixed182-day blocks, block-start maturity, held-fold edges, held-SG exclusion, minimum group count and endpoint clipping.
- Same source `:34–55,105–107`: original group-frequency metrics and scope construction.
- `membrane-app:scripts/research/history-forecasts/r164_ranges.py:177–203`: original ratios, weights, held-SG/block CAL and quantiles.
- `membrane-board:knowledge/q26-research-continuation.md:4322`: O16/O17/O114/O140 all block-frozen, not daily-updated.
- `membrane-board:AGENT_BOARD.md:5299–5307` at inspected snapshot: original ruling10, unseen sets/periods before model fits.
- `membrane-board:design/Q26_ROUND16_PREREG.md:628–630`: specific two-unseen-sets-before-revision-development rule.
- `membrane-board:knowledge/q26-research-continuation.md:4176–4178`: a descriptive label does not waive revision reserves.
- Same knowledge `:4322`: daily was untested; this is evidence of an open question, not authorization.
- `membrane-app:docs/research/R135R_FROZEN_AUDIT_REVIEW_CODEX_2026_10_19.md:62–70`: separate R13.5r training/upstream gap.
