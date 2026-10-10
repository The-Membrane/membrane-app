import { isDeepStrictEqual } from 'node:util'
import {
  captureApyUsdJointNativeCurrent,
  captureApyUsdJointNativeHistoryBatch,
  prepareApyUsdJointNativeCurrentCapturePlan,
  prepareApyUsdJointNativeHistoryCapturePlan,
  selectedOriginalApyUsdJointNativeCapture,
  selectedOriginalApyUsdJointNativeReceiptsForRetention,
} from '@/scripts/research/apyusd-joint-native-history-capture.mjs'
import {
  APY_USD_JOINT_NATIVE_ANCHORS,
  apyUsdJointNativeCurrentReadPlan,
  replayApyUsdJointNativeCurrent,
  replayApyUsdJointNativeHistoryPoint,
  type ApyUsdJointNativeCurrentBinding,
  type ApyUsdJointNativeCurrentReplay,
  type ApyUsdJointNativeCurrentWire,
  type ApyUsdJointNativeHistoryBinding,
  type ApyUsdJointNativeHistoryWire,
} from './apyUsdJointNativeEvidence'
import {
  beginHolderNativeHistoryOriginalSeries,
  recordHolderNativeHistoryOriginalBatch,
  finishHolderNativeHistoryOriginalSeries,
  type HolderNativeHistoryOriginalReason,
  type HolderNativeHistoryOriginalRetentionStatus,
} from './holderNativeHistoryOriginals.server'

export type ApyUsdJointNativeAcquisitionBinding = Omit<
  ApyUsdJointNativeCurrentBinding,
  'acquiredAtUtc'
> & { asOfMs: number }
export type ApyUsdJointNativeCurrentAcquisition = Readonly<{
  evidence: { binding: ApyUsdJointNativeCurrentBinding; wire: ApyUsdJointNativeCurrentWire }
  fact: ApyUsdJointNativeCurrentReplay
  availableAtUtc: string
  originalAuthority: false
  authenticated: false
  executionQualified: false
}>
export type ApyUsdJointNativeHistoricalEvidence = Readonly<{
  schema: 'apyusd_joint_native_history_evidence_v1'
  points: readonly {
    binding: ApyUsdJointNativeHistoryBinding
    wire: ApyUsdJointNativeHistoryWire
  }[]
  acquiredAtUtc: string
  availableAtUtc: string
  fullSharesRaw: string
  owner: null
  historicalOwnership: false
  originalAuthority: false
  authenticated: false
  executionQualified: false
}>
export type ApyUsdJointNativeHistoryAtIssue = Readonly<{
  evidence: ApyUsdJointNativeHistoricalEvidence
  issuedAtUtc: string
  originalAuthority: false
  authenticated: false
  executionQualified: false
}>
type Batch = { plan: any; capture: any }
type CurrentOriginal = {
  binding: ApyUsdJointNativeAcquisitionBinding
  batches: Batch[]
  availableMs: number
  sourceClosureSha256: string | null
  cacheIdentity: object
}
type HistoryEntry = {
  raw: { binding: ApyUsdJointNativeHistoryBinding; wire: ApyUsdJointNativeHistoryWire }[]
  batches: Batch[]
  availableAtUtc: string
  sourceClosureSha256: string | null
  anchors: typeof APY_USD_JOINT_NATIVE_ANCHORS
  currentOriginal: CurrentOriginal
}
const currentOriginals = new WeakMap<object, CurrentOriginal>()
const historyOriginals = new WeakMap<
  object,
  {
    current: ApyUsdJointNativeCurrentAcquisition
    entry: HistoryEntry
    binding: ApyUsdJointNativeAcquisitionBinding
    points: ReturnType<typeof replayApyUsdJointNativeHistoryPoint>[]
  }
>()
const cache = new Map<string, HistoryEntry>(),
  pending = new Map<string, Promise<HistoryEntry | null>>()
const nativeNow = Date.now,
  NativeDate = Date
const cacheIdentities = new WeakMap<object, number>()
let nextCacheIdentity = 0
// Discovery hint only, from the retained native ownerOf(881) / complete NFT count observation.
// data/research/venue-signals/apyusd-current-liquid-cash-native-evidence-2026-10-08/
// originals-c2c0dfb5-be12-4368-a52f-f6a1c491c0c9/evidence-index.json
// Fresh native ownerOf plus all-owned count closure is mandatory; this cannot assert ownership.
export function apyUsdJointNativeReceiptCandidateHints(
  owner: string,
  receiptTokenId?: string,
): readonly string[] {
  check(
    typeof owner === 'string' && /^0x[0-9a-f]{40}$/.test(owner) && owner !== '0x' + '0'.repeat(40),
  )
  if (receiptTokenId !== undefined) {
    check(
      typeof receiptTokenId === 'string' &&
        /^(0|[1-9][0-9]{0,77})$/.test(receiptTokenId) &&
        BigInt(receiptTokenId) < 1n << 256n,
    )
    return Object.freeze([receiptTokenId])
  }
  return Object.freeze(owner === '0x9830d6b37fe7488707cc4ad7f8b481d75eb2a8c2' ? ['881'] : [])
}
let capturing = false
let diagnostic: Readonly<{
  phase: string
  qualified: boolean
  retention: readonly HolderNativeHistoryOriginalRetentionStatus[]
}> | null = null
const check = (v: unknown) => {
  if (!v) throw Error('apy_native_producer_rejected')
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
function own<T>(input: T): T {
  let nodes = 0,
    chars = 0
  const ancestry = new Set<object>()
  const copy = (v: unknown, depth: number): unknown => {
    check(++nodes <= 1024 && depth <= 8)
    if (v === null || typeof v === 'boolean') return v
    if (typeof v === 'string') {
      chars += v.length
      check(v.length <= 128 && chars <= 16384)
      return v
    }
    if (typeof v === 'number') {
      check(Number.isSafeInteger(v) && v >= 0)
      return v
    }
    check(
      v &&
        typeof v === 'object' &&
        !ancestry.has(v) &&
        !Object.getOwnPropertySymbols(v).length &&
        Object.getPrototypeOf(v) === (Array.isArray(v) ? Array.prototype : Object.prototype),
    )
    ancestry.add(v as object)
    const ds = Object.getOwnPropertyDescriptors(v!),
      result: any = Array.isArray(v) ? [] : {}
    if (Array.isArray(v))
      check(v.length <= 64 && Object.getOwnPropertyNames(v).length === v.length + 1)
    for (const [k, d] of Object.entries(ds)) {
      if (Array.isArray(v) && k === 'length') continue
      check(
        d.enumerable &&
          Object.hasOwn(d, 'value') &&
          !['__proto__', 'constructor', 'prototype'].includes(k),
      )
      result[k] = copy(d.value, depth + 1)
    }
    if (Array.isArray(v))
      check(result.length === v.length && Object.keys(result).length === v.length)
    ancestry.delete(v as object)
    return result
  }
  return freeze(copy(input, 0) as T)
}
function binding(value: ApyUsdJointNativeAcquisitionBinding) {
  const b = own(value)
  check(
    Object.keys(b).sort().join(',') ===
      ['asset', 'asOfMs', 'candidateReceiptIds', 'destination', 'owner', 'routeKey', 'source']
        .sort()
        .join(','),
  )
  const now = nativeNow()
  check(
    Date.now === nativeNow &&
      Date === NativeDate &&
      b.asOfMs <= now &&
      b.asOfMs >= Date.parse(b.source.blockTime) &&
      now - Date.parse(b.source.blockTime) <= 1800000,
  )
  const { asOfMs: _asOf, ...question } = b
  apyUsdJointNativeCurrentReadPlan(
    { ...question, acquiredAtUtc: new NativeDate(now).toISOString() },
    { stage: 'base' },
  )
  return b
}
function sameQuestion(
  a: ApyUsdJointNativeAcquisitionBinding,
  b: ApyUsdJointNativeAcquisitionBinding,
) {
  const { asOfMs: _a, ...x } = a,
    { asOfMs: _b, ...y } = b
  return isDeepStrictEqual(x, y)
}
function originals(batches: Batch[]) {
  for (const b of batches)
    check(selectedOriginalApyUsdJointNativeCapture(b.capture, b.plan) === b.capture)
}
function retentionSafe(status: HolderNativeHistoryOriginalRetentionStatus) {
  check(status.reason !== 'source_changed' && status.reason !== 'artifact_changed')
}
function capturedClosure(statuses: readonly HolderNativeHistoryOriginalRetentionStatus[]) {
  const digests = statuses.map((s) => s.sourceClosureSha256 ?? null)
  const known = digests.filter((d): d is string => d !== null)
  check(digests.length > 0 && known.every((d) => /^[0-9a-f]{64}$/.test(d) && d === known[0]))
  return known.length === digests.length ? known[0] : null
}
/** Only the native private acquisition object selects. Advancing clock cannot rebind its subject. */
export function selectedOriginalApyUsdJointNativeCurrent(
  value: unknown,
  supplied: ApyUsdJointNativeAcquisitionBinding,
): ApyUsdJointNativeCurrentReplay | null {
  try {
    const b = binding(supplied),
      original = value && typeof value === 'object' ? currentOriginals.get(value) : undefined
    check(original && sameQuestion(original.binding, b) && b.asOfMs >= original.availableMs)
    originals(original!.batches)
    return (value as ApyUsdJointNativeCurrentAcquisition).fact
  } catch {
    return null
  }
}
/** Fixed configured pair/default native controls; no injected client, clock, controller or history. */
export async function acquireApyUsdJointNativeCurrent(
  supplied: ApyUsdJointNativeAcquisitionBinding,
): Promise<ApyUsdJointNativeCurrentAcquisition | null> {
  const retention: HolderNativeHistoryOriginalRetentionStatus[] = []
  let phase = 'prepare',
    reason: HolderNativeHistoryOriginalReason = 'invalid_input'
  let handles: ReturnType<typeof beginHolderNativeHistoryOriginalSeries>[] = [],
    qualifications: boolean[][] = [[], []],
    finished = [false, false]
  const finish = (i: number, ok: boolean) => {
    finished[i] = true
    const status = finishHolderNativeHistoryOriginalSeries(handles[i], {
      qualification: ok,
      reason: ok ? 'qualified' : reason,
      batchQualifications: qualifications[i],
    })
    retention.push(status)
    retentionSafe(status)
  }
  try {
    const b = binding(supplied),
      { asOfMs: _asOf, ...question } = b
    const plan = prepareApyUsdJointNativeCurrentCapturePlan({
      ...question,
      acquiredAtUtc: new NativeDate(nativeNow()).toISOString(),
    })
    // Two synchronous source snapshots precede the first await. Each keeps at most three phase receipts.
    handles = [0, 1].map(() =>
      beginHolderNativeHistoryOriginalSeries({ kind: 'apy_usd_current', sharesRaw: null }),
    )
    phase = 'capture'
    reason = 'capture_unavailable'
    const captured = await captureApyUsdJointNativeCurrent(plan)
    phase = 'retain'
    reason = 'replay_rejected'
    const records = selectedOriginalApyUsdJointNativeReceiptsForRetention(captured)
    check(records === captured.batches && records.length > 0 && records.length <= 6)
    records.forEach((record: any, i: number) => {
      const n = Math.floor(i / 3)
      recordHolderNativeHistoryOriginalBatch(handles[n], {
        batchIndex: i % 3,
        plan: { preparedPlan: plan, phasePlan: record.plan },
        receipt: record.receipt,
        capturedAccepted: captured.accepted,
      })
      qualifications[n].push(false)
    })
    check(selectedOriginalApyUsdJointNativeCapture(captured, plan) === captured)
    const acquiredAtUtc = new NativeDate(
      Math.max(...captured.wire.origins.map((o: any) => Date.parse(o.acquiredAtUtc))),
    ).toISOString()
    const finalBinding = freeze({ ...question, acquiredAtUtc })
    phase = 'codec'
    reason = 'codec_rejected'
    const fact = replayApyUsdJointNativeCurrent(captured.wire, finalBinding)
    check(fact.current.receiptInventory?.complete)
    qualifications = qualifications.map((rows) => rows.map(() => true))
    phase = 'finalize'
    handles.forEach((_h, i) => finish(i, qualifications[i].length > 0))
    binding({ ...b, asOfMs: nativeNow() })
    originals([{ plan, capture: captured }])
    const availableMs = nativeNow(),
      result = freeze({
        evidence: { binding: finalBinding, wire: captured.wire },
        fact,
        availableAtUtc: new NativeDate(availableMs).toISOString(),
        originalAuthority: false as const,
        authenticated: false as const,
        executionQualified: false as const,
      })
    currentOriginals.set(result, {
      binding: b,
      batches: [{ plan, capture: captured }],
      availableMs,
      sourceClosureSha256: capturedClosure(retention),
      cacheIdentity: {},
    })
    check(selectedOriginalApyUsdJointNativeCurrent(result, { ...b, asOfMs: nativeNow() }) === fact)
    diagnostic = freeze({ phase: 'current_qualified', qualified: true, retention })
    return result
  } catch {
    handles.forEach((_h, i) => {
      if (!finished[i])
        try {
          finish(i, false)
        } catch {}
    })
    diagnostic = freeze({ phase, qualified: false, retention })
    return null
  }
}
function checkedCurrent(
  current: ApyUsdJointNativeCurrentAcquisition,
  b: ApyUsdJointNativeAcquisitionBinding,
) {
  const fact = selectedOriginalApyUsdJointNativeCurrent(current, { ...b, asOfMs: nativeNow() })
  check(fact)
  return fact!
}
function key(f: ApyUsdJointNativeCurrentReplay, original: CurrentOriginal) {
  // If local source snapshots are unavailable, reuse only this exact current acquisition.
  // A missing digest cannot authorize cross-acquisition framework equivalence.
  let identity = cacheIdentities.get(original.cacheIdentity)
  if (identity === undefined) {
    identity = ++nextCacheIdentity
    cacheIdentities.set(original.cacheIdentity, identity)
  }
  return JSON.stringify([
    f.current.fullSharesRaw,
    f.current.runtimeRegime,
    f.vestingAddress,
    f.current.vaultUnlockingFeeWad,
    f.current.feeCurve,
    APY_USD_JOINT_NATIVE_ANCHORS,
    original.sourceClosureSha256 ?? ['same_current_only', identity],
  ])
}
function replayEntry(
  entry: HistoryEntry,
  fact: ApyUsdJointNativeCurrentReplay,
  original: CurrentOriginal,
) {
  originals(entry.batches)
  check(
    isDeepStrictEqual(entry.anchors, APY_USD_JOINT_NATIVE_ANCHORS) &&
      (entry.sourceClosureSha256 === null
        ? entry.currentOriginal === original
        : entry.sourceClosureSha256 === original.sourceClosureSha256),
  )
  const pairs = entry.raw.map((p) => {
    const b = p.binding,
      old = b.currentSource,
      fresh = fact.current.source
    check(
      b.source.blockNumber < fresh.blockNumber &&
        Date.parse(b.source.blockTime) < Date.parse(fresh.blockTime) &&
        old.blockNumber <= fresh.blockNumber &&
        Date.parse(old.blockTime) <= Date.parse(fresh.blockTime) &&
        (old.blockNumber !== fresh.blockNumber || isDeepStrictEqual(old, fresh)),
    )
    const point = replayApyUsdJointNativeHistoryPoint(p.wire, b)
    check(
      point.runtimeRegime === fact.current.runtimeRegime &&
        isDeepStrictEqual(point.runtimeIdentities, fact.runtimeIdentities) &&
        point.vestingAddress === fact.vestingAddress &&
        point.vaultUnlockingFeeWad === fact.current.vaultUnlockingFeeWad &&
        isDeepStrictEqual(point.feeCurve, fact.current.feeCurve),
    )
    return { binding: b, wire: p.wire, point }
  })
  check(pairs.length === 8 && pairs.every((p, i) => p.binding.cashIndex === 112 + i))
  return pairs
}
async function captureHistory(
  current: ApyUsdJointNativeCurrentAcquisition,
  b: ApyUsdJointNativeAcquisitionBinding,
  fact: ApyUsdJointNativeCurrentReplay,
  original: CurrentOriginal,
): Promise<HistoryEntry | null> {
  // Four separate two-anchor receipts preserve the shared sink's unchanged three-receipt limit.
  const handles = [0, 1, 2, 3].map(() =>
    beginHolderNativeHistoryOriginalSeries({
      kind: 'apy_usd_history',
      sharesRaw: fact.current.fullSharesRaw,
    }),
  )
  const statuses: HolderNativeHistoryOriginalRetentionStatus[] = [],
    finished = [false, false, false, false],
    qualifications: boolean[][] = [[], [], [], []]
  const raw: HistoryEntry['raw'] = [],
    batches: Batch[] = []
  let phase = 'prepare',
    reason: HolderNativeHistoryOriginalReason = 'plan_rejected'
  const finish = (i: number, ok: boolean) => {
    finished[i] = true
    const status = finishHolderNativeHistoryOriginalSeries(handles[i], {
      qualification: ok,
      reason: ok ? 'qualified' : reason,
      batchQualifications: qualifications[i],
    })
    statuses.push(status)
    retentionSafe(status)
  }
  try {
    for (let i = 0; i < 4; i++) {
      checkedCurrent(current, b)
      const plan = prepareApyUsdJointNativeHistoryCapturePlan({
        batchIndex: i,
        fullSharesRaw: fact.current.fullSharesRaw,
        currentSource: fact.current.source,
        currentRuntimeRegime: fact.current.runtimeRegime,
        vestingAddress: fact.vestingAddress,
        vaultUnlockingFeeWad: fact.current.vaultUnlockingFeeWad,
      })
      phase = 'capture'
      reason = 'capture_unavailable'
      const captured = await captureApyUsdJointNativeHistoryBatch(plan)
      phase = 'retain'
      reason = 'replay_rejected'
      const records = selectedOriginalApyUsdJointNativeReceiptsForRetention(captured)
      check(records === captured.batches && records.length === 1)
      recordHolderNativeHistoryOriginalBatch(handles[i], {
        batchIndex: 0,
        plan: { preparedPlan: plan, phasePlan: records[0].plan },
        receipt: records[0].receipt,
        capturedAccepted: captured.accepted,
      })
      qualifications[i].push(false)
      check(selectedOriginalApyUsdJointNativeCapture(captured, plan) === captured)
      batches.push({ plan, capture: captured })
      checkedCurrent(current, b)
      phase = 'codec'
      reason = 'codec_rejected'
      for (const p of captured.wire) {
        const acquiredAtUtc = new NativeDate(
          Math.max(...p.wire.origins.map((o: any) => Date.parse(o.acquiredAtUtc))),
        ).toISOString()
        raw.push({ binding: { ...p.binding, acquiredAtUtc }, wire: p.wire })
      }
      // Each batch is decoded before its provisional receipt is qualified.
      for (const p of raw.slice(-2)) {
        const point = replayApyUsdJointNativeHistoryPoint(p.wire, p.binding)
        check(
          point.runtimeRegime === fact.current.runtimeRegime &&
            isDeepStrictEqual(point.runtimeIdentities, fact.runtimeIdentities) &&
            isDeepStrictEqual(point.feeCurve, fact.current.feeCurve),
        )
      }
      qualifications[i][0] = true
      phase = 'finalize'
      finish(i, true)
      checkedCurrent(current, b)
    }
    const sourceClosureSha256 = capturedClosure(statuses)
    check(
      sourceClosureSha256 === null ||
        original.sourceClosureSha256 === null ||
        sourceClosureSha256 === original.sourceClosureSha256,
    )
    const entry = freeze({
      raw,
      batches,
      availableAtUtc: new NativeDate(nativeNow()).toISOString(),
      sourceClosureSha256,
      anchors: APY_USD_JOINT_NATIVE_ANCHORS,
      currentOriginal: original,
    })
    replayEntry(entry, fact, original)
    diagnostic = freeze({ phase: 'history_qualified', qualified: true, retention: statuses })
    return entry
  } catch {
    handles.forEach((_h, i) => {
      if (!finished[i])
        try {
          finish(i, false)
        } catch {}
    })
    diagnostic = freeze({ phase, qualified: false, retention: statuses })
    return null
  }
}
/** One bounded native series at a time; two same-S/policy entries, actual acquisition clocks retained. */
export async function readApyUsdJointNativeHistoryAtIssue(
  current: ApyUsdJointNativeCurrentAcquisition,
  supplied: ApyUsdJointNativeAcquisitionBinding,
): Promise<ApyUsdJointNativeHistoryAtIssue | null> {
  try {
    const b = binding(supplied),
      fact = checkedCurrent(current, b),
      original = currentOriginals.get(current)!
    const k = key(fact, original)
    let entry = cache.get(k)
    if (entry?.sourceClosureSha256 === null && entry.currentOriginal !== original) entry = undefined
    if (!entry) {
      let job = pending.get(k)
      if (!job) {
        if (capturing) return null
        capturing = true
        job = captureHistory(current, b, fact, original).finally(() => {
          capturing = false
          pending.delete(k)
        })
        pending.set(k, job)
      }
      entry = (await job) ?? undefined
      if (!entry) return null
      cache.delete(k)
      cache.set(k, entry)
      while (cache.size > 2) cache.delete(cache.keys().next().value!)
    }
    checkedCurrent(current, b)
    const pairs = replayEntry(entry, fact, original),
      issuedMs = nativeNow()
    const acquiredAtUtc = new NativeDate(
      Math.max(...pairs.map((p) => Date.parse(p.binding.acquiredAtUtc))),
    ).toISOString()
    check(
      Date.parse(acquiredAtUtc) <= Date.parse(entry.availableAtUtc) &&
        Date.parse(entry.availableAtUtc) <= issuedMs,
    )
    const evidence = freeze({
      schema: 'apyusd_joint_native_history_evidence_v1' as const,
      points: pairs.map(({ binding, wire }) => ({ binding, wire })),
      acquiredAtUtc,
      availableAtUtc: entry.availableAtUtc,
      fullSharesRaw: fact.current.fullSharesRaw,
      owner: null,
      historicalOwnership: false as const,
      originalAuthority: false as const,
      authenticated: false as const,
      executionQualified: false as const,
    })
    const result = freeze({
      evidence,
      issuedAtUtc: new NativeDate(issuedMs).toISOString(),
      originalAuthority: false as const,
      authenticated: false as const,
      executionQualified: false as const,
    })
    historyOriginals.set(result, {
      current,
      entry,
      binding: b,
      points: freeze(pairs.map((p) => p.point)),
    })
    checkedCurrent(current, b)
    return result
  } catch {
    return null
  }
}
export function selectedOriginalApyUsdJointNativeHistory(
  value: unknown,
  current: ApyUsdJointNativeCurrentAcquisition,
  supplied: ApyUsdJointNativeAcquisitionBinding,
) {
  try {
    const b = binding(supplied),
      original = value && typeof value === 'object' ? historyOriginals.get(value) : undefined
    check(original && original.current === current && sameQuestion(original.binding, b))
    const fact = checkedCurrent(current, b)
    check(b.asOfMs >= Date.parse((value as ApyUsdJointNativeHistoryAtIssue).issuedAtUtc))
    replayEntry(original!.entry, fact, currentOriginals.get(current)!)
    return original!.points
  } catch {
    return null
  }
}
export function apyUsdJointNativeEvidenceDiagnostic() {
  return diagnostic
}
