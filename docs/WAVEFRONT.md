# Wavefront — the Oct 10-11 2025 full-coverage census (Real vs Membrane)

> **2026-10-18 — the headline changed (owner rulings).** Membrane now walks every position at
> **its own per-asset line** (not the protocol's), every sale is **liquidity-capped**, and only
> **debt repaid** is compared. §0 below is the current headline and method; the tables after it
> are the census at the protocol's own line with unlimited liquidity — the pre-ruling census,
> kept as the sensitivity "Membrane at the protocol's line" and as the cross-check's base.

## 0. The headline: Membrane's own line, liquidity-capped sales

| set (compared: walked, with a Membrane line and liquidity for what it sells) | positions | Real repaid | Membrane repaid† | net | gross less / more† |
| --- | ---: | ---: | ---: | ---: | --- |
| Aave V3 | 1,727 | $133.44M | $164.91M | 23.6% more | 729 / 741 |
| Morpho Blue | 553 | $30.67M | $28.12M | 8.3% less | 262 / 54 |
| **all** | **2,280 of 3,197** | **$164.12M** | **$193.03M** | **17.6% more** | **991 ($33.93M) / 795 ($62.84M)** |

Left out of both sides (`meta.exclusions`): **866** positions with no Membrane line on any
collateral leg (Aave 643, Morpho 223; $23.34M real repaid; OP, ARB, AAVE, Mog, UNI, AERO, …) and
**51** that would have to sell a token nobody liquidated on that chain (all Aave; $0.66M; EURC
and USDbC on Base, sUSD on Optimism, DAI and tBTC on Arbitrum, osETH on mainnet). 735 compared
positions hold some collateral with no Membrane line ($39.04M of collateral at t0); that
collateral is left out of the weighted line (the simulator's rule). The strict-lines run below
excludes those positions as well. No collateral-seized figure is compared any more: Membrane's
liquidation fee is not assumed. Real seized stays in each row as provenance.

**The line** (`lib/wavefront/membraneLine.ts`). The per-wallet simulator's own rule:
`weightedMembraneLine` of the t0 collateral (`MEMBRANE_ASSET_LTV`, modelled: WETH 0.80, wstETH
0.78, WBTC/cbBTC 0.75, …; `DEPLOY_LAUNCH_LTV` for sUSDS/syrupUSDC/scrvUSD), value-weighted at
t0. A mixed position splits like `compare.ts splitByDelayClass`, each half at `membraneHalfLine`
(now shared by both engines, `lib/position-sim/membrane.ts`). The class is
`delayClassOf(symbols, Membrane line)`. t0 is still the protocol's first liquidation, so on a
lower line a position starts further past its line. That is intended.

**The liquidity cap** (`lib/wavefront/liquidity.ts`, `kernel.ts` PENDING ORDERS):
- *Capacity* per (chain, collateral token) is the most tokens that left liquidated borrowers
  in any rolling 10-minute window (census minute buckets m-9..m) of 10-11 Oct. It covers every
  Aave V3 and Morpho Blue liquidation in the census on that chain. "Left the borrower" means
  Aave's liquidatedCollateralAmount plus the protocol fee, and Morpho's seized assets. Raw
  integers, exact. The liquidators-only figure (no fee) is beside it: AAVE on mainnet is
  97,556.85 with the fee and 96,876.22 without. The 96.9k quoted in the ruling is the second.
- *Rate, shared:* every Membrane sale of that token on that chain draws on one trailing window
  of **1.1×** capacity (modelled †: the delay lets liquidity recover). Order: minute, then pid,
  then sub. Capacity is available at any minute.
- *Split:* a sale offers the same fraction of every collateral leg's tokens (pro rata by value,
  as `cureSale`'s scalar walk). Each leg fills against its own window. Repaid = sized repay ×
  value filled / value offered. If every leg fills fully, the kernel takes `cureSale`'s own
  result, so an unlimited run is the old walk bit for bit (tested).
- *Pending:* what did not fill stays pending, in debt units. At each later minute, before
  anything else:
  - the timer is idle (the sale already deleted it, `:1724-1727`), so there is no arm, save or
    band test;
  - the order is re-sized at that minute's price as min(pending, repay-to-cap), so it never
    goes past the cap. If the position is back at or under the cap, the remainder is cancelled;
  - the LTV moves on the collateral still held;
  - a later fill is a `sell` record with `carry: true` and the sale's own event and why. It is
    not a new sale; `maxSales` counts decisions;
  - once the order is done, the timer classifies afresh.
  A remainder still pending at the grid end is never credited (`unfilledAtGridEnd`; $0 in this
  build).
- *No capacity:* a position that holds a token with capacity 0 is first walked alone. If it
  would ever sell, it is excluded ('no-capacity'). Before a first sale the capped and uncapped
  walks are identical, so this solo walk decides it exactly, and the excluded position never
  touches the shared book.
- Only collateral sales are capped. Debt repayment is not.

| run (each on its own compared set) | positions | Real | Membrane† | net | Aave | Morpho |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.5× capacity | 2,280 | $164.12M | $155.66M | 5.2% less | 2.8% less | 15.4% less |
| 1.0× | 2,280 | $164.12M | $191.89M | 16.9% more | 22.8% more | 8.8% less |
| **1.1× (headline)** | **2,280** | **$164.12M** | **$193.03M** | **17.6% more** | **23.6% more** | **8.3% less** |
| 2.0× | 2,280 | $164.12M | $209.79M | 27.8% more | 35.8% more | 6.8% less |
| unlimited (the old assumption) | 2,280 | $164.12M | $220.52M | 34.4% more | 43.8% more | 6.8% less |
| protocol's own line, 1.1× | 3,127 | $187.36M | $123.26M | 34.2% less | 28.2% less | 56.5% less |
| protocol's own line, unlimited | 3,127 | $187.36M | $156.57M | 16.4% less | 5.7% less | 56.1% less |
| strict lines, 1.1× | 1,545 | $135.17M | $149.67M | 10.7% more | 16.3% more | 8.3% less |
| band 2% | 2,277 | $164.08M | $195.83M | 19.4% more | 25.2% more | 6.1% less |
| band 8% | 2,283 | $164.16M | $165.31M | 0.7% more | 2.5% more | 7.0% less |
| nobody clears early | 2,279 | $164.11M | $193.09M | 17.7% more | 23.6% more | 8.3% less |
| no $2,000 floor | 2,280 | $164.12M | $192.38M | 17.2% more | 23.2% more | 8.8% less |
| one sale per position | 2,280 | $164.12M | $177.27M | 8.0% more | 11.9% more | 8.7% less |
| stop after a t0 sale | 2,280 | $164.12M | $182.86M | 11.4% more | 16.0% more | 8.7% less |
| t0 at N-1 prices | 2,280 | $164.12M | $192.79M | 17.5% more | 23.5% more | 8.6% less |

**Why Membrane now closes MORE.** The modelled lines are mostly below the protocols' lines
(wstETH 0.78 against Aave's 0.81; Morpho LLTVs of 0.86). At t0 most positions are therefore
already past `line × 1.04`: 1,590 are sold at t0, repaid to a lower cap (line − 3pp), while the
protocols' liquidators took partial bites. 1,906 compared positions have a lower line ($158.06M
real → $173.25M Membrane). 374 have a HIGHER Membrane line. These are mostly positions that also
hold collateral with no Membrane line, which inherit their known legs' line ($6.06M → $19.78M).
The largest single difference is one of them: a mainnet AAVE + other-collateral account at 0.80
instead of Aave's 0.765, sold at the band for $17.98M against Aave's $3.99M. E-mode is not the
driver (15 positions).

**The whale** (`0x372cae…`, 284,393 AAVE, $34.86M debt, LTV0 0.912 on Aave's 0.76): Aave's
liquidators took 5 bites, $3.69M. AAVE has no Membrane line, so it is not in the headline. At
Aave's line, Membrane repays **$29.86M unlimited** and **$13.10M at 1.1×**: it fills the
window's remainder at t0, and before the window frees AAVE recovers above the borrow cap, so the
rest is cancelled.

**Capacity** (top per chain, peak USD): mainnet WBTC 321.3 ($34.9M), WETH 4,950 ($17.8M), AAVE
97,557 ($13.9M), cbBTC 127.5 ($13.8M); Base cbBTC 197.3 ($21.5M), WETH 426 ($1.6M); Arbitrum
WETH 2,003 ($7.2M), WBTC 55.2 ($5.9M); Optimism OP 1.52M ($0.6M), WETH 104 ($0.4M). 83 tokens
in all (`meta.liquidity.capacity`). 335 compared positions had a sale the cap did not fill at
once.

**The stream stays schema 2.** The change is additive: `mem.carry?` and `mem.unfilledUsd?`
(compact columns `carry`, `unfilledUsd`; a reader without them folds the same totals).
`open.line` / `delayClass` / `subs` are the line Membrane walks. `walked` is now the COMPARED
set: an excluded position is `walked: false` with its reason, so `coverage.walked` reads 2,280
of 3,197.

---

Every position liquidated on an **Aave V3 pool or the Morpho Blue singleton of mainnet,
Arbitrum, Optimism or Base** between 2025-10-10T00:00Z and 2025-10-11T23:59Z (scope: §1), with
what the protocol actually did on one side and what Membrane's engine would have done on the
other, on the **same positions**, priced from the **protocols' own oracles read on chain**. It
replaces the old census's 2,347 Aave rows (747 of them priced and included) with **3,197
positions, all walked**.

| | positions | walked | Real repaid | Real seized (incl. Aave protocol fee) | Membrane repaid |
| --- | ---: | ---: | ---: | ---: | ---: |
| Aave V3 | 2,421 | 2,421 | $148.17M | $157.36M (fee $0.92M) | $139.53M |
| Morpho Blue | 776 | 776 | $39.95M (+ $0.28M bad debt) | $41.93M | $17.53M |
| **all** | **3,197** | **3,197** | **$188.11M** | **$199.29M** | **$157.06M** |

Both sides are summed over the same positions, the walked ones (here all of them), and skip
the 13 Morpho positions whose loan token has no USD price. Membrane: 2,570 positions sold at
least once, 627 never sold (73 of the sold ones were sold by the conservative grid-end sale),
3,402 sales, $157.01M of collateral sold.

**What moved since the previous build** (3,163 positions, 3,157 walked; Real repaid $186.00M,
seized $196.15M, Membrane $155.42M):

| change | positions | Real repaid | Real seized | Membrane |
| --- | ---: | ---: | ---: | ---: |
| scope: 3 Aave Lido + 31 Morpho Arbitrum positions the owner CSVs lacked | +34 | +$2,099,941.14 | +$2,219,907.63 | +$1,575,058.93 |
| t0 located at block N-1 prices: the 6 formerly unwalked positions | +6 walked | +$9,860.37 | +$11,611.44 | +$40,804.89 |
| t0 located at N-1: `aave-v3:optimism:<core>:0xcb92…350c` (t0 its 1st event, was its 2nd) | — | — | — | +$21,100.02 |
| Aave protocol fee now in Real seized, on the 3,157 positions walked before | — | — | +$910,555.73 | — |
| rounding (seized now read from the raw `collateralSeizedTotal`) | — | — | +$0.20 | — |
| **total** | | **+$2,109,801.51** | **+$3,142,075.00** | **+$1,636,963.84** |

The protocol fee on all 3,114 Aave events is **$920,995.99** (the 34 new and 6 newly walked
positions carry $10,440.26 of it).

The engine pieces live in `lib/wavefront/` and are what the live wavefront engine reuses
unchanged; position ids come from `lib/wavefront/pid.ts`, shared with it byte for byte. **The
Evidence page and the landing read this census** (owner decision 2026-10-16), through the
served `public/data/oct10-2025/evidence-census.json` and `evidence-census-headline.json`,
built from `census.json` by `scripts/build-evidence-census.ts` (it re-runs this walk from the
same inputs for the cure diagnostic, the one-repay delay credit and the kernel
sensitivities, and stops if the rerun does not reproduce `census.json`'s rows). The old
`evidence.json` is read by no page; it stays as a test fixture and as the cross-check's
other side (§ the cross-check).

---

## 1. Scope and data

### Scope

In scope: every Aave V3 pool registered in the `PoolAddressesProviderRegistry` of mainnet,
Arbitrum, Optimism and Base, and the Morpho Blue singleton of each of those chains. Every
LiquidationCall / Liquidate those emitters logged in the exact window was scanned in full on two
independent log backends and compared log by log (`recall-coverage/inputs/oct10/onchain/
events-scan.json`, and that directory's `PROVENANCE.md`):

| chain | venue | pool / singleton | events | in the owner CSVs |
| --- | --- | --- | ---: | ---: |
| mainnet | Aave V3 Core | `0x87870bca…` | 902 | 902 |
| mainnet | Aave V3 Lido | `0x4e033931…` | 3 | 0 |
| mainnet | Aave V3 EtherFi | `0x0aa97c28…` | 0 | 0 |
| arbitrum | Aave V3 Core | `0x794a6135…` | 938 | 938 |
| optimism | Aave V3 Core | `0x794a6135…` | 801 | 801 |
| base | Aave V3 Core | `0xa238dd80…` | 470 | 470 |
| mainnet | Morpho Blue | `0xbbbbbbbb…` | 268 | 268 |
| arbitrum | Morpho Blue | `0x6c247b1f…` | 31 | 0 |
| optimism | Morpho Blue | `0xce95afbb…` | 0 | 0 |
| base | Morpho Blue | `0xbbbbbbbb…` | 618 | 618 |
| | | | **4,031** | **3,997** |

That is 3,114 Aave events on 2,421 accounts and 917 Morpho events on 776 positions: the
denominator is **3,197**.

**Out of scope**, and not in any figure here:
- every other chain. Avalanche alone had **531** Aave V3 LiquidationCalls in the window
  (counted for size only); Polygon, Gnosis, BNB, Scroll and the rest were not scanned;
- on the four chains, every emitter that is not an Aave V3 registry pool or the Morpho Blue
  singleton (a topic-only scan lists them): **Aave V2** (mainnet "Aave genesis market", 37),
  **Spark** (mainnet, 49), Granary (Optimism, 87), Extra Finance (Optimism 23, Base 16),
  ZeroLend (Base, 12), **Seamless** (Base, 7), Phiat (mainnet, 3), Avalon (Arbitrum 2, Base 1),
  UwU (mainnet, 1), Polter (Base, 1).

### Position ids

`lib/wavefront/pid.ts` (the live engine's module, copied byte for byte; never edited here):

- `aave-v3:<chain>:<pool>:<user>` — one Aave V3 account **in one pool**. The pool ADDRESS is the
  id (the same address borrowing on Core and on Lido is two positions, liquidated
  independently); the display label (core / lido / etherfi) comes from `aaveMarketLabel`.
- `morpho-blue:<chain>:<marketId>:<borrower>`.

All lower case. The previous builds wrote `aave-v3:<chain>:<user>`; `parseAnyPid` reads both
and `legacyPid` maps a Core id back. Below, `<core>` abbreviates the chain's Core pool.

### Inputs

All in the private datasets repo, `recall-coverage/inputs/oct10/` (the list is
`scripts/oct10-coverage/censusInputs.ts`):

- `aave_liquidations_enriched.csv` (3,111 events, 2,418 accounts) and
  `morpho_liquidations.csv` (886 events, 745 positions) — the owner's event pull.
- `onchain/aave_liquidations_extra.csv` (3 events: the Lido pool) and
  `onchain/morpho_liquidations_extra.csv` (31 events: Morpho Arbitrum) — the in-scope events
  the CSVs lack, decoded from the logs.
- `onchain/` — the on-chain pull by `scripts/oct10-coverage/pull-onchain.ts` and its
  `extras.ts` / `fees.ts` (read its `PROVENANCE.md`): the block in force at every minute start
  on each chain; AaveOracle `getAssetsPrices` for every reserve at every minute, one path per
  market with events (mainnet Core, mainnet Lido, Arbitrum, Optimism, Base); every Morpho
  oracle's `price()` at every minute (mainnet, Base, Arbitrum); every Aave event's full position
  at N-1 with LTs under the user's e-mode, HF recomputed exactly at N-1 and with block-N prices
  (`aave-events*.jsonl.gz`); every Morpho event's position and market at N-1, price at N-1 and
  N, borrowed rounded up with interest accrued to ts(N) (`morpho-events*.jsonl.gz`); and the
  liquidation protocol fee of every Aave event (`aave-protocol-fee.jsonl.gz`).

**Verification** (the pull's `PROVENANCE.md`, per output). A result that feeds a file was
re-asked on a different backend group, and required to be byte-equal, when it fell in a
deterministic sample (units whose key hashes under 4%) or was an anomaly (revert, zero or null
value, > 20% one-minute move, HF recompute mismatch, CSV mismatch, Morpho position not
liquidatable). **That is a ~4% sample plus every anomaly, not every value**; the extras were
re-asked in full, and setup reads (addresses, reserve lists, feeds, market params) at 100%. No
backend disagreed on any re-asked value.

| output | units | in the sample | units re-asked (any reason) |
| --- | ---: | ---: | ---: |
| `aave-events` | 5,377 | 4.05% | 83.1% (mostly HF-recompute anomalies) |
| `aave-events-extra` | 9 | — | 100% |
| `aave-oracle-1m` (4 Core paths) | 11,520 | 3.77% | 4.0% |
| `aave-oracle-1m.lido` | 2,880 | 3.68% | 3.7% |
| `aave-protocol-fee` | 4,643 | 3.96% | 8.5% |
| `minute-blocks` | 11,520 | 3.93% | 4.0% |
| `morpho-events` | 1,802 | 4.77% | 6.0% |
| `morpho-events-extra` | 93 | 2.15% | 100% |
| `morpho-oracle-1m` (3 chains) | 8,640 | 3.83% | 4.1% |

Outputs:

| file | where | what |
| --- | --- | --- |
| `census.json` | datasets `oct10-2025/coverage/` (canonical) | `meta` (method, scope, inputs with sha256, coverage, totals, classes, clusters, outcomes, concentration, stats, sensitivity, cross-check) + one row per position |
| `replay.jsonl.gz` | datasets `oct10-2025/coverage/` (canonical) | the whole stream, schema v2, 18,718 records |
| `PROVENANCE.md` | datasets `oct10-2025/coverage/` | source commit, input and output sha256 |
| `wavefront-replay.json` | `public/data/oct10-2025/` (served) | the same stream in the compact columnar form (≈1.48 MB) |
| `coverage-summary.json` | `public/data/oct10-2025/` (served) | scope, coverage, totals, classes, clusters, sensitivity, cross-check summary (≈18 KB) |

## 2. Method

### Positions and t0

- **Aave V3**: one position per `(chain, pool, user)`. Composition is read at the t0 event's
  block N-1 (the pull's full re-read): collateral = reserves with aToken > 0, the collateral flag
  on and LT > 0 under the user's e-mode; debt = reserves with variable debt > 0. Every leg is
  valued at the **t0 prices** with Aave's own rounding (floor collateral, ceil debt), so
  `line = Σ coll_i·LT_i / Σ coll_i` is Aave's weighted liquidation threshold at those prices and
  `LTV0 = debt / coll`. Collateral worth 0 base units (14 accounts hold such dust) is dropped —
  Aave counts it as 0.
- **Morpho Blue**: one position per `(chain, market, borrower)`, valued in **loan-token
  units**: collateral at the t0 event's N-1 × the oracle `price()` / 1e36; borrowed = shares →
  assets **rounded up**, interest accrued to ts(N) (what Morpho's own check reads);
  `line = LLTV`; `LTV(m) = borrowed / (collateral × price(m) / 1e36)`, anchored at the t0
  price. Interest after t0 is not added (two-day window).

**Locating t0.** t0 is the first event the protocol's own check finds liquidatable:

1. at **block-N prices** (Aave: the pull's exact HF recompute, composition at N-1, < 1; Morpho:
   `borrowed > floor(floor(coll × price_N / 1e36) × LLTV / 1e18)`);
2. if not at N, at **block N-1 prices** (Aave: N-1 prices and composition, HF at N-1 < 1;
   Morpho: price at N-1, debt still accrued to N).

The pull reads prices at the END of block N; an oracle update later in block N than the
liquidation can hide the breach the liquidator saw. The basis used is recorded as
`priceBasis: 'N' | 'N-1'` on the `open` record and the census row. **3,190 positions locate at
N, 7 at N-1, none at neither**:

| position | events | LTV0 / line at N-1 | outcome | Real repaid | Membrane |
| --- | ---: | --- | --- | ---: | ---: |
| `aave-v3:mainnet:<core>:0x1326…1b92a` | 1 | 0.4202 / 0.41 | sold at the band | $2,395.35 | $4,846.18 |
| `aave-v3:mainnet:<core>:0x5ade…3f5ea` | 1 | 0.7739 / 0.71 | sold at t0 past the band | $6,630.86 | $34,932.37 |
| `aave-v3:optimism:<core>:0xcb92…350c` | 3 | 0.6353 / 0.63 | sold at the band | $43,035.80 | $46,018.08 |
| `aave-v3:optimism:<core>:0xd2f2…68898` | 1 | 0.6305 / 0.63 | sold at the band | $331.13 | $331.13 |
| `aave-v3:optimism:<core>:0x1b2c…fe1df` | 1 | 0.6668 / 0.6661 | sold at the band | $243.05 | $435.23 |
| `aave-v3:optimism:<core>:0xf70c…6d14` (mixed) | 1 | 0.6421 / 0.63 | sold at the band | $84.35 | $84.35 |
| `morpho-blue:base:0x5b34…79d7:0xceb9…e599` | 1 | 0.86000007 / 0.86 | sold at the grid end | $175.63 | $175.63 |

Six of them were the previous build's "not walked" positions; `0xcb92…` used to start at its
2nd event (located at N) and now starts at its 1st (located at N-1). How much the choice of
basis matters is published as a sensitivity (§5).

### The price path

Each leg moves with **its own protocol-oracle minute path**: `value(m) = value_t0 × p(m) / p_t0`
for every minute `m` after t0's minute, where `p(m)` is the price in force at the minute START
(the highest block with timestamp ≤ the minute start) — the anchor-at-the-liquidation,
no-look-ahead rule the old census used at `p_liq`. Aave legs read the AaveOracle column of their
reserve in their market; a Morpho position reads its market's oracle. The grid ends at minute
2,879 (2025-10-11T23:59Z).

**No silent carry-forward.** A held leg with a missing or zero price at a minute it is walked
through is a hard error in the census (`census.ts` `priceAt`) and in the kernel (`kernel.ts`
`missingPrice: 'throw'`, the default; the message says a missing price is never carried forward
silently). The live engine inherits that default; carrying the last price forward has to be
asked for by name. This pull has no such minute.

### Delay class and the mixed split

`delayClassOf(<every collateral symbol>, line)` from `lib/position-sim/collateralClass.ts`, on
the FULL composition. A **mixed** position cannot exist on Membrane (Cdp.sol:1650-1651), so it
is walked as the two positions Membrane would hold, exactly like `compare.ts`
`splitByDelayClass`: no-delay legs (sub 0) and delayed legs (sub 1); debt pro rata to
collateral value at t0, so both halves open at the position's own LTV; each half at its **own**
LT-weighted line and its own class `delayClassOf(its symbols, its line)`; the position's
Membrane figures are the sum of the halves. A half can open under its own line — it then simply
walks.

| | delayed | mixed (split) | no-delay |
| --- | ---: | ---: | ---: |
| Aave V3 | 1,907 | 496 | 18 |
| Morpho Blue | 762 | — | 14 |

Worth knowing about the 496 mixed positions: **248 have a half worth under 1% of the
collateral, and 247 of those are a dust STABLE leg** next to volatile collateral (e.g. a few
cents of USDC with the collateral flag on). The rule splits them like any other; the dust half
is sold at its line and closes cents. 247 halves open under their own line.

### Membrane's engine

`lib/wavefront/kernel.ts`, one kernel per half, stepped minute by minute. It runs
`DelayTimer` from `curePath.ts` (arm in the band, save on a return under the line, sell when the
band breaks or the 8 h expire, instant sale for the no-delay class) and `cureSale` — the sale
step `cureWalk` itself calls: repay-to-cap with `membraneRepayValue` and the $2,000
`liqDebtMinimum` floor, seized == repaid (no fee), the position walks on after a sale (max 20
sales), and a delay still running when the grid ends is sold there (conservative). Each sale is
reported in USD at the sale minute (for Morpho, × the loan token's USD at that minute). A
delayed position already past `line × (1 + band)` at t0 is sold at once (`Immediate`,
LiquidationEngine.sol:1694-1703, `:1698`, at membrane-solidity `16e12329`) and then walks on
like after any sale, as `cureWalk` does — a sale leaves no timer (a band break or an expiry
deletes it, `:1724-1727` at `16e12329`; an Immediate sale never had one) and nothing closes the
position. See §5.

Parameters: band 4% (`MAX_THRESHOLD_TO_DELAY`), delay 28,800 s (480 one-minute steps), borrow
gap 3 pp, floor $2,000 (in loan units for a priced non-USD Morpho loan; **not applied** to a
USD-unpriced one, below), 20 sales.

### The real side

- **Aave**: repaid = `debt_to_cover_normalized` × the debt reserve's AaveOracle price at
  block N. **Seized = everything taken from the borrower**: the event's
  `liquidatedCollateralAmount` **plus the liquidation protocol fee** that goes to the treasury
  (`aave-protocol-fee.jsonl.gz` `collateralSeizedTotalRaw`; `protocolFeeRaw` is the treasury
  aToken Transfer in the event's own receipt, which the pull's recomputed fee matches on all
  3,114 events, 234 of them after Aave's scaled-balance rounding) × the collateral reserve's
  price at N. The fee is also reported on its own (`real.protocolFeeUsd`). Every one of the
  6,228 legs is priced from the event's own block-N re-read; the minute-path fallback was never
  needed.
- **Morpho**: repaid = `repaid_assets_normalized` × loan USD; seized collateral at the event's
  own oracle `price(N)` in loan units × loan USD. **Realised bad debt is reported separately**,
  not in repaid: **$275,716.58** priced, of which mainnet USDS loans $273,885.07 (45 events),
  one mainnet cbBTC loan $1,214.11 (0.0109 cbBTC), Base USDC loans $617.43 (5 events); plus one
  mainnet USDf loan's 9.54 USDf, unpriced. None on Arbitrum.
- **Loan-token USD (Morpho)**: $1.00 for a dollar stable held at one (`heldAtOne` — USDC,
  USDS, USDT, USD₮0, crvUSD, MAI; 732 positions); else the AaveOracle price of the same token
  on the same chain's Core market, from the minute path **at the minute START of the event's
  minute, not at block N** (EURC 20, WETH 7, cbBTC 3, LBTC 1 = 31 positions); else
  **unpriced**: ZCHF 3, eUSD 3, sUSDS 3, EURCV 2, DEGEN 1, USDf 1 = **13 positions, 13
  events**. (sUSDS is yield-bearing: Part 1 stopped holding those at $1.00.) For an unpriced
  loan the LTV path and every arm / save / sell decision are unaffected, but **the repay size
  is not**: the $2,000 floor is a USD figure and cannot be applied, so those positions' repays
  are sized without it (11 sales on them). Their USD is missing on both sides.

### Clusters

From the largest collateral leg by USD at t0: **ETH** (WETH, ETH, stETH, wstETH, weETH, rETH,
cbETH, ETHx, osETH, tETH, rsETH, wrsETH, ezETH, superOETHb, wsuperOETHb, bsdETH, ETH+, ETH0),
**BTC** (WBTC, BTC, cbBTC, tBTC, LBTC, eBTC, FBTC), **OP**, **ARB**, **LINK**, **AAVE**,
**Stables** (`isStable`), any other symbol that is the primary leg of ≥ 20 positions across the
census gets its own cluster (this window: **Mog, UNI, AERO, PEPE, CRV**), else **Other**.
Symbols match exactly — mainnet Morpho's "BITCOIN" is a meme token and lands in Other.

| cluster | positions | Real repaid (walked) | Membrane repaid | sold |
| --- | ---: | ---: | ---: | ---: |
| ETH | 1,056 | $77.85M | $62.27M | 832 |
| BTC | 690 | $74.21M | $18.91M | 416 |
| OP | 360 | $0.72M | $0.78M | 340 |
| ARB | 281 | $0.89M | $1.11M | 250 |
| LINK | 261 | $8.57M | $11.81M | 225 |
| AAVE | 183 | $12.67M | $50.84M | 161 |
| Other | 102 | $2.47M | $1.74M | 91 |
| Stables | 75 | $0.45M | $0.19M | 75 |
| Mog | 57 | $5.49M | $4.85M | 53 |
| UNI | 41 | $3.17M | $3.14M | 40 |
| AERO | 36 | $0.04M | $0.03M | 34 |
| PEPE | 35 | $0.78M | $0.71M | 33 |
| CRV | 20 | $0.82M | $0.66M | 20 |

## 3. The stream (schema v2)

Defined, encoded, decoded and reduced in `lib/wavefront/stream.ts` (read its header for the
field-level spec). Records, ordered by `seq` (1, 2, 3, …):

| kind | fields |
| --- | --- |
| `open` | pid, protocol, chain, block, ts (first event); legs `[{symbol, usd}]`, debtLegs; debtUsd, collUsd, line, ltv0 (at t0); delayClass; cluster; walked; reason (when not walked); t0 `{block, ts, minute}` and `priceBasis` (walked only); subs `[{sub, delayClass, line, share, collUsd, debtUsd}]` (a split) |
| `real` | pid, ts, block, tx, logIndex, repaidUsd, seizedUsd (USD at block-N oracle prices; null = unpriced); badDebtUsd (every Morpho record, absent on Aave) |
| `mem` | pid, sub?, ts, minute, event `arm`/`save`/`sell`/`sell-instant`, why `band`/`expiry`/`grid-end`/`no-series`/`instant`, repaidUsd, soldUsd (USD at that minute), ltv |
| `tick` | ts, minute, coverage `{walked, total}`, totals `{real:{positions, repaidUsd, soldUsd, badDebtUsd, unpricedEvents}, mem:{positionsSold, positionsArmed, positionsKept, repaidUsd, soldUsd, unpricedSales}}` |

v2 changes v1 in three ways: Aave pids carry the pool (§1; v1 ids still decode through
`parseAnyPid`), `open` carries `priceBasis`, and the `real` totals fold **walked positions
only**. A v1 reader refuses a v2 file (the header says which).

- **Same positions on both sides**: the reducer folds a `real` record into `totals.real` only
  when its position is walked; a position that is not walked counts in `coverage` and nowhere
  else. So every tick compares Real and Membrane on the same set (this build walks all 3,197, so
  here the rule is a guarantee rather than a difference).
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
  dictionary-coded strings, one `order` character per record; pid and mem ts are rebuilt). The
  compact `open` columns gained `market` (the Aave pool or the Morpho market id, dictionary
  coded; −1 only for a legacy 3-part Aave id) and `priceBasis` (0 = N, 1 = N-1, −1 absent).
  `decodeCompact(encodeCompact(r))` is `r` exactly.

## 4. Coverage

Walked n / 3,197, by protocol × market × chain:

| venue | chain | positions | walked | Real repaid | Real seized | of which protocol fee | Morpho bad debt | Membrane repaid | sold | kept | of which grid-end |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| aave-v3 core | arbitrum | 776 | 776 | $17.97M | $19.16M | $118,653.70 | — | $8.77M | 649 | 127 | 2 |
| aave-v3 core | base | 426 | 426 | $5.76M | $6.15M | $39,121.04 | — | $1.98M | 323 | 103 | 22 |
| aave-v3 core | mainnet | 623 | 623 | $120.95M | $128.32M | $738,726.68 | — | $125.59M | 527 | 96 | 19 |
| aave-v3 core | optimism | 593 | 593 | $1.76M | $1.90M | $14,133.96 | — | $1.67M | 539 | 54 | 15 |
| aave-v3 lido | mainnet | 3 | 3 | $1.73M | $1.83M | $10,360.61 | — | $1.52M | 2 | 1 | 0 |
| morpho-blue | arbitrum | 31 | 31 | $0.37M | $0.39M | — | $0.00 | $0.06M | 26 | 5 | 0 |
| morpho-blue | base | 553 | 553 | $19.20M | $20.06M | — | $617.42 | $8.21M | 340 | 213 | 12 |
| morpho-blue | mainnet | 192 | 192 | $20.38M | $21.48M | — | $275,099.16 | $9.26M | 164 | 28 | 3 |
| **all** | | **3,197** | **3,197** | **$188.11M** | **$199.29M** | **$920,995.99** | **$275,716.58** | **$157.06M** | **2,570** | **627** | **73** |

"sold" and "kept" partition walked; "of which grid-end" counts positions with a delay still
running when the grid ended (sold there). No position is unwalked: every one is located by the
protocol's own check at N or at N-1 (§2).

The old census's **"3,095"** was its 2,350 Aave cohort rows + 745 Morpho positions. Its 68
missing Aave accounts had no event whose debt symbol had a series; on this branch it has 2,347
rows (71 dropped) since Part 1 stopped pinning sUSD at $1. This census has the owner CSVs'
2,418 + 745 plus the 3 Lido accounts and 31 Morpho Arbitrum positions found on chain.

## 5. Results and sensitivity

Outcomes (a split position takes its dominant half's): sold at the band 1,650; cured then held
711; sold at t0 past the band 652; sold at the grid end 73; no-delay sold 59; held (opened under
its line, never breached) 30; sold at expiry 22.

**Walking on after a sale at t0 past the band** (`meta.sensitivity.noWalkOnAfterT0BandSale`).
A delayed position already past `line × 1.04` at t0 is sold at once and then walks on, like
after every other sale: a sale leaves no timer (a band break or an expiry deletes it,
LiquidationEngine.sol:1724-1727 at membrane-solidity `16e12329`; an Immediate sale,
`:1694-1703`, never had one) and nothing closes the position, so a later breach can open a
fresh window and a later band break sells again. Until 2026-10-14 `cureWalk` (and so the
kernel) stopped after that one t0 repay. Stopping is published as the sensitivity:
**$151.26M**, i.e. the walk-on adds **+$5,800,461.00** of Membrane sales (121 more sales) on 72
of the 678 positions with a half sold at t0 past the band — the largest,
`aave-v3:mainnet:<core>:0x372cae…`, $25.74M → $29.86M. No outcome changes (the outcome names
the first sale).

The same change moved `evidence.json`, which is therefore NOT unchanged on this branch: its
Membrane headline **+$13,303.43** (priced $22,191,189.76 → $22,204,493.19; all included
$54,158,792.83 → $54,172,096.26; one account, mainnet `0x9bafc9…`), every figure built on it by
the same amount, and the sensitivities whose walks differ — `liquidityBound` **+$1,084,241.29**
(priced $20.81M → $21.89M: a capped t0 sale used to end the walk with the remainder unsold),
`bandSensitivity` at a 2% band **+$145,130.49** and at an 8% band **+$10,621.90**. See
`docs/POSITION_SIMULATOR.md` §3 and `public/data/oct10-2025/README.md`.

**The t0 price basis** (`meta.sensitivity.t0PriceBasis`). 2,450 positions are located by the
protocol's check at BOTH bases, N and N-1. On **13** of them the t0 decision (per half: under
the line / inside the band / past the band / no-delay sale) differs between the two — 7 on
mainnet, 6 on Optimism, mostly "past the band at N, inside it at N-1". Membrane repays
**$106,073.23** on those 13 at the headline basis and **$104,357.43** when they are valued at
N-1. Rebuilding the whole census at N-1 wherever N-1 locates (N otherwise) gives
**$156,980,740.05**, **−$75,440.28** from the headline (most of it sale-size differences on
positions whose t0 decision does not change).

**Concentration.** The largest Membrane figure is one AAVE-collateral account,
`aave-v3:mainnet:<core>:0x372cae…`: LTV0 **0.912** against a 0.76 line (the protocol first
liquidated it already far past Membrane's band), sold at t0 past the band, **$29.86M = 19.0%
of the Membrane total**. The ten largest are **51.7%** of it, all on mainnet Core.

## 6. Cross-check against the old census

Unchanged by this round: every figure below is the same as in the previous build. Over the rows
both include — the old census's 747 **priced, not-excluded** rows, all walked here —
`scripts/oct10-coverage/crossCheck.ts` toggles each difference back to the old choice **one at
a time** on the new census and reports `new − toggled`. Membrane figures are compared on the t0
basis (`closedT0`, what the old `membraneClosedUsd` is). The real side compared is repaid,
which the protocol fee does not touch.

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
`aave-v3:arbitrum:<core>:0xc7218ace…f2c8a7` (wstETH against USD₮0/USDC, line 79%, LTV0 79.58%,
the band breaks at 82.16%), liquidated at minute 1,279. Arbitrum's feed had printed the crash
**before** the liquidating block: wstETH reads $4,271.33 at both N-1 and N, 2.4% under the
minute's opening $4,374. The old census anchored at the mainnet ETH/USD round in force at that
timestamp, which had not printed it yet, and then walked the mainnet grid into its 3.6% dip at
minute 1,281: LTV 82.6%, past the band → sold at the band, $2.67M. On Arbitrum's own feed
minute 1,281 is 0.1% under the liquidation print (LTV 79.7%, inside the band) and the account
is back under its line at minute 1,282 → cured, nothing sold. On mainnet (i), AaveOracle reads
Chainlink's SVR feeds, which serve a transmitted round with a delay: the pull's
`chainlink-check.json` finds Aave's mainnet WETH price equal to the round in force on 96.18% of
minutes (WBTC 97.78%, cbBTC 97.78%), every mismatch an older round, the newest unserved round at
most 61 s old; on the L2s the match is 100%. (ii) the full basket — other legs moving the walk,
and mixed accounts split by class — adds $0.86M net. (iv) is negligible: the inverted HF at N-1
is Aave's weighted LT at N-1 prices, and the N-1 → N weight shift is tiny.

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
  design); 1,118 under the lowered line. A missing price throws by default and is carried
  forward only when asked for.
- `tests/unit/wavefrontStream.test.ts` — JSONL and compact round trips (4-part and legacy
  3-part pids); the reducer over the whole served replay (open exactly once and first, ticks
  equal to the fold, the sold/armed/kept partition, totals == Σ WALKED positions on both sides,
  the served summary == the fold); the reducer refuses each forbidden record and keeps a
  non-walked position's real records out of the totals.
- `tests/unit/wavefrontCensus.test.ts` — the census on a committed 22-position fixture
  (`tests/unit/fixtures/wavefront-census-fixture.json`, from
  `scripts/oct10-coverage/make-census-fixture.ts`; it includes a Lido account, a Morpho
  Arbitrum position and three N-1-located ones): it reproduces the full census's figures for
  each position (price basis and protocol fee included); both sides on the same positions;
  walked ⇒ located at t0; mixed halves sum to the whole; the stream folds to the rows' sums;
  single-leg walks equal `cureWalk`; a held leg with no price at a walked minute throws.
- `tests/unit/wavefrontLiquidity.test.ts` — the capacity model. It covers:
  - the table (rolling max, fee in, liquidator part);
  - the trailing window;
  - the 1.1× multiplier and unlimited;
  - no capacity;
  - two positions sharing one window (pid order, the remainder filling when it frees);
  - the carry at a later price (more tokens);
  - cancellation on recovery and the remainder unfilled at the grid end;
  - the multi-leg split;
  - unlimited ≡ uncapped, record for record;
  - on the fixture, a no-capacity exclusion and the whale at Aave's line (1.1× vs unlimited).

  The census fixture test now checks the two runs whose positions are independent: protocol
  line with no model, and Membrane line unlimited. The shared book cannot be reproduced on a
  subset.
- `scripts/tests/wavefront-census.test.ts` (needs the datasets repo). Since 2026-10-18 it also
  checks:
  - the compared/excluded partition;
  - the protocol-line, no-model run equals the pre-ruling $157,056,180.33;
  - the real side is identical in every run;
  - no window ever fills past its limit;
  - the whale's exact figures.

  And the same invariants on
  all 3,197 positions, a fresh build equal to the written `census.json`, the canonical and
  served replays equal, and **1,770 single-leg walked positions equal `cureWalk`** on their
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
its 22 positions.

## 9. Known limits

- **t0 is the protocol's FIRST liquidation, and it can already be deep.** Membrane is started
  where the protocol first acted, not where the position first crossed its line, so a position
  the protocol let run far past the line opens far past Membrane's band and is sold at once.
  The largest is the AAVE whale `aave-v3:mainnet:<core>:0x372cae…`: LTV0 0.912 on a 0.76 line,
  **$29.86M, 19% of the Membrane total**; the ten largest positions are **52%** of it. Those
  sales are what Membrane does from that state, not what it would have done on the way there.
- **Later Real events can involve new borrowing; Membrane walks the t0 composition only.** The
  Real side sums every event of a position, and a borrower can add debt between two
  liquidations; Membrane never sees debt added after t0. Measured block to block (debt at a
  liquidated block's N-1, at those prices, more than 5% above what the previous block's
  liquidations left): **20 Aave events on 19 positions, $413,477.20 of Real repaid**
  (`meta.stats.newBorrowingAfterLiquidation`; interest counts too, so an upper bound).
  Comparing event to event instead flags 44 events on 42 positions ($4,046,052 repaid), but 24
  of those are pairs in the SAME block, which share one N-1 read, so their "new debt" is an
  artefact of the pull; a reviewer's 55 events / $4.15M is an upper bound of that kind.
- **The t0 price basis.** Prices are read at the end of block N (or N-1, §2); on 13 positions
  the t0 decision depends on which, worth $106,073.23 of Membrane repaid ($104,357.43 at N-1);
  the whole census moves −$75,440.28 at N-1 first (§5).
- The line is held at its t0 value while a multi-leg basket's weights drift (as `cureWalk`
  holds it). Sales offer every leg pro rata. Under the cap a leg can fill less than the others,
  and the weights then follow what is held.
- Liquidity-capped fills are priced at the oracle, not at a market-impact price. Capacity is
  what liquidators absorbed on the day (a floor on what the market could take, ×1.1 modelled).
  The debt side is never capped.
- Membrane's per-asset lines are modelled (no deployment). Collateral with no line is either
  excluded (no leg has a line) or left out of the weighted line (some legs), which can give that
  collateral a higher line than its protocol's (§0).
- Morpho interest after t0 is not accrued.
- Morpho loan USD for a non-$1 loan is the price in force at the minute START of the event's
  minute, not at block N.
- Yield-bearing stables are not held at $1 (Part 1), and this pull has no USD path for sUSDS,
  so the 3 Morpho positions with an sUSDS loan are walked but USD-unpriced; for the 13
  USD-unpriced positions the $2,000 floor is not applied (§2).
- No venue recall and no liquidation fee on the Membrane side (as the old census); the Real
  side's seized includes Aave's protocol fee.
- The minute grid is the price in force at each minute start; a sale is decided on it, not on
  the block where a keeper would land.
- Scope (§1): no chain beyond the four, no Aave V2, Spark or other V3 forks.
