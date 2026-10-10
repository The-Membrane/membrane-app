import { createHash } from 'node:crypto'
import { verifyFirstBreachIssue } from './aave-usde-first-breach.mjs'
import {
  bindFirstBreachIssue,
  verifyFirstBreachSchedule,
} from './aave-usde-first-breach-schedule.mjs'
import { normalizeSample } from './aave-usde-prospective-cash.mjs'

const HOUR_MS = 3_600_000
const CREATE_LAG_MS = 120_000
const statuses = new Set([
  'success',
  'skipped_fresh',
  'skipped_unchanged',
  'read_failure',
  'insert_failure',
  'missed',
])
const hash = (value) => createHash('sha256').update(value).digest('hex')
const digest = (value) => /^[a-f0-9]{64}$/.test(value)
const fail = (message) => {
  throw new Error(message)
}
const time = (value, name) => {
  const ms = Date.parse(value)
  if (!Number.isSafeInteger(ms) || new Date(ms).toISOString() !== value)
    fail(`Invalid ${name} UTC timestamp`)
  return ms
}
const slotId = (venue, at) => `${venue}:${new Date(at).toISOString()}`
const rowHash = (row) => hash(JSON.stringify(row))

// The caller must persist these exact bytes before collection starts and retain
// their independently witnessed physical SHA. This builder cannot attest that.
export function buildHourlyCoverageManifest({
  venue,
  startAt,
  endExclusiveAt,
  declaredAt,
  issueSchedulePhysicalSha256,
}) {
  if (typeof venue !== 'string' || !/^[a-z0-9-]+$/.test(venue)) fail('Invalid venue')
  if (!digest(issueSchedulePhysicalSha256)) fail('Invalid issue schedule physical SHA')
  const start = time(startAt, 'start')
  const end = time(endExclusiveAt, 'end')
  const declared = time(declaredAt, 'declaration')
  if (start % HOUR_MS || end % HOUR_MS || end <= start || end - start > 31 * 86_400_000)
    fail('Manifest requires bounded, aligned hourly slots')
  if (declared >= start) fail('Manifest must be declared before first slot')
  const slots = Array.from({ length: (end - start) / HOUR_MS }, (_, i) => ({
    id: slotId(venue, start + i * HOUR_MS),
    at: new Date(start + i * HOUR_MS).toISOString(),
  }))
  return JSON.stringify({
    study: 'aave-usde-first-breach-hourly-coverage-v1',
    venue,
    startAt,
    endExclusiveAt,
    declaredAt,
    issueSchedulePhysicalSha256,
    slots,
  })
}

// Receipts are recorder-attempt evidence, not an authenticated independent
// attestation. The audit never promotes a self-sealed feed to prospective use.
export function auditHourlyCoverage({
  manifestBytes,
  expectedManifestPhysicalSha256,
  issueScheduleBytes,
  expectedIssueSchedulePhysicalSha256,
  issue,
  receipts,
  snapshotRows,
  asOf,
}) {
  verifyFirstBreachIssue(issue)
  const { manifest: issueSchedule } = verifyFirstBreachSchedule(
    issueScheduleBytes,
    expectedIssueSchedulePhysicalSha256,
  )
  const issued = time(issue.issuedAt, 'issue')
  const issueSlots = issueSchedule.slots.filter(
    (slot) =>
      time(slot.scheduledAt, 'issue slot start') <= issued &&
      issued < time(slot.closesAt, 'issue slot end'),
  )
  if (issueSlots.length !== 1) fail('Issue must belong to exactly one scheduled v2 slot')
  const issueScheduleBinding = bindFirstBreachIssue({
    scheduleBytes: issueScheduleBytes,
    expectedPhysicalSha256: expectedIssueSchedulePhysicalSha256,
    slotId: issueSlots[0].slotId,
    issue,
  })
  if (
    typeof manifestBytes !== 'string' ||
    !digest(expectedManifestPhysicalSha256) ||
    hash(manifestBytes) !== expectedManifestPhysicalSha256
  )
    fail('Manifest physical SHA mismatch')
  const manifest = JSON.parse(manifestBytes)
  if (
    !digest(expectedIssueSchedulePhysicalSha256) ||
    manifest.issueSchedulePhysicalSha256 !== expectedIssueSchedulePhysicalSha256 ||
    expectedIssueSchedulePhysicalSha256 === expectedManifestPhysicalSha256
  )
    fail('Distinct issue schedule physical SHA required')
  const canonical = buildHourlyCoverageManifest(manifest)
  if (canonical !== manifestBytes) fail('Manifest slot IDs or bytes mismatch')
  if (manifest.venue !== 'aave-v3-usde') fail('Manifest venue mismatch')
  const closes = time(issue.targetAt, 'target') + 8 * HOUR_MS
  const cutoff = closes + CREATE_LAG_MS
  const asOfMs = time(asOf, 'as-of')
  if (time(manifest.declaredAt, 'declaration') > issued)
    fail('Manifest was not declared before issue')
  if (time(manifest.startAt, 'start') > issued || time(manifest.endExclusiveAt, 'end') <= closes)
    fail('Manifest does not cover anchor-to-outcome observation window')
  if (!Array.isArray(receipts) || !Array.isArray(snapshotRows)) fail('Receipts and rows required')

  const seenReceipts = new Map()
  const duplicateSlotIds = new Set()
  const unexpectedSlotIds = new Set()
  const expected = new Set(manifest.slots.map((slot) => slot.id))
  for (const receipt of receipts) {
    if (!receipt || typeof receipt.slotId !== 'string') fail('Invalid receipt')
    if (!expected.has(receipt.slotId)) {
      unexpectedSlotIds.add(receipt.slotId)
      continue
    }
    if (seenReceipts.has(receipt.slotId)) duplicateSlotIds.add(receipt.slotId)
    else seenReceipts.set(receipt.slotId, receipt)
  }
  const rowsById = new Map()
  const duplicateRowIds = new Set()
  for (const row of snapshotRows) {
    if (!row || typeof row.id !== 'string') fail('Invalid snapshot row')
    if (rowsById.has(row.id)) duplicateRowIds.add(row.id)
    else rowsById.set(row.id, row)
  }
  const attached = new Set()
  const counts = {
    expected: 0,
    pending: 0,
    missing: 0,
    success: 0,
    skippedFresh: 0,
    skippedUnchanged: 0,
    readFailure: 0,
    insertFailure: 0,
    missed: 0,
    duplicate: 0,
    mismatch: 0,
    late: 0,
    censored: 0,
  }
  const slots = []
  let previousSample = issue.anchor
  const seenBlockHashes = new Set([issue.anchor.blockHash])
  const seenSampleIds = new Set([issue.anchor.id])
  for (const slot of manifest.slots) {
    const at = time(slot.at, 'slot')
    if (at + HOUR_MS <= issued || at >= closes) continue
    counts.expected++
    const receipt = seenReceipts.get(slot.id)
    let state
    if (asOfMs < Math.min(at + HOUR_MS, closes) + CREATE_LAG_MS) state = 'pending'
    else if (!receipt) state = 'missing'
    else if (duplicateSlotIds.has(slot.id)) state = 'duplicate'
    else if (!statuses.has(receipt.status)) state = 'mismatch'
    else {
      let attempted
      try {
        attempted = time(receipt.attemptedAt, 'attempt')
      } catch {
        attempted = NaN
      }
      if (!Number.isFinite(attempted)) state = 'mismatch'
      else if (
        attempted < at ||
        attempted < issued ||
        attempted >= at + HOUR_MS ||
        attempted > closes
      )
        state = 'late'
      else if (receipt.status !== 'success') state = receipt.status
      else {
        const row = rowsById.get(receipt.snapshotId)
        const observed = row && Date.parse(row.observed_at)
        const created = row && Date.parse(row.created_at)
        let normalized
        try {
          normalized = row && normalizeSample(row)
        } catch {
          normalized = null
        }
        if (
          !row ||
          duplicateRowIds.has(receipt.snapshotId) ||
          !digest(receipt.snapshotRowSha256) ||
          rowHash(row) !== receipt.snapshotRowSha256 ||
          !normalized ||
          !normalized.recorderAtomicV1 ||
          (normalized &&
            (BigInt(normalized.block) <= BigInt(previousSample.block) ||
              normalized.blockTime <= previousSample.blockTime ||
              normalized.firstLocalObservedAt <= previousSample.firstLocalObservedAt ||
              seenSampleIds.has(normalized.id) ||
              seenBlockHashes.has(normalized.blockHash))) ||
          !Number.isFinite(observed) ||
          observed < at ||
          observed <= issued ||
          observed >= at + HOUR_MS ||
          observed > closes ||
          observed > attempted ||
          !Number.isFinite(created) ||
          created < observed ||
          created > attempted ||
          created > at + HOUR_MS + CREATE_LAG_MS ||
          created > cutoff
        )
          state = 'mismatch'
        else {
          attached.add(row.id)
          previousSample = normalized
          seenSampleIds.add(normalized.id)
          seenBlockHashes.add(normalized.blockHash)
          state = 'success'
        }
      }
    }
    const key =
      {
        skipped_fresh: 'skippedFresh',
        skipped_unchanged: 'skippedUnchanged',
        read_failure: 'readFailure',
        insert_failure: 'insertFailure',
      }[state] ?? state
    counts[key]++
    if (state !== 'success' && state !== 'pending') counts.censored++
    slots.push({ slotId: slot.id, state })
  }
  const unattachedSnapshotIds = snapshotRows.map((row) => row.id).filter((id) => !attached.has(id))
  const hasAnomaly =
    counts.censored > 0 ||
    duplicateRowIds.size > 0 ||
    unexpectedSlotIds.size > 0 ||
    unattachedSnapshotIds.length > 0
  return {
    study: 'aave-usde-first-breach-hourly-coverage-v1',
    issueSha256: issue.sha256,
    manifestPhysicalSha256: expectedManifestPhysicalSha256,
    issueSchedulePhysicalSha256: expectedIssueSchedulePhysicalSha256,
    asOf,
    observationClosesAt: new Date(closes).toISOString(),
    sourceCutoffAt: new Date(cutoff).toISOString(),
    counts,
    slots,
    unexpectedSlotIds: [...unexpectedSlotIds].sort(),
    duplicateRowIds: [...duplicateRowIds].sort(),
    unattachedSnapshotIds,
    hourlyCoverageFromCallerReceipts: !hasAnomaly && asOfMs >= cutoff,
    scorerGapRuleEquivalentToHourlyCoverage: false,
    issueScheduleSlotId: issueScheduleBinding.slotId,
    issueScheduleMembership: 'caller_consistent_only',
    sourceCompleteness: 'caller_receipt_evidence_only',
    prospectiveEligible: false,
  }
}

export const physicalSha256 = hash
export const snapshotRowSha256 = rowHash
