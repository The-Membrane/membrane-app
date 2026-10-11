import assert from 'node:assert/strict'
import test from 'node:test'

import workbench from '../../components/Carry/ForecastWorkbench.tsx'

const { isMatchingHolderExitAssessment, stakedUsdatExitAmounts } = workbench
const asset = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3'
const request = {
  routeKey: 'USDe → Staked USDe [USDe]',
  destinationAddress: '0x9d39a5de30e57443bff2a8307a4256c8797a3497',
  owner: `0x${'b'.repeat(40)}`,
  assetsRaw: '1000000000000000000',
  horizonHours: 24,
  payoutAsset: asset,
  kind: 'susde',
}
function assessment(mode = 'cooldown', execution = 'success') {
  const direct = mode === 'direct_withdrawal'
  return {
    status: 'partial',
    routeKey: request.routeKey,
    destinationAddress: request.destinationAddress,
    owner: request.owner,
    request: { assetsRaw: request.assetsRaw, assetAddress: asset, horizonHours: 24 },
    source: {
      chainId: 1,
      blockNumber: 1,
      blockHash: `0x${'a'.repeat(64)}`,
      blockTime: '2026-10-07T12:00:00.000Z',
      originValidation: 'two_provider',
    },
    stages: [
      {
        name: direct ? 'withdrawal' : 'cooldown_initiation',
        assetAddress: asset,
        status: execution === 'success' ? 'simulated' : 'reverted',
        amountRaw: request.assetsRaw,
        relatedToRequest: true,
      },
      {
        name: 'pending_claim',
        assetAddress: asset,
        status: direct ? 'simulated' : 'unassessed',
        amountRaw: '5000000000000000000',
        relatedToRequest: false,
      },
    ],
    finalPayout: { assetAddress: asset, status: 'unassessed', amountRaw: null },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
    cooldownCondition: {
      exitMode: mode,
      durationSeconds: direct ? 0 : 86400,
      pendingAssetsRaw: '5000000000000000000',
      aggregateSiloUsdeRaw: '100000000000000000000',
      pendingClaimEarliestAt: direct ? '2026-10-07T12:00:00.000Z' : '2026-10-07T13:00:00.000Z',
      initiationStatus: direct ? 'not_applicable' : execution,
      directWithdrawalStatus: direct ? execution : null,
      pendingClaimStatus: direct ? 'success' : 'not_yet_eligible',
      newRequestWouldResetPending: !direct,
      ifInitiatedAtCheckedBlockEarliestAt: direct ? null : '2026-10-08T12:00:00.000Z',
    },
  }
}

test('one AUSD payout and one independently queued sUSDat share retain distinct native units', () => {
  assert.deepEqual(stakedUsdatExitAmounts('1', '1'), {
    assetsRaw: '1000000',
    sharesRaw: '1000000000000000000',
  })
  assert.deepEqual(stakedUsdatExitAmounts('2.5', '7.1'), {
    assetsRaw: '2500000',
    sharesRaw: '7100000000000000000',
  })
})
test('independent payout/share precision failures never round or substitute the other quantity', () => {
  assert.deepEqual(stakedUsdatExitAmounts('1.0000001', '1'), {
    assetsRaw: null,
    sharesRaw: '1000000000000000000',
  })
  assert.deepEqual(stakedUsdatExitAmounts('1', '1.0000000000000000001'), {
    assetsRaw: '1000000',
    sharesRaw: null,
  })
})
for (const mode of ['cooldown', 'direct_withdrawal']) {
  for (const execution of ['success', 'evm_revert']) {
    test(`matches canonical sUSDe ${mode} ${execution} without merging its older pending claim`, () => {
      const value = assessment(mode, execution)
      assert.equal(isMatchingHolderExitAssessment(value, request), true)
      assert.equal(value.stages[1].relatedToRequest, false)
      assert.notEqual(value.stages[1].amountRaw, request.assetsRaw)
      assert.equal(value.cooldownCondition.newRequestWouldResetPending, mode === 'cooldown')
      assert.equal(value.finalPayout.status, 'unassessed')
    })
  }
}
const invalid = [
  [
    'direct withdrawal mislabeled as cooldown initiation',
    'direct_withdrawal',
    (a) => {
      a.stages[0].name = 'cooldown_initiation'
    },
  ],
  [
    'cooldown mislabeled as direct withdrawal',
    'cooldown',
    (a) => {
      a.stages[0].name = 'withdrawal'
    },
  ],
  [
    'direct mode with positive duration',
    'direct_withdrawal',
    (a) => {
      a.cooldownCondition.durationSeconds = 1
    },
  ],
  [
    'cooldown mode with zero duration',
    'cooldown',
    (a) => {
      a.cooldownCondition.durationSeconds = 0
    },
  ],
  [
    'direct mode with an initiation',
    'direct_withdrawal',
    (a) => {
      a.cooldownCondition.initiationStatus = 'success'
    },
  ],
  [
    'cooldown mode without initiation',
    'cooldown',
    (a) => {
      a.cooldownCondition.initiationStatus = 'not_applicable'
    },
  ],
  [
    'cooldown with a direct withdrawal result',
    'cooldown',
    (a) => {
      a.cooldownCondition.directWithdrawalStatus = 'success'
    },
  ],
  [
    'direct mode without a withdrawal result',
    'direct_withdrawal',
    (a) => {
      a.cooldownCondition.directWithdrawalStatus = null
    },
  ],
  [
    'direct failure presented as simulated',
    'direct_withdrawal',
    (a) => {
      a.cooldownCondition.directWithdrawalStatus = 'evm_revert'
    },
  ],
  [
    'cooldown failure presented as simulated',
    'cooldown',
    (a) => {
      a.cooldownCondition.initiationStatus = 'evm_revert'
    },
  ],
  [
    'unknown exit mode',
    'cooldown',
    (a) => {
      a.cooldownCondition.exitMode = 'unknown'
    },
  ],
  [
    'pending assets relabeled as requested Q',
    'direct_withdrawal',
    (a) => {
      a.stages[1].relatedToRequest = true
    },
  ],
]
for (const [name, mode, change] of invalid) {
  test(`rejects ${name}`, () => {
    const value = assessment(mode)
    change(value)
    assert.equal(isMatchingHolderExitAssessment(value, request), false)
  })
}
