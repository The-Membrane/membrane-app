import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  scoreCapacityPrediction,
  nativeProjectionElapsedMs,
  projectNativeNetStock,
  scoreUsd3SizedHistory,
  scoreFluidSizedHistory,
  fluidNativeCapacity,
  scoreApySizedHistory,
  apyInitiationCapacity,
  scoreApyReceiptPayments,
  scoreUmbrellaFundingQuoteHistory,
  umbrellaQuoteCashUpperBound,
  type UmbrellaFundingQuoteFrame,
  type ApySizedFrame,
  type ReceiptPaymentRow,
} from '@/lib/venueForecast/nativeHolderSizedHoldout'
import type { Usd3JointHistoricalPoint } from '@/lib/carry/usd3JointHistoricalProcess'
import { ORIGINAL_GHO } from '@/lib/carry/umbrellaGhoExit'
import type { FluidBridgeUsdcFrame } from '@/lib/carry/fluidBridgeUsdcJointHistoricalProcess'
import {
  authenticateNativeHolderPlan,
  joinUmbrellaDiagnosticFrames,
  NATIVE_HOLDER_PLAN_PATH,
  NATIVE_HOLDER_V3_PLAN_PATH,
  buildNativeHolderSizedHoldout,
  writeNativeHolderSizedHoldout,
} from '../../scripts/research/native-holder-sized-holdout.mts'

// These small arithmetic fixtures are unsigned. The final controls separately read pinned saved native datasets.
const start = Date.parse('2026-09-01T00:00:00.000Z')
const iso = (h: number) => new Date(start + h * 3600000).toISOString()
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const VAULT = '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc'
const holder = '0x1234567890123456789012345678901234567890'
const hash = (n: number) => '0x' + n.toString(16).padStart(64, '0')
function usd3(): Usd3JointHistoricalPoint[] {
  return [100, 90, 80, 70].map((limit, n) => ({
    source: {
      chainId: 1,
      blockNumber: 100 + n,
      blockHash: hash(n + 1),
      blockTime: iso(n * 24),
      finalized: true,
    },
    acquiredAtUtc: iso(100),
    hypotheticalSharesRaw: '1000000',
    shareDecimals: 6,
    asset: USDC,
    assetDecimals: 6,
    nativeEaRaw: String(150 + n * 3),
    availableWithdrawLimitRaw: String(limit),
    nativeQuoteStatus: 'conditional_reference_address_quote',
    withdrawalLimitSubject: holder,
    conditionalReferenceAddressQuote: true,
    ownerCommitmentQualification: false,
    shutdown: false,
    navRaw: '200',
    totalAssetsRaw: '200',
    idleUsdcDiagnosticRaw: '0',
    idleUsdcIsTotalFundingUpperBound: false,
    sourceClass: 'captured_identical_runtimes_only',
    sourceImplementationEquivalence: false,
    runtimeIdentities: [VAULT, '0x' + '1'.repeat(40), '0x' + '2'.repeat(40), USDC].map(
      (address, j) => ({ address, runtimeKeccak256: hash(j + 20) }),
    ),
  }))
}
function fluid(): FluidBridgeUsdcFrame[] {
  return [300, 300, 80, 70].map((cash, n) => ({
    source: {
      chainId: 1,
      blockNumber: String(100 + n),
      blockHash: hash(n + 1),
      blockTime: iso(n * 24),
    },
    acquiredAtUtc: iso(100),
    availableAtUtc: iso(100),
    provenanceRef: 'unsigned_fixture_' + n,
    holderSharesRaw: '1000000000000000000',
    shareDecimals: 18,
    asset: USDC,
    assetDecimals: 6,
    fundingUnit: 'gross_native_USDC',
    entitlementUnit: 'net_native_USDC',
    runtimeCodeHashes: { [holder]: hash(20) },
    regime: 'unsigned_same_runtime',
    paused: false,
    withdrawalFeeBps: 500,
    fullHolderNetUsdcRaw: String(100 + n * 10),
    nativeProngs: {
      bridgeFunding: String(cash),
      bankCash: '400',
      bankSupply: '400',
      bankWithdrawableUntilLimit: '400',
      bankResolverWithdrawable: '400',
    },
    provenanceKind: 'native_hypothetical_shares',
    owner: null,
    historicalOwnership: false,
  }))
}
function apy(): ApySizedFrame[] {
  return [10100, 10201, 10302, 10403].map((gross, n) => ({
    source: {
      chainId: 1,
      blockNumber: 100 + n,
      blockHash: hash(n + 1),
      blockTime: iso(n * 24),
      finalized: true,
    },
    acquiredAtUtc: iso(100),
    profileId: 'apyusd_joint_native_v1',
    runtimeRegime: 'unsigned_fixture',
    assetDecimals: 18,
    shareDecimals: 18,
    fullSharesRaw: '10000',
    fullGrossAssetsRaw: String(gross),
    fullEscrowEaRaw: String((gross * 100) / 101),
    vaultCashRaw: '1000000',
    vestedAmountRaw: '0',
    receiptCashRaw: '1000000',
    owner: null,
    historicalOwnership: false,
    authenticated: false,
    originalAuthority: false,
    executionAuthority: false,
    nativeCommitmentAuthentication: false,
    sourceImplementationEquivalence: false,
    vestedYieldPullabilityProven: false,
    calibrated: false,
    runtimeIdentities: [],
    vestingAddress: null,
    vaultUnlockingFeeWad: '10000000000000000',
    primaryAbiVersion: 'official_mutable_HEAD',
    feeCurve: {
      minFeeWad: '1000000000000000',
      maxFeeWad: '50000000000000000',
      minDurationSeconds: 3 * 86400,
      maxDurationSeconds: 21 * 86400,
      curvatureWad: '1000000000000000000',
    },
    vaultPaused: false,
    receiptPaused: false,
  }))
}
function payments(): ReceiptPaymentRow[] {
  const days = [0, 1, 2, 10, 11, 12],
    paid = [4, 15, null, 16, 30, null]
  return days.map((d, n) => ({
    tokenId: String(n + 1),
    holder,
    issuedAt: start / 1000 + d * 86400,
    claimableAt: start / 1000 + (d + 3) * 86400,
    escrowRaw: '100',
    paidAt: paid[n] === null ? null : start / 1000 + paid[n]! * 86400,
    paidRaw: paid[n] === null ? null : n === 0 ? '90' : '95',
    payoutHolder: paid[n] === null ? null : holder,
  }))
}
const basic = () => ({
  sourceAtUtc: iso(24),
  targetAtUtc: iso(48),
  requestedRaw: ['50', '95'],
  baselineRaw: '100',
  actualRaw: '90',
  scenarios: [{ status: 'usable' as const, availableRaw: '110', reason: null }],
})
describe('research native holder-sized prediction measurements', () => {
  it('subtracts each native Q once and scores amount error once for correlated Q cases', () => {
    const r = scoreCapacityPrediction(basic())
    expect(r.amountScore).toMatchObject({
      predictedMeanRaw: '110',
      signedErrorRaw: '20',
      persistenceAbsoluteErrorRaw: '10',
    })
    expect(r.amountErrorDenominator).toBe(1)
    expect(r.QCases.map((q) => q.predictedMeanHeadroomRaw)).toEqual(['60', '15'])
    expect(r.QCases[1]).toMatchObject({
      actualHeadroomRaw: '-5',
      falseSafe: true,
      endpointLossBracket: { after: iso(24), by: iso(48) },
    })
    expect(r.MRaw).toBeNull()
  })
  it('changing a held-out outcome changes errors without changing predictions', () => {
    const a = scoreCapacityPrediction(basic()),
      b = scoreCapacityPrediction({ ...basic(), actualRaw: '190' })
    expect(b.band).toEqual(a.band)
    expect(b.amountScore?.signedErrorRaw).toBe('-80')
  })
  it('keeps censored donors in the denominator and suppresses the whole forecast headline', () => {
    const r = scoreCapacityPrediction({
      ...basic(),
      scenarios: [
        ...basic().scenarios,
        { status: 'censored', availableRaw: null, reason: 'negative_stock' },
      ],
    })
    expect(r).toMatchObject({
      complete: false,
      attemptedScenarios: 2,
      usableScenarios: 1,
      censoredScenarios: 1,
      band: null,
      amountScore: null,
    })
    expect(r.QCases[0].falseSafe).toBeNull()
  })
  it('does not infer a continuous loss/recovery duration from native endpoints', () => {
    const r = scoreCapacityPrediction({ ...basic(), baselineRaw: '40', actualRaw: '90' })
    expect(r.QCases[0].endpointRecoveryBracket).toEqual({ after: iso(24), by: iso(48) })
    expect(r.QCases[0].continuousAvailabilityKnown).toBe(false)
  })
  it.each([[['0']], [['1', '1']]])('rejects zero or duplicate Q cases %j', (q) => {
    expect(() => scoreCapacityPrediction({ ...basic(), requestedRaw: q })).toThrow()
  })
  it('does exact native arithmetic beyond safe Number precision', () => {
    const v = (1n << 200n).toString(),
      Q = ((1n << 200n) - 1n).toString()
    expect(
      scoreCapacityPrediction({
        ...basic(),
        requestedRaw: [Q],
        baselineRaw: v,
        actualRaw: v,
        scenarios: [{ status: 'usable', availableRaw: v, reason: null }],
      }).QCases[0].actualHeadroomRaw,
    ).toBe('1')
  })
  it('adds nonzero source age once to the exact issue+horizon target', () => {
    const input = {
      sourceAtUtc: iso(24),
      issueAtUtc: iso(25),
      horizonHours: 2,
      targetAtUtc: iso(27),
      sourceRaw: '100',
      donorStartAtUtc: iso(1),
      donorEndAtUtc: iso(2),
      donorStartRaw: '100',
      donorEndRaw: '110',
    }
    expect(
      nativeProjectionElapsedMs(input.sourceAtUtc, input.issueAtUtc, 2, input.targetAtUtc),
    ).toBe(3 * 3600000)
    expect(projectNativeNetStock(input)).toBe(130n)
    const r = scoreCapacityPrediction({
      ...basic(),
      issueAtUtc: iso(25),
      horizonHours: 2,
      targetAtUtc: iso(27),
    })
    expect(r).toMatchObject({
      sourceAgeSeconds: 3600,
      elapsedSeconds: 10800,
      hypotheticalZeroLagOrigin: false,
      historicallyFinalizedIssueAvailable: false,
    })
  })
  it('censors mismatched native horizon endpoints rather than interpolating or choosing the nearest day', () => {
    const r = scoreCapacityPrediction({ ...basic(), issueAtUtc: iso(25), horizonHours: 24 })
    expect(r).toMatchObject({
      complete: false,
      actualRaw: null,
      targetCensorReason: 'missing_exact_issue_plus_horizon_native_endpoint',
    })
    expect(nativeProjectionElapsedMs(iso(24), iso(25), 24, iso(48))).toBeNull()
    expect(
      projectNativeNetStock({
        sourceAtUtc: iso(24),
        issueAtUtc: iso(25),
        horizonHours: 24,
        targetAtUtc: iso(48),
        sourceRaw: '100',
        donorStartAtUtc: iso(0),
        donorEndAtUtc: iso(1),
        donorStartRaw: '90',
        donorEndRaw: '100',
      }),
    ).toBeNull()
  })
  it('rejects donors available only at or after the source cutoff', () => {
    expect(() =>
      projectNativeNetStock({
        sourceAtUtc: iso(24),
        issueAtUtc: iso(25),
        horizonHours: 1,
        targetAtUtc: iso(26),
        sourceRaw: '100',
        donorStartAtUtc: iso(23),
        donorEndAtUtc: iso(24),
        donorStartRaw: '90',
        donorEndRaw: '100',
      }),
    ).toThrow('donor_after_source_cutoff')
  })
})
describe('unchanged native USD3 and Fluid joint engines', () => {
  it('replays fixed-S USD3 forecasts and measured native limits', () => {
    const r = scoreUsd3SizedHistory(usd3(), iso(200))[0]
    expect(r).toMatchObject({
      complete: true,
      actualRaw: '70',
      assetDecimals: 6,
      shareDecimals: 6,
      historicalOwnership: false,
    })
    expect(r.amountScore?.signedErrorRaw).toBe('0')
    expect(r.nativeFundingDiagnostic.actualRaw).toBe('70')
    expect(r.trainingSources.every((p) => p.source.blockTime < r.knowledgeCutoffUtc)).toBe(true)
  })
  it('rejects a source-frame acquisition after the actual analysis time', () => {
    const f = usd3()
    f[0].acquiredAtUtc = iso(201)
    expect(() => scoreUsd3SizedHistory(f, iso(200))).toThrow('actual_acquisition_clock')
  })
  it.each(['S', 'runtime', 'units', 'native_limit'])('censors changed USD3 held-out %s', (kind) => {
    const f = usd3()
    if (kind === 'S') f[3].hypotheticalSharesRaw = '2000000'
    if (kind === 'runtime') f[3].runtimeIdentities[1].runtimeKeccak256 = hash(55)
    if (kind === 'units') f[3].assetDecimals = 18 as 6
    if (kind === 'native_limit') {
      f[3].availableWithdrawLimitRaw = null
      f[3].nativeQuoteStatus = 'censored_native_withdrawal_limit_unavailable'
    }
    expect(scoreUsd3SizedHistory(f, iso(200))[0].complete).toBe(false)
  })
  it('rejects a changed training S instead of scaling old native share quotes', () => {
    const f = usd3()
    f[0].hypotheticalSharesRaw = '2000000'
    expect(() => scoreUsd3SizedHistory(f, iso(200))).toThrow('training_S_or_regime')
  })
  it('uses the weakest native Fluid prong and applies the withdrawal fee exactly once', () => {
    expect(fluidNativeCapacity(fluid()[2])).toEqual({ fundingNetRaw: '76', availableRaw: '76' })
    const r = scoreFluidSizedHistory(fluid(), iso(200), [['70']])[0]
    expect(r).toMatchObject({ baselineRaw: '76', actualRaw: '66', complete: true })
    expect(r.amountScore?.predictedMeanRaw).toBe('76')
    expect(r.QCases[0]).toMatchObject({
      predictedMeanHeadroomRaw: '6',
      actualHeadroomRaw: '-4',
      falseSafe: true,
    })
  })
  it('retains Fluid funding error when a tiny native entitlement masks it in holder capacity', () => {
    const f = fluid()
    f.forEach((point) => {
      point.fullHolderNetUsdcRaw = '1'
    })
    const r = scoreFluidSizedHistory(f, iso(200), [['1', '2']])[0]
    expect(r.amountScore?.absoluteErrorRaw).toBe('0')
    expect(r.nativeFundingDiagnostic.amountScore?.signedErrorRaw).toBe('10')
    expect(r.nativeProngBindings.baseline).toMatchObject({
      fullEntitlementRaw: '1',
      quoteEntitlementBinding: true,
      nativeFundingBinding: false,
      weakestNativeProngs: ['bridgeFunding'],
    })
    expect(r.nativeProngBindings.outcome?.nativeProngs.bridgeFunding).toBe('70')
  })
  it.each(['fee', 'S', 'unit', 'runtime'])('censors changed Fluid target %s', (kind) => {
    const f = fluid()
    if (kind === 'fee') f[3].withdrawalFeeBps = 600
    if (kind === 'S') f[3].holderSharesRaw = '2'
    if (kind === 'unit') f[3].shareDecimals = 6
    if (kind === 'runtime') f[3].runtimeCodeHashes[holder] = hash(55)
    expect(scoreFluidSizedHistory(f, iso(200))[0].complete).toBe(false)
  })
  it('does not pool a different holder-provenance frame into a hypothetical study', () => {
    const f = fluid()
    Object.assign(f[0], { owner: holder, historicalOwnership: true })
    expect(() => scoreFluidSizedHistory(f, iso(200))).toThrow('training_S_or_regime')
  })
})
describe('APY native quote/funding study and separate actual receipt payments', () => {
  it('keeps ceil unlocking fees within native cash and uint208, without zeroing partial funding', () => {
    expect(
      apyInitiationCapacity({
        netEaRaw: '200',
        vaultCashRaw: '101',
        feeWad: '10000000000000000',
        paused: false,
      }),
    ).toMatchObject({ availableRaw: '100', grossNeededRaw: '101' })
    const cap = (1n << 208n) - 1n
    expect(
      apyInitiationCapacity({
        netEaRaw: String(cap + 1n),
        vaultCashRaw: String(cap + 1n),
        feeWad: '0',
        paused: false,
      }).availableRaw,
    ).toBe(String(cap))
    expect(
      apyInitiationCapacity({ netEaRaw: '10', vaultCashRaw: '100', feeWad: '0', paused: true })
        .availableRaw,
    ).toBe('0')
  })
  it('replays post-vault-fee native quote capacity without historical old-NFT ownership or a simulated mint', () => {
    const r = scoreApySizedHistory(apy(), iso(200))[0]
    expect(r).toMatchObject({
      complete: true,
      actualRaw: '10300',
      existingNFTsUsed: 0,
      historicalOwnership: false,
    })
    expect(r.amountScore?.predictedMeanRaw).toBe('10300')
    expect(r.hypotheticalSourceInitiation).toMatchObject({
      escrowRaw: '10200',
      conditionalUnobservedNetAtTargetRaw: '0',
      actualNativeInitiationSimulation: false,
      actualMintedReceipt: false,
      actualDeliveryTarget: false,
    })
    expect(r.QCases.find((q) => q.requestedRaw === '1000000000000000000')?.actualCovers).toBe(false)
  })
  it('reports raw APY cash NET error when full-S quote accuracy conceals funding error', () => {
    const f = apy(),
      cash = ['1000000', '1100000', '1200000', '1500000']
    f.forEach((point, n) => {
      point.vaultCashRaw = cash[n]
    })
    const r = scoreApySizedHistory(f, iso(200))[0]
    expect(r.amountScore?.absoluteErrorRaw).toBe('0')
    expect(r.nativeVaultCashDiagnostic).toMatchObject({
      scope: 'raw_native_apxUSD_vault_cash_not_holder_execution',
      actualRaw: '1500000',
      feeApplied: false,
      holderQApplied: false,
      QCases: [],
    })
    expect(r.nativeVaultCashDiagnostic.amountScore).toMatchObject({
      predictedMeanRaw: '1300000',
      signedErrorRaw: '-200000',
      persistenceAbsoluteErrorRaw: '300000',
    })
    expect(r.nativeProngBindings.baseline).toMatchObject({
      fullEntitlementRaw: '10200',
      vaultCashRaw: '1200000',
      quoteEntitlementBinding: true,
      nativeFundingBinding: false,
    })
    expect(r.nativeProngBindings.outcome?.vaultCashRaw).toBe('1500000')
  })
  it('measures a later native pause as zero initiation capacity without claiming receipt delivery', () => {
    const f = apy()
    f[3].receiptPaused = true
    const r = scoreApySizedHistory(f, iso(200))[0]
    expect(r).toMatchObject({
      complete: true,
      actualRaw: '0',
      targetKind: 'later_native_escrow_quote_and_cash_upper_bound_not_initiation_call',
    })
    expect(r.QCases.every((q) => q.actualCovers === false)).toBe(true)
    expect(r.hypotheticalSourceInitiation.actualDeliveryTarget).toBe(false)
  })
  it('rejects a double-applied vault fee in native Ea', () => {
    const f = apy()
    f[1].fullEscrowEaRaw = '9999'
    expect(() => scoreApySizedHistory(f, iso(200))).toThrow('native_quote_fee')
  })
  it('censors held-out APY policy changes', () => {
    const f = apy()
    f[3].feeCurve.minDurationSeconds = 4 * 86400
    expect(scoreApySizedHistory(f, iso(200))[0].complete).toBe(false)
  })
  it('keeps negative projected native cash as a censored donor', () => {
    const f = apy()
    f[0].vaultCashRaw = '1000'
    f[1].vaultCashRaw = '1'
    f[2].vaultCashRaw = '1'
    expect(scoreApySizedHistory(f, iso(200))[0]).toMatchObject({
      complete: false,
      censoredScenarios: 1,
      band: null,
    })
  })
  it('fits net-payment amount and duration only from split-visible training payments', () => {
    const r = scoreApyReceiptPayments(payments())
    expect(r).toMatchObject({
      trainingVisiblePayments: 1,
      trainingLatePaymentsExcluded: 1,
      descriptiveCompletedCaseFit: {
        netPaidPerEscrowWad: '900000000000000000',
        requestToPaymentMedianSeconds: 4 * 86400,
      },
    })
    expect(r.holdout.find((h) => h.days === 7)).toMatchObject({ paid: 1, scored: 3, censored: 0 })
    const changed = payments()
    changed[1].paidRaw = '1'
    changed[4].paidRaw = '1'
    expect(scoreApyReceiptPayments(changed).descriptiveCompletedCaseFit).toEqual(
      r.descriptiveCompletedCaseFit,
    )
  })
  it('retains unpaid receipts as right-censored ultimate delivery rather than invented zero payout', () => {
    const r = scoreApyReceiptPayments(payments())
    expect(r.holdout[0].cases.find((c) => c.tokenId === '6')).toMatchObject({
      deliveryDurationSeconds: null,
      rightCensored: true,
      actualNetPaidByHRaw: '0',
    })
  })
  it.each(['owner', 'duplicate', 'gross_amount'])('rejects invalid payment %s joins', (kind) => {
    const f = payments()
    if (kind === 'owner') f[3].payoutHolder = '0x' + 'a'.repeat(40)
    if (kind === 'duplicate') f[3].tokenId = f[0].tokenId
    if (kind === 'gross_amount') f[3].paidRaw = '101'
    expect(() => scoreApyReceiptPayments(f)).toThrow()
  })
})
function umbrella(): UmbrellaFundingQuoteFrame[] {
  return [1000, 900, 800, 850].map((cash, n) => ({
    cashIndex: n,
    source: {
      chainId: 1,
      finalized: true,
      blockNumber: 100 + n,
      blockHash: hash(n + 1),
      blockTime: iso(n * 24),
    },
    acquiredAtUtc: iso(100),
    sharesRaw: '100',
    cooldownCoveredSharesRaw: '50',
    cashRaw: String(cash),
    fullEaRaw: '20',
    coveredEaRaw: '10',
    paused: false,
    cooldownSeconds: '1728000',
    unstakeWindowSeconds: '172800',
    runtimeCodeHashes: { [holder]: hash(20), [VAULT]: hash(21), [USDC]: hash(22) },
    owner: null,
    historicalOwnership: false,
    sourceClass: 'captured_identical_runtimes_only',
    MRaw: null,
    maxSlashableAssetsRaw: String(cash - 1),
    asset: ORIGINAL_GHO,
    assetDecimals: 18,
    shareDecimals: 18,
  }))
}
describe('unsigned Umbrella native funding/quote diagnostic, missing holder eligibility', () => {
  it('separately measures cash error hidden by tiny entitlement with one denominator per fold', () => {
    const r = scoreUmbrellaFundingQuoteHistory(umbrella(), iso(200))[0]
    expect(r).toMatchObject({
      diagnosticOnly: true,
      complete: true,
      actualRaw: '10',
      amountErrorDenominator: 1,
      upperBoundAmountErrorDenominator: 1,
      holderAmountErrorDenominator: 0,
      actualHolderEligibility: null,
      actualHolderExitAbilityRaw: null,
      fullSharesRaw: '100',
      cooldownCoveredSharesRaw: '50',
      historicallyFinalizedIssueAvailable: false,
    })
    expect(r.amountScore?.absoluteErrorRaw).toBe('0')
    expect(r.nativeGhoCashDiagnostic).toMatchObject({
      complete: true,
      actualRaw: '850',
      baselineRaw: '800',
      amountErrorDenominator: 1,
      QCases: [],
      feeApplied: false,
      holderQApplied: false,
      maxSlashableApplied: false,
    })
    expect(r.nativeGhoCashDiagnostic.amountScore).toMatchObject({
      predictedMeanRaw: '700',
      signedErrorRaw: '-150',
      persistenceAbsoluteErrorRaw: '50',
    })
    expect(r.QCases).toHaveLength(4)
    expect(
      r.QCases.every((q) => q.actualHeadroomRaw === String(10n - BigInt(q.requestedRaw))),
    ).toBe(true)
    expect(r.trainingSources.map((p) => p.source.blockTime)).toEqual([iso(0), iso(24)])
    expect(r.baselineActualAcquiredAtUtc).toBe(iso(100))
  })
  it('does not fit future endpoint values', () => {
    const f = umbrella(),
      a = scoreUmbrellaFundingQuoteHistory(f, iso(200))[0]
    f[3].cashRaw = '950'
    const b = scoreUmbrellaFundingQuoteHistory(f, iso(200))[0]
    expect(a.scenarios).toEqual(b.scenarios)
    expect(a.nativeGhoCashDiagnostic.scenarios).toEqual(b.nativeGhoCashDiagnostic.scenarios)
    expect(b.nativeGhoCashDiagnostic.amountScore?.signedErrorRaw).toBe('-250')
  })
  it.each(['sharesRaw', 'cooldownCoveredSharesRaw'] as const)(
    'rejects changed training %s without scaling native quotes',
    (key) => {
      const f = umbrella()
      f[0][key] = key === 'sharesRaw' ? '101' : '49'
      expect(() => scoreUmbrellaFundingQuoteHistory(f, iso(200))).toThrow('umbrella_training_S_CS')
    },
  )
  it('censors changed target CS while retaining the independent raw-cash score', () => {
    const f = umbrella()
    f[3].cooldownCoveredSharesRaw = '49'
    const r = scoreUmbrellaFundingQuoteHistory(f, iso(200))[0]
    expect(r).toMatchObject({
      complete: false,
      actualRaw: null,
      amountErrorDenominator: 0,
      targetCensorReason: 'target_S_CS_units_runtime_or_policy_changed',
    })
    expect(r.nativeGhoCashDiagnostic.complete).toBe(true)
  })
  it('censors a missing native endpoint quote', () => {
    const f = umbrella()
    f[3].coveredEaRaw = null
    const r = scoreUmbrellaFundingQuoteHistory(f, iso(200))[0]
    expect(r.targetCensorReason).toBe('target_native_quote_or_cash_missing')
    expect(r.amountErrorDenominator).toBe(0)
    expect(r.nativeGhoCashDiagnostic.amountErrorDenominator).toBe(1)
  })
  it('does not fit or transplant a later native policy', () => {
    const f = umbrella()
    f[3].cooldownSeconds = '1728001'
    const r = scoreUmbrellaFundingQuoteHistory(f, iso(200))[0]
    expect(r.complete).toBe(false)
    expect(r.actualHolderEligibility).toBeNull()
    expect(r.historicalHolderPolicyTransplanted).toBe(false)
    expect(r.scenarios[0].availableRaw).toBe('10')
  })
  it('censors target runtime substitution', () => {
    const f = umbrella()
    f[3].runtimeCodeHashes[holder] = hash(99)
    const r = scoreUmbrellaFundingQuoteHistory(f, iso(200))[0]
    expect(r.complete).toBe(false)
    expect(r.nativeGhoCashDiagnostic.complete).toBe(false)
  })
  it.each(['owner', 'units', 'authority'] as const)('rejects %s substitution', (kind) => {
    const f = umbrella()
    if (kind === 'owner') f[0].owner = holder as unknown as null
    if (kind === 'units') f[0].assetDecimals = 6 as unknown as 18
    if (kind === 'authority')
      f[0].authority = { authentication: true } as unknown as Record<string, false>
    expect(() => scoreUmbrellaFundingQuoteHistory(f, iso(200))).toThrow()
  })
  it('does not turn a nearby block into an exact24h target', () => {
    const f = umbrella()
    f[3].source.blockTime = new Date(start + 72 * 3600000 + 1000).toISOString()
    const r = scoreUmbrellaFundingQuoteHistory(f, iso(200))[0]
    expect(r.complete).toBe(false)
    expect(r.targetCensorReason).toBe('missing_exact_issue_plus_horizon_native_endpoint')
    expect(r.nativeGhoCashDiagnostic.complete).toBe(false)
  })
  it('counts nonzero source age once and preserves actual acquisition clocks', () => {
    const f = umbrella()
    const miss = scoreUmbrellaFundingQuoteHistory(f, iso(200), { sourceAgeMs: 1200000 })[0]
    expect(miss.complete).toBe(false)
    const hit = scoreUmbrellaFundingQuoteHistory(f, iso(200), {
      sourceAgeMs: 1200000,
      horizonHours: 24 - 1 / 3,
    })[0]
    expect(hit.complete).toBe(true)
    expect(hit.sourceAgeSeconds).toBe(1200)
    expect(hit.elapsedSeconds).toBe(86400)
    expect(hit.nativeGhoCashDiagnostic.amountScore?.predictedMeanRaw).toBe('700')
    expect(hit.actualOutcomeAcquiredAtUtc).toBe(iso(100))
  })
  it('does not subtract maxSlashable as a fee, reserve or loss', () => {
    const f = umbrella()
    f.forEach((p) => {
      p.maxSlashableAssetsRaw = '0'
    })
    const r = scoreUmbrellaFundingQuoteHistory(f, iso(200))[0]
    expect(umbrellaQuoteCashUpperBound(f[2])).toBe('10')
    expect(r.nativeProngBindings.baseline.maxSlashableAppliedAsFeeReserveOrLoss).toBe(false)
    expect(r.nativeGhoCashDiagnostic.amountScore?.predictedMeanRaw).toBe('700')
  })
  it('censors negative projected stocks instead of clamping them', () => {
    const f = umbrella()
    f[0].cashRaw = '1000'
    f[1].cashRaw = '1'
    f[2].cashRaw = '1'
    const r = scoreUmbrellaFundingQuoteHistory(f, iso(200))[0]
    expect(r.complete).toBe(false)
    expect(r.nativeGhoCashDiagnostic.complete).toBe(false)
    expect(r.censoredScenarios).toBe(1)
  })
  it('grades a native future pause as zero upper bound while holder eligibility stays unknown', () => {
    const f = umbrella()
    f[3].paused = true
    const r = scoreUmbrellaFundingQuoteHistory(f, iso(200))[0]
    expect(r.actualRaw).toBe('0')
    expect(r.actualHolderExitAbilityRaw).toBeNull()
    expect(r.QCases.map((q) => q.falseSafe)).toEqual([true, true, true, false])
    expect(r.QCases.every((q) => q.actualCovers === false)).toBe(true)
  })
})

describe('fixed saved-source integration, unsigned research only', () => {
  let cached: ReturnType<typeof buildNativeHolderSizedHoldout> | undefined
  const actual = () => (cached ??= buildNativeHolderSizedHoldout(new Date().toISOString()))
  it('rejects substituted or modified immutable input plans before input reads', () => {
    const text = readFileSync(resolve(process.cwd(), NATIVE_HOLDER_PLAN_PATH), 'utf8')
    expect(authenticateNativeHolderPlan(text).roster).toHaveLength(67)
    expect(() =>
      authenticateNativeHolderPlan(text.replace('391143432', '391143433') + ' '),
    ).toThrow('immutable_plan_pin')
    expect(() => authenticateNativeHolderPlan('{}')).toThrow('immutable_plan_pin')
  })
  it('retains all25/67 and supplemental separately while rebuilding actual native full-S datasets', () => {
    const r = actual()
    expect(r.counts).toMatchObject({
      coreGroups: 25,
      coreDestinations: 67,
      supplementalGroups: 1,
      supplementalDestinations: 1,
      coreCashDiagnosticGroups: 21,
      coreCashDiagnosticDestinations: 63,
      nativeSizedStudyGroups: 3,
      chronologicalSizedFolds: 17,
      nativeAcquisitionsThisRun: 0,
    })
    expect(
      r.core.filter((c) => c.nativeSizedStudy).map((c) => c.nativeSizedStudy?.folds.length),
    ).toEqual(expect.arrayContaining([5, 7, 5]))
    expect(
      r.core.filter((c) => !c.nativeSizedStudy).every((c) => c.notProvidedToThisStudy.length > 0),
    ).toBe(true)
    expect(r.core.filter((c) => c.finalOriginalAssetCashExclusion)).toHaveLength(4)
    expect(r.methodology).toMatchObject({
      historicallyFinalizedIssueAvailabilityEstablished: false,
      oldNFT881UsedAsHistoricalOwnership: false,
      nearestDayOrInterpolatedLabels: false,
    })
  })
  it('retains implementation byte pins and narrow runtime provenance without issuance authority', () => {
    const r = actual()
    expect(r.studyImplementationSourcePins.map((pin) => pin.path)).toEqual([
      'lib/venueForecast/nativeHolderSizedHoldout.ts',
      'scripts/research/native-holder-sized-holdout.mts',
      'scripts/lib/boundedLocalReceiptFile.mjs',
    ])
    r.studyImplementationSourcePins.forEach((pin) => {
      const bytes = readFileSync(resolve(process.cwd(), pin.path))
      expect(pin.bytes).toBe(bytes.length)
      expect(pin.fileSha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    })
    expect(r.runtimeProvenance).toMatchObject({
      nodeVersion: process.version,
      sourceBytesAreLoadedCompiledModuleProof: false,
      originalIssueReproducibilityAuthority: false,
    })
    const coverage = r.nativeConstraintCoverage.filter((row) => row.foldsWithNativeProngValues > 0)
    expect(coverage).toHaveLength(2)
    expect(
      coverage.every(
        (row) =>
          row.baselineQuoteEntitlementBoundFolds === row.foldsWithNativeProngValues &&
          row.outcomeQuoteEntitlementBoundFolds === row.foldsWithNativeProngValues,
      ),
    ).toBe(true)
    expect(coverage.every((row) => row.observedQuoteBoundCasesProveCashSensitivity === false)).toBe(
      true,
    )
  })
  it('reconstructs the actual96/89 APY net-delivery cohort and only3 visible fit labels', () => {
    const r = actual().receiptPayments
    expect(r).toMatchObject({
      requestCount: 96,
      actualPaymentCount: 89,
      openCount: 7,
      trainRequests: 48,
      holdoutRequests: 48,
      trainingVisiblePayments: 3,
    })
    expect(r.holdout.map((h) => h.paid)).toEqual([0, 9, 10, 37, 43])
    expect(r.historicalOwnership).toBe(false)
  })
  it('freezes original unsigned reports and refuses cloned reports without writing', () => {
    const r = actual()
    expect(Object.isFrozen(r)).toBe(true)
    expect(Reflect.set(r, 'calibratedProbability', true)).toBe(false)
    expect(() =>
      writeNativeHolderSizedHoldout(
        resolve(process.cwd(), 'data/research/venue-signals/SHOULD_NOT_EXIST.json'),
        structuredClone(r),
      ),
    ).toThrow('original_built_report')
    expect(r).toMatchObject({
      authenticationAuthority: false,
      originalPrivateIssuanceAuthority: false,
      executionAuthority: false,
      calibratedProbability: false,
    })
  })
})

describe('immutable v3 saved Umbrella diagnostic admission', () => {
  let cached: ReturnType<typeof buildNativeHolderSizedHoldout> | undefined
  const actualV3 = () =>
    (cached ??= buildNativeHolderSizedHoldout(
      new Date().toISOString(),
      resolve(process.cwd(), NATIVE_HOLDER_V3_PLAN_PATH),
    ))
  type JoinArgs = Parameters<typeof joinUmbrellaDiagnosticFrames>
  let cachedJoin:
    | { response: JoinArgs[0]; manifest: JoinArgs[1]; batches: JoinArgs[2]; identity: JoinArgs[3] }
    | undefined
  const originalJoin = () => {
    if (cachedJoin) return cachedJoin
    const plan = authenticateNativeHolderPlan(
      readFileSync(resolve(process.cwd(), NATIVE_HOLDER_V3_PLAN_PATH), 'utf8'),
      3,
    )
    const read = (key: string) => {
      const pin = plan.inputs[key]
      const bytes = readFileSync(resolve(process.cwd(), pin.path))
      expect(bytes.length).toBe(pin.bytes)
      expect(bytes.length).toBeLessThanOrEqual(8 * 1024 * 1024)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin.fileSha256)
      return JSON.parse(bytes.toString('utf8'))
    }
    cachedJoin = {
      response: read('umbrella'),
      manifest: read('umbrellaManifest'),
      batches: [0, 1].map((n) => ({
        plan: read('umbrellaPlan' + n),
        receipt: read('umbrellaReceipt' + n),
      })),
      identity: plan.umbrellaDiagnosticSpec!.identity,
    }
    return cachedJoin
  }
  it('authenticates v3 independently while keeping v2 immutable and rejecting substitution', () => {
    const v3 = readFileSync(resolve(process.cwd(), NATIVE_HOLDER_V3_PLAN_PATH), 'utf8')
    expect(authenticateNativeHolderPlan(v3, 3).roster).toHaveLength(67)
    expect(() => authenticateNativeHolderPlan(v3)).toThrow('immutable_plan_pin')
    expect(() => authenticateNativeHolderPlan(v3 + ' ', 3)).toThrow('immutable_plan_pin')
  })
  it('retains three holder studies and reports one separate native funding/quote diagnostic', () => {
    const r = actualV3()
    expect(r.schema).toBe('native_holder_sized_holdout_v3')
    expect(r.counts).toMatchObject({
      nativeSizedStudyGroups: 3,
      nativeSizedStudyDestinations: 3,
      chronologicalSizedFolds: 17,
      coreGroups: 25,
      coreDestinations: 67,
      coreCashDiagnosticGroups: 21,
      coreCashDiagnosticDestinations: 63,
      nativeFundingQuoteDiagnosticGroups: 1,
      nativeFundingQuoteDiagnosticDestinations: 1,
      diagnosticChronologicalFolds: 5,
      diagnosticCorrelatedDonorEdgeAttempts: 15,
      diagnosticUpperBoundAmountComparisons: 5,
      diagnosticFundingAmountComparisons: 5,
      diagnosticCorrelatedQCases: 20,
      diagnosticHolderAbilityComparisons: 0,
      nativeAcquisitionsThisRun: 0,
    })
    expect(r.inputs.umbrellaReceipt0.bytes).toBe(2130337)
    expect(r.inputs.umbrellaReceipt1.bytes).toBe(2312085)
    expect(r.inputs.umbrellaReceipt0.bytes).toBeGreaterThan(1024 * 1024)
    expect(r.inputs.umbrellaReceipt1.bytes).toBeGreaterThan(1024 * 1024)
    const diagnostic = r.nativeFundingQuoteDiagnostics[0]
    expect(diagnostic.provenance).toMatchObject({
      joinedNativeTraces: 288,
      joinedChainRows: 4,
      physicalRows: 292,
    })
    expect(diagnostic.folds).toHaveLength(5)
    expect(
      diagnostic.folds.every(
        (f) =>
          f.actualHolderEligibility === null &&
          f.actualHolderExitAbilityRaw === null &&
          f.holderAmountErrorDenominator === 0 &&
          f.fullSharesRaw === '72016496913002872528' &&
          f.cooldownCoveredSharesRaw === '72016496913002872528',
      ),
    ).toBe(true)
    const row = r.core.find((c) => c.nativeFundingQuoteDiagnostic)
    expect(row?.nativeSizedStudy).toBeNull()
    expect(row?.notProvidedToThisStudy).toContain(
      'historical_staker_cooldown_snapshot_and_maxRedeem',
    )
    expect(r.methodology.umbrellaCurrentHolderWindowTransplanted).toBe(false)
  })
  it('rejects native trace result substitution against the pinned physical response bytes', () => {
    const f = originalJoin(),
      response = structuredClone(f.response)
    const trace = response.umbrellaGhoJointHistoricalEvidence.points[7].wire.origins[0].traces.find(
      (t) => t.key === 'fullEaRaw',
    )!
    Reflect.set(trace, 'result', '0x' + '0'.repeat(63) + '1')
    expect(() =>
      joinUmbrellaDiagnosticFrames(
        response,
        f.manifest,
        f.batches,
        f.identity,
        new Date().toISOString(),
      ),
    ).toThrow('umbrella_native_result_agreement')
  })
  it('rejects changed historical S rather than reusing another native quote basis', () => {
    const f = originalJoin(),
      response = structuredClone(f.response)
    Reflect.set(
      response.umbrellaGhoJointHistoricalEvidence.points[7].binding,
      'fullSharesRaw',
      '72016496913002872529',
    )
    expect(() =>
      joinUmbrellaDiagnosticFrames(
        response,
        f.manifest,
        f.batches,
        f.identity,
        new Date().toISOString(),
      ),
    ).toThrow('umbrella_original_binding')
  })
  it('rejects a resealed settlement observation that differs from the unchanged native row', () => {
    const f = originalJoin(),
      receipt = structuredClone(f.batches[0].receipt),
      settlement = receipt.settlements[0]
    settlement.observation.httpStatus = 503
    const canonical = (value: unknown): string => {
      if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
      if (value && typeof value === 'object') {
        const fields = value as Record<string, unknown>
        return (
          '{' +
          Object.keys(fields)
            .sort()
            .map((key) => JSON.stringify(key) + ':' + canonical(fields[key]))
            .join(',') +
          '}'
        )
      }
      const encoded = JSON.stringify(value)
      if (typeof encoded !== 'string') throw Error('fixture_json_value')
      return encoded
    }
    const body = Object.fromEntries(Object.entries(settlement).filter(([key]) => key !== 'sha256'))
    settlement.sha256 = createHash('sha256').update(canonical(body)).digest('hex')
    expect(() =>
      joinUmbrellaDiagnosticFrames(
        f.response,
        f.manifest,
        [{ plan: f.batches[0].plan, receipt }, f.batches[1]],
        f.identity,
        new Date().toISOString(),
      ),
    ).toThrow('umbrella_terminal_settlement_join')
  })
})
