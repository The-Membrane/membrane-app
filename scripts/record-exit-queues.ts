/**
 * record-exit-queues.ts — the exit-queue ledger recorder (Layer: DATA).
 *
 *   pnpm exitq:record                       dry run: prints the plan, writes nothing
 *   pnpm exitq:record --run                 scan every venue to the finalized block
 *   pnpm exitq:record --run --venue lido-steth --days 30 --max-chunks 20
 *
 * For each venue it scans withdrawal-queue logs from the ledger's cursor to the
 * finalized block, applies them to data/exit-queue/<venue>.json, then reads the
 * queue depth and the parameters at the last scanned block. Re-running continues
 * from the cursor; a run cut short by --max-chunks leaves a consistent ledger.
 *
 * RPC: --rpc, else EXIT_QUEUE_RPC_URLS / RECORDER_RPC_URLS / RECORDER_RPC_URL from
 * the environment or .env.local (comma-separated; list the getLogs-capable keyed
 * endpoint first — free tiers cap eth_getLogs ranges and the reader halves the range
 * on a range error). URLs are never printed. Beacon: --beacon, else BEACON_API_URL,
 * else the public publicnode beacon endpoint.
 *
 * Historical eth_calls need --quorum matching answers (default 2): public relay
 * pools have returned other blocks' state for archive reads. --quorum 1 on a single
 * trusted archive endpoint halves the calls. --bisect caps ether.fi bisection reads.
 *
 * Manual only. Do not install it as a launchd job; the owner controls that fleet.
 */
import { parseAbiItem, type AbiFunction, type PublicClient } from 'viem'

import {
  beaconSnapshot,
  parseSpec,
  summarizeExitQueue,
  type ExitingValidator,
} from '../lib/exitQueue/beacon'
import type { LogFilter } from '../lib/exitQueue/decode'
import { recordSnapshot } from '../lib/exitQueue/ledger'
import { DEFAULT_DIR, loadLedger, saveLedger } from '../lib/exitQueue/store'
import { syncVenue, type ChainReader } from '../lib/exitQueue/sync'
import type { RawLog } from '../lib/exitQueue/types'
import { allVenues } from '../lib/exitQueue/venues'
// plain .mjs helper shared with the other recorders (allowJs types it)
import { makeClient, readEnv } from './lib/venue-reads.mjs'

const argv = process.argv.slice(2)
const flag = (name: string) => argv.includes(`--${name}`)
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const opts = (name: string) => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []))
const int = (name: string, fallback: number) => {
  const v = opt(name)
  const n = v == null ? fallback : Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer`)
  return n
}

function envValue(key: string): string | undefined {
  if (process.env[key]) return process.env[key]
  try {
    return readEnv().get(key) || undefined
  } catch {
    return undefined
  }
}

const rpc =
  opt('rpc') ??
  envValue('EXIT_QUEUE_RPC_URLS') ??
  envValue('RECORDER_RPC_URLS') ??
  envValue('RECORDER_RPC_URL')
const beaconUrl = (
  opt('beacon') ??
  envValue('BEACON_API_URL') ??
  'https://ethereum-beacon-api.publicnode.com'
).replace(/\/$/, '')
const hosts = (urls: string) =>
  urls
    .split(',')
    .map((u) => {
      try {
        return new URL(u.trim()).host
      } catch {
        return '?'
      }
    })
    .join(', ')

const RANGE_ERROR = /range|limit|too many|exceed|10000|5000|block range|query returned more/i

/**
 * Historical eth_call answers from a public relay pool are not trustworthy one at a
 * time: on 2026-10-05 Pocket answered ether.fi lastFinalizedRequestId at block
 * 25,930,000 with 82721 once and 82427 five times (dRPC: 82427 every time), and an
 * earlier read returned 82325, a value from ~22k blocks before. So a read older than
 * `recentFloor` is repeated until `quorum` answers agree; no agreement throws, and the
 * caller treats it as a failed read (bracket or reconcile, never a silent value).
 */
function makeReader(
  client: PublicClient,
  quorum: number,
): ChainReader & { rpcCalls: number; quorumMisses: number; recentFloor: number } {
  const tsCache = new Map<number, number>()
  const key = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x))
  const reader = {
    rpcCalls: 0,
    quorumMisses: 0,
    recentFloor: Number.MAX_SAFE_INTEGER,
    async blockTs(block: number) {
      const hit = tsCache.get(block)
      if (hit != null) return hit
      reader.rpcCalls += 1
      const b = await client.getBlock({ blockNumber: BigInt(block) })
      const ts = Number(b.timestamp)
      tsCache.set(block, ts)
      return ts
    },
    async call(address: string, signature: string, args: unknown[], block: number) {
      const fn = parseAbiItem(signature) as AbiFunction
      const once = () => {
        reader.rpcCalls += 1
        return client.readContract({
          address: address as `0x${string}`,
          abi: [fn],
          functionName: fn.name,
          args: args as never,
          blockNumber: BigInt(block),
        })
      }
      if (quorum <= 1 || block >= reader.recentFloor) return once()
      const votes = new Map<string, { value: unknown; n: number }>()
      for (let i = 0; i < quorum + 2; i += 1) {
        const value = await once()
        const vote = votes.get(key(value)) ?? { value, n: 0 }
        vote.n += 1
        votes.set(key(value), vote)
        if (vote.n >= quorum) return vote.value
      }
      reader.quorumMisses += 1
      throw new Error(`no ${quorum}-read quorum for ${fn.name} at ${block}`)
    },
    async getLogs(filter: LogFilter, fromBlock: number, toBlock: number): Promise<RawLog[]> {
      type Raw = {
        address: string
        topics: string[]
        data: string
        blockNumber: string
        logIndex: string
        transactionHash: string
        blockTimestamp?: string
        removed?: boolean
      }
      let raw: Raw[]
      try {
        reader.rpcCalls += 1
        raw = (await client.request({
          method: 'eth_getLogs',
          params: [
            {
              address: filter.address,
              topics: filter.topics as never,
              fromBlock: `0x${fromBlock.toString(16)}`,
              toBlock: `0x${toBlock.toString(16)}`,
            },
          ],
        } as never)) as Raw[]
      } catch (e) {
        const msg = String((e as Error)?.message ?? e)
        if (toBlock > fromBlock && RANGE_ERROR.test(msg)) {
          const mid = fromBlock + Math.floor((toBlock - fromBlock) / 2)
          return [
            ...(await reader.getLogs(filter, fromBlock, mid)),
            ...(await reader.getLogs(filter, mid + 1, toBlock)),
          ]
        }
        throw e
      }
      const out: RawLog[] = []
      for (const l of raw) {
        if (l.removed) continue
        const blockNumber = Number(BigInt(l.blockNumber))
        // Pocket and newer clients return blockTimestamp with each log; others need a block read.
        const blockTimestamp = l.blockTimestamp
          ? Number(BigInt(l.blockTimestamp))
          : await reader.blockTs(blockNumber)
        tsCache.set(blockNumber, blockTimestamp)
        out.push({
          address: l.address,
          topics: l.topics,
          data: l.data,
          blockNumber,
          logIndex: Number(BigInt(l.logIndex)),
          transactionHash: l.transactionHash,
          blockTimestamp,
        })
      }
      return out
    },
  }
  return reader
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${beaconUrl}${path}`, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`beacon ${path} → HTTP ${res.status}`)
  return (await res.json()) as T
}

async function recordBeacon(dir: string, run: boolean) {
  const header = await getJson<{
    data: { header: { message: { slot: string; state_root: string } } }
  }>('/eth/v1/beacon/headers/finalized')
  const slot = Number(header.data.header.message.slot)
  // Query by state root, not slot: it pins the exact state, and public nodes refuse
  // (HTTP 403) a numeric slot as state_id while serving the root.
  const stateRoot = header.data.header.message.state_root
  const block = await getJson<{
    data: { message: { body: { execution_payload: { block_number: string; timestamp: string } } } }
  }>(`/eth/v2/beacon/blocks/${slot}`)
  const payload = block.data.message.body.execution_payload
  const spec = parseSpec(
    (await getJson<{ data: Record<string, unknown> }>('/eth/v1/config/spec')).data,
  )
  const validators = await getJson<{ data: ExitingValidator[] }>(
    `/eth/v1/beacon/states/${stateRoot}/validators?status=active_exiting`,
  )
  const summary = summarizeExitQueue(slot, validators.data, spec)
  const snap = beaconSnapshot(summary, Number(payload.block_number), Number(payload.timestamp))
  console.log(
    `  beacon-exit  slot ${slot} block ${snap.block}: ${summary.exitingCount} exiting, ` +
      `${Number(BigInt(summary.exitingGwei) / 10n ** 9n).toLocaleString()} ETH, ` +
      `schedule tail ${summary.tailExitEpoch} (${(summary.scheduleWaitS / 86_400).toFixed(2)}d)`,
  )
  if (!run) return
  const ledger = loadLedger('beacon-exit', dir)
  recordSnapshot(ledger, snap)
  ledger.coverage ??= {
    fromBlock: snap.block,
    fromTs: snap.ts,
    throughBlock: snap.block,
    throughTs: snap.ts,
  }
  ledger.coverage.throughBlock = Math.max(ledger.coverage.throughBlock, snap.block)
  ledger.coverage.throughTs = Math.max(ledger.coverage.throughTs, snap.ts)
  saveLedger(ledger, dir)
}

async function main() {
  const run = flag('run')
  const dir = opt('dir') ?? DEFAULT_DIR
  const only = opts('venue')
  const venues = allVenues()
    .filter((v) => !only.length || only.includes(v.key))
    .sort((a, b) => a.priority - b.priority)
  if (!venues.length) throw new Error(`no venue matches ${only.join(', ')}`)
  const sync = {
    days: int('days', 30),
    chunkBlocks: int('chunk', 5_000),
    maxChunks: int('max-chunks', 60),
    // A 30-day first run of ether.fi needs ~18 reads per finalization; later runs far fewer.
    bisectCalls: int('bisect', 2_000),
    retentionDays: int('retention', 120),
  }
  console.log(`exit-queue recorder — ${run ? 'RUN' : 'DRY (add --run to write)'} → ${dir}`)
  console.log(`  rpc: ${rpc ? hosts(rpc) : 'NONE'} · beacon: ${new URL(beaconUrl).host}`)

  const client = rpc ? (makeClient(rpc) as PublicClient) : null
  const reader = client ? makeReader(client, int('quorum', 2)) : null
  const finalized = client ? await client.getBlock({ blockTag: 'finalized' }) : null
  const anchor = finalized
    ? { block: Number(finalized.number), ts: Number(finalized.timestamp) }
    : null
  if (anchor)
    console.log(
      `  anchor: finalized block ${anchor.block} (${new Date(anchor.ts * 1000).toISOString()})`,
    )
  // Reads within 64 blocks of the anchor are recent state, which every node serves.
  if (reader && anchor) reader.recentFloor = anchor.block - 64

  for (const def of venues) {
    try {
      if (def.kind === 'beacon') {
        await recordBeacon(dir, run)
        continue
      }
      if (!reader || !anchor) {
        console.log(`  ${def.key}  skipped: no RPC configured`)
        continue
      }
      const ledger = loadLedger(def.key, dir)
      const from = ledger.coverage
        ? ledger.coverage.throughBlock + 1
        : anchor.block - sync.days * 7_200
      if (!run) {
        console.log(
          `  ${def.key}  would scan ${from} → ${anchor.block} (${anchor.block - from + 1} blocks)`,
        )
        continue
      }
      const before = reader.rpcCalls
      const missesBefore = reader.quorumMisses
      const r = await syncVenue(def, ledger, reader, { ...sync, anchor })
      const file = saveLedger(r.ledger, dir)
      const snap = r.ledger.snapshots[r.ledger.snapshots.length - 1]
      console.log(
        `  ${def.key}  scanned → ${r.scannedTo}${r.complete ? '' : ' (PARTIAL: raise --max-chunks or re-run)'}; ` +
          `${r.logs} logs, ${reader.rpcCalls - before} rpc calls` +
          `${reader.quorumMisses > missesBefore ? ` (${reader.quorumMisses - missesBefore} reads without quorum)` : ''}; ` +
          `queue ${snap?.depthCount ?? '?'} req / ${snap?.depthAmount ?? '?'} raw ${def.unit.symbol}; ` +
          `${Object.keys(r.ledger.requests).length} requests in ledger, ` +
          `${r.ledger.unmatchedClaims} unmatched claims, ${r.ledger.undecodedLogs} undecoded → ${file}`,
      )
    } catch (e) {
      // One venue's failure never stops the others (same discipline as the recorder tick).
      console.error(`  ${def.key}  FAILED: ${String((e as Error)?.message ?? e).split('\n')[0]}`)
      process.exitCode = 1
    }
  }
}

main().catch((e) => {
  console.error(String((e as Error)?.message ?? e).split('\n')[0])
  process.exit(1)
})
