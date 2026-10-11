import { createHash } from 'node:crypto'

import {
  appendLocalCarryExitV2Record,
  LOCAL_CARRY_EXIT_V2_ROOT,
  verifyLocalCarryExitV2Ledger,
} from './localCarryExitV2Store.mjs'

const sha = (value) => createHash('sha256').update(value).digest('hex')

function clockMs(now) {
  const value = typeof now === 'function' ? now() : now
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isSafeInteger(date.getTime())) throw Error('local_exit_v2_witness_clock_invalid')
  return date.getTime()
}

function unwitnessed(state) {
  return [...state.issues.values()].filter((issue) => !state.readbacks.has(issue.payload.issueId))
}

/**
 * Reopen the local ledger in a separate step and bind every still-current issue
 * SHA before H1. This proves only that the same Mac could replay its durable
 * files; it is not an independent clock, host, server, or external witness.
 */
export function recordLocalCarryExitV2Readbacks({
  root = LOCAL_CARRY_EXIT_V2_ROOT,
  now = () => new Date(),
  limit = 64,
  minFreeBytes,
  verify = verifyLocalCarryExitV2Ledger,
  append = appendLocalCarryExitV2Record,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 256)
    throw Error('local_exit_v2_witness_limit_invalid')

  const scan = verify({ root })
  const scanObservedMs = clockMs(now)
  const allUnwitnessed = unwitnessed(scan)
  const expired = allUnwitnessed.filter(
    (issue) => Date.parse(issue.payload.plan[0].targetAtUtc) <= scanObservedMs,
  )
  const eligible = allUnwitnessed.filter(
    (issue) => Date.parse(issue.payload.plan[0].targetAtUtc) > scanObservedMs,
  )
  const pending = eligible
    .sort(
      (left, right) =>
        left.payload.issuedAtUtc.localeCompare(right.payload.issuedAtUtc) ||
        left.payload.issueId.localeCompare(right.payload.issueId),
    )
    .slice(0, limit)
  const counts = {}
  const records = []
  const count = (status) => {
    counts[status] = (counts[status] ?? 0) + 1
  }
  if (expired.length) counts.h1_elapsed = expired.length

  for (const scannedIssue of pending) {
    const reopened = verify({ root })
    const observedMs = clockMs(now)
    const issue = reopened.issues.get(scannedIssue.payload.issueId)
    if (!issue || issue.sha256 !== scannedIssue.sha256) {
      count('issue_changed_on_reopen')
      continue
    }
    if (reopened.readbacks.has(issue.payload.issueId)) {
      count('already_witnessed')
      continue
    }
    const h1At = Date.parse(issue.payload.plan[0].targetAtUtc)
    if (observedMs >= h1At) {
      count('h1_elapsed')
      continue
    }
    if (observedMs < Date.parse(issue.recordedAtUtc)) {
      count('clock_before_issue')
      continue
    }
    const witnessId = `local:${sha(`${issue.payload.issueId}\u001f${issue.sha256}`)}`
    const options = { root, now: observedMs }
    if (minFreeBytes !== undefined) options.minFreeBytes = minFreeBytes
    const payload = {
      issueId: issue.payload.issueId,
      issueSha256: issue.sha256,
      witnessId,
      readbackAtUtc: new Date(observedMs).toISOString(),
      readbackProof: {
        schema: 'carry_local_exit_v2_readback_v1',
        provenance: 'same_machine_ledger_reopen',
        issueSequence: issue.sequence,
        issueSha256: issue.sha256,
        reopenedHeadSequence: reopened.head?.sequence ?? 0,
        reopenedHeadSha256: reopened.head?.lastSha256 ?? null,
        separateLedgerReadStep: true,
        independentProcess: false,
        independentClock: false,
        independentHost: false,
        independentServer: false,
        externalMonotonicCheckpoint: false,
        rollbackProof: false,
        prospectiveValidated: false,
        forecastValidated: false,
        holderExecutableExit: false,
      },
    }
    let record
    try {
      record = append('readback', payload, options)
    } catch (error) {
      const after = verify({ root })
      const existing = after.readbacks.get(issue.payload.issueId)
      if (existing?.payload.issueSha256 === issue.sha256) {
        count('already_witnessed')
        continue
      }
      throw error
    }
    records.push(record)
    count('witnessed_local_only')
  }

  return {
    scanned: allUnwitnessed.length,
    eligibleScanned: pending.length,
    expiredUnwitnessed: expired.length,
    truncated: eligible.length > pending.length,
    counts,
    records,
    provenance: 'same_machine_ledger_reopen',
    independentTimestamp: false,
    independentWitness: false,
    externalMonotonicCheckpoint: false,
    rollbackProof: false,
    prospectiveValidated: false,
    forecastValidated: false,
    holderExecutableExit: false,
  }
}
