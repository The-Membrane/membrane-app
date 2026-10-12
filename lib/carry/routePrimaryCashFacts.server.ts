import { loadPinnedAudit } from '../../scripts/research/conditional-cash-time-holdout.mjs'
import { primaryMeasuredSourceLink } from './primaryMeasuredSourceLinks'
import type { RouteEventQuestion, RouteEventContextSources } from './routeEventContext'
import type { ConditionalSampledCashHistory } from './conditionalSampledCashPathProjection'

const MAX = (1n << 256n) - 1n
const raw = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const floor = (n: bigint, d: bigint) => n / d - (n < 0n && n % d !== 0n ? 1n : 0n)
/** Called on the server with its existing independently checked capacity reader.
 * That reader supplies contextual aggregate measurements, never private holder authority. */
export function readRoutePrimaryCashFacts(question: RouteEventQuestion,
  current: RouteEventContextSources['capacity'], issueMs: number) {
  const linkage = primaryMeasuredSourceLink(question.routeKey, question.destination)
  const base = { schema: 'route_primary_cash_facts_v1' as const, question,
    issuedAtUtc: new Date(issueMs).toISOString(), linkage,
    holderHeadroom: null, ownerAndFullEntitlementQualified: false,
    causalNewsEffect: false as const, calibrated: false as const, holderExecutableExit: false as const,
    forecastValidated: false as const }
  if (!linkage) return { ...base, status: 'source_not_enrolled' as const, facts: [], conditionalNetScenario: null }
  if (linkage.lane === 'foreign_intermediate') return { ...base,
    status: 'foreign_units_require_joint_conversion' as const, facts: [], conditionalNetScenario: null }
  try {
    const audit = loadPinnedAudit()
    const history = Object.values(audit.histories).find((h: any) => h.identity.routeKey === question.routeKey &&
      h.identity.destination === question.destination && h.identity.asset === question.payoutAsset &&
      h.identity.assetDecimals === question.assetDecimals) as ConditionalSampledCashHistory | undefined
    if (!history || Date.parse(history.witness.availableAt) > issueMs) throw Error('history_unavailable_at_issue')
    const facts = history.points.slice(-2).map(p => ({ block: p[1], blockHash: p[2],
      occurredAtUtc: p[3], availableAtUtc: history.witness.availableAt, cashRaw: p[4],
      source: 'authenticated_pinned_native_history' as const,
      receiptSha256: history.witness.lastDailyReceiptSha256 }))
    let worst: { numeratorRaw: string; denominatorMs: number; fromBlock: string; toBlock: string;
      fromAtUtc: string; toAtUtc: string } | null = null
    for (let i = 1; i < history.points.length; i++) {
      const a = history.points[i - 1], b = history.points[i], dt = Date.parse(b[3]) - Date.parse(a[3])
      const net = BigInt(b[4]) - BigInt(a[4])
      if (dt <= 0 || dt > 91800000 || net >= 0n || Date.parse(b[3]) > issueMs) continue
      if (!worst || net * BigInt(worst.denominatorMs) < BigInt(worst.numeratorRaw) * BigInt(dt))
        worst = { numeratorRaw: String(net), denominatorMs: dt,
          fromBlock: a[1], toBlock: b[1], fromAtUtc: a[3], toAtUtc: b[3] }
    }
    let source: { cashRaw: string; block: string; blockHash: string; sourceAtUtc: string } | null = null
    if (current.status === 'available') {
      const v = current.value, p = v.observations.at(-1)
      if (v.routeKey === question.routeKey && v.destination === question.destination &&
          v.payoutAsset === question.payoutAsset && v.assetDecimals === question.assetDecimals &&
          v.metric === 'aggregate_cash_raw' && v.meaning === 'aggregate_route_liquidity_proxy_not_holder_executable_capacity' &&
          ['local_hash_chain_replay','database_identity_checked'].includes(v.verification) && p &&
          raw(p.raw) && raw(p.block) && /^0x[0-9a-f]{64}$/.test(p.blockHash) &&
          Number.isFinite(Date.parse(p.blockTime)) && Date.parse(p.blockTime) <= issueMs &&
          issueMs - Date.parse(p.blockTime) <= 86400000) {
        source = { cashRaw: p.raw, block: p.block, blockHash: p.blockHash, sourceAtUtc: p.blockTime }
      }
    }
    const elapsed = source ? issueMs + question.horizonHours * 3600000 - Date.parse(source.sourceAtUtc) : null
    const delta = worst && elapsed !== null && Number.isSafeInteger(elapsed) && elapsed >= 0 ?
      floor(BigInt(worst.numeratorRaw) * BigInt(elapsed), BigInt(worst.denominatorMs)) : null
    const cash = delta !== null && source ? BigInt(source.cashRaw) + delta : null
    return { ...base, status: source ? 'historical_and_recorded_aggregate_facts' as const : 'historical_primary_facts_only' as const,
      facts, historyWitness: history.witness,
      measuredHistoricalCashChangeRaw: facts.length === 2 ? String(BigInt(facts[1].cashRaw) - BigInt(facts[0].cashRaw)) : null,
      recordedCurrentSource: source, currentSourceHolderQualified: false,
      conditionalNetScenario: worst ? { kind: 'historical_adverse_net_persists' as const,
        rate: worst, historicalNetIncludesOtherUsers: true,
        assumption: 'repeat_selected_native_NET_rate_unchanged_mechanism_not_a_news_effect' as const,
        targetAtUtc: new Date(issueMs + question.horizonHours * 3600000).toISOString(),
        currentSource: source, conditionalCashDeltaRaw: delta === null ? null : String(delta),
        conditionalCashProxyRaw: cash !== null && cash >= 0n && cash <= MAX ? String(cash) : null,
        endpointCensored: cash !== null && (cash < 0n || cash > MAX),
        noQOrAdditionalMDeductedHere: true, holderHeadroom: null } : null }
  } catch { return { ...base, status: 'pinned_history_not_available' as const, facts: [], conditionalNetScenario: null } }
}
