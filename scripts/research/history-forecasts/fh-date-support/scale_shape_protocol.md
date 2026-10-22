# Q26 known-state scale and shape diagnostic — CODEX CONTINUATION

This is a prospective saved-data diagnostic following accepted O153. No additional
array summaries have been inspected to choose its parameters. It is descriptive
research on exposed development data, not a forecasting candidate or blind test.

## Target and source orientation

Use the complete accepted O153 current-main basis and its authenticated evidence.
Keep both eligible coefficient vintages and both known downside states, producing
all four state/vintage comparisons. Older means label_end <= immediate predecessor
cutoff. Recent means label_end > cutoff. Retain original membership and all rows.

Original a3_touch.py:377 defines depth=log(future_minimum/issuance_spot).
The future-low window at :173 excludes issuance spot. Original a6_touch.py:654
divides this signed depth by positive annualized volatility scale. Original
a2_touch.py:600–609 counts inclusive z <= negative barrier thresholds.

Define X=-Z before sorting or computing any statistic. This is SIGNED adverse
orientation, not an assertion that X is nonnegative. Negative X represents a
favorable future minimum. Preserve negative values, zeros, ties and all finite
values. Do not take absolute values, clip at zero or remove favorable paths.
The sign is fixed by original source semantics before empirical inspection.

Unknown-state rows remain in the authenticated full input and its count checks.
The present conditional target is explicitly restricted to the two known states.
It does not impute the unknown law or repair the unavailable original symmetric
decomposition. Conditional cell denominators are distinct from O153's whole-date
accounting weights. Never describe these statistics as a replacement global gap.

## Fixed statistics and conventions

For each of the four comparisons, use every older and recent X in that state.
Require both cells nonempty. The fixed quantile probabilities are exact rational
1/10, 1/4, 1/2, 3/4, 9/10, 19/20 and 99/100. Use nearest-rank order statistics:
sorted_X[ceil(p*n)-1]. The even-sample median is the lower median under this rule.
Do not interpolate or choose a different quantile convention after inspection.

Report the raw two-sample ECDF supremum gap with inclusive counts at the complete
tied support union. Counts and the resulting fraction are exact. Include zero
left-tail difference. Positive and negative zero are one ECDF coordinate.

If BOTH cell medians are strictly positive, divide each group's X by its own
empirical median. Compute the normalized ECDF supremum gap and each fixed quantile
divided by its own median. Division and ordering use exact rational values of
the original finite binary64 numbers, avoiding overflow and artificial rounded
ties. This estimates descriptive scale from the same samples. It is not an
ex ante correction or evidence of predictive calibration.

If either median is nonpositive, mark the paired normalization UNAVAILABLE.
Still retain both cells, raw ECDF gap and every raw quantile. Do not substitute
another scale or remove the inconvenient cell. Report all four cases without
averaging, selecting or silently discarding unsupported results.

Report normalized-gap direction as smaller, equal or larger than the raw gap.
There is no pass threshold, pooled winner, p-value, confidence label or claim
that a smaller normalized gap proves a scale mechanism. Shape differences can
remain after rescaling. All quantile profiles must be retained, including weak
or adverse results. Dependence and prior development exposure remain unquantified.

## Input and verification boundaries

Pin the accepted basis, depth result, independent acceptance, parent acceptance,
closed phase, immutable admission, producer/checker requests and actual terminals,
original plan/runtime and pinned depth-checker source used only for bounded NPY
header checking. Authenticate these metadata/hash chains before array decoding.
Do not rerun original loaders, feature construction, fitting or forecasts.

Validate all fifteen archive headers, <=64 MiB archive/expanded capacity and
<=200000 original rows. Decode ONLY current_z, previous_z, main_state and
main_label_end. Verify typed shapes, finite values, date/state domains, full
row count and six state/date counts against both accepted vintage reports.
Then apply the declared sign change to new arrays. The input remains read-only.

Use independent producer/checker reductions, without importing the new producer
into the checker. Meaningful synthetic checks include pure scale shifts, a
same-median tail change, unequal counts, ties, signed favorable values, zero
medians and finite outliers whose floating division would overflow into false
ties. Verify exact complete report equality and original input immutability.

## Execution scope

Historical saved-data execution remains NOT ADMITTED until source/fixture gates
and exact request pins are verified by the parent. The planned fresh allowance
is 30 seconds: one nonspawning producer capped at20 and one conditional checker
capped at10. No unused prior phase capacity transfers. Parent uses bounded
process-group deadlines, reaps each child and verifies no surviving members.

Input/header capacity, decoded row count and output <=1 MiB are source-enforced.
Check disk >=2 GiB plus256 MiB at boundaries. This saved-only scope makes no
continuous RSS or disk-sampling claim. No new model-observer framework is needed.
Retain commands, source/input pins, logs, terminal evidence and failures without
silent retries. Outputs are exclusive and outside the accepted O153 input root.

No model fitting, forecasts, forecast scoring, unseen/reserved access, weight or
window selection, retuning or promotion is authorized by this diagnostic.
O140's failed chronological weighting, original step/range findings and blind
A/B NOT RUN remain unchanged. Original historical bridge parity remains
UNAVAILABLE. The full forecasting research goal remains active.
