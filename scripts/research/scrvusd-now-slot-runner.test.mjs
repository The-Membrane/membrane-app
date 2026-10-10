import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createNowSchedule } from './scrvusd-now-schedule.mjs'
import {
  attemptStartNameV1,
  boundIssueNameV2,
  buildAttemptStartV1,
} from './scrvusd-exit-forecast-issue.mjs'
import {
  ISSUE_OUT,
  START_OUT,
  acceptsSourceStageResult,
  recoverNowSlotFinalization,
  runNowSlot,
} from './scrvusd-now-slot-runner.mjs'
import { ATTEMPT_START_OUT_V1, ISSUE_OUT_V2 } from './scrvusd-bound-exit-forecast-score.mjs'

const time = '2026-09-29T12:00:12.000Z'
const manifest = createNowSchedule({
  plannedAtUtc: '2026-09-29T09:00:00.000Z',
  startAtUtc: '2026-09-29T12:00:00.000Z',
  endAtUtc: '2026-09-29T13:00:00.000Z',
})
const slotId = manifest.slots[0].slotId
const proof = {
  manifest,
  prospectiveScheduleConfirmed: true,
  historicalPublicationAvailabilityCertified: true,
  evidenceClass: 'db_witnessed_manifest',
  publisherXid: '100',
  confirmerXid: '101',
  witnessXid: '102',
  confirmedAtUtc: '2026-09-29T09:00:02.000Z',
  manifestVisibleAtUtc: '2026-09-29T09:00:03.000Z',
}
const stat = () => ({ bavail: 100000000, bsize: 4096 })

test('default v2 issue and start directories match the score lane', () => {
  assert.equal(ISSUE_OUT, ISSUE_OUT_V2)
  assert.equal(START_OUT, ATTEMPT_START_OUT_V1)
})

test('default holder stage retains observed failures instead of selecting successes', () => {
  assert.equal(acceptsSourceStageResult('holder', 'success'), true)
  assert.equal(acceptsSourceStageResult('holder', 'revert'), true)
  assert.equal(acceptsSourceStageResult('holder', 'provider_error'), true)
  assert.equal(acceptsSourceStageResult('holder', 'unavailable'), false)
  assert.equal(acceptsSourceStageResult('quote', 'revert'), false)
})

function harness({
  failStart = null,
  failResult = null,
  floor = '2026-09-29T12:00:11.000Z',
  sourceStartAtUtc = '2026-09-29T12:00:11.500Z',
  failSourceStart = false,
  missingSourceStart = false,
  witnessAtUtc = '2026-09-29T12:00:12.000Z',
  failWitness = false,
  missingWitness = false,
  source = { status: 'failed', reason: 'process_failure' },
  getSourceRows = () => null,
  priorRun = null,
  publicationProof = proof,
  now = () => new Date(time),
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'scrvusd-slot-runner-'))
  const calls = {
    starts: [],
    results: [],
    source: 0,
    confirms: 0,
    sourceStarts: 0,
    witnesses: 0,
    readRuns: 0,
    order: [],
  }
  const attemptStore = {
    async readRun() {
      calls.readRuns++
      calls.order.push('read_run')
      return (
        priorRun ?? {
          manifestSha256: manifest.sha256,
          slotId,
          arms: [3600, 7200, 86400, 604800].map((horizonSeconds) => ({
            horizonSeconds,
            status: 'start_missing',
          })),
          startConfirmedAtUtc: null,
          startConfirmerXid: null,
          sourceCaptureFloorUtc: null,
          captureFloorXid: null,
          runConfirmedAtUtc: null,
          runConfirmerXid: null,
          runCoverageConfirmed: false,
        }
      )
    },
    async startArm(row) {
      if (row.horizonSeconds === failStart) throw new Error('start rejected')
      calls.starts.push(row)
    },
    async confirmStarts() {
      calls.confirms++
      calls.order.push('confirm_starts')
      return {
        sourceCaptureFloorUtc: floor,
        arms: calls.starts.map((row) => ({
          horizonSeconds: row.horizonSeconds,
          status: 'result_missing',
          startLogicalSha256: row.startReceipt.sha256,
          startPhysicalSha256: row.physicalSha256,
        })),
      }
    },
    async resultArm(row) {
      if (row.horizonSeconds === failResult) throw new Error('result rejected')
      calls.results.push(row)
      return row
    },
    async confirmRun() {
      calls.confirms++
      calls.order.push('confirm_run')
      return { runCoverageConfirmed: true }
    },
  }
  let sourceNonce = null
  const asOfStore = {
    async startSource({ manifestSha256, slotId, nonceSha256 }) {
      calls.sourceStarts++
      calls.order.push('source_start')
      if (failSourceStart) throw new Error('source start rejected')
      if (missingSourceStart) return null
      sourceNonce = nonceSha256
      return {
        manifestSha256,
        slotId,
        nonceSha256,
        captureFloorAtUtc: floor,
        captureFloorXid: '100',
        sourceStartAtUtc,
        sourceStartXid: '101',
        sourceCollectionIndependentlyTimed: false,
      }
    },
    async witnessRun({ manifestSha256, slotId }) {
      calls.witnesses++
      calls.order.push('witness_run')
      if (failWitness) throw new Error('run witness rejected')
      if (missingWitness) return null
      return {
        manifestSha256,
        slotId,
        nonceSha256: sourceNonce,
        sourceStartAtUtc,
        sourceStartXid: '101',
        runConfirmerXid: '102',
        witnessXid: '103',
        runVisibleAtUtc: witnessAtUtc,
        historicalAvailabilityCertifiedForRun: true,
      }
    },
  }
  const startOut = join(dir, 'starts')
  const run = () =>
    runNowSlot({
      manifestSha256: manifest.sha256,
      slotId,
      scheduleStore: { readManifestWitness: async () => publicationProof },
      attemptStore,
      asOfStore,
      collectSources: async () => {
        calls.source++
        calls.order.push('collect_sources')
        return source
      },
      getSourceRows,
      now,
      startOut,
      issueOut: join(dir, 'issues'),
      stat,
    })
  return { run, calls, startOut, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('runner rejects absent or malformed manifest witness before slot writes', async () => {
  for (const publicationProof of [
    { ...proof, historicalPublicationAvailabilityCertified: false },
    { ...proof, manifestVisibleAtUtc: '2026-09-29T11:00:00.000Z' },
    { ...proof, witnessXid: proof.confirmerXid },
  ]) {
    const h = harness({ publicationProof })
    try {
      await assert.rejects(h.run(), /Witnessed future manifest required/)
      assert.equal(h.calls.readRuns, 0)
      assert.equal(h.calls.starts.length, 0)
    } finally {
      h.cleanup()
    }
  }
})

test('four committed starts precede source collection; source failure records four failures', async () => {
  const h = harness()
  try {
    const result = await h.run()
    assert.equal(result.status, 'research_only')
    assert.equal(result.calibratedForecastEligible, false)
    assert.equal(h.calls.starts.length, 4)
    assert.equal(h.calls.confirms, 2)
    assert.equal(h.calls.source, 1)
    assert.equal(h.calls.sourceStarts, 1)
    assert.equal(h.calls.witnesses, 1)
    assert.deepEqual(h.calls.order, [
      'read_run',
      'confirm_starts',
      'source_start',
      'collect_sources',
      'confirm_run',
      'witness_run',
    ])
    assert.deepEqual(
      h.calls.results.map((row) => row.status),
      Array(4).fill('failed'),
    )
    assert.deepEqual(
      h.calls.results.map((row) => row.reason),
      Array(4).fill('process_failure'),
    )
  } finally {
    h.cleanup()
  }
})

test('partial start fails before capture and leaves the run unconfirmed', async () => {
  const h = harness({ failStart: 7200 })
  try {
    await assert.rejects(h.run(), /start rejected/)
    assert.equal(h.calls.starts.length, 1)
    assert.equal(h.calls.source, 0)
    assert.equal(h.calls.confirms, 0)
    assert.equal(h.calls.results.length, 0)
  } finally {
    h.cleanup()
  }
})

test('preflight rejects any prior DB stage before writing or collecting', async () => {
  const empty = {
    manifestSha256: manifest.sha256,
    slotId,
    arms: [3600, 7200, 86400, 604800].map((horizonSeconds) => ({
      horizonSeconds,
      status: 'start_missing',
    })),
    runCoverageConfirmed: false,
  }
  for (const priorRun of [
    {
      ...empty,
      arms: [{ horizonSeconds: 3600, status: 'result_missing' }, ...empty.arms.slice(1)],
    },
    { ...empty, startConfirmedAtUtc: time },
    { ...empty, sourceCaptureFloorUtc: time },
    { ...empty, runConfirmedAtUtc: time },
    { ...empty, runCoverageConfirmed: true },
    { ...empty, arms: empty.arms.slice(1) },
  ]) {
    const h = harness({ priorRun })
    try {
      await assert.rejects(h.run(), /Incomplete\/nonresumable slot/)
      assert.equal(h.calls.readRuns, 1)
      assert.equal(h.calls.starts.length, 0)
      assert.equal(h.calls.source, 0)
      assert.equal(h.calls.confirms, 0)
    } finally {
      h.cleanup()
    }
  }
})

test('preflight rejects exact-slot local orphan while leaving other-slot files alone', async () => {
  const h = harness()
  try {
    mkdirSync(h.startOut)
    writeFileSync(join(h.startOut, `${slotId}-3600s-orphan.json`), 'orphan')
    await assert.rejects(h.run(), /Incomplete\/nonresumable slot/)
    assert.equal(h.calls.starts.length, 0)
    assert.equal(h.calls.source, 0)
  } finally {
    h.cleanup()
  }
  const other = harness()
  try {
    mkdirSync(other.startOut)
    writeFileSync(join(other.startOut, `${'f'.repeat(64)}-3600s-other.json`), 'other')
    const result = await other.run()
    assert.equal(result.status, 'research_only')
  } finally {
    other.cleanup()
  }
})

test('partial result write leaves the run unconfirmed', async () => {
  const h = harness({ failResult: 7200 })
  try {
    await assert.rejects(h.run(), /result rejected/)
    assert.equal(h.calls.source, 1)
    assert.equal(h.calls.results.length, 1)
    assert.equal(h.calls.confirms, 1)
  } finally {
    h.cleanup()
  }
})

test('missing committed capture floor fails before source collection', async () => {
  const h = harness({ floor: null })
  try {
    await assert.rejects(h.run(), /capture floor/)
    assert.equal(h.calls.source, 0)
    assert.equal(h.calls.results.length, 0)
  } finally {
    h.cleanup()
  }
})

test('failed or late source-start gate prevents source collection and results', async () => {
  for (const options of [
    { failSourceStart: true },
    { missingSourceStart: true },
    { sourceStartAtUtc: '2026-09-29T12:00:10.000Z' },
    { sourceStartAtUtc: '2026-09-29T12:00:13.000Z' },
  ]) {
    const h = harness(options)
    try {
      await assert.rejects(h.run())
      assert.equal(h.calls.source, 0)
      assert.equal(h.calls.results.length, 0)
      assert.equal(h.calls.witnesses, 0)
    } finally {
      h.cleanup()
    }
  }
})

test('missing or invalid run witness refuses completed run status', async () => {
  for (const options of [
    { failWitness: true },
    { missingWitness: true },
    { witnessAtUtc: '2026-09-29T12:00:11.000Z' },
  ]) {
    const h = harness(options)
    try {
      await assert.rejects(h.run())
      assert.equal(h.calls.source, 1)
      assert.equal(h.calls.results.length, 4)
      assert.equal(h.calls.confirms, 2)
      assert.equal(h.calls.witnesses, 1)
    } finally {
      h.cleanup()
    }
  }
})

test('source captured after floor but before source start becomes failed, never issued', async () => {
  const h = harness({
    source: { status: 'ready' },
    getSourceRows: () => ({
      latestCheckpoint: { checkpoint: { captureStartUtc: '2026-09-29T12:00:11.200Z' } },
      holderRow: { issue: { captureStartUtc: '2026-09-29T12:00:12.000Z' } },
      durationRow: { issue: { issuedAtUtc: '2026-09-29T12:00:13.000Z' } },
    }),
  })
  try {
    await h.run()
    assert.deepEqual(
      h.calls.results.map((row) => row.status),
      Array(4).fill('failed'),
    )
    assert.deepEqual(
      h.calls.results.map((row) => row.reason),
      Array(4).fill('verification_failure'),
    )
  } finally {
    h.cleanup()
  }
})

test('missed slot performs no writes or source capture', async () => {
  const h = harness({ now: () => new Date('2026-09-29T13:00:00.000Z') })
  try {
    await assert.rejects(h.run(), /Missed or future slot/)
    assert.equal(h.calls.starts.length, 0)
    assert.equal(h.calls.source, 0)
  } finally {
    h.cleanup()
  }
})

const hash = (value) => createHash('sha256').update(value).digest('hex')
const xid = (n) => String(n)

function recoveryHarness({ confirmed = false, witnessed = false, issued = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'scrvusd-recover-runner-'))
  const startOut = join(dir, 'starts')
  const issueOut = join(dir, 'issues')
  mkdirSync(startOut)
  mkdirSync(issueOut)
  const arms = [3600, 7200, 86400, 604800].map((horizonSeconds, index) => {
    const start = buildAttemptStartV1({
      manifest,
      slotId,
      horizonSeconds,
      recordedAtUtc: time,
    })
    const startPayload = JSON.stringify(start)
    writeFileSync(join(startOut, attemptStartNameV1(start)), `${startPayload}\n`)
    const arm = {
      horizonSeconds,
      status: 'failed',
      startPayload,
      startLogicalSha256: start.sha256,
      startPhysicalSha256: hash(`${startPayload}\n`),
      startedAtUtc: time,
      startXid: xid(200 + index),
      resultAtUtc: time,
      resultXid: xid(300 + index),
      issuePayload: null,
      issueLogicalSha256: null,
      issuePhysicalSha256: null,
    }
    if (issued && index === 0) {
      const unsigned = {
        anchorBlock: { number: 26000000, hash: `0x${'a'.repeat(64)}` },
        issuedAtUtc: time,
        scheduleBinding: {
          manifestSha256: manifest.sha256,
          slotId,
          horizonSeconds,
          attemptStart: {
            logicalSha256: start.sha256,
            physicalSha256: arm.startPhysicalSha256,
          },
        },
        targetUtc: '2026-09-29T13:00:12.000Z',
      }
      const issue = { ...unsigned, sha256: hash(JSON.stringify(unsigned)) }
      const issuePayload = JSON.stringify(issue)
      writeFileSync(join(issueOut, boundIssueNameV2(issue)), `${issuePayload}\n`)
      Object.assign(arm, {
        status: 'db_reported_issued_unverified',
        issuePayload,
        issueLogicalSha256: issue.sha256,
        issuePhysicalSha256: hash(`${issuePayload}\n`),
      })
    }
    return arm
  })
  const run = {
    manifestSha256: manifest.sha256,
    slotId,
    arms,
    startConfirmedAtUtc: '2026-09-29T12:00:10.000Z',
    startConfirmerXid: '180',
    sourceCaptureFloorUtc: '2026-09-29T12:00:11.000Z',
    captureFloorXid: '181',
    runConfirmedAtUtc: confirmed ? '2026-09-29T12:00:13.000Z' : null,
    runConfirmerXid: confirmed ? '400' : null,
    runCoverageConfirmed: confirmed,
  }
  const sourceStart = {
    manifestSha256: manifest.sha256,
    slotId,
    nonceSha256: 'b'.repeat(64),
    captureFloorAtUtc: run.sourceCaptureFloorUtc,
    captureFloorXid: run.captureFloorXid,
    sourceStartAtUtc: '2026-09-29T12:00:11.500Z',
    sourceStartXid: '190',
    sourceCollectionIndependentlyTimed: false,
  }
  const visibility = {
    manifestSha256: manifest.sha256,
    slotId,
    nonceSha256: sourceStart.nonceSha256,
    sourceStartAtUtc: sourceStart.sourceStartAtUtc,
    sourceStartXid: sourceStart.sourceStartXid,
    runConfirmerXid: '400',
    witnessXid: '401',
    runVisibleAtUtc: '2026-09-29T12:00:14.000Z',
    historicalAvailabilityCertifiedForRun: true,
  }
  const calls = { confirm: 0, witness: 0, source: 0, starts: 0, results: 0 }
  const attemptStore = {
    readRun: async () => run,
    confirmRun: async () => {
      calls.confirm++
      Object.assign(run, {
        runConfirmedAtUtc: '2026-09-29T12:00:13.000Z',
        runConfirmerXid: '400',
        runCoverageConfirmed: true,
      })
      return run
    },
    startArm: async () => calls.starts++,
    resultArm: async () => calls.results++,
  }
  const asOfStore = {
    readSourceStart: async () => sourceStart,
    readRunWitness: async () => (witnessed ? visibility : null),
    witnessRun: async () => {
      calls.witness++
      return visibility
    },
    startSource: async () => calls.source++,
  }
  const recover = (options = {}) =>
    recoverNowSlotFinalization({
      manifestSha256: manifest.sha256,
      slotId,
      scheduleStore: {
        readManifestWitness: async () => ({ ...proof, manifestSha256: manifest.sha256 }),
      },
      attemptStore,
      asOfStore,
      startOut,
      issueOut,
      now: () => new Date(time),
      ...options,
    })
  return {
    recover,
    run,
    sourceStart,
    calls,
    startOut,
    issueOut,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('exact recovery confirms four committed results and witnesses without repeating capture', async () => {
  const h = recoveryHarness({ issued: true })
  try {
    const result = await h.recover()
    assert.equal(result.historicalAvailabilityCertifiedForRun, true)
    assert.equal(result.runVisibleAtUtc, '2026-09-29T12:00:14.000Z')
    assert.deepEqual(h.calls, { confirm: 1, witness: 1, source: 0, starts: 0, results: 0 })
  } finally {
    h.cleanup()
  }
})

test('exact recovery witnesses an already confirmed run once', async () => {
  const h = recoveryHarness({ confirmed: true })
  try {
    await h.recover()
    assert.deepEqual(h.calls, { confirm: 0, witness: 1, source: 0, starts: 0, results: 0 })
  } finally {
    h.cleanup()
  }
})

test('exact recovery returns an existing witness without mutation, including after slot', async () => {
  const h = recoveryHarness({ confirmed: true, witnessed: true })
  try {
    const result = await h.recover({ now: () => new Date('2026-09-30T12:00:00.000Z') })
    assert.equal(result.runVisibleAtUtc, '2026-09-29T12:00:14.000Z')
    assert.deepEqual(h.calls, { confirm: 0, witness: 0, source: 0, starts: 0, results: 0 })
  } finally {
    h.cleanup()
  }
})

test('recovery refuses partial results, absent source start, and missing local start before mutation', async () => {
  for (const damage of [
    (h) => {
      h.run.arms[0].status = 'result_missing'
    },
    (h) => {
      h.sourceStart.sourceStartAtUtc = null
    },
    (h) => {
      rmSync(join(h.startOut, attemptStartNameV1(JSON.parse(h.run.arms[0].startPayload))))
    },
  ]) {
    const h = recoveryHarness()
    try {
      damage(h)
      await assert.rejects(h.recover())
      assert.deepEqual(h.calls, { confirm: 0, witness: 0, source: 0, starts: 0, results: 0 })
    } finally {
      h.cleanup()
    }
  }
})

test('recovery refuses an issued run after the first target before confirmation', async () => {
  const h = recoveryHarness({ issued: true })
  try {
    await assert.rejects(
      h.recover({ now: () => new Date('2026-09-29T13:00:12.000Z') }),
      /Recovery missed earliest issued target/,
    )
    assert.equal(h.calls.confirm, 0)
  } finally {
    h.cleanup()
  }
})

test('recovery refuses missing issued bytes and does not witness a confirmed run after target', async () => {
  const missing = recoveryHarness({ issued: true })
  try {
    const issue = JSON.parse(missing.run.arms[0].issuePayload)
    rmSync(join(missing.issueOut, boundIssueNameV2(issue)))
    await assert.rejects(missing.recover())
    assert.equal(missing.calls.confirm, 0)
    assert.equal(missing.calls.witness, 0)
  } finally {
    missing.cleanup()
  }
  const late = recoveryHarness({ confirmed: true, issued: true })
  try {
    await assert.rejects(
      late.recover({ now: () => new Date('2026-09-29T13:00:12.000Z') }),
      /Recovery missed earliest issued target/,
    )
    assert.equal(late.calls.witness, 0)
  } finally {
    late.cleanup()
  }
})

test('recovery refuses an issued target that differs from issue time plus horizon', async () => {
  const h = recoveryHarness({ issued: true })
  try {
    const old = JSON.parse(h.run.arms[0].issuePayload)
    const { sha256: _seal, ...unsigned } = old
    unsigned.targetUtc = '2026-09-29T14:00:12.000Z'
    const changed = { ...unsigned, sha256: hash(JSON.stringify(unsigned)) }
    const payload = JSON.stringify(changed)
    writeFileSync(join(h.issueOut, boundIssueNameV2(changed)), `${payload}\n`)
    Object.assign(h.run.arms[0], {
      issuePayload: payload,
      issueLogicalSha256: changed.sha256,
      issuePhysicalSha256: hash(`${payload}\n`),
    })
    await assert.rejects(h.recover(), /Exact retained issue receipt differs/)
    assert.equal(h.calls.confirm, 0)
    assert.equal(h.calls.witness, 0)
  } finally {
    h.cleanup()
  }
})

test('recovery refuses exact DB/local issued bytes whose issue time predates committed source start', async () => {
  const h = recoveryHarness({ issued: true })
  try {
    const original = JSON.parse(h.run.arms[0].issuePayload)
    const { sha256: _seal, ...unsigned } = original
    unsigned.issuedAtUtc = '2026-09-29T12:00:11.250Z'
    unsigned.targetUtc = '2026-09-29T13:00:11.250Z'
    const changed = { ...unsigned, sha256: hash(JSON.stringify(unsigned)) }
    const payload = JSON.stringify(changed)
    writeFileSync(join(h.issueOut, boundIssueNameV2(changed)), `${payload}\n`)
    Object.assign(h.run.arms[0], {
      issuePayload: payload,
      issueLogicalSha256: changed.sha256,
      issuePhysicalSha256: hash(`${payload}\n`),
    })
    await assert.rejects(h.recover(), /Exact retained issue receipt differs/)
    assert.equal(h.calls.confirm, 0)
    assert.equal(h.calls.witness, 0)
  } finally {
    h.cleanup()
  }
})
