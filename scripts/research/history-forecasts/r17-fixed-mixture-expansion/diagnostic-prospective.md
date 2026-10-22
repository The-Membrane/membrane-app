# Fixed accepted-output diagnostic — CODEX CONTINUATION

This is a descriptive, read-only investigation of accepted O168 unchanged-C
forecasts. It adds no model, calibrator, fit, threshold selection, trial, reserve
access or raw-hourly decoder. A calibration gap alone does not establish a data
bug or its cause. Historical zero-event findings from other targets are not
assumed to apply to this H24/-10% population.

## Frozen population and questions

- Target: horizon24, barrier index2 (-10%). Include the complete accepted five-H,
  prediction-only J. Use known H24 labels for L24. L5 is diagnostic and never a
  selection filter. Reconstruct J independently from each authenticated prepared
  horizon's keys, issuance and baseline-valid flags before joining predictions.
- Arms: A_raw_fH, B_common_shape and C_conditional, unchanged.
- Registered edges: `[0,.01,.02,.05,.1,.2,.4,.6,.8,1]`. Internal equality enters
  the higher bin; p=1 remains in the final bin. Low means p<.01; high means p>=.8.
- Report all-J and known-L24 denominators separately. Unknown-label zero
  placeholders count as unknown, never as non-events. Probability sums/means for
  exact-zero/one, high and low categories identify all-J versus known-L24 scope.
- Reconcile nine registered known-only calibration bins against the accepted
  sealed report for pooled,2024 and2025, all3 arms at index2. Counts/events are
  exact; probability sums use absolute tolerance1e-10. Quarter diagnostics use
  the same fixed bins and independent UTC quarter joins.
- Count zeros, ones, high and low by year and quarter. Compare actual A/C zero/high
  membership intersections, differences and unions; equal counts are insufficient.
- Public concentration contains only sorted top counts and shares, never series
  identities. Private concentration retains series IDs for later investigation.

## API and admission

`diagnose_rows(sid,ts,probabilities,y,known,expected_keys=None,status='DRAFT')`
accepts generated arrays under `READY_SYNTHETIC_SOURCE_QUALIFICATION`. Its optional
expected-key authority lets source tests reject omissions, substitutions and
cross-quarter duplicates. Actual `run(path,sha,status='DRAFT')` requires the separate
`READY_PARENT_REVIEWED_FIXED_C_DIAGNOSTIC` enum both as call argument and in the
externally SHA-sealed request, before archive access. It always supplies its own
complete expected J, derived from all277 sealed prepared receipts.

The actual request has exact fields `schema,status,scope,target_index,bins,pins,out`.
Schema is `q26-fixed-c-probability-diagnostic-request-v1`; scope is
`ACCEPTED_FIXED_C_PROBABILITY_DIAGNOSTIC_ONLY`. The five pin roles are
`parent_acceptance,manifest,prepared_manifest,report,source`, each an exact
path/size/SHA256 record. Parent acceptance binds the accepted request/manifest and
closed outcome. Its sealed input-pin index is used as authority; current runtime/native
files, prepared archives, private quarter pairs and summary/report pins used by
this diagnostic are rehashed. Raw-hourly files are not opened or rehashed. ZIP/NPY headers are bounded before decoding;
object arrays, duplicate/missing keys and stale pins refuse.

The output is one fresh0600 JSON beside its private request, outside accepted
source/data/runtime trees, with flush/fsync and exact readback. `public_data`
contains aggregates only; `private_data` contains cases, keys, probabilities and
source references. The entire output must fit1MiB without truncation. Parent
admission separately supplies a fresh hard120-second process bound and verifies
OS-observed peak RSS<=512MiB afterward. This is an observed-memory acceptance
check, not continuous memory containment. No old phase allowance is reused.

## Complete private provenance inventory, before hourly access

Inventory every accepted all-J row with C==0 OR C>=.8, including unknown labels.
Prior-review references of331 zeros and46 high cases are not selection filters;
actual all-J counts may differ from known-only report counts. No full low-bin
case inventory is selected. Each selected case has its SID/key, UTC origin,
quarter, known/unknown outcome, all3 target probabilities and exact prepared/private
artifact references. This is a complete predetermined population, not selected
examples supporting an explanation.

A later separately admitted raw-label audit must replay every selected case using
original frozen hourly-grid alignment and issue spot, all24 low bars
`[idx,idx+24)`, finite-positive validity and the exact original float comparison
`log(min(low)/spot) <= log1p(-.1)`. The mathematically equivalent ratio threshold
should be recorded separately to expose boundary arithmetic rather than silently
substitute it. This label describes retrospective hourly-low touch, not necessarily
an exchange's liquidation mechanism. The present diagnostic does not read hourly
prices, change labels, attribute causality or execute that replay.

## Required source checks

Generated oracle cases cover p=0, the neighbors and equality at .01/.8, p=1,
known true events at zero, unknown labels and mutations, empty populations,
equal-count different cross-arm membership, reordered/duplicated/missing/extra
keys, all-five-H J membership independent of labels, registered-bin reconciliation,
stale pins, object-array refusal and public/private separation. Parent reviews
actual diffs and reruns checks; a separate reviewer refutes the source before any
market-payload admission.
