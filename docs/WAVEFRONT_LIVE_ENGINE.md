# Wavefront live engine — Real vs Membrane in real time (Q28 step 2)

**Status: BUILT AND VERIFIED, NOT DEPLOYED — PENDING OWNER APPROVAL.** Nothing here is
deployed, scheduled, paid for or written to a production database. The Dockerfile and
`fly.toml` in `deploy/wavefront-live/` and the SQL in `db/migrations-pending/` are prepared,
not applied. §9 lists what the owner decides.

For every liquidation **in scope** — every Aave V3 pool of the chain's
PoolAddressesProviderRegistry (mainnet Core, Lido and EtherFi; the Core pool on Arbitrum,
Optimism and Base), plus allow-listed instances outside it (none by default, §4) — and every
**Morpho Blue** liquidation on Ethereum, Arbitrum, Optimism and Base, the engine

1. sees the liquidation about a minute after it happens (logs read to head − confirmations);
2. reads the position at block N−1 and the oracle prices at N−1 and N exactly as the Oct 10
   pull read them, and locates it with the census's own rule — at the N prices, or, when an
   oracle update later in block N hides the breach, at the N−1 prices (`priceBasis`);
3. starts a Membrane kernel for the same position (the census's spec, class rule and mixed
   split; `lib/wavefront/kernel.ts`);
4. steps every open kernel once a minute with that minute's on-chain oracle prices;
5. appends both sides to the wavefront stream (`docs/WAVEFRONT.md` §3, **schema v2**:
   pool-qualified Aave pids, `priceBasis` on a walked `open`, real totals over walked positions).

The Oct 10 census writes the same stream from the recorded window; `--mode historical` runs
**this** engine, unchanged, on a simulated clock over archive blocks, and §6 compares the two.

### Second review (go-live blockers) — what changed

| item | fix | where it is checked |
| --- | --- | --- |
| HIGH 1 Postgres sink could never commit (a constant-folded `1/0` guard) | optimistic concurrency: the FIRST statement of each commit moves the state row from the version this writer last committed to the next (`UPDATE … WHERE stream AND version`, in a CTE whose row count divides 1 — 0 rows aborts the whole transaction at run time); state row created explicitly; `stream` column + `(stream, seq)` key, load/MAX per stream; an ambiguous commit is settled by reading the row back (before the next write if even that fails; the engine then reloads) | **a real Postgres 16** (`wavefrontLivePostgres.test.ts`, 7 tests, run here): two writers, ambiguous commits, the whole engine through Postgres = the in-memory stream (§5) |
| HIGH 2 reconciliation double-counted after failed passes | the processed-event keys a future pass could re-find are never pruned (`retainFromTs`, correct by construction); a pass reaches back at most `reconcileMaxCatchupMinutes` (1,440; counted and logged when cut) | the reviewer's repro as a test: 3 failed passes, then a 240-minute pass → no duplicate `real`, repaid $24,600 (was $49,200); the capped variant |
| MEDIUM 3 lagging logs nodes answer short | logs are read only to `min(head of two backend groups) − confirmations`; every chunk is asked on two groups and the UNION kept (the shorter host quarantined, `shortAnswers`); a non-empty chunk whose second backend does not answer in 10 s is kept only if its own group holds the chunk's last block (`unverifiedNonEmpty`) | tests: a short answer caught; a node 40 blocks behind never asked past its head; extra calls measured (§8) |
| MEDIUM 4 the census comparison could pass while things differed | integers (blocks, timestamps, minutes, indexes) compared exactly (1e-6 of a block number is 23 blocks); per-pid record order; ticks compared via restricted folds; missing / extra positions are differences unless in a listed by-design category; exit code 1 on any difference | §6 (0 differences); a 1-block and a 1-second mutation are both caught |
| MEDIUM 5 scope by address list | logs by TOPIC from any emitter; an emitter is Aave V3 iff its `ADDRESSES_PROVIDER()` is a registry provider (the registry is re-read on an unknown emitter); forks / V2 pools / non-registry instances excluded and counted per emitter; Horizon RWA known, OFF by default | tests (fork, V2-like pool, non-registry instance, a pool the registry adds mid-stream, allow-list) and the Oct 10 replay (§6) |
| MEDIUM 6 state growth | the state holds open positions only; closed ones leave it at the commit that closes them (the stream is their archive; the open-once index is rebuilt from the sink at start-up) | tests (a later liquidation of a closed pid, resume); sizes in §5 |
| MEDIUM 7 keyed endpoints | `WAVEFRONT_RPC_<CHAIN>` (comma-separated URLs) → own backend groups; only hostnames ever printed (host labels redacted, log lines and the stats file scrubbed); the public endpoints stay as the independent re-ask / reconciliation backends | `wavefrontLiveRpc.test.ts` |
| MEDIUM 8 liveness | chains independent: a chain behind for `chainStallSeconds` (300 s) stops holding the others, its positions are flagged on the ticks (`gaps.lagging`), it is retried with backoff and caught up as `late` records; reconciliation runs in the background with a real cancellation (AbortSignal) at its budget; `PoolKeeper` re-enables capability-disabled endpoints after 15 min | tests (a chain down 5 minutes → the same records per position; a hanging pass cancelled while minutes go on); the live smoke (§8) |
| LOW | a position whose oracle is silent `maxGapMinutes` (60) in a row is closed with a reason; gap positions persisted; reorg limits (§10); cost figures consistent ($3.20); owner list extended; the `db:push` trap documented | tests; §9, §10 |


### Rebase onto the schema-v2 census (membrane-app `30a4011`) — what changed

| item | what | where it is checked |
| --- | --- | --- |
| the full test run hung | the census's `aaveRealUsd` now takes a fee record; the engine's old call passed none, so every minute with an Aave liquidation threw and was retried forever (the tests' backoff is a no-op). Fixed by adopting the new call; and a minute that fails `maxMinuteFailures` (30) times in a row now ends a historical run with the error instead of retrying forever (live keeps retrying with backoff, the stream waits) | full `npx vitest run`: 23 s; a test that a broken sink ends the run |
| schema v2 emitted | the header says schema 2; a walked `open` carries `priceBasis: 'N' \| 'N-1'` (the census's `openRecord` shape); pool-qualified pids were already v2; real totals over walked positions come from the shared reducer | engine tests (A: `'N'`, F: `'N-1'`, B: none) |
| N−1 locate | the census's rule, not the engine's: the readers emit the pull's `recomputedNm1` / `priceNm1`, and `aavePositionSpec` / `morphoPositionSpec` decide (the engine's own accrual-to-ts(N) locate is removed) | reader tests = the pull's specs; §6 |
| protocol fee | the census's source: the treasury Transfer in the liquidation's receipt (arithmetic as the fallback) — the arithmetic alone left 2 records one cent off | §6: 0 differences; a test with a receipt fee that differs from the arithmetic |
| missing prices | kernels built with `missingPrice: 'carry-forward'` explicitly, never reached: the engine checks every ratio before stepping and records a gap instead (§3) | the gap tests; the kernel snapshot test |
| walk-on | the kernel walks on after a t0 band sale by default (as the census); `--walk-on false` → `stopAfterT0BandSale`, the sensitivity | CLI |

---

## 1. Code

| file | what |
| --- | --- |
| `lib/wavefront/live/engine.ts` | `LiveEngine`: the minute loop, lagging chains and catch-up, positions, ticks, lifecycle, background reconciliation, scope classification, durable state; `SimClock`, `clockHead` (historical) / `liveHead` |
| `lib/wavefront/live/logs.ts` | `LogScanner`: eth_getLogs by topic, chunked, every chunk on two backend groups (union), emitter classification hook, reconciliation on independent backends with an AbortSignal |
| `lib/wavefront/live/blocks.ts` | headers, the block in force at a time (`atOrBefore`, the pull's rule), the head agreed by two backends (`agreedHead`) |
| `lib/wavefront/live/aaveRead.ts` | registry markets, `ADDRESSES_PROVIDER()`, per-pool setup, the per-event re-read (the pull's record shape incl. `recomputedNm1` and every reserve's `priceNm1`; `computeHf` from the pull), the liquidation protocol fee (the receipt's treasury transfer; the LiquidationLogic arithmetic as the fallback) |
| `lib/wavefront/live/morphoRead.ts` | market params, the per-event re-read (accrual and health check as the pull; `priceNm1`) |
| `lib/wavefront/live/prices.ts` | one Multicall3 per chain per minute; re-read of missing values on another backend |
| `lib/wavefront/live/positions.ts` | spec → `open` / `real` / kernels with the census's own functions; kernel snapshots |
| `lib/wavefront/live/sinks.ts` | `FileSink` (JSONL + state, crash-safe), `PostgresSink` (optimistic concurrency, per stream), `MemorySink`; `opened()` (the open-once index from the stream) |
| `lib/wavefront/live/rpc.ts` | the RPC seam, endpoint table, keyed endpoints from the environment (`buildPool`), `PoolKeeper`, `CountingRpc` (ledger, timeout, cancellation) |
| `lib/wavefront/live/state.ts`, `codec.ts`, `config.ts`, `calls.ts` | state types, event decoding, chain constants and defaults (incl. `KNOWN_NON_REGISTRY_AAVE`) |
| `lib/wavefront/pid.ts` | **the pid builder** (one module; the census adopts it) |
| `scripts/wavefront-live/run.ts` | CLI (`--mode live|historical`, `--from`, `--to`, `--chains`, `--out`, `--sink file|postgres`, `--stats`, `--allow-aave-provider`, …) |
| `scripts/wavefront-live/compare-census.ts` | the historical-equivalence check (§6) |
| `scripts/wavefront-live/make-fixture.ts` | the readers' test fixture from the pull's records |
| `tests/unit/wavefrontLive*.test.ts` | 84 tests (§7); `wavefrontLiveFake.ts` / `wavefrontLiveScenario.ts` / `wavefrontLivePg.ts` are their scripted chain, scenario and throwaway Postgres |
| `db/migrations-pending/2026-10-14_wavefront_live.sql` | the Postgres tables — **not applied** |
| `deploy/wavefront-live/{Dockerfile,fly.toml}` | the worker image and a Fly.io config — **not deployed** |

Reused, not copied: the census's spec builders (`aave.ts`, `morpho.ts`), `collateralClass.ts`,
`cluster.ts`, the kernel, the stream codec and reducer, and from the pull
(`scripts/oct10-coverage/`) the RPC pool with backend groups and backoff (`rpc.ts`), the ABIs and
Multicall3 helpers (`abi.ts`), `computeHf` (`aaveEvents.ts`), and `MAX_SALES` / `DELAY_STEPS`
(`census.ts`). The Morpho share/accrual helpers are module-private in the pull, so they are
copied into `morphoRead.ts` and tested against 7 recorded pull rows.

## 2. The minute loop

All I/O is injected — `LiveRpc` (production: the pull's `RpcPool` wrapped in `CountingRpc`),
`Clock` (real or simulated), `StreamSink`, and a head function — so live, tests and historical
runs execute the same code.

Minute m spans [S_m, S_m+60) (S_m = epoch + 60 m; the epoch is the UTC midnight the stream was
created on, so tick minutes are :09, :19, …). A chain is **ready** for m once it has been scanned
through a confirmed block with timestamp ≥ S_m+60. Minute m is processed when every chain is
ready — or when the ones that are not have been behind for `chainStallSeconds` (live 300 s;
historical runs wait for every chain). **A lagging chain does not hold the others**: in its
lagging minutes its positions are not stepped and its liquidations not read, the next tick says so
(`gaps.lagging: {chains, positionMinutes}` — that tick's totals do not include them), it is polled
again with backoff (2 s doubling to 60 s), and once it answers its missed minutes are caught up —
stepped on archive prices, liquidations processed — as `late` records (≤ 60 catch-up minutes per
stream minute). Then, for the ready chains:

1. **step** — every open kernel whose t0 minute is before m, on ONE Multicall3 per chain at the
   block in force at S_m (the highest block with ts ≤ S_m): `AaveOracle.getAssetsPrices` per
   pool oracle for the reserves the open positions hold (+ the Morpho loan tokens priced from the
   Core oracle) and `price()` of every open Morpho oracle. A held leg whose value is missing,
   zero or reverting is re-read on another backend group; still missing, the position is **not
   stepped** that minute (no silent carry-forward) — logged `GAP`, counted, and reported on the
   next tick as `gaps: {positionMinutes, positions, sample}`;
2. **events** — liquidations with ts in [S_m, S_m+60) in (ts, chain, block, log) order. A pid
   seen for the first time is re-read and opened (`open` + `real` + its kernels' t0 `mem`);
   a pid already in the stream gets `real` only;
3. **order** — the minute's records sorted by (ts, tick < open < real < mem, emission), USD
   rounded, seq assigned, each folded by `applyRecord` (the ONE reducer; it throws on anything the
   schema forbids);
4. **tick** at m = 9, 19, … from the reducer's fold;
5. **close** — a position whose kernels are done, idle for the horizon (default 7 days) with no
   timer armed, or whose held legs' oracle values were missing `maxGapMinutes` (60) minutes in a
   row (`gaps.closed: [{pid, reason}]` on the next tick — "oracle silent 60 minutes in a row (an
   armed timer abandoned)") stops being stepped and leaves the state with this commit (it stays in
   the stream; a later liquidation of the same pid is a `real` record);
6. **reconcile** — in the background (§4): a finished pass is consumed here, its finds appended
   as `late`; due passes are started;
7. **commit** the minute's records and the engine state in one sink commit.

A minute processed more than 180 s after it ended (restart, outage) has every record flagged
`backfilled: true`; its logs and prices are archive reads, so the stream has no gaps. Any error
in a minute rolls the engine back to the last commit and the minute is retried with backoff (a
failing head poll is retried per chain, the other chains unaffected).

## 3. Positions — the census's rules, plus the 2.1 review

- **Spec, line, class, split**: `aavePositionSpec` / `morphoPositionSpec` on the live re-read,
  `delayClassOf` on the full composition, mixed → two halves exactly as the census. The readers
  rebuild the pull's records exactly: tested on 8 recorded Aave events (every chain, e-mode on
  three, a not-liquidatable one; HF at N to the wei) and 7 Morpho events, and the census spec
  built from the live record equals the one built from the pull's row.
- **pid** (`lib/wavefront/pid.ts`): `aave-v3:<chain>:<pool>:<user>` and
  `morpho-blue:<chain>:<marketId>:<borrower>`. The **pool address** is in the id because a user
  on two Aave markets has two independent positions (own reserves, oracle, health factor); the
  address is what the log carries, needs no lookup table and cannot collide; a display label comes
  from the provider's market id (`aaveMarketLabel`: core / lido / etherfi). `legacyPid` maps a
  Core-pool id back to the census's `aave-v3:<chain>:<user>`.
- **Locating t0 — the census's rule, not the engine's**: the readers build the pull's record
  shape including the N−1 fields (Aave: `recomputedNm1.healthFactor`, the N−1 composition at the
  N−1 prices — equal to getUserAccountData at N−1 — and every reserve's `priceNm1`; Morpho: the
  oracle's `priceNm1`), and the census's `aavePositionSpec` / `morphoPositionSpec` decide: block
  N prices, else block N−1 (Morpho: the debt accrued to ts(N) at price(N−1)), else
  `walked: false` with the census's reason. Every walked `open` carries `priceBasis: 'N' |
  'N-1'` (schema v2). (The first build located at N−1 with its own rule — Aave balances accrued
  to ts(N) with Aave's index math; that code is gone: one rule, the census's.)
- **Real seized includes the Aave protocol fee**: `liquidatedCollateralAmount` is the
  liquidator's share. aave-v3-origin v3.5.0 `LiquidationLogic.sol` :224-237 (bonus: the e-mode
  category's when the collateral is in the borrower's category, else the reserve's), :644-653
  (`bonusCollateral = X − X.percentDiv(bonus)`, `fee = bonusCollateral.percentMul(protocolFee)`,
  `X −= fee`), :422-430 (the event emits X − fee). The engine inverts L = X − fee(X) exactly (an
  integer search around L·bonus·1e4 / (bonus·1e4 − (bonus − 1e4)·fee)); from revision 11 (v3.7.0
  :615-622) the rounding is percentDivFloor / percentMulCeil and the pool's `POOL_REVISION` picks
  it. Checked on 11 Oct 10 receipts (all four chains, one e-mode): the fee equals the treasury's
  aToken Transfer exactly in all 11 — but not always: on 218 of the 2,632 Oct 10 Aave events the
  treasury receives one or more units less (the aToken moves the fee through its scaled balance
  and rounds down). So the engine takes the fee **where the census takes it: the collateral
  aToken's Transfer(borrower → RESERVE_TREASURY_ADDRESS) in the liquidation's own receipt**,
  after the transaction's previous LiquidationCall and before this one (`AaveReader.treasuryFee`,
  the rule of `scripts/oct10-coverage/fees.ts`; one `eth_getTransactionReceipt` per transaction,
  the aToken and treasury addresses cached per reserve); the arithmetic is the fallback when a
  receipt has no such transfer, and the two are counted (`feeFromReceipt`, `feeFromArithmetic`,
  `feeScaledRounding`). The real record is the census's `aaveRealUsd` fed a fee record of the
  census's shape (`protocolFeeRaw`, `collateralSeizedTotalRaw` = L + fee): `real.seizedUsd` =
  (L + fee) × price(N) on both sides; `real.protocolFeeUsd` = fee × price(N) is a live-only
  field (v2 readers ignore it).
- **Real totals over walked positions only** (schema v2, owner review item 5) live in
  `lib/wavefront/stream.ts` and are picked up unchanged by the engine (it folds with
  `applyRecord`; a closed position that gets another record is folded through a stub carrying its
  `walked` flag).
- **Missing prices**: the kernel (since 30a4011) throws on a missing ratio by default. The engine
  owns the gap policy — a position whose held leg has no value at a minute is not stepped (a
  gap), and every ratio is checked before a kernel is stepped — so its kernels are built with
  `missingPrice: 'carry-forward'` explicitly and that option never acts; a throw there would turn
  a slip into a minute retried forever.
- **Not a census rule — look-ahead.** The census anchors t0 at a LATER event when the first is not
  located (at N nor N−1). A live stream cannot look ahead and the schema allows one `open` per
  pid: such a position opens `walked: false` at its first event.

## 4. Data sources and checks

- **Events — by topic, any emitter**: one eth_getLogs filter per chunk, topic0 ∈
  {`LiquidationCall` 0xe413a321…5286, `Liquidate` 0xa4946ede…7e41}, **no address filter**, chunked
  (span halves on a range refusal). Every log is checked (topic, block in range, not removed,
  blockHash = the header used for its timestamp; logs' own `blockTimestamp` is not trusted —
  arb1.arbitrum.io returns 0 there).
- **Scope = classification of the emitter** (cached per emitter in the chain state):
  - Morpho `Liquidate`: the Blue singleton only (mainnet/Base 0xBBBB…FFCb, Arbitrum 0x6c24…8F5e,
    Optimism 0xce95…AF92); the same signature from anything else is excluded;
  - Aave `LiquidationCall`: a pool the engine knows → in. An unknown emitter → the registry is
    re-read at the log's block (a pool the registry added since the last read gets a reader); else
    the emitter is an Aave V3 pool **iff its `ADDRESSES_PROVIDER()` returns a provider of the
    chain's registry** (or an allow-listed one). Anything else is **excluded and counted per
    emitter** (`scan.excludedByEmitter`, with the reason and provider in `excluded`): Aave V3
    forks (Spark, Seamless, … — their own provider), Aave V2 pools and other contracts (no
    `ADDRESSES_PROVIDER()`), non-registry instances;
  - **Horizon RWA** (mainnet, provider 0x5D39E06b…8ba0 → pool 0xAe05Cd22…32C8, "Horizon RWA
    Market"; checked on chain 2026-10-14: `getPool`, `getMarketId`, the pool's
    `ADDRESSES_PROVIDER()`; not listed by the registry 0xbaA999AC…5170) is a known non-registry
    instance: **OFF by default**, brought in with `--allow-aave-provider horizon` (an owner
    decision, §9). Excluded, it is named in the reason.
- **Registry**: mainnet 0xbaA999AC…5170 (Core 0x87870Bca…, Lido 0x4e033931…, EtherFi
  0x0AA97c28…), Arbitrum/Optimism 0x770ef9f4…52b6, Base 0x2f6571d3…78E2; resolved at start-up, on
  an unknown emitter, and daily; the Core pool and oracle are asserted against the verified
  addresses.
- **Head — agreed by two backends**: logs are read only up to `min(eth_blockNumber of two
  independent logs-capable groups) − confirmations` (`Blocks.agreedHead`; no second group → the
  poll waits). A node behind the head answers a range past its own head with a SHORT list and no
  error (seen on dRPC and arb1.arbitrum.io), so the range asked is one both groups have.
- **Every chunk on two backends** (board R33, extended): every chunk is asked on two different
  backend groups and the **union** kept. When the answers differ, the shorter host is quarantined
  for logs (1 h) — `falseEmpty` when it answered `[]`, `shortAnswers` otherwise. An empty chunk no
  second group confirms is not believed (`UnconfirmedEmptyError`: narrower spans are tried — some
  hosts cap logs at 10 blocks — and the minute waits). A non-empty chunk whose second group does
  not answer within 10 s (the independent public backends are the rate-limited ones) is kept only
  if its own group holds the chunk's last block with the same hash (`unverifiedNonEmpty`; the
  reconciliation re-checks it), else the range is retried. Pocket/Nodies are never asked for logs
  (probe 2026-10-14: Pocket mainnet missed 2/20 events, Optimism 13/20, OP Nodies 20/20, all as
  `[]` or short answers); flashbots/mevblocker are excluded (asserted).
- **Reconciliation — in the background, cancellable**: every hour a pass per chain re-scans the
  window (two hours) on backend groups that did not answer the primary scan of each part. It runs
  off the minute path with a wall-clock budget (120 s) at which it is **cancelled** (an
  AbortSignal: the waiting request is released at once and nothing more is asked); live, a
  minute never waits for it (`--mode historical` and the tests do wait for it at the next minute,
  bounded by the same budget, so a replay is reproducible). A finished pass is consumed by the
  next minute: an event it found that was neither processed nor pending is
  processed then, its records `late: true`, `eventTs` its own time, ts the append time (the
  reducer requires ordered ts); a late position is caught up minute by minute on archive prices.
  A failed or cancelled pass is counted; the next one starts where the last success ended — but
  never more than `reconcileMaxCatchupMinutes` (24 h) back (counted `reconcileCapped`, logged
  with the unchecked block range). **Dedupe is correct by construction**: a processed event's key
  is kept until no future pass can start at or before its time (`retainFromTs` = max(the cap,
  min(the window start, the last success's end)), all non-decreasing, lowered to an in-flight
  pass's start), so a re-found event is never taken for a missed one.
- **Reorgs**: nothing above head − confirmations is read (mainnet 3 blocks ≈ 36 s, the L2s ≈ 30 s:
  OP-stack 15 blocks, Arbitrum 120). Limits in §10.
- **Prices**: §2 step 1; per-asset re-read when one source reverts the batch (the pull's rule).
- **Endpoints and keys**: keyless public endpoints by default (the pull's probed archive list,
  minus Pocket for logs, BlockPI and onfinality; plus arb1.arbitrum.io and, live, PublicNode).
  **Keyed endpoints** come from the environment only: `WAVEFRONT_RPC_MAINNET`, `_ARBITRUM`,
  `_OPTIMISM`, `_BASE` = comma-separated URLs. Each becomes its own backend group
  (`keyed-<hostname>`, higher concurrency, listed first, so it carries most traffic); the public
  groups stay as the **independent** second backends of every chunk and the reconciliation. A
  keyed URL usually carries its key, so only its **hostname** is ever printed: its host label is
  `keyed:<hostname>`, and the CLI scrubs every log line and the stats file of the URLs (and of
  `DATABASE_URL`). `PoolKeeper` re-enables an endpoint the pool disabled for capability errors
  after 15 minutes (the pull's pool disables for good — right for a one-off pull, wrong for a
  worker that runs for months); quarantines for false or short answers stay.

## 5. Durable state, sinks

The state — the stream position, per chain the scanned block and the last minute processed, the
pending events, the processed-event keys a reconciliation could still re-find and the answering
groups of those logs chunks (adjacent chunks merged), the excluded emitters, the reducer's fold
(coverage and totals) and every **open** position's kernels as field snapshots — is committed
with each minute's records. **Closed positions are not in it**: they leave at the commit that
closes them; the stream is their archive, and at start-up the engine rebuilds its open-once index
(pid → walked) from the sink (`StreamSink.opened()`), so its size follows the positions walking,
not the age of the stream.

- **file**: append-only JSONL (`encodeJsonl`'s format; the header adds `engine`, `mode`,
  `chains`, `createdAt`; `window.minutes` is 0 = open-ended) + `<file>.state`. Records are
  fsync'ed, then the state is written to a temp file, fsync'ed and renamed; it records the JSONL
  length it belongs to, and on load a longer JSONL (a torn or uncommitted tail) is truncated
  back. Restoring a kernel snapshot checks its field set against a fresh kernel and refuses a
  mismatch (kernel.ts changed under a saved state). One disk: back it up (§9).
- **Postgres** (Neon, `@neondatabase/serverless`, driver loaded only with `--sink postgres`;
  `DATABASE_URL` read only by the CLI): `wavefront_events(stream, seq, ts, kind, pid, body)` with
  primary key `(stream, seq)` and indexes on `(stream, ts)`, `(stream, pid)`, append-only by
  trigger; `wavefront_engine_state(stream, header, version, seq, state)`. The state row is created
  explicitly with the stream (a second create fails). Each minute is one transaction whose FIRST
  statement is the guard — `WITH upd AS (UPDATE wavefront_engine_state SET version = v+1, seq,
  state WHERE stream = $1 AND version = v RETURNING 1) SELECT 1 / (SELECT count(*) FROM upd)` —
  then the records (≤ 1,000 rows per INSERT). `version` counts commits (seq does not move on a
  minute without records). **Two writers**: whichever commits second matches no row, raises
  division_by_zero at run time and its whole transaction — records included — rolls back; it
  then reads the row back and stops with `SinkConflictError`. **Ambiguous commit** (the connection
  fails around COMMIT): the row is read back — landed (version, seq and the state's md5 match) →
  success; not landed → the original error, and the minute is retried; when even the read-back
  fails, the next write settles it first, and if the commit had landed the engine reloads from
  the sink (`SinkAheadError`). load() checks MAX(seq) of the stream against the state row.
  Tested on a throwaway local Postgres 16 (initdb in a temp directory, unix socket only) — the
  migration applied, two writers, ambiguous commits landed and not, the read-back failing, the
  append-only trigger, and the whole engine on the scripted chain through Postgres with an
  unknown-outcome commit in the middle: the same stream as in memory. **Not applied** anywhere.

**State size.** What the state holds is the open positions, so its size is ≈ 2 KB + 2.6–3.6 KB per position
walking (more for many-leg positions), independent of the stream's age:

- **Oct 10 slice**, at 23:00 (1,573 positions walking, 1,126 closed; walk-on, the census
  default): **5.67 MB** (0.75 MB gzipped). The first design also kept every position ever opened
  in the reducer (6.53 MB at the same point with walk-on off), growing by ~1 KB for every
  position opened, forever.
- **A simulated month** (the scripted chain, 43,200 minutes, 100 liquidated positions a day —
  3,000 — with WETH swinging ±5% daily; 11.6 min wall): the state is 2 KB + 2.62 KB per walking
  position at every point — day 1: 27 walking, 73 KB; day 7: 200, 525 KB; day 30: **604 walking,
  1.58 MB**; the 2,396 closed positions are in the stream only (the first design would have
  carried them too, ≈ +2.4 MB at day 30 and growing). The walking set keeps growing in that
  simulation because the daily swing re-arms and saves positions, and any activity restarts their
  7-day idle clock; in a calm market they close after 7 days. A maximum walk age would bound it
  outright — not implemented (it would be a new census rule).

## 6. Verification against the Oct 10-11 census (`--mode historical`)

**Slice**: 2025-10-10T20:50Z → 23:00Z (minutes 1,250–1,379): all four chains, both protocols,
the crash peak (21:13–21:20, up to 1,337 records a minute). The engine starts cold at 20:50
(`--mode historical`, simulated clock, archive blocks, the same code as live) and its stream is
compared with the census's for every position the census **opened inside the slice**, on every
minute inside it, by `scripts/wavefront-live/compare-census.ts`: each `open`, `real` and `mem`
record field by field (integers — blocks, timestamps, minutes, indexes — exactly; USD within
1e-6 relative, i.e. equal cents), each position's record order, and at every tick the fold of
the compared positions so far against the census's fold of the same positions. Census
positions missing from the live stream and live positions the census lacks count as
differences unless they fall in a by-design category; the exit code is 1 on any difference.

**Result — against the schema-v2, full-scope census** (membrane-datasets
`oct10-2025/coverage/replay.jsonl.gz`, built at membrane-app `30a4011`: every registry pool,
Morpho on all three chains it has, N−1 locate, the fee in seized, walked-only real totals; the
engine on this branch with `--walk-on true`, the census's kernel default):

| positions | `open` | `real` | `mem` (sales) | ticks compared | differences | by-design |
| ---: | ---: | ---: | ---: | ---: | --- | --- |
| 2,648 | 2,648 | 3,350 | 7,101 (2,771) | 13 (2,648 positions in the fold) | **0** — records 0, ticks 0, missing 0, extra 0 | **none** |

- **Every by-design category of the first comparison is gone**: the 3 mainnet Lido positions and
  the 17 Morpho Arbitrum positions are IN the census and compared (2,648 = 2,628 + 20); the 6
  positions located at N−1 now have `priceBasis: 'N-1'` on both sides, with equal fields and
  records; real seized includes the protocol fee on both sides and is compared as is.
- **Same dollars**: real repaid **$180,652,844.21** on both sides; Membrane repaid
  **$151,093,253.88** on both sides. The protocol fee inside real seized: $891,415.19
  (`protocolFeeUsd`, a live-only field, reported, not compared).
- **What is left is not compared, not different**: 51 positions the census opened before 20:50
  (their first event is earlier than the slice) — the cold-started engine opens them at their
  first in-slice event, so they are neither compared nor counted.
- **The fee needed the census's own source**: computed with the LiquidationLogic arithmetic,
  2 real records differed by one cent. The census reads the fee from the treasury Transfer in
  the liquidation's receipt, which is the arithmetic after the aToken's scaled-balance rounding
  — one or more units lower on 218 of the 2,632 Aave events. The engine now reads the same
  receipt (aaveRead.ts `treasuryFee`; the arithmetic is the fallback when a receipt has no
  transfer — 0 times here) and the difference is 0.
- **Scope on the crash** (the topic scan): 128 liquidation-signature logs from 6 out-of-scope
  emitters were excluded and counted — mainnet **Spark Protocol** pool 0xC13e21B6…E987 (25; its
  provider 0x02C3eA4e… is not in the registry) and the **Aave V2** LendingPool 0x7d2768dE…C7A9
  (5; no `ADDRESSES_PROVIDER()`); Optimism 0x8FD4aF47…5DfE (55; no `ADDRESSES_PROVIDER()`) and
  the "Optimism Extra X Lending Market" pool 0x345D2827… (21); Base "Base ZeroLend Market"
  0x766f2127… (11) and "Base Extra X Lending Market" 0x09b11746… (11). The census excludes them
  too (it is registry-scoped).
- **Checks along the way**: HF recomputed at N−1 = getUserAccountData to the wei on every Aave
  event (0 mismatches); every one of 520 chunks asked on two backends — 275 empty ones
  confirmed, 0 false empties, 0 short answers, 0 unverified; 6 reconciliation passes, 2 failed
  or cancelled at their budget (rate-limited third backends) and retried, 0 late events; 0 gaps;
  0 errors; the stream folds through the reducer (13 ticks equal to the fold).
- **Cost of the replay**: 14,605 RPC requests (15,397 HTTP attempts with retries) for 130
  minutes, 3,408 liquidations, 2,699 positions — of which 2,274 receipts (one per Aave
  liquidation's transaction); 11.3 min wall, 82.5 s CPU, **max RSS 340 MB** (heap 156 MB; walk-on
  keeps more positions walking — 1,573 at 23:00 — and the run kept up to 2,000 receipts per pool
  reader, since cut to 256). The slowest crash minute (21:17, 1,206 records) took 15.4 s; one
  minute waited 120 s for a reconciliation pass (historical runs wait for them).
- **History**: before the rebase (stream schema v1), the same comparison against the served v1
  replay of this branch's old base reported 0 differences with the by-design list above (Lido,
  Morpho Arbitrum, 6 N−1 positions = +$61,729.28 on the Membrane side, the fee compared as
  `seizedUsd − protocolFeeUsd`). The strict comparator catches a single real record moved by
  one block and a single t0 moved by one second.

## 7. Tests

`npx vitest run tests/unit/wavefrontLive*.test.ts` — 84 tests:

- `wavefrontLiveCodec` — both topics decoded from real Oct 10 logs to the CSV rows; a log from
  another registry pool gets that pool's pid; foreign topic / bad shape refused; units equal the
  CSV's normalised columns; the pid module; **the protocol fee on 11 real receipts**; the
  endpoint tables (≥ 2 independent logs groups per chain, no Pocket, no excluded relay).
- `wavefrontLiveReads` — the Aave and Morpho readers against a chain answering the pull's
  recorded reads: same records, same census specs.
- `wavefrontLiveEngine` — the minute loop on a scripted chain (real ABIs, real Multicall3
  calldata): opens / reals / mems / ticks folded by the reducer; one position per (pool, user);
  N−1 locate; a mid-minute open; ONE price multicall per stepped minute across pools and Morpho;
  a position's records equal a kernel fed the path directly; a gap when a value is missing on
  every backend and a re-read when on one; resume after a crash (in-process and new process) =
  the uninterrupted stream; downtime replayed `backfilled`; never past head − confirmations, a log
  in an unconfirmed block that vanishes never emitted; never past the LOWER of two backends'
  heads; a false empty and a short answer caught by the second backend, the host quarantined; an
  event both primary backends missed back as `late` through the background reconciliation; an
  unconfirmable empty not believed.
- `wavefrontLiveLiveness` — the protocol fee taken from the receipt's treasury transfer when it
  differs from the arithmetic; a minute that fails every time ends a historical run; scope
  (forks, a V2-like pool, a non-registry instance excluded and counted; a pool the registry adds mid-stream found; the allow-list; a Morpho signature off the
  singleton); **the reviewer's dedupe repro** (3 failed passes → no duplicate real, $24,600) and
  the capped variant; **a chain down 5 minutes** while the other goes on, caught up `late` with the
  same records per position; **a hanging reconciliation cancelled** at its budget while every
  minute is processed; the gap-close rule; gap positions across a restart; closed positions out
  of the state, a later liquidation of a closed pid, resume; the state flat over 300 minutes.
- `wavefrontLivePostgres` — §5, on a real Postgres (skipped, saying why, where no `initdb` exists).
- `wavefrontLiveRpc` — keyed endpoints from the environment (groups, order, public groups kept),
  no URL in host labels or errors, `PoolKeeper`, cancellation in `CountingRpc`.
- `wavefrontLiveKernel` — 200 random walks: snapshot → JSON → restore mid-walk = uninterrupted;
  a changed field set refused.
- `wavefrontLiveSinks` — the Postgres SQL (guard first, batched inserts with the stream, record-
  less commits, per-stream load; refuse on a seq mismatch or records without a state row; no
  DATABASE_URL at import); the file sink truncating an uncommitted tail and its open-once index;
  the memory sink.

## 8. Live smoke, RPC volume, hosting

### Live smoke (2026-10-14, after the second review: all four chains, file sink, public keyless endpoints)

One stream, three process lifetimes, 27 minutes (minutes 506–532 of the day, 08:26–08:53 UTC),
**no gap**, seq contiguous, the stream folds through the reducer:

| segment | wall time | what happened |
| --- | --- | --- |
| 1 | 08:26:36 – 08:33:54 | created the stream; minutes 506–512; a real liquidation at minute 507 (Morpho Blue, mainnet, wstETH/USDT, $0.51 of debt: `open` walked, `real`, `mem` arm); then **`kill -9`** |
| 2 | 08:36:34 – 08:45:51 | **resumed** at minute 513 (512 had committed just before the kill); background reconciliation every 3 minutes to exercise it live: 7 passes ran, and Base's pass started at minute 518 was **cancelled at its 120 s budget while minutes 519 and 520 were processed on time** — off the minute path; then SIGTERM (clean stop) |
| 3 | 08:46:05 – 08:54:37 | resumed at 522 (`backfilled`: processed 210 s after it ended); production defaults with PublicNode call-only (below); SIGTERM |

- **Checks**: every chunk on two backends — 99 chunks: 98 empty ones confirmed and the one with
  the liquidation returned by both; 0 false empties, 0 short answers, 0 unverified heads; 1 unconfirmable empty (Base, segment 2) retried;
  0 errors; 0 out-of-scope logs in those minutes (the crash replay had 128, §6).
- **Found by the smoke**: PublicNode refuses a logs filter without an address (`-32701 Please
  specify an address`, all three chains) — it is now call-only (eth_call, heads); the other public
  logs backends (Tenderly, dRPC, Blast, base.org, mainnet.optimism.io, arb1) serve topic-only
  filters (they carried the crash replay). **A keyed provider must allow topic-only
  eth_getLogs** (§9).
- **Latency**: minutes processed 50–60 s after they ended (confirmations: mainnet 3 blocks, the
  L2s ≈ 30 s), so a liquidation enters the stream 1–2 minutes after it happens.
- **Resources (calm)**: max RSS 141–155 MB (V8 heap 26–35 MB), CPU 3.1 s over 8.5 min (0.6% of a
  core).

### RPC volume (measured)

| | requests / minute | notes |
| --- | ---: | --- |
| mainnet, calm | ≈ 12 | head polls on TWO backends (≈ 5.6 eth_blockNumber/min: 12 s blocks, ~3 polls before the 3rd confirmation), 2 logs (the chunk on two backends), ~3 headers, ~2 calls |
| each L2, calm | ≈ 6–7 | 2 heads (two backends), 1–2 headers, 2 logs |
| all four chains, calm | **≈ 28–32** | segment 3: 271 requests in 8.49 min, start-up (registry, setups) included; the first build's smoke measured ≈ 20–22 |
| of which new in this review | ≈ +6.5 | the agreed head (a second eth_blockNumber per poll: mainnet +3, each L2 +1.1). A chunk is asked twice as before when empty — calm chunks are — and now also when non-empty: +1 per non-empty chunk (≈ 4 a minute in a crash, 0 in calm). The scope rule: ≈ 3 calls once per new out-of-scope emitter |
| + open positions | + ≈ 2 per chain | one price Multicall3 and ~1 header per chain-minute while anything is walking (a 7-day horizon keeps something walking most of the time) |
| + reconciliation | + ≈ 10 / hour | hourly, a few chunks per chain |
| + per liquidation | ≈ 3.4 | Aave: user multicall at N−1, block states at N−1 and N (shared by every liquidation in the block), the transaction's receipt (the protocol fee); Morpho: state, IRM, price(N). Oct 10 replay: 14,605 requests for 3,408 liquidations in 130 min (2,274 of them receipts) |

**Monthly**: calm ≈ 30/min × 43,200 ≈ **1.3 M**; with positions walking on every chain ≈ 38/min
≈ **1.6 M** (≈ 0.6 requests/s on average); an Oct 10-sized crash day adds ≈ 15–20 k on the day
(the peak minute, 21:19 UTC with 362 liquidations, needs ≈ 1,300 requests). The design draft's
350 k/month underestimated it: every chunk costs two calls (the R33 rule, now for every chunk),
every head poll two, and each poll reads the confirmed block's header.

### Where it runs — options (prices: the parent's 2026-10 lookups, to be re-checked)

| option | what | monthly | trade-off |
| --- | --- | --- | --- |
| **A (recommended)** | always-on Node worker on **Fly.io**, shared-cpu-1x **512 MB**, the Neon sink (or a 1 GB volume for the file sink) | **≈ $3.20** ($1.94 for the 256 MB preset + 0.25 GB × $5 per GB-month; a 1 GB volume ≈ $0.15 more) | true minute cadence, continuous log polling, restart/backfill built in; one more host to watch |
| B | Vercel Pro per-minute cron → a route running one minute per call, state through Neon | $0 marginal if on Pro | best-effort timing, function time limits on crash minutes (the Oct 10 peak minute: 362 liquidations, ≈ 1,300 RPC requests, 12–15 s of processing on public endpoints — and ≈ 2-3 s of reads per minute queue behind rate limits), the whole state round-trips through the DB every minute |
| C | Hetzner CX23 VPS | ≈ €5.49 | as A, more ops (OS, updates, process supervision) |

**Sizing.** Calm: ~150 MB RSS and < 1% CPU. A crash like Oct 10 keeps ~1,500 positions walking
and the replay peaked at 340 MB RSS (heap 156 MB; with walk-on, the census default, and a receipt
cache since cut from 2,000 to 256 per pool reader), so the 256 MB preset is too small for a crash and the
recommendation is **shared-cpu-1x with 512 MB: ≈ $1.94 + 0.25 GB × $5 ≈ $3.20 / month** (plus
≈ $0.15 for a 1 GB volume if the file sink is used). One machine, never two (the minute loop is a
single writer; the Postgres sink's guard refuses a second one). CPU is never the limit.

**Recommendation: A (Fly.io, 512 MB, ≈ $3.20/mo) with the Neon sink**, a keyed RPC provider as the
primary logs and reads backend (`WAVEFRONT_RPC_<CHAIN>`) and the public endpoints as the
independent re-ask and reconciliation backends, and the daily export to membrane-datasets. B is
cheaper only if the project is already on Vercel Pro, and a crash minute (≈ 1,300 requests,
seconds of rate-limited reads) inside a per-minute function invocation, with the full state
round-tripping through the database each minute, is the wrong shape for it. C costs more for the
same thing plus OS work.

## 9. Decisions needed from the owner (nothing below has been done)

1. **Hosting and spend**: A (Fly.io, 512 MB, ≈ $3.20/mo), B (Vercel cron) or C (Hetzner
   ≈ €5.49/mo); who owns the account and the alert on a stalled stream (the stats file's
   `engine.chains.*.pollFailures`, `minutes[].lagging`, `counters.reconcileFailures`).
2. **RPC keys (secrets)**: keyless public endpoints carried the smoke and the crash replay, but
   with rate limits (dRPC, base.org) and Pocket's false empties excluded the redundancy is thin
   (Arbitrum has 2 logs groups). A keyed provider — and ideally a second, independent one — goes
   into the host's secret store as `WAVEFRONT_RPC_MAINNET`, `WAVEFRONT_RPC_ARBITRUM`,
   `WAVEFRONT_RPC_OPTIMISM`, `WAVEFRONT_RPC_BASE` (comma-separated URLs; e.g. `fly secrets set
   WAVEFRONT_RPC_BASE=https://…`), never the repo. Only hostnames are printed. The provider must
   serve **eth_getLogs by topic without an address** over minute-sized ranges (PublicNode's
   free tier does not), and ≈ 1.3–1.6 M requests a month (§8).
3. **Scope beyond the registry**: Aave instances outside the PoolAddressesProviderRegistry are
   excluded by default and counted per emitter. **Horizon RWA** (mainnet, an Aave-run RWA market,
   §4) is the known one: include it (`--allow-aave-provider horizon`) or not. Forks (Spark,
   Seamless, …) stay out under the registry rule.
4. **Neon table in production**: apply `db/migrations-pending/2026-10-14_wavefront_live.sql`
   (or a separate database) and switch to `--sink postgres`. **As part of that step, the drizzle
   trap**: the tables are not in `db/schema.ts`, so `pnpm db:push` would then offer to DROP them
   (data included) — answer no, or declare them in `db/schema.ts` (or exclude them with
   drizzle's `tablesFilter`) together with applying the SQL.
5. **Neon cost of state writes**: the Postgres sink rewrites the state row every minute (43,200
   times a month). The state is ≈ 2 KB + ~3 KB per position walking: a calm
   month with ~50 positions walking writes ≈ 130 KB × 43,200 ≈ 5.6 GB; the simulated month's end
   (604 walking, 1.58 MB) ≈ 68 GB/month; an Oct 10-like crash ≈ 5.7 MB a minute while ~1,500
   positions walk. Neon bills storage including its history window, so this matters. Options:
   gzip the state before writing (7.6× on the Oct 10 state — a small change in the sink), keep
   the file sink on a Fly volume and export daily, or accept the volume.
6. **File-sink backups** (if the file sink is chosen): the JSONL and its `.state` live on one
   volume; a lost volume loses the stream (the engine would start a new one). A daily copy of
   both (the export to membrane-datasets, item 7, can be that copy) or the Neon sink.
7. **Daily export** of the stream to `membrane-datasets` (rule N18) — a schedule.
8. **Going live**: DESIGN_RULES says the wavefront goes live only when it runs in real time on
   every liquidated position; the page stays behind its flag until the owner says so.
9. ~~The census follows the 2.1 rules~~ — done in membrane-app `30a4011` (full scope,
   pool-qualified pids via `lib/wavefront/pid.ts`, N−1 locate, the fee in seized, walked-only
   real totals, schema v2); the engine emits the same schema and §6 compares the two directly.

## 10. Known limits

- **Reorgs.** The confirmations (mainnet 3 blocks ≈ 36 s; OP-stack 15 blocks ≈ 30 s; Arbitrum
  120 blocks ≈ 30 s) protect against the common short reorgs, not against everything: an L2 block
  30 s deep is final only from the sequencer's point of view, **not L1-safe** (that takes the
  batch posted and the L1 block finalised — minutes to ~15 min on OP-stack, longer for Arbitrum);
  a mainnet reorg deeper than 3 blocks is rare but possible. There is **no retraction record** in
  schema v2: a liquidation emitted and later reorged out stays in the stream. The reconciliation
  counts processed events a later pass did not return (`reconcileShort`) — the signal to look at —
  and the hash check stops a scan whose log does not match the header it read.
- A position closed after its horizon that is liquidated again gets `real` records only (one
  `open` per pid in the schema); a new episode would need an episode suffix in the pid.
- The cluster list is fixed (`DEFAULT_OWN_CLUSTERS`, the census's: AERO, CRV, Mog, PEPE, UNI); a
  live stream cannot count a whole window ahead.
- Late and caught-up records carry the append time in `ts` (so the reducer's order holds); their
  own time is `eventTs`. A tick written while a chain lagged does not include that chain's
  records of those minutes (`gaps.lagging` says so); the next ticks do.
- A reconciliation pass that reaches its 24 h cap leaves the stretch before it unchecked (logged
  with the block range, counted).
- Interest after t0 is not accrued (as the census); prices are the minute start's; no venue
  recall, no Membrane-side fee.
