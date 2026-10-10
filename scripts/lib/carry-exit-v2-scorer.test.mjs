import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ExitV2ScorePreparationError, prepareCarryExitV2Control } from './carry-exit-v2-scorer.mjs'

const address = (digit) => `0x${digit.repeat(40)}`
const hash = (digit) => `0x${digit.repeat(64)}`
const expectCode = (code) => (error) =>
  error instanceof ExitV2ScorePreparationError && error.code === code

function fixture() {
  return {
    batch: {
      id: '7',
      routeKey: 'USDC -> USD3 [USDC]',
      destination: address('2'),
      asset: address('3'),
      holder: address('1'),
      issuedAt: '2026-09-29T23:00:00.000001Z',
      baselineBlock: '100',
      baselineHash: hash('a'),
      baselineBlockAt: '2026-09-29T22:59:48.000Z',
    },
    caseRow: { id: '9', batchId: '7', assetsRaw: '1000000', baselineStatus: 'success' },
    plan: {
      caseId: '9',
      horizonH: 1,
      predecessorH: 0,
      conditionalRecovery: false,
      targetAt: '2026-09-30T00:00:00.000001Z',
      deadlineAt: '2026-09-30T02:00:00.000001Z',
    },
    priorScores: [],
  }
}

function setH48(args, statuses) {
  args.plan = {
    ...args.plan,
    horizonH: 48,
    predecessorH: 24,
    conditionalRecovery: false,
    targetAt: '2026-10-01T23:00:00.000001Z',
    deadlineAt: '2026-10-02T01:00:00.000001Z',
  }
  args.priorScores = [1, 4, 24].map((horizonH, index) => ({
    id: String(index + 1),
    caseId: '9',
    horizonH,
    status: statuses[index],
    targetBlock: String(200 + index),
    targetHash: hash('b'),
    targetBlockAt: '2026-09-30T00:00:12.000Z',
  }))
}

test('eligible H1 returns measurement_required with frozen baseline predecessor', () => {
  const result = prepareCarryExitV2Control(fixture())
  assert.equal(result.kind, 'measurement_required')
  assert.equal(result.core.predecessorStatus, 'success')
  assert.equal(result.core.predecessorBlock, '100')
  assert.equal(result.core.predecessorHash, hash('a'))
  assert.equal(result.core.predecessorScoreId, null)
  assert.equal(result.core.status, undefined)
})

test('ineligible baseline emits only a not_eligible row with null measurement fields', () => {
  const args = fixture()
  args.caseRow.baselineStatus = 'ineligible'
  const result = prepareCarryExitV2Control(args)
  assert.equal(result.row.status, 'not_eligible')
  assert.equal(result.row.targetBlock, null)
  assert.equal(result.row.callEvidenceDoc, null)
  assert.equal(result.row.missingReason, null)
})

test('H48 after sampled success still requires an exact future measurement', () => {
  const args = fixture()
  setH48(args, ['covered_revert', 'covered_revert', 'success'])
  const result = prepareCarryExitV2Control(args)
  assert.equal(result.kind, 'measurement_required')
  assert.equal(result.core.predecessorScoreId, '3')
  assert.equal(result.core.predecessorBlock, '202')
})

test('H48 after sampled covered revert still requires route-specific measurement', () => {
  const args = fixture()
  setH48(args, ['covered_revert', 'covered_revert', 'covered_revert'])
  const result = prepareCarryExitV2Control(args)
  assert.equal(result.kind, 'measurement_required')
  assert.equal(result.core.status, undefined)
})

test('H168 after five sampled successes still requires an exact future measurement', () => {
  const args = fixture()
  setH48(args, ['success', 'success', 'success'])
  args.plan = {
    ...args.plan,
    horizonH: 168,
    predecessorH: 48,
    targetAt: '2026-10-06T23:00:00.000001Z',
    deadlineAt: '2026-10-07T01:00:00.000001Z',
  }
  args.priorScores.push({
    id: '4',
    caseId: '9',
    horizonH: 48,
    status: 'success',
    targetBlock: '203',
    targetHash: hash('c'),
    targetBlockAt: '2026-10-01T23:00:12.000Z',
  })
  const result = prepareCarryExitV2Control(args)
  assert.equal(result.kind, 'measurement_required')
  assert.equal(result.core.predecessorScoreId, '4')
  assert.equal(result.core.predecessorBlock, '203')
})

test('conditional future plans and skipped predecessor rows are rejected', () => {
  const args = fixture()
  setH48(args, ['success', 'success', 'success'])
  args.plan.conditionalRecovery = true
  assert.throws(() => prepareCarryExitV2Control(args), expectCode('invalid_frozen_plan'))
  args.plan.conditionalRecovery = false
  args.priorScores[2].status = 'not_triggered'
  args.priorScores[2].targetBlock = null
  args.priorScores[2].targetHash = null
  args.priorScores[2].targetBlockAt = null
  assert.throws(() => prepareCarryExitV2Control(args), expectCode('prior_scores_invalid'))
})

test('prior holder attrition censors later recovery measurement', () => {
  const args = fixture()
  setH48(args, ['covered_revert', 'holder_attrition', 'episode_censored'])
  Object.assign(args.priorScores[2], {
    targetBlock: null,
    targetHash: null,
    targetBlockAt: null,
  })
  assert.equal(prepareCarryExitV2Control(args).row.status, 'episode_censored')
  args.priorScores[2].status = 'covered_revert'
  assert.throws(() => prepareCarryExitV2Control(args), expectCode('prior_scores_invalid'))
})

test('mandatory H4 is censored after H1 holder attrition', () => {
  const args = fixture()
  args.plan = {
    ...args.plan,
    horizonH: 4,
    predecessorH: 1,
    targetAt: '2026-09-30T03:00:00.000001Z',
    deadlineAt: '2026-09-30T05:00:00.000001Z',
  }
  args.priorScores = [
    {
      id: '1',
      caseId: '9',
      horizonH: 1,
      status: 'holder_attrition',
      targetBlock: '200',
      targetHash: hash('b'),
      targetBlockAt: '2026-09-30T00:00:12.000Z',
    },
  ]
  assert.equal(prepareCarryExitV2Control(args).row.status, 'episode_censored')
})

test('baseline covered revert still requires H48 measurement after intervening missing rows', () => {
  const args = fixture()
  args.caseRow.baselineStatus = 'covered_revert'
  setH48(args, ['missing', 'missing', 'missing'])
  for (const row of args.priorScores) {
    row.targetBlock = null
    row.targetHash = null
    row.targetBlockAt = null
  }
  assert.equal(prepareCarryExitV2Control(args).kind, 'measurement_required')
})

test('missing or misordered predecessor rows are refused', () => {
  const args = fixture()
  setH48(args, ['covered_revert', 'covered_revert', 'success'])
  args.priorScores.pop()
  assert.throws(() => prepareCarryExitV2Control(args), expectCode('prior_scores_incomplete'))
  args.priorScores.push({ ...args.priorScores[1], id: '3', horizonH: 24, caseId: '10' })
  assert.throws(() => prepareCarryExitV2Control(args), expectCode('prior_scores_invalid'))
})

test('prior status and source fields must agree with DB control semantics', () => {
  const args = fixture()
  setH48(args, ['covered_revert', 'covered_revert', 'success'])
  args.priorScores[0].status = 'not_triggered'
  assert.throws(() => prepareCarryExitV2Control(args), expectCode('prior_scores_invalid'))
  args.priorScores[0].status = 'covered_revert'
  args.priorScores[2].targetBlock = null
  assert.throws(() => prepareCarryExitV2Control(args), expectCode('prior_scores_invalid'))
})

test('exact DB microsecond issue clock is enforced', () => {
  const args = fixture()
  args.plan.targetAt = '2026-09-30T00:00:00.000000Z'
  assert.throws(() => prepareCarryExitV2Control(args), expectCode('invalid_frozen_plan'))
})

test('a measured or missing status is never synthesized from supplied loose fields', () => {
  const args = fixture()
  args.quote = { status: 'success' }
  args.missingReason = 'rpc_unavailable'
  const result = prepareCarryExitV2Control(args)
  assert.equal(result.kind, 'measurement_required')
  assert.equal(result.core.status, undefined)
})
