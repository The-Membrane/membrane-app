import type { FixedEntitlementCashOutlook } from './fixedEntitlementCashOutlook'

export type ReviewedPrimaryEvent = {
  eventId: string
  title: string
  affected: { routeKey: string; destination: string; asset: string; assetDecimals: number; version: string }
  primarySource: { kind: 'native_log' | 'official_announcement'; url: string; contentSha256: string; reviewRef: string }
  occurredAtUtc: string
  publishedAtUtc: string | null
  fetchedAtUtc: string
  availableAtUtc: string
}
export type DeclaredEventNetAssumption = {
  eventId: string
  netDeltaRaw: string
  denominatorMs: number
  reviewRef: string
  interpretation: 'conditional_assumption_not_estimated_news_effect'
}
const utc = (v: string) => Number.isSafeInteger(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v
const MAX = (1n << 256n) - 1n
const unsigned = (v: string) => /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const signed = (v: string) => /^(0|-?[1-9][0-9]{0,77})$/.test(v) && BigInt(v) >= -MAX && BigInt(v) <= MAX
/** Original fact review and holder-source authority are supplied independently.
 * A headline does not qualify as a primary fact and never determines the NET rate.
 * All three occurrence/publication/availability clocks are retained separately. */
export function buildPrimaryEventNetScenario(input: {
  outlook: FixedEntitlementCashOutlook & { owner: string }
  version: string
  event: ReviewedPrimaryEvent
  assumption: DeclaredEventNetAssumption
}, qualifyOriginal: (v: typeof input) => boolean) {
  try {
    if (!qualifyOriginal(input)) return null
    const { outlook: o, version, event: e, assumption: a } = structuredClone(input)
    const s = o.currentSource, issue = Date.parse(o.issuedAtUtc)
    if (!/^[a-z0-9_]{1,64}$/.test(version) || !e.eventId || e.eventId !== a.eventId ||
        !e.title || e.title.length > 512 || !e.primarySource.reviewRef || !a.reviewRef ||
        !/^[a-f0-9]{64}$/.test(e.primarySource.contentSha256) ||
        !['native_log','official_announcement'].includes(e.primarySource.kind) ||
        a.interpretation !== 'conditional_assumption_not_estimated_news_effect' ||
        !Number.isSafeInteger(a.denominatorMs) || a.denominatorMs <= 0 || !signed(a.netDeltaRaw) ||
        !['routeKey','destination','asset','assetDecimals'].every(k => (e.affected as any)[k] === (o.identity as any)[k]) ||
        e.affected.version !== version ||
        ![e.occurredAtUtc,e.fetchedAtUtc,e.availableAtUtc,o.issuedAtUtc,s.blockTime,s.readAt].every(utc) ||
        (e.publishedAtUtc !== null && !utc(e.publishedAtUtc)) ||
        Date.parse(e.occurredAtUtc) > Date.parse(e.availableAtUtc) ||
        Date.parse(e.fetchedAtUtc) > Date.parse(e.availableAtUtc) ||
        (e.publishedAtUtc !== null && Date.parse(e.publishedAtUtc) > Date.parse(e.availableAtUtc)) ||
        Date.parse(e.availableAtUtc) > issue || Date.parse(s.readAt) > issue ||
        ![s.cashRaw,o.fullEntitlementRaw,o.additionalCompetitionRaw,o.requestedRaw].every(unsigned)) return null
    const url = new URL(e.primarySource.url)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    const targetMs = issue + o.horizonHours * 3600000, elapsed = targetMs - Date.parse(s.blockTime)
    if (!Number.isSafeInteger(targetMs) || elapsed < 0 || elapsed > 8760 * 3600000) return null
    const numerator = BigInt(a.netDeltaRaw) * BigInt(elapsed), denominator = BigInt(a.denominatorMs)
    const delta = numerator / denominator - (numerator < 0n && numerator % denominator !== 0n ? 1n : 0n)
    const projected = BigInt(s.cashRaw) + delta
    if (projected < 0n || projected > MAX) return null // preserve range censorship; never clamp a hidden overflow.
    const afterM = projected > BigInt(o.additionalCompetitionRaw) ? projected - BigInt(o.additionalCompetitionRaw) : 0n
    const capacity = afterM < BigInt(o.fullEntitlementRaw) ? afterM : BigInt(o.fullEntitlementRaw)
    return { schema: 'primary_event_net_scenario_v1' as const,
      question: { ...o.identity, owner: o.owner, requestedRaw: o.requestedRaw,
        horizonHours: o.horizonHours, fullEntitlementRaw: o.fullEntitlementRaw,
        additionalCompetitionRaw: o.additionalCompetitionRaw, issuedAtUtc: o.issuedAtUtc },
      currentSource: s, event: e, assumption: a,
      targetAtUtc: new Date(targetMs).toISOString(), targetCashRaw: String(projected),
      targetCapacityProxyRaw: String(capacity), targetHeadroomRaw: String(capacity - BigInt(o.requestedRaw)),
      application: 'replace_NET_assumption_Q_once_additional_M_separate' as const,
      measuredChange: null, observedDriver: null,
      possibleLeadingSignal: 'declared_conditional_scenario' as const,
      causalNewsEffect: false as const, calibrated: false as const,
      holderExecutableExit: false as const, forecastValidated: false as const }
  } catch { return null }
}
export type PrimaryEventNetScenario = NonNullable<ReturnType<typeof buildPrimaryEventNetScenario>>

/** Called only after the enclosing holder receipt has independently qualified.
 * Recompute the declared arithmetic and every binding; this grants no authority. */
export function matchingPrimaryEventNetScenario(value: PrimaryEventNetScenario | null | undefined,
  current: FixedEntitlementCashOutlook & { owner: string }, version: string) {
  if (!value) return null
  const recomputed = buildPrimaryEventNetScenario({ outlook: current, version,
    event: value.event, assumption: value.assumption }, () => true)
  return recomputed && JSON.stringify(recomputed) === JSON.stringify(value) ? value : null
}
