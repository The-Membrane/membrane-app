# Adversarial next-comparison recommendation — design only

**Verdict:** admit preparation of one fixed, narrow three-arm comparison, plus the existing raw-fH contextual anchor. Do not admit fitting/data execution from this note. The identifiable question is whether a fixed state-specific positive scale correction is sufficient for a common residual-depth law in this seen cohort. Generic “scale error versus shape error” is not identifiable: a state-dependent redefinition of scale can change the apparent normalized law. No latent-volatility, causal, market-skill or promotion claim follows.

## What existing work does and does not establish

- O81 already compared the baseline-offset linear/base-XGB/shape-XGB event models. Shape-XGB adds all six D/W/M jump/imbalance features to the same event-target machinery, rather than separating normalization from the ECDF: `train_models.py:61–65,77–88,168–186`. Aggregate H24/−10% raw shape BSS is only 0.00104037; across H6/12/24/72/168 it is −.0215865/−.0109160/.00104037/.00163638/−.0119344. These are the existing JSON aggregate scores, not a new analysis or independent test. A second feature-augmented classifier would largely repeat that question. Its weakness does not prove a shared residual law.
- O86 compares fixed issuance-state marginals, retaining calendar/asset views and matching normalization support (`conditional_depth_v2.py:114–144`). It finds different normalized-depth summaries and event errors, but those marginals mix asset/calendar/scale support; they cannot identify a cause. Its plan explicitly acknowledges that limitation (`DESIGN.DRAFT.md:23–35`). The accepted result is the aggregate JSON at `analysis-v2/result.json:1`; no NPZ arrays were opened for this design task.
- The prior surrogate mechanism study already crossed Gaussian regression-target noise with genuine heterogeneous residual laws. Its .5/.25/.25 analytic pool and nonadditive interpretation are explicit (`r16-fh-mechanism-design-v1/DESIGN.DRAFT.md:17–31`). Repeating that Monte Carlo would not establish market relevance.

## Mandatory bridge: admitted daily rows are not the original fH library

Original staging refits HAR at each quarter and applies that current coefficient to the *entire historical library* before predicting the quarter (`build_inputs.py:117–124`; `a6_touch.py:639–654`). The NPZ only retains each row’s own-quarter issued lsH, rounded to float32 (`build_inputs.py:122,135–143`). Its daily complete-label library also differs from the original hourly, legacy-tolerant library. Do not present a rebuilt NPZ forecast as an exact replay of raw fH, and do not assign its difference from raw fH to scale or pooling. The matched daily pooled arm below is the necessary bridge. Raw stored `p_fH` remains a contextual fourth curve on identical evaluation rows.

## One fixed comparison

Use all five admitted horizons, all five unchanged barriers, the same24 assets, and the already frozen downside-imbalance-D binary cut; unknown is an explicit third state. This axis is selected using already-seen O86 evidence, so the test is retrospective development. No axis/cut/state/model search, Cartesian intersections, new acquisition or new XGB fit.

“Pooled” below means across states **within one asset/horizon/quarter**, not across24 assets. Original fH is itself per-series; pooling all assets would add a new mixture confound. For a quarter Q, define one common training library of issue-eligible, complete, baseline-available daily origins with finite positive effective issued scale and `t+H*3600 <= Q`. Use all of it, equal weight per eligible origin, with no new hash truncation. Every arm uses the same library, cutoff and evaluation-row support. Evaluation covers each own quarter in2024/25. Source precedents: `train_models.py:55–59,168–186`; complete depth and future-window convention: `build_inputs.py:63–76`.

For origin i, preserve signed depth D_i, including D_i>0 and D_i=0. Define

```
s_i = exp(effective issued log sigma_i) * sqrt(H/8760)
Z_i = D_i / s_i
M_g = median_train{|Z_j| : state(j)=g}
W_i = Z_i / M_state(i)
a_i(k) = log1p(k)/s_i

A: shared empirical CDF of Z_j, query a_i(k)
B: shared empirical CDF of W_j, query a_i(k)/M_state(i)
C: own-state empirical CDF of W_j, same query a_i(k)/M_state(i)
```

M_g must be finite and strictly positive; no epsilon floor, clipping of positive depths, alternative quantile, or optimization against barrier losses. Median absolute depth is homogeneous under positive multiplicative scaling, robust, and available in this schema; it is not uniquely “true volatility.” A common global multiplier cancels from both library and threshold, so no extra global-scale arm is informative. Using M_g/M_global instead of M_g is algebraically equivalent here.

**Important correction:** B must pool *rowwise state-normalized W_j*, not the original pooled Z_j with only the test threshold rescaled. Under a true scale-mixture null, the latter retains the very mixture it purports to remove and is not a clean scale-only control.

A→B tests this fixed state-scale correction plus its induced matched re-pooling; B→C adds conditional residual shape after the same correction. Because within-state positive scaling cancels, C is exactly the own-state Z ECDF evaluated at a_i(k). Thus a scale×own-state-CDF2×2 cannot separately estimate a scale effect: its two conditional-CDF arms are algebraically identical. This is a negative-control identity, not evidence that scale never matters.

Freeze fallback handling before any execution: if any **nonempty training state** has M_g zero/nonfinite, rowwise W is undefined for part of the common library; issue A for **both B and C for that entire asset/quarter**, rather than silently removing those training rows. If only the test state has an empty training library, issue A for both B and C on that state. Flag the reason and retain all affected evaluation rows. If A itself lacks a usable library/scale, all three use the same stored raw-fH fallback, with an explicit reason. Unknown states can have their own M/CDF if supported; otherwise use that same paired fallback. Report training counts, M_g, fallback fraction and effective support per asset/quarter/state. Never drop sparse, adverse, rare-event or unknown groups to manufacture common support.

## What can refute the interpretation

- B outperforming A alone is evidence for this constrained scale correction, not a measured improvement in future-sigma forecasts. Historical `lfut` is not an admitted NPZ column; do not smuggle in realized target information or claim a new volatility-regression experiment (`build_inputs.py:140–143`).
- C outperforming B means conditional shape carries predictive information beyond these state-constant scales under this library/protocol. It does not rule out a richer time-varying scale error or asset/calendar composition within each state.
- A new per-state CDF changes effective sample size and calendar composition as well as shape. Report state/year/library support; do not allocate a score difference additively to a physical mechanism. Keep every asset/year/horizon/barrier result. Conditioning separately within each asset removes the most direct cross-asset pooling confound, not all dependence/nonstationarity.
- Re-estimating M from evaluation depths would trivially align observed distributions and leak labels. Keep M and the entire CDF frozen for the quarter. Do not change cutpoints or recut by evaluation year. The existing issued log scale itself uses a past-quarter fit, so replaying NPZ rows is deliberately the own-issued-scale protocol, not current-quarter retrostandardization.

## Cheap controls that should precede any market-row calculation

1. **Exact scale-only null:** use a small deterministic signed-depth library with the same standardized support in each state multiplied by distinct positive c_g. Include a positive minimum and a zero. Require B=C exactly on all fixed queries after median-absolute normalization; A may differ. No simulated-world search is needed.
2. **Equal-scale genuine-shape alternative:** e.g. uniformly distributed signed supports {−4,−2,−1,+.5} and {−8,−2,−1,+.5} have equal median absolute depth1.5 and distinct tails. Verify exact conditional hit probabilities and the pooled mixture; B cannot correct the tail difference and C can represent it. Preserve positive minima.
3. **Algebraic controls:** M_g=1 must make B=A; applying any positive constant within a state to both its library and query must leave C bit-identical. Verify tie-inclusive ECDF, all five barrier monotonicity, empty/unknown state, zero median and common fallback behavior.
4. **Leakage controls:** mutate only strictly post-cutoff depths/labels and assert identical fitted libraries/M/predictions; a label ending exactly at Q remains included. Poison2024/25 features when deriving frozen2022/23 cuts; cut bytes must not change. State features are Xshape[:,3], not a future semivariance statistic (`build_inputs.py:98–101`; `conditional_depth_v2.py:124–142`).
5. **One fixed information-free state control:** the low bit of the first byte of SHA256(`Q26-R17-COND-NEGATIVE-v1:{sid}:{ts}`), shared across horizons, independent of all features/labels, run through the same B/C procedure. Keep it as a finite-sample/partition-complexity diagnostic, not a second route to select a winner. Its gains must not be relabeled evidence for downside-state physics. No repeated seeds or best negative-control selection.

## Fixed estimand and stop rule

Primary development contrast is C−B paired mean Brier at H24, averaged equally over the five fixed barriers, reported separately for2024 and2025 plus the pooled view. Also report H24/−10% explicitly, all individual barriers, bounded logloss with **float labels before unary minus**, observed-minus-expected, missing-label bounds, and every other horizon/year. Shared28-day global calendar blocks, split at year boundaries, can give descriptive paired resampling SD/quantiles; they are not validated confidence intervals, p-values or independent-asset evidence. M and CDF fitting are not rerun using evaluation labels inside this descriptive spread calculation.

One execution only after source/request freeze and cheap controls pass. No axis, median, library window, shrinkage, cap, fallback, or tolerance change after seeing scores. Resource failure stops and preserves evidence; it does not authorize a new seed/model.

Next-action criteria are a **predeclared engineering screen**, not a significance declaration:

- If B helps relative to A but C does not improve B in both primary years, stop conditional-shape development here; retain the constrained scale explanation as sufficient for this comparison, without claiming it is the unique cause.
- If C has lower primary Brier than B in both years, does not worsen primary bounded logloss in either year, and its benefit exceeds the fixed hash-control contrast in both years, that materially supports a later independently admitted conditional-law prototype. All other horizon/barrier harms remain explicit; it does not authorize replacing raw fH or making a full-horizon claim.
- Require the primary C−B Brier difference also to stay negative under each of the24 leave-one-asset-out aggregate evaluations in both years (no refits required). If gains reverse by year, fail that fixed concentration check, or disappear under the matched bridge/control, stop and classify the test as unstable/inconclusive. Do not chase a favorable horizon or retrain an XGB variant.

No numerical effect-size floor or arbitrary significance cutoff is invented after O86. Equality or undefined support fails the advancement screen. Any future “production-useful” effect threshold must come from an explicit decision/cost objective before a later experiment, not this already-spent dataset.

## Paths and evidence boundary

All relative references above resolve under `/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence/`, except `a6_touch.py` which is `/Users/EBmic/research-workspaces/history-forecasts-continuation/scripts/research/history-forecasts/a6_touch.py`. O81 source is `r17-operational-continuation-v3/train_models.py`; producer is `r17-event-pilot-v1/build_inputs.py`; O86 source/design/result are under `r17-conditional-depth-audit-v1/`. These are actual inspected sources. This task read source and existing aggregate JSON only; no NPZ arrays, raw OHLC, fits, Board files or other designer’s proposal file were opened. The parent supplied the convergent three-arm formulation after the initial independent cancellation/library-mismatch findings; this note explicitly refutes/adopts that formulation.
