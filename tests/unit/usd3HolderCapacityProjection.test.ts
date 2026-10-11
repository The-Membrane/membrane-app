import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import audit from '@/data/research/venue-signals/conditional-sampled-cash-history-v1.audit.json'
import {
  buildConditionalSampledCashPathProjection,
  selectedConditionalSampledCashPathProjection,
  type ConditionalSampledCashHistory,
} from '@/lib/carry/conditionalSampledCashPathProjection'
import {
  buildHolderExitCapacityQuote,
  agreeHolderExitCapacityQuotes,
  selectedHolderExitCapacity,
} from '@/lib/carry/holderExitCapacity'
import type { HolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import {
  buildUsd3HolderCapacityProjection,
  selectedUsd3HolderCapacityProjection,
  type Usd3HolderCapacityInput,
} from '@/lib/carry/usd3HolderCapacityProjection'
const hash = (s: string) => createHash('sha256').update(s).digest('hex'),
  NOW = Date.parse('2026-10-08T12:00:00.000Z'),
  unit = 10n ** 6n
function fixture(full = 1000n, cash = 500n, nativeLimit?: bigint) {
  const history = structuredClone(
    Object.values(audit.histories).find((h) => h.identity.routeKey === 'USDC → USD3 [USDC]')!,
  ) as ConditionalSampledCashHistory
  const owner = `0x${'b'.repeat(40)}` as `0x${string}`,
    requestedRaw = (20n * unit).toString()
  const currentSource = {
    ...history.identity,
    chainId: 1 as const,
    block: '26190000',
    blockHash: `0x${'a'.repeat(64)}`,
    blockTime: new Date(NOW - 60000).toISOString(),
    readAt: new Date(NOW).toISOString(),
    cashRaw: (cash * unit).toString(),
    sourceKind: 'live_read_only_two_origin_finalized' as const,
  }
  const source = {
    chainId: 1 as const,
    blockNumber: Number(currentSource.block),
    blockHash: currentSource.blockHash,
    blockTime: currentSource.blockTime,
    finalized: true as const,
  }
  const assessment: HolderExitAssessment = {
    status: 'assessed',
    routeKey: history.identity.routeKey,
    destinationAddress: history.identity.destination as `0x${string}`,
    owner,
    request: {
      assetsRaw: requestedRaw,
      assetAddress: history.identity.asset as `0x${string}`,
      horizonHours: 24,
    },
    source: { ...source, originValidation: 'single_provider' },
    stages: [
      {
        name: 'withdrawal',
        relatedToRequest: true,
        status: 'reverted',
        amountRaw: requestedRaw,
        assetAddress: history.identity.asset as `0x${string}`,
      },
    ],
    finalPayout: {
      status: 'unassessed',
      assetAddress: history.identity.asset as `0x${string}`,
      amountRaw: null,
    },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
  }
  const quote = buildHolderExitCapacityQuote(
    assessment,
    {
      entitlementRaw: (full * unit).toString(),
      quotedMaxWithdrawRaw: (10n * unit).toString(),
      quotedMaxWithdrawStatus: 'quoted',
      effectiveLimitRaw: null,
      withdrawalsPaused: null,
      ...(nativeLimit === undefined
        ? {}
        : {
            usd3NativeCapacity: {
              owner,
              method: 'availableWithdrawLimit(address)' as const,
              asset: history.identity.asset,
              assetDecimals: 6 as const,
              unit: 'raw_usdc_6' as const,
              capacityRaw: (nativeLimit * unit).toString(),
              resultStatus: 'quoted' as const,
              source,
              runtimeProfile: null,
            },
          }),
    },
    NOW,
  )!
  const capacityAgreement = agreeHolderExitCapacityQuotes(
    { host: 'one.example', quote },
    { host: 'two.example', quote },
    NOW,
  )!
  const cashProjection = buildConditionalSampledCashPathProjection(
    { history, currentSource, request: { requestedRaw, asOf: new Date(NOW).toISOString() } },
    hash,
  )
  const input: Usd3HolderCapacityInput = {
    cashProjection,
    capacityAgreement,
    binding: { ...history.identity, owner, requestedRaw, currentSource: source, asOfMs: NOW },
    currentSource,
    horizonHours: 24,
    asOfMs: NOW,
  }
  return {
    input,
    value: buildUsd3HolderCapacityProjection(input, hash)!,
    cashProjection,
    capacityAgreement,
  }
}
describe('USD3 idle cash cannot qualify historical withdrawal funding', () => {
  it.each([0n, 500n, 10n ** 12n])(
    'rejects idle-only funding at %s USDC without changing the diagnostic',
    (idle) => {
      const f = fixture(1000n, idle)
      const before = structuredClone(f.input)
      expect(f.cashProjection?.status).toBe('estimated')
      expect(selectedHolderExitCapacity(f.capacityAgreement, f.input.binding)).not.toBeNull()
      expect(
        selectedConditionalSampledCashPathProjection(
          f.cashProjection,
          {
            identity: (f.cashProjection as any).identity,
            requestedRaw: f.input.binding.requestedRaw,
            currentSource: f.input.currentSource,
            asOfMs: NOW,
          },
          hash,
        ),
      ).not.toBeNull()
      expect(f.value).toBeNull()
      expect(f.input).toEqual(before)
      expect(f.input.currentSource.cashRaw).toBe((idle * unit).toString())
    },
  )

  it.each([1950000n, 5290000n])(
    'a qualified current native limit of %s USDC does not turn idle donors into native history',
    (limit) => {
      const f = fixture(1000n, 0n, limit)
      const capacity = selectedHolderExitCapacity(f.capacityAgreement, f.input.binding)
      expect(capacity?.quote.usd3NativeCapacity).toMatchObject({
        resultStatus: 'quoted',
        capacityRaw: (limit * unit).toString(),
      })
      expect(capacity?.quote.entitlementRaw).toBe('1000000000')
      expect(f.input.currentSource.cashRaw).toBe('0')
      expect(f.value).toBeNull()
    },
  )

  it('rejects an issued legacy idle headline when rendering, including its claimed zero capacity', () => {
    const f = fixture(1000n, 0n)
    const legacyHeadline = {
      status: 'conditional_usd3_holder_capacity_projection',
      input: structuredClone(f.input),
      scope: 'entitlement_clipped_cash_coverage_only',
      horizons: [{ capacity: { minimumRaw: '0', maximumRaw: '0' } }],
      forecastValidated: false,
      holderExecutableExit: false,
    }
    expect(selectedUsd3HolderCapacityProjection(legacyHeadline, f.input, hash)).toBeNull()
  })

  it('does not allow a caller to relabel pinned idle history as native withdrawal funding', () => {
    const f = fixture()
    const input = structuredClone(f.input)
    ;(input.cashProjection as any).cashMeasure = 'availableWithdrawLimit(address)'
    expect(buildUsd3HolderCapacityProjection(input, hash)).toBeNull()
  })
})
