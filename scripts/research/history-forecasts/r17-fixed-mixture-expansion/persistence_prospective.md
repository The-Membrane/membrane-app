# O188 persistence baseline — source qualification only

CODEX CONTINUATION. No empirical scoring, provider request, fit or reserved
outcome access is admitted by these files. Existing58 source files stay unchanged.

## Frozen target and clock

Use the original annualized close-return RMS sigma, not centered sample standard
deviation, Parkinson variance, or a new fitted volatility model. In original
`a6_touch.py:269–288`, `r[m]=log(close[m]/close[m-1])` and future origin j uses
`r[j:j+24]`. At issuance i, set j=i−24. Persistence therefore uses
`r[i−24:i]`, ending at known `close[i−1]`. Original `a_touch.py:258–262` defines
issuance spot as that same preceding close.

The pure helper calls original `A6.sigma_fut(close,24,start_i)` on the FULL source
grid, then selects `[i−24]`. It never shifts filtered daily/J targets. Irregular
or missing previous J rows cannot replace a 24-hour window with a different one.
Generated future-change tests verify the selected value is unaffected by
`close[i:]`; changing the last known return can change it.

Preserve the original source rules: j≥1, j−1≥start_i, at least one finite return,
positive RMS, and `max_nulls(24,.05)=1` from `a3_touch.py:190–191`. Consequently,
earliest eligible issuance is i≥start_i+25, because24 returns need25 closes.
Zero RMS remains unavailable (NaN), not an epsilon. Nonfinite log returns follow
the exact original tolerance; do not silently repair prices or missing values.

`strict_past` separately records24 finite log returns plus the original start
eligibility. It is diagnostic, not an extra baseline selection filter. The
`finite_past_returns` count remains separate from forecast availability.

## API and source boundaries

`persistence(A6,ser,ts,status=DRAFT)` returns exact timestamp copy, float64
`persistence`, bool `strict_past`, and int32 `finite_past_returns`.

`support_masks(ts,har,ewma,persist,target,status=DRAFT)` exposes forecast
availability separately from positive observed target support and all frozen
comparison masks. It performs no scoring. Single-series timestamps must remain
ordered; panel integration joins exact `(sid,ts)` keys.

Only synthetic READY or parent-reviewed ADMITTED enum crosses the pure gate.
The caller must authenticate original source/runtime/raw inputs and exact J;
this pure component makes no input-authentication claim. No Prep6 construction,
HAR coefficient estimate, solver, window selection, weight or clipping is added.

## Comparison supports frozen before scores

Use the exact accepted full277 J in2024/2025, preserving every row and arm's
availability. Primary point comparisons use THREE-WAY COMMON positive finite
HAR/EWMA/persistence forecasts and positive finite observed target. All three
pairwise supports are also retained, fixed in advance: HAR/EWMA, HAR/persistence,
EWMA/persistence. Their denominators differ and cannot be treated as rankings
on identical cases. Target-positive support is retrospective/outcome-dependent.

Report original squared-log-sigma means and the separately authored normalized
variance-QLIKE metric on each frozen support for pooled2024/2025 and each year.
Retain original null-tolerant target and complete-future diagnostic views. Do not
select the favorable support, discard overflow, invent significance or claim
latent-volatility calibration, unseen skill, downstream touch improvement, or
product readiness. QLIKE helper owns stable metric arithmetic and numerical
refusal; this helper owns only persistence and explicit support masks.

## Planned minimal integration — NOT RUN

Reuse accepted O187v2 saved exact HAR/EWMA/target/strict-future and exact J keys.
Compute only the new persistence baseline from original full raw R12 series per
SID. Save new persistence plus `(sid,ts)` and diagnostic fields; join old scales
by exact keys for independent checking. No HAR/EWMA reconstruction or refit is
needed. Preserve O187 attempt1 codec failure and all previous model failures.

## Generated evidence and limits

Seven tests use the authenticated ORIGINAL `sigma_fut` and `max_nulls` ASTs,
independent direct24-return calculations, future and last-known perturbations,
irregular J, warmup/start boundaries, one-versus-two missing returns, infinity,
zero, flat prices, schema/DRAFT guards, forbidden solvers, and fixed mask cases.
Tests read source only and generated arrays. They do not establish empirical
skill or resource safety. Private tests use Q26_SOURCE_ROOT; installed sibling
layout resolves the original source directory portably.
