import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import evidence from '@/data/research/venue-signals/stusds-historical-capacity-2026-10-07T14-29.export.json'
import {
  buildHolderExitCapacityQuote,
  agreeHolderExitCapacityQuotes,
} from '@/lib/carry/holderExitCapacity'
import {
  stusdsPinnedProtocolHistory,
  STUSDS_PROTOCOL_CAPACITY_HISTORY_PIN,
} from '@/lib/carry/stusdsProtocolCapacityHistoryPins'
import {
  buildStusdsHistoricalHolderCapacityProjection,
  selectedStusdsHistoricalHolderCapacityProjection,
  stusdsRayPow,
  type StusdsHistoricalHolderCapacityInput,
} from '@/lib/carry/stusdsHistoricalHolderCapacityProjection'
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex'),
  RAY = 10n ** 27n,
  UNIT = 10n ** 18n
const routeKey = 'USDS → StUsds [USDS]',
  destination = '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9',
  asset = evidence.asset,
  owner = '0x' + 'b'.repeat(40)
function fixture(E = 1000n * UNIT, Q = UNIT) {
  const current = {
    point: structuredClone(evidence.current),
    readAtUtc: evidence.knowledgeCutoff,
    captureReceiptSha256: evidence.captureReceiptSha256,
  }
  const asOfMs = Date.parse(evidence.knowledgeCutoff),
    source = {
      chainId: 1 as const,
      blockNumber: Number(current.point.source.blockNumber),
      blockHash: current.point.source.blockHash,
      blockTime: current.point.source.blockTime,
      finalized: true as const,
    }
  const assessment = {
    status: 'assessed',
    routeKey,
    destinationAddress: destination,
    owner,
    request: { assetsRaw: String(Q), assetAddress: asset, horizonHours: 24 },
    source: { ...source, originValidation: 'single_provider' },
    stages: [
      {
        name: 'withdrawal',
        relatedToRequest: true,
        status: 'reverted',
        assetAddress: asset,
        amountRaw: String(Q),
      },
    ],
    finalPayout: { status: 'unassessed', assetAddress: asset, amountRaw: null },
  }
  const quote = buildHolderExitCapacityQuote(
    assessment as any,
    {
      entitlementRaw: String(E),
      quotedMaxWithdrawRaw: '0',
      quotedMaxWithdrawStatus: 'quoted',
      effectiveLimitRaw: null,
      withdrawalsPaused: null,
    },
    asOfMs,
  )!
  expect(quote).toBeTruthy()
  const capacityAgreement = agreeHolderExitCapacityQuotes(
    { host: 'one.example', quote },
    { host: 'two.example', quote },
    asOfMs,
  )!
  const input: StusdsHistoricalHolderCapacityInput = {
    history: stusdsPinnedProtocolHistory(),
    current,
    capacityAgreement,
    binding: {
      routeKey,
      destination,
      owner,
      requestedRaw: String(Q),
      asset,
      assetDecimals: 18,
      currentSource: source,
      asOfMs,
    },
    horizonHours: 24,
    asOfMs,
  }
  const accept = (v: unknown) => JSON.stringify(v) === JSON.stringify(current)
  const value = buildStusdsHistoricalHolderCapacityProjection(input, accept)
  return { input, accept, value, current }
}
describe('StUSDS own global-prong and mechanical-growth holder scenarios', () => {
  it('pins verified full export/body provenance and deeply isolates historical metadata', () => {
    expect(
      hash(
        readFileSync(
          'data/research/venue-signals/stusds-historical-capacity-2026-10-07T14-29.export.json',
        ),
      ),
    ).toBe(STUSDS_PROTOCOL_CAPACITY_HISTORY_PIN.exportFileSha256)
    expect(
      hash(
        readFileSync(
          'data/research/venue-signals/stusds-historical-capacity-2026-10-07T14-29.json',
        ),
      ),
    ).toBe(STUSDS_PROTOCOL_CAPACITY_HISTORY_PIN.rawFileSha256)
    const a = stusdsPinnedProtocolHistory()
    a.history.points[0].globalProngs.totalSupplyRaw = '1'
    expect(stusdsPinnedProtocolHistory().history.points[0].globalProngs.totalSupplyRaw).not.toBe(
      '1',
    )
    expect(
      Object.isFrozen(STUSDS_PROTOCOL_CAPACITY_HISTORY_PIN.history.points[0].globalProngs),
    ).toBe(true)
  })
  it('supports a different entered holder, ignores historical owner E and preserves current M independently', () => {
    const f = fixture()
    expect(f.value).toBeTruthy()
    const v = f.value!
    expect(owner).not.toBe(evidence.current.holderQuote.owner)
    expect(v.owner).toBe(owner)
    expect(v.evidence.historicalHolderMatches).toBe(false)
    expect(v.currentEntitlementRaw).toBe(String(1000n * UNIT))
    expect(v.currentQuotedMaxWithdrawRaw).toBe('0')
    expect(BigInt(v.scenario.capacityLowerRaw[1])).toBeGreaterThan(1000n * UNIT)
    expect(v.scenario.headroomLowerRaw[1]).toBe(
      String(BigInt(v.scenario.capacityLowerRaw[1]) - UNIT),
    )
    const optional = structuredClone(f.input)
    delete optional.current.point.holderQuote
    expect(
      buildStusdsHistoricalHolderCapacityProjection(
        optional,
        (v) => JSON.stringify(v) === JSON.stringify(optional.current),
      ),
    ).toBeTruthy()
  })
  it('matches raw recorded indices before growth and uses joint net S/Art/Due changes only', () => {
    const f = fixture(),
      v = f.value!
    expect(v).toBeTruthy()
    expect(v.futureProngs.totalSupplyRaw).toBe(evidence.current.globalProngs.totalSupplyRaw)
    expect(v.futureProngs.vatArtRaw).toBe(evidence.current.globalProngs.vatArtRaw)
    expect(v.futureProngs.clipDueRaw).toBe('0')
    expect(v.futureProngs.chiRaw).toBe('1077504642576908381024682405')
    expect(v.futureProngs.burnRateRaw).toBe('1174543374832431459208093140')
    expect(v.scenario.globalUnusedFundsRaw[1]).toBe('37337634119074883020950658')
    expect(BigInt(v.futureProngs.chiRaw)).toBeGreaterThan(
      BigInt(evidence.current.globalProngs.chiNowRaw),
    )
    expect(BigInt(v.futureProngs.burnRateRaw)).toBeGreaterThan(
      BigInt(evidence.current.globalProngs.burnRateNowRaw),
    )
    expect(v.scenario.elapsedSeconds).toBe(1152)
    expect(Date.parse(v.scenario.targetAt) - Date.parse(evidence.current.source.blockTime)).toBe(
      1152000,
    )
    for (const horizonHours of [1, 48, 168])
      expect(
        buildStusdsHistoricalHolderCapacityProjection({ ...f.input, horizonHours }, f.accept)!
          .scenario,
      ).toEqual(v.scenario)
  })
  it('reproduces ray rounding edge vectors and rejects intermediate arithmetic overflow', () => {
    expect(stusdsRayPow(String(RAY + 1n), 2)).toBe(String(RAY + 2n))
    expect(stusdsRayPow('0', 0)).toBe(String(RAY))
    expect(stusdsRayPow('0', 3)).toBe('0')
    expect(stusdsRayPow(String((1n << 256n) - 1n), 2)).toBeNull()
    expect(stusdsRayPow(['1'] as any, 1)).toBeNull()
    const f = fixture((1n << 256n) - 1n)
    expect(f.value).toBeNull()
  })
  it('uses protocol U before holder clipping and retains one-window censoring', () => {
    const f = fixture(100_000_000n * UNIT, 100_000_000n * UNIT),
      v = f.value!
    expect(v.scenario.capacityLowerRaw[1]).toBe(v.scenario.globalUnusedFundsRaw[1])
    expect(v.scenario.possibleSampledShortfalls[0]).toMatchObject({
      leftCensored: true,
      rightCensored: true,
      sampledSpanSeconds: 1152,
    })
    expect(v.scenario.definiteSampledShortfalls[0]).toMatchObject({
      leftCensored: true,
      rightCensored: true,
    })
    expect(v.continuousPathKnown).toBe(false)
    expect(v.forwardProbability).toBe(false)
    expect(v.executableMaximum).toBe(false)
  })
  it('rejects wrong entered owner/Q/source/units, malformed primitives and missing current authority', () => {
    const f = fixture()
    const mutations = [
      (x: any) => (x.binding.owner = '0x' + 'c'.repeat(40)),
      (x: any) => (x.binding.requestedRaw = '2'),
      (x: any) => (x.binding.currentSource.blockHash = '0x' + '0'.repeat(64)),
      (x: any) => (x.binding.assetDecimals = 6),
      (x: any) => (x.current.point.source.blockNumber = ['26141037']),
      (x: any) => (x.current.readAtUtc = [evidence.knowledgeCutoff]),
    ]
    for (const mutate of mutations) {
      const x = structuredClone(f.input)
      mutate(x)
      expect(buildStusdsHistoricalHolderCapacityProjection(x, f.accept)).toBeNull()
    }
    expect(buildStusdsHistoricalHolderCapacityProjection(f.input, () => false)).toBeNull()
  })
  it('rejects changed runtime/dependency rule, altered recorded indices and overflow before clipping', () => {
    const f = fixture()
    for (const change of [
      (x: any) => (x.current.point.runtimeIdentities.implementation.sha256 = '0'.repeat(64)),
      (x: any) => (x.current.point.addresses.vat = '0x' + 'c'.repeat(40)),
      (x: any) => (x.current.point.globalProngs.chiNowRaw = '1'),
      (x: any) => (x.current.point.globalProngs.burnRateNowRaw = '1'),
      (x: any) => (x.current.point.globalProngs.totalSupplyRaw = String((1n << 256n) - 1n)),
    ]) {
      const x = structuredClone(f.input)
      change(x)
      expect(
        buildStusdsHistoricalHolderCapacityProjection(
          x,
          (v) => JSON.stringify(v) === JSON.stringify(x.current),
        ),
      ).toBeNull()
    }
  })
  it('rejects resealed or modified history rather than using historical holder deltas', () => {
    const f = fixture(),
      x = structuredClone(f.input) as any
    x.history.history.points[1].holderQuote.fullPositionEntitlementRaw = '1'
    expect(buildStusdsHistoricalHolderCapacityProjection(x, f.accept)).toBeNull()
  })
  it('retains issued clock, filters exact target boundary, and expires at source+30min', () => {
    const f = fixture(),
      target = Date.parse(f.value!.scenario.targetAt),
      expiry = Date.parse(evidence.current.source.blockTime) + 1800000
    const selected = (ms: number) =>
      selectedStusdsHistoricalHolderCapacityProjection(
        f.value,
        { ...f.input, asOfMs: ms, binding: { ...f.input.binding, asOfMs: ms } },
        f.accept,
      )
    expect(selected(target - 1)!.view.futureScenario).not.toBeNull()
    expect(selected(target)!.view.futureScenario).toBeNull()
    expect(selected(target)!.projection.request.asOf).toBe(evidence.knowledgeCutoff)
    expect(selected(expiry)).not.toBeNull()
    expect(selected(expiry + 1)).toBeNull()
  })
  it('strict selector rebuild rejects changed summaries, source, assumptions and censoring', () => {
    const f = fixture()
    for (const mutate of [
      (x: any) => (x.scope = 'cash_proxy'),
      (x: any) => (x.holderExecutableExit = true),
      (x: any) => (x.scenario.headroomLowerRaw[1] = '1'),
      (x: any) => (x.scenario.targetAt = '2026-10-08T00:00:00.000Z'),
      (x: any) => (x.assumption = 'unchanged'),
      (x: any) => (x.scenario.possibleSampledShortfalls = [{ leftCensored: false }]),
    ]) {
      const v = structuredClone(f.value)
      mutate(v)
      expect(selectedStusdsHistoricalHolderCapacityProjection(v, f.input, f.accept)).toBeNull()
    }
  })
  it('builder freezes approved original global point despite callback mutation of caller supply', () => {
    const f = fixture(),
      approved = structuredClone(f.current),
      baseline = structuredClone(f.value)
    const value = buildStusdsHistoricalHolderCapacityProjection(f.input, (given) => {
      expect(given).toEqual(approved)
      f.input.current.point.globalProngs.totalSupplyRaw = String(
        BigInt(f.input.current.point.globalProngs.totalSupplyRaw) * 2n,
      )
      return true
    })
    expect(value).toEqual(baseline)
    expect(value!.scenario.globalUnusedFundsRaw).toEqual(baseline!.scenario.globalUnusedFundsRaw)
    expect(value!.input.current.point).toEqual(approved.point)
  })
  it('builder preserves separately bound source/owner/Q when verifier mutates external input', () => {
    for (const mutate of [
      (x: any) => (x.binding.owner = '0x' + 'c'.repeat(40)),
      (x: any) => (x.binding.requestedRaw = '2'),
      (x: any) => (x.binding.currentSource.blockHash = '0x' + '0'.repeat(64)),
      (x: any) => (x.current.point.source.blockTime = '2026-10-08T00:00:00.000Z'),
    ]) {
      const f = fixture(),
        baseline = structuredClone(f.value),
        approved = structuredClone(f.current)
      const value = buildStusdsHistoricalHolderCapacityProjection(f.input, (given) => {
        expect(given).toEqual(approved)
        mutate(f.input)
        return true
      })
      expect(value).toEqual(baseline)
    }
  })
  it('selector snapshots payload and expected question before either verification callback', () => {
    const f = fixture(),
      expected = structuredClone(f.input),
      payload = structuredClone(f.value),
      approved = structuredClone(f.current)
    const baseline = selectedStusdsHistoricalHolderCapacityProjection(payload, expected, f.accept)
    let calls = 0
    const selected = selectedStusdsHistoricalHolderCapacityProjection(
      payload,
      expected,
      (given) => {
        expect(given).toEqual(approved)
        calls++
        expected.current.point.globalProngs.totalSupplyRaw = String(
          BigInt(expected.current.point.globalProngs.totalSupplyRaw) * 2n,
        )
        expected.binding.owner = '0x' + 'c'.repeat(40)
        expected.binding.requestedRaw = '2'
        payload!.scenario.headroomLowerRaw[1] = '1'
        return true
      },
    )
    expect(calls).toBe(2)
    expect(selected).toEqual(baseline)
  })
})
