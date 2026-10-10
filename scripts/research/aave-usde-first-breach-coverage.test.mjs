import assert from 'node:assert/strict'
import test from 'node:test'
import { issueFirstBreach, scoreFirstBreach } from './aave-usde-first-breach.mjs'
import {
  buildFirstBreachSchedule,
  physicalSha256 as schedulePhysicalSha256,
} from './aave-usde-first-breach-schedule.mjs'
import {
  auditHourlyCoverage,
  buildHourlyCoverageManifest,
  physicalSha256,
  snapshotRowSha256,
} from './aave-usde-first-breach-coverage.mjs'

const base = Date.parse('2026-09-28T00:00:00.000Z')
const iso = (at) => new Date(at).toISOString()
const hour = 3_600_000
const config = {
  name: 'aave-v3-usde',
  enabled: true,
  kind: 'atoken-liquidity',
  address: '0x4F5923Fc5FD4a93352581b38B7cD26943012DECF',
  underlying: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3',
  decimals: 18,
}
const sample = (i) => {
  const at = base + i * 4 * hour
  return {
    id: `sample-${i}`,
    venue: 'aave-v3-usde',
    chain: 'ethereum',
    source: 'observed',
    recorder_atomic_v1: true,
    block: String(100 + i),
    observed_at: iso(at),
    created_at: iso(at),
    instant_usd: 20_000_000,
    params: {
      kind: 'atoken-liquidity',
      read_block_finalized: true,
      read_block_pinned: true,
      read_block_number: String(100 + i),
      read_block_hash: `0x${(100 + i).toString(16).padStart(64, '0')}`,
      read_block_time: at / 1000 - 600,
      aToken: config.address,
      underlying: config.underlying,
      underlyingOnchain: config.underlying,
      underlyingIdentity: 'match',
      decimalsIdentity: 'match',
      decimals: 18,
      underlyingDecimalsOnchain: 18,
      reads: { underlyingAsset: true, underlyingDecimals: true, underlyingBalance: true },
      underlyingBalance: (20_000_000n * 10n ** 18n).toString(),
      priceAssumptionUsd: 1,
    },
  }
}
const issue = issueFirstBreach(
  Array.from({ length: 7 }, (_, i) => sample(i)),
  {
    config,
    anchorId: 'sample-6',
    issuedAt: iso(base + 24 * hour),
    amountUsd: 10_000_000,
    horizonSeconds: 8 * 3600,
  },
)
const issueScheduleBytes = buildFirstBreachSchedule({
  plannedAt: iso(base + 23 * hour),
  startAt: iso(base + 24 * hour),
  endExclusiveAt: iso(base + 25 * hour),
})
const scheduleSha = schedulePhysicalSha256(issueScheduleBytes)
const manifestBytes = buildHourlyCoverageManifest({
  venue: 'aave-v3-usde',
  startAt: iso(base + 24 * hour),
  endExclusiveAt: iso(base + 41 * hour),
  declaredAt: iso(base + 23 * hour),
  issueSchedulePhysicalSha256: scheduleSha,
})
const manifest = JSON.parse(manifestBytes)
const row = (i) => {
  const observed = base + (24 + i) * hour + 60_000
  const prior = sample(7 + i)
  return {
    ...prior,
    id: `hour-${i}`,
    block: String(300 + i),
    observed_at: iso(observed),
    created_at: iso(observed + 30_000),
    params: {
      ...prior.params,
      read_block_number: String(300 + i),
      read_block_hash: `0x${(300 + i).toString(16).padStart(64, '0')}`,
      read_block_time: observed / 1000 - 600,
    },
  }
}
const receipts = manifest.slots.slice(0, 16).map((slot, i) => ({
  slotId: slot.id,
  status: 'success',
  attemptedAt: iso(base + (24 + i) * hour + 100_000),
  snapshotId: `hour-${i}`,
  snapshotRowSha256: snapshotRowSha256(row(i)),
}))
const rows = manifest.slots.slice(0, 16).map((_, i) => row(i))
const audit = (changes = {}) =>
  auditHourlyCoverage({
    manifestBytes,
    expectedManifestPhysicalSha256: physicalSha256(manifestBytes),
    issueScheduleBytes,
    expectedIssueSchedulePhysicalSha256: scheduleSha,
    issue,
    receipts,
    snapshotRows: rows,
    asOf: iso(base + 40 * hour + 120_000),
    ...changes,
  })
const auditChangedRow = (index, changed) => {
  const changedRows = rows.map((r, i) => (i === index ? changed : r))
  const changedReceipts = receipts.map((r, i) =>
    i === index ? { ...r, snapshotRowSha256: snapshotRowSha256(changed) } : r,
  )
  return audit({ snapshotRows: changedRows, receipts: changedReceipts })
}

test('exact hourly receipts and rows produce only caller receipt evidence', () => {
  const result = audit()
  assert.equal(result.counts.expected, 16)
  assert.equal(result.counts.success, 16)
  assert.equal(result.hourlyCoverageFromCallerReceipts, true)
  assert.equal(result.prospectiveEligible, false)
  assert.equal(result.sourceCompleteness, 'caller_receipt_evidence_only')
  assert.equal(result.issueScheduleMembership, 'caller_consistent_only')
  assert.equal(result.issueScheduleSlotId, JSON.parse(issueScheduleBytes).slots[0].slotId)
})

test('adjacent or nonadjacent receipts cannot recycle a pinned block or hash', () => {
  const duplicateBlock = {
    ...rows[1],
    block: rows[0].block,
    params: { ...rows[1].params, read_block_number: rows[0].block },
  }
  assert.equal(auditChangedRow(1, duplicateBlock).counts.mismatch, 1)
  const repeatedHash = {
    ...rows[1],
    params: { ...rows[1].params, read_block_hash: rows[0].params.read_block_hash },
  }
  assert.equal(auditChangedRow(1, repeatedHash).counts.mismatch, 1)
  const repeatedEarlierHash = {
    ...rows[2],
    params: { ...rows[2].params, read_block_hash: rows[0].params.read_block_hash },
  }
  assert.equal(auditChangedRow(2, repeatedEarlierHash).counts.mismatch, 1)
  const oldBlockTime = {
    ...rows[1],
    params: { ...rows[1].params, read_block_time: rows[0].params.read_block_time },
  }
  assert.equal(auditChangedRow(1, oldBlockTime).counts.mismatch, 1)
})

test('first hourly row must advance the issue anchor block and hash', () => {
  const anchorReuse = {
    ...rows[0],
    block: issue.anchor.block,
    params: {
      ...rows[0].params,
      read_block_number: issue.anchor.block,
      read_block_hash: issue.anchor.blockHash,
    },
  }
  const result = auditChangedRow(0, anchorReuse)
  assert.equal(result.counts.mismatch, 1)
  assert.equal(result.hourlyCoverageFromCallerReceipts, false)
})

test('anchor and nonadjacent outcome snapshot IDs cannot be reused', () => {
  const anchorIdReuse = { ...rows[0], id: issue.anchor.id }
  const anchorRows = [anchorIdReuse, ...rows.slice(1)]
  const anchorReceipts = receipts.map((receipt, i) =>
    i === 0
      ? {
          ...receipt,
          snapshotId: anchorIdReuse.id,
          snapshotRowSha256: snapshotRowSha256(anchorIdReuse),
        }
      : receipt,
  )
  const anchorResult = audit({ snapshotRows: anchorRows, receipts: anchorReceipts })
  assert.equal(anchorResult.counts.mismatch, 1)
  assert.equal(anchorResult.hourlyCoverageFromCallerReceipts, false)

  const reusedId = { ...rows[2], id: rows[0].id }
  const laterRows = rows.map((r, i) => (i === 2 ? reusedId : r))
  const laterReceipts = receipts.map((receipt, i) =>
    i === 2
      ? { ...receipt, snapshotId: reusedId.id, snapshotRowSha256: snapshotRowSha256(reusedId) }
      : receipt,
  )
  const laterResult = audit({ snapshotRows: laterRows, receipts: laterReceipts })
  assert.ok(laterResult.counts.mismatch >= 1)
  assert.deepEqual(laterResult.duplicateRowIds, [rows[0].id])
  assert.equal(laterResult.hourlyCoverageFromCallerReceipts, false)
})

test('a missed hourly tick fails coverage even when scorer accepts <=8h gaps', () => {
  const without = receipts.filter((receipt) => receipt.slotId !== manifest.slots[2].id)
  const coverage = audit({ receipts: without, snapshotRows: rows.filter((r) => r.id !== 'hour-2') })
  assert.equal(coverage.counts.missing, 1)
  assert.equal(coverage.hourlyCoverageFromCallerReceipts, false)
  const scoreRows = [sample(7), sample(8), sample(9), sample(10)]
  const scored = scoreFirstBreach(issue, scoreRows, {
    scoredAt: iso(base + 40 * hour + 120_000),
    existingScore: null,
  })
  assert.equal(scored.status, 'observed')
})

test('failed, skipped and explicit missed attempts stay distinct', () => {
  const altered = receipts.map((r, i) =>
    i === 0
      ? { ...r, status: 'read_failure' }
      : i === 1
        ? { ...r, status: 'insert_failure' }
        : i === 2
          ? { ...r, status: 'skipped_fresh' }
          : i === 3
            ? { ...r, status: 'skipped_unchanged' }
            : i === 4
              ? { ...r, status: 'missed' }
              : r,
  )
  const result = audit({ receipts: altered })
  assert.equal(result.counts.readFailure, 1)
  assert.equal(result.counts.insertFailure, 1)
  assert.equal(result.counts.skippedFresh, 1)
  assert.equal(result.counts.skippedUnchanged, 1)
  assert.equal(result.counts.missed, 1)
  assert.equal(result.hourlyCoverageFromCallerReceipts, false)
})

test('duplicate receipt, duplicate row, unmatched row and mismatched row are visible', () => {
  assert.equal(audit({ receipts: [...receipts, receipts[0]] }).counts.duplicate, 1)
  assert.equal(audit({ snapshotRows: [...rows, rows[0]] }).counts.mismatch, 1)
  assert.deepEqual(audit({ snapshotRows: [...rows, { ...row(99) }] }).unattachedSnapshotIds, [
    'hour-99',
  ])
  const badRows = rows.map((r, i) => (i === 0 ? { ...r, block: '999' } : r))
  assert.equal(audit({ snapshotRows: badRows }).counts.mismatch, 1)
  const wrongReserve = rows.map((r, i) =>
    i === 0 ? { ...r, params: { ...r.params, underlyingOnchain: config.address } } : r,
  )
  const resealedReceipts = receipts.map((r, i) =>
    i === 0 ? { ...r, snapshotRowSha256: snapshotRowSha256(wrongReserve[0]) } : r,
  )
  assert.equal(audit({ snapshotRows: wrongReserve, receipts: resealedReceipts }).counts.mismatch, 1)
})

test('late attempt or late DB availability never counts as a timely hourly observation', () => {
  const lateAttempt = receipts.map((r, i) =>
    i === 0 ? { ...r, attemptedAt: iso(base + 25 * hour) } : r,
  )
  assert.equal(audit({ receipts: lateAttempt }).counts.late, 1)
  const lateRow = rows.map((r, i) => (i === 0 ? { ...r, created_at: iso(base + 26 * hour) } : r))
  assert.equal(audit({ snapshotRows: lateRow }).counts.mismatch, 1)
  const invalidAttempt = receipts.map((r, i) => (i === 0 ? { ...r, attemptedAt: 'not-a-date' } : r))
  assert.equal(audit({ receipts: invalidAttempt }).counts.mismatch, 1)
  assert.equal(audit({ receipts: invalidAttempt }).hourlyCoverageFromCallerReceipts, false)
  const beforeInsert = receipts.map((r, i) =>
    i === 0 ? { ...r, attemptedAt: iso(base + 24 * hour + 75_000) } : r,
  )
  assert.equal(audit({ receipts: beforeInsert }).counts.mismatch, 1)
  assert.equal(audit({ receipts: beforeInsert }).hourlyCoverageFromCallerReceipts, false)
})

test('manifest physical bytes, slot IDs, schedule identity and window must match', () => {
  assert.throws(() => audit({ expectedManifestPhysicalSha256: 'b'.repeat(64) }), /physical SHA/)
  assert.throws(
    () => audit({ expectedIssueSchedulePhysicalSha256: 'b'.repeat(64) }),
    /schedule physical SHA/,
  )
  const changed = {
    ...manifest,
    slots: [{ ...manifest.slots[0], id: 'invented' }, ...manifest.slots.slice(1)],
  }
  const changedBytes = JSON.stringify(changed)
  assert.throws(
    () =>
      audit({
        manifestBytes: changedBytes,
        expectedManifestPhysicalSha256: physicalSha256(changedBytes),
      }),
    /slot IDs|bytes/,
  )
  assert.throws(
    () =>
      buildHourlyCoverageManifest({
        venue: 'aave-v3-usde',
        startAt: iso(base + 24 * hour),
        endExclusiveAt: iso(base + 41 * hour),
        declaredAt: iso(base + 24 * hour),
        issueSchedulePhysicalSha256: scheduleSha,
      }),
    /before first slot/,
  )
})

test('schedule bytes and external physical SHA are mandatory and must match manifest', () => {
  assert.throws(() => audit({ issueScheduleBytes: undefined }), /schedule bytes|required/)
  assert.throws(
    () => audit({ expectedIssueSchedulePhysicalSha256: undefined }),
    /schedule bytes|required/,
  )
  assert.throws(
    () => audit({ expectedIssueSchedulePhysicalSha256: 'a'.repeat(64) }),
    /schedule physical SHA/,
  )
  const differentBytes = buildFirstBreachSchedule({
    plannedAt: iso(base + 22 * hour),
    startAt: iso(base + 24 * hour),
    endExclusiveAt: iso(base + 25 * hour),
  })
  assert.throws(
    () =>
      audit({
        issueScheduleBytes: differentBytes,
        expectedIssueSchedulePhysicalSha256: schedulePhysicalSha256(differentBytes),
      }),
    /Distinct issue schedule physical SHA required/,
  )
})

test('only the unique scheduled interval and fixed-grid issue arm can pass', () => {
  const shiftedBytes = buildFirstBreachSchedule({
    plannedAt: iso(base + 23 * hour),
    startAt: iso(base + 25 * hour),
    endExclusiveAt: iso(base + 26 * hour),
  })
  const shiftedSha = schedulePhysicalSha256(shiftedBytes)
  const shiftedManifestBytes = buildHourlyCoverageManifest({
    venue: 'aave-v3-usde',
    startAt: iso(base + 24 * hour),
    endExclusiveAt: iso(base + 41 * hour),
    declaredAt: iso(base + 23 * hour),
    issueSchedulePhysicalSha256: shiftedSha,
  })
  assert.throws(
    () =>
      audit({
        issueScheduleBytes: shiftedBytes,
        expectedIssueSchedulePhysicalSha256: shiftedSha,
        manifestBytes: shiftedManifestBytes,
        expectedManifestPhysicalSha256: physicalSha256(shiftedManifestBytes),
      }),
    /exactly one scheduled v2 slot/,
  )
  const descriptiveIssue = issueFirstBreach(
    Array.from({ length: 7 }, (_, i) => sample(i)),
    {
      config,
      anchorId: 'sample-6',
      issuedAt: iso(base + 24 * hour),
      amountUsd: 9_000_000,
      horizonSeconds: 8 * 3600,
    },
  )
  assert.throws(() => audit({ issue: descriptiveIssue }), /fixed-grid arm/)
  const wrongStudyBytes = issueScheduleBytes.replace(
    'aave-v3-usde-first-sampled-cash-breach-by-h-v2',
    'aave-v3-usde-first-sampled-cash-breach-by-h-v1',
  )
  assert.throws(
    () =>
      audit({
        issueScheduleBytes: wrongStudyBytes,
        expectedIssueSchedulePhysicalSha256: schedulePhysicalSha256(wrongStudyBytes),
      }),
    /Wrong first-breach schedule study/,
  )
})

test('coverage remains pending before the fixed source cutoff', () => {
  const result = audit({ asOf: iso(base + 39 * hour) })
  assert.equal(result.hourlyCoverageFromCallerReceipts, false)
  assert.ok(result.counts.pending > 0)
  assert.equal(result.counts.censored, 0)
})

test('a first-slot sample at issue time does not cover the post-issue window', () => {
  const laterIssue = issueFirstBreach(
    Array.from({ length: 7 }, (_, i) => sample(i)),
    {
      config,
      anchorId: 'sample-6',
      issuedAt: iso(base + 24 * hour + 60_000),
      amountUsd: 10_000_000,
      horizonSeconds: 8 * 3600,
    },
  )
  const result = audit({ issue: laterIssue, asOf: iso(base + 40 * hour + 180_000) })
  assert.equal(result.counts.mismatch, 1)
  assert.equal(result.hourlyCoverageFromCallerReceipts, false)
})
