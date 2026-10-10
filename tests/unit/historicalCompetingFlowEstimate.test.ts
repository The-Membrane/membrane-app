import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import summary from '@/data/research/venue-signals/aave-usdc-flow-stress-duration-v1.json'
import {
  AAVE_COMPETING_FLOW_IDENTITY,
  buildHistoricalCompetingFlowEstimate,
  selectedHistoricalCompetingFlowEstimate,
} from '@/lib/carry/historicalCompetingFlowEstimate'
import {
  buildExitImpactForecast,
  withHistoricalCompetingFlow,
} from '@/lib/forecast/exitImpactForecast'
import { carryForecastRequest, readAaveHistoricalCompetingFlow } from '@/pages/api/carry/forecast'
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const estimate = () => buildHistoricalCompetingFlowEstimate(summary, hash)

describe('verified historical competing flow', () => {
  it('replays pinned aggregate flow with 78 bounded durations and only two exact endpoints', () => {
    const e = estimate()
    expect(e.status).toBe('historical_context')
    if (e.status !== 'historical_context') throw Error('fixture')
    expect(e).toMatchObject({
      windowCount: 78,
      horizonBlocks: 256,
      claim: 'aggregate_reserve_gross_flow_only',
      selectedHorizonForecast: false,
      holderExecutableExit: false,
      prospectiveValidated: false,
      forecastValidated: false,
    })
    expect(e.timeCoverage).toEqual({
      boundedWindows: 78,
      exactWindows: 2,
      durationSeconds: { lowerSeconds: 2532, upperSeconds: 3588 },
    })
    expect(e.chronologicalBacktest.lastWindow.trainingWindows).toBe(77)
    expect(e.chronologicalBacktest.lastWindow.depletion.totalRaw).toBe(
      (BigInt(e.grossDepletion.totalRaw) - BigInt(e.windows[77].grossReserveOutRaw)).toString(),
    )
    expect(e.chronologicalBacktest.lastWindow.replenishment.totalRaw).toBe(
      (BigInt(e.grossReplenishment.totalRaw) - BigInt(e.windows[77].grossReserveInRaw)).toString(),
    )
    expect(e.chronologicalBacktest.depletion.meanAbsoluteError.denominator).toBe(77)
    expect(e.grossDepletion.totalRaw).toBe('1128372422222473')
    expect(e.chronologicalBacktest.depletion.meanAbsoluteError.numeratorRaw).toBe(
      '1348505579102656',
    )
    expect(e.chronologicalBacktest.depletion.persistenceAbsoluteError.numeratorRaw).toBe(
      '1799087254800962',
    )
    expect(e.chronologicalBacktest.replenishment.meanAbsoluteError.numeratorRaw).toBe(
      '1114055170284740',
    )
    expect(readAaveHistoricalCompetingFlow()).toEqual(e)
  })
  it.each(['amount', 'conservation', 'overlap', 'count', 'duration', 'identity'])(
    'rejects corrupted physical evidence: %s',
    (change) => {
      const s = structuredClone(summary)
      if (change === 'amount') Object.assign(s.pairedWindows[0], { grossReserveOutRaw: ['1'] })
      if (change === 'conservation') s.pairedWindows[0].targetCashRaw = '1'
      if (change === 'overlap') s.pairedWindows[1].originBlock = s.pairedWindows[0].originBlock
      if (change === 'count') s.pairedWindows.pop()
      if (change === 'duration') s.pairedWindows[0].durationPath.timeHeaders[0].timestampSec += 1
      if (change === 'identity') s.identity.marketKey = 'other'
      expect(buildHistoricalCompetingFlowEstimate(s, hash).status).toBe('unavailable')
    },
  )
  it.each(['mean', 'mae', 'duration', 'windows', 'flags', 'array'])(
    'browser recomputation rejects altered context: %s',
    (change) => {
      const e = estimate()
      if (e.status !== 'historical_context') throw Error('fixture')
      const altered = structuredClone(e)
      if (change === 'mean') altered.grossDepletion.mean.numeratorRaw = '1'
      if (change === 'mae')
        altered.chronologicalBacktest.depletion.meanAbsoluteError.numeratorRaw = '1'
      if (change === 'duration') altered.windows[0].durationSeconds!.upperSeconds += 1
      if (change === 'windows') altered.windows.reverse()
      if (change === 'flags') Object.assign(altered, { selectedHorizonForecast: true })
      if (change === 'array')
        Object.assign(altered, { grossDepletion: Object.entries(altered.grossDepletion) })
      expect(
        selectedHistoricalCompetingFlowEstimate(altered, AAVE_COMPETING_FLOW_IDENTITY, hash),
      ).toBeNull()
    },
  )
  it('binds the exact reserve and keeps cash/Q arithmetic and selected horizon unchanged', () => {
    const e = estimate()
    const f = buildExitImpactForecast({
      kind: 'conditional_projection',
      identity: AAVE_COMPETING_FLOW_IDENTITY,
      requestedRaw: '1000000',
      horizonHours: 24,
      scenario: { status: 'unavailable', reason: 'untouched_holdout_failed' },
    })
    const before = structuredClone(f)
    const attached = withHistoricalCompetingFlow(f, e, hash)!
    expect(attached.expectedCompetingFlow.status).toBe('historical_context')
    expect({ ...attached, expectedCompetingFlow: before.expectedCompetingFlow }).toEqual(before)
    expect(f).toEqual(before)
    expect(
      withHistoricalCompetingFlow(
        { ...f, identity: { ...f.identity, destination: `0x${'a'.repeat(40)}` } },
        e,
        hash,
      )?.expectedCompetingFlow.status,
    ).toBe('unavailable')
    expect(
      selectedHistoricalCompetingFlowEstimate(
        e,
        { ...AAVE_COMPETING_FLOW_IDENTITY, assetDecimals: 18 },
        hash,
      ),
    ).toBeNull()
  })
  it('actual saved-data API branch attaches Aave context without any network read', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const fetch = vi.fn(() => {
      throw Error('network forbidden')
    })
    vi.stubGlobal('fetch', fetch)
    try {
      let code = 0
      let body: any
      const headers = vi.fn()
      await carryForecastRequest(
        {
          method: 'GET',
          query: {
            routeKey: AAVE_COMPETING_FLOW_IDENTITY.routeKey,
            destination: AAVE_COMPETING_FLOW_IDENTITY.destination,
            amountUnits: '1',
            horizonHours: '24',
          },
          socket: { remoteAddress: '127.0.0.1' },
        } as never,
        {
          setHeader: headers,
          status(n: number) {
            code = n
            return this
          },
          json(v: unknown) {
            body = v
            return this
          },
        } as never,
        async () => ({ status: 'unavailable' }) as never,
        async () => ({ status: 'unavailable' }) as never,
      )
      expect(code).toBe(200)
      expect(headers).toHaveBeenCalledWith('Cache-Control', 'no-store')
      expect(body.exitImpact.historicalBacktest.expectedCompetingFlow).toEqual(estimate())
      expect(body.exitImpact.historicalBacktest.question).toEqual({
        requestedRaw: '1000000',
        horizonHours: 24,
      })
      expect(body.exitImpact.historicalBacktest.expectedCompetingFlow.horizonBlocks).toBe(256)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
    }
  })
})
