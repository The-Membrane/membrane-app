import { describe, expect, it } from 'vitest'
import {
  scoreFluidBridgeUsdcHistoricalFold as score,
  buildFluidBridgeUsdcHistoricalHolderBacktest as authenticateAndBuild,
  writeFluidBridgeUsdcHistoricalHolderBacktest as write,
  main,
  FLUID_USDC_BACKTEST_FOLDS,
  fluidBridgeUsdcHistoricalFoldDefinitions as joinedFolds,
} from '../../scripts/research/fluid-bridge-usdc-historical-holder-backtest.mts'
import {
  FLUID_BRIDGE_USDC,
  FLUID_BRIDGE_USDC_PRONGS,
  type FluidBridgeUsdcFrame,
} from '@/lib/carry/fluidBridgeUsdcJointHistoricalProcess'

const acquisition = '2026-10-08T12:00:00.000Z'
const reconstruction = '2026-10-08T12:01:00.000Z'
/** Fully synthetic same-S frame controls, never capture authentication or ownership evidence. */
function frame(n: number): FluidBridgeUsdcFrame {
  return {
    source: {
      chainId: 1,
      blockNumber: String(26000000 + n * 100),
      blockHash: '0x' + (n + 1).toString(16).repeat(64),
      blockTime: new Date(Date.UTC(2026, 8, 28, 23, 59, 59) + n * 86400000).toISOString(),
    },
    acquiredAtUtc: acquisition,
    availableAtUtc: acquisition,
    provenanceRef: 'synthetic_native_control_' + n,
    provenanceKind: 'native_hypothetical_shares',
    owner: null,
    historicalOwnership: false,
    holderSharesRaw: '967573479322309282',
    shareDecimals: 18,
    asset: FLUID_BRIDGE_USDC,
    assetDecimals: 6,
    fundingUnit: 'gross_native_USDC',
    entitlementUnit: 'net_native_USDC',
    runtimeCodeHashes: { [FLUID_BRIDGE_USDC]: '0x' + 'a'.repeat(64) },
    regime: 'synthetic_runtime_fee5_unpaused',
    paused: false,
    withdrawalFeeBps: 5,
    fullHolderNetUsdcRaw: String(1000000 + n * 1000),
    nativeProngs: Object.fromEntries(
      FLUID_BRIDGE_USDC_PRONGS.map((k) => [k, '2000000']),
    ) as FluidBridgeUsdcFrame['nativeProngs'],
  }
}
function input() {
  return {
    id: 'synthetic_daily_fold',
    training: [frame(0), frame(1)],
    baseline: frame(2),
    outcome: frame(3),
    reconstructedAtUtc: reconstruction,
  }
}
describe('retrospective USDC bridge same-S fold controls', () => {
  it('joins ten synthetic native frames into seven causal folds and 28 correlated Q scenarios', () => {
    const frames = Array.from({ length: 10 }, (_, n) => frame(n))
    frames.forEach((f, n) => {
      f.provenanceRef =
        'synthetic_capture_' + (n < 4 ? 'older' : n < 8 ? 'additional' : 'retained') + ':' + n
      if (n >= 4) f.acquiredAtUtc = f.availableAtUtc = '2026-10-08T12:00:30.000Z'
    })
    const original = structuredClone(frames)
    const definitions = joinedFolds(frames, reconstruction)
    expect(definitions).toHaveLength(7)
    expect(definitions.map((f) => f.training.length - 1)).toEqual([1, 2, 3, 4, 5, 6, 7])
    const results = definitions.map((f) =>
      score({
        id: f.id,
        training: f.training.map((n) => frames[n]),
        baseline: frames[f.baseline],
        outcome: frames[f.outcome],
        reconstructedAtUtc: reconstruction,
      }),
    )
    expect(results.reduce((n, f) => n + f.correlatedQScenarioCount, 0)).toBe(28)
    expect(
      definitions.every((f) => f.training.every((n) => n < f.baseline && n !== f.outcome)),
    ).toBe(true)
    expect(
      definitions.every(
        (f) =>
          f.id.includes(frames[f.baseline].source.blockTime) &&
          f.id.includes(frames[f.outcome].source.blockTime),
      ),
    ).toBe(true)
    expect(frames).toEqual(original)
    const six = joinedFolds(frames.slice(0, 6), reconstruction)
    expect(six).toHaveLength(3)
    expect(
      six.every(
        (f) =>
          f.training.every((n) => n < f.baseline) &&
          f.id.includes(frames[f.baseline].source.blockTime) &&
          f.id.includes(frames[f.outcome].source.blockTime),
      ),
    ).toBe(true)
  })
  it('labels nondefault six-frame source dates without legacy Sep30/Oct1 names', () => {
    const frames = Array.from({ length: 6 }, (_, n) => frame(n))
    frames.forEach((f) => {
      f.source.blockTime = new Date(Date.parse(f.source.blockTime) - 4 * 86400000).toISOString()
    })
    const definitions = joinedFolds(frames, reconstruction)
    expect(definitions).toHaveLength(3)
    expect(definitions[0].id).toBe('native_2026-09-26T23:59:59.000Z_to_2026-09-27T23:59:59.000Z')
    expect(
      definitions.every((f) => f.training.every((n) => n < f.baseline && n !== f.outcome)),
    ).toBe(true)
    expect(definitions.map((f) => f.id)).not.toEqual(FLUID_USDC_BACKTEST_FOLDS.map((f) => f.id))
  })
  it.each([
    'duplicate',
    'conflicting_header',
    'reversed',
    'changed_S',
    'changed_fee',
    'changed_runtime',
    'changed_units',
    'future_acquisition',
    'sparse',
  ])('rejects combined synthetic frame %s before scoring', (fault) => {
    const frames = Array.from({ length: 10 }, (_, n) => frame(n))
    if (fault === 'duplicate') frames[4] = structuredClone(frames[3])
    if (fault === 'conflicting_header') frames[4].source.blockHash = frames[3].source.blockHash
    if (fault === 'reversed') [frames[3], frames[4]] = [frames[4], frames[3]]
    if (fault === 'changed_S') frames[4].holderSharesRaw = '1'
    if (fault === 'changed_fee') frames[4].withdrawalFeeBps = 6
    if (fault === 'changed_runtime')
      frames[4].runtimeCodeHashes[FLUID_BRIDGE_USDC] = '0x' + 'b'.repeat(64)
    if (fault === 'changed_units') (frames[4] as any).fundingUnit = 'USDT'
    if (fault === 'future_acquisition')
      frames[4].acquiredAtUtc = frames[4].availableAtUtc = '2026-10-08T12:02:00.000Z'
    if (fault === 'sparse') delete frames[4]
    expect(() => joinedFolds(frames, reconstruction)).toThrow(/joined_/)
  })
  it('rejects malformed additional capture/options before reading primary evidence', () => {
    for (const options of [
      { additionalCapture: null },
      { additionalCapture: { receipt: {} } },
      { additionalCapture: { receipt: {}, captureText: '', extra: true } },
      { additionalCapture: { receipt: {}, captureText: 'x'.repeat(8 * 1024 * 1024 + 1) } },
      { extra: true },
      Object.create({ additionalCapture: {} }),
    ]) {
      expect(() => authenticateAndBuild({}, reconstruction, options as any)).toThrow(
        /additional_capture_shape|options_shape/,
      )
    }
    expect(() =>
      authenticateAndBuild({}, reconstruction, {
        additionalCapture: { receipt: {}, captureText: '{}' },
      }),
    ).toThrow(/capture_transport_invalid/)
  })
  it('uses strictly earlier training frames and labels four correlated Q scenarios separately', () => {
    const f = score(input())
    expect(f.donorIntervalCount).toBe(1)
    expect(f.correlatedQScenarioCount).toBe(4)
    expect(f.trainingGapsSeconds).toEqual([86400])
    expect(f.headerCutoffUtc).toBe(input().baseline.source.blockTime)
    expect(f.reconstructionMode).toBe('retrospective_replay')
    expect(
      f.cases.every((c) => c.questionKind === 'hypothetical_research_size_not_original_user_Q'),
    ).toBe(true)
    expect(f.cases.every((c) => c.MRaw === null)).toBe(true)
    expect(f.betweenNativeOutcomeEndpointsKnown).toBe(false)
  })
  it('projects six channels, scores actual target after clipping, and deducts exact Q once', () => {
    const f = score(input())
    for (const c of f.cases) {
      expect(c.actual?.availableRaw).toBe('1003000')
      expect(c.predicted?.availableMeanRaw).toBe('1003000')
      expect(BigInt(c.actual!.headroomRaw)).toBe(1003000n - BigInt(c.requestedRaw))
      expect(BigInt(c.predicted!.headroomMeanRaw)).toBe(1003000n - BigInt(c.requestedRaw))
      expect(c.forecastMinusObservedRaw).toBe('0')
      expect(c.headroomForecastMinusObservedRaw).toBe('0')
      expect(c.persistenceMinusObservedRaw).toBe('-1000')
      expect(c.sampledScenarios[0].jointNetDeltaRaw.fullEa).toBe('1000')
    }
    expect(f.cases.map((c) => c.requestedRaw)).toEqual(['901800', '991980', '1002000', '1002001'])
    expect(f.cases[3].observedEndpointBrackets.recovery).toEqual({
      after: input().baseline.source.blockTime,
      by: input().outcome.source.blockTime,
    })
    expect(f.cases[3].observedEndpointBrackets.interveningAvailabilityKnown).toBe(false)
  })
  it('uses a weak target native funding prong and applies fee once before net Ea', () => {
    const i = input()
    i.outcome.nativeProngs.bankCash = '10001'
    const f = score(i),
      c = f.cases[0]
    expect(c.actual?.fundingNetRaw).toBe('9995')
    expect(c.actual?.availableRaw).toBe('9995')
    expect(c.actual?.headroomRaw).toBe(String(9995n - BigInt(c.requestedRaw)))
    expect(c.forecastMinusObservedRaw).toBe('993005')
    expect(c.observedEndpointBrackets.loss).toEqual({
      after: i.baseline.source.blockTime,
      by: i.outcome.source.blockTime,
    })
  })
  it('does not allow outcome values to influence donor deltas or predictions', () => {
    const a = input(),
      b = structuredClone(a)
    b.outcome.fullHolderNetUsdcRaw = '100000'
    const first = score(a),
      changed = score(b)
    expect(changed.cases.map((c) => c.predicted)).toEqual(first.cases.map((c) => c.predicted))
    expect(changed.cases[0].forecastMinusObservedRaw).toBe('903000')
    expect(changed.cases[0].actual?.fullEaRaw).toBe('100000')
  })
  it('reports worsening native funding separately when full-Ea prediction remains accurate', () => {
    const i = input()
    i.outcome.nativeProngs.bankCash = '1500000'
    for (const c of score(i).cases) {
      expect(c.forecastMinusObservedRaw).toBe('0')
      expect(c.predicted?.availableMeanRaw).toBe('1003000')
      expect(c.predicted?.fundingNetMeanRaw).toBe('1999000')
      expect(c.predicted?.fundingNetMeanExact).toEqual({
        numeratorRaw: '1999000',
        denominator: '1',
        floorRaw: '1999000',
      })
      expect(c.predicted?.fundingNetRange).toEqual({ minRaw: '1999000', maxRaw: '1999000' })
      expect(c.actual?.fundingNetRaw).toBe('1499250')
      expect(c.fundingForecastMinusObservedRaw).toBe('499750')
      expect(c.fundingPersistenceMinusObservedRaw).toBe('499750')
      expect(c.bindingScope).toBe('full_entitlement')
    }
  })
  it('labels mixed source/projected/actual binders and ties without implying funding accuracy', () => {
    const i = input()
    i.outcome.nativeProngs.bankCash = '10001'
    expect(score(i).cases.every((c) => c.bindingScope === 'mixed')).toBe(true)
    const tie = input()
    for (const f of [...tie.training, tie.baseline, tie.outcome]) {
      f.fullHolderNetUsdcRaw = '19990'
      f.nativeProngs.bankCash = '20000'
    }
    expect(score(tie).cases.every((c) => c.bindingScope === 'mixed')).toBe(true)
  })
  it('labels native funding when every measurement binds below full Ea', () => {
    const i = input()
    for (const f of [...i.training, i.baseline, i.outcome]) f.nativeProngs.bankCash = '10001'
    expect(
      score(i).cases.every(
        (c) =>
          c.bindingScope === 'native_funding' &&
          c.fundingForecastMinusObservedRaw === '0' &&
          c.predicted?.fundingNetMeanRaw === '9995',
      ),
    ).toBe(true)
  })
  it('keeps an exact funding mean and descriptive range across distinct donors', () => {
    const i = {
      ...input(),
      training: [frame(0), frame(1), frame(2)],
      baseline: frame(3),
      outcome: frame(4),
    }
    i.training[1].nativeProngs.bankCash = '1800000'
    const c = score(i).cases[0]
    expect(c.predicted?.fundingNetMeanExact).toEqual({
      numeratorRaw: '3798100',
      denominator: '2',
      floorRaw: '1899050',
    })
    expect(c.predicted?.fundingNetRange).toEqual({ minRaw: '1799100', maxRaw: '1999000' })
    expect(c.forecastMinusObservedRaw).toBe('0')
    expect(c.fundingForecastMinusObservedRaw).toBe('-99950')
    expect(c.fundingPersistenceMinusObservedRaw).toBe('0')
  })
  it('suppresses funding aggregates and errors for censored projected arithmetic', () => {
    const i = input()
    i.training[1].nativeProngs.bankCash = ((1n << 256n) - 1n).toString()
    const f = score(i)
    expect(
      f.cases.every(
        (c) =>
          c.counts.censored === 1 &&
          c.predicted === null &&
          c.fundingForecastMinusObservedRaw === null &&
          c.fundingPersistenceMinusObservedRaw === null,
      ),
    ).toBe(true)
  })
  it.each(['baseline_endpoint', 'outcome_endpoint', 'duplicate', 'future_acquisition'])(
    'rejects %s training/reconstruction leakage',
    (fault) => {
      const i = input()
      if (fault === 'baseline_endpoint') i.training.push(structuredClone(i.baseline))
      if (fault === 'outcome_endpoint') i.training.push(structuredClone(i.outcome))
      if (fault === 'duplicate') i.training[1] = structuredClone(i.training[0])
      if (fault === 'future_acquisition') i.training[0].acquiredAtUtc = '2026-10-09T12:00:00.000Z'
      expect(() => score(i)).toThrow()
    },
  )
  it.each(['S', 'runtime', 'fee', 'regime'])(
    'excludes changed %s donors and suppresses complete prediction',
    (fault) => {
      const i = input()
      if (fault === 'S') i.training[0].holderSharesRaw = '1'
      if (fault === 'runtime')
        i.training[0].runtimeCodeHashes[FLUID_BRIDGE_USDC] = '0x' + 'b'.repeat(64)
      if (fault === 'fee') i.training[0].withdrawalFeeBps = 6
      if (fault === 'regime') i.training[0].regime = 'changed'
      const f = score(i)
      expect(f.complete).toBe(false)
      expect(
        f.cases.every(
          (c) =>
            c.counts.excluded === 1 && c.predicted === null && c.forecastMinusObservedRaw === null,
        ),
      ).toBe(true)
      expect(
        f.cases.every(
          (c) =>
            c.fundingForecastMinusObservedRaw === null &&
            c.fundingPersistenceMinusObservedRaw === null,
        ),
      ).toBe(true)
    },
  )
  it('rejects training native-unit rebinding and a backdated acquisition clock', () => {
    const i = input()
    ;(i.training[0] as any).entitlementUnit = 'gross_native_USDC'
    expect(() => score(i)).toThrow()
    const j = input()
    j.training[0].availableAtUtc = j.training[0].source.blockTime
    expect(() => score(j)).toThrow(/reconstruction_clock/)
  })
  it.each(['S', 'unit', 'runtime', 'fee'])(
    'excludes changed %s target from same-S outcome scoring',
    (fault) => {
      const i = input()
      if (fault === 'S') i.outcome.holderSharesRaw = '1'
      if (fault === 'unit') (i.outcome as any).fundingUnit = 'other_unit'
      if (fault === 'runtime')
        i.outcome.runtimeCodeHashes[FLUID_BRIDGE_USDC] = '0x' + 'b'.repeat(64)
      if (fault === 'fee') i.outcome.withdrawalFeeBps = 6
      const f = score(i)
      expect(f.complete).toBe(false)
      expect(
        f.cases.every(
          (c) =>
            c.actual === null &&
            c.forecastMinusObservedRaw === null &&
            c.persistenceMinusObservedRaw === null &&
            c.outcomeExclusion !== null,
        ),
      ).toBe(true)
    },
  )
  it('labels the three fixed chronological folds without counting correlated Qs as independent samples', () => {
    expect(
      FLUID_USDC_BACKTEST_FOLDS.map((f) => [f.training.length - 1, f.baseline, f.outcome]),
    ).toEqual([
      [1, 2, 3],
      [2, 3, 4],
      [3, 4, 5],
    ])
    expect(
      FLUID_USDC_BACKTEST_FOLDS.every((f) =>
        f.training.every((n) => n < f.baseline && n !== f.outcome),
      ),
    ).toBe(true)
  })
  it('rejects forged capture transport and unissued reports without launching network', () => {
    // A nonexistent root proves malformed transport rejects before local native authentication.
    expect(() =>
      authenticateAndBuild({ schema: 'forged' }, reconstruction, {
        root: '/private/tmp/absent-fluid-backtest-input-root',
      }),
    ).toThrow('fluid_usdc_backtest_capture_transport_invalid')
    expect(() =>
      write('/private/tmp/never-issued-fluid-backtest.json', { sha256: 'a'.repeat(64) } as any),
    ).toThrow(/private_report/)
  })
  it.each(['chain', 'hash', 'block', 'uint', 'nonsecond_header'])(
    'rejects malformed native %s outcome facts',
    (fault) => {
      const i = input()
      if (fault === 'chain') (i.outcome.source as any).chainId = 2
      if (fault === 'hash') i.outcome.source.blockHash = '0x1234'
      if (fault === 'block') i.outcome.source.blockNumber = '01'
      if (fault === 'uint') i.outcome.fullHolderNetUsdcRaw = (1n << 256n).toString()
      if (fault === 'nonsecond_header')
        i.outcome.source.blockTime = new Date(
          Date.parse(i.outcome.source.blockTime) + 1,
        ).toISOString()
      expect(() => score(i)).toThrow(/native_frame_facts/)
    },
  )
  it('accepts only the exact bounded CLI argument form', () => {
    for (const args of [
      [],
      ['--capture', 'x'],
      ['--output', 'x', '--capture', 'y'],
      ['--capture', 'x', '--output', 'y', '--extra'],
      ['--capture', 'x', '--output', 'y', '--additional-capture', 'z'],
      ['--additional-capture', 'x', '--capture', 'y', '--output', 'z'],
      ['--capture', 'x', '--additional-capture', 'y', '--output', 'z', '--extra'],
      Object.assign(['--capture', 'x', '--output', 'y'], { extra: true }),
      Object.assign(new Array(4), { 0: '--capture', 1: 'x', 2: '--output' }),
    ])
      expect(() => main(args)).toThrow(/cli_arguments/)
  })
})
