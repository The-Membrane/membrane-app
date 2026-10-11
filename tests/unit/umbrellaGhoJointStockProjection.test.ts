import { describe, expect, it } from 'vitest'
import {
  buildUmbrellaGhoJointStockProjection,
  type UmbrellaGhoJointStockProjectionInput,
} from '@/lib/carry/umbrellaGhoJointStockProjection'
import type { UmbrellaGhoNativeCapacityFact } from '@/lib/carry/umbrellaGhoNativeCapacity'
import {
  UMBRELLA_GHO_ROUTE,
  UMBRELLA_STKGHO,
  ORIGINAL_GHO,
  VERIFIED_STKGHO_IMPLEMENTATION,
} from '@/lib/carry/umbrellaGhoExit'

const T = Date.parse('2026-10-08T12:00:00.000Z'),
  DAY = 86400000
const hashes = {
  [UMBRELLA_STKGHO]: '0x5fa5d4889c27130d81c0afb814238692ca6b8774d690db729865fca3e3722a52',
  [VERIFIED_STKGHO_IMPLEMENTATION]:
    '0x553314ff37b47c42c33fc80c155f04cf1f0163967003f2a0bac7ccbb1dd22a21',
  [ORIGINAL_GHO]: '0xdd51428dd1ef13362e52bfc1689ed8e011730e6c6d5b50aaf96165ccd7bf0172',
}
const utc = (n: number) => new Date(n).toISOString()
function input(): UmbrellaGhoJointStockProjectionInput {
  // Unsigned mechanical facts, not original acquisition/ownership authority.
  const current: UmbrellaGhoNativeCapacityFact = {
    schema: 'umbrella_gho_native_capacity_v1',
    profileId: 'umbrella_stkgho_v1_native_2026_10_08',
    routeKey: UMBRELLA_GHO_ROUTE,
    destination: UMBRELLA_STKGHO,
    owner: '0x' + '1'.repeat(40),
    asset: ORIGINAL_GHO,
    assetDecimals: 18,
    shareDecimals: 18,
    source: {
      chainId: 1,
      blockNumber: 99,
      blockHash: '0x' + '9'.repeat(64),
      blockTime: utc(T),
      finalized: true,
    },
    readAtUtc: utc(T),
    fullSharesRaw: '100',
    fullEaRaw: '200',
    fullEaMethod: 'preview_redeem_full_position',
    cooldownSharesRaw: '40',
    cooldownSnapshotEaRaw: '80',
    cooldownEnd: T / 1000 - 60,
    withdrawalWindowSeconds: 86400,
    windowEndInclusive: T / 1000 - 60 + 86400,
    cooldownStartedAt: null,
    currentCooldownSeconds: 1728000,
    currentUnstakeWindowSeconds: 172800,
    maxRedeemSharesRaw: '40',
    totalAssetsGhoRaw: '10000',
    totalSupplySharesRaw: '5000',
    ghoCashRaw: '1000',
    maxSlashableAssetsRaw: '1',
    paused: false,
    state: 'window_open',
    MRaw: null,
    runtimeCodeHashes: { ...hashes },
    runtimeProfileQualified: true,
    qualification: 'runtime_profile_qualified',
    traces: [],
    originalAuthority: false,
    authenticated: false,
    executionAuthority: false,
    historicalOwnership: false,
    guaranteedDelivery: false,
  }
  return {
    current,
    issuedAtUtc: utc(T),
    horizonMs: 3600000,
    requestedRaw: '50',
    history: Array.from({ length: 8 }, (_, i) => ({
      cashIndex: 112 + i,
      source: {
        chainId: 1 as const,
        blockNumber: i + 1,
        blockHash: '0x' + String(i + 1).padStart(64, '0'),
        blockTime: utc(T - (8 - i) * DAY),
        finalized: true as const,
      },
      acquiredAtUtc: utc(T - 1000),
      sharesRaw: '100',
      cooldownCoveredSharesRaw: '40',
      cashRaw: '1000',
      fullEaRaw: '200',
      coveredEaRaw: '80',
      paused: false,
      cooldownSeconds: '1728000',
      unstakeWindowSeconds: '172800',
      runtimeCodeHashes: { ...hashes },
      owner: null,
      historicalOwnership: false as const,
      sourceClass: 'captured_identical_runtimes_only' as const,
    })),
  }
}
function model(v = input()) {
  const result = buildUmbrellaGhoJointStockProjection(v)
  if (!result) throw Error('expected valid mechanical model')
  return result
}
function usable(v = input(), n = 0) {
  const s = model(v).scenarios[n]
  if (s.status !== 'usable') throw Error(s.censorReason)
  return s
}
function setWindow(v: UmbrellaGhoJointStockProjectionInput, end: number, window: number) {
  v.current.cooldownEnd = end
  v.current.withdrawalWindowSeconds = window
  v.current.windowEndInclusive = end + window
  const at = Date.parse(v.current.source.blockTime) / 1000
  v.current.state = v.current.paused
    ? 'paused'
    : v.current.cooldownSharesRaw === '0' || end === 0
      ? 'cooldown_not_started'
      : at < end
        ? 'waiting'
        : at <= end + window
          ? 'window_open'
          : 'window_expired'
  v.current.maxRedeemSharesRaw =
    !v.current.paused && BigInt(v.current.cooldownSharesRaw) > 0n && at >= end && at <= end + window
      ? v.current.cooldownSharesRaw
      : '0'
}

describe('pure Umbrella full and covered native NET stock projection', () => {
  it('bounds a partial cooldown position separately from full Ea and shared cash', () => {
    const m = model(),
      s = usable()
    expect(s.measurement).toMatchObject({
      cashRaw: '1000',
      fullEaRaw: '200',
      coveredEaRaw: '80',
      availableRaw: '80',
      headroomRaw: '30',
      eligible: true,
    })
    expect(m.MRaw).toBeNull()
    expect(m.scenarios).toHaveLength(7)
    expect(m.independentHistoricalSeries).toBe(1)
    expect(m.flags).toEqual({
      originalAuthority: false,
      authenticated: false,
      historicalOwnership: false,
      executionAuthority: false,
      calibratedProbability: false,
      guaranteedDelivery: false,
      coverageCountPromotion: false,
    })
  })

  it('changes Q only after the same projected funding minimum', () => {
    const a = input(),
      b = input()
    b.requestedRaw = '90'
    const x = usable(a),
      y = usable(b)
    expect(y.projectedStocks).toEqual(x.projectedStocks)
    expect(y.signedDeltaByChannel).toEqual(x.signedDeltaByChannel)
    expect(y.measurement.availableRaw).toBe('80')
    expect(y.measurement.headroomRaw).toBe('-10')
    expect(model(b).sourceMeasurement.headroomRaw).toBe('-10')
  })

  it('counts nonzero source age once in issue zero and target without changing baseline', () => {
    const v = input()
    v.current.fullEaRaw = '200000'
    v.current.cooldownSnapshotEaRaw = '80000'
    v.history.forEach((p, i) => {
      p.cashRaw = String(1000 + i * 86400)
    })
    const zero = usable(v)
    expect(zero.measurement.cashRaw).toBe('4600')
    v.issuedAtUtc = utc(T + 600000)
    v.current.readAtUtc = utc(T + 500000)
    const m = model(v),
      s = usable(v)
    expect(m.sourceAgeMs).toBe(600000)
    expect(m.projectionElapsedMs).toBe(4200000)
    expect(m.sourceMeasurement.cashRaw).toBe('1000')
    expect(m.persistenceTarget?.cashRaw).toBe('1000')
    expect(s.sampledDuration?.checkpoints[0].cashRaw).toBe('1600')
    expect(s.measurement.cashRaw).toBe('5200')
  })

  it.each([
    [
      'stale issue',
      (v: UmbrellaGhoJointStockProjectionInput) => {
        v.issuedAtUtc = utc(T + 1800001)
      },
    ],
    [
      'future read',
      (v: UmbrellaGhoJointStockProjectionInput) => {
        v.current.readAtUtc = utc(T + 1)
      },
    ],
    [
      'read before source',
      (v: UmbrellaGhoJointStockProjectionInput) => {
        v.current.readAtUtc = utc(T - 1)
      },
    ],
    [
      'future source',
      (v: UmbrellaGhoJointStockProjectionInput) => {
        v.current.source.blockTime = utc(T + 1000)
      },
    ],
    [
      'future acquisition',
      (v: UmbrellaGhoJointStockProjectionInput) => {
        v.history[0].acquiredAtUtc = utc(T + 1)
      },
    ],
    [
      'historical source leakage',
      (v: UmbrellaGhoJointStockProjectionInput) => {
        v.history[7].source.blockTime = utc(T)
      },
    ],
  ])('rejects %s', (_, change) => {
    const v = input()
    change(v)
    expect(buildUmbrellaGhoJointStockProjection(v)).toBeNull()
  })

  it('accepts exactly 30 minutes of source age with honest read/issue clocks', () => {
    const v = input()
    v.issuedAtUtc = utc(T + 1800000)
    expect(model(v).sourceAgeMs).toBe(1800000)
  })

  it('keeps the final inclusive second open and closes at its first following millisecond', () => {
    const v = input()
    setWindow(v, T / 1000 - 1, 1)
    v.horizonMs = 999
    expect(usable(v).measurement.availableRaw).toBe('80')
    v.issuedAtUtc = utc(T + 999)
    v.current.readAtUtc = utc(T + 999)
    v.horizonMs = 1
    const s = usable(v)
    expect(s.sampledDuration?.checkpoints[0].availableRaw).toBe('80')
    expect(s.measurement.availableRaw).toBe('0')
    expect(s.sampledDuration?.knownWindowClosingMs).toBe(1)
    expect(s.sampledDuration?.firstSampledInsufficiencyMs).toBe(1)
    expect(s.sampledDuration?.sampledConditionsLastingMs).toBe(1)
    expect(model(v).window.closesExclusiveAtUtc).toBe(utc(T + 1000))
  })

  it('inserts waiting opening/expiry and reports recovery without conditions holding at issue', () => {
    const v = input()
    setWindow(v, T / 1000 + 60, 1)
    v.horizonMs = 62001
    const d = usable(v).sampledDuration!
    expect(d.checkpoints.find((p) => p.elapsedMs === 60000)?.availableRaw).toBe('80')
    expect(d.checkpoints.find((p) => p.elapsedMs === 62000)?.availableRaw).toBe('0')
    expect(d.firstSampledInsufficiencyMs).toBe(0)
    expect(d.firstSampledRecoveryMs).toBe(60000)
    expect(d.sampledConditionsLastingMs).toBeNull()
    expect(d.knownWindowOpeningMs).toBe(60000)
    expect(d.knownWindowClosingMs).toBe(62000)
    expect(d.continuousProof).toBe(false)
    v.horizonMs = 60000
    expect(usable(v).measurement.availableRaw).toBe('80')
  })

  it('models a native 20-day waiting cooldown beyond seven days with bounded checkpoints', () => {
    const v = input()
    setWindow(v, T / 1000 + (20 * DAY) / 1000, 48 * 3600)
    v.horizonMs = 20 * DAY + 3600000
    const m = model(v),
      s = usable(v),
      d = s.sampledDuration!
    expect(m.sourceMeasurement.availableRaw).toBe('0')
    expect(s.measurement.availableRaw).toBe('80')
    expect(d.firstSampledRecoveryMs).toBe(20 * DAY)
    expect(d.sampledConditionsLastingMs).toBeNull()
    expect(d.knownWindowOpeningMs).toBe(20 * DAY)
    expect(d.checkpoints.length).toBeLessThanOrEqual(67)
    expect(d.trueFirstLossClaim).toBe(false)
  })

  it('preserves a long window final inclusive millisecond and its exact first closed millisecond', () => {
    const v = input()
    setWindow(v, T / 1000 + (20 * DAY) / 1000, 48 * 3600)
    v.horizonMs = 22 * DAY + 999
    expect(usable(v).measurement.availableRaw).toBe('80')
    v.horizonMs = 22 * DAY + 1000
    const s = usable(v),
      d = s.sampledDuration!
    expect(s.measurement.availableRaw).toBe('0')
    expect(d.knownWindowClosingMs).toBe(22 * DAY + 1000)
    expect(d.checkpoints.find((p) => p.elapsedMs === 22 * DAY + 1000)?.availableRaw).toBe('0')
    expect(d.firstSampledRecoveryMs).toBe(20 * DAY)
    expect(d.sampledConditionsLastingMs).toBeNull()
    expect(d.checkpoints.length).toBeLessThanOrEqual(67)
  })

  it('accepts 720 hours and rejects its first excess millisecond', () => {
    const v = input()
    v.horizonMs = 30 * DAY
    expect(model(v).input.horizonMs).toBe(720 * 3600000)
    v.horizonMs++
    expect(buildUmbrellaGhoJointStockProjection(v)).toBeNull()
  })

  it('does not invent a new cooldown even over a 30-day horizon', () => {
    const v = input()
    v.current.cooldownSharesRaw = '0'
    v.current.cooldownSnapshotEaRaw = '0'
    v.history.forEach((p) => {
      p.cooldownCoveredSharesRaw = '0'
      p.coveredEaRaw = '0'
    })
    setWindow(v, 0, 0)
    v.horizonMs = 30 * DAY
    const m = model(v)
    expect(m.targetSummary).toBeNull()
    expect(m.window.initiationUnknown).toBe(true)
    expect(
      m.scenarios.every(
        (s) => s.status === 'censored' && s.censorReason === 'future_cooldown_initiation_unknown',
      ),
    ).toBe(true)
  })

  it('retains expired CS larger than S without inventing a reset or future available cash', () => {
    const v = input()
    v.current.cooldownSharesRaw = '140'
    v.current.cooldownSnapshotEaRaw = '280'
    v.history.forEach((p) => {
      p.cooldownCoveredSharesRaw = '140'
      p.coveredEaRaw = '280'
    })
    setWindow(v, T / 1000 - 100, 1)
    expect(model(v).sourceMeasurement.availableRaw).toBe('0')
    expect(usable(v).measurement.availableRaw).toBe('0')
    setWindow(v, T / 1000 + 60, 1)
    expect(buildUmbrellaGhoJointStockProjection(v)).toBeNull()
  })

  it('censors unknown future initiation, preserving current zero rather than inventing a cooldown', () => {
    const v = input()
    v.current.cooldownSharesRaw = '0'
    v.current.cooldownSnapshotEaRaw = '0'
    v.history.forEach((p) => {
      p.cooldownCoveredSharesRaw = '0'
      p.coveredEaRaw = '0'
    })
    setWindow(v, 0, 0)
    const m = model(v)
    expect(m.window).toEqual({
      opensAtUtc: null,
      closesExclusiveAtUtc: null,
      initiationUnknown: true,
    })
    expect(m.sourceMeasurement.availableRaw).toBe('0')
    expect(m.persistenceTarget).toBeNull()
    expect(m.targetSummary).toBeNull()
    expect(
      m.scenarios.every(
        (s) => s.status === 'censored' && s.censorReason === 'future_cooldown_initiation_unknown',
      ),
    ).toBe(true)
  })

  it('censors future unpause and never treats pause as a guaranteed future delivery path', () => {
    const v = input()
    v.current.paused = true
    v.current.maxSlashableAssetsRaw = '0'
    v.history.forEach((p) => {
      p.paused = true
    })
    setWindow(v, v.current.cooldownEnd, v.current.withdrawalWindowSeconds)
    const m = model(v)
    expect(m.sourceMeasurement.availableRaw).toBe('0')
    expect(
      m.scenarios.every(
        (s) => s.status === 'censored' && s.censorReason === 'source_paused_future_unpause_unknown',
      ),
    ).toBe(true)
    expect(m.targetSummary).toBeNull()
  })

  it('censors a negative future cash stock without clipping or hiding it from the headline', () => {
    const v = input()
    v.current.ghoCashRaw = '5'
    v.horizonMs = 6 * 3600000
    v.history[1].cashRaw = '976'
    const m = model(v)
    expect(m.scenarios[0]).toMatchObject({
      status: 'censored',
      censorReason: 'projected_stock_out_of_range:cashRaw',
    })
    expect(m.usableScenarioCount).toBe(6)
    expect(m.targetSummary).toBeNull()
    expect(m.usableOnlyDiagnostic.available).not.toBeNull()
  })

  it('uses mathematical floor for negative nonintegral NET changes', () => {
    const v = input()
    v.history[1].coveredEaRaw = '79'
    v.horizonMs = 1
    expect(usable(v).projectedStocks.coveredEaRaw).toBe('79')
  })

  it('changes the real empirical band when alternate native history changes', () => {
    const a = input(),
      b = input()
    b.history.forEach((p, i) => {
      p.coveredEaRaw = String(80 + i * 24)
    })
    expect(model(a).targetSummary?.available.band.minRaw).toBe('80')
    expect(model(b).targetSummary?.available.band.minRaw).toBe('81')
  })

  it('keeps the weakest projected native prong instead of averaging channels', () => {
    const v = input()
    v.current.ghoCashRaw = '60'
    v.history.forEach((p, i) => {
      p.cashRaw = String(1000 - i * 24)
      p.fullEaRaw = String(200 + i * 2400)
    })
    const s = usable(v)
    expect(s.measurement).toMatchObject({
      cashRaw: '59',
      fullEaRaw: '300',
      coveredEaRaw: '80',
      availableRaw: '59',
      headroomRaw: '9',
    })
  })

  it.each(['sharesRaw', 'cooldownCoveredSharesRaw'] as const)(
    'rejects re-scaled historical %s',
    (key) => {
      const v = input()
      v.history[0][key] = '101'
      expect(buildUmbrellaGhoJointStockProjection(v)).toBeNull()
    },
  )

  it('does not invent adjacency across missing, unsupported or changed-regime points', () => {
    const gap = input()
    gap.history = gap.history.filter((p) => p.cashIndex !== 115)
    expect(model(gap).excludedIntervals).toEqual([{ fromIndex: 2, reason: 'historical_gap' }])
    expect(model(gap).scenarios).toHaveLength(5)
    const unsupported = input()
    unsupported.history[3].cashRaw = null
    expect(model(unsupported).excludedIntervals).toEqual([
      { fromIndex: 2, reason: 'unsupported_native_channel' },
      { fromIndex: 3, reason: 'unsupported_native_channel' },
    ])
    const drift = input()
    drift.history[3].cooldownSeconds = '1'
    expect(model(drift).excludedIntervals).toEqual([
      { fromIndex: 2, reason: 'historical_regime_changed' },
      { fromIndex: 3, reason: 'historical_regime_changed' },
    ])
    expect(model(drift).targetSummary).toBeNull()
  })

  it.each([
    [
      'owner',
      (v: UmbrellaGhoJointStockProjectionInput) => {
        ;(v.history[0] as unknown as { owner: string }).owner = v.current.owner
      },
    ],
    [
      'asset',
      (v: UmbrellaGhoJointStockProjectionInput) => {
        ;(v.current as unknown as { asset: string }).asset = '0x' + '2'.repeat(40)
      },
    ],
    [
      'units',
      (v: UmbrellaGhoJointStockProjectionInput) => {
        ;(v.current as unknown as { assetDecimals: number }).assetDecimals = 6
      },
    ],
    [
      'runtime',
      (v: UmbrellaGhoJointStockProjectionInput) => {
        v.current.runtimeCodeHashes[ORIGINAL_GHO] = '0x' + '0'.repeat(64)
      },
    ],
    [
      'M',
      (v: UmbrellaGhoJointStockProjectionInput) => {
        ;(v.current as unknown as { MRaw: string }).MRaw = '1'
      },
    ],
    [
      'noncanonical Q',
      (v: UmbrellaGhoJointStockProjectionInput) => {
        v.requestedRaw = '050'
      },
    ],
    [
      'incorrect source maxRedeem',
      (v: UmbrellaGhoJointStockProjectionInput) => {
        v.current.maxRedeemSharesRaw = '100'
      },
    ],
  ])('rejects incompatible %s', (_, change) => {
    const v = input()
    change(v)
    expect(buildUmbrellaGhoJointStockProjection(v)).toBeNull()
  })

  it('snapshots aliases, rejects cycles/accessors without invocation, and freezes caller-isolated output', () => {
    const v = input()
    v.history.forEach((p) => {
      p.runtimeCodeHashes = v.current.runtimeCodeHashes
    })
    const m = model(v)
    v.current.fullEaRaw = '1'
    v.history[0].cashRaw = '1'
    expect(m.input.current.fullEaRaw).toBe('200')
    expect(m.input.history[0].cashRaw).toBe('1000')
    expect(Object.isFrozen(m.input.current.runtimeCodeHashes)).toBe(true)
    const accessor = input()
    let touched = false
    Object.defineProperty(accessor.current, 'fullEaRaw', {
      enumerable: true,
      get() {
        touched = true
        return '200'
      },
    })
    expect(buildUmbrellaGhoJointStockProjection(accessor)).toBeNull()
    expect(touched).toBe(false)
    const cycle = input()
    ;(cycle as unknown as { cycle: unknown }).cycle = cycle
    expect(buildUmbrellaGhoJointStockProjection(cycle)).toBeNull()
    const sparse = input()
    delete (sparse.history as unknown[])[2]
    expect(buildUmbrellaGhoJointStockProjection(sparse)).toBeNull()
  })
})
