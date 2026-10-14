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
| **Membrane's per-asset max LTV** | **MODELLED** | see §2 — there is nothing to read |
| **Membrane's liquidation fee** | **MODELLED** | defaults to the source protocol's own bonus |
| **Venue recall rate / fast rate** | **MODELLED** | our reading of each venue's exit mechanics; editable |
| The opening demo position | **MOCK** | invented balances, real Aave risk parameters attached |

### The single most important caveat

**Membrane has no Ethereum mainnet deployment.** `config/evm/chains.ts` targets a local
anvil. There is no live contract to read a per-asset max LTV from, and no committed
mainnet LTV configuration exists anywhere in `membrane-core` or `membrane-solidity` —
everything found there is Osmosis-era Cosmos config, Rust test fixtures, or frontend
mocks. So the Membrane side of this comparison is a **model of a protocol that is not
deployed**, run against real prices. The simulation edge is not the live edge.

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

**Membrane engine.** On breach: compute the partial repay that restores the borrow cap,
recall from deployment venues first, take only the shortfall out of collateral, and allow
an 8-hour cure window in which fast venue capital can save the position with nothing sold.

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

Membrane has two liquidation-delay classes, and the simulator and the Oct 10 census run
every position in its own. **One definition** decides the class for both:
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
with no dollar effect (`meta.delayClass.lineRule`). The stable set is the union of the two
old lists (`HELD_AT_ONE`, the census `STABLES`) plus USDe and sUSDe. Those two are stable
for the class but **measured**, not held at $1: USDe really moved on Oct 10 and has its
own series.

| Rule | Contract (membrane-solidity master `16e12329`) | Simulator |
|---|---|---|
| The listing's one parameter is an immutable LTV cap | `Collateral.sol:75`; immutable via `LtvCapImmutable`, `Collateral.sol:383-385` | — (no listing exists; the cap is modelled per symbol) |
| Class is derived: `_noDelay(cap) = cap > MAX_LTV_HARD_CAP` (strict) | `Collateral.sol:424-426` | `collateralClass.ts:112` `lineIsNoDelay`; `:103` `isNoDelayCollateral` (stable ⇒ no-delay, MODELLED) |
| `MAX_LTV_HARD_CAP = 9e17`, `NO_DELAY_LTV_HARD_CAP = 96e16` | `lib/Constants.sol:23`, `:32` | `collateralClass.ts:42`, `:46` (re-exported by `membrane.ts`) |
| A delayed asset's max LTV is clamped to its cap (≤ 90%) | `Collateral.sol:538-540`, `:562` | `membrane.ts:106` `membraneMaxLtv` (clamps at the class cap, `collateralClass.ts:117`) |
| A no-delay asset has no window (`max_threshold_to_delay == 0`) | `Collateral.sol:430-432`; deploy `script/DeployFullSystem.s.sol:1127` | `curePath.ts:226` (the no-delay timer ignores the band) |
| Launch listing: sUSDS, syrupUSDC, scrvUSD at 96e16; WETH at 90e16 | `script/DeployFullSystem.s.sol:269-272` | the stable ⇒ no-delay assumption, `collateralClass.ts:103` |
| Instant mode: threshold = line, `currentLtv > threshold` ⇒ Immediate | `LiquidationEngine.sol:1572-1576`, `:1694-1703` | `curePath.ts:226` (`sell`, reason `instant`, strict `>`) |
| A timer can never arm in instant mode | `LiquidationEngine.sol:1708-1710` (`InstantModeNotLiquidatable`) | `curePath.ts:226` (never returns `arm`) |
| No-delay walk: sold at t0, walks on, sold again on a later breach | as above, plus the repay-to-cap `LiquidationEngine.sol:2204-2238` | `curePath.ts:393`, `:470` (`cureWalk` `noDelay`, outcome `sold-no-delay`) |
| Stable and volatile collateral may not share a position | `Cdp.sol:1650-1651` → `MixedDelayClassCollateral`, `Collateral.sol:789-793` | `collateralClass.ts:135` `delayClassOf` → `'mixed'` |
| Paid recall-only lane: a recall that alone cures pays the keeper's fee | `LiquidationEngine.sol:1603-1658` (trigger `:1623`, fee base `:1653-1654`, fee `:1821-1838`, `:1877`, `:1887`, sale steps skipped `:1137-1141`) | `compare.ts:359` (in-window cure), `:392`/`:404` (sale whose shortfall is zero) |
| Post-check: a liquidation may not raise LTV | `Cdp.sol:2494-2498` (`LiquidationRaisedLtv`) | **not modelled** — caveat, `compare.ts:587` |

**Mixed collateral: split in the simulator, excluded in the census.**

- *Simulator* (`compare.ts:480` `splitByDelayClass`). A pasted position holding both
  classes is run as the **two isolated positions** Membrane would make the borrower hold.
  The debt, and any deployed venue capital, is split pro-rata to collateral value at
  minute 0, so both halves open at the position's own LTV (the neutral split). Each half
  runs in its own class against its own line, and the halves are summed into one run. The
  split is modelled, and the run says so in a caveat: a borrower could split differently.
- *Census* (`scripts/build-evidence.ts:665-682`). A liquidated account whose collateral
  spans both classes is a position that cannot exist on Membrane, so there is nothing to
  compare. It is **excluded from both sides**, like an unlocated line, and counted under
  `meta.excluded.byReason.mixedDelayClass`. An account that is both unlocated and mixed
  keeps the earlier, unlocated reason.

**The paid recall-only lane.** When venue capital alone brings a position back to or under
its line, nothing is sold, the timer is deleted, and the keeper is still paid the ordinary
fee from the borrower's collateral, on `min(restore-to-cap target, recalled)`. It applies
in both classes. Before this lane a recall that cured a position paid nobody; the
simulator used to say "no fee was paid", and that wording is gone. The simulator's fee is
the flat modelled rate, not the contract's fee ramp. The census credits no recall, so it
never enters this lane.

**The post-check, a caveat only.** `Cdp.sol:2494-2498` reverts any liquidation that leaves
the position's LTV higher than before it. The simulator does **not** model that revert:
its flat fee is a stand-in for the contract's ramp, so a revert computed from it would be
an artefact of the model. Every run states this caveat.

**What it did to the Oct 10 census** (`meta.delayClass`, `meta.sensitivity.stablesDelayed`).
73 priced accounts are no-delay (72 on stable collateral, 1 a WETH/WETH account with a
94.6% line). None of them would have cured in a window (`time.noDelay`), and every one
has a flat or never-recovering path, so selling at t0 instead of at the 8h expiry moves
**no dollar**: the same-rows delta is $0.00. All of the headline change is the 19
mixed-class accounts leaving both sides: priced 748 → 732 accounts, Aave $34.69M →
$34.03M, Membrane $22.19M → $21.48M. `stablesDelayed` reproduces the old headline exactly.
Under the per-sale liquidity cap (`meta.sensitivity.liquidityBound`) the class does move
dollars, because a capped no-delay remainder is sold the next minute instead of earning a
fresh window.

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
   asset understates its own risk.
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
