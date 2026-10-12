# Position alerts — back-test and recommended thresholds

2026-10-07, revised 2026-10-11 and 2026-10-12 · merged to `evm-migration` in #97, #98, #99 and
#101 · this revision completes E2 (Compound v3, Enclabs and Abracadabra added: $285.9M of debt,
the spec's ~$285M) and wires a governance-change source · status: **research, dry-run delivery
only. G2 is met on the per-cluster reading for every replayed cluster (§1). Delivery stays off
until the outbox gates pass.**

Demand: position alerts, 10 messages from 8 authors (UMBRELLA data product #7 on the agent
board). Members who leave positions "set and forget" asked for health-factor and
liquidation-price alerts. This memo reports what such alerts would have done on six years of
hourly ETH/BTC and on the stress events E1–E4, and their false-alarm rate in calm markets.

**The gate** is G2 of the Recall Coverage Dataset spec (claude.ai artifact
`Lm9KrFSbw9zp2FtWhcd3Nm`, §10 build order, phase P1). Verbatim:

> the alert trigger is back-tested on E1–E4 (fires before the breach block for every breached
> cluster) with its calm-30-day false-alarm rate reported; per-wallet rows are internal only

**Owner ruling 2026-10-11: G2 is read per cluster.** A breached cluster passes when a
warn-or-higher message to any of its members came before the cluster's first breach. Breach is
the first sample with HF < 1 on a position's path, the dataset's own test. The memo also reports
two stricter readings: the cluster's first breacher was itself warned first, and every breached
position was warned first.

| Spec event | Spec definition (§5) | What is replayed now | Match |
|---|---|---|---|
| E1 (EV-1) | Oct 10–11 2025 cascade. Aave v3 Core: 799 liquidations, $117.35M. The USD-loop line is Morpho sUSDe/USDT at LLTV 91.5% | (a) **Every account the Oct-10 census includes** (1,750, 25 collateral clusters), minute by minute on the Chainlink rounds of the spec's E1 pull (OP and ARB on Binance 1m). (b) The **Morpho USD-loop positions** (spec release 0.2.1: 3 rows, 2 with a mainnet oracle path), on the market oracle at every block | ✅ all clusters. 599 census-excluded accounts (no rebased breach) are listed, not scored |
| E2 (EV-2) | Stream xUSD collapse, Nov 2–12 2025, multi-chain, ~$285M of loans against xUSD / xBTC / xETH on Euler, Silo, Morpho, Gearbox. Elixir deUSD −98% on Nov 6. Spec data: "to pull; venue ids not yet resolved" | (a) **Every Morpho market** on xUSD, deUSD, sdeUSD or a PT on them that the Morpho API serves (Ethereum, Arbitrum, World Chain: 18 markets), hourly. (b) **Every Stream- or Elixir-collateral borrower on 19 Euler v2 borrow vaults, 8 Silo v2 markets, the Gearbox v3.1 Plasma credit manager, 3 Compound v3 comets, 2 Enclabs pools and 2 Abracadabra cauldrons** (Ethereum, Arbitrum, Avalanche, Sonic, Plasma), read on chain every 2 h at each venue's own oracle and risk-adjusted value, with hourly market prices between reads. Both on the venue oracle and on the market price | ✅ **$285.9M of debt at the window start**, the spec's ~$285M. A holder scan of every Stream and Elixir token found Compound, Enclabs and Abracadabra. Euler on 24 chains, every Gearbox v3 credit manager and Silo v1/v2 everywhere add only dust |
| E3 (EV-3) | KelpDAO rsETH exploit from Apr 18 2026 17:35 UTC. Aave Core USDC at ≥ 99.9% utilization for 82.4 h | The **214 Aave Core pure USD loops** of the spec's `positions_start`, on the dataset's own HF path model; exit capacity on **Aave Core USDC** from the spec's per-block table | ✅ matches |
| E4 (EV-4) | Morpho PT-reUSD-10DEC2026 oracle dip, Aug 25 2026 | **All 193 positions at t0** (149 loopers in 15 clusters + 44 below $1,000 of debt), on the observed oracle at every block from t0 − 300, with debt accrued on the market rate | ✅ matches |

Code: `lib/positionAlerts/` (pure rule engine) · `scripts/research/position-alert-backtest.ts`
(hourly, calm, E1-volatile, Nov-2025, E4 and depeg sweeps) ·
`scripts/research/position-alert-pinned-replay.ts` (the spec's clusters, §1b) ·
`scripts/research/position-alert-signal-backtest.ts` (exit capacity, oracle change, LST depeg on
Chainlink) · tests in `tests/unit/positionAlerts*.test.ts`.

**Where the data is.** Every input lives in the private repo `triccs/membrane-datasets`
(`position-alerts/`, `recall-coverage/`, `oct10-2025/`, `venue-stress/`, `oracle-registry/`,
`price-history/`), by owner ruling 2026-10-11 (agent board rule N18). The scripts find it through
`MEMBRANE_DATASETS_DIR`, default `../membrane-datasets`. This repo keeps only the public results:
`docs/research/position-alerts-backtest-results.json`, `…-pinned-results.json` (per cluster, no
position identifier) and `…-signal-results.json`. Every number below is in one of them.

---

## 1. Verdict

**Recommended default** (`DEFAULT_ALERT_CONFIG`, push from **warn**):

| Rule | Watch (in-app) | Warn (push) | Critical (push) | Anti-flap |
|---|---|---|---|---|
| Health factor | < 1.30 | < 1.15 | < 1.05 | band 0.03 · clear after 2h recovered · watch re-fire cooldown 6h |
| Health factor, **correlated loops** (USD-yielding or PT collateral on USD debt, opt-in `CORRELATED_LOOP_HF`) | < 1.05 | < 1.02 | < 1.01 | band 0.005 · 2h |
| Cushion burn: share of the HF cushion above 1.00 lost in 6h (only when HF < 1.5) | — | — | ≥ 50% | band 0.10 · 2h |
| Collateral depeg, stable (bps below $1, or below the venue's NAV for a yield-bearing stable) | 50 | 150 | 500 | 2 samples to confirm · band 20 · 2h |
| Collateral depeg, LST (bps below underlying × redemption rate), **on a synchronous ratio** | 100 | 250 | 600 | 2 samples · band 30 · 2h |
| Oracle change (registry adapter, direction-aware; frozen-price detector) | per change kind (§8) | | | 24h window |
| Governance change (Euler, Gearbox, Compound v3, Enclabs, Aave v3): threshold cut projected on the position | cut, HF stays ≥ 1.15 | projected HF < 1.15; ramp to 0; collateral forbidden | projected HF < 1; LT set to 0; repay paused | 24h window, ramps held to their end (§8b) |
| Distance to liquidation price | opt-in only (`LIQUIDATION_DISTANCE_PRESET`) | | | |
| LTV | opt-in user lines only (`ltvLines`) | | | |
| Exit capacity vs recall needed | internal only (§7) | | | |
| Exit-capacity burn | off; opt-in `CAPACITY_BURN_PRESET` (§7) | | | |

Every message states the liquidation price and the repay / top-up that restores HF 1.30.
**Poll every minute** (§9): the full E1 census loses 152 more warnings at a 5-minute poll.

**Gate status against G2** (default config, `…-pinned-results.json` `gateCluster` and `gate`):

| Event | **Per cluster (the ruling): clusters passed / breached** | First breacher warned first | Every breached position warned first | Lead | Verdict |
|---|---|---|---|---|---|
| E1, Aave census, 1-min poll | **19 / 19** scoreable clusters | 19 / 19 | 1,565 / 1,588 (98.6%) | cluster lead 1 min (BAL, 1 account) to 21 h; position median 16 min | **met** |
| E1, Aave census, 5-min poll | 17 / 19 (1INCH and BAL fail) | 17 / 19 | 1,413 / 1,588 | — | not met at 5 min: poll every minute |
| E1, Morpho USD loops | 2 / 2 | 2 / 2 | 2 / 2 | 2h 01m, censored (HF 1.0034 at the window start) | met |
| E2, all venues, breach on the venue oracle | **17 / 17** (Morpho 2, Compound 2, Euler 6, Silo 6, Gearbox 1) | 17 / 17 | 63 / 63 | 58 of 63 censored (in warn from the first read). Uncensored: 34–258 h | met |
| E2, all venues, breach on the market price | **32 / 32** (Morpho 2, Abracadabra 1, Compound 2, Euler 15, Silo 8, Enclabs 3, Gearbox 1) | 32 / 32 | 165 / 165 | 128 of 165 censored. Uncensored: median 3.3 h, min 0 (warned at the last read before HF fell below 1) | met |
| E3, 214 Aave USD loops | 0 / 0 (no loop breached, lowest HF 1.0065) | — | — | — | met (vacuous). In-event false alarms: §1b |
| E4, 193 positions | 4 / 4 | 4 / 4 | 20 / 20 | 69–79 min, censored (all in critical at t0 − 1h) | met |

132 E1 census accounts are not scoreable: their reconstructed path is already under HF 1 at
00:00 UTC, so the backward reconstruction does not hold for them (64 hold stable collateral
against stable debt and 48 volatile against volatile). 30 more never cross 1 on the path. So 6
of the 25 census clusters have no scoreable breach: the two one-account clusters sUSDe and USDe,
and the four stable-collateral clusters (USDC, USDT, DAI, USD₮0). Their liquidations are not
explained by a price path in the census data. Counting the 132 as misses gives 1,565 / 1,720
positions and 11 / 25 clusters on the strict reading.

The 23 E1 positions that no reading can warn fell from HF ≥ 1.5 to below 1 in one oracle update
(AAVE, ARB and LINK clusters). Per cluster they do not fail G2: other members of the same
clusters were warned hours before the first breach.

**Calm false-alarm rates reported** (G2's second condition):

| Signal | Calm false alarms | Source |
|---|---|---|
| HF tiers, default | 0.285 warn+ per position-month, 0 critical (§2) | 17 market-wide 30-day calm windows, synthetic positions |
| HF tiers on USD loops | default: 145 of 214 E3 loops warned in 21 days (136 at the first read). `CORRELATED_LOOP_HF`: 11 of 214, 0.086 per position-month | §1b |
| LST depeg, Chainlink STETH/ETH | **0 warn+** in 59.5 calm months; 6 watch | §6 |
| Stable depeg (USDC, USDe) | 0.087 / 0.032 warn+ per 30 days | §6 |
| Oracle change | 0.027 warn+ per asset-month over 264 asset-months | §8 |
| Exit capacity (ratio) | 0 in the 30 days before E3; 1.5–6.9 warn+ per month across 27 calm months | §7 |
| Governance change, Aave v3 Ethereum Core | 0.0013 warn+ per collateral-month over 1,486.5 calm months (2 critical: CRV Aug 2023, rsETH May 2026); e-mode drops 0.079 per month for an e-mode holder | §8b |
| Governance change, the E2 markets (May–Oct 2025) | 0.031 warn+ per market-collateral month over 510 months (upper bound: subjects with any event) | §8b |

**Per-wallet rows: internal only.** Owner ruling 2026-10-11: yes to data privacy. The raw
inputs, which hold Morpho borrower addresses and Aave census accounts, moved out of this public
repo to `triccs/membrane-datasets`. The public results hold cluster tables only, and the sample
message (§11) is a synthetic position. Old commits of this public repo still hold the earlier
data files. Removing them needs a history rewrite, which is an owner decision (board N18).

**G2 verdict: met on the per-cluster reading, at a 1-minute poll, for every replayed cluster.**
Every breached cluster of E1–E4 had a warn-or-higher message before its first breach, the calm
false-alarm rates are reported, and the per-wallet rows are internal. What G2 does not settle:

- **Censored leads.** Most E2–E4 positions sat in warn or critical from the first read. There
  the alert is a standing warning, not a timely one.
- **Governance can act faster than any alert.** On Nov 4 the governor of an Avalanche Euler vault
  liquidated a deUSD position with $1.15M of debt at venue HF 1.06. It set the LTV to 0 inside
  the liquidation transaction (§1b). The governance-change rule reports it, but only after the
  fact. The position had a standing HF warning. Slower changes it does warn of: Gearbox forbade
  xUSD on Oct 31 and ramped its threshold to 0 over Nov 3–5 (§8b).
- **E2 is reconstructed every 2 hours.** A borrower who acted between two reads is seen only at
  the next read. Three liquidations fell between reads and are scored at their own time (§10).

**So no position alert goes external yet.** Delivery stays dry-run until the gates of the
PERSONAL ALERT OUTBOX board entry (2026-09-27) pass and the owner turns it on.

## 1b. The spec's clusters, replayed (`scripts/research/position-alert-pinned-replay.ts`)

The E1 Morpho, E3 and E4 paths come from the Recall Coverage Dataset's own loaders and path
models (membrane-solidity `research/recall-dataset` at `ea00f926`), exported once by
`position-alerts/pinned/exporter/alertPaths.ts` in the datasets repo. They reproduce the
dataset: E4 has 20 rule breaches and 20 observed liquidations, the same 20 pairs. E3's lowest HF
is 1.0065 with 0 breaches, as in RESULTS 0.2.3.

**E1 census.** Each included account is priced on the feed of its collateral (and of its debt,
when volatile), scaled so the path prints the census state at the liquidation minute.
Breach is the first minute with HF < 1 on that path. At a 1-minute poll, 1,565 of 1,588
scoreable accounts got a warn-or-higher message first. All 23 misses had HF 1.4–3.3 at 00:00 and
crossed 1 in the 21:18–21:20 minute: the Chainlink AAVE/USD feed printed 192.23 at 21:18:47 and
134.43 at 21:20:11, LINK/USD went 15.50 → 13.05 → 11.41 in one block at 21:20:11, and ARB spot
fell 36% from the 21:18 to the 21:19 close. The cushion-burn rule checks only below HF 1.5, so it
had nothing to see before the jump.

**E3: the default HF lines do not fit loops.** A USD loop on an e-mode or 91.5% line lives at
HF 1.01–1.10. At E3 start, 136 of 214 loops were already under 1.15 and 77 under 1.05. None
breached. The warn-line sweep on the same clusters (`loopSweep`):

| Warn line (critical halfway to 1) | E4: breaches warned first / 20 (at the first read) | E4: median / min lead | E4: unbreached positions warned / 173 | E3: loops warned / 214 | E3: warn+ per position-month |
|---|---|---|---|---|---|
| HF < 1.005 | 20 (0) | 3.9 min / 2.8 min | 51 | 0 | 0 |
| HF < 1.01 | 20 (8) | 6.9 min / 5 min | 51 | 4 | 0.026 |
| **HF < 1.02 (`CORRELATED_LOOP_HF`)** | **20 (16)** | **72 min / 11 min** | **51** | **11** | **0.086** |
| HF < 1.03 | 20 (20) | 73 min / 69 min | 51 | 41 | 0.283 |
| HF < 1.05 | 20 (20) | 73 min / 69 min | 68 | 81 | 0.593 |
| HF < 1.15 (default) | 20 (20) | 73 min / 69 min | 109 | 145 | 0.962 |
| cushion burn only | 20 (0) | 3.1 min / 1.6 min | 51 | 0 | 0 |

The 51 unbreached E4 positions warned at every line are the ones the cushion-burn rule caught
in the 3% oracle drop: each lost more than half of its cushion and survived. The loop preset is
opt-in because it was chosen on the same events it was measured on. E1 Morpho is warned 2 / 2 at
every line.

**E2 on Morpho.** 28 positions were open in the window on the 18 markets. 23 carry under $1,000
of debt (dust), one deUSD position opened at 16:00 UTC on Nov 6, during the collapse, against
the fixed $1 oracle (it borrowed $2.9k on $347 of market value: not a victim), and one World
Chain sdeUSD position ($1.02M of debt) repaid and left on Nov 3 at 18:00, before the collapse.
That leaves four set-and-forget positions: Ethereum sdeUSD/USDC ($8.86M of debt, HF 1.016),
World Chain sdeUSD/USDC ($214k, HF 1.004, oracle fixed at $1), Arbitrum xUSD/USDC ($732k,
HF 1.059) and the World Chain position above while it was open.

- **No liquidation came in the window.** The oracles were fixed or NAV-based. The 8 liquidations since Oct 26 are dust, dated Nov 20 to Apr 2026.
- **The oracle breach came from interest, not price:** at 100% utilization the debt grew past a frozen collateral value. Ethereum sdeUSD crossed 1 on Nov 9 at 21:00, World Chain sdeUSD on Nov 6 at 08:00, Arbitrum xUSD on Nov 15 at 14:00.
- **The market breach came first:** Arbitrum xUSD on Nov 3 in the 12:00 hour, Ethereum sdeUSD in the 13:00 hour, World Chain sdeUSD on Nov 4 in the 12:00 hour. (A breach is stamped at the start of the hour in which HF fell below 1.)
- Every one of them sat in warn from the first read, so every lead is censored. For xUSD the depeg rule went critical 12 days before the oracle breach. The new frozen-price detector (§8) went critical at the last hourly read before xUSD's market breach.
- **Price sources disagree on sdeUSD.** CoinGecko trades had it 3.5% under the DefiLlama on-chain price by Nov 3 18:00 and 15% under by Nov 4 18:00, while the on-chain price held 1.069 until Nov 6. The replay uses CoinGecko trades, with the on-chain price only to fill gaps.

**E2 off Morpho** (`build-position-alert-e2-offmorpho.mjs`, every 2 h, Oct 26 → Nov 16). The
cohort is every account with debt at the Nov 2 block that held a Stream or Elixir collateral:
167 Euler accounts from Borrow logs, 72 Silo accounts from debt-share mints, 30 Gearbox credit
accounts, 21 Compound v3 accounts from SupplyCollateral logs, 11 Enclabs accounts from vToken
transfers and 14 Abracadabra accounts from cauldron logs. After the $1,000 dust line, 1 Euler
account with other collateral and the Gearbox accounts with no debt, 223 positions remain:
Euler 137, Silo 52, Compound 20, Enclabs 11, Gearbox 2, Abracadabra 1. They carried $275.3M of
debt at the window start (Euler $179.5M, Silo $61.8M, Compound $29.6M, Enclabs $3.5M,
Abracadabra $0.6M, Gearbox $0.2M). With Morpho's $10.6M, E2 holds **$285.9M**, the spec's ~$285M.

The first scan looked only at the venues the spec names. A second one listed the top 40 holders
of every Stream and Elixir token at Nov 2 and found Compound v3, Enclabs and Abracadabra. Euler
on 24 chains (Berachain, BOB, TAC and Swell included), all 70 Gearbox v3 credit managers on
Ethereum and Silo v1/v2 on every chain added $5 of debt (`position-alerts/e2-offmorpho-discovery/`
in the datasets repo).

- **One owner holds 74% of it.** One owner's accounts on Euler, Silo, Compound, Enclabs and Morpho carry $210.3M, $84.2M of it on Plasma Euler eUSDT0-7 alone. (Who, and the transactions below, are in the datasets repo: per-wallet rows stay internal.) Read the per-cluster gate with that in mind: one owner's warnings dominate the dollar count.
- **Most venue oracles did not follow the market.** Euler, Silo, Gearbox and Enclabs valued xUSD at its NAV, about $1.266, through the window. Compound's deUSD feed did follow it: $0.996 at 13:59 on Nov 6, $0.082 at 15:59. 60 positions on 15 clusters breached on the oracle, the first on Nov 3 at 13:30 (a Compound account absorbed between two reads).
- **What took them below 1 on the oracle.** Interest at a frozen collateral value for 32. Collateral withdrawn for 16: on Nov 3–4 these borrowers pulled xUSD out at the NAV price, down to the borrow limit, and interest did the rest. Those were not set-and-forget positions. The oracle price for 11 (8 Compound deUSD, xBTC, xETH). A liquidation-threshold change for 1 (Gearbox).
- **Euler ramped liquidation LTVs down 1–2 points on Nov 3** (from about 10:00 UTC on Plasma eUSDT0-7, emsUSD-3, eplUSD-2 and Ethereum eUSDC-64, eWETH-33, eWBTC-9). The replay reads HF from each venue's own risk-adjusted value (Euler `accountLiquidity`, Gearbox `twvUSD`, Compound's per-asset factors, Enclabs' comptroller liquidity), so the ramp moves HF as it did on chain. With the config LT the replay overstated HF by up to 0.035 after Nov 3.
- **On the market price** 162 positions on 30 clusters breached, the first on Nov 3 at 04:55 (Silo, Sonic). Every one was warned first, 125 of them from the first read. The 37 uncensored leads are short: median 3.3 h. The xUSD market fell from above the warn line to below 1 within hours on Nov 3–4. 32 xBTC and xETH positions have no market price and are scored on the oracle only.
- **Liquidations of replayed positions: 13.** 9 Compound accounts were absorbed between Nov 3 13:30 and Nov 6 22:35, all after the deUSD feed fell. One Gearbox account was partly liquidated on Nov 3 at 16:34, 2.5 h after its breach. 2 Morpho positions were liquidated later (Nov 20, Apr 2026). On Nov 4, 14:17–16:48 UTC, the governor of Avalanche Euler eUSDt-3 liquidated one deUSD sub-account in 4 transactions. Each set the deUSD liquidation LTV to 0, liquidated, then set it back to 0.925 (the vault's `GovSetLTV`, `GovSetMaxLiquidationDiscount` and `Liquidate` events). Venue HF was 1.06 at the read before. Every one of the 13 had a warning before its breach.

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
- What could have warned was the oracle construction. A 15-minute TWAP priced off an $8.97M pool against a $67.5M book (`docs/research/worst-carry-venues.md`). That is oracle-risk territory, not a price alert. The oracle-change rule (§8) reports changes to a configuration, and this one did not change.
- The pinned replay of all 193 positions (§1b) agrees: 20 / 20 breaches warned, every one already in critical at t0 − 1h. With `CORRELATED_LOOP_HF` the 4 positions above HF 1.02 got their first warn 11 minutes or more ahead.

So the honest borrower message for a position opened within ~2% of its line is a one-off
critical at open with the E4 precedent. The thresholds above do send it (HF < 1.05 → critical
at first read).

## 6. Collateral depeg

| Series | Window | Messages /30d (all) | Warn+ /30d | Warn+ episodes |
|---|---|---|---|---|
| USDC (DefiLlama, ~hourly) | 2023-01 → 2026-10 | 0.175 | 0.087 | 1: Mar 10 2023 (SVB), peak 652 bps |
| USDe | 2024-03 → 2026-10 | 0.221 | 0.032 | 1: Feb 1 2026, 159 bps |
| stETH/ETH, post-Shanghai | 2023-04 → 2026-10 | 0.636 | 0.141 | includes **artifacts** (below) |
| **stETH/ETH, Chainlink STETH/ETH (synchronous, hourly)** | **2021-08 → 2026-10, 59.5 calm months** | **0.101** | **0** | none in calm. In the 2022 discount (May 9 → Jul 31, held out as stress): warn May 13 at 439 bps, critical Jun 16 at 610 bps, 2 days before the trough (650 bps, Jun 18) |
| stETH/ETH, Chainlink STETH/ETH (E1, 1m, synchronous) | Oct 10–11 2025 | — | — | 1 warn at 21:25 UTC, the real 4.4% depeg |
| USDe Oct 10: Binance spot low vs Curve on-chain quote | Oct 10–11 2025 | — | — | Binance: critical (1,000 bps) · Curve: **never** above 50 bps |
| deUSD (E2) | Oct 25 → Nov 30 2025 | — | — | critical Nov 6 11:00 UTC; below $0.50 at 15:58 (**5h lead**) |
| rsETH/ETH vs 1.0686 rate proxy (E3) | Apr 10 → 26 2026 | — | — | critical Apr 19 02:00, the first sample showing the depeg; 0 messages in the 8.8 pre-incident days |

**Two source rules are now load-bearing:**

1. **Compute a ratio from one synchronous quote.** Use the Curve pool or Chainlink STETH/ETH. Never divide two independently sampled USD prices. The DefiLlama stETH/ETH series shows "depegs" of 837 bps on May 20 2024 and 818 bps on Feb 3 2025. Both are days ETH moved 10–20% inside an hour, and the two legs were sampled minutes apart. On the synchronous Chainlink feed the LST rule raised **0 warn+ messages in 59.5 calm months**, against 0.141 per 30 days on the DefiLlama ratio since Shanghai (`…-signal-results.json` `lstDepegChainlink`). **This passes the calm test for stETH. rsETH still has no synchronous ratio source here.**
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

## 7. Exit capacity vs recall needed — wired, too noisy, keep internal

**Source.** `venueStressCapacity` (`lib/positionAlerts/capacity.ts`) adapts the hourly
venue-stress history (schema `venue-stress-history/v1`, the archive series behind
`lib/position-sim/measuredCapacity.ts` on `feat/risk-frontier-stress-grid`). A paused venue
reads 0. For E3 the replay reads the spec's own table instead: Aave Core USDC's virtual
underlying balance at every state-changing block, polled every 5 minutes.

**E3 on Aave Core USDC** (exploit Apr 18 17:35 UTC; full lock = the first block at 99.9%
utilization, Apr 19 05:32). A modelled position needs the recall shown after a 20% shock:

| Recall need | Capacity first under the need | Cover-ratio rule: first warn+ (lead to the shortfall / to the full lock) | With `CAPACITY_BURN_PRESET`: first burn warn (lead to the full lock) |
|---|---|---|---|
| $10M | Apr 19 05:25 | 05:25 (0h / 0.1h) | 02:35 (2.95h) |
| $50M | 05:00 | 04:20 (0.7h / 1.2h) | 02:35 (2.95h) |
| $100M | 04:05 | 03:30 (0.6h / 2.0h) | 02:35 (2.95h) |
| $250M | 02:50 | 01:50 (1.0h / 3.7h) | 02:35 (2.95h) |

Neither rule fired before the exploit. The burn term (share of the trailing 6h peak capacity
gone, warn at 50%) adds 0.9–2.8 hours over the cover ratio for recalls up to $100M, and nothing
at $250M.

**Calm rate.** Hourly Aave Core USDC capacity, 27.4 months outside the stress windows and E3
(median $262M available). The cover ratio alone raised 2.5 / 5.3 / 6.9 / 1.5 warn+ messages per
month for $10M / $50M / $100M / $250M recalls. The burn preset added 5.2 per month at every size.
The burn sweep (lookback 1h / 6h / 24h × warn 30% / 50% / 70%, `burnSweep`) never went under 4.2
per month. In the 30 days before E3 both rules were silent at every size: the spec's per-event
calm window would pass, the 27-month record does not.

**So exit capacity stays internal**, and the burn term stays off by default
(`exitCapacity.burn = null`; opt-in `CAPACITY_BURN_PRESET`). Aave Core USDC capacity swings by
tens of millions in calm months, so a recall-size alert needs a venue-specific baseline first.

## 8. Oracle change — wired

**Adapter.** `fromRegistryChange` (`lib/positionAlerts/oracleRegistry.ts`) maps the registry's
change kinds (`lib/oracleRegistry/changes.ts` on `feat/oracle-registry` `d1d2ca4c`, copied
structurally) onto alert kinds, with a severity that depends on the direction:

| Registry kind | Alert kind | Severity |
|---|---|---|
| `aggregator` | `feed_replaced` | warn |
| `market_source`, `wiring`, `update_model`, `entry_removed` | `source_changed` | warn |
| `upgrade` (proxy implementation) | `upgrade` | warn |
| `discount` | `discount_changed` | **warn if raised** (marks a PT down at once), watch if lowered |
| `cap` | `cap_changed` | **warn if lowered** (can pin the price under the market), watch if raised |
| `quorum` | `quorum_changed` | **warn if fewer signers**, watch on a rotation, none if more |
| `heartbeat`, `deviation_threshold` | `heartbeat_changed`, `deviation_changed` | watch if loosened, none if tightened |
| `twap_window`, `entry_added`, `other` | `twap_changed` / `source_changed` | watch |
| `access` (read-access grant, e.g. Chronicle toll) | — | none |

**Frozen price.** `detectPriceFreeze` reports `price_frozen` (critical) when an oracle holds one
value for 6h while the market moves 200 bps or more away. It is skipped for oracles that never
move (hard-coded), where the depeg rule already tells the borrower. In E2 it went critical at
the last hourly read before Arbitrum xUSD's market breach (§1b).

**Calm rate.** The registry's config-card history (oracle dimension, since each subject's
collection start: 2023-07 to 2026-10) plus parameter diffs between its snapshots, for 8 assets
(264 asset-months): **0.064 messages and 0.027 warn+ per asset-month**. The warns were 2 proxy
upgrades (cbBTC, WBTC RedStone), the PT-srUSDe discount set from 0 to 5.31% and its Aave source
change, and 3 shrinks of the weETH oracle committee (5 → 3 or 4 → 3 members). The 7 wstETH
committee rotations were watch only. Bridge, admin and mint changes are out of this rule's scope.

**Gate.** No E1–E4 breach followed a registry change, so this rule can only be judged on its
calm rate, which is low. It stays internal until the registry is merged and read live.

## 8b. Governance change — wired

A venue can move health factor with no price move: it cuts or ramps a liquidation threshold,
disables a collateral or pauses repay. `lib/positionAlerts/governance.ts` adapts the events of
five venues into `GovernanceChangeEvent`s:

- Euler v2 borrow vaults: `GovSetLTV`, `GovSetHookConfig`, `GovSetMaxLiquidationDiscount`, rate model and governor changes.
- Gearbox v3 CreditConfigurators: threshold set or ramped, token forbidden, expiry, borrowing stopped.
- Compound v3: Configurator factor changes, in force at the comet upgrade, and the comet's `PauseAction`.
- Enclabs (Venus isolated-pools Comptrollers): threshold changes, paused actions, unlisting.
- Aave v3 PoolConfigurator: collateral configuration, freeze and pause, and e-mode changes.

Morpho Blue market parameters, Silo v2 configs and Abracadabra cauldron risk parameters cannot
change, so those markets are covered with no events. A price-feed swap found in these logs goes
to the oracle-change rule as `feed_replaced`.

**Severity is projected per position.** A threshold cut is scored by the health factor the
position would have once it fully applies: critical below 1, warn below 1.15, watch otherwise. A
raise is not a message. A threshold set to 0 at once, or paused repay, is critical. A ramp to 0
is warn until its last 6 hours. The rule reports itself uncovered for a market with no source.
`scripts/research/build-governance-changes.ts` reads the events on keyless archive RPCs, and
every log range is read on two endpoints with equal counts.

**In E2** the rule messaged 143 of the 223 off-Morpho positions on the venue-oracle run:

- 125 Euler positions: 63 watch and 60 warn, mostly from the Nov 3 ramps. 2 critical, from the Nov 4 zero-LTV transactions on Avalanche eUSDt-3: the liquidated sub-account (after the fact) and a second deUSD account in that vault.
- 8 Compound positions got the Nov 4 withdraw pause (watch). The cUSDS borrowers had repaid before it.
- 8 Enclabs positions went critical when the pool paused every action, repay and liquidation included, on every market: 6 on Sonic on Nov 4 at 14:01, 2 on Plasma on Nov 7 at 16:00. The borrower cannot act.
- 2 Gearbox positions got the Oct 31 ban on new xUSD and the Nov 3–5 ramp of its threshold from 0.90 to 0 (warn). That ramp took one of them below 1 and into a partial liquidation.

It gave the earliest warning to one breached position (Euler, Sonic). The others sat in HF warn
from the first read. Enclabs also raised the xUSD threshold on Sonic from 0.90 to 0.92 on Nov 3
(no message: a raise).

**Calm rates** (`…-signal-results.json` `governanceChange`). The holder sits at HF 1.30 under the
threshold in force before each change; changes inside 24 hours merge into one message. Stress
windows (E1, E2, E3) are counted apart.

| Series | Collateral-months | Warn+ per month | Any message per month | Notes |
|---|---|---|---|---|
| Aave v3 Ethereum Core, base changes | 1,486.5 | 0.0013 | 0.027 | 2 critical: CRV threshold 61% → 41% (Aug 2023), rsETH threshold → 0 and pause (May 2026) |
| Aave v3 Ethereum Core, e-mode drops | 292.4 | 0.079 | 0.079 | an asset dropped from an e-mode category: only that category's holders |
| E2 markets, May 1 – Oct 25 2025 | 510.4 | 0.031 | 0.090 | upper bound (subjects with an event). Mostly Euler curators setting a collateral's threshold to 0 at once |

In the E1 and E3 windows Aave's changes touch no replayed position. On Oct 11 2025 it added two
e-mode categories. In Apr 2026 it froze rsETH 1.5 h after the exploit and paused it on Apr 23.
It also set WETH's borrow LTV to 0 and froze it, with the liquidation threshold unchanged.

## 9. Monitor cadence and anti-flap

- **On ETH and BTC collateral, cadence matters only for critical.** Warn (HF < 1.15) kept ≥ 99.7% warned ≥1h on the 587 volatile E1 accounts from a 1-minute to a 60-minute poll. Critical HF < 1.05 alone missed 1 / 29 / 36 / 173 of 587 at 1 / 5 / 15 / 60-minute polls. The default critical tier, which adds burn, missed 0 / 0 / 0 / 22.
- **On the full census, cadence matters at every tier.** Warned before the breach: 1,565 / 1,413 / 1,382 of 1,588 scoreable accounts at a 1 / 5 / 15-minute poll. The alt-coin clusters (AAVE, ARB, OP, LINK, UNI, ENS) fell in minutes. **Poll every minute**, or on each oracle update.
- **Anti-flap.** For positions opened near a band in calm windows, the default band, dwell and cooldown cut messages from **7.95 to 1.83 per position-month**. On hourly history, warn+ false alarms fell from 0.759 to 0.251 at the same recall (88.4% vs 88.8%). Escalation is never delayed. An all-clear is sent only after a warn-level episode and 2h of recovery, so it is never sent into a bounce.

## 10. What this does not show

- **Set-and-forget only.** No replayed borrower repays, tops up or adds debt. Real borrowers act. A lead time is "time the borrower had", not "time the borrower used".
- **E1 and the November Morpho set reconstruct balances backwards** from the liquidation snapshot (E1) or from hourly Morpho history. On the 587 volatile E1 accounts the reconstructed path crossed HF 1 before the real liquidation for 403: median 4 minutes early, p90 869 minutes. §2–§4 score against the real liquidation time. The full-census replay (§1b) scores against the path's own first HF < 1, which is stricter, and drops the 132 accounts whose path starts under 1. On the November set, 143 of 145 crossed early, median 10.6 minutes, because spot leads the oracle.
- **OP and ARB are priced on Binance spot**, not on the Optimism and Arbitrum Chainlink feeds the venues read. Every other census asset uses a mainnet Chainlink round, scaled to the account's state price at its liquidation minute.
- **Spot is not the oracle** for the hourly set, E2 and the E3 ETH set. Spot lows liquidate slightly earlier than Chainlink would. A spot-driven monitor also warns slightly earlier than an oracle-driven one. E1 and E4 use the venue oracle.
- **E1 leads cap at about 21h** (the window opens at 00:00 Oct 10). L2 accounts are priced on the mainnet Chainlink feed, the same simplification as `evidence.json`.
- **Small n where it matters most.** E4 is 20 breached pairs in one 14-minute cascade. E2 on Morpho is 4 positions, and one owner holds 80% of the E2 debt off Morpho. E3 rsETH and exit capacity are one episode each. They show mechanism and timing, not rates.
- **E2 off Morpho is read every 2 hours.** A lead of 0 there means the warning came at the last read before HF fell below 1, up to 2 h before the crossing. Between two reads the position is held and the market price steps hourly. A borrower action inside an interval is seen at the next read. Two Enclabs positions re-levered or withdrew on Nov 3 while xUSD fell 9.7%; at the 12:00 print the depeg rule was already at warn. Three liquidations fell between reads (2 Compound absorbs, the Euler forced liquidation); they are scored as the breach at their own time. A position that opened and closed between two reads is not seen.
- **The loop preset and the burn sweep were chosen on the events they are scored on.** Treat their numbers as in-sample.
- **Precision is low by construction** for a 72h horizon in slow markets: HF < 1.15 has precision 0.19 on hourly history. Most warn messages are not followed by liquidation, because prices recover. That is the cost of 41h median warning. The 72h horizon is a modelling choice.
- **No interest accrual** in the synthetic positions. Morpho positions carry real accrued debt.
- **Calm windows for the HF tiers are market-wide.** They are 17 30-day windows of low ETH/BTC
  drawdown with synthetic positions. The spec's per-event calm points hold rates, not positions,
  so they cannot replay an HF path. Exit capacity uses the 30 days before E3 and 27 calm months.

## 11. Delivery: dry run only

`lib/positionAlerts/telegram.ts` formats a plain-text message and `dryRunTelegram()` returns it
with `sent: false`. There is no HTTP call, no token and no chat lookup. A test asserts the whole
module imports none of `scripts/lib/notify.mjs`, `scripts/lib/telegramBot.mjs`,
`components/Radar/telegramLogic.ts` or `alarmRules.mjs`, and contains no `fetch(`, no
`api.telegram.org` and no env read, per the board ruling that personal alerts must not reuse the
radar alarm sender. Sample (`results.sampleMessage`): a **synthetic** $100k cbBTC/USDC position on
Morpho (LLTV 86%), held untouched on the real Nov 2025 BTC 1-minute path from the window high.
The earlier sample came from a real borrower's replay; that one now stays in the private repo
(per-wallet rows are internal only).

```
[WARN] Morpho cbBTC/USDC (synthetic) · 0x0000…0000

Health factor 1.15
Below 1.15. Liquidation starts at 1.00. LTV 74.9% against a 86.0% line.

Collateral $133.6K · debt $100.0K
Liquidation if cbBTC reaches $79,148 (now $90,934).
To get back to HF 1.30: repay $11.6K, or add $17.6K of cbBTC.

Dry run: formatted, not sent · 2025-11-18 02:17 UTC
```

## 12. To meet G2

Done: every E1 cluster, the E3 USD loops, all E4 positions, E2 on all seven venues ($285.9M),
the per-wallet ruling, the per-cluster reading (owner ruling 2026-10-11, board T34), the LST calm
rate on Chainlink, and the exit-capacity, oracle-change and governance-change sources. Still open:

1. **E2 corners not checked:** archive state on Monad, Etherlink and Somnia (no keyless archive
   RPC), Dolomite on Botanix and Polygon zkEVM, Silo v2 on Injective, X Layer, MegaETH, Pharos
   and XDC. The holder scan misses a venue holding less than the 40th holder of a token. The
   spec lists the E2 venue ids as unresolved (MQ-7): `venues-2/RESULT.json` in the datasets repo
   resolves them.
2. **Governance sources for the live monitor.** The adapters are tested on the replay. A live
   source needs the same reads per market the user holds, with the 6-hour ramp escalation.
3. **rsETH depeg on a synchronous ratio.** Read the Kelp rate provider and a Curve or Balancer
   rsETH/ETH pool at the same block.
4. **Exit capacity:** a venue-specific baseline before any alert (§7).
5. **Public git history** still holds the earlier data files. A history rewrite is an owner
   decision (board N18).

## 13. Reproduce

Clone `triccs/membrane-datasets` next to this repo (or set `MEMBRANE_DATASETS_DIR`). Then:

```
node scripts/research/build-position-alert-data.mjs        # keyless; refreshes position-alerts/ in the datasets repo
node scripts/research/build-position-alert-e2-offmorpho.mjs # keyless, ~10–20 min; E2 off Morpho, six venues (E2OFF_CACHE=<dir> keeps cohorts)
pnpm tsx scripts/research/build-governance-changes.ts      # keyless; governance events (--only=e2,aave), every range on two endpoints
pnpm tsx scripts/research/position-alert-backtest.ts       # ~14 min; --skip-sweeps for the tier tables only
pnpm tsx scripts/research/position-alert-pinned-replay.ts  # ~1 min; the spec's clusters (§1b)
pnpm tsx scripts/research/position-alert-signal-backtest.ts # seconds; exit capacity, oracle change, LST depeg (§6–§8)
pnpm vitest run tests/unit/positionAlerts.test.ts tests/unit/positionAlertsBacktest.test.ts
```

`position-alerts/manifest.json` pins each built input's SHA-256, and every dataset directory has
a `PROVENANCE.md`. The pinned paths are exported by `position-alerts/pinned/exporter/alertPaths.ts`
from a checkout of membrane-solidity `ea00f926` (`node --experimental-strip-types`). All scripts
are deterministic.
