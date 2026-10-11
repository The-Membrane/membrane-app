import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import workbench from '../../components/Carry/ForecastWorkbench.tsx'
import umbrellaOutlook from '../../lib/carry/umbrellaWindowOutlook.ts'
import assessmentModule from '../../lib/carry/holderExitAssessment.ts'
import morphoJointFixtureModule from './fixtures/morphoV2JointHolderForecastFixture.ts'
import morphoLegacyFixtureModule from './fixtures/morphoV2HolderForecastFixture.ts'
import morphoJointBindingModule from '../../lib/carry/morphoV2JointHolderForecastBinding.ts'
import susdeBindingModule from '../../lib/carry/susdeHolderForecastBinding.ts'

const { isCurrentHolderExitAssessment } = assessmentModule

const {
  isHolderWatchStatus,
  isCanonicalFixedVaultExitObservation,
  isRecentExitCheck,
  isLocalHolderWatchHostname,
  isMatchingHolderExitAssessment,
  withMatchingHolderMechanicalOutlook,
  elapsedAtSourceBlock,
  resolvedMorphoAssessmentTarget,
  splitHolderExitStages,
  holderTimeProcessIssueFromResponse,
  holderMorphoV2PositionEvidenceFromResponse,
} = workbench
const { umbrellaWindowAtHorizon } = umbrellaOutlook
const { createMorphoV2JointHolderForecastFixture } = morphoJointFixtureModule
const { createMorphoV2HolderForecastFixture } = morphoLegacyFixtureModule
const { selectedMorphoV2JointHolderForecastIssue } = morphoJointBindingModule
const { holderExitRequestCanPublish } = susdeBindingModule

for (const asset of ['USDC', 'USDT'])
  for (const status of [200, 503]) {
    test(`workbench retains private ${asset} joint receipt and three native channels on HTTP${status}`, () => {
      const f = createMorphoV2JointHolderForecastFixture(asset, '123', true, 48)
      const response = {
        ...f.response,
        ...(status === 503 ? { error: 'holder_exit_assessment_unavailable' } : {}),
      }
      const position = holderMorphoV2PositionEvidenceFromResponse(response, status)
      assert.equal(position.holder, f.compactHolder)
      assert.equal(position.historical, f.compactHistorical)
      const issue = holderTimeProcessIssueFromResponse(
        response,
        status,
        f.question,
        null,
        null,
        f.expected.source,
      )
      assert.ok(issue)
      assert.equal(selectedMorphoV2JointHolderForecastIssue(issue, f.question), issue)
      assert.equal(issue.sharesRaw, '123')
      assert.equal(issue.fullEaRaw, '10587996327')
      assert.equal(issue.issuedAtMs, f.question.asOfMs)
      const changedHorizon = { ...f.question, horizonHours: 24 }
      assert.equal(selectedMorphoV2JointHolderForecastIssue(issue, changedHorizon), null)
      const freshIssue = holderTimeProcessIssueFromResponse(
        response,
        status,
        changedHorizon,
        null,
        null,
        f.expected.source,
      )
      assert.ok(freshIssue)
      assert.equal(freshIssue.horizonHours, 24)
      assert.equal(selectedMorphoV2JointHolderForecastIssue(freshIssue, changedHorizon), freshIssue)
      const sourceExpiry = Date.parse(issue.source.blockTime) + 30 * 60_000
      assert.equal(selectedMorphoV2JointHolderForecastIssue(issue, f.question, sourceExpiry), issue)
      assert.equal(
        selectedMorphoV2JointHolderForecastIssue(issue, f.question, sourceExpiry + 1),
        null,
      )
      for (const q of [
        { ...f.question, requestedRaw: '1' },
        { ...f.question, requestedHolderAddress: `0x${'c'.repeat(40)}` },
        { ...f.question, requestedAssetDecimals: 18 },
      ])
        assert.equal(
          holderTimeProcessIssueFromResponse(response, status, q, null, null, f.expected.source),
          null,
        )
      assert.equal(
        holderTimeProcessIssueFromResponse(
          response,
          500,
          f.question,
          null,
          null,
          f.expected.source,
        ),
        null,
      )
      assert.deepEqual(holderMorphoV2PositionEvidenceFromResponse(response, 500), {
        holder: null,
        historical: null,
      })
    })
  }

test('workbench allows legacy USDC only when both joint channels are absent', () => {
  const f = createMorphoV2HolderForecastFixture()
  assert.ok(holderTimeProcessIssueFromResponse(f.response, 200, f.question, null, null))
  for (const channel of [
    'morphoV2CurrentHolderPositionEvidence',
    'morphoV2HistoricalHolderEaEvidence',
  ]) {
    for (const invalid of [null, '', '{}', { approved: true }]) {
      assert.equal(
        holderTimeProcessIssueFromResponse(
          { ...f.response, [channel]: invalid },
          200,
          f.question,
          null,
          null,
        ),
        null,
      )
    }
  }
})

test('optional Morpho evidence publication remains bound to the current non-aborted request', () => {
  const first = new AbortController(),
    second = new AbortController()
  assert.equal(holderExitRequestCanPublish(first, first), true)
  assert.equal(holderExitRequestCanPublish(first, second), false)
  first.abort()
  assert.equal(holderExitRequestCanPublish(first, first), false)
  assert.equal(holderExitRequestCanPublish(second, second), true)
})

test('Umbrella scheduled window is evaluated at the selected horizon', () => {
  const blockTime = '2026-10-02T00:00:00.000Z'
  const start = Date.parse(blockTime) / 1000 + 3600
  const end = Date.parse(blockTime) / 1000 + 2 * 3600
  assert.equal(umbrellaWindowAtHorizon(blockTime, start, end, 0), '+0h: cooldown waiting')
  assert.equal(umbrellaWindowAtHorizon(blockTime, start, end, 1), '+1h: within scheduled window')
  assert.equal(umbrellaWindowAtHorizon(blockTime, start, end, 2), '+2h: within scheduled window')
  assert.equal(umbrellaWindowAtHorizon(blockTime, start, end, 3), '+3h: scheduled window closed')
  assert.equal(umbrellaWindowAtHorizon('invalid', start, end, 3), null)
})

test('queue age uses pinned source time and rejects absent or future timestamps', () => {
  const blockTime = '2026-10-01T00:00:00.000Z'
  const sourceSeconds = Date.parse(blockTime) / 1000
  assert.equal(elapsedAtSourceBlock(String(sourceSeconds - 27 * 3600), blockTime), '1d 3h')
  assert.equal(elapsedAtSourceBlock(String(sourceSeconds - 65 * 60), blockTime), '1h 5m')
  assert.equal(elapsedAtSourceBlock('0', blockTime), null)
  assert.equal(elapsedAtSourceBlock(String(sourceSeconds + 1), blockTime), null)
  assert.equal(elapsedAtSourceBlock('garbage', blockTime), null)
})

test('only claims from an earlier request leave the current route stage group', () => {
  const stages = [
    { name: 'queue_request', relatedToRequest: false },
    { name: 'pt_redemption', relatedToRequest: false },
    { name: 'usdc_vault_withdrawal', relatedToRequest: false },
    { name: 'usdt_delivery', relatedToRequest: true },
    { name: 'pending_claim', relatedToRequest: false },
    { name: 'receipt_claim', relatedToRequest: false },
    { name: 'existing_ticket_claim', relatedToRequest: false },
  ]
  const grouped = splitHolderExitStages(stages)
  assert.deepEqual(
    grouped.routeStages.map((stage) => stage.name),
    ['queue_request', 'pt_redemption', 'usdc_vault_withdrawal', 'usdt_delivery'],
  )
  assert.deepEqual(
    grouped.existingClaimStages.map((stage) => stage.name),
    ['pending_claim', 'receipt_claim', 'existing_ticket_claim'],
  )
})
const morphoIdentities = JSON.parse(
  readFileSync(new URL('../../lib/carry/morpho-v2-asset-identities.json', import.meta.url), 'utf8'),
)
const cohort = JSON.parse(
  readFileSync(
    new URL('../../scripts/route-cohort/aug-2026-ab-vault-seed.json', import.meta.url),
    'utf8',
  ),
)
const routeKey = 'USDC → supply on Aave V3'
const destinationAddress = '0x1111111111111111111111111111111111111111'
const owner = '0x2222222222222222222222222222222222222222'
const payoutAsset = '0x3333333333333333333333333333333333333333'
const request = {
  routeKey,
  destinationAddress,
  owner,
  assetsRaw: '25000000',
  horizonHours: 24,
  payoutAsset,
  kind: 'direct',
}
const direct = {
  status: 'assessed',
  routeKey,
  destinationAddress,
  owner,
  request: { assetsRaw: request.assetsRaw, assetAddress: payoutAsset, horizonHours: 24 },
  source: {
    chainId: 1,
    blockNumber: 26_000_000,
    blockHash: `0x${'a'.repeat(64)}`,
    blockTime: '2026-10-01T00:00:00.000Z',
    originValidation: 'two_provider',
  },
  stages: [
    {
      name: 'withdrawal',
      assetAddress: payoutAsset,
      status: 'simulated',
      amountRaw: request.assetsRaw,
      relatedToRequest: true,
    },
  ],
  finalPayout: { assetAddress: payoutAsset, status: 'simulated', amountRaw: request.assetsRaw },
  forecast: {
    status: 'unvalidated',
    futureExit: null,
    exitDurationHours: null,
    prospectiveValidated: false,
  },
}

test('current exit checks expire on block age even when the request tuple is unchanged', () => {
  const blockTime = '2026-10-01T00:00:00.000Z'
  const blockMs = Date.parse(blockTime)
  assert.equal(isRecentExitCheck(blockTime, blockMs), true)
  assert.equal(isRecentExitCheck(blockTime, blockMs + 30 * 60_000), true)
  assert.equal(isRecentExitCheck(blockTime, blockMs + 30 * 60_000 + 1), false)
  assert.equal(isRecentExitCheck(blockTime, blockMs - 1), false)
  assert.equal(isRecentExitCheck('invalid', blockMs), false)
})

test('direct assessment must match chosen owner, size, horizon, destination, and payout', () => {
  assert.equal(isMatchingHolderExitAssessment(direct, request), true)
  for (const changed of [
    { owner: '0x4444444444444444444444444444444444444444' },
    { assetsRaw: '26000000' },
    { horizonHours: 1 },
    { destinationAddress: '0x5555555555555555555555555555555555555555' },
    { payoutAsset: '0x6666666666666666666666666666666666666666' },
  ])
    assert.equal(isMatchingHolderExitAssessment(direct, { ...request, ...changed }), false)
  assert.equal(
    isMatchingHolderExitAssessment(
      { ...direct, forecast: { ...direct.forecast, prospectiveValidated: true } },
      request,
    ),
    false,
  )
})

test('tracked direct vault assessment keeps its exact payout asset and unvalidated horizon', () => {
  const trackedRequest = {
    ...request,
    routeKey: 'USDS → StUsds [USDS]',
    destinationAddress: '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9',
    payoutAsset: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
    kind: 'tracked',
  }
  const tracked = {
    ...direct,
    routeKey: trackedRequest.routeKey,
    destinationAddress: trackedRequest.destinationAddress,
    request: { ...direct.request, assetAddress: trackedRequest.payoutAsset },
    stages: [{ ...direct.stages[0], assetAddress: trackedRequest.payoutAsset }],
    finalPayout: { ...direct.finalPayout, assetAddress: trackedRequest.payoutAsset },
  }
  assert.equal(isMatchingHolderExitAssessment(tracked, trackedRequest), true)
  assert.equal(
    isMatchingHolderExitAssessment(tracked, { ...trackedRequest, assetsRaw: '26000000' }),
    false,
  )
  assert.equal(
    isMatchingHolderExitAssessment(tracked, { ...trackedRequest, horizonHours: 1 }),
    false,
  )
})

test('sGHO, sUSDS, and USD3 use the common exact holder withdrawal contract', () => {
  for (const kind of ['sgho', 'susds', 'usd3']) {
    assert.equal(isMatchingHolderExitAssessment(direct, { ...request, kind }), true)
    assert.equal(
      isMatchingHolderExitAssessment(direct, { ...request, kind, assetsRaw: '26000000' }),
      false,
    )
    assert.equal(
      isMatchingHolderExitAssessment(direct, { ...request, kind, horizonHours: 1 }),
      false,
    )
  }
})

test('fixed vault routes require exact vault, asset, and decimals before amount conversion', () => {
  for (const [route, vault, asset, decimals] of [
    [
      'USDS → SUsds [USDS]',
      '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd',
      '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
      18,
    ],
    [
      'USDC → USD3 [USDC]',
      '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc',
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      6,
    ],
    [
      'USDe → Staked USDe [USDe]',
      '0x9d39a5de30e57443bff2a8307a4256c8797a3497',
      '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
      18,
    ],
  ]) {
    const selected = {
      vault,
      asset,
      assetDecimals: decimals,
      source: 'finalized_erc4626',
      routeAssetIdentity: 'confirmed',
    }
    // Fixtures must match the frozen contracts; if they change, update the route mapping first.
    assert.equal(isCanonicalFixedVaultExitObservation(route, vault, selected), true)
    assert.equal(isCanonicalFixedVaultExitObservation(route, owner, selected), false)
    assert.equal(
      isCanonicalFixedVaultExitObservation(route, vault, { ...selected, asset: owner }),
      false,
    )
    assert.equal(
      isCanonicalFixedVaultExitObservation(route, vault, {
        ...selected,
        assetDecimals: decimals + 1,
      }),
      false,
    )
  }
})

test('Umbrella only accepts Q-sized payout inside the current open window', () => {
  const umbrellaRequest = {
    ...request,
    routeKey: 'GHO → UmbrellaStakeToken [GHO]',
    destinationAddress: '0x4f827a63755855cdf3e8f3bcd20265c833f15033',
    payoutAsset: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
    kind: 'umbrella_gho',
  }
  const condition = {
    gate: 'window_open',
    cooldownEnd: 1790810000,
    windowEndInclusive: 1790820000,
    currentCooldownSeconds: 100,
    currentUnstakeWindowSeconds: 1000,
    slashExposure: 'no_slashable_assets',
  }
  const umbrella = {
    ...direct,
    routeKey: umbrellaRequest.routeKey,
    destinationAddress: umbrellaRequest.destinationAddress,
    request: { ...direct.request, assetAddress: umbrellaRequest.payoutAsset },
    stages: [
      {
        name: 'redeem',
        assetAddress: umbrellaRequest.payoutAsset,
        status: 'simulated',
        amountRaw: request.assetsRaw,
        relatedToRequest: true,
      },
    ],
    finalPayout: {
      assetAddress: umbrellaRequest.payoutAsset,
      status: 'simulated',
      amountRaw: '25000001',
    },
    condition,
  }
  assert.equal(isMatchingHolderExitAssessment(umbrella, umbrellaRequest), true)
  assert.equal(
    isMatchingHolderExitAssessment(
      { ...umbrella, condition: { ...condition, windowEndInclusive: null } },
      umbrellaRequest,
    ),
    false,
  )
  assert.equal(
    isMatchingHolderExitAssessment(
      { ...umbrella, condition: { ...condition, gate: 'waiting' } },
      umbrellaRequest,
    ),
    false,
  )
  assert.equal(
    isMatchingHolderExitAssessment(
      { ...umbrella, finalPayout: { ...umbrella.finalPayout, amountRaw: '24999999' } },
      umbrellaRequest,
    ),
    false,
  )
  assert.equal(
    isMatchingHolderExitAssessment({ ...umbrella, owner: payoutAsset }, umbrellaRequest),
    false,
  )
  const sourceMs = Date.parse(umbrella.source.blockTime)
  const shortWindow = {
    ...umbrella,
    condition: { ...condition, windowEndInclusive: Math.floor((sourceMs + 2 * 60_000) / 1000) },
  }
  assert.equal(isCurrentHolderExitAssessment(shortWindow, sourceMs + 60_000), true)
  assert.equal(isCurrentHolderExitAssessment(shortWindow, sourceMs + 5 * 60_000), false)
})

test('sUSDe keeps new cooldown Q separate from an older claim and expires at eligibility', () => {
  const susdeRequest = {
    ...request,
    routeKey: 'USDe → Staked USDe [USDe]',
    destinationAddress: '0x9d39a5de30e57443bff2a8307a4256c8797a3497',
    payoutAsset: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
    kind: 'susde',
  }
  const sourceMs = Date.parse(direct.source.blockTime)
  const earliest = new Date(sourceMs + 2 * 60_000).toISOString()
  const susde = {
    ...direct,
    status: 'partial',
    source: { ...direct.source, originValidation: 'two_provider' },
    routeKey: susdeRequest.routeKey,
    destinationAddress: susdeRequest.destinationAddress,
    request: { ...direct.request, assetAddress: susdeRequest.payoutAsset },
    stages: [
      {
        name: 'cooldown_initiation',
        assetAddress: susdeRequest.payoutAsset,
        status: 'simulated',
        amountRaw: request.assetsRaw,
        relatedToRequest: true,
      },
      {
        name: 'pending_claim',
        assetAddress: susdeRequest.payoutAsset,
        status: 'unassessed',
        amountRaw: '50000000',
        relatedToRequest: false,
      },
    ],
    finalPayout: { assetAddress: susdeRequest.payoutAsset, status: 'unassessed', amountRaw: null },
    cooldownCondition: {
      exitMode: 'cooldown',
      directWithdrawalStatus: null,
      durationSeconds: 604800,
      pendingAssetsRaw: '50000000',
      aggregateSiloUsdeRaw: '17000000000000000000',
      pendingClaimEarliestAt: earliest,
      initiationStatus: 'success',
      pendingClaimStatus: 'not_yet_eligible',
      newRequestWouldResetPending: true,
      ifInitiatedAtCheckedBlockEarliestAt: new Date(sourceMs + 604800000).toISOString(),
    },
  }
  assert.equal(isMatchingHolderExitAssessment(susde, susdeRequest), true)
  assert.equal(
    isMatchingHolderExitAssessment(
      { ...susde, source: { ...susde.source, originValidation: 'single_provider' } },
      susdeRequest,
    ),
    false,
  )
  assert.equal(
    isMatchingHolderExitAssessment(
      {
        ...susde,
        cooldownCondition: { ...susde.cooldownCondition, aggregateSiloUsdeRaw: undefined },
      },
      susdeRequest,
    ),
    false,
  )
  assert.equal(isCurrentHolderExitAssessment(susde, sourceMs + 60_000), true)
  assert.equal(isCurrentHolderExitAssessment(susde, sourceMs + 3 * 60_000), false)
  assert.equal(
    isMatchingHolderExitAssessment(
      { ...susde, stages: [susde.stages[0], { ...susde.stages[1], relatedToRequest: true }] },
      susdeRequest,
    ),
    false,
  )
  assert.equal(
    isMatchingHolderExitAssessment(
      { ...susde, finalPayout: { ...susde.finalPayout, status: 'simulated' } },
      susdeRequest,
    ),
    false,
  )
})

test('Staked USDat share queue cannot become an AUSD holder payout', () => {
  const queueRequest = {
    ...request,
    routeKey: 'AUSD → Staked USDat [USDat]',
    destinationAddress: '0xd166337499e176bbc38a1fbd113ab144e5bd2df7',
    payoutAsset: '0x00000000efe302beaa2b3e6e1b18d08d69a9012a',
    kind: 'staked_usdat',
    sharesRaw: '1000000000000000000',
    requestTokenId: '42',
  }
  const queue = {
    ...direct,
    status: 'partial',
    routeKey: queueRequest.routeKey,
    destinationAddress: queueRequest.destinationAddress,
    request: {
      ...direct.request,
      assetAddress: queueRequest.payoutAsset,
      sharesRaw: queueRequest.sharesRaw,
      requestTokenId: '42',
    },
    stages: [
      {
        name: 'queue_request',
        assetAddress: null,
        status: 'simulated',
        amountRaw: null,
        relatedToRequest: false,
      },
      {
        name: 'existing_ticket_claim',
        assetAddress: '0x23238f20b894f29041f48d88ee91131c395aaa71',
        status: 'unassessed',
        amountRaw: null,
        relatedToRequest: false,
      },
    ],
    finalPayout: { assetAddress: queueRequest.payoutAsset, status: 'unassessed', amountRaw: null },
    stakedUsdatCondition: {
      requestedSharesRaw: queueRequest.sharesRaw,
      previewUsdatRaw: '2500000',
      queueRequestStatus: 'success',
      simulatedQueueTicketId: '99',
      existingTicketId: '42',
      existingTicketOwnership: 'not_found',
      existingTicketClaimStatus: 'not_found',
      existingTicketRequestedAtUnix: null,
      existingTicketRequestedLimit: null,
    },
  }
  assert.equal(isMatchingHolderExitAssessment(queue, queueRequest), true)
  const queueWithLimit = {
    ...queue,
    stages: [queue.stages[0], { ...queue.stages[1], status: 'reverted' }],
    stakedUsdatCondition: {
      ...queue.stakedUsdatCondition,
      existingTicketOwnership: 'holder',
      existingTicketClaimStatus: 'evm_revert',
      existingTicketRequestedAtUnix: String(Date.parse(queue.source.blockTime) / 1000 - 3600),
      existingTicketRequestedLimit: {
        minSharePriceRaw: '1040000',
        currentNetSharePriceRaw: '1034622',
        comparison: 'above_current_quote',
        limitUpdateSimulation: 'success',
      },
    },
  }
  assert.equal(isMatchingHolderExitAssessment(queueWithLimit, queueRequest), true)
  assert.equal(
    isMatchingHolderExitAssessment(
      {
        ...queueWithLimit,
        stakedUsdatCondition: {
          ...queueWithLimit.stakedUsdatCondition,
          existingTicketRequestedAtUnix: String(Date.parse(queue.source.blockTime) / 1000 + 1),
        },
      },
      queueRequest,
    ),
    false,
  )
  assert.equal(
    isMatchingHolderExitAssessment(
      {
        ...queueWithLimit,
        stakedUsdatCondition: {
          ...queueWithLimit.stakedUsdatCondition,
          existingTicketRequestedLimit: {
            ...queueWithLimit.stakedUsdatCondition.existingTicketRequestedLimit,
            limitUpdateSimulation: 'unknown',
          },
        },
      },
      queueRequest,
    ),
    false,
  )
  assert.equal(
    isMatchingHolderExitAssessment(
      {
        ...queueWithLimit,
        stakedUsdatCondition: {
          ...queueWithLimit.stakedUsdatCondition,
          existingTicketRequestedLimit: {
            ...queueWithLimit.stakedUsdatCondition.existingTicketRequestedLimit,
            comparison: 'at_or_below_current_quote',
          },
        },
      },
      queueRequest,
    ),
    false,
  )
  assert.equal(isMatchingHolderExitAssessment(queue, { ...queueRequest, sharesRaw: '2' }), false)
  assert.equal(
    isMatchingHolderExitAssessment(queue, { ...queueRequest, requestTokenId: '43' }),
    false,
  )
  assert.equal(
    isMatchingHolderExitAssessment(
      { ...queue, finalPayout: { ...queue.finalPayout, status: 'simulated' } },
      queueRequest,
    ),
    false,
  )
})

test('Twyne collateral vault PT first leg cannot become a USDe holder payout', () => {
  const ptRequest = {
    ...request,
    routeKey: 'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]',
    destinationAddress: '0x0af56afbddcb140323445bd7211ba90e54e5fd1c',
    payoutAsset: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
    kind: 'twyne_pt',
    collateralVault: '0x3333333333333333333333333333333333333333',
    ptRaw: '2000000000000000000',
  }
  const pt = {
    ...direct,
    status: 'partial',
    routeKey: ptRequest.routeKey,
    destinationAddress: ptRequest.destinationAddress,
    request: {
      ...direct.request,
      assetAddress: ptRequest.payoutAsset,
      collateralVault: ptRequest.collateralVault,
      ptRaw: ptRequest.ptRaw,
    },
    stages: [
      {
        name: 'pt_redemption',
        assetAddress: '0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34',
        status: 'simulated',
        amountRaw: ptRequest.ptRaw,
        relatedToRequest: false,
      },
    ],
    finalPayout: { assetAddress: ptRequest.payoutAsset, status: 'unassessed', amountRaw: null },
    twyneCondition: {
      collateralVault: ptRequest.collateralVault,
      requestedPtRaw: ptRequest.ptRaw,
      status: 'observed',
      reason: null,
      simulatedReturnedPtRaw: ptRequest.ptRaw,
    },
  }
  assert.equal(isMatchingHolderExitAssessment(pt, ptRequest), true)
  const unsupported = {
    ...pt,
    status: 'unsupported',
    stages: [],
    twyneCondition: {
      ...pt.twyneCondition,
      status: 'unsupported',
      reason: 'deployment_unattested',
      simulatedReturnedPtRaw: null,
    },
  }
  assert.equal(isMatchingHolderExitAssessment(unsupported, ptRequest), true)
  assert.equal(
    isMatchingHolderExitAssessment({ ...unsupported, stages: pt.stages }, ptRequest),
    false,
  )
  assert.equal(
    isMatchingHolderExitAssessment(
      { ...pt, twyneCondition: { ...pt.twyneCondition, simulatedReturnedPtRaw: '1' } },
      ptRequest,
    ),
    false,
  )
  assert.equal(isMatchingHolderExitAssessment(pt, { ...ptRequest, ptRaw: '1' }), false)
  assert.equal(isMatchingHolderExitAssessment(pt, { ...ptRequest, collateralVault: owner }), false)
  assert.equal(
    isMatchingHolderExitAssessment(
      { ...pt, finalPayout: { ...pt.finalPayout, status: 'simulated' } },
      ptRequest,
    ),
    false,
  )
})

test('PYUSD route identity cannot be shown as a holder payout', () => {
  const pyusdRequest = {
    ...request,
    routeKey: 'PYUSD → StakingVault [wYLDS]',
    destinationAddress: '0x19ebb35279a16207ec4ba82799cc64715065f7f6',
    payoutAsset: '0x6c3ea9036406852006290770bedfcaba0e23a0e8',
    kind: 'pyusd_staking',
  }
  const identity = {
    ...direct,
    status: 'unsupported',
    unsupportedReason: 'pyusd_leg_not_verified',
    routeKey: pyusdRequest.routeKey,
    destinationAddress: pyusdRequest.destinationAddress,
    request: { ...direct.request, assetAddress: pyusdRequest.payoutAsset },
    stages: [],
    finalPayout: { assetAddress: pyusdRequest.payoutAsset, status: 'unassessed', amountRaw: null },
  }
  assert.equal(isMatchingHolderExitAssessment(identity, pyusdRequest), true)
  assert.equal(
    isMatchingHolderExitAssessment({ ...identity, stages: direct.stages }, pyusdRequest),
    false,
  )
  assert.equal(
    isMatchingHolderExitAssessment({ ...identity, finalPayout: direct.finalPayout }, pyusdRequest),
    false,
  )
  const queue = {
    holder: pyusdRequest.owner,
    existingWyldsSharesRaw: '2000000',
    pendingSharesRaw: '1000000',
    pendingUsdcRaw: '990000',
    pendingSinceUnix: '1790800000',
    yieldPaused: false,
    yieldFrozen: false,
    redeemVault: '0x0000000000000000000000000000000000000002',
    requestAssessed: false,
    completion: 'admin_gated_unassessed',
    usdcPayout: 'not_attested',
  }
  const queueOnly = {
    ...identity,
    status: 'partial',
    unsupportedReason: undefined,
    pyusdYieldQueueCondition: queue,
  }
  assert.equal(isMatchingHolderExitAssessment(queueOnly, pyusdRequest), true)
  assert.equal(
    isMatchingHolderExitAssessment(
      {
        ...queueOnly,
        pyusdYieldQueueCondition: {
          ...queue,
          pendingSinceUnix: String(Date.parse(queueOnly.source.blockTime) / 1000 + 1),
        },
      },
      pyusdRequest,
    ),
    false,
  )
  assert.equal(
    isMatchingHolderExitAssessment(
      { ...queueOnly, pyusdYieldQueueCondition: { ...queue, holder: queue.redeemVault } },
      pyusdRequest,
    ),
    false,
  )
  assert.equal(
    isMatchingHolderExitAssessment(
      { ...queueOnly, pyusdYieldQueueCondition: { ...queue, requestAssessed: true } },
      pyusdRequest,
    ),
    false,
  )
  const primeRequest = { ...pyusdRequest, primeSharesRaw: '1000000' }
  const firstLeg = {
    ...identity,
    status: 'partial',
    unsupportedReason: undefined,
    request: { ...identity.request, primeSharesRaw: primeRequest.primeSharesRaw },
    stages: [
      {
        name: 'prime_redemption',
        assetAddress: primeRequest.destinationAddress,
        status: 'simulated',
        amountRaw: primeRequest.primeSharesRaw,
        relatedToRequest: false,
      },
    ],
    pyusdStakingCondition: {
      requestedPrimeSharesRaw: primeRequest.primeSharesRaw,
      holderPrimeSharesRaw: '3000000',
      maxRedeemRaw: '3000000',
      previewWyldsRaw: '1050000',
      simulatedWyldsRaw: '1050000',
      stakingPaused: false,
      holderFrozen: false,
      reason: 'prime_to_wylds_callable',
    },
  }
  assert.equal(isMatchingHolderExitAssessment(firstLeg, primeRequest), true)
  assert.equal(
    isMatchingHolderExitAssessment({ ...firstLeg, pyusdYieldQueueCondition: queue }, primeRequest),
    true,
  )
  assert.equal(
    isMatchingHolderExitAssessment(
      {
        ...firstLeg,
        pyusdStakingCondition: {
          ...firstLeg.pyusdStakingCondition,
          simulatedWyldsRaw: '0',
        },
      },
      primeRequest,
    ),
    false,
  )
  assert.equal(
    isMatchingHolderExitAssessment(
      {
        ...firstLeg,
        pyusdStakingCondition: {
          ...firstLeg.pyusdStakingCondition,
          holderPrimeSharesRaw: '999999',
        },
      },
      primeRequest,
    ),
    false,
  )
  assert.equal(
    isMatchingHolderExitAssessment(
      {
        ...firstLeg,
        pyusdStakingCondition: {
          ...firstLeg.pyusdStakingCondition,
          stakingPaused: true,
        },
      },
      primeRequest,
    ),
    false,
  )
  assert.equal(
    isMatchingHolderExitAssessment(firstLeg, { ...primeRequest, primeSharesRaw: '2000000' }),
    false,
  )
})

test('Fluid first-leg USDC amount cannot stand in for the chosen USDT exit', () => {
  const fluidRequest = {
    ...request,
    kind: 'fluid',
    firstLegUsdcRaw: '1000000',
  }
  const fluid = {
    ...direct,
    status: 'partial',
    stages: [
      {
        name: 'usdc_vault_withdrawal',
        assetAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        status: 'simulated',
        amountRaw: '1000000',
        relatedToRequest: false,
      },
      {
        name: 'usdc_to_usdt_conversion',
        assetAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7',
        status: 'unassessed',
        amountRaw: null,
        relatedToRequest: false,
      },
      {
        name: 'usdt_delivery',
        status: 'unassessed',
        relatedToRequest: true,
      },
    ],
    finalPayout: { ...direct.finalPayout, status: 'unassessed', amountRaw: null },
  }
  assert.equal(isMatchingHolderExitAssessment(fluid, fluidRequest), true)
  assert.equal(
    isMatchingHolderExitAssessment(
      {
        ...fluid,
        stages: [
          fluid.stages[0],
          { ...fluid.stages[1], relatedToRequest: undefined },
          fluid.stages[2],
        ],
      },
      fluidRequest,
    ),
    false,
  )
  assert.equal(
    isMatchingHolderExitAssessment(fluid, { ...fluidRequest, firstLegUsdcRaw: '2000000' }),
    false,
  )
  assert.equal(
    isMatchingHolderExitAssessment(
      { ...fluid, finalPayout: { ...fluid.finalPayout, status: 'simulated' } },
      fluidRequest,
    ),
    false,
  )
})

test('new ApyUSD receipt initiation cannot inherit an existing receipt claim', () => {
  const apyRequest = { ...request, kind: 'apy' }
  const apy = {
    ...direct,
    status: 'partial',
    stages: [
      {
        name: 'receipt_initiation',
        status: 'simulated',
        amountRaw: request.assetsRaw,
        relatedToRequest: true,
      },
      {
        name: 'receipt_claim',
        assetAddress: payoutAsset,
        status: 'unassessed',
        amountRaw: null,
        relatedToRequest: false,
      },
    ],
    finalPayout: { ...direct.finalPayout, status: 'unassessed', amountRaw: null },
    apyUsdCondition: {
      currentMinimumClaimDelaySeconds: 259200,
      ifInitiatedAtCheckedBlockClaimableAt: Date.parse(direct.source.blockTime) / 1000 + 259200,
      ifInitiatedAtCheckedBlockEarliestNetRaw: '24150000',
      ifInitiatedAtCheckedBlockMinimumFeeAt: Date.parse(direct.source.blockTime) / 1000 + 1728000,
      ifInitiatedAtCheckedBlockMinimumFeeNetRaw: request.assetsRaw,
      ifInitiatedAtCheckedBlockHorizonNetRaw: null,
    },
  }
  assert.equal(isMatchingHolderExitAssessment(apy, apyRequest), true)
  assert.equal(
    isMatchingHolderExitAssessment(
      { ...apy, stages: [apy.stages[0], { ...apy.stages[1], status: 'simulated' }] },
      apyRequest,
    ),
    false,
  )
  const receiptRequest = { ...apyRequest, receiptTokenId: '881' }
  const apyWithReceipt = {
    ...apy,
    request: { ...apy.request, receiptTokenId: '881' },
    stages: [
      apy.stages[0],
      {
        ...apy.stages[1],
        assetAddress: payoutAsset,
        status: 'simulated',
        amountRaw: '24000000',
      },
    ],
    existingReceiptClaim: {
      tokenId: '881',
      assetAddress: payoutAsset,
      status: 'simulated',
      amountRaw: '24000000',
      delivery: 'not_observed',
    },
  }
  assert.equal(isMatchingHolderExitAssessment(apyWithReceipt, receiptRequest), true)
  const unsupportedApy = {
    ...apy,
    status: 'unsupported',
    stages: [
      { ...apy.stages[0], status: 'unassessed' },
      { ...apy.stages[1], status: 'unassessed' },
    ],
    apyUsdCondition: undefined,
  }
  assert.equal(isMatchingHolderExitAssessment(unsupportedApy, apyRequest), true)
  assert.equal(
    isMatchingHolderExitAssessment(
      { ...unsupportedApy, stages: [apy.stages[0], unsupportedApy.stages[1]] },
      apyRequest,
    ),
    false,
  )
  assert.equal(
    isMatchingHolderExitAssessment(
      {
        ...unsupportedApy,
        stages: [unsupportedApy.stages[0], apyWithReceipt.stages[1]],
        existingReceiptClaim: apyWithReceipt.existingReceiptClaim,
        request: apyWithReceipt.request,
      },
      receiptRequest,
    ),
    false,
  )
  assert.equal(isMatchingHolderExitAssessment(apyWithReceipt, apyRequest), false)
  assert.equal(
    isMatchingHolderExitAssessment(
      { ...apyWithReceipt, existingReceiptClaim: undefined },
      receiptRequest,
    ),
    false,
  )
  assert.equal(
    isMatchingHolderExitAssessment(
      {
        ...apyWithReceipt,
        existingReceiptClaim: { ...apyWithReceipt.existingReceiptClaim, amountRaw: '24000001' },
      },
      receiptRequest,
    ),
    false,
  )
  assert.equal(
    isMatchingHolderExitAssessment(
      {
        ...apyWithReceipt,
        existingReceiptClaim: { ...apyWithReceipt.existingReceiptClaim, delivery: 'observed' },
      },
      receiptRequest,
    ),
    false,
  )
  assert.equal(
    isMatchingHolderExitAssessment(
      {
        ...apy,
        apyUsdCondition: {
          ...apy.apyUsdCondition,
          ifInitiatedAtCheckedBlockClaimableAt:
            apy.apyUsdCondition.ifInitiatedAtCheckedBlockClaimableAt + 1,
        },
      },
      apyRequest,
    ),
    false,
  )
  assert.equal(
    isMatchingHolderExitAssessment(
      { ...apy, stages: [apy.stages[0], { ...apy.stages[1], relatedToRequest: true }] },
      apyRequest,
    ),
    false,
  )
})

test('Morpho assessment resolves all 49 frozen vaults by route and destination identity', () => {
  assert.equal(morphoIdentities.entries.length, 49)
  for (const identity of morphoIdentities.entries) {
    const routeKeys = [
      ...new Set(
        cohort.positions
          .filter((entry) => entry.vault.toLowerCase() === identity.vault.toLowerCase())
          .flatMap((entry) => entry.routeIds),
      ),
    ]
    assert.ok(routeKeys.length > 0)
    let accepted = 0
    for (const routeKey of routeKeys) {
      const target = resolvedMorphoAssessmentTarget(routeKey, identity.vault)
      if (target) {
        assert.equal(target.asset.toLowerCase(), identity.asset.toLowerCase())
        accepted += 1
      }
      assert.equal(resolvedMorphoAssessmentTarget(routeKey, owner), null)
    }
    assert.ok(accepted > 0, `no frozen route subject for ${identity.vault}`)
  }
  assert.equal(
    resolvedMorphoAssessmentTarget('GHO → sGho [GHO]', morphoIdentities.entries[0].vault),
    null,
  )
})

test('Morpho present simulation accepts only matching Q and an unvalidated future', () => {
  const identity = morphoIdentities.entries[0]
  const position = cohort.positions.find(
    (entry) => entry.vault.toLowerCase() === identity.vault.toLowerCase(),
  )
  const morphoRequest = {
    ...request,
    routeKey: position.routeIds[0],
    destinationAddress: identity.vault,
    payoutAsset: identity.asset,
    kind: 'morpho',
  }
  const morpho = {
    ...direct,
    routeKey: morphoRequest.routeKey,
    destinationAddress: identity.vault,
    request: { ...direct.request, assetAddress: identity.asset },
    stages: [{ ...direct.stages[0], assetAddress: identity.asset }],
    finalPayout: { ...direct.finalPayout, assetAddress: identity.asset },
  }
  assert.equal(isMatchingHolderExitAssessment(morpho, morphoRequest), true)
  assert.equal(
    isMatchingHolderExitAssessment(morpho, { ...morphoRequest, assetsRaw: '26000000' }),
    false,
  )
  assert.equal(isMatchingHolderExitAssessment(morpho, { ...morphoRequest, horizonHours: 1 }), false)
})

test('watch control is restricted to local browser hostnames', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', '::1'])
    assert.equal(isLocalHolderWatchHostname(host), true)
  for (const host of ['app.membrane.fi', 'localhost.attacker.example', '192.168.1.10'])
    assert.equal(isLocalHolderWatchHostname(host), false)
})

test('watch status accepts both horizons and keeps forecast unvalidated', () => {
  const status = {
    id: 'a'.repeat(64),
    state: 'issued',
    horizons: [
      { horizonHours: 1, state: 'measured_success' },
      { horizonHours: 24, state: 'retrying' },
    ],
    forecastValidated: false,
  }
  assert.equal(isHolderWatchStatus(status), true)
  assert.equal(isHolderWatchStatus({ ...status, horizons: status.horizons.slice(0, 1) }), false)
  assert.equal(isHolderWatchStatus({ ...status, forecastValidated: true }), false)
  assert.equal(
    isHolderWatchStatus({
      ...status,
      horizons: [
        { horizonHours: 1, state: 'issued' },
        { horizonHours: 1, state: 'pending' },
      ],
    }),
    false,
  )
  for (const state of ['queued', 'issued', 'retrying', 'quarantined', 'exhausted'])
    assert.equal(isHolderWatchStatus({ ...status, state }), true)
  for (const state of [
    'pending',
    'measured_success',
    'measured_failure',
    'censored',
    'retrying',
    'quarantined',
    'exhausted',
  ])
    assert.equal(
      isHolderWatchStatus({
        ...status,
        horizons: [
          { horizonHours: 1, state },
          { horizonHours: 24, state },
        ],
      }),
      true,
    )
})

test('invalid optional mechanical projection drops independently of holder stages', () => {
  const value = { ...direct, mechanicalOutlook: { issuedAt: 'forged' } }
  const selected = withMatchingHolderMechanicalOutlook(
    value,
    owner,
    Date.parse(direct.source.blockTime),
  )
  assert.equal(selected.mechanicalOutlook, null)
  assert.deepEqual(selected.stages, direct.stages)
  assert.deepEqual(selected.request, direct.request)
  assert.equal(selected.status, direct.status)
})
