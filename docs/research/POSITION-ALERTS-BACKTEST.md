# Position alerts — back-test and recommended thresholds

2026-10-07 · branch `feat/position-alert-backtest` · status: **research, dry-run delivery only**

Demand: position alerts, 10 messages from 8 authors. Members who leave positions "set and
forget" asked for health-factor and liquidation-price alerts. This memo reports what such
alerts would have done on the measured stress events E1–E4 and on six years of hourly ETH/BTC.
It also reports the false-alarm rate over 30-day calm windows, as the board gate requires before
any external alert:

> Alerts must be back-tested on E1–E4, with the false-alarm rate over 30 calm days reported.

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

**Gate status, per rule:**

| Rule | E1 Oct-10-25 | E2 Nov-25 | E3 Apr-26 Kelp | E4 Aug-25-26 PT-reUSD | 30-day calm false alarms | Gate |
|---|---|---|---|---|---|---|
| Health factor tiers | ✅ 587 real accounts | ✅ 145 real positions | ✅ synthetic ETH + rsETH loops (30 Morpho liquidations in the window, none relevant) | ✅ 20 real positions — **cannot warn** (see §5) | ✅ reported (§2) | **passes, with the E4 limit stated** |
| Cushion burn (critical) | ✅ | ✅ | ✅ | ✅ minutes only | ✅ 0 per position-month | **passes** |
| Depeg | ✅ stETH/ETH + USDe | ✅ deUSD | ✅ rsETH | n/a (PT has no peg) | ✅ years of USDC / USDe / stETH | **passes for stables; LST needs a synchronous ratio source (§6)** |
| Exit capacity | — | — | n = 1 episode | — | ❌ no 30-day capacity series here | **fails — keep internal** |
| Oracle change | — | — | — | — | ❌ no registry to replay | **fails — keep internal** |

---

## 2. Health-factor lines: warning time vs false alarms

One threshold at a time, scored at that line. Columns: liquidations warned at least 1h before
(hourly) or 15m / 1h before (minute data); false alarms per position per 30 days (a message
with no liquidation in the next 72h, never-liquidated positions only).

| Line | Hourly 2020→26: warned ≥1h | false alarms /30d | Calm windows: false alarms /30d | E1 (1m): ≥15m / ≥1h | E2 (1m): median lead |
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

E2 is ≥ 99% warned ≥1h under every candidate. Nov 2025 was a slow grind, with a median lead
of 28.8h at the critical line.

Adding burn ≥ 50% as a critical-only trigger lifts Oct-10 critical warning ≥1h from 46.8% to
86.9%, and ≥15m from 74.8% to 98.1%. Calm-window critical false alarms stay at 0. A lower burn line at warn (30%)
more than doubled warn-level false alarms on hourly history against the default (0.304 → 0.662
per position-month) for 2.4pp more warned liquidations, so it is not in the default.

## 5. E4 (PT-reUSD, Aug 25 2026): no price alert can help a position parked on the line

All 20 liquidated positions sat at **HF 1.005–1.024** for up to 14 days (median 1.012, three
hours before). The Morpho oracle read 0.97099 at 04:00 UTC. It first ticked down 0.1% at
**04:33**, and the first liquidation followed at **04:37**. The low was 0.94386, and the oracle
recovered to 0.968 by 05:19.

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

Aave V3 USDe cash fell from $504M (Apr 18 12:38) through $408M (Apr 19 00:41) to $0 by 12:42.
For a position whose recall need after a 20% shock is $100M, the rule fired watch at 06:26 and
went critical at 06:56, at the crossing. The 30 minutes of warning came at watch only. With a
$250M need, warn came 2.3h before the crossing. A static coverage ratio sees a run only once it
is most of the way through. The venue-capacity study found a two-stage event + 6h-outflow rule
that flagged 8h48m before the same $100M crossing (`docs/research/venue-capacity-drivers.md`,
also n = 1). The next step is a capacity-burn term, the analogue of §4.

No 30-day capacity series is available offline: the venue recorder lives in Neon. So no calm
false-alarm rate exists and the rule does not pass the gate. `lib/position-sim/measuredCapacity.ts`
is not on this base; `capacity.ts` fixes the interface it must satisfy.

## 8. Oracle change — stub, fails the gate

`feat/oracle-registry` is not on this base. `oracleRegistry.ts` fixes the event interface
(`feed_replaced`, `source_changed`, `heartbeat_changed`, `deviation_changed`, `cap_changed`,
`paused`, `price_frozen`) and a severity map. With no source wired, the rule reports
**uncovered**, never "no changes". E4 is the case for building it.

## 9. Monitor cadence and anti-flap

- **Cadence matters only for critical.** Warn (HF < 1.15) kept ≥ 99.7% warned ≥1h on E1 from a 1-minute to a 60-minute poll. Critical HF < 1.05 alone missed 1 / 29 / 36 / 173 of 587 accounts at 1 / 5 / 15 / 60-minute polls. The default critical tier, which adds burn, missed 0 / 0 / 0 / 22 and warned 86.9% / 86.9% / 77.9% / 68.5% at least 1h ahead. **Poll at least every 5 minutes.**
- **Anti-flap.** For positions opened near a band in calm windows, the default band, dwell and cooldown cut messages from **7.95 to 1.83 per position-month**. On hourly history, warn+ false alarms fell from 0.759 to 0.251 at the same recall (88.4% vs 88.8%). Escalation is never delayed. An all-clear is sent only after a warn-level episode and 2h of recovery, so it is never sent into a bounce.

## 10. What this does not show

- **Set-and-forget only.** No replayed borrower repays, tops up or adds debt. Real borrowers act. A lead time is "time the borrower had", not "time the borrower used".
- **E1 and E2 reconstruct balances backwards** from the liquidation snapshot (E1) or from hourly Morpho history (E2). On E1 the reconstructed path crossed HF 1 before the real liquidation for 403 of 587 accounts: median 4 minutes early, p90 869 minutes. Some accounts changed balances during the day, and liquidators are not instant. The real liquidation time is used for scoring. On E2, 143 of 145 crossed early, median 10.6 minutes, because spot leads the oracle.
- **Spot is not the oracle** for the hourly set, E2 and the E3 ETH set. Spot lows liquidate slightly earlier than Chainlink would. A spot-driven monitor also warns slightly earlier than an oracle-driven one. E1 and E4 use the venue oracle.
- **E1 leads cap at about 21h** (the window opens at 00:00 Oct 10). L2 accounts are priced on the mainnet Chainlink feed, the same simplification as `evidence.json`.
- **Small n where it matters most.** E4 is 20 positions in one 14-minute cascade. E3 rsETH and exit capacity are one episode each. They show mechanism and timing, not rates.
- **Precision is low by construction** for a 72h horizon in slow markets: HF < 1.15 has precision 0.19 on hourly history. Most warn messages are not followed by liquidation, because prices recover. That is the cost of 41h median warning. The 72h horizon is a modelling choice.
- **No interest accrual** in the synthetic positions. Morpho positions carry real accrued debt.

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

## 12. Reproduce

```
node scripts/research/build-position-alert-data.mjs        # ~10 min, keyless; refreshes data/position-alerts/
pnpm tsx scripts/research/position-alert-backtest.ts       # ~13 min; --skip-sweeps for the tier tables only
pnpm vitest run tests/unit/positionAlerts.test.ts tests/unit/positionAlertsBacktest.test.ts
```

The data manifest pins each input's SHA-256. The harness is deterministic.
