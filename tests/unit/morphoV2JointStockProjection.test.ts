import { describe, expect, it } from 'vitest'
import {
  buildMorphoV2JointStockProjection,
  type MorphoV2JointStockFrame,
  type MorphoV2JointStockProjectionInput,
} from '@/lib/carry/morphoV2JointStockProjection'
import { morphoV2AdapterCapacityMath } from '@/lib/carry/morphoV2AdapterCapacityMath'

const MAX = String((1n << 256n) - 1n)
const HOUR = 3600000
function frame(hours: number): MorphoV2JointStockFrame {
  const at = Date.parse('2026-10-01T00:00:00.000Z') + hours * HOUR
  return {
    source: {
      chainId: 1,
      blockNumber: String(hours + 1),
      blockHash: '0x' + String(hours + 1).padStart(64, '0'),
      blockTime: new Date(at).toISOString(),
    },
    regime: {
      profile: 'configured-adapter',
      runtimeCodeIdentity: 'code-v1',
      configurationIdentity: 'config-v1',
      feePolicyIdentity: 'fee-v1',
      enrolled: true,
      asset: '0x' + 'a'.repeat(40),
      assetDecimals: 6,
      shareDecimals: 18,
    },
    prongs: {
      market: ['10000000', '10000000000000', '4000000', '4000000000000', String(at / 1000), '0'],
      borrowRateRaw: '0',
      internalSharesRaw: '5000000000000',
      actualSharesRaw: '5000000000000',
      allocationsRaw: ['5000000', '5000000', '5000000'],
      idleCashRaw: '0',
      blueCashRaw: '6000000',
      allowanceRaw: MAX,
    },
    fixedShareEntitlement: {
      method: 'native_preview_redeem_fixed_shares',
      sharesRaw: '1000000000000000000',
      assetsRaw: '8000000',
    },
  }
}
function input(): MorphoV2JointStockProjectionInput {
  return {
    current: frame(3),
    donors: [{ id: 'hourly-flow', start: frame(0), end: frame(1) }],
    fixedSharesRaw: '1000000000000000000',
    requestedRaw: '1000000',
    horizonMs: HOUR,
    marketMaximumRaw: null,
  }
}
function result(v = input()) {
  const r = buildMorphoV2JointStockProjection(v)
  if (!r) throw Error('expected valid pure projection')
  return r
}
function usable(v = input()) {
  const s = result(v).scenarios[0]
  if (s.status !== 'usable') throw Error(s.censorReason)
  return s
}

describe('pure Morpho V2 joint NET stock projection', () => {
  it('accepts market liquidity flow and recomputes capacity rather than freezing market state', () => {
    const v = input(),
      end = v.donors[0].end
    end.prongs.market = [
      '10000000',
      '10000000000000',
      '6000000',
      '6000000000000',
      end.prongs.market[4],
      '0',
    ]
    end.fixedShareEntitlement.assetsRaw = '7000000'
    const s = usable(v)
    expect(s.signedDeltaByChannel.borrowAssets).toBe('2000000')
    expect(s.projectedStocks.borrowShares).toBe('6000000000000')
    expect(s.measurement).toEqual({
      protocolCapacityRaw: '4000000',
      fullEaRaw: '7000000',
      availableRaw: '4000000',
      headroomRaw: '3000000',
    })
  })
  it('accepts joint internal/actual shares and allocation ledger changes', () => {
    const v = input(),
      end = v.donors[0].end
    end.prongs.internalSharesRaw = '4000000000000'
    end.prongs.actualSharesRaw = '4500000000000'
    end.prongs.allocationsRaw = ['4000000', '4000000', '4000000']
    const s = usable(v)
    expect(s.projectedStocks.internalShares).toBe('4000000000000')
    expect(s.projectedStocks.actualShares).toBe('4500000000000')
    expect(s.projectedStocks.allocation2).toBe('4000000')
    expect(s.measurement.protocolCapacityRaw).toBe('4000000')
  })
  it('holds fixed S quotes independent of Q, applies min(Ea,C), then subtracts original Q once', () => {
    const v = input()
    v.current.fixedShareEntitlement.assetsRaw = '2000000'
    v.donors[0].end.fixedShareEntitlement.assetsRaw = '7500000'
    const before = usable(v)
    expect(before.measurement.fullEaRaw).toBe('1500000')
    expect(before.measurement.availableRaw).toBe('1500000')
    expect(before.measurement.headroomRaw).toBe('500000')
    v.requestedRaw = '250000'
    const after = usable(v)
    expect(after.projectedStocks).toEqual(before.projectedStocks)
    expect(after.measurement.fullEaRaw).toBe(before.measurement.fullEaRaw)
    expect(after.measurement.headroomRaw).toBe('1250000')
    v.donors[0].end.fixedShareEntitlement.sharesRaw = '1'
    expect(result(v).excludedDonors[0].reason).toBe('fixed_share_quote_mismatch')
  })
  it('projects simultaneous idle/Blue NET changes once, without treating global cash as gross outflow', () => {
    const v = input()
    v.donors[0].end.prongs.idleCashRaw = '1000000'
    v.donors[0].end.prongs.blueCashRaw = '3000000'
    const s = usable(v)
    expect(s.projectedStocks.idleCash).toBe('1000000')
    expect(s.projectedStocks.globalBlueCash).toBe('3000000')
    expect(s.measurement.protocolCapacityRaw).toBe('4000000')
    expect(s.measurement.headroomRaw).toBe('3000000')
  })
  it('normalizes native interest and fee exactly once per endpoint and adds no synthetic accrual', () => {
    const v = input()
    const all = [v.current, v.donors[0].start, v.donors[0].end]
    for (const f of all) {
      const market = [...f.prongs.market]
      market[4] = String(Date.parse(f.source.blockTime) / 1000 - 60)
      market[5] = '100000000000000000'
      f.prongs.market = market
      f.prongs.borrowRateRaw = '100000000000000'
    }
    const accrue = (f: MorphoV2JointStockFrame) => {
      const g = f.prongs
      return morphoV2AdapterCapacityMath({
        market: g.market.map(BigInt),
        at: BigInt(Date.parse(f.source.blockTime) / 1000),
        borrowRate: BigInt(g.borrowRateRaw),
        internalShares: BigInt(g.internalSharesRaw),
        actualShares: BigInt(g.actualSharesRaw),
        allocations: g.allocationsRaw.map(BigInt),
        idleCash: 0n,
        blueCash: 6000000n,
        allowance: BigInt(MAX),
        enrolled: true,
      })
    }
    const native = accrue(v.current)
    expect(BigInt(native.interestRaw)).toBeGreaterThan(0n)
    expect(BigInt(native.feeSharesRaw)).toBeGreaterThan(0n)
    const r = result(v),
      s = usable(v)
    expect(r.sourceNormalizedStocks.supplyAssets).toBe(native.accruedSupplyAssetsRaw)
    expect(r.sourceNormalizedStocks.supplyShares).toBe(native.accruedSupplySharesRaw)
    expect(s.signedDeltaByChannel.supplyAssets).toBe('0')
    expect(s.signedDeltaByChannel.supplyShares).toBe('0')
    expect(s.measurement.protocolCapacityRaw).toBe(native.conditionalProtocolCapacityRaw)
    expect(r.persistenceBaseline.protocolCapacityRaw).toBe(native.conditionalProtocolCapacityRaw)
    const end = v.donors[0].end,
      market = [...end.prongs.market]
    market[4] = String(Date.parse(end.source.blockTime) / 1000 - 120)
    end.prongs.market = market
    const from = accrue(v.donors[0].start),
      to = accrue(end),
      changed = usable(v)
    expect(changed.signedDeltaByChannel.supplyAssets).toBe(
      String(BigInt(to.accruedSupplyAssetsRaw) - BigInt(from.accruedSupplyAssetsRaw)),
    )
    expect(changed.signedDeltaByChannel.supplyShares).toBe(
      String(BigInt(to.accruedSupplySharesRaw) - BigInt(from.accruedSupplySharesRaw)),
    )
  })
  it('censors negative stocks, uint128 overflow and incoherent share ordering instead of clamping', () => {
    const negative = input()
    negative.current.prongs.idleCashRaw = '1'
    negative.donors[0].start.prongs.idleCashRaw = '10'
    expect(result(negative).scenarios[0]).toMatchObject({
      status: 'censored',
      censorReason: 'projected_stock_out_of_range:idleCash',
    })
    const shares = input()
    shares.current.prongs.actualSharesRaw = '5500000000000'
    shares.donors[0].start.prongs.actualSharesRaw = '10000000000000'
    expect(result(shares).scenarios[0]).toMatchObject({
      status: 'censored',
      censorReason: 'internal_vs_actual_shares',
    })
    const overflow = input()
    overflow.current.prongs.market = [
      String((1n << 128n) - 1n),
      ...overflow.current.prongs.market.slice(1),
    ]
    overflow.donors[0].end.prongs.market = [
      '10000001',
      ...overflow.donors[0].end.prongs.market.slice(1),
    ]
    expect(result(overflow).scenarios[0]).toMatchObject({
      status: 'censored',
      censorReason: 'math_uint',
    })
    const allocations = input()
    allocations.current.prongs.allocationsRaw = ['1', '5000000', '5000000']
    allocations.donors[0].end.prongs.allocationsRaw = ['4999998', '5000000', '5000000']
    expect(result(allocations).scenarios[0]).toMatchObject({
      status: 'censored',
      censorReason: 'projected_stock_out_of_range:allocation0',
    })
  })
  it('excludes true code/configuration/fee/enrollment/unit regime changes and future leakage', () => {
    for (const field of [
      'runtimeCodeIdentity',
      'configurationIdentity',
      'feePolicyIdentity',
      'profile',
    ] as const) {
      const v = input()
      v.donors[0].end.regime[field] = 'different'
      expect(result(v).excludedDonors[0].reason).toContain('regime_changed')
    }
    const units = input()
    units.donors[0].end.regime.assetDecimals = 18
    expect(result(units).excludedDonors[0].reason).toContain('regime_changed')
    const enrollment = input()
    enrollment.donors[0].end.regime.enrolled = false
    expect(result(enrollment).excludedDonors[0].reason).toContain('regime_changed')
    const future = input()
    future.donors[0].end.source = { ...future.current.source }
    expect(result(future).excludedDonors[0].reason).toBe('donor_time_or_block_leakage')
    const fee = input()
    fee.donors[0].end.prongs.market = [...fee.donors[0].end.prongs.market.slice(0, 5), '1']
    expect(result(fee).excludedDonors[0].reason).toContain('regime_changed')
  })
  it('preserves unknown M and cloned source snapshots while exposing no evidence authority', () => {
    const v = input(),
      r = result(v),
      original = structuredClone(v)
    expect(v).toEqual(original)
    v.current.prongs.idleCashRaw = '999'
    expect(r.sourceSnapshot.prongs.idleCashRaw).toBe('0')
    expect(r.marketMaximumRaw).toBeNull()
    expect(r.queuedCompetingMRaw).toBeNull()
    expect(Object.values(r.claims).every((claim) => claim === false)).toBe(true)
    expect(r.persistenceBaseline).toEqual({
      protocolCapacityRaw: '5000000',
      fullEaRaw: '8000000',
      availableRaw: '5000000',
      headroomRaw: '4000000',
    })
    v.marketMaximumRaw = '1'
    expect(result(v).persistenceBaseline.fullEaRaw).toBe('8000000')
    expect(result(v).marketMaximumRaw).toBe('1')
    expect(result(v).queuedCompetingMRaw).toBeNull()
    v.queuedCompetingMRaw = '999999999'
    const known = result(v)
    expect(known.queuedCompetingMRaw).toBe('999999999')
    expect(known.marketMaximumRaw).toBe('1')
    expect(known.persistenceBaseline).toEqual(
      result({ ...v, queuedCompetingMRaw: null }).persistenceBaseline,
    )
  })
  it('computes exact descriptive mean/band only over usable scenarios, with no probability claim', () => {
    const v = input()
    v.donors = [v.donors[0], { id: 'odd-unit', start: frame(0), end: frame(1) }]
    v.donors[1].end.prongs.idleCashRaw = '1'
    const r = result(v)
    expect(r.descriptiveExpectedFlow.headline?.available?.empiricalMean).toEqual({
      numeratorRaw: '10000001',
      denominatorRaw: '2',
      floorRaw: '5000000',
    })
    expect(r.descriptiveExpectedFlow.headline?.available?.band.median).toEqual({
      numeratorRaw: '10000001',
      denominatorRaw: '2',
      floorRaw: '5000000',
    })
    expect(r.descriptiveExpectedFlow.headline?.headroom?.band).toMatchObject({
      minRaw: '4000000',
      maxRaw: '4000001',
    })
    v.current.prongs.idleCashRaw = '0'
    v.donors[1].start.prongs.idleCashRaw = '2'
    const partial = result(v)
    expect(partial.usableScenarioCount).toBe(1)
    expect(partial.descriptiveExpectedFlow.headline).toBeNull()
    expect(partial.descriptiveExpectedFlow.censoredScenarioCount).toBe(1)
    expect(
      partial.descriptiveExpectedFlow.usableOnlyDiagnostic.available?.empiricalMean.floorRaw,
    ).toBe('5000000')
  })
  it('reports protocol NET depletion even when full Ea masks active-capacity decline', () => {
    const v = input()
    v.donors[0].start.fixedShareEntitlement.assetsRaw = '1000000'
    v.donors[0].end.fixedShareEntitlement.assetsRaw = '1000000'
    v.donors[0].end.prongs.blueCashRaw = '3000000'
    const r = result(v)
    expect(r.maxObservedInclusiveNetDepletionRate).toMatchObject({
      amountRaw: '0',
      donorPeriodMs: HOUR,
      acceptedDonorCount: 1,
    })
    expect(r.maxObservedProtocolCapacityNetDepletionRate).toMatchObject({
      amountRaw: '2000000',
      donorPeriodMs: HOUR,
      acceptedDonorCount: 1,
      nativeUnit: 'native_asset_raw6',
    })
  })
  it('accepts any positive whole-second horizon up to seven days and scales signed deltas exactly', () => {
    for (const horizonMs of [1000, HOUR, 24 * HOUR, 48 * HOUR, 168 * HOUR]) {
      const v = input()
      v.horizonMs = horizonMs
      v.donors[0].end.prongs.idleCashRaw = '3600'
      expect(usable(v).projectedStocks.idleCash).toBe(String(horizonMs / 1000))
    }
    for (const horizonMs of [0, 999, 1001, 168 * HOUR + 1000]) {
      const v = input()
      v.horizonMs = horizonMs
      expect(buildMorphoV2JointStockProjection(v)).toBeNull()
    }
  })
  it('uses mathematical floor for negative and positive nondivisible NET shifts', () => {
    const v = input()
    v.donors = [{ id: 'two-hour-negative', start: frame(0), end: frame(2) }]
    v.donors[0].end.fixedShareEntitlement.assetsRaw = '7999999'
    v.current.fixedShareEntitlement.assetsRaw = '2000000'
    const negative = usable(v)
    expect(negative.signedDeltaByChannel.fullEa).toBe('-1')
    expect(negative.projectedStocks.fullEa).toBe('1999999')
    expect(negative.measurement.headroomRaw).toBe('999999')
    expect(result(v).assumptions.signedNativeUnitRounding).toBe('mathematical_floor')
    v.donors[0].end.fixedShareEntitlement.assetsRaw = '8000001'
    expect(usable(v).projectedStocks.fullEa).toBe('2000000')
    v.donors[0].end.fixedShareEntitlement.assetsRaw = '8000003'
    expect(usable(v).projectedStocks.fullEa).toBe('2000001')
    v.donors[0].end.fixedShareEntitlement.assetsRaw = '7999997'
    expect(usable(v).projectedStocks.fullEa).toBe('1999998')
  })
  it('reports only sampled insufficiency, with resolution and uncertainty between bounded checkpoints', () => {
    const v = input()
    v.includeSampledDuration = true
    v.current.prongs.idleCashRaw = '5000000'
    v.current.prongs.blueCashRaw = '0'
    v.requestedRaw = '3000000'
    v.donors[0].start.prongs.idleCashRaw = '4000000'
    const d = usable(v).sampledDuration
    expect(d?.firstSampledInsufficiencyMs).toBe(1856000)
    expect(d?.checkpoints.length).toBe(65)
    expect(d?.maxCheckpointGapMs).toBe(57000)
    expect(d?.trueFirstLossClaim).toBe(false)
    expect(d?.continuousProof).toBe(false)
    expect(d?.unknownBetweenCheckpoints).toBe(true)
  })
  it('rejects malformed source input and noncanonical units before producing a projection', () => {
    const invalid = input()
    invalid.current.prongs.internalSharesRaw = '99999999999999'
    expect(buildMorphoV2JointStockProjection(invalid)).toBeNull()
    const quote = input()
    quote.current.fixedShareEntitlement.assetsRaw = '01'
    expect(buildMorphoV2JointStockProjection(quote)).toBeNull()
    const canonical = input()
    canonical.current.source.blockTime = '2026-10-01T03:00:00Z'
    expect(buildMorphoV2JointStockProjection(canonical)).toBeNull()
  })
})

describe('issue-relative Morpho source age', () => {
  it('scales each NET stock once across source age plus nominal horizon, including milliseconds', () => {
    const v = input()
    v.donors[0].end.prongs.idleCashRaw = String(HOUR)
    v.sourceAgeMs = 60001
    v.includeSampledDuration = true
    const s = usable(v)
    expect(s.projectedStocks.idleCash).toBe(String(HOUR + 60001))
    expect(s.sampledDuration?.checkpoints[0]).toMatchObject({ elapsedMs: 0 })
    expect(s.sampledDuration?.checkpoints.at(-1)?.elapsedMs).toBe(HOUR)
    expect(result(v).sourceSnapshot.prongs.idleCashRaw).toBe('0')
    expect(result(v).persistenceBaseline).toEqual(
      result({ ...v, sourceAgeMs: 0 }).persistenceBaseline,
    )
    expect(result(v).queuedCompetingMRaw).toBeNull()
  })
  it('independently checks issue and target available/headroom with negative NET floor', () => {
    const v = input()
    for (const f of [v.current, v.donors[0].start, v.donors[0].end])
      f.prongs.idleCashRaw = '10000000'
    v.donors[0].end.fixedShareEntitlement.assetsRaw = '7000000'
    v.sourceAgeMs = 60001
    v.includeSampledDuration = true
    const s = usable(v)
    expect(s.sampledDuration?.checkpoints[0]).toEqual({
      elapsedMs: 0,
      availableRaw: '7983333',
      headroomRaw: '6983333',
    })
    expect(s.sampledDuration?.checkpoints.at(-1)).toEqual({
      elapsedMs: HOUR,
      availableRaw: '6983333',
      headroomRaw: '5983333',
    })
    expect(s.projectedStocks.fullEa).toBe('6983333')
    expect(s.measurement.fullEaRaw).toBe('6983333')
    expect(result(v).persistenceBaseline.fullEaRaw).toBe('8000000')
  })
  it('reports already-insufficient projected issue state as zero issue-relative duration', () => {
    const v = input()
    v.requestedRaw = '7990000'
    v.donors[0].end.fixedShareEntitlement.assetsRaw = '7000000'
    // Lift protocol funding above Ea so this control exercises the full-S prong.
    for (const f of [v.current, v.donors[0].start, v.donors[0].end])
      f.prongs.idleCashRaw = '10000000'
    v.includeSampledDuration = true
    expect(usable(v).sampledDuration?.firstSampledInsufficiencyMs).toBeGreaterThan(0)
    v.sourceAgeMs = 60001
    expect(usable(v).sampledDuration?.firstSampledInsufficiencyMs).toBe(0)
  })
  it('preserves explicit zero-age legacy results and rejects invalid or stale age', () => {
    const v = input()
    expect(result(v)).toEqual(result({ ...v, sourceAgeMs: 0 }))
    expect(result({ ...v, horizonMs: 168 * HOUR, sourceAgeMs: 1800000 }).projectionElapsedMs).toBe(
      168 * HOUR + 1800000,
    )
    for (const sourceAgeMs of [-1, 0.5, 1800001, NaN, Infinity, null])
      expect(
        buildMorphoV2JointStockProjection({
          ...v,
          sourceAgeMs,
        } as MorphoV2JointStockProjectionInput),
      ).toBeNull()
  })
})
