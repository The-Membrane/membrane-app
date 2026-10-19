# Q26 continuation — 2026-10-19

## Provenance and limits

Source session: <https://claude.ai/code/session_01Vv8BNqd3QymKqE3KbgGfYF>.
Continuation checkout: `/private/tmp/history-forecasts-continuation`.
Source app revision: `440648f1f`; board revision: `a2cbb91`; datasets revision: `bc8767d`.
This handoff preserves the whole research rationale, including negative/unfinished branches.
It does not authorize inspecting reserved observations or changing the production forecast.

Evidence classes are deliberately separate:

- **Published source/artifact:** committed code or an identified published artifact, whose scope must be checked.
- **UNPUBLISHED recovered claim:** a result in Claude session tool output, not an independently verified artifact.
- **Continuation instrument fix:** source reviewed, author/parent synthetic tests passed; separately reviewed.
- **Pending experiment:** partial job/checkpoint, with no final outcome and no success/failure inference.

Published source code is not evidence that an unpublished experiment completed or passed.
Newly downloaded published development rows use float16, whereas the original rows used float32.
Reproduction from that download may differ numerically; do not silently attribute differences to model changes.

## Owner's research objective and decision boundaries

The objective is a whole lending simulator: reason about a depositor's choice over a holding period,
not only improve an isolated forecast score. Preserve the depositor-facing 6-hour through 7-day horizon.
An eligible horizon is **eligible**, not a PASS, and does not by itself establish lending utility.
Production toggles remain an owner decision; R7.2 is still pending.

Owner continuity rule: use each model in the asset, horizon and depth where it works. A long-horizon failure
does not erase short-horizon gains. Check the instrument before recording a negative verdict, and record
the tested implementation rather than closing the underlying idea.

Keep these questions separate:

1. Training/test contamination: establish the instrument universe, time boundaries, and as-of inputs first.
2. Upstream sigma quality: measure its errors before treating a `reg2` adjustment as a solution.
3. `reg2` compensation: a transformed forecast can offset sigma errors without repairing the sigma estimate.
4. Statistical power: dependent observations reduce effective evidence; a time-only ceiling is not established.
5. Transform faults: wrong transformations are a different explanation from low power or dependence.
6. Probability target: realized finite-group frequencies differ from latent individual event probabilities.

The APR stable blind route is exhausted in the recovered context; that is a scoped conclusion,
not a claim that every stable-asset or every APR idea has failed. Do not broaden failed-idea claims.
Review the `lp` branch before B20b; review faster-step behavior on development data before escalation.
No reserved-data inspection is required to repair or review these instruments.

## Current source-review findings

`r164_ranges.py` evaluates a realized group-frequency target and a pooled calibration-frequency target.
A perfect latent individual probability interval need not contain the realized frequency of a small group:
three Bernoulli observations can average 2/3 while every true probability is 1/2.
Thus these coverage results cannot validate individual latent-probability confidence intervals.
Do not switch the estimand silently; preserve it, label it explicitly, and decide the desired target separately.

The power issue is not established as a time-only ceiling. Clustering, cross-sectional dependence,
finite group sizes, and the target under test must be examined before interpreting non-rejection.
The unweighted-ratio experiment below also changes the training-group weighting relative to the weighted
construction; apparent coverage improvement alone does not settle the target or the overcoverage concern.

## Continuation instrument fixes — scoped parent verification complete

Owned source: `scripts/research/history-forecasts/r164_ranges.py`.
Synthetic checks: `scripts/research/history-forecasts/test_r164_ranges.py`.
No forecasting-model fit or reserved-data input was changed.

- CGM intersection correction: sum normalized residuals by `(series_group, block)` across forecast bins
  before squaring/subtracting the intersection component. Duplicate observations within the same
  intersections preserve the known-answer variance `.0625` for coverage `[1,1,0,0]`.
- Interval score uses `alpha = 1 - nominal`, replacing the hard-coded `.10`; reject nonfinite nominal
  values and values outside the open unit interval before loading observations.
- Clip both endpoints for CAL/CALr/CALb to `[0,1]`; enforce ordered valid finite probability ranges.
  A point `.9` with calibration ratios `1.2/1.4` becomes `[1,1]`.
- Output metadata names `target=realized_group_frequency` and
  `T2_target=pooled_calibration_frequency`; document the latent-probability limitation.

Author and parent independently passed **7 tests**, including score `1.2` at nominal `.8` and `2.2` at `.9`
for `[.2,.4]` against `.5`; `git diff --check` was clean. A separate reviewer approved the scoped patch.
This verifies the synthetic instrument repairs, not empirical range performance or the desired estimand.

```sh
cd /private/tmp/history-forecasts-continuation
/private/tmp/history-forecasts-py312/bin/python -m unittest discover \
  -s scripts/research/history-forecasts -p test_r164_ranges.py -v
git diff --check
```

## Recovered Claude results — UNPUBLISHED, artifacts not independently verified

These numbers are recovered tool-output claims. They must not be cited as confirmed published results.

| Branch | Recovered claim | Boundary / next verification |
| --- | --- | --- |
| R13.5r instrument audit | Clean test universe 194; ATS/CRVUSD/SMART removed; 48 development instruments removed | Reconcile universe manifests and source revision before comparing scores |
| h3 frozen/all | BSS `.0250`, R `1.0669` | Unpublished; verify exact run artifact |
| h3 frozen/clean | BSS `.0255`, R `1.0688` | Unpublished; distinguish filtering from refit |
| h3 refit/all | BSS `.0252`, R `1.0585` | Unpublished; verify training universe |
| h3 refit/clean | BSS `.0260`, R `1.0598` | Unpublished; no production decision implied |
| GARCH reviewer, preexisting synthetic experiment | Deep R: 1d `.99` vs HAR `.36`; 3d `1.02` vs `.43`; 7d `1.06` vs `.59` | Synthetic result, not completed real-data validation |
| Unweighted CAL, 1d at -10% | Coverage `.947`, width `11.5`, versus weighted `.770`, width `8.4` | Group-ratio weighting and TOST overcoverage concern unresolved |
| Unweighted CAL, 3d at -10% | Coverage `.868`, width `31.5`, versus weighted `.772`, width `21.6` | Do not interpret coverage increase alone as better uncertainty |
| NN | Mid/long had no eligible outcome; shallow job unfinished | No blanket conclusion about neural models |

## Artifact paths, reconstruction, and interrupted jobs

Recovered cloud scratch root (`SC`, not accessible in this local checkout):
`/tmp/claude-0/-home-user/5db7bc9d-0d68-5d3f-a50f-faa01897ef28/scratchpad`.

- Audit: `SC/lev/r135r-audit.json`; staged but **not pushed** under
  `/home/user/membrane-datasets/history-forecasts/audit-lev-2026-10-19/{census,exclusions,r135r-audit}.json`
  according to recovered command output. The staged files are unavailable locally.
  ATS/SMART exclusion reasons are not independently established: initial census had jumps without name-peg
  flags, and audit `decide()` also auto-excludes daily SD <1% over 180 days, potentially real low-volatility
  instruments. The clean-universe sensitivity is diagnostic, not proof all removals were prohibited.
- GARCH: `SC/r164/{garch.py,fast.py,syn-garch.csv.gz,real-28.pkl,evalreal.py,cellb.py}`;
  real scoring was unfinished, with task output `b7sbxvtza.output`. Source and artifacts remain unpublished.
  Reconstruction recipe: quarterly Gaussian-QMLE GJR(1,1), preceding 3 years of hourly data (≥2,000 rows),
  variance targeting `w=v*(1-a-.5*g-b)`, `a,g,b≥0`, persistence <`.9995`; starts `(.05,.03,.9)`,
  `(.1,.05,.8)`, `(.03,.02,.94)`, Nelder–Mead 800 iterations; paired hourly `(logclose,loglow)/sqrt(h)`
  residuals, prequarter pool ≥1,000, recursive hourly variance updates. This recipe is recovered context,
  not a substitute for the unpublished source or evidence of completed real scoring.
- NN: `SC/r162/dev/dev-r162-nn.json`; shallow fit unfinished. Recovered commands, from research scripts:
  `r16_nn.py fit --datasets /home/user/membrane-datasets --out "$SC/r162/dev" --threads 2 --tiers shallow`,
  then `r16_dev.py score-nn --out "$SC/r162/dev"` (invoke with the appropriate Python interpreter).
- R111v4: `SC/r111v4`; source `wt-run3/scripts/research/history-forecasts` at `caf536f4`.
  Polygon checkpoint **2022-12-30**, **285 MB**, repeatedly OOM; wait for memory usage **≤7 GB** before resume.
  With `S="$SC/r111v4"`: `python3 r111v4_gate.py run --mk poly --work "$S/poly" --out "$S/run-caf536f4" --scratch "$S/ck" --resume`.
  Frozen SHA: `b14676459b8b0d0644cda51334d9072e324dcd34bc52bf3a38f33d47fe5effd7`. No final outcomes.
- Published local R16.4 input: `/private/tmp/history-forecasts-datasets/history-forecasts/r16/r164-dev-63d4700f`;
  parent verified 144 checksums. This does not verify the unpublished scratch runs above.
- Exact h3 and unweighted-CAL run commands/artifacts are still missing. Recover them before reproduction;
  preserve weighting, realized-frequency target, and overcoverage tests. Do not invent artifact names.

## Immediate continuation order

```text
source / universe / as-of audit
  -> verified range instrument fixes (synthetic scope)
  -> recover named unpublished artifacts and job status
  -> development-only sigma / reg2 / lp / faster-step review
  -> power + target + equivalence interpretation
  -> depositor 6h–7d lending-simulator decision
  -> owner R7.2 production decision
```

Do not open unseen data to resolve missing handoff details. Missing artifacts remain explicitly unverified;
failed or interrupted jobs retain their actual scope. Update the handoff with exact artifacts and observed
commands/results as they are recovered, without rewriting recovered claims into published evidence.

## Canonical sources and remaining source-review caveats

- membrane-board `knowledge/q26-model-inventory.md`, Q26 owner rulings and simulator-module inventory.
- membrane-board `design/q26-standardization-diagnosis-2026-10-19.md:307`: review confirms scale bias,
  but does not identify class forecast-error spread separately from jumps/tails. The initial clean
  decomposition into transformation error versus calendar effects is stronger than its evidence.
- membrane-board `design/Q26_ROUND16_PREREG.md:432`: deep-correction concentration, contamination,
  R16.4 registration, frozen comparator rules, and unopened reserve allocations.
- membrane-board `design/q26-closed-path-audit-2026-10-19.md:112`: eligible depositor horizons and reopened faults.
- `r164_power.py:37`: total series/time bootstrap z is scaled without decomposing a time-only component.
  Its width leg is a deterministic indicator of the development median, not simulated joint-gate power.
- `r164_ranges.py`: bounds are averaged over rows with available ranges, whereas outcomes use the whole group.
  Current constructions generally supply complete groups; partial availability is not explicitly enforced.

## Verified development replay

The corrected scorer completed all 80 cells. On identical published float16 inputs, all 140 one-day
coverage and median-width readings are unchanged. CGM standard errors change. This preserves NOT RUN
under the existing power calculation, without validating its separate assumptions.

Primary CAL coverage remains `.939633` at 1d −15% and `.905263` at 3d −25%. Corrected CGM SE is `.016614`
and `.022071`; median width is `3.4714` and `5.1897` probability points. Existing power legs remain
`.140523` and `.175770`, product `.0246997`.

Artifacts: membrane-datasets `7c8c33e`, branch `codex/r164-instrument-review`,
`history-forecasts/r16/r164-review-20261019/`. This includes the corrected replay, unmodified one-day
same-input baseline, a bounded synthetic runtime check, provenance and checksums.
The one-series/four-origin synthetic run is not the published aggregate experiment.
