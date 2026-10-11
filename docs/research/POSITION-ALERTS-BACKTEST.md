# Position alerts — back-test and recommended thresholds

2026-10-07, revised 2026-10-11 · merged to `evm-migration` in #97; gate and E2 claims corrected
in this revision · status: **research, dry-run delivery only. The external-alert gate is NOT yet
met (§1).**

Demand: position alerts, 10 messages from 8 authors (UMBRELLA data product #7 on the agent
board). Members who leave positions "set and forget" asked for health-factor and
liquidation-price alerts. This memo reports what such alerts would have done on six years of
hourly ETH/BTC and on the stress events E1–E4, and their false-alarm rate in calm markets.

**The gate** is G2 of the Recall Coverage Dataset spec (claude.ai artifact
`Lm9KrFSbw9zp2FtWhcd3Nm`, §10 build order, phase P1). Verbatim:

> the alert trigger is back-tested on E1–E4 (fires before the breach block for every breached
> cluster) with its calm-30-day false-alarm rate reported; per-wallet rows are internal only

The first version of this memo paraphrased the gate and dropped two conditions: "every breached
cluster" and "per-wallet rows are internal only". It also used its own E2. The events are
defined in spec §5, and this back-test matches them only in part:

| Spec event | Spec definition (§5) | What this back-test replayed | Match |
|---|---|---|---|
| E1 (EV-1) | Oct 10–11 2025 cascade. Aave v3 Core: 799 liquidations, $117.35M. The USD-loop line is Morpho sUSDe/USDT at LLTV 91.5% (2 liquidations) | 587 Aave accounts from the committed oct10 census (WETH / wstETH / WBTC / cbBTC collateral, stable debt), priced on the Chainlink feed in force each minute | ⚠ priced volatile clusters only. Not replayed: the Morpho sUSDe/USDT USD-loop cluster, and 1,763 other census accounts (1,003 with unpriced collateral, 599 census-excluded, 100 with stable or LST collateral, 60 with volatile debt, 1 with no debt) |
| E2 (EV-2) | Stream xUSD collapse, Nov 2–12 2025, multi-chain. ~$285M of loans against xUSD / xBTC / xETH on Euler, Silo, Morpho, Gearbox. Elixir deUSD −98% on Nov 6. Spec data: "to pull; venue ids not yet resolved" | 145 Morpho WBTC / cbBTC / wstETH positions liquidated anywhere in **November** 2025 (46 of them first liquidated inside Nov 2–12), plus the deUSD price series | ⚠ **not the spec's E2.** The xUSD / deUSD-collateral clusters that define the event were not replayed as positions. Only the deUSD depeg alert touches them (§6) |
| E3 (EV-3) | KelpDAO rsETH exploit from Apr 18 2026 17:35 UTC. Aave Core USDC at ≥ 99.9% utilization for 82.4 h | Synthetic rsETH/ETH loops on a market vs an exchange-rate oracle, synthetic ETH positions, and Aave **USDe** cash | ⚠ **synthetic.** No real E3 positions. The capacity replay uses USDe, not the spec's USDC |
| E4 (EV-4) | Morpho PT-reUSD-10DEC2026 oracle dip, Aug 25 2026. 19 borrowers (20 borrower-market pairs) at HF 1.0053–1.0238; oracle −0.54% at the first liquidation | The same 20 borrower-market pairs, with real hourly balances and the market oracle read every 5 blocks around the cascade | ✅ matches |

Code: `lib/positionAlerts/` (pure rule engine) · `scripts/research/position-alert-backtest.ts`
(harness) · `data/position-alerts/` (inputs, manifest, `backtest-results.json`) · tests in
`tests/unit/positionAlerts*.test.ts`. Every number below is in `backtest-results.json`.

---

## 1. Verdict

**Recommended default** (`DEFAULT_ALERT_CONFIG`, push from **warn**):

| Rule | Watch (in-app) | Warn (push) | Critical (push) | Anti-flap |
|---|---|---|---|---|
| Health factor | < 1.30 | < 1.15 | < 1.05 | band 0.03 · clear after 2h recovered · watch re-fire cooldown 6h |
| Cushion burn: share of the HF cushion above 1.00 lost in 6h (only when HF < 1.5) | — | — | ≥ 50% | band 0.10 · 2h |
| Collateral depeg, stable (bps below $1) | 50 | 150 | 500 | 2 samples to confirm · band 20 · 2h |
| Collateral depeg, LST (bps below underlying × redemption rate) | 100 | 250 | 600 | 2 samples · band 30 · 2h |
| Distance to liquidation price | opt-in only (`LIQUIDATION_DISTANCE_PRESET`) | | | |
| LTV | opt-in user lines only (`ltvLines`) | | | |
| Exit capacity vs recall needed | internal only, uncovered until wired | | | |
| Oracle change | internal only, stub interface | | | |

Every message states the liquidation price and the repay / top-up that restores HF 1.30.

**Gate status, per rule, against G2.** "Fires before breach" means a warn-or-higher message came
before the first real liquidation of every replayed position.

| Rule | E1 | E2 | E3 | E4 | Calm-30-day false alarms | G2 |
|---|---|---|---|---|---|---|
| Health-factor tiers (default config) | fired before breach for **587 / 587** replayed accounts. Spec's USD-loop cluster not replayed | November Morpho set: before breach for **145 / 145**. Inside Nov 2–12: **46 / 46, all ≥ 1h (32 already under 1.15 at the first read); critical 46 / 46, median lead 23h (`results.e2SpecWindow`)**. Spec's xUSD clusters not replayed | synthetic only (§6). One rsETH loop missed by the HF tiers alone, caught by the depeg rule | before breach for **20 / 20**, but only because every pair opened inside critical. The price gave ~4 min (§5) | 0.285 per position-month at warn+, 0 at critical (§2). Market-wide calm windows, not the spec's per-event calm points | **not met**: E1 USD-loop, E2 and E3 defining clusters missing |
| Cushion burn (critical only) | part of the default critical tier: 0 / 587 missed at a 1-minute poll | 0 / 145 missed | synthetic | minutes of warning only | 0 per position-month | **not met** (same E1 / E2 / E3 gap) |
| Collateral depeg | Chainlink STETH/ETH and USDe replayed | **deUSD**, the asset behind E2: critical 5h before it fell below $0.50 | rsETH: critical at the first depegged sample | n/a (a PT has no peg) | years of USDC / USDe / stETH (§6) | **stables: closest to met; LSTs need a synchronous ratio source** |
| Exit capacity | — | — | n = 1, on USDe not USDC | — | none (no 30-day capacity series offline) | **fails, keep internal** |
| Oracle change | — | — | — | — | none (registry not wired) | **fails, keep internal** |

**Per-wallet rows.** G2 says per-wallet rows are internal only. `data/position-alerts/e2-nov-2025.json`
and `e4-aug-2026.json` hold Morpho borrower addresses, and §11 shows one shortened address. This
repo is public. The addresses are public on chain, and the committed `public/data/oct10-2025/evidence.json`
already lists Aave borrower addresses the same way. **Owner decision needed** on whether G2 covers
committed research inputs. Until then no surface may show a per-wallet row.

**So no position alert goes external yet.** What is missing for G2: replay the E1 Morpho
USD-loop cluster, the E2 xUSD / deUSD clusters and real E3 positions from the spec's
block-pinned tables, and resolve the per-wallet question (§12).

---

## 2. Health-factor lines: warning time vs false alarms

One threshold at a time, scored at that line. Columns: liquidations warned at least 1h before
(hourly) or 15m / 1h before (minute data); false alarms per position per 30 days (a message
with no liquidation in the next 72h, never-liquidated positions only).

| Line | Hourly 2020→26: warned ≥1h | false alarms /30d | Calm windows: false alarms /30d | E1 (1m): ≥15m / ≥1h | Nov-2025 Morpho set (1m): median lead |
|---|---|---|---|---|---|
| HF < 1.05 | 59.8% | 0.026 | 0 | 74.8% / 46.8% | 28.8h |
| HF < 1.10 | 80.8% | 0.103 | 0.020 | 97.4% / 92.5% | 93.5h |
| HF < 1.15 | 88.8% | 0.224 | 0.285 | 100% / 100%¹ | 157.5h¹ |
| HF < 1.20 | 93.0% | 0.406 | 0.540 | 100% / 100%¹ | ¹ |
| HF < 1.30 | 98.4%¹ | 0.431 | 0.137 | ¹ | ¹ |

¹ Lower bound. Many positions were already under the line at the first sample (censored), so
the real lead is longer than measured.

- **Hourly set:** 7,320 synthetic positions over ETH and BTC. Each opens every 2 days at HF 1.25, 1.5 or 2.0, against $100k of stable debt. Each is held untouched for 30 days. **766 liquidations fall on 119 distinct days.** The windows overlap, so 119 is the effective sample, not 766.
- **Calm set:** 17 non-overlapping 30-day windows in which ETH and BTC each stayed within 10% of their running peak (`calmWindows` in the results). Positions open at HF 1.2, 1.25 and 1.5 on ETH and BTC: 102 position-months.
- **Warn misses.** Of the 766 hourly-history liquidations, the warn line gave 680 (88.8%) at
  least 1h of warning, 32 (4.2%) a message with zero lead, and **54 (7.0%) no message at all**.
  The misses are crashes inside one hourly bar: liquidation is read on the hour's low, while the
  monitor reads only the hour's close. 48 of the 54 opened at HF 1.5 or 2.0 and fell through 1.15
  and 1.0 in the same hour. On minute data the warn line missed nothing: 0 of 587 (E1), 0 of 145
  (November Morpho set), 0 of 20 (E4). So the misses mostly show the hourly bars of the history.
  The live risk is a crash faster than the poll (§9).
- **Why 1.15 for warn.** It is where false alarms start to climb fast for little extra lead: 1.10→1.15 adds 8pp of warned liquidations, and 1.15→1.20 adds 4pp but nearly doubles false alarms. The median lead on hourly history is 41h and the p10 is 5h.
- **Why 1.05 for critical.** It gives zero calm false alarms. By itself it is too late in a fast crash: only 47% of the Oct 10 accounts got an hour. §4 adds the fix.
- **Watch at 1.30** costs 0.68 messages per position-month, and 29% of positions get one in a month. Positions parked near 1.30 get 1.47. So watch stays in-app (`DEFAULT_PUSH_MIN_SEVERITY = 'warn'`).

## 3. Distance to liquidation price — static and volatility-scaled

For one collateral leg against stable debt, distance = 1 − 1/HF. A distance rule therefore
repeats the HF rule message for message (dist < 10% ≈ HF < 1.11: 82.2% warned at 0.133 false
alarms, against 80.8% at 0.103). Every HF message already states the liquidation price.

The **sigma** variant divides the log-distance by the trailing 24h volatility (EWMA, 24h
half-life, read from the last completed hour). On hourly history it is slightly more efficient:
sigma < 3 warned 91.6% at 0.269 false alarms, against HF < 1.20 at 93.0% and 0.406. It is
quieter in calm windows: sigma < 3 gave 0.088 against HF < 1.15 at 0.285. It is worse where it
matters: on Oct 10, sigma < 2 warned 78.5% ≥1h against 92.5% for HF < 1.10, because an hourly
volatility reading cannot react inside a one-hour crash. It warned nobody usefully on E4. It is
also harder to explain to a borrower. **Opt-in, not default.**

## 4. Cushion burn — the fast-crash detector

Cushion burn = (peak HF in the last 6h − HF now) / (peak − 1), checked only while HF < 1.5. It
judges a looper at HF 1.005 and a borrower at HF 1.4 on the same scale.

| Burn line | Hourly: warned ≥1h | false alarms /30d | Calm /30d | E1: ≥15m / ≥1h | E4: median lead |
|---|---|---|---|---|---|
| ≥ 30% | 81.6% | 0.367 | 0.167 | 98.6% / 96.1% | 4.3 min |
| ≥ 50% | 49.0% | 0.053 | **0** | 95.4% / 81.8% | 2.7 min |
| ≥ 75% | 10.3% | 0.007 | 0 | 52.6% / 22.7% | 0.8 min |

Hourly bars cannot see a burn that happens inside one bar, so the hourly recall understates it.
The minute data is the honest test.

**Tier candidates, same data** (`results.tiered`):

| Candidate | Hourly warn+: warned ≥1h / FA per 30d | Hourly critical: ≥1h / FA per 30d | Calm: warn+ / critical FA per 30d | E1 critical: ≥15m / ≥1h |
|---|---|---|---|---|
| HF tiers only | 88.8% / 0.251 | 59.8% / 0.026 | 0.285 / 0 | 74.8% / 46.8% |
| **HF tiers + burn ≥ 50% at critical (default)** | **89.0% / 0.304** | **66.6% / 0.079** | **0.285 / 0** | **98.1% / 86.9%** |
| HF tiers + burn 30% warn / 50% critical | 91.4% / 0.662 | 66.6% / 0.079 | 0.452 / 0 | 98.1% / 86.9% |
| … + sigma 2 warn / 1 critical | 92.6% / 0.822 | 72.7% / 0.113 | 0.461 / 0 | 98.1% / 86.9% |
| HF tiers, anti-flap off | 88.4% / 0.759 | 53.1% / 0.044 | 1.296 / 0 | 69.2% / 36.6% |

The November-2025 Morpho set is ≥ 99% warned ≥1h under every candidate. Nov 2025 was a slow
grind for BTC/ETH collateral, with a median lead of 28.8h at the critical line.

Adding burn ≥ 50% as a critical-only trigger lifts Oct-10 critical warning ≥1h from 46.8% to
86.9%, and ≥15m from 74.8% to 98.1%. Calm-window critical false alarms stay at 0. A lower burn line at warn (30%)
more than doubled warn-level false alarms on hourly history against the default (0.304 → 0.662
per position-month) for 2.4pp more warned liquidations, so it is not in the default.

## 5. E4 (PT-reUSD, Aug 25 2026): no price alert can help a position parked on the line

All 20 liquidated borrower-market pairs (19 borrowers) sat at **HF 1.005–1.024** for up to 14
days (median 1.012, three hours before). This matches the spec's 1.0053–1.0238 at t0. The Morpho
oracle read 0.97099 at 04:00 UTC. It first ticked down 0.1% at **04:33**, and the first
liquidation followed at **04:37**, with the oracle down 0.54% (spec §5 agrees). The low was
0.94386, and the oracle recovered to 0.968 by 05:19.

- Every static line (HF, distance) was breached for the whole window. That means one message at open, then silence. The lead is "12 days", which is censored and meaningless.
- Cushion burn ≥ 50% fired a median **2.7 minutes** before liquidation. The data cannot do better: the price itself gave about 4 minutes.
- What could have warned was the oracle construction. A 15-minute TWAP priced off an $8.97M pool against a $67.5M book (`docs/research/worst-carry-venues.md`). That is oracle-change / oracle-risk territory, not a price alert, and the oracle-change rule here is still a stub.

So the honest borrower message for a position opened within ~2% of its line is a one-off
critical at open with the E4 precedent. The thresholds above do send it (HF < 1.05 → critical
at first read).

## 6. Collateral depeg

| Series | Window | Messages /30d (all) | Warn+ /30d | Warn+ episodes |
|---|---|---|---|---|
| USDC (DefiLlama, ~hourly) | 2023-01 → 2026-10 | 0.175 | 0.087 | 1: Mar 10 2023 (SVB), peak 652 bps |
| USDe | 2024-03 → 2026-10 | 0.221 | 0.032 | 1: Feb 1 2026, 159 bps |
| stETH/ETH, post-Shanghai | 2023-04 → 2026-10 | 0.636 | 0.141 | includes **artifacts** (below) |
| stETH/ETH, Chainlink STETH/ETH (E1, 1m, synchronous) | Oct 10–11 2025 | — | — | 1 warn at 21:25 UTC, the real 4.4% depeg |
| USDe Oct 10: Binance spot low vs Curve on-chain quote | Oct 10–11 2025 | — | — | Binance: critical (1,000 bps) · Curve: **never** above 50 bps |
| deUSD (E2) | Oct 25 → Nov 30 2025 | — | — | critical Nov 6 11:00 UTC; below $0.50 at 15:58 (**5h lead**) |
| rsETH/ETH vs 1.0686 rate proxy (E3) | Apr 10 → 26 2026 | — | — | critical Apr 19 02:00, the first sample showing the depeg; 0 messages in the 8.8 pre-incident days |

**Two source rules are now load-bearing:**

1. **Compute a ratio from one synchronous quote.** Use the Curve pool or Chainlink STETH/ETH. Never divide two independently sampled USD prices. The DefiLlama stETH/ETH series shows "depegs" of 837 bps on May 20 2024 and 818 bps on Feb 3 2025. Both are days ETH moved 10–20% inside an hour, and the two legs were sampled minutes apart. The synchronous Chainlink feed on Oct 10 shows only the real move.
2. **Measure the depeg where the borrower would exit or be liquidated.** On Oct 10, USDe printed $0.65 on Binance while the on-chain Curve quote held within 50 bps.

The depeg message tells the borrower whether their venue's oracle sees the move. A
market-priced oracle already counts it in HF. An exchange-rate or hard-coded oracle does not:
HF holds, but at market prices it is lower, and selling takes the discount.

**E3 rsETH loops** (rsETH collateral, ETH debt, LT 0.93, opened at the pre-incident rate):

| Venue oracle | HF at open | Liquidated? | Default config | HF tiers only |
|---|---|---|---|---|
| market ratio | 1.05, 1.10 | yes: Apr 19 01:00 / 02:00, the first hourly samples showing the depeg | opened inside warn (censored lead). The depeg message lands the same hour as the liquidation | same |
| market ratio | 1.25 | yes: Apr 20 00:59 | warned **6.0h** before, by the depeg rule. Its first warn came 23h before, then cleared on a bounce and re-fired | **missed**: the HF warn at Apr 19 03:00 cleared on the same bounce |
| exchange rate | 1.05 / 1.10 / 1.25 | never (HF is constant) | depeg critical Apr 19 02:00. Market-valued HF fell to 0.73 / 0.76 / 0.87, underwater at market | **silent** on the depeg |

The rsETH/ETH ratio comes from two hourly DefiLlama series (rule 1 above). The 25% depeg is
real, because Aave froze the reserve, but individual hourly bounces may be sampling noise.
**E3 ETH/USD control:** 3 positions at HF 1.10 / 1.25 / 1.50 held Apr 12 → 26 on the 1-minute
path (ETH max drawdown 8.6%). There were no liquidations. One critical message went to the
HF 1.10 position as it dipped to ~1.005 and recovered: 1 false alarm in 42 position-days.

## 7. Exit capacity vs recall needed (E3) — fails the gate, keep internal

The spec's E3 venue is Aave Core **USDC**. This replay uses Aave **USDe**, the series the
venue-capacity study had already measured. Re-run it on USDC from the spec's tables (§12).

Aave V3 USDe cash fell from $504M (Apr 18 12:38) through $408M (Apr 19 00:41) to $0 by 12:42.
For a position whose recall need after a 20% shock is $100M, the rule fired watch at 06:26 and
went critical at 06:56, at the crossing. The 30 minutes of warning came at watch only. With a
$250M need, warn came 2.3h before the crossing. A static coverage ratio sees a run only once it
is most of the way through. The venue-capacity study found a two-stage event + 6h-outflow rule
that flagged 8h48m before the same $100M crossing (`docs/research/venue-capacity-drivers.md`,
also n = 1). The next step is a capacity-burn term, the analogue of §4.

No 30-day capacity series is available offline: the venue recorder lives in Neon. So no calm
false-alarm rate exists and the rule does not pass the gate. `lib/position-sim/measuredCapacity.ts`
exists on `origin/feat/risk-frontier-stress-grid` (`ceab3fbd`) but is not merged into
`evm-migration`. Its hourly archive history (2023-10 → 2026-10) is the 30-day series this rule
needs. `capacity.ts` fixes the interface an adapter over it must satisfy.

## 8. Oracle change — stub, fails the gate

The registry's change detector is `lib/oracleRegistry/changes.ts` (`detectChanges`,
`detectChangeSeries`) on `origin/feat/oracle-registry` (`d1d2ca4c`), not merged into
`evm-migration`. `oracleRegistry.ts` here fixes a stub event interface (`feed_replaced`,
`source_changed`, `heartbeat_changed`, `deviation_changed`, `cap_changed`, `paused`,
`price_frozen`) and a severity map. **The two do not match.** The registry emits `aggregator`,
`heartbeat`, `deviation_threshold`, `twap_window`, `cap`, `discount`, `market_source`, `wiring`,
`quorum`, `update_model`, `entry_added`, `entry_removed` and `other`. Wiring needs a mapping and
severities for the kinds the stub lacks (TWAP window, quorum, discount, wiring). E4's oracle was
a TWAP over a thin pool, so `twap_window` and `market_source` matter most. With no source wired,
the rule reports **uncovered**, never "no changes".

## 9. Monitor cadence and anti-flap

- **Cadence matters only for critical.** Warn (HF < 1.15) kept ≥ 99.7% warned ≥1h on E1 from a 1-minute to a 60-minute poll. Critical HF < 1.05 alone missed 1 / 29 / 36 / 173 of 587 accounts at 1 / 5 / 15 / 60-minute polls. The default critical tier, which adds burn, missed 0 / 0 / 0 / 22 and warned 86.9% / 86.9% / 77.9% / 68.5% at least 1h ahead. **Poll at least every 5 minutes.**
- **Anti-flap.** For positions opened near a band in calm windows, the default band, dwell and cooldown cut messages from **7.95 to 1.83 per position-month**. On hourly history, warn+ false alarms fell from 0.759 to 0.251 at the same recall (88.4% vs 88.8%). Escalation is never delayed. An all-clear is sent only after a warn-level episode and 2h of recovery, so it is never sent into a bounce.

## 10. What this does not show

- **Set-and-forget only.** No replayed borrower repays, tops up or adds debt. Real borrowers act. A lead time is "time the borrower had", not "time the borrower used".
- **E1 and E2 reconstruct balances backwards** from the liquidation snapshot (E1) or from hourly Morpho history (E2). On E1 the reconstructed path crossed HF 1 before the real liquidation for 403 of 587 accounts: median 4 minutes early, p90 869 minutes. Some accounts changed balances during the day, and liquidators are not instant. The real liquidation time is used for scoring. On E2, 143 of 145 crossed early, median 10.6 minutes, because spot leads the oracle.
- **Spot is not the oracle** for the hourly set, E2 and the E3 ETH set. Spot lows liquidate slightly earlier than Chainlink would. A spot-driven monitor also warns slightly earlier than an oracle-driven one. E1 and E4 use the venue oracle.
- **E1 leads cap at about 21h** (the window opens at 00:00 Oct 10). L2 accounts are priced on the mainnet Chainlink feed, the same simplification as `evidence.json`.
- **Small n where it matters most.** E4 is 20 borrower-market pairs in one 14-minute cascade. E3 rsETH and exit capacity are one episode each. They show mechanism and timing, not rates.
- **Precision is low by construction** for a 72h horizon in slow markets: HF < 1.15 has precision 0.19 on hourly history. Most warn messages are not followed by liquidation, because prices recover. That is the cost of 41h median warning. The 72h horizon is a modelling choice.
- **No interest accrual** in the synthetic positions. Morpho positions carry real accrued debt.
- **Calm windows are market-wide.** They are 17 30-day windows of low ETH/BTC drawdown with
  synthetic positions. The spec pulls 30 daily calm points per event. Those were not used.

## 11. Delivery: dry run only

`lib/positionAlerts/telegram.ts` formats a plain-text message and `dryRunTelegram()` returns it
with `sent: false`. There is no HTTP call, no token and no chat lookup. A test asserts the whole
module imports none of `scripts/lib/notify.mjs`, `scripts/lib/telegramBot.mjs`,
`components/Radar/telegramLogic.ts` or `alarmRules.mjs`, and contains no `fetch(`, no
`api.telegram.org` and no env read, per the board ruling that personal alerts must not reuse the
radar alarm sender. Sample, from the replay of E2's largest position (real Morpho cbBTC/USDC
borrower, Nov 6 2025):

```
[CRITICAL] Morpho cbBTC/USDC · 0xED3A…0A03

Health factor 1.029
Below 1.050. Liquidation starts at 1.00. LTV 83.5% against a 86.0% line.

Collateral $10.63M · debt $8.88M
Liquidation if cbBTC reaches $98,047 (now $100,935).
To get back to HF 1.30: repay $1.85M, or add $2.79M of cbBTC.

Dry run: formatted, not sent · 2025-11-06 21:01 UTC
```

## 12. To meet G2

1. Replay the E2 xUSD / deUSD-collateral clusters once the spec resolves their venue ids, and
   real E3 positions, from the spec's block-pinned tables (membrane-solidity branch
   `claude/laughing-pasteur-lzifki`, `research/recall-dataset/data/chain/`).
2. Replay the E1 Morpho sUSDe/USDT USD-loop cluster (spec release 0.2.1 builds 3 positions).
3. Owner decision on per-wallet rows in committed research data.
4. Re-run the LST depeg calm rate on a synchronous source: the Chainlink STETH/ETH feed
   (proxy `0x8639…2812`), hourly from 2021-08, is `public/data/price-history/steth-eth-1h.json`
   on `origin/feat/risk-frontier-stress-grid`.
5. Exit capacity and oracle change: wire the sources in §7–§8, then measure their calm rate.

## 13. Reproduce

```
node scripts/research/build-position-alert-data.mjs        # ~10 min, keyless; refreshes data/position-alerts/
pnpm tsx scripts/research/position-alert-backtest.ts       # ~13 min; --skip-sweeps for the tier tables only
pnpm vitest run tests/unit/positionAlerts.test.ts tests/unit/positionAlertsBacktest.test.ts
```

The data manifest pins each input's SHA-256. The harness is deterministic.
