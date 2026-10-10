import assert from 'node:assert/strict'
import test from 'node:test'

import component from '../../components/Carry/ExitEvidenceAlert.tsx'

const { currentSampleRecovery, formatExitEvidenceAmount, matchingSampledLosses } = component
const holder = `0x${'a'.repeat(40)}`
const destination = `0x${'b'.repeat(40)}`
const scope = {
  requestId: 1,
  routeKey: 'USDC → USD3 [USDC]',
  destination,
  holder,
  assetsRaw: '10000000000',
  assetDecimals: 6,
  assetUnit: 'USDC',
}

function feed(overrides = {}) {
  return {
    status: 'bounded_sampled_exit_evidence',
    scope: { maxRecentIssuedBaselinesPerLedger: 200, completeHistory: false },
    prospectiveValidated: false,
    futureExitForecast: false,
    likelyDuration: 'unavailable',
    alerts: [
      {
        kind: 'sampled_exit_loss',
        scope: 'one_sampled_holder_and_amount',
        routeKey: scope.routeKey,
        destination,
        holder,
        assetsRaw: scope.assetsRaw,
        baseline: {
          block: '100',
          hash: `0x${'1'.repeat(64)}`,
          blockTime: '2026-09-29T10:00:00.000Z',
        },
        lossObserved: {
          block: '110',
          hash: `0x${'2'.repeat(64)}`,
          blockTime: '2026-09-29T11:00:00.000Z',
        },
        outcome: 'holder_covered_evm_revert',
        recovery: null,
        duration: 'unavailable',
      },
    ],
    ...overrides,
  }
}

test('renders only matching bounded nonforecast holder and amount evidence', () => {
  assert.equal(matchingSampledLosses(feed(), scope).length, 1)
  assert.equal(matchingSampledLosses(feed({ futureExitForecast: true }), scope).length, 0)
  assert.equal(matchingSampledLosses(feed({ scope: { completeHistory: true } }), scope).length, 0)
  assert.equal(matchingSampledLosses(feed(), { ...scope, holder: destination }).length, 0)
  assert.equal(matchingSampledLosses(feed(), { ...scope, assetsRaw: '10000000001' }).length, 0)
  assert.equal(matchingSampledLosses(feed(), { ...scope, routeKey: 'other' }).length, 0)
  assert.equal(matchingSampledLosses(feed(), { ...scope, destination: holder }).length, 0)
  assert.equal(matchingSampledLosses(feed({ alerts: [] }), scope).length, 0)
})

test('accepts later sampled recovery but rejects an earlier or inconsistent recovery', () => {
  const alert = feed().alerts[0]
  const recovered = {
    ...alert,
    recovery: {
      status: 'later_same_holder_amount_success',
      point: { block: '120', hash: `0x${'3'.repeat(64)}`, blockTime: '2026-09-29T12:00:00.000Z' },
    },
    duration: 'interval_censored',
  }
  assert.equal(matchingSampledLosses(feed({ alerts: [recovered] }), scope).length, 1)
  assert.equal(
    matchingSampledLosses(
      feed({
        alerts: [
          {
            ...recovered,
            recovery: {
              ...recovered.recovery,
              point: {
                block: '120',
                hash: `0x${'3'.repeat(64)}`,
                blockTime: '2026-09-29T10:30:00.000Z',
              },
            },
          },
        ],
      }),
      scope,
    ).length,
    0,
  )
  assert.equal(
    matchingSampledLosses(feed({ alerts: [{ ...alert, duration: 'interval_censored' }] }), scope)
      .length,
    0,
  )
})

test('newer same-subject finalized success reconciles an older H1 loss', () => {
  const alert = matchingSampledLosses(feed(), scope)[0]
  const sample = {
    routeKey: scope.routeKey,
    destination: scope.destination,
    holder: scope.holder,
    assetsRaw: scope.assetsRaw,
    status: 'success',
    blockNumber: 120,
    blockHash: `0x${'4'.repeat(64)}`,
    blockTime: '2026-09-29T12:00:00.000Z',
  }
  assert.deepEqual(currentSampleRecovery(alert, scope, sample), sample)
  assert.equal(currentSampleRecovery(alert, scope, { ...sample, holder: destination }), null)
  assert.equal(currentSampleRecovery(alert, scope, { ...sample, assetsRaw: '10000000001' }), null)
  assert.equal(currentSampleRecovery(alert, scope, { ...sample, destination: holder }), null)
  assert.equal(currentSampleRecovery(alert, scope, { ...sample, status: 'evm_revert' }), null)
  assert.equal(currentSampleRecovery(alert, scope, { ...sample, blockHash: '0x1234' }), null)
  assert.equal(currentSampleRecovery(alert, scope, { ...sample, blockNumber: 110 }), null)
  assert.equal(
    currentSampleRecovery(alert, scope, { ...sample, blockTime: '2026-09-29T10:30:00.000Z' }),
    null,
  )
})

test('shows the exact sampled amount even below one cent', () => {
  assert.equal(formatExitEvidenceAmount('10000000000', 6), '10,000')
  assert.equal(formatExitEvidenceAmount('1', 6), '0.000001')
})
