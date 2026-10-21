# R17 horizon coherence — implementation DRAFT, no scientific execution

This new source implements the parent-reviewed O92 design in membrane-board/design/q26-r17-horizon-coherence-2026-10-21.md, SHA256 ee0c2bcf972b53625204ff5b31eea803568336b727a7ad4f84384840e3121a54. The design, O88 science and accepted results remain immutable. No actual NPZ or outcome rows have been accessed during authoring. A refusing draft is not execution admission.

## Frozen replay before projection

Import the exact O88 cdf_comparison.py SHA256 f5cae4471db94e1a5e3b187db1c90192aad70f4fa2758fcb98df95ed6b08c7f1. Its unchanged admission function authenticates the original O86 source/base/cuts and input graph. The new admission additionally binds the accepted O88 request c0992f2e281ee6f4a1028b2eadb614da0cf075d594db5488486f7fee2dcad422, result d55a37fe60f5aa7d31d25a631fd664acabb80ce6803cc577e29dbc18fc6d7cb7, successful outer expected/post-pin equality and exact request/result inclusion, and independent accepted/request_pin/result_pin schema. The result itself has no request pin, so that binding must not be invented from its top-level fields.

Rehash the 325 inherited runtime/native pins plus interpreter from the pinned O86 identity audit. Preserve absolute lexical symlink paths in content pins and check invoked/resolved interpreter and prefix separately. Verify the three one-thread environment variables before importing the original predictor, which otherwise sets them itself. No dependency installation or Torch/SciPy import is used.

Read the same five admitted NPZ archives, only the fourteen O88 members. The actual producer writes sid int32 and ts int64. Reject other key dtypes instead of coercing them. Re-run unchanged metadata/complete-label/baseline-availability checks and deterministic predictor. Reconcile every original 54-view point/support record per horizon, all stored training-fold records including membership hashes/medians/fallbacks, all 15 nonfallback views, and all 60 original cross-horizon records before admitting projected scores. Exact cleaned scalar/list/dictionary equality is required because source/runtime/inputs are unchanged. There is no new tolerance. Expected realized fold count is taken from the accepted result (955), not the planned 960. Do not rerun bootstrap/asset-omission summaries or copy their sensitivities to projections.

## J and L have distinct roles

J is an exact unique (int32 SID,int64 UTC time) five-H join using evaluation issuance, baseline availability and all-six-arm finite [0,1] forecasts only. It never reads labels. Project only full five-H vectors for all five barriers under the same equal-weight policy. Outside J, every originally available forecast stays unchanged. Report baseline/nonfinite/out-of-range/excluded availability, missing other-H keys, present-but-unavailable other-H keys, all per-H availability and original-scored membership hashes, plus canonical sorted J/L membership hashes. Newly reconstructed per-view hashes are new audit evidence, not purported archived O88 row hashes.

L is J intersect complete labels at every horizon. Assert binary/severity/horizon label nesting and the longer-complete-implies-shorter-complete prefix property. Missing label placeholders are not scored. Only L and its horizon-independent pooled/year/asset subsets carry the equal-weight summed-H squared-error theorem. Original per-H and state views retain their own original memberships, including cohorts outside J and incomplete vectors. No selection-bias or missing-at-random claim follows.

## Projection and fixed arithmetic budget

Find violating vectors in NumPy, then perform equal-weight PAV with exact integer dyadic block sums and cross-product mean comparisons. Already ordered vectors are copied identically. Each pooled mean is converted once from an exact Fraction to binary64. Identical five-H weights are used for every severity, preserving severity order. Validate [0,1], severity and horizon order. The declared residual diagnostic tolerance remains 1e-12, matching O88, rather than a new payload-chosen threshold.

The summed-H theorem gap is computed as sum_H(q-y)^2 - sum_H(p-y)^2 + sum_H(p-q)^2. Its fixed per-origin/barrier upper arithmetic budget is derived before payload. With u=2^-53, gamma4=4u/(1-4u), gamma2=2u/(1-2u), A=20u+5*gamma4*(1+4u), the budget is:

    5*(4u+2u^2) + 3*A + gamma2*(15+3*A).

The first term bounds rounding exact PAV block means in both loss and projection distance. Each rounded subtract-square contributes at most4u absolute error on [0,1]. A covers each five-term sum, and gamma2 covers the final two additions. The exact rational is converted upward to binary64, approximately1.8874e-14. This is a fixed absolute calculation bound, not a data tolerance or inference interval. For an n-vector subset, add the predeclared reduction budget gamma_(n-1)*15*n to n times the per-vector budget. Fail on any excess. Preserve worst positive per-vector gap and all pooled/year/asset sums. Exact Fraction oracle fixtures independently test the PAV kernel via max-min interval averages, rather than copying the implementation or parent's independent checker.

## Complete output, adverse coordinates and missingness

All six arms, five horizons, five barriers, both years and 24 asset marginals remain. Preserve all 270 original and projected point views with raw Brier, bounded epsilon1e-6 logloss/clips, events, probability means, O/E and exact 0/1 counts. Retain projected-minus-original paired losses, original/projected C-B/C-A/hash contrasts, and unknown-label Brier endpoint bounds for all originally available forecasts. The endpoint bounds are conservative independent-label bounds and ignore unknown-label nesting.

Report primary H24/-10 pooled/by-year descriptive bins with fixed edges [0,.01,.02,.05,.1,.2,.4,.6,.8,1], last edge inclusive. Retain empty bins and counts/events/probability/Brier sums. No individual-probability calibration claim follows.

On full J report all ten H pairs per arm with per-barrier original/projected violation counts and maxima, changed vectors/cells, maximum corrections and ties. On L report per-origin theorem checks in memory and only compact pooled/year/asset aggregates, including every individual-H Brier coordinate. No per-row prediction or theorem-vector archive is written. A projection can worsen H24 Brier or bounded logloss and this is not an acceptance failure. The fixed epsilon counterexample p=(2eps,0,1,1,1), y=all1 improves summed Brier by2eps^2 while worsening clipped-logloss sum by ln2. This is not a causal explanation of any historical logloss tradeoff.

## Controls and current status

request.DRAFT.json refuses before payload authentication. Tests include producer dtypes, shuffled IDs, duplicate IDs, missing-H support, label-independent J, nonnested-label refusal, full alignment→projection→270-view/calibration/unknown-label reporting, binary uint8/bool/float losses, 0/1 endpoints, undefined O/E, exact PAV oracle, and positive metadata closure with symlink/source/native/request/output-path failure cases. The original predictor, helper views and metrics are imported unchanged for synthetic reporting only. No real data, new fit, cut, calibration map, interpolation, resampling or model selection is authorized by source creation.

A later separately frozen parent request gets one fresh 120-second serial attempt,1,000,000,000-byte RSS,2,147,483,648-byte free reserve and10,000,000-byte recursive owned output cap. Parent outer guarding is required. Internal alarm/resources, stage/error code and partial replay progress remain durable on failure. Final authentication rechecks request, original artifacts, native files and source identities. No automatic retry follows a hold.
