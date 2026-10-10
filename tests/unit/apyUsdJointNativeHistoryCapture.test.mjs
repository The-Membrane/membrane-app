import test from 'node:test'
import assert from 'node:assert/strict'
import {
  apyUsdNativeCaptureContainsSecret,
  apyUsdNativeCandidateErrorsAgree,
  prepareApyUsdJointNativeCurrentCapturePlan,
  prepareApyUsdJointNativeHistoryCapturePlan,
  captureApyUsdJointNativeCurrent,
  selectedOriginalApyUsdJointNativeCapture,
  selectedOriginalApyUsdJointNativeReceiptsForRetention,
} from '../../scripts/research/apyusd-joint-native-history-capture.mjs'
const source = () => ({
  chainId: 1,
  blockNumber: 26150788,
  blockHash: '0x' + 'a'.repeat(64),
  blockTime: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
  finalized: true,
})
const current = () => ({
  routeKey: 'apxUSD → ApyUSD [apxUSD]',
  destination: '0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a',
  asset: '0x98a878b1cd98131b271883b390f68d2c90674665',
  owner: '0x9830d6b37fe7488707cc4ad7f8b481d75eb2a8c2',
  candidateReceiptIds: ['881'],
  source: source(),
  acquiredAtUtc: new Date().toISOString(),
})
const history = () => ({
  batchIndex: 0,
  fullSharesRaw: '0',
  currentSource: source(),
  currentRuntimeRegime: 'c'.repeat(64),
  vestingAddress: null,
  vaultUnlockingFeeWad: '1000000000000000',
})
test('current input is snapshotted; receipt candidates remain distinct and dense', () => {
  const input = current(),
    plan = prepareApyUsdJointNativeCurrentCapturePlan(input)
  input.owner = '0x' + '1'.repeat(40)
  input.candidateReceiptIds[0] = '1137'
  assert.equal(plan.binding.owner, current().owner)
  assert.deepEqual(plan.binding.candidateReceiptIds, ['881'])
  assert.equal(plan.maxControls, 6)
  assert.equal(plan.maxPhysicalStarts, 828)
  assert.equal(plan.originalAuthority, false)
  assert(Object.isFrozen(plan.binding.source))
  const duplicate = current()
  duplicate.candidateReceiptIds.push('881')
  assert.throws(() => prepareApyUsdJointNativeCurrentCapturePlan(duplicate))
  const sparse = current()
  sparse.candidateReceiptIds = Array(1)
  assert.throws(() => prepareApyUsdJointNativeCurrentCapturePlan(sparse))
})
test('accessors and cycles are rejected without invoking getters', () => {
  let touched = false
  const input = current()
  Object.defineProperty(input, 'owner', {
    enumerable: true,
    get() {
      touched = true
      return current().owner
    },
  })
  assert.throws(() => prepareApyUsdJointNativeCurrentCapturePlan(input))
  assert.equal(touched, false)
  const cycle = current()
  cycle.source = cycle
  assert.throws(() => prepareApyUsdJointNativeCurrentCapturePlan(cycle))
})
test('history retains zero/full S independently of Q at exactly two fixed anchors', () => {
  const input = history(),
    plan = prepareApyUsdJointNativeHistoryCapturePlan(input)
  input.fullSharesRaw = '100'
  input.currentSource.blockHash = '0x' + 'b'.repeat(64)
  assert.deepEqual(
    plan.anchors.map((a) => a.binding.cashIndex),
    [112, 113],
  )
  assert(plan.anchors.every((a) => a.binding.fullSharesRaw === '0' && a.binding.owner === null))
  assert.equal(plan.maxPhysicalStarts, 110)
  assert.equal(plan.historicalOwnership, false)
  assert.throws(() =>
    prepareApyUsdJointNativeHistoryCapturePlan({ ...history(), requestedRaw: '1' }),
  )
  assert.throws(() => prepareApyUsdJointNativeHistoryCapturePlan({ ...history(), batchIndex: 4 }))
  assert.throws(() =>
    prepareApyUsdJointNativeHistoryCapturePlan({ ...history(), fullSharesRaw: '00' }),
  )
})
test('cloned plans fail before configured origins or native fetch can start', async () => {
  const plan = prepareApyUsdJointNativeCurrentCapturePlan(current())
  await assert.rejects(captureApyUsdJointNativeCurrent(structuredClone(plan)), /original_plan/)
  assert.equal(selectedOriginalApyUsdJointNativeCapture({ accepted: true }, plan), null)
  assert.equal(
    selectedOriginalApyUsdJointNativeReceiptsForRetention({ accepted: true, batches: [] }),
    null,
  )
})
for (const [name, body] of [
  ['literal', '{"error":"credentialSecret"}'],
  ['unicode value', '{"error":"credential\\u0053ecret"}'],
  ['unicode key', '{"credential\\u0053ecret":0}'],
  ['percent escaped', '{"error":"credential%53ecret"}'],
  ['double percent', '{"error":"credential%2553ecret"}'],
  ['malformed escaped', '{"error":"credential\\u0053ecret"'],
])
  test('privacy rejects ' + name + ' before original retention', () => {
    assert.equal(apyUsdNativeCaptureContainsSecret(Buffer.from(body), ['credentialSecret']), true)
  })
test('safe ordinary malformed response bytes are retained; duplicates/escaped ambiguity fail closed', () => {
  assert.equal(
    apyUsdNativeCaptureContainsSecret(Buffer.from('ordinary invalid json'), ['credentialSecret']),
    false,
  )
  assert.equal(
    apyUsdNativeCaptureContainsSecret(Buffer.from('{"x":1,"x":"\\u0073afe"}'), [
      'credentialSecret',
    ]),
    true,
  )
  assert.equal(
    apyUsdNativeCaptureContainsSecret(Buffer.from('{"result":"0x1234"}'), ['credentialSecret']),
    false,
  )
})
test('candidate native revert bytes agree across allowed provider codes, never missing or drifting data', () => {
  const a = { code: 3, message: 'native_error', data: '0x7e273289' + '0'.repeat(60) + '0371' }
  assert.equal(apyUsdNativeCandidateErrorsAgree(a, { ...a, code: -32000 }), true)
  assert.equal(apyUsdNativeCandidateErrorsAgree(a, { ...a, code: -32015 }), true)
  assert.equal(apyUsdNativeCandidateErrorsAgree(a, { ...a, code: -32603 }), false)
  assert.equal(
    apyUsdNativeCandidateErrorsAgree({ ...a, data: undefined }, { ...a, data: undefined }),
    false,
  )
  assert.equal(
    apyUsdNativeCandidateErrorsAgree(a, { ...a, data: '0x7e273289' + '0'.repeat(64) }),
    false,
  )
})
