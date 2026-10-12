import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { readBoundedReceiptFile } from '../../scripts/lib/boundedLocalReceiptFile.mjs'
import type { RouteEventQuestion } from './routeEventContext'
import type { ReviewedPrimaryEvent } from './primaryEventNetScenario'

const SHA = '17e896684f87f87eb65ba446fa87093647f1a953da522a8b421a4423ae7c003b'
const CONFIGURATOR = '0x64b761d848206f447fe2dd461b0c635ec39ebb27'
const SUBJECTS = [
  { routeKey: 'USDC → supply on Aave V3', destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', assetDecimals: 6 },
  { routeKey: 'USDe → supply on Aave V3', destination: '0x4f5923fc5fd4a93352581b38b7cd26943012decf',
    asset: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3', assetDecimals: 18 },
]
type PrimaryLogFact = ReviewedPrimaryEvent & {
  originalArgs: Record<string, string | boolean | number>
  block: string
  logIndex: number
}
type ProtocolRuleScenarioBase = {
  sourceEvent: PrimaryLogFact
  assumption: 'latest_recorded_parameter_unchanged_through_issue_plus_H'
  targetAtUtc: string
  initialDepositBlockedByThisParameter: boolean
  holderExitBlockedByThisParameter: boolean
  initialDepositUpperBoundRaw: '0' | null
  holderExitUpperBoundRaw: '0' | null
  currentConfigurationKnown: false
  otherProtocolChecksKnown: false
  causalNewsEffect: false
  holderExecutableExit: false
}
type ProtocolRuleScenario = ProtocolRuleScenarioBase & (
  { parameter: 'paused' | 'frozen'; value: boolean }
  | { parameter: 'liquidationThresholdBps'; value: string
      collateralValueRule: {
        applicability: 'sole_collateral_standard_mode_fixed_prices'
        valueUnit: 'same_quote_currency_value_not_asset_raw'
        relation: 'remaining_collateral_value_gte_debt_value_times_10000_div_threshold_bps'
        numerator: '10000'
        denominatorBps: string
      }
      borrowerStateKnown: false
      pricesKnown: false
      eModeKnown: false }
)

function args(value: unknown): Record<string, string | boolean | number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (entries.length > 16 || entries.some(([k, v]) => !/^[A-Za-z0-9_]{1,64}$/.test(k) ||
      (typeof v !== 'boolean' && !(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) &&
        (typeof v !== 'string' || v.length > 256)))) return null
  return Object.fromEntries(entries)
}

/** Recorded primary logs, with collection availability distinct from occurrence.
 * Exact dataset hash approves neither current config nor a reconstructed past forecast.
 * Block hashes are absent from this dataset: these facts cannot qualify a holder source. */
export function readAavePrimaryEventFacts(question: RouteEventQuestion, cutoffMs: number) {
  const subject = SUBJECTS.find(s => s.routeKey === question.routeKey && s.destination === question.destination &&
    s.asset === question.payoutAsset && s.assetDecimals === question.assetDecimals)
  const base = { schema: 'route_primary_event_facts_v1' as const, question, issuedAtUtc: new Date(cutoffMs).toISOString(),
    association: 'primary_facts_not_causal_news_effect' as const,
    version: 'aave_v3_ethereum_core' as const,
    historicalStateOnly: true, currentConfigurationKnown: false,
    scenario: null, scenarioReason: 'no_reviewed_event_NET_assumption' as const,
    conditionalScenarios: [] as ProtocolRuleScenario[],
    holderExecutableExit: false as const, forecastValidated: false as const }
  if (!subject) return { ...base, status: 'subject_not_enrolled' as const, facts: [] }
  try {
    const path = resolve(process.env.MEMBRANE_DATASETS_DIR ?? '/workspace/membrane-datasets',
      'governance-changes/aave-v3-ethereum-core.json')
    const text = readBoundedReceiptFile(path, { maxFileBytes: 300000, maxTotalBytes: 300000, totalBytes: 0 })
    if (createHash('sha256').update(text).digest('hex') !== SHA) throw Error('primary_event_pin')
    const body = JSON.parse(text), available = Date.parse(body.fetchedAt)
    if (!Number.isSafeInteger(cutoffMs) || !Number.isFinite(available) || available > cutoffMs ||
        body.configurator !== CONFIGURATOR || !Array.isArray(body.events) || body.events.length > 5000)
      throw Error('primary_event_availability_or_identity')
    const eligible = body.events.filter((e: any) => e.chainId === 1 &&
      e.address === CONFIGURATOR && e.args?.asset?.toLowerCase() === subject.asset &&
      Number.isSafeInteger(e.block) && Number.isSafeInteger(e.logIndex) && Number.isSafeInteger(e.ts) &&
      e.ts * 1000 <= available && /^0x[0-9a-f]{64}$/.test(e.tx) &&
      typeof e.name === 'string' && /^[A-Za-z0-9_]{1,96}$/.test(e.name) && args(e.args))
      .sort((a: any, b: any) => b.block - a.block || b.logIndex - a.logIndex)
    const fact = (e: any): PrimaryLogFact => ({ eventId: `${e.tx}:${e.logIndex}`, title: e.name,
        affected: { ...subject, version: 'aave_v3_ethereum_core' },
        primarySource: { kind: 'native_log', url: `https://etherscan.io/tx/${e.tx}#eventlog`,
          contentSha256: SHA, reviewRef: 'governance-changes/manifest.json:aave-v3-ethereum-core.json' },
        occurredAtUtc: new Date(e.ts * 1000).toISOString(), publishedAtUtc: null,
        fetchedAtUtc: body.fetchedAt, availableAtUtc: body.fetchedAt,
        originalArgs: args(e.args)!, block: String(e.block), logIndex: e.logIndex })
    const facts = eligible.slice(0, 20).map(fact)
    const conditionalScenarios: ProtocolRuleScenario[] = []
    const targetAtUtc = new Date(cutoffMs + question.horizonHours * 3600000).toISOString()
    for (const [eventName, parameter] of [['ReservePaused','paused'],['ReserveFrozen','frozen']] as const) {
      // Select independently before the twenty-fact display limit, so an older opposite
      // setting cannot displace a more recent event for this same exact parameter.
      const latest = eligible.find((e: any) => e.name === eventName && typeof e.args[parameter] === 'boolean')
      if (!latest) continue
      const blocked = latest.args[parameter] as boolean
      conditionalScenarios.push({ parameter, value: blocked, sourceEvent: fact(latest),
        assumption: 'latest_recorded_parameter_unchanged_through_issue_plus_H', targetAtUtc,
        initialDepositBlockedByThisParameter: blocked,
        holderExitBlockedByThisParameter: parameter === 'paused' && blocked,
        initialDepositUpperBoundRaw: blocked ? '0' : null,
        holderExitUpperBoundRaw: parameter === 'paused' && blocked ? '0' : null,
        currentConfigurationKnown: false, otherProtocolChecksKnown: false,
        causalNewsEffect: false, holderExecutableExit: false })
    }
    const collateral = eligible.find((e: any) => e.name === 'CollateralConfigurationChanged')
    // A zero threshold contributes no positive borrowing coverage; do not divide
    // by zero or substitute LTV. The most recent valid recorded setting wins.
    if (collateral && typeof collateral.args.liquidationThreshold === 'string' &&
        /^(0|[1-9][0-9]{0,4})$/.test(collateral.args.liquidationThreshold) &&
        BigInt(collateral.args.liquidationThreshold) > 0n && BigInt(collateral.args.liquidationThreshold) <= 10000n) {
      const value = collateral.args.liquidationThreshold as string
      conditionalScenarios.push({ parameter: 'liquidationThresholdBps', value,
        sourceEvent: fact(collateral),
        assumption: 'latest_recorded_parameter_unchanged_through_issue_plus_H', targetAtUtc,
        initialDepositBlockedByThisParameter: false, holderExitBlockedByThisParameter: false,
        initialDepositUpperBoundRaw: null, holderExitUpperBoundRaw: null,
        currentConfigurationKnown: false, otherProtocolChecksKnown: false,
        causalNewsEffect: false, holderExecutableExit: false,
        collateralValueRule: { applicability: 'sole_collateral_standard_mode_fixed_prices',
          valueUnit: 'same_quote_currency_value_not_asset_raw',
          relation: 'remaining_collateral_value_gte_debt_value_times_10000_div_threshold_bps',
          numerator: '10000', denominatorBps: value },
        borrowerStateKnown: false, pricesKnown: false, eModeKnown: false })
    }
    return { ...base, status: 'recorded_primary_facts' as const, sourceSha256: SHA,
      availableAtUtc: body.fetchedAt, blockHashEvidence: 'not_recorded' as const, facts, conditionalScenarios }
  } catch { return { ...base, status: 'source_unavailable_or_not_yet_available' as const, facts: [] } }
}
