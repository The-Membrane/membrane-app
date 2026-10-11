import {
  captureFluidBridgeUsdcHypotheticalHistory,
  configuredFluidBridgeUsdcHypotheticalOrigins,
  prepareFluidBridgeUsdcHypotheticalHistoryPlan,
  replayFluidBridgeUsdcHypotheticalHistory,
} from '@/scripts/research/fluid-bridge-usdc-hypothetical-history-capture.mjs'
import {
  HOLDER_CAPACITY_SOURCE_MAX_AGE_MS,
  selectedHolderExitCapacity,
  type HolderExitCapacityBinding,
} from './holderExitCapacity'
import { replayFluidUsdcBridgeNativeCapacityFact } from './fluidUsdcBridgeNativeCapacity'
import {
  decodeFluidUsdcBridgeJointNativeHistoryEvidence,
  encodeFluidUsdcBridgeJointNativeHistoryEvidence,
  type FluidUsdcBridgeJointDecodedNativeHistoryEvidence,
  type FluidUsdcBridgeJointNativeHistoryEvidenceTransport,
} from './fluidUsdcBridgeJointNativeEvidenceCodec'
import {
  resolveFluidUsdcBridgeJointTrustedProfile,
  type FluidUsdcBridgeJointTrustedProfile,
} from './fluidUsdcBridgeJointTrustedProfile'
import {
  beginHolderNativeHistoryOriginalSeries,
  recordHolderNativeHistoryOriginalBatch,
  finishHolderNativeHistoryOriginalSeries,
  type HolderNativeHistoryOriginalReason,
} from './holderNativeHistoryOriginals.server'

type Entry = {
  evidence: FluidUsdcBridgeJointNativeHistoryEvidenceTransport
  facts: FluidUsdcBridgeJointDecodedNativeHistoryEvidence
}
const cache = new Map<string, Entry>()
let capturing = false
const pending = new Map<string, Promise<Entry | null>>()
function check(ok: unknown): asserts ok {
  if (!ok) throw Error('fluid_bridge_joint_history_unavailable')
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const positive = (v: unknown): v is string =>
  typeof v === 'string' && /^[1-9][0-9]{0,77}$/.test(v) && BigInt(v) < 1n << 256n
function snapshot(input: unknown): unknown {
  let nodes = 0,
    bytes = 0
  const seen = new WeakSet<object>()
  const copy = (v: unknown, d: number): unknown => {
    check(++nodes <= 20000 && d <= 24)
    if (typeof v === 'string') {
      bytes += v.length * 3
      check(bytes <= 4 * 1024 * 1024)
      return v
    }
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
      return v
    check(
      v &&
        typeof v === 'object' &&
        !seen.has(v) &&
        Object.getOwnPropertySymbols(v).length === 0 &&
        Object.getPrototypeOf(v) === (Array.isArray(v) ? Array.prototype : Object.prototype),
    )
    seen.add(v)
    const ds = Object.getOwnPropertyDescriptors(v)
    check(Object.values(ds).every((x) => Object.hasOwn(x, 'value')))
    let result: unknown
    if (Array.isArray(v)) {
      check(v.length <= 2000 && Object.keys(ds).length === v.length + 1)
      result = Array.from({ length: v.length }, (_, n) => {
        check(ds[n]?.enumerable)
        return copy(ds[n].value, d + 1)
      })
    } else {
      const r: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(ds)) {
        bytes += k.length * 3
        check(
          x.enumerable &&
            !['__proto__', 'constructor', 'prototype'].includes(k) &&
            bytes <= 4 * 1024 * 1024,
        )
        r[k] = copy(x.value, d + 1)
      }
      result = r
    }
    seen.delete(v)
    return result
  }
  return copy(input, 0)
}
const equal = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => equal(v, b[i]))
    )
  return (
    record(a) &&
    record(b) &&
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
  )
}
function checkedCurrent(value: unknown, binding: HolderExitCapacityBinding) {
  const b = snapshot(binding) as HolderExitCapacityBinding,
    capacity = snapshot(value)
  check(
    b &&
      typeof b === 'object' &&
      typeof b.owner === 'string' &&
      /^0x[0-9a-f]{40}$/.test(b.owner) &&
      b.owner !== '0x' + '0'.repeat(40) &&
      positive(b.requestedRaw) &&
      b.assetDecimals === 6 &&
      Number.isSafeInteger(b.asOfMs),
  )
  const profile = resolveFluidUsdcBridgeJointTrustedProfile(b.routeKey, b.destination, b.asset)
  check(profile)
  check(record(capacity) && record(capacity.quote))
  const aggregate = replayFluidUsdcBridgeNativeCapacityFact(
    capacity.quote.fluidUsdcBridgeNativeCapacity,
    b.owner,
    b.currentSource,
    b.asOfMs,
  )
  check(aggregate && aggregate.paused === false)
  const selected = selectedHolderExitCapacity(capacity, b)
  check(
    selected && equal(selected.origins.map((o) => o.host).sort(), [...profile.originHosts].sort()),
  )
  const q = selected.quote,
    p = q.sourceHolderPosition
  check(
    p &&
      p.method === 'balance_of_owner_at_source' &&
      p.shareDecimals === 18 &&
      positive(p.sharesRaw) &&
      q.entitlementMethod === 'preview_redeem_full_position' &&
      positive(q.entitlementRaw),
  )
  const native = selected.origins.map((o) =>
    replayFluidUsdcBridgeNativeCapacityFact(
      o.quote.fluidUsdcBridgeNativeCapacity,
      b.owner,
      b.currentSource,
      b.asOfMs,
    ),
  )
  check(native[0] && native[1])
  const a = native[0],
    c = native[1]
  check(
    [a, c, aggregate].every(
      (f) =>
        f.sharesRaw === p.sharesRaw &&
        f.fullNetEaRaw === q.entitlementRaw &&
        f.paused === false &&
        f.feeBps === profile.feeBps &&
        equal(f.runtimeCodeHashes, profile.runtimeCodeHashes),
    ),
  )
  check(equal(a.nativeProngs, c.nativeProngs) && equal(a.nativeProngs, aggregate.nativeProngs))
  const readAtMs = Math.max(Date.parse(a.readAtUtc), Date.parse(c.readAtUtc))
  check(
    aggregate.readAtUtc === new Date(readAtMs).toISOString() &&
      readAtMs <= b.asOfMs &&
      b.asOfMs - Date.parse(q.source.blockTime) <= HOLDER_CAPACITY_SOURCE_MAX_AGE_MS,
  )
  check(
    profile.anchors.every(
      (x) =>
        x.source.blockNumber < q.source.blockNumber &&
        Date.parse(x.source.blockTime) < Date.parse(q.source.blockTime),
    ),
  )
  return { b, profile, sharesRaw: p.sharesRaw, capacity, readAtMs }
}
function compatible(entry: Entry, current: ReturnType<typeof checkedCurrent>) {
  const { b, profile, sharesRaw } = current,
    f = entry.facts
  return (
    f.profileId === profile.profileId &&
    f.frames.length === 12 &&
    Date.parse(f.acquiredAtUtc) <= b.asOfMs &&
    f.acquiredAtUtc ===
      new Date(Math.max(...f.frames.map((x) => Date.parse(x.acquiredAtUtc)))).toISOString() &&
    f.frames.every(
      (x, i) =>
        x.holderSharesRaw === sharesRaw &&
        x.shareDecimals === 18 &&
        x.asset === profile.asset &&
        x.assetDecimals === 6 &&
        x.paused === false &&
        x.withdrawalFeeBps === profile.feeBps &&
        x.owner === null &&
        x.historicalOwnership === false &&
        x.source.blockNumber === String(profile.anchors[i].source.blockNumber) &&
        x.source.blockHash === profile.anchors[i].source.blockHash &&
        x.source.blockTime === profile.anchors[i].source.blockTime &&
        Number(x.source.blockNumber) < b.currentSource.blockNumber &&
        Date.parse(x.source.blockTime) < Date.parse(b.currentSource.blockTime) &&
        equal(x.runtimeCodeHashes, profile.runtimeCodeHashes),
    )
  )
}
async function acquire(
  sharesRaw: string,
  profile: FluidUsdcBridgeJointTrustedProfile,
): Promise<Entry | null> {
  // App-owned source bytes are snapshotted before the first origin/capture await.
  // Retention metadata grants no authority and stays outside the public transport.
  const originalSeries = beginHolderNativeHistoryOriginalSeries({
    kind: 'fluid_usdc_bridge',
    sharesRaw,
  })
  const batchQualifications: boolean[] = []
  let failureReason: HolderNativeHistoryOriginalReason = 'provider_unavailable'
  try {
    const origins = await configuredFluidBridgeUsdcHypotheticalOrigins()
    check(
      equal(
        origins.map((o: { host: string }) => o.host),
        profile.originHosts,
      ),
    )
    const originals: unknown[] = []
    for (let n = 0; n < 12; n += 4) {
      failureReason = 'plan_rejected'
      const anchors = profile.anchors.slice(n, n + 4)
      const plan = prepareFluidBridgeUsdcHypotheticalHistoryPlan({
        root: process.cwd(),
        cashIndices: anchors.map((a) => a.cashIndex),
        sharesRaw,
      })
      check(
        equal(
          plan.anchors.map((a: { cashIndex: number; source: unknown }) => ({
            cashIndex: a.cashIndex,
            source: a.source,
          })),
          anchors,
        ),
      )
      // Registered configured pair, native fetch, private prepared plan; no caller hooks.
      failureReason = 'capture_unavailable'
      const captured = await captureFluidBridgeUsdcHypotheticalHistory(plan, origins, {
        root: process.cwd(),
      })
      recordHolderNativeHistoryOriginalBatch(originalSeries, {
        batchIndex: n / 4,
        plan,
        receipt: captured.receipt,
        capturedAccepted: captured.accepted,
      })
      failureReason = 'replay_rejected'
      const replay = replayFluidBridgeUsdcHypotheticalHistory(captured.receipt, plan)
      check(
        captured.accepted &&
          replay.authoritativeNativeCapture === true &&
          replay.points.length === 4 &&
          replay.points.every(
            (p: { hypotheticalSharesRaw: string }) => p.hypotheticalSharesRaw === sharesRaw,
          ),
      )
      batchQualifications.push(true)
      originals.push(captured.receipt)
    }
    failureReason = 'codec_rejected'
    const evidence = encodeFluidUsdcBridgeJointNativeHistoryEvidence(originals),
      facts = decodeFluidUsdcBridgeJointNativeHistoryEvidence(evidence)
    check(
      facts &&
        facts.frames.length === 12 &&
        facts.originalAuthority === false &&
        facts.authenticated === false,
    )
    finishHolderNativeHistoryOriginalSeries(originalSeries, {
      qualification: true,
      reason: 'qualified',
      batchQualifications,
    })
    return { evidence, facts }
  } catch {
    finishHolderNativeHistoryOriginalSeries(originalSeries, {
      qualification: false,
      reason: failureReason,
      batchQualifications,
    })
    return null
  }
}
async function load(current: ReturnType<typeof checkedCurrent>): Promise<Entry | null> {
  const key = JSON.stringify([current.sharesRaw, current.profile.profileId])
  const stored = cache.get(key)
  if (stored) return stored
  let work = pending.get(key)
  if (!work) {
    if (capturing) return null
    capturing = true
    work = acquire(current.sharesRaw, current.profile)
      .then((entry) => {
        if (entry) {
          while (cache.size >= 2) cache.delete(cache.keys().next().value!)
          cache.set(key, entry)
        }
        return entry
      })
      .finally(() => {
        pending.delete(key)
        capturing = false
      })
    pending.set(key, work)
  }
  return await work
}
/** Actual issue clock is read after the last acquisition/normalization await.
 * Revalidate the original current snapshot including execution evidence and TTL. */
export async function readFluidUsdcBridgeJointHistoricalEvidenceAtIssue(
  capacityAgreement: unknown,
  binding: HolderExitCapacityBinding,
): Promise<{
  evidence: FluidUsdcBridgeJointNativeHistoryEvidenceTransport
  issuedAtUtc: string
} | null> {
  try {
    const current = checkedCurrent(capacityAgreement, binding),
      entry = await load(current)
    if (!entry) return null
    const issueMs = Date.now()
    check(Number.isSafeInteger(issueMs) && issueMs >= current.b.asOfMs)
    const finalized = checkedCurrent(current.capacity, { ...current.b, asOfMs: issueMs })
    check(finalized.sharesRaw === current.sharesRaw && finalized.profile === current.profile)
    return compatible(entry, finalized)
      ? { evidence: structuredClone(entry.evidence), issuedAtUtc: new Date(issueMs).toISOString() }
      : null
  } catch {
    return null
  }
}
