// Local research planning only. No publisher, scheduler, database, or alert.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const STUDY = 'scrvusd-now-origin-expected-slots-v1'
export const ISSUE_STUDY = 'scrvusd-now-origin-exit-forecast-issue-v1'
export const HOLDER = '0xcbe72c8dc34af0dc8e7a70df4c1da0ef23feca8e'
export const Q_ASSETS_RAW = '1000000000000000000000'
export const ROUTE = 'direct_erc4626_withdraw_crvusd_from_scrvusd'
export const HORIZONS_SECONDS = Object.freeze([3600, 7200, 86400, 604800])
export const CADENCE_SECONDS = 3600
export const MAX_DAYS = 14

const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const canonicalUtc = (value, name) => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
    throw new Error(`${name} requires explicit canonical UTC milliseconds`)
  const millis = Date.parse(value)
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value)
    throw new Error(`Invalid ${name}`)
  return millis
}
const assertPlain = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${name} must be an object`)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const issueBody = ({ sha256: _sha256, ...body }) => body

export function createNowSchedule({ plannedAtUtc, startAtUtc, endAtUtc }) {
  const planned = canonicalUtc(plannedAtUtc, 'plannedAtUtc')
  const start = canonicalUtc(startAtUtc, 'startAtUtc')
  const end = canonicalUtc(endAtUtc, 'endAtUtc')
  const hourMs = CADENCE_SECONDS * 1000
  if (start % hourMs || end % hourMs) throw new Error('Slots must align to UTC hours')
  if (start - planned < 2 * hourMs) throw new Error('First slot requires at least two hours lead')
  if (end <= start || end - start > MAX_DAYS * 86400 * 1000)
    throw new Error('Schedule must contain at most fourteen complete days')
  const slots = Array.from({ length: (end - start) / hourMs }, (_, index) => {
    const scheduledAtUtc = new Date(start + index * hourMs).toISOString()
    return {
      slotId: sha({ study: STUDY, scheduledAtUtc }),
      scheduledAtUtc,
      closesAtUtc: new Date(start + (index + 1) * hourMs).toISOString(),
    }
  })
  const body = {
    schema: STUDY,
    study: STUDY,
    scope: { holder: HOLDER, qAssetsRaw: Q_ASSETS_RAW, route: ROUTE },
    plannedAtUtc,
    startAtUtc,
    endAtUtc,
    cadenceSeconds: CADENCE_SECONDS,
    horizonsSeconds: [...HORIZONS_SECONDS],
    slots,
    evidenceClass: 'local_research_plan_only',
  }
  return { ...body, sha256: sha(body) }
}

export function verifyNowSchedule(manifest) {
  assertPlain(manifest, 'Manifest')
  const expected = createNowSchedule(manifest)
  if (!same(manifest, expected)) throw new Error('Manifest differs from canonical sealed schedule')
  return expected
}

const validatedIssue = (row, now) => {
  const issue = row?.issue ?? row
  assertPlain(issue, 'Verified issue')
  if (
    issue.study !== ISSUE_STUDY ||
    issue.kind !== 'prospective-now-origin-holder-exit-forecast-issue' ||
    issue.holder !== HOLDER ||
    issue.qAssetsRaw !== Q_ASSETS_RAW ||
    issue.route !== ROUTE ||
    !HORIZONS_SECONDS.includes(issue.horizonSeconds) ||
    typeof issue.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(issue.sha256) ||
    issue.sha256 !== sha(issueBody(issue)) ||
    canonicalUtc(issue.issuedAtUtc, 'issue issuedAtUtc') > now
  )
    throw new Error('Issue row is not an as-of sealed fixed-scope NOW issue')
  return issue
}

// Caller must supply the COMPLETE externally verified issue set and bound attempt
// set. A local JSON seal cannot attest write time, DB commit, or RPC independence.
export function auditNowSchedule(manifest, { asOfUtc, verifiedIssueRows, boundAttemptRows = [] }) {
  const sealed = verifyNowSchedule(manifest)
  const now = canonicalUtc(asOfUtc, 'asOfUtc')
  if (now < canonicalUtc(sealed.plannedAtUtc, 'plannedAtUtc'))
    throw new Error('Audit precedes local plan time')
  if (!Array.isArray(verifiedIssueRows) || !Array.isArray(boundAttemptRows))
    throw new Error('Complete verified issue and bound attempt arrays required')
  const issues = new Map()
  for (const row of verifiedIssueRows) {
    const issue = validatedIssue(row, now)
    if (issues.has(issue.sha256)) throw new Error('Duplicate verified issue')
    issues.set(issue.sha256, issue)
  }
  const slots = new Map(sealed.slots.map((slot) => [slot.slotId, slot]))
  const byCell = new Map()
  const linkedIssues = new Map()
  for (const row of boundAttemptRows) {
    assertPlain(row, 'Bound attempt')
    const slot = slots.get(row.slotId)
    if (
      row.manifestSha256 !== sealed.sha256 ||
      !slot ||
      !HORIZONS_SECONDS.includes(row.horizonSeconds) ||
      !['issued', 'abstained', 'failed', 'unknown'].includes(row.status)
    )
      throw new Error('Attempt lacks exact schedule, slot, arm, or status binding')
    const recorded = canonicalUtc(row.recordedAtUtc, 'attempt recordedAtUtc')
    if (
      recorded < canonicalUtc(slot.scheduledAtUtc, 'slot scheduledAtUtc') ||
      recorded >= canonicalUtc(slot.closesAtUtc, 'slot closesAtUtc') ||
      recorded > now
    )
      throw new Error('Attempt is outside its half-open slot or audit time')
    if (row.status === 'issued') {
      if (typeof row.issueSha256 !== 'string' || !issues.has(row.issueSha256))
        throw new Error('Issued attempt lacks linked verified issue')
      const issue = issues.get(row.issueSha256)
      if (
        issue.horizonSeconds !== row.horizonSeconds ||
        canonicalUtc(issue.issuedAtUtc, 'issue issuedAtUtc') <
          canonicalUtc(slot.scheduledAtUtc, 'slot scheduledAtUtc') ||
        canonicalUtc(issue.issuedAtUtc, 'issue issuedAtUtc') > recorded
      )
        throw new Error('Issued attempt does not match a distinct issue in its slot')
      const cellKey = `${slot.slotId}/${row.horizonSeconds}`
      if (linkedIssues.has(issue.sha256) && linkedIssues.get(issue.sha256) !== cellKey)
        throw new Error('Issued attempt reuses an issue across schedule cells')
      const binding = issue.scheduleBinding
      if (
        binding != null &&
        (binding.manifestSha256 !== sealed.sha256 || binding.slotId !== slot.slotId)
      )
        throw new Error('Linked issue has conflicting schedule binding')
      linkedIssues.set(issue.sha256, cellKey)
    } else if (row.issueSha256 != null) {
      throw new Error('Non-issued attempt cannot link an issue')
    }
    const key = `${slot.slotId}/${row.horizonSeconds}`
    byCell.set(key, [...(byCell.get(key) ?? []), row])
  }
  const dueSlots = sealed.slots
    .filter((slot) => canonicalUtc(slot.closesAtUtc, 'slot closesAtUtc') <= now)
    .map((slot) => ({
      ...slot,
      arms: HORIZONS_SECONDS.map((horizonSeconds) => {
        const attempts = byCell.get(`${slot.slotId}/${horizonSeconds}`) ?? []
        let status = 'missing'
        if (attempts.length > 1) status = 'unknown'
        else if (attempts.length === 1) {
          const row = attempts[0]
          status =
            row.status === 'issued' && issues.get(row.issueSha256)?.scheduleBinding == null
              ? 'unbound'
              : row.status
        }
        return { horizonSeconds, status, attemptCount: attempts.length }
      }),
    }))
  const dueSlotIds = new Set(dueSlots.map((slot) => slot.slotId))
  const issuedCellKeys = new Set(
    dueSlots.flatMap((slot) =>
      slot.arms
        .filter((arm) => arm.status === 'issued')
        .map((arm) => `${slot.slotId}/${arm.horizonSeconds}`),
    ),
  )
  let boundIssueCount = 0
  let unboundIssueCount = 0
  let unconfirmedBoundIssueCount = 0
  let outsidePlanIssueCount = 0
  let notYetDueSlotIssueCount = 0
  for (const issue of issues.values()) {
    const issued = canonicalUtc(issue.issuedAtUtc, 'issue issuedAtUtc')
    const slot = sealed.slots.find(
      (candidate) =>
        issued >= canonicalUtc(candidate.scheduledAtUtc, 'slot scheduledAtUtc') &&
        issued < canonicalUtc(candidate.closesAtUtc, 'slot closesAtUtc'),
    )
    if (!slot) outsidePlanIssueCount += 1
    else if (!dueSlotIds.has(slot.slotId)) notYetDueSlotIssueCount += 1
    else if (issue.scheduleBinding == null) unboundIssueCount += 1
    else if (issuedCellKeys.has(linkedIssues.get(issue.sha256))) boundIssueCount += 1
    else unconfirmedBoundIssueCount += 1
  }
  return {
    schema: 'scrvusd-now-origin-expected-slot-audit-v1',
    manifestSha256: sealed.sha256,
    asOfUtc,
    evidenceClass: 'local_research_only',
    prospectiveScheduleConfirmed: false,
    calibratedForecastEligible: false,
    dueSlotCount: dueSlots.length,
    dueArmCount: dueSlots.length * HORIZONS_SECONDS.length,
    boundIssuedArmCount: dueSlots
      .flatMap((slot) => slot.arms)
      .filter((arm) => arm.status === 'issued').length,
    boundIssueCount,
    unboundIssueCount,
    unconfirmedBoundIssueCount,
    outsidePlanIssueCount,
    notYetDueSlotIssueCount,
    dueSlots,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, ...args] = process.argv.slice(2)
    if (mode === '--draft' && args.length === 3) {
      console.log(
        JSON.stringify(
          createNowSchedule({ plannedAtUtc: args[0], startAtUtc: args[1], endAtUtc: args[2] }),
        ),
      )
    } else if (mode === '--verify' && args.length === 1) {
      console.log(JSON.stringify(verifyNowSchedule(JSON.parse(readFileSync(args[0], 'utf8')))))
    } else {
      throw new Error(
        'Usage: --draft <plannedAtUtc> <startAtUtc> <endAtUtc> | --verify <manifest.json>',
      )
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
