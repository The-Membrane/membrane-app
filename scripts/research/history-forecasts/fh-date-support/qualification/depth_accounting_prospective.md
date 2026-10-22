# Q26 same-cohort depth accounting — CODEX CONTINUATION

Status: prospective source qualification only. Historical numerical execution is
NOT ADMITTED YET. This document authorizes neither data decoding nor a new job.
The first scope contains per-vintage empirical accounting and hypothetical
symmetric-allocation envelopes. It excludes cross-vintage contrasts and
older-reference calculations.

## Fixed cohort, historical identity and original arithmetic

Use the single accepted O150 reconstructed CURRENT main cohort, in its complete
original row order. The O150 witness is new reconstruction evidence. Missing
original bridge bytes and complete original authorities remain unrecovered.
Historical bridge parity remains UNAVAILABLE throughout this scope.

Authenticate the accepted O150 plan, started marker, witness, result, saved
acceptance and terminal evidence before decoding. Authenticate original
ancestor/staging/fit/raw/manifest/cuts lineage and the new source/runtime closure.
Every role pin must belong to the file closure. Bind the exact current executable,
packages and one-thread environment. No unseen inputs, downloads or installs.

Reconstruct the entire original raw series using the exact source-qualified
grid loader and Prep6(...,24,with_fbL=False). Preserve whole-array arithmetic.
Use retained coefficients only. Guard fitting, linear solving and prediction
entry points. Never call the original horizon builder, bridge or integration.

Reconstruct current membership, dates, original float32 D and states exactly.
Compare ALL FIVE O150 witness fields before any new accounting: main_index int64,
main_label_end int64, main_state int8, D_original float32 and unknown_partition
int8. Compare dtype, shape, order and bytes, including float32 representation.
Reject missing, extra, reordered, duplicated or changed rows. No tolerance,
renormalized subset or replacement cohort is permitted. Unknown states remain
unknown. Label-end equality at the predecessor is older. Equality at the current
cutoff remains mature.

## Current and predecessor metadata and eligibility

Derive the immediately preceding UTC calendar quarter. Require unique original
H24 metadata records at both cutoffs. For EACH record, verify its own-cutoff
regression count, coefficient-presence rule, training label-end extrema, current
library last label end and fallback-library last label end using original
functions and maturity. The original rule is coef=None exactly when n_reg<4.
Do not fit to repair a discrepancy.

Evaluate original sigma_H and z_of on the WHOLE history using each retained
coefficient vector, then select the unchanged current-main indices. Previous
mapping applies to every fixed current-main row, including recent observations.
Do not intersect with the previous vintage's mature library.

A vintage is eligible only if its coefficient is present and EVERY fixed row has
original validity, finite strictly positive original annualized sigma_H and
finite binary64 standardized depth. Missing predecessor coefficients make the
entire predecessor vintage unavailable. Any invalid row makes the entire vintage
unavailable. Never drop, clamp, fill, replace or reweight invalid rows. Preserve
explicit reasons and invalid-row counts privately. A current-cohort mismatch is
an instrument failure, not an alternate unavailable-data success.

The recovered diagnostic provides the authority: q26-fh-library-diagnostic.py
lines45–51,64–88 and q26-fh-library-diagnostic-run.py lines103–108. This new adapter
does not invoke the old producer, which replays forecasts and requires missing
historical bridge artifacts.

## Observed accounting, separately for each eligible vintage

Require nonempty recent and older date groups. Confirm both known states have
positive support in both groups, with unknown support only in older history.
Use whole-date weights r_s=N_recent,s/N_recent,all and o_s=N_older,s/N_older,all.
Never renormalize onto known states. Alpha=o_unknown remains fixed across eligible
vintages because cohort membership, dates and states remain fixed.

At each finite threshold u, F_recent,s and F_older,s are inclusive empirical CDFs
of original standardized depth. K contains both observed known states. Define:

```text
CK = sum_K (r_s-o_s)*(F_recent,s+F_older,s)/2
WK = sum_K (r_s+o_s)*(F_recent,s-F_older,s)/2
f  = F_older,unknown
U  = -alpha*f
Delta = F_recent,all - F_older,all
Delta = CK + WK + U
```

Counts, weights and linear forms use exact integer/rational arithmetic. Depth
coordinates retain their finite binary64 ordering. Standardized depth creation
uses the original scientific float arithmetic, not a new rational model.
The exact identity is required at every retained state, without numerical epsilon.

## Hypothetical symmetric completion, not a restored observed decomposition

Let x be a hypothetical missing recent unknown-state CDF value, with 0<=x<=1:

```text
C_unknown = -alpha*(x+f)/2
W_unknown =  alpha*(x-f)/2
C_unknown + W_unknown = U

Clo = CK - alpha*(1+f)/2
Chi = CK - alpha*f/2
Wlo = WK - alpha*f/2
Whi = WK + alpha*(1-f)/2

Chi-Clo = Whi-Wlo = alpha/2
Clo+Whi = Chi+Wlo = Delta
```

The two intervals are linked, not a rectangle. Their pointwise sharpness assumes
an unrestricted proper hypothetical missing-state CDF at a finite threshold.
Choices across thresholds must obey monotonicity, support and proper-CDF endpoint
constraints. No imputation or observed full symmetric attribution is performed.

## Knots, finite tails, left limits and reported sup norms

For EACH eligible vintage, retain its entire distinct finite observed-depth knot
union across all six date/state cells. Canonicalize signed zero to one +0
coordinate for ECDF evaluation. Never thin, interpolate or truncate support.
Use inclusive counts at each knot. A knot's left-limit state equals the preceding
right-continuous state, with all observed counts zero before the first knot.

Observed Delta,CK,WK,U are constant between knots. All knots plus the symbolic
finite-left state suffice for their exact sup absolute norms. The last knot
already represents the entire finite right observed tail. At the finite left
state, all four observed functions are zero. At the finite right observed state,
Delta=0,CK=alpha,WK=0,U=-alpha.

Endpoint envelopes have DIFFERENT finite-tail states:

```text
                     Clo       Chi       Wlo       Whi
finite left tail   -alpha/2      0         0       alpha/2
finite right tail      0      alpha/2  -alpha/2       0
```

Include the finite-left state when computing envelope sup norms. Omitting it can
understate a norm. For each fixed proper hypothetical CDF, actual completed C and
W approach zero at infinite endpoints. The pointwise envelope limits need not
collapse: supremum over completions and the tail limit do not commute.

Report exact sup absolute norms separately for Delta,CK,WK,U,Clo,Chi,Wlo,Whi.
The envelope norms describe endpoint envelopes, not an observed completed C/W
decomposition. Individual endpoint maxima need not arise together from one CDF.
Do not report independent extrema as jointly attainable. No minimum achievable
global norm or cross-vintage contrast is included. Such quantities would need
additional CDF-coupled optimization or a separately declared comparison scope.

## Source-gate oracle and observable finish conditions

Use a hand-derived rational fixture, independent of production reducers:

```text
Recent: state0 depths -1,1,1; state1 depth 0
Older: state0 depth 0; state1 depths -1,2; unknown depth 1
Alpha=1/4

u      CK       WK        U       Delta
left   0        0         0        0
-1     1/48    -1/48      0        0
 0     7/48    -7/48      0        0
 1     5/16     3/16     -1/4      1/4
 2     1/4      0        -1/4      0
```

At u=1, both interval lows are1/16 and highs3/16. Only opposite endpoints sum to
Delta=1/4. The finite-left Clo=-1/8 produces its true sup norm1/8. Observed knots
alone incorrectly give5/48. Parent's independent synthetic proof is retained at
/private/tmp/q26-depth-accounting-parent-rational-proof.json.

Source qualification must demonstrate:

- Every rational oracle row, exact identity, interval width and opposite-endpoint
  identity agrees with a separately implemented saved checker.
- Duplicate knots, signed zero, inclusive ties, left limits and both finite tails
  are retained correctly. The missing-left-tail regression fails when omitted.
- None coefficients and invalid/nonfinite/zero/negative scales preserve whole-
  vintage unavailability. Another eligible vintage remains independently usable.
- Every one of the five cohort-field mismatch classes refuses before accounting.
  Positive parity compares complete typed bytes, without row intersection.
- Refit/prediction spies fail, and original whole-array constructor/guard wiring
  qualifies on a generated synthetic grid in cold processes.
- New source pins, output schema, admitted argv and independent saved-checker
  receipts are parent-reviewed. No raw historical arrays are decoded during this
  source-only qualification.

## Fresh execution admission remains pending

Expected limits follow existing O150 containment: a NEW finite90-second phase,
one producer capped60 seconds and one independent checker capped30 seconds.
Aggregate sampled process-group RSS ceiling is768MiB. Preserve2GiB free disk plus
256MiB admission margin. Bind output/log capacity and full-support capacities in
the immutable request. Admission requires qualified sealed producer/checker
commands, exact source/input/runtime pins, fresh exclusive outputs, successful
prelaunch authentication and terminal/reaping/no-live-member evidence. Actual
sampled limits must not be represented as continuous peak proofs.

This prospective expectation is not an admitted request. No closed phase's
unused allocation can transfer. Failures remain recorded without silent retries,
favorable-subset salvage or after-the-fact scope changes.

Acceptance requires complete cohort parity, original metadata/eligibility checks,
all-knot exact accounting, full witness output and independent saved acceptance.
Historical bridge parity remains UNAVAILABLE after success. The original full
symmetric decomposition remains unavailable. Dependent-label sampling uncertainty
is separate and unquantified. No confidence interval, causal drift, forecast skill,
model promotion, age window, half-life or weighting recommendation follows.
