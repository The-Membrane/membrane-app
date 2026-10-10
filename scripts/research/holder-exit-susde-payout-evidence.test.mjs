import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  buildSusdePayoutEvidence,
  readVerifiedSusdePayoutEvidence,
} from './holder-exit-susde-payout-evidence.mjs'

const ROUTE = 'USDe → Staked USDe [USDe]'
const VAULT = '0x9d39a5de30e57443bff2a8307a4256c8797a3497'
const USDE = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3'
const HOLDER = `0x${'1'.repeat(40)}`
const OTHER_HOLDER = `0x${'2'.repeat(40)}`
const Q_RAW = '10000000000000000000'
const sha = (value) => createHash('sha256').update(value).digest('hex')
const hash = (digit) => `0x${digit.repeat(64)}`
const requestAtUtc = '2026-10-01T10:00:00.000Z'
const anchorAtUtc = '2026-10-01T11:59:00.000Z'
const issuedAtUtc = '2026-10-01T12:00:00.000Z'
const cooldownEndUtc = '2026-10-02T11:00:00.000Z'
const payoutAtUtc = '2026-10-02T12:05:00.000Z'
const localEvidenceAvailableAtUtc = '2026-10-02T14:05:00.000Z'
const duration = (from, to) => Math.floor((Date.parse(to) - Date.parse(from)) / 1_000)

const issue = (sequence = 1) => ({
  study: 'susde_public_pending_exit_issue_v1',
  sequence,
  sha256: sequence === 1 ? 'a'.repeat(64) : 'b'.repeat(64),
  chainId: 1,
  routeKey: ROUTE,
  vault: VAULT,
  originalAsset: USDE,
  holder: sequence === 1 ? HOLDER : OTHER_HOLDER,
  pendingAssetsRaw: Q_RAW,
  cooldownEndUtc,
  anchor: { blockAtUtc: anchorAtUtc },
  issuedAtUtc,
  estimand: 'existing_pending_whole_queue_unstake_simulation',
  minedDeliveryProven: false,
})
const record = (forIssue = issue()) => ({
  study: 'susde_public_request_to_payout_episode_v1',
  status: 'linked_observed_episode',
  issueSequence: forIssue.sequence,
  issueSha256: forIssue.sha256,
  requestProofSha256: '1'.repeat(64),
  sidecarSha256: '2'.repeat(64),
  deliverySha256: '3'.repeat(64),
  archiveFinalSha256: '4'.repeat(64),
  holder: forIssue.holder,
  rawAssets: forIssue.pendingAssetsRaw,
  requestSharesRaw: '12000000000000000000',
  requestTransactionHash: hash('5'),
  requestLogIndex: '7',
  payoutTransactionHash: hash('6'),
  requestAtUtc,
  cooldownEndUtc: forIssue.cooldownEndUtc,
  payoutAtUtc,
  localEvidenceAvailableAtUtc,
  localEvidenceAvailabilityClock: 'unwitnessed_local_wall_clock',
  observedRequestToPayoutSeconds: duration(requestAtUtc, payoutAtUtc),
  observedPendingToPayoutSeconds: duration(anchorAtUtc, payoutAtUtc),
  cryptographicAbsenceProven: false,
  headerChainContinuityProven: false,
  implementationIdentityVerified: false,
  forecastValidated: false,
  futureDurationClaim: false,
})

test('loader reads exactly five local sidecars sequentially in fixed issue order', async () => {
  const calls = []
  let active = 0
  const records = await readVerifiedSusdePayoutEvidence({
    loadOne: async ({ issueSequence }) => {
      active++
      assert.equal(active, 1)
      calls.push(issueSequence)
      await Promise.resolve()
      active--
      return { issueSequence }
    },
  })
  assert.deepEqual(calls, [1, 3, 6, 8, 10])
  assert.deepEqual(
    records,
    calls.map((issueSequence) => ({ issueSequence })),
  )
})

test('projector emits JSON-safe issue-level mined payout facts without duration forecast', () => {
  const sourceIssue = issue()
  const sourceRecord = record(sourceIssue)
  const { facts, diagnostics } = buildSusdePayoutEvidence({
    issues: [sourceIssue],
    records: [sourceRecord],
  })
  assert.equal(facts.length, 1)
  assert.deepEqual(
    {
      issueSequence: facts[0].issueSequence,
      issueSha256: facts[0].issueSha256,
      holderCommitment: facts[0].holderCommitment,
      qRaw: facts[0].qRaw,
      requestAtUtc: facts[0].requestAtUtc,
      payoutAtUtc: facts[0].payoutAtUtc,
      localEvidenceAvailableAtUtc: facts[0].localEvidenceAvailableAtUtc,
      localEvidenceAvailabilityClock: facts[0].localEvidenceAvailabilityClock,
      observedRequestToPayoutSeconds: facts[0].observedRequestToPayoutSeconds,
      observedPendingToPayoutSeconds: facts[0].observedPendingToPayoutSeconds,
      requestProofSha256: facts[0].requestProofSha256,
      sidecarSha256: facts[0].sidecarSha256,
      deliverySha256: facts[0].deliverySha256,
    },
    {
      issueSequence: 1,
      issueSha256: sourceIssue.sha256,
      holderCommitment: sha(`${VAULT}:${HOLDER}`),
      qRaw: Q_RAW,
      requestAtUtc,
      payoutAtUtc,
      localEvidenceAvailableAtUtc,
      localEvidenceAvailabilityClock: 'unwitnessed_local_wall_clock',
      observedRequestToPayoutSeconds: duration(requestAtUtc, payoutAtUtc),
      observedPendingToPayoutSeconds: duration(anchorAtUtc, payoutAtUtc),
      requestProofSha256: sourceRecord.requestProofSha256,
      sidecarSha256: sourceRecord.sidecarSha256,
      deliverySha256: sourceRecord.deliverySha256,
    },
  )
  assert.equal(facts[0].minedFinalAssetPayoutProven, true)
  assert.equal(facts[0].cryptographicAbsenceProven, false)
  assert.equal(facts[0].calibratedRestrictionDuration, false)
  assert.equal(facts[0].forecastEligible, false)
  assert.equal(diagnostics.sameEpisodeMinedPayouts, 1)
  assert.equal(diagnostics.calibratedRestrictionDurations, 0)
  assert.deepEqual(JSON.parse(JSON.stringify(facts)), facts)
})

test('as-of cutoff waits for local evidence availability even after payout event time', () => {
  const sourceIssue = issue()
  const sourceRecord = record(sourceIssue)
  const payoutMs = Date.parse(payoutAtUtc)
  const availabilityMs = Date.parse(localEvidenceAvailableAtUtc)
  const before = buildSusdePayoutEvidence({
    issues: [sourceIssue],
    records: [sourceRecord],
    asOfMs: payoutMs,
  })
  assert.deepEqual(before.facts, [])
  assert.equal(before.diagnostics.verifiedPayoutRecords, 1)
  assert.equal(before.diagnostics.sameEpisodeMinedPayouts, 0)
  assert.equal(before.diagnostics.notYetAvailablePayoutFactsExcluded, 1)
  assert.equal(before.diagnostics.futurePayoutFactsExcluded, 1)

  const immediatelyBefore = buildSusdePayoutEvidence({
    issues: [sourceIssue],
    records: [sourceRecord],
    asOfMs: availabilityMs - 1,
  })
  assert.deepEqual(immediatelyBefore.facts, [])
  assert.equal(immediatelyBefore.diagnostics.notYetAvailablePayoutFactsExcluded, 1)

  const at = buildSusdePayoutEvidence({
    issues: [sourceIssue],
    records: [sourceRecord],
    asOfMs: availabilityMs,
  })
  assert.equal(at.facts.length, 1)
  assert.equal(at.facts[0].payoutAtUtc, payoutAtUtc)
  assert.equal(at.facts[0].localEvidenceAvailableAtUtc, localEvidenceAvailableAtUtc)
  assert.equal(at.diagnostics.sameEpisodeMinedPayouts, 1)
  assert.equal(at.diagnostics.notYetAvailablePayoutFactsExcluded, 0)
  assert.equal(at.diagnostics.futurePayoutFactsExcluded, 0)
})

test('as-of cutoff validates every hidden record and rejects invalid timestamps', () => {
  const sourceIssue = issue()
  const sourceRecord = record(sourceIssue)
  const asOfMs = Date.parse(localEvidenceAvailableAtUtc) - 1
  assert.throws(
    () =>
      buildSusdePayoutEvidence({
        issues: [sourceIssue],
        records: [sourceRecord, sourceRecord],
        asOfMs,
      }),
    /duplicate_payout/,
  )
  assert.throws(
    () =>
      buildSusdePayoutEvidence({
        issues: [sourceIssue],
        records: [{ ...sourceRecord, status: 'sidecar_missing' }],
        asOfMs,
      }),
    /binding_invalid/,
  )
  for (const invalidAsOfMs of [-1, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () =>
        buildSusdePayoutEvidence({
          issues: [sourceIssue],
          records: [sourceRecord],
          asOfMs: invalidAsOfMs,
        }),
      /input_limit/,
    )
  }
})

test('projector rejects issue binding, unsupported status and altered proof scope', () => {
  const sourceIssue = issue()
  for (const mutate of [
    (row) => (row.status = 'sidecar_missing'),
    (row) => (row.issueSha256 = '0'.repeat(64)),
    (row) => (row.holder = OTHER_HOLDER),
    (row) => (row.rawAssets = '1'),
    (row) => (row.cooldownEndUtc = '2026-10-03T11:00:00.000Z'),
    (row) => (row.deliverySha256 = 'invalid'),
    (row) => (row.forecastValidated = true),
    (row) => (row.cryptographicAbsenceProven = true),
    (row) => (row.futureDurationClaim = true),
    (row) => (row.localEvidenceAvailabilityClock = 'independently_witnessed_publication'),
  ]) {
    const changed = record(sourceIssue)
    mutate(changed)
    assert.throws(
      () => buildSusdePayoutEvidence({ issues: [sourceIssue], records: [changed] }),
      /binding_invalid/,
    )
  }
  const changedIssue = { ...sourceIssue, estimand: 'hypothetical_cooldown_initiation' }
  assert.throws(
    () => buildSusdePayoutEvidence({ issues: [changedIssue], records: [record(sourceIssue)] }),
    /binding_invalid/,
  )
})

test('projector rejects wrong timing and invented elapsed seconds', () => {
  const sourceIssue = issue()
  for (const mutate of [
    (row) => (row.requestAtUtc = anchorAtUtc),
    (row) => (row.payoutAtUtc = issuedAtUtc),
    (row) => (row.localEvidenceAvailableAtUtc = issuedAtUtc),
    (row) => (row.observedRequestToPayoutSeconds += 1),
    (row) => (row.observedPendingToPayoutSeconds += 1),
  ]) {
    const changed = record(sourceIssue)
    mutate(changed)
    assert.throws(
      () => buildSusdePayoutEvidence({ issues: [sourceIssue], records: [changed] }),
      /timing_invalid/,
    )
  }
  const invalidClock = record(sourceIssue)
  invalidClock.localEvidenceAvailableAtUtc = 'invalid'
  assert.throws(
    () => buildSusdePayoutEvidence({ issues: [sourceIssue], records: [invalidClock] }),
    /clock_invalid/,
  )
})

test('duplicate issue or delivery cannot create a second payout fact', () => {
  const first = issue()
  assert.throws(
    () => buildSusdePayoutEvidence({ issues: [first], records: [record(first), record(first)] }),
    /duplicate_payout/,
  )
  const third = issue(3)
  const thirdRecord = record(third)
  thirdRecord.deliverySha256 = record(first).deliverySha256
  thirdRecord.payoutTransactionHash = hash('7')
  const issues = [first, null, third]
  assert.throws(
    () => buildSusdePayoutEvidence({ issues, records: [record(first), thirdRecord] }),
    /duplicate_payout/,
  )
})

test('records for issues outside the saved sidecar set are rejected', () => {
  const second = issue(2)
  const issues = [null, second]
  assert.throws(
    () => buildSusdePayoutEvidence({ issues, records: [record(second)] }),
    /binding_invalid/,
  )
  assert.deepEqual(buildSusdePayoutEvidence({ issues: [], records: [] }).facts, [])
})
