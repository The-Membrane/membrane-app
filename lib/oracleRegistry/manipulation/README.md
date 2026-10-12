# Oracle-manipulation ratio engine

Data + engine for the oracle-registry's manipulation-cost card. For every **leaf** (the
object an attacker actually moves — a Pendle market's implied-rate TWAP, a Uniswap v3
pool's tick, a Curve pool's balances, an ERC-4626 share rate, a push/pull feed) it
computes the attacker's **cost** `C(X)` to move it, the **extractable value** `EV(X)`
across every mainnet lending market that reads it, the ratio curves `R_lo = C_lo/EV_hi`
and `R_pt = C_pt/EV_pt` over the move size `X`, and a RED/YELLOW/GREEN verdict.

> **Scope:** this is the data + engine only. It is **not** wired into the oracle page.
> `lib/oracleRegistry/config/*` and `components/OracleRegistry/Config*` (another
> workstream) are untouched. Nothing here imports them.

## Owner rulings (2026-10-05) — the verdict

- **RED** if `R_lo < 1.5`, **or** a hard-red override (read-only reentrancy), **or**
  free-move EV ≥ \$100k.
- **YELLOW** if `R_pt < 10`, **or** `C_lo < $100M` floor, **or** any free-move EV > 0.
- **GREEN** otherwise.
- Every card carries the line: *every measured past oracle attack had
  cost / extracted ≤ 0.76.* `R_lo` **is** cost/extracted at the attacker-optimal point,
  so `R_lo < 1.5` means the cheapest move sits within 2× of that danger line.
- **Publication: PUBLIC.** A mainnet-only v1 states on every card that the data is not
  exhaustive and will be extended.

`R_lo` uses the cheapest cost (passive hold, top-k-LP-removed liquidity) over the
largest EV (`EV_hi`, on-demand liquidity + the aggregate-edge downside bound). `R_pt`
uses the realistic passive full-liquidity cost over position-level EV. Both minimise over
move size, direction and hold, because the attacker picks the cheapest ratio.

## Layout

```
chain/        keccak, ABI codec, JSON-RPC (multicall + getLogsWide w/ empty-chunk
              cross-check), Chainlink feed directory + USD price helper
leaf/         decode.ts   oracle address → price tree over leaves
              costCurves.ts  leaf kind → cost curves + free moves (+ hard-red)
cost/         pendle, univ3 (tick-walk), curve (get_dy), vault (ERC-4626 donation),
              impact (regimes: atomic/passive/competitive), freeMoves
ev/           math (borrow-and-walk upside, liquidation-capture downside, shared
              liquidity), morpho, aaveFamily (aave-v3 + spark), compound (Comet)
tree.ts       evaluate a price tree; how a leaf move reaches a reader (TWAP/EMA share)
ratio.ts      join cost + EV + free moves → R_lo/R_pt curves + verdict
engine.ts     discover() across venues; analyzeLeaf() → a card
analyzeOne.ts single-leaf analysis (used by the fork test)
catalog/      seed catalog + merge of data/oracle-registry/catalog.json if present
```

Build: `tsx scripts/research/build-oracle-manipulation.ts [--block N] [--min USD]
[--leaf 0x..] [--max-leaves N]` → `public/data/oracle-manipulation/{index,meta}.json`
and `leaf/<id>.json` per movable/non-green leaf. The dataset is a few hundred KB (disk is
tight; green inert leaves live in the index only).

## What is validated on-chain

- **Pendle AMM** (float port of `MarketMathCore`, 32-split trades) reproduces the
  PT-reUSD state change across the attack blocks to **0.02 % on notional, 0.002 % on
  spot** (observed `readState` deltas, blocks 25,829,822 → 25,829,867).
- **Uniswap v3 tick-walk** from on-chain `liquidityNet` matches **QuoterV2** exactly at
  every test point, both directions, up to ~200 ticks crossed.
- **Curve** cost comes from the pool's own `get_dy` (grid + batched bisection), so no
  Curve math is re-implemented; EMA half-life is read from `ma_exp_time`/`ma_half_time`.
- **Leaf decode** turns the PT-reUSD Morpho oracle into `min(Pendle[twap900s],
  linear-discount)`; Pyth, RedStone, Chainlink push feeds, Curve-LP (`get_virtual_price`
  → read-only-reentrancy hard-red) and ERC-4626 vaults are all classified.

## The PT-reUSD fixture (methodology regression)

`tests/unit/oracleManipulationFixture.test.ts` reconstructs the Aug-2026 attack: the
Pendle market state is frozen at the attack block
(`fixtures/oracle-manipulation-snapshot.json`); the borrower book is the documented
at-risk tranche (~\$36M liquidated, health 1.005–1.024 at 91.5 % LLTV) plus a healthy
remainder. The engine reads **RED** with `R_lo ≈ 0.002` — cost/extracted far below the
0.76 past-attack line, matching the near-zero-cost reality (the attacker's Pendle YT
round-trip was itself profitable). A network-gated test (`ORACLE_MANIP_LIVE=1`) re-reads
the leaf live.

> Today the live PT-reUSD book has de-risked, so at the current block the leaf reads
> YELLOW, not RED — the engine reflects present state. The RED verdict is the Aug-2026
> fixture.

## Coverage gaps (v1 is NOT exhaustive)

1. **Readers:** Euler v2, Fluid and Liquity v2 are **not yet enumerated**. Hooks for the
   next pass: `EulerRouter.getQuote`/`getConfiguredOracle` per (borrow vault, collateral
   vault); the Fluid resolver; the Liquity v2 branch `PriceFeed`. Morpho, Aave v3, Spark
   and Compound III **are** covered — that is where exotic leaves (Pendle PTs, LRTs,
   long-tail feeds) actually live.
2. **Downside EV for Aave/Spark/Compound** needs per-borrower health, which the free data
   path does not give. `EV_pt` downside is **withheld** there; `EV_hi` uses the
   aggregate-edge bound. Morpho downside **is** position-level (Morpho API).
3. **Membrane's own Cdp positions are not read**, so a leaf used only inside Membrane
   shows external EV = 0. Wire the Positions reads next.
4. **ERC-4626 donation sensitivity** is a read-only heuristic (totalAssets ≈
   asset.balanceOf). A balance-tracking classification is a **CANDIDATE**; confirm against
   source before a public card calls the share rate movable.
5. **Pull feeds** (Pyth/RedStone): the free move uses an assumed staleness window and
   volatility class. Set them per leaf in the catalog; fundamental/NAV feeds are marked
   non-movable.
6. **USD prices** for non-stable pool tokens come from the Aave oracle; a leaf whose
   venues do not price a token skips its cost curve. Stablecoins are pinned at \$1.
7. **Morpho API USD values** are taken as given; a few markets report implausible USD
   sizes (e.g. a PAXG market at \$13.5B). Treat per-market USD as the API's, not re-derived.
8. **Chainlink deviation thresholds** come from the public feed directory; a feed absent
   from it gets no deviation-band free move (its risk is under-counted, not over-counted).
9. **Methodology doc** `docs/research/ORACLE-MANIPULATION-COST.md` (branch
   `feat/oracle-registry`) was **not reachable in the build environment**; the engine
   follows the owner rulings as stated in the task plus the public PT-reUSD post-mortem.
10. **v1 is Ethereum mainnet only.**

## Judgment call for the owner

The literal ruling "any free-move EV > 0 → YELLOW" produces low-magnitude yellows (a feed
whose deviation band can tip a single near-edge position by a few dollars). The cards show
the magnitude, so these are legible, but a **materiality floor on free-move EV** (e.g.
ignore < \$1k) is a candidate refinement — flagged for an owner ruling rather than added
unilaterally.

## RPC note

The engine uses the shared public RPC ring. `getLogsWide` cross-checks every empty chunk
against a second endpoint (the ring can return false-empty chunks). Archive reads use the
endpoints that served them on 2026-10-07 (drpc, tenderly). `RECORDER_RPC_URL` (keyed)
endpoints, if set in `.env.local`, are used first and never logged (shown only as
`env:<host>`).
