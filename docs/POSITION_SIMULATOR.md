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

---

## 8. Running it

```bash
pnpm test:unit          # engine golden tests + simulator tests (64 assertions total)
pnpm build:oct10-data   # regenerate public/data/oct10-2025 from the raw pull
npx tsc --noEmit        # the repo has pre-existing unrelated errors; these dirs are clean
```

Entry points:

| Path | What |
|---|---|
| `pages/[chain]/simulator.tsx` | the page |
| `components/Simulator/Simulator.tsx` | orchestrator |
| `lib/position-sim/compare.ts` | the two-engine comparison |
| `lib/position-sim/membrane.ts` | Membrane's maths and its modelled parameters |
| `lib/position-sim/adapters/` | the protocol adapters |
| `lib/gauntlet-engine/` | the shared engine extraction |
