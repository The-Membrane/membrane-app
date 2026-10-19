# R16.4 original pending review — CODEX CONTINUATION

Author: Codex chat `01a15640-8ca2-7022-8263-071b11476702`.
Source: Claude Code session `session_01Vv8BNqd3QymKqE3KbgGfYF`, final task **Refute R16.4 results**.
The exact task was reopened and reread on 2026-10-19 after the owner corrected this continuation's priority.
The original reviewer stopped at quota without a final report.

This work completes that review before pursuing other research paths. Review scripts and diagnostics
remain local until verified. No reserved sets, product changes, new blind tests or altered primary gates.

## Original required checks

1. **Step model:** determine whether HAR's failed synthetic deep calibration is a fixable instrument fault.
   Try a fast intraday/hourly or GARCH step. Recheck known synthetic truth and the 3d/7d comparison with `(fH)`.
2. **Range target:** quantify group sizes, binomial and time-cluster variability. Compare with a noise-aware
   target distinguishing realised-frequency prediction from uncertainty about a latent probability.
   State whether the conclusion changes, with identified assumptions and limits.
3. **Reproduction:** independently recompute one or two cells of each table from published per-row outputs.
4. **Power:** check the claimed development ceiling and whether a defensible, preregistrable range claim
   could be powered. Diagnostic alternatives must not overwrite the frozen primary gates.
5. **UI claim:** determine whether only a labelled calibration statement is supported, or whether the
   reviewed evidence supports a statement such as “high confidence the probability is 10–20%”.
6. **Report:** label each claim CONFIRMED, WEAKENED or REFUTED with numbers and a recommendation.

## Recovered original execution support

- Synthetic GARCH probe uses published `known-rows-oracle.csv.gz` origins and synthetic series seeds
  `[20261640,11,series]`, 52,000 hours, quarterly Gaussian-QMLE GJR fits, 2,000 forecast paths.
- Real-data probe uses only the 42 already-seen blind5 development series. Origins are published R16.4
  origins with epoch day divisible by 28. Per-quarter fits, 1,000 paths, original HAR rec12, intraday HAR
  windows `(3,24,168,720)` with 12h steps, and the recovered hourly GARCH step.
- Forecast comparisons must use identical eligible origins and levels. Baseline regeneration must reconcile
  with stored float16 rec12 before attributing differences. Replace nondeterministic `hash(key)` identifiers
  with collision-free stable identities, documenting this reviewer repair.
- Range diagnostics use the original finite mask including all bootstrap quantiles and the five baseline
  predictions, forecast-only quintile bins, original series groups, and original 182-day blocks.

## Review cautions already visible in original code

- Original range `cellb.py` computes cluster sums from uncentered `y-p`; calibration bias therefore enters
  its variance proxy. Reproduce it explicitly and compare a centered version before calling it sampling noise.
- Its deconvolution shrinkage uses split covariance computed on all groups, including held-out outcomes.
  That exploratory calculation is not an out-of-fold validation of a latent-probability range.
- SE widening is an outcome-frequency compatibility diagnostic, not automatically a confidence interval
  for an individual latent event probability. Small groups, rare outcomes and time dependence matter.
- The exact-GARCH oracle previously used a separate simulator. A successful separate loop does not by itself
  certify the production HAR simulator. Same-loop checks and causal state tests are required.
- A faster model changes both scale dynamics and residual sampling. A win alone does not prove that slow
  response is the exclusive source of the original model's errors.

## Execution ledger

- Completed earlier: scoring-instrument repairs, seven tests, full 80-cell range replay and same-input
  one-day baseline. These do not complete the original substantive review above.
- Completed: hourly GJR known-answer reconstruction, 42-series real GJR and intraday h3 replays,
  original-table reproduction, centered noise diagnostics, equal-group range sensitivity and conditional
  power analysis. All 36 parent-run instrument tests pass; real h3 results and unchanged common support
  were independently recomputed from all 42 checkpoints.
- Completed: full intraday synthetic comparison (28,800 unchanged published truth/baseline rows),
  independent output verification and final review report. The tested intraday features improve synthetic
  deep calibration partially but do not repair it or demonstrate real-data advantage over fH.

## Secondary numerical sensitivity declared before inspecting real comparison scores

The original primary comparison remains raw Brier loss at 1,000 forecast paths. A Monte Carlo touch
estimate adds numerical variance to that loss relative to `(fH)`'s deterministic empirical probability.
Report a secondary conditional-MC diagnostic, without replacing the original result:

`Brier_MC_adjusted = (p_hat-y)^2 - p_hat*(1-p_hat)/(n_paths-1)`.

For independent simulated Bernoulli paths this subtracts the unbiased estimate of numerical forecast
variance. It does not correct model misspecification, fitting uncertainty, history sampling, or selection.
Apply it only to regenerated `base12` and `garch` probabilities, whose path counts are known. Keep `(fH)`
unchanged, retain negative individual adjusted losses, and report both raw and adjusted aggregate deltas.
This sensitivity cannot turn the development review into a blind pass or an action recommendation.
