// Offline preregistration and coverage audit for the USDe sampled-cash pilot.
// This module does not schedule, publish, query a database, or fetch chain data.
import { createHash } from 'node:crypto'
import { SCORE_AMOUNTS_USD, SCORE_HORIZONS_SECONDS, STUDY } from './aave-usde-prospective-cash.mjs'

const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const iso = (value, name) => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
    throw new Error(`${name} must be an explicit UTC ISO timestamp`)
  const millis = Date.parse(value)
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value)
    throw new Error(`Invalid ${name}`)
  return millis
}
const cellKey = (q, h) => `${q}/${h}`
const grid = () =>
  SCORE_AMOUNTS_USD.flatMap((amountUsd) =>
    SCORE_HORIZONS_SECONDS.map((horizonSeconds) => ({ amountUsd, horizonSeconds })),
  )

export function createCashSchedule({ plannedAt, startAt, endAt, cadenceSeconds }) {
  const planned = iso(plannedAt, 'plannedAt')
  const start = iso(startAt, 'startAt')
  const end = iso(endAt, 'endAt')
  if (cadenceSeconds !== 3600) throw new Error('USDe pilot requires explicit hourly cadenceSeconds')
  const step = cadenceSeconds * 1000
  if (start <= planned || end <= start || (end - start) % step !== 0)
    throw new Error('Schedule must be future, nonempty, and contain complete cadence slots')
  const slotCount = (end - start) / step
  if (!Number.isSafeInteger(slotCount) || slotCount > 8760)
    throw new Error('Schedule exceeds 8760 slots')
  const arms = grid()
  const slots = Array.from({ length: slotCount }, (_, index) => {
    const scheduledAt = new Date(start + index * step).toISOString()
    return {
      slotId: sha({ study: STUDY, scheduledAt, cadenceSeconds }),
      scheduledAt,
      closesAt: new Date(start + (index + 1) * step).toISOString(),
      arms,
    }
  })
  const body = {
    schema: 'aave-usde-cash-schedule-v1',
    study: STUDY,
    plannedAt,
    startAt,
    endAt,
    cadenceSeconds,
    amountsUsd: [...SCORE_AMOUNTS_USD],
    horizonsSeconds: [...SCORE_HORIZONS_SECONDS],
    slots,
  }
  return { ...body, sha256: sha(body) }
}

export function verifyCashSchedule(manifest) {
  const expected = createCashSchedule({
    plannedAt: manifest?.plannedAt,
    startAt: manifest?.startAt,
    endAt: manifest?.endAt,
    cadenceSeconds: manifest?.cadenceSeconds,
  })
  if (JSON.stringify(manifest) !== JSON.stringify(expected))
    throw new Error('Schedule manifest differs from canonical sealed manifest')
  return expected
}

const order = {
  not_scheduled: 0,
  scheduled_without_result: 1,
  abstained: 2,
  failed: 3,
  duplicate: 4,
  issued: 5,
}
const receiptStatus = new Set(['scheduled', 'abstained', 'failed', 'duplicate', 'issued'])
const field = (row, camel, snake) => {
  if (camel in row && snake in row && String(row[camel]) !== String(row[snake]))
    throw new Error(`Conflicting receipt ${camel} fields`)
  return row[camel] ?? row[snake]
}
const dbReceipt = (row) => {
  if (!row || typeof row !== 'object') throw new Error('Invalid issue-attempt receipt')
  const recordedAt = field(row, 'recordedAt', 'recorded_at')
  return {
    manifestSha256: field(row, 'manifestSha256', 'manifest_sha256'),
    slotId: field(row, 'slotId', 'slot_id'),
    runId: field(row, 'runId', 'run_id'),
    amountUsd: Number(field(row, 'amountUsd', 'amount_usd')),
    horizonSeconds: Number(field(row, 'horizonSeconds', 'horizon_seconds')),
    phase: row.phase,
    status: row.status,
    reason: row.reason,
    issueId: field(row, 'issueId', 'issue_id'),
    publisherXid: field(row, 'publisherXid', 'publisher_xid'),
    recordedAt: recordedAt instanceof Date ? recordedAt.toISOString() : recordedAt,
  }
}
const dbIssue = (row) => {
  if (!row || typeof row !== 'object') throw new Error('Invalid linked issue receipt')
  const timestamp = (camel, snake) => {
    const value = field(row, camel, snake)
    return value instanceof Date ? value.toISOString() : value
  }
  return {
    id: row.id,
    amountUsd: Number(field(row, 'amountUsd', 'amount_usd')),
    horizonSeconds: Number(field(row, 'horizonSeconds', 'horizon_seconds')),
    issuedAt: timestamp('issuedAt', 'issued_at'),
    persistedAt: timestamp('persistedAt', 'persisted_at'),
    targetAt: timestamp('targetAt', 'target_at'),
  }
}
const dbRunConfirmation = (row) => {
  if (!row || typeof row !== 'object') throw new Error('Invalid issue-run confirmation')
  const confirmedAt = field(row, 'confirmedAt', 'confirmed_at')
  return {
    runId: field(row, 'runId', 'run_id'),
    manifestSha256: field(row, 'manifestSha256', 'manifest_sha256'),
    slotId: field(row, 'slotId', 'slot_id'),
    confirmedAt: confirmedAt instanceof Date ? confirmedAt.toISOString() : confirmedAt,
    confirmerXid: field(row, 'confirmerXid', 'confirmer_xid'),
    resultXid: field(row, 'resultXid', 'result_xid'),
  }
}

// Receipts must be immutable persisted rows read in full by the caller. A
// random runId alone cannot show a skipped scheduler invocation. The producer
// must persist slotId and manifestSha256 on both start and result rows.
export function auditCashSchedule(
  manifest,
  receipts,
  { asOf, issueReceipts = [], manifestConfirmation = null, issueRunConfirmations = [] },
) {
  const sealed = verifyCashSchedule(manifest)
  const now = iso(asOf, 'asOf')
  if (now < iso(sealed.plannedAt, 'plannedAt')) throw new Error('Audit precedes preregistration')
  if (!Array.isArray(receipts)) throw new Error('Complete issue-attempt receipt set required')
  if (!Array.isArray(issueReceipts)) throw new Error('Complete linked issue receipt set required')
  if (!Array.isArray(issueRunConfirmations))
    throw new Error('Complete issue-run confirmation query required')
  const normalized = receipts.map(dbReceipt)
  const issues = new Map()
  for (const raw of issueReceipts) {
    const issue = dbIssue(raw)
    if (typeof issue.id !== 'string' || issues.has(issue.id))
      throw new Error('Duplicate or invalid linked issue ID')
    issues.set(issue.id, issue)
  }
  const claimedNewIssues = new Set()
  let manifestConfirmed = false
  if (manifestConfirmation !== null) {
    const sha = field(manifestConfirmation, 'manifestSha256', 'manifest_sha256')
    const confirmedRaw = field(manifestConfirmation, 'confirmedAt', 'confirmed_at')
    const confirmedAt = confirmedRaw instanceof Date ? confirmedRaw.toISOString() : confirmedRaw
    const publisherXid = field(manifestConfirmation, 'publisherXid', 'publisher_xid')
    const confirmerXid = field(manifestConfirmation, 'confirmerXid', 'confirmer_xid')
    if (
      sha !== sealed.sha256 ||
      iso(confirmedAt, 'manifest confirmedAt') > now ||
      iso(confirmedAt, 'manifest confirmedAt') < iso(sealed.plannedAt, 'plannedAt') ||
      iso(sealed.startAt, 'startAt') - iso(confirmedAt, 'manifest confirmedAt') < 2 * 3600 * 1000 ||
      publisherXid == null ||
      confirmerXid == null ||
      String(publisherXid) === String(confirmerXid)
    )
      throw new Error('Manifest lacks valid post-commit confirmation')
    manifestConfirmed = true
  }
  const slots = new Map(sealed.slots.map((slot) => [slot.slotId, slot]))
  const bySlot = new Map(sealed.slots.map((slot) => [slot.slotId, []]))
  const seen = new Set()
  const startTimes = new Map()
  const allowedCells = new Set(grid().map((arm) => cellKey(arm.amountUsd, arm.horizonSeconds)))
  for (const row of normalized) {
    if (!row || row.manifestSha256 !== sealed.sha256 || !slots.has(row.slotId))
      throw new Error('Receipt lacks a valid persisted schedule binding')
    if (typeof row.runId !== 'string' || !/^[0-9a-f-]{36}$/i.test(row.runId))
      throw new Error('Receipt lacks a valid runId')
    const key = cellKey(row.amountUsd, row.horizonSeconds)
    if (
      !allowedCells.has(key) ||
      !['start', 'result'].includes(row.phase) ||
      !receiptStatus.has(row.status)
    )
      throw new Error('Receipt has an unknown arm, phase, or status')
    if ((row.phase === 'start') !== (row.status === 'scheduled'))
      throw new Error('Receipt phase/status mismatch')
    if (row.phase === 'start' && (row.issueId != null || row.reason != null))
      throw new Error('Scheduled arm must have no issue or reason')
    if (
      row.phase === 'result' &&
      ((['issued', 'duplicate'].includes(row.status) &&
        (typeof row.issueId !== 'string' ||
          !/^[0-9a-f-]{36}$/i.test(row.issueId) ||
          row.reason != null)) ||
        (['abstained', 'failed'].includes(row.status) &&
          (row.issueId != null || typeof row.reason !== 'string' || !row.reason)))
    )
      throw new Error('Terminal receipt lacks valid issue or reason evidence')
    const slot = slots.get(row.slotId)
    const recorded = iso(row.recordedAt, 'recordedAt')
    if (
      recorded < iso(slot.scheduledAt, 'scheduledAt') ||
      recorded >= iso(slot.closesAt, 'closesAt')
    )
      throw new Error('Receipt timestamp is outside its scheduled slot')
    if (recorded > now) throw new Error('Receipt follows audit time')
    if (row.phase === 'result' && ['issued', 'duplicate'].includes(row.status)) {
      const issue = issues.get(row.issueId)
      if (!issue) throw new Error('Issued or duplicate arm lacks linked persisted issue')
      if (issue.amountUsd !== row.amountUsd || issue.horizonSeconds !== row.horizonSeconds)
        throw new Error('Linked issue does not match arm')
      const issued = iso(issue.issuedAt, 'linked issuedAt')
      const persisted = iso(issue.persistedAt, 'linked persistedAt')
      const target = iso(issue.targetAt, 'linked targetAt')
      if (issued > persisted || persisted >= target || persisted > recorded)
        throw new Error('Linked issue timing is inconsistent with attempt result')
      if (row.status === 'issued') {
        if (
          issued < iso(slot.scheduledAt, 'scheduledAt') ||
          persisted >= iso(slot.closesAt, 'closesAt') ||
          claimedNewIssues.has(issue.id)
        )
          throw new Error('Issued arm is not a distinct new issue in this slot')
        claimedNewIssues.add(issue.id)
      }
    }
    const identity = `${row.slotId}/${row.runId}/${key}/${row.phase}`
    if (seen.has(identity)) throw new Error('Duplicate immutable arm-phase receipt')
    seen.add(identity)
    if (row.phase === 'start') startTimes.set(identity, recorded)
    bySlot.get(row.slotId).push(row)
  }
  for (const row of normalized) {
    if (row.phase === 'result') {
      const startAt = startTimes.get(
        `${row.slotId}/${row.runId}/${cellKey(row.amountUsd, row.horizonSeconds)}/start`,
      )
      if (startAt === undefined) throw new Error('Result receipt has no matching scheduled start')
      if (iso(row.recordedAt, 'result recordedAt') < startAt)
        throw new Error('Result receipt precedes scheduled start')
      if (
        row.status === 'issued' &&
        (iso(issues.get(row.issueId).issuedAt, 'linked issuedAt') < startAt ||
          iso(issues.get(row.issueId).persistedAt, 'linked persistedAt') < startAt)
      )
        throw new Error('Issued claim predates its matching scheduled start')
    }
  }
  const byRun = new Map()
  for (const row of normalized) {
    const prior = byRun.get(row.runId)
    if (prior && prior.slotId !== row.slotId)
      throw new Error('Issue run is bound to multiple schedule slots')
    const group = prior ?? { slotId: row.slotId, starts: new Set(), results: new Set() }
    group[row.phase === 'start' ? 'starts' : 'results'].add(
      cellKey(row.amountUsd, row.horizonSeconds),
    )
    byRun.set(row.runId, group)
  }
  for (const group of byRun.values()) {
    if (
      group.starts.size !== allowedCells.size ||
      (group.results.size && group.results.size !== allowedCells.size)
    )
      throw new Error('Issue run has incomplete fixed-grid arms or results')
  }
  const runConfirmations = new Map()
  for (const raw of issueRunConfirmations) {
    const confirmation = dbRunConfirmation(raw)
    const group = byRun.get(confirmation.runId)
    if (
      !group ||
      runConfirmations.has(confirmation.runId) ||
      confirmation.manifestSha256 !== sealed.sha256 ||
      confirmation.slotId !== group.slotId ||
      confirmation.confirmerXid == null ||
      confirmation.resultXid == null ||
      String(confirmation.confirmerXid) === String(confirmation.resultXid)
    )
      throw new Error('Issue-run confirmation binding is invalid')
    const confirmedAt = iso(confirmation.confirmedAt, 'run confirmedAt')
    if (confirmedAt > now || group.results.size !== allowedCells.size)
      throw new Error('Issue-run confirmation is future or lacks complete results')
    const results = normalized.filter(
      (row) => row.runId === confirmation.runId && row.phase === 'result',
    )
    if (
      results.some(
        (row) =>
          row.publisherXid == null || String(row.publisherXid) !== String(confirmation.resultXid),
      )
    )
      throw new Error('Issue-run confirmation result transaction differs from persisted results')
    const latestResultAt = Math.max(
      ...results.map((row) => iso(row.recordedAt, 'result recordedAt')),
    )
    if (confirmedAt < latestResultAt || confirmedAt - latestResultAt > 60_000)
      throw new Error('Issue-run confirmation is before or more than 60 seconds after results')
    if (
      results.some(
        (row) =>
          row.status === 'issued' &&
          iso(issues.get(row.issueId).targetAt, 'linked targetAt') <= confirmedAt,
      )
    )
      throw new Error('Issue-run confirmation missed an issued target')
    runConfirmations.set(confirmation.runId, confirmedAt)
  }

  const auditedSlots = sealed.slots.map((slot) => {
    const rows = bySlot.get(slot.slotId)
    const due = now >= iso(slot.closesAt, 'closesAt')
    if (!due)
      return {
        slotId: slot.slotId,
        scheduledAt: slot.scheduledAt,
        status: 'open',
        observedReceiptCount: rows.length,
        arms: [],
      }
    const runs = new Set(rows.map((row) => row.runId))
    const arms = grid().map(({ amountUsd, horizonSeconds }) => {
      const cellRows = rows.filter(
        (row) => row.amountUsd === amountUsd && row.horizonSeconds === horizonSeconds,
      )
      const starts = cellRows.filter((row) => row.phase === 'start')
      const results = cellRows.filter((row) => row.phase === 'result')
      const status = results.reduce(
        (best, row) => (order[row.status] > order[best] ? row.status : best),
        starts.length ? 'scheduled_without_result' : 'not_scheduled',
      )
      const issued = results.filter((row) => row.status === 'issued')
      const prospectiveIssued = issued.filter(
        (row) => manifestConfirmed && runConfirmations.has(row.runId),
      )
      return {
        amountUsd,
        horizonSeconds,
        status,
        issuedIssueIds: issued.map((row) => row.issueId),
        duplicateIssueIds: results
          .filter((row) => row.status === 'duplicate')
          .map((row) => row.issueId),
        prospectiveIssuedIssueIds: prospectiveIssued.map((row) => row.issueId),
        unconfirmedIssuedIssueIds: issued
          .filter((row) => !prospectiveIssued.includes(row))
          .map((row) => row.issueId),
        prospectiveEligible: prospectiveIssued.length > 0,
        invocationCount: starts.length,
        retryCount: Math.max(0, starts.length - 1),
        resultCount: results.length,
      }
    })
    return {
      slotId: slot.slotId,
      scheduledAt: slot.scheduledAt,
      status: runs.size ? 'invoked' : 'missed_invocation',
      invocationCount: runs.size,
      arms,
    }
  })
  const complete = auditedSlots.filter((slot) => slot.status !== 'open')
  const counts = Object.fromEntries(
    Object.keys(order).map((status) => [
      status,
      complete.flatMap((slot) => slot.arms).filter((arm) => arm.status === status).length,
    ]),
  )
  return {
    manifestSha256: sealed.sha256,
    asOf,
    dueSlotCount: complete.length,
    missedInvocationCount: complete.filter((slot) => slot.status === 'missed_invocation').length,
    manifestConfirmed,
    confirmedRunCount: runConfirmations.size,
    prospectiveIssuedArmCount: complete
      .flatMap((slot) => slot.arms)
      .filter((arm) => arm.prospectiveEligible).length,
    unconfirmedIssuedArmCount: complete
      .flatMap((slot) => slot.arms)
      .filter((arm) => arm.issuedIssueIds.length > 0 && !arm.prospectiveEligible).length,
    armCounts: counts,
    slots: auditedSlots,
  }
}
