/**
 * NET-APY HISTORY — the venue yield behind the set-and-forget return statement (Q20).
 *
 * The return half of the set-and-forget sim needs what the deployed debt EARNED over a
 * named window. Owner rule: venue yield comes from the net-APY history of lib/netApy
 * (PR #92); where that history does not exist, the yield is unavailable and is never
 * invented. This script builds that history with lib/netApy's own pinned-block reader:
 * every sample is `readVenueSnapshot` at one archive block, priced by `ratesAtSize`, the
 * code that matches each venue's on-chain getter exactly (docs/NET_APY_AT_SIZE.md).
 * Nothing here re-implements a rate model.
 *
 * WHERE IT STOPS. lib/netApy reads Aave v3 through `getVirtualUnderlyingBalance` and the
 * v2 rate strategy (`getInterestRateDataBps`). Both exist only from Aave v3.1 (mid-2024).
 * Before that block the reader throws, so the history starts at the first readable block
 * and the return statement says "unavailable" for any window that starts earlier. The
 * first readable block is found by bisection and published with the last failing read.
 *
 * WHAT ONE SAMPLE HOLDS (venue `aave-v3-usdc`, default)
 *   util, borrowApr        at the sample block, no added size
 *   supplyApr@<size>       the venue supply APR (after the reserve factor) once a deposit
 *                          of <size> USD is added: 0 (the marginal rate), and each
 *                          cash-vs-book book ($10M, $50M, $250M). Membrane's whole book
 *                          moves the rate it earns; the position's own deposit does not.
 *   reserveFactorBps       read at the block
 * plus, for the incumbent comparison, Aave v3 WETH's liquidation threshold and bonus
 * (`getReserveData(WETH).configuration`, bits 16–31 and 32–47) at the same block.
 *
 * SAMPLE BLOCKS come from public/data/venue-stress/history.json `timeline` (the archive
 * block that file read for each UTC hour), so a net-APY sample and a venue-stress row
 * share a block. Stride: --stride-hours (default 1). Keep it hourly: the Aave borrow series
 * the return statement charges is hourly, and a coarser grid holds one sample for hours. A 6 h
 * grid landed on 00:00 UTC every day, the hour of Aave USDC's daily drain (SET-AND-FORGET-LTV.md
 * "transient"), and held a ~55% supply APR for 6 h where the hourly borrow APR averaged ~15%.
 * Resumable: rows append to
 * data/price-history/cache/net-apy-history/<venue>.jsonl (gitignored).
 *
 * DATA IS PRIVATE (board rule N18). The output is fetched data, so it goes to the private
 * datasets repo ($MEMBRANE_DATASETS_DIR, default ../membrane-datasets), directory
 * net-apy-history/, never into this public repo. Update net-apy-history/PROVENANCE.md there.
 *
 * Run (from the repo root):
 *   ./node_modules/.bin/tsx scripts/position-sim/build-net-apy-history.ts [--stride-hours=1]
 *       [--concurrency=10] [--venues=aave-v3-usdc]
 * Writes <datasets>/net-apy-history/<venue>-<stride>h.json. RPC: NET_APY_RPC_URL /
 * RECORDER_RPC_URL from the env or .env.local first, then the public archive gateways
 * (lib/netApy/rpc.ts). Output names hosts only, never URLs.
 */
import fs from 'node:fs'
import path from 'node:path'

import { createPublicClient, fallback, http, type PublicClient } from 'viem'
import { mainnet } from 'viem/chains'

import { datasetsDir } from '../lib/datasetsDir.mjs'

import { ratesAtSize } from '../../lib/netApy/irm'
import { poolAbi, readVenueSnapshot } from '../../lib/netApy/read'
import { envRpcUrls, PUBLIC_ARCHIVE_RPCS, redactError } from '../../lib/netApy/rpc'
import type { BlockAnchor } from '../../lib/netApy/types'
import { AAVE_V3_POOL, NET_APY_VENUES, usdToRaw, type VenueDef } from '../../lib/netApy/venues'
import { EXIT_CAPACITY_BOOKS } from '../../lib/position-sim/exitCapacityAnalogs'
import {
  NET_APY_HISTORY_DIR,
  NET_APY_HISTORY_SCHEMA,
  netApyHistoryFileName,
  type NetApyHistoryFile,
  type NetApyHistoryVenue,
} from '../../lib/position-sim/returnStatement'

const ROOT = process.cwd()
const CACHE = path.join(ROOT, 'data/price-history/cache/net-apy-history')
const VENUE_STRESS = path.join(ROOT, 'public/data/venue-stress/history.json')

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const

const args = new Map<string, string>()
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
  if (m) args.set(m[1], m[2] ?? 'true')
}
const STRIDE_H = Math.max(1, Number(args.get('stride-hours') ?? 1))
const CONCURRENCY = Math.max(1, Number(args.get('concurrency') ?? 10))
const VENUES = (args.get('venues') ?? 'aave-v3-usdc').split(',')

/** Sizes the supply APR is priced at, USD: the marginal rate, then each book. */
const SIZES_USD: readonly number[] = [0, ...EXIT_CAPACITY_BOOKS.map((b) => b.usd)]

// ------------------------------------------------------------------ rpc

const PUBLIC_ARCHIVE = PUBLIC_ARCHIVE_RPCS.filter((u) => !u.includes('publicnode')) // refuses archive reads without a token
const urls = [...envRpcUrls(), ...PUBLIC_ARCHIVE]
const hosts = urls.map((u) => new URL(u).host)
const client = createPublicClient({
  chain: mainnet,
  transport: fallback(
    urls.map((u) => http(u, { timeout: 20_000, retryCount: 2 })),
    { rank: false, retryCount: 2 },
  ),
  batch: { multicall: { wait: 16 } },
}) as PublicClient

async function anchorAt(b: number): Promise<BlockAnchor> {
  const blk = await client.getBlock({ blockNumber: BigInt(b) })
  if (blk.number === null || blk.hash === null) throw new Error(`block ${b} has no number/hash`)
  return { chainId: 1, blockNumber: blk.number, blockTimestamp: blk.timestamp, blockHash: blk.hash }
}

// ------------------------------------------------------------------ sample

type Row = NetApyHistoryVenue['rows'][number]

async function sample(def: VenueDef, t: number, b: number): Promise<Row> {
  const anchor = await anchorAt(b)
  const s = await readVenueSnapshot(client, def, anchor, hosts[0])
  const at0 = ratesAtSize(s, { supply: 0n, borrow: 0n })
  const supply = SIZES_USD.map((usd) =>
    usd === 0
      ? at0.supplyApr
      : ratesAtSize(s, { supply: usdToRaw(usd, def.asset), borrow: 0n }).supplyApr,
  )
  const rf = 'reserveFactorBps' in s.state ? Number(s.state.reserveFactorBps) : null
  const rd = (await client.readContract({
    address: AAVE_V3_POOL,
    abi: poolAbi,
    functionName: 'getReserveData',
    args: [WETH],
    blockNumber: BigInt(b),
  })) as { configuration: bigint }
  const cfg = rd.configuration
  const lt = Number((cfg >> 16n) & 0xffffn)
  const bonus = Number((cfg >> 32n) & 0xffffn)
  return [
    t,
    Number(anchor.blockTimestamp),
    b,
    at0.utilization,
    at0.borrowApr,
    ...supply,
    rf,
    lt,
    bonus,
  ] as Row
}

const COLUMNS = [
  't',
  'blockTs',
  'b',
  'util',
  'borrowApr',
  ...SIZES_USD.map((u) => `supplyApr@${u}`),
  'reserveFactorBps',
  'wethLtBps',
  'wethBonusBps',
] as const

// ------------------------------------------------------------------ main

interface Timeline {
  t: number[]
  b: number[]
}

function timeline(): Timeline {
  const vs = JSON.parse(fs.readFileSync(VENUE_STRESS, 'utf8')) as { timeline: Timeline }
  return vs.timeline
}

async function readable(def: VenueDef, b: number): Promise<string | null> {
  try {
    await readVenueSnapshot(client, def, await anchorAt(b), hosts[0])
    return null
  } catch (e) {
    return redactError(e)
  }
}

/** First timeline index whose block lib/netApy can read (bisection; reads are monotone in
 *  the upgrade). Returns the last failing read too. */
async function firstReadable(
  def: VenueDef,
  tl: Timeline,
): Promise<{ index: number; lastFailure: { t: number; b: number; why: string } | null }> {
  let lo = 0
  let hi = tl.t.length - 1
  const lastErr = await readable(def, tl.b[hi])
  if (lastErr)
    throw new Error(`${def.venueKey}: not readable even at the last block ${tl.b[hi]}: ${lastErr}`)
  const firstErr = await readable(def, tl.b[lo])
  if (!firstErr) return { index: 0, lastFailure: null }
  let failure = { t: tl.t[lo], b: tl.b[lo], why: firstErr }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    const err = await readable(def, tl.b[mid])
    if (err) {
      lo = mid
      failure = { t: tl.t[mid], b: tl.b[mid], why: err }
    } else hi = mid
    console.log(`  bisect ${def.venueKey}: block ${tl.b[mid]} ${err ? 'fails' : 'reads'}`)
  }
  return { index: hi, lastFailure: failure }
}

async function buildVenue(def: VenueDef, tl: Timeline): Promise<NetApyHistoryVenue> {
  fs.mkdirSync(CACHE, { recursive: true })
  const cacheFile = path.join(CACHE, `${def.venueKey}.jsonl`)
  const metaFile = path.join(CACHE, `${def.venueKey}.meta.json`)
  let meta: { index: number; lastFailure: { t: number; b: number; why: string } | null }
  if (fs.existsSync(metaFile)) meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  else {
    meta = await firstReadable(def, tl)
    fs.writeFileSync(metaFile, JSON.stringify(meta))
  }
  console.log(
    `${def.venueKey}: first readable block ${tl.b[meta.index]} (${new Date(tl.t[meta.index] * 1000).toISOString()})`,
  )

  const done = new Map<number, Row>()
  if (fs.existsSync(cacheFile)) {
    for (const line of fs.readFileSync(cacheFile, 'utf8').split('\n')) {
      if (!line.trim()) continue
      const r = JSON.parse(line) as Row | { t: number; failed: string }
      if (Array.isArray(r)) done.set(r[0] as number, r)
    }
  }
  // Targets on the stride grid, aligned to UTC midnight, from the first readable hour.
  const targets: { t: number; b: number }[] = []
  for (let i = meta.index; i < tl.t.length; i++) {
    if ((tl.t[i] / 3600) % STRIDE_H !== 0) continue
    if (!done.has(tl.t[i]) && tl.b[i] > 0) targets.push({ t: tl.t[i], b: tl.b[i] })
  }
  console.log(
    `${def.venueKey}: ${done.size} cached, ${targets.length} to read at ${STRIDE_H}h stride, concurrency ${CONCURRENCY}`,
  )
  const failures: { t: number; b: number; why: string }[] = []
  const out = fs.openSync(cacheFile, 'a')
  let next = 0
  let n = 0
  const t0 = Date.now()
  const worker = async () => {
    while (next < targets.length) {
      const k = targets[next++]
      let row: Row | null = null
      let why = ''
      for (let attempt = 0; attempt < 3 && !row; attempt++) {
        try {
          row = await sample(def, k.t, k.b)
        } catch (e) {
          why = redactError(e)
        }
      }
      if (row) {
        done.set(k.t, row)
        fs.writeSync(out, JSON.stringify(row) + '\n')
      } else failures.push({ ...k, why })
      if (++n % 100 === 0) {
        const rate = n / ((Date.now() - t0) / 1000)
        console.log(`  ${n}/${targets.length} (${rate.toFixed(1)}/s, ${failures.length} failed)`)
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  fs.closeSync(out)
  const rows = [...done.values()].sort((a, b) => (a[0] as number) - (b[0] as number))
  return {
    venueKey: def.venueKey,
    label: def.label,
    columns: [...COLUMNS],
    firstReadable: { t: tl.t[meta.index], b: tl.b[meta.index] },
    lastUnreadable: meta.lastFailure,
    rows,
    failures,
  }
}

async function main() {
  const tl = timeline()
  const finalized = await client.getBlock({ blockTag: 'finalized' })
  const maxB = Math.max(...tl.b)
  if (finalized.number !== null && BigInt(maxB) > finalized.number)
    throw new Error('timeline block above finalized')
  const venues: Record<string, NetApyHistoryVenue> = {}
  for (const key of VENUES) {
    const def = NET_APY_VENUES.find((v) => v.venueKey === key)
    if (!def) throw new Error(`unknown net-APY venue ${key}`)
    if (def.protocol !== 'aave-v3')
      throw new Error(
        `${key}: only aave-v3 venues are wired (the incumbent params read Aave v3 WETH)`,
      )
    venues[key] = await buildVenue(def, tl)
  }
  const file: NetApyHistoryFile = {
    schema: NET_APY_HISTORY_SCHEMA,
    generatedAt: new Date().toISOString(),
    source:
      'lib/netApy readVenueSnapshot + ratesAtSize at pinned archive blocks (PR #92); sample blocks from public/data/venue-stress/history.json timeline',
    hosts,
    strideSeconds: STRIDE_H * 3600,
    sizesUsd: [...SIZES_USD],
    semantics: {
      t: 'target UTC hour (unix s)',
      blockTs: 'timestamp of the block read',
      b: 'archive block read',
      util: 'borrow utilization at the block, 0–1',
      borrowApr:
        'variable borrow APR at the block, fraction per year (lib/netApy ratesAtSize, no added size)',
      'supplyApr@<usd>':
        'venue supply APR after the reserve factor once <usd> is supplied, fraction per year (ratesAtSize)',
      reserveFactorBps: 'reserve factor read at the block',
      wethLtBps:
        'Aave v3 WETH liquidation threshold, bps (getReserveData(WETH).configuration bits 16-31)',
      wethBonusBps:
        'Aave v3 WETH liquidation bonus, bps incl. principal: 10500 = a 5% bonus (bits 32-47)',
    },
    venues,
  }
  const outDir = path.join(datasetsDir(ROOT), NET_APY_HISTORY_DIR)
  fs.mkdirSync(outDir, { recursive: true })
  const out = path.join(outDir, netApyHistoryFileName(VENUES, STRIDE_H))
  fs.writeFileSync(out, JSON.stringify(file) + '\n')
  for (const v of Object.values(venues)) {
    console.log(`${v.venueKey}: ${v.rows.length} samples, ${v.failures.length} failed → ${out}`)
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`[net-apy-history] ${redactError(e)}`)
    process.exit(1)
  },
)
