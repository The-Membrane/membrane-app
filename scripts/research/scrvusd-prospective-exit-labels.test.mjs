import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  labelsFromVerifiedRows,
  readLabels,
  verifiedStableRows,
} from './scrvusd-prospective-exit-labels.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const at = (second) =>
  new Date(Date.parse('2026-09-28T00:00:00.000Z') + second * 1000).toISOString()
const block = (number) => ({
  number,
  hash: `0x${number.toString(16).padStart(64, '0')}`,
  timestamp: Date.parse(at(0)) / 1000 + number,
})
const seal = (payload) => ({ ...payload, sha256: sha(JSON.stringify(payload)) })
const makeRow = (filename, issue) => ({
  filename,
  issue,
  physicalSha256: sha(`${JSON.stringify(issue)}\n`),
})
const ref = (row) => ({
  filename: row.filename,
  logicalSha256: row.issue.sha256,
  physicalSha256: row.physicalSha256,
})

function fixture(number = 100, horizonSeconds = 7200) {
  const anchorBlock = block(number)
  const issue = seal({
    study: 'scrvusd-now-origin-exit-forecast-issue-v1',
    issuedAtUtc: at(200),
    anchorBlock,
    holder: `0x${'1'.repeat(40)}`,
    qAssetsRaw: '1000000000000000000000',
    route: 'direct_erc4626_withdraw_crvusd_from_scrvusd',
    horizonOrigin: 'issue_time',
    horizonSeconds,
    targetUtc: at(200 + horizonSeconds),
    currentExecutableAbility: { status: 'sampled_success', capturedAtUtc: at(150) },
    currentMechanismContext: { status: 'unverified' },
    historicalContext: {
      flowStatus: 'as_of_context',
      flow: {
        maximumObservedCompleteWindow: { '24h': { withdrawnRaw: '900' } },
        maximumObservedCompleteWindowNetDepletion: { '24h': { netDepletionRaw: '400' } },
        completeToFirstLive: false,
      },
    },
  })
  const filename = `${String(number).padStart(12, '0')}-${anchorBlock.hash.slice(2)}-${horizonSeconds}s.json`
  const issueRow = makeRow(filename, issue)
  const score = seal({
    study: 'scrvusd-now-origin-exit-forecast-score-v1',
    issue: ref(issueRow),
    scoredAtUtc: at(10000),
    evidenceCutoffUtc: at(9200),
    targetUtc: issue.targetUtc,
    horizonSeconds,
    sourceFrontier: { status: 'verified_through_checkpoint' },
    selectedQuote: { filename: 'selected.json' },
    pointOutcome: {
      status: 'revert',
      holder: issue.holder,
      qAssetsRaw: issue.qAssetsRaw,
      route: issue.route,
    },
    trajectory: { status: 'first_loss_interval' },
    sampledCodeIdentity: { status: 'unknown' },
  })
  return { issueRow, scoreRow: makeRow(filename, score) }
}

test('score is absent before its local clock; pending issue remains in denominator', () => {
  const { issueRow, scoreRow } = fixture()
  const before = labelsFromVerifiedRows({
    issues: [issueRow],
    scores: [scoreRow],
    asOfUtc: at(9999),
  })
  assert.deepEqual(before.denominators, { issues: 1, scored: 0, pending: 1 })
  assert.equal(before.rows[0].score.status, 'pending')
  assert.equal(before.rows[0].score.pointOutcome, null)
  assert.equal(before.rows[0].qAssetsRaw, issueRow.issue.qAssetsRaw)
  assert.equal(before.rows[0].horizonSeconds, 7200)
  assert.equal(before.rows[0].historicalFlowStatus, 'as_of_context')
  assert.equal(
    before.rows[0].historicalFlowContext.maximumObservedCompleteWindow['24h'].withdrawnRaw,
    '900',
  )
  assert.equal(
    before.rows[0].historicalFlowContext.maximumObservedCompleteWindowNetDepletion['24h']
      .netDepletionRaw,
    '400',
  )
  const atScore = labelsFromVerifiedRows({
    issues: [issueRow],
    scores: [scoreRow],
    asOfUtc: at(10000),
  })
  assert.deepEqual(atScore.denominators, { issues: 1, scored: 1, pending: 0 })
  assert.equal(atScore.rows[0].score.pointOutcome.status, 'revert')
  assert.equal(atScore.rows[0].score.sampledCodeIdentity.status, 'unknown')
})

test('issue after cutoff is absent and an issue without a score stays pending', () => {
  const { issueRow } = fixture()
  assert.equal(
    labelsFromVerifiedRows({ issues: [issueRow], scores: [], asOfUtc: at(199) }).denominators
      .issues,
    0,
  )
  const current = labelsFromVerifiedRows({ issues: [issueRow], scores: [], asOfUtc: at(200) })
  assert.deepEqual(current.denominators, { issues: 1, scored: 0, pending: 1 })
})

test('score identity mismatch, stale physical reference, and replay onto another issue fail', () => {
  const { issueRow, scoreRow } = fixture()
  const changedQ = makeRow(scoreRow.filename, {
    ...scoreRow.issue,
    pointOutcome: { ...scoreRow.issue.pointOutcome, qAssetsRaw: '1' },
  })
  assert.throws(
    () => labelsFromVerifiedRows({ issues: [issueRow], scores: [changedQ], asOfUtc: at(10000) }),
    /does not match/,
  )
  const changedPhysicalRef = makeRow(scoreRow.filename, {
    ...scoreRow.issue,
    issue: { ...scoreRow.issue.issue, physicalSha256: 'a'.repeat(64) },
  })
  assert.throws(
    () =>
      labelsFromVerifiedRows({
        issues: [issueRow],
        scores: [changedPhysicalRef],
        asOfUtc: at(10000),
      }),
    /does not match/,
  )
  const other = fixture(101)
  assert.throws(
    () =>
      labelsFromVerifiedRows({
        issues: [other.issueRow],
        scores: [{ ...scoreRow, filename: other.issueRow.filename }],
        asOfUtc: at(10000),
      }),
    /does not match/,
  )
})

test('duplicate issue and duplicate score fail', () => {
  const { issueRow, scoreRow } = fixture()
  assert.throws(
    () => labelsFromVerifiedRows({ issues: [issueRow, issueRow], scores: [], asOfUtc: at(10000) }),
    /Duplicate exit issue/,
  )
  assert.throws(
    () =>
      labelsFromVerifiedRows({
        issues: [issueRow],
        scores: [scoreRow, scoreRow],
        asOfUtc: at(10000),
      }),
    /Duplicate exit score/,
  )
})

test('real empty folder replay goes through existing ledger verifiers', () => {
  const root = mkdtempSync(join(tmpdir(), 'scrvusd-exit-labels-'))
  try {
    const result = readLabels({
      asOfUtc: at(10000),
      issueOut: join(root, 'issues'),
      scoreOut: join(root, 'scores'),
      now: () => new Date(),
    })
    assert.deepEqual(result.denominators, { issues: 0, scored: 0, pending: 0 })
    assert.equal(result.forecast.status, 'unavailable')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('stable snapshot rejects addition, deletion, and canonical byte change during verifier', () => {
  const { issueRow, scoreRow } = fixture()
  const root = mkdtempSync(join(tmpdir(), 'scrvusd-exit-label-race-'))
  const issueOut = join(root, 'issues')
  const scoreOut = join(root, 'scores')
  mkdirSync(issueOut)
  mkdirSync(scoreOut)
  const write = (dir, row) =>
    writeFileSync(join(dir, row.filename), `${JSON.stringify(row.issue)}\n`)
  try {
    const blank = verifiedStableRows({ issueOut, scoreOut, verifyLedger: () => {} })
    assert.deepEqual(blank, { issues: [], scores: [] })
    assert.throws(
      () =>
        verifiedStableRows({ issueOut, scoreOut, verifyLedger: () => write(issueOut, issueRow) }),
      /changed during verification/,
    )
    assert.throws(
      () =>
        verifiedStableRows({
          issueOut,
          scoreOut,
          verifyLedger: () => unlinkSync(join(issueOut, issueRow.filename)),
        }),
      /changed during verification/,
    )
    write(issueOut, issueRow)
    const { sha256: _oldSeal, ...issuePayload } = issueRow.issue
    const changed = seal({ ...issuePayload, qAssetsRaw: '999' })
    assert.throws(
      () =>
        verifiedStableRows({
          issueOut,
          scoreOut,
          verifyLedger: () =>
            writeFileSync(join(issueOut, issueRow.filename), `${JSON.stringify(changed)}\n`),
        }),
      /changed during verification/,
    )
    write(issueOut, issueRow)
    assert.throws(
      () =>
        verifiedStableRows({ issueOut, scoreOut, verifyLedger: () => write(scoreOut, scoreRow) }),
      /changed during verification/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
