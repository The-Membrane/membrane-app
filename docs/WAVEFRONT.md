# Wavefront — the Oct 10-11 2025 full-coverage census (Real vs Membrane)

Every position liquidated on Aave V3 or Morpho Blue between 2025-10-10T00:00Z and
2025-10-11T23:59Z, with what the protocol actually did on one side and what Membrane's engine
would have done on the other, on the **same positions**, priced from the **protocols' own
oracles read on chain**. It replaces the old census's 2,347 Aave rows (747 of them priced and
included) with **3,163 positions, 3,157 walked**.

| | positions | walked | Real repaid | Real seized | Membrane repaid (= sold) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Aave V3 | 2,418 | 2,413 | $146.43M | $154.61M | $137.95M |
| Morpho Blue | 745 | 744 | $39.58M (+ $0.28M bad debt) | $41.54M | $17.47M |
| **all** | **3,163** | **3,157** | **$186.00M** | **$196.15M** | **$155.42M** |

USD totals are over walked positions and skip the 13 Morpho positions whose loan token has no
USD price, on both sides. Membrane: 2,536 positions sold at least once, 621 never sold (72 of
the sold ones were sold by the conservative grid-end sale), 3,361 sales.

The engine pieces live in `lib/wavefront/` and are what the live wavefront engine (next PR)
reuses unchanged. **The Evidence page still reads the old `evidence.json`**; switching it to
this census is an owner decision.

---

## 1. Data

All inputs are in the private datasets repo, `recall-coverage/inputs/oct10/`:

- `aave_liquidations_enriched.csv` (3,111 events, 2,418 `(chain, user)` accounts) and
  `morpho_liquidations.csv` (886 events, 745 `(chain, market, borrower)` positions) — the
  owner's event pull.
- `onchain/` — the on-chain pull by `scripts/oct10-coverage/pull-onchain.ts` (read its
  `PROVENANCE.md`): the block in force at every minute start on each chain; AaveOracle
  `getAssetsPrices` for every reserve at every minute (mainnet, Arbitrum, Optimism, Base); every
  Morpho oracle's `price()` at every minute (mainnet, Base); every Aave event's full position at
  N-1 with LTs under the user's e-mode, HF recomputed exactly at N-1 (3,111 / 3,111 to the wei)
  and with block-N prices; every Morpho event's position and market at N-1, price at N-1 and N,
  borrowed rounded up with interest accrued to ts(N), liquidatable at N. Every value was
  cross-verified on a second RPC backend group.

Outputs:

| file | where | what |
| --- | --- | --- |
| `census.json` | datasets `oct10-2025/coverage/` (canonical) | `meta` (method, inputs with sha256, coverage, totals, classes, clusters, outcomes, sensitivity, cross-check) + one row per position |
| `replay.jsonl.gz` | datasets `oct10-2025/coverage/` (canonical) | the whole stream, schema v1, 18,484 records |
| `PROVENANCE.md` | datasets `oct10-2025/coverage/` | source commit, input and output sha256 |
| `wavefront-replay.json` | `public/data/oct10-2025/` (served) | the same stream in the compact columnar form (≈1.46 MB) |
| `coverage-summary.json` | `public/data/oct10-2025/` (served) | coverage, totals, classes, clusters, sensitivity, cross-check summary (≈11 KB) |

## 2. Method

### Positions and t0

- **Aave V3**: one position per `(chain, user)`. Composition is read at the t0 event's block
  N-1 (the pull's full re-read): collateral = reserves with aToken > 0, the collateral flag on
  and LT > 0 under the user's e-mode; debt = reserves with variable debt > 0. Every leg is
  valued at **block-N AaveOracle prices** with Aave's own rounding (floor collateral, ceil
  debt), so `line = Σ coll_i·LT_i / Σ coll_i` is Aave's weighted liquidation threshold at N and
  `LTV0 = debt_N / coll_N`. With that rounding `LTV0 > line` is exactly the pull's `HF_N < 1`
  (no float mismatch on any account). **Located** iff HF at N < 1 on the t0 event. t0 is the
  first event; when the first is not located and a later one is, the first located one
  (one account: `aave-v3:optimism:0xcb92…350c`, t0 = its 2nd event). Collateral worth 0 base
  units at N (14 accounts hold such dust) is dropped — Aave counts it as 0.
- **Morpho Blue**: one position per `(chain, market, borrower)`, valued in **loan-token
  units**: collateral at the first event's N-1 × the oracle `price()` / 1e36; borrowed =
  shares → assets **rounded up**, interest accrued to ts(N) (what Morpho's own check reads);
  `line = LLTV`; `LTV(m) = borrowed / (collateral × price(m) / 1e36)`, anchored at price(N).
  Not liquidatable at N → not walked. Interest after t0 is not added (two-day window).

### The price path

Each leg moves with **its own protocol-oracle minute path**: `value(m) = value_N × p(m) / p_N`
for every minute `m` after t0's minute, where `p(m)` is the price in force at the minute START
(the highest block with timestamp ≤ the minute start) — the same anchor-at-the-liquidation,
no-look-ahead rule the old census used at `p_liq`. Aave legs read the AaveOracle column of their
reserve on their chain; a Morpho position reads its market's oracle. The grid ends at minute
2,879 (2025-10-11T23:59Z).

### Delay class and the mixed split

`delayClassOf(<every collateral symbol>, line)` from `lib/position-sim/collateralClass.ts`, on
the FULL composition. A **mixed** position cannot exist on Membrane (Cdp.sol:1650-1651), so it
is walked as the two positions Membrane would hold, exactly like `compare.ts`
`splitByDelayClass`: no-delay legs (sub 0) and delayed legs (sub 1); debt pro rata to
collateral value at t0, so both halves open at the position's own LTV; each half at its **own**
LT-weighted line and its own class `delayClassOf(its symbols, its line)`; the position's
Membrane figures are the sum of the halves. A half can open under its own line — it then simply
walks (it is not "unlocated").

| | delayed | mixed (split) | no-delay |
| --- | ---: | ---: | ---: |
| Aave V3 | 1,904 | 496 | 18 |
| Morpho Blue | 731 | — | 14 |

Worth knowing about the 495 walked mixed positions: **247 have a half worth under 1% of the
collateral, and 246 of those are a dust STABLE leg** next to volatile collateral (e.g. a few
cents of USDC with the collateral flag on). The rule splits them like any other; the dust half
is sold at its line and closes cents. 246 halves open under their own line.

### Membrane's engine

`lib/wavefront/kernel.ts`, one kernel per half, stepped minute by minute. It runs
`DelayTimer` from `curePath.ts` (arm in the band, save on a return under the line, sell when the
band breaks or the 8 h expire, instant sale for the no-delay class) and `cureSale` — the sale
step `cureWalk` itself now calls (extracted, byte-identical `evidence.json`): repay-to-cap with
`membraneRepayValue` and the $2,000 `liqDebtMinimum` floor, seized == repaid (no fee), the
position walks on after a sale (max 20 sales), and a delay still running when the grid ends is
sold there (conservative). Each sale is reported in USD at the sale minute (for Morpho, × the
loan token's USD at that minute). A delayed position already past `line × (1 + band)` at t0 is
sold at once (`Immediate`) and then walks on like after any sale, as `cureWalk` does — the
contract deletes the timer after every sale (LiquidationEngine.sol:1421-1423). See §5.

Parameters: band 4% (`MAX_THRESHOLD_TO_DELAY`), delay 28,800 s (480 one-minute steps), borrow
gap 3 pp, floor $2,000 (in loan units for a priced non-USD Morpho loan; not applied to an
unpriced one), 20 sales.

### The real side

- **Aave**: `debt_to_cover_normalized × the debt reserve's AaveOracle price at block N`, and
  `liquidated_collateral_normalized × the collateral reserve's`. Every one of the 6,222 legs
  priced from the event's own block-N re-read; the minute-path fallback was never needed.
- **Morpho**: `repaid_assets_normalized × loan USD`; seized collateral at the event's own
  oracle `price(N)` in loan units × loan USD; **realised bad debt reported separately**
  ($275,716.58 on mainnet; not in repaid).
- **Loan-token USD (Morpho)**: $1.00 for a dollar stable held at one (`heldAtOne` — USDC,
  USDS, USDT, crvUSD, MAI; 701 positions); else the AaveOracle price of the same token on the
  same chain from the minute path at the event minute (EURC, WETH, cbBTC, LBTC; 31 positions);
  else **unpriced**: ZCHF 3, eUSD 3, sUSDS 3, EURCV 2, DEGEN 1, USDf 1 = **13 positions, 13
  events**. (sUSDS is yield-bearing: Part 1 stopped holding those at $1.00.) Their LTV and
  every Membrane decision are unaffected; only USD is missing.

### Clusters

From the largest collateral leg by USD at t0: **ETH** (WETH, ETH, stETH, wstETH, weETH, rETH,
cbETH, ETHx, osETH, tETH, rsETH, wrsETH, ezETH, superOETHb, wsuperOETHb, bsdETH, ETH+, ETH0),
**BTC** (WBTC, BTC, cbBTC, tBTC, LBTC, eBTC, FBTC), **OP**, **ARB**, **LINK**, **AAVE**,
**Stables** (`isStable`), any other symbol that is the primary leg of ≥ 20 positions across the
census gets its own cluster (this window: **Mog, UNI, AERO, PEPE, CRV**), else **Other**.
Symbols match exactly — mainnet Morpho's "BITCOIN" is a meme token and lands in Other.

| cluster | positions | Real repaid (walked) | Membrane repaid | sold |
| --- | ---: | ---: | ---: | ---: |
| ETH | 1,023 | $75.75M | $60.70M | 805 |
| BTC | 689 | $74.21M | $18.91M | 415 |
| OP | 360 | $0.72M | $0.76M | 337 |
| ARB | 281 | $0.89M | $1.11M | 250 |
| LINK | 261 | $8.56M | $11.78M | 224 |
| AAVE | 183 | $12.67M | $50.84M | 161 |
| Other | 102 | $2.47M | $1.74M | 90 |
| Stables | 75 | $0.45M | $0.19M | 75 |
| Mog | 57 | $5.49M | $4.85M | 53 |
| UNI | 41 | $3.17M | $3.14M | 40 |
| AERO | 36 | $0.04M | $0.03M | 34 |
| PEPE | 35 | $0.78M | $0.71M | 33 |
| CRV | 20 | $0.82M | $0.66M | 19 |

## 3. The stream (schema v1)

Defined, encoded, decoded and reduced in `lib/wavefront/stream.ts` (read its header for the
field-level spec). Records, ordered by `seq` (1, 2, 3, …):

| kind | fields |
| --- | --- |
| `open` | pid, protocol, chain, block, ts (first event); legs `[{symbol, usd}]`, debtLegs; debtUsd, collUsd, line, ltv0 (at t0); delayClass; cluster; walked; reason (when not walked); t0 `{block, ts, minute}` (walked only); subs `[{sub, delayClass, line, share, collUsd, debtUsd}]` (a split) |
| `real` | pid, ts, block, tx, logIndex, repaidUsd, seizedUsd (USD at block-N oracle prices; null = unpriced); badDebtUsd (every Morpho record, absent on Aave) |
| `mem` | pid, sub?, ts, minute, event `arm`/`save`/`sell`/`sell-instant`, why `band`/`expiry`/`grid-end`/`no-series`/`instant`, repaidUsd, soldUsd (USD at that minute), ltv |
| `tick` | ts, minute, coverage `{walked, total}`, totals `{real:{positions, repaidUsd, soldUsd, badDebtUsd, unpricedEvents}, mem:{positionsSold, positionsArmed, positionsKept, repaidUsd, soldUsd, unpricedSales}}` |

pid = `aave-v3:<chain>:<user>` or `morpho-blue:<chain>:<marketId>:<borrower>`.

- **Order**: by ts; at equal ts tick, open, real, mem; then by position and emission order.
  A tick at minute m has `ts = start + 60·(m+1)` and summarises every record before it; ticks
  fall every 10 minutes (m = 9, 19, …, 2,879). A mem record's ts is t0's own second at the t0
  minute and the minute start after it.
- **Partition**: every opened walked position is exactly one of *sold* (≥ 1 sale), *armed*
  (never sold, a timer running now) or *kept*; `sold + armed + kept == coverage.walked` at every
  tick. The final tick has `armed == 0` (the grid-end sale).
- **Reducer**: `applyRecord(state, record)` folds a record in place and throws on anything the
  schema forbids (a second open, a record before its open, a mem record for an unwalked
  position, a non-increasing seq, ts going back, a tick that is not the fold). The UI and the
  tests both use it.
- **Files**: JSONL (`encodeJsonl`/`decodeJsonl`: a header line, then one record per line;
  USD rounded to cents and ratios to 1e-6 when a record is made, so every reader sums the same
  numbers) and the compact served form (`encodeCompact`/`decodeCompact`: column arrays,
  dictionary-coded strings, one `order` character per record; pid and mem ts are rebuilt).
  `decodeCompact(encodeCompact(r))` is `r` exactly.

## 4. Coverage

| protocol | chain | positions | walked | not walked | Real repaid | Real seized | Morpho bad debt | Membrane repaid | sold | kept | of which grid-end |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| aave-v3 | arbitrum | 776 | 776 | 0 | $17.97M | $19.04M | — | $8.77M | 649 | 127 | 2 |
| aave-v3 | base | 426 | 426 | 0 | $5.76M | $6.11M | — | $1.98M | 323 | 103 | 22 |
| aave-v3 | mainnet | 623 | 621 | 2 | $120.94M | $127.57M | — | $125.55M | 525 | 96 | 19 |
| aave-v3 | optimism | 593 | 590 | 3 | $1.76M | $1.88M | — | $1.65M | 536 | 54 | 15 |
| morpho-blue | base | 553 | 552 | 1 | $19.20M | $20.06M | $0.00M | $8.21M | 339 | 213 | 11 |
| morpho-blue | mainnet | 192 | 192 | 0 | $20.38M | $21.48M | $0.28M | $9.26M | 164 | 28 | 3 |
| **all** | | **3,163** | **3,157** | **6** | **$186.00M** | **$196.15M** | **$0.28M** | **$155.42M** | **2,536** | **621** | **72** |

"sold" and "kept" partition walked; "of which grid-end" counts positions with a delay still
running when the grid ended (sold there).

**Not walked — 6 of 3,163**, each because the protocol's own check, recomputed at block N, says
the position was not liquidatable there:

| position | reason | LTV0 / line at N | real repaid |
| --- | --- | --- | ---: |
| `aave-v3:mainnet:0x1326…1b92a` | HF at block N ≥ 1 on its only event | 0.4047 / 0.41 | $2,395.35 |
| `aave-v3:mainnet:0x5ade…3f5ea` | HF at block N ≥ 1 on its only event | 0.6861 / 0.71 | $6,630.86 |
| `aave-v3:optimism:0xd2f2…68898` | HF at block N ≥ 1 on its only event | 0.6224 / 0.63 | $331.13 |
| `aave-v3:optimism:0x1b2c…fe1df` | HF at block N ≥ 1 on its only event | 0.6648 / 0.6661 | $243.05 |
| `aave-v3:optimism:0xf70c…6d14` | HF at block N ≥ 1 on its only event (a mixed account) | 0.6228 / 0.6300 | $84.35 |
| `morpho-blue:base:0x5b34…79d7:0xceb9…e599` | LTV_N ≤ LLTV on its only event | 0.859998 / 0.86 | $175.63 |

The pull reads state at N-1 and prices at the end of block N, so anything that happened inside
block N before the liquidation (a price update, a borrow, interest, a prior same-block
liquidation) is invisible to it; these six are where that matters. They are kept in the stream
(`open` with `walked: false` and the reason; their real records are there) and in
`census.json`, and are outside both sides' walked totals.

The old census's **"3,095"** was its 2,350 Aave cohort rows + 745 Morpho positions. Its 68
missing Aave accounts had no event whose debt symbol had a series; on this branch it has 2,347
rows (71 dropped) since Part 1 stopped pinning sUSD at $1. This census has all 2,418 + 745.

## 5. Results and sensitivity

Outcomes (a split position takes its dominant half's): sold at the band 1,618; sold at t0
past the band 651; cured then held 705; sold at the grid end 72; no-delay sold 59; sold at
expiry 22; held (opened under its line, never breached) 30.

**Walking on after a sale at t0 past the band** (`meta.sensitivity.noWalkOnAfterT0BandSale`).
A delayed position already past `line × 1.04` at t0 is sold at once and then walks on, like
after every other sale: the contract deletes the timer after any sale and the position stays
live (LiquidationEngine.sol:1421-1423), so a later breach can open a fresh window and a later
band break sells again. Until 2026-10-14 `cureWalk` (and so the kernel) stopped after that one
t0 repay. Stopping is published as the sensitivity: **$149.62M**, i.e. the walk-on adds
**+$5.80M** of Membrane sales (121 more sales) on 72 of the 677 positions with a half sold at
t0 past the band — the largest, `aave-v3:mainnet:0x372cae…`, $25.74M → $29.86M. No outcome
changes (the outcome names the first sale). The same change moves `evidence.json` by +$13,303
(one account, mainnet `0x9bafc9…`; see `docs/POSITION_SIMULATOR.md`).

## 6. Cross-check against the old census

Over the rows both include — the old census's 747 **priced, not-excluded** rows, all walked
here — `scripts/oct10-coverage/crossCheck.ts` toggles each difference back to the old choice
**one at a time** on the new census and reports `new − toggled`. Membrane figures are compared
on the t0 basis (`closedT0`, what the old `membraneClosedUsd` is).

**Real side** — old $34,685,176.13 → new $34,698,936.96 (+$13,760.83), decomposed exactly:

| cause | USD |
| --- | ---: |
| debt priced from AaveOracle at N instead of the Chainlink round / flat $1 | −$2,384.67 |
| 4 events the old census dropped (debt symbol with no series) | +$15,987.68 |
| the old census capped an account's repaid at its debt | +$157.81 |

704 of 747 rows agree within 1%.

**Membrane side** — old $22,204,493.19 → new $13,133,229.25 (**−$9,071,263.94**):

| factor (effect = new − toggled) | USD |
| --- | ---: |
| (i) price source, mainnet rows: AaveOracle (Chainlink SVR `DualAggregator` feeds) vs the public ETH/BTC rounds and their minute grid | −$2,934,073.65 |
| (ii) composition: full basket (split when mixed) vs the single liquidated leg | +$861,020.61 |
| (iii) per-chain oracles on Arbitrum / Optimism / Base vs the mainnet round on a timestamp rule | **−$8,098,746.33** |
| (iv) line from exact N prices vs the inverted HF at N-1 | −$988.70 |
| sum of the four | −$10,172,788.07 |
| interaction and residual | +$1,101,524.13 |

**All four toggled together reproduce the old census: $22,202,794.99, −$1,698.20 from it, 746
of 747 rows within 1%.** So the new code with the old choices is the old census, and the
difference is the choices. Per row, new vs old agree within 1% on 418 rows and have the same
outcome on 516.

How each toggle is built:
- (i)/(iii) every leg the old grid can price (ETH and its proxies, BTC and its proxies, wstETH,
  stables flat at $1) takes the old census's t0 basis — its N-1 value rebased by the round in
  force at N over the round in force at N-1 (log-index rule on mainnet, timestamp rule on L2s) —
  and walks `prices-1m.json` relative to the round in force at N; other legs keep AaveOracle.
  Applied to mainnet rows it is (i); to L2 rows, (iii).
- (ii) one collateral leg (the first event's liquidated reserve) carrying the whole collateral,
  one debt leg (its debt reserve) carrying the whole debt, no split, in the old row's class.
- (iv) the old line `hf × debt / coll` of the first event's N-1 snapshot; a split's halves
  scaled by old/new.

**What moved.** (iii) is the big one, and it is a pricing fact, not a model change: the old
census priced L2 accounts through mainnet Chainlink rounds, but an L2 account is liquidated —
and would be judged by Membrane — on its own chain's feed. Example,
`aave-v3:arbitrum:0xc7218ace…f2c8a7` (wstETH against USD₮0/USDC, line 79%, LTV0 79.58%, the
band breaks at 82.16%), liquidated at minute 1,279. Arbitrum's feed had already printed the
crash in the liquidating block (wstETH $4,271, 2.4% under the minute's opening $4,374). The old
census anchored at the mainnet ETH/USD round in force at that timestamp, which had not printed
it yet, and then walked the mainnet grid into its 3.6% dip at minute 1,281: LTV 82.6%, past the
band → sold at the band, $2.67M. On Arbitrum's own feed minute 1,281 is 0.1% under the
liquidation print (LTV 79.7%, inside the band) and the account is back under its line at
minute 1,282 → cured, nothing sold. On mainnet (i), AaveOracle reads Chainlink's SVR feeds, which serve
a transmitted round with a delay: the pull's `chainlink-check.json` finds Aave's mainnet WETH
price equal to the round in force on 96.18% of minutes (WBTC 97.78%, cbBTC 97.78%), every
mismatch an older round, the newest unserved round at most 61 s old; on the L2s the match is
100%. (ii) the full basket — other legs moving the walk, and mixed accounts split by class — adds
$0.86M net. (iv) is negligible: the inverted HF at N-1 is Aave's weighted LT at
N-1 prices, and the N-1 → N weight shift is tiny.

The ten largest per-row differences, with the all-toggled figure, are in
`census.json meta.crossCheck.topMembraneDifferences`.

## 7. Tests

- `tests/unit/wavefrontKernel.test.ts` — **kernel ≡ cureWalk** on every `evidence.json` row
  with a usable series (1,142): the series rebuilt exactly as `build-evidence.ts` builds it,
  both engines on identical inputs, same closed dollars (≤ 1e-6), first-sale index, outcome,
  sales, breaches and first-cure minute, under six settings (headline, where both walk on after
  a t0 sale past the band; all delayed; timer never cleared early; a $250k per-sale cap; the
  line 2% lower; the old stop after a t0 sale, the sensitivity). 709 rows compared under the
  census line (the other 433 are ones `cureWalk` calls unlocated — the kernel walks them by
  design); 1,118 under the lowered line.
- `tests/unit/wavefrontStream.test.ts` — JSONL and compact round trips; the reducer over the
  whole served replay (open exactly once and first, ticks equal to the fold, the
  sold/armed/kept partition, totals == Σ positions, the served summary == the fold); the
  reducer refuses each forbidden record.
- `tests/unit/wavefrontCensus.test.ts` — the census on a committed 20-position fixture
  (`tests/unit/fixtures/wavefront-census-fixture.json`, from
  `scripts/oct10-coverage/make-census-fixture.ts`): it reproduces the full census's figures
  for each position; both sides on the same positions; walked ⇒ located at t0; mixed halves sum
  to the whole; the stream folds to the rows' sums; single-leg walks equal `cureWalk`.
- `scripts/tests/wavefront-census.test.ts` (needs the datasets repo) — the same invariants on
  all 3,163 positions, a fresh build equal to the written `census.json`, the canonical and
  served replays equal, and **1,736 single-leg walked positions equal `cureWalk`** on their
  composite series.

## 8. Rebuild

```sh
MEMBRANE_DATASETS_DIR=/path/to/membrane-datasets npx tsx scripts/oct10-coverage/build-census.ts
MEMBRANE_DATASETS_DIR=/path/to/membrane-datasets npx tsx scripts/tests/wavefront-census.test.ts
npx vitest run tests/unit/wavefront*.test.ts
```

`build-census.ts --no-write` prints without writing. The build is deterministic (no
timestamps in the data files); `PROVENANCE.md` records the code commit. Rebuild the fixture
with `scripts/oct10-coverage/make-census-fixture.ts` after a census change that moves any of
its 20 positions.

## 9. Known limits

- The line is held at its t0 value while a multi-leg basket's weights drift (as `cureWalk`
  holds it); sales take every leg pro rata.
- Morpho interest after t0 is not accrued.
- Yield-bearing stables are not held at $1 (Part 1), and this pull has no USD path for sUSDS,
  so the 3 Morpho positions with an sUSDS loan are walked but USD-unpriced.
- No venue recall and no liquidation fee on the Membrane side (as the old census).
- The minute grid is the price in force at each minute start; a sale is decided on it, not on
  the block where a keeper would land.
