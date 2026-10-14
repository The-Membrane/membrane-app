# Position Simulator

`/[chain]/simulator` — paste an Ethereum address, read the lending position behind it,
put the same collateral/debt vector into Membrane, and run both through the measured
10–11 October 2025 crash.

No wallet connect. That is the entire point: it is a sample, and a sample you have to
sign into is not a sample.

---

## 1. What is real, what is modelled, what is mock

This is the section to read before quoting any number off this page.

| Figure | Status | Where it comes from |
|---|---|---|
| Your collateral/debt balances | **real** | read live from mainnet by the protocol adapters |
| Your protocol's liquidation threshold, max LTV, liquidation bonus | **real** | read live from the protocol's own config |
| Your protocol's health factor | **real** (Aave/Spark) / **derived** (Morpho, Compound — neither exposes one) | `getUserAccountData` / computed |
| The Oct 10 price path | **real, measured** | Chainlink oracle rounds + Binance 1m klines, 1-minute grid |
| Aave/Morpho repay sizes | **real, measured** | 3,111 and 886 decoded `Liquidate` events from the window |
| Membrane's partial-repay formula | **real** | `LiquidationEngine.sol:2204-2238` |
| Membrane's 8-hour cure window | **real** | `liquidation-engine/src/contract.rs:52` — `unwrap_or(28800)` |
| Membrane's 3pp borrow/liquidation LTV gap | **real** | `lib/Constants.sol:30` — `BORROW_LTV_GAP = 3e16` |
| Membrane's 90% max-LTV hard cap | **real** | `lib/Constants.sol:23` — `MAX_LTV_HARD_CAP = 9e17` |
| Membrane's 10% liquidation-fee ceiling | **real** | `lib/Constants.sol:57` — `MAX_LIQ_FEE = 1e17` |
| Recall-before-collateral ordering | **real** | `LiquidationEngine.sol:924-928`, `_step1_5_venueRecall` |
| Membrane's 96% no-delay listing cap | **real** | `lib/Constants.sol:32` — `NO_DELAY_LTV_HARD_CAP = 96e16` |
| No-delay class: no window, sold the minute it is over its line | **real** | `Collateral.sol:424-426`, `LiquidationEngine.sol:1572-1576` — see §3, *Delay class* |
| Recall-only cure pays the keeper's fee from collateral | **real** | `LiquidationEngine.sol:1603-1658` |
| **Which collateral is no-delay** | **MODELLED** | stable ⇒ no-delay listing, mirroring the deploy; the contracts carry no stable label |
| **A mixed position's split into two** | **MODELLED** | debt pro-rata to collateral value at the start |
| **Membrane's per-asset max LTV** | **MODELLED** | see §2 — there is nothing to read, except below |
| sUSDS 88%, syrupUSDC 86%, scrvUSD 86% max LTV | **real (deploy script)** | `script/DeployFullSystem.s.sol:243`, `:247`, `:251` (membrane-solidity `16e12329`) — the bootstrap line until each asset's Disco pool covers it, then its 96% cap; `DEPLOY_LAUNCH_LTV`, `membrane.ts` |
| **Membrane's liquidation fee** | **MODELLED** | defaults to the source protocol's own bonus |
| **Venue recall rate / fast rate** | **MODELLED** | our reading of each venue's exit mechanics; editable |
| The opening demo position | **MOCK** | invented balances, real Aave risk parameters attached |

### The single most important caveat

**Membrane has no Ethereum mainnet deployment.** `config/evm/chains.ts` targets a local
anvil. There is no live contract to read a per-asset max LTV from. The one committed LTV
configuration is the deploy script's: its three launch stables list at a bootstrap max LTV
of 88% (sUSDS) and 86% (syrupUSDC, scrvUSD), `script/DeployFullSystem.s.sol:243-251`, and
the simulator uses those as they are (`DEPLOY_LAUNCH_LTV`, stamped as a source, not
modelled). Every other per-asset line is ours. So the Membrane side of this comparison is
a **model of a protocol that is not deployed**, run against real prices. The simulation
edge is not the live edge.

**No line, no run.** An asset with no line in `MEMBRANE_ASSET_LTV` gets none (GHO, for
one; nothing is invented). A position whose collateral has **no** line at all is not run:
its weighted line would be 0 and every minute would be "over" it. The page shows no
Membrane run and says why on its hero line, the same line it uses for "No open position
found" (`hasMembraneLine`, `Simulator.tsx`). A position with at least one known leg runs
at the weighted line of its known legs, and the unknown ones are named in a caveat.

**The user's line is clamped to the position's class.** The max-LTV slider and a URL
`?ltv=` run from 30% up to the cap of the position on screen: 96% when every collateral
leg is a stable (`NO_DELAY_LTV_HARD_CAP`), else 90% (`positionLtvCap`,
`clampMembraneLtv`). The URL value is clamped at use, once the position is known. Without
the clamp a 95% `?ltv` would have made a WETH position no-delay by the line rule.

### A result that is not flattering, and stays in

With the modelled LTVs in `lib/position-sim/membrane.ts`, Membrane's line on the demo
basket (77.4%) is **tighter** than Aave's real one (80.4%). With no deployment venue to
recall from, Membrane therefore breaches sooner, liquidates more often, and **ends with
less equity than Aave** on the demo position. This is asserted as a test
(`scripts/tests/position-sim.test.ts`, "with no venue, a tighter modelled line makes
Membrane liquidate earlier and MORE often") so that it cannot be quietly tuned away. If
that assertion ever flips, someone loosened the modelled LTVs — check why.

Membrane's advantage appears when there is capital to recall. That is the honest claim.

### Forbidden claims

- Never say or imply borrowers pay no interest — "no interest", "0%", "free", "~0%".
  This phrasing is permanently deleted from the product.
- No win rates, no confidence figures, no "X% of users" claims.
- Borrow interest is **not accrued** in the simulation. Rather than imply it is free, the
  UI states that balances are held at opening size so the two engines are compared on
  the price move alone, and that real debt grows under both.

---

## 2. Data sources and provenance

### `public/data/oct10-2025/`

Built by `pnpm build:oct10-data` (`scripts/build-oct10-dataset.ts`) from a raw pull at
`~/Downloads/oct10_data` that is **not committed**. The script only ever copies measured
values; it never derives or smooths one. The committed output is what ships.

| File | Contents |
|---|---|
| `prices-1m.json` | 2,880 one-minute bars, 2025-10-10 00:00 → 2025-10-11 23:59 UTC. Columnar. ETH/BTC/stETH-ETH Chainlink oracle; ETH/BTC/USDe Binance spot with candle lows; on-chain USDe Curve quote. Plus `carried` flags marking minutes where an oracle held its previous round. |
| `protocols.json` | Aave V3 reserve params and Morpho Blue market params read on-chain at mainnet block **23,543,615**; the measured Aave/Morpho repay distributions; the oracle-lag report; USDe exit-liquidity summary. |
| `manifest.json` | Window, per-series source attribution, and the caveat list rendered in the UI. |

Everything was fetched from public JSON-RPC (Tenderly public gateways) and Binance public
daily dumps. No paid API keys.

### `public/data/oct10-2025/evidence.json` — the census

Built by `scripts/build-evidence.ts`, which runs the SAME walk (`curePath.ts`) and the
SAME delay-class definition (`collateralClass.ts`) as the simulator. Its two raw inputs
are **not in this repo**. Board rule N18 puts every dataset in the private
`triccs/membrane-datasets` repo, and the builder reads them from there:

```
<datasets>/recall-coverage/inputs/oct10/aave_liquidations_enriched.csv
<datasets>/recall-coverage/inputs/oct10/chainlink_rounds.csv
```

`<datasets>` is `$MEMBRANE_DATASETS_DIR`, else `../membrane-datasets` next to this repo
(`scripts/lib/datasetsDir.mjs`). The builder stops with the fix if either file is missing.
The sha256 of each input is in that directory's `PROVENANCE.md`.

```bash
MEMBRANE_DATASETS_DIR=/path/to/membrane-datasets ./node_modules/.bin/tsx scripts/build-evidence.ts
npx tsx scripts/tests/evidence.test.mts    # the lenses render, every total recomputes from its rows
```

Hard-coded copies of census figures must be recomputed after a rebuild:
`lib/position-sim/oct10Totals.ts` (pinned by `tests/unit/oct10Totals.test.ts`) and the
copy in `components/Seniority/facts.ts`.

### Measured extremes (regenerate with `pnpm build:oct10-data`, do not hand-edit)

| Series | Low | At (UTC) |
|---|---|---|
| ETH Chainlink oracle | $3,464.40 | 2025-10-10 21:20 |
| BTC Chainlink oracle | $105,157.16 | 2025-10-10 21:23 |
| ETH Binance spot | $3,488.88 | 2025-10-10 21:20 |
| BTC Binance spot | $103,975.26 | 2025-10-10 21:19 |
| USDe Binance spot | $0.6651 | 2025-10-10 21:43 |
| USDe on-chain (Curve, 1 USDe clip) | $0.99683 | 2025-10-10 22:56 |

### Corrections carried forward

1. **The "$0.9957 on-chain USDe minimum" figure is not supported by the data.** It appears
   only as a pre-existing assumption in a source-script comment, never as a measured
   output. The measured minimum is **$0.99683**. Prior sessions recorded 0.9957; that is
   an artifact, and the dataset manifest records the correction.
2. **The on-chain USDe low is a marginal quote, not exit liquidity.** The same Curve pool
   bottomed at $1.13M USDC of reserves; a 1,000,000 USDe sell realised an average of
   **$0.9759** at the worst minute. "On-chain never broke $0.997" is true of the quote and
   false of exiting at size.
3. **The feed labelled `wstETH/ETH` is actually the stETH/ETH feed** — its on-chain
   `description()` reads `STETH / ETH`, and it is a ~24-hour-heartbeat feed. It is shipped
   under its true identity and is **not** used to price wstETH.
4. **Oracle and spot are different series and the difference matters.** During the crash
   the ETH oracle printed 0.70% *below* the Binance spot trough, while the BTC oracle
   bottomed 4 minutes late and 1.14% *above* it. Liquidations fire off the oracle, so the
   simulator prices collateral off the **oracle** columns. Using spot would fire ETH
   liquidations late and BTC liquidations early.

---

## 3. The engine

### `lib/gauntlet-engine/` — the shared extraction

The liquidation/recall maths used to live in `components/Builder/utils.ts`. It now lives
in `lib/gauntlet-engine/`, imports nothing from React or the browser, and runs unchanged
in Node, an API route, or the client. `components/Builder/{utils,types,fixtures}.ts` are
thin re-export shims, so no Builder import changed.

The extraction was verified by running the pre-extraction original from git history and
the extracted module over **14,475 deep-equality checks** — every exported function,
7 seeds × 15 floors × 7 boards × 3 LTVs × 3 intents — with **zero differences**. That
comparison needed a file from git history so it could not be committed; the values it
produced are frozen as golden tests in `scripts/tests/gauntlet-engine.test.ts`.

### `lib/position-sim/` — the comparison

Both runs walk the **identical** price path. The only thing that differs is what each
engine does when the line is crossed, so the gap between the two ending equities is
attributable to engine design and nothing else.

**Source engine.** Repays a share of the loan and the liquidator seizes that value plus
the on-chain liquidation bonus. The share is the **measured median** from the Oct 10
events (Aave 57.8%; Morpho 100% — Morpho has no close factor and 65.5% of its
liquidations were full), not the documented close factor.

**Membrane engine.** Every call recalls from deployment venues first, toward the whole
debt. If that alone brings the position back under its line, nothing is sold and the call
is paid its fee (the recall-only lane, below). Otherwise a breach inside the band opens the
8-hour window, and a sale takes only the shortfall to the borrow cap out of collateral. A
position with no window (stablecoin collateral) is sold at the line. See *Delay class*
below.

**Equity is `collateral + deployed − debt` in both runs.** This is load-bearing. An
earlier version left deployed capital off the balance sheet, which made every recall look
like free money and overstated Membrane's advantage by roughly 4×. A recall moves a dollar
off the asset side and a dollar off the liability side — it is equity-neutral at the
moment it happens. Membrane's real advantage is the liquidation penalty and the forced
sale it *avoids*. A test asserts the advantage can never exceed the deployed capital.

### Rust vs Solidity: a deliberate divergence

```
Solidity  repay = loan × (L − B) / (L × (1 − B))     LiquidationEngine.sol:2222-2238
Rust      repay = loan × (L − B) /  L                cdp/src/liquidations.rs:474-483
```

The `/(1 − B)` factor accounts for the collateral that leaves with the repay. The Solidity
source records why the faithful port was abandoned: it "under-repays 5× at B=0.8", which
CosmWasm self-heals over repeated keeper calls but Solidity turns into a hard revert.

- `lib/position-sim/membrane.ts` uses the **Solidity** form — the simulator targets EVM.
- `lib/gauntlet-engine/core.ts` `repayNeeded` keeps the **Rust** form — that is the game's
  engine and was deliberately left untouched by this work.

A test pins both, including that they differ.

### Delay class: no-delay collateral

Membrane has two liquidation-delay classes. The simulator runs every position in its own,
and the Oct 10 census does wherever its data can see the collateral (below). **One
definition** decides the class for both:
`lib/position-sim/collateralClass.ts`. Neither engine keeps a stable list of its own.

**The contract rule.** There is no stablecoin label in the contracts. `ee680ded`
introduced an `is_stablecoin` flag; `fc92ed4f` (merged in `6b8789ae`) replaced it with one
immutable listing parameter, the LTV cap `AssetParams.max_ltv_cap`, and the class is
**derived** from it: a cap strictly above 90% is no-delay. A no-delay asset carries no
window, so the engine runs it in instant mode: it is sold the minute its LTV is over its
line, every time, with no band and no timer.

**The modelled assumption, stated.** Because the class follows the cap and not a label,
"stable ⇒ no-delay" is **our assumption about how a stable would be listed**. It mirrors
the deploy script, which lists all three launch stables (sUSDS, syrupUSDC, scrvUSD) at the
96% no-delay cap and WETH at 90% with the 4% window. A line above 90% is not an
assumption: only a no-delay listing can carry one. **For a volatile asset that implies a
listing the deploy does not have** (it lists WETH at 90%, delayed): the census keeps the
contract rule anyway. On Oct 10 that is one WETH/WETH Aave e-mode account on a 94.6% line,
with no dollar effect (`meta.delayClass.lineRule`).

**Marked as modelled where readers see it.** Every reader-facing statement that stablecoin
collateral gets no window carries a †, and the surface prints one footer line,
"† modelled, not a guarantee" (`MODELLED_FOOTNOTE`, `lib/position-sim/guarantee.ts`;
membrane-board `design/DESIGN_RULES.md` §3). The marked statements: the landing bridge (both
variants) and the second "What the number contains" line (`components/Seniority/facts.ts`,
footers in `Hero.tsx`, `Close.tsx`); the simulator's exception line, its "why it held"
line, its caveat and a split half's label (footer in `GuaranteeBlock.tsx`); and the
Evidence page's time blurb, its no-window histogram row and stat, and the no-window caveat
(one footer under the caveats, `Evidence.tsx`). The census confirms only the
**composition** of the 18 priced accounts it can see in full (all stablecoins), not the
rule.

**The stable set** is the union of the two old lists (`HELD_AT_ONE`, the census
`STABLES`), the deploy's launch stables syrupUSDC and scrvUSD, and the synthetic dollars.
Four kinds, all stable for the class:

- **Held at $1.00:** USDC, USDT, DAI, GHO, USDS and the rest.
- **Held flat at the read price, not at $1.00:** the yield-bearing receipts sDAI, sUSDS,
  syrupUSDC and scrvUSD (`YIELD_BEARING_STABLES`). They accrue above $1 (syrupUSDC reads
  about $1.12), so a $1.00 pin would mark a position in one ~11% under its own value and
  sell it at minute 0 on both sides (a Morpho syrupUSDC/USDC position at LTV 0.857 against
  an LLTV of 0.915 did exactly that). Over two days their accrual is a few basis points,
  so the path is flat: the simulator gives them no series and values each leg at the
  position's own `priceUsd` every minute (`scenario.ts` `buildPricePath`). They are listed
  in `Comparison.heldAtReadPriceSymbols`, not as unpriced, and every run says so in a
  caveat. The census reads only price ratios, where flat at $1.00 and flat at the read
  price are the same series, so it prices both kinds as a flat 1.0 (`heldFlat`); no
  census figure moves (and no Oct 10 census event has a yield-bearing leg).
- **Measured, not held at $1:** USDe and sUSDe. USDe really moved on Oct 10 and has its own
  series.
- **Off peg, not held at $1, and unpriced:** sUSD. It traded well under $1.00 through 2025
  and the dataset has no series for it. In the census it appears only as debt, on Optimism,
  so those 4 events drop out as unpriced debt and the cohort is 2,347 accounts, not 2,350.

| Rule | Contract (membrane-solidity master `16e12329`) | Simulator |
|---|---|---|
| The listing's one parameter is an immutable LTV cap | `Collateral.sol:75`; immutable via `LtvCapImmutable`, `Collateral.sol:383-385` | — (no listing exists; the cap is modelled per symbol) |
| Class is derived: `_noDelay(cap) = cap > MAX_LTV_HARD_CAP` (strict) | `Collateral.sol:424-426` | `collateralClass.ts:163` `lineIsNoDelay`; `:154` `isNoDelayCollateral` (stable ⇒ no-delay, MODELLED) |
| `MAX_LTV_HARD_CAP = 9e17`, `NO_DELAY_LTV_HARD_CAP = 96e16` | `lib/Constants.sol:23`, `:32` | `collateralClass.ts:42`, `:46` (re-exported by `membrane.ts`) |
| A delayed asset's max LTV is clamped to its cap (≤ 90%) | `Collateral.sol:538-540`, `:562` | `membrane.ts:106` `membraneMaxLtv` (clamps at the class cap, `collateralClass.ts:168`); a split half, `compare.ts:544` |
| A no-delay asset has no window (`max_threshold_to_delay == 0`) | `Collateral.sol:430-432`; deploy `script/DeployFullSystem.s.sol:1127` | `curePath.ts:226` (the no-delay timer ignores the band) |
| Launch listing: sUSDS, syrupUSDC, scrvUSD at 96e16; WETH at 90e16 | `script/DeployFullSystem.s.sol:269-272` | the stable ⇒ no-delay assumption, `collateralClass.ts:154` |
| Instant mode: threshold = line, `currentLtv > threshold` ⇒ Immediate | `LiquidationEngine.sol:1572-1576`, `:1694-1703` | `curePath.ts:226` (`sell`, reason `instant`, strict `>`) |
| A timer can never arm in instant mode | `LiquidationEngine.sol:1708-1710` (`InstantModeNotLiquidatable`) | `curePath.ts:226` (never returns `arm`) |
| No-delay walk: sold at t0, walks on, sold again on a later breach | as above, plus the repay-to-cap `LiquidationEngine.sol:2204-2238` | `curePath.ts:393`, `:470` (`cureWalk` `noDelay`, outcome `sold-no-delay`) |
| Delayed, already past the band at t0: Immediate, then the position walks on (a later breach opens a fresh window, a later band break sells again) | `LiquidationEngine.sol:1390` (Immediate); the timer is deleted after ANY sale and the position stays live, `:1421-1423` | `cureWalk` (outcome `sold-at-t0` names the first sale; the walk continues — the old stop after one repay is `stopAfterT0BandSale`, published as `meta.sensitivity.noWalkOnAfterT0BandSale`) |
| Stable and volatile collateral may not share a position | `Cdp.sol:1650-1651` → `MixedDelayClassCollateral`, `Collateral.sol:789-793` | `collateralClass.ts:186` `delayClassOf` → `'mixed'` |
| Every call recalls first, toward the WHOLE debt | `repayTarget = totalDebt` `LiquidationEngine.sol:1319`; Step 1.5 sends `min(retrievable, repayTarget - totalRepaid)` `:1450-1453` | `compare.ts:347-353` (recall `min(available, debt)` at every keeper call) |
| Paid recall-only lane: post-recall LTV ≤ line ⇒ fee, nothing sold, timer deleted | `LiquidationEngine.sol:1603-1658` (trigger `:1623`, runs before classification; fee base `min(target, recalled)` `:1653-1654`; fee `:1821-1838`, `:1877`, `:1887`; sale steps skipped `:1137-1141`) | `compare.ts:366` (at a breach, a sale, or inside the window) |
| Still over the line: breach call arms with the recall kept; in-window call reverts | `TimerStarted` lane; `TimerActive` revert `:1690` | `compare.ts:403` (arm), `:397` (hold: no state change) |
| Still over the line at a sale: Step 2 sizes the target at the POST-recall LTV on the PRE-recall loan; collateral covers the target less the recall | `_getRepayQuantities` `LiquidationEngine.sol:2663-2732` (`totalDebt` `:1311`, `:2671`; `currentLtv` read `:1554`); sell wall `remaining = repayTarget - totalRepaid` `:2261` | `compare.ts:446`, `membrane.ts:226` (`membraneSaleAfterRecall`) |
| Post-check: a liquidation may not raise LTV | `Cdp.sol:2494-2498` (`LiquidationRaisedLtv`) | **not modelled** — caveat, `compare.ts:671` |

**Mixed collateral: split in the simulator, walked as before in the census.**

- *Simulator* (`compare.ts:544` `splitByDelayClass`). A pasted position holding both
  kinds is run as the **two isolated positions** Membrane would make the borrower hold.
  The debt, and any deployed venue capital, is split pro-rata to collateral value at
  minute 0, so both halves open at the position's own LTV (the neutral split). Each half
  keeps its OWN modelled line: the page always passes a line override (the blended line
  by default), so each half's line is scaled by override / whole-position line
  (`compare.ts:561`) — at the default exactly its own line, and a user edit moves both by
  the same factor — then clamped to its class's cap (96% stable, 90% otherwise). A half
  with no modelled LTV on any leg (e.g. GHO) runs at the whole position's scaled line, and
  the run says so. Each half is labelled from the class it actually runs in, and the
  halves are summed into one run. The split is modelled: a borrower could split
  differently.
- *Census* (`scripts/build-evidence.ts:745`). The CSV names only the reserves that were
  seized. An account with a stable AND a volatile reserve seized is `mixed`: a position
  Membrane would not hold in one piece, but the data cannot say how it would have been
  split. The headline walks it delayed on its first leg, exactly as before this rule, and
  removing such accounts from both sides is published as `meta.sensitivity.mixedExcluded`
  (16 priced accounts on Oct 10: Aave $0.65M, Membrane $0.71M).

**What the census can see.** Because the CSV names only the seized reserves, the class of
most accounts is unknowable from it. `seenCollateralShare` is the seized reserves over ONE
denominator, the account's total collateral at block N-1 of its FIRST liquidation
(`scripts/build-evidence.ts:589-613`). Each reserve is priced by the round in force at that
block. Its balance is `pre_collateral_normalized` at its own first event: for the reserve
seized first that is the first event's block; for a reserve first seized later it is the
best the CSV has (nothing was seized from it in between, but deposits, withdrawals and
interest are not seen). This used to divide each reserve by the total at its OWN first
event, which earlier seizures had already shrunk: 11 of the 13 shares above 1.05 (up to
1.487) were multi-reserve accounts inflated that way, not an oracle mismatch. On one
denominator the largest raw share is 1.061, a single-reserve WETH account; 349 accounts
are above 1, all but 3 of them single-reserve, and the excess is the gap between the
Chainlink round and Aave's own price in the total (`meta.anchor`). The published share is
capped at 1 (`meta.delayClass.seenCollateralShare.rawAboveOne`); the class only asks
whether the share is ≥ 95%, which a raw share above 1 passes capped or not. The change
moved 16 rows between share buckets (11 of them included and priced) and 8 rows from
`delayed` to `unknown` (5 included and priced). Both walk the window, so no dollar figure
moved. The class is applied only where the share is ≥ 95%. Everywhere else the class is
`unknown` and the account walks the window as before, unless its line is above 90%
(`:745`). Of the 71 priced accounts whose seized collateral is all stablecoins, 53 are
unknown on that test. The full composition of every account needs on-chain reads of every
reserve it held, not this CSV.

**The venue recall, and the paid recall-only lane.** Every keeper call runs Step 1.5
before it classifies anything, and Step 1.5 recalls toward the **whole debt**, not the
restore-to-cap amount (`repayTarget = totalDebt`, `LiquidationEngine.sol:1319`;
`:1450-1453`). The simulator models a call at the breach (the call that would start the
timer), at a sale (band break, expiry, or a no-window position over its line), and inside
the window (under the mapping below the breach call has already drawn the fast share, so a
call inside the window finds nothing new). At each, it recalls `R = min(available, debt)`:

- **Available** maps onto the two inputs, conservatively, so both stay meaningful (the
  page clamps `fastRate` ≤ `recallRate`, `Controls.tsx:301-313`). A call at the breach,
  inside the window, or at a sale with no window running can recall only what is there now
  or inside the 8 hours: up to `fastRate` of the deployed capital, cumulative. Only a sale
  at EXPIRY, after the full 8-hour window has run, can draw up to `recallRate`, cumulative.
  A band break gets `fastRate` like any early call: it can come minutes after the breach
  (the median priced band sale on Oct 10 came 4 minutes after its breach). A cooldown venue
  (sUSDe: recall 0.3, fast 0) returns nothing at the breach or at a band break.
- **After the recall the LTV is at or under the line** → the recall-only lane
  (`:1603-1658`, trigger `:1623`). Nothing is sold, any timer is deleted, and the call
  is paid the fee from collateral on `min(restore-to-cap target at the PRE-recall state,
  R)` (`:1653-1654`). One event, one fee. It applies in both classes, at the breach,
  during the window, and at a sale. An underwater position with a deep venue takes it
  once, not twice.
- **Still over the line.** At the breach, the recall stays and the timer arms with the
  smaller debt (the timer-start call pays no fee). Inside the window, the call would
  revert `TimerActive`, so the recall rolls back and nothing changes. At a sale, the
  contract sizes the sale as Step 2 does (`_getRepayQuantities`, `:2663-2732`): the
  restore-to-cap fraction at the POST-recall LTV (`currentLtv`, read `:1554`) applied to
  the PRE-recall loan (`p.totalDebt`, `:1311`, `:2671`), with the debt floor on that. The
  sale then covers only `remaining = repayTarget - totalRepaid` (`:2261`), and the recall
  counts in `totalRepaid`. So collateral sold = max(0, that target − R), with the fee on
  top (`membraneSaleAfterRecall`, `membrane.ts:226`). Example: debt $100k, collateral
  $110k, line 87% (borrow cap 84%), R = $2k → $33,714 of collateral, not the $35,000 a
  post-recall-loan sizing would give. A sale that recalls, sells and charges nothing (the collateral
  is already gone and no venue capital is left) records no event; an event that sold
  nothing is a recall only when a venue actually returned capital.

The simulator's fee is the flat modelled rate, not the contract's fee ramp. The census
credits no recall, so it never enters this lane.

**The post-check, a caveat only.** `Cdp.sol:2494-2498` reverts any liquidation that leaves
the position's LTV higher than before it. The simulator does **not** model that revert:
its flat fee is a stand-in for the contract's ramp, so a revert computed from it would be
an artefact of the model. Every run states this caveat.

**What it did to the Oct 10 census** (`meta.delayClass`, `meta.sensitivity.stablesDelayed`).
19 priced accounts are no-delay: 18 whose collateral the CSV sees is all stablecoins, and 1
WETH/WETH account on a 94.6% line. None of them would have cured in a window
(`time.noDelay`), and every one has a flat or never-recovering path, so selling at t0
instead of at the 8h expiry moves **no dollar**: the same-rows delta is $0.00, and the
headline is the pre-rule headline (priced Aave $34.69M, Membrane $22.19M then; $22.20M since
the walk-on below). It moves none
under the per-sale liquidity cap either (`meta.sensitivity.liquidityBound` is unchanged),
though in general it can: a capped remainder with no window is sold the next minute
instead of earning a fresh one.

**A sale at t0 past the band walks on** (2026-10-14, `meta.sensitivity.noWalkOnAfterT0BandSale`).
`cureWalk` used to sell a delayed account already past line × 1.04 at t0 once and stop
walking it, while every other sale walked on. The contract deletes the timer after any sale
and the position stays live (`LiquidationEngine.sol:1421-1423`), so the census now walks it
on like the simulator does. On Oct 10 that moves one priced account (mainnet `0x9bafc9…`,
sold again later): Membrane **+$13,303.43** on both sets (priced $22,191,189.76 →
$22,204,493.19; all included $54,158,792.83 → $54,172,096.26), no outcome changes, and a
second account (`0xc6cb96…`) re-arms and is saved after its t0 sale without selling again.
Under the per-sale liquidity cap (`meta.sensitivity.liquidityBound`) it is worth more,
$20.81M → $21.89M priced: a capped t0 sale used to end the walk with the remainder unsold.

---

## 4. The adapter interface

```ts
export interface LendingAdapter {
  id: ProtocolId
  label: string
  /** Throws on failure — the registry catches and converts to an AdapterResult. */
  read(address: `0x${string}`): Promise<ProtocolPosition[]>
}
```

`runAdapters(address)` runs every adapter **in parallel**, wraps each in its own
try/catch, times it, and returns `AdapterResult[]`. One protocol failing never affects
another and never blanks the page. Status is `ok` / `empty` / `error` / `unsupported`, and
the `message` is rendered verbatim — a broken adapter says so rather than reporting an
empty wallet.

| Protocol | State | Notes |
|---|---|---|
| **Aave V3** | working | Addresses resolved through `PoolAddressesProvider` so an upgrade cannot break it. Aggregate from `getUserAccountData`; per-leg breakdown from `PoolDataProvider`; prices from `AaveOracle`. |
| **Spark** | working | Aave V3 fork — same factory, different `PoolAddressesProvider`. |
| **Morpho Blue** | working | No on-chain enumeration of a user's markets exists, so it multicalls `position()` across the market list committed in `protocols.json`, then reads `idToMarketParams` on-chain. Borrow APR is `null` — reading it needs the external adaptive-curve IRM, which is not wired. `null` is the honest answer. |
| **Compound V3** | working | cUSDCv3, cWETHv3, cUSDTv3. Real borrow APR. |
| **Fluid** | **stub** | Throws `UnsupportedError` with an explanation. The VaultResolver enumeration and tick decoding are not implemented. Reported as `unsupported`, never as an empty wallet. |

### The one price assumption in the adapters

Morpho loan tokens **USDC / USDT / DAI are valued at exactly $1.00**, matched by address
rather than symbol. Every affected position carries this in `provenance.detail`. Any other
loan token is priced off the Aave V3 oracle; if Aave has no source for it, the adapter
**throws naming the market and token** rather than inventing a price. One exotic Morpho
market therefore fails the whole Morpho read — that is deliberate.

### RPC

`lib/position-sim/rpc.ts` builds a viem `fallback` transport over keyless public mainnet
endpoints, overridable with `NEXT_PUBLIC_MAINNET_RPC_URL`. It is strictly read-only: no
signer is attached and no write method is exposed. It is separate from `config/evm/`
because that client points at the anvil where Membrane lives.

---

## 5. Deployment detection (the secondary sim)

`lib/position-sim/venues.ts` checks ERC-20 balances of a short list of known
yield-bearing tokens. If nothing is detected, the deployment section renders a single
line saying so — **it does not invent a deployment**. A zero result is explicitly not
claimed as proof there is none; the capital may be in an unlisted venue, an LP position,
or on another address.

The `recallRate` / `fastRate` per venue are **modelled** from each venue's exit mechanics
(sUSDe's 7-day cooldown, Aave's utilisation cap, sDAI's on-demand redemption) and are
editable in the UI, because they are the variable that moves the result most.

---

## 6. Shareability

- URL carries the address and every input that changes the result (`?a=`, `?p=`, `?ltv=`,
  `?fee=`, `?recall=`, `?fast=`, `?dep=`), so a shared link reproduces the run. Round-trip
  is tested.
- The share card is a 1080×1350 canvas PNG in the Living Typeface palette, the same
  approach as the Builder's card. Its footer always carries the provenance and the
  "not a forecast" line — the card cannot be shared stripped of its caveats.
- `PageSeo seoClass="indexable"` — this is a marketing surface.
- **Demo-first (CLAUDE.md V20):** the page opens fully populated with a worked example,
  synchronously, before anyone types anything. No empty state, no connect gate. The demo
  block is stamped `mock`. Once a real address loads, the demo is gone — there is no path
  that silently falls back to it.

---

## 7. Known limitations

1. **Membrane is not deployed on mainnet.** Its LTV parameters here are ours. §1.
2. **Borrow interest is not accrued.** Both engines are compared on the price move alone.
   Real debt grows under both.
3. **Liquidations are modelled as firing the first minute the oracle breaches.** A real
   liquidation needs a profitable liquidator in that minute; some fire late and a few
   never fire.
4. **Gas, MEV competition and slippage on seized collateral are not modelled.** All three
   make the real outcome worse than these runs, not better.
5. **Only Chainlink ETH/USD and BTC/USD are priced.** Any other collateral is held flat
   across the window and named in `Comparison.unpricedSymbols`. A position in an unpriced
   asset understates its own risk. The dollar stables are held at $1.00 and the
   yield-bearing receipts at their read price (`Comparison.heldAtReadPriceSymbols`); both
   are known flat, not unpriced.
6. **eMode is reflected only through the aggregate.** Aave's `getUserAccountData` applies
   eMode, isolation mode and collateral flags, so the totals are right, but the per-leg
   thresholds shown are the reserve's base values.
7. **Fluid is not implemented.** §4.
8. **Morpho borrow APR is `null`.** §4.
9. **The wstETH oracle in the dataset is the stETH feed.** §2.
10. **Adapters are not covered by network tests** — only their pure decoding/scaling
    arithmetic is. There is no fixture RPC in this repo.
11. **A simulation is not a forecast.**
12. **The delay class of stable collateral is modelled.** The contracts derive the class
    from each listing's LTV cap; "stable ⇒ no-delay" is our listing assumption. §3.
13. **A mixed position's split is modelled.** Membrane would hold it as two positions; how
    the borrower divides the debt between them is ours (pro-rata to value). §3.
14. **The `LiquidationRaisedLtv` post-check is not modelled** (`Cdp.sol:2494-2498`). §3.
15. **The wallet-history replay (`history.ts`) still grants every collateral the 8h
    window.** Only the Oct 10 comparison and the census apply the delay class.
16. **The census cannot see most accounts' collateral.** Its CSV names only the seized
    reserves, so the delay class is applied only where they are ≥ 95% of the collateral.
    Full composition needs on-chain reads (the Q28 full-coverage census). §3.

---

## 8. Running it

```bash
pnpm test:unit          # vitest, the CI gate (includes tests/unit/collateralClass.test.ts)
npx tsx scripts/tests/position-sim.test.ts   # engine + simulator + census-agreement tests
pnpm build:oct10-data   # regenerate public/data/oct10-2025 from the raw pull
MEMBRANE_DATASETS_DIR=../membrane-datasets ./node_modules/.bin/tsx scripts/build-evidence.ts  # the census (§2)
npx tsc --noEmit        # the repo has pre-existing unrelated errors; these dirs are clean
```

Entry points:

| Path | What |
|---|---|
| `pages/[chain]/simulator.tsx` | the page |
| `components/Simulator/Simulator.tsx` | orchestrator |
| `lib/position-sim/compare.ts` | the two-engine comparison |
| `lib/position-sim/membrane.ts` | Membrane's maths and its modelled parameters |
| `lib/position-sim/collateralClass.ts` | the one stable definition and the delay class |
| `lib/position-sim/curePath.ts` | the delay walk both engines share |
| `lib/position-sim/adapters/` | the protocol adapters |
| `lib/gauntlet-engine/` | the shared engine extraction |
