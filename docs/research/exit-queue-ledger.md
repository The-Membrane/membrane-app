# Exit-queue ledger (Layer: DATA)

Status: built 2026-10-05 on `feat/exit-queue-ledger` (off `evm-migration` @ `28c674d`); contract
reconciled with the board's umbrella entry and backfilled on the keyed RPC 2026-10-05/06.
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

| Term         | Definition | Where |
| ------------ | ---------- | ----- |
| Venue key    | One key per venue across recorder rows, forecaster issues and Risk Frontier nodes. A venue the venue recorder already names keeps the recorder's name: `sUSDe` (`tools/venue-recorder.config.json`). The others had no key anywhere and are minted here: `lido-steth`, `beacon-exit`, `etherfi-weeth`, `kelp-rseth`, `maple-syrupusdc`, `erc7540:<address>`. `aliases.assets` lists the tokens whose exit runs through each queue (`wstETH` → `lido-steth`); `venueKeyForAsset()` resolves them. | `lib/exitQueue/{types,venues}.ts` |
| Block anchor | `{ block, ts }`: the **finalized** block the numbers were computed at (`getBlock({ blockTag: 'finalized' })`). Every metric, `venue_state` row and Risk Frontier input carries one. | `lib/exitQueue/types.ts`, `scripts/record-exit-queues.ts` |
| Label        | `{ class, basis, text }`. `class` is the umbrella's label class (`measured_change`, `observed_driver`, `leading_signal`, `stress_scenario`, `calibrated_forecast`). Everything this layer emits is `measured_change`. `basis` says what kind of measured fact it is: `onchain_state` (read at the anchor), `measured_history` ("measured history, not a forecast"), `chain_schedule` (the beacon chain's assigned exit epochs; "not a forecast"), `change_log` (a recorded parameter change). | `label()`, `LABEL_TEXT`, `BASIS_CLASS` in `lib/exitQueue/types.ts` |

**Reconciled with the umbrella entry (2026-10-05, on the Mac).** The cloud session could not read the
board and assumed the terms. Two differed and were changed in code and tests
(`tests/unit/exitQueueContract.test.ts`):

- `ethena-susde` became `sUSDe`. The umbrella allows one key per venue, and the venue recorder
  already names this one. The `venue_state.venue_id` now joins recorder rows directly.
- The umbrella's label classes are a different, coarser set. The lane's four labels became the
  `basis` under class `measured_change`, so "class" means the same thing in every lane.

The anchor already matched: the recorder reads the finalized block.

**Recall Coverage Dataset.** `venueMetrics().venueState` is the `venue_state` slice this
layer owns: `venue_id`, `block`, `ts`, `queue_depth` (float, venue unit), `queue_depth_count`,
`cooldown_s` (int seconds, null when the venue has no on-chain cooldown), `proxy = none`.

**Risk Frontier.** `exitTimeInput(metrics, 30)` → `ExitTimeInput` (`lib/exitQueue/riskFrontier.ts`):
request → claimable p50/p90 with a lower bound when a quantile is not reached, the advertised
cooldown and whether it sets the wait, the beacon schedule floor (readings get the same +27.3 h
withdrawability delay, so the parts compare), queue depth and the last change time.
`exitTime(input, 'p90')` is the conservative single number with what it rests on: the largest
part, its `source`, `atLeast` (print "≥") and its `label`. `exitTimeS` is the bare number.
`null` = unknown, never 0. A cooldown that is only a floor raises the number but never stands
alone: Kelp's `withdrawalDelayBlocks` reads 0. The stress engine consumes it on the integration
branch `feat/risk-frontier-exit-queue` (`lib/position-sim/exitQueueAxis.ts`).

## Venues

| Key               | Contract (mainnet)                                        | Request                               | Claimable (finalized)                                                    | Claim                                                                       | Queue now                                                        | Advertised wait                              |
| ----------------- | --------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------- |
| `lido-steth`      | WithdrawalQueueERC721 `0x889e…F9B1`                       | `WithdrawalRequested`                 | `WithdrawalsFinalized(from, to)` range                                   | `WithdrawalClaimed`                                                         | `unfinalizedStETH()`, `unfinalizedRequestNumber()`               | none on-chain                                |
| `beacon-exit`     | Beacon API                                                | —                                     | —                                                                        | —                                                                           | `active_exiting` count, Σ effective balance                      | schedule tail: max `exit_epoch` − head epoch |
| `etherfi-weeth`   | WithdrawRequestNFT `0x7d57…4E2c`                          | `WithdrawRequestCreated`              | `lastFinalizedRequestId()` advanced — **no event**; located by bisection | `WithdrawRequestClaimed`                                                    | count `nextRequestId − 1 − lastFinalized`; amount = ledger sum   | none on-chain                                |
| `kelp-rseth`      | LRTWithdrawalManager `0x62De…ec16`                        | `AssetWithdrawalQueued(…, userNonce)` | `nextLockedNonce(asset)` read at each `AssetUnlocked`                    | `AssetWithdrawalFinalized`, FIFO + exact rsETH amount                       | count Σ `nextUnusedNonce − nextLockedNonce`; amount = ledger sum | `withdrawalDelayBlocks` × 12 s               |
| `sUSDe`           | StakedUSDeV2 `0x9D39…3497`, silo `0x7FC7…3425`            | `Withdraw` with receiver = silo       | `cooldownEnd` = request time + cooldown in force (contract rule)         | USDe `Transfer` silo → receiver, matched to an owner bucket by exact amount | `USDe.balanceOf(silo)`                                           | `cooldownDuration()`                         |
| `maple-syrupusdc` | pool `0x80ac…Cc0b` → WithdrawalManagerQueue `0x1bc4…cfE3` | `RequestCreated`                      | `RequestProcessed` + `RequestRemoved` in one tx                          | same tx (redeem pays out)                                                   | `totalShares()`, `queue()`                                       | none on-chain                                |
| `erc7540:<addr>`  | configured in `ERC7540_VAULTS` (empty)                    | `RedeemRequest`                       | not standardised                                                         | ERC-4626 `Withdraw` by controller, FIFO                                     | ledger                                                           | none                                         |

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
  A failed read (`null`) is never a change. Changes from before the ledger's coverage appear
  only when verified once and listed in `seededChanges` (today: sUSDe cooldown 604,800 →
  86,400 s, block 24,669,809, tx `0x05856199…f9`); this is not a complete history.
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
Hourly, it is a non-fatal step of `scripts/recorder-tick.sh`, after the flows recorder:
`/opt/homebrew/bin/node --import tsx scripts/record-exit-queues.ts --run --max-chunks 12`. Use node
`--import tsx`, not the `.bin/tsx` shim, which needs `node` on PATH (launchd has none). The tick runs
from the main checkout (`evm-migration`), so the line takes effect only once this branch is merged
there. **Do not install a separate launchd job**; the owner controls the `com.membrane.*` fleet.
Re-running continues from each ledger's cursor.

Storage is local-first (Neon is quota-limited): one JSON file per venue under
`data/exit-queue/` (gitignored), written atomically. Finished requests are pruned after 120
days. Sizes after a 30-day backfill: Lido 935 KB, sUSDe 497 KB, ether.fi 308 KB, Maple 216 KB,
Kelp 90 KB, beacon 0.5 KB per reading.

API: `GET /api/venues/exit-queues[?venue=]` (`pages/api/venues/exit-queues.ts`; no RPC).
Card: `components/Venue/ExitQueueCard.tsx`, mounted on the Carry page as section 08.

## Keyed-RPC re-run (Mac, finalized block 26,129,440, 2026-10-05 23:25 UTC; measured history, not a forecast)

30-day backfill on the keyed Ankr endpoint alone (`--quorum 1 --log-quorum 1`, 79 s): 0 request-id
gaps, 0 read anomalies, 0 undecoded logs, 0 bracketed finalizations. The ledger's open count equals
the contract's pending count for Lido (514), ether.fi (17) and Kelp (145). An independent sUSDe scan
on Infura gave a byte-identical request set (979 requests, 162 unmatched claims), so the venue with
no id-gap check is covered by a second provider. 30-day request cohorts unless stated.

| Venue           | Requests | Request → claimable                                                                   | Claimable → claimed      | Queue now                       |
| --------------- | -------- | ------------------------------------------------------------------------------------- | ------------------------ | ------------------------------- |
| Lido stETH      | 2,849    | p50 23.4 h · p90 111.0 h (4.6 d); 7-day cohort p50 110.9 h, p90 not reached ≥ 113.9 h | p50 21.0 h               | 514 requests / 131,818 stETH    |
| Beacon exits    | —        | last scheduled exit 8.46 d after head (+27.3 h to withdrawable, then the sweep)       | —                        | 23,122 validators / 869,932 ETH |
| ether.fi eETH   | 885      | p50 25.3 h · p90 37.3 h; 7-day cohort p50 37.3 h · p90 71.2 h                         | p50 1.2 h · p90 3.7 h    | 17 requests / 2,752 eETH        |
| Kelp rsETH      | 218      | p50 402.5 h (16.8 d); p90 not reached, ≥ 505.9 h (21.1 d); no 7-day request unlocked  | p50 23.2 h               | 145 requests / 10,740 rsETH     |
| Ethena sUSDe    | 979      | 24.0 h at p50 and p90 (the 1-day cooldown, contract rule)                             | p50 51 min · p90 164.5 h | silo 15.42M USDe                |
| Maple syrupUSDC | 609      | p50 3.4 min · p90 6.4 min                                                             | same tx                  | empty                           |

**Against the cloud run.** The cloud's anchor was 19 h earlier. Pinned to it (block 26,123,831), the
keyed ledger reproduces the cloud's queue: Lido 514 / 150,123.8 stETH, ether.fi 70 / 1,243.05 eETH,
Kelp 138 / 7,087.8 rsETH. It also gives Kelp p50 397.6 h / ≥ 487.1 h, ether.fi 7-day p50 55.6 h /
p90 70.8 h, and Lido 7-day ≥ 103.2 h. Lido 30-day p90 is 102.5 h against 101.9 h; the keyed ledger
starts 19 h later, so that window is partial. The differences in the table above are 19 h of queue
movement, not the RPC. One figure is unstable rather than different: sUSDe claimable → claimed p90
(cloud 96.3 h, keyed 163.7 h at the same anchor). Kaplan–Meier survival on that tail is 0.114 at
96 h and reaches 0.10 only at ~164 h, so a 1–2 % change in the cohort moves the p90 by ~70 h. It is
not an exit-time input (request → claimable is).

**First hourly tick** (the `scripts/recorder-tick.sh` line, run by hand with an empty environment,
7.5 s, default quorum 2 on the 7-endpoint ring; finalized block 26,130,296): still 0 gaps and
0 anomalies; Lido 521/521, ether.fi 15/15, Kelp 146/146. Risk Frontier `exitTime(…, 'p90')`:
Lido 112.1 h, beacon ≥ 230.3 h (chain schedule), ether.fi 36.5 h, Kelp ≥ 508.8 h, sUSDe 24.0 h,
Maple 6.4 min.

## Cloud-run findings (2026-10-05; finalized block 26,123,831, 04:38 UTC; measured history, not a forecast)

30-day backfill over public RPC (Pocket + dRPC) with every defense below on: 0 request-id
gaps, 0 read anomalies, and the ledger's open count equals the contract's pending count for
Lido (514), ether.fi (70) and Kelp (138). Request cohorts; 30-day window unless stated.

| Venue           | Requests | Request → claimable                                                                      | Claimable → claimed     | Queue now                                       |
| --------------- | -------- | ---------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------- |
| Lido stETH      | 2,856    | p50 23.5 h · p90 101.9 h (4.2 d); 7-day cohort median not reached, ≥ 103.2 h             | p50 22.9 h              | 514 requests / 150,124 stETH                    |
| Beacon exits    | —        | last scheduled exit 8.92 d after head (+27.3 h to withdrawable, then the sweep)          | —                       | 24,323 validators / 786,275 ETH                 |
| ether.fi eETH   | 869      | p50 25.4 h · p90 43.5 h; 7-day cohort p50 55.6 h · p90 70.8 h                            | p50 1.5 h · p90 3.8 h   | 70 requests / 1,243 eETH                        |
| Kelp rsETH      | 217      | p50 397.6 h (16.6 d); p90 not reached, ≥ 487.1 h (20.3 d); no 7-day request unlocked yet | p50 32.8 h              | 138 requests / 7,088 rsETH                      |
| Ethena sUSDe    | 1,003    | 24.0 h at p50 and p90 (the 1-day cooldown, contract rule)                                | p50 45 min · p90 96.3 h | silo 15.67M USDe (cooling + matured, unclaimed) |
| Maple syrupUSDC | 604      | p50 3.4 min · p90 6.4 min (processed and paid in one tx)                                 | same tx                 | empty                                           |

Read with care:

- Lido and ether.fi are slowing: their 7-day cohorts wait longer than their 30-day cohorts.
  The beacon queue (≈ 9 d to the last scheduled exit) is the likely common cause; this ledger
  shows the coincidence, not the mechanism.
- Kelp's on-chain `withdrawalDelayBlocks` is **0** (code default 8 days), yet requests take a
  median 16.6 days to unlock: the operator's `unlockQueue` sets the wait, not the parameter.
  An "advertised cooldown" read from the contract would understate the real wait.
- sUSDe's wait is the cooldown by construction; the tail is users not claiming, and its p90 sits
  on a flat stretch of the survival curve (see the keyed re-run).

## Data hazards found while building

1. **Public relays drop logs silently.** One 30-day Lido scan missed 118 of 2,862 requests;
   two sUSDe scans each missed different requests. Nothing errored. Defenses: each log range
   is fetched twice and unioned when the answers differ (the final run caught 3 Lido, 3
   ether.fi and 6 sUSDe disagreeing ranges); request-id gaps (Lido, ether.fi, Maple, Kelp per
   asset) trigger a re-fetch of the bounding range and are counted if they remain.
2. **Public relays answer archive `eth_call` with another block's state.** Pocket answered
   ether.fi `lastFinalizedRequestId` at block 25,930,000 with 82721 once and 82427 five times
   (dRPC: 82427 every time); another read returned 82325 at a block where the value is 82403.
   Defense: historical reads need two matching answers; bisection retries an out-of-order
   read, then brackets the interval (`readAnomalies`).
3. **publicnode refuses archive `eth_call`** (`-32602 Archive requests require a personal
token`) while serving recent state, so a fallback hop turned historical reads into
   failures. Reads at events retry; Kelp reconciles with `nextLockedNonce` at the scan end.
4. **Kelp `AssetWithdrawalFinalized` is also emitted by `instantWithdrawal`**, which never
   queued. The ledger accepts a queue claim only when the burned rsETH equals the user's
   oldest open request (what `completeWithdrawal` always pays).
5. **ether.fi finalization emits no event.** `lastFinalizedRequestId` is bisected; a budget
   that runs out depth-first leaves later finalizations to be dated by the claim (an upper
   bound, `finalizedVia: 'claim'`). The default budget is now 2,000 reads.
6. **Beacon API**: publicnode returns HTTP 403 for a numeric slot as `state_id` and sometimes
   404 for a finalized state root; the recorder falls back to `finalized` and re-checks the slot.

## Open items

- ERC-7540: no vault configured; the standard has no fulfilment event, so only request →
  claim is measurable until a vault's own event is verified.
- Beacon history is a series of schedule readings, one per recorder run; a per-validator
  initiation → exit history would need historical state reads.
- sUSDe claim matching needs the owner's whole bucket inside the ledger; buckets that started
  before the ledger stay unmatched (counted).
- `--quorum 1 --log-quorum 1` is safe only on a single trusted archive endpoint. The tick uses
  the full ring with the defaults (2).
- sUSDe has no request ids, so a missed request log is caught only by the double fetch.

## Board lines

Posted 2026-10-05/06 on the canonical board (`/Users/EBmic/AGENT_BOARD.md`): the lane line under the
umbrella's LANES list, the data-products row #2, and the entry "### LANE — Exit-queue ledger" at the
end of the umbrella. It carries the contract reconcile (resolved in code), the keyed-RPC numbers and
the discoveries:

- Public relays (Pocket) silently drop `eth_getLogs` results: one Lido 30-day scan missed 118 of
  2,862 requests. They also answer archive `eth_call` with another block's state. publicnode refuses
  archive `eth_call` (-32602). Keyed Ankr and Infura agree byte-for-byte on sUSDe.
- Kelp `withdrawalDelayBlocks` = 0 on-chain, yet request → unlock is a median 16.8 d (keyed run;
  16.6 d in the cloud run). A floor-only cooldown must never stand in for an exit time.
- Kelp `AssetWithdrawalFinalized` also fires for `instantWithdrawal`.
- ether.fi finalization emits no event; `lastFinalizedRequestId` is bisected.
- sUSDe claimable → claimed p90 sits on a flat survival tail (0.114 at 96 h, 0.10 at ~164 h).
- position-sim `KNOWN_VENUES` still says sUSDe has a 7-day cooldown; it is 1 day on-chain since
  block 24,669,809.
