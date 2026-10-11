import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildSubjectManifest } from '../../../../scripts/record-carry-cash-issues.mjs'
import {
  registerCashProspectiveV2,
  tickCashProspectiveV2,
} from '../../../../scripts/lib/localCarryCashProspectiveV2Store.mjs'
import { registerVault5V2 } from '../../../../scripts/lib/localCarryCashVault5V2Store.mjs'
import { CASH_V2_POLICY } from '../../../../scripts/research/carry-cash-prospective-v2-policy.mjs'
import {
  VAULT5_SUBJECTS,
  VAULT5_V2_POLICY,
} from '../../../../scripts/research/carry-cash-vault5-v2-policy.mjs'
import {
  PROSPECTIVE_CASH_MODEL_IDENTITIES,
  prospectiveCashModelFromVault5State,
  readProspectiveCashModel,
} from './prospectiveCashModelRead.mjs'

const hex = (character) => character.repeat(64)
const at = (value) => Date.parse(value)

function receipt(subject, manifestSha256, sequence, blockAt, firstLocalReceiptAt, cashRaw) {
  return {
    sequence,
    sha256: hex(String((sequence + (subject.id === 'sgho' ? 4 : 0)) % 10)),
    manifestSha256,
    collectionMode: 'current',
    block: String(1000 + sequence),
    blockHash: `0x${hex('a')}`,
    blockAt,
    firstLocalReceiptAt,
    rows: [
      {
        routeKey: subject.routeKey,
        destination: subject.destination,
        asset: subject.asset,
        shareDecimals: subject.decimals,
        assetDecimals: subject.decimals,
        cashRaw,
        state: 'observed',
        reason: null,
      },
    ],
  }
}

function twoSubjectFixture() {
  const parent = mkdtempSync(join(tmpdir(), 'prospective-cash-read-two-'))
  const root = join(parent, 'ledger')
  const inputs = {}
  for (const subject of CASH_V2_POLICY.subjects) {
    const manifest = { sha256: hex(subject.id === 'sgho' ? 'b' : 'c') }
    const first = receipt(
      subject,
      manifest.sha256,
      1,
      '2026-10-05T12:00:00.000Z',
      '2026-10-05T12:04:00.000Z',
      '1000',
    )
    inputs[subject.cohort] = {
      manifest,
      verified: {
        count: 1,
        last: first,
        records: [first],
        manifestSha256: manifest.sha256,
      },
    }
  }
  const development = CASH_V2_POLICY.subjects.map((subject) => ({
    subjectId: subject.id,
    kind: 'pinned_test_source',
    physicalSha256: hex('d'),
    contentSha256: hex('e'),
    count: 120,
    throughUtc: '2026-09-30T00:00:00.000Z',
    parameters: {
      pairCount: 60,
      firstPairSourceAtUtc: '2026-01-01T00:00:00.000Z',
      lastPairTargetAtUtc: '2026-09-30T00:00:00.000Z',
      medianDeltaRaw: '10',
      p10DeltaRaw: '-100',
      p90DeltaRaw: '100',
    },
  }))
  const push = (subjectId, sequence, blockAt, firstLocalReceiptAt, cashRaw) => {
    const subject = CASH_V2_POLICY.subjects.find((row) => row.id === subjectId)
    const source = inputs[subject.cohort]
    const row = receipt(
      subject,
      source.manifest.sha256,
      sequence,
      blockAt,
      firstLocalReceiptAt,
      cashRaw,
    )
    source.verified.records.push(row)
    source.verified.count++
    source.verified.last = row
  }
  return { parent, root, inputs, development, push }
}

const exactIdentity = (subject) => ({
  routeKey: subject.routeKey,
  destination: subject.destination,
  asset: subject.asset,
  horizonHours: 24,
})

test('dispatches every exact two-subject and Vault5 identity to a zero-issue collecting model', async () => {
  const two = twoSubjectFixture()
  const vaultParent = mkdtempSync(join(tmpdir(), 'prospective-cash-read-vault5-'))
  const vaultRoot = join(vaultParent, 'ledger')
  try {
    registerCashProspectiveV2(two.inputs, two.development, {
      root: two.root,
      minFreeBytes: 0,
      now: at('2026-10-05T12:07:00.000Z'),
    })
    const manifest = await buildSubjectManifest()
    registerVault5V2(manifest, { root: vaultRoot }, '2026-10-05T12:07:00.000Z')
    assert.equal(PROSPECTIVE_CASH_MODEL_IDENTITIES.length, 7)
    for (const identity of PROSPECTIVE_CASH_MODEL_IDENTITIES) {
      const result = await readProspectiveCashModel(identity, {
        now: '2026-10-05T12:08:00.000Z',
        twoSubject: { inputs: two.inputs, root: two.root },
        vault5: { manifest, root: vaultRoot },
      })
      assert.equal(result.status, 'collecting')
      assert.deepEqual(
        {
          routeKey: result.routeKey,
          destination: result.destination,
          asset: result.asset,
          horizonHours: result.horizonHours,
        },
        identity,
      )
      assert.equal(result.claim, 'aggregate_cash_proxy_only')
      assert.equal(result.holderExecutableExit, false)
      assert.equal(result.prospectiveValidated, false)
      assert.equal(result.outcome.issued, 0)
      assert.equal(result.latestActiveIssue, null)
    }
  } finally {
    rmSync(two.parent, { recursive: true, force: true })
    rmSync(vaultParent, { recursive: true, force: true })
  }
})

test('wrong identity returns no match without loading or revealing another subject', async () => {
  const known = CASH_V2_POLICY.subjects[0]
  const requested = { ...exactIdentity(known), asset: VAULT5_SUBJECTS[0].asset }
  const result = await readProspectiveCashModel(requested, {
    twoSubject: {
      get inputs() {
        throw new Error('must_not_load')
      },
    },
  })
  assert.deepEqual(result, {
    status: 'unavailable',
    ...requested,
    claim: 'aggregate_cash_proxy_only',
    holderExecutableExit: false,
    prospectiveValidated: false,
    schedule: null,
    outcome: null,
    interval: null,
    source: null,
    latestActiveIssue: null,
    reason: 'no_exact_model_match',
  })
})

test('returns the latest still-active two-subject projection and its issue/target clocks', async () => {
  const fixture = twoSubjectFixture()
  try {
    registerCashProspectiveV2(fixture.inputs, fixture.development, {
      root: fixture.root,
      minFreeBytes: 0,
      now: at('2026-10-05T12:07:00.000Z'),
    })
    for (const subject of CASH_V2_POLICY.subjects)
      fixture.push(subject.id, 2, '2026-10-05T13:03:00.000Z', '2026-10-05T13:08:00.000Z', '1000')
    tickCashProspectiveV2(fixture.inputs, {
      root: fixture.root,
      minFreeBytes: 0,
      now: at('2026-10-05T13:15:00.000Z'),
    })
    const result = await readProspectiveCashModel(exactIdentity(CASH_V2_POLICY.subjects[0]), {
      now: '2026-10-05T13:15:00.000Z',
      twoSubject: { inputs: fixture.inputs, root: fixture.root },
    })
    assert.equal(result.status, 'collecting')
    assert.equal(result.outcome.issued, 1)
    assert.deepEqual(result.latestActiveIssue, {
      issuedAtUtc: '2026-10-05T13:15:00.000Z',
      sourceAtUtc: '2026-10-05T13:03:00.000Z',
      targetAtUtc: '2026-10-06T13:03:00.000Z',
      targetLowUtc: '2026-10-06T12:03:00.000Z',
      targetHighUtc: '2026-10-06T14:03:00.000Z',
      outcomeDueByUtc: '2026-10-06T16:03:00.000Z',
      projection: {
        sourceCashRaw: '1000',
        pointRaw: '1010',
        lowRaw: '900',
        highRaw: '1100',
        persistenceRaw: '1000',
      },
    })
    const beforeIssue = await readProspectiveCashModel(exactIdentity(CASH_V2_POLICY.subjects[0]), {
      now: '2026-10-05T13:14:59.999Z',
      twoSubject: { inputs: fixture.inputs, root: fixture.root },
    })
    assert.equal(beforeIssue.latestActiveIssue, null)
    const atDeadline = await readProspectiveCashModel(exactIdentity(CASH_V2_POLICY.subjects[0]), {
      now: '2026-10-06T16:03:00.000Z',
      twoSubject: { inputs: fixture.inputs, root: fixture.root },
    })
    assert.equal(atDeadline.latestActiveIssue?.issuedAtUtc, '2026-10-05T13:15:00.000Z')
    const afterDeadline = await readProspectiveCashModel(
      exactIdentity(CASH_V2_POLICY.subjects[0]),
      {
        now: '2026-10-06T16:03:00.001Z',
        twoSubject: { inputs: fixture.inputs, root: fixture.root },
      },
    )
    assert.equal(afterDeadline.latestActiveIssue, null)
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true })
  }
})

test('Vault5 validation requires both the exact subject and the cohort to pass', () => {
  const identity = exactIdentity(VAULT5_SUBJECTS[0])
  const observedScores = Array.from({ length: 20 }, () => ({
    content: { status: 'observed', issueSha256: hex('a') },
  }))
  const state = { issues: [], scores: observedScores, ticks: [] }
  const exact = {
    ...VAULT5_SUBJECTS[0],
    completeClusters: 20,
    issuedAttempts: 20,
    covered: 18,
    passed: true,
  }
  const base = {
    scheduledClusters: 20,
    issuedClusters: 20,
    missedClusters: 0,
    scoredClusters: 20,
    bySubject: [exact],
  }
  const collecting = prospectiveCashModelFromVault5State(
    identity,
    state,
    { ...base, cohortPassed: false },
    at('2026-10-05T12:00:00.000Z'),
  )
  assert.equal(collecting.status, 'collecting')
  assert.equal(collecting.prospectiveValidated, false)
  const validated = prospectiveCashModelFromVault5State(
    identity,
    state,
    { ...base, cohortPassed: true },
    at('2026-10-05T12:00:00.000Z'),
  )
  assert.equal(validated.status, 'validated')
  assert.equal(validated.prospectiveValidated, true)
})

test('Vault5 slot expiry remains unassessed source evidence rather than a source outage', () => {
  const subject = VAULT5_SUBJECTS[0]
  const identity = exactIdentity(subject)
  const state = {
    issues: [],
    scores: [],
    ticks: [{ content: { status: 'missed', reason: 'slot_expired' } }],
  }
  const evaluation = {
    scheduledClusters: 1,
    issuedClusters: 0,
    missedClusters: 1,
    scoredClusters: 0,
    cohortPassed: false,
    bySubject: [
      {
        ...subject,
        completeClusters: 0,
        issuedAttempts: 0,
        covered: 0,
        passed: false,
      },
    ],
  }
  const model = prospectiveCashModelFromVault5State(
    identity,
    state,
    evaluation,
    at('2026-10-05T12:00:00.000Z'),
  )
  assert.deepEqual(model.source, {
    opportunities: 1,
    available: 0,
    unavailable: 0,
    ineligible: 0,
    unassessed: 1,
    availabilityPercent: null,
  })
})

test('Vault5 active projection is bounded by issuance, deadline, and score state', () => {
  const subject = VAULT5_SUBJECTS[0]
  const identity = exactIdentity(subject)
  const issue = {
    sha256: hex('b'),
    recordedAt: '2026-10-05T13:00:00.000Z',
    content: {
      sourceAt: '2026-10-05T12:55:00.000Z',
      targetLow: '2026-10-06T11:55:00.000Z',
      targetHigh: '2026-10-06T13:55:00.000Z',
      targetReceiptDeadline: '2026-10-06T14:55:00.000Z',
      attempts: [
        {
          ...subject,
          sourceCashRaw: '1000',
          pointRaw: '1010',
          lowRaw: '900',
          highRaw: '1100',
          baselinePointRaw: '1000',
          baselineLowRaw: '850',
          baselineHighRaw: '1150',
        },
      ],
    },
  }
  const evaluation = {
    scheduledClusters: 1,
    issuedClusters: 1,
    missedClusters: 0,
    scoredClusters: 0,
    cohortPassed: false,
    bySubject: [
      {
        ...subject,
        completeClusters: 0,
        issuedAttempts: 1,
        covered: 0,
        passed: false,
      },
    ],
  }
  const modelAt = (when, scores = []) =>
    prospectiveCashModelFromVault5State(
      identity,
      { issues: [issue], scores, ticks: [] },
      evaluation,
      at(when),
    )
  assert.equal(modelAt('2026-10-05T12:59:59.999Z').latestActiveIssue, null)
  assert.equal(
    modelAt('2026-10-05T13:00:00.000Z').latestActiveIssue?.targetAtUtc,
    '2026-10-06T12:55:00.000Z',
  )
  assert.ok(modelAt('2026-10-06T14:55:00.000Z').latestActiveIssue)
  assert.equal(modelAt('2026-10-06T14:55:00.001Z').latestActiveIssue, null)
  assert.equal(
    modelAt('2026-10-05T13:00:00.000Z', [
      { content: { issueSha256: issue.sha256, status: 'observed' } },
    ]).latestActiveIssue,
    null,
  )
})

test('adapter turns read-only lagging-head verification into unavailable without mutating head', async () => {
  const fixture = twoSubjectFixture()
  try {
    registerCashProspectiveV2(fixture.inputs, fixture.development, {
      root: fixture.root,
      minFreeBytes: 0,
      now: at('2026-10-05T12:07:00.000Z'),
    })
    const second = JSON.parse(readFileSync(join(fixture.root, '000000000002.json'), 'utf8'))
    const headPath = `${fixture.root}.head.json`
    writeFileSync(
      headPath,
      `${JSON.stringify({
        study: CASH_V2_POLICY.study,
        sequence: 2,
        sha256: second.sha256,
      })}\n`,
    )
    const beforeBytes = readFileSync(headPath)
    const beforeMtimeNs = statSync(headPath, { bigint: true }).mtimeNs
    const result = await readProspectiveCashModel(exactIdentity(CASH_V2_POLICY.subjects[0]), {
      now: '2026-10-05T12:08:00.000Z',
      twoSubject: { inputs: fixture.inputs, root: fixture.root },
    })
    assert.equal(result.status, 'unavailable')
    assert.equal(result.reason, 'local_evidence_unavailable')
    assert.deepEqual(readFileSync(headPath), beforeBytes)
    assert.equal(statSync(headPath, { bigint: true }).mtimeNs, beforeMtimeNs)
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true })
  }
})

test('absent two-subject and Vault5 ledgers are unavailable rather than zero-history models', async () => {
  const fixture = twoSubjectFixture()
  const vaultParent = mkdtempSync(join(tmpdir(), 'prospective-cash-read-absent-vault-'))
  try {
    const two = await readProspectiveCashModel(exactIdentity(CASH_V2_POLICY.subjects[0]), {
      twoSubject: { inputs: fixture.inputs, root: fixture.root },
    })
    assert.equal(two.status, 'unavailable')
    assert.equal(two.reason, 'prospective_ledger_unavailable')
    const manifest = await buildSubjectManifest()
    const vault = await readProspectiveCashModel(exactIdentity(VAULT5_SUBJECTS[0]), {
      vault5: { manifest, root: join(vaultParent, 'missing-ledger') },
    })
    assert.equal(vault.status, 'unavailable')
    assert.equal(vault.reason, 'prospective_ledger_unavailable')
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true })
    rmSync(vaultParent, { recursive: true, force: true })
  }
})

test('dispatch requires the numeric 24-hour horizon exactly', async () => {
  const requested = { ...exactIdentity(CASH_V2_POLICY.subjects[0]), horizonHours: '24' }
  const result = await readProspectiveCashModel(requested)
  assert.equal(result.status, 'unavailable')
  assert.equal(result.reason, 'no_exact_model_match')
  assert.equal(result.horizonHours, null)
  assert.equal(VAULT5_V2_POLICY.horizonHours, 24)
})

test('null and property-throwing identities return typed no-match objects', async () => {
  const throwing = Object.defineProperty({}, 'routeKey', {
    get() {
      throw new Error('untrusted getter')
    },
  })
  for (const requested of [null, throwing]) {
    const result = await readProspectiveCashModel(requested)
    assert.equal(result.status, 'unavailable')
    assert.equal(result.reason, 'no_exact_model_match')
    assert.equal(result.routeKey, null)
    assert.equal(result.destination, null)
    assert.equal(result.asset, null)
    assert.equal(result.horizonHours, null)
  }
})
