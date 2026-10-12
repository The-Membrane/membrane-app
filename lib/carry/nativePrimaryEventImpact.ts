import type { ConditionalSampledCashHistory } from './conditionalSampledCashPathProjection'
import type { FixedEntitlementCashOutlook } from './fixedEntitlementCashOutlook'
import { primaryMeasuredSourceLink } from './primaryMeasuredSourceLinks'

type Qualified = FixedEntitlementCashOutlook & { owner: string }
/** Capacity facts are primary native measurements, not a news story or a causal driver.
 * The issuer must approve its original two-provider receipt before this copy is made. */
export function buildNativePrimaryEventImpact(original: Qualified,
  qualifyOriginal: (v: Qualified, history: ConditionalSampledCashHistory | null) => boolean,
  originalHistory: ConditionalSampledCashHistory | null = original.adverseEventScenario?.input.history ?? null,
) {
  if (!qualifyOriginal(original, originalHistory)) return null
  const value = structuredClone(original), s = value.currentSource
  const linkage = primaryMeasuredSourceLink(value.identity.routeKey, value.identity.destination)
  if (!linkage || linkage.lane !== 'native_cash') return null
  const history = originalHistory ? structuredClone(originalHistory) : null
  if (history && !['routeKey','destination','asset','assetDecimals'].every(k =>
    (history.identity as any)[k] === (value.identity as any)[k])) return null
  const previous = history?.points.at(-1)
  if (!previous || !/^0x[0-9a-f]{40}$/.test(value.owner) ||
      !['live_read_only_two_origin_finalized','manifest_bound_ledger'].includes(s.sourceKind) ||
      Date.parse(s.readAt) > Date.parse(value.issuedAtUtc) ||
      Date.parse(history!.witness.availableAt) > Date.parse(value.issuedAtUtc) ||
      Date.parse(previous[3]) >= Date.parse(s.blockTime)) return null
  const question = { ...value.identity, owner: value.owner, requestedRaw: value.requestedRaw,
    horizonHours: value.horizonHours, fullEntitlementRaw: value.fullEntitlementRaw,
    additionalCompetitionRaw: value.additionalCompetitionRaw, issuedAtUtc: value.issuedAtUtc }
  const change = BigInt(s.cashRaw) - BigInt(previous[4])
  return { schema: 'native_primary_event_impact_v1' as const, question,
    currentSource: s, affected: { ...value.identity, version: linkage.mechanism }, sourceLinkage: linkage,
    facts: [
      { kind: 'native_cash_observation' as const, classification: 'measured_change' as const,
        block: previous[1], blockHash: previous[2], occurredAtUtc: previous[3],
        availableAtUtc: history!.witness.availableAt, cashRaw: previous[4],
        provenance: 'pinned_native_history' as const, receiptSha256: history!.witness.lastDailyReceiptSha256 },
      { kind: 'native_cash_observation' as const, classification: 'measured_change' as const,
        block: s.block, blockHash: s.blockHash, occurredAtUtc: s.blockTime,
        availableAtUtc: s.readAt, cashRaw: s.cashRaw,
        provenance: s.sourceKind === 'manifest_bound_ledger' ? 'original_manifest_bound_ledger' as const :
          'original_two_provider_finalized_read' as const, receiptSha256: s.receiptSha256 ?? null },
    ],
    measuredCashChangeRaw: String(change),
    direction: change < 0n ? 'shrinking' as const : change > 0n ? 'growing' as const : 'unchanged' as const,
    conditionalScenario: value.adverseHolderHeadroom ? {
      kind: 'historical_adverse_net_persists' as const,
      application: 'replace_NET_assumption' as const,
      headroom: value.adverseHolderHeadroom,
      targetAtUtc: value.adverseEventScenario!.targetAtUtc,
      historyDigest: value.adverseEventScenario!.historyDigest,
      assumption: value.adverseEventScenario!.assumption,
    } : null,
    observedDriver: null, primaryNewsFacts: [],
    newsCoverage: 'primary_news_catalogue_not_enrolled' as const,
    wireRelation: 'Q13_measured_change_layer_no_causal_driver' as const,
    accounting: value.accounting, causalNewsEffect: false as const,
    calibrated: false as const, holderExecutableExit: false as const,
    forecastValidated: false as const }
}
export type NativePrimaryEventImpact = NonNullable<ReturnType<typeof buildNativePrimaryEventImpact>>

/** Use after the enclosing native receipt has matched the current holder assessment.
 * It cannot authenticate arbitrary JSON; retention/authority belongs to that receipt. */
export function matchingNativePrimaryEventImpact(value: NativePrimaryEventImpact | null | undefined, current: Qualified) {
  if (!value || value.schema !== 'native_primary_event_impact_v1' || value.causalNewsEffect !== false ||
      value.calibrated !== false || value.holderExecutableExit !== false || value.forecastValidated !== false) return null
  const q = value.question
  if (!['routeKey','destination','asset','assetDecimals'].every(k =>
    (q as any)[k] === (current.identity as any)[k]) ||
    !['owner','requestedRaw','horizonHours','fullEntitlementRaw','additionalCompetitionRaw','issuedAtUtc'].every(k =>
      (q as any)[k] === (current as any)[k]) ||
    JSON.stringify(value.currentSource) !== JSON.stringify(current.currentSource) ||
    value.conditionalScenario?.historyDigest !== (current.adverseHolderHeadroom ? current.adverseEventScenario?.historyDigest : undefined)) return null
  return value
}
