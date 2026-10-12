import type {
  LedgerEvent,
  ParamChange,
  ParamSample,
  ParamValue,
  QueueRequest,
  QueueSnapshot,
  VenueKey,
  VenueLedger,
} from './types'
import type { VenueDef } from './venues'

/**
 * The `queue_requests` ledger: applies decoded events to per-request rows.
 * Pure and idempotent — applying the same events twice leaves the ledger unchanged —
 * so a recorder crash between "apply" and "save cursor" cannot double count.
 */

export const emptyLedger = (venue: VenueKey): VenueLedger => ({
  schema: 1,
  venue,
  coverage: null,
  requests: {},
  params: [],
  changes: [],
  snapshots: [],
  cursors: {},
  unmatchedClaims: 0,
  undecodedLogs: 0,
})

const isOpen = (r: QueueRequest) => r.claimedTs == null && r.cancelledTs == null
const byAge = (a: QueueRequest, b: QueueRequest) =>
  a.requestedBlock - b.requestedBlock || compareIds(a.id, b.id)

function compareIds(a: string, b: string): number {
  const na = idNumber(a)
  const nb = idNumber(b)
  if (na != null && nb != null) return na < nb ? -1 : na > nb ? 1 : 0
  return a < b ? -1 : a > b ? 1 : 0
}

/** Numeric part of a request id: Lido/ether.fi/Maple `123`, Kelp `0xasset:123`. */
function idNumber(id: string): bigint | null {
  const tail = id.includes(':') ? id.slice(id.lastIndexOf(':') + 1) : id
  return /^\d+$/.test(tail) ? BigInt(tail) : null
}

const eventOrder = (a: LedgerEvent, b: LedgerEvent) => a.block - b.block || a.logIndex - b.logIndex

const lastParam = (ledger: VenueLedger, param: string): ParamValue | undefined => {
  const key = `param:${param}`
  return key in ledger.cursors ? (JSON.parse(ledger.cursors[key]) as ParamValue) : undefined
}

export const setParamCursor = (ledger: VenueLedger, param: string, value: ParamValue) => {
  ledger.cursors[`param:${param}`] = JSON.stringify(value)
}

function finalize(
  r: QueueRequest,
  block: number | null,
  ts: number,
  via: QueueRequest['finalizedVia'],
) {
  if (r.finalizedTs != null && r.finalizedVia !== 'contract_rule') return
  r.finalizedBlock = block
  r.finalizedTs = ts
  r.finalizedVia = via
}

function claim(r: QueueRequest, block: number, ts: number, logId: string) {
  r.claimedBlock = block
  r.claimedTs = ts
  r.claimLog = logId
  // A claim proves the request was claimable by then; keep an earlier finalization if
  // known, else the claim time is an upper bound on it.
  if (r.finalizedTs == null) finalize(r, block, ts, 'claim')
}

export function applyEvents(
  ledger: VenueLedger,
  def: VenueDef,
  events: LedgerEvent[],
): VenueLedger {
  const usedClaimLogs = new Set(
    Object.values(ledger.requests)
      .map((r) => r.claimLog)
      .filter(Boolean),
  )
  const processedInTx = new Map<string, string>()

  for (const e of [...events].sort(eventOrder)) {
    switch (e.kind) {
      case 'request': {
        if (ledger.requests[e.id]) break
        const r: QueueRequest = {
          id: e.id,
          owner: e.owner,
          ...(e.asset ? { asset: e.asset } : {}),
          amount: e.amount.toString(),
          requestedBlock: e.block,
          requestedTs: e.ts,
          finalizedBlock: null,
          finalizedTs: null,
          claimedBlock: null,
          claimedTs: null,
        }
        if (def.kind === 'ethena') {
          // StakedUSDeV2.cooldownAssets: cooldownEnd = now + cooldownDuration for the
          // owner's WHOLE bucket, so every still-open request of this owner resets too.
          const duration = Number(lastParam(ledger, 'cooldownDuration') ?? NaN)
          if (Number.isFinite(duration)) {
            const end = e.ts + duration
            for (const other of Object.values(ledger.requests))
              if (other.owner === e.owner && isOpen(other)) {
                other.finalizedBlock = null
                other.finalizedTs = end
                other.finalizedVia = 'contract_rule'
              }
            r.finalizedTs = end
            r.finalizedVia = 'contract_rule'
          }
        }
        ledger.requests[e.id] = r
        break
      }
      case 'finalize_range': {
        for (const r of Object.values(ledger.requests)) {
          const n = idNumber(r.id)
          if (n != null && n >= e.fromId && n <= e.toId) finalize(r, e.block, e.ts, 'event')
        }
        break
      }
      case 'finalize_through': {
        for (const r of Object.values(ledger.requests)) {
          if (e.asset && r.asset !== e.asset) continue
          const n = idNumber(r.id)
          if (n == null) continue
          const covered = e.exclusive ? n < e.throughId : n <= e.throughId
          if (covered && r.requestedBlock <= e.block) finalize(r, e.block, e.ts, e.via)
        }
        break
      }
      case 'claim': {
        if (usedClaimLogs.has(e.logId)) break
        const r = ledger.requests[e.id]
        if (!r) {
          ledger.unmatchedClaims += 1
          break
        }
        if (r.claimedTs != null) break
        claim(r, e.block, e.ts, e.logId)
        usedClaimLogs.add(e.logId)
        break
      }
      case 'claim_fifo': {
        if (usedClaimLogs.has(e.logId)) break
        // The OLDEST open request of this owner/asset is the only candidate; if it does
        // not fit (not yet claimable, or a different amount), the claim belongs to a
        // request outside the ledger or to a non-queue exit, and is counted as unmatched.
        const next = Object.values(ledger.requests)
          .filter((r) => r.owner === e.owner && r.asset === e.asset && isOpen(r))
          .sort(byAge)[0]
        const fits =
          next &&
          (def.kind === 'erc7540' || (next.finalizedTs != null && next.finalizedTs <= e.ts)) &&
          (e.amount === undefined || BigInt(next.amount) === e.amount)
        if (!fits) {
          ledger.unmatchedClaims += 1
          break
        }
        claim(next, e.block, e.ts, e.logId)
        usedClaimLogs.add(e.logId)
        break
      }
      case 'claim_amount': {
        if (usedClaimLogs.has(e.logId)) break
        // StakedUSDeV2.unstake pays the owner's whole matured bucket in one silo transfer,
        // so the transfer amount must equal the sum of that owner's open requests.
        const buckets = new Map<string, QueueRequest[]>()
        for (const r of Object.values(ledger.requests))
          if (isOpen(r)) buckets.set(r.owner, [...(buckets.get(r.owner) ?? []), r])
        const candidates = [...buckets.entries()].filter(
          ([, rs]) =>
            rs.every((r) => r.finalizedTs != null && r.finalizedTs <= e.ts) &&
            rs.reduce((s, r) => s + BigInt(r.amount), 0n) === e.amount,
        )
        candidates.sort(
          ([oa, ra], [ob, rb]) =>
            Number(ob === e.receiver) - Number(oa === e.receiver) ||
            (ra[0].finalizedTs ?? 0) - (rb[0].finalizedTs ?? 0),
        )
        const hit = candidates[0]
        if (!hit) {
          ledger.unmatchedClaims += 1
          break
        }
        for (const r of hit[1]) claim(r, e.block, e.ts, e.logId)
        usedClaimLogs.add(e.logId)
        break
      }
      case 'process':
        processedInTx.set(e.id, e.txHash)
        break
      case 'remove': {
        const r = ledger.requests[e.id]
        if (!r || !isOpen(r)) break
        if (processedInTx.get(e.id) === e.txHash) {
          // Maple: RequestProcessed then RequestRemoved in one tx = fully processed;
          // the redeem pays the owner in that same transaction.
          finalize(r, e.block, e.ts, 'event')
          claim(r, e.block, e.ts, `${e.txHash}:remove`)
        } else r.cancelledTs = e.ts
        break
      }
      case 'manual': {
        const r = ledger.requests[e.id]
        if (!r) break
        r.manual = true
        // Manual owners redeem later from manualSharesAvailable; that claim is not observable here.
        if (r.claimedBlock === e.block) {
          r.claimedBlock = null
          r.claimedTs = null
          delete r.claimLog
        }
        break
      }
      case 'param': {
        if (
          ledger.changes.some(
            (c) => c.param === e.param && c.txHash === e.txHash && c.block === e.block,
          )
        )
          break
        const prior = lastParam(ledger, e.param)
        ledger.changes.push({
          param: e.param,
          from: e.from !== undefined ? e.from : (prior ?? null),
          to: e.to,
          block: e.block,
          ts: e.ts,
          source: 'event',
          txHash: e.txHash,
        })
        setParamCursor(ledger, e.param, e.to)
        break
      }
      case 'unlock_hint':
        break
    }
  }
  return ledger
}

/**
 * Record a parameter read. A value that differs from the previous read with no
 * event in between is logged as a `state_diff` change: the silent-change detector
 * (savUSD's unannounced 1d → 1min unstake change is the motivating case).
 */
export function recordParamSample(ledger: VenueLedger, sample: ParamSample): ParamChange[] {
  const prev = ledger.params[ledger.params.length - 1]
  const added: ParamChange[] = []
  if (prev && sample.block > prev.block) {
    for (const [param, to] of Object.entries(sample.values)) {
      // A failed read is null. It is not a change, and the next good read is
      // compared with the last good one.
      if (to === null) continue
      const before = [...ledger.params].reverse().find((p) => p.values[param] != null)
      if (!before) continue
      const from = before.values[param]
      if (from === to) continue
      const explained = ledger.changes.some(
        (c) =>
          c.param === param &&
          c.source === 'event' &&
          c.block > before.block &&
          c.block <= sample.block,
      )
      if (explained) continue
      const change: ParamChange = {
        param,
        from,
        to,
        block: sample.block,
        ts: sample.ts,
        source: 'state_diff',
        sinceBlock: before.block,
      }
      ledger.changes.push(change)
      added.push(change)
    }
  }
  if (!prev || sample.block > prev.block) {
    ledger.params.push(sample)
    for (const [param, value] of Object.entries(sample.values))
      if (value !== null) setParamCursor(ledger, param, value)
  }
  return added
}

export function recordSnapshot(ledger: VenueLedger, snapshot: QueueSnapshot) {
  const last = ledger.snapshots[ledger.snapshots.length - 1]
  if (last && last.block >= snapshot.block) return
  ledger.snapshots.push(snapshot)
}

/**
 * Locate every block where a monotone non-decreasing on-chain counter changed in
 * (lo, hi]. Exact by bisection while the call budget lasts. A change is reported at
 * `hi` with `bracketFrom` = its lower block bound (an upper bound on the time) when
 * the budget runs out, a historical read fails, or a read is out of order.
 *
 * Out-of-order reads happen: on 2026-10-05 one public relay returned
 * lastFinalizedRequestId 82325 at block 25,925,600 while two others returned 82403,
 * the value at the blocks on both sides. Such a read is retried once, then the
 * interval is bracketed and counted in `budget.anomalies`.
 */
export async function findChangePoints(
  read: (block: number) => Promise<bigint>,
  lo: { block: number; value: bigint },
  hi: { block: number; value: bigint },
  budget: { calls: number; anomalies?: number },
): Promise<Array<{ block: number; value: bigint; bracketFrom?: number }>> {
  if (hi.value === lo.value || hi.block <= lo.block) return []
  if (hi.block - lo.block === 1) return [{ block: hi.block, value: hi.value }]
  const bracket = [{ block: hi.block, value: hi.value, bracketFrom: lo.block }]
  if (budget.calls <= 0) return bracket
  const midBlock = lo.block + Math.floor((hi.block - lo.block) / 2)
  const inOrder = (v: bigint) => v >= lo.value && v <= hi.value
  let midValue: bigint | null = null
  for (let attempt = 0; attempt < 2 && budget.calls > 0; attempt += 1) {
    budget.calls -= 1
    try {
      midValue = await read(midBlock)
    } catch {
      // A historical read failed (e.g. a non-archive endpoint in the fallback ring).
      return bracket
    }
    if (inOrder(midValue)) break
  }
  if (midValue == null || !inOrder(midValue)) {
    budget.anomalies = (budget.anomalies ?? 0) + 1
    return bracket
  }
  const mid = { block: midBlock, value: midValue }
  return [
    ...(await findChangePoints(read, lo, mid, budget)),
    ...(await findChangePoints(read, mid, hi, budget)),
  ]
}

export const SNAPSHOT_CAP = 2000
export const PARAM_SAMPLE_CAP = 500

/** Keep the files small: drop finished requests past retention, cap snapshot/param history. */
export function pruneLedger(
  ledger: VenueLedger,
  anchorTs: number,
  retentionDays = 120,
): VenueLedger {
  const cutoff = anchorTs - retentionDays * 86_400
  for (const [id, r] of Object.entries(ledger.requests)) {
    const done = r.claimedTs != null || r.cancelledTs != null || (r.manual && r.finalizedTs != null)
    if (done && r.requestedTs < cutoff) delete ledger.requests[id]
  }
  if (ledger.snapshots.length > SNAPSHOT_CAP)
    ledger.snapshots = ledger.snapshots.slice(-SNAPSHOT_CAP)
  if (ledger.params.length > PARAM_SAMPLE_CAP)
    ledger.params = ledger.params.slice(-PARAM_SAMPLE_CAP)
  return ledger
}
