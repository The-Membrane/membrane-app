#!/usr/bin/env node
// Oracle registry collector (Ethereum mainnet): raw readings for every catalog entry.
//
//   node scripts/oracle-registry/collect.mjs                 # snapshot + 30-day history
//   node scripts/oracle-registry/collect.mjs --snapshot-only # just the current snapshot
//   node scripts/oracle-registry/collect.mjs --at-block=N    # one archive snapshot (not latest)
//   options: --days=30 --step=3600 (archive grid, seconds) --gov-days=180 (governance
//            look-back for changes.json) --fresh (drop a resumable run)
//            --keep-cache (keep data/oracle-registry/.cache after a successful run)
//
// Writes (all raw, in each entry's own quote unit — the engine in lib/oracleRegistry/ does
// USD normalization, consensus and colours):
//   data/oracle-registry/snapshots/<iso>.json + snapshots/latest.json   current readings,
//       component ages, on-chain mechanism params (for the change detector), catalog config
//   data/oracle-registry/snapshots/<iso of window start>.json            the same at the
//       window's first block (seeds the event series; diff it against latest for changes)
//   data/oracle-registry/history/<id>.json  { source, points: [[ts, price(, updatedAt)]] }
//   data/oracle-registry/history/index.json  per-entry source + point count
//   data/oracle-registry/changes.json        governance events over --gov-days (CAPO caps,
//       PT discount rate, market source swaps, Chainlink aggregator swaps, Chronicle bar…)
//
// History sources, best first:
//   chainlink_rounds — AnswerUpdated on the proxy's aggregator (head + window-start phase)
//   events           — Chronicle Poked, RedStone ValueUpdate/AnswerUpdated, Pyth
//                      PriceFeedUpdate (on-chain pushes only: Pyth's off-chain history is paid)
//   archive_sampling — Multicall3 eth_call at a fixed grid of archive blocks (views, TWAPs,
//                      lending-market adapters, and any event feed whose events were not found)
//   none_public      — nothing readable (the card says so)
//
// RPC: RECORDER_RPC_URL (.env.local, comma list). eth_getLogs goes to the keyed Ankr endpoint
// (10k-block spans, measured 2026-09-23) with Infura as backup; free tiers refuse log scans.
// URLs are never printed: every error string is scrubbed. Resumable: grid samples and log
// chunks are appended to data/oracle-registry/.cache/*.jsonl and skipped on the next run.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  fallback,
  getAddress,
  hexToString,
  http,
  parseAbiItem,
  toEventSelector,
  toHex,
} from 'viem'
import { ROOT, readEnv, makeClient } from '../lib/venue-reads.mjs'
import {
  MULTICALL3,
  SIG,
  abiOf,
  agesFromComponents,
  componentCalls,
  configOf,
  decodeComponents,
  decodeParams,
  decodePrice,
  guardProcessErrors,
  paramCalls,
  priceCalls,
  scrub,
  sig9,
  storageParams,
} from './lib/readers.mjs'
import { crossCheckedRange } from './lib/confirmLogs.mjs'

// Any failure that escapes (a top-level await on an RPC call) prints scrubbed, never the URL.
guardProcessErrors('oracle-registry collect')

const args = process.argv.slice(2)
const flag = (k) => args.includes(`--${k}`)
const argVal = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`))
  return a ? a.slice(k.length + 3) : d
}
const DAYS = Number(argVal('days', '30'))
const STEP = Number(argVal('step', '3600'))
const SNAPSHOT_ONLY = flag('snapshot-only')
const FRESH = flag('fresh')
const KEEP_CACHE = flag('keep-cache')
// Config changes are rare (the last Aave Core AssetSourceUpdated was ~100 days before this
// was written), so governance events get a longer look-back than prices.
const GOV_DAYS = Number(argVal('gov-days', '180'))
const LOG_SPAN = 10_000n
const CHUNK_CALLS = 40
const GRID_CONCURRENCY = 3
const LOG_CONCURRENCY = 2

const OUT = join(ROOT, 'data', 'oracle-registry')
const SNAP_DIR = join(OUT, 'snapshots')
const HIST_DIR = join(OUT, 'history')
const CACHE = join(OUT, '.cache')
const CATALOG = join(OUT, 'catalog.json')

// ---- RPC -----------------------------------------------------------------------------------
// ORACLE_REGISTRY_RPC_URL in the environment overrides .env.local: a test hook (the unit test
// points it at a dead local port) and a way to aim a one-off run at another endpoint.
const urls = String(process.env.ORACLE_REGISTRY_RPC_URL || readEnv().get('RECORDER_RPC_URL') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
if (!urls.length) {
  console.error('RECORDER_RPC_URL missing from .env.local')
  process.exit(1)
}
const hostOf = (u) => {
  try {
    return new URL(u).host
  } catch {
    return ''
  }
}
const state = makeClient(urls.join(','))
const logUrls = [
  ...urls.filter((u) => hostOf(u).includes('ankr')),
  ...urls.filter((u) => hostOf(u).includes('infura')),
]
const logClientOf = (list) =>
  createPublicClient({
    chain: defineChain({
      id: 1,
      name: 'Ethereum',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: list } },
    }),
    transport:
      list.length === 1
        ? http(list[0], { timeout: 30_000, retryCount: 1 })
        : fallback(
            list.map((u) => http(u, { timeout: 30_000, retryCount: 1 })),
            { rank: false },
          ),
  })
const logClient = logUrls.length ? logClientOf(logUrls) : null
// Fail-closed audit (MISSED collect.mjs:811): an EMPTY log answer is confirmed on a second,
// independent endpoint (a distinct host) before it is believed — the governance events feed the
// config cards' OR-1 / AD-9 rows. No second host: an empty answer is never confirmed (the run
// stops at that chunk, "re-run to resume"; the cards list the stale window as a read gap).
const logPair = []
for (const u of [...logUrls, ...urls])
  if (!logPair.some((x) => hostOf(x) === hostOf(u))) logPair.push(u)
const logPrimary = logPair[0] ? logClientOf([logPair[0]]) : null
const logSecondary = logPair[1] ? logClientOf([logPair[1]]) : null

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function retry(fn, tries = 3) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      await sleep(400 * 2 ** i)
    }
  }
  throw last
}
async function pool(items, n, worker) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++
        out[k] = await worker(items[k], k)
      }
    }),
  )
  return out
}
const isoName = (ts) =>
  new Date(ts * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-')
// fail-closed audit (PO-07 / MISSED-1): every write goes through a temp file and a rename — a full
// disk mid-write truncated changes.json, and the config cards then read it as "no events"
const writeJson = (path, obj) => {
  const tmp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, JSON.stringify(obj) + '\n')
    renameSync(tmp, path)
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* the original error is the one to report */
    }
    throw e
  }
}

// ---- batched reads -------------------------------------------------------------------------
/**
 * Executes call specs at one block. specs: {entryId, tag, address, sig, args?, direct?, slot?}.
 * Returns Map(entryId → Map(tag → {ok, value, error})) and the block timestamp when asked.
 */
async function execCalls(specs, blockNumber, wantTs = false) {
  const res = new Map()
  const put = (s, r) => {
    if (!res.has(s.entryId)) res.set(s.entryId, new Map())
    res.get(s.entryId).set(s.tag, r)
  }
  const multi = specs.filter((s) => !s.direct && s.slot == null)
  let ts = null
  for (let i = 0; i < multi.length || (wantTs && ts == null && i === 0); i += CHUNK_CALLS) {
    const chunk = multi.slice(i, i + CHUNK_CALLS)
    const contracts = chunk.map((s) => {
      const abi = abiOf(s.sig)
      return { address: s.address, abi, functionName: abi[0].name, args: s.args ?? [] }
    })
    const withTs = wantTs && ts == null
    if (withTs)
      contracts.push({
        address: MULTICALL3,
        abi: abiOf(SIG.blockTimestamp),
        functionName: 'getCurrentBlockTimestamp',
      })
    const out = await retry(() =>
      state.multicall({ contracts, allowFailure: true, blockNumber, batchSize: 1_000_000 }),
    )
    chunk.forEach((s, k) => {
      const r = out[k]
      put(
        s,
        r.status === 'success'
          ? { ok: true, value: r.result }
          : { ok: false, error: scrub(r.error?.shortMessage || r.error?.message) },
      )
    })
    if (withTs && out[out.length - 1]?.status === 'success') ts = Number(out[out.length - 1].result)
  }
  // Chronicle: tolled reads pass only as an eth_call from address(0) — no Multicall3.
  await pool(
    specs.filter((s) => s.direct),
    3,
    async (s) => {
      const abi = abiOf(s.sig)
      try {
        const value = await retry(
          () =>
            state.readContract({
              address: s.address,
              abi,
              functionName: abi[0].name,
              args: s.args ?? [],
              blockNumber,
            }),
          2,
        )
        put(s, { ok: true, value })
      } catch (e) {
        put(s, { ok: false, error: scrub(e?.shortMessage || e?.message) })
      }
    },
  )
  for (const s of specs.filter((x) => x.slot != null)) {
    try {
      const value = await retry(() =>
        state.getStorageAt({ address: s.address, slot: toHex(s.slot, { size: 32 }), blockNumber }),
      )
      put(s, { ok: true, value })
    } catch (e) {
      put(s, { ok: false, error: scrub(e?.shortMessage || e?.message) })
    }
  }
  return { res, ts }
}

const tagSpecs = (e, calls) => calls.map((c) => ({ ...c, entryId: e.id }))

async function takeSnapshot(catalog, blockNumber) {
  const specs = []
  for (const e of catalog.entries) {
    specs.push(
      ...tagSpecs(e, [
        ...priceCalls(e),
        ...componentCalls(e),
        ...paramCalls(e),
        ...storageParams(e),
      ]),
    )
  }
  const { res } = await execCalls(specs, blockNumber)
  const ts = Number((await retry(() => state.getBlock({ blockNumber }))).timestamp)
  const entries = catalog.entries.map((e) => {
    const sub = res.get(e.id) ?? new Map()
    const d = decodePrice(e, sub)
    const row = { id: e.id, price: d.price, updatedAt: d.updatedAt }
    const comps =
      d.updatedAt == null || e.mechanism.timestampIsReadTime ? decodeComponents(e, sub) : []
    if (comps.length) row.components = comps
    if (Object.keys(d.extras).length) row.extras = d.extras
    if (d.warnings.length) row.warnings = d.warnings
    if (d.error) row.error = d.error
    row.params = decodeParams(e, sub)
    row.config = configOf(e)
    return row
  })
  return {
    version: 1,
    chainId: 1,
    block: Number(blockNumber),
    ts,
    catalogGeneratedAt: catalog.generatedAt,
    entries,
  }
}

/**
 * One archive grid point: every non-tolled entry's price at `block`, plus the updatedAt of
 * each clocked component for views that take their age from their legs (so the history
 * replay judges staleness exactly as the snapshot does), in a few batched eth_calls.
 */
async function sampleBlock(entries, block) {
  const specs = []
  for (const e of entries)
    specs.push(
      ...tagSpecs(
        e,
        [...priceCalls(e), ...componentCalls(e)].filter((c) => !c.direct),
      ),
    )
  const { res, ts } = await execCalls(specs, BigInt(block), true)
  const r = {}
  const c = {}
  for (const e of entries) {
    const sub = res.get(e.id) ?? new Map()
    const d = decodePrice(e, sub)
    if (d.price == null) continue
    r[e.id] = d.updatedAt ? [sig9(d.price), d.updatedAt] : [sig9(d.price)]
    const legs = agesFromComponents(e) ? decodeComponents(e, sub) : []
    if (legs.length) c[e.id] = Object.fromEntries(legs.map((x) => [x.role, x.updatedAt]))
  }
  return { b: block, ts, r, ...(Object.keys(c).length ? { c } : {}) }
}

// ---- events --------------------------------------------------------------------------------
const PRICE_EVENTS = {
  au: parseAbiItem(
    'event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)',
  ),
  pk: parseAbiItem('event Poked(address indexed caller, uint128 val, uint32 age)'),
  vu: parseAbiItem('event ValueUpdate(uint256 value, bytes32 dataFeedId, uint256 updatedAt)'),
}
const PYTH_EVENT = parseAbiItem(
  'event PriceFeedUpdate(bytes32 indexed id, uint64 publishTime, int64 price, uint64 conf)',
)
const GOV_EVENTS = [
  'event CapParametersUpdated(uint256 snapshotRatio, uint256 snapshotTimestamp, uint256 maxRatioGrowthPerSecond, uint16 maxYearlyRatioGrowthPercent)',
  'event PriceCapUpdated(int256 priceCap)',
  'event DiscountRatePerYearUpdated(uint64 oldDiscountRatePerYear, uint64 newDiscountRatePerYear)',
  'event AssetSourceUpdated(address indexed asset, address indexed source)',
  'event FallbackOracleUpdated(address indexed fallbackOracle)',
  'event BarUpdated(address indexed caller, uint8 oldBar, uint8 newBar)',
  'event Upgraded(address indexed implementation)',
  'event AggregatorProposed(address indexed current, address indexed proposed)',
  'event AggregatorConfirmed(address indexed previous, address indexed latest)',
  'event FeedLifted(address indexed caller, address indexed feed)',
  'event FeedDropped(address indexed caller, address indexed feed)',
  'event TollGranted(address indexed caller, address indexed who)',
  'event TollRenounced(address indexed caller, address indexed who)',
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
].map((s) => parseAbiItem(s))
const TOPIC = Object.fromEntries(
  Object.entries(PRICE_EVENTS).map(([k, ev]) => [toEventSelector(ev), k]),
)
const GOV_BY_TOPIC = new Map(GOV_EVENTS.map((ev) => [toEventSelector(ev), ev]))

const bytes32ToString = (h) => hexToString(h, { size: 32 }).replace(/\0+$/g, '')
const lower = (a) => String(a).toLowerCase()

/** Which events (if any) carry this entry's price history. */
function eventPlan(e, head, base) {
  if (e.provider === 'chronicle') return { kind: 'pk', addresses: [e.address], source: 'events' }
  if (e.provider === 'pyth') return { kind: 'py', id: lower(e.readArgs[0]), source: 'events' }
  if (e.provider === 'redstone') {
    const adapter = e.mechanism.components.find((c) => c.role === 'adapter')?.address
    if (adapter && lower(adapter) !== lower(e.address) && e.mechanism.dataFeedId)
      return { kind: 'vu', addresses: [adapter], id: e.mechanism.dataFeedId, source: 'events' }
    // single-feed RedStone adapters: AnswerUpdated (and possibly ValueUpdate) on the feed itself
    return { kind: 'au', addresses: [e.address], id: e.mechanism.dataFeedId, source: 'events' }
  }
  if (e.provider === 'chainlink' && e.readMethod === 'latestRoundData()') {
    const aggs = [...new Set([head?.params?.aggregator, base?.params?.aggregator].filter(Boolean))]
    if (aggs.length) return { kind: 'au', addresses: aggs, source: 'chainlink_rounds' }
  }
  return null
}

async function getLogsAdaptive(params, depth = 0, client = logClient) {
  try {
    return await retry(() => client.getLogs(params), 2)
  } catch (e) {
    const span = params.toBlock - params.fromBlock
    if (span < 500n || depth > 6) throw e
    const mid = params.fromBlock + span / 2n
    const a = await getLogsAdaptive({ ...params, toBlock: mid }, depth + 1, client)
    const b = await getLogsAdaptive({ ...params, fromBlock: mid + 1n }, depth + 1, client)
    return [...a, ...b]
  }
}

/**
 * One range, every piece of it confirmed (throws when it cannot be). Fail-closed review
 * (2026-10-10, OC-4 / rules #2): the split on a failing primary now happens OUTSIDE the
 * cross-check (`crossCheckedRange`): each half is checked on its own. It ran inside
 * `getLogsAdaptive` and only the joined answer was checked, so a false-empty half next to a
 * non-empty one was accepted, its log lost and the chunk cached as read.
 */
const oneRange = (client, params) => (fromBlock, toBlock) =>
  retry(() => client.getLogs({ ...params, fromBlock, toBlock }), 2)
const confirmedRange = (params) =>
  crossCheckedRange(
    oneRange(logPrimary ?? logClient, params),
    logSecondary ? oneRange(logSecondary, params) : null,
    params.fromBlock,
    params.toBlock,
  )

const jsonArgs = (args) =>
  Object.fromEntries(
    Object.entries(args || {}).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]),
  )

async function scanChunk(from, to, plan) {
  const rows = []
  const raw = await confirmedRange({
    address: plan.emitters,
    fromBlock: BigInt(from),
    toBlock: BigInt(to),
  })
  for (const l of raw) {
    const t0 = l.topics[0]
    const a = getAddress(l.address)
    const b = Number(l.blockNumber)
    const kind = TOPIC[t0]
    try {
      if (kind && plan.priceEmitters.has(lower(a))) {
        const d = decodeEventLog({ abi: [PRICE_EVENTS[kind]], data: l.data, topics: l.topics })
        if (kind === 'au')
          rows.push({ a, k: 'au', v: d.args.current.toString(), t: Number(d.args.updatedAt), b })
        else if (kind === 'pk')
          rows.push({ a, k: 'pk', v: d.args.val.toString(), t: Number(d.args.age), b })
        else {
          const id = bytes32ToString(d.args.dataFeedId)
          if (plan.feedIds.has(id))
            rows.push({
              a,
              k: 'vu',
              id,
              v: d.args.value.toString(),
              t: Number(d.args.updatedAt),
              b,
            })
        }
        continue
      }
      const gov = GOV_BY_TOPIC.get(t0)
      if (gov) {
        const d = decodeEventLog({ abi: [gov], data: l.data, topics: l.topics })
        rows.push({
          a,
          k: 'gov',
          ev: gov.name,
          args: jsonArgs(d.args),
          b,
          tx: l.transactionHash,
          li: l.logIndex,
        })
      } else if (!plan.priceEmitters.has(lower(a))) {
        rows.push({
          a,
          k: 'gov',
          ev: 'unknown',
          topic0: t0,
          b,
          tx: l.transactionHash,
          li: l.logIndex,
        })
      }
    } catch {
      if (!plan.priceEmitters.has(lower(a)))
        rows.push({
          a,
          k: 'gov',
          ev: 'undecodable',
          topic0: t0,
          b,
          tx: l.transactionHash,
          li: l.logIndex,
        })
    }
  }
  if (plan.pyth && plan.pythIds.length) {
    const py = await getLogsAdaptive({
      address: plan.pyth,
      event: PYTH_EVENT,
      args: { id: plan.pythIds },
      fromBlock: BigInt(from),
      toBlock: BigInt(to),
    })
    for (const l of py)
      rows.push({
        a: getAddress(l.address),
        k: 'py',
        id: lower(l.args.id),
        v: l.args.price.toString(),
        t: Number(l.args.publishTime),
        b: Number(l.blockNumber),
      })
  }
  return rows
}

function buildLogPlan(catalog, head, base) {
  const byId = (snap) => new Map(snap.entries.map((r) => [r.id, r]))
  const h = byId(head)
  const s = byId(base)
  const priceEmitters = new Set()
  const govEmitters = new Set()
  const feedIds = new Set()
  const pythIds = new Set()
  let pyth = null
  for (const e of catalog.entries) {
    const p = eventPlan(e, h.get(e.id), s.get(e.id))
    if (p?.kind === 'py') {
      pyth = e.address
      pythIds.add(p.id)
    } else if (p) {
      for (const a of p.addresses) priceEmitters.add(lower(a))
      if (p.id) feedIds.add(p.id)
    }
    if (e.provider === 'chainlink') govEmitters.add(lower(e.address)) // proxy: aggregator swaps
    for (const g of e.mechanism.governance) {
      if (!g.event) continue
      if (g.event.startsWith('AssetSourceUpdated')) {
        for (const u of e.usedBy)
          if (u.check?.type === 'aave_source') govEmitters.add(lower(u.check.oracle))
      } else govEmitters.add(lower(e.address))
    }
    for (const u of e.usedBy)
      if (u.check?.type === 'aave_source') govEmitters.add(lower(u.check.oracle))
  }
  return {
    emitters: [...new Set([...priceEmitters, ...govEmitters])].map((a) => getAddress(a)),
    govEmitters: [...govEmitters].map((a) => getAddress(a)),
    priceEmitters: [...priceEmitters],
    feedIds: [...feedIds],
    pyth,
    pythIds: [...pythIds],
  }
}

// ---- history assembly ----------------------------------------------------------------------
/**
 * blockTs: block → timestamp for every block that carries a Chronicle Poked log. Poked's
 * `age` is the SIGNED observation time; the contract stores the poke's block.timestamp as
 * the value's age (what readWithAge returns), so the history uses the block time too —
 * otherwise each update would apply a few minutes before the chain saw it.
 */
function assembleHistories(catalog, run, head, base, gridRows, logRows, blockTs) {
  const h = new Map(head.entries.map((r) => [r.id, r]))
  const s = new Map(base.entries.map((r) => [r.id, r]))
  const out = []
  for (const e of catalog.entries) {
    const plan = eventPlan(e, h.get(e.id), s.get(e.id))
    const seedRow = s.get(e.id)
    const seed = seedRow?.price != null ? [seedRow.updatedAt ?? base.ts, sig9(seedRow.price)] : null
    let points = []
    let source = 'none_public'
    let note
    if (plan) {
      const addrs = new Set((plan.addresses || []).map(lower))
      const dec = e.decimals
      const ev = logRows.filter((r) => {
        if (plan.kind === 'py') return r.k === 'py' && r.id === plan.id
        if (!addrs.has(lower(r.a))) return false
        if (plan.kind === 'au') return r.k === 'au' || (r.k === 'vu' && r.id === plan.id)
        return r.k === plan.kind && (plan.kind !== 'vu' || r.id === plan.id)
      })
      const evPoints = ev
        .map((r) => [r.k === 'pk' ? (blockTs.get(r.b) ?? r.t) : r.t, sig9(Number(r.v) / 10 ** dec)])
        .filter((p) => p[1] > 0 && p[0] >= run.startTs - 1 && p[0] <= run.endTs + 60)
      const headUpdated = h.get(e.id)?.updatedAt
      const missed = !evPoints.length && headUpdated != null && headUpdated > run.startTs + 60
      if (!missed && (evPoints.length || seed)) {
        source = plan.source
        points = [...(seed ? [seed] : []), ...evPoints]
        if (!evPoints.length)
          note = `no on-chain update inside the window; value held since ${new Date((seed?.[0] ?? 0) * 1000).toISOString().slice(0, 10)}`
        if (plan.kind === 'py')
          note = `${note ? note + '. ' : ''}on-chain pushes only (pull oracle; off-chain Hermes needs a Pyth API key)`
      } else if (missed) {
        note = `expected ${plan.kind} events were not found although the feed updated in the window; archive-sampled instead`
      }
    }
    let legs = []
    if (!points.length) {
      // Clocked legs recorded at any sample, in catalog order: each point's 4th element.
      legs = (e.mechanism.components || []).filter((k) =>
        gridRows.some((g) => g.r[e.id] && g.c?.[e.id]?.[k.role] != null),
      )
      const sampled = []
      for (const g of gridRows) {
        const v = g.r[e.id]
        if (!v || !g.ts) continue
        if (legs.length)
          sampled.push([
            g.ts,
            v[0],
            v.length === 2 ? v[1] : null,
            legs.map((k) => g.c?.[e.id]?.[k.role] ?? null),
          ])
        else sampled.push(v.length === 2 ? [g.ts, v[0], v[1]] : [g.ts, v[0]])
      }
      if (sampled.length) {
        source = 'archive_sampling'
        points = sampled
      } else if (!note) {
        note =
          e.provider === 'chronicle'
            ? 'no Poked events and no readable value at the window start'
            : 'no readable history at the sampled archive blocks'
      }
    }
    points.sort((a, b) => a[0] - b[0])
    const dedup = []
    for (const p of points) {
      if (dedup.length && dedup[dedup.length - 1][0] === p[0]) dedup[dedup.length - 1] = p
      else dedup.push(p)
    }
    out.push({
      id: e.id,
      source: dedup.length ? source : 'none_public',
      ...(source === 'archive_sampling' ? { stepSeconds: run.step } : {}),
      from: run.startTs,
      to: run.endTs,
      ...(source === 'archive_sampling' && legs.length
        ? { components: legs.map((k) => ({ role: k.role, address: k.address })) }
        : {}),
      points: dedup,
      ...(note ? { note } : {}),
    })
  }
  return out
}

function governanceChanges(catalog, logRows, blockTs) {
  const events = []
  for (const r of logRows) {
    if (r.k !== 'gov') continue
    const a = lower(r.a)
    const ids = new Set()
    for (const e of catalog.entries) {
      if (lower(e.address) === a) ids.add(e.id)
      if (r.ev === 'AssetSourceUpdated') {
        for (const u of e.usedBy)
          if (
            u.check?.type === 'aave_source' &&
            lower(u.check.oracle) === a &&
            lower(u.check.asset) === lower(r.args?.asset)
          )
            ids.add(e.id)
      }
    }
    if (!ids.size) continue // e.g. AssetSourceUpdated for an asset outside the registry
    events.push({
      block: r.b,
      ts: blockTs.get(r.b) ?? null,
      tx: r.tx,
      logIndex: r.li,
      emitter: r.a,
      event: r.ev,
      ...(r.args ? { args: r.args } : {}),
      ...(r.topic0 ? { topic0: r.topic0 } : {}),
      entryIds: [...ids],
    })
  }
  return events.sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)
}

// ---- main ----------------------------------------------------------------------------------
const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'))
mkdirSync(SNAP_DIR, { recursive: true })

// --at-block=N: one archive snapshot at block N (for a config diff against latest), nothing else.
const AT_BLOCK = argVal('at-block', '')
const headBlock = AT_BLOCK ? BigInt(AT_BLOCK) : (await retry(() => state.getBlockNumber())) - 2n
console.log(
  `oracle-registry collect — snapshot at block ${headBlock}, ${catalog.entries.length} entries`,
)
const head = await takeSnapshot(catalog, headBlock)
writeJson(join(SNAP_DIR, `${isoName(head.ts)}.json`), head)
if (!AT_BLOCK) writeJson(join(SNAP_DIR, 'latest.json'), head)
const readOk = head.entries.filter((r) => r.price != null).length
console.log(
  `snapshot ${isoName(head.ts)}: ${readOk}/${head.entries.length} priced, ${head.entries.filter((r) => r.error).length} errors`,
)
for (const r of head.entries) if (r.error) console.log(`  ✗ ${r.id}: ${r.error}`)
if (SNAPSHOT_ONLY || AT_BLOCK) process.exit(0)

if (!logClient) {
  console.error(
    'no Ankr/Infura endpoint in RECORDER_RPC_URL: event history needs a getLogs-capable RPC',
  )
  process.exit(1)
}
mkdirSync(CACHE, { recursive: true })
mkdirSync(HIST_DIR, { recursive: true })
const RUN = join(CACHE, 'run.json')
const GRID = join(CACHE, 'grid.jsonl')
const LOGS = join(CACHE, 'logs.jsonl')
const BASE = join(CACHE, 'baseline.json')
let run = !FRESH && existsSync(RUN) ? JSON.parse(readFileSync(RUN, 'utf8')) : null
if (
  run &&
  (run.days !== DAYS || run.step !== STEP || run.catalogGeneratedAt !== catalog.generatedAt)
)
  run = null
if (!run) {
  for (const f of [GRID, LOGS, BASE]) rmSync(f, { force: true })
  const endBlock = Number(head.block)
  const endTs = head.ts
  const wantTs = endTs - DAYS * 86400
  let startBlock = endBlock - Math.round((DAYS * 86400) / 12)
  let t0 = Number(
    (await retry(() => state.getBlock({ blockNumber: BigInt(startBlock) }))).timestamp,
  )
  startBlock += Math.round((wantTs - t0) / 12)
  t0 = Number((await retry(() => state.getBlock({ blockNumber: BigInt(startBlock) }))).timestamp)
  run = {
    days: DAYS,
    step: STEP,
    catalogGeneratedAt: catalog.generatedAt,
    startBlock,
    startTs: t0,
    endBlock,
    endTs,
  }
  writeJson(RUN, run)
  console.log(
    `new history window: blocks ${startBlock}–${endBlock} (${isoName(t0)} → ${isoName(endTs)})`,
  )
} else {
  console.log(`resuming history window: blocks ${run.startBlock}–${run.endBlock}`)
}

// 1) baseline snapshot at the window start (seeds + aggregator of the earlier phase)
let base
if (existsSync(BASE)) base = JSON.parse(readFileSync(BASE, 'utf8'))
else {
  base = await takeSnapshot(catalog, BigInt(run.startBlock))
  writeJson(BASE, base)
}
writeJson(join(SNAP_DIR, `${isoName(base.ts)}.json`), base)
// The window end is fixed by run.json; on a resumed run it predates this run's head snapshot.
const END = join(CACHE, 'end.json')
let endSnap = head
if (run.endBlock !== head.block) {
  if (existsSync(END)) endSnap = JSON.parse(readFileSync(END, 'utf8'))
  else {
    endSnap = await takeSnapshot(catalog, BigInt(run.endBlock))
    writeJson(END, endSnap)
  }
}

// 2) archive grid
const readLines = (p) =>
  existsSync(p)
    ? readFileSync(p, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
const gridEntries = catalog.entries.filter((e) => priceCalls(e).some((c) => !c.direct))
const gridBlocks = []
for (let t = run.startTs; t <= run.endTs; t += STEP) {
  const b = Math.round(
    run.startBlock +
      ((t - run.startTs) * (run.endBlock - run.startBlock)) / (run.endTs - run.startTs),
  )
  gridBlocks.push(Math.min(run.endBlock, Math.max(run.startBlock, b)))
}
const gridDone = new Set(readLines(GRID).map((g) => g.b))
const gridTodo = [...new Set(gridBlocks)].filter((b) => !gridDone.has(b))
console.log(
  `archive grid: ${gridBlocks.length} blocks every ${STEP}s, ${gridTodo.length} to sample`,
)
let gridN = 0
let gridFail = 0
await pool(gridTodo, GRID_CONCURRENCY, async (b) => {
  try {
    const row = await sampleBlock(gridEntries, b)
    appendFileSync(GRID, JSON.stringify(row) + '\n')
  } catch (e) {
    gridFail++
    console.log(`  grid block ${b} failed: ${scrub(e?.shortMessage || e?.message)}`)
  }
  if (++gridN % 120 === 0) console.log(`  grid ${gridN}/${gridTodo.length}`)
  await sleep(40)
})

// 3) event logs
let plan = run.logPlan
if (!plan || !plan.govEmitters) {
  plan = buildLogPlan(catalog, endSnap, base)
  run.logPlan = plan
  writeJson(RUN, run)
}
const planSets = {
  ...plan,
  priceEmitters: new Set(plan.priceEmitters),
  feedIds: new Set(plan.feedIds),
}
const chunks = []
for (let f = run.startBlock; f <= run.endBlock; f += Number(LOG_SPAN))
  chunks.push([f, Math.min(run.endBlock, f + Number(LOG_SPAN) - 1)])
const logDone = new Set(
  readLines(LOGS)
    .filter((l) => l.v === 2)
    .map((l) => `${l.from}-${l.to}`),
)
const logTodo = chunks.filter(([f, t]) => !logDone.has(`${f}-${t}`))
console.log(
  `event scan: ${plan.emitters.length} emitters + Pyth (${plan.pythIds.length} ids), ${chunks.length} chunks, ${logTodo.length} to scan`,
)
let logFail = 0
await pool(logTodo, LOG_CONCURRENCY, async ([f, t]) => {
  try {
    const rows = await scanChunk(f, t, planSets)
    appendFileSync(LOGS, JSON.stringify({ v: 2, from: f, to: t, rows }) + '\n')
  } catch (e) {
    logFail++
    console.log(`  log chunk ${f}-${t} failed: ${scrub(e?.shortMessage || e?.message)}`)
  }
})
if (gridFail || logFail) {
  console.log(
    `incomplete: ${gridFail} grid blocks and ${logFail} log chunks failed — re-run to resume`,
  )
  process.exit(1)
}

// 3b) governance look-back before the price window (known config events only)
const GOVF = join(CACHE, 'gov.jsonl')
const govStart = Math.max(0, run.endBlock - Math.round((GOV_DAYS * 86400) / 12))
const govChunks = []
for (let f = govStart; f < run.startBlock; f += Number(LOG_SPAN))
  govChunks.push([f, Math.min(run.startBlock - 1, f + Number(LOG_SPAN) - 1)])
// only chunks written with the cross-check (v 2) count as done: older ones are read again
const govDone = new Set(
  readLines(GOVF)
    .filter((l) => l.v === 2)
    .map((l) => `${l.from}-${l.to}`),
)
const govTodo = govChunks.filter(([f, t]) => !govDone.has(`${f}-${t}`))
console.log(
  `governance look-back: ${GOV_DAYS} days, ${govChunks.length} chunks, ${govTodo.length} to scan`,
)
await pool(govTodo, LOG_CONCURRENCY, async ([f, t]) => {
  try {
    const raw = await confirmedRange({
      address: plan.govEmitters,
      // viem's getLogs has no raw `topics`; `events` becomes the topic0 OR-filter.
      events: GOV_EVENTS,
      fromBlock: BigInt(f),
      toBlock: BigInt(t),
    })
    const rows = []
    for (const l of raw) {
      const gov = GOV_BY_TOPIC.get(l.topics[0])
      if (!gov) continue // defensive: the RPC honoured the filter, nothing else should arrive
      try {
        const d = decodeEventLog({ abi: [gov], data: l.data, topics: l.topics })
        rows.push({
          a: getAddress(l.address),
          k: 'gov',
          ev: gov.name,
          args: jsonArgs(d.args),
          b: Number(l.blockNumber),
          tx: l.transactionHash,
          li: l.logIndex,
        })
      } catch {
        rows.push({
          a: getAddress(l.address),
          k: 'gov',
          ev: 'undecodable',
          topic0: l.topics[0],
          b: Number(l.blockNumber),
          tx: l.transactionHash,
          li: l.logIndex,
        })
      }
    }
    appendFileSync(GOVF, JSON.stringify({ v: 2, from: f, to: t, rows }) + '\n')
  } catch (e) {
    logFail++
    console.log(`  governance chunk ${f}-${t} failed: ${scrub(e?.shortMessage || e?.message)}`)
  }
})
if (logFail) {
  console.log(`incomplete: ${logFail} governance chunks failed — re-run to resume`)
  process.exit(1)
}

// 4) block timestamps for Chronicle pokes and governance logs (cached: resumable)
const gridRows = readLines(GRID).sort((a, b) => a.b - b.b)
const logRows = readLines(LOGS)
  .filter((l) => l.v === 2)
  .flatMap((l) => l.rows)
const govRows = [
  ...readLines(GOVF)
    .filter((l) => l.v === 2)
    .flatMap((l) => l.rows),
  ...logRows.filter((r) => r.k === 'gov'),
]
const BLOCKTS = join(CACHE, 'blockts.jsonl')
const blockTs = new Map(readLines(BLOCKTS).map((x) => [x.b, x.ts]))
const tsTodo = [
  ...new Set([...logRows.filter((r) => r.k === 'pk').map((r) => r.b), ...govRows.map((r) => r.b)]),
].filter((b) => !blockTs.has(b))
console.log(`block timestamps: ${tsTodo.length} to read`)
let tsFail = 0
await pool(tsTodo, 3, async (b) => {
  try {
    const ts = Number((await retry(() => state.getBlock({ blockNumber: BigInt(b) }))).timestamp)
    blockTs.set(b, ts)
    appendFileSync(BLOCKTS, JSON.stringify({ b, ts }) + '\n')
  } catch (e) {
    tsFail++
    console.log(`  block ${b} timestamp failed: ${scrub(e?.shortMessage || e?.message)}`)
  }
  await sleep(20)
})
if (tsFail) {
  console.log(`incomplete: ${tsFail} block timestamps failed — re-run to resume`)
  process.exit(1)
}

// 5) assemble
const histories = assembleHistories(catalog, run, endSnap, base, gridRows, logRows, blockTs)
for (const hst of histories) writeJson(join(HIST_DIR, `${hst.id}.json`), hst)
const window = {
  startBlock: run.startBlock,
  endBlock: run.endBlock,
  startTs: run.startTs,
  endTs: run.endTs,
  days: run.days,
  stepSeconds: run.step,
}
writeJson(join(HIST_DIR, 'index.json'), {
  window,
  entries: histories.map((x) => ({
    id: x.id,
    source: x.source,
    points: x.points.length,
    ...(x.note ? { note: x.note } : {}),
  })),
})

const changes = governanceChanges(catalog, govRows, blockTs)
writeJson(join(OUT, 'changes.json'), {
  window: { startBlock: govStart, endBlock: run.endBlock, days: GOV_DAYS, endTs: run.endTs },
  events: changes,
})

const bySource = {}
for (const x of histories) bySource[x.source] = (bySource[x.source] || 0) + 1
console.log(
  `history: ${histories.length} entries — ${JSON.stringify(bySource)}; ${changes.length} governance events`,
)
for (const x of histories)
  if (x.note) console.log(`  · ${x.id}: ${x.source} (${x.points.length}) — ${x.note}`)
if (!KEEP_CACHE) rmSync(CACHE, { recursive: true, force: true })
process.exit(0)
