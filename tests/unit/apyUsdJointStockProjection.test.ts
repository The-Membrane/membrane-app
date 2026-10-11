import { describe, expect, it } from 'vitest'
import {
  buildApyUsdJointStockProjection,
  type ApyUsdJointStockProjectionInput,
} from '@/lib/carry/apyUsdJointStockProjection'

const T = Date.parse('2026-10-08T12:00:00.000Z'),
  DAY = 86400000
const utc = (n: number) => new Date(n).toISOString()
function fixture(): ApyUsdJointStockProjectionInput {
  // Synthetic unsigned observations: these do not grant native or ownership authority.
  const source = (n: number, at: number) => ({
    chainId: 1 as const,
    blockNumber: n,
    blockHash: '0x' + String(n % 10).repeat(64),
    blockTime: utc(at),
    finalized: true as const,
  })
  return {
    current: {
      source: source(100, T),
      readAtUtc: utc(T),
      profileId: 'synthetic_apy',
      runtimeRegime: 'synthetic_same_runtime',
      assetDecimals: 18,
      shareDecimals: 18,
      fullSharesRaw: '100',
      fullEscrowEaRaw: '1000',
      fullGrossAssetsRaw: '1010',
      vaultUnlockingFeeWad: '10000000000000000',
      vaultCashRaw: '2000',
      vestedAmountRaw: '100',
      receiptCashRaw: '10000',
      vaultPaused: false,
      receiptPaused: false,
      fullShareInitiationSimulation: true,
      feeCurve: {
        minFeeWad: '0',
        maxFeeWad: '34000000000000000',
        minDurationSeconds: 259200,
        maxDurationSeconds: 1728000,
        curvatureWad: '1000000000000000000',
      },
      existingReceipt: {
        tokenId: '881',
        escrowRaw: '500',
        fullNetEaRaw: '500',
        createdAtUtc: utc(T - 40 * DAY),
        claimableAtUtc: utc(T - 37 * DAY),
        fullClaimSimulation: true,
      },
    },
    history: [0, 1].map((i) => ({
      source: source(80 + i, T - (10 - i) * DAY),
      acquiredAtUtc: utc(T),
      profileId: 'synthetic_apy',
      runtimeRegime: 'synthetic_same_runtime',
      assetDecimals: 18,
      shareDecimals: 18,
      fullSharesRaw: '100',
      fullEscrowEaRaw: String(1000 + i * 9),
      fullGrossAssetsRaw: String(1010 + i * 10),
      vaultCashRaw: String(2000 + i * 100),
      vestedAmountRaw: '100',
      receiptCashRaw: String(10000 - i * 9000),
      owner: null,
      historicalOwnership: false,
    })),
    question: {
      issuedAtUtc: utc(T),
      horizonHours: 96,
      plannedInitiationOffsetSeconds: 86400,
      requestedRaw: '100',
    },
  }
}
describe('APY two-leg conditional stock projection (unsigned fixtures)', () => {
  it('does not publish reserved-receipt-only capacity after unexplained share initiation failure', () => {
    const f = fixture()
    f.current.fullShareInitiationSimulation = false
    const m = buildApyUsdJointStockProjection(f)!
    expect(m.scenarios[0].target).toMatchObject({
      initiation: 'censored',
      newNetRaw: null,
      availableRaw: null,
      headroomRaw: null,
      knownFundedNetRaw: '500',
    })
    expect(m.scenarios[0].target.censorReasons).toContain('full_share_initiation_unqualified')
    expect(m.targetSummary).toBeNull()
    expect(m.scenarios[0].checkpoints.find((p) => p.elapsedMs === 0)?.newNetRaw).toBe('0')
    f.current.shareInitiationSimulationStatus = 'succeeded'
    expect(buildApyUsdJointStockProjection(f)).toBeNull()
  })
  it('permits only an observed source funding deficit to recover at the hypothetical future burn', () => {
    const f = fixture()
    f.current.vaultCashRaw = '900'
    f.current.fullShareInitiationSimulation = false
    f.current.shareInitiationSimulationStatus = 'native_funding_gate'
    f.question.plannedInitiationOffsetSeconds = 2 * 86400
    f.question.horizonHours = 144
    const m = buildApyUsdJointStockProjection(f)!
    expect(m.scenarios[0].checkpoints.find((p) => p.elapsedMs === 2 * DAY)).toMatchObject({
      initiation: 'hypothetically_funded',
      frozenNewEscrowRaw: '1019',
      newNetRaw: '0',
      existingNetRaw: '500',
    })
    expect(BigInt(m.scenarios[0].target.newNetRaw!)).toBeGreaterThan(0n)
    expect(m.persistenceTarget.frozenNewEscrowRaw).toBe('891')
    expect(BigInt(m.persistenceTarget.newNetRaw!)).toBeGreaterThan(0n)
    expect(m.MRaw).toBeNull()
    f.current.vaultCashRaw = '2000'
    expect(buildApyUsdJointStockProjection(f)).toBeNull()
  })
  it('independently checks initiation, exact opening, whole old receipt and fee-once target', () => {
    const m = buildApyUsdJointStockProjection(fixture())!
    const points = m.scenarios[0].checkpoints
    expect(points[0]).toMatchObject({
      elapsedMs: 0,
      availableRaw: '500',
      headroomRaw: '400',
      frozenNewEscrowRaw: null,
    })
    expect(points.find((p) => p.elapsedMs === DAY)).toMatchObject({
      frozenNewEscrowRaw: '1009',
      newNetRaw: '0',
    })
    // projectedGross1020 yields escrow1009; ceil(1009*3.4%)=35; net974 plus reserved old500, Q100 once.
    expect(m.scenarios[0].target).toMatchObject({
      frozenNewEscrowRaw: '1009',
      newNetRaw: '974',
      availableRaw: '1474',
      headroomRaw: '1374',
    })
    expect(m.persistenceTarget.availableRaw).toBe('1466')
    expect(m.targetAtUtc).toBe(utc(T + 4 * DAY))
    expect(m.MRaw).toBeNull()
  })
  it('ordinary other-NFT claims cannot deplete an already funded owner reservation', () => {
    const f = fixture()
    f.question.plannedInitiationOffsetSeconds = 10 * 86400
    const m = buildApyUsdJointStockProjection(f)!
    expect(m.scenarios[0].target.existingNetRaw).toBe('500')
    expect(m.scenarios[0].target.availableRaw).toBe('500')
    expect(m.assumptions.receiptCashHistoryDiagnosticOnly).toBe(true)
  })
  it('requires whole receipt funding and claim evidence, never invents a partial old claim', () => {
    const f = fixture()
    f.current.receiptCashRaw = '499'
    const m = buildApyUsdJointStockProjection(f)!
    expect(m.targetSummary).toBeNull()
    expect(m.scenarios[0].target.existingNetRaw).toBeNull()
    expect(m.scenarios[0].target.availableRaw).toBeNull()
    f.current.receiptCashRaw = '500'
    f.current.existingReceipt!.fullClaimSimulation = false
    expect(buildApyUsdJointStockProjection(f)!.targetSummary).toBeNull()
  })
  it('counts source age once at planned burn and stops share accrual afterward', () => {
    const f = fixture()
    f.question.issuedAtUtc = utc(T + 500)
    f.question.plannedInitiationOffsetSeconds = 0
    f.question.horizonHours = 72
    f.current.vaultCashRaw = '1000000'
    f.history[1].fullEscrowEaRaw = '86401000'
    f.history[1].fullGrossAssetsRaw = '87265010'
    const m = buildApyUsdJointStockProjection(f)!
    expect(m.sourceAgeMs).toBe(500)
    expect(m.scenarios[0].checkpoints[0].frozenNewEscrowRaw).toBe('1500')
    expect(m.scenarios[0].target).toMatchObject({
      frozenNewEscrowRaw: '1500',
      newNetRaw: '1449',
      availableRaw: '1949',
    })
    expect(m.scenarios[0].checkpoints.at(-1)?.atUtc).toBe(utc(T + 500 + 3 * DAY))
  })
  it('freezes partial asset capacity without deducting unlocking fee twice', () => {
    const f = fixture()
    f.history[1].vaultCashRaw = '1005'
    f.history[1].fullEscrowEaRaw = '1000'
    f.history[1].fullGrossAssetsRaw = '1010'
    expect(buildApyUsdJointStockProjection(f)!.scenarios[0].target).toMatchObject({
      initiation: 'hypothetically_funded',
      frozenNewEscrowRaw: '995',
      existingNetRaw: '500',
    })
  })
  it('uses exact partial cash capacity, native full entitlement cap, and Q once', () => {
    const f = fixture()
    f.question.plannedInitiationOffsetSeconds = 0
    f.question.horizonHours = 480
    f.current.vaultCashRaw = '900'
    f.current.fullShareInitiationSimulation = false
    f.current.shareInitiationSimulationStatus = 'native_funding_gate'
    const a = buildApyUsdJointStockProjection(f)!
    // 891 + ceil(891 / 100) = 900; one more escrow wei requires 901 cash.
    expect(a.persistenceTarget).toMatchObject({
      frozenNewEscrowRaw: '891',
      newNetRaw: '891',
      existingNetRaw: '500',
      availableRaw: '1391',
      headroomRaw: '1291',
    })
    expect(a.assumptions).toMatchObject({
      action: 'asset_denominated_withdrawForReceipt',
      residualShareAccrualOutsidePlannedAction: true,
    })
    f.question.requestedRaw = '1000'
    const b = buildApyUsdJointStockProjection(f)!
    expect(b.persistenceTarget.availableRaw).toBe('1391')
    expect(b.persistenceTarget.headroomRaw).toBe('391')
    f.current.vaultCashRaw = '0'
    expect(buildApyUsdJointStockProjection(f)!.persistenceTarget).toMatchObject({
      frozenNewEscrowRaw: null,
      newNetRaw: '0',
      availableRaw: '500',
    })
    f.current.vaultCashRaw = '5000'
    f.current.fullShareInitiationSimulation = true
    f.current.shareInitiationSimulationStatus = 'succeeded'
    expect(buildApyUsdJointStockProjection(f)!.persistenceTarget.frozenNewEscrowRaw).toBe('1000')
  })
  it('does not redeem a rounded-up share when an asset action can fund one wei', () => {
    const f = fixture()
    f.question.plannedInitiationOffsetSeconds = 0
    f.question.horizonHours = 480
    f.current.fullSharesRaw = '1'
    f.current.fullGrossAssetsRaw = '2'
    f.current.fullEscrowEaRaw = '2'
    f.current.vaultUnlockingFeeWad = '0'
    f.current.vaultCashRaw = '1'
    f.current.fullShareInitiationSimulation = false
    f.current.shareInitiationSimulationStatus = 'native_funding_gate'
    f.history.forEach((p) => {
      p.fullSharesRaw = '1'
      p.fullEscrowEaRaw = '2'
      p.fullGrossAssetsRaw = '2'
      p.vaultCashRaw = '1'
    })
    expect(buildApyUsdJointStockProjection(f)!.persistenceTarget).toMatchObject({
      frozenNewEscrowRaw: '1',
      newNetRaw: '1',
      availableRaw: '501',
    })
  })
  it('caps a single planned receipt at the native uint208 escrow boundary', () => {
    const f = fixture(),
      cap = (1n << 208n) - 1n
    f.question.plannedInitiationOffsetSeconds = 0
    f.question.horizonHours = 480
    f.current.vaultUnlockingFeeWad = '0'
    f.current.fullGrossAssetsRaw = (cap + 1n).toString()
    f.current.fullEscrowEaRaw = (cap + 1n).toString()
    f.current.vaultCashRaw = (cap + 1n).toString()
    f.history.forEach((p) => {
      p.fullGrossAssetsRaw = (cap + 1n).toString()
      p.fullEscrowEaRaw = (cap + 1n).toString()
      p.vaultCashRaw = (cap + 1n).toString()
    })
    const m = buildApyUsdJointStockProjection(f)!
    expect(m.persistenceTarget.frozenNewEscrowRaw).toBe(cap.toString())
    expect(m.persistenceTarget.availableRaw).toBe((cap + 500n).toString())
    expect(m.assumptions.receiptEscrowCapRaw).toBe(cap.toString())
    expect(m.input.current.fullEscrowEaRaw).toBe((cap + 1n).toString())
  })
  it('accepts exact required cash one wei below native convert gross', () => {
    const f = fixture()
    f.question.plannedInitiationOffsetSeconds = 0
    f.current.fullGrossAssetsRaw = '1011'
    f.current.vaultCashRaw = '1010'
    // preview=1011-ceil(1011/101)=1000; required=1000+ceil(1000/100)=1010.
    expect(buildApyUsdJointStockProjection(f)!.scenarios[0].target.initiation).toBe(
      'hypothetically_funded',
    )
  })
  it('never treats totalAssets accounting as liquid cash, and retains censored diagnostics', () => {
    const f = fixture()
    f.current.vaultCashRaw = null
    f.current.totalAssetsAccountingRaw = '999999999'
    const m = buildApyUsdJointStockProjection(f)!
    expect(m.targetSummary).toBeNull()
    expect(m.scenarios[0].target).toMatchObject({
      availableRaw: null,
      existingNetRaw: '500',
      knownFundedNetRaw: '500',
    })
  })
  it('requires an explicit cash-plus-vested assumption to use vested assets', () => {
    const f = fixture()
    f.current.vaultCashRaw = '950'
    f.current.vestedAmountRaw = '100'
    f.question.plannedInitiationOffsetSeconds = 0
    expect(buildApyUsdJointStockProjection(f)!.scenarios[0].target.frozenNewEscrowRaw).toBe('940')
    f.fundingBasis = 'cash_plus_vested_assumption'
    const m = buildApyUsdJointStockProjection(f)!
    expect(m.scenarios[0].target.initiation).toBe('hypothetically_funded')
    expect(m.scenarios[0].target.frozenNewEscrowRaw).toBe('1000')
    expect(m.assumptions.vestedPullabilityAssumed).toBe(true)
  })
  it('censors an unproven preview fee relationship while preserving receipt diagnostics', () => {
    const f = fixture()
    f.current.fullEscrowEaRaw = '999'
    const m = buildApyUsdJointStockProjection(f)!
    expect(m.targetSummary).toBeNull()
    expect(m.scenarios[0].target).toMatchObject({ existingNetRaw: '500', newNetRaw: null })
    const h = fixture()
    h.history[1].fullEscrowEaRaw = '998'
    expect(buildApyUsdJointStockProjection(h)!.excludedIntervals[0].reason).toBe(
      'historical_preview_fee_policy_mismatch',
    )
  })
  it('Q changes headroom once and cannot alter full-S or the frozen escrow', () => {
    const f = fixture(),
      a = buildApyUsdJointStockProjection(f)!
    f.question.requestedRaw = '300'
    const b = buildApyUsdJointStockProjection(f)!
    expect(a.scenarios[0].target.availableRaw).toBe(b.scenarios[0].target.availableRaw)
    expect(
      BigInt(a.scenarios[0].target.headroomRaw!) - BigInt(b.scenarios[0].target.headroomRaw!),
    ).toBe(200n)
    expect(b.input.current.fullSharesRaw).toBe('100')
  })
  it('uses actual donor duration, negative NET once, and mathematical floor', () => {
    const f = fixture()
    f.history[1].source.blockTime = utc(T - 8 * DAY)
    f.history[1].fullEscrowEaRaw = '997'
    f.history[1].fullGrossAssetsRaw = '1007'
    const m = buildApyUsdJointStockProjection(f)!
    expect(m.scenarios[0].donorPeriodMs).toBe(2 * DAY)
    expect(m.scenarios[0].target.frozenNewEscrowRaw).toBe('998')
  })
  it('marks vault exhaustion without erasing the reserved existing receipt', () => {
    const f = fixture()
    f.history[1].vaultCashRaw = '0'
    f.question.plannedInitiationOffsetSeconds = 2 * 86400
    const m = buildApyUsdJointStockProjection(f)!
    expect(m.targetSummary!.available.band.p10Raw).toBe('500')
    expect(m.scenarios[0].target).toMatchObject({
      availableRaw: '500',
      headroomRaw: '400',
      newNetRaw: '0',
      vaultFundingExhausted: true,
    })
    expect(m.scenarios[0].firstSampledVaultExhaustionMs).toBe(DAY)
  })
  it('retains exclusions for missing donors rather than publishing a selected-only band', () => {
    const f = fixture()
    f.history[0].vaultCashRaw = null
    const m = buildApyUsdJointStockProjection(f)!
    expect(m.targetSummary).toBeNull()
    expect(m.excludedIntervals).toHaveLength(1)
  })
  it('preserves valid raw 0/36 units and zero unredeemed S while retaining receipt881', () => {
    const f = fixture()
    f.current.fullSharesRaw = '0'
    f.current.fullEscrowEaRaw = '0'
    f.current.fullGrossAssetsRaw = '0'
    f.current.assetDecimals = 0
    f.current.shareDecimals = 36
    for (const p of f.history) {
      p.fullSharesRaw = '0'
      p.fullEscrowEaRaw = '0'
      p.fullGrossAssetsRaw = '0'
      p.assetDecimals = 0
      p.shareDecimals = 36
    }
    expect(buildApyUsdJointStockProjection(f)!.scenarios[0].target.availableRaw).toBe('500')
  })
  it('rejects future/stale/read clocks, unit/profile/S/source drift and unsupported durations', () => {
    const mutations = [
      (f: ApyUsdJointStockProjectionInput) => {
        f.question.issuedAtUtc = utc(T - 1)
      },
      (f: ApyUsdJointStockProjectionInput) => {
        f.question.issuedAtUtc = utc(T + 1800001)
      },
      (f: ApyUsdJointStockProjectionInput) => {
        f.current.readAtUtc = utc(T + 1)
      },
      (f: ApyUsdJointStockProjectionInput) => {
        f.current.assetDecimals = 37
      },
      (f: ApyUsdJointStockProjectionInput) => {
        f.history[0].assetDecimals = 6
      },
      (f: ApyUsdJointStockProjectionInput) => {
        f.history[0].runtimeRegime = 'other'
      },
      (f: ApyUsdJointStockProjectionInput) => {
        f.history[0].fullSharesRaw = '101'
      },
      (f: ApyUsdJointStockProjectionInput) => {
        f.history[0].source.blockNumber = 100
      },
      (f: ApyUsdJointStockProjectionInput) => {
        f.question.horizonHours = 721
      },
      (f: ApyUsdJointStockProjectionInput) => {
        f.question.plannedInitiationOffsetSeconds = -1
      },
    ]
    for (const mutate of mutations) {
      const f = fixture()
      mutate(f)
      expect(buildApyUsdJointStockProjection(f)).toBeNull()
    }
  })
  it('rejects forged old opening and fractional native receipt clocks', () => {
    const f = fixture()
    f.current.existingReceipt!.claimableAtUtc = utc(T - 37 * DAY + 1000)
    expect(buildApyUsdJointStockProjection(f)).toBeNull()
    const g = fixture()
    g.current.existingReceipt!.createdAtUtc = utc(T - 40 * DAY + 500)
    g.current.existingReceipt!.claimableAtUtc = utc(T - 37 * DAY + 500)
    expect(buildApyUsdJointStockProjection(g)).toBeNull()
  })
  it('quantizes hypothetical mint time while preserving exact source-age milliseconds', () => {
    const f = fixture()
    f.question.issuedAtUtc = utc(T + 500)
    f.question.plannedInitiationOffsetSeconds = 0
    f.question.horizonHours = 72
    const m = buildApyUsdJointStockProjection(f)!,
      opening = 3 * DAY - 500
    expect(m.scenarios[0].checkpoints.find((p) => p.elapsedMs === opening - 1)?.newNetRaw).toBe('0')
    expect(m.scenarios[0].checkpoints.find((p) => p.elapsedMs === opening)).toMatchObject({
      newNetRaw: '966',
      hypotheticalMintAtUtc: utc(T),
    })
    expect(m.sourceAgeMs).toBe(500)
  })
  it('cannot mint zero-NAV escrow or a floored negative quote', () => {
    const f = fixture()
    f.current.fullEscrowEaRaw = '0'
    f.current.fullGrossAssetsRaw = '0'
    f.question.plannedInitiationOffsetSeconds = 0
    expect(buildApyUsdJointStockProjection(f)!.scenarios[0].target).toMatchObject({
      initiation: 'not_initiated',
      frozenNewEscrowRaw: null,
      availableRaw: '500',
      grossQuoteFloored: true,
    })
    const g = fixture()
    g.history[1].fullEscrowEaRaw = '0'
    g.history[1].fullGrossAssetsRaw = '0'
    g.question.plannedInitiationOffsetSeconds = 2 * 86400
    expect(buildApyUsdJointStockProjection(g)!.scenarios[0].target).toMatchObject({
      availableRaw: '500',
      grossQuoteFloored: true,
      newNetRaw: '0',
    })
  })
  it('censors combined uint256 overflow while preserving bounded individual leg diagnostics', () => {
    const f = fixture(),
      max = ((1n << 256n) - 1n).toString()
    f.question.plannedInitiationOffsetSeconds = 0
    f.current.vaultUnlockingFeeWad = '0'
    f.current.fullGrossAssetsRaw = max
    f.current.fullEscrowEaRaw = max
    f.current.vaultCashRaw = max
    f.current.receiptCashRaw = max
    f.current.existingReceipt!.escrowRaw = max
    f.current.existingReceipt!.fullNetEaRaw = max
    for (const p of f.history) p.fullEscrowEaRaw = p.fullGrossAssetsRaw
    const m = buildApyUsdJointStockProjection(f)!
    expect(m.targetSummary).toBeNull()
    expect(m.scenarios[0].target.availableRaw).toBeNull()
    expect(m.scenarios[0].target.existingNetRaw).toBe(max)
    expect(BigInt(m.scenarios[0].target.newNetRaw!)).toBeGreaterThan(0n)
    expect(m.scenarios[0].target.censorReasons).toContain('combined_available_uint256_overflow')
  })
  it('rejects Q zero', () => {
    const f = fixture()
    f.question.requestedRaw = '0'
    expect(buildApyUsdJointStockProjection(f)).toBeNull()
  })
  it('combines mature and clock-gated immature NFTs at each exact opening', () => {
    const f = fixture(),
      mature = f.current.existingReceipt!
    const immature = {
      tokenId: '882',
      escrowRaw: '100',
      fullNetEaRaw: '96',
      createdAtUtc: utc(T - DAY),
      claimableAtUtc: utc(T + 2 * DAY),
      fullClaimSimulation: false,
      claimSimulationStatus: 'native_time_gate' as const,
    }
    f.current.existingReceipt = null
    f.current.receiptInventory = {
      nativeOwnedCountRaw: '2',
      complete: true,
      receipts: [mature, immature],
    }
    f.current.receiptCashRaw = '600'
    const m = buildApyUsdJointStockProjection(f)!
    const before = m.scenarios[0].checkpoints.find((p) => p.elapsedMs === 2 * DAY - 1)!
    const opening = m.scenarios[0].checkpoints.find((p) => p.elapsedMs === 2 * DAY)!
    expect(before.existingNetRaw).toBe('500')
    expect(opening.existingNetRaw).toBe('596')
    expect(opening.receiptDiagnostics[1]).toMatchObject({
      eligible: true,
      reservationQualified: true,
      netRaw: '96',
    })
    expect(opening.headroomRaw).toBe('496')
    f.question.horizonHours = 480
    const end = buildApyUsdJointStockProjection(f)!.scenarios[0].checkpoints.find(
      (p) => p.elapsedMs === 19 * DAY,
    )!
    expect(end.receiptDiagnostics[1].netRaw).toBe('100')
  })
  it('counts owned zero-escrow tickets in complete native inventory', () => {
    const f = fixture(),
      positive = f.current.existingReceipt!
    f.current.existingReceipt = null
    f.current.receiptInventory = {
      nativeOwnedCountRaw: '2',
      complete: true,
      receipts: [
        positive,
        {
          tokenId: '882',
          escrowRaw: '0',
          fullNetEaRaw: '0',
          createdAtUtc: utc(0),
          claimableAtUtc: utc(0),
          fullClaimSimulation: false,
          claimSimulationStatus: 'unexplained_revert',
        },
      ],
    }
    const m = buildApyUsdJointStockProjection(f)!
    expect(m.scenarios[0].target.existingNetRaw).toBe('500')
    expect(m.scenarios[0].target.receiptDiagnostics).toHaveLength(2)
    expect(m.targetSummary).not.toBeNull()
  })
  it('never reuses one shared cash balance across two whole NFT reservations', () => {
    const f = fixture(),
      first = f.current.existingReceipt!
    f.current.existingReceipt = null
    f.current.receiptInventory = {
      nativeOwnedCountRaw: '2',
      complete: true,
      receipts: [first, { ...first, tokenId: '882' }],
    }
    f.current.receiptCashRaw = '999'
    const m = buildApyUsdJointStockProjection(f)!
    expect(m.targetSummary).toBeNull()
    expect(m.scenarios[0].target.existingNetRaw).toBeNull()
    expect(m.scenarios[0].target.receiptDiagnostics.every((p) => !p.reservationQualified)).toBe(
      true,
    )
    f.current.receiptCashRaw = '1000'
    expect(buildApyUsdJointStockProjection(f)!.scenarios[0].target.existingNetRaw).toBe('1000')
  })
  it('censors incomplete inventory without losing known-ticket diagnostics', () => {
    const f = fixture(),
      first = f.current.existingReceipt!
    f.current.existingReceipt = null
    f.current.receiptInventory = { nativeOwnedCountRaw: '2', complete: false, receipts: [first] }
    const m = buildApyUsdJointStockProjection(f)!
    expect(m.targetSummary).toBeNull()
    expect(m.scenarios[0].target.availableRaw).toBeNull()
    expect(m.scenarios[0].target.existingNetRaw).toBe('500')
    expect(m.scenarios[0].target.censorReasons).toContain('owned_receipt_inventory_incomplete')
    f.current.receiptInventory.nativeOwnedCountRaw = '1'
    expect(buildApyUsdJointStockProjection(f)!.targetSummary).toBeNull()
  })
  it('rejects duplicate IDs, dishonest complete counts and ambiguous legacy input', () => {
    const f = fixture(),
      first = f.current.existingReceipt!
    f.current.existingReceipt = null
    f.current.receiptInventory = {
      nativeOwnedCountRaw: '2',
      complete: true,
      receipts: [first, { ...first }],
    }
    expect(buildApyUsdJointStockProjection(f)).toBeNull()
    f.current.receiptInventory.receipts = [first]
    expect(buildApyUsdJointStockProjection(f)).toBeNull()
    f.current.receiptInventory.nativeOwnedCountRaw = '1'
    f.current.existingReceipt = first
    expect(buildApyUsdJointStockProjection(f)).toBeNull()
  })
  it('rejects claimed clock-gated/succeeded status inconsistent with native source', () => {
    const f = fixture()
    f.current.existingReceipt!.claimSimulationStatus = 'native_time_gate'
    f.current.existingReceipt!.fullClaimSimulation = false
    expect(buildApyUsdJointStockProjection(f)).toBeNull()
    f.current.existingReceipt!.claimSimulationStatus = 'succeeded'
    expect(buildApyUsdJointStockProjection(f)).toBeNull()
    f.current.existingReceipt!.claimSimulationStatus = 'unexplained_revert'
    expect(buildApyUsdJointStockProjection(f)!.targetSummary).toBeNull()
  })
  it('bounds inventory and rejects aggregate escrow uint256 overflow', () => {
    const f = fixture(),
      first = f.current.existingReceipt!
    f.current.existingReceipt = null
    f.current.receiptInventory = {
      nativeOwnedCountRaw: '65',
      complete: true,
      receipts: Array.from({ length: 65 }, (_, i) => ({ ...first, tokenId: String(i) })),
    }
    expect(buildApyUsdJointStockProjection(f)).toBeNull()
    const max = ((1n << 256n) - 1n).toString()
    f.current.receiptInventory = {
      nativeOwnedCountRaw: '2',
      complete: true,
      receipts: [
        { ...first, escrowRaw: max, fullNetEaRaw: max },
        { ...first, tokenId: '882' },
      ],
    }
    expect(buildApyUsdJointStockProjection(f)).toBeNull()
  })
  it('keeps an immature NFT censored when its revert has no native time-gate classification', () => {
    const f = fixture()
    f.current.existingReceipt = {
      tokenId: '882',
      escrowRaw: '100',
      fullNetEaRaw: '96',
      createdAtUtc: utc(T - DAY),
      claimableAtUtc: utc(T + 2 * DAY),
      fullClaimSimulation: false,
      claimSimulationStatus: 'unexplained_revert',
    }
    expect(buildApyUsdJointStockProjection(f)!.targetSummary).toBeNull()
  })
  it('rejects getters without invoking them and freezes independent input/model copies', () => {
    const f = fixture()
    let invoked = false
    Object.defineProperty(f.current, 'vaultCashRaw', {
      enumerable: true,
      get() {
        invoked = true
        return '2000'
      },
    })
    expect(buildApyUsdJointStockProjection(f)).toBeNull()
    expect(invoked).toBe(false)
    const clean = fixture(),
      model = buildApyUsdJointStockProjection(clean)!
    clean.current.fullEscrowEaRaw = '1'
    expect(model.input.current.fullEscrowEaRaw).toBe('1000')
    expect(Object.isFrozen(model)).toBe(true)
    expect(model).toMatchObject({
      originalAuthority: false,
      authenticated: false,
      calibrated: false,
      executionQualified: false,
      historicalOwnership: false,
      iidDonorsAssumed: false,
    })
  })
})
