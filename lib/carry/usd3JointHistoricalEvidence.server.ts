import {
  captureUsd3HypotheticalHistory,
  configuredUsd3HypotheticalOrigins,
  prepareUsd3HypotheticalHistoryPlan,
  replayUsd3HypotheticalHistory,
} from '@/scripts/research/usd3-hypothetical-history-capture.mjs'
import {
  HOLDER_CAPACITY_SOURCE_MAX_AGE_MS,
  selectedHolderExitCapacity,
  type HolderExitCapacityBinding,
} from './holderExitCapacity'
import {
  decodeUsd3JointNativeHistoryEvidence,
  encodeUsd3JointNativeHistoryEvidence,
  type Usd3JointDecodedNativeHistoryEvidence,
  type Usd3JointNativeHistoryEvidenceTransport,
} from './usd3JointNativeEvidenceCodec'
import {
  resolveUsd3JointTrustedProfile,
  type Usd3JointTrustedProfile,
} from './usd3JointTrustedProfile'

import {
  beginHolderNativeHistoryOriginalSeries,
  recordHolderNativeHistoryOriginalBatch,
  finishHolderNativeHistoryOriginalSeries,
  type HolderNativeHistoryOriginalReason,
} from './holderNativeHistoryOriginals.server'

type Entry = {
  transport: Usd3JointNativeHistoryEvidenceTransport
  facts: Usd3JointDecodedNativeHistoryEvidence
}
const cache = new Map<string, Entry>()
const pending = new Map<string, Promise<Entry | null>>()
let capturing = false
const ZERO = '0x0000000000000000000000000000000000000000'
const positive = (v: unknown): v is string =>
  typeof v === 'string' && /^[1-9][0-9]{0,77}$/.test(v) && BigInt(v) < 1n << 256n
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
function check(ok: unknown): asserts ok {
  if (!ok) throw Error('usd3_joint_historical_evidence_unavailable')
}
// Never execute caller accessors, toJSON, prototypes or unbounded object trees.
function snapshot(input: unknown): unknown {
  let nodes = 0,
    bytes = 0
  const seen = new WeakSet<object>()
  const copy = (v: unknown, depth: number): unknown => {
    check(depth <= 24 && ++nodes <= 20000)
    if (typeof v === 'string') {
      bytes += v.length
      check(bytes <= 1024 * 1024)
      return v
    }
    if (v === null || typeof v === 'boolean') return v
    if (typeof v === 'number') {
      check(Number.isFinite(v))
      return v
    }
    check(
      v && typeof v === 'object' && !seen.has(v) && Object.getOwnPropertySymbols(v).length === 0,
    )
    check(Object.getPrototypeOf(v) === (Array.isArray(v) ? Array.prototype : Object.prototype))
    seen.add(v)
    const descriptors = Object.getOwnPropertyDescriptors(v)
    check(Object.values(descriptors).every((d) => Object.hasOwn(d, 'value')))
    if (Array.isArray(v)) {
      check(v.length <= 20000 && Object.keys(descriptors).length === v.length + 1)
      const result = Array.from({ length: v.length }, (_, i) => {
        check(descriptors[i]?.enumerable)
        return copy(descriptors[i].value, depth + 1)
      })
      seen.delete(v)
      return result
    }
    const out: Record<string, unknown> = {}
    for (const [key, descriptor] of Object.entries(descriptors)) {
      check(descriptor.enumerable && !['__proto__', 'constructor', 'prototype'].includes(key))
      bytes += key.length
      check(bytes <= 1024 * 1024)
      out[key] = copy(descriptor.value, depth + 1)
    }
    seen.delete(v)
    return out
  }
  return copy(input, 0)
}
const same = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => same(v, b[i]))
    )
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const x = a as Record<string, unknown>,
      y = b as Record<string, unknown>
    return (
      Object.keys(x).length === Object.keys(y).length &&
      Object.keys(x).every((k) => Object.hasOwn(y, k) && same(x[k], y[k]))
    )
  }
  return false
}
function checkedCurrent(value: unknown, binding: HolderExitCapacityBinding) {
  const b = snapshot(binding) as HolderExitCapacityBinding
  check(
    b &&
      typeof b === 'object' &&
      typeof b.routeKey === 'string' &&
      typeof b.destination === 'string' &&
      typeof b.asset === 'string' &&
      typeof b.owner === 'string' &&
      /^0x[0-9a-f]{40}$/.test(b.owner) &&
      b.owner !== ZERO &&
      positive(b.requestedRaw) &&
      b.assetDecimals === 6 &&
      Number.isSafeInteger(b.asOfMs),
  )
  const profile = resolveUsd3JointTrustedProfile(b.routeKey, b.destination, b.asset)
  check(profile)
  const selected = selectedHolderExitCapacity(snapshot(value), b)
  check(
    selected && same(selected.origins.map((o) => o.host).sort(), [...profile.originHosts].sort()),
  )
  const q = selected.quote,
    s = q.sourceHolderPosition,
    native = q.usd3NativeCapacity
  check(
    s &&
      s.method === 'balance_of_owner_at_source' &&
      s.shareDecimals === 6 &&
      positive(s.sharesRaw) &&
      q.fullPositionEntitlementMethod === 'preview_redeem_full_position' &&
      positive(q.fullPositionEntitlementRaw),
  )
  check(
    native &&
      native.resultStatus === 'quoted' &&
      native.capacityRaw !== null &&
      Object.hasOwn(native, 'shutdown') &&
      native.shutdown === false &&
      Object.hasOwn(native, 'readAtUtc') &&
      utc(native.readAtUtc) &&
      native.runtimeProfile,
  )
  const sourceMs = Date.parse(q.source.blockTime)
  check(
    sourceMs <= Date.parse(native.readAtUtc) &&
      Date.parse(native.readAtUtc) <= b.asOfMs &&
      b.asOfMs - sourceMs <= HOLDER_CAPACITY_SOURCE_MAX_AGE_MS,
  )
  for (const origin of selected.origins) {
    const fact = origin.quote.usd3NativeCapacity
    check(
      fact &&
        Object.hasOwn(fact, 'shutdown') &&
        fact.shutdown === false &&
        Object.hasOwn(fact, 'readAtUtc') &&
        utc(fact.readAtUtc) &&
        sourceMs <= Date.parse(fact.readAtUtc) &&
        Date.parse(fact.readAtUtc) <= b.asOfMs,
    )
  }
  check(
    native.runtimeProfile.contracts.every(
      (c, i) =>
        c.address === profile.runtimePins[i]?.address &&
        c.keccak256 === profile.runtimePins[i]?.runtimeKeccak256,
    ),
  )
  check(
    profile.anchors.length === 4 &&
      profile.anchors.every(
        (a, i) =>
          a.cashIndex === 115 + i &&
          a.source.blockNumber < q.source.blockNumber &&
          Date.parse(a.source.blockTime) < sourceMs,
      ),
  )
  return { b, profile, sharesRaw: s.sharesRaw, agreement: selected }
}
function compatible(
  entry: Entry,
  b: HolderExitCapacityBinding,
  sharesRaw: string,
  profile: Usd3JointTrustedProfile,
) {
  const f = entry.facts,
    sourceMs = Date.parse(b.currentSource.blockTime)
  return (
    f.profileId === profile.id &&
    f.subject.withdrawalLimitSubject === b.owner &&
    f.subject.sharesRaw === sharesRaw &&
    Date.parse(f.acquiredAtUtc) <= b.asOfMs &&
    b.asOfMs - sourceMs <= HOLDER_CAPACITY_SOURCE_MAX_AGE_MS &&
    f.points.length === 4 &&
    f.points.every(
      (p, i) =>
        same(p.source, profile.anchors[i].source) &&
        p.source.blockNumber < b.currentSource.blockNumber &&
        Date.parse(p.source.blockTime) < sourceMs &&
        p.shutdown === false &&
        p.withdrawalLimitSubject === b.owner &&
        p.hypotheticalSharesRaw === sharesRaw &&
        p.asset === profile.subject.asset &&
        p.assetDecimals === 6 &&
        p.shareDecimals === 6 &&
        p.availableWithdrawLimitRaw !== null &&
        p.nativeQuoteStatus === 'conditional_reference_address_quote' &&
        p.runtimeIdentities.every(
          (r, j) =>
            r.address === profile.runtimePins[j]?.address &&
            r.runtimeKeccak256 === profile.runtimePins[j]?.runtimeKeccak256,
        ),
    )
  )
}
async function acquire(
  owner: string,
  sharesRaw: string,
  profile: Usd3JointTrustedProfile,
): Promise<Entry | null> {
  // Capture exact source originals before any provider await. Retention status
  // is server diagnostics only and never establishes native replay authority.
  const originalSeries = beginHolderNativeHistoryOriginalSeries({ kind: 'usd3', sharesRaw })
  let failureReason: HolderNativeHistoryOriginalReason = 'plan_rejected'
  const batchQualifications: boolean[] = []
  try {
    const plan = prepareUsd3HypotheticalHistoryPlan({
      root: process.cwd(),
      sharesRaw,
      withdrawalLimitSubject: owner,
    })
    check(
      same(
        plan.anchors.map((a: { cashIndex: number; source: unknown }) => ({
          cashIndex: a.cashIndex,
          source: a.source,
        })),
        profile.anchors,
      ),
    )
    failureReason = 'provider_unavailable'
    const origins = await configuredUsd3HypotheticalOrigins()
    check(
      same(
        origins.map((o: { host: string }) => o.host),
        profile.originHosts,
      ),
    )
    // No injected fetcher, clocks, control, origins or registration API. Only the
    // collector's private configured factory and native dependency path qualify.
    failureReason = 'capture_unavailable'
    const capture = await captureUsd3HypotheticalHistory(plan, origins, { root: process.cwd() })
    recordHolderNativeHistoryOriginalBatch(originalSeries, {
      batchIndex: 0,
      plan,
      receipt: capture.receipt,
      capturedAccepted: capture.accepted,
    })
    batchQualifications.push(false)
    failureReason = 'replay_rejected'
    const replay = replayUsd3HypotheticalHistory(capture.receipt, plan)
    check(replay.authoritativeNativeCapture === true && replay.points.length === 4)
    batchQualifications[0] = true
    failureReason = 'codec_rejected'
    const transport = encodeUsd3JointNativeHistoryEvidence(capture.receipt)
    const facts = decodeUsd3JointNativeHistoryEvidence(transport)
    check(
      facts.subject.withdrawalLimitSubject === owner &&
        facts.subject.sharesRaw === sharesRaw &&
        same(replay.points, facts.points) &&
        transport.authenticated === false &&
        transport.originalAuthority === false,
    )
    check(
      facts.points.every(
        (p) =>
          p.shutdown === false &&
          p.availableWithdrawLimitRaw !== null &&
          p.runtimeIdentities.every(
            (r, i) =>
              r.address === profile.runtimePins[i]?.address &&
              r.runtimeKeccak256 === profile.runtimePins[i]?.runtimeKeccak256,
          ),
      ),
    )
    finishHolderNativeHistoryOriginalSeries(originalSeries, {
      qualification: true,
      reason: 'qualified',
      batchQualifications,
    })
    return { transport, facts }
  } catch {
    finishHolderNativeHistoryOriginalSeries(originalSeries, {
      qualification: false,
      reason: failureReason,
      batchQualifications,
    })
    return null
  }
}
/** Optional acquisition for this exact current full position. Private native
 * authority remains on the server; returned evidence is explicitly unsigned. */
async function load(
  b: HolderExitCapacityBinding,
  sharesRaw: string,
  profile: Usd3JointTrustedProfile,
): Promise<Entry | null> {
  const key = JSON.stringify([b.owner, sharesRaw, profile.id, profile.runtimePins, profile.anchors])
  const stored = cache.get(key)
  if (stored) return stored
  let work = pending.get(key)
  if (!work) {
    if (capturing) return null
    capturing = true
    work = acquire(b.owner, sharesRaw, profile)
      .then((entry) => {
        if (entry) {
          while (cache.size >= 4) cache.delete(cache.keys().next().value!)
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

export async function readUsd3JointHistoricalEvidence(
  capacityAgreement: unknown,
  binding: HolderExitCapacityBinding,
): Promise<Usd3JointNativeHistoryEvidenceTransport | null> {
  try {
    const { b, profile, sharesRaw } = checkedCurrent(capacityAgreement, binding)
    const entry = await load(b, sharesRaw, profile)
    return entry && compatible(entry, b, sharesRaw, profile)
      ? structuredClone(entry.transport)
      : null
  } catch {
    return null
  }
}

/** Finalize this request under the actual issue clock after exactly one optional
 * acquisition. Revalidate the original snapshot; no clock is fabricated. */
export async function readUsd3JointHistoricalEvidenceAtIssue(
  capacityAgreement: unknown,
  binding: HolderExitCapacityBinding,
): Promise<{ evidence: Usd3JointNativeHistoryEvidenceTransport; issuedAtUtc: string } | null> {
  try {
    const current = checkedCurrent(capacityAgreement, binding)
    const entry = await load(current.b, current.sharesRaw, current.profile)
    if (!entry) return null
    const issuedAtMs = Date.now()
    check(Number.isSafeInteger(issuedAtMs) && issuedAtMs >= current.b.asOfMs)
    const issuedAtUtc = new Date(issuedAtMs).toISOString()
    check(utc(issuedAtUtc))
    const finalized = checkedCurrent(current.agreement, { ...current.b, asOfMs: issuedAtMs })
    check(finalized.sharesRaw === current.sharesRaw && finalized.profile === current.profile)
    return compatible(entry, finalized.b, finalized.sharesRaw, finalized.profile)
      ? { evidence: structuredClone(entry.transport), issuedAtUtc }
      : null
  } catch {
    return null
  }
}
