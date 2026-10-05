# Exit-queue ledger (Layer: DATA)

Status: built 2026-10-05 on `feat/exit-queue-ledger` (off `evm-migration` @ `28c674d`).
Measured history only. No forecast, no alert, no risk badge: the research-only rules in
[`venue-capacity-drivers.md`](./venue-capacity-drivers.md) still apply to anything predictive.

## Why

DeFi Dojo community research (621 verified records, membrane-solidity
`docs/RESEARCH-DEFI-DOJO-COMMUNITY.md` §F4) ranks exit-queue length and real wait time as
the largest single data need:

- LST/LRT and beacon exit queue: 22 messages / 16 authors;
- vault and yield-stablecoin withdrawal-request status + ETA: 21 / 17;
- cooldown terms disclosed up front: 11 / 8.

Members were hurt by silent changes: Ethena moved to a dynamic 1–7 d cooldown, savUSD's
unstake changed 1 d → 1 min unannounced, and Ethena's UI showed 0 after the cooldown. So the
ledger records what requests actually took, and logs every parameter change, including
changes that emitted no event.

## Contract with the other layers

| Term | Definition | Where |
| --- | --- | --- |
| Venue key | Stable id: `lido-steth`, `beacon-exit`, `etherfi-weeth`, `kelp-rseth`, `ethena-susde`, `maple-syrupusdc`, `erc7540:<address>`. `aliases.venueRecorder` maps to the recorder's names (`sUSDe`). | `lib/exitQueue/venues.ts` |
| Block anchor | `{ block, ts }`: the finalized block the numbers were computed at. Every metric, `venue_state` row and Risk Frontier input carries one. | `lib/exitQueue/types.ts` |
| Label class | `onchain_state` (read at the anchor), `measured_history` (observed outcomes over a trailing window; "measured history, not a forecast"), `chain_schedule` (the beacon chain's assigned exit epochs; "not a forecast"), `change_log` (a recorded parameter change). | `LABEL_TEXT` in `lib/exitQueue/types.ts` |

The umbrella board entry (Mac-only `/Users/EBmic/AGENT_BOARD.md`) was not readable from the
cloud session that built this. The three terms above are this lane's reading of
"venue-key + block anchor + label classes"; check them against the umbrella entry.

**Recall Coverage Dataset.** `venueMetrics().venueState` is the `venue_state` slice this
layer owns: `venue_id`, `block`, `ts`, `queue_depth` (float, venue unit), `queue_depth_count`,
`cooldown_s` (int seconds, null when the venue has no on-chain cooldown), `proxy = none`.

**Risk Frontier.** `exitTimeInput(metrics, 30)` → `ExitTimeInput` (`lib/exitQueue/riskFrontier.ts`):
request → claimable p50/p90 with a lower bound when a quantile is not reached, the advertised
cooldown, the beacon schedule floor, queue depth and the last change time. `exitTimeS(input, 'p90')`
is the conservative single number (max of the parts; `null` = unknown, never 0). The stress
engine (`lib/position-sim/stressGrid.ts`, branch `feat/risk-frontier-stress-grid` @ `44c79c8b`)
is not touched here.

## Venues

| Key | Contract (mainnet) | Request | Claimable (finalized) | Claim | Queue now | Advertised wait |
| --- | --- | --- | --- | --- | --- | --- |
| `lido-steth` | WithdrawalQueueERC721 `0x889e…F9B1` | `WithdrawalRequested` | `WithdrawalsFinalized(from, to)` range | `WithdrawalClaimed` | `unfinalizedStETH()`, `unfinalizedRequestNumber()` | none on-chain |
| `beacon-exit` | Beacon API | — | — | — | `active_exiting` count, Σ effective balance | schedule tail: max `exit_epoch` − head epoch |
| `etherfi-weeth` | WithdrawRequestNFT `0x7d57…4E2c` | `WithdrawRequestCreated` | `lastFinalizedRequestId()` advanced — **no event**; located by bisection | `WithdrawRequestClaimed` | count `nextRequestId − 1 − lastFinalized`; amount = ledger sum | none on-chain |
| `kelp-rseth` | LRTWithdrawalManager `0x62De…ec16` | `AssetWithdrawalQueued(…, userNonce)` | `nextLockedNonce(asset)` read at each `AssetUnlocked` | `AssetWithdrawalFinalized`, FIFO + exact rsETH amount | count Σ `nextUnusedNonce − nextLockedNonce`; amount = ledger sum | `withdrawalDelayBlocks` × 12 s |
| `ethena-susde` | StakedUSDeV2 `0x9D39…3497`, silo `0x7FC7…3425` | `Withdraw` with receiver = silo | `cooldownEnd` = request time + cooldown in force (contract rule) | USDe `Transfer` silo → receiver, matched to an owner bucket by exact amount | `USDe.balanceOf(silo)` | `cooldownDuration()` |
| `maple-syrupusdc` | pool `0x80ac…Cc0b` → WithdrawalManagerQueue `0x1bc4…cfE3` | `RequestCreated` | `RequestProcessed` + `RequestRemoved` in one tx | same tx (redeem pays out) | `totalShares()`, `queue()` | none on-chain |
| `erc7540:<addr>` | configured in `ERC7540_VAULTS` (empty) | `RedeemRequest` | not standardised | ERC-4626 `Withdraw` by controller, FIFO | ledger | none |

Every address and event ABI was checked on 2026-10-05: proxies through the EIP-1967 slot,
ABIs from verified implementation source (Sourcify for ether.fi impl `0x41617d01…4a7e` and
Kelp impl `0x0ecde3f4…2c19`; GitHub for Lido, Ethena, Maple), topic0 seen in live logs.
`tests/unit/exitQueueDecode.test.ts` pins the topic0 hashes.

## Derivations

- **Kaplan–Meier durations.** Request → claimable, claimable → claimed and request → claimed,
  each over a request cohort (requests made in the trailing 7/30/90 days, followed to the
  anchor). A still-open request counts as "waited at least its age", a cancelled one is
  censored at cancellation. Dropping open requests is the usual mistake: while a queue builds,
  the completed requests are the fast ones (negative-control test in `exitQueueMetrics.test.ts`).
  When a quantile is not reached, `atLeastS` gives the lower bound and the card prints `≥`.
- **Coverage.** `complete` when the ledger starts before the window; `partial` when the
  window is truncated to the ledger's start; `none` before coverage.
- **Lower bounds and upper bounds.** A ledger-summed queue amount that misses requests older
  than the ledger is flagged `amountIsLowerBound`. A finalization located only to a block
  range is `finalizedVia: 'bracket'` and is dated at the range end (an upper bound).
- **Parameter change log.** Event-sourced changes (sUSDe `CooldownDurationUpdated`, Kelp
  `WithdrawalDelayBlocksUpdated` / fee / min amount, pause and bunker events) plus
  **read-diff changes**: each run reads the parameters, and a value that differs from the
  last good read with no event in between is logged as `state_diff` with its block bracket.
  A failed read (`null`) is never a change.
- **Unmatched claims** are counted, never invented (claims of requests older than the ledger,
  non-queue exits).

## Running it

```
pnpm exitq:record                      # dry run: plan only
pnpm exitq:record --run                # all venues, 30 days on the first run
pnpm exitq:record --run --venue lido-steth --days 30 --max-chunks 60
```

RPC: `--rpc`, else `EXIT_QUEUE_RPC_URLS` / `RECORDER_RPC_URLS` / `RECORDER_RPC_URL` from the
environment or `.env.local` (comma-separated; put the keyed archive + getLogs endpoint first).
URLs are never printed. Beacon: `--beacon`, else `BEACON_API_URL`, else publicnode.
Manual only — **do not install it as a launchd job**; the owner controls the `com.membrane.*`
fleet. Re-running continues from each ledger's cursor.

Storage is local-first (Neon is quota-limited): one JSON file per venue under
`data/exit-queue/` (gitignored), written atomically. Finished requests are pruned after 120
days. Sizes after a 30-day backfill: Lido 936 KB, sUSDe 472 KB, Maple 205 KB, Kelp 71 KB,
beacon 0.5 KB per reading.

API: `GET /api/venues/exit-queues[?venue=]` (`pages/api/venues/exit-queues.ts`; no RPC).
Card: `components/Venue/ExitQueueCard.tsx`, mounted on the Carry page as section 08.

## Findings (2026-10-05, finalized block ≈ 26,123,640; measured history, not a forecast)

30-day backfill over public RPC (Pocket + publicnode), request cohorts:

- **Lido stETH**: 2,855 requests. Request → finalized p50 23.5 h, p90 101.4 h (4.2 d).
  The 7-day cohort has not reached its median: 513 requests / 150,124 stETH unfinalized,
  oldest 102.6 h. Finalized → claimed p50 23.1 h.
- **Beacon exit queue**: 24,354–24,392 validators / ≈787–788k ETH exiting; the last assigned
  exit epoch is 2,014 epochs (≈ 8.95 d) after head, +27.3 h to withdrawable, then the sweep.
- **Ethena sUSDe**: 962 requests; request → claimable 24.0 h at p50 and p90 (the 1-day
  cooldown, contract rule). Claimable → claimed p50 0.8 h, p90 370.7 h (15.4 d): a long tail
  of matured, unclaimed cooldowns. The silo holds 15.27M USDe (cooling and matured-unclaimed).
- **Maple syrupUSDC**: 573 requests; processed (and paid in the same tx) p50 ≈ 6 min, p90 ≈ 8 min;
  6 cancelled; queue empty at the anchor.
- **Kelp rsETH** and **ether.fi eETH**: see the lane log on the board; the first 30-day run
  exposed two data hazards (below) and was re-run.

Data hazards found while building:

1. **Kelp `AssetWithdrawalFinalized` is also emitted by `instantWithdrawal`**, which never
   queued. The event alone is not a queue claim. `completeWithdrawal` always pays the user's
   oldest request, so the ledger accepts a claim only when the burned rsETH equals that
   request's amount.
2. **Kelp `withdrawalDelayBlocks` reads 0** on 2026-10-05 (code default 8 days). The
   advertised delay is therefore not the wait; the operator's `unlockQueue` is.
3. **A public relay returned a wrong historical read**: ether.fi `lastFinalizedRequestId`
   82,325 at block 25,925,600, while Pocket and dRPC both return 82,403 there (and at the
   blocks on both sides). Bisection now retries an out-of-order read once, then brackets the
   interval and counts it in `readAnomalies`.
4. **publicnode refuses archive `eth_call`** (`-32602 Archive requests require a personal
   token`) while serving recent state, so a fallback hop silently turned historical reads
   into failures. Reads at events are retried; Kelp reconciles with the on-chain frontier at
   the scan end (upper bound); ether.fi keeps its cursor block when the end read fails.
5. **Beacon API**: publicnode answers `/states/{state_root}/validators` but returns HTTP 403
   for a numeric slot as `state_id`. The recorder queries by the finalized header's state root.

## Open items

- ERC-7540: no vault configured; the standard has no fulfilment event, so only request →
  claim is measurable until a vault's own event is verified.
- Beacon history is a series of schedule readings, one per recorder run; a per-validator
  initiation → exit history would need historical state reads.
- sUSDe claim matching needs the owner's whole bucket inside the ledger; buckets that started
  before the ledger stay unmatched (counted).
- Live validation used public RPCs from a cloud session; re-run with the keyed Ankr alias on
  the Mac before relying on the numbers.
