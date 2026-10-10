import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  appendLocalCarryExitV2Record,
  CARRY_EXIT_V2_HORIZONS,
  CARRY_EXIT_V2_PREDECESSOR,
  dueLocalCarryExitV2Targets,
  getLocalCarryExitV2Prior,
  LocalCarryExitV2StoreError,
  projectLocalCarryExitV2Coverage,
  recoverLocalCarryExitV2Head,
  verifyLocalCarryExitV2Ledger,
} from './localCarryExitV2Store.mjs'

const base = Date.parse('2026-10-05T12:00:00.000Z')
const at = (hours = 0) => new Date(base + hours * 3_600_000).toISOString()
const destination = `0x${'1'.repeat(40)}`
const asset = `0x${'2'.repeat(40)}`
const blockHash = `0x${'3'.repeat(64)}`
const digest = (text) => createHash('sha256').update(text).digest('hex')
const fixture = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'carry-exit-v2-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { root: join(dir, 'store') }
}
const issuePayload = (overrides = {}) => ({
  issueId: 'issue-1',
  routeKey: 'USDC -> vault',
  destination,
  asset,
  decimals: 6,
  assetsRaw: '1000000',
  baselineStatus: 'success',
  baselineBlock: '123',
  baselineHash: blockHash,
  baselineBlockAtUtc: at(-0.01),
  issuedAtUtc: at(),
  proofEnvelope: { pinnedRpc: 'rpc-1', privateHolder: destination, rawProof: 'secret-proof' },
  issueEnvelope: { method: 'redeem', calldata: '0x1234' },
  plan: CARRY_EXIT_V2_HORIZONS.map((horizonH) => ({
    horizonH,
    predecessorH: CARRY_EXIT_V2_PREDECESSOR[horizonH],
    conditionalRecovery: false,
    targetAtUtc: at(horizonH),
    deadlineAtUtc: at(horizonH + 2),
  })),
  ...overrides,
})
const append = (root, kind, payload, hours = 0) =>
  appendLocalCarryExitV2Record(kind, payload, {
    root,
    now: base + hours * 3_600_000,
    minFreeBytes: 0,
  })
const issueAndWitness = (root, issue = issuePayload()) => {
  const issued = append(root, 'issue', issue)
  const readback = append(
    root,
    'readback',
    {
      issueId: issue.issueId,
      issueSha256: issued.sha256,
      witnessId: `w-${issue.issueId}`,
      readbackAtUtc: at(0.1),
      readbackProof: { independentLocalRead: 'verified', rawPrivate: 'secret' },
    },
    0.2,
  )
  return { issued, readback }
}
const outcome = (root, issueId, horizonH, kind, status, hours = horizonH + 0.5, overrides = {}) => {
  const state = verifyLocalCarryExitV2Ledger({ root })
  const issue = state.issues.get(issueId)
  const plan = issue.payload.plan.find((row) => row.horizonH === horizonH)
  const prior = getLocalCarryExitV2Prior(state, issueId, horizonH)
  const core = {
    issueId,
    horizonH,
    targetAtUtc: plan.targetAtUtc,
    deadlineAtUtc: plan.deadlineAtUtc,
    predecessorH: plan.predecessorH,
    predecessorSha256: prior?.predecessorSha256 ?? null,
    status,
  }
  const payload =
    kind === 'missing'
      ? { ...core, reason: 'target window unavailable', receiptAtUtc: at(hours) }
      : {
          ...core,
          scoredAtUtc: at(hours),
          scoreEnvelope: { selectedBlock: '456' },
          proofEnvelope: { rawPrivate: 'private-target-proof' },
          targetBlock: ['not_eligible', 'episode_censored'].includes(status) ? null : '456',
          targetHash: ['not_eligible', 'episode_censored'].includes(status) ? null : blockHash,
          targetBlockAtUtc: ['not_eligible', 'episode_censored'].includes(status)
            ? null
            : at(horizonH + 0.1),
          observedAtUtc: ['not_eligible', 'episode_censored'].includes(status)
            ? null
            : at(horizonH + 0.2),
        }
  return append(root, kind, { ...payload, ...overrides }, hours)
}
const typed = (code) => (error) =>
  error instanceof LocalCarryExitV2StoreError && error.code.endsWith(code)

test('clean replay retains all record kinds, exact due inputs, and local-only claims', (t) => {
  const { root } = fixture(t)
  append(root, 'attempt', { attemptId: 'attempt-1', stage: 'candidate', status: 'selected' })
  issueAndWitness(root)
  let state = verifyLocalCarryExitV2Ledger({ root })
  assert.equal(state.records.length, 3)
  assert.deepEqual(
    dueLocalCarryExitV2Targets(state, base + 3_600_000).map((row) => row.horizonH),
    [1],
  )
  assert.equal(getLocalCarryExitV2Prior(state, 'issue-1', 1).predecessorStatus, 'success')
  outcome(root, 'issue-1', 1, 'score', 'success')
  state = verifyLocalCarryExitV2Ledger({ root })
  assert.equal(getLocalCarryExitV2Prior(state, 'issue-1', 4).predecessorStatus, 'success')
  assert.deepEqual(
    dueLocalCarryExitV2Targets(state, base + 4 * 3_600_000).map((row) => row.horizonH),
    [4],
  )
  outcome(root, 'issue-1', 4, 'missing', 'missing', 6)
  outcome(root, 'issue-1', 24, 'score', 'holder_attrition', 24.5)
  outcome(root, 'issue-1', 48, 'missing', 'censored', 50)
  outcome(root, 'issue-1', 168, 'score', 'episode_censored', 168.5)
  state = verifyLocalCarryExitV2Ledger({ root })
  const coverage = projectLocalCarryExitV2Coverage(state, base + 169 * 3_600_000)
  assert.deepEqual(
    coverage.subjects.map((row) => [
      row.issued,
      row.recorded_unverified,
      row.measured,
      row.missing,
      row.unavailable,
      row.censored,
    ]),
    [[1, 3, 0, 1, 0, 1]],
  )
  assert.equal(coverage.measurementValidatorId, null)
  assert.equal(coverage.externalMonotonicCheckpoint, false)
  assert.equal(coverage.rollbackProof, false)
  assert.match(coverage.chainLimitation, /no external monotonic checkpoint or rollback proof/)
  const validated = projectLocalCarryExitV2Coverage(state, base + 169 * 3_600_000, {
    validatorId: 'synthetic-fixture-v1',
    measurementValidator: ({ issueRecord, readbackRecord, scoreRecord, plan }) =>
      issueRecord.payload.baselineHash === blockHash &&
      readbackRecord.payload.readbackProof.independentLocalRead === 'verified' &&
      scoreRecord.payload.targetAtUtc === plan.targetAtUtc &&
      scoreRecord.payload.proofEnvelope.rawPrivate === 'private-target-proof',
  })
  assert.equal(validated.measurementValidatorId, 'synthetic-fixture-v1')
  assert.equal(validated.subjects[0].measured, 2)
  assert.equal(validated.subjects[0].censored, 2)
  assert.equal(validated.subjects[0].recorded_unverified, 0)
  assert.deepEqual(
    state.records.map((row) => row.kind),
    ['attempt', 'issue', 'readback', 'score', 'missing', 'score', 'missing', 'score'],
  )
  for (const flag of [
    'prospectiveValidated',
    'forecastValidated',
    'holderExecutableExit',
    'minedPayoutProven',
    'independentTimestamp',
    'independentWitness',
    'calibratedForecast',
  ])
    assert.equal(coverage[flag], false)
})

test('exact route, destination, asset, decimals, raw Q, and horizon cells remain separate', (t) => {
  const { root } = fixture(t)
  const variants = [
    {},
    { routeKey: 'USDC -> other vault' },
    { destination: `0x${'4'.repeat(40)}` },
    { asset: `0x${'5'.repeat(40)}` },
    { decimals: 18 },
    { assetsRaw: '1000001' },
  ]
  for (const [index, variant] of variants.entries()) {
    const issuedAtUtc = at(index / 100)
    const issue = issuePayload({
      ...variant,
      issueId: `issue-${index}`,
      baselineBlockAtUtc: at(-0.01),
      issuedAtUtc,
      plan: CARRY_EXIT_V2_HORIZONS.map((horizonH) => ({
        horizonH,
        predecessorH: CARRY_EXIT_V2_PREDECESSOR[horizonH],
        conditionalRecovery: false,
        targetAtUtc: new Date(Date.parse(issuedAtUtc) + horizonH * 3_600_000).toISOString(),
        deadlineAtUtc: new Date(Date.parse(issuedAtUtc) + (horizonH + 2) * 3_600_000).toISOString(),
      })),
    })
    append(root, 'issue', issue, index / 100)
  }
  const coverage = projectLocalCarryExitV2Coverage(verifyLocalCarryExitV2Ledger({ root }), base)
  assert.equal(coverage.subjects.length, 6)
  assert.equal(
    coverage.subjects.reduce((n, row) => n + row.cells.length, 0),
    30,
  )
  assert(
    coverage.subjects.every(
      (row) => row.cells.map((cell) => cell.horizonH).join(',') === '1,4,24,48,168',
    ),
  )
})

test('an unwitnessed issue fails closed at H1 without poisoning a later witnessed episode', (t) => {
  const { root } = fixture(t)
  append(root, 'issue', issuePayload())

  const beforeH1 = projectLocalCarryExitV2Coverage(
    verifyLocalCarryExitV2Ledger({ root }),
    base + 3_600_000 - 1,
  ).subjects[0]
  assert.equal(beforeH1.pending, CARRY_EXIT_V2_HORIZONS.length)
  assert.equal(beforeH1.unavailable, 0)
  assert(
    beforeH1.cells.every(
      (cell) => cell.status === 'pending' && cell.reason === null && cell.witnessed === false,
    ),
  )

  const atH1 = projectLocalCarryExitV2Coverage(
    verifyLocalCarryExitV2Ledger({ root }),
    base + 3_600_000,
  ).subjects[0]
  assert.equal(atH1.pending, 0)
  assert.equal(atH1.unavailable, CARRY_EXIT_V2_HORIZONS.length)
  assert(
    atH1.cells.every(
      (cell) =>
        cell.status === 'unavailable' &&
        cell.reason === 'readback_not_sealed_before_h1' &&
        cell.witnessed === false,
    ),
  )
  assert.equal(atH1.cells.find((cell) => cell.horizonH === 168).due, false)

  const laterIssuedAtUtc = at(2)
  const laterIssue = issuePayload({
    issueId: 'issue-2',
    baselineBlock: '124',
    baselineBlockAtUtc: at(1.99),
    issuedAtUtc: laterIssuedAtUtc,
    plan: CARRY_EXIT_V2_HORIZONS.map((horizonH) => ({
      horizonH,
      predecessorH: CARRY_EXIT_V2_PREDECESSOR[horizonH],
      conditionalRecovery: false,
      targetAtUtc: new Date(Date.parse(laterIssuedAtUtc) + horizonH * 3_600_000).toISOString(),
      deadlineAtUtc: new Date(
        Date.parse(laterIssuedAtUtc) + (horizonH + 2) * 3_600_000,
      ).toISOString(),
    })),
  })
  const later = append(root, 'issue', laterIssue, 2)
  append(
    root,
    'readback',
    {
      issueId: 'issue-2',
      issueSha256: later.sha256,
      witnessId: 'w-issue-2',
      readbackAtUtc: at(2.1),
      readbackProof: { independentLocalRead: 'verified' },
    },
    2.2,
  )

  const combined = projectLocalCarryExitV2Coverage(
    verifyLocalCarryExitV2Ledger({ root }),
    base + 3 * 3_600_000,
  ).subjects[0]
  assert.equal(combined.issued, 2)
  assert.equal(combined.unavailable, CARRY_EXIT_V2_HORIZONS.length)
  assert.equal(combined.pending, CARRY_EXIT_V2_HORIZONS.length)
  assert(
    combined.cells
      .filter((cell) => cell.witnessed)
      .every((cell) => cell.status === 'pending' && cell.reason === null),
  )
})

test('duplicate identical append is idempotent; changed logical keys and repeated episode are refused', (t) => {
  const { root } = fixture(t)
  const issue = issuePayload()
  const first = append(root, 'issue', issue)
  assert.equal(append(root, 'issue', issue, 0.5).sha256, first.sha256)
  assert.equal(verifyLocalCarryExitV2Ledger({ root }).records.length, 1)
  assert.throws(
    () => append(root, 'issue', { ...issue, assetsRaw: '2000000' }),
    typed('duplicate_logical_key'),
  )
  assert.throws(
    () => append(root, 'issue', { ...issue, issueId: 'issue-2' }),
    typed('duplicate_episode'),
  )
})

test('read-only head lag fails without mutation and explicit recorder recovery advances head', (t) => {
  const { root } = fixture(t)
  const issued = append(root, 'issue', issuePayload())
  const headPath = `${root}.head.json`
  const oldHead = readFileSync(headPath, 'utf8')
  const witness = append(
    root,
    'readback',
    {
      issueId: 'issue-1',
      issueSha256: issued.sha256,
      witnessId: 'w-1',
      readbackAtUtc: at(0.1),
      readbackProof: { receipt: 'verified' },
    },
    0.2,
  )
  writeFileSync(headPath, oldHead)
  assert.throws(() => verifyLocalCarryExitV2Ledger({ root }), typed('head_lag_recovery_required'))
  assert.throws(
    () => verifyLocalCarryExitV2Ledger({ root, recoverHead: true, lockHeld: true }),
    typed('head_lag_recovery_required'),
  )
  assert.equal(readFileSync(headPath, 'utf8'), oldHead)
  assert.equal(recoverLocalCarryExitV2Head({ root }).lastSha256, witness.sha256)
  assert.equal(verifyLocalCarryExitV2Ledger({ root }).records.length, 2)
})

test('corrupt bytes, truncation, tamper, and sequence gaps fail verification', (t) => {
  const { root } = fixture(t)
  append(root, 'issue', issuePayload())
  const path = join(root, '000000000001.json')
  const original = readFileSync(path, 'utf8')
  for (const bad of [
    original.slice(0, -10),
    original.replace('1000000', '1000001'),
    `${original.trim()}  \n`,
  ]) {
    writeFileSync(path, bad)
    assert.throws(() => verifyLocalCarryExitV2Ledger({ root }), LocalCarryExitV2StoreError)
  }
  const resealed = JSON.parse(original)
  resealed.payload.assetsRaw = '1000001'
  const { sha256: _ignored, ...body } = resealed
  resealed.sha256 = digest(JSON.stringify(body))
  writeFileSync(path, `${JSON.stringify(resealed)}\n`)
  assert.throws(
    () => verifyLocalCarryExitV2Ledger({ root }),
    typed('head_ahead_or_prefix_mismatch'),
  )
})

test('a missing sequence file is rejected before any head recovery', (t) => {
  const { root } = fixture(t)
  issueAndWitness(root)
  renameSync(join(root, '000000000002.json'), join(root, '000000000003.json'))
  assert.throws(() => verifyLocalCarryExitV2Ledger({ root }), typed('sequence_gap'))
  assert.throws(() => recoverLocalCarryExitV2Head({ root }), typed('sequence_gap'))
})

test('causal ordering and target/deadline/predecessor controls reject invalid records', (t) => {
  const { root } = fixture(t)
  assert.throws(
    () =>
      append(root, 'readback', {
        issueId: 'issue-1',
        witnessId: 'w',
        issueSha256: '0'.repeat(64),
        readbackAtUtc: at(),
        readbackProof: { receipt: 'claimed' },
      }),
    typed('readback_before_issue'),
  )
  const badPlan = issuePayload()
  badPlan.plan[0].deadlineAtUtc = at(2)
  assert.throws(() => append(root, 'issue', badPlan), typed('plan_target_deadline_invalid'))
  issueAndWitness(root)
  const state = verifyLocalCarryExitV2Ledger({ root })
  const plan = state.issues.get('issue-1').payload.plan[1]
  const h4 = {
    issueId: 'issue-1',
    horizonH: 4,
    targetAtUtc: plan.targetAtUtc,
    deadlineAtUtc: plan.deadlineAtUtc,
    predecessorH: 1,
    predecessorSha256: null,
    status: 'success',
    scoredAtUtc: at(4.5),
    scoreEnvelope: { x: 1 },
    proofEnvelope: { x: 1 },
  }
  assert.throws(() => append(root, 'score', h4, 4.5), typed('predecessor_missing'))
  assert.throws(
    () => outcome(root, 'issue-1', 1, 'missing', 'missing', 2),
    typed('missing_invalid'),
  )
  assert.throws(
    () => outcome(root, 'issue-1', 1, 'score', 'success', 0.5),
    typed('score_before_target'),
  )
  const h1 = outcome(root, 'issue-1', 1, 'score', 'success')
  assert.throws(
    () => append(root, 'score', { ...h4, predecessorSha256: 'f'.repeat(64) }, 4.5),
    typed('predecessor_mismatch'),
  )
  assert.equal(
    getLocalCarryExitV2Prior(verifyLocalCarryExitV2Ledger({ root }), 'issue-1', 4)
      .predecessorSha256,
    h1.sha256,
  )
})

test('late measured and control scores are refused after their frozen deadline', (t) => {
  const { root } = fixture(t)
  issueAndWitness(root)
  assert.throws(
    () => outcome(root, 'issue-1', 1, 'score', 'success', 3.01),
    typed('score_after_deadline'),
  )
  const control = issuePayload({
    issueId: 'control-1',
    assetsRaw: '2000000',
    baselineStatus: 'ineligible',
  })
  const { root: controlRoot } = fixture(t)
  issueAndWitness(controlRoot, control)
  assert.throws(
    () => outcome(controlRoot, 'control-1', 1, 'score', 'not_eligible', 3.01),
    typed('score_after_deadline'),
  )
  outcome(root, 'issue-1', 1, 'missing', 'missing', 3.01)
})

test('overdue missing statuses preserve eligibility and attrition semantics', (t) => {
  const { root: eligibleRoot } = fixture(t)
  issueAndWitness(eligibleRoot)
  assert.throws(
    () => outcome(eligibleRoot, 'issue-1', 1, 'missing', 'censored', 3.01),
    typed('missing_invalid'),
  )
  outcome(eligibleRoot, 'issue-1', 1, 'missing', 'unavailable', 3.01)

  const { root: controlRoot } = fixture(t)
  issueAndWitness(
    controlRoot,
    issuePayload({ issueId: 'control-1', assetsRaw: '2000000', baselineStatus: 'ineligible' }),
  )
  assert.throws(
    () => outcome(controlRoot, 'control-1', 1, 'missing', 'missing', 3.01),
    typed('missing_invalid'),
  )
  outcome(controlRoot, 'control-1', 1, 'missing', 'unavailable', 3.01)

  const { root: attritionRoot } = fixture(t)
  issueAndWitness(attritionRoot)
  outcome(attritionRoot, 'issue-1', 1, 'score', 'holder_attrition')
  assert.throws(
    () => outcome(attritionRoot, 'issue-1', 4, 'missing', 'missing', 6.01),
    typed('missing_invalid'),
  )
  outcome(attritionRoot, 'issue-1', 4, 'missing', 'censored', 6.01)
})

test('readback must be committed before H1 and before any target observation', (t) => {
  const { root } = fixture(t)
  const issued = append(root, 'issue', issuePayload())
  const payload = {
    issueId: 'issue-1',
    issueSha256: issued.sha256,
    witnessId: 'late',
    readbackAtUtc: at(1),
    readbackProof: { receipt: 'local' },
  }
  assert.throws(() => append(root, 'readback', payload, 1), typed('readback_time_invalid'))
  assert.throws(
    () => append(root, 'readback', { ...payload, readbackAtUtc: at(0.5) }, 1),
    typed('readback_time_invalid'),
  )
  assert.equal(verifyLocalCarryExitV2Ledger({ root }).readbacks.size, 0)
})

test('readback time cannot predate the durable issue record', (t) => {
  const { root } = fixture(t)
  const issued = append(root, 'issue', issuePayload(), 0.5)
  assert.throws(
    () =>
      append(
        root,
        'readback',
        {
          issueId: 'issue-1',
          issueSha256: issued.sha256,
          witnessId: 'backdated',
          readbackAtUtc: at(0.1),
          readbackProof: { receipt: 'local' },
        },
        0.6,
      ),
    typed('readback_time_invalid'),
  )
})

test('measured target blocks must advance beyond baseline and any concrete predecessor', (t) => {
  const { root } = fixture(t)
  issueAndWitness(root)
  assert.throws(
    () => outcome(root, 'issue-1', 1, 'score', 'success', 1.5, { targetBlock: '123' }),
    typed('score_target_invalid'),
  )
  outcome(root, 'issue-1', 1, 'score', 'success')
  assert.throws(
    () => outcome(root, 'issue-1', 4, 'score', 'success', 4.5, { targetBlock: '456' }),
    typed('score_target_invalid'),
  )
  outcome(root, 'issue-1', 4, 'score', 'success', 4.5, { targetBlock: '457' })
})

test('non-plain, accessor, and toJSON payloads cannot append a replay-breaking record', (t) => {
  const { root } = fixture(t)
  const accessor = issuePayload()
  Object.defineProperty(accessor, 'assetsRaw', { enumerable: true, get: () => '1000000' })
  assert.throws(() => append(root, 'issue', accessor), typed('payload_non_plain'))
  const customJson = issuePayload({ issueId: 'issue-json' })
  customJson.toJSON = () => ({ ...customJson, toJSON: undefined })
  assert.throws(() => append(root, 'issue', customJson), LocalCarryExitV2StoreError)
  const nestedAccessor = issuePayload({ issueId: 'issue-nested' })
  Object.defineProperty(nestedAccessor.proofEnvelope, 'hidden', {
    enumerable: true,
    get: () => 'secret',
  })
  assert.throws(() => append(root, 'issue', nestedAccessor), typed('payload_non_plain'))
  const ordinary = issuePayload()
  const recorded = append(root, 'issue', ordinary)
  ordinary.assetsRaw = '9999999'
  assert.equal(verifyLocalCarryExitV2Ledger({ root }).issues.get('issue-1').sha256, recorded.sha256)
})

test('canonical payload ordering makes equivalent retries idempotent', (t) => {
  const { root } = fixture(t)
  const first = issuePayload({
    proofEnvelope: { z: { second: 2, first: 1 }, a: 'same' },
    issueEnvelope: { method: 'redeem', calldata: '0x1234' },
  })
  const recorded = append(root, 'issue', first)
  const retry = issuePayload({
    proofEnvelope: { a: 'same', z: { first: 1, second: 2 } },
    issueEnvelope: { calldata: '0x1234', method: 'redeem' },
  })
  assert.equal(append(root, 'issue', retry).sha256, recorded.sha256)
  assert.equal(verifyLocalCarryExitV2Ledger({ root }).records.length, 1)
})

test('placeholder score envelopes stay unverified unless a named validator checks them', (t) => {
  const { root } = fixture(t)
  issueAndWitness(root)
  outcome(root, 'issue-1', 1, 'score', 'success')
  const state = verifyLocalCarryExitV2Ledger({ root })
  const defaultView = projectLocalCarryExitV2Coverage(state, base + 2 * 3_600_000)
  assert.equal(defaultView.subjects[0].recorded_unverified, 1)
  assert.equal(defaultView.subjects[0].measured, 0)
  assert.equal(defaultView.subjects[0].cells[0].status, 'recorded_unverified')
  const rejected = projectLocalCarryExitV2Coverage(state, base + 2 * 3_600_000, {
    validatorId: 'synthetic-fixture-v1',
    measurementValidator: () => false,
  })
  assert.equal(rejected.subjects[0].measured, 0)
  assert.equal(rejected.subjects[0].recorded_unverified, 1)
  assert.throws(
    () =>
      projectLocalCarryExitV2Coverage(state, base, {
        measurementValidator: () => true,
      }),
    typed('measurement_validator_invalid'),
  )
})

test('coverage projection never exposes private holder identifiers or raw proofs', (t) => {
  const { root } = fixture(t)
  issueAndWitness(root)
  const projected = JSON.stringify(
    projectLocalCarryExitV2Coverage(verifyLocalCarryExitV2Ledger({ root }), base),
  )
  for (const secret of [
    'privateHolder',
    'secret-proof',
    'private-target-proof',
    'rawPrivate',
    'calldata',
    'w-issue-1',
    'issue-1',
  ])
    assert(!projected.includes(secret), secret)
})
