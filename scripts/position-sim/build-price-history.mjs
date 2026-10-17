/**
 * MULTI-YEAR HOURLY PRICE HISTORY for the set-and-forget LTV sim (owner ask 2026-10-04:
 * "run a sim to see what LTV per asset will be profitable to set and forget with our
 * recall mech"). The statistics live in lib/position-sim/drawdowns.ts; this script only
 * gathers, aligns and labels the data, then writes a summary computed WITH that module.
 *
 * WHAT IT BUILDS (public/data/price-history/, every file on ONE grid: hour i opens at
 * 2020-01-01T00:00Z + i h; `close` = price at the hour's END, `low`/`high` = range inside it)
 *   eth-usd-1h.json, btc-usd-1h.json
 *       oracle / oracleLow / oracleHigh   Chainlink AnswerUpdated, every phase aggregator,
 *                                         each used ONLY while the proxy pointed at it
 *       binance / binanceLow / binanceHigh   Binance spot 1h klines (USDT-quoted)
 *       coinbase / coinbaseLow / coinbaseHigh   Coinbase Exchange 1h candles (USD-quoted)
 *       primary.segments                  oracle wherever it covers; before that, the market
 *                                         series that tracked the oracle tightest (measured)
 *   steth-eth-1h.json   Chainlink STETH/ETH MARKET feed (the depeg path, e.g. Jun 2022)
 *   lst-rates-1d.json   wstETH.stEthPerToken() and weETH.getRate() read at each UTC day's
 *                       first oracle block (archive eth_call) — the exchange-rate paths
 *   manifest.json       sources, coverage, phase tables, oracle-vs-market cross-check
 *   summary.json        drawdown quantiles, recovery curve, worst windows, named events
 *
 * RESUMABLE + PACED. Everything fetched lands in data/price-history/cache/ (gitignored)
 * first: one file per (market, month), per (feed, 250k-block segment), per rate. A
 * finished month / segment is never fetched again; the open month and the head segment
 * are refetched each run. Market REST calls are paced (Binance 250 ms, Coinbase 400 ms,
 * backoff on 429/5xx); getLogs rotate across the probed RPC ring (lib/position-sim/
 * rpcRing.ts — the keyed Ankr endpoint carries it) 8 pieces wide.
 *
 * WHY PHASE WINDOWS. A Chainlink proxy's old phase aggregators can keep emitting after the
 * proxy moves on (ETH/USD phase 1 still printed in 2021, months after phase 3 took over).
 * Merging every aggregator's logs — fine for a point lookup — would interleave two feeds
 * into one hourly low/high. So the switch block of each phase is found by bisecting the
 * proxy's `phaseId()` over archive state, and a log counts only inside its phase's window.
 * That rule drops the one pre-switch round the proxy DID serve — the new aggregator's latest
 * at the switch — so each switch also gets a HANDOVER round read from archive state
 * (lib/position-sim/oracleRounds.ts header; cached as cache/oracle/<feed>/handover.json).
 *
 * KEYS NEVER PRINTED. RPC URLs come from .env.local RECORDER_RPC_URL; every log line and
 * error goes through `redact`, which rewrites any keyed URL to `env:<host>`.
 *
 * USAGE (tsx, because it imports the TypeScript ring + drawdown modules)
 *   npx tsx scripts/position-sim/build-price-history.mjs                  # every phase
 *   npx tsx scripts/position-sim/build-price-history.mjs --phase=market   # REST only, no RPC
 *   npx tsx scripts/position-sim/build-price-history.mjs --phase=oracle,rates
 *   npx tsx scripts/position-sim/build-price-history.mjs --phase=build    # from cache only
 *   npx tsx scripts/position-sim/build-price-history.mjs --phase=handover # phase-switch reads only
 *   --grid-end=<ISO hour>   pin the grid's last hour (default: the last complete hour) — rebuild
 *                           a published grid from cache without growing it
 *   --no-ring-stats   skip appending this run's endpoint stats to public/data/rpc-ring-stats.json
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { parseAbiItem } from 'viem'

import { readEnv, ROOT } from '../lib/venue-reads.mjs'

const {
  DRAWDOWN_WINDOWS,
  drawdownTable,
  forwardDrawdowns,
  gridFromFile,
  intrabarWicks,
  primaryGrid,
  recoveryCurve,
  seriesDiffStats,
  worstWindows,
} = await import('../../lib/position-sim/drawdowns.ts')
const { aggregateHours, decodeRounds, withHandovers } =
  await import('../../lib/position-sim/oracleRounds.ts')

// ------------------------------------------------------------------ env + redaction

const { get } = readEnv()
if (get('RECORDER_RPC_URL')) process.env.RECORDER_RPC_URL = get('RECORDER_RPC_URL')
const ENV_URLS = String(process.env.RECORDER_RPC_URL ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const ENV_HOSTS = [...new Set(ENV_URLS.map((u) => new URL(u).host))]
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function redact(x) {
  let s = String(x)
  for (const host of ENV_HOSTS) {
    s = s.replace(new RegExp(`https?://${escapeRe(host)}[^\\s"'\`,)]*`, 'g'), `env:${host}`)
  }
  return s
}
const log = (...a) => console.log(redact(a.join(' ')))
// viem strips only `user:pass@` from error URLs; a key in the PATH (Ankr, Infura) would
// print through any stray rejection, so every process-level error is scrubbed too.
for (const ev of ['unhandledRejection', 'uncaughtException']) {
  process.on(ev, (e) => {
    console.error(redact(e?.stack ?? e))
    process.exit(1)
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ constants

const H = 3600
const DAY = 86_400
const GRID_START = Date.UTC(2020, 0, 1) / 1000 // 1577836800
const OUT_DIR = join(ROOT, 'public', 'data', 'price-history')
const CACHE = join(ROOT, 'data', 'price-history', 'cache')
const FINALITY = 64n
const SEGMENT_BLOCKS = 250_000n
const SEGMENT_VERSION = 2 // v2: raw rounds per segment (v1 kept only hourly aggregates)
/** Shortest oracle run the primary series will use; a shorter island (ETH/USD's few test
 *  rounds on 2020-01-15, 84 days before the feed really started) stays on the market. */
const MIN_ORACLE_RUN_HOURS = 168
const ZERO = '0x0000000000000000000000000000000000000000'

const ASSETS = {
  'eth-usd': { asset: 'ETH/USD', dp: 2 },
  'btc-usd': { asset: 'BTC/USD', dp: 2 },
}

const MARKETS = {
  binance: {
    label:
      'Binance spot 1h klines, USDT-quoted (data-api.binance.vision public market-data REST, no key)',
    paceMs: 250,
    symbols: { 'eth-usd': 'ETHUSDT', 'btc-usd': 'BTCUSDT' },
  },
  coinbase: {
    label:
      'Coinbase Exchange 1h candles, USD-quoted (api.exchange.coinbase.com public REST, no key)',
    paceMs: 400,
    symbols: { 'eth-usd': 'ETH-USD', 'btc-usd': 'BTC-USD' },
  },
}

const FEEDS = {
  'eth-usd': {
    proxy: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    decimals: 8,
    fromBlock: 9_180_000n, // 2019-12-30: seeds the round in force at the grid start
    auditGapHours: 4, // 1 h heartbeat since 2020; any longer silence is re-queried
    maxStaleHours: 48, // the column goes null past this — never bridge a dead feed
  },
  'btc-usd': {
    proxy: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
    decimals: 8,
    fromBlock: 9_180_000n,
    auditGapHours: 4,
    maxStaleHours: 48,
  },
  'steth-eth': {
    proxy: '0x86392dC19c0b719886221c78AB11eb8Cf5c52812',
    decimals: 18,
    fromBlock: 11_800_000n, // 2021-02-06, before the feed's first round
    auditGapHours: 26, // 24 h heartbeat
    maxStaleHours: 72,
  },
}

const RATES = {
  wstethStEthPerToken: {
    address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
    fn: 'stEthPerToken',
    label:
      'wstETH.stEthPerToken(): stETH per wstETH (Lido share rate, steps at each oracle report)',
  },
  weethRate: {
    address: '0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee',
    fn: 'getRate',
    label: 'weETH.getRate(): eETH (redeemable 1:1 for ETH) per weETH',
  },
}

const ANSWER_UPDATED = parseAbiItem(
  'event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)',
)
const PROXY_ABI = [
  {
    type: 'function',
    name: 'phaseId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint16' }],
  },
  {
    type: 'function',
    name: 'phaseAggregators',
    stateMutability: 'view',
    inputs: [{ type: 'uint16' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'description',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  // AggregatorFacade (the 2020 V3-interface wrapper over a legacy aggregator) answers this;
  // a real aggregator does not.
  {
    type: 'function',
    name: 'aggregator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
]
const PHASE_TABLE_VERSION = 2
const LATEST_ROUND_ABI = [
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { type: 'uint80', name: 'roundId' },
      { type: 'int256', name: 'answer' },
      { type: 'uint256', name: 'startedAt' },
      { type: 'uint256', name: 'updatedAt' },
      { type: 'uint80', name: 'answeredInRound' },
    ],
  },
]
const HANDOVER_VERSION = 1
const RATE_ABI = [
  {
    type: 'function',
    name: 'stEthPerToken',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getRate',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
]

/** Named stress windows from the owner's ask (UTC dates, inclusive start, exclusive end). */
const EVENTS = [
  { id: 'mar-2020', label: 'Mar 2020 (Black Thursday)', from: '2020-03-08', to: '2020-03-20' },
  { id: 'may-2021', label: 'May 2021 deleveraging', from: '2021-05-12', to: '2021-05-24' },
  {
    id: 'jun-2022',
    label: 'Jun 2022 (3AC / Celsius / stETH discount)',
    from: '2022-06-08',
    to: '2022-06-22',
  },
  { id: 'aug-2024', label: 'Aug 2024 (yen-carry unwind)', from: '2024-08-01', to: '2024-08-08' },
  { id: 'oct-10-2025', label: 'Oct 10 2025 cascade', from: '2025-10-09', to: '2025-10-13' },
  { id: 'feb-2026', label: 'Feb 2026 (whole month)', from: '2026-02-01', to: '2026-03-01' },
]

const RECOVERY_DROPS = [0.05, 0.075, 0.1, 0.125, 0.15, 0.2, 0.25, 0.3]

// ------------------------------------------------------------------ small io helpers

const args = process.argv.slice(2)
const flag = (name) => args.some((a) => a === `--${name}`)
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const PHASES = opt('phase', 'all')
  .split(',')
  .map((s) => s.trim())
const runs = (p) => PHASES.includes('all') || PHASES.includes(p)

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}
function writeJson(path, value, pretty = false) {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, pretty ? 2 : 0) + '\n')
  renameSync(tmp, path)
}
const round = (x, dp) =>
  x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** dp) / 10 ** dp
const iso = (sec) => new Date(sec * 1000).toISOString().replace('.000Z', 'Z')
const isoDate = (sec) => (Number.isFinite(sec) ? iso(sec) : null)
const nowSec = () => Math.floor(Date.now() / 1000)

/**
 * Last COMPLETE hour's open timestamp, fixed once per run so every file shares one grid.
 * `--grid-end=<ISO hour>` pins it instead, so a --phase=build from cache can reproduce a
 * published grid exactly (the default would grow it by every hour since, forward-filled).
 */
const GRID_END = (() => {
  const pin = opt('grid-end', null)
  if (pin === null) return Math.floor(nowSec() / H) * H - H
  const t = Date.parse(pin) / 1000
  if (!Number.isFinite(t) || t % H !== 0 || t < GRID_START)
    throw new Error(`--grid-end=${pin}: not a whole UTC hour on or after the grid start`)
  return t
})()
const GRID_COUNT = (GRID_END - GRID_START) / H + 1

// ------------------------------------------------------------------ market (REST)

async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'membrane-price-history/1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      })
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`)
      if (!r.ok) {
        const e = new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`)
        e.fatal = true
        throw e
      }
      return await r.json()
    } catch (e) {
      if (e.fatal || attempt >= 5) throw e
      await sleep(1000 * 2 ** attempt)
    }
  }
}

function monthRanges(untilSec) {
  const out = []
  let y = 2020
  let m = 0
  for (;;) {
    const from = Date.UTC(y, m, 1) / 1000
    if (from > untilSec) break
    out.push({
      key: `${y}-${String(m + 1).padStart(2, '0')}`,
      from,
      to: Date.UTC(y, m + 1, 1) / 1000,
    })
    m++
    if (m === 12) {
      m = 0
      y++
    }
  }
  return out
}

/** Rows are [openTs, high, low, close]; only candles that have CLOSED are kept. */
async function fetchBinance(symbol, from, to) {
  const url =
    `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1h` +
    `&startTime=${from * 1000}&endTime=${to * 1000 - 1}&limit=1000`
  const rows = await getJson(url)
  return rows
    .map((r) => [Math.round(r[0] / 1000), Number(r[2]), Number(r[3]), Number(r[4])])
    .filter((r) => r[0] + H <= nowSec())
}

async function fetchCoinbase(product, from, to, paceMs) {
  const out = new Map()
  for (let s = from; s < to; s += 300 * H) {
    const e = Math.min(to - H, s + 299 * H)
    const url =
      `https://api.exchange.coinbase.com/products/${product}/candles?granularity=3600` +
      `&start=${iso(s)}&end=${iso(e)}`
    const rows = await getJson(url)
    // [time, low, high, open, close, volume], newest first
    for (const r of rows)
      if (r[0] >= s && r[0] <= e && r[0] + H <= nowSec()) out.set(r[0], [r[0], r[2], r[1], r[4]])
    await sleep(paceMs)
  }
  return [...out.values()].sort((a, b) => a[0] - b[0])
}

async function phaseMarket() {
  const lastHour = Math.floor(nowSec() / H) * H
  for (const [source, cfg] of Object.entries(MARKETS)) {
    for (const [key, symbol] of Object.entries(cfg.symbols)) {
      const dir = join(CACHE, 'market', `${source}-${key}`)
      let fetched = 0
      for (const mo of monthRanges(lastHour)) {
        const path = join(dir, `${mo.key}.json`)
        if (readJson(path)?.complete) continue
        const to = Math.min(mo.to, lastHour)
        const rows =
          source === 'binance'
            ? await fetchBinance(symbol, mo.from, to)
            : await fetchCoinbase(symbol, mo.from, to, cfg.paceMs)
        writeJson(path, {
          source,
          symbol,
          month: mo.key,
          fetchedAt: new Date().toISOString(),
          complete: mo.to <= nowSec() - 2 * H,
          rows,
        })
        fetched++
        await sleep(cfg.paceMs)
      }
      log(`market ${source} ${symbol}: ${fetched} month file(s) fetched`)
    }
  }
}

// ------------------------------------------------------------------ oracle (RPC ring)

async function makeRing() {
  const { probeRing, RpcRing } = await import('../../lib/position-sim/rpcRing.ts')
  // Probe ONLY the keyed endpoints + Pocket, and do not rewrite the shared ring table
  // (public/data/rpc-ring.json) — this job is not a ring census.
  const table = await probeRing(['https://eth.api.pocket.network'], ENV_URLS)
  log(
    'ring:',
    table.entries
      .filter((e) => e.cap > 0)
      .map((e) => `${new URL(e.url).host} cap=${e.cap}`)
      .join(', '),
  )
  return new RpcRing(table)
}

const isAbsent = (e) =>
  /returned no data|reverted|execution reverted/i.test(String(e?.shortMessage ?? e?.message ?? e))

async function withRetry(fn, label) {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i >= 4)
        throw new Error(
          `${label}: ${redact(String(e?.shortMessage ?? e?.message ?? e)).slice(0, 200)}`,
        )
      await sleep(500 * 2 ** i)
    }
  }
}

/** phaseId() at a block; 0 where the proxy did not exist yet. */
async function phaseAt(client, proxy, blockNumber) {
  for (let i = 0; ; i++) {
    try {
      return Number(
        await client.readContract({
          address: proxy,
          abi: PROXY_ABI,
          functionName: 'phaseId',
          blockNumber,
        }),
      )
    } catch (e) {
      if (isAbsent(e)) return 0
      if (i >= 4)
        throw new Error(
          `phaseId @${blockNumber}: ${redact(String(e?.shortMessage ?? e)).slice(0, 160)}`,
        )
      await sleep(500 * 2 ** i)
    }
  }
}

async function phaseTable(client, key, feed, head) {
  const path = join(CACHE, 'oracle', key, 'phases.json')
  const read = (fn, a) =>
    withRetry(
      () => client.readContract({ address: feed.proxy, abi: PROXY_ABI, functionName: fn, args: a }),
      `${key} ${fn}`,
    )
  const current = Number(await read('phaseId'))
  const cached = readJson(path)
  if (cached && cached.version === PHASE_TABLE_VERSION && cached.phases.length === current)
    return cached
  const description = await read('description')
  const decimals = Number(await read('decimals'))
  if (decimals !== feed.decimals)
    throw new Error(`${key}: proxy decimals ${decimals} != expected ${feed.decimals}`)
  const phases = []
  for (let p = 1; p <= current; p++) {
    const address = String(await read('phaseAggregators', [p]))
    // A FACADE emits no AnswerUpdated of its own: the rounds the proxy served during its
    // phase are the WRAPPED legacy aggregator's (ETH/USD and BTC/USD phase 2, Aug–Oct 2020).
    // Without this the phase-2 window is two months of one stale, forward-filled price.
    let logSource = address
    let facadeOf = null
    try {
      const inner = String(
        await client.readContract({ address, abi: PROXY_ABI, functionName: 'aggregator' }),
      )
      if (inner && inner !== ZERO) {
        logSource = inner
        facadeOf = inner
      }
    } catch {
      /* a real aggregator: it emits its own rounds */
    }
    phases.push({ phase: p, address, logSource, facadeOf, fromBlock: '0', toBlock: null })
  }
  // Switch block of phase p = the first block whose phaseId() >= p (phaseId only grows).
  let lo = feed.fromBlock
  for (let p = 2; p <= current; p++) {
    let a = lo
    let b = head
    while (a < b) {
      const mid = (a + b) / 2n
      if ((await phaseAt(client, feed.proxy, mid)) >= p) b = mid
      else a = mid + 1n
    }
    phases[p - 1].fromBlock = String(a)
    phases[p - 2].toBlock = String(a - 1n)
    lo = a
  }
  const table = {
    version: PHASE_TABLE_VERSION,
    proxy: feed.proxy,
    description,
    decimals,
    phases,
    computedAt: new Date().toISOString(),
    head: String(head),
  }
  writeJson(path, table, true)
  log(
    `${key}: ${description}, ${current} phases:`,
    phases
      .map(
        (p) =>
          `#${p.phase} ${p.address.slice(0, 10)}${p.facadeOf ? ` (facade of ${p.facadeOf.slice(0, 10)})` : ''} from ${p.fromBlock}`,
      )
      .join(' | '),
  )
  return table
}

const activeIn = (table, s, e) =>
  table.phases.filter(
    (p) =>
      p.logSource !== ZERO &&
      BigInt(p.fromBlock) <= e &&
      (p.toBlock === null || BigInt(p.toBlock) >= s),
  )
const segStart = (feed, block) =>
  feed.fromBlock + ((BigInt(block) - feed.fromBlock) / SEGMENT_BLOCKS) * SEGMENT_BLOCKS
const segPath = (key, s) => join(CACHE, 'oracle', key, `seg-${s}.json`)

async function scanFeed(ring, key, feed, table, head) {
  let fetched = 0
  let events = 0
  for (let s = feed.fromBlock; s <= head; s += SEGMENT_BLOCKS) {
    const full = s + SEGMENT_BLOCKS - 1n
    const e = full < head ? full : head
    const active = activeIn(table, s, e)
    const addrs = active.map(
      (p) => `${p.logSource.toLowerCase()}@${p.fromBlock}-${p.toBlock ?? ''}`,
    )
    const path = segPath(key, s)
    const cached = readJson(path)
    if (
      cached?.version === SEGMENT_VERSION &&
      cached.complete &&
      JSON.stringify(cached.addrs) === JSON.stringify(addrs)
    )
      continue
    let decoded = { rows: [], outOfPhase: 0 }
    if (active.length) {
      const sources = [...new Set(active.map((p) => p.logSource))]
      const logs = await ring.getLogsWide(
        { address: sources, event: ANSWER_UPDATED, fromBlock: s, toBlock: e },
        8,
      )
      decoded = decodeRounds(logs, active, feed.decimals)
    }
    writeJson(path, {
      version: SEGMENT_VERSION,
      from: String(s),
      to: String(e),
      complete: e === full && full + FINALITY <= head,
      addrs,
      outOfPhase: decoded.outOfPhase,
      rows: decoded.rows,
    })
    fetched++
    events += decoded.rows.length
    if (fetched % 10 === 0) log(`  ${key}: through block ${e} (${events} rounds so far this run)`)
    await sleep(100)
  }
  log(`oracle ${key}: ${fetched} segment(s) fetched, ${events} rounds`)
}

/** Every cached round of a feed, sorted, plus the segment files they came from. */
function loadOracleRows(key) {
  const dir = join(CACHE, 'oracle', key)
  if (!existsSync(dir)) return { rows: [], files: [], outOfPhase: 0 }
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('seg-'))
    .map((f) => readJson(join(dir, f)))
    .filter((x) => x?.version === SEGMENT_VERSION)
    .sort((a, b) => (BigInt(a.from) < BigInt(b.from) ? -1 : 1))
  const rows = files.flatMap((f) => f.rows)
  return { rows, files, outOfPhase: files.reduce((a, f) => a + f.outOfPhase, 0) }
}

/**
 * The hourly aggregate the columns are built from: the LOGGED rounds plus one handover round
 * per phase switch (what the proxy served from the switch block on). `events` counts logged
 * rounds only. Throws if a switch has no handover read (run --phase=handover).
 */
function loadOracleHours(key) {
  const { rows, files, outOfPhase } = loadOracleRows(key)
  const table = readJson(join(CACHE, 'oracle', key, 'phases.json'))
  let merged = rows
  let handovers = []
  if (table && table.phases.length > 1) {
    const cached = readJson(handoverPath(key))
    handovers = cached?.version === HANDOVER_VERSION ? cached.switches : []
    merged = withHandovers(rows, table.phases, handovers, table.decimals).rows
  }
  return {
    hours: aggregateHours(merged),
    events: rows.length,
    segments: files.length,
    outOfPhase,
    handovers,
  }
}

const handoverPath = (key) => join(CACHE, 'oracle', key, 'handover.json')

/**
 * PHASE HANDOVER reads (lib/position-sim/oracleRounds.ts header): for each switch, the new
 * phase's latestRoundData() at the block BEFORE the switch and the switch block's timestamp.
 * The proxy's own latestRoundData() at the switch block is read as a check: it must equal
 * the handover answer, or a round the new aggregator logged inside the switch block.
 */
async function phaseHandovers(client, key, feed, table) {
  const path = handoverPath(key)
  const cached = readJson(path)
  const done = new Map(
    cached?.version === HANDOVER_VERSION ? cached.switches.map((x) => [x.phase, x]) : [],
  )
  const latest = (address, blockNumber) =>
    withRetry(async () => {
      try {
        const r = await client.readContract({
          address,
          abi: LATEST_ROUND_ABI,
          functionName: 'latestRoundData',
          blockNumber,
        })
        return { answer: r[1], updatedAt: Number(r[3]) }
      } catch (e) {
        if (isAbsent(e)) return null // no round yet ("No data present")
        throw e
      }
    }, `${key} latestRoundData @${blockNumber}`)
  const logged = loadOracleRows(key).rows
  const switches = []
  for (const p of table.phases) {
    if (p.phase <= 1) continue
    const prev = done.get(p.phase)
    if (prev && prev.fromBlock === p.fromBlock) {
      switches.push(prev)
      continue
    }
    const b = BigInt(p.fromBlock)
    const block = await withRetry(
      () => client.getBlock({ blockNumber: b }),
      `${key} getBlock ${p.fromBlock}`,
    )
    const carried = await latest(p.address, b - 1n)
    const proxy = await latest(feed.proxy, b)
    const answer = carried && carried.answer > 0n ? carried.answer : null
    const proxyAnswer = proxy ? proxy.answer : null
    const scale = 10 ** table.decimals
    const inBlock = logged.filter((r) => r[0] === Number(p.fromBlock))
    const proxyAgrees =
      proxyAnswer === answer ||
      (proxyAnswer !== null &&
        inBlock.length > 0 &&
        inBlock[inBlock.length - 1][3] === Number(proxyAnswer) / scale)
    if (!proxyAgrees)
      throw new Error(
        `${key} phase ${p.phase}: the proxy served ${proxyAnswer} at the switch, the new ` +
          `aggregator's latest before it was ${answer}, and no round in the switch block explains it`,
      )
    const entry = {
      phase: p.phase,
      fromBlock: p.fromBlock,
      aggregator: p.address,
      switchTs: Number(block.timestamp),
      answer: answer === null ? null : String(answer),
      updatedAt: answer === null ? null : carried.updatedAt,
      price: answer === null ? null : Number(answer) / scale,
      proxyAtSwitch:
        proxyAnswer === null ? null : { answer: String(proxyAnswer), updatedAt: proxy.updatedAt },
    }
    switches.push(entry)
    log(
      `  handover ${key} #${p.phase} @${p.fromBlock} (${iso(entry.switchTs)}): ` +
        (entry.price === null
          ? 'new aggregator had no round yet'
          : `${entry.price} (round updated ${iso(entry.updatedAt)})`),
    )
  }
  writeJson(path, { version: HANDOVER_VERSION, proxy: feed.proxy, switches }, true)
  log(`handover ${key}: ${switches.length} switch(es)`)
}

/**
 * getLogs over [from, to] that does NOT trust a lone empty answer. Measured 2026-10-05: the
 * ring's getLogsWide came back with seven ETH/USD and several BTC/USD 10,000-block pieces
 * EMPTY (a 34–35 h hole in a 1 h-heartbeat feed) that the keyed Ankr endpoint answers with
 * ~40 rounds — some endpoint in the rotation answers [] instead of an error. So each piece
 * goes to the ring's endpoints one at a time in table order; the first non-empty answer
 * wins, and an empty piece needs TWO endpoints to agree (or is recorded as confirmed by
 * one when only one answers at all).
 */
async function verifiedLogs(ring, address, from, to) {
  const { createPublicClient, http } = await import('viem')
  const { mainnet } = await import('viem/chains')
  const span = 10_000n
  const logs = []
  const emptyBy = new Set()
  for (let s = from; s <= to; s += span) {
    const e = s + span - 1n < to ? s + span - 1n : to
    const eps = ring.table.entries.filter((x) => x.cap >= Number(e - s + 1n))
    let empties = 0
    let got = null
    for (const ep of eps) {
      try {
        const c = createPublicClient({
          chain: mainnet,
          transport: http(ep.url, { timeout: 20_000, retryCount: 1 }),
        })
        const l = await c.getLogs({ address, event: ANSWER_UPDATED, fromBlock: s, toBlock: e })
        if (l.length) {
          got = l
          break
        }
        empties++
        emptyBy.add(new URL(ep.url).host)
        if (empties >= 2) break
      } catch {
        /* this endpoint cannot serve the piece; ask the next */
      }
    }
    if (got) logs.push(...got)
    else if (empties === 0) throw new Error(`audit: no endpoint served blocks ${s}-${e}`)
    await sleep(60)
  }
  return { logs, emptyBy: [...emptyBy] }
}

/**
 * GAP AUDIT. Any stretch between consecutive rounds longer than the feed's heartbeat
 * allowance is re-queried through `verifiedLogs`; recovered rounds are written back into
 * their segment files, and a gap that stays empty is recorded (audit.json → manifest) as a
 * real oracle silence, never silently bridged.
 */
async function auditFeed(ring, key, feed, table) {
  const auditPath = join(CACHE, 'oracle', key, 'audit.json')
  const audit = readJson(auditPath) ?? { gaps: {} }
  const { rows, files } = loadOracleRows(key)
  const gaps = []
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][2] - rows[i - 1][2] > feed.auditGapHours * H) gaps.push([rows[i - 1], rows[i]])
  }
  const bySeg = new Map(files.map((f) => [f.from, f]))
  const dirty = new Set()
  let repaired = 0
  for (const [a, b] of gaps) {
    const id = `${a[0]}-${b[0]}`
    if (audit.gaps[id]) continue
    const from = BigInt(a[0]) + 1n
    const to = BigInt(b[0]) - 1n
    const entry = {
      fromTs: iso(a[2]),
      toTs: iso(b[2]),
      hours: Math.round((b[2] - a[2]) / H),
      fromBlock: String(from),
      toBlock: String(to),
    }
    if (to < from) {
      audit.gaps[id] = { ...entry, repairedRounds: 0, confirmedEmptyBy: ['adjacent blocks'] }
      continue
    }
    const active = activeIn(table, from, to)
    const sources = [...new Set(active.map((p) => p.logSource))]
    const { logs, emptyBy } = sources.length
      ? await verifiedLogs(ring, sources, from, to)
      : { logs: [], emptyBy: [] }
    const decoded = decodeRounds(logs, active, feed.decimals)
    const got = decoded.rows
    for (const r of got) {
      const seg = bySeg.get(String(segStart(feed, r[0])))
      if (!seg) continue
      seg.rows.push(r)
      dirty.add(seg.from)
    }
    repaired += got.length
    // Logs that exist in the hole but belong to an aggregator the proxy was not serving
    // (a phase switch) leave the hole real from a consumer's point of view.
    audit.gaps[id] = {
      ...entry,
      repairedRounds: got.length,
      confirmedEmptyBy: got.length ? [] : emptyBy,
      outOfPhaseLogs: decoded.outOfPhase,
    }
    log(
      `  audit ${key}: ${entry.hours} h gap from ${entry.fromTs} → ` +
        (got.length
          ? `${got.length} rounds recovered`
          : `real silence (empty per ${emptyBy.join(', ') || 'none'}; ${decoded.outOfPhase} out-of-phase logs)`),
    )
  }
  for (const from of dirty) {
    const seg = bySeg.get(from)
    seg.rows.sort((x, y) => x[0] - y[0] || x[1] - y[1])
    seg.rows = seg.rows.filter(
      (r, i, arr) => i === 0 || r[0] !== arr[i - 1][0] || r[1] !== arr[i - 1][1],
    )
    writeJson(segPath(key, from), seg)
  }
  writeJson(auditPath, audit, true)
  log(
    `audit ${key}: ${gaps.length} gap(s) over ${feed.auditGapHours} h, ${repaired} rounds recovered`,
  )
}

async function phaseOracle(ring) {
  const client = ring.readClient()
  const head = await client.getBlockNumber()
  log(`head ${head}`)
  for (const [key, feed] of Object.entries(FEEDS)) {
    const table = await phaseTable(client, key, feed, head)
    await scanFeed(ring, key, feed, table, head)
    await auditFeed(ring, key, feed, table)
    await phaseHandovers(client, key, feed, table)
  }
}

/** --phase=handover alone: the phase-switch reads on the cached phase tables. */
async function phaseHandoverOnly(ring) {
  const client = ring.readClient()
  const head = await client.getBlockNumber()
  for (const [key, feed] of Object.entries(FEEDS)) {
    const table = await phaseTable(client, key, feed, head)
    await phaseHandovers(client, key, feed, table)
  }
}

// ------------------------------------------------------------------ rates (archive eth_call)

/** The first oracle block of each UTC day (within its first 6 h), from the ETH/USD cache. */
function dayBlocks() {
  const { hours } = loadOracleHours('eth-usd')
  const out = []
  for (let d = GRID_START; d <= GRID_END; d += DAY) {
    let block = null
    for (let h = d; h < d + 6 * H; h += H) {
      const x = hours.get(h)
      if (x) {
        block = x[5]
        break
      }
    }
    out.push({ day: d, block })
  }
  return out
}

async function readRate(client, rate, block) {
  try {
    const v = await client.readContract({
      address: rate.address,
      abi: RATE_ABI,
      functionName: rate.fn,
      blockNumber: BigInt(block),
    })
    const x = Number(v) / 1e18
    return x > 0 ? x : null
  } catch (e) {
    if (isAbsent(e)) return null
    throw e
  }
}

async function phaseRates(ring) {
  const client = ring.readClient()
  const days = dayBlocks().filter((d) => d.block != null)
  if (days.length === 0)
    throw new Error('rates: no ETH/USD oracle blocks cached — run --phase=oracle first')
  for (const [name, rate] of Object.entries(RATES)) {
    const path = join(CACHE, 'rates', `${name}.json`)
    const cache = readJson(path) ?? { name, values: {} }
    // First readable day: bisect (a contract that exists keeps existing).
    let first = cache.firstDay ?? null
    if (first == null) {
      let a = 0
      let b = days.length - 1
      if ((await withRetry(() => readRate(client, rate, days[b].block), name)) == null) {
        log(`rates ${name}: unreadable at head — skipped`)
        continue
      }
      while (a < b) {
        const mid = (a + b) >> 1
        if ((await withRetry(() => readRate(client, rate, days[mid].block), name)) != null) b = mid
        else a = mid + 1
      }
      first = days[a].day
      cache.firstDay = first
    }
    const todo = days.filter((d) => d.day >= first && cache.values[d.day] === undefined)
    let done = 0
    const worker = async () => {
      for (;;) {
        const d = todo.shift()
        if (!d) return
        cache.values[d.day] = [
          d.block,
          await withRetry(() => readRate(client, rate, d.block), `${name}@${d.block}`),
        ]
        done++
        if (done % 100 === 0) {
          writeJson(path, cache)
          log(`  rates ${name}: ${done} days read`)
        }
        await sleep(50)
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker))
    writeJson(path, cache)
    log(`rates ${name}: first readable day ${iso(first)}, ${done} new day(s) read`)
  }
}

// ------------------------------------------------------------------ build

function marketColumns(source, key, dp) {
  const dir = join(CACHE, 'market', `${source}-${key}`)
  const close = new Array(GRID_COUNT).fill(null)
  const low = new Array(GRID_COUNT).fill(null)
  const high = new Array(GRID_COUNT).fill(null)
  if (!existsSync(dir)) return null
  for (const f of readdirSync(dir)) {
    const m = readJson(join(dir, f))
    for (const [ts, h, l, c] of m?.rows ?? []) {
      const i = (ts - GRID_START) / H
      if (!Number.isInteger(i) || i < 0 || i >= GRID_COUNT) continue
      if (!(c > 0 && l > 0 && h > 0)) continue
      close[i] = round(c, dp)
      low[i] = round(l, dp)
      high[i] = round(h, dp)
    }
  }
  return { close, low, high }
}

/**
 * Oracle columns: close = round in force at the hour's end; low/high include the round in
 * force at its start. Forward-filled across hours with no round — but never past
 * `maxStaleHours` after the last round: a feed that went silent is null, not flat.
 */
function oracleColumns(hours, dp, maxStaleHours) {
  const close = new Array(GRID_COUNT).fill(null)
  const low = new Array(GRID_COUNT).fill(null)
  const high = new Array(GRID_COUNT).fill(null)
  let inForce = null
  let inForceHour = -Infinity
  const pre = [...hours.keys()].filter((t) => t < GRID_START).sort((a, b) => a - b)
  if (pre.length) {
    inForceHour = pre[pre.length - 1]
    inForce = hours.get(inForceHour)[1]
  }
  for (let i = 0; i < GRID_COUNT; i++) {
    const ts = GRID_START + i * H
    const x = hours.get(ts)
    const fresh = inForce != null && ts - inForceHour <= maxStaleHours * H
    if (x) {
      const [, last, lo, hi] = x
      low[i] = round(fresh ? Math.min(inForce, lo) : lo, dp)
      high[i] = round(fresh ? Math.max(inForce, hi) : hi, dp)
      close[i] = round(last, dp)
      inForce = last
      inForceHour = ts
    } else if (fresh) {
      close[i] = low[i] = high[i] = round(inForce, dp)
    }
  }
  return { close, low, high }
}

/**
 * Primary segments: the oracle wherever it has a value inside a run of at least
 * MIN_ORACLE_RUN_HOURS, the fallback market everywhere else. Contiguous runs of one
 * source become one segment.
 */
function primarySegments(oracle, fallback, count) {
  const useOracle = new Array(count).fill(false)
  if (oracle) {
    for (let i = 0; i < count; ) {
      if (oracle[i] == null) {
        i++
        continue
      }
      let j = i
      while (j + 1 < count && oracle[j + 1] != null) j++
      if (j - i + 1 >= MIN_ORACLE_RUN_HOURS) for (let k = i; k <= j; k++) useOracle[k] = true
      i = j + 1
    }
  }
  const segs = []
  for (let i = 0; i < count; i++) {
    const source = useOracle[i] ? 'oracle' : fallback
    if (!source) continue
    const last = segs[segs.length - 1]
    if (last && last.source === source && last.toIndex === i - 1) last.toIndex = i
    else segs.push({ source, fromIndex: i, toIndex: i })
  }
  return segs
}

/** Longest stretch without a single round, per calendar year (heartbeat check). */
function roundGaps(hours) {
  const ts = [...hours.keys()].filter((t) => t >= GRID_START).sort((a, b) => a - b)
  const byYear = {}
  for (let i = 1; i < ts.length; i++) {
    const gapH = (ts[i] - ts[i - 1]) / H
    const y = new Date(ts[i] * 1000).getUTCFullYear()
    if (!byYear[y] || gapH > byYear[y].maxGapHours)
      byYear[y] = { maxGapHours: gapH, endingAt: iso(ts[i]) }
  }
  return byYear
}

function coverageOf(col) {
  let from = -1
  let to = -1
  let n = 0
  for (let i = 0; i < col.length; i++) {
    if (col[i] != null) {
      if (from < 0) from = i
      to = i
      n++
    }
  }
  if (from < 0) return null
  return {
    from: iso(GRID_START + from * H),
    to: iso(GRID_START + to * H),
    fromIndex: from,
    toIndex: to,
    hours: n,
    missing: to - from + 1 - n,
  }
}

const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null)
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null)

function diffSummary(a, b, grid, range) {
  const s = seriesDiffStats(a, b, grid, range)
  return {
    n: s.n,
    meanBps: r1(s.meanBps),
    medianAbsBps: r1(s.medianAbsBps),
    p90AbsBps: r1(s.p90AbsBps),
    p99AbsBps: r1(s.p99AbsBps),
    maxAbsBps: r1(s.maxAbsBps),
    maxAt: isoDate(s.maxTs),
  }
}

function crossCheck(file) {
  const grid = { startTs: file.startTs, stepSeconds: file.stepSeconds }
  const c = file.columns
  const pairs = [
    ['oracle', 'binance'],
    ['oracle', 'coinbase'],
    ['binance', 'coinbase'],
  ].filter(([a, b]) => c[a] && c[b])
  const out = {}
  for (const [a, b] of pairs) {
    const byYear = {}
    for (let y = 2020; y <= new Date(GRID_END * 1000).getUTCFullYear(); y++) {
      const from = (Date.UTC(y, 0, 1) / 1000 - GRID_START) / H
      const to = (Date.UTC(y + 1, 0, 1) / 1000 - GRID_START) / H - 1
      const s = diffSummary(c[a], c[b], grid, { fromIndex: from, toIndex: to })
      if (s.n) byYear[y] = s
    }
    const lowDiff = seriesDiffStats(c[`${a}Low`], c[`${b}Low`], grid)
    let deeper2 = 0
    let deeper5 = 0
    for (let i = 0; i < GRID_COUNT; i++) {
      const x = c[`${a}Low`][i]
      const y = c[`${b}Low`][i]
      if (x == null || y == null) continue
      if (y <= x * 0.98) deeper2++
      if (y <= x * 0.95) deeper5++
    }
    out[`${a}_vs_${b}`] = {
      close: diffSummary(c[a], c[b], grid),
      closeByYear: byYear,
      low: {
        meanBps: r1(lowDiff.meanBps),
        medianAbsBps: r1(lowDiff.medianAbsBps),
        p99AbsBps: r1(lowDiff.p99AbsBps),
        maxAbsBps: r1(lowDiff.maxAbsBps),
        maxAt: isoDate(lowDiff.maxTs),
      },
      [`hoursWhere_${b}Low_2pctBelow_${a}Low`]: deeper2,
      [`hoursWhere_${b}Low_5pctBelow_${a}Low`]: deeper5,
    }
  }
  return out
}

function tableOut(rows) {
  return rows.map((r) => ({
    window: r.label,
    n: r.n,
    effectiveN: r.effectiveN,
    p50: r4(r.p50),
    p90: r4(r.p90),
    p99: r4(r.p99),
    max: r4(r.max),
    maxAt: isoDate(r.maxTs),
  }))
}

function eventsOut(file, sources) {
  const out = []
  for (const ev of EVENTS) {
    const from = (Date.parse(`${ev.from}T00:00:00Z`) / 1000 - GRID_START) / H
    const to = (Date.parse(`${ev.to}T00:00:00Z`) / 1000 - GRID_START) / H - 1
    if (from >= GRID_COUNT) continue
    const row = {
      id: ev.id,
      label: ev.label,
      from: ev.from,
      to: ev.to,
      worst24hForwardDrawdown: {},
    }
    for (const src of sources) {
      const g = src === 'primary' ? primaryGrid(file) : gridFromFile(file, src)
      const d = forwardDrawdowns(g, 24)
      let best = -1
      let at = -1
      for (let i = Math.max(0, from); i <= Math.min(to, GRID_COUNT - 1); i++) {
        if (Number.isFinite(d[i]) && d[i] > best) {
          best = d[i]
          at = i
        }
      }
      row.worst24hForwardDrawdown[src] =
        at < 0
          ? null
          : { drop: r4(best), entryAt: iso(GRID_START + at * H), entryPrice: g.close[at] }
    }
    out.push(row)
  }
  return out
}

function recoveryOut(rows) {
  return rows.map((r) => ({
    drop: r.drop,
    events: r.events,
    recovered: r.recovered,
    p: r4(r.p),
    ci95: [r4(r.ciLow), r4(r.ciHigh)],
    medianHoursToRecover: Number.isFinite(r.medianStepsToRecover) ? r.medianStepsToRecover : null,
    meanMaxDrop: r4(r.meanMaxDrop),
  }))
}

function worstOut(g, hours, k) {
  return worstWindows(g, hours, k).map((w) => ({
    entryAt: iso(w.ts),
    entryPrice: w.entryPrice,
    troughAt: iso(w.troughTs),
    troughPrice: w.troughPrice,
    drop: r4(w.drop),
  }))
}

/** The gap audit, compacted for the manifest: recovered vs confirmed-real silences. */
function auditSummary(key) {
  const a = readJson(join(CACHE, 'oracle', key, 'audit.json'))
  if (!a) return null
  const gaps = Object.values(a.gaps)
  const recovered = gaps.filter((g) => g.repairedRounds > 0)
  const real = gaps.filter((g) => g.repairedRounds === 0)
  return {
    auditGapHours: FEEDS[key].auditGapHours,
    gapsAudited: gaps.length,
    recoveredGaps: recovered.length,
    recoveredRounds: recovered.reduce((x, g) => x + g.repairedRounds, 0),
    confirmedSilences: real.map((g) => ({
      from: g.fromTs,
      to: g.toTs,
      hours: g.hours,
      confirmedEmptyBy: g.confirmedEmptyBy,
      outOfPhaseLogs: g.outOfPhaseLogs ?? 0,
    })),
  }
}

/** The handover rounds as the manifest lists them (one per phase switch). */
function handoversOut(handovers) {
  return handovers.map((h) => ({
    phase: h.phase,
    switchBlock: h.fromBlock,
    switchUtc: iso(h.switchTs),
    price: h.price,
    roundUpdatedUtc: h.updatedAt ? iso(h.updatedAt) : null,
  }))
}

function fileSize(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function phaseBuild(ringStats) {
  mkdirSync(OUT_DIR, { recursive: true })
  const manifest = {
    name: 'Multi-year hourly price history (set-and-forget LTV sim)',
    generatedAt: new Date().toISOString(),
    generatedBy: 'scripts/position-sim/build-price-history.mjs',
    statistics: 'lib/position-sim/drawdowns.ts',
    grid: {
      startUtc: iso(GRID_START),
      endUtc: iso(GRID_END),
      startTs: GRID_START,
      stepSeconds: H,
      count: GRID_COUNT,
      convention:
        'index i is the hour opening at startTs + i*3600; close = price at the END of the hour (kline close / Chainlink round in force at the hour end); low/high = range inside the hour, including the opening value; null = no observation',
    },
    sources: {
      oracle:
        'Chainlink AnswerUpdated logs of every phase aggregator of the feed proxy, each counted only inside its own phase window (switch blocks bisected from the proxy phaseId() over archive state), plus one handover round per switch (latestRoundData() of the new phase aggregator at the block before the switch, stamped at the switch block — what the proxy served from then on), timestamps = the event updatedAt, forward-filled across hours with no round',
      binance: MARKETS.binance.label,
      coinbase: MARKETS.coinbase.label,
    },
    assets: {},
    files: {},
  }
  const summary = {
    generatedAt: manifest.generatedAt,
    statistics: 'lib/position-sim/drawdowns.ts',
    definitions: {
      forward:
        'entry-relative: 1 - (lowest LOW in the next w hours) / (entry hour CLOSE), at every entry hour — the set-and-forget quantity',
      rolling:
        'deepest running-CLOSE-peak to later LOW inside each w-hour window, at every window end',
      effectiveN: 'n / w — roughly how many independent windows the overlapping sample holds',
      recovery:
        'events = first hour whose LOW is >= drop below the highest CLOSE of the previous 24 h (de-clustered: a new event needs a pre-drop level set after the last one resolved); recovered = a CLOSE back at >= (1 - 4%) x that level within the 8 hours counted from the event hour opening ("close") — or any later hour HIGH ("high")',
    },
    assets: {},
  }

  for (const [key, a] of Object.entries(ASSETS)) {
    const columns = {}
    for (const source of Object.keys(MARKETS)) {
      const m = marketColumns(source, key, a.dp)
      if (!m) continue
      columns[source] = m.close
      columns[`${source}Low`] = m.low
      columns[`${source}High`] = m.high
    }
    const oh = loadOracleHours(key)
    if (oh.hours.size) {
      const o = oracleColumns(oh.hours, a.dp, FEEDS[key].maxStaleHours)
      columns.oracle = o.close
      columns.oracleLow = o.low
      columns.oracleHigh = o.high
    }
    const file = { asset: a.asset, startTs: GRID_START, stepSeconds: H, count: GRID_COUNT, columns }
    const xc = crossCheck(file)
    // Where the oracle has no usable run: the market that tracked the oracle tightest.
    const oc = columns.oracle ? coverageOf(columns.oracle) : null
    const candidates = Object.keys(MARKETS)
      .filter((s) => columns[s])
      .map((s) => ({ s, med: xc[`oracle_vs_${s}`]?.close.medianAbsBps ?? Infinity }))
      .sort((x, y) => x.med - y.med)
    const fallback = candidates[0]?.s ?? null
    const segments = primarySegments(columns.oracle, fallback, GRID_COUNT)
    const firstOracle = segments.find((x) => x.source === 'oracle')
    file.primary = {
      segments,
      note: firstOracle
        ? `oracle-grade from ${iso(GRID_START + firstOracle.fromIndex * H)}` +
          (segments.length > 1
            ? `; ${fallback} wherever the oracle has no run of >= ${MIN_ORACLE_RUN_HOURS} h (chosen as the lowest median |close diff| vs the oracle: ${candidates.map((c) => `${c.s} ${c.med} bps`).join(', ')})`
            : '')
        : `no usable oracle run; ${fallback} throughout`,
    }
    const outPath = join(OUT_DIR, `${key}-1h.json`)
    writeJson(outPath, file)
    const phases = readJson(join(CACHE, 'oracle', key, 'phases.json'))
    manifest.assets[key] = {
      asset: a.asset,
      file: `${key}-1h.json`,
      coverage: Object.fromEntries(
        Object.keys(columns)
          .filter((c) => !/Low$|High$/.test(c))
          .map((c) => [c, coverageOf(columns[c])]),
      ),
      primary: {
        segments: segments.map((s) => ({
          ...s,
          from: iso(GRID_START + s.fromIndex * H),
          to: iso(GRID_START + s.toIndex * H),
        })),
        note: file.primary.note,
      },
      oracle: phases
        ? {
            proxy: phases.proxy,
            description: phases.description,
            decimals: phases.decimals,
            phases: phases.phases,
            rounds: oh.events,
            logsOutsideTheirPhaseWindow: oh.outOfPhase,
            phaseHandovers: handoversOut(oh.handovers),
            longestGapWithoutARoundByYear: roundGaps(oh.hours),
            maxStaleHours: FEEDS[key].maxStaleHours,
            gapAudit: auditSummary(key),
          }
        : null,
      crossCheck: xc,
    }

    // ---- summary statistics (drawdowns.ts)
    const prim = primaryGrid(file)
    // Source comparisons run over the oracle's USABLE span (its first primary segment), so
    // a market's Mar-2020 crash is never set against an oracle that was not running yet.
    const oracleFrom = firstOracle ? firstOracle.fromIndex : null
    const oracleRange =
      oracleFrom !== null ? { fromIndex: oracleFrom, toIndex: GRID_COUNT - 1 } : {}
    const sameSpan = {}
    for (const src of ['oracle', ...Object.keys(MARKETS)]) {
      if (!columns[src]) continue
      sameSpan[src] = tableOut(
        drawdownTable(gridFromFile(file, src), { mode: 'forward', ...oracleRange }),
      )
    }
    const wicks = {}
    for (const src of ['oracle', ...Object.keys(MARKETS)]) {
      if (!columns[src]) continue
      const w2 = intrabarWicks(gridFromFile(file, src), 0.02).filter(
        (w) => oracleFrom === null || w.index >= oracleFrom,
      )
      const w5 = w2.filter((w) => w.depth >= 0.05)
      wicks[src] = {
        atLeast2pct: w2.length,
        atLeast5pct: w5.length,
        deepest: w2
          .sort((x, y) => y.depth - x.depth)
          .slice(0, 3)
          .map((w) => ({ at: iso(w.ts), depth: r4(w.depth) })),
      }
    }
    summary.assets[key] = {
      asset: a.asset,
      primarySegments: manifest.assets[key].primary.segments,
      forward: tableOut(drawdownTable(prim, { mode: 'forward' })),
      rolling: tableOut(drawdownTable(prim, { mode: 'rolling' })),
      forwardBySourceOverOracleSpan: {
        from: oracleFrom === null ? null : iso(GRID_START + oracleFrom * H),
        ...sameSpan,
      },
      recovery24hLookback: {
        close: recoveryOut(
          recoveryCurve(prim, RECOVERY_DROPS, { lookbackSteps: 24, recoverOn: 'close' }),
        ),
        high: recoveryOut(
          recoveryCurve(prim, RECOVERY_DROPS, { lookbackSteps: 24, recoverOn: 'high' }),
        ),
      },
      recovery8hLookback: {
        close: recoveryOut(
          recoveryCurve(prim, RECOVERY_DROPS, { lookbackSteps: 8, recoverOn: 'close' }),
        ),
      },
      worstWindows: {
        '24h': worstOut(prim, 24, 6),
        '7d': worstOut(prim, 168, 5),
        '30d': worstOut(prim, 720, 5),
      },
      intrabarWicksOverOracleSpan: {
        from: oracleFrom === null ? null : iso(GRID_START + oracleFrom * H),
        ...wicks,
      },
      events: eventsOut(file, [
        'primary',
        ...['oracle', ...Object.keys(MARKETS)].filter((s) => columns[s]),
      ]),
    }
    log(`build ${key}: ${GRID_COUNT} hours, segments ${file.primary.note}`)
  }

  // ---- stETH/ETH market feed (depeg path)
  const sh = loadOracleHours('steth-eth')
  if (sh.hours.size) {
    const o = oracleColumns(sh.hours, 6, FEEDS['steth-eth'].maxStaleHours)
    const file = {
      asset: 'STETH/ETH',
      startTs: GRID_START,
      stepSeconds: H,
      count: GRID_COUNT,
      columns: { oracle: o.close, oracleLow: o.low, oracleHigh: o.high },
      primary: {
        segments: [],
        note: 'Chainlink STETH/ETH market feed (deviation/heartbeat updates, forward-filled)',
      },
    }
    const oc = coverageOf(o.close)
    if (oc)
      file.primary.segments.push({
        source: 'oracle',
        fromIndex: oc.fromIndex,
        toIndex: GRID_COUNT - 1,
      })
    writeJson(join(OUT_DIR, 'steth-eth-1h.json'), file)
    const phases = readJson(join(CACHE, 'oracle', 'steth-eth', 'phases.json'))
    manifest.assets['steth-eth'] = {
      asset: 'STETH/ETH',
      file: 'steth-eth-1h.json',
      coverage: { oracle: oc },
      oracle: phases
        ? {
            proxy: phases.proxy,
            description: phases.description,
            decimals: phases.decimals,
            phases: phases.phases,
            rounds: sh.events,
            logsOutsideTheirPhaseWindow: sh.outOfPhase,
            phaseHandovers: handoversOut(sh.handovers),
            longestGapWithoutARoundByYear: roundGaps(sh.hours),
            maxStaleHours: FEEDS['steth-eth'].maxStaleHours,
            gapAudit: auditSummary('steth-eth'),
          }
        : null,
      note: 'MARKET price of stETH in ETH (the discount path). wstETH/ETH at market = this x stEthPerToken (lst-rates-1d.json). Aave and most lenders price wstETH through the exchange rate, not this feed.',
    }
    const g = gridFromFile(file, 'oracle')
    let minV = Infinity
    let minAt = -1
    for (let i = 0; i < GRID_COUNT; i++) {
      const v = o.low[i]
      if (v != null && v < minV) {
        minV = v
        minAt = i
      }
    }
    summary.assets['steth-eth'] = {
      asset: 'STETH/ETH (market discount)',
      forward: tableOut(drawdownTable(g, { mode: 'forward' })),
      deepestPrint: { at: iso(GRID_START + minAt * H), price: minV },
      worstWindows: { '7d': worstOut(g, 168, 5), '30d': worstOut(g, 720, 3) },
    }
    log(`build steth-eth: coverage from ${oc?.from}`)
  }

  // ---- exchange-rate paths (daily)
  const dayCount = Math.floor((GRID_END - GRID_START) / DAY) + 1
  const rateCols = {}
  const rateMeta = {}
  for (const [name, rate] of Object.entries(RATES)) {
    const cache = readJson(join(CACHE, 'rates', `${name}.json`))
    if (!cache) continue
    const col = new Array(dayCount).fill(null)
    let n = 0
    let maxStepDown = 0
    let prev = null
    for (let i = 0; i < dayCount; i++) {
      const hit = cache.values[GRID_START + i * DAY]
      if (hit && hit[1] != null) {
        col[i] = Math.round(hit[1] * 1e9) / 1e9
        n++
        if (prev != null && hit[1] < prev) maxStepDown = Math.max(maxStepDown, 1 - hit[1] / prev)
        prev = hit[1]
      }
    }
    rateCols[name] = col
    const cov = coverageOf(col)
    rateMeta[name] = {
      source: rate.label,
      contract: rate.address,
      firstDay: cov ? iso(GRID_START + cov.fromIndex * DAY) : null,
      days: n,
      first: cov ? col[cov.fromIndex] : null,
      last: cov ? col[cov.toIndex] : null,
      largestDayOverDayDecline: r4(maxStepDown),
    }
  }
  if (Object.keys(rateCols).length) {
    writeJson(join(OUT_DIR, 'lst-rates-1d.json'), {
      asset: 'LST exchange rates (per ETH)',
      startTs: GRID_START,
      stepSeconds: DAY,
      count: dayCount,
      readAt:
        'archive eth_call at the block of the first Chainlink ETH/USD round of each UTC day (within its first 6 h)',
      columns: rateCols,
    })
    manifest.assets['lst-rates'] = { file: 'lst-rates-1d.json', stepSeconds: DAY, rates: rateMeta }
  }

  if (ringStats) manifest.rpc = ringStats
  writeJson(join(OUT_DIR, 'summary.json'), summary, true)
  for (const f of readdirSync(OUT_DIR).filter(
    (x) => x.endsWith('.json') && x !== 'manifest.json',
  )) {
    manifest.files[f] = fileSize(join(OUT_DIR, f))
  }
  writeJson(join(OUT_DIR, 'manifest.json'), manifest, true)
  manifest.files['manifest.json'] = fileSize(join(OUT_DIR, 'manifest.json'))
  writeJson(join(OUT_DIR, 'manifest.json'), manifest, true)
  const total = Object.values(manifest.files).reduce((x, y) => x + y, 0)
  log(
    `build: wrote ${Object.keys(manifest.files).length} files, ${(total / 1e6).toFixed(2)} MB total`,
  )
  if (total > 30e6)
    throw new Error(`price history is ${(total / 1e6).toFixed(1)} MB — over the 30 MB budget`)
}

// ------------------------------------------------------------------ main

async function main() {
  log(
    `grid ${iso(GRID_START)} → ${iso(GRID_END)} (${GRID_COUNT} hours); phases: ${PHASES.join(',')}`,
  )
  if (runs('market')) await phaseMarket()
  let ring = null
  if (runs('oracle') || runs('rates') || PHASES.includes('handover')) {
    if (ENV_URLS.length === 0)
      log('warning: RECORDER_RPC_URL is empty — the ring runs on public endpoints only')
    ring = await makeRing()
  }
  if (runs('oracle')) await phaseOracle(ring)
  else if (PHASES.includes('handover')) await phaseHandoverOnly(ring)
  if (runs('rates')) await phaseRates(ring)
  let ringStats = null
  if (ring) {
    ringStats = ring.stats()
    if (!flag('no-ring-stats')) ring.saveStats('price-history')
  }
  if (runs('build')) phaseBuild(ringStats)
}

main().catch((e) => {
  console.error(redact(e?.stack ?? e))
  process.exit(1)
})
