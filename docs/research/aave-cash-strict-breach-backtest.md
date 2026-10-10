# Retrospective sampled-cash first breach by horizon

[`aave-cash-strict-breach-backtest.mjs`](../../scripts/research/aave-cash-strict-breach-backtest.mjs) replays the frozen eight-reserve Aave V3 grid for amount `q` and horizon `H`. An eligible anchor begins with sampled cash at or above `q`. The strict event is the **first subsequent observed sample below `q` at or before anchor time + H**. A below-`q` target witness after H and within the allowed eight-hour observation lag completes the window but is **not** a by-H event. The legacy v1 `sampledCashBelowAmount` includes that witness, so the two labels remain separately named and counted. A sampled loss that recovers before H remains a strict event.

This adapter retains v1's source eligibility, 70/30 boundary, 24-hour purge, complete path through the first target witness, gap and ineligible-sample censoring, and near-end denominator. An explicit `asOfAt` limits the source to samples no later than that Unix second and leaves a cell pending until H + eight hours, even when an early witness is present. The frozen source has block timestamps and a locally verified entries digest; it has **no first-local-observed or creation clock**. Therefore `asOfAt` is a source-time replay only and cannot validate v2's issue-time availability or 120-second creation cutoff. The eight-reserve grid **excludes USDe**. This is a semantic sensitivity study, never prospective USDe validation.

Run `node scripts/research/aave-cash-strict-breach-backtest.mjs` for the fixed 3×3 amount/horizon grid, or pass `--amount-usd Q --horizon-hours H [--as-of UnixSeconds]` for one cell. The fixed grid is $1m/$10m/$50m crossed with 8h/24h/7d. Every output contains per-market and pooled train/holdout eligible, observed, censored/pending, strict by-H and v1 lag-inclusive event counts. `legacyPositiveStrictNegative` is the number of otherwise observed anchors that v1 calls positive solely because the first below-`q` sample arrived after H. The same anchor can appear in many overlapping windows; pooled counts do not represent independent trials.

Frozen checkpoint replay (full source, no as-of cutoff; values are **strict events / observed**, followed by **v1-only lag positives**):

| `q`  | `H` |          Train |        Holdout |
| ---- | --- | -------------: | -------------: |
| $1m  | 8h  |   6 / 5,806; 4 | 12 / 2,690; 12 |
| $1m  | 24h |  14 / 5,788; 3 | 36 / 2,680; 10 |
| $1m  | 7d  |  69 / 5,644; 2 | 178 / 2,541; 4 |
| $10m | 8h  |  12 / 4,922; 9 | 14 / 1,182; 11 |
| $10m | 24h |  30 / 4,913; 8 | 36 / 1,178; 10 |
| $10m | 7d  | 185 / 4,841; 6 | 237 / 1,130; 5 |
| $50m | 8h  | 14 / 3,014; 13 |     4 / 481; 4 |
| $50m | 24h | 40 / 3,011; 11 |    11 / 479; 2 |
| $50m | 7d  | 239 / 2,987; 7 |    16 / 455; 0 |

The archived holdout has already been seen; these are exploratory counts, not blind predictive accuracy. Below-threshold samples are reserve cash under a $1 display assumption, not a fixed-holder executable withdrawal. Sampling cannot establish unobserved crossings between samples or how long an exit condition will last. No event rate here is a calibrated probability, and no forecast, duration estimate, or alert is enabled.
