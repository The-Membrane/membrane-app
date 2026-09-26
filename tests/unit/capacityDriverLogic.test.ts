import { describe, expect, it } from 'vitest'

import {
  explainCapacityMove,
  validatedTransactionEvidence,
  type DriverEvent,
  type DriverSnapshot,
  type VenueDriverConfig,
} from '@/components/Venue/capacityDriverLogic'

const marketA = {
  name: 'Pool A',
  kind: 'psm-buffer',
  address: '0xA1',
  buffer: '0xA2',
  bufferToken: '0xA3',
  exitFrom: '0xA4',
  enabled: true,
}
const marketB = {
  name: 'Pool B',
  kind: 'psm-buffer',
  address: '0xB1',
  buffer: '0xB2',
  bufferToken: '0xB3',
  exitFrom: '0xB4',
  enabled: true,
}
const config: VenueDriverConfig = {
  name: 'test',
  kind: 'erc4626-cooldown',
  depthMarkets: [marketA, marketB],
}
const read = (market: typeof marketA, usd: number) => ({
  ...market,
  exitableUsd: usd,
  bufferBalanceRaw: String(usd * 1e6),
  priceAssumptionUsd: 1,
  reads: { buffer: true },
})

const classEvidenceRow = () => ({
  event_id: 'event',
  venue: 'test',
  status: 'reconciled',
  evidence: {
    eventId: 'event',
    venue: 'test',
    window: { fromBlock: 10, toBlock: 11 },
    blockPinnedSnapshots: false,
    results: [
      {
        market: 'Pool A',
        recordedReserveDeltaUsdProxy: 60,
        transferNetUsdProxy: 60,
        byTransactionClassUsdProxy: {
          swap: 50,
          lp_add: 10,
          lp_remove: 0,
          mixed: 0,
          direct_or_other: 0,
        },
        residualVsRecordedUsdProxy: 0,
        residualPctOfGrossMovement: 0,
        attributionGate95Pct: true,
      },
      {
        market: 'Pool B',
        recordedReserveDeltaUsdProxy: 0,
        transferNetUsdProxy: 0,
        byTransactionClassUsdProxy: {
          swap: -5,
          lp_add: 5,
          lp_remove: 0,
          mixed: 0,
          direct_or_other: 0,
        },
        residualVsRecordedUsdProxy: 0,
        residualPctOfGrossMovement: 0,
        attributionGate95Pct: true,
      },
    ],
  },
})
const snap = (id: string, at: string, a: number, b: number): DriverSnapshot => ({
  id,
  block: id === 'prior' ? 10 : 11,
  observedAt: at,
  instantUsd: null,
  params: { depth_usd: a + b, depthMarkets: [read(marketA, a), read(marketB, b)] },
})
const old = snap('prior', '2026-09-20T00:00:00.000Z', 100, 100)
const next = snap('next', '2026-09-20T01:00:00.000Z', 160, 100)
const event: DriverEvent = {
  id: 'event',
  kind: 'param_changed',
  prev: { depth_usd: 200 },
  next: { depth_usd: 260 },
}

describe('observed capacity component accounting', () => {
  it('reconciles per-market exit-side inventory deltas to the exact observed total', () => {
    const result = explainCapacityMove(config, event, old, next)
    expect(result.status).toBe('available')
    if (result.status !== 'available') return
    expect(result.deltaUsd).toBe(60)
    expect(result.components.map((part) => part.deltaUsd)).toEqual([60, 0])
    expect(result.components.reduce((sum, part) => sum + part.deltaUsd, 0)).toBe(result.deltaUsd)
    expect(result.aaveStocks).toBeNull()
  })

  it('refuses a failed enabled-market read, not interpreting it as a real contraction', () => {
    const failed = structuredClone(next)
    const market = (failed.params.depthMarkets as Record<string, unknown>[])[0]
    market.reads = { buffer: false }
    market.exitableUsd = null
    expect(explainCapacityMove(config, event, old, failed)).toMatchObject({
      status: 'unavailable',
      reason: 'incomplete_read',
    })
    const failedPrecision = structuredClone(next)
    ;(failedPrecision.params.depthMarkets as Record<string, unknown>[])[0].reads = {
      buffer: true,
      decimals: false,
    }
    expect(explainCapacityMove(config, event, old, failedPrecision)).toMatchObject({
      status: 'unavailable',
      reason: 'incomplete_read',
    })
    const failedAggregate = structuredClone(next)
    failedAggregate.params.depth_complete = false
    expect(explainCapacityMove(config, event, old, failedAggregate)).toMatchObject({
      status: 'unavailable',
      reason: 'incomplete_read',
    })
  })

  it('refuses a changed market set or an aggregate that does not sum to the markets', () => {
    const missing = structuredClone(next)
    ;(missing.params.depthMarkets as unknown[]).pop()
    expect(explainCapacityMove(config, event, old, missing)).toMatchObject({
      status: 'unavailable',
      reason: 'market_set_changed',
    })
    const wrong = structuredClone(next)
    ;(wrong.params.depthMarkets as Record<string, unknown>[])[0].exitableUsd = 180
    expect(explainCapacityMove(config, event, old, wrong)).toMatchObject({
      status: 'unavailable',
      reason: 'unreconciled',
    })
  })

  it('shows Aave cash and variable debt as separate stocks, not additive causes', () => {
    const aave: VenueDriverConfig = { name: 'aave-v3-usde', kind: 'atoken-liquidity' }
    const aaveSnap = (id: string, at: string, cash: number, debt: number): DriverSnapshot => ({
      id,
      block: id === 'prior' ? 10 : 11,
      observedAt: at,
      instantUsd: cash,
      params: {
        underlyingBalance: String(BigInt(cash) * 10n ** 18n),
        variableDebt: String(BigInt(debt) * 10n ** 18n),
        decimals: 18,
        priceAssumptionUsd: 1,
        reads: { underlyingBalance: true, variableDebt: true },
      },
    })
    const result = explainCapacityMove(
      aave,
      {
        id: 'aave-event',
        kind: 'instant_liquidity_shift',
        prev: { instant_usd: 100 },
        next: { instant_usd: 130 },
      },
      aaveSnap('prior', old.observedAt, 100, 200),
      aaveSnap('next', next.observedAt, 130, 180),
    )
    expect(result.status).toBe('available')
    if (result.status !== 'available') return
    expect(result.deltaUsd).toBe(30)
    expect(result.aaveStocks).toMatchObject({ cashDeltaUsd: 30, debtDeltaUsd: -20 })
    expect(result.components).toEqual([])
  })

  it('does not turn unchanged observations into a significant shift', () => {
    const unchanged = snap('next', next.observedAt, 100, 100)
    const noShift: DriverEvent = {
      id: 'event',
      kind: 'param_changed',
      prev: { depth_usd: 200 },
      next: { depth_usd: 200 },
    }
    expect(explainCapacityMove(config, noShift, old, unchanged)).toMatchObject({
      status: 'unavailable',
      reason: 'invalid_event',
    })
    expect(explainCapacityMove(config, null, old, next)).toMatchObject({
      status: 'unavailable',
      reason: 'no_event',
    })
  })
})

describe('transaction-class evidence claim gate', () => {
  const base = explainCapacityMove(config, event, old, next)
  if (base.status !== 'available') throw new Error('test fixture must be available')
  const curveBase = {
    ...base,
    components: base.components.map((component) => ({ ...component, kind: 'curve-stableswap' })),
  }

  it('aggregates only a reconciled same-event, same-block, all-market record', () => {
    expect(validatedTransactionEvidence(base, 'test', classEvidenceRow())).toBeNull()
    const result = validatedTransactionEvidence(curveBase, 'test', classEvidenceRow())
    expect(result).toMatchObject({
      blockPinnedSnapshots: false,
      byClassUsdProxy: { swap: 45, lp_add: 15 },
      transferNetUsdProxy: 60,
      residualUsdProxy: 0,
    })
    expect(result?.markets).toHaveLength(2)
  })

  it('fails closed on missing, incomplete, wrong-event, or failed-gate evidence', () => {
    expect(validatedTransactionEvidence(curveBase, 'test', null)).toBeNull()
    const incomplete = classEvidenceRow()
    incomplete.status = 'incomplete'
    expect(validatedTransactionEvidence(curveBase, 'test', incomplete)).toBeNull()
    const wrongEvent = classEvidenceRow()
    wrongEvent.event_id = 'another-event'
    expect(validatedTransactionEvidence(curveBase, 'test', wrongEvent)).toBeNull()
    const failedGate = classEvidenceRow()
    failedGate.evidence.results[0].attributionGate95Pct = false
    expect(validatedTransactionEvidence(curveBase, 'test', failedGate)).toBeNull()
    const wrongBlock = classEvidenceRow()
    wrongBlock.evidence.window.toBlock = 12
    expect(validatedTransactionEvidence(curveBase, 'test', wrongBlock)).toBeNull()
  })

  it('rejects a missing market, class arithmetic error, or residual mismatch', () => {
    const missing = classEvidenceRow()
    missing.evidence.results.pop()
    expect(validatedTransactionEvidence(curveBase, 'test', missing)).toBeNull()
    const wrongClass = classEvidenceRow()
    wrongClass.evidence.results[0].byTransactionClassUsdProxy.swap = 45
    expect(validatedTransactionEvidence(curveBase, 'test', wrongClass)).toBeNull()
    const wrongResidual = classEvidenceRow()
    wrongResidual.evidence.results[0].residualVsRecordedUsdProxy = 2
    expect(validatedTransactionEvidence(curveBase, 'test', wrongResidual)).toBeNull()
  })
})
