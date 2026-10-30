# R3T on a ratio loop (stETH collateral, ETH debt) — development only

Not a registered test. Data: Curve ETH/stETH `get_dy(1,0,1e18)` hourly at past blocks 11.6M–26.25M
(2021-01 to 2026-10-27, before the R3T forward T_REG 2026-11-02), keyless archive RPC. `fetch.py` rebuilds it;
`sim.py <data> <out>` runs the grid. Membrane liquidation mechanics (line/1.04 immediate, 8 h timer, 8–16 h re-dip),
10 % penalty, 10 bp per de-lever trade, weekly starts, 90-day horizon, carry excluded.

Result (2026-10-30, 48,746 hours, 278 overlapping starts, 2–3 independent stress episodes):
- Worst market ratio 0.9315 (June 2022). Opening at ≤ 0.95× max LTV (distance ≥ ~7 %): no liquidation under any rule.
- At 0.97–1.0× max: holding is liquidated (9–27 starts, from 2021-Q1 and 2022); any de-lever rule prevents all of them.
- R3T is not better than a fixed 3 % distance rule here. With its larger restore target it loses more (sells at the
  bottom of a depeg that reverted); with the same restore target it ties (log-utility within ±0.001) at ~10× more trades.
- Weakness: every depeg in sample reverted. A non-reverting depeg (slashing, insolvency) is not in the data; that is
  the case the de-lever premium insures.
