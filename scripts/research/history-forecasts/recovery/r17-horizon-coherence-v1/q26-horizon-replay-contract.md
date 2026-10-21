# O92 independent O88 replay-contract audit — source/metadata only

No NPZ arrays, row outcomes, fit or replay executed. Read the actual accepted request/source/result and linked JSON metadata. This is contract guidance, not clearance of the implementation now being written.

## Exact accepted closure

O88 directory: /Users/EBmic/research-workspaces/history-forecasts-recovery-evidence/r17-conditional-cdf-comparison-v1.
- request.parent.json:5719B SHA256 c0992f2e281ee6f4a1028b2eadb614da0cf075d594db5488486f7fee2dcad422; /status=PARENT_FROZEN_COMPARISON, not the DRAFT.
- cdf_comparison.py:18985B SHA256 f5cae4471db94e1a5e3b187db1c90192aad70f4fa2758fcb98df95ed6b08c7f1.
- result-v1/result.json:2936939B SHA256 d55a37fe60f5aa7d31d25a631fd664acabb80ce6803cc577e29dbc18fc6d7cb7.
- result-v1.outer-receipt.json SHA256 9ffaf69957de240927a900d50d36f33b06028ddbb1ea48d23e42624777e678e9: execution_complete true, returncode0, timed_out false, unchanged pins; /expected_pins includes the exact accepted request above and /result_pin binds d55a.... Require expected/post pin lists equality and this linkage. O88 result has source/cuts/base pins but NO direct accepted-request pin; result self-fields alone are not the full admission chain.
- Accepted /base_request_pin: analyze-v2.request.parent.json SHA5484fcfca49d29cf8792a507c66f0ff7ea4e0e545dbf28ba36b11322b27ffc99. /cuts_pin SHA15119684a77a93e62da694ae0392c5c6922d5ecf821984796d61995872499ce4. Do not regenerate cuts.

## Required original replay comparison, before accepting PAV scores

Key objects by semantic identity, rejecting duplicate/missing/extra keys, not zip-truncating lists. Preserve original list order in output if convenient, but order alone is not identity.

1. /horizons must be exactly string keys6,12,24,72,168. Each /horizons/H/point_views has54 records:3 calendar pooled/2024/2025 +24 SID marginals +3 axes x3 states x3 calendars=27. Across H this is270 views, each with all five barriers and six arms, not270 scalar scores. Source cdf_comparison.py:85-91; helper conditional_depth_v2.py:114-121. View key=(view_type,view); identical names such as unknown/pooled occur under different axes. State cuts/features differ by H, so do not construct one state mask and broadcast it across H.

2. Every view's exact support fields: issued_n,baseline_unavailable_n,scored_n,unknown_label_n,unknown_state_issued_n,future_missing_hours,legacy_label_n. Every /arms/{raw_fH,A_pooled_Z,B_pooled_W,C_state_Z,hash_B,hash_C}: n,events[5],mean_probability[5],observed_frequency[5],brier[5],bounded_logloss[5],logloss_clipped[5],observed_over_expected[5]. Source:77-91. Preserve nulls: O/E undefined or empty support is not zero. Counts/identities/nulls compare exactly; original scalar float comparison tolerance can stay rtol2e-13/atol2e-12 from source:111, frozen before replay. No widening after a mismatch.

3. /paired_brier_difference and /all_available_paired_bounds require the exact six contrast names from source:10: C_minus_B,C_minus_A,hash_C_minus_hash_B,A_minus_raw_fH,B_minus_raw_fH,C_minus_raw_fH. Differences retain barrier order. Bounds have n,unknown_n,lower[5],upper[5] and use all baseline-available rows, not just complete labels. Source:82-90. Cast uint8 y to float before signed arithmetic; missing placeholders never become scored zero events.

4. /horizons/H/folds has191 realized records/H,955 total, NOT the upper192/960 plan. Key=(H,sid,quarter_start), checking quarter_end and every metadata field: issued_n,mature_issued_n,training_exclusions_overlapping,library_unique_Z,state_historical_events,library_n,library_dates,library_blocks,library_label_end_min/max,library_membership_sha256,historical_events plus full main and negative_control subobjects. Source:54-72. Each subobject has median[2],conditional_fallback_reason,bridge_raw_fallback_n,unknown_state_n,B_transformed_query_ties[5],state_n[2],state_unique_Z[2],B_C_equal_A_fallback_n,conditional_query_invalid_n,W_distinct_Z_collapses[2] or null. Compare them all; same counts alone do not prove same row membership or same normalization. Fallback/null medians and unequal state sample sizes are real observed cases, not exceptional records to omit.

5. Preserve /main_nonfallback_point_sensitivity three calendar records/H=15 total, including issued_no_fallback_n,scored_n,unknown_label_n, A/B/C scores, C-B/C-A paired differences and missing bounds. Source:94-98. They have a different support from full issuance; they must not replace the original full scores or the new all-five-complete theorem cohort.

6. /cross_horizon has60 records:10 unordered H pairs x6 arms. Key=(short_h,long_h,arm). All fields common_origins,repeated_barrier_exposures,violations,max_positive_violation compare. Source:130-137 joins exact SID/time on prediction availability, NOT on complete labels or state membership. It aggregates all five barriers in each record; no per-barrier reversal totals are archived. Source:182 forms availability as issue_eligible&p_fH_valid&2024/25. Actual metadata has17180 common origins in every pair and85900 repeated barrier exposures/record; do not infer the general rule that future supports must coincide.

7. Source:101-113 original raw-reference check is27 calendar/asset views x5 barriers x3 metric comparisons=405 scalar comparisons/H; /reference_metric_checks is405 for every H. Thus675 raw reference cells across all H,2025 scalar comparisons. A new comparator that expects675 scalar checks would undercount.

## Primary and original sensitivities

Primary H24/-10 is barrier index2, never a five-barrier mean. Original full scored counts:17180 pooled,8420 year2024,8760 year2025. Source:116-122 uses full per-H complete/available rows, not nonfallback-only or all-five-complete L. Preserve the opposing-year weaknesses instead of scoring the replay first on a newly restricted cohort.

Original /primary_sensitivity has six targets (C-B/C-A xpooled/2024/2025),500 draws,seed2026106000 and weight_sha256. Source:116-122 plus helper:92-97 generates separate year SeedSequence streams, global date blocks across assets and no refit. Original /primary_leave_one_asset_out has72 records keyed(year,omitted_sid), each with n and C-B/C-A/hash-C-minus-hash-B primary differences. Source:123-127 omits only evaluation losses, never refits. These remain historical original-forecast evidence; do not relabel them as projected-forecast sensitivities. Reconciliation may rerun the same deterministic derived arithmetic, but projection inference is not licensed by the original intervals.

## Pure predictor/import/runtime contract and pitfalls

cdf_comparison.py imports stdlib+NumPy only (:3-6); functions ecdf,state_of,hash_states,issued_scale,standardized,fit_libraries,predict_fold,mature_mask,quarter_starts,make_predictions are the replay implementation (:13-75). Keep original whole arrays, original row order and source constants (2022+ libraries,2024/25 evaluation, eight quarter starts); no new feature filtering or H168 maturity mask for short-H original libraries. C's direct own-state-Z computation must stay direct, not a numerically different W/t division at ties (:46). Preserve the main D-known training membership for hash controls (:61,69), first byte digest bit, and all fallback reasons (:37-51). A purity check can reject scipy/torch/xgboost imports; none are required to evaluate these empirical CDFs.

Admission (:147-153) imports the pinned base /execution_source_pin conditional_depth_v2.py SHA1bfd3d85f035b4e32e2b1d01edf4ba881595ce1e588615c380c60d96e277881e from its original path. That helper's authenticate(:66-77) verifies exact Python lexical executable/version and NumPy version,363 closure pins plus input/metadata pins, predecessor history, accepted build/manifest/input/cohort/feature identities. O88 current source identity uses __file__.resolve for module identity; helper's execution_identity(:46-49) likewise binds its own accepted path. Import the pinned modules at their actual admitted paths; copying the full helper to a new directory can break its source/relative frozen-cut identity. The new runner separately authenticates its own source/request; calling old admission alone does NOT bind the new runner or enforce all new request protocol constants.

Runtime: /Users/EBmic/research-workspaces/history-forecasts-recovery-runtime/bin/python,Python3.12.14,NumPy2.5.4. Base closure contains363 pins totaling662875740 bytes; underlying identity metadata records325 native pins and interpreter pin SHA037855106cd54d93abad568c82f87e6419d41df05d116b2a183e57be76ee06d9. This historical closure includes Torch and other native files, but hashing them is not importing them and does not require new packages. Keep the inherited closure rather than silently pruning it; count hashing in the wall budget. Exact path/size/SHA checks in both sources preserve lexical paths (:140-146 / helper:13-19). Do not resolve every stored pin path into a different symlink representation, or replace the required lexical sys.executable with its resolved target. Preserve single-thread env set before NumPy import.

The fourteen NPZ members are exactly source:11. No new raw OHLC or full prediction archive is needed. Original row predictions are memory-only (:175-183); deterministic replay is required. Original metadata does not archive per-view row-ID hashes, so matching270 aggregates cannot alone prove evaluation membership/rowwise identity. Reconstruct membership from the same pinned input arrays and exact helper.views; record new keyed row-ID hashes for availability,per-H scored views,J,L to make the new audit durable. Training membership hashes already exist and must match.

## Executable synthetic/mutation checks recommended before admission

- Make synthetic270 views/955 folds/60 cross-H records and prove deletion,duplication,extra semantic key or changed count/null/median/membership hash fails. Comparing only lengths is inadequate. Use empty unknown-state view with null mean/OE and valid empirical p=0/1 cases.
- Swap two equal-count rows between same-year/asset feature strata; demonstrate metrics alone are insufficient and keyed row-ID fingerprints catch the permutation. Shuffle H input row order independently and check an exact SID/time join recovers the same aligned grid; duplicate keys must fail.
- Construct shorter-H valid/longer-H missing label rows, and prediction-available but incomplete-label rows. Verify original cross-H availability and270 view supports stay unchanged while J/L masks remain separate. Outside J leave original forecasts unchanged and report residual full-pair reversals; zero-after-PAV claim applies on J, not an assumed universal cohort.
- Freeze a fixture with H24 differing from H12/H72 and barrier2 differing from the five-barrier mean; verify primary/year/LOO selections. Ensure original six sensitivities are not copied into projected fields.
- Perturb each one of main/negative-control fallback reason,unknown-state count,quantile median,tie count or library row hash; replay comparison must fail despite identical pooled n.
- Temporary lexical interpreter symlink with identical content must satisfy byte pins at the admitted lexical path; altered bytes must fail. Wrong accepted request with same base/cut pins must fail against the original outer receipt/request identity. A changed closure member/native pin must fail before arrays, without imports of the package it belongs to.

    accepted request + outer receipt + immutable result
                           |
                exact pinned replay and keyed checks
                           |
             original supports/folds/scores reconciled
                           |
                   new no-label PAV stage
