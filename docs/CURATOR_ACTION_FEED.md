# Curator action feed

What vault curators changed on Ethereum mainnet, which curators left the same collateral
together, who holds which collateral, which vault withdrawals moved a market, and who
moved a market when its borrow rate jumped.
Lane: umbrella "ONE GOAL, THREE LAYERS", data product #8, layer DATA+PRODUCT. Spec: owner
"Risk Manager Tooling — Planning Spec" (2026-10-05). Research driver: DeFi Dojo (621
verified records) — curator exposure + rate-spike attribution, 10 msgs / 6 authors; after
the Resolv / Stream / msUSD incidents members asked which vaults were exposed. Steakhouse
cutting rsETH in 2025 was a signal anyone could have followed.

Page `/[chain]/curator-feed` · API `/api/curator-feed` · data `.data/curator-feed/` (live,
written by each run) else `curator-feed/` in the **private** repo `triccs/membrane-datasets`
(`$MEMBRANE_DATASETS_DIR`, default `../membrane-datasets`; board rule N18 — no copy in
this public repo; `lib/curatorFeed/paths.ts`) · collector `pnpm curators:feed`
(incremental; hourly in `scripts/recorder-tick.sh`).

## Contract terms this lane shares

| Term         | Here                                                                                                                                                                                                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| block anchor | The **finalized** head at collection time; the window is `head − DAYS × 7,200` blocks (post-merge ≤ 7,200 blocks/day, so the window covers ≥ DAYS days). Exposure is read at the head; exit context and attribution at the action's own block.                                         |
| claim class  | Feed row = `measured-change` (the chain recorded it). Exit cluster = `possible-leading-signal` (a pattern across curators, not an outcome). Attribution row and spike row = `observed-driver` (one block's market move and the flows inside it). `lib/curatorFeed/service.ts` `CLAIM`. |
| copy         | Factual only: who, what, which market, how much, when executable. No "safe", no predictions. A test greps every rendered sentence.                                                                                                                                                     |

## What it records

| Source                                                   | Events (exact signatures in `lib/curatorFeed/abi.ts`)                                                                                                                                                                                                                                                               | Feed kinds                                                                                                                                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MetaMorpho v1.0 / v1.1                                   | SubmitCap · SetCap · RevokePendingCap · SubmitMarketRemoval · RevokePendingMarketRemoval · SetSupplyQueue · SetWithdrawQueue · ReallocateSupply / ReallocateWithdraw · SubmitTimelock / SetTimelock / RevokePendingTimelock · SetCurator · SetIsAllocator · Submit/Set/RevokePendingGuardian · OwnershipTransferred | `cap_submit` `cap_raise` `cap_cut` `cap_zero` `cap_revoke` `removal_submit` `removal_revoke` `market_removed` `market_added` `supply_queue_add/remove` `timelock_*` `curator_set` `allocator_set` `guardian_*` `owner_set`; reallocation legs → flows |
| Morpho Vault V2                                          | Submit / Accept / Revoke (the queued call is decoded from `data`) · Increase/DecreaseAbsoluteCap · Increase/DecreaseRelativeCap · Allocate / Deallocate (allocator senders only) · Add/RemoveAdapter · SetOwner · SetCurator · SetIsAllocator · SetIsSentinel · Increase/DecreaseTimelock · Abdicate                | same kinds, plus `adapter_add/remove` `sentinel_set` `v2_submit` `v2_revoke`; cap scope = market, collateral or adapter from the event's `idData`                                                                                                     |
| Vault V2 market adapter (MorphoMarketV1AdapterV2)        | its own Submit / Accept / Revoke / Increase/DecreaseTimelock / Abdicate · BurnShares                                                                                                                                                                                                                                | `writeoff_submit` (timelocked `burnShares`), `writeoff` (the adapter dropped its record of a market position — an exit), adapter timelock rows; shown on the parent vault with `via` = adapter                                                        |
| Morpho Blue                                              | AccrueInterest (rate series) · Supply / Withdraw / Borrow / Repay / Liquidate in a spike's cause block                                                                                                                                                                                                              | spike cases (below)                                                                                                                                                                                                                                   |
| Public Allocator (Morpho, Euler)                         | not scanned separately: a MetaMorpho / Euler Earn reallocation leg whose `caller` is the Public Allocator is tagged `public-allocator`                                                                                                                                                                              | flows `source`                                                                                                                                                                                                                                        |
| Euler Earn                                               | the Euler Earn event set (strategy = ERC-4626 address)                                                                                                                                                                                                                                                              | as MetaMorpho, `scope: strategy`                                                                                                                                                                                                                      |
| Aave v3 PoolConfigurator (Core, Prime, EtherFi, Horizon) | SupplyCapChanged · BorrowCapChanged · CollateralConfigurationChanged · ReserveFrozen · ReservePaused · ReserveBorrowing                                                                                                                                                                                             | protocol-level analogues: `cap_raise/cut` (0 = **no cap**), `freeze` `pause` `borrow_off` `ltv_zero` …                                                                                                                                                |

Contract rules the classifier relies on (`lib/curatorFeed/classify.ts` header): a
MetaMorpho cap cut is immediate (SetCap, no SubmitCap); a raise is SubmitCap then SetCap;
`_setCap` on a new market emits SetWithdrawQueue, so queues are fully visible once a
starting queue is read; a Vault V2 relative cap of WAD means "no relative cap" and 0 means
nothing can be allocated. A submit accepted **in its own transaction** (zero timelock)
never had a window and is folded into the executed row. Instead, each row carries the
vault's **zero-timelock functions** from the last read (`timelock() = 0` for V1 / Euler
Earn; per function for Vault V2 via `timelock(bytes4)`: `increaseAbsoluteCap`,
`increaseRelativeCap`, `addAdapter`, `setIsAllocator`, and the market adapter's
`burnShares`). The page tags them `timelock 0`; the vault exposure list shows every
timelock.

A market adapter's `burnShares(marketId)` sets the adapter's supply-share record for that
market to 0: the vault's books no longer count the position (a write-off). It is
timelocked on the adapter, so the submit is a pending row like a cap submit, and it is an
exit for clusters. Its size is the burned shares priced with `market(id)` at the block
before.

## Status and colour

| Status                              | Meaning                                                                                                                                                                                              | Colour                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `pending`                           | submitted, inside its timelock window (`validAt` from the event for Vault V2, from a head read of `pendingCap` / `config.removableAt` / `pendingTimelock` / `pendingGuardian` for V1 and Euler Earn) | amber                         |
| `executable`                        | window elapsed, not executed or revoked — the contract keeps it pending                                                                                                                              | amber (collapsed on the page) |
| `accepted` / `revoked` / `executed` | history                                                                                                                                                                                              | grey                          |
| `cleared`                           | no resolution event collected but the head read shows nothing pending (counted in meta)                                                                                                              | grey                          |
| cluster member                      | any of the above inside an exit cluster                                                                                                                                                              | red                           |

Status is computed against the request clock, so a cap leaves its window without a
re-collect.

## Exit clusters (red)

An exit is `cap_zero`, `removal_submit`, `market_removed`, `writeoff_submit` or `writeoff`
on a target with exactly one collateral. It counts toward a cluster only when:

- the vault kept **no other market with that collateral capped**, read at the exit's block
  (`stillCapped`; V1 / Euler Earn: withdraw queue + each entry's cap; Vault V2: the
  collateral cap and another market cap of that collateral both open). A cap moved to a
  new oracle / LLTV market with the same collateral is a migration, not an exit;
- it is not a Pendle PT exit within 14 days of the PT's `expiry()` (a roll-off).

A cluster is ≥ 2 **distinct curator entities** (Morpho API registry / Euler labels; one
curator with five vaults is one curator) exiting the same collateral inside the window
(24, 48 or 72 h; default 72). Overlapping windows chain into one cluster; `tightestHours`
is the shortest span that holds ≥ 2 curators. Aave freezes / LTV-zero on the same asset
are attached as context and never counted. Euler Earn strategies with several collaterals
are listed but not clustered.

## Exposure

`exposure.json` = per vault at the head: MetaMorpho withdraw queue × Morpho Blue
`position` (supply shares → assets with SharesMathLib's virtual 1e6 shares / 1 asset);
Vault V2 market adapters (`expectedSupplyAssets`) and V1-vault adapters (look-through,
pro rata); Euler Earn `config(strategy).balance` → `convertToAssets`. The API pivots it
to collateral → vaults (`?view=exposure`) or lists vault → markets → collateral → share
(`&by=vault`). Vaults ≥ $100k (Morpho API TVL, or on-chain when the API has none).

Morpho Blue positions are valued with interest accrued to the head block
(`exposure.ts` `accrueMarket`: the IRM's `borrowRateView` at that block and Morpho's
three-term Taylor compounding), as MetaMorpho's `totalAssets()` counts them. Until
2026-10-11 they used `market()`'s stored totals; in sdeUSD/USDC, last touched 19 h before
at 800 %/yr, that counted $9M of Adpend USDC's book value as live. The accrual reproduces
the incident reconstruction's interest to the unit (`tests/unit/curatorFeedSignals.test.ts`).

Two kinds of reported assets are kept apart from live supply (from the 2025 sdeUSD
write-offs, `curator-incidents/sdeusd-2025/` in the datasets repo):

- **Book value.** Supply in a market with the "supply locked" flag (below). The vault view
  gives `liveUsd` = `totalUsd` − `lockedUsd` − `lostUsd` and ranks by it; the collateral
  view's `usd` excludes it and `lockedUsd` carries it. Without this, Adpend USDC ($513M)
  and 1337 USDC ($273M) ranked as the 1st and 4th largest vaults, and sdeUSD as the largest
  collateral, on $7.4M of net lent principal. A vault's `lockedUsd` is capped at its
  reported total: a Vault V2 adapter's `expectedSupplyAssets` accrues to now, while the
  vault's `totalAssets` grows at most at its max rate (Mainstreet USDC: $13.4M in the
  adapter, $2.65M reported).
- **Written off, still counted.** MetaMorpho v1.1 keeps written-off assets in
  `totalAssets()` as `lostAssets()`, so its share price does not fall. The collector reads
  `lostAssets()` for every MetaMorpho vault (v1.0 has none); the vault view shows it as
  `lostUsd` when ≥ $1 (smaller is share-math rounding). At block 26,170,664, eleven v1.1
  vaults carried ≥ $1k of it, among them Gauntlet USDC Frontier ($1.91M, all of its
  reported total), August AUSD ($674K), Hybrid Tandem Propulsion USDC ($615K), IMF USDS
  ($819K) and Avantgarde USDC Core ($343K, all of its total: its sdeUSD position).

## Attribution

For every block where vault reallocations withdrew ≥ $1M net (per transaction, so an
idle-market round trip nets out) from a Morpho Blue market: `market(id)` and the IRM's
`borrowRateView` at the end of block b−1 and block b. Kept when the block cut supply by
≥ 20 %, spiked the borrow rate (≥ 1.5× and ≥ +2 APR points, simple APR), or left
utilization ≥ 99 %. The text states the vault's share of the block's supply drop and never
more: other transactions in the block are inside the difference.

## Rate spikes (spike-first attribution)

Withdrawal-first attribution starts from large vault withdrawals, so it cannot see a
spike that a borrower caused. Spike-first starts from the rate:

1. Morpho Blue emits `AccrueInterest(id, prevBorrowRate, …)` at the first interaction
   with a market in a block. `prevBorrowRate` is the rate charged since the previous
   accrual, set by the market's state after the previous accrual block's last
   interaction. So between consecutive accruals in blocks c and d, the rate moved because
   of what happened in block c (`lib/curatorFeed/spikes.ts` header).
2. Kept: markets that curated vaults use (any action target, flow target, exposure row,
   V2 adapter market or queue entry), a jump of ≥ 1.5× and ≥ +2 APR points, a borrow
   size implied by the accrual (interest ÷ rate·Δt) of ≥ $500k, and market supply of
   ≥ $1M at the end of block c−1. Each market's last rate is carried in `state.json`, so a
   jump across two runs is not lost.
3. Every Supply / Withdraw / Borrow / Repay / Liquidate on the market in block c,
   grouped by driver. A vault (or V2 adapter) withdrawal is a **reallocation** when the
   same transaction holds an allocator's reallocation leg out of that market for that
   vault, else a **redemption** (the vault paying its own depositors).
4. Each driver's share is its first-order effect on utilization at the state before the
   block (`ΔS` moves `u = B/S` by `−B·ΔS/S²`; `ΔB` by `ΔB/S`), among the drivers that
   pushed utilization up. Interest accrued in the block and second-order terms are left
   out, so shares are shown with "≈".

`GET /api/curator-feed?view=spikes` (`&only=reallocation|drained`, `&minUsd=` market
supply floor, `&limit=`). The page defaults to reallocation-led spikes on markets with
≥ $10M supply.

## Flags (`lib/curatorFeed/flags.ts`, `?view=flags`)

Five flags (seven labels) from the 2026 msY / AZND write-offs (`curator-incidents/msy-aznd-2026/` in the
datasets repo) and the 2025 sdeUSD write-offs (`curator-incidents/sdeusd-2025/`). Each is read for every
market curated vaults use (the spike universe):

| Flag                  | Fires when                                                                                                                                                                                                                                                                                                           | Read                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| fixed-price oracle    | the MorphoChainlinkOracleV2 has no feed and no vault: `price()` is a constant                                                                                                                                                                                                                                        | inputs once per oracle (immutable), kept in `state.json`                                                                      |
| reported-value oracle | every input is a reported value — a feed whose `description()` names a fundamental / NAV / exchange-rate / redemption / proof-of-reserve value, or a vault rate whose asset is not the loan token. No market price in the path                                                                                       | same                                                                                                                          |
| oracle reverting      | `price()` reverts at the head. The text gives the first block of the current run of reverts (`revertOnset`: step back from the head, doubling, to the newest block that answers, then binary search, back to Morpho Blue's deployment at block 18,883,124; "every block probed" when every probe back to it reverts) | every run                                                                                                                     |
| oracle stale          | a feed's `latestRoundData()` reports its last update more than 72 h before the head (the oldest feed counts)                                                                                                                                                                                                         | every run                                                                                                                     |
| one borrower          | one address owes ≥ 50 % of a market's borrows, on a market with ≥ $1M borrowed. Per vault: allocation share × that borrower's debt ÷ the market's supply, shown when ≥ 25 %                                                                                                                                          | with each exposure read: the Morpho API ranks the two largest borrowers; their debt is read on chain (`position`, rounded up) |
| supply locked         | borrows ≥ 99.9 % of supply at the head and 7 days (50,400 blocks) earlier, and the oracle reverts or has no market price (fixed / reported). Suppliers can withdraw only what borrowers repay; supply is book value (Exposure)                                                                                       | every run: `market()` at the head, and 7 days back for the markets fully borrowed at the head                                 |
| curator shift         | the same curator's vaults on the same UTC day: one or more net out of a market and one or more net in, each ≥ $1M (daily flows), and a vault that moved out then cut that collateral (cap to 0, removal, write-off) within 7 days                                                                                    | every run, over the window's flows and actions                                                                                |

Why each matters, from the incident: a reported-value oracle (msY: "RedStone Price Feed
for MSY_FUNDAMENTAL/USD") or a fixed price (AZND: 1.00) never sees the collateral's market
price, so no position became liquidatable when msUSD traded at $0.06–0.27; once `price()`
reverts, Morpho Blue cannot liquidate, lend against the collateral or release collateral
from a position with debt; Alpha moved $6.7M of msY/USDC from Prime and Core into Delta on
2026-06-12 and cut Prime's and Core's msY caps three hours later; one address borrowed
$8.46M of AZND/USDC from Alpha USDC Asia V2 in a day. sdeUSD/USDC (91.5 %) has been fully
borrowed since 2025-11-04 06:43 UTC; on 2025-11-06 sdeUSD's market price fell from $1.06 to
$0.10 within four hours (DefiLlama, 12:02 → 16:03 UTC) while its oracle kept pricing it at
$1.07. Interest at the IRM's top rate took $7.4M of net lent principal to a $9.9B book
value by 2026-10-11, and two vaults that never removed the market report $787M of total
assets, all but $0.16 of it in this market (block 26,170,792). `market()` returns stored totals: the text gives
the time interest was last accrued (`lastUpdate`), not a growth rate.

Texts state what the chain shows (claim class `measured-change` for market facts,
`possible-leading-signal` for shifts). The reported-value test is a description match: a
feed with an unreadable description makes the oracle `unknown`, never flagged. Oracles
that are not MorphoChainlinkOracleV2 are `unknown` too. The borrower ranking comes from the
Morpho API; only its top two per market are checked on chain.

First run (2026-10-11, block 26,169,995): 519 oracles, 167 markets flagged —
reported-value 88, one borrower 54, stale 20, fixed price 17, reverting 8 (7 oracles); 2
curator shifts (Alpha msY 2026-06-12; Gauntlet ETH+/WETH 2026-04-13). Largest by curated
supply: sdeUSD/USDC (91.5 %) — $773M from Adpend USDC and 1337 USDC (≈ 99 % of each),
oracle reverting since the window start or earlier (since 2026-10-11 the search reaches back to
Morpho Blue's deployment: since block 24,055,805, 2025-12-20), one address owing 100 % of its borrows;
msY/USDC (91.5 %) — $20.3M from Mainstreet USDC (≈ 96 % of the vault lent to one
borrower), reverting since block 25,367,564. One-borrower markets include cbBTC/USDC (one
address owes 57 % of $304M), kBTC/RLUSD (70 % of $213M) and wstUSR/USDC (68 % of $205M).
Resolv's RLP and USR feeds report a last update 204 days old (5 markets).

Supply locked, first run (2026-10-11, block 26,170,664): 57 markets fully borrowed at the
head, 16 of them flagged. Largest: sdeUSD/USDC (91.5 %, $9.71B book, reverting), msY/USDC
(86 %, $95.3M, reverting; the Alpha Delta write-off), AZND/USDC ($10M, fixed price),
ILLIQUID_PERPDEX_COLL/USDC ($844K, fixed), deUSD/USDC (86 %, $348K, fixed; MEV Capital
Elixir USDC). Held by curated vaults: sdeUSD (Adpend, 1337), msY 91.5 % (two Mainstreet
USDC vaults), deUSD (MEV Capital Elixir USDC). The rest are dust.

## Oracle above market (`lib/curatorFeed/oracleGap.ts`, `?view=oracle-gap`)

The flags above say what an oracle prices FROM (a static classification). This measures
what it prices AT, against the market, every collector run — Q25 T2's indicator I3
(membrane-datasets `validation/t2`, prereg `membrane-board design/VALIDATION_PREREG.md` T2):

| Piece | Rule |
| --- | --- |
| gap | `oracle / market − 1`. Oracle = the market's Morpho `price()` at the head block (the flags read), `/1e36 × 10^(collateral decimals − loan decimals)` loan tokens per whole collateral token (Morpho Blue IOracle), × DefiLlama's USD price of the loan token — no token is taken as $1. Market = DefiLlama's USD price of the collateral (`coins.llama.fi/prices/current`, keyless, ≤ 100 coins per call). |
| condition | `gap ≥ 2 %`, one-sided (the oracle prices the collateral above the market). |
| fired | 24 consecutive OBSERVED hourly points with the condition (T2 D3): fires at the 24th point, never back-dated. |
| unobserved | `price()` reverts (D9), no DefiLlama price, a sample ≥ 6 h old (D7), on-chain vs DefiLlama decimals that disagree, or a DefiLlama `confidence` under 0.9 (the lower of the two prices; not in T2, whose prices were frozen pulls). Never a 0; it breaks a run, as a missing hour does. A low-confidence point keeps its raw prices and gap in the store for audit; the cut is applied when the store is read. |
| consecutive | Points deduplicated per UTC hour (newest wins), ≤ 1.5 h apart (D2's 1.5× cadence hold, for run-time jitter). |
| stale | the newest run is > 3 h old: the page hatches the module and withholds the headline. |
| markets | every Morpho Blue market curated vaults hold at the exposure read, with a collateral and an oracle (~300). Euler Earn strategies have no Morpho oracle. Held markets never observed are listed as unobserved. |
| order | fired, then above the line for under 24 h, then the rest; inside each, by the $ exposed (curated supply at the exposure read; book value in a supply-locked market, labelled), then hours above. Markets with under $1 of curated exposure sit below a one-line fold on the page. |

The constants (2 %, 24 h, 2 daily points) are not written in code: `lib/curatorFeed/i3Record.generated.json`
holds them and T2's I3 record, built by `node scripts/curator-feed/build-i3-record.mjs` from
`validation/t2/results.json` (sha256 computed and checked against its PROVENANCE.md row; `--check`
fails when the committed file is stale). `tests/unit/curatorFeedOracleGap.test.ts` replays T2's own
I3 series through the same code: every point's fired flag in `AZND-I3.csv` (daily), `msY-I3.csv`
(daily) and `sdeUSD-I3.csv` (hourly) matches, and the first fires equal results.json (AZND
2026-06-12 17:48, sdeUSD 2025-11-04 23:00, msY none).

The record, shown beside the live module: I3 warned ≥ 9 days ahead in 1 of 3 incidents — AZND
49 days before its write-off with 0 false alarms in 74 calm days; sdeUSD 6.7 days before
(under 9); silent before msY and before Oct 10 2025. Caveats on the page: retrospective, n = 3,
T2 FAIL overall; stETH (Oct 10 series) fired twice in calm 2022; AZND's oracle was fixed at
1 USDC, so its gap is `1 / market − 1`.

On the page (§07, `components/CuratorFeed/OracleGapSection.tsx`; owner 2026-10-16: "smaller
cards, less words … a one-glance understanding"): one card per market, in a grid (1 column at
390 px, up to 4 on desktop). A card shows the market, the delta as its big figure, the mark
(✖ fired, red · ▲ hours of 24 · below · ░ not measured or stale, figure withheld) and the $
exposed in small print. Prices, the 48-point series, holders and links are in the card's fold;
the method, the record and its caveats in one "How this is measured" fold. The API is read at
`limit=500` (every market), so "Show only mine" sees all of them.

Your markets (`lib/exposure`): pick a curator (from the feed's own vault → curator labels), or
paste an address (a connected wallet prefills it). The address is read on Ethereum mainnet,
read-only and with no signature, at one pinned block through the keyless public client
(`lib/position-sim/rpc.ts`): ERC-4626 `balanceOf` on every vault §07 lists, then
`convertToAssets` and `totalAssets` where shares are held, and Morpho Blue `position(id, user)`
on every listed market. At most 500 vaults and 500 markets, 100 calls per multicall (50 for the
asset reads): at most 31 eth_calls. Over a limit or malformed: a named error before any call. A
failed call is listed by its error name, and a market whose read failed is "unchecked", never
"none". Tied cards get a heavy frame and a tag ("you supply", "your vault …", "curated by …");
"Highlight mine" / "Show only mine" switch the grid. The viewer's pro-rata $ is computed
(`Relation.usd`, as of the exposure read, book value flagged) but not shown: a new kind of
number waits for the owner.

The compact card (`CuratorFeedCard`, venue page and Today's Safety body) leads with one line —
"✖ n alarms now", "No alarm now", or which input is missing — then 2–5 word headlines
(`lib/curatorFeed/headlines.ts`): "2 curators left LBTC", "Cap cut to 0: PT-sUSDD",
"Oracle gap: none for 24h". Vault, curator and date are small print; the full sentence and the
transaction are in each item's fold. A cluster is an alarm only while its last exit is inside
the 72 h window; an older one is shown as history. An exits feed whose head is older than that
window says "Exits as of <date>", never "no alarm".

Store: `oracle-gap.json` next to `feed.json` (format in `lib/curatorFeed/store.ts`): runs
`[ts, block]`, a market dictionary and rows `[run, market, oracleUsd, marketUsd, confidence,
gap]`, observed points only, the last 7 days (≈ 2 MB at 300 markets). A run that observed
nothing is not recorded. Written by every collector run (step 12, non-fatal; `--publish` also
writes the datasets copy). The hourly tick that already runs the collector is what builds the
24-hour persistence: no new schedule.

Dry run (keyless RPC + DefiLlama, writes nothing):

```
env -u CURATOR_FEED_RPC_URLS -u RECORDER_RPC_URL pnpm curators:feed --oracle-gap-only --dry-run --limit=25
```

On 2026-10-14 (block 26,187,700, all 300 held markets, a real run): 278 observed, 2 at
DefiLlama confidence 0.85 (armUSDCp/WBTC, armUSDTp/WBTC) not counted. Earlier the same day
(block 26,187,350, before the confidence cut): 280 observed; 3 oracles revert
(sdeUSD/USDC, two msY/USDC); 17 collaterals have no DefiLlama price (sUSDv, sETHv, RLP, rRLP,
expired PTs, liUSD-1w, BOBO, sNUSD, GOOGL / NVDA / TSLA, ROY-ST-apyUSD). Above 2 % at that
point: deUSD/USDC (fixed 1.0 oracle, DefiLlama $0.00000001), USR / wstUSR / aprUSR / MC-USR
(≈ +1,160 %), IMF, APU, CULT (USDS markets), apyUSD/USDC (+2.45 %) and PT-apyUSD-5NOV2026
(+2.12 %). One point is not a fire: each needs 24 hours in a row.

## Incremental collection

Each run reads `[last block + 1, finalized head]` only. The collector state
(`state.json`: verified emitter kinds, V2 adapters → vault, V2 allocators, the
classifier's replay state — open submits, last cap per target, queues — and each
curated market's last rate) is carried, so the classifier resumes where it stopped.
`tests/unit/curatorFeed.test.ts` checks that a run split at every cut point equals one
run. Checked end to end on chain too: a 2-day full run and a 1-day full run plus a 1-day
incremental run gave identical actions, spikes and attribution cases. Daily flow rows on
the boundary day are summed, and can differ in the 6th significant digit (rounding).

- The window rolls: `CURATOR_FEED_MAX_DAYS` (default 190) of blocks are kept, never fewer
  than `CURATOR_FEED_DAYS` (default 182) once full. Submits still open are never dropped.
- Exposure is re-read when older than `CURATOR_FEED_EXPOSURE_MAX_AGE_H` (default 6 h).
- Every still-open V1 / Euler Earn submit is re-read at the head each run
  (`applyHeadPending`), not only the new ones.
- Files are written then renamed, so the API never reads a half-written file. The API
  re-parses a file only when its mtime changes.

## Chains

Ethereum mainnet only (owner 2026-10-11: "we launch on mainnet only").
`scripts/lib/curator-feed-chain.ts` holds every chain-specific address; another chain is a
new entry there. Base was measured as a candidate on 2026-10-11 (probe outside the repo: Morpho
MetaMorpho `SetCap` → 0, `SubmitMarketRemoval`, Vault V2 `DecreaseAbsoluteCap` → 0 on
Base, vault list from the Morpho API, Tenderly reads at 1,000 blocks):

- 286 Base exits by 80 vaults in the same 182 days.
- Of the 53 mainnet clusters, 13 had a Base exit of the same collateral from 7 days
  before to 3 days after. Where the events are clearly the same, Base came at the same
  time or later: rsETH 2026-04-18 +18 min (mainnet 18:58, Base 19:16 UTC), syrupUSDC
  +1.7 h, ezETH 2026-05-05 0 h, the 2026-07-13 broad cut +13.5 h (Steakhouse's Base vaults
  2026-07-14 10:23 UTC). The earlier Base exits were routine exits of common collateral
  (wstETH, cbBTC) or the wind-down of three Muscadine vaults (now about $10–20 each).
- So Base adds no earlier signal for mainnet users. It would add Base-only assets
  (cbETH, AERO, stkWELL, cUSDO and others). Keyless Base endpoints serve history only at
  1,000 blocks per getLogs (Tenderly); dRPC and PublicNode refuse it. A Base entry needs
  a keyed archive endpoint.

## Data integrity

- **Every log chunk is read from two endpoints and unioned** by (block, logIndex). A short
  endpoint can only omit logs, never invent them. Disagreements, recovered logs and which
  endpoint was short are stored in `meta.logs`.
- **Every emitter is verified** against its factory (`isMetaMorpho` on both factories,
  `isVaultV2`, Euler Earn `isVault`, `isMorphoMarketV1AdapterV2` plus the adapter's
  `parentVault()` being a verified Vault V2) before its logs count.
- RPC: `CURATOR_FEED_RPC_URLS`, then `RECORDER_RPC_URL` (env or `.env.local`), then
  keyless endpoints. Only `env:<host>` labels are printed or stored; every error string is
  scrubbed. A test checks the stored labels.

Measured 2026-10-07 (see the board entry):

- `eth.api.pocket.network` answered a 50,000-block topic query with 659 logs where the
  true count was 1,008, with no error. In the first 182-day run it was the short side of
  **all 23** dual-read disagreements (12,035 logs recovered). It now serves calls only.
- 267 contracts emitted these topics in the window without being canonical vaults —
  Vault V2 **adapters** (MorphoMarketV1AdapterV2 emits `Submit`/`Accept` with the vault's
  signatures) and MetaMorpho forks such as a "TestUSDC" vault outside both factories.
  Topic-only indexing without factory verification mislabels them.
- Morpho API rejects `address_in` lists longer than 100; `Asset.priceUsd` is deprecated
  (removal 2026-10-21) — the collector uses `price { usd }`.

## Collection of 2026-10-11

Full run, blocks 24,859,211–26,169,611 (2026-04-11 21:33 → 2026-10-11 13:49 UTC,
182.7 days, finalized head), 16.4 min on keyless endpoints. 1,807 log chunks, every one
read twice: 0 disagreements (tenderly ×2, mevblocker, dRPC). Files: feed 13.1 MB, flows
2.2 MB, exposure 0.3 MB, state 1.1 MB (16.7 MB).

- 670,473 events from 470 MetaMorpho, 652 Vault V2 (362 market adapters) and 48 Euler
  Earn vaults (factory-verified) and the 4 Aave PoolConfigurators → 21,545 actions
  (Vault V2 18,326 · MetaMorpho 2,699 · Aave 274 · Euler Earn 246; 7,339 zero-timelock
  submits folded). 21 submits open at the head.
- Exits: 1,642 (62 left another cap on the same collateral open). Clusters: 53 at 72 h,
  32 at 24 h — unchanged from the first collection; rsETH 2026-04-18 is still the
  largest.
- **12 Vault V2 write-offs (`burnShares`), all by Alpha vaults except one.** Two are
  large, both on 2026-07-31 in markets at 100 % utilization (supply = borrow), checked on
  a second endpoint: Alpha USDC Delta V2 wrote off its msY/USDC position (≈ 34.5M USDC,
  block 25,654,860), and its `totalAssets()` went from 17.73M to 0 in that block; Alpha
  USDC Asia V2 wrote off its AZND/USDC position (≈ 10.0M USDC, block 25,654,823),
  `totalAssets()` 7.36M → 0. The other ten were dust (≤ 0.000001 USDC).
- 609,962 reallocation legs → 73,452 daily flow rows; 306 vaults in the exposure
  snapshot; 2,713 withdrawal-first attribution blocks kept of 10,013 ≥ $1M candidates.
- Spikes: 976,430 `AccrueInterest` logs (971,937 on 636 curated markets) → 11,851
  candidates → **10,545 spikes** kept (≥ $1M supply). 6,036 were led by a vault
  reallocation and 2,216 ended at ≥ 99 % utilization. At ≥ $10M supply: 3,841 spikes,
  2,140 reallocation-led. In the latest 500 at ≥ $10M the leading driver was a vault
  redemption in 227, a reallocation in 210, borrowers in 48 and non-vault suppliers in 15.
- Incremental runs on top of it: ~100–160 new blocks in 20–60 s.

## First collection (2026-10-07)

Blocks 24,827,100–26,137,500 (2026-04-07 → 2026-10-07, 182.7 days, finalized head).
675,233 events from 470 MetaMorpho, 654 Vault V2 and 48 Euler Earn vaults (factory-
verified) and the 4 Aave PoolConfigurators → 21,400 feed actions (Vault V2 18,095 ·
MetaMorpho 2,765 · Aave 274 · Euler Earn 266; 7,332 zero-timelock submits folded),
615,535 reallocation legs → 74,005 daily flow rows, 306 vaults in the exposure snapshot,
2,864 attribution blocks kept of 10,674 ≥ $1M candidates (1,981 rate spikes, 279 at
≥ 99 % utilization). 1,598 log chunks, every one read twice: 0 disagreements between the
three endpoints used. Files: feed 8.1 MB, flows 2.2 MB, exposure 0.3 MB.

Exit clusters: 53 at 72 h, 32 at 24 h. Largest: **2026-04-18 18:58 UTC — 9 curators
(Re7, Steakhouse, kpk, UltraYield, MEV Capital, Gauntlet, Yearn, Avantgarde, one unnamed)
set rsETH caps to 0 or removed rsETH markets across 12 vaults within one hour**, leaving
no other rsETH market capped; Aave v3 Core and Prime froze their rsETH reserves at 19:03 and 19:17 UTC. The same day saw
clusters on ezETH, agETH, pufETH, ETH+, ynETHx and hgETH. One member checked by hand
against the chain (Re7 WETH, block 24,908,698: its only rsETH market had cap 0). Most
clusters (47 of 53) include at least one vault that closed caps on ≥ 3 collaterals in the
window — vault wind-downs and broad cuts; the text says so per cluster.

## Run it

```
pnpm curators:feed                    # incremental from .data/curator-feed (else the datasets copy)
pnpm curators:feed --full             # re-read the whole window (CURATOR_FEED_DAYS, default 182)
pnpm curators:feed --full --publish   # … and write the datasets-repo copy + PROVENANCE.md
pnpm curators:feed --exposure         # force a fresh exposure snapshot
pnpm curators:feed --oracle-gap-only [--dry-run] [--limit=N]   # step 12 alone (oracle gap)
CURATOR_FEED_TO_BLOCK=<n>             # stop at block n (reproduce a run; check split = full)
```

A full run took 16.4 min on keyless endpoints; an hourly incremental run takes under a minute.
Output: `feed.json` (meta in clear,
entities/actions/attribution/spikes with hex strings interned), `flows.json`
(dictionary-encoded daily rows, whole-token units at 6 significant digits),
`exposure.json`, `state.json`. Budget < 20 MB; a test enforces it. `--publish` also writes
`PROVENANCE.md` (code commit, window, sha256 of each file); commit it in the datasets repo.
A deployment needs the datasets repo (or `.data/curator-feed`) on disk; without it the API
answers 503.

## API

```
GET /api/curator-feed                     open submits, exit clusters, newest actions
    ?collateral=rsETH|0x…  ?curator=<name>  ?protocol=morpho-v1|morpho-v2|euler-earn|aave-v3
    ?group=caps|exits|queues|roles|timelock|protocol  ?status=open|pending|executable|done
    ?window=24..72  ?limit=1..500  ?before=<action id>
GET /api/curator-feed?view=exposure       [&by=vault] [&collateral=] [&curator=] [&minUsd=]
GET /api/curator-feed?view=attribution    [&collateral=] [&market=0x…] [&only=spike|drained]
GET /api/curator-feed?view=flags          [&collateral=] [&curator=] [&market=0x…]
GET /api/curator-feed?view=spikes         [&collateral=] [&curator=] [&market=0x…]
                                          [&only=reallocation|drained] [&minUsd=] [&limit=]
GET /api/curator-feed?view=oracle-gap     [&collateral=] [&curator=] [&market=0x…] [&limit=]
                                          no oracle-gap.json yet = 200, meta.measured false
CURATOR_FEED_NOW=<unix s>                 pins the API's request clock outside production
                                          (reproduce a checkpoint or a replayed series)
```

## Files

| Piece                                                                     | File                                                                                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| keccak256, ABI catalog + decoder, Vault V2 idData                         | `lib/curatorFeed/{keccak,abi,decode,v2ids}.ts`                                                                                                   |
| classifier (state replay), status, clusters, flows, exposure, attribution | `lib/curatorFeed/{classify,status,clusters,flows,exposure,attribution}.ts`                                                                       |
| rate spikes, rolling window, flags                                        | `lib/curatorFeed/{spikes,window,flags}.ts`                                                                                                       |
| oracle gap (I3), its record and builder                                   | `lib/curatorFeed/oracleGap.ts`, `lib/curatorFeed/i3Record.generated.json`, `scripts/curator-feed/build-i3-record.mjs`                            |
| incident timelines (market + vault, archive reads)                        | `scripts/research/curator-incident.ts`                                                                                                           |
| chain config                                                              | `scripts/lib/curator-feed-chain.ts`                                                                                                              |
| copy, API logic, on-disk format                                           | `lib/curatorFeed/{format,service,store}.ts`                                                                                                      |
| RPC client (dual-read getLogs, batches, key scrubbing)                    | `scripts/lib/curator-feed-rpc.ts`                                                                                                                |
| collector                                                                 | `scripts/collect-curator-feed.ts`                                                                                                                |
| API, page, card                                                           | `pages/api/curator-feed/index.ts`, `pages/[chain]/curator-feed.tsx`, `components/CuratorFeed/CuratorFeed.tsx` (`CuratorFeed`, `CuratorFeedCard`) |
| §07 cards, card headlines, wallet exposure                                | `components/CuratorFeed/OracleGapSection.tsx`, `lib/curatorFeed/headlines.ts`, `lib/exposure/{resolve,relations}.ts`                            |
| tests                                                                     | `tests/unit/curatorFeed{,Signals,Data,OracleGap,OracleGapApi,Headlines}.test.ts`, `tests/unit/exposureResolve.test.ts`, real-log fixtures `tests/unit/fixtures/curator-feed-logs.json` |

## Not yet

- Other chains (owner: mainnet only for launch). See "Chains".
- Spike drivers inside a vault: a vault redemption is attributed to the vault, not to the
  depositor who redeemed.
- Euler Earn strategies (EVK vaults) have no spike series: the rate source is Morpho Blue
  `AccrueInterest` only.
