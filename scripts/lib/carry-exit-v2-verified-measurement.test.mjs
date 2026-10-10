import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  syntheticRoute,
  syntheticVerifiedMeasurementFixture,
} from './carry-exit-v2-verified-measurement-fixture.mjs'
import { measureCarryExitV2Verified } from './carry-exit-v2-verified-measurement.mjs'

test('only assembled evidence emerges after capture and two-origin agreement', async () => {
  const { input, calls } = syntheticVerifiedMeasurementFixture()
  const result = await measureCarryExitV2Verified(input)
  assert.equal(result.status, 'verified')
  assert.equal(result.callEvidenceDoc.verificationStatus, 'verified')
  assert.equal(result.callEvidenceDoc.routeKey, syntheticRoute.routeKey)
  assert.equal(result.callEvidenceDoc.assetsRaw, '1000000')
  assert.equal(result.callEvidenceDoc.identityEvidence.checks.length, 4)
  assert.equal(result.callEvidenceDoc.replayEvidenceDoc.origins.primary, 'https://primary.example')
  assert.equal(
    result.callEvidenceDoc.replayEvidenceDoc.origins.secondary,
    'https://secondary.example',
  )
  assert(calls.capture.length > 0)
  assert(calls.primary.length > 0)
  assert(calls.secondary.length > 0)
  assert.equal('verdict' in result, false)
})

test('a malformed independent replay yields unavailable without a document', async () => {
  const { input, calls } = syntheticVerifiedMeasurementFixture(true)
  const result = await measureCarryExitV2Verified(input)
  assert.deepEqual(result, { status: 'unavailable', reason: 'replay_unavailable' })
  assert(calls.secondary.length > 0)
  assert.equal('callEvidenceDoc' in result, false)
})

test('caller-authored replay, status, and verdict are refused before any RPC', async () => {
  for (const forged of [{ replay: {} }, { status: 'verified' }, { verdict: {} }]) {
    const { input, calls } = syntheticVerifiedMeasurementFixture()
    Object.assign(input, forged)
    assert.deepEqual(await measureCarryExitV2Verified(input), {
      status: 'unavailable',
      reason: 'invalid_input',
    })
    assert.equal(calls.capture.length, 0)
  }
})

test('same-origin transports cannot yield a verified document', async () => {
  const { input } = syntheticVerifiedMeasurementFixture()
  input.secondary.url = input.primary.url
  const result = await measureCarryExitV2Verified(input)
  assert.equal(result.status, 'unavailable')
  assert.equal('callEvidenceDoc' in result, false)
})
