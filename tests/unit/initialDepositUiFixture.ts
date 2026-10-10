import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { buildConditionalSampledCashPathProjection } from '@/lib/carry/conditionalSampledCashPathProjection'
import {
  buildInitialDepositCapacityProjection,
  INITIAL_DEPOSIT_MARKETS,
} from '@/lib/carry/initialDepositCapacityProjection'
import {
  initialDepositIssueFromResponse,
  initialDepositQuestion,
} from '@/components/Carry/initialDepositScenario'

export const NOW = Date.parse('2026-10-08T12:00:00.000Z')
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const audit = JSON.parse(
  readFileSync(
    'data/research/venue-signals/conditional-sampled-cash-history-v1.audit.json',
    'utf8',
  ),
)
export function initialDepositUiFixture({
  D = '10',
  Q = '9',
  H = 24,
  native = true,
  blocked = false,
  cash = '100',
  market = 0,
} = {}) {
  const m = INITIAL_DEPOSIT_MARKETS[market]
  const history = Object.values(audit.histories).find(
    (h: any) => h.identity.routeKey === m.routeKey,
  ) as any
  const source = {
    ...history.identity,
    chainId: 1 as const,
    cashRaw: cash,
    block: '26190000',
    blockHash: `0x${'a'.repeat(64)}`,
    blockTime: new Date(NOW - 1000).toISOString(),
    readAt: new Date(NOW).toISOString(),
    sourceKind: 'live_read_only_two_origin_finalized' as const,
  }
  const dailyProjection = buildConditionalSampledCashPathProjection(
    {
      history,
      currentSource: source,
      request: { requestedRaw: Q, asOf: new Date(NOW).toISOString() },
    },
    hash,
  )
  const facts = {
    pool: m.pool,
    aToken: source.destination,
    asset: source.asset,
    assetDecimals: 6 as const,
    configurationRaw: String((6n << 48n) | (1n << 56n) | (blocked ? 1n << 57n : 0n)),
    normalizedIncomeRaw: String(10n ** 27n),
    scaledTotalSupplyRaw: '1000',
    accruedToTreasuryScaledRaw: '20',
  }
  const projection = buildInitialDepositCapacityProjection(
    {
      currentSource: source,
      dailyProjection,
      depositAssetsRaw: D,
      plannedExitAssetsRaw: Q,
      horizonHours: H,
      asOfMs: NOW,
      nativeAgreement: native
        ? {
            status: 'agreed_initial_deposit_native_facts',
            currentSource: source,
            readAt: source.readAt,
            origins: [
              { originHostSha256: hash('one'), facts },
              { originHostSha256: hash('two'), facts: { ...facts } },
            ],
          }
        : undefined,
    },
    hash,
  )
  if (projection.status !== 'conditional_initial_deposit_projection') throw Error(projection.reason)
  const units = (v: string) =>
    `${BigInt(v) / 1000000n}.${String(BigInt(v) % 1000000n).padStart(6, '0')}`
  const question = initialDepositQuestion(
    'initial_deposit',
    source.routeKey,
    source.destination,
    units(D),
    units(Q),
    H,
  )!
  const body = {
    routeKey: source.routeKey,
    destination: source.destination,
    source: 'prospective_finalized_observations',
    forecast: {
      claim: 'aggregate_cash_proxy_only',
      amountUnits: Number(units(Q)),
      horizonHours: H,
    },
    initialDepositProjection: projection,
    conditionalSampledCashPathProjection: dailyProjection,
  }
  const issue = initialDepositIssueFromResponse(body, question, NOW, NOW)!
  const currentCash = {
    routeKey: source.routeKey,
    destination: source.destination,
    cashRaw: cash,
    assetAddress: source.asset,
    assetDecimals: 6,
    assetSymbol: market ? 'USDT' : 'USDC',
    observedAt: source.blockTime,
    block: source.block,
    blockHash: source.blockHash,
    freshness: 'fresh' as const,
    label: 'Market cash' as const,
    sourceKind: source.sourceKind,
    readAtUtc: source.readAt,
  }
  const props = {
    routeKey: source.routeKey,
    destination: source.destination,
    requestedAmount: units(Q),
    requestedRaw: Q,
    requestedAssetSymbol: currentCash.assetSymbol,
    requestedAssetAddress: source.asset,
    requestedAssetDecimals: 6,
    horizonHours: H,
    asOfMs: NOW,
    currentCash,
    conditionalSampledCashPathProjection: dailyProjection,
    scenarioMode: 'initial_deposit' as const,
    depositAmount: units(D),
    initialDepositIssue: issue,
    prospectiveCashModel: null,
    historicalScenario: null,
    grossWithdrawals: null,
    grossInflows: null,
    historicalGrossFlow: null,
    morphoPayout: null,
    holderAssessment: null,
    expectedEventEnrollment: null,
    eventContext: null,
    historicalOutlook: null,
  }
  return { source, dailyProjection, projection, question, body, issue, currentCash, props }
}
