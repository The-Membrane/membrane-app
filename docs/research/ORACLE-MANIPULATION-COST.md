# Oracle Manipulation Safety Ratio: Methodology Spec (v1, 2026-10-05)

> **Status.** Research-grade methodology, 2026-10-05. **Not yet implemented.** All thresholds are proposals pending owner sign-off. An attack-cost curve is also a target list; publication policy is open (§8 Q5).
>
> Inputs: five fact-checked research reports, one completeness critique (rejections: Appendix). *(unverified)* = no primary source. Formulas are models until fork-tested.

## 1. Definitions

- **Leaf ℓ:** the state an attacker moves: a pool, Pendle market, ERC-4626 vault, aggregator, Pyth id or CEX source set. Group consumers by leaf, never by oracle address, window or chain: one Pendle buffer feeds every TWAP duration, one Pyth id or CEX source set every chain.
- **X:** the signed gap between oracle and true price. For market m, X_m = (1+X)^e − 1, with e = +1 if ℓ prices the collateral and −1 if the loan asset, then clipped by min/max/cap branches and feed clamps (§2.4). A min(TWAP, curve) passes upward moves up to the gap; in PT-reUSD the TWAP already sat below the curve, so the curve gave no downside protection.
- **h, W, N:** seconds the manipulated price is in force; the window; N = W/τ_b, with τ_b the consumer chain's block time (12 s L1, 2 s Base, 0.25 s Arbitrum).
- **Cost C:** net mark-to-market loss at the true price (arbitrage slippage + fees − unwind recovery). Trade size, depth and borrowed inventory are **capital**, reported separately.
- **Free move X_free:** the largest |X| available at C = 0 (§2.4).
- **EV:** value extractable at true prices, net of attacker collateral, summed over every market on every chain reading ℓ.
- **Safety ratio:** R = min over X, h, direction, regime of C/EV, with arg-min. **R_lo = C_lo/EV_hi**, EV_hi at capture share **α = 1** (the attacker controls timing); α < 1 only in the point estimate R_pt.

**Directions.** **Up** (lenders lose): borrow at the inflated price and walk; pays only when X_m > 1/LTV − 1 (9.3% at 91.5%, 3.6% at 96.5%). **Down** (borrowers lose): force liquidations from near zero (PT-reUSD's first victim: ~0.65%); usually binds at high LLTV (n = 1).

## 2. Cost model

### 2.1 Spot cost to move one pool by ε

| AMM | Loss | Reads |
|---|---|---|
| Constant product | R(√(1+ε) + 1/√(1+ε) − 2) ≈ D·ln²(1+ε)/8 | reserves |
| Uniswap v3/v4 | Walk initialized ticks: Σ[Δin_i/(1−f) − P0·Δout_i]. **Never TVL.** Past the last tick the price moves free. | `slot0`, `liquidity`, `tickBitmap`, `ticks(i).liquidityNet`; v4 StateView plus hook dynamic fee |
| Balancer weighted | Ai = Bi((1+ε)^(Wo/(Wi+Wo)) − 1) | balances, weights |
| Curve stableswap-ng | Bisect dx with `get_dy` on a fork; dynamic off-peg fee | `A`, `stored_rates`, balances, `offpeg_fee_multiplier` |
| Pendle | Simulate from `readState()`; 96% PT-proportion cap bounds down, exchangeRate ≥ 1 bounds up | `readState`, expiry |

Fork-simulate Curve, Balancer stable, Pendle and v4 hooks; the fork also tests the closed forms (https://eprint.iacr.org/2022/445.pdf).

**Removable depth.** C_lo uses depth net of the **top-k removable LP positions** (proposal k = 3); R_pt uses live depth. A few LPs (possibly the attacker) often hold concentrated depth and can withdraw first; a slot controller can burn others' limit orders (https://blog.uniswap.org/uniswap-v3-oracles) and refill an exhausted pool at the target price (https://chaoslabs.xyz/posts/chaos-labs-uniswap-v3-twap-market-risk).

### 2.2 Averaging: spot move s for an oracle move X

| Averaging | Required s | Notes |
|---|---|---|
| Geometric TWAP (v3) | 1+s = (1+X)^(W/h) | Counts from the next block; capped by min/max tick and truncating hooks (±9,116 ticks/block) |
| Arithmetic TWAP | 1+s = 1 + X·W/h | One block can beat holding; scan every h |
| Pendle ln-rate TWAP | Δln(1+r) = −ln(1−X)/τ · W/h | v3 write semantics (verified in code); 900 s needs cardinality 85 |
| Curve EMA | s = X/(1 − e^(−h/ma_exp_time)) | Previous block's price; spot capped at 2.0 (ng); one block ≈ 1.38% at 866 s; read `ma_exp_time` per pool |

Averaged oracles need state that survives a block, so flash loans cannot fund them; borrowed ℓ can (§2.3). Measure arbitrage reversion ρ per chain (sub-second L2 blocks are not all arbitraged).

### 2.3 Regimes

| Regime | Cost | Capital |
|---|---|---|
| R1: one interval | C1 at (1+X)^N, capped by exhaustion cost | Δ(s) |
| R2: arbitraged every block | (h/τ_b)·c(s), **oracle pool** depth only; geometric ≈ N·D·ln²(1+X)/8 | Δ(s) |
| R3p: proposer holds k slots | ≈ 2f·Δ(m_k) + forgone block value, m_k = (1+X)^(N/(k−1)) | Δ(m_k), not flash-loanable |
| R3b: builder, block share p | ≥ (1−p)·R2: lost blocks cost R2 each; exclusion assumed free | Δ(s) |
| R4: no effective arbitrage | round-trip fees + gas + unwind loss | ≈ Δ(1+X) |

- **C_hi** = ρ·R2. **C_lo** = min(R1, R4 if ρ ≈ 0, R3p at k*, R3b at p_top), each with frequency and capital.
- **k*** = largest k with ≥ 1 expected run per 30 days for the largest single operator entity (not a staking protocol's aggregate); runs of ≥ k slots at share s occur ≈ 7200(1−s)s^k times a day (1%: three in a row ≈ 0.2/month). EIP-7917 (2025-12-03) guarantees lookahead.
- **p_top** = 52.38% (Titan, 7 d to 2026-10-05, https://www.relayscan.io/overview?t=7d). Rival builders pricing the arbitrage into bids is pre-PBS reasoning *(unverified)*; hence the (1−p) bound.
- **Evidence limit:** R3p infeasibility on deep v3 rests on one pool sampled 2022-09-04 ($709B swap for a 2-block 20% move on USDC/WETH; Uniswap Labs, 2022-10-27). Mackinga's "~100× cheaper" is PoW, arithmetic-TWAP only.

**Capital routes** (feasibility, not cost): flash loans (same block); **borrowed ℓ** for a downward hold at ≈ 0 interest (collateralised; check borrowable ℓ before calling an attack infeasible); **Pendle YT leverage** ≈ YT price × PT moved ($320k of YT pushed ~5.4M PT into a ~3.1M-PT pool); **upside self-financing**, borrowed proceeds re-buy and re-post ℓ (Moola: 243k CELO own, rest recycled borrows).

**Unwind.** Downward with borrowed ℓ: repay with seized ℓ, so no buyback and no exit through the thin pool; C_down = min(sell-leg loss, 2f·Δ with buyback) + borrow fees. Pendle: seized PT plus held YT redeem at par (fees are on the rate, so 2f·Δ is approximate); default PTs to R4 (n = 1).

### 2.4 Zero-cost moves (C = 0 up to X_free)

The attacker times an existing gap; R is degenerate, so these are coloured by EV (§5).

| Path | X_free | Direction and notes |
|---|---|---|
| **Push feed: deviation band, heartbeat** | dev + drift during update latency (p90 breach-to-update) | Upside and loan-side only: a falling market leaves the stored price stale-high; borrow at it or front-run the visible update (OEV). Pays when X_free > 1/LTV − 1 (loan-side > 1 − LTV). Back-running updates raises α, not cost. Metronome's Base ETH/USD sat outside its band 18.5% of minutes; stale-price flow drained pools unmanipulated (https://paragraph.com/@metronomedao/ethusd-oracle-service-and-adverse-flow-on-msusd-mseth-liquidity-pools-measured-findings). |
| **Two-feed composite** (wstETH/USD ÷ ETH/USD) | dev1 + dev2 | **Both.** Legs update at different times, so the ratio drifts with no market move, reaching positions 0.65% from a 96.5% LLTV. Back-run the leg update. |
| **Chainlink `minAnswer`/`maxAnswer`** | true price beyond the clamp | Up: below `minAnswer` the feed stops, so collateral bought at market borrows at the floor once P < LTV·minAnswer (Venus/Blizz, LUNA 2022 *(unverified)*); `maxAnswer` mirrors loan-side. Show the crash distance where each binds. |
| **Pull feed, stored** (Pyth `updatePriceFeeds`) | largest move within maxAge, newer than stored | Either, once per update (https://docs.pyth.network/price-feeds/best-practices). |
| **Pull feed, not stored** (RedStone core calldata, ~3-min default *(unverified)*; Pyth `parsePriceFeedUpdates*`) | (max − min)/min over the window | **Both in one tx:** a high package to borrow, a low one to liquidate. |
| **Read-only reentrancy** (Curve `get_virtual_price`, Balancer `getRate` without the pool's lock check) | unbounded in the callback | Both; atomic, flash-funded (dForce, Sturdy 2023 *(unverified)*). **Hard-red.** |

### 2.5 Classes where cost-to-move is the wrong metric

| Class | What replaces the ratio |
|---|---|
| **Push CEX feeds** (Chainlink, Chronicle, RedStone) | **(a) Source cost:** volume-weighted average per data aggregator (undisclosed filters), then node and network medians. Moving a venue of weight w by Y moves the index ≈ w·Y at loss ≈ notional × Y/2, plus holding until the update. **w is endogenous:** wash volume raises it (w = (V_v + V_wash)/(V + V_wash)); add wash fees and re-solve (YieldBlox: one self-trade on an empty book). Nodes share aggregators, so the source layer is one leaf. CoinGecko 2% depth is capital. **(b) Collusion floor:** OCR f+1 nodes; Chronicle `bar`, or one feed on ScribeOptimistic; RedStone ~majority of threshold *(unverified)*. **(c) Latency:** median staleness, p90 breach-to-update. |
| **Pull feeds** | As push, plus §2.4 selection. |
| **ERC-4626, balance-based** | Donation C ≈ X·totalAssets·(1−σ) (σ = attacker's share); also instant drops. **Near-empty:** C shrinks with totalAssets (wUSDM: supply 5.33M → 1.27M, then 439,560 USDM moved 1.07 → 1.76, https://community.venus.io/t/5004). **Marked at spot:** leaf = strategy pool (Makina: Curve `calc_withdraw_one_coin`). **Vesting (sUSDe-style):** do direct transfers count at once? Vested donations act like an average. |
| **Reported rate / issuer NAV** | Lido, sUSDS: per-report sanity bound and governance-compromise cost. Signed NAV: key compromise, unpriceable, flag (Resolv: 80M USR minted via a stolen key). |
| **CAPO** | X_max = (snapshotRatio + growth·Δt)/currentRatio − 1; show headroom (can go negative). Base feed uncapped, read via `latestAnswer`. |
| **Fixed price or peg** | Depeg exposure: break-even discount 1 − LTV × reachable liquidity; includes WBTC/cbBTC via BTC/USD and bridge-hack depegs. |
| **Pendle linear discount** | Deterministic; show break-even APY r* (market PT = linear × LLTV) vs the cap-implied maximum and history. |
| **Composite** (MorphoChainlinkOracleV2, Liquity) | min over splits of Σ c_i(x_i) s.t. Π(1+x_i) = 1+X, not the cheapest leg. Quote legs move inversely; a leg on both sides cancels. Flag donatable quote-side vaults and two-leg drift (§2.4). Liquity: min(market, rate) to borrow and liquidate, max to redeem. |
| **Admin-swappable source** | Per consumer: holder and timelock for Chainlink proxy `proposeAggregator`/`confirmAggregator`, EulerRouter governor, Aave POOL_ADMIN and Risk Stewards (CAPO params), upgradeable adapters (MorphoChainlinkOracleV2 is immutable). Config changes are moves too (Moonwell cbETH lacked its ETH/USD leg: $1.78M bad debt, https://forum.moonwell.fi/t/2068). Scored on the config card. |
| **L2 / cross-chain** | Sequencer uptime (does the consumer check an uptime feed with grace period?), relayed-rate lag (a band-like free move), bridge depeg (peg row). A centralized sequencer is R3 with s = 1: an operator-trust row, not in C_lo. |

## 3. Extractable value

**Upside.** U(X) = Σ_m B_m·[1 − 1/(LTV_m(1+X_m))]⁺, with B_m = min(avail, borrowCap − debt, isoCeiling − isoDebt, LTV·collateralCapHeadroom·P(1+X_m)).
- Cap Σ B_m by any shared pool (Aave reserve, Fluid liquidity layer, MetaMorpho vault).
- **Loan-side variant (UwU):** B_m·[1 − (1−X)/LTV]⁺, paying when X > 1 − LTV.
- **Borrow-side LTV/price:** Aave LTV (not LT); Morpho LLTV; Euler borrowLTV at bid/ask; Comet borrowCollateralFactor; Fluid `oraclePriceOperate`; Silo `maxLtvOracle` (falls back to `solvencyOracle`).
- **avail** includes Morpho `reallocatableLiquidityAssets` and V1 supply-on-behalf donations, which supply caps do not stop.

**Downside.** With x = |X_m|: D(X) = α·Σ_m Σ_{HF′<1} r_i·[I_i/(1−x) − 1] + cascade − exit slippage; α = 1 for EV_hi.
- HF′ = (Σ_{j≠ℓ} c_j·LT_j + c_ℓ·LT_ℓ·(1−x))/debt; r_i = min(CF·d_i, c_i·P(1−x)/I_i).
- I/(1−x) counts collateral seized at the depressed price: Aave CAPO liquidators took 382.76 ETH from mispricing vs 129.72 ETH bonus (https://governance.aave.com/t/24269).
- **Exit slippage = 0** when seized ℓ repays borrowed ℓ (§2.3).
- **Reflexive cascade:** liquidators selling seized ℓ into the leaf pool push X further for free. Iterate X_{n+1} = X_n + impact(β·seized_n) to a fixed point, β = share sold into the leaf (1 for EV_hi); Pendle and LLAMMA cases *(unverified)*.

| Protocol | Incentive / close factor |
|---|---|
| Morpho | I = min(1.15, 1/(0.3·LLTV + 0.7)), CF 100%; pre-liquidations pay `preLIF` ≤ 1/LLTV (1.093 at 91.5%) via their own oracle |
| Aave v3.3 | I = 1 + (LB−1)(1−protocolFee); repay ≤ min(reserveDebt, 0.5·totalDebt) only if HF > 0.95 and both legs ≥ $2k, else 100%; < $1k leftover forces full liquidation (`aave-v3-origin`) |
| Euler V2 | I = 1/max(h′, 1 − maxDiscount) at mid; `liquidationCoolOffTime` blocks atomic round trips |
| Compound III | `absorb` pays nothing; `buyCollateral` discounts only while reserves < target |
| Liquity V2 | JIT Stability Pool deposit lets the attacker choose its share |
| Silo | `liquidationTargetLtv` acts as close factor |

**Score the best path**, at least U + D on both sides (UwU: down, borrow, up, liquidate); never add correlated assets.

**Finding every market on a leaf:**
- **Morpho:** `api.morpho.org/graphql` (limit 1000, key `marketId`); follow `oracle.data` to source; cross-check `CreateMarket`; `marketPositions` for health.
- **Aave / Spark:** `getReservesList` → `getSourceOfAsset`, recursing CAPO, `PriceCapAdapterStable` and `PendlePriceCapAdapter` (linear discount × asset/USD: no Pendle market is a leaf there). HF′ needs per-reserve balances and eMode LT, which `getUserAccountData` (aggregates) lacks: read `UiPoolDataProviderV3.getUserReservesData` per borrower from Borrow events.
- **Others:** Euler `EulerRouter.getConfiguredOracle`, Comet `getAssetInfo`, Fluid `getVaultEntireData`, Silo `getConfig`, Liquity branch `priceFeed`.
- **Pendle:** view calls are not logged, so find `getPtToSyRate(market, ·)` consumers by scanning oracle constructor args and immutables.
- **Cross-chain:** sum EV across chains for chain-agnostic leaves (Pyth id, CEX source set behind per-chain feeds, relayed rate); a DEX leaf sums only its pool's consumers.
- **Ground truth:** fork, mock ℓ to P(1±X), read protocols' health views; closed forms only rank.
- **Rolling maxima:** PT-reUSD/USDC re-levered from $52.2M to $99.7M borrows (Morpho API, 2026-10-05).

## 4. Choosing X

R is a curve, both directions: X ∈ {0.25, 0.5, 1, 2, 3, 5, 10, 20, 50}% ∪ every position's break-even move (x where HF′ = 1; 1/LTV − 1 up) ∪ each X_free, since a fixed grid misses the arg-min; h ∈ {same block, 1, 2, 3, 5 blocks, N} in the consumer chain's blocks.

Report the worst point (X, h, direction, regime), where R first crosses 1, per-market break-evens, EV(X_free).

## 5. Calibration

E = value retained, net of abandoned collateral, before negotiated returns. "est." = derived.

| Incident | C | E | C/E | Source |
|---|---|---|---|---|
| Harvest 2020 | ≈$6.2M (est.: 0.3% flash fee × 30 tx + swap loss) | ≈$24M (net of fees) | ≈0.21–0.27 | https://medium.com/p/3cf900d65217 |
| Cream 2021 | $9.42M donation (+≈$1.9M fee, unverified) | $120–130M | 0.07–0.09 | https://github.com/yearn/yearn-security/blob/master/disclosures/2021-10-27.md |
| Inverse Apr 2022 | ≈$1.74M (DAO: ≈$3M) | $14.8–15.6M | 0.11–0.20 | https://medium.com/p/b15c2e917888 |
| Inverse Jun 2022 | ≈$4.0M (E − $1.26M profit) | $5.3M net ($10.1M gross) | 0.76 (0.39 gross) | https://blocksec.com/blog/our-take-on-the-inverse-finance-security-incident-price-manipulation-attack |
| Mango 2022 | ≤ ≈$4M buy notional | ≈$106M ($116M − $10M collateral left) | ≤0.04 | https://www.soliduslabs.com/post/mango-hack |
| Moola 2022 | ≤ own capital (243k CELO) | $8.4–9.1M | ≲0.03 | https://www.certik.com/blog/moola-market |
| Bonq 2023 | ≈$358 (20 TRB) | $1.85M | 0.0002 | https://medium.com/@omniscia.io/bonq-protocol-incident-post-mortem-4fd79fe5c932 |
| UwU 2024 | ≈$1M+ (est., unverified) | $19.3M | ≈0.05–0.08 | https://slowmist.medium.com/analysis-of-the-uwu-lend-hack-9502b2c06dbe |
| Makina 2026 | fees + Curve imbalance loss (unpublished) | 1,299 ETH ≈ $4.13M | <0.05 (est., unverified) | https://makinafi.substack.com/p/post-mortem-january-20th-2026-incident |
| YieldBlox 2026 | ≈$4 (0.05-USTRY self-trade) | ≈$10.2M | ≈4e-7 | https://github.com/saariuslystoned/blnd-huntr |
| PT-reUSD 2026 | ≈0 ($320,000 in, $321,131 out) | $0.36M realised – ≈$1.3M | ≈0 | https://www.pennyworks.com/articles/defi-accounting/cant-fake-liquidity/ |

**Failed:** Venus THE 2026 ($9.92M in, $5.21M retained: C/E 0.67 gross, ≈1.9 retained; CEX hedge under investigation; donation supply-cap bypass; $2.15M bad debt; https://blocksec.com/blog/venus-thena-donation-attack). Aave CRV 2022 (failed, $1.6M bad debt; https://arxiv.org/abs/2302.04068). Hyperliquid JELLY 2025 ($7.17M in, $6.26M out per Arkham; a perp venue).

**Excluded:** Rodeo (no attacker cost; its $1.7M manipulation capital came from Rodeo's own pool, https://medium.com/p/f35635c14101); bug and fixed-price cases (KiloEx, Loopscale, Silo/Morpho wstUSR, Polter) become overrides.

**What the data supports, with sample sizes:**
1. Successful C/E ≈ 0–0.76, median ≈ 0.03–0.1, many rows estimates or bounds. 1× is break-even by definition, not a finding.
2. Failures: n = 3, mixed classes. Venus failed at 0.67 gross, inside the success band, so gross ratios do not separate outcomes.
3. Cost error: the one incident with two independent estimates differs 1.7× (Inverse Apr); the 3–10× band is analyst judgement. A 3× line sits inside either.
4. No successful geometric-v3-TWAP attack exists here; the deep-pool anchor is simulation (Uniswap Labs, Euler).
5. Downside EV has one genuine check (CAPO: 383 ETH predicted, 382.76 measured); PT-reUSD's "profit = (LIF−1) × repaid" is an accounting identity.
6. Pendle R4, YT leverage and "down binds at high LLTV": PT-reUSD only (n = 1).
7. The floor rests on two positions: Gauntlet's polled ~$100M (https://governance.aave.com/t/10757/36) and Euler eIP 9's ≥$500M over 2 blocks for collateral tier (URL not captured).

**Recommendation** (proposal):

- **Red:** R_lo < 1.5, or any hard-red override, or EV_hi(X_free) ≥ E_min (proposal $100k).
- **Yellow:** R_lo ≥ 1.5 but R_pt < 10, or C_lo < floor (proposal $100M), or 0 < EV_hi(X_free) < E_min.
- **None:** R_pt ≥ 10, C_lo ≥ floor, EV_hi(X_free) = 0.

Keep 1.5× (2× over the highest successful C/E, 0.76, on a lower bound). Replace 3× with 10× on the point estimate plus the floor: attackers accept losses and hedge (Venus, CRV).

**Hard-red overrides:** same-block-readable sources (spot `get_p`, balance-based share prices, LP balances, Tellor without dispute delay, read-only-reentrant `get_virtual_price`/`getRate`); hardcoded prices on depeggable assets; TWAPs with few samples or a bypassable window (Rodeo: 4 samples; Inverse: bypassed after 15 s); VWAPs over volumeless markets; effective depth below the debt it prices (PT-reUSD: $8.97M pool, $52.2M borrows); stableswap-ng pools deployed before 2023-12-12 with non-18-decimal or rate-oracle tokens; adapters that clamp `secondsAgo`.

## 6. Uncertainty and honesty

- **Tag every number** measured (block N), simulated, modelled or reported; show [R_lo, R_hi], never a bare ratio.
- **Best state is "no warning in the modelled range"**, never "safe"; governance, keys, misconfiguration, latency, sequencer and depeg are separate rows.
- **Point-in-time:** withdrawals, fees, reallocation and re-levering move R (Resolv borrowing: $4,900 → $6.2M in hours); show staleness.
- **Unreadable inputs** show as modelled or unknown, never silently defaulted: Chainlink sources and weights (w modelled); ρ (needs large swaps and next-block state; unmeasured ⇒ ρ = 0 in C_lo); Pyth `maxAge`, RedStone tolerance (getterless; read verified source); v4 per-swap fees (simulate); Pyth publisher counts (Pythnet); stake and builder shares (beacon, relays); p90 breach-to-update (external reference series).

## 7. Implementation map (membrane-app `feat/oracle-registry`)

**Catalog** (`data/oracle-registry/catalog.json`, `lib/oracleRegistry/catalog.ts`): add `OracleEntry.manipulation` with `leaves[]` `{kind, address, side, chainId}`; `averaging` `{type, windowSeconds, blockTimeSeconds, maExpTime, cardinalityRequired, clampsSecondsAgo}`; `passThrough` `{up, down}`; `freeMove` `{deviationBps, heartbeatSeconds, legs[], clamp, pull: {stored, windowSeconds}, reentrancyGuarded}`; `admin` `{holder, timelockSeconds, upgradeable}`; `overrides[]`. `OracleEntry.chainId` and `OracleSnapshot.chainId` are the literal type `1` today; cross-chain EV needs them widened. Extend `UsedBy` with borrow/liquidation LTV, incentive, close factor, avail, `sharedPoolId`; `verify-catalog.mjs` checks leaf wiring.

**Collector** (`scripts/oracle-registry/collect.mjs`, `lib/readers.mjs`) adds leaf state, LP concentration (position events, LP-token holders), aggregator `minAnswer`/`maxAnswer`, Chainlink round history, proposer lookahead (`/eth/v1/beacon/states/{id}/proposer_lookahead`), relayscan builder shares, per-reserve Aave balances, the Pendle constructor scan, sequencer uptime feeds, the §3 enumeration and anvil forks; writes `data/oracle-registry/manipulation/<leafId>.json`.

**Engine** (new pure `lib/oracleRegistry/manipulation.ts`): `requiredSpotMove`, `spotCost`, `removableDepth`, `regimeCosts`, `freeMove`, `upsideEV`, `downsideEV`, `cascade`, `ratioCurve`, `manipulationVerdict`. Fixtures: PT-reUSD and wUSDM replays score red; a deep ETH/USDC v3 pool clears the ratio; a 96.5%-LLTV two-USD-feed composite flags a free move.

**Card UI:** a separate Manipulation badge (none/yellow/red/n/a), distinct from consensus colours; expanded: R(X) curve, arg-min, capital, EV by market and chain, X_free, provenance; non-tradeable classes show their replacement metric. Admin rows go to the **config card** (Pending amber, Proposed blue, Historical grey; a shorter timelock is red), reusing `lib/oracleRegistry/changes.ts` kinds `aggregator`, `cap`, `wiring`.

**Alerts:** verdict change, EV jump, depth drop or LP withdrawal, low CAPO headroom, queued admin change, sequencer downtime, catalog change.

**Compute** *(estimated)*: fork bisection and per-borrower reads dominate; EV on events, full recompute hourly.

## 8. Open questions for the owner

1. **Thresholds:** 1.5×, 10×, the floor ($100M, $500M, per asset), E_min.
2. **R3:** entity-share source (beacon vs Rated), the 30-day k* rule, k for removable depth.
3. **v1 EV scope:** protocols beyond Morpho, Aave, Spark, Liquity; which chains.
4. **α for R_pt:** measured or 1? (R_lo fixes α = 1.)
5. **Publication:** public, curator-only or delayed.
6. **Paid data:** CoinGecko Pro, DefiLlama Pro, archive RPC, beacon/relay data.
7. **Membrane's own markets** in v1?
8. **L2 trust rows** in v1?

## Appendix: Rejected critique items

1. **"A single push feed is red at C = 0 against 0.65% victims."** Rejected downward: lag holds the stored price at its last true value, so it cannot push a healthy position under threshold; the feed moves down only when the source aggregate crosses the band, at source cost. Upside free move, OEV and two-leg drift are kept (§2.4).
2. **Centralized sequencer as R3 (s = 1) inside C_lo.** Made an operator-trust row instead: inside C_lo it would score every L2 averaged oracle red by assumption; it belongs with admin-key compromise.
3. **Mango as a wash-volume VWAP case.** Mechanism kept; Mango used a three-venue median, JELLY is a perp venue; YieldBlox cited.
4. **"D is an ex-post fit to CAPO."** n = 1 is kept; "fit" is not: the formula was derived independently of CAPO's numbers.
