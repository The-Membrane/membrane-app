import { isDeepStrictEqual } from 'node:util'
import {
  captureUmbrellaGhoJointHistoryBatch,
  prepareUmbrellaGhoJointHistoryCapturePlan,
  selectedOriginalUmbrellaGhoJointHistoryBatch,
  selectedOriginalUmbrellaGhoJointHistoryReceiptForRetention,
} from '@/scripts/research/umbrella-gho-joint-history-capture.mjs'
import {
  UMBRELLA_GHO_JOINT_NATIVE_HISTORY_ANCHORS,
  replayUmbrellaGhoJointNativeHistoryPoint,
  type UmbrellaGhoJointNativeHistoryBinding,
  type UmbrellaGhoJointNativeHistoryPoint,
  type UmbrellaGhoJointNativeHistoryWire,
} from './umbrellaGhoJointNativeHistory'
import { selectedOriginalUmbrellaGhoNativeCapacity } from './umbrellaGhoNativeCapacity.server'
import type {
  UmbrellaGhoNativeCapacityBinding,
  UmbrellaGhoNativeCapacityFact,
} from './umbrellaGhoNativeCapacity'
import { projectUmbrellaGhoNativeHeader } from './umbrellaGhoNativeCapacity'
import { parseUsd3HypotheticalJson } from '@/scripts/research/usd3-hypothetical-history-capture.mjs'
import {
  beginHolderNativeHistoryOriginalSeries,
  recordHolderNativeHistoryOriginalBatch,
  finishHolderNativeHistoryOriginalSeries,
  type HolderNativeHistoryOriginalKind,
  type HolderNativeHistoryOriginalReason,
  type HolderNativeHistoryOriginalRetentionStatus,
} from './holderNativeHistoryOriginals.server'

/** Unsigned public native facts. Original server identities never cross JSON. */
export type UmbrellaGhoJointHistoricalEvidenceTransport = Readonly<{
  schema: 'umbrella_gho_joint_native_history_evidence_v1'
  subject: Readonly<{
    fullSharesRaw: string
    cooldownSharesRaw: string
    owner: null
    historicalOwnership: false
  }>
  points: readonly Readonly<{
    binding: UmbrellaGhoJointNativeHistoryBinding
    wire: UmbrellaGhoJointNativeHistoryWire
  }>[]
  acquiredAtUtc: string
  originalAuthority: false
  authenticated: false
  historicalOwnership: false
  executionQualified: false
  forecastIssued: false
}>
export type UmbrellaGhoJointHistoricalEvidenceAtIssue = Readonly<{
  evidence: UmbrellaGhoJointHistoricalEvidenceTransport
  issuedAtUtc: string
  originalAuthority: false
  authenticated: false
  executionQualified: false
}>
type NativePoint = {
  cashIndex: number
  source: UmbrellaGhoJointNativeHistoryBinding['source']
  wire: UmbrellaGhoJointNativeHistoryWire
  acquiredAtUtc: string
}
type Entry = {
  fullSharesRaw: string
  cooldownSharesRaw: string
  rawPoints: readonly NativePoint[]
  acquiredAtUtc: string
  batches: readonly { capture: unknown; plan: unknown }[]
  retention: HolderNativeHistoryOriginalRetentionStatus
}
type Original = {
  entry: Entry
  current: unknown
  binding: UmbrellaGhoNativeCapacityBinding
  points: readonly UmbrellaGhoJointNativeHistoryPoint[]
  issueMs: number
}
const cache = new Map<string, Entry>(),
  pending = new Map<string, Promise<Entry | null>>()
const originals = new WeakMap<object, Original>()
const nativeNow = Date.now
let capturing = false
let lastDiagnostic: Readonly<{
  phase: string
  qualified: boolean
  retention: HolderNativeHistoryOriginalRetentionStatus | null
}> | null = null
const check = (v: unknown) => {
  if (!v) throw Error('umbrella_history_producer_rejected')
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    for (const x of Object.values(v)) freeze(x)
    Object.freeze(v)
  }
  return v
}
/** Complete own data is copied before the first await; accessors are never invoked. */
function ownBinding(value: unknown): UmbrellaGhoNativeCapacityBinding {
  let nodes = 0
  const seen = new Set<object>()
  const copy = (v: unknown, depth: number): unknown => {
    check(++nodes <= 64 && depth <= 3)
    if (typeof v === 'string') {
      check(v.length <= 128)
      return v
    }
    if (typeof v === 'number') {
      check(Number.isSafeInteger(v) && v >= 0)
      return v
    }
    if (typeof v === 'boolean') return v
    check(
      v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        Object.getPrototypeOf(v) === Object.prototype &&
        Object.getOwnPropertySymbols(v).length === 0 &&
        !seen.has(v),
    )
    seen.add(v as object)
    const result: Record<string, unknown> = {}
    for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(v!))) {
      check(
        d.enumerable &&
          Object.hasOwn(d, 'value') &&
          !['__proto__', 'constructor', 'prototype'].includes(k),
      )
      result[k] = copy(d.value, depth + 1)
    }
    seen.delete(v as object)
    return result
  }
  return freeze(copy(value, 0) as UmbrellaGhoNativeCapacityBinding)
}
function checkedCurrent(current: unknown, binding: UmbrellaGhoNativeCapacityBinding) {
  check(Date.now === nativeNow)
  const fact = selectedOriginalUmbrellaGhoNativeCapacity(current, binding)
  check(fact)
  return fact!
}
function key(f: UmbrellaGhoNativeCapacityFact) {
  return JSON.stringify([
    f.fullSharesRaw,
    f.cooldownSharesRaw,
    f.profileId,
    Object.entries(f.runtimeCodeHashes).sort(([a], [b]) => a.localeCompare(b)),
    f.currentCooldownSeconds,
    f.currentUnstakeWindowSeconds,
    UMBRELLA_GHO_JOINT_NATIVE_HISTORY_ANCHORS,
  ])
}
function originalBatches(entry: Entry) {
  for (const batch of entry.batches)
    check(selectedOriginalUmbrellaGhoJointHistoryBatch(batch.capture, batch.plan) === batch.capture)
}
function replayPoints(entry: Entry, current: UmbrellaGhoNativeCapacityFact) {
  originalBatches(entry)
  check(
    entry.fullSharesRaw === current.fullSharesRaw &&
      entry.cooldownSharesRaw === current.cooldownSharesRaw,
  )
  const pairs = entry.rawPoints.map((p) => {
    const binding: UmbrellaGhoJointNativeHistoryBinding = {
      cashIndex: p.cashIndex,
      source: p.source,
      currentSource: current.source,
      fullSharesRaw: entry.fullSharesRaw,
      cooldownSharesRaw: entry.cooldownSharesRaw,
      acquiredAtUtc: p.acquiredAtUtc,
    }
    const point = replayUmbrellaGhoJointNativeHistoryPoint(p.wire, binding)
    check(
      point &&
        isDeepStrictEqual(point.runtimeCodeHashes, current.runtimeCodeHashes) &&
        point.cooldownSeconds === String(current.currentCooldownSeconds) &&
        point.unstakeWindowSeconds === String(current.currentUnstakeWindowSeconds),
    )
    return { binding, wire: p.wire, point: point! }
  })
  check(pairs.length === 8)
  return pairs
}
async function acquire(
  currentAcquisition: unknown,
  binding: UmbrellaGhoNativeCapacityBinding,
  fact: UmbrellaGhoNativeCapacityFact,
): Promise<Entry | null> {
  const revalidate = () =>
    check(checkedCurrent(currentAcquisition, { ...binding, asOfMs: nativeNow() }) === fact)
  // Fixed executable/config closure is snapshotted synchronously, before configured origins await.
  const series = beginHolderNativeHistoryOriginalSeries({
    kind: 'umbrella_gho_history' as HolderNativeHistoryOriginalKind,
    sharesRaw: fact.fullSharesRaw,
  })
  const qualifications: boolean[] = [],
    batches: { capture: unknown; plan: unknown }[] = []
  const rawPoints: NativePoint[] = []
  let reason: HolderNativeHistoryOriginalReason = 'provider_unavailable'
  let phase = 'prepare',
    finished = false
  let retention: HolderNativeHistoryOriginalRetentionStatus | null = null
  const finish = (qualification: boolean, why: HolderNativeHistoryOriginalReason) => {
    finished = true
    retention = finishHolderNativeHistoryOriginalSeries(series, {
      qualification,
      reason: why,
      batchQualifications: qualifications,
    })
    return retention
  }
  try {
    for (const batchIndex of [0, 1]) {
      phase = 'prepare'
      reason = 'plan_rejected'
      const plan = prepareUmbrellaGhoJointHistoryCapturePlan({
        batchIndex,
        fullSharesRaw: fact.fullSharesRaw,
        cooldownSharesRaw: fact.cooldownSharesRaw,
        currentSource: fact.source,
      })
      phase = 'current_recheck'
      revalidate()
      phase = 'capture'
      reason = 'capture_unavailable'
      const captured = await captureUmbrellaGhoJointHistoryBatch(plan)
      // Privacy is independent of qualification: permitted failed originals are retained.
      phase = 'retention_privacy'
      reason = 'replay_rejected'
      const safeReceipt = selectedOriginalUmbrellaGhoJointHistoryReceiptForRetention(captured)
      check(safeReceipt === captured.receipt)
      phase = 'record'
      recordHolderNativeHistoryOriginalBatch(series, {
        batchIndex,
        plan,
        receipt: safeReceipt,
        capturedAccepted: captured.accepted,
      })
      qualifications.push(false)
      phase = 'current_recheck'
      revalidate()
      phase = 'physical_replay'
      reason = 'replay_rejected'
      check(selectedOriginalUmbrellaGhoJointHistoryBatch(captured, plan) === captured)
      const rows = new Map<number, any>(captured.receipt.ledger.map((r: any) => [r.physicalId, r]))
      const chainRows = [rows.get(1), rows.get(2)]
      const result = (r: any) => {
        const envelope = parseUsd3HypotheticalJson(
          Buffer.from(r.rawBodyBase64, 'base64').toString('utf8'),
        )
        check(Object.hasOwn(envelope, 'result'))
        return envelope.result
      }
      for (let n = 0; n < 4; n++) {
        const a = plan.anchors[n]
        const origins = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'].map((host, origin) => {
          const traces = a.requests.map((spec: any, i: number) => {
            const row = rows.get(3 + n * 36 + origin * 18 + i)
            check(row && row.host === host)
            const rawResult = result(row)
            const normalized = ['headerBefore', 'headerAfter'].includes(spec.key)
              ? projectUmbrellaGhoNativeHeader(rawResult)
              : rawResult
            check(normalized !== null)
            return {
              key: spec.key,
              request: spec.request,
              result: normalized,
              completedAtUtc: row.completedAtUtc,
            }
          })
          const acquiredAtUtc = new Date(
            Math.max(...traces.map((t: any) => Date.parse(t.completedAtUtc))),
          ).toISOString()
          return {
            host,
            chainIdTrace: {
              key: 'chain',
              request: {
                method: 'eth_chainId',
                params: [],
              },
              result: result(chainRows[origin]),
            },
            acquiredAtUtc,
            traces,
          }
        })
        const acquiredAtUtc = new Date(
          Math.max(...origins.map((o) => Date.parse(o.acquiredAtUtc))),
        ).toISOString()
        const wire = { origins } as UmbrellaGhoJointNativeHistoryWire
        phase = 'native_replay'
        const point = replayUmbrellaGhoJointNativeHistoryPoint(wire, {
          cashIndex: a.cashIndex,
          source: a.source,
          currentSource: fact.source,
          fullSharesRaw: fact.fullSharesRaw,
          cooldownSharesRaw: fact.cooldownSharesRaw,
          acquiredAtUtc,
        })
        check(
          point &&
            isDeepStrictEqual(point.runtimeCodeHashes, fact.runtimeCodeHashes) &&
            point.cooldownSeconds === String(fact.currentCooldownSeconds) &&
            point.unstakeWindowSeconds === String(fact.currentUnstakeWindowSeconds),
        )
        rawPoints.push(freeze({ cashIndex: a.cashIndex, source: a.source, wire, acquiredAtUtc }))
      }
      qualifications[batchIndex] = true
      batches.push({ capture: captured, plan })
    }
    reason = 'codec_rejected'
    phase = 'normalize'
    check(rawPoints.length === 8)
    const acquiredAtUtc = new Date(
      Math.max(...rawPoints.map((p) => Date.parse(p.acquiredAtUtc))),
    ).toISOString()
    phase = 'retention'
    const retention = finish(true, 'qualified')
    check(retention.reason !== 'source_changed' && retention.reason !== 'artifact_changed')
    phase = 'current_recheck'
    revalidate()
    const entry = freeze({
      fullSharesRaw: fact.fullSharesRaw,
      cooldownSharesRaw: fact.cooldownSharesRaw,
      rawPoints,
      acquiredAtUtc,
      batches,
      retention,
    })
    lastDiagnostic = freeze({ phase: 'native_history_replayed', qualified: true, retention })
    return entry
  } catch {
    const rejectedRetention = finished ? retention : finish(false, reason)
    lastDiagnostic = freeze({ phase, qualified: false, retention: rejectedRetention })
    return null
  }
}
async function load(
  currentAcquisition: unknown,
  binding: UmbrellaGhoNativeCapacityBinding,
  fact: UmbrellaGhoNativeCapacityFact,
) {
  const id = key(fact),
    stored = cache.get(id)
  if (stored) return stored
  let work = pending.get(id)
  if (!work) {
    if (capturing) return null
    capturing = true
    work = acquire(currentAcquisition, binding, fact)
      .then((entry) => {
        if (entry) {
          while (cache.size >= 2) cache.delete(cache.keys().next().value!)
          cache.set(id, entry)
        }
        return entry
      })
      .finally(() => {
        pending.delete(id)
        capturing = false
      })
    pending.set(id, work)
  }
  return await work
}
/** No serialized current fact, historical flags, custom client, clock, or callbacks are accepted. */
export async function readUmbrellaGhoJointHistoricalEvidenceAtIssue(
  currentAcquisition: unknown,
  suppliedBinding: UmbrellaGhoNativeCapacityBinding,
): Promise<UmbrellaGhoJointHistoricalEvidenceAtIssue | null> {
  try {
    const binding = ownBinding(suppliedBinding),
      current = checkedCurrent(currentAcquisition, binding)
    const entry = await load(currentAcquisition, binding, current)
    if (!entry) return null
    const issueMs = nativeNow()
    check(issueMs >= binding.asOfMs)
    const finalizedBinding = freeze({ ...binding, asOfMs: issueMs })
    check(checkedCurrent(currentAcquisition, finalizedBinding) === current)
    const pairs = replayPoints(entry, current)
    check(Date.parse(entry.acquiredAtUtc) <= issueMs)
    const evidence = freeze({
      schema: 'umbrella_gho_joint_native_history_evidence_v1' as const,
      subject: {
        fullSharesRaw: current.fullSharesRaw,
        cooldownSharesRaw: current.cooldownSharesRaw,
        owner: null,
        historicalOwnership: false as const,
      },
      points: pairs.map(({ binding, wire }) => ({ binding, wire })),
      acquiredAtUtc: entry.acquiredAtUtc,
      originalAuthority: false as const,
      authenticated: false as const,
      historicalOwnership: false as const,
      executionQualified: false as const,
      forecastIssued: false as const,
    })
    check(Buffer.byteLength(JSON.stringify(evidence)) <= 1024 * 1024)
    // Issue clock is after raw retention/normalization. Recheck after the final synchronous replay.
    const finalMs = nativeNow(),
      finalBinding = freeze({ ...binding, asOfMs: finalMs })
    check(
      checkedCurrent(currentAcquisition, finalBinding) === current &&
        finalMs >= issueMs &&
        Date.parse(entry.acquiredAtUtc) <= finalMs,
    )
    const value = freeze({
      evidence,
      issuedAtUtc: new Date(finalMs).toISOString(),
      originalAuthority: false as const,
      authenticated: false as const,
      executionQualified: false as const,
    })
    originals.set(value, {
      entry,
      current: currentAcquisition,
      binding: finalBinding,
      points: freeze(pairs.map((p) => p.point)),
      issueMs: finalMs,
    })
    return value
  } catch {
    return null
  }
}
/** Exact original history identity, coupled to the original current holder binding. */
export function selectedOriginalUmbrellaGhoJointHistoricalEvidence(
  value: unknown,
  currentAcquisition: unknown,
  suppliedBinding: UmbrellaGhoNativeCapacityBinding,
): readonly UmbrellaGhoJointNativeHistoryPoint[] | null {
  try {
    check(value && typeof value === 'object')
    const original = originals.get(value as object)
    check(original && original.current === currentAcquisition)
    const binding = ownBinding(suppliedBinding)
    check(
      binding.asOfMs >= original!.issueMs &&
        isDeepStrictEqual({ ...binding, asOfMs: null }, { ...original!.binding, asOfMs: null }),
    )
    const current = checkedCurrent(currentAcquisition, binding)
    replayPoints(original!.entry, current)
    return original!.points
  } catch {
    return null
  }
}
/** Bounded server-only diagnostics; paths/seals stay outside the evidence transport. */
export function getLastUmbrellaGhoJointHistoricalEvidenceDiagnostic() {
  return lastDiagnostic
}
