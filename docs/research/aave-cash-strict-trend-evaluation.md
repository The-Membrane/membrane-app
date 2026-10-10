# Trend rule against a strict sampled cash breach

[`aave-cash-strict-trend-evaluation.mjs`](../../scripts/research/aave-cash-strict-trend-evaluation.mjs) replays the existing trailing decline candidate against the separate [strict first-breach label](aave-cash-strict-breach-backtest.md): at least one complete-path sampled reserve cash observation below amount `q` **at or before** `H`. The legacy target witness up to eight hours after H cannot make this outcome positive. The prior rule and its 18–30-hour trailing lookback are imported unchanged. Predictions read only prior samples. A zero-decline or absent past trail has the existing behavior (`false` or abstain, respectively). Two fixed comparators are always-no-breach and current sampled cash below `2q`.

The evaluator validates the exact complete frozen eight-market checkpoint and local entries digest before scoring. The train/holdout boundary, 24-hour purge, source eligibility, full-path censoring, and pending as-of behavior come from the strict label. Run one specified cell with:

```text
node scripts/research/aave-cash-strict-trend-evaluation.mjs --amount-usd 1000000 --horizon-hours 24
```

Each split reports anchor-level confusion counts, abstentions, censored and pending rows for all eligible anchors. A predeclared nonoverlap sensitivity selects the earliest eligible anchor in each market and split, then selects another only after the previous anchor's full `H + 8h` window has closed. Censored and pending anchors still occupy a window. This removes overlapping decision windows but does not create independent market episodes or an event-level lead-time estimate.

Frozen $1m / 24h replay (the archived holdout was already seen):

| Split and selection  | Strict breaches / observed | Trend TP / FP / FN / TN | Trend abstentions |
| -------------------- | -------------------------: | ----------------------: | ----------------: |
| Train, all anchors   |                 14 / 5,788 |    4 / 101 / 10 / 5,658 |                15 |
| Train, nonoverlap    |                    3 / 970 |        0 / 20 / 3 / 942 |                 5 |
| Holdout, all anchors |                 36 / 2,680 |    14 / 67 / 22 / 2,577 |                 0 |
| Holdout, nonoverlap  |                    6 / 453 |         4 / 9 / 2 / 438 |                 0 |

The holdout also has 20 censored all-anchor labels and one censored nonoverlap label; they do not enter confusion counts. The nonoverlap train result has no captured strict event, and the holdout has only six strict breaches. These data do not support an alert threshold, a calibrated probability, or a claim about how long an exit condition will last. The cash proxy omits same-holder executable liquidity and any unobserved crossing between samples. The frozen eight markets exclude USDe; block timestamps do not attest what was locally visible at issue time. `predictiveGatePassed` remains `false`.
