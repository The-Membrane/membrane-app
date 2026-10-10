import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'

import { APXUSD_ASSET, APYUSD_ROUTE, APYUSD_VAULT } from '@/lib/carry/apyUsdExit'
import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import type { HolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import {
  projectHolderExitMechanicalOutlook,
  type HolderExitMechanicalRequest,
} from '@/lib/carry/holderExitMechanicalOutlook'
import { ORIGINAL_GHO, UMBRELLA_GHO_ROUTE, UMBRELLA_STKGHO } from '@/lib/carry/umbrellaGhoExit'
import { STAKED_USDAT_ROUTE, STAKED_USDAT_VAULT } from '@/lib/carry/stakedUsdatExit'
import type { SupplementalHolderExitSubject } from '@/lib/carry/holderExitSupplementalRegistry'
import { AUSD_ASSET } from '@/lib/carry/holderExitAssessment'

const owner = '0x1111111111111111111111111111111111111111' as Address
const blockMs = Date.parse('2026-10-07T12:00:00.000Z')
const unix = blockMs / 1000
const market = DIRECT_SUPPLY_MARKETS.aaveV3Usdc
function fixture(
  routeKey = market.routeKey as string,
  destinationAddress = market.destination as Address,
  assetAddress = market.underlying as Address,
): HolderExitAssessment {
  return {
    status: 'assessed',
    routeKey,
    destinationAddress,
    owner,
    request: { assetsRaw: '100', assetAddress, horizonHours: 1 },
    source: {
      chainId: 1,
      blockNumber: 1,
      blockHash: `0x${'a'.repeat(64)}`,
      blockTime: new Date(blockMs).toISOString(),
      originValidation: 'single_provider',
    },
    stages: [
      {
        name: 'withdrawal',
        assetAddress,
        status: 'simulated',
        amountRaw: '100',
        relatedToRequest: true,
      },
    ],
    finalPayout: { assetAddress, status: 'simulated', amountRaw: '100' },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
  }
}
function request(
  a: HolderExitAssessment,
  overrides: Partial<HolderExitMechanicalRequest> = {},
): HolderExitMechanicalRequest {
  return {
    routeKey: a.routeKey,
    destinationAddress: a.destinationAddress,
    owner: a.owner,
    assetAddress: a.request.assetAddress,
    assetsRaw: a.request.assetsRaw,
    nowMs: blockMs,
    horizonSeconds: 3600,
    ...overrides,
  }
}
const project = (a: HolderExitAssessment, overrides: Partial<HolderExitMechanicalRequest> = {}) =>
  projectHolderExitMechanicalOutlook(a, request(a, overrides))
function umbrella() {
  const a = fixture(UMBRELLA_GHO_ROUTE, UMBRELLA_STKGHO, ORIGINAL_GHO)
  a.condition = {
    gate: 'waiting',
    cooldownEnd: unix + 3600,
    windowEndInclusive: unix + 7200,
    currentCooldownSeconds: 3600,
    currentUnstakeWindowSeconds: 3600,
    slashExposure: 'no_slashable_assets',
  }
  a.stages[0].status = 'unassessed'
  a.finalPayout = { assetAddress: ORIGINAL_GHO, status: 'unassessed', amountRaw: null }
  return a
}
function apyWithNativeCurve() {
  const a = fixture(APYUSD_ROUTE, APYUSD_VAULT, APXUSD_ASSET)
  a.request.assetsRaw = '1000000'
  a.stages[0] = {
    name: 'receipt_initiation',
    assetAddress: null,
    status: 'simulated',
    amountRaw: a.request.assetsRaw,
    relatedToRequest: true,
  }
  a.finalPayout = { assetAddress: APXUSD_ASSET, status: 'unassessed', amountRaw: null }
  a.apyUsdCondition = {
    currentFeeCurve: {
      minFeeWad: '10000000000000000',
      maxFeeWad: '50000000000000000',
      minDurationSeconds: 600,
      maxDurationSeconds: 7200,
      curvatureWad: '1000000000000000000',
    },
    currentMinimumClaimDelaySeconds: 600,
    ifInitiatedAtCheckedBlockClaimableAt: unix + 600,
    ifInitiatedAtCheckedBlockEarliestNetRaw: '950000',
    ifInitiatedAtCheckedBlockMinimumFeeAt: unix + 7200,
    ifInitiatedAtCheckedBlockMinimumFeeNetRaw: '990000',
    ifInitiatedAtCheckedBlockHorizonNetRaw: '968181',
    existingReceipt: {
      tokenId: '1000',
      ownership: 'holder',
      escrowRaw: '9000000',
      createdAt: unix - 100000,
      claimableAt: unix - 1000,
      claimableNow: true,
      receiptPaused: false,
      currentFeeRaw: '100000',
      currentPreviewPayoutRaw: '8900000',
      claimSimulation: 'success',
      simulatedClaimPayoutRaw: '8900000',
      delivery: 'not_observed',
    },
  }
  return a
}
const apyClaimProng = (
  a: HolderExitAssessment,
  overrides: Partial<HolderExitMechanicalRequest> = {},
) => project(a, overrides).prongs.find((prong) => prong.id === 'new_q_receipt_claim')!
describe('holder exit mechanical outlook', () => {
  it('projects a conditional atomic baseline beyond source freshness without claiming future payout', () => {
    const result = project(fixture(), { horizonSeconds: 30 * 86400 })
    expect(result.status).toBe('conditional')
    expect(result.requestedQ.atTarget).toBe('conditional_by_target')
    expect(result.currentFinalAssetAmountRaw).toBe('100')
    expect(result.requestedQ.finalAssetAmountRaw).toBeNull()
    expect(result.sourceValidUntil).toBe('2026-10-07T12:30:00.000Z')
    expect(result.conditionalOnUnchangedParameters).toBe(true)
    expect(result.prospectiveValidated).toBe(false)
  })
  it.each([
    { owner: '0x2222222222222222222222222222222222222222' as Address },
    { assetsRaw: '101' },
    { assetsRaw: '0100' },
    { assetsRaw: '-1' },
    { assetAddress: ORIGINAL_GHO },
    { destinationAddress: owner },
    { horizonSeconds: 0 },
    { horizonSeconds: 0.5 },
    { horizonSeconds: Number.MAX_SAFE_INTEGER },
  ])('rejects drift or invalid native quantity/horizon %j', (override) => {
    expect(project(fixture(), override)).toMatchObject({
      status: 'abstain',
      reason: 'binding_invalid',
      prongs: [],
    })
  })
  it('rejects stale and future source stamps and malformed block evidence', () => {
    const a = fixture()
    expect(project(a, { nowMs: blockMs + 1800_001 }).reason).toBe('source_stale')
    expect(project(a, { nowMs: blockMs - 1 }).reason).toBe('source_invalid')
    a.source.blockHash = '0x1'
    expect(project(a).reason).toBe('source_invalid')
  })
  it('composes a known cooldown lower bound without inventing final delivery', () => {
    const a = umbrella()
    const before = project(a, { horizonSeconds: 3599 })
    expect(before.requestedQ.stageEarliestAt).toBe('2026-10-07T13:00:00.000Z')
    expect(before.requestedQ.fullRouteEarliestAt).toBeNull()
    expect(before.requestedQ.atTarget).toBe('after_target')
    expect(project(a).prongs.find((p) => p.id === 'cooldown_window')?.atTarget).toBe(
      'conditional_by_target',
    )
  })
  it('honors the last inclusive window second and its millisecond boundary', () => {
    const a = umbrella()
    expect(
      project(a, { horizonSeconds: 7200 }).prongs.find((p) => p.id === 'cooldown_window')?.atTarget,
    ).toBe('conditional_by_target')
    expect(
      project(a, { nowMs: blockMs + 999, horizonSeconds: 7200 }).prongs.find(
        (p) => p.id === 'cooldown_window',
      )?.atTarget,
    ).toBe('conditional_by_target')
    expect(project(a, { nowMs: blockMs + 1000, horizonSeconds: 7200 }).requestedQ.atTarget).toBe(
      'window_expired_by_target',
    )
  })
  it('does not promise a pause release or erase the time of other attested prongs', () => {
    const a = umbrella()
    a.condition!.gate = 'paused'
    const result = project(a)
    expect(result.requestedQ.atTarget).toBe('restriction_release_unknown')
    expect(result.requestedQ.fullRouteEarliestAt).toBeNull()
  })
  it('keeps a new sUSDe cooldown separate from pending entitlement and pending reset', () => {
    const a = fixture(
      'USDe → Staked USDe [USDe]',
      '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497',
      '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
    )
    a.status = 'partial'
    a.stages = [
      {
        name: 'cooldown_initiation',
        assetAddress: a.request.assetAddress,
        amountRaw: '100',
        relatedToRequest: true,
        status: 'simulated',
      },
    ]
    a.finalPayout.status = 'unassessed'
    a.finalPayout.amountRaw = null
    a.cooldownCondition = {
      exitMode: 'cooldown',
      durationSeconds: 7200,
      pendingAssetsRaw: '999',
      aggregateSiloUsdeRaw: '1000000',
      pendingClaimEarliestAt: '2026-10-07T12:10:00.000Z',
      initiationStatus: 'success',
      directWithdrawalStatus: null,
      pendingClaimStatus: 'not_yet_eligible',
      newRequestWouldResetPending: true,
      ifInitiatedAtCheckedBlockEarliestAt: '2026-10-07T14:00:00.000Z',
    }
    const result = project(a)
    expect(result.pendingReset).toBe(true)
    expect(result.requestedQ.stageEarliestAt).toBe('2026-10-07T14:00:00.000Z')
    expect(result.prongs.find((p) => p.id === 'existing_pending_claim')).toMatchObject({
      scope: 'independent_entitlement',
      amountRaw: '999',
    })
    expect(result.requestedQ.fullRouteEarliestAt).toBeNull()
    a.cooldownCondition.initiationStatus = 'evm_revert'
    expect(project(a).prongs.find((p) => p.id === 'new_q_cooldown_claim')?.earliestAt).toBeNull()
  })
  it('keeps Apy fee endpoints in native units without interpolating an unattested curve', () => {
    const a = fixture(APYUSD_ROUTE, APYUSD_VAULT, APXUSD_ASSET)
    a.stages[0].name = 'receipt_initiation'
    a.finalPayout.status = 'unassessed'
    a.apyUsdCondition = {
      currentFeeCurve: null,
      existingReceipt: null,
      currentMinimumClaimDelaySeconds: 600,
      ifInitiatedAtCheckedBlockClaimableAt: unix + 600,
      ifInitiatedAtCheckedBlockEarliestNetRaw: '95',
      ifInitiatedAtCheckedBlockMinimumFeeAt: unix + 7200,
      ifInitiatedAtCheckedBlockMinimumFeeNetRaw: '99',
      ifInitiatedAtCheckedBlockHorizonNetRaw: '97',
    }
    const fee = (horizonSeconds: number) =>
      project(a, { horizonSeconds }).prongs.find((p) => p.id === 'new_q_receipt_claim')!
    expect(fee(600)).toMatchObject({ amountRaw: '95', feeRaw: '5' })
    expect(fee(3600)).toMatchObject({ amountRaw: '97', feeRaw: '3' })
    expect(fee(1000)).toMatchObject({ amountRaw: null, feeRaw: null })
    expect(fee(8000)).toMatchObject({ amountRaw: '99', feeRaw: '1' })
    a.apyUsdCondition.ifInitiatedAtCheckedBlockMinimumFeeNetRaw = '101'
    expect(fee(8000)).toMatchObject({ amountRaw: null, feeRaw: null, feeMinimumNetRaw: null })
  })
  it.each([
    [600, '950000', '50000'],
    [1800, '957272', '42728'],
    [3600, '968181', '31819'],
    [3900, '970000', '30000'],
    [7200, '990000', '10000'],
    [8000, '990000', '10000'],
  ] as const)(
    'projects the validated Apy native curve at %s seconds from checked-block initiation',
    (horizonSeconds, amountRaw, feeRaw) => {
      const a = apyWithNativeCurve()
      expect(apyClaimProng(a, { horizonSeconds })).toMatchObject({
        scope: 'requested_q',
        amountRaw,
        feeRaw,
        earliestAt: new Date(blockMs + 600000).toISOString(),
        feeMinimumAt: new Date(blockMs + 7200000).toISOString(),
        feeMinimumNetRaw: '990000',
      })
      expect(project(a, { horizonSeconds }).requestedQ.finalAssetAmountRaw).toBeNull()
    },
  )
  it('includes response-source offset in elapsed Apy time without moving the initiation clock', () => {
    const a = apyWithNativeCurve()
    const direct = apyClaimProng(a, { horizonSeconds: 3900 })
    const offset = project(a, { nowMs: blockMs + 300000, horizonSeconds: 3600 })
    expect(offset.targetAt).toBe(new Date(blockMs + 3900000).toISOString())
    expect(offset.prongs.find((prong) => prong.id === 'new_q_receipt_claim')).toEqual(direct)
    expect(offset.source.blockTime).toBe(a.source.blockTime)
  })
  it.each([
    [999, 599, null, null, 'after_target'],
    [0, 600, '950000', '50000', 'conditional_by_target'],
    [999, 600, '950000', '50000', 'conditional_by_target'],
    [1000, 600, '950006', '49994', 'conditional_by_target'],
  ] as const)(
    'uses contract clock seconds at the Apy minimum boundary with offset %s and horizon %s',
    (offsetMs, horizonSeconds, amountRaw, feeRaw, atTarget) => {
      const a = apyWithNativeCurve()
      const result = project(a, { nowMs: blockMs + offsetMs, horizonSeconds })
      expect(result.targetAt).toBe(
        new Date(blockMs + offsetMs + horizonSeconds * 1000).toISOString(),
      )
      expect(result.prongs.find((prong) => prong.id === 'new_q_receipt_claim')).toMatchObject({
        amountRaw,
        feeRaw,
        atTarget,
      })
      expect(a.apyUsdCondition?.ifInitiatedAtCheckedBlockClaimableAt).toBe(unix + 600)
    },
  )
  it('projects a supported quadratic Apy interior with exact native integer rounding', () => {
    const a = apyWithNativeCurve()
    a.apyUsdCondition!.currentFeeCurve!.curvatureWad = '2000000000000000000'
    expect(apyClaimProng(a, { horizonSeconds: 3900 })).toMatchObject({
      amountRaw: '960000',
      feeRaw: '40000',
    })
  })
  it.each(['missing', 'null', 'invalid'] as const)(
    'preserves legacy Apy endpoints when the current curve is %s',
    (kind) => {
      const a = apyWithNativeCurve()
      if (kind === 'missing') Reflect.deleteProperty(a.apyUsdCondition!, 'currentFeeCurve')
      else if (kind === 'null') a.apyUsdCondition!.currentFeeCurve = null
      else a.apyUsdCondition!.currentFeeCurve!.curvatureWad = '0'
      expect(apyClaimProng(a, { horizonSeconds: 3600 })).toMatchObject({
        amountRaw: '968181',
        feeRaw: '31819',
      })
      expect(apyClaimProng(a, { horizonSeconds: 3900 })).toMatchObject({
        amountRaw: null,
        feeRaw: null,
      })
      expect(apyClaimProng(a, { horizonSeconds: 600 })).toMatchObject({
        amountRaw: '950000',
        feeRaw: '50000',
      })
      expect(apyClaimProng(a, { horizonSeconds: 7200 })).toMatchObject({
        amountRaw: '990000',
        feeRaw: '10000',
      })
    },
  )
  it.each(['minimum_delay', 'claimable_clock', 'minimum_fee_clock'] as const)(
    'requires coherent Apy %s before applying the current curve to new Q',
    (field) => {
      const a = apyWithNativeCurve()
      if (field === 'minimum_delay') a.apyUsdCondition!.currentMinimumClaimDelaySeconds = 601
      else if (field === 'claimable_clock')
        a.apyUsdCondition!.ifInitiatedAtCheckedBlockClaimableAt = unix + 601
      else a.apyUsdCondition!.ifInitiatedAtCheckedBlockMinimumFeeAt = unix + 7201
      expect(apyClaimProng(a, { horizonSeconds: 1800 })).toMatchObject({
        amountRaw: null,
        feeRaw: null,
      })
      expect(apyClaimProng(a, { horizonSeconds: 3600 })).toMatchObject({
        amountRaw: '968181',
        feeRaw: '31819',
      })
    },
  )
  it('leaves a coherent unsupported Apy interior null even at the old saved horizon', () => {
    const a = apyWithNativeCurve()
    a.apyUsdCondition!.currentFeeCurve!.curvatureWad = '1500000000000000000'
    expect(apyClaimProng(a, { horizonSeconds: 3600 })).toMatchObject({
      amountRaw: null,
      feeRaw: null,
    })
    expect(apyClaimProng(a, { horizonSeconds: 600 })).toMatchObject({
      amountRaw: '950000',
      feeRaw: '50000',
    })
    expect(apyClaimProng(a, { horizonSeconds: 7200 })).toMatchObject({
      amountRaw: '990000',
      feeRaw: '10000',
    })
  })
  it('does not project new Apy Q after a failed checked-block initiation', () => {
    const a = apyWithNativeCurve()
    a.stages[0].status = 'reverted'
    expect(apyClaimProng(a, { horizonSeconds: 3900 })).toMatchObject({
      earliestAt: null,
      amountRaw: null,
      feeRaw: null,
    })
  })
  it('leaves old Apy receipt E and creation-clock facts untouched by the new-Q current curve', () => {
    const a = apyWithNativeCurve()
    const saved = structuredClone(a.apyUsdCondition!.existingReceipt)
    const initial = apyClaimProng(a, { horizonSeconds: 3900 })
    expect(a.apyUsdCondition!.existingReceipt).toEqual(saved)
    a.apyUsdCondition!.existingReceipt!.escrowRaw = '80000000'
    a.apyUsdCondition!.existingReceipt!.createdAt = unix - 700000
    expect(apyClaimProng(a, { horizonSeconds: 3900 })).toEqual(initial)
    expect(a.apyUsdCondition!.existingReceipt).toEqual({
      ...saved,
      escrowRaw: '80000000',
      createdAt: unix - 700000,
    })
    expect(initial.amountRaw).toBe('970000')
  })
  it('never turns an independent owned staked USDat ticket into original AUSD Q eligibility', () => {
    const a = fixture(STAKED_USDAT_ROUTE, STAKED_USDAT_VAULT, AUSD_ASSET)
    a.status = 'partial'
    a.stages = []
    a.finalPayout.status = 'unassessed'
    a.stakedUsdatCondition = {
      requestedSharesRaw: '123',
      previewUsdatRaw: '120',
      queueRequestStatus: 'success',
      simulatedQueueTicketId: '1',
      existingTicketId: '2',
      existingTicketOwnership: 'holder',
      existingTicketClaimStatus: 'success',
      existingTicketRequestedAtUnix: `${unix - 1}`,
      existingTicketConversionQuote: null,
      existingTicketRequestedLimit: null,
    }
    const result = project(a)
    expect(result.prongs.find((p) => p.id === 'existing_ticket_eligibility')).toMatchObject({
      scope: 'independent_entitlement',
      earliestAt: a.source.blockTime,
    })
    expect(result.requestedQ).toMatchObject({
      fullRouteEarliestAt: null,
      finalAssetAmountRaw: null,
      atTarget: 'unattested',
    })
  })
  it('ignores foreign condition families rather than projecting their timers', () => {
    const a = fixture()
    a.condition = umbrella().condition
    const result = project(a)
    expect(result.mechanismFamily).toBe('atomic')
    expect(result.prongs.some((p) => p.id === 'cooldown_window')).toBe(false)
  })
  it('accepts a verified registered future atomic subject and rejects replayed or unverified evidence', () => {
    const a = fixture('future_exact_route', owner)
    const missing = { state: 'unavailable' as const, adapterId: null, evidenceRef: null }
    const ref = { sourceId: 'exact-assessment', contentSha256: `sha256:${'a'.repeat(64)}` }
    const descriptor: SupplementalHolderExitSubject = {
      subjectVersion: '1',
      protocolId: 'future',
      chainId: 1,
      routeKey: a.routeKey,
      routeVersion: '1',
      destinationAddress: owner,
      contractIdentity: {
        kind: 'direct',
        destinationCodeHash: a.source.blockHash,
        receipt: {
          ...ref,
          chainId: 1,
          blockNumber: 1,
          blockHash: a.source.blockHash,
          destinationAddress: owner,
          destinationCodeHash: a.source.blockHash,
          implementationAddress: null,
          implementationCodeHash: null,
        },
        implementationAddress: null,
        implementationCodeHash: null,
      },
      inputAsset: { address: a.request.assetAddress, decimals: 6 },
      finalPayoutAsset: { address: a.request.assetAddress, decimals: 6 },
      mechanism: 'atomic',
      stages: [
        {
          stageId: 'withdrawal',
          kind: 'atomic_exit',
          adapterId: 'future-withdraw',
          adapterVersion: '1',
          inputAssetAddress: a.request.assetAddress,
          outputAssetAddress: a.request.assetAddress,
        },
      ],
      currentObservation: {
        state: 'evidence_recorded',
        adapterId: 'future-holder',
        evidenceRef: ref,
        kind: 'exact_holder_final_payout',
      },
      historicalAssay: {
        ...missing,
        family: 'exact_target_ability',
        holderSelectionVersion: '1',
        fixedQRaw: ['100'],
        horizonSeconds: [3600],
      },
      grossFlow: {
        deposits: missing,
        withdrawals: missing,
        net: missing,
        intervalMaximum: missing,
        endpointReconciliation: missing,
        intervalSeconds: 3600,
      },
      expectedFlow: { semantics: 'unavailable', unitAssetAddress: a.request.assetAddress },
      maximumFlow: { semantics: 'unavailable', unitAssetAddress: a.request.assetAddress },
      newsEventSources: { state: 'unavailable', sources: [] },
      validationState: 'not_started',
    }
    const run = (verified: boolean) =>
      projectHolderExitMechanicalOutlook(a, request(a), {
        subject: descriptor,
        verifyEvidence: () => verified,
      })
    expect(project(a)).toMatchObject({ status: 'abstain', mechanismFamily: 'unregistered' })
    expect(run(true)).toMatchObject({
      status: 'conditional',
      mechanismFamily: 'atomic',
      prospectiveValidated: false,
    })
    expect(run(false).status).toBe('abstain')
    descriptor.contractIdentity.receipt.blockNumber = 2
    expect(run(true).status).toBe('abstain')
  })
  it.each([['100'], { toString: () => '100' }, new String('100')])(
    'rejects shared malformed request and assessment Q without coercion %j',
    (invalid) => {
      const a = fixture()
      const q = invalid as unknown as string
      a.request.assetsRaw = q
      a.stages[0].amountRaw = q
      a.finalPayout.amountRaw = q
      const before = JSON.stringify(a)
      expect(project(a, { assetsRaw: q })).toMatchObject({
        status: 'abstain',
        reason: 'binding_invalid',
        currentFinalAssetAmountRaw: null,
      })
      expect(JSON.stringify(a)).toBe(before)
    },
  )
  it.each(['stage', 'final'] as const)(
    'rejects a singleton-array native amount in %s evidence',
    (where) => {
      const a = fixture()
      if (where === 'stage') a.stages[0].amountRaw = ['100'] as unknown as string
      else a.finalPayout.amountRaw = ['100'] as unknown as string
      expect(project(a)).toMatchObject({ status: 'abstain', reason: 'binding_invalid' })
    },
  )
  it.each([
    ['blockTime', [new Date(blockMs).toISOString()]],
    ['blockTime', { toString: () => new Date(blockMs).toISOString() }],
    ['blockTime', new Date(blockMs)],
    ['blockHash', [`0x${'a'.repeat(64)}`]],
    ['blockHash', { toString: () => `0x${'a'.repeat(64)}` }],
    ['blockNumber', [1]],
    ['blockNumber', '1'],
    ['chainId', [1]],
  ])('rejects malformed source %s without canonicalizing it', (field, invalid) => {
    const a = fixture()
    ;(a.source as unknown as Record<string, unknown>)[field as string] = invalid
    const before = JSON.stringify(a)
    expect(project(a)).toMatchObject({ status: 'abstain', reason: 'source_invalid', prongs: [] })
    expect(JSON.stringify(a)).toBe(before)
  })
  it.each(['owner', 'assetAddress', 'destinationAddress'] as const)(
    'rejects boxed or array addresses for %s',
    (field) => {
      const a = fixture()
      const r = request(a)
      r[field] = [r[field]] as unknown as Address
      expect(projectHolderExitMechanicalOutlook(a, r)).toMatchObject({
        status: 'abstain',
        reason: 'binding_invalid',
      })
    },
  )
  it('keeps missing or malformed mandatory Umbrella windows unattested while preserving the current payout baseline', () => {
    const a = umbrella()
    a.condition!.gate = 'window_open'
    a.condition!.cooldownEnd = unix
    a.condition!.windowEndInclusive = unix + 600
    a.stages[0].status = 'simulated'
    a.finalPayout.status = 'simulated'
    a.finalPayout.amountRaw = '100'
    expect(project(a, { horizonSeconds: 30 * 86400 }).requestedQ.atTarget).toBe(
      'window_expired_by_target',
    )
    delete a.condition
    const missing = project(a, { horizonSeconds: 30 * 86400 })
    expect(missing.currentFinalAssetAmountRaw).toBe('100')
    expect(missing.requestedQ).toMatchObject({ fullRouteEarliestAt: null, atTarget: 'unattested' })
    a.condition = umbrella().condition
    a.condition!.cooldownEnd = [unix] as unknown as number
    expect(project(a).requestedQ.fullRouteEarliestAt).toBeNull()
  })
  it('does not promote missing Apy mandatory receipt mechanics into complete future eligibility', () => {
    const a = fixture(APYUSD_ROUTE, APYUSD_VAULT, APXUSD_ASSET)
    expect(project(a).requestedQ.fullRouteEarliestAt).toBeNull()
    expect(project(a).currentFinalAssetAmountRaw).toBe('100')
  })
  it.each([undefined, 'evm_revert', 'unknown', ['simulated'], { toString: () => 'simulated' }])(
    'rejects missing or foreign final payout status %j with a non-null amount',
    (invalid) => {
      const a = fixture()
      a.finalPayout.status = invalid as unknown as HolderExitAssessment['finalPayout']['status']
      expect(project(a)).toMatchObject({
        status: 'abstain',
        reason: 'binding_invalid',
        currentFinalAssetAmountRaw: null,
        requestedQ: { fullRouteEarliestAt: null, atTarget: 'unattested' },
      })
    },
  )
  it.each(['simulated', 'mined_observed'] as const)(
    'preserves an explicit %s current payout baseline',
    (status) => {
      const a = fixture()
      a.finalPayout.status = status
      expect(project(a)).toMatchObject({
        status: 'conditional',
        currentFinalAssetAmountRaw: '100',
        requestedQ: {
          fullRouteEarliestAt: a.source.blockTime,
          atTarget: 'conditional_by_target',
          finalAssetAmountRaw: null,
        },
      })
    },
  )
  it('clones provenance and never mutates source assessments', () => {
    const a = umbrella()
    const before = JSON.stringify(a)
    const result = project(a)
    result.source.blockTime = 'changed'
    expect(JSON.stringify(a)).toBe(before)
  })
})
