import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import test from 'node:test'

import { buildSubjectManifest } from '../../scripts/record-carry-cash-issues.mjs'
import {
  buildIssueAttempts,
  buildScoreAttempts,
  verifyLocalCashIssueLedgerFromVerified,
} from '../../scripts/lib/localCarryCashIssueStore.mjs'
import { verifyLocalCarryCash } from '../../scripts/lib/localCarryCashStore.mjs'

const fixtureManifest = {
  sha256: 'fixture',
  subjects: Array.from({ length: 67 }, (_, index) => ({
    route_key: `route-${index}`,
    destination: `destination-${index}`,
    asset: 'asset',
  })),
}
const validTime = '2026-10-07T12:00:00.000Z'

test('rejects invalid and noncanonical timestamps on every invocation', () => {
  for (const invalid of [
    null,
    0,
    '',
    '2026-10-07T12:00:00Z',
    '2026-10-07T12:00:00.000+00:00',
    '2026-02-30T12:00:00.000Z',
    '2026-02-29T12:00:00.000Z',
    '2026-10-07T24:00:00.000Z',
    '2026-13-07T12:00:00.000Z',
  ]) {
    for (let invocation = 0; invocation < 2; invocation++) {
      assert.throws(
        () => buildIssueAttempts(fixtureManifest, [], invalid),
        /local_cash_issue_bad_time/,
      )
    }
  }
  assert.equal(buildIssueAttempts(fixtureManifest, [], validTime).length, 134)
})

test('evicts validated timestamps when an invocation exceeds the bounded cache', () => {
  const observations = Array.from({ length: 4097 }, (_, index) => {
    const blockAt = new Date(Date.parse(validTime) - (index + 1) * 1000).toISOString()
    return {
      collectionMode: 'current',
      evidenceKind: 'current_finalized_observation',
      manifestSha256: fixtureManifest.sha256,
      source: { blockAt },
      firstLocalReceiptAt: blockAt,
      subjects: [],
    }
  })
  const oldestInserted = observations[0].source.blockAt
  const originalParse = Date.parse
  let parses = 0
  try {
    Date.parse = (value) => {
      if (value === oldestInserted) parses++
      return originalParse(value)
    }
    assert.equal(buildIssueAttempts(fixtureManifest, observations, validTime).length, 134)
  } finally {
    Date.parse = originalParse
  }
  assert.ok(parses > 1, 'the earliest inserted value must be revalidated after eviction')
})

test('validated timestamps are reused only within one complete archive verification', async () => {
  const manifest = await buildSubjectManifest()
  const verifiedCash = verifyLocalCarryCash(manifest)
  const cashBefore = JSON.stringify(verifiedCash)
  const originalParse = Date.parse
  const invocationCalls = []
  let replay
  try {
    for (let invocation = 0; invocation < 2; invocation++) {
      const calls = new Map()
      Date.parse = (value) => {
        calls.set(value, (calls.get(value) ?? 0) + 1)
        return originalParse(value)
      }
      const start = performance.now()
      replay = verifyLocalCashIssueLedgerFromVerified(manifest, verifiedCash)
      assert.equal(replay.count, 185)
      assert.ok(calls.size > 0 && calls.size < 4096)
      assert.ok([...calls.values()].every((count) => count === 1))
      invocationCalls.push([...calls.keys()].sort())
      console.log(
        JSON.stringify({
          invocation,
          records: replay.count,
          uniqueParsedTimes: calls.size,
          elapsedMs: Math.round(performance.now() - start),
        }),
      )
    }
    assert.deepEqual(invocationCalls[0], invocationCalls[1])

    const previouslyValid = replay.records.find((record) => record.kind === 'issue').issuedAt
    Date.parse = (value) => (value === previouslyValid ? NaN : originalParse(value))
    assert.throws(
      () => verifyLocalCashIssueLedgerFromVerified(manifest, verifiedCash),
      /local_cash_issue_bad_time/,
    )
    Date.parse = originalParse
    assert.equal(verifyLocalCashIssueLedgerFromVerified(manifest, verifiedCash).count, 185)
  } finally {
    Date.parse = originalParse
  }

  const issues = new Map()
  for (const record of replay.records) {
    let rebuilt
    if (record.kind === 'issue') {
      rebuilt = buildIssueAttempts(manifest, replay.observations, record.issuedAt)
      issues.set(record.slotAt, record)
    } else {
      rebuilt = buildScoreAttempts(
        issues.get(record.issueSlotAt),
        manifest,
        replay.observations,
        record.scoredAt,
        Object.hasOwn(record, 'horizonHours') ? record.horizonHours : null,
      )
    }
    assert.equal(JSON.stringify(rebuilt), JSON.stringify(record.attempts))
  }
  assert.equal(JSON.stringify(verifiedCash), cashBefore)
  const digest = createHash('sha256').update(JSON.stringify(replay.records)).digest('hex')
  console.log(JSON.stringify({ rebuiltRecords: replay.count, recordsSha256: digest }))

  const altered = structuredClone(verifiedCash)
  const issue = replay.records.find(
    (record) =>
      record.kind === 'issue' && record.attempts.some((attempt) => attempt.status === 'issued'),
  )
  const attempt = issue.attempts.find((row) => row.status === 'issued')
  const receipt = altered.records.find((row) => row.sha256 === attempt.source.receiptSha256)
  const row = receipt.rows.find(
    (entry) => entry.routeKey === attempt.routeKey && entry.destination === attempt.destination,
  )
  row.cashRaw = (BigInt(row.cashRaw) + 1n).toString()
  assert.throws(
    () => verifyLocalCashIssueLedgerFromVerified(manifest, altered),
    /local_cash_issue_replay_mismatch/,
  )
})
