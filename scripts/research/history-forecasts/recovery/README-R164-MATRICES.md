# CODEX CONTINUATION: original R16.4 loss-matrix reconstruction

This source-only handoff adds the reviewed reconstruction helper and synthetic tests. It includes no private request, manifest, input paths, raw market data, predictions or matrix results. It is not a standalone runnable experiment.

A local request must bind the exact 132 previously admitted private packet files, parent restoration acceptance/retrieval/monitor receipts, original scorer/generator source hashes, this helper/tests and the exact Python/NumPy runtime. It must preserve the helper's fixed original constants and operational policy. Construct and review that private request locally; this patch supplies neither missing identities nor blanket execution authorization.

## Reconstruction contract

Read all 130 sorted original stored NPZs once, retaining the original 127 MAJOR-cluster insertion IDs. Use the single joint finite intersection of all seven main models: a, f, fH, rec12, fix12, recb12, recc12. Preserve original binary labels, threshold indices, horizon and day identities, with 182-day blocks anchored at day 17532. Never substitute a pairwise mask or the 42-series subset.

The twelve original comparison pairs and four horizons (24/72/168/720 hours) are fixed in source. Each horizon retains all support plus the original shallow/mid/deep bands: sixteen groups. Each group has six arrays, making **96 total keys**: Md, MdLo, MdHi (12 x S x B float64), Mn (S x B int64), SIDs and BIDs (int64). Trim zero-support cluster/block margins separately for each group. SIDs denote original MAJOR-cluster IDs, not 130 raw-series ordinals. Mn contains unequal cell counts; Md arrays contain loss sums, not cell means.

Group prefixes are T24/T72/T168/T720 with G0=all, G1=shallow, G2=mid and G3=deep, followed by the array name. The output receipt freezes comparison order, group dimensions, source/input identities, all field dtypes/shapes, row counts and precision qualifications.

## Precision and checks

Stored main probabilities are float16; original generation explicitly saves float32. Conditional on ordinary nearest float32-to-float16 packing, closed adjacent-float16 midpoint intervals (computed in float64 and clamped to [0,1]) conservatively enclose possible original float32 values. The packing operation is not independently proved. Original provenance documents stored float16 versus float32 summaries but does not specify rounding code or rounding mode. Closed endpoints and independently propagated envelopes can include unattainable tie points or jointly unattainable combinations. Compatibility does not recover the original floats.

Binary Brier and R bounds, paired-loss bounds and BSS ratio bounds are propagated explicitly, retaining null or potentially zero reference denominators. The only published-statistic numerical guard is 64 * float64 epsilon * max(1, abs(value)); counts are exact. Float32 singleton intervals are tested; unsupported precision stops for review.

The helper checks exact row/positive-count contracts plus 900 published-summary numerical compatibility checks: base rates, seven-model Brier/R at whole horizons and levels, twelve comparison mean differences/BSS, and all three band BSS values. It does not reconstruct MCB, top-quintile statistics, bootstrap z or leave-top results.

Parent verification separately checks all 576 matrix planes: sixteen groups x twelve comparisons x stored/lower/upper loss sums, against original cell construction, with exact integer denominator and ID support checks. That is distinct from the 900 scalar published-summary compatibility checks; neither proves the packing transform or lost float32 identity.

## Operational boundary

Fresh output folder only: one compressed matrix archive and a metadata receipt, jointly capped at 10 MB. Policy is 1 GB RSS, 2 GB free-disk reserve and 300 seconds; external parent monitoring is required for asynchronous enforcement. Failures preserve a review-hold receipt and partial stage without relaxing reconciliation bounds.

Synthetic tests include full 130-series/127-cluster child-process serialization, unequal denominator cells, MAJOR grouping, all-seven-model exclusion, float16 midpoint envelopes, source-count refusal and preserved failed reconciliation. Run the sibling test script with the reviewed NumPy runtime and numerical thread environment set to one.

No bootstrap, LP replay, new fitting, prediction generation, reserve access, power verdict or model-selection gate is implemented or authorized here. Future bootstrap work requires a separately accepted matrix handoff and protocol.
