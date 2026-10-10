/** Unsigned diagnostic only: sampled conditional stock boundaries never establish actual depletion. */
export type ConditionalStockBoundaryInput = {
  sourceAtUtc: string
  issueAtUtc: string
  targetAtUtc: string
  currentValuesByChannel: Record<string, string>
  cashChannelKeys: readonly string[]
  scenarios: readonly {
    fromIndex: number
    status: 'conditional_path' | 'censored_path'
    reason: string | null
    censoredAtUtc: string | null
    donor: {
      startAtUtc: string
      endAtUtc: string
      durationSeconds: number
      jointDeltaRaw: Record<string, string>
      ratesByChannel: Record<string, { numeratorRaw: string; denominatorMs: string }>
    }
    points: readonly { atUtc: string; valuesByChannel: Record<string, string> }[]
  }[]
}
export type ConditionalStockBoundaryOutlook = {
  schema: 'conditional_sampled_cash_boundary_v1'
  sourceAtUtc: string
  issueAtUtc: string
  targetAtUtc: string
  attemptedDonors: number
  boundaryDonors: number
  boundaries: readonly {
    fromIndex: number
    affectedCashChannels: readonly string[]
    lastPositiveAtUtc: string
    firstRejectedAtUtc: string
    afterIssueMs: number
    byIssueMs: number
  }[]
  zeroClampApplied: false
  observedDepletionTimeKnown: false
  authenticated: false
  executionQualified: false
  calibratedProbability: false
}
const MAX = (1n << 256n) - 1n
const unsigned = (x: unknown): x is string =>
  typeof x === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(x) && BigInt(x) <= MAX
const signed = (x: unknown): x is string =>
  typeof x === 'string' &&
  /^(0|-?[1-9][0-9]{0,77})$/.test(x) &&
  BigInt(x) >= -MAX &&
  BigInt(x) <= MAX
function check(x: unknown): asserts x {
  if (!x) throw Error('invalid_boundary_input')
}
function time(x: unknown) {
  check(typeof x === 'string' && x.length <= 32)
  const t = Date.parse(x)
  check(Number.isSafeInteger(t) && t >= 0 && new Date(t).toISOString() === x)
  return t
}
function snapshot(input: unknown): unknown {
  let bytes = 0,
    nodes = 0
  const ancestry = new Set<object>()
  const copy = (x: unknown, depth: number): unknown => {
    check(++nodes <= 100000 && depth <= 20)
    if (x === null || typeof x === 'boolean') return x
    if (typeof x === 'number') {
      check(Number.isFinite(x))
      return x
    }
    if (typeof x === 'string') {
      bytes += x.length * 2
      check(bytes <= 2097152)
      return x
    }
    check(typeof x === 'object' && !ancestry.has(x))
    const array = Array.isArray(x),
      proto = Object.getPrototypeOf(x)
    check(array ? proto === Array.prototype : proto === Object.prototype || proto === null)
    const ds = Object.getOwnPropertyDescriptors(x),
      keys = Reflect.ownKeys(ds)
    check(keys.length <= 256 && keys.every((k) => typeof k === 'string'))
    ancestry.add(x)
    try {
      if (array) {
        const n = ds.length?.value
        check(Number.isSafeInteger(n) && n >= 0 && n <= 128 && keys.length === n + 1)
        return Array.from({ length: n }, (_, k) => {
          const d = ds[String(k)]
          check(d && d.enumerable && 'value' in d)
          return copy(d.value, depth + 1)
        })
      }
      const result: Record<string, unknown> = Object.create(null)
      for (const key of keys as string[]) {
        bytes += key.length * 2
        check(key.length <= 128 && bytes <= 2097152)
        const d = ds[key]
        check(d.enumerable && 'value' in d)
        result[key] = copy(d.value, depth + 1)
      }
      return result
    } finally {
      ancestry.delete(x)
    }
  }
  return copy(input, 0)
}
function stock(base: string, delta: string, elapsed: number, denominator: string) {
  const product = BigInt(delta) * BigInt(elapsed)
  check(product >= -MAX && product <= MAX)
  const d = BigInt(denominator),
    q = product / d
  const shift = product < 0n && product % d !== 0n ? q - 1n : q
  const result = BigInt(base) + shift
  check(result >= -MAX && result <= MAX)
  return result
}
function freeze<T>(x: T): T {
  if (x && typeof x === 'object') {
    Object.values(x).forEach(freeze)
    Object.freeze(x)
  }
  return x
}
/** Caller selects cash keys from its own qualified model; this helper creates no original authority. */
export function buildConditionalStockBoundaryOutlook(
  supplied: ConditionalStockBoundaryInput,
): ConditionalStockBoundaryOutlook | null {
  try {
    const i = snapshot(supplied) as ConditionalStockBoundaryInput
    const source = time(i.sourceAtUtc),
      issue = time(i.issueAtUtc),
      target = time(i.targetAtUtc)
    check(
      source <= issue &&
        issue - source <= 1800000 &&
        target > issue &&
        target - issue <= 8760 * 3600000,
    )
    check(
      Array.isArray(i.cashChannelKeys) &&
        i.cashChannelKeys.length > 0 &&
        i.cashChannelKeys.length <= 16 &&
        new Set(i.cashChannelKeys).size === i.cashChannelKeys.length &&
        i.cashChannelKeys.every(
          (k) =>
            typeof k === 'string' &&
            /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k) &&
            unsigned(i.currentValuesByChannel[k]),
        ),
    )
    check(Array.isArray(i.scenarios) && i.scenarios.length > 0 && i.scenarios.length <= 128)
    const ids = new Set<number>()
    const boundaries: ConditionalStockBoundaryOutlook['boundaries'][number][] = []
    for (const s of i.scenarios) {
      check(
        Number.isSafeInteger(s.fromIndex) &&
          s.fromIndex >= 0 &&
          s.fromIndex < 128 &&
          !ids.has(s.fromIndex),
      )
      ids.add(s.fromIndex)
      check(s.status === 'conditional_path' || s.status === 'censored_path')
      check(
        s.status === 'conditional_path'
          ? s.reason === null && s.censoredAtUtc === null
          : typeof s.reason === 'string' &&
              s.reason.length > 0 &&
              time(s.censoredAtUtc) >= source &&
              time(s.censoredAtUtc) <= target,
      )
      const start = time(s.donor.startAtUtc),
        end = time(s.donor.endAtUtc)
      check(
        end < source &&
          end > start &&
          Number.isSafeInteger(s.donor.durationSeconds) &&
          s.donor.durationSeconds > 0 &&
          s.donor.durationSeconds * 1000 === end - start,
      )
      const denominator = String(end - start)
      for (const k of i.cashChannelKeys) {
        const rate = s.donor.ratesByChannel[k]
        check(
          signed(s.donor.jointDeltaRaw[k]) &&
            rate &&
            rate.numeratorRaw === s.donor.jointDeltaRaw[k] &&
            rate.denominatorMs === denominator,
        )
      }
      check(Array.isArray(s.points) && s.points.length <= 128)
      let previousPoint = -1
      for (const p of s.points) {
        const at = time(p.atUtc)
        check(at >= source && at <= target && at > previousPoint)
        previousPoint = at
        for (const k of i.cashChannelKeys) {
          const v = stock(
            i.currentValuesByChannel[k],
            s.donor.jointDeltaRaw[k],
            at - source,
            denominator,
          )
          check(unsigned(p.valuesByChannel[k]) && v === BigInt(p.valuesByChannel[k]))
        }
      }
      if (s.status !== 'censored_path' || s.reason !== 'negative_joint_prong') continue
      const rejected = time(s.censoredAtUtc)
      check(rejected > issue && rejected <= target)
      const negatives = i.cashChannelKeys.filter(
        (k) =>
          stock(
            i.currentValuesByChannel[k],
            s.donor.jointDeltaRaw[k],
            rejected - source,
            denominator,
          ) < 0n,
      )
      if (!negatives.length) continue // A noncash prong may censor the joint path.
      let previous = -1,
        last: (typeof s.points)[number] | null = null
      for (const p of s.points) {
        const at = time(p.atUtc)
        check(at >= source && at < rejected && at <= target && at > previous)
        previous = at
        for (const k of i.cashChannelKeys) {
          const reconstructed = stock(
            i.currentValuesByChannel[k],
            s.donor.jointDeltaRaw[k],
            at - source,
            denominator,
          )
          check(unsigned(p.valuesByChannel[k]) && reconstructed === BigInt(p.valuesByChannel[k]))
        }
        if (at >= issue && negatives.every((k) => BigInt(p.valuesByChannel[k]) > 0n)) last = p
      }
      if (!last) continue
      boundaries.push({
        fromIndex: s.fromIndex,
        affectedCashChannels: negatives,
        lastPositiveAtUtc: last.atUtc,
        firstRejectedAtUtc: s.censoredAtUtc!,
        afterIssueMs: time(last.atUtc) - issue,
        byIssueMs: rejected - issue,
      })
    }
    return freeze({
      schema: 'conditional_sampled_cash_boundary_v1',
      sourceAtUtc: i.sourceAtUtc,
      issueAtUtc: i.issueAtUtc,
      targetAtUtc: i.targetAtUtc,
      attemptedDonors: i.scenarios.length,
      boundaryDonors: boundaries.length,
      boundaries,
      zeroClampApplied: false,
      observedDepletionTimeKnown: false,
      authenticated: false,
      executionQualified: false,
      calibratedProbability: false,
    })
  } catch {
    return null
  }
}
/** Conservative outward-rounded sampled hour bounds, never an exact depletion-time estimate. */
export function conditionalStockBoundaryHours(
  outlook: ConditionalStockBoundaryOutlook,
): string | null {
  try {
    const x = snapshot(outlook) as ConditionalStockBoundaryOutlook
    check(
      x.schema === 'conditional_sampled_cash_boundary_v1' &&
        x.boundaries.length > 0 &&
        x.boundaryDonors === x.boundaries.length &&
        Number.isSafeInteger(x.attemptedDonors) &&
        x.attemptedDonors >= x.boundaryDonors &&
        x.attemptedDonors <= 128,
    )
    check(
      x.boundaries.every(
        (b) =>
          Number.isSafeInteger(b.afterIssueMs) &&
          Number.isSafeInteger(b.byIssueMs) &&
          b.afterIssueMs >= 0 &&
          b.byIssueMs > b.afterIssueMs,
      ),
    )
    const after = Math.floor(Math.min(...x.boundaries.map((b) => b.afterIssueMs)) / 3600000)
    const by = Math.ceil(Math.max(...x.boundaries.map((b) => b.byIssueMs)) / 3600000)
    return `${after}\u2013${by}h \u00b7 ${x.boundaryDonors}/${x.attemptedDonors} paths`
  } catch {
    return null
  }
}
