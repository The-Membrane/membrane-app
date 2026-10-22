# O12 paired prediction-error accounting — prospective diagnostic

CODEX CONTINUATION. Source-only specification. No payload retrieval, decoding,
scientific execution or model fitting is admitted by this document.

## Question and frozen population

Determine whether retained GJR forecast error is associated with event misses,
non-event errors or exact wrong certainty. This is probability-level accounting,
not identification of feedback, conditional variance or a pool mechanism.
Use the authenticated O12 `intraday-real.json.gz` rows and `step-real.json.gz`
summary. Retain every native row and original declared selected series. These are
spent development observations. Neither recovery nor a new metric makes them blind.

Original horizons are 24, 72, 168 and 720 hours, with k=0..9 at each horizon.
No barrier value is inferred from k. All 40 cells remain, including empty cells.
Also retain the original per-horizon all/mid/deep bands: k0..9, k4..6 and k7..9.
These overlap, so their row counts and losses must not be pooled together.

The primary support ledger is original four-arm complete support, in source
order garch/fH/rec12/base12. Its exclusion precedence is original: invalid outcome,
missing arm(s), then invalid prediction. A separately named five-arm ledger adds
h3 validity to that support. It is never substituted for the original four-arm
denominator. Unknown/unavailable probabilities remain excluded with explicit
native counts and reasons. Exact probabilities zero and one remain valid.

The inherited censored-origin list describes origins absent from native rows.
Its entry and stored-row totals remain separate from all loss denominators.
Its flattened source format does not permit independent per-series or per-cell
allocation. Do not infer labels, probabilities or zero loss for those rows.

## Fixed views and arithmetic

For each support, report all 52 cells/bands on: all native rows, each original
selected series in sorted anonymous ordinal order, and each native `block182`
value in sorted order. The original formula is
`(timestamp // 86400 - 17532) // 182`; timestamp is not reconstructed from i0
without the missing series base time. The archived integer is source-qualified.
No year, new regime, SG, feature threshold or winner-selected subset is invented.

For every arm, Brier is the mean of `(p-y)**2`. Event and non-event contributions
sum their respective losses and divide by ALL common rows, not event-specific
counts. Separately labeled event/non-event conditional means divide by their own
counts and are null for empty categories. Pairwise deltas subtract the two row
losses before `math.fsum`, with the same event partition and common denominator.
All unordered arm pairs are retained. Their direction follows priority
fH, rec12, base12, garch, h3: later priority minus earlier priority.

Also report mean forecast, event frequency, signed bias, exact-zero/exact-one
counts, exact-zero events and exact-one non-events. No near-endpoint threshold
is introduced. Brier and mean summaries are factual accounting, not significance.
Historical NumPy means and fresh fsum comparisons use fixed 1e-12 absolute OR
relative numerical agreement. Counts, support keys and categories compare exactly.

Bounded logloss is OMITTED: O12's original real summary defines no logloss or
clipping rule. Public `logloss_status` is exactly `not_defined_in_O12`.
Do not silently import a later study's epsilon or present a new clipped score as
an original O12 metric. No bootstrap, confidence interval, power or promotion test.

## Provenance and reconciliation

The wrapper must authenticate immutable archive provenance, compressed and inner
identities, source identities and selected-series lineage before decoding. The
pure API `analyze(intraday_report, step_summary)` receives already decoded objects;
it does not authenticate files, download data or run a loader.

Bind intraday config.prior_signature to the step summary signature and selected
series to the original selected population. An authenticated selected subset can
be reported honestly, but its four-arm total is not compared with a wider original
summary. Exact-scope comparisons also require native row counts to agree. The
independent saved consumer checks original four-arm summaries only when scope is
comparable; five-arm GJR and h3 summaries use their own original intraday support.
It reproduces h3's source substitution of p_h3 for p_garch without relabeling the
actual retained garch column. Duplicate (series,i0,T,k) keys are structural refusal.
Malformed identities, missing required fields and nonnumeric probability types
are structural refusal. Numeric invalid outcomes/probabilities remain counted
using the original exclusion ledger, with no missing-as-zero conversion.

Producing source evidence, all under the original continuation source directory:

- `r164_step_real_review.py:26,73–90`: model order and original common support.
- `r164_step_real_review.py:93–141`: Brier/BSS/R and original overlapping bands.
- `r164_step_real_review.py:196–223`: fitted state is local; rows retain forecasts
  and fit-count metadata, not coefficients, origin variance or residual pools.
- `r164_step_real_review.py:275–290`: checkpoints serialize that result; the top
  real-step report excludes rows from its per-series summaries.
- `r164_intraday_review.py:207–228`: old rows are copied, h3 is appended, and all
  joined rows are embedded. Both intraday summaries use five-arm common support.
- `r164_step_review.py:167–211,257–260`: a genuine feedback/fixed-scale comparison
  requires the same fitted model, h0, paired pool and RNG. Its retained paired
  fixed-scale branch is synthetic, not a new real-data ablation.
- `r164_recursive.py:72`: the four original horizons.

Repository-qualified producer citations resolve under
`membrane-app:scripts/research/history-forecasts/`.
Source-qualified inheritance does not independently reconstruct raw bars,
original fitted states, O33/O35 missing states or per-origin checkpoint bytes.

## Exact safe result schema

Root: schema=`q26-step-error-accounting-v1`, attribution=`CODEX CONTINUATION`,
scope (fixed diagnostic literal), input_coverage, logloss_status, supports,
interpretation (fixed limits).

input_coverage: native_rows, selected_series (count), inherited_censored_origins,
inherited_censored_rows, censored_reason_counts, original_four_summary_scope_match.

supports: two entries, named four_arm and five_arm, each with arms, common_rows,
excluded_rows, reason_counts and views.

Each view: scope (`all`, `series_%03d` or `block_<native integer>`), horizon,
depth (`k0`..`k9`, all/mid/deep), native_rows, common_rows, excluded_rows,
reason_counts, native_availability, events, non_events, models, pair_deltas.
native_availability maps each arm to valid/missing/invalid counts on native rows.

Each model: brier, event_contribution, non_event_contribution,
event_conditional_mean, non_event_conditional_mean, mean_prediction,
event_frequency, signed_bias, exact_zero, exact_one, zero_events, one_non_events.
Each pair: brier, event_contribution, non_event_contribution. Losses and means are
null on empty support, while counts remain zero. No original series names, origin
keys, probabilities, labels, learned states, archive hashes or operational pins
enter this public result. Exact source/runtime identities belong in private
execution receipts. No arbitrary input strings are copied into public metadata.

## Resource and independent evidence plan

One separately admitted decode/accounting job: at most 90 seconds, 1 GiB RSS,
64 MiB outputs and 2 GiB free-space reserve. At most 96 MiB uncompressed per input
report and 300,000 native rows. A 10,000-total-view structural resource cap refuses
the entire job instead of truncating scopes. No new scientific selection follows
from these resource bounds. Gzip decoding, metadata validation and execution are
within the wrapper's full wall cap. No scientific input is opened this source turn.

One saved check separately capped at 90 seconds, same RSS/output/reserve limits.
Reuse the existing qualified external observer and authenticated runtime/guard.
No new supervisor is needed. The independent consumer uses separate Python loops
and sum identities, verifies every cell/view/count/component, reconciles original
summaries under their proper support, and never calls the producer analysis or
original summarize/bootstrap functions. Tiny synthetic fixtures precede admission.

Any provenance mismatch, duplicate key, unsupported schema, resource breach or
arithmetic disagreement is refusal. Preserve failures and partial private evidence.
No automatic retry, simulation, refit, endpoint repair or model promotion follows.
Publication follows the canonical Board workflow and labels this CODEX CONTINUATION.
