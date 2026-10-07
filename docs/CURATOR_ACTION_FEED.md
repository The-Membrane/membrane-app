# Curator action feed

What vault curators changed on Ethereum mainnet, which curators left the same collateral
together, who holds which collateral, and which vault withdrawals moved a market.
Lane: umbrella "ONE GOAL, THREE LAYERS", data product #8, layer DATA+PRODUCT. Spec: owner
"Risk Manager Tooling — Planning Spec" (2026-10-05). Research driver: DeFi Dojo (621
verified records) — curator exposure + rate-spike attribution, 10 msgs / 6 authors; after
the Resolv / Stream / msUSD incidents members asked which vaults were exposed. Steakhouse
cutting rsETH in 2025 was a signal anyone could have followed.

Page `/[chain]/curator-feed` · API `/api/curator-feed` · data `public/data/curator-feed/`
· collector `pnpm curators:feed`.

## Contract terms this lane shares

| Term         | Here                                                                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| block anchor | The **finalized** head at collection time; the window is `head − DAYS × 7,200` blocks (post-merge ≤ 7,200 blocks/day, so the window covers ≥ DAYS days). Exposure is read at the head; exit context and attribution at the action's own block.                                       |
| claim class  | Feed row = `measured-change` (the chain recorded it). Exit cluster = `possible-leading-signal` (a pattern across curators, not an outcome). Attribution row = `observed-driver` (one block's market move and the vault withdrawals inside it). `lib/curatorFeed/service.ts` `CLAIM`. |
| copy         | Factual only: who, what, which market, how much, when executable. No "safe", no predictions. A test greps every rendered sentence.                                                                                                                                                   |

## What it records

| Source                                                   | Events (exact signatures in `lib/curatorFeed/abi.ts`)                                                                                                                                                                                                                                                               | Feed kinds                                                                                                                                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MetaMorpho v1.0 / v1.1                                   | SubmitCap · SetCap · RevokePendingCap · SubmitMarketRemoval · RevokePendingMarketRemoval · SetSupplyQueue · SetWithdrawQueue · ReallocateSupply / ReallocateWithdraw · SubmitTimelock / SetTimelock / RevokePendingTimelock · SetCurator · SetIsAllocator · Submit/Set/RevokePendingGuardian · OwnershipTransferred | `cap_submit` `cap_raise` `cap_cut` `cap_zero` `cap_revoke` `removal_submit` `removal_revoke` `market_removed` `market_added` `supply_queue_add/remove` `timelock_*` `curator_set` `allocator_set` `guardian_*` `owner_set`; reallocation legs → flows |
| Morpho Vault V2                                          | Submit / Accept / Revoke (the queued call is decoded from `data`) · Increase/DecreaseAbsoluteCap · Increase/DecreaseRelativeCap · Allocate / Deallocate (allocator senders only) · Add/RemoveAdapter · SetOwner · SetCurator · SetIsAllocator · SetIsSentinel · Increase/DecreaseTimelock · Abdicate                | same kinds, plus `adapter_add/remove` `sentinel_set` `v2_submit` `v2_revoke`; cap scope = market, collateral or adapter from the event's `idData`                                                                                                     |
| Public Allocator (Morpho, Euler)                         | not scanned separately: a MetaMorpho / Euler Earn reallocation leg whose `caller` is the Public Allocator is tagged `public-allocator`                                                                                                                                                                              | flows `source`                                                                                                                                                                                                                                        |
| Euler Earn                                               | the Euler Earn event set (strategy = ERC-4626 address)                                                                                                                                                                                                                                                              | as MetaMorpho, `scope: strategy`                                                                                                                                                                                                                      |
| Aave v3 PoolConfigurator (Core, Prime, EtherFi, Horizon) | SupplyCapChanged · BorrowCapChanged · CollateralConfigurationChanged · ReserveFrozen · ReservePaused · ReserveBorrowing                                                                                                                                                                                             | protocol-level analogues: `cap_raise/cut` (0 = **no cap**), `freeze` `pause` `borrow_off` `ltv_zero` …                                                                                                                                                |

Contract rules the classifier relies on (`lib/curatorFeed/classify.ts` header): a
MetaMorpho cap cut is immediate (SetCap, no SubmitCap); a raise is SubmitCap then SetCap;
`_setCap` on a new market emits SetWithdrawQueue, so queues are fully visible once a
starting queue is read; a Vault V2 relative cap of WAD means "no relative cap" and 0 means
nothing can be allocated. A submit accepted **in its own transaction** (zero timelock)
never had a window and is folded into the executed row.

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

An exit is `cap_zero`, `removal_submit` or `market_removed` on a target with exactly one
collateral. It counts toward a cluster only when:

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

## Attribution

For every block where vault reallocations withdrew ≥ $1M net (per transaction, so an
idle-market round trip nets out) from a Morpho Blue market: `market(id)` and the IRM's
`borrowRateView` at the end of block b−1 and block b. Kept when the block cut supply by
≥ 20 %, spiked the borrow rate (≥ 1.5× and ≥ +2 APR points, simple APR), or left
utilization ≥ 99 %. The text states the vault's share of the block's supply drop and never
more: other transactions in the block are inside the difference.

## Data integrity

- **Every log chunk is read from two endpoints and unioned** by (block, logIndex). A short
  endpoint can only omit logs, never invent them. Disagreements, recovered logs and which
  endpoint was short are stored in `meta.logs`.
- **Every emitter is verified** against its factory (`isMetaMorpho` on both factories,
  `isVaultV2`, Euler Earn `isVault`) before its logs count.
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
pnpm curators:feed                         # tsx scripts/collect-curator-feed.ts
CURATOR_FEED_DAYS=182 pnpm curators:feed   # window (default 182)
```

A full re-collect (no incremental cache) took ≈ 11 min on keyless endpoints. Output:
`feed.json` (meta in clear, entities/actions/attribution with hex strings interned),
`flows.json` (dictionary-encoded daily rows, whole-token units at 6 significant digits),
`exposure.json`. Budget < 20 MB; a test enforces it.

## API

```
GET /api/curator-feed                     open submits, exit clusters, newest actions
    ?collateral=rsETH|0x…  ?curator=<name>  ?protocol=morpho-v1|morpho-v2|euler-earn|aave-v3
    ?group=caps|exits|queues|roles|timelock|protocol  ?status=open|pending|executable|done
    ?window=24..72  ?limit=1..500  ?before=<action id>
GET /api/curator-feed?view=exposure       [&by=vault] [&collateral=] [&curator=] [&minUsd=]
GET /api/curator-feed?view=attribution    [&collateral=] [&market=0x…] [&only=spike|drained]
```

## Files

| Piece                                                                     | File                                                                                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| keccak256, ABI catalog + decoder, Vault V2 idData                         | `lib/curatorFeed/{keccak,abi,decode,v2ids}.ts`                                                                                                   |
| classifier (state replay), status, clusters, flows, exposure, attribution | `lib/curatorFeed/{classify,status,clusters,flows,exposure,attribution}.ts`                                                                       |
| copy, API logic, on-disk format                                           | `lib/curatorFeed/{format,service,store}.ts`                                                                                                      |
| RPC client (dual-read getLogs, batches, key scrubbing)                    | `scripts/lib/curator-feed-rpc.ts`                                                                                                                |
| collector                                                                 | `scripts/collect-curator-feed.ts`                                                                                                                |
| API, page, card                                                           | `pages/api/curator-feed/index.ts`, `pages/[chain]/curator-feed.tsx`, `components/CuratorFeed/CuratorFeed.tsx` (`CuratorFeed`, `CuratorFeedCard`) |
| tests                                                                     | `tests/unit/curatorFeed{,Signals,Data}.test.ts`, real-log fixtures `tests/unit/fixtures/curator-feed-logs.json`                                  |

## Not yet

- Incremental collection (each run re-reads the whole window).
- Spike-first attribution from Morpho Blue `AccrueInterest` (≈ 4k logs/day on the busy
  markets); v1 is withdrawal-first and so misses spikes caused by borrowers.
- Vault V2 adapter-level timelocked calls (e.g. `burnShares`) — adapters are dropped by
  the factory check today.
- Zero-timelock raises as a per-vault fact (they are folded, not counted).
- Other chains (Base, Arbitrum, Unichain…): the factories differ per chain.
