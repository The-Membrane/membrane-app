import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  HOLDER,
  HORIZONS_SECONDS,
  ISSUE_STUDY,
  Q_ASSETS_RAW,
  ROUTE,
  auditNowSchedule,
  createNowSchedule,
  verifyNowSchedule,
} from './scrvusd-now-schedule.mjs'

const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const plan = () =>
  createNowSchedule({
    plannedAtUtc: '2026-09-28T08:00:00.000Z',
    startAtUtc: '2026-09-28T10:00:00.000Z',
    endAtUtc: '2026-09-28T12:00:00.000Z',
  })
const issue = (issuedAtUtc, horizonSeconds, scheduleBinding) => {
  const body = {
    study: ISSUE_STUDY,
    kind: 'prospective-now-origin-holder-exit-forecast-issue',
    issuedAtUtc,
    horizonSeconds,
    holder: HOLDER,
    qAssetsRaw: Q_ASSETS_RAW,
    route: ROUTE,
    ...(scheduleBinding ? { scheduleBinding } : {}),
  }
  return { ...body, sha256: sha(body) }
}
const attempt = (manifest, slot, horizonSeconds, status, extra = {}) => ({
  manifestSha256: manifest.sha256,
  slotId: slot.slotId,
  horizonSeconds,
  status,
  recordedAtUtc: slot.scheduledAtUtc,
  ...extra,
})

test('canonical sealed hourly manifest and explicit lead/window bounds', () => {
  const manifest = plan()
  assert.deepEqual(verifyNowSchedule(manifest), manifest)
  assert.equal(manifest.slots.length, 2)
  assert.equal(manifest.slots[0].closesAtUtc, manifest.slots[1].scheduledAtUtc)
  assert.deepEqual(manifest.horizonsSeconds, [...HORIZONS_SECONDS])
  assert.throws(() =>
    verifyNowSchedule({ ...manifest, scope: { ...manifest.scope, holder: '0x0' } }),
  )
  assert.throws(() => createNowSchedule({ ...manifest, plannedAtUtc: undefined }))
  assert.throws(() => createNowSchedule({ ...manifest, startAtUtc: '2026-09-28T09:00:00.000Z' }))
  assert.throws(() => createNowSchedule({ ...manifest, endAtUtc: '2026-10-13T10:00:00.000Z' }))
  assert.throws(() => createNowSchedule({ ...manifest, startAtUtc: '2026-09-28T10:30:00.000Z' }))
})

test('due slots use half-open boundaries; missing arms remain visible', () => {
  const manifest = plan()
  const before = auditNowSchedule(manifest, {
    asOfUtc: '2026-09-28T10:59:59.999Z',
    verifiedIssueRows: [],
  })
  assert.equal(before.dueSlotCount, 0)
  const atClose = auditNowSchedule(manifest, {
    asOfUtc: '2026-09-28T11:00:00.000Z',
    verifiedIssueRows: [],
  })
  assert.equal(atClose.dueSlotCount, 1)
  assert.deepEqual(
    atClose.dueSlots[0].arms.map((arm) => arm.status),
    Array(4).fill('missing'),
  )
  assert.equal(atClose.dueArmCount, 4)
  assert.equal(atClose.prospectiveScheduleConfirmed, false)
})

test('manual v1 issue in a scheduled slot is unbound, never issued coverage', () => {
  const manifest = plan()
  const manual = issue('2026-09-28T10:10:00.000Z', 3600)
  const audit = auditNowSchedule(manifest, {
    asOfUtc: '2026-09-28T11:00:00.000Z',
    verifiedIssueRows: [manual],
  })
  assert.equal(audit.unboundIssueCount, 1)
  assert.equal(audit.boundIssuedArmCount, 0)
  assert.equal(audit.dueSlots[0].arms[0].status, 'missing')
  const claimed = auditNowSchedule(manifest, {
    asOfUtc: '2026-09-28T11:00:00.000Z',
    verifiedIssueRows: [manual],
    boundAttemptRows: [
      attempt(manifest, manifest.slots[0], 3600, 'issued', {
        issueSha256: manual.sha256,
        recordedAtUtc: '2026-09-28T10:11:00.000Z',
      }),
    ],
  })
  assert.equal(claimed.dueSlots[0].arms[0].status, 'unbound')
  assert.equal(claimed.boundIssuedArmCount, 0)
  assert.equal(claimed.unboundIssueCount, 1)
})

test('due coverage excludes historical and still-open-slot issues', () => {
  const manifest = plan()
  const beforePlan = issue('2026-09-28T09:59:59.999Z', 3600)
  const dueManual = issue('2026-09-28T10:10:00.000Z', 3600)
  const openManual = issue('2026-09-28T11:00:00.000Z', 3600)
  const audit = auditNowSchedule(manifest, {
    asOfUtc: '2026-09-28T11:30:00.000Z',
    verifiedIssueRows: [beforePlan, dueManual, openManual],
  })
  assert.equal(audit.dueSlotCount, 1)
  assert.equal(audit.dueArmCount, 4)
  assert.equal(audit.boundIssueCount, 0)
  assert.equal(audit.unboundIssueCount, 1)
  assert.equal(audit.outsidePlanIssueCount, 1)
  assert.equal(audit.notYetDueSlotIssueCount, 1)
  assert.equal(audit.dueSlots[0].arms[0].status, 'missing')
})

test('hand-built future-schema dual binding describes an operational issued arm only', () => {
  const manifest = plan()
  const slot = manifest.slots[0]
  const linked = issue('2026-09-28T10:10:00.000Z', 7200, {
    manifestSha256: manifest.sha256,
    slotId: slot.slotId,
  })
  const audit = auditNowSchedule(manifest, {
    asOfUtc: '2026-09-28T11:00:00.000Z',
    verifiedIssueRows: [linked],
    boundAttemptRows: [
      attempt(manifest, slot, 7200, 'issued', {
        issueSha256: linked.sha256,
        recordedAtUtc: '2026-09-28T10:11:00.000Z',
      }),
    ],
  })
  assert.equal(audit.dueSlots[0].arms[1].status, 'issued')
  assert.equal(audit.boundIssuedArmCount, 1)
  assert.equal(audit.prospectiveScheduleConfirmed, false)
  assert.equal(audit.calibratedForecastEligible, false)
})

test('duplicate issued attempts in one cell are unknown; cross-cell issue reuse fails', () => {
  const manifest = plan()
  const slot = manifest.slots[0]
  // This is a synthetic future-schema row; the current v1 issuer cannot emit it.
  const linked = issue('2026-09-28T10:10:00.000Z', 3600, {
    manifestSha256: manifest.sha256,
    slotId: slot.slotId,
  })
  const first = attempt(manifest, slot, 3600, 'issued', {
    issueSha256: linked.sha256,
    recordedAtUtc: '2026-09-28T10:11:00.000Z',
  })
  const duplicate = { ...first, recordedAtUtc: '2026-09-28T10:12:00.000Z' }
  const base = {
    asOfUtc: '2026-09-28T11:00:00.000Z',
    verifiedIssueRows: [linked],
  }
  const audit = auditNowSchedule(manifest, { ...base, boundAttemptRows: [first, duplicate] })
  assert.equal(audit.dueSlots[0].arms[0].status, 'unknown')
  assert.equal(audit.boundIssuedArmCount, 0)
  assert.equal(audit.boundIssueCount, 0)
  assert.equal(audit.unconfirmedBoundIssueCount, 1)
  assert.throws(() =>
    auditNowSchedule(manifest, {
      ...base,
      boundAttemptRows: [
        first,
        attempt(manifest, slot, 7200, 'issued', {
          issueSha256: linked.sha256,
          recordedAtUtc: '2026-09-28T10:12:00.000Z',
        }),
      ],
    }),
  )
})

test('forged or wrong-bound rows and wrong time are rejected', () => {
  const manifest = plan()
  const slot = manifest.slots[0]
  const linked = issue('2026-09-28T10:10:00.000Z', 3600, {
    manifestSha256: manifest.sha256,
    slotId: manifest.slots[1].slotId,
  })
  const base = {
    asOfUtc: '2026-09-28T11:00:00.000Z',
    verifiedIssueRows: [linked],
  }
  assert.throws(() =>
    auditNowSchedule(manifest, {
      ...base,
      boundAttemptRows: [attempt(manifest, slot, 3600, 'issued', { issueSha256: linked.sha256 })],
    }),
  )
  assert.throws(() =>
    auditNowSchedule(manifest, {
      ...base,
      boundAttemptRows: [
        attempt(manifest, slot, 3600, 'failed', { manifestSha256: '0'.repeat(64) }),
      ],
    }),
  )
  assert.throws(() =>
    auditNowSchedule(manifest, {
      ...base,
      boundAttemptRows: [
        attempt(manifest, slot, 3600, 'failed', { recordedAtUtc: slot.closesAtUtc }),
      ],
    }),
  )
  assert.throws(() =>
    auditNowSchedule(manifest, {
      ...base,
      boundAttemptRows: [attempt(manifest, slot, 3600, 'issued', { issueSha256: 'f'.repeat(64) })],
    }),
  )
})
