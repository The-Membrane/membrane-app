/**
 * THE MULTI-YEAR CORPUS behind the scale line:
 *
 *   "4% sounds small. It would have kept $X of collateral over the last N years."
 *
 * Owner wants the real figure, so this scans EVERY Aave V3 mainnet LiquidationCall
 * from the Pool's deploy block (16,291,127 — Jan 2023) to head, with NO user filter,
 * clusters each account's events into 24h EPISODES, and replays every episode through
 * the 4% band / 8h window with the SAME ENGINE and the SAME PRICING the per-wallet
 * scanner uses. It imports `replayEpisode` / `clusterEpisodes` from
 * lib/position-sim/history.ts and `feedRounds` / `TOKENS` / `priceAt` / `bonusToFee` /
 * `stEthPerToken` / `dataProviderAbi` from lib/position-sim/historyScan.ts rather than
 * re-deriving any of them: two implementations of one claim is how a landing-page
 * number silently drifts from the thing it claims to measure. (That is why this file
 * is run under tsx — `npx tsx scripts/scan-aave-liquidations.mjs` — a plain `node` run
 * cannot import the TypeScript engine, and a hand-copied engine is the failure mode
 * this whole file exists to avoid.)
 *
 * TWO PHASES, BOTH RESUMABLE. A crash loses at most one chunk or one account.
 *   logs      — chunked getLogs → one row per event in `aave_liquidations`
 *   episodes  — GROUP BY user → cluster → replay → `aave_liquidation_episodes`
 * Resume points live in `aave_scan_cursor`; every insert is ON CONFLICT DO NOTHING, so
 * re-running a partially-done chunk or account is a no-op. Just re-run the command.
 *
 * HONESTY RULES, ENCODED — every one of these is also stated verbatim in the `method`
 * paragraph of public/data/liquidation-corpus.json:
 *   - Membrane's side NEVER assumes a deployment. There is no recall: recall = 0. The
 *     position is the liquidated slice and nothing is pulled back from a venue.
 *   - The fee Membrane is charged is the VENUE'S OWN liquidation bonus at that event's
 *     block (Aave `liquidationBonus − 1`), never a cheaper liquidator.
 *   - The liquidation line is approximated by the SEIZED RESERVE's own liquidation
 *     threshold at the event block. A multi-collateral account's true blended line
 *     needs the full account state at a historical block — several archive reads per
 *     event, which no keyless endpoint will serve. The approximation is named, never
 *     silent.
 *   - `worse` episodes (the Membrane chain cost at least what the real liquidator took)
 *     are COUNTED AND PRINTED, never netted away into the kept figure.
 *   - Episodes nothing in which could be priced are excluded from every dollar figure
 *     and their count is printed.
 *
 * USAGE
 *   npx tsx scripts/scan-aave-liquidations.mjs                  # both phases, to head
 *   npx tsx scripts/scan-aave-liquidations.mjs --phase=logs
 *   npx tsx scripts/scan-aave-liquidations.mjs --phase=episodes
 *   npx tsx scripts/scan-aave-liquidations.mjs --max-blocks=20000   # smoke run
 *   npx tsx scripts/scan-aave-liquidations.mjs --reset              # drop the cursors
 */

import { neon } from '@neondatabase/serverless'
import { createPublicClient, fallback, getAddress, http } from 'viem'
import { mainnet } from 'viem/chains'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

import { readEnv, ROOT } from './lib/venue-reads.mjs'

// --- env FIRST: historyRpcUrls() reads process.env, and tsx gets no Next injection.
const { get } = readEnv()
if (get('RECORDER_RPC_URL')) process.env.RECORDER_RPC_URL = get('RECORDER_RPC_URL')
if (get('NEXT_PUBLIC_MAINNET_RPC_URL'))
  process.env.NEXT_PUBLIC_MAINNET_RPC_URL = get('NEXT_PUBLIC_MAINNET_RPC_URL')

const {
  AAVE_V3_START_BLOCK,
  AAVE_V3_ADDRESSES_PROVIDER,
  AAVE_V3_POOL_FALLBACK,
  LIQUIDATION_CALL,
  providerAbi,
  dataProviderAbi,
  TOKENS,
  feedRounds,
  priceAt,
  bonusToFee,
  stEthPerToken,
  historyRpcUrls,
} = await import('../lib/position-sim/historyScan.ts')

const {
  DEFAULT_REPLAY_PARAMS,
  EPISODE_GAP_SECONDS,
  EPISODE_SPAN_SECONDS,
  clusterEpisodes,
  replayEpisode,
} = await import('../lib/position-sim/history.ts')

// ------------------------------------------------------------------ settings

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? dflt : hit.slice(name.length + 3)
}
const has = (name) => argv.includes(`--${name}`)

const PHASE = flag('phase', 'all')
/** 5,000 blocks. The recorder's RPC ring silently TRUNCATES getLogs past ~20k blocks
 *  per call — it answers 200 with a short list rather than erroring — so the scan never
 *  asks for more than a quarter of that, and additionally halves on any chunk whose
 *  result count comes back at a suspicious round number (see LOG_RESULT_CAP). */
const CHUNK = BigInt(flag('chunk', '5000'))
/** A chunk that returns this many logs is assumed to have hit the endpoint's RESULT cap
 *  and is RE-REQUESTED at half the span — the discarded call's logs are never inserted,
 *  so the guard can only cost requests, never events.
 *
 *  MEASURED 2026-09-22: at 900 this fired on the 5 Aug 2024 crash (blocks 20,456,127+),
 *  which really did print 1,853 LiquidationCalls in 5,000 blocks. Halving showed the
 *  counts scaling sub-linearly with the span (1,853 / 1,608 / 1,275) — the signature of
 *  genuine density, not a cap, which would have repeated one number. The threshold is
 *  therefore 5,000: still far under the 10,000-log cap the public endpoints enforce, and
 *  no longer grinding a real crash down to the 250-block floor. The PRIMARY truncation
 *  defence is the 5,000-block chunk itself (the ring silently truncates past ~20k). */
const LOG_RESULT_CAP = Number(flag('result-cap', '5000'))
const MAX_BLOCKS = flag('max-blocks', null) === null ? null : BigInt(flag('max-blocks'))
const MAX_EPISODE_ACCOUNTS = Number(flag('max-accounts', '0')) || Infinity
/** Every N episodes: a partial summary write and a progress line. */
const SUMMARY_EVERY = Number(flag('summary-every', '2000'))
const PROGRESS_EVERY = Number(flag('progress-every', '500'))
/** Politeness. A keyless endpoint that 429s costs more time than this ever will. */
const RPC_GAP_MS = Number(flag('rpc-gap', '35'))
const BLOCK_TIME_CONCURRENCY = Number(flag('block-concurrency', '4'))

/** Chainlink rounds are fetched in fixed 80,000-block BUCKETS and cached. 80k is not
 *  arbitrary: `feedRounds` carries a hard 40-request budget per aggregator and its span
 *  ladder bottoms out at 2,000 blocks, so 40 x 2,000 = 80,000 is the widest window it
 *  can still finish at its FLOOR. Ask for more and a capped endpoint would silently
 *  return a short round list — which is exactly the failure this bucket size forbids.
 *  A bucket is a strict SUPERSET of the [event − 1,400, event + 72h] window the
 *  per-wallet scanner fetches, and replayEpisode filters rounds by timestamp, so the
 *  replay is identical — only better anchored. */
const ROUND_BUCKET = 80_000n
/** ~12s blocks: the 72h chain window plus slack, matching historyScan's BLOCKS_SPAN. */
const BLOCKS_SPAN = BigInt(Math.ceil(EPISODE_SPAN_SECONDS / 12) + 400)
const BLOCKS_BEFORE = 1_400n

const OUT_PATH = join(ROOT, 'public', 'data', 'liquidation-corpus.json')

// --------------------------------------------------------------------- setup

const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!dbUrl) {
  console.error('No DATABASE_URL_UNPOOLED / DATABASE_URL in .env.local')
  process.exit(1)
}
const sql = neon(dbUrl)

/** The same ring the per-wallet scanner uses (Tenderly public gateway first — the only
 *  keyless endpoint the Oct 10 pull found that serves both archive state and wide
 *  getLogs), built here rather than imported so the scan can hold its own timeouts. */
// THE RING (owner 2026-09-23): probe every candidate for its real getLogs cap, save
// the table, and rotate every log fetch across the endpoints that can serve it, so no
// single free tier carries the job. Re-probed when the saved table is > 6h old.
const { ensureRing, RpcRing } = await import('../lib/position-sim/rpcRing.ts')
const ringTable = await ensureRing(historyRpcUrls())
const ring = new RpcRing(ringTable)
console.log(`rpc ring: ${ringTable.entries.filter((e) => e.cap > 0).map((e) => `${new URL(e.url).host}@${e.cap}`).join(' · ')} (probed ${ringTable.probedAt})`)
const client = ring.readClient()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowIso = () => new Date().toISOString()
const log = (...a) => console.log(`[${nowIso()}]`, ...a)

async function getCursor(name) {
  const rows = await sql`SELECT value FROM aave_scan_cursor WHERE name = ${name}`
  return rows[0]?.value ?? null
}
async function setCursor(name, value) {
  await sql`INSERT INTO aave_scan_cursor (name, value, updated_at) VALUES (${name}, ${String(value)}, now())
            ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`
}

// ------------------------------------------------------------ phase 1: logs

/** Resolve the Pool and its data provider through the addresses provider, exactly as
 *  the per-wallet scanner does; fall back to the never-moved proxy constant. */
async function resolveAave() {
  let pool = AAVE_V3_POOL_FALLBACK
  let dataProvider = null
  try {
    pool = await client.readContract({
      address: AAVE_V3_ADDRESSES_PROVIDER,
      abi: providerAbi,
      functionName: 'getPool',
    })
    dataProvider = await client.readContract({
      address: AAVE_V3_ADDRESSES_PROVIDER,
      abi: providerAbi,
      functionName: 'getPoolDataProvider',
    })
  } catch (e) {
    log('addresses provider read failed, using the Pool constant:', String(e).slice(0, 120))
  }
  return { pool, dataProvider }
}

const blockTimeCache = new Map()

/** Block timestamps for the blocks a chunk actually touched, resolved with a small
 *  concurrency pool. A failed read RETRIES once and then throws — an event with no
 *  timestamp cannot be placed on the timeline at all, and silently dropping it would
 *  quietly shrink the corpus. */
async function blockTimes(blocks) {
  const todo = blocks.filter((b) => !blockTimeCache.has(b.toString()))
  let i = 0
  const worker = async () => {
    while (i < todo.length) {
      const b = todo[i++]
      let last
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const blk = await client.getBlock({ blockNumber: b })
          blockTimeCache.set(b.toString(), Number(blk.timestamp))
          last = null
          break
        } catch (e) {
          last = e
          await sleep(300 * (attempt + 1))
        }
      }
      if (last) throw last
      if (RPC_GAP_MS) await sleep(RPC_GAP_MS)
    }
  }
  await Promise.all(Array.from({ length: BLOCK_TIME_CONCURRENCY }, worker))
  const out = new Map()
  for (const b of blocks) out.set(b.toString(), blockTimeCache.get(b.toString()))
  return out
}

async function insertEvents(rows) {
  if (rows.length === 0) return
  await sql`
    INSERT INTO aave_liquidations
      (block, block_time, tx_hash, log_index, "user", collateral_asset, debt_asset,
       debt_to_cover, liquidated_collateral_amount, liquidator)
    SELECT * FROM UNNEST(
      ${rows.map((r) => r.block)}::bigint[],
      ${rows.map((r) => r.blockTime)}::timestamptz[],
      ${rows.map((r) => r.txHash)}::text[],
      ${rows.map((r) => r.logIndex)}::int[],
      ${rows.map((r) => r.user)}::text[],
      ${rows.map((r) => r.collateralAsset)}::text[],
      ${rows.map((r) => r.debtAsset)}::text[],
      ${rows.map((r) => r.debtToCover)}::numeric[],
      ${rows.map((r) => r.liquidatedCollateralAmount)}::numeric[],
      ${rows.map((r) => r.liquidator)}::text[]
    )
    ON CONFLICT (tx_hash, log_index) DO NOTHING`
}

async function phaseLogs() {
  const { pool } = await resolveAave()
  log(`phase logs — Aave V3 Pool ${pool}`)

  // FREEZE the head at the first run so a scan resumed days later keeps one stable
  // toBlock, and therefore one stable denominator for the whole corpus.
  let headStr = await getCursor('logs_head')
  if (!headStr) {
    headStr = (await client.getBlockNumber()).toString()
    await setCursor('logs_head', headStr)
  }
  const head = BigInt(headStr)

  let cursor = BigInt((await getCursor('logs')) ?? AAVE_V3_START_BLOCK.toString())
  if (BigInt(ring.maxCap()) < CHUNK) log(`chunk ${CHUNK} exceeds the ring's widest cap ${ring.maxCap()} — the ring splits it`)
  const toBlock = MAX_BLOCKS === null ? head : bigMin(cursor + MAX_BLOCKS - 1n, head)
  log(`blocks ${cursor} → ${toBlock} (head ${head}), chunk ${CHUNK}`)

  let span = CHUNK
  let events = 0
  let chunks = 0
  const started = Date.now()

  while (cursor <= toBlock) {
    const to = bigMin(cursor + span - 1n, toBlock)
    let logs
    try {
      logs = await ring.getLogs({
        address: pool,
        event: LIQUIDATION_CALL,
        fromBlock: cursor,
        toBlock: to,
      })
    } catch (e) {
      if (span > 250n) {
        span /= 2n
        log(`getLogs failed at ${cursor}, halving span to ${span}: ${String(e).slice(0, 140)}`)
        continue
      }
      log(`getLogs failed at the ${span}-block floor from ${cursor} — backing off 30s`)
      await sleep(30_000)
      continue
    }
    // THE TRUNCATION GUARD. The ring answers an over-wide getLogs with a SHORT LIST,
    // not an error, so a chunk that comes back at the result cap is presumed cut off
    // and is re-requested at half the span rather than believed.
    if (logs.length >= LOG_RESULT_CAP && span > 250n) {
      span /= 2n
      log(`chunk ${cursor}-${to} returned ${logs.length} logs (>= cap) — halving span to ${span}`)
      continue
    }

    // A log whose indexed borrower did not decode cannot be attributed to an account
    // and is dropped with a count, never guessed at.
    const decoded = logs.filter((l) => l.args?.user && l.args?.collateralAsset && l.args?.debtAsset)
    if (decoded.length !== logs.length) {
      log(`WARNING: ${logs.length - decoded.length} undecodable LiquidationCall logs in ${cursor}-${to}`)
    }
    if (decoded.length > 0) {
      const uniqueBlocks = [...new Set(decoded.map((l) => l.blockNumber))]
      const times = await blockTimes(uniqueBlocks)
      await insertEvents(
        decoded.map((l) => ({
          block: l.blockNumber.toString(),
          blockTime: new Date(times.get(l.blockNumber.toString()) * 1000).toISOString(),
          txHash: l.transactionHash,
          logIndex: Number(l.logIndex),
          user: getAddress(l.args.user).toLowerCase(),
          collateralAsset: getAddress(l.args.collateralAsset).toLowerCase(),
          debtAsset: getAddress(l.args.debtAsset).toLowerCase(),
          debtToCover: (l.args.debtToCover ?? 0n).toString(),
          liquidatedCollateralAmount: (l.args.liquidatedCollateralAmount ?? 0n).toString(),
          liquidator: getAddress(l.args.liquidator).toLowerCase(),
        })),
      )
      events += decoded.length
    }

    cursor = to + 1n
    await setCursor('logs', cursor.toString())
    chunks += 1
    // Climb back toward the configured chunk once a narrowed span is surviving.
    if (span < CHUNK && chunks % 20 === 0) span = bigMin(span * 2n, CHUNK)
    if (chunks % 100 === 0) {
      const done = Number(cursor - AAVE_V3_START_BLOCK)
      const total = Number(head - AAVE_V3_START_BLOCK)
      const rate = done / ((Date.now() - started) / 1000 || 1)
      log(
        `logs: block ${cursor} (${((done / total) * 100).toFixed(2)}%), ${events} events this run, ` +
          `~${((total - done) / rate / 3600).toFixed(1)}h left at ${Math.round(rate)} blk/s`,
      )
    }
    // Honest progress: the summary the page reads is refreshed during phase 1 too, so
    // a half-scanned corpus shows a half-scanned number rather than yesterday's.
    if (chunks % 500 === 0) await writeSummary(true)
    if (RPC_GAP_MS) await sleep(RPC_GAP_MS)
  }

  if (cursor > head) await setCursor('logs_done', '1')
  log(`phase logs complete to ${cursor - 1n} — ${events} events inserted this run`)
  await writeSummary(true)
}

const bigMin = (a, b) => (a < b ? a : b)

// -------------------------------------------------------- phase 2: episodes

/** Chainlink rounds, bucketed and cached. See ROUND_BUCKET for why 80,000. */
const roundBuckets = new Map()
async function roundsBucket(feed, index) {
  const key = `${feed}:${index}`
  const hit = roundBuckets.get(key)
  if (hit) return hit
  const from = AAVE_V3_START_BLOCK + BigInt(index) * ROUND_BUCKET
  const to = from + ROUND_BUCKET - 1n
  const got = await feedRounds(client, feed, from, to, Date.now() + 15 * 60_000, ring)
  roundBuckets.set(key, got)
  return got
}
async function roundsOver(feed, fromBlock, toBlock) {
  const lo = fromBlock < AAVE_V3_START_BLOCK ? AAVE_V3_START_BLOCK : fromBlock
  const first = Number((lo - AAVE_V3_START_BLOCK) / ROUND_BUCKET)
  const last = Number((toBlock - AAVE_V3_START_BLOCK) / ROUND_BUCKET)
  const out = []
  for (let i = first; i <= last; i++) out.push(...(await roundsBucket(feed, i)))
  return out.sort((a, b) => a.ts - b.ts)
}

/** The reserve's liquidation threshold and the venue's own bonus AT THE EVENT BLOCK,
 *  falling back to the current block when the node refuses archive state — the same
 *  two-step, and the same `usedCurrentParams` disclosure, as the per-wallet scanner. */
const lineCache = new Map()
let usedCurrentParams = 0
let archiveReads = 0
async function lineFor(dataProvider, collAddr, blockNumber) {
  const key = `${collAddr}:${blockNumber}`
  if (lineCache.has(key)) return lineCache.get(key)
  const read = async (b) =>
    client.readContract({
      address: dataProvider,
      abi: dataProviderAbi,
      functionName: 'getReserveConfigurationData',
      args: [collAddr],
      ...(b === undefined ? {} : { blockNumber: b }),
    })
  let out = null
  const t0 = Date.now()
  try {
    const cfg = await read(blockNumber)
    archiveReads += 1
    out = { line: Number(cfg[2]) / 10_000, fee: bonusToFee(cfg[3]) }
  } catch {
    try {
      const cfg = await read()
      usedCurrentParams += 1
      out = { line: Number(cfg[2]) / 10_000, fee: bonusToFee(cfg[3]) }
    } catch {
      out = null
    }
  }
  if (out && !(out.line > 0)) out = null
  T.line += Date.now() - t0; T.n.line++
  lineCache.set(key, out)
  return out
}

// Per-step wall-clock (owner asked where the minute per account goes).
const T = { line: 0, rounds: 0, wrap: 0, n: { line: 0, rounds: 0, wrap: 0 } }
const timed = async (k, f) => { const t = Date.now(); try { return await f() } finally { T[k] += Date.now() - t; T.n[k]++ } }
const wrapCache = new Map()
async function wrapAt(blockNumber) {
  const key = blockNumber.toString()
  if (wrapCache.has(key)) return wrapCache.get(key)
  const v = await timed('wrap', () => stEthPerToken(client, blockNumber))
  wrapCache.set(key, v)
  return v
}

/**
 * Replay ONE account's whole history: cluster into 24h episodes, price each one, and
 * walk the Membrane chain over the 72h after the episode's last event — capped at the
 * next episode's first event so Membrane is never charged twice for the same days
 * (owner boundary ruling 2026-09-12, same as historyScan).
 */
async function replayAccount(user, rows, dataProvider) {
  const hits = rows.map((r) => ({
    ts: Number(r.ts),
    blockNumber: BigInt(r.block),
    collAddr: r.collateral_asset,
    debtAddr: r.debt_asset,
    collRaw: BigInt(r.liquidated_collateral_amount),
    debtRaw: BigInt(r.debt_to_cover),
  }))
  const clusters = clusterEpisodes(
    hits.filter((h) => h.ts > 0),
    EPISODE_GAP_SECONDS,
  )
  const out = []

  for (const [ci, cluster] of clusters.entries()) {
    const firstBlock = cluster[0].blockNumber
    const lastBlock = cluster[cluster.length - 1].blockNumber
    const from = firstBlock > BLOCKS_BEFORE ? firstBlock - BLOCKS_BEFORE : 0n
    const to = lastBlock + BLOCKS_SPAN
    const lastTs = cluster[cluster.length - 1].ts
    const nextStartTs = clusters[ci + 1]?.[0]?.ts
    const spanSeconds =
      nextStartTs !== undefined
        ? Math.max(0, Math.min(EPISODE_SPAN_SECONDS, nextStartTs - lastTs))
        : EPISODE_SPAN_SECONDS
    const spanEndTs = lastTs + spanSeconds

    const roundsFor = async (meta, ts) => {
      if (meta.pricing.kind === 'stable') {
        return [
          { ts: ts - 1, price: 1 },
          { ts: spanEndTs, price: 1 },
        ]
      }
      return timed('rounds', () => roundsOver(meta.pricing.feed, from, to))
    }

    const priced = []
    const labels = []
    let actualSeizedUsd = 0
    let actualRepaidUsd = 0
    let unpricedEvents = 0

    for (const h of cluster) {
      const coll = TOKENS[h.collAddr]
      const debt = TOKENS[h.debtAddr]
      labels.push(coll?.symbol ?? h.collAddr.slice(0, 10))
      if (!coll || !debt) {
        unpricedEvents += 1
        continue
      }
      const cfg = await lineFor(dataProvider, h.collAddr, h.blockNumber)
      if (!cfg) {
        unpricedEvents += 1
        continue
      }
      const collRounds = await roundsFor(coll, h.ts)
      const collPrice = coll.pricing.kind === 'stable' ? 1 : priceAt(collRounds, h.ts)
      const debtPrice =
        debt.pricing.kind === 'stable' ? 1 : priceAt(await roundsFor(debt, h.ts), h.ts)
      if (collPrice === null || debtPrice === null) {
        unpricedEvents += 1
        continue
      }
      const collWrap = coll.pricing.kind === 'wsteth' ? await wrapAt(h.blockNumber) : 1
      const debtWrap = debt.pricing.kind === 'wsteth' ? await wrapAt(h.blockNumber) : 1
      const collateralSeizedUsd = (Number(h.collRaw) / 10 ** coll.decimals) * collPrice * collWrap
      const debtRepaidUsd = (Number(h.debtRaw) / 10 ** debt.decimals) * debtPrice * debtWrap
      actualSeizedUsd += collateralSeizedUsd
      actualRepaidUsd += debtRepaidUsd
      priced.push({
        hl: {
          ts: h.ts,
          collateralSeizedUsd,
          debtRepaidUsd,
          ltvAtEvent: cfg.line,
          liqLine: cfg.line,
        },
        meta: coll,
        fee: cfg.fee,
      })
    }

    const collateral = [...new Set(labels)].join(' + ')
    if (priced.length === 0) {
      out.push({
        user,
        startTs: cluster[0].ts,
        endTs: lastTs,
        collateral,
        actualSeizedUsd: 0,
        actualRepaidUsd: 0,
        membraneSeizedUsd: 0,
        membraneLiquidations: 0,
        verdict: 'unknown',
        unpriced: true,
        eventCount: cluster.length,
        unpricedEvents,
        why: unpricedEvents === cluster.length ? 'no event in this episode could be priced (token map / line / rounds)' : 'no priced event',
      })
      continue
    }

    // The ANCHOR is the first priced event: its collateral carries the price path, its
    // market carries the line and the FEE — the venue's own bonus, never a cheaper one.
    const anchor = priced[0]
    const r = replayEpisode(
      priced.map((p) => p.hl),
      await roundsFor(anchor.meta, anchor.hl.ts),
      { ...DEFAULT_REPLAY_PARAMS, liqFee: anchor.fee, spanSeconds },
    )
    out.push({
      user,
      startTs: cluster[0].ts,
      endTs: lastTs,
      collateral,
      actualSeizedUsd,
      actualRepaidUsd,
      membraneSeizedUsd: r.membraneSeizedUsd,
      membraneLiquidations: r.membraneLiquidations,
      verdict: r.verdict,
      unpriced: r.verdict === 'unknown',
      eventCount: cluster.length,
      unpricedEvents,
      why: r.why,
    })
  }
  return out
}

async function insertEpisodes(eps) {
  if (eps.length === 0) return
  const n = (x) => (Number.isFinite(x) ? String(x) : '0')
  await sql`
    INSERT INTO aave_liquidation_episodes
      ("user", start_ts, end_ts, collateral, actual_seized_usd, actual_repaid_usd,
       membrane_seized_usd, membrane_liquidations, verdict, unpriced, event_count,
       unpriced_events, why)
    SELECT * FROM UNNEST(
      ${eps.map((e) => e.user)}::text[],
      ${eps.map((e) => String(e.startTs))}::bigint[],
      ${eps.map((e) => String(e.endTs))}::bigint[],
      ${eps.map((e) => e.collateral.slice(0, 200))}::text[],
      ${eps.map((e) => n(e.actualSeizedUsd))}::numeric[],
      ${eps.map((e) => n(e.actualRepaidUsd))}::numeric[],
      ${eps.map((e) => n(e.membraneSeizedUsd))}::numeric[],
      ${eps.map((e) => e.membraneLiquidations)}::int[],
      ${eps.map((e) => e.verdict)}::text[],
      ${eps.map((e) => e.unpriced)}::boolean[],
      ${eps.map((e) => e.eventCount)}::int[],
      ${eps.map((e) => e.unpricedEvents)}::int[],
      ${eps.map((e) => e.why ?? null)}::text[]
    )
    ON CONFLICT ("user", start_ts) DO UPDATE SET
      end_ts = EXCLUDED.end_ts, collateral = EXCLUDED.collateral,
      actual_seized_usd = EXCLUDED.actual_seized_usd, actual_repaid_usd = EXCLUDED.actual_repaid_usd,
      membrane_seized_usd = EXCLUDED.membrane_seized_usd, membrane_liquidations = EXCLUDED.membrane_liquidations,
      verdict = EXCLUDED.verdict, unpriced = EXCLUDED.unpriced, event_count = EXCLUDED.event_count,
      unpriced_events = EXCLUDED.unpriced_events, why = EXCLUDED.why
    -- Only rows from before the why column existed (the dead-ring era, replayed with
    -- no working getLogs endpoint) are corrected; a tagged row is never overwritten.
    WHERE aave_liquidation_episodes.why IS NULL`
}

async function phaseEpisodes() {
  // An episode is a CLUSTER of an account's events, so replaying an account before the
  // log scan has finished would cluster a PARTIAL history and commit a wrong episode
  // under a primary key that ON CONFLICT DO NOTHING would then never correct. The
  // phase therefore refuses to start until the log scan is done; --force-episodes is
  // for smoke runs only, and --reset clears the episodes it wrote.
  if ((await getCursor('logs_done')) !== '1' && !has('force-episodes')) {
    log('phase episodes SKIPPED — the log scan has not finished (pass --force-episodes to override)')
    return
  }
  const { dataProvider } = await resolveAave()
  if (!dataProvider) {
    console.error('No Aave V3 PoolDataProvider — every line read would fail. Aborting.')
    process.exit(1)
  }
  log(`phase episodes — data provider ${dataProvider}`)

  let userCursor = (await getCursor('episodes')) ?? ''
  let accounts = 0
  let episodes = 0
  const started = Date.now()

  for (;;) {
    const batch = await sql`
      SELECT DISTINCT "user" FROM aave_liquidations
      WHERE "user" > ${userCursor} ORDER BY "user" LIMIT 200`
    if (batch.length === 0) break

    for (const { user } of batch) {
      const rows = await sql`
        SELECT block, extract(epoch FROM block_time)::bigint AS ts, collateral_asset,
               debt_asset, debt_to_cover, liquidated_collateral_amount
        FROM aave_liquidations WHERE "user" = ${user} ORDER BY block, log_index`
      let eps = []
      try {
        eps = await replayAccount(user, rows, dataProvider)
      } catch (e) {
        // A replay that throws is a BUG or a dead endpoint, not a result. Do not commit
        // a cursor past it — stop so the resume re-attempts this exact account.
        log(`replay failed for ${user}: ${String(e).slice(0, 200)} — stopping (resumable)`)
        await writeSummary(true)
        process.exit(1)
      }
      await insertEpisodes(eps)
      userCursor = user
      await setCursor('episodes', userCursor)
      ring.saveStats('aave-episodes')
      console.log('rpc ring:', ring.stats().map((s) => `${s.host} ${s.ok}/${s.calls} ${(s.blocks / 1000).toFixed(0)}k blk ${s.avgMs}ms`).join(' · '),
        `| t line ${(T.line / 1000).toFixed(1)}s/${T.n.line} rounds ${(T.rounds / 1000).toFixed(1)}s/${T.n.rounds} wrap ${(T.wrap / 1000).toFixed(1)}s/${T.n.wrap} total ${((Date.now() - started) / 1000).toFixed(0)}s`)
      accounts += 1
      episodes += eps.length

      if (episodes > 0 && episodes % PROGRESS_EVERY < eps.length) {
        const per = (Date.now() - started) / 1000 / Math.max(1, episodes)
        log(
          `episodes: ${episodes} replayed over ${accounts} accounts this run ` +
            `(${per.toFixed(2)}s/episode, ${usedCurrentParams} current-param fallbacks)`,
        )
      }
      if (episodes > 0 && episodes % SUMMARY_EVERY < eps.length) await writeSummary(true)
      if (accounts >= MAX_EPISODE_ACCOUNTS) {
        log(`--max-accounts reached (${accounts})`)
        await writeSummary(true)
        return
      }
    }
  }
  await setCursor('episodes_done', '1')
  log(`phase episodes complete — ${episodes} episodes over ${accounts} accounts this run`)
}

// ---------------------------------------------------------------- summary

/**
 * THE METHOD PARAGRAPH — same discipline as historyScan's buildMethod: what is
 * measured, what is approximated, what is excluded, in one readable paragraph that
 * names every approximation this scan actually made.
 */
function buildMethod(x) {
  return [
    `Every Aave V3 mainnet LiquidationCall from the Pool's deploy block ${x.fromBlock.toLocaleString('en-US')} (Dec 2022) through block ${x.toBlock.toLocaleString('en-US')}, decoded from logs with NO address filter and no per-wallet event cap — ${x.events.toLocaleString('en-US')} events across ${x.accounts.toLocaleString('en-US')} liquidated accounts.`,
    `Events on one account within 24 hours of each other are ONE EPISODE — one crash, one position — and Membrane's side of an episode is a CHAIN, not a single sale: the position starts at its liquidation line carrying the debt the liquidators actually repaid, is repriced by the Chainlink rounds that really printed, and is walked for 72 hours past the episode's last event (capped at the next episode's first event, so no day is charged twice). Crossing the line arms an 8-hour timer; a climb past the 4% break band sells immediately; a return to the borrow line (liquidation line − 3pp) clears the timer with nothing sold; a window that expires still over the cap is a repay-to-cap, after which the position CONTINUES and can be liquidated again. This is the same engine (lib/position-sim/history.ts replayEpisode) and the same pricing the per-wallet scanner runs.`,
    `MEMBRANE'S SIDE NEVER ASSUMES A DEPLOYMENT: there is no venue recall, recall = 0. The fee Membrane is charged is the SOURCE VENUE'S OWN liquidation bonus at that event's block (Aave liquidationBonus − 1), never a cheaper liquidator.`,
    `The account's liquidation line is APPROXIMATED by the seized reserve's own liquidation threshold read at the event block${x.usedCurrentParams > 0 ? ` (${x.usedCurrentParams.toLocaleString('en-US')} reads fell back to the current block where the node refused archive state)` : ''}, and the LTV at the event is taken to equal that line — an account being liquidated was at or over it by definition. A multi-collateral account's true blended line is a value-weighted average of its reserves, which needs the full account state at a historical block and is not cheaply readable; the single-reserve threshold is the honest approximation and it is stated here rather than hidden.`,
    `Stablecoins are held at $1.00; wstETH is priced as stETH/USD × stEthPerToken; every other asset is priced off its Chainlink USD feed's AnswerUpdated rounds. Assets with no committed price source are UNPRICED: ${x.unpricedEpisodes.toLocaleString('en-US')} of ${x.episodes.toLocaleString('en-US')} episodes could not be priced at all and are excluded from every dollar figure here, counted in neither direction, and a further ${x.unpricedEventCount.toLocaleString('en-US')} individual events inside otherwise-priced episodes contributed nothing — so the actual-seized side is a floor, not a total.`,
    `Episodes where the Membrane chain cost AT LEAST what the real liquidator took are counted as 'worse' (${x.worseCount.toLocaleString('en-US')} of them) and are included in membraneSeizedUsd at full weight — they are never netted away to flatter the kept figure. keptUsd is actualSeizedUsd − membraneSeizedUsd over priced episodes only.`,
    `NOT COVERED: Spark, Morpho Blue, Compound V3, Fluid and every non-mainnet chain. This corpus is Aave V3 mainnet alone — one venue, one event shape, one set of reserve configs — so the figure is a floor on the liquidation universe, not a total.`,
    x.partial
      ? `PARTIAL: this scan is still running. Figures cover the ${x.episodes.toLocaleString('en-US')} episodes replayed so far, not the whole corpus.`
      : '',
  ]
    .filter(Boolean)
    .join(' ')
}

async function writeSummary(partial) {
  const [ev] = await sql`
    SELECT count(*)::int AS events, count(DISTINCT "user")::int AS accounts,
           min(block_time) AS from_date, max(block_time) AS to_date
    FROM aave_liquidations`
  // fromBlock/toBlock are the SCANNED RANGE, not the first and last event: during a
  // partial run the distinction is the difference between "we have looked at 1.2M of
  // 9.7M blocks" and a figure that silently reads as complete. fromDate/toDate are the
  // first and last event actually observed — the window the scale line's N years spans.
  const scannedTo = BigInt((await getCursor('logs')) ?? AAVE_V3_START_BLOCK.toString()) - 1n
  const [ep] = await sql`
    SELECT count(*)::int AS episodes,
           count(*) FILTER (WHERE NOT unpriced)::int AS priced,
           count(*) FILTER (WHERE unpriced)::int AS unpriced,
           coalesce(sum(actual_seized_usd)   FILTER (WHERE NOT unpriced), 0)::float8 AS actual_seized,
           coalesce(sum(actual_repaid_usd)   FILTER (WHERE NOT unpriced), 0)::float8 AS actual_repaid,
           coalesce(sum(membrane_seized_usd) FILTER (WHERE NOT unpriced), 0)::float8 AS membrane_seized,
           count(*) FILTER (WHERE verdict = 'saved')::int   AS saved,
           count(*) FILTER (WHERE verdict = 'partial')::int AS partial_n,
           count(*) FILTER (WHERE verdict = 'broke')::int   AS broke,
           count(*) FILTER (WHERE verdict = 'worse')::int   AS worse,
           coalesce(sum(unpriced_events), 0)::int            AS unpriced_events
    FROM aave_liquidation_episodes`
  const byYearEp = await sql`
    SELECT extract(year FROM to_timestamp(start_ts))::int AS year,
           coalesce(sum(actual_seized_usd), 0)::float8 AS actual_seized,
           coalesce(sum(membrane_seized_usd), 0)::float8 AS membrane_seized
    FROM aave_liquidation_episodes WHERE NOT unpriced GROUP BY 1 ORDER BY 1`
  const byYearEv = await sql`
    SELECT extract(year FROM block_time)::int AS year, count(*)::int AS events
    FROM aave_liquidations GROUP BY 1 ORDER BY 1`
  const byColl = await sql`
    SELECT collateral,
           count(*)::int AS episodes,
           coalesce(sum(actual_seized_usd), 0)::float8 AS actual_seized,
           coalesce(sum(membrane_seized_usd), 0)::float8 AS membrane_seized
    FROM aave_liquidation_episodes WHERE NOT unpriced
    GROUP BY 1 ORDER BY 3 DESC LIMIT 8`

  const evYears = new Map(byYearEv.map((r) => [r.year, r.events]))
  const years = [...new Set([...byYearEp.map((r) => r.year), ...evYears.keys()])].sort()
  const byYear = years.map((year) => {
    const e = byYearEp.find((r) => r.year === year)
    const a = e?.actual_seized ?? 0
    const m = e?.membrane_seized ?? 0
    return {
      year,
      events: evYears.get(year) ?? 0,
      actualSeizedUsd: round2(a),
      membraneSeizedUsd: round2(m),
      keptUsd: round2(a - m),
    }
  })

  const doc = {
    protocol: 'Aave V3 mainnet',
    fromBlock: Number(AAVE_V3_START_BLOCK),
    toBlock: Number(scannedTo < AAVE_V3_START_BLOCK ? AAVE_V3_START_BLOCK : scannedTo),
    fromDate: ev.from_date ? new Date(ev.from_date).toISOString() : null,
    toDate: ev.to_date ? new Date(ev.to_date).toISOString() : null,
    events: ev.events,
    accounts: ev.accounts,
    episodes: ep.episodes,
    pricedEpisodes: ep.priced,
    unpricedEpisodes: ep.unpriced,
    /** Individual events inside otherwise-priced episodes that had no committed price
     *  source. They contribute nothing to actualSeizedUsd, so the actual side is a
     *  FLOOR — printed, never absorbed. */
    unpricedEvents: ep.unpriced_events,
    actualSeizedUsd: round2(ep.actual_seized),
    actualRepaidUsd: round2(ep.actual_repaid),
    membraneSeizedUsd: round2(ep.membrane_seized),
    keptUsd: round2(ep.actual_seized - ep.membrane_seized),
    savedCount: ep.saved,
    partialCount: ep.partial_n,
    brokeCount: ep.broke,
    worseCount: ep.worse,
    byYear,
    byCollateral: byColl.map((r) => ({
      collateral: r.collateral,
      episodes: r.episodes,
      actualSeizedUsd: round2(r.actual_seized),
      membraneSeizedUsd: round2(r.membrane_seized),
      keptUsd: round2(r.actual_seized - r.membrane_seized),
    })),
    method: buildMethod({
      fromBlock: Number(AAVE_V3_START_BLOCK),
      toBlock: Number(scannedTo < AAVE_V3_START_BLOCK ? AAVE_V3_START_BLOCK : scannedTo),
      unpricedEventCount: ep.unpriced_events,
      events: ev.events,
      accounts: ev.accounts,
      episodes: ep.episodes,
      unpricedEpisodes: ep.unpriced,
      worseCount: ep.worse,
      usedCurrentParams,
      partial,
    }),
    partial,
    generatedAt: nowIso(),
  }

  mkdirSync(join(ROOT, 'public', 'data'), { recursive: true })
  writeFileSync(OUT_PATH, `${JSON.stringify(doc, null, 2)}\n`)
  log(
    `summary${partial ? ' (partial)' : ''} → public/data/liquidation-corpus.json — ` +
      `${doc.events} events, ${doc.episodes} episodes, kept $${Math.round(doc.keptUsd).toLocaleString('en-US')}`,
  )
  return doc
}

const round2 = (x) => Math.round((Number(x) || 0) * 100) / 100

// -------------------------------------------------------------------- main

if (has('reset')) {
  // Cursors and EPISODES go; the event rows stay. An event row is an immutable decoded
  // fact keyed by (tx_hash, log_index) and re-scanning it is a no-op, but an episode is
  // a derived clustering that a partial scan can get wrong — so it is always rebuilt.
  await sql`DELETE FROM aave_scan_cursor`
  await sql`DELETE FROM aave_liquidation_episodes`
  log('cursors and derived episodes cleared (event rows kept — they are idempotent)')
}
if (has('reset-events')) {
  await sql`DELETE FROM aave_liquidations`
  log('event rows cleared')
}

if (PHASE === 'logs' || PHASE === 'all') await phaseLogs()
if (PHASE === 'episodes' || PHASE === 'all') await phaseEpisodes()

const logsDone = (await getCursor('logs_done')) === '1'
const epDone = (await getCursor('episodes_done')) === '1'
await writeSummary(!(logsDone && epDone))
log('done')
