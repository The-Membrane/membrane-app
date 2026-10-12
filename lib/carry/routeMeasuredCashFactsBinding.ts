import type {readRoutePrimaryCashFacts} from './routePrimaryCashFacts.server'
import type {RouteEventQuestion, RouteEventContextSources} from './routeEventContext'
import {primaryMeasuredSourceLink} from './primaryMeasuredSourceLinks'
import {registeredConditionalSampledCashIdentity} from './conditionalSampledCashPathProjection'

type Facts = ReturnType<typeof readRoutePrimaryCashFacts>
export type RouteMeasuredCurrentCashWitness = {
  routeKey: string; destination: string; assetAddress: string; assetDecimals: number
  cashRaw: string; block: string; blockHash: string; observedAt: string
}
type Capacity = RouteEventContextSources['capacity'] | RouteMeasuredCurrentCashWitness | null
const MAX = (1n << 256n) - 1n
const raw = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const signed = (v: unknown): v is string => typeof v === 'string' && /^(0|-?[1-9][0-9]{0,95})$/.test(v)
const hash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v)
const digest = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const time = (v: unknown): number => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && new Date(v).toISOString() === v ? Date.parse(v) : NaN
const same = (a: RouteEventQuestion, b: RouteEventQuestion) => a.routeKey === b.routeKey && a.destination === b.destination &&
  a.requestedRaw === b.requestedRaw && a.payoutAsset === b.payoutAsset && a.assetDecimals === b.assetDecimals && a.horizonHours === b.horizonHours
const floor = (n: bigint, d: bigint) => n / d - (n < 0n && n % d !== 0n ? 1n : 0n)

export type SelectedRouteMeasuredCashFacts = {
  evidence: Facts
  measuredHistoricalCashChangeRaw: string | null
  conditionalCashDeltaRaw: string | null
  conditionalCashProxyRaw: string | null
  endpointCensored: boolean
  targetAtUtc: string | null
  meaning: 'aggregate_cash_proxy_not_owner_headroom_or_causal_news_effect'
}

/** Selection of this application's contextual API response against independent question,
 * clock and recorded-capacity input. This is transport binding and arithmetic checking,
 * not authentication of arbitrary JSON or an original private holder/source receipt. */
export function selectedRouteMeasuredCashFacts(value: unknown, question: RouteEventQuestion,
  capacity: Capacity, nowMs: number): SelectedRouteMeasuredCashFacts | null {
  try {
    const v = value as Facts
    if (!v || v.schema !== 'route_primary_cash_facts_v1' || !same(v.question, question) ||
      !Number.isSafeInteger(nowMs) || !raw(question.requestedRaw) || !/^0x[0-9a-f]{40}$/.test(question.payoutAsset) ||
      !Number.isInteger(question.assetDecimals) || question.assetDecimals < 0 || question.assetDecimals > 36 ||
      !Number.isFinite(question.horizonHours) || question.horizonHours <= 0 || question.horizonHours > 8760 ||
      v.ownerAndFullEntitlementQualified !== false || v.holderHeadroom !== null || v.causalNewsEffect !== false ||
      v.calibrated !== false || v.holderExecutableExit !== false || v.forecastValidated !== false) return null
    const issue = time(v.issuedAtUtc), target = issue + question.horizonHours * 3600000
    if (!Number.isSafeInteger(issue) || issue > nowMs || nowMs - issue > 1800000 || !Number.isSafeInteger(target) || nowMs >= target) return null
    const link = primaryMeasuredSourceLink(question.routeKey, question.destination)
    if (!link || JSON.stringify(v.linkage) !== JSON.stringify(link)) return null
    const empty = {evidence: v, measuredHistoricalCashChangeRaw: null, conditionalCashDeltaRaw: null,
      conditionalCashProxyRaw: null, endpointCensored: false, targetAtUtc: null,
      meaning: 'aggregate_cash_proxy_not_owner_headroom_or_causal_news_effect' as const}
    if (link.lane === 'foreign_intermediate') {
      return v.status === 'foreign_units_require_joint_conversion' && v.facts.length === 0 && v.conditionalNetScenario === null ? empty : null
    }
    const identity = registeredConditionalSampledCashIdentity(question.routeKey, question.destination)
    if (!identity || identity.asset !== question.payoutAsset || identity.assetDecimals !== question.assetDecimals) return null
    if (v.status === 'pinned_history_not_available') return v.facts.length === 0 && v.conditionalNetScenario === null ? empty : null
    if (v.status !== 'historical_primary_facts_only' && v.status !== 'historical_and_recorded_aggregate_facts') return null
    if (!('historyWitness' in v) || !digest(v.historyWitness.manifestSha256) || !digest(v.historyWitness.lastDailyReceiptSha256) ||
      !Number.isSafeInteger(time(v.historyWitness.availableAt)) || time(v.historyWitness.availableAt) > issue ||
      v.currentSourceHolderQualified !== false || v.facts.length !== 2) return null
    const [a,b] = v.facts
    for (const fact of v.facts) {
      if (!raw(fact.block) || !hash(fact.blockHash) || !raw(fact.cashRaw) ||
        fact.source !== 'authenticated_pinned_native_history' || fact.receiptSha256 !== v.historyWitness.lastDailyReceiptSha256 ||
        fact.availableAtUtc !== v.historyWitness.availableAt || !Number.isSafeInteger(time(fact.occurredAtUtc)) ||
        time(fact.occurredAtUtc) > time(fact.availableAtUtc)) return null
    }
    if (BigInt(b.block) <= BigInt(a.block) || time(b.occurredAtUtc) <= time(a.occurredAtUtc) ||
      v.measuredHistoricalCashChangeRaw !== String(BigInt(b.cashRaw) - BigInt(a.cashRaw))) return null
    const source = v.recordedCurrentSource
    if (source) {
      if (v.status !== 'historical_and_recorded_aggregate_facts' || !capacity) return null
      let p: {raw:string;block:string;blockHash:string;blockTime:string}
      if ('status' in capacity) {
        if (capacity.status !== 'available') return null
        const c=capacity.value, observation=c.observations.at(-1)
        if (!observation || c.routeKey !== question.routeKey || c.destination !== question.destination ||
          c.payoutAsset !== question.payoutAsset || c.assetDecimals !== question.assetDecimals || c.metric !== 'aggregate_cash_raw' ||
          c.meaning !== 'aggregate_route_liquidity_proxy_not_holder_executable_capacity' ||
          !['local_hash_chain_replay','database_identity_checked'].includes(c.verification)) return null
        p=observation
      } else {
        if (capacity.routeKey !== question.routeKey || capacity.destination !== question.destination ||
          capacity.assetAddress !== question.payoutAsset || capacity.assetDecimals !== question.assetDecimals) return null
        p={raw:capacity.cashRaw,block:capacity.block,blockHash:capacity.blockHash,blockTime:capacity.observedAt}
      }
      if (!raw(source.cashRaw) || !raw(source.block) || !hash(source.blockHash) ||
        !Number.isSafeInteger(time(source.sourceAtUtc)) || time(source.sourceAtUtc) > issue || nowMs-time(source.sourceAtUtc)>86400000 ||
        source.cashRaw !== p.raw || source.block !== p.block || source.blockHash !== p.blockHash || source.sourceAtUtc !== p.blockTime) return null
    } else if (v.status !== 'historical_primary_facts_only') return null
    const result = {...empty, measuredHistoricalCashChangeRaw: v.measuredHistoricalCashChangeRaw}
    const scenario = v.conditionalNetScenario
    if (!scenario) return result
    if (scenario.kind !== 'historical_adverse_net_persists' || scenario.historicalNetIncludesOtherUsers !== true ||
      scenario.assumption !== 'repeat_selected_native_NET_rate_unchanged_mechanism_not_a_news_effect' ||
      scenario.noQOrAdditionalMDeductedHere !== true || scenario.holderHeadroom !== null ||
      scenario.targetAtUtc !== new Date(target).toISOString() || JSON.stringify(scenario.currentSource) !== JSON.stringify(source)) return null
    const rate = scenario.rate
    if (!signed(rate.numeratorRaw) || BigInt(rate.numeratorRaw) >= 0n || BigInt(rate.numeratorRaw) < -MAX ||
      !Number.isSafeInteger(rate.denominatorMs) || rate.denominatorMs <= 0 || rate.denominatorMs > 91800000 ||
      !raw(rate.fromBlock) || !raw(rate.toBlock) || BigInt(rate.toBlock) <= BigInt(rate.fromBlock) ||
      !Number.isSafeInteger(time(rate.fromAtUtc)) || !Number.isSafeInteger(time(rate.toAtUtc)) ||
      time(rate.toAtUtc) - time(rate.fromAtUtc) !== rate.denominatorMs || time(rate.toAtUtc) > time(v.historyWitness.availableAt) ||
      time(rate.toAtUtc) > issue) return null
    if (!source) {
      return scenario.conditionalCashDeltaRaw === null && scenario.conditionalCashProxyRaw === null && scenario.endpointCensored === false ? result : null
    }
    const delta = floor(BigInt(rate.numeratorRaw) * BigInt(target - time(source.sourceAtUtc)), BigInt(rate.denominatorMs))
    const cash = BigInt(source.cashRaw) + delta, censored = cash < 0n || cash > MAX
    if (scenario.conditionalCashDeltaRaw !== String(delta) || scenario.conditionalCashProxyRaw !== (censored ? null : String(cash)) ||
      scenario.endpointCensored !== censored) return null
    return {...result, conditionalCashDeltaRaw: String(delta), conditionalCashProxyRaw: censored ? null : String(cash),
      endpointCensored: censored, targetAtUtc: scenario.targetAtUtc}
  } catch {return null}
}
