// Pure v2 issue calendar. Persist and independently witness exact bytes before
// the first slot; this module itself cannot attest publication or DB coverage.
import { createHash } from 'node:crypto'
import { STUDY, verifyFirstBreachIssue } from './aave-usde-first-breach.mjs'
import { SCORE_AMOUNTS_USD, SCORE_HORIZONS_SECONDS } from './aave-usde-prospective-cash.mjs'

export const SCHEDULE_SCHEMA = 'aave-usde-first-breach-issue-schedule-v1'
const HOUR_MS = 3_600_000
// The separate hourly coverage manifest is capped at 31 days. Reserve 7d
// for the longest fixed score horizon and 8h for its target witness.
const MAX_SLOTS = 31 * 24 - 7 * 24 - 8
const sha = (bytes) => createHash('sha256').update(bytes, 'utf8').digest('hex')
const fail = (message) => {
  throw new Error(message)
}
const timestamp = (value, name) => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
    fail(`${name} must be an explicit UTC ISO timestamp`)
  const ms = Date.parse(value)
  if (!Number.isSafeInteger(ms) || new Date(ms).toISOString() !== value) fail(`Invalid ${name}`)
  return ms
}
const grid = () =>
  SCORE_AMOUNTS_USD.flatMap((amountUsd) =>
    SCORE_HORIZONS_SECONDS.map((horizonSeconds) => ({ amountUsd, horizonSeconds })),
  )
const cell = (slotId, amountUsd, horizonSeconds) => `${slotId}/${amountUsd}/${horizonSeconds}`

export function buildFirstBreachSchedule({ plannedAt, startAt, endExclusiveAt }) {
  const planned = timestamp(plannedAt, 'plannedAt')
  const start = timestamp(startAt, 'startAt')
  const end = timestamp(endExclusiveAt, 'endExclusiveAt')
  const count = (end - start) / HOUR_MS
  if (
    planned >= start ||
    start % HOUR_MS !== 0 ||
    end % HOUR_MS !== 0 ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > MAX_SLOTS
  )
    fail('Schedule requires future, bounded, aligned hourly slots')
  const arms = grid()
  const slots = Array.from({ length: count }, (_, index) => {
    const scheduledAt = new Date(start + index * HOUR_MS).toISOString()
    const closesAt = new Date(start + (index + 1) * HOUR_MS).toISOString()
    return {
      slotId: sha(
        JSON.stringify({ study: STUDY, plannedAt, startAt, endExclusiveAt, scheduledAt, closesAt }),
      ),
      scheduledAt,
      closesAt,
      arms,
    }
  })
  return JSON.stringify({
    schema: SCHEDULE_SCHEMA,
    study: STUDY,
    plannedAt,
    startAt,
    endExclusiveAt,
    cadenceSeconds: 3600,
    amountsUsd: [...SCORE_AMOUNTS_USD],
    horizonsSeconds: [...SCORE_HORIZONS_SECONDS],
    slots,
  })
}

// expectedPhysicalSha256 must come from outside these bytes (for example, a
// previously confirmed insert-once schedule row). Caller possession of a hash
// does not establish its publication time, immutability, or completeness.
export function verifyFirstBreachSchedule(scheduleBytes, expectedPhysicalSha256) {
  if (typeof scheduleBytes !== 'string' || !/^[a-f0-9]{64}$/.test(expectedPhysicalSha256))
    fail('Expected physical SHA and exact schedule bytes required')
  if (sha(scheduleBytes) !== expectedPhysicalSha256) fail('Issue schedule physical SHA mismatch')
  let manifest
  try {
    manifest = JSON.parse(scheduleBytes)
  } catch {
    fail('Invalid issue schedule JSON')
  }
  if (manifest?.study !== STUDY || manifest?.schema !== SCHEDULE_SCHEMA)
    fail('Wrong first-breach schedule study or schema')
  if (buildFirstBreachSchedule(manifest) !== scheduleBytes)
    fail('Issue schedule differs from canonical bytes or fixed grid')
  return { manifest, physicalSha256: expectedPhysicalSha256 }
}

// Only a validated fixed-grid v2 issue from the requested slot and arm can be
// associated with a schedule. The returned binding is caller consistency.
export function bindFirstBreachIssue({ scheduleBytes, expectedPhysicalSha256, slotId, issue }) {
  const { manifest, physicalSha256 } = verifyFirstBreachSchedule(
    scheduleBytes,
    expectedPhysicalSha256,
  )
  verifyFirstBreachIssue(issue)
  const slot = manifest.slots.find((item) => item.slotId === slotId)
  if (!slot) fail('Issue slot absent from v2 schedule')
  if (issue.scoreClass !== 'fixed_grid') fail('Descriptive issue is not a fixed-grid arm')
  if (
    !slot.arms.some(
      (arm) => arm.amountUsd === issue.amountUsd && arm.horizonSeconds === issue.horizonSeconds,
    )
  )
    fail('Issue arm absent from scheduled grid')
  const issued = timestamp(issue.issuedAt, 'issuedAt')
  if (
    issued < timestamp(slot.scheduledAt, 'slot start') ||
    issued >= timestamp(slot.closesAt, 'slot end')
  )
    fail('Issue time outside scheduled slot')
  return {
    study: STUDY,
    issueSchedulePhysicalSha256: physicalSha256,
    slotId,
    amountUsd: issue.amountUsd,
    horizonSeconds: issue.horizonSeconds,
    issueSha256: issue.sha256,
    membership: 'caller_consistent_only',
    prospectiveEligible: false,
  }
}

// Include every planned arm even when no attempt was supplied. Inputs are
// caller-supplied receipts; this is a denominator inventory, not a DB audit.
export function classifyFirstBreachSchedule({
  scheduleBytes,
  expectedPhysicalSha256,
  asOf,
  attempts = [],
}) {
  const { manifest } = verifyFirstBreachSchedule(scheduleBytes, expectedPhysicalSha256)
  const now = timestamp(asOf, 'asOf')
  if (now < timestamp(manifest.plannedAt, 'plannedAt')) fail('Audit precedes schedule plan')
  if (!Array.isArray(attempts)) fail('Complete caller attempt array required')
  const planned = new Map()
  for (const slot of manifest.slots)
    for (const arm of slot.arms)
      planned.set(cell(slot.slotId, arm.amountUsd, arm.horizonSeconds), {
        slot,
        arm,
        status: now < timestamp(slot.closesAt, 'slot end') ? 'scheduled' : 'missing',
        issueSha256: null,
      })
  const seen = new Set()
  for (const attempt of attempts) {
    if (!attempt || !['issued', 'failed', 'abstained', 'duplicate'].includes(attempt.status))
      fail('Invalid terminal attempt status')
    if (attempt.issueSchedulePhysicalSha256 !== expectedPhysicalSha256)
      fail('Attempt lacks exact issue schedule physical SHA binding')
    const key = cell(attempt.slotId, attempt.amountUsd, attempt.horizonSeconds)
    const entry = planned.get(key)
    if (!entry) fail('Attempt is outside scheduled slot or arm')
    if (
      attempt.amountUsd !== entry.arm.amountUsd ||
      attempt.horizonSeconds !== entry.arm.horizonSeconds
    )
      fail('Attempt arm must exactly match scheduled numeric values')
    if (seen.has(key)) fail('Duplicate terminal attempt for scheduled arm')
    seen.add(key)
    const recorded = timestamp(attempt.recordedAt, 'recordedAt')
    if (
      recorded < timestamp(entry.slot.scheduledAt, 'slot start') ||
      recorded >= timestamp(entry.slot.closesAt, 'slot end') ||
      recorded > now
    )
      fail('Attempt time outside slot or as-of')
    if (attempt.status === 'issued' || attempt.status === 'duplicate') {
      if (!attempt.issue) fail('Issued or duplicate attempt lacks matching v2 issue')
      const bound = bindFirstBreachIssue({
        scheduleBytes,
        expectedPhysicalSha256,
        slotId: attempt.slotId,
        issue: attempt.issue,
      })
      if (bound.amountUsd !== attempt.amountUsd || bound.horizonSeconds !== attempt.horizonSeconds)
        fail('Linked issue does not match attempted schedule arm')
      if (timestamp(attempt.issue.issuedAt, 'issuedAt') > recorded)
        fail('Attempt recorded before issue')
      entry.issueSha256 = bound.issueSha256
    } else if (attempt.issue != null || typeof attempt.reason !== 'string' || !attempt.reason)
      fail('Failed or abstained attempt requires reason and no issue')
    entry.status = attempt.status
  }
  const counts = { scheduled: 0, issued: 0, failed: 0, abstained: 0, duplicate: 0, missing: 0 }
  const cells = [...planned.values()].map(({ slot, arm, status, issueSha256 }) => {
    counts[status]++
    return { slotId: slot.slotId, ...arm, status, issueSha256 }
  })
  return {
    study: STUDY,
    issueSchedulePhysicalSha256: expectedPhysicalSha256,
    asOf,
    counts,
    cells,
    sourceCompleteness: 'caller_attempt_evidence_only',
    prospectiveEligible: false,
  }
}

export const physicalSha256 = sha
