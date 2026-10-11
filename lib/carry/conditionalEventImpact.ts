import { sha256, stringToHex } from 'viem'
import {
  registeredConditionalSampledCashIdentity,
  type ConditionalSampledCashCurrentSource,
  type ConditionalSampledCashHistory,
  type ConditionalSampledCashIdentity,
} from './conditionalSampledCashPathProjection'

export type ConditionalEventImpactQuestion = ConditionalSampledCashIdentity & {
  requestedRaw: string
  horizonHours: number
  issuedAtUtc: string
}
export type ConditionalEventImpactInput = {
  question: ConditionalEventImpactQuestion
  currentSource: ConditionalSampledCashCurrentSource
  history: ConditionalSampledCashHistory
}
export type ConditionalEventImpactScenario = {
  fromIndex: number
  toIndex: number
  donorDurationMs: number
  historicalNetRaw: string
  issueCashRaw: string
  targetCashRaw: string
  targetCashAfterQRaw: string | null
  targetNetImpactRaw: string
  status: 'usable' | 'censored'
  reason: 'projected_cash_out_of_range' | null
}
export type ConditionalEventImpact = {
  schema: 'conditional_event_impact_v1'
  method: 'historical_net_stress'
  input: ConditionalEventImpactInput
  historyDigest: string
  sourceAgeMs: number
  projectionElapsedMs: number
  targetAtUtc: string
  scope: 'aggregate_native_cash_proxy_only'
  assumption: 'historical_adverse_NET_persists_from_source_to_issue_plus_H'
  scenarios: ConditionalEventImpactScenario[]
  excludedIntervals: { fromIndex: number; toIndex: number; reason: 'gap_or_non_adverse' }[]
  target: {
    cashRange: { minimumRaw: string; maximumRaw: string } | null
    netImpactRange: { minimumRaw: string; maximumRaw: string } | null
    minimumCashAfterQRaw: string | null
    complete: boolean
  }
  competingMRaw: null
  onsetAtUtc: null
  crossingAtUtc: null
  causalNewsEffect: false
  publicationIsFirstKnown: false
  originalAuthority: false
  authenticated: false
  holderExitForecast: false
  holderExecutableExit: false
  fullCashAllocatedToHolder: false
  reservedReceiptDeduction: false
  calibrated: false
}
const MAX = (1n << 256n) - 1n
const SHA = /^[a-f0-9]{64}$/
const HASH = /^0x[a-f0-9]{64}$/
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const check = (v: unknown): void => {
  if (!v) throw Error('conditional_event_impact_invalid')
}
const exactKeys = (v: object, keys: string[]) =>
  Object.keys(v).sort().join(',') === [...keys].sort().join(',')
function snapshot(value: unknown): any {
  let nodes = 0,
    bytes = 0
  const ancestry = new WeakSet<object>()
  const copy = (v: unknown, depth: number): any => {
    check(++nodes <= 12000 && depth <= 16)
    if (typeof v === 'string') {
      bytes += v.length * 2
      check(bytes <= 512 * 1024)
      return v
    }
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isSafeInteger(v)))
      return v
    check(v !== null && typeof v === 'object')
    const obj = v as object
    check(
      !ancestry.has(obj) &&
        (Array.isArray(obj) ||
          Object.getPrototypeOf(obj) === Object.prototype ||
          Object.getPrototypeOf(obj) === null),
    )
    ancestry.add(obj)
    const descriptors = Object.getOwnPropertyDescriptors(obj),
      keys = Reflect.ownKeys(descriptors)
    check(keys.length <= 1024 && keys.every((k) => typeof k === 'string' && k.length <= 128))
    bytes += (keys as string[]).reduce((n, k) => n + k.length * 2, 0)
    check(bytes <= 512 * 1024)
    const array = Array.isArray(obj)
    if (array)
      check((obj as unknown[]).length <= 512 && keys.length === (obj as unknown[]).length + 1)
    const out: any = array ? [] : Object.create(null)
    for (const key of keys as string[]) {
      if (array && key === 'length') continue
      const d = descriptors[key]
      check(
        d.enumerable &&
          Object.hasOwn(d, 'value') &&
          key !== '__proto__' &&
          (!array || /^(0|[1-9][0-9]*)$/.test(key)),
      )
      out[key] = copy(d.value, depth + 1)
    }
    if (array)
      check(
        out.length === (obj as unknown[]).length &&
          Array.from({ length: out.length }, (_, i) => Object.hasOwn(out, i)).every(Boolean),
      )
    ancestry.delete(obj)
    return out
  }
  return copy(value, 0)
}
function canonical(v: any): string {
  return Array.isArray(v)
    ? `[${v.map(canonical).join(',')}]`
    : v !== null && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
          .join(',')}}`
      : JSON.stringify(v)
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
function identity(a: ConditionalSampledCashIdentity, b: ConditionalSampledCashIdentity) {
  return ['routeKey', 'destination', 'asset', 'assetDecimals'].every(
    (k) => (a as any)[k] === (b as any)[k],
  )
}
const floor = (n: bigint, d: bigint) => n / d - (n < 0n && n % d !== 0n ? 1n : 0n)
function range(values: bigint[]) {
  return {
    minimumRaw: String(values.reduce((a, b) => (a < b ? a : b))),
    maximumRaw: String(values.reduce((a, b) => (a > b ? a : b))),
  }
}

/** Unsigned cash context only. The API supplies an independently checked native
 * timeline; this helper never approves that timeline or a private holder issue. */
export function buildConditionalEventImpact(supplied: unknown): ConditionalEventImpact | null {
  try {
    const input = snapshot(supplied) as ConditionalEventImpactInput
    check(exactKeys(input, ['question', 'currentSource', 'history']))
    const q = input.question,
      c = input.currentSource,
      h = input.history
    check(
      exactKeys(q, [
        'routeKey',
        'destination',
        'asset',
        'assetDecimals',
        'requestedRaw',
        'horizonHours',
        'issuedAtUtc',
      ]),
    )
    const registered = registeredConditionalSampledCashIdentity(q.routeKey, q.destination)
    check(registered && identity(registered!, q) && identity(q, c) && identity(q, h.identity))
    check(
      raw(q.requestedRaw) &&
        BigInt(q.requestedRaw) > 0n &&
        Number.isSafeInteger(q.horizonHours) &&
        q.horizonHours >= 1 &&
        q.horizonHours <= 8760 &&
        utc(q.issuedAtUtc),
    )
    check(
      Object.keys(c).every((k) =>
        [
          'routeKey',
          'destination',
          'asset',
          'assetDecimals',
          'chainId',
          'cashRaw',
          'block',
          'blockHash',
          'blockTime',
          'readAt',
          'sourceKind',
          'manifestSha256',
          'receiptSha256',
        ].includes(k),
      ),
    )
    check(
      c.chainId === 1 &&
        raw(c.cashRaw) &&
        raw(c.block) &&
        BigInt(c.block) > 0n &&
        HASH.test(c.blockHash) &&
        utc(c.blockTime) &&
        utc(c.readAt),
    )
    check(['manifest_bound_ledger', 'live_read_only_two_origin_finalized'].includes(c.sourceKind))
    if (c.sourceKind === 'manifest_bound_ledger')
      check(SHA.test(c.manifestSha256 ?? '') && SHA.test(c.receiptSha256 ?? ''))
    const sourceAt = Date.parse(c.blockTime),
      issueAt = Date.parse(q.issuedAtUtc),
      sourceAgeMs = issueAt - sourceAt
    check(
      sourceAt <= Date.parse(c.readAt) &&
        Date.parse(c.readAt) <= issueAt &&
        sourceAgeMs >= 0 &&
        sourceAgeMs <= 1800000,
    )
    check(
      exactKeys(h, ['identity', 'coverage', 'witness', 'points']) &&
        SHA.test(h.witness.manifestSha256) &&
        SHA.test(h.witness.lastDailyReceiptSha256) &&
        utc(h.witness.availableAt) &&
        Date.parse(h.witness.availableAt) <= issueAt,
    )
    check(Array.isArray(h.points) && h.points.length >= 2 && h.points.length <= 120)
    h.points.forEach((p, i) => {
      check(
        p.length === 5 &&
          Number.isSafeInteger(p[0]) &&
          p[0] >= 0 &&
          p[0] < 120 &&
          raw(p[1]) &&
          HASH.test(p[2]) &&
          utc(p[3]) &&
          raw(p[4]),
      )
      check(
        BigInt(p[1]) < BigInt(c.block) &&
          Date.parse(p[3]) < sourceAt &&
          Date.parse(p[3]) <= Date.parse(h.witness.availableAt),
      )
      if (i) {
        const a = h.points[i - 1]
        check(p[0] > a[0] && BigInt(p[1]) > BigInt(a[1]) && Date.parse(p[3]) > Date.parse(a[3]))
      }
    })
    const projectionElapsedMs = sourceAgeMs + q.horizonHours * 3600000,
      targetAt = issueAt + q.horizonHours * 3600000
    check(Number.isSafeInteger(targetAt) && Number.isSafeInteger(projectionElapsedMs))
    const scenarios: ConditionalEventImpactScenario[] = [],
      excludedIntervals: ConditionalEventImpact['excludedIntervals'] = []
    for (let i = 1; i < h.points.length; i++) {
      const a = h.points[i - 1],
        z = h.points[i],
        period = Date.parse(z[3]) - Date.parse(a[3]),
        delta = BigInt(z[4]) - BigInt(a[4])
      if (z[0] !== a[0] + 1 || period < 18 * 3600000 || period > 30 * 3600000 || delta >= 0n) {
        excludedIntervals.push({ fromIndex: a[0], toIndex: z[0], reason: 'gap_or_non_adverse' })
        continue
      }
      const shift = floor(delta * BigInt(projectionElapsedMs), BigInt(period)),
        targetCash = BigInt(c.cashRaw) + shift,
        issueCash = BigInt(c.cashRaw) + floor(delta * BigInt(sourceAgeMs), BigInt(period))
      const usable = issueCash >= 0n && issueCash <= MAX && targetCash >= 0n && targetCash <= MAX
      scenarios.push({
        fromIndex: a[0],
        toIndex: z[0],
        donorDurationMs: period,
        historicalNetRaw: String(delta),
        issueCashRaw: String(issueCash),
        targetCashRaw: String(targetCash),
        targetCashAfterQRaw: usable ? String(targetCash - BigInt(q.requestedRaw)) : null,
        targetNetImpactRaw: String(shift),
        status: usable ? 'usable' : 'censored',
        reason: usable ? null : 'projected_cash_out_of_range',
      })
    }
    if (!scenarios.length) return null
    const complete = scenarios.every((s) => s.status === 'usable')
    const impacts = scenarios.map((s) => BigInt(s.targetNetImpactRaw))
    const boundedImpacts = impacts.every((n) => n >= -MAX && n <= MAX)
    return freeze({
      schema: 'conditional_event_impact_v1',
      method: 'historical_net_stress',
      input,
      historyDigest: sha256(stringToHex(canonical(h))).slice(2),
      sourceAgeMs,
      projectionElapsedMs,
      targetAtUtc: new Date(targetAt).toISOString(),
      scope: 'aggregate_native_cash_proxy_only',
      assumption: 'historical_adverse_NET_persists_from_source_to_issue_plus_H',
      scenarios,
      excludedIntervals,
      target: {
        cashRange: complete ? range(scenarios.map((s) => BigInt(s.targetCashRaw))) : null,
        netImpactRange: complete && boundedImpacts ? range(impacts) : null,
        minimumCashAfterQRaw: complete
          ? range(scenarios.map((s) => BigInt(s.targetCashAfterQRaw!))).minimumRaw
          : null,
        complete,
      },
      competingMRaw: null,
      onsetAtUtc: null,
      crossingAtUtc: null,
      causalNewsEffect: false,
      publicationIsFirstKnown: false,
      originalAuthority: false,
      authenticated: false,
      holderExitForecast: false,
      holderExecutableExit: false,
      fullCashAllocatedToHolder: false,
      reservedReceiptDeduction: false,
      calibrated: false,
    })
  } catch {
    return null
  }
}

/** Structural replay is not original/native authentication. A new source, Q,
 * H or issue is a different sidecar; advancing render time cannot reissue it. */
export function selectedConditionalEventImpact(
  value: unknown,
  question: ConditionalEventImpactQuestion,
  currentSource: ConditionalSampledCashCurrentSource,
  renderAsOfMs: number,
): ConditionalEventImpact | null {
  try {
    const copy = snapshot({ value, question, currentSource, renderAsOfMs }),
      candidate = copy.value
    check(
      Number.isSafeInteger(copy.renderAsOfMs) &&
        canonical(candidate.input.question) === canonical(copy.question),
    )
    const c = candidate.input.currentSource
    check(canonical(c) === canonical(copy.currentSource))
    check(
      copy.renderAsOfMs >= Date.parse(copy.question.issuedAtUtc) &&
        copy.renderAsOfMs <= Date.parse(c.blockTime) + 1800000 &&
        copy.renderAsOfMs < Date.parse(candidate.targetAtUtc),
    )
    const replay = buildConditionalEventImpact(candidate.input)
    return replay && canonical(replay) === canonical(candidate) ? replay : null
  } catch {
    return null
  }
}

/** Reads only copied own data; publication clocks cannot substitute for issuance. */
export function conditionalEventImpactIssuedAt(value: unknown): string | null {
  try {
    const copy = snapshot(value),
      at = copy.input?.question?.issuedAtUtc
    return utc(at) ? at : null
  } catch {
    return null
  }
}

/** Separate unsigned current witness, copied before any property inspection.
 * It supplies provenance metadata only after matching the displayed observation. */
export function conditionalEventImpactCurrentWitness(
  value: unknown,
  asOfMs: number,
): ConditionalSampledCashCurrentSource | null {
  try {
    const c = snapshot(value) as ConditionalSampledCashCurrentSource
    check(
      Number.isSafeInteger(asOfMs) &&
        Object.keys(c).every((k) =>
          [
            'routeKey',
            'destination',
            'asset',
            'assetDecimals',
            'chainId',
            'cashRaw',
            'block',
            'blockHash',
            'blockTime',
            'readAt',
            'sourceKind',
            'manifestSha256',
            'receiptSha256',
          ].includes(k),
        ),
    )
    const registered = registeredConditionalSampledCashIdentity(c.routeKey, c.destination)
    check(
      registered &&
        identity(registered!, c) &&
        c.chainId === 1 &&
        raw(c.cashRaw) &&
        raw(c.block) &&
        BigInt(c.block) > 0n &&
        HASH.test(c.blockHash) &&
        utc(c.blockTime) &&
        utc(c.readAt),
    )
    check(['manifest_bound_ledger', 'live_read_only_two_origin_finalized'].includes(c.sourceKind))
    if (c.sourceKind === 'manifest_bound_ledger')
      check(SHA.test(c.manifestSha256 ?? '') && SHA.test(c.receiptSha256 ?? ''))
    if (c.manifestSha256 !== undefined) check(SHA.test(c.manifestSha256))
    if (c.receiptSha256 !== undefined) check(SHA.test(c.receiptSha256))
    check(
      Date.parse(c.blockTime) <= Date.parse(c.readAt) &&
        Date.parse(c.readAt) <= asOfMs &&
        asOfMs - Date.parse(c.blockTime) <= 1800000,
    )
    return freeze(c)
  } catch {
    return null
  }
}
