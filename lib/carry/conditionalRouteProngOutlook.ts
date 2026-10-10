import {
  buildConditionalTimeProcess,
  type ConditionalTimeProcessInput,
} from '../venueForecast/conditionalTimeProcess'

export type RouteProngKind =
  | 'cash'
  | 'entitlement'
  | 'queue_funding'
  | 'conversion'
  | 'collateral_headroom'
  | 'debt_headroom'
export type RouteProngEvidence = 'observed' | 'modeled' | 'assumed' | 'unknown'
type Asset = { assetAddress: string; decimals: number }
/** A serialized, externally qualified capacity projection; a debt BALANCE is not headroom. */
export type ConditionalRouteProng = {
  key: string
  kind: RouteProngKind
  evidence: RouteProngEvidence
  asset: Asset
  unit: 'native_underlying_cash' | 'qualified_holder_entitlement' | 'qualified_ticket_funding' |
    'qualified_conversion_capacity' | 'qualified_collateral_headroom' | 'qualified_debt_headroom'
  source: { sourceAtUtc: string; readAtUtc: string; provenanceRef: string }
  provenance: string[]
  assumptions: string[]
  exclusions: string[]
  /** Unknown is null, never an invented zero. These are native capacity units. */
  capacityRaw: string | null
  /** Optional process input contains only actual historical observations. */
  timeProcessInput: ConditionalTimeProcessInput | null
  /** Qualified shared historical bundle identity; matching clocks alone is insufficient. */
  jointHistoryProvenanceRef: string | null
  /** Explicit opt-in for a new venue, with no synthetic historical observations. */
  unchangedRegimeAssumption: string | null
  /** A qualified transformation to final payout capacity units, not a public price quote. */
  transformation: {
    outputAsset: Asset
    outputUnit: 'final_asset_capacity'
    numeratorRaw: string
    denominatorRaw: string
    provenanceRef: string
    assumptions: string[]
  } | null
}
export type ConditionalRouteProngOutlookInput = {
  routeKey: string
  destination: string
  issueAtUtc: string
  requestedRaw: string
  horizonHours: number
  outputAsset: Asset
  /** A holder amount remains unknown unless separately qualified; it is not inferred from cash. */
  holderEntitlementRaw: string | null
  requiredProngKeys: string[]
  prongs: ConditionalRouteProng[]
  /** Historical deltas are NET. This optional reserve must be explicitly additional. */
  competition: {
    netHistoryIncludesCompetingFlow: true
    additionalGrossReserveRaw: string | null
    reserveBasis: 'none' | 'additional_competition_excluded_from_net_history'
    provenanceRef: string
  }
}
export type RouteProngQualifier = (privateInput: ConditionalRouteProngOutlookInput) => boolean
const CAPACITY_UNITS: Record<RouteProngKind, ConditionalRouteProng['unit']> = {
  cash: 'native_underlying_cash', entitlement: 'qualified_holder_entitlement',
  queue_funding: 'qualified_ticket_funding', conversion: 'qualified_conversion_capacity',
  collateral_headroom: 'qualified_collateral_headroom', debt_headroom: 'qualified_debt_headroom',
}
const MAX = (1n << 256n) - 1n
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const utc = (v: unknown): v is string =>
  typeof v === 'string' && Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256
const texts = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 32 && v.every(text)
const asset = (v: Asset) => v && /^0x[0-9a-f]{40}$/.test(v.assetAddress) &&
  Number.isSafeInteger(v.decimals) && v.decimals >= 0 && v.decimals <= 77
const sameAsset = (a: Asset, b: Asset) => a.assetAddress === b.assetAddress && a.decimals === b.decimals
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>
  return Object.keys(x).length === Object.keys(y).length &&
    Object.keys(x).every((k) => Object.hasOwn(y, k) && equal(x[k], y[k]))
}
function transformed(p: ConditionalRouteProng, value: string) {
  const t = p.transformation!
  const product = BigInt(value) * BigInt(t.numeratorRaw)
  if (product > MAX) throw Error('transformation_intermediate_overflow')
  return String(product / BigInt(t.denominatorRaw))
}
function prepare(input: ConditionalRouteProngOutlookInput) {
  if (!text(input.routeKey) || !text(input.destination) || !utc(input.issueAtUtc) ||
    !raw(input.requestedRaw) || input.requestedRaw === '0' || !asset(input.outputAsset) ||
    !Number.isFinite(input.horizonHours) || input.horizonHours <= 0 || input.horizonHours > 8760 ||
    !Number.isSafeInteger(input.horizonHours * 3600000) ||
    (input.holderEntitlementRaw !== null && !raw(input.holderEntitlementRaw)) ||
    !Array.isArray(input.prongs) || input.prongs.length < 1 || input.prongs.length > 16 ||
    !texts(input.requiredProngKeys) || input.requiredProngKeys.length < 1 ||
    new Set(input.requiredProngKeys).size !== input.requiredProngKeys.length ||
    new Set(input.prongs.map((p) => p.key)).size !== input.prongs.length) return false
  const c = input.competition
  if (!c || c.netHistoryIncludesCompetingFlow !== true ||
    (c.additionalGrossReserveRaw !== null && !raw(c.additionalGrossReserveRaw)) ||
    !text(c.provenanceRef) || !['none', 'additional_competition_excluded_from_net_history'].includes(c.reserveBasis) ||
    (c.reserveBasis === 'none' && c.additionalGrossReserveRaw !== '0')) return false
  const issue = Date.parse(input.issueAtUtc)
  return Number.isSafeInteger(issue + input.horizonHours * 3600000) && input.prongs.every((p) => {
    if (!text(p.key) || !['cash', 'entitlement', 'queue_funding', 'conversion', 'collateral_headroom', 'debt_headroom'].includes(p.kind) ||
      !['observed', 'modeled', 'assumed', 'unknown'].includes(p.evidence) || !asset(p.asset) || !text(p.unit) ||
      p.unit !== CAPACITY_UNITS[p.kind] || !texts(p.provenance) || !texts(p.assumptions) || !texts(p.exclusions) || !p.source ||
      !utc(p.source.sourceAtUtc) || !utc(p.source.readAtUtc) || !text(p.source.provenanceRef) ||
      Date.parse(p.source.sourceAtUtc) > Date.parse(p.source.readAtUtc) || Date.parse(p.source.readAtUtc) > issue ||
      issue - Date.parse(p.source.sourceAtUtc) > 1800000 ||
      (p.unchangedRegimeAssumption !== null && !text(p.unchangedRegimeAssumption)) ||
      (p.jointHistoryProvenanceRef !== null && !text(p.jointHistoryProvenanceRef))) return false
    const t = p.transformation
    if (t && (!asset(t.outputAsset) || t.outputUnit !== 'final_asset_capacity' ||
      !raw(t.numeratorRaw) || !raw(t.denominatorRaw) || t.denominatorRaw === '0' ||
      !text(t.provenanceRef) || !texts(t.assumptions))) return false
    if (p.evidence === 'unknown') return p.capacityRaw === null && p.timeProcessInput === null
    if (!raw(p.capacityRaw) || p.provenance.length === 0) return false
    const x = p.timeProcessInput
    if (!x) return true
    // Only prequalified native CAPACITY channels are accepted, never arbitrary debt balances.
    return x.channels.length === 1 && x.channels[0].key === p.key &&
      sameAsset({ assetAddress: x.channels[0].assetAddress, decimals: x.channels[0].decimals }, p.asset) &&
      x.channels[0].unit === p.unit && x.current.valuesByChannel[p.key] === p.capacityRaw &&
      x.current.fullEntitlementRaw === undefined && equal(x.outputAsset, input.outputAsset) &&
      x.issueAtUtc === input.issueAtUtc && x.requestedRaw === input.requestedRaw &&
      x.horizonHours === input.horizonHours && x.current.sourceAtUtc === p.source.sourceAtUtc &&
      x.current.readAtUtc === p.source.readAtUtc && x.current.provenanceRef === p.source.provenanceRef
  })
}
/** Private composition proposal: qualification binds evidence/transformations, not this arithmetic.
 * Results remain conditional capacity scenarios; they authenticate neither ownership nor ticket funding. */
export function buildConditionalRouteProngOutlook(
  supplied: ConditionalRouteProngOutlookInput,
  qualify: RouteProngQualifier,
) {
  try {
    const input = structuredClone(supplied)
    if (!prepare(input) || qualify(structuredClone(input)) !== true) return null
    const targetAtUtc = new Date(Date.parse(input.issueAtUtc) + input.horizonHours * 3600000).toISOString()
    const prongs = input.prongs.map((p) => {
      const compatible = p.transformation !== null && sameAsset(p.transformation.outputAsset, input.outputAsset)
      const measure = (state: Record<string, string>) => ({
        availableRaw: transformed(p, state[p.key]), entitlementRaw: null,
      })
      const approved = p.timeProcessInput
      const process = p.evidence !== 'unknown' && compatible && approved
        ? buildConditionalTimeProcess(approved, (x) => equal(x, approved), measure) : null
      let currentFinalCapacityRaw: string | null = null
      if (p.capacityRaw !== null && compatible) {
        try { currentFinalCapacityRaw = transformed(p, p.capacityRaw) } catch { /* This prong stays unjoined. */ }
      }
      const mechanical = !approved && p.evidence !== 'unknown' && currentFinalCapacityRaw !== null && p.unchangedRegimeAssumption
        ? { status: 'assumed_unchanged_regime_capacity' as const,
            assumption: p.unchangedRegimeAssumption, actualHistoricalObservationCount: 0,
            issueAtUtc: input.issueAtUtc, targetAtUtc, capacityRaw: currentFinalCapacityRaw!,
            continuousPathKnown: false as const, forecastValidated: false as const } : null
      return { ...p, currentFinalCapacityRaw, process, mechanical,
        outlookStatus: p.evidence === 'unknown' ? 'unknown' as const
          : !compatible ? 'unjoined_native_capacity' as const
            : process ? 'conditional_modeled' as const : mechanical ? 'assumed' as const : 'current_only' as const }
    })
    const required = input.requiredProngKeys.map((key) => prongs.find((p) => p.key === key))
    const blockers = input.requiredProngKeys.filter((_, i) => !required[i] || required[i]!.currentFinalCapacityRaw === null)
    if (input.competition.additionalGrossReserveRaw === null) blockers.push('additional_competition_unknown')
    const reserve = input.competition.additionalGrossReserveRaw === null ? 0n : BigInt(input.competition.additionalGrossReserveRaw)
    const minimum = (values: string[]) => values.map(BigInt).reduce((a, b) => a < b ? a : b)
    const reserveOnce = (v: bigint) => String(v > reserve ? v - reserve : 0n)
    const currentCapacityRaw = blockers.length ? null
      : reserveOnce(minimum(required.map((p) => p!.currentFinalCapacityRaw!)))
    // Joint modeling requires actual simultaneous donor observations and current clocks.
    // Independent scalar bands are never combined into an invented joint distribution.
    let process: ReturnType<typeof buildConditionalTimeProcess> = null
    if (!blockers.length && required.every((p) => p!.process && p!.jointHistoryProvenanceRef !== null &&
      p!.jointHistoryProvenanceRef === required[0]!.jointHistoryProvenanceRef)) {
      const members = required.map((p) => p!), base = members[0].timeProcessInput!
      const aligned = members.every((p) => {
        const x = p.timeProcessInput!
        return x.current.sourceAtUtc === base.current.sourceAtUtc && x.current.readAtUtc === base.current.readAtUtc &&
          x.current.regime === base.current.regime && x.maxHistoricalGapSeconds === base.maxHistoricalGapSeconds &&
          x.observations.length === base.observations.length && x.observations.every((o, i) =>
            o.sourceAtUtc === base.observations[i].sourceAtUtc && o.availableAtUtc === base.observations[i].availableAtUtc &&
            o.regime === base.observations[i].regime)
      })
      if (aligned) {
        const channels = members.flatMap((p) => p.timeProcessInput!.channels)
        const joint: ConditionalTimeProcessInput = {
          ...base, channels, measurementRule: 'qualified_route_weakest_capacity_prong_minus_additional_reserve_once',
          current: { ...base.current, valuesByChannel: Object.fromEntries(members.map((p) => [p.key, p.capacityRaw!])) },
          observations: base.observations.map((o, i) => ({ ...o, channels,
            valuesByChannel: Object.fromEntries(members.map((p) => [p.key, p.timeProcessInput!.observations[i].valuesByChannel[p.key]])),
            provenanceRef: members[0].jointHistoryProvenanceRef! + ':' + i,
          })),
        }
        process = buildConditionalTimeProcess(joint, (x) => equal(x, joint), (state) => ({
          availableRaw: reserveOnce(minimum(members.map((p) => transformed(p, state[p.key])))), entitlementRaw: null,
        }))
      }
    }
    const mechanical = !blockers.length && required.every((p) => p!.mechanical)
      ? { status: 'assumed_unchanged_route_regime' as const, issueAtUtc: input.issueAtUtc, targetAtUtc,
          capacityRaw: currentCapacityRaw!, headroomRaw: String(BigInt(currentCapacityRaw!) - BigInt(input.requestedRaw)),
          actualHistoricalObservationCount: 0, assumptions: required.map((p) => p!.unchangedRegimeAssumption!),
          continuousPathKnown: false as const } : null
    return {
      status: 'conditional_route_partial_prong_outlook' as const, input, prongs,
      holderEntitlementRaw: input.holderEntitlementRaw,
      route: { blockers, currentCapacityRaw, process, mechanical,
        outlookStatus: blockers.length ? 'unknown_required_prongs' as const : process ? 'conditional_modeled' as const
          : mechanical ? 'assumed' as const : 'current_only_unaligned_or_missing_history' as const },
      caveats: ['Native channels are capacity projections, not arbitrary balances.',
        'Historical net flow already includes competing activity; only separately excluded gross competition is reserved.',
        'Episode clocks and troughs are sampled, not continuous crossing times.',
        'Unknown holder entitlement is preserved; capacity does not prove a holder exit or funded ticket.'],
      forecastValidated: false as const, holderExecutableExit: false as const,
      minedPayout: false as const, calibratedProbability: false as const, confidenceInterval: false as const,
    }
  } catch { return null }
}
/** Rebuild from serialized inputs; no closures or callback authority are serialized into the result. */
export function selectedConditionalRouteProngOutlook(
  value: unknown,
  expected: { input: ConditionalRouteProngOutlookInput; asOfMs: number },
  qualify: RouteProngQualifier,
) {
  try {
    const e = structuredClone(expected), v = structuredClone(value)
    if (!Number.isSafeInteger(e.asOfMs) || e.asOfMs < Date.parse(e.input.issueAtUtc) ||
      e.asOfMs >= Date.parse(e.input.issueAtUtc) + e.input.horizonHours * 3600000 ||
      e.input.prongs.some((p) => e.asOfMs - Date.parse(p.source.sourceAtUtc) > 1800000)) return null
    const rebuilt = buildConditionalRouteProngOutlook(e.input, qualify)
    return rebuilt && equal(v, rebuilt) ? rebuilt : null
  } catch { return null }
}
