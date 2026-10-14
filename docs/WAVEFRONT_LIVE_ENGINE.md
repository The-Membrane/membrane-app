# Wavefront live engine — Real vs Membrane in real time (Q28 step 2)

**Status: BUILT AND VERIFIED, NOT DEPLOYED — PENDING OWNER APPROVAL.** Nothing here is
deployed, scheduled, paid for or written to a production database. The Dockerfile and
`fly.toml` in `deploy/wavefront-live/` and the SQL in `db/migrations-pending/` are prepared,
not applied. §9 lists what the owner decides.

For every liquidation on **every Aave V3 pool** (the PoolAddressesProviderRegistry's markets:
mainnet Core, Lido and EtherFi; the Core pool on Arbitrum, Optimism and Base) and on **Morpho
Blue** on Ethereum, Arbitrum, Optimism and Base, the engine

1. sees the liquidation about a minute after it happens (logs read to head − confirmations);
2. reads the position at block N−1 and the oracle prices at N−1 and N exactly as the Oct 10
   pull read them, and locates it — at the N prices, or, when an oracle update later in block N
   hides the breach, at the N−1 prices with the debt accrued to ts(N);
3. starts a Membrane kernel for the same position (the census's spec, class rule and mixed
   split; `lib/wavefront/kernel.ts`);
4. steps every open kernel once a minute with that minute's on-chain oracle prices;
5. appends both sides to the wavefront stream (`docs/WAVEFRONT.md` §3, schema v1).

The Oct 10 census writes the same stream from the recorded window; `--mode historical` runs
**this** engine, unchanged, on a simulated clock over archive blocks, and §6 compares the two.

---

## 1. Code

| file | what |
| --- | --- |
| `lib/wavefront/live/engine.ts` | `LiveEngine`: the minute loop, positions, ticks, lifecycle, reconciliation, durable state; `SimClock`, `clockHead` (historical) / `liveHead` |
| `lib/wavefront/live/logs.ts` | `LogScanner`: eth_getLogs for both topics on every pool, chunked; false-empty re-ask; reconciliation on independent backends |
| `lib/wavefront/live/blocks.ts` | headers and the block in force at a time (`atOrBefore`, the pull's rule) |
| `lib/wavefront/live/aaveRead.ts` | registry markets, per-pool setup, the per-event re-read (pull shape, `computeHf` from the pull), N−1 locate with Aave's index math, the liquidation protocol fee |
| `lib/wavefront/live/morphoRead.ts` | market params, the per-event re-read (accrual and health check as the pull), N−1 locate |
| `lib/wavefront/live/prices.ts` | one Multicall3 per chain per minute; re-read of missing values on another backend |
| `lib/wavefront/live/positions.ts` | spec → `open` / `real` / kernels with the census's own functions; kernel snapshots |
| `lib/wavefront/live/sinks.ts` | `FileSink` (JSONL + state, crash-safe), `PostgresSink` (Neon via an injected executor), `MemorySink` |
| `lib/wavefront/live/state.ts`, `codec.ts`, `config.ts`, `rpc.ts`, `calls.ts` | state types, event decoding, chain constants, the RPC seam and endpoint table |
| `lib/wavefront/pid.ts` | **the pid builder** (one module; the census adopts it later) |
| `scripts/wavefront-live/run.ts` | CLI (`--mode live|historical`, `--from`, `--to`, `--chains`, `--out`, `--sink file|postgres`, `--stats`) |
| `scripts/wavefront-live/compare-census.ts` | the historical-equivalence check (§6) |
| `scripts/wavefront-live/make-fixture.ts` | the readers' test fixture from the pull's records |
| `tests/unit/wavefrontLive*.test.ts` | 57 tests (§7) |
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
created on, so tick minutes are :09, :19, …). It is processed once **every** chain has been
scanned through a confirmed block with timestamp ≥ S_m+60. Then:

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
5. **close** — a position whose kernels are done, or idle for the horizon (default 7 days) with
   no timer armed, stops being stepped (it stays in the stream; a later liquidation of the same
   pid is a `real` record);
6. **reconcile** every hour (default; window 2 h) — §4;
7. **commit** the minute's records and the engine state in one sink commit.

A minute processed more than 180 s after it ended (restart, outage) has every record flagged
`backfilled: true`; its logs and prices are archive reads, so the stream has no gaps. Any error
in a minute rolls the engine back to the last commit and the minute is retried with backoff.

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
- **Locating t0 at N−1**: not liquidatable at the N prices (read at the END of block N) → retried
  at the N−1 prices with every balance accrued to ts(N) using Aave's own index math (aave-v3-origin
  v3.5.0, the Oct 10 pools' revision 9: `MathUtils.sol:23-34, 79-84`, `ReserveLogic.sol:39-78`,
  `TokenMath.sol:66-71, 108-113`; checked on each use by accruing to ts(N−1) and getting the read
  balances back) / Morpho's accrual (already to ts(N)) with price(N−1). Located there → walked
  from the N−1 prices, `open.priceBasis: 'N-1'`. Neither → `walked: false` with the reason.
- **Real seized includes the Aave protocol fee**: `liquidatedCollateralAmount` is the
  liquidator's share. aave-v3-origin v3.5.0 `LiquidationLogic.sol` :224-237 (bonus: the e-mode
  category's when the collateral is in the borrower's category, else the reserve's), :644-653
  (`bonusCollateral = X − X.percentDiv(bonus)`, `fee = bonusCollateral.percentMul(protocolFee)`,
  `X −= fee`), :422-430 (the event emits X − fee). The engine inverts L = X − fee(X) exactly (an
  integer search around L·bonus·1e4 / (bonus·1e4 − (bonus − 1e4)·fee)); from revision 11 (v3.7.0
  :615-622) the rounding is percentDivFloor / percentMulCeil and the pool's `POOL_REVISION` picks
  it. Checked on 11 Oct 10 receipts (all four chains, one e-mode): the fee equals the treasury's
  aToken Transfer **exactly** in all 11. `real.seizedUsd` = (L + fee) × price(N),
  `real.protocolFeeUsd` = fee × price(N).
- **Reducer change** (owner review item 5: real totals over walked positions only) lives in
  `lib/wavefront/stream.ts` and is picked up unchanged by the engine (it folds with
  `applyRecord`).
- **Not a census rule — look-ahead.** The census anchors t0 at a LATER event when the first is not
  located (1 account on Oct 10-11). A live stream cannot look ahead and the schema allows one
  `open` per pid: such a position opens `walked: false` at its first event.

## 4. Data sources and checks

- **Events**: one eth_getLogs filter per chain — addresses [every registry pool, Morpho Blue],
  topic0 ∈ {`LiquidationCall` 0xe413a321…5286, `Liquidate` 0xa4946ede…7e41} — chunked (span
  halves on a range refusal). Every log is checked (emitter, topic, block in range, not removed,
  blockHash = the header used for its timestamp; logs' own `blockTimestamp` is not trusted —
  arb1.arbitrum.io returns 0 there).
- **Registry**: mainnet 0xbaA999AC…5170 (Core 0x87870Bca…, Lido 0x4e033931…, EtherFi
  0x0AA97c28…), Arbitrum/Optimism 0x770ef9f4…52b6, Base 0x2f6571d3…78E2; resolved at start-up
  and daily; the Core pool and oracle are asserted against the verified addresses.
- **An empty answer is not a fact** (board R33): every empty chunk is re-asked on a different
  backend group before it counts. A second backend with logs → the first host is quarantined for
  logs (1 h) and the fuller answer kept. No independent backend → `UnconfirmedEmptyError`: the
  range is not believed, narrower spans are tried (some hosts cap logs at 10 blocks), and the
  minute waits. Pocket/Nodies are never asked for logs (probe 2026-10-14 on minute-sized ranges
  around 20 known Oct 10 events per chain: Pocket mainnet missed 2/20, Optimism 13/20, OP Nodies
  20/20, all as `[]` or short answers); flashbots/mevblocker are excluded (asserted).
- **Reconciliation**: every hour the last two hours are re-scanned, each part on a backend group
  that did not answer it in the primary scan; a missed event is processed then and its records
  carry `late: true`, `eventTs` (its own time) and ts = the append time (the reducer requires
  ordered ts); a late position is caught up minute by minute on archive prices. Each chain's pass
  has a 120 s budget: a pass that cannot run (independent backends rate-limiting) is counted, and
  the next one starts where the last success ended — it never holds the stream.
- **Reorgs**: nothing above head − confirmations is read (mainnet 3 blocks, the L2s ≈ 30 s:
  OP-stack 15, Arbitrum 120).
- **Prices**: §2 step 1; per-asset re-read when one source reverts the batch (the pull's rule).

## 5. Durable state, sinks

The state (stream position, per chain the scanned block, pending events, recent event keys and
the answering group of every recent logs chunk, the reducer's fold, every open kernel as a field
snapshot, counters) is committed with each minute's records:

- **file**: append-only JSONL (`encodeJsonl`'s format; the header adds `engine`, `mode`,
  `chains`, `createdAt`; `window.minutes` is 0 = open-ended) + `<file>.state`. Records are
  fsync'ed, then the state is written to a temp file, fsync'ed and renamed; it records the JSONL
  length it belongs to, and on load a longer JSONL (a torn or uncommitted tail) is truncated
  back. Restoring a kernel snapshot checks its field set against a fresh kernel and refuses a
  mismatch (kernel.ts changed under a saved state).
- **Postgres** (Neon, `@neondatabase/serverless`, driver loaded only with `--sink postgres`;
  `DATABASE_URL` read only by the CLI): one transaction per minute — a guard that aborts unless
  the stored state is the one this writer last committed (two writers cannot both commit), the
  records as `INSERT INTO wavefront_events (seq, ts, kind, pid, body)` (≤ 1,000 rows per
  statement), and the state row update. Tables in `db/migrations-pending/` (append-only trigger
  on the events table). **Not applied.**

## 6. Verification against the Oct 10-11 census (`--mode historical`)

**Slice**: 2025-10-10T20:50Z → 23:00Z (minutes 1,250–1,379): all four chains, both protocols,
the crash peak (21:13–21:20, up to 1,337 records a minute). The engine starts cold at 20:50
(`--mode historical`, simulated clock, archive blocks, the same code as live) and its stream is
compared with the census's for every position the census **opened inside the slice**, on every
minute inside it (`scripts/wavefront-live/compare-census.ts`; numbers within 1e-6 relative —
USD are cents on both sides — after mapping Core-pool pids to the census's form).

The kernel default moved while this was built (the census branch makes "walk on after a t0 band
sale" the default; the datasets `replay.jsonl.gz` was rebuilt with it at membrane-app
`afbf41f`). So the engine was run twice and compared with the census of the same kernel:

| run | census compared with | positions | `open` | `real` | `mem` (sales) | differences |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| default kernel of this branch's base (`7ce3f9e`, walk-on off) | served `public/data/oct10-2025/wavefront-replay.json` (same base) | 2,628 | 2,628 | 3,330 | 6,840 (2,628) | **0** besides the by-design items below |
| `--walk-on true` (the census's new default) | datasets `oct10-2025/coverage/replay.jsonl.gz` (`afbf41f`) | 2,628 | 2,628 | 3,330 | 7,017 (2,748) | **0** besides the by-design items below |

- **Same positions**: all 2,628 census positions opened in the slice are found (0 missing). Real
  repaid is identical on both runs: **$178,575,112.08**.
- **By design (owner review 2.1), all explained**:
  - **6 positions located at the N−1 prices** (`priceBasis: 'N-1'`): the census's 5 "HF at block
    N ≥ 1" accounts in the slice (Optimism 0xd2f2…, 0x1b2c…, 0xf70c… (mixed); mainnet 0x1326…,
    0x5ade…) are walked here, and the one account the census anchored at its SECOND event
    (Optimism 0xcb92…) is located at its first. Their open fields (collUsd, ltv0, walked) and
    mem records differ by construction; together they are the WHOLE Membrane-side difference:
    $143,740,188.72 vs $143,678,459.44 = **+$61,729.28 = their sales** ($86,647.34 here vs
    $24,918.06 in the census).
  - **Real seized includes the Aave protocol fee**: $881,054.62 in the slice. Compared as
    `seizedUsd − protocolFeeUsd`, every Aave record equals the census within one cent (655 of
    them by exactly one cent: both figures are rounded to cents separately).
- **Outside the census** (in the live stream, not compared): 17 Morpho Blue positions on
  **Arbitrum** (the owner's event pull had Morpho on mainnet and Base only), 3 positions on the
  mainnet **Lido** pool (the census is Core-only); 51 positions the census had opened before
  20:50 and the cold-started engine opened at their first in-slice event.
- **Checks along the way**: the health factor recomputed at N−1 equals getUserAccountData to the
  wei on **all 2,632** Aave events; 384 empty logs chunks confirmed by a second backend, 0 false
  empties, 0 unconfirmed; 0 gaps (no held leg's oracle value missing on every backend); 0 errors;
  the stream folds through the reducer (13 ticks equal to the fold).
- **Cost of the replay**: 12,155 RPC requests (12,604 HTTP attempts with retries) for 130 minutes,
  3,408 liquidations, 2,699 positions: 9.6 min wall, 79 s CPU, max RSS 381 MB (heap 135 MB, about
  1,500 positions walking). The slowest minute (21:20, 1,158 records) took 11.9 s. With the
  hourly reconciliation on (the first run), a rate-limiting independent backend held a minute
  for up to 11 min — hence the 120 s per-chain reconciliation budget (§4).
- **Not reproducible by design**: the census's look-ahead t0 shift (none left in this slice
  once N−1 locating is on).


## 7. Tests

`npx vitest run tests/unit/wavefrontLive*.test.ts` — 57 tests:

- `wavefrontLiveCodec` — both topics decoded from real Oct 10 logs to the CSV rows; a log from
  another registry pool gets that pool's pid; foreign emitter / topic / bad shape refused; units
  equal the CSV's normalised columns; the pid module; **the protocol fee on 11 real receipts**;
  the endpoint tables (≥ 2 independent logs groups per chain, no Pocket, no excluded relay).
- `wavefrontLiveReads` — the Aave and Morpho readers against a chain answering the pull's
  recorded reads: same records, same census specs.
- `wavefrontLiveEngine` — the minute loop on a scripted chain (real ABIs, real Multicall3
  calldata): opens / reals / mems / ticks folded by the reducer; one position per (pool, user);
  N−1 locate; a mid-minute open; ONE price multicall per stepped minute across pools and Morpho;
  a position's records equal a kernel fed the path directly; a gap when a value is missing on
  every backend and a re-read when on one; resume after a crash (in-process and new process) =
  the uninterrupted stream; downtime replayed `backfilled`; never past head − confirmations, a log
  in an unconfirmed block that vanishes never emitted; a false empty caught and its host
  quarantined; a missed event back as `late` through the reconciliation; an unconfirmable empty
  not believed.
- `wavefrontLiveKernel` — 200 random walks: snapshot → JSON → restore mid-walk = uninterrupted;
  a changed field set refused.
- `wavefrontLiveSinks` — the Postgres SQL (guard, batched inserts, state update; refuse on a seq
  mismatch; no DATABASE_URL at import); the file sink truncating an uncommitted tail; the memory
  sink.

## 8. Live smoke, RPC volume, hosting

### Live smoke (2026-10-14, all four chains, file sink, public keyless endpoints)

One stream, four process lifetimes, 54 minutes (minutes 359–412 of the day, 05:59–06:53 UTC)
with **no gap**:

| segment | wall time | what happened |
| --- | --- | --- |
| 1 | 05:59:30 – 06:14:46 | created the stream; 14 minutes processed; then **`kill -9`** mid-wait |
| 2 | 06:19:08 – 06:26:13 | **resumed** at minute 373; minutes 373–375 replayed `backfilled` (376–377 were under the 180 s lag), then live |
| 3 | 06:33:30 – 06:38:06 | resumed after a clean stop; minutes 385–390 replayed `backfilled`, **including the tick of minute 389** (a backfilled record) |
| 4 | 06:42:14 – 06:54:37 | resumed (395–398 backfilled); 12 minutes with the production defaults (hourly reconciliation) for the RPC measurement |

- **Seen**: 0 liquidations (a calm market — none on any of the 6 pools or 4 Morpho deployments
  in those 54 minutes); 6 ticks written (`coverage 0/0`); blocks scanned: mainnet 270, Arbitrum
  11,495, Optimism 1,624, Base 1,624; Aave markets resolved from the registry: mainnet 3 (Core,
  Lido, EtherFi), one on each L2.
- **False-empty defence**: every empty chunk was re-asked on a second backend group (mainnet
  64, Arbitrum 37, Optimism 37, Base 37 in the stream's life); 0 contradicted, 0 unconfirmable.
- **Latency**: each minute was processed 58–62 s after it ended (confirmations: mainnet 3 blocks,
  the L2s ≈ 30 s), so a liquidation enters the stream 1–2 minutes after it happens.
- **Errors**: 0 minutes failed in segments 1, 2 and 4; Base's reconciliation pass hit its 120 s
  budget once (segment 3, run every 5 min there to exercise it) because its independent logs
  backends were rate-limiting (mainnet.base.org answered `request limit reached` to 85% of its
  calls, dRPC and PublicNode to some) — skipped and covered by the next pass, as designed.
- **Resources (calm)**: max RSS 146–158 MB (V8 heap 26–35 MB; most of the RSS is Node + the
  TypeScript loader), CPU 3.1 s over 12.35 min (0.4% of a core).

### RPC volume (measured)

| | requests / minute | notes |
| --- | ---: | --- |
| mainnet, calm | ≈ 7.5 | 12 s blocks: ~3 head polls before the 3rd confirmation lands, 2 logs (the empty answer + its re-ask), ~2.5 headers |
| each L2, calm | ≈ 4.2 | 1 head, 1 header, 2 logs |
| all four chains, calm | **≈ 20** | segment 4: 276 requests in 12.35 min, start-up (registry, setups) included |
| + open positions | + ≈ 2 per chain | one price Multicall3 and ~1 header per chain-minute while anything is walking (a 7-day horizon keeps something walking most of the time) |
| + reconciliation | + ≈ 10 / hour | hourly, a few chunks per chain |
| + per liquidation | ≈ 2.7 | Aave: user multicall at N−1, block states at N−1 and N (shared by every liquidation in the block); Morpho: state, IRM, price(N). Oct 10 replay: 12,155 requests for 3,408 liquidations in 130 min |

**Monthly**: calm ≈ 20/min × 43,200 ≈ **0.86 M**; with positions walking on every chain ≈ 28/min
≈ **1.2 M** (≈ 0.5 requests/s on average); an Oct 10-sized crash day adds ≈ 15–20 k on the day
(the peak minute, 21:19 UTC with 362 liquidations, needs ≈ 1,000 requests). The design draft's
350 k/month underestimated it: every empty logs answer costs a second call (the R33 rule) and
each poll reads the confirmed block's header.


### Where it runs — options (prices: the parent's 2026-10 lookups, to be re-checked)

| option | what | monthly | trade-off |
| --- | --- | --- | --- |
| **A (recommended)** | always-on Node worker on **Fly.io**, shared-cpu-1x 256 MB, 1 GB volume for the file sink (or the Neon sink) | **≈ $1.94** (+$5 per GB-month of extra RAM; a 1 GB volume ≈ $0.15) | true minute cadence, continuous log polling, restart/backfill built in; one more host to watch |
| B | Vercel Pro per-minute cron → a route running one minute per call, state through Neon | $0 marginal if on Pro | best-effort timing, function time limits on crash minutes (the Oct 10 peak minute: 362 liquidations, ≈ 1,000 RPC requests, 11.9 s of processing on public endpoints — and ≈ 2-3 s of reads per minute queue behind rate limits), the whole state round-trips through the DB every minute |
| C | Hetzner CX23 VPS | ≈ €5.49 | as A, more ops (OS, updates, process supervision) |

**Sizing.** Calm: ~150 MB RSS and < 1% CPU — the 256 MB shared-cpu-1x preset fits. A crash
like Oct 10 keeps ~1,500 positions walking and the replay peaked at **381 MB RSS** (135 MB heap),
so the recommendation is **shared-cpu-1x with 512 MB: ≈ $1.94 + 0.25 GB × $5 ≈ $3.20 / month**
(plus a 1 GB volume for the file sink, ≈ $0.15, or the Neon sink and no volume). One machine,
never two (the minute loop is a single writer; the Postgres sink's guard refuses a second one).
CPU is never the limit: the whole 130-minute crash replay used 79 s of CPU.

**Recommendation: A (Fly.io, 512 MB, ≈ $3.20/mo) with the Neon sink**, a keyed RPC provider as the
primary logs and reads backend and the public endpoints as the independent re-ask and
reconciliation backends, and the daily export to membrane-datasets. B is cheaper only if the
project is already on Vercel Pro, and a crash minute (≈ 1,000 requests, seconds of rate-limited
reads) inside a per-minute function invocation, with the full state round-tripping through the
database each minute, is the wrong shape for it. C costs more for the same thing plus OS work.

## 9. Decisions needed from the owner (nothing below has been done)

1. **Hosting and spend**: A (Fly.io ≈ $2/mo), B (Vercel cron) or C (Hetzner ≈ €5.49/mo); who
   owns the account and the alert on a stalled stream.
2. **RPC keys (secrets)**: keyless public endpoints carried the smoke and the crash replay, but
   with rate limits (drpc, base official) and Pocket's false empties excluded the redundancy is
   thin on Arbitrum (2 logs groups). A keyed provider (and a second one for the independent
   re-ask) is the reliable choice; keys go into the host's secret store, never the repo.
3. **Neon table in production**: apply `db/migrations-pending/2026-10-14_wavefront_live.sql`
   (or a separate database) and switch to `--sink postgres`.
4. **Daily export** of the stream to `membrane-datasets` (rule N18) — a schedule.
5. **Going live**: DESIGN_RULES says the wavefront goes live only when it runs in real time on
   every liquidated position; the page stays behind its flag until the owner says so.
6. **The census follows** the 2.1 rules (all pools, pool-qualified pids via `lib/wavefront/pid.ts`,
   N−1 locate, gaps, protocol fee, walked-only real totals) so replay and live agree again.

## 10. Known limits

- A position closed after its horizon that is liquidated again gets `real` records only (one
  `open` per pid in schema v1); a new episode would need an episode suffix in the pid.
- The cluster list is fixed (`DEFAULT_OWN_CLUSTERS`, the census's: AERO, CRV, Mog, PEPE, UNI); a
  live stream cannot count a whole window ahead.
- The reducer state keeps every position ever opened (~1-2 KB each) — fine for months; archive
  it if the stream runs for years.
- Late records carry the append time in `ts` (so the reducer's order holds); their own time is
  `eventTs`. A compact re-encoding would rebuild their mem ts from t0.
- Interest after t0 is not accrued (as the census); prices are the minute start's; no venue
  recall, no Membrane-side fee.
