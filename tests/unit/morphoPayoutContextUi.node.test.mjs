import assert from 'node:assert/strict'
import test from 'node:test'

import workbench from '../../components/Carry/ForecastWorkbench.tsx'

const { isMatchingMorphoV2PayoutContext } = workbench
const routeKey = 'RLUSD → VaultV2 [RLUSD]'
const destination = '0x6dc58a06264c102d10fefb620cf2df228533f2b3'
const valid = {
  status: 'observed',
  routeKey,
  destination,
  sourceRangeCount: 4,
  latestCoveredBlock: '26094905',
  latestCoveredAt: '2026-10-01T04:00:00.000Z',
  sourceCompleteness: 'not_independently_proven',
  candidateTransactions: 19,
  sealedTransactions: 12,
  receiptReconciledTransactions: 10,
  externalPayoutProofRows: 10,
  ambiguousTransactions: 2,
  pendingTransactions: 7,
  payoutMeaning: 'historical_external_receiver_transfer',
  sameHolderExit: 'not_established',
  calibratedForecast: false,
}

test('matches only the selected vault and honest transaction accounting', () => {
  assert.equal(isMatchingMorphoV2PayoutContext(valid, routeKey, destination), true)
  assert.equal(isMatchingMorphoV2PayoutContext(valid, routeKey, `0x${'a'.repeat(40)}`), false)
  assert.equal(isMatchingMorphoV2PayoutContext(valid, 'USDC → VaultV2 [USDC]', destination), false)
  assert.equal(
    isMatchingMorphoV2PayoutContext({ ...valid, pendingTransactions: 6 }, routeKey, destination),
    false,
  )
  assert.equal(
    isMatchingMorphoV2PayoutContext({ ...valid, calibratedForecast: true }, routeKey, destination),
    false,
  )
})
