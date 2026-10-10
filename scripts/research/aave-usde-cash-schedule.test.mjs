import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  auditCashSchedule,
  createCashSchedule,
  verifyCashSchedule,
} from './aave-usde-cash-schedule.mjs'

const inputs = {
  plannedAt: '2026-09-28T00:00:00.000Z',
  startAt: '2026-09-29T00:00:00.000Z',
  endAt: '2026-09-29T03:00:00.000Z',
  cadenceSeconds: 3600,
}
const runA = '11111111-1111-4111-8111-111111111111'
const runB = '22222222-2222-4222-8222-222222222222'
const issueId = (slot, arm) =>
  `33333333-3333-4333-8333-${String(slot.arms.indexOf(arm) + 1).padStart(12, '0')}`
const receipt = (manifest, slot, runId, arm, phase, status) => ({
  manifestSha256: manifest.sha256,
  slotId: slot.slotId,
  runId,
  amountUsd: arm.amountUsd,
  horizonSeconds: arm.horizonSeconds,
  phase,
  status,
  issueId: ['issued', 'duplicate'].includes(status) ? issueId(slot, arm) : null,
  reason: ['abstained', 'failed'].includes(status) ? 'test_reason' : null,
  recordedAt: new Date(
    Date.parse(slot.scheduledAt) + (phase === 'start' ? 1000 : 2000),
  ).toISOString(),
})
const run = (manifest, slot, runId, status) => [
  ...slot.arms.map((arm) => receipt(manifest, slot, runId, arm, 'start', 'scheduled')),
  ...slot.arms.map((arm) => receipt(manifest, slot, runId, arm, 'result', status)),
]
const linkedIssue = (slot, arm) => ({
  id: issueId(slot, arm),
  amount_usd: String(arm.amountUsd),
  horizon_seconds: arm.horizonSeconds,
  issued_at: new Date(Date.parse(slot.scheduledAt) + 1100),
  persisted_at: new Date(Date.parse(slot.scheduledAt) + 1500),
  target_at: new Date(Date.parse(slot.scheduledAt) + 1100 + arm.horizonSeconds * 1000),
})

test('manifest is stable, future, explicit, and has nine arms per hourly slot', () => {
  const a = createCashSchedule(inputs)
  assert.deepEqual(a, createCashSchedule(inputs))
  assert.deepEqual(verifyCashSchedule(a), a)
  assert.equal(a.slots.length, 3)
  assert.ok(a.slots.every((slot) => slot.arms.length === 9))
  assert.equal(new Set(a.slots.map((slot) => slot.slotId)).size, 3)
  assert.throws(() => createCashSchedule({ ...inputs, startAt: undefined }), /explicit UTC/)
  assert.throws(() => createCashSchedule({ ...inputs, cadenceSeconds: 1800 }), /hourly/)
  assert.throws(() => createCashSchedule({ ...inputs, plannedAt: inputs.startAt }), /future/)
  assert.throws(() => verifyCashSchedule({ ...a, slots: [] }), /differs/)
})

test('skipped hourly invocation is a denominator slot with nine unscheduled arms', () => {
  const manifest = createCashSchedule(inputs)
  const slot = manifest.slots[0]
  const audit = auditCashSchedule(manifest, run(manifest, slot, runA, 'abstained'), {
    asOf: '2026-09-29T03:00:00.000Z',
  })
  assert.equal(audit.dueSlotCount, 3)
  assert.equal(audit.missedInvocationCount, 2)
  assert.equal(audit.armCounts.abstained, 9)
  assert.equal(audit.armCounts.not_scheduled, 18)
  assert.equal(audit.slots[1].status, 'missed_invocation')
})

test('duplicate retry counts one arm outcome while retaining two invocation receipts', () => {
  const manifest = createCashSchedule(inputs)
  const slot = manifest.slots[0]
  const arm = slot.arms[0]
  const attempts = [
    ...run(manifest, slot, runA, 'failed'),
    ...run(manifest, slot, runB, 'failed').map((row) =>
      row.phase === 'result' &&
      row.amountUsd === arm.amountUsd &&
      row.horizonSeconds === arm.horizonSeconds
        ? receipt(manifest, slot, runB, arm, 'result', 'issued')
        : row,
    ),
  ]
  const audit = auditCashSchedule(manifest, attempts, {
    asOf: '2026-09-29T01:00:00.000Z',
    issueReceipts: [linkedIssue(slot, arm)],
  })
  assert.equal(audit.armCounts.issued, 1)
  assert.equal(audit.armCounts.failed, 8)
  assert.equal(audit.armCounts.not_scheduled, 0)
  assert.equal(audit.slots[0].arms[0].retryCount, 1)
  assert.equal(audit.slots[0].arms[0].resultCount, 2)
  assert.equal(audit.slots[0].invocationCount, 2)
})

test('scheduled without result is visible and unbound receipts fail closed', () => {
  const manifest = createCashSchedule(inputs)
  const slot = manifest.slots[0]
  const arm = slot.arms[0]
  const starts = slot.arms.map((item) => receipt(manifest, slot, runA, item, 'start', 'scheduled'))
  const start = starts[0]
  const asOf = '2026-09-29T01:00:00.000Z'
  const audit = auditCashSchedule(manifest, starts, { asOf })
  assert.equal(audit.armCounts.scheduled_without_result, 9)
  assert.throws(
    () => auditCashSchedule(manifest, [{ ...start, slotId: undefined }], { asOf }),
    /binding/,
  )
  assert.throws(
    () => auditCashSchedule(manifest, [{ ...start, manifestSha256: undefined }], { asOf }),
    /binding/,
  )
  assert.throws(
    () =>
      auditCashSchedule(
        manifest,
        [{ ...start, phase: 'result', status: 'abstained', reason: 'test_reason' }],
        {
          asOf,
        },
      ),
    /matching scheduled start/,
  )
  assert.throws(
    () =>
      auditCashSchedule(manifest, [start, { ...start, phase: 'result', status: 'issued' }], {
        asOf,
      }),
    /valid issue or reason/,
  )
})

test('current open slot can contain receipts without entering the completed denominator', () => {
  const manifest = createCashSchedule(inputs)
  const slot = manifest.slots[0]
  const starts = slot.arms.map((arm) => receipt(manifest, slot, runA, arm, 'start', 'scheduled'))
  const audit = auditCashSchedule(manifest, starts, {
    asOf: '2026-09-29T00:30:00.000Z',
  })
  assert.equal(audit.dueSlotCount, 0)
  assert.equal(audit.slots[0].status, 'open')
  assert.equal(audit.slots[0].observedReceiptCount, 9)
})

test('DB-shaped receipts require complete runs and linked issue timing', () => {
  const manifest = createCashSchedule(inputs)
  const slot = manifest.slots[0]
  const arm = slot.arms[0]
  const rows = run(manifest, slot, runA, 'failed').map((row) => ({
    manifest_sha256: row.manifestSha256,
    slot_id: row.slotId,
    run_id: row.runId,
    amount_usd: String(row.amountUsd),
    horizon_seconds: row.horizonSeconds,
    phase: row.phase,
    status: row.status,
    reason: row.reason,
    issue_id: row.issueId,
    publisher_xid: row.phase === 'result' ? '12' : '11',
    recorded_at: new Date(row.recordedAt),
  }))
  const asOf = '2026-09-29T01:00:00.000Z'
  assert.equal(auditCashSchedule(manifest, rows, { asOf }).armCounts.failed, 9)
  assert.throws(
    () =>
      auditCashSchedule(
        manifest,
        rows.filter((row, index) => index !== 0 && index !== 9),
        { asOf },
      ),
    /incomplete/,
  )
  assert.throws(() => auditCashSchedule(manifest, rows.slice(0, -1), { asOf }), /incomplete/)
  const reverseClock = [...rows]
  reverseClock[9] = {
    ...reverseClock[9],
    recorded_at: new Date(Date.parse(slot.scheduledAt) + 500),
  }
  assert.throws(() => auditCashSchedule(manifest, reverseClock, { asOf }), /precedes scheduled/)
  const issued = [...rows]
  issued[9] = { ...issued[9], status: 'issued', reason: null, issue_id: issueId(slot, arm) }
  assert.throws(() => auditCashSchedule(manifest, issued, { asOf }), /linked persisted issue/)
  assert.equal(
    auditCashSchedule(manifest, issued, { asOf, issueReceipts: [linkedIssue(slot, arm)] }).armCounts
      .issued,
    1,
  )
  const manifestConfirmation = {
    manifestSha256: manifest.sha256,
    confirmedAt: '2026-09-28T01:00:00.000Z',
    publisherXid: '10',
    confirmerXid: '11',
  }
  const issueRunConfirmations = [
    {
      run_id: runA,
      manifest_sha256: manifest.sha256,
      slot_id: slot.slotId,
      confirmed_at: new Date(Date.parse(slot.scheduledAt) + 3000),
      result_xid: '12',
      confirmer_xid: '13',
    },
  ]
  const unconfirmedAudit = auditCashSchedule(manifest, issued, {
    asOf,
    issueReceipts: [linkedIssue(slot, arm)],
  })
  assert.equal(unconfirmedAudit.prospectiveIssuedArmCount, 0)
  assert.equal(unconfirmedAudit.unconfirmedIssuedArmCount, 1)
  assert.equal(
    auditCashSchedule(manifest, issued, {
      asOf,
      issueReceipts: [linkedIssue(slot, arm)],
      manifestConfirmation,
      issueRunConfirmations,
    }).prospectiveIssuedArmCount,
    1,
  )
  assert.throws(
    () =>
      auditCashSchedule(
        manifest,
        issued.map((row, index) => (index === 9 ? { ...row, publisher_xid: '14' } : row)),
        {
          asOf,
          issueReceipts: [linkedIssue(slot, arm)],
          manifestConfirmation,
          issueRunConfirmations,
        },
      ),
    /result transaction differs/,
  )
  assert.throws(
    () =>
      auditCashSchedule(manifest, issued, {
        asOf,
        issueReceipts: [linkedIssue(slot, arm)],
        manifestConfirmation: { ...manifestConfirmation, confirmerXid: '10' },
        issueRunConfirmations,
      }),
    /post-commit confirmation/,
  )
  assert.throws(
    () =>
      auditCashSchedule(manifest, issued, {
        asOf,
        issueReceipts: [linkedIssue(slot, arm)],
        manifestConfirmation,
        issueRunConfirmations: [
          {
            ...issueRunConfirmations[0],
            confirmed_at: new Date(Date.parse(slot.scheduledAt) + 64_000),
          },
        ],
      }),
    /more than 60 seconds/,
  )
  const lateStart = [...issued]
  lateStart[0] = {
    ...lateStart[0],
    recorded_at: new Date(Date.parse(slot.scheduledAt) + 1800),
  }
  assert.throws(
    () => auditCashSchedule(manifest, lateStart, { asOf, issueReceipts: [linkedIssue(slot, arm)] }),
    /predates its matching scheduled start/,
  )
  const late = {
    ...linkedIssue(slot, arm),
    persisted_at: new Date(Date.parse(slot.scheduledAt) + 3000),
  }
  assert.throws(
    () => auditCashSchedule(manifest, issued, { asOf, issueReceipts: [late] }),
    /timing is inconsistent/,
  )
})
