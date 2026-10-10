import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import {
  FLUID_JOINT_CAPTURE_PINS,
  replayFluidUsdtBridgeJointHistory,
} from '../../scripts/research/fluid-usdt-bridge-joint-history-replay.mjs'

let networkAttempts = 0
globalThis.fetch = async () => {
  networkAttempts++
  throw Error('offline_fetch_forbidden')
}
const texts = Object.fromEntries(
  Object.entries(FLUID_JOINT_CAPTURE_PINS).map(([key, pin]) => [
    key,
    readFileSync(resolve(pin.path), 'utf8'),
  ]),
)
const result = await replayFluidUsdtBridgeJointHistory(texts)
const helperImport = await import('../../lib/carry/fluidUsdtBridgeJointHistoricalProcess.ts')
const helper = helperImport.default ?? helperImport
if (process.argv[2] === '--review-report') {
  const directory = '/private/tmp/fluid-joint-native-replay-oct7'
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    resolve(directory, 'authenticated-replay-report.json'),
    JSON.stringify(result.report, null, 2) + '\n',
    { flag: 'wx' },
  )
}
const clone = () => structuredClone(result.input)
const reseal = (value) => {
  const { sha256, ...body } = value
  return (
    JSON.stringify({
      ...body,
      sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    }) + '\n'
  )
}

test('actual immutable captures replay with zero network calls', () => {
  assert.equal(networkAttempts, 0)
  assert.deepEqual(result.report.actualReads, { native: 112, fixed: 12 })
  assert.equal(result.input.issueAtUtc, '2026-10-07T21:36:00.506Z')
  assert.equal(result.report.captureAvailability.native, '2026-10-07T20:33:00.975Z')
  assert.equal(result.input.history[0].source.blockNumber, '26101887')
  assert.equal(result.input.baseline.source.blockNumber, '26102143')
  assert.equal(result.input.history[0].originalIssue.issueAtUtc, '2026-10-02T03:32:46.286Z')
  assert.equal(result.input.history[0].originalIssue.targetAtUtc, '2026-10-03T03:32:46.286Z')
  assert.equal(result.report.originalIssues[0].targets.length, 5)
  assert.ok(result.approve('history', clone()))
  assert.equal(result.approve('current', clone()), false)
})
test('same full shares and already net E survive native prong join', () => {
  assert.deepEqual(
    result.input.history.map((p) => p.holderSharesRaw),
    ['967573479322309282', '967573479322309282'],
  )
  assert.deepEqual(
    result.input.history.map((p) => p.fullHolderNetUsdcRaw),
    ['1014574', '1014581'],
  )
  assert.deepEqual(result.input.history[0].nativeProngs, {
    bridgeFunding: '14345876701725',
    bankCash: '21611734288821',
    bankSupply: '130584187474293',
    bankWithdrawableUntilLimit: '65292093737147',
    bankResolverWithdrawable: '21611734288821',
  })
  assert.deepEqual(result.input.baseline.nativeProngs, {
    bridgeFunding: '14339964014963',
    bankCash: '21607996326464',
    bankSupply: '130578855751172',
    bankWithdrawableUntilLimit: '65289427875586',
    bankResolverWithdrawable: '21607996326464',
  })
  assert.deepEqual(
    result.process.historicalAnchors.map((p) => p.holderClippedNetUsdcRaw),
    ['1014574', '1014581'],
  )
  assert.deepEqual(
    result.process.historicalAnchors.map((p) => p.headroomNetUsdcRaw),
    ['1004430', '1004437'],
  )
  assert.equal(result.process.intervals[0].donor.durationSeconds, 3072)
  assert.equal(result.process.intervals[0].donor.jointNetDeltaRaw.bridgeFunding, '-5912686762')
  assert.equal(result.process.intervals[0].donor.jointNetDeltaRaw.bankCash, '-3737962357')
})
test('research Q preserves original unknown final USDT question', () => {
  assert.equal(result.input.requestedFinalUsdtRaw, '10145')
  assert.equal(result.input.baseline.conversion.requiredNetUsdcRaw, '10144')
  assert.equal(result.input.originalQuestion.firstLegUsdcRequestedRaw, '10145')
  assert.equal(result.input.originalQuestion.finalUsdtRequestedRaw, null)
  assert.equal(result.input.originalQuestion.questionBinding, 'unassessed')
  assert.equal(result.report.originalQuestionResolved, false)
  assert.equal(result.report.provenanceCorrection.rawArtifactImmutable, true)
})
test('dated output does not manufacture future path, payout, probability or USDT maximum', () => {
  assert.equal(result.process.prospectiveProcess, null)
  assert.equal(result.process.conditionalRequestedBucketCoverage, null)
  assert.equal(result.process.unrestrictedFinalUsdtCapacityRaw, null)
  assert.equal(result.process.fullHolderEntitlementUsdtRaw, null)
  assert.equal(result.process.continuousPathKnown, false)
  assert.equal(result.process.calibratedProbability, false)
  assert.equal(result.process.minedPayout, false)
  assert.equal(result.process.sourceImplementationEquivalence, false)
  assert.equal(result.process.thinHistoricalEvidence, true)
  assert.deepEqual(result.process.sampledHistoricalShortfalls, [])
})

for (const [name, mutate] of [
  [
    'full net E',
    (i) => {
      i.baseline.fullHolderNetUsdcRaw = '1014582'
    },
  ],
  [
    'funding versus bank cash',
    (i) => {
      i.baseline.nativeProngs.bridgeFunding = i.baseline.nativeProngs.bankCash
    },
  ],
  [
    'full shares',
    (i) => {
      i.baseline.holderSharesRaw = '1'
    },
  ],
  [
    'owner',
    (i) => {
      i.owner = '0x' + '1'.repeat(40)
    },
  ],
  [
    'fee',
    (i) => {
      i.baseline.withdrawalFeeBps = 6
    },
  ],
  [
    'source block',
    (i) => {
      i.baseline.source.blockNumber = '26102144'
    },
  ],
  [
    'runtime code',
    (i) => {
      i.baseline.runtimeCodeHashes[i.destination] = '0x' + 'a'.repeat(64)
    },
  ],
  [
    'question unit',
    (i) => {
      i.originalQuestion.finalUsdtRequestedRaw = '10145'
    },
  ],
  [
    'quote input unit',
    (i) => {
      i.baseline.conversion.inputDecimals = 18
    },
  ],
  [
    'quote Q scaling',
    (i) => {
      i.requestedFinalUsdtRaw = '101450'
    },
  ],
  [
    'capture backdating',
    (i) => {
      i.baseline.availableAtUtc = i.baseline.source.blockTime
    },
  ],
  [
    'future custom grid',
    (i) => {
      i.futureTimes = ['2026-10-08T00:00:00.000Z']
    },
  ],
])
  test(`independent evidence approval refuses modified ${name}`, () => {
    const candidate = clone()
    mutate(candidate)
    assert.equal(result.approve('history', candidate), false)
    assert.equal(helper.buildFluidUsdtBridgeJointHistoricalProcess(candidate, result.approve), null)
  })
test('expired actual sources cannot enter current conditional mode', () => {
  const candidate = clone()
  candidate.mode = 'current_conditional'
  assert.equal(result.approve('current', candidate), false)
  assert.equal(helper.buildFluidUsdtBridgeJointHistoricalProcess(candidate, result.approve), null)
  // Expired-source gate also rejects a permissive callback.
  assert.equal(
    helper.buildFluidUsdtBridgeJointHistoricalProcess(candidate, () => true),
    null,
  )
})
for (const key of ['native', 'fixed'])
  test(`immutable ${key} bytes cannot be replaced by self-resealed provider disagreement`, async () => {
    const raw = JSON.parse(texts[key])
    if (key === 'native')
      raw.wrapperOrigins[1].observations[0].traces[0].response.result.hash = '0x' + 'a'.repeat(64)
    else raw.traces[1].response.result = '0x' + '0'.repeat(256)
    await assert.rejects(
      replayFluidUsdtBridgeJointHistory({ ...texts, [key]: reseal(raw) }),
      /immutable_file_pin/,
    )
  })
test('caller cannot mutate the private canonical approval through returned input', () => {
  const candidate = clone()
  candidate.baseline.fullHolderNetUsdcRaw = '0'
  assert.equal(result.approve('history', candidate), false)
  assert.ok(result.approve('history', clone()))
  assert.ok(Object.isFrozen(result.process.input.baseline))
  assert.equal(networkAttempts, 0)
})
