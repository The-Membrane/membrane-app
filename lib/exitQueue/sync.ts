import { decodeVenueLog, venueLogFilters, type LogFilter } from './decode'
import {
  applyEvents,
  findChangePoints,
  pruneLedger,
  recordParamSample,
  recordSnapshot,
  setParamCursor,
} from './ledger'
import type {
  BlockAnchor,
  LedgerEvent,
  ParamValue,
  QueueSnapshot,
  RawLog,
  VenueLedger,
} from './types'
import type { VenueDef } from './venues'

/**
 * One recorder pass for one venue: scan logs from the ledger's cursor to the anchor,
 * derive finalization points that have no event, apply, then read the queue and the
 * parameters at the last scanned block. All chain access goes through ChainReader so
 * the pass is testable without an RPC.
 */

export interface ChainReader {
  /** Logs for one filter over [from, to]. Must fill `blockTimestamp`. */
  getLogs(filter: LogFilter, fromBlock: number, toBlock: number): Promise<RawLog[]>
  /** eth_call of a `function …` signature at a block. */
  call(address: string, signature: string, args: unknown[], block: number): Promise<unknown>
  blockTs(block: number): Promise<number>
}

export interface SyncOptions {
  anchor: BlockAnchor
  /** First run only: how far back to start. */
  days: number
  chunkBlocks: number
  maxChunks: number
  /** eth_call budget for bisecting ether.fi finalization points. */
  bisectCalls: number
  retentionDays: number
}

export const BLOCKS_PER_DAY = 7_200
/** Synthetic events derived from reads apply after every log in their block. */
const END_OF_BLOCK = 1_000_000_000

export const KELP_ASSETS = [
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', // native ETH
  '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', // stETH
]

const SIG = {
  lido: {
    unfinalizedStETH: 'function unfinalizedStETH() view returns (uint256)',
    unfinalizedRequestNumber: 'function unfinalizedRequestNumber() view returns (uint256)',
    bunker: 'function isBunkerModeActive() view returns (bool)',
    paused: 'function isPaused() view returns (bool)',
  },
  etherfi: {
    lastFinalized: 'function lastFinalizedRequestId() view returns (uint32)',
    nextRequestId: 'function nextRequestId() view returns (uint32)',
    paused: 'function paused() view returns (bool)',
  },
  kelp: {
    nextLocked: 'function nextLockedNonce(address) view returns (uint256)',
    nextUnused: 'function nextUnusedNonce(address) view returns (uint256)',
    delay: 'function withdrawalDelayBlocks() view returns (uint256)',
    paused: 'function paused() view returns (bool)',
  },
  ethena: {
    cooldown: 'function cooldownDuration() view returns (uint24)',
    balanceOf: 'function balanceOf(address) view returns (uint256)',
  },
  maple: {
    totalShares: 'function totalShares() view returns (uint256)',
    queue: 'function queue() view returns (uint128, uint128)',
    manager: 'function manager() view returns (address)',
    withdrawalManager: 'function withdrawalManager() view returns (address)',
  },
} as const

async function tryCall(
  reader: ChainReader,
  address: string,
  sig: string,
  args: unknown[],
  block: number,
) {
  try {
    return await reader.call(address, sig, args, block)
  } catch {
    return null
  }
}

/** Historical reads through a public fallback ring fail transiently; try a few times. */
async function retryCall(
  reader: ChainReader,
  address: string,
  sig: string,
  args: unknown[],
  block: number,
  attempts = 3,
) {
  for (let i = 0; i < attempts; i += 1) {
    const v = await tryCall(reader, address, sig, args, block)
    if (v != null) return v
  }
  return null
}

const big = (v: unknown): bigint | null => (v == null ? null : BigInt(v as bigint))
const num = (v: unknown): number | null => (v == null ? null : Number(v))
const bool = (v: unknown): boolean | null => (v == null ? null : Boolean(v))

/** Parameter values a venue exposes as reads (compared run to run for silent changes). */
export async function readParams(
  def: VenueDef,
  reader: ChainReader,
  block: number,
): Promise<Record<string, ParamValue>> {
  const c = def.contracts
  switch (def.kind) {
    case 'lido':
      return {
        bunkerMode: bool(await tryCall(reader, c.queue, SIG.lido.bunker, [], block)),
        paused: bool(await tryCall(reader, c.queue, SIG.lido.paused, [], block)),
      }
    case 'etherfi':
      return { paused: bool(await tryCall(reader, c.queue, SIG.etherfi.paused, [], block)) }
    case 'kelp':
      return {
        withdrawalDelayBlocks: num(await tryCall(reader, c.queue, SIG.kelp.delay, [], block)),
        paused: bool(await tryCall(reader, c.queue, SIG.kelp.paused, [], block)),
      }
    case 'ethena':
      return {
        cooldownDuration: num(await tryCall(reader, c.vault, SIG.ethena.cooldown, [], block)),
      }
    case 'maple': {
      const manager = await tryCall(reader, c.pool, SIG.maple.manager, [], block)
      const wm = manager
        ? await tryCall(reader, String(manager), SIG.maple.withdrawalManager, [], block)
        : null
      return { withdrawalManager: wm == null ? null : String(wm).toLowerCase() }
    }
    default:
      return {}
  }
}

/** Queue depth now, read on-chain where the venue has a total; otherwise summed from the ledger. */
export async function readQueue(
  def: VenueDef,
  reader: ChainReader,
  ledger: VenueLedger,
  anchor: BlockAnchor,
): Promise<QueueSnapshot> {
  const c = def.contracts
  const openRequests = Object.values(ledger.requests).filter(
    (r) =>
      r.claimedTs == null &&
      r.cancelledTs == null &&
      !(r.finalizedTs != null && r.finalizedTs <= anchor.ts),
  )
  const ledgerAmount = openRequests.reduce((s, r) => s + BigInt(r.amount), 0n).toString()
  const base = { block: anchor.block, ts: anchor.ts }
  switch (def.kind) {
    case 'lido': {
      const amount = big(
        await tryCall(reader, c.queue, SIG.lido.unfinalizedStETH, [], anchor.block),
      )
      const count = num(
        await tryCall(reader, c.queue, SIG.lido.unfinalizedRequestNumber, [], anchor.block),
      )
      return {
        ...base,
        depthAmount: amount?.toString() ?? null,
        depthCount: count,
        depthSource: 'onchain',
        extra: { countSource: 'onchain', ledgerOpen: openRequests.length },
      }
    }
    case 'etherfi': {
      const last = num(await tryCall(reader, c.queue, SIG.etherfi.lastFinalized, [], anchor.block))
      const next = num(await tryCall(reader, c.queue, SIG.etherfi.nextRequestId, [], anchor.block))
      const count = last != null && next != null ? Math.max(0, next - 1 - last) : null
      return {
        ...base,
        depthAmount: ledgerAmount,
        depthCount: count,
        depthSource: 'ledger',
        extra: {
          countSource: 'onchain',
          lastFinalizedRequestId: last,
          ledgerOpen: openRequests.length,
          // Requests older than the ledger are in the on-chain count but not in the sum.
          amountIsLowerBound: count == null || openRequests.length < count,
        },
      }
    }
    case 'kelp': {
      const assets = [
        ...new Set([...KELP_ASSETS, ...openRequests.map((r) => r.asset!).filter(Boolean)]),
      ]
      let count: number | null = 0
      for (const asset of assets) {
        const locked = num(
          await tryCall(reader, c.queue, SIG.kelp.nextLocked, [asset], anchor.block),
        )
        const unused = num(
          await tryCall(reader, c.queue, SIG.kelp.nextUnused, [asset], anchor.block),
        )
        if (locked == null || unused == null) count = null
        else if (count != null) count += Math.max(0, unused - locked)
      }
      return {
        ...base,
        depthAmount: ledgerAmount,
        depthCount: count,
        depthSource: 'ledger',
        extra: {
          countSource: 'onchain',
          ledgerOpen: openRequests.length,
          amountIsLowerBound: count == null || openRequests.length < count,
        },
      }
    }
    case 'ethena': {
      // The silo holds every cooling-down and matured-but-unclaimed USDe.
      const amount = big(
        await tryCall(reader, c.usde, SIG.ethena.balanceOf, [c.silo], anchor.block),
      )
      const owners = new Set(
        Object.values(ledger.requests)
          .filter((r) => r.claimedTs == null && r.cancelledTs == null)
          .map((r) => r.owner),
      )
      return {
        ...base,
        depthAmount: amount?.toString() ?? null,
        depthCount: owners.size,
        depthSource: 'onchain',
        extra: { countSource: 'ledger_owner_buckets', includesMaturedUnclaimed: true },
      }
    }
    case 'maple': {
      const shares = big(await tryCall(reader, c.queue, SIG.maple.totalShares, [], anchor.block))
      const q = (await tryCall(reader, c.queue, SIG.maple.queue, [], anchor.block)) as
        | readonly [bigint, bigint]
        | null
      return {
        ...base,
        depthAmount: shares?.toString() ?? null,
        depthCount: q ? Math.max(0, Number(q[1]) - Number(q[0]) + 1) : null,
        depthSource: 'onchain',
        extra: { countIncludesCancelledSlots: true },
      }
    }
    default:
      return {
        ...base,
        depthAmount: ledgerAmount,
        depthCount: openRequests.length,
        depthSource: 'ledger',
      }
  }
}

export async function syncVenue(
  def: VenueDef,
  ledger: VenueLedger,
  reader: ChainReader,
  opts: SyncOptions,
): Promise<{
  ledger: VenueLedger
  scannedTo: number
  chunks: number
  logs: number
  complete: boolean
}> {
  if (def.kind === 'beacon')
    throw new Error('beacon-exit is recorded by recordBeacon, not syncVenue')
  const first = !ledger.coverage
  const fromBlock = ledger.coverage
    ? ledger.coverage.throughBlock + 1
    : Math.max(1, opts.anchor.block - opts.days * BLOCKS_PER_DAY)

  if (first) {
    // Baseline at the block before the scan: sUSDe needs the cooldown in force to
    // date each request's maturity; ether.fi needs its finalization frontier.
    const ts = await reader.blockTs(fromBlock - 1)
    recordParamSample(ledger, {
      block: fromBlock - 1,
      ts,
      values: await readParams(def, reader, fromBlock - 1),
    })
    if (def.kind === 'etherfi') {
      const v = await tryCall(
        reader,
        def.contracts.queue,
        SIG.etherfi.lastFinalized,
        [],
        fromBlock - 1,
      )
      if (v != null) {
        ledger.cursors.lastFinalizedRequestId = String(v)
        ledger.cursors.lastFinalizedBlock = String(fromBlock - 1)
      }
    }
  }

  const filters = venueLogFilters(def)
  const logs: RawLog[] = []
  let to = fromBlock - 1
  let chunks = 0
  while (to < opts.anchor.block && chunks < opts.maxChunks) {
    const end = Math.min(to + opts.chunkBlocks, opts.anchor.block)
    for (const f of filters) logs.push(...(await reader.getLogs(f, to + 1, end)))
    to = end
    chunks += 1
  }
  if (to < fromBlock)
    return { ledger, scannedTo: to, chunks, logs: 0, complete: to >= opts.anchor.block }

  const seen = new Set<string>()
  const events: LedgerEvent[] = []
  for (const log of logs) {
    const key = `${log.transactionHash.toLowerCase()}:${log.logIndex}`
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const e = decodeVenueLog(def, log)
      if (e) events.push(e)
    } catch {
      ledger.undecodedLogs += 1
    }
  }

  if (def.kind === 'kelp') {
    // AssetUnlocked has no nonce range; nextLockedNonce(asset) read at that block does.
    // A read that fails or goes backwards is skipped here and settled by the
    // end-of-scan reconciliation below (as an upper bound, never silently dropped).
    const lastByAsset = new Map<string, bigint>()
    const hints = events.filter((e) => e.kind === 'unlock_hint').sort((a, b) => a.block - b.block)
    for (const hint of hints) {
      if (hint.kind !== 'unlock_hint') continue
      const v = await retryCall(
        reader,
        def.contracts.queue,
        SIG.kelp.nextLocked,
        [hint.asset],
        hint.block,
      )
      const value = v == null ? null : BigInt(v as bigint)
      const before = lastByAsset.get(hint.asset)
      if (value == null || (before != null && value < before)) {
        ledger.readAnomalies = (ledger.readAnomalies ?? 0) + 1
        continue
      }
      lastByAsset.set(hint.asset, value)
      events.push({
        kind: 'finalize_through',
        throughId: value,
        asset: hint.asset,
        exclusive: true,
        block: hint.block,
        ts: hint.ts,
        logIndex: hint.logIndex,
        via: 'read_at_event',
      })
    }
  }

  if (def.kind === 'etherfi') {
    // finalizeRequests emits nothing; bisect the monotone lastFinalizedRequestId
    // between the last block it was read at and the end of this scan.
    const read = async (b: number) =>
      BigInt((await reader.call(def.contracts.queue, SIG.etherfi.lastFinalized, [], b)) as bigint)
    // With no baseline read, any value below the first known request is a safe floor:
    // none of the ledger's requests existed when the scan started.
    const ids = [
      ...Object.keys(ledger.requests),
      ...events.flatMap((e) => (e.kind === 'request' ? [e.id] : [])),
    ].map((id) => BigInt(id))
    const floor = ids.length ? ids.reduce((a, b) => (b < a ? b : a)) - 1n : null
    const cursor = ledger.cursors.lastFinalizedRequestId
    const loValue = cursor != null ? BigInt(cursor) : floor
    let hiValue: bigint | null = null
    try {
      hiValue = await read(to)
    } catch {
      // Leave the cursor where it was; the next run bisects across this span too.
    }
    if (loValue != null && hiValue != null) {
      const lo = {
        block: Number(ledger.cursors.lastFinalizedBlock ?? fromBlock - 1),
        value: loValue,
      }
      const budget = { calls: opts.bisectCalls, anomalies: 0 }
      const points = await findChangePoints(read, lo, { block: to, value: hiValue }, budget)
      ledger.readAnomalies = (ledger.readAnomalies ?? 0) + budget.anomalies
      for (const p of points)
        events.push({
          kind: 'finalize_through',
          throughId: p.value,
          block: p.block,
          ts: await reader.blockTs(p.block),
          logIndex: END_OF_BLOCK,
          via: p.bracketFrom != null ? 'bracket' : 'bisect',
        })
    }
    if (hiValue != null) {
      ledger.cursors.lastFinalizedRequestId = hiValue.toString()
      ledger.cursors.lastFinalizedBlock = String(to)
    }
  }

  applyEvents(ledger, def, events)

  if (def.kind === 'kelp') {
    // Reconcile with the on-chain frontier: a request the chain has unlocked but the
    // ledger still holds open (its unlock read was skipped above) is dated to the end
    // of this scan — an upper bound, marked `bracket`.
    const assets = new Set(
      Object.values(ledger.requests)
        .filter((r) => r.finalizedTs == null && r.asset)
        .map((r) => r.asset!),
    )
    const toTsForBracket = await reader.blockTs(to)
    const late: LedgerEvent[] = []
    for (const asset of assets) {
      const v = await retryCall(reader, def.contracts.queue, SIG.kelp.nextLocked, [asset], to)
      if (v == null) continue
      late.push({
        kind: 'finalize_through',
        throughId: BigInt(v as bigint),
        asset,
        exclusive: true,
        block: to,
        ts: toTsForBracket,
        logIndex: END_OF_BLOCK,
        via: 'bracket',
      })
    }
    applyEvents(ledger, def, late)
  }

  const toTs = await reader.blockTs(to)
  ledger.coverage = {
    fromBlock: ledger.coverage?.fromBlock ?? fromBlock,
    fromTs: ledger.coverage?.fromTs ?? (await reader.blockTs(fromBlock)),
    throughBlock: to,
    throughTs: toTs,
  }

  const anchor = { block: to, ts: toTs }
  recordParamSample(ledger, { ...anchor, values: await readParams(def, reader, to) })
  recordSnapshot(ledger, await readQueue(def, reader, ledger, anchor))
  pruneLedger(ledger, toTs, opts.retentionDays)
  return { ledger, scannedTo: to, chunks, logs: logs.length, complete: to >= opts.anchor.block }
}

export { setParamCursor }
