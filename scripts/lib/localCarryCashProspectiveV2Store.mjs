// Independent SHA-chained H24 cash study. It never mutates the August model ledger.
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import {
  CASH_V2_POLICY,
  HOUR_MS,
  POLICY_SHA256,
  canonicalUtc,
  cashRaw,
  projectCashV2,
  sha256,
} from '../research/carry-cash-prospective-v2-policy.mjs'

export const LOCAL_CASH_PROSPECTIVE_V2_ROOT = resolve(
  'data/research/venue-signals/local-carry-cash-prospective-v2',
)
export const LOCAL_CASH_PROSPECTIVE_V2_STUDY = CASH_V2_POLICY.study
const SHA = /^[0-9a-f]{64}$/
const HASH = /^0x[0-9a-f]{64}$/
const FILE = /^\d{12}\.json$/
const MAX_RECORDS = 100_000
const MAX_RECORD_BYTES = 512 * 1024
const DEFAULT_FREE = 1024 * 1024 * 1024
const SUBJECTS = new Map(CASH_V2_POLICY.subjects.map((subject) => [subject.id, subject]))
const filename = (n) => `${String(n).padStart(12, '0')}.json`
const iso = (ms) => new Date(ms).toISOString()
const horizonMs = CASH_V2_POLICY.horizonHours * HOUR_MS
const windowMs = CASH_V2_POLICY.targetWindowHours * HOUR_MS
const graceMs = CASH_V2_POLICY.receiptGraceHours * HOUR_MS
const sourceAgeMs = CASH_V2_POLICY.maximumSourceAgeHours * HOUR_MS
const scheduleMs = CASH_V2_POLICY.scheduleHours * HOUR_MS
const threshold = CASH_V2_POLICY.minimumPercent / 100
export class CashProspectiveV2LedgerError extends Error {
  constructor(code) {
    const stableCode = `cash_v2_${code}`
    super(stableCode)
    this.name = 'CashProspectiveV2LedgerError'
    this.code = stableCode
  }
}

const fail = (code) => {
  throw new CashProspectiveV2LedgerError(code)
}

function withLock(root, work) {
  mkdirSync(dirname(root), { recursive: true })
  const lock = `${root}.lock`
  try {
    mkdirSync(lock)
  } catch (error) {
    if (error?.code === 'EEXIST') fail('lock_manual_inspection_required')
    throw error
  }
  try {
    return work()
  } finally {
    rmdirSync(lock)
  }
}

const headPath = (root) => `${root}.head.json`
const headBody = (sequence, sha) => ({
  study: LOCAL_CASH_PROSPECTIVE_V2_STUDY,
  sequence,
  sha256: sha,
})
function writeHead(root, sequence, sha, initial = false) {
  const path = headPath(root)
  const temp = `${path}.${randomUUID()}.tmp`
  const bytes = `${JSON.stringify(headBody(sequence, sha))}\n`
  const fd = openSync(temp, 'wx', 0o600)
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    if (initial) linkSync(temp, path)
    else renameSync(temp, path)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
}
function readHead(root) {
  const path = headPath(root)
  if (!existsSync(path)) return null
  const bytes = readFileSync(path, 'utf8')
  const head = JSON.parse(bytes)
  if (
    bytes !== `${JSON.stringify(head)}\n` ||
    head.study !== LOCAL_CASH_PROSPECTIVE_V2_STUDY ||
    !Number.isSafeInteger(head.sequence) ||
    head.sequence < 0 ||
    (head.sequence === 0 ? head.sha256 !== null : !SHA.test(head.sha256 ?? ''))
  )
    fail('head_invalid')
  return head
}

const planPath = (root) => `${root}.plan.json`
function readPlan(root) {
  const path = planPath(root)
  if (!existsSync(path)) return null
  const bytes = readFileSync(path, 'utf8')
  const plan = JSON.parse(bytes)
  const { sha256: digest, ...body } = plan
  if (
    bytes !== `${JSON.stringify(plan)}\n` ||
    digest !== sha256(JSON.stringify(body)) ||
    body.study !== LOCAL_CASH_PROSPECTIVE_V2_STUDY ||
    body.policySha256 !== POLICY_SHA256 ||
    !Array.isArray(body.artifacts) ||
    body.artifacts.length !== SUBJECTS.size ||
    !Array.isArray(body.cutoffs) ||
    body.cutoffs.length !== SUBJECTS.size
  )
    fail('registration_plan_invalid')
  canonicalUtc(body.activationAtUtc)
  if (
    new Set(body.artifacts.map((row) => row.subjectId)).size !== SUBJECTS.size ||
    new Set(body.cutoffs.map((row) => row.subjectId)).size !== SUBJECTS.size
  )
    fail('registration_plan_subjects')
  return plan
}

function freezePlan(root, body) {
  const path = planPath(root)
  const plan = { ...body, sha256: sha256(JSON.stringify(body)) }
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    const fd = openSync(temp, 'wx', 0o600)
    try {
      writeFileSync(fd, `${JSON.stringify(plan)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    linkSync(temp, path)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  return plan
}

function exactSubjectRow(receipt, subject) {
  const rows = receipt.rows?.filter(
    (row) => row.routeKey === subject.routeKey && row.destination === subject.destination,
  )
  if (rows?.length !== 1) fail('subject_row_count')
  const row = rows[0]
  if (row.state === 'identity_mismatch') fail('subject_cash_identity')
  if (row.state === 'no_code' || row.state === 'unassessed') {
    if (
      row.asset !== null ||
      row.assetDecimals !== null ||
      row.shareDecimals !== null ||
      row.cashRaw !== null ||
      typeof row.reason !== 'string' ||
      !row.reason
    )
      fail('subject_unavailable_shape')
    return null
  }
  if (
    row.state !== 'observed' ||
    row.asset !== subject.asset ||
    row.assetDecimals !== subject.decimals ||
    row.shareDecimals !== subject.decimals ||
    row.reason !== null
  )
    fail('subject_cash_identity')
  cashRaw(row.cashRaw)
  return row
}

function verifiedSource(inputs, subject) {
  const source = inputs?.[subject.cohort]
  if (
    !source ||
    !SHA.test(source.manifest?.sha256 ?? '') ||
    (source.verified?.manifestSha256 != null &&
      source.manifest.sha256 !== source.verified.manifestSha256) ||
    source.verified?.records?.some((row) => row.manifestSha256 !== source.manifest.sha256) ||
    source.verified.count !== source.verified.records?.length ||
    (source.verified.count &&
      source.verified.last?.sha256 !== source.verified.records.at(-1)?.sha256)
  )
    fail('source_not_verified')
  return source
}

function receiptByRef(inputs, subject, ref) {
  const source = verifiedSource(inputs, subject)
  if (
    ref.manifestSha256 !== source.manifest.sha256 ||
    !Number.isSafeInteger(ref.sequence) ||
    ref.sequence < 1
  )
    fail('receipt_reference')
  const receipt = source.verified.records[ref.sequence - 1]
  if (!receipt || receipt.sequence !== ref.sequence || receipt.sha256 !== ref.receiptSha256)
    fail('receipt_reference')
  return receipt
}

function sourceView(receipt, subject, manifestSha256) {
  const row = exactSubjectRow(receipt, subject)
  if (
    receipt.collectionMode !== 'current' ||
    receipt.manifestSha256 !== manifestSha256 ||
    !HASH.test(receipt.blockHash) ||
    !/^\d+$/.test(String(receipt.block)) ||
    canonicalUtc(receipt.blockAt) > canonicalUtc(receipt.firstLocalReceiptAt)
  )
    fail('current_source_invalid')
  if (!row) return null
  return {
    manifestSha256,
    sequence: receipt.sequence,
    receiptSha256: receipt.sha256,
    block: String(receipt.block),
    blockHash: receipt.blockHash,
    sourceAtUtc: receipt.blockAt,
    firstLocalReceiptAtUtc: receipt.firstLocalReceiptAt,
    cashRaw: row.cashRaw,
  }
}

function recordBody(record) {
  const { sha256: _sha, ...body } = record
  return body
}

function eligibleView(inputs, subject, state, now) {
  const cell = state.enrollment.payload.subjects.find((row) => row.subjectId === subject.id)
  const prior = state.issues.filter((row) => row.payload.subjectId === subject.id).at(-1)
  if (prior && now <= canonicalUtc(prior.payload.targetHighUtc)) return { status: 'not_due' }
  const candidates = currentCandidates(inputs, subject, cell.cutoff).filter(
    (view) =>
      canonicalUtc(view.firstLocalReceiptAtUtc) > canonicalUtc(state.enrollment.recordedAtUtc) &&
      canonicalUtc(view.sourceAtUtc) > canonicalUtc(state.enrollment.recordedAtUtc) &&
      canonicalUtc(view.firstLocalReceiptAtUtc) <= now &&
      canonicalUtc(view.sourceAtUtc) <= now &&
      now - canonicalUtc(view.sourceAtUtc) <= sourceAgeMs &&
      now < canonicalUtc(view.sourceAtUtc) + horizonMs - windowMs &&
      (!prior || canonicalUtc(view.sourceAtUtc) > canonicalUtc(prior.payload.targetHighUtc)),
  )
  const view = candidates.at(-1)
  return view ? { status: 'issued', view } : { status: 'source_unavailable' }
}

function issuePayload(state, subject, view, now) {
  const artifact = state.artifacts.get(subject.id)
  const target = canonicalUtc(view.sourceAtUtc) + horizonMs
  return {
    subjectId: subject.id,
    enrollmentSha256: state.enrollment.sha256,
    artifactSha256: artifact.sha256,
    source: view,
    issuedAtUtc: iso(now),
    targetAtUtc: iso(target),
    targetLowUtc: iso(target - windowMs),
    targetHighUtc: iso(target + windowMs),
    graceUntilUtc: iso(target + windowMs + graceMs),
    projection: projectCashV2(view.cashRaw, artifact.payload.parameters),
  }
}

function replayOpportunity(record, opportunity, state, inputs) {
  const subject = SUBJECTS.get(opportunity.subjectId)
  if (!subject) fail('opportunity_subject')
  const expected = eligibleView(inputs, subject, state, canonicalUtc(record.recordedAtUtc))
  const expectedIssue =
    expected.status === 'issued'
      ? issuePayload(state, subject, expected.view, canonicalUtc(record.recordedAtUtc))
      : null
  if (
    opportunity.status !== expected.status ||
    JSON.stringify(opportunity.issue) !== JSON.stringify(expectedIssue)
  )
    fail('opportunity_invalid')
  if (opportunity.status === 'issued') {
    const payload = opportunity.issue
    state.issues.push({
      kind: 'issue',
      payload,
      recordedAtUtc: record.recordedAtUtc,
      sha256: sha256(
        JSON.stringify({ tickSha256: record.sha256, subjectId: subject.id, issue: payload }),
      ),
    })
  }
}

function selectedTarget(inputs, subject, state, issue) {
  const cell = state.enrollment.payload.subjects.find((row) => row.subjectId === subject.id)
  const targetAt = canonicalUtc(issue.payload.targetAtUtc)
  return (
    currentCandidates(inputs, subject, cell.cutoff)
      .filter(
        (view) =>
          view.sequence > issue.payload.source.sequence &&
          BigInt(view.block) > BigInt(issue.payload.source.block) &&
          canonicalUtc(view.sourceAtUtc) >= targetAt - windowMs &&
          canonicalUtc(view.sourceAtUtc) <= targetAt + windowMs &&
          canonicalUtc(view.firstLocalReceiptAtUtc) > canonicalUtc(issue.payload.issuedAtUtc) &&
          canonicalUtc(view.firstLocalReceiptAtUtc) <= canonicalUtc(issue.payload.graceUntilUtc),
      )
      .sort(
        (a, b) =>
          Math.abs(canonicalUtc(a.sourceAtUtc) - targetAt) -
            Math.abs(canonicalUtc(b.sourceAtUtc) - targetAt) ||
          canonicalUtc(a.sourceAtUtc) - canonicalUtc(b.sourceAtUtc) ||
          a.sequence - b.sequence,
      )[0] ?? null
  )
}

function checkRecord(record, prior, state, inputs) {
  if (
    record.study !== LOCAL_CASH_PROSPECTIVE_V2_STUDY ||
    record.sequence !== (prior?.sequence ?? 0) + 1 ||
    record.previousSha256 !== (prior?.sha256 ?? null) ||
    !SHA.test(record.sha256 ?? '') ||
    sha256(JSON.stringify(recordBody(record))) !== record.sha256
  )
    fail('chain_invalid')
  const recorded = canonicalUtc(record.recordedAtUtc)
  if (prior && recorded < canonicalUtc(prior.recordedAtUtc)) fail('clock_order')
  const p = record.payload
  if (!p || typeof p !== 'object' || Array.isArray(p)) fail('payload_invalid')
  if (record.kind === 'artifact') {
    const subject = SUBJECTS.get(p.subjectId)
    if (
      !subject ||
      state.artifacts.has(subject.id) ||
      p.policySha256 !== POLICY_SHA256 ||
      JSON.stringify(p.subject) !== JSON.stringify(subject) ||
      p.source?.subjectId !== subject.id ||
      !SHA.test(p.source.physicalSha256 ?? '') ||
      !SHA.test(p.source.contentSha256 ?? '') ||
      p.source.count < 1 ||
      canonicalUtc(p.source.throughUtc) > recorded ||
      p.parameters?.pairCount < CASH_V2_POLICY.minimumDevelopmentPairs ||
      !/^-?\d+$/.test(p.parameters.medianDeltaRaw ?? '') ||
      !/^-?\d+$/.test(p.parameters.p10DeltaRaw ?? '') ||
      !/^-?\d+$/.test(p.parameters.p90DeltaRaw ?? '')
    )
      fail('artifact_invalid')
    if (
      record.recordedAtUtc !== state.plan?.activationAtUtc ||
      JSON.stringify(p) !==
        JSON.stringify(state.plan?.artifacts.find((row) => row.subjectId === subject.id))
    )
      fail('artifact_plan_binding')
    projectCashV2('1', p.parameters)
    state.artifacts.set(subject.id, record)
  } else if (record.kind === 'enrollment') {
    if (
      state.enrollment ||
      p.policySha256 !== POLICY_SHA256 ||
      !Array.isArray(p.subjects) ||
      p.subjects.length !== SUBJECTS.size
    )
      fail('enrollment_invalid')
    for (const cell of p.subjects) {
      const subject = SUBJECTS.get(cell.subjectId)
      const artifact = state.artifacts.get(cell.subjectId)
      const source = subject && verifiedSource(inputs, subject)
      const cutoff = source?.verified.records[cell.cutoff?.sequence - 1]
      if (
        !subject ||
        !artifact ||
        cell.artifactSha256 !== artifact.sha256 ||
        cell.cutoff?.manifestSha256 !== source.manifest.sha256 ||
        !cutoff ||
        cutoff.sha256 !== cell.cutoff.receiptSha256 ||
        cell.cutoff.sequence !==
          source.verified.records.findIndex((row) => row.sha256 === cutoff.sha256) + 1 ||
        canonicalUtc(artifact.recordedAtUtc) > recorded
      )
        fail('enrollment_binding')
    }
    if (new Set(p.subjects.map((row) => row.subjectId)).size !== SUBJECTS.size)
      fail('enrollment_duplicate_subject')
    for (const cell of p.subjects) {
      const planned = state.plan?.cutoffs.find((row) => row.subjectId === cell.subjectId)
      if (
        JSON.stringify(cell.cutoff) !== JSON.stringify(planned?.cutoff) ||
        record.recordedAtUtc !== state.plan?.activationAtUtc
      )
        fail('enrollment_plan_binding')
    }
    state.enrollment = record
  } else if (record.kind === 'tick') {
    const slot = canonicalUtc(p.slotAtUtc)
    if (
      !state.enrollment ||
      !['on_time', 'missed'].includes(p.status) ||
      slot % scheduleMs !== 0 ||
      slot <= canonicalUtc(state.enrollment.recordedAtUtc) ||
      p.enrollmentSha256 !== state.enrollment.sha256 ||
      (state.ticks.length &&
        slot !== canonicalUtc(state.ticks.at(-1).payload.slotAtUtc) + scheduleMs) ||
      (!state.ticks.length &&
        slot !==
          Math.ceil((canonicalUtc(state.enrollment.recordedAtUtc) + 1) / scheduleMs) *
            scheduleMs) ||
      (p.status === 'on_time' &&
        (recorded < slot || recorded > slot + CASH_V2_POLICY.onTimeTickMinutes * 60_000)) ||
      (p.status === 'missed' && recorded <= slot + CASH_V2_POLICY.onTimeTickMinutes * 60_000) ||
      !Array.isArray(p.opportunities) ||
      p.opportunities.length !== (p.status === 'on_time' ? SUBJECTS.size : 0)
    )
      fail('tick_invalid')
    if (p.status === 'on_time') {
      for (const [index, subject] of CASH_V2_POLICY.subjects.entries()) {
        if (p.opportunities[index]?.subjectId !== subject.id) fail('opportunity_order')
        replayOpportunity(record, p.opportunities[index], state, inputs)
      }
    }
    state.ticks.push(record)
  } else if (record.kind === 'score') {
    const issue = state.issues.find((row) => row.sha256 === p.issueSha256)
    const subject = SUBJECTS.get(p.subjectId)
    if (
      !issue ||
      !subject ||
      issue.payload.subjectId !== subject.id ||
      state.scores.some((row) => row.payload.issueSha256 === p.issueSha256) ||
      p.scoredAtUtc !== record.recordedAtUtc ||
      !['observed', 'censored'].includes(p.status) ||
      recorded <= canonicalUtc(issue.payload.graceUntilUtc)
    )
      fail('score_binding')
    if (p.status === 'observed') {
      const target = receiptByRef(inputs, subject, p.target)
      const view = sourceView(target, subject, issue.payload.source.manifestSha256)
      const selected = selectedTarget(inputs, subject, state, issue)
      const issueMs = canonicalUtc(issue.payload.issuedAtUtc)
      if (
        JSON.stringify(p.target) !== JSON.stringify(view) ||
        JSON.stringify(p.target) !== JSON.stringify(selected) ||
        p.reason !== null ||
        view.sequence <= issue.payload.source.sequence ||
        BigInt(view.block) <= BigInt(issue.payload.source.block) ||
        canonicalUtc(view.sourceAtUtc) < canonicalUtc(issue.payload.targetLowUtc) ||
        canonicalUtc(view.sourceAtUtc) > canonicalUtc(issue.payload.targetHighUtc) ||
        canonicalUtc(view.firstLocalReceiptAtUtc) <= issueMs ||
        canonicalUtc(view.firstLocalReceiptAtUtc) > canonicalUtc(issue.payload.graceUntilUtc) ||
        canonicalUtc(view.firstLocalReceiptAtUtc) > recorded ||
        JSON.stringify(p.outcome) !==
          JSON.stringify({
            targetCashRaw: view.cashRaw,
            covered:
              cashRaw(view.cashRaw) >= cashRaw(issue.payload.projection.lowRaw) &&
              cashRaw(view.cashRaw) <= cashRaw(issue.payload.projection.highRaw),
            modelAbsoluteErrorRaw: (cashRaw(view.cashRaw) >
            cashRaw(issue.payload.projection.pointRaw)
              ? cashRaw(view.cashRaw) - cashRaw(issue.payload.projection.pointRaw)
              : cashRaw(issue.payload.projection.pointRaw) - cashRaw(view.cashRaw)
            ).toString(),
            persistenceAbsoluteErrorRaw: (cashRaw(view.cashRaw) >
            cashRaw(issue.payload.projection.persistenceRaw)
              ? cashRaw(view.cashRaw) - cashRaw(issue.payload.projection.persistenceRaw)
              : cashRaw(issue.payload.projection.persistenceRaw) - cashRaw(view.cashRaw)
            ).toString(),
          })
      )
        fail('score_observed_invalid')
    } else if (
      p.target !== null ||
      p.outcome !== null ||
      p.reason !== 'target_window_unobserved' ||
      selectedTarget(inputs, subject, state, issue) !== null
    )
      fail('score_censor_invalid')
    state.scores.push(record)
  } else fail('kind_invalid')
}

export function verifyCashProspectiveV2Ledger(
  inputs,
  root = LOCAL_CASH_PROSPECTIVE_V2_ROOT,
  options = {},
) {
  const state = {
    records: [],
    artifacts: new Map(),
    enrollment: null,
    ticks: [],
    issues: [],
    scores: [],
    plan: readPlan(root),
  }
  const parent = dirname(root)
  if (
    existsSync(parent) &&
    readdirSync(parent).some(
      (name) => name.startsWith(`${basename(root)}.pending.`) && name.endsWith('.tmp'),
    )
  )
    fail('orphan_temp_manual_inspection_required')
  const head = readHead(root)
  if (!existsSync(root)) {
    if (head?.sequence > 0) fail('head_ahead_manual_inspection_required')
    return state
  }
  const files = readdirSync(root).sort()
  if (files.length > MAX_RECORDS || files.some((name) => !FILE.test(name))) fail('unexpected_file')
  let prior = null
  for (const [index, name] of files.entries()) {
    if (name !== filename(index + 1)) fail('sequence_gap')
    const bytes = readFileSync(join(root, name), 'utf8')
    if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES) fail('record_too_large')
    const record = JSON.parse(bytes)
    if (bytes !== `${JSON.stringify(record)}\n`) fail('record_bytes')
    checkRecord(record, prior, state, inputs)
    state.records.push(record)
    prior = record
  }
  if (state.records.length && !head) fail('head_missing_manual_inspection_required')
  if (state.records.length && !state.plan)
    fail('registration_plan_missing_manual_inspection_required')
  if (head) {
    if (
      head.sequence > state.records.length ||
      (head.sequence > 0 && state.records[head.sequence - 1]?.sha256 !== head.sha256)
    )
      fail('head_ahead_manual_inspection_required')
    if (head.sequence < state.records.length) {
      if (options.recoverHead === false) fail('head_lag_recovery_required')
      if (options.lockHeld) writeHead(root, state.records.length, prior.sha256)
      else
        withLock(root, () => {
          const reread = readHead(root)
          if (JSON.stringify(reread) !== JSON.stringify(head)) fail('head_changed_during_recovery')
          writeHead(root, state.records.length, prior.sha256)
        })
    }
  }
  return state
}

function reserve(root, bytes, minFreeBytes) {
  let path = root
  while (!existsSync(path)) path = dirname(path)
  const stat = statfsSync(path)
  if (Number(stat.bavail) * Number(stat.bsize) - bytes < minFreeBytes) fail('disk_reserve')
}

function append(kind, payloadOrFactory, inputs, root, now, minFreeBytes) {
  return withLock(root, () => {
    const state = verifyCashProspectiveV2Ledger(inputs, root, { lockHeld: true })
    if (state.records.length >= MAX_RECORDS) fail('record_limit')
    if (!readHead(root)) writeHead(root, 0, null, true)
    const recordedAtUtc = iso(now)
    const payload =
      typeof payloadOrFactory === 'function' ? payloadOrFactory(state) : payloadOrFactory
    const body = {
      study: LOCAL_CASH_PROSPECTIVE_V2_STUDY,
      sequence: state.records.length + 1,
      previousSha256: state.records.at(-1)?.sha256 ?? null,
      kind,
      recordedAtUtc,
      payload,
    }
    const record = { ...body, sha256: sha256(JSON.stringify(body)) }
    checkRecord(record, state.records.at(-1), state, inputs)
    const bytes = `${JSON.stringify(record)}\n`
    if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES) fail('record_too_large')
    reserve(root, Buffer.byteLength(bytes), minFreeBytes)
    mkdirSync(root, { recursive: true })
    const temp = `${root}.pending.${randomUUID()}.tmp`
    try {
      const fd = openSync(temp, 'wx', 0o600)
      try {
        writeFileSync(fd, bytes)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      linkSync(temp, join(root, filename(record.sequence)))
    } finally {
      if (existsSync(temp)) unlinkSync(temp)
    }
    writeHead(root, record.sequence, record.sha256)
    return record
  })
}

function cutoffFor(inputs, subject) {
  const source = verifiedSource(inputs, subject)
  const last = source.verified.last
  if (!last || source.verified.count !== last.sequence) fail('cutoff_unavailable')
  return {
    manifestSha256: source.manifest.sha256,
    sequence: last.sequence,
    receiptSha256: last.sha256,
  }
}

export function registerCashProspectiveV2(inputs, development, options = {}) {
  const root = options.root ?? LOCAL_CASH_PROSPECTIVE_V2_ROOT
  const now = options.now ?? Date.now()
  const minFreeBytes = options.minFreeBytes ?? DEFAULT_FREE
  if (
    !Array.isArray(development) ||
    development.length !== SUBJECTS.size ||
    new Set(development.map((row) => row.subjectId)).size !== SUBJECTS.size
  )
    fail('development_subjects')
  const artifacts = CASH_V2_POLICY.subjects.map((subject) => {
    const source = development.find((row) => row.subjectId === subject.id)
    if (!source) fail('development_missing')
    return {
      subjectId: subject.id,
      subject,
      policySha256: POLICY_SHA256,
      source: Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'parameters')),
      parameters: source.parameters,
    }
  })
  // This external immutable plan is durable before any artifact can be appended.
  // A retry uses its original clock and both source cutoffs, even if feeds advanced.
  const plan = withLock(root, () => {
    const state = verifyCashProspectiveV2Ledger(inputs, root, { lockHeld: true })
    if (state.plan) {
      if (JSON.stringify(state.plan.artifacts) !== JSON.stringify(artifacts))
        fail('development_changed')
      return state.plan
    }
    if (state.records.length) fail('registration_plan_missing_manual_inspection_required')
    return freezePlan(root, {
      study: LOCAL_CASH_PROSPECTIVE_V2_STUDY,
      policySha256: POLICY_SHA256,
      activationAtUtc: iso(now),
      artifacts,
      cutoffs: CASH_V2_POLICY.subjects.map((subject) => ({
        subjectId: subject.id,
        cutoff: cutoffFor(inputs, subject),
      })),
    })
  })
  const activationMs = canonicalUtc(plan.activationAtUtc)
  let state = verifyCashProspectiveV2Ledger(inputs, root)
  for (const payload of plan.artifacts) {
    if (!state.artifacts.has(payload.subjectId))
      append('artifact', payload, inputs, root, activationMs, minFreeBytes)
    state = verifyCashProspectiveV2Ledger(inputs, root)
  }
  if (state.enrollment) return { status: 'already_registered', enrollment: state.enrollment }
  const enrollment = append(
    'enrollment',
    {
      policySha256: POLICY_SHA256,
      subjects: CASH_V2_POLICY.subjects.map((subject) => ({
        subjectId: subject.id,
        artifactSha256: state.artifacts.get(subject.id).sha256,
        cutoff: plan.cutoffs.find((row) => row.subjectId === subject.id).cutoff,
      })),
    },
    inputs,
    root,
    activationMs,
    minFreeBytes,
  )
  return { status: 'registered', enrollment }
}

export function tickCashProspectiveV2(inputs, options = {}) {
  const root = options.root ?? LOCAL_CASH_PROSPECTIVE_V2_ROOT
  const now = options.now ?? Date.now()
  const minFreeBytes = options.minFreeBytes ?? DEFAULT_FREE
  const state = verifyCashProspectiveV2Ledger(inputs, root)
  if (!state.enrollment) fail('not_enrolled')
  let slot = state.ticks.length
    ? canonicalUtc(state.ticks.at(-1).payload.slotAtUtc) + scheduleMs
    : Math.ceil((canonicalUtc(state.enrollment.recordedAtUtc) + 1) / scheduleMs) * scheduleMs
  const current = Math.floor(now / scheduleMs) * scheduleMs
  const added = []
  while (slot <= current) {
    if (added.length >= 1000) fail('tick_catchup_limit')
    const onTime = slot === current && now <= slot + CASH_V2_POLICY.onTimeTickMinutes * 60_000
    added.push(
      append(
        'tick',
        (fresh) => ({
          slotAtUtc: iso(slot),
          status: onTime ? 'on_time' : 'missed',
          enrollmentSha256: fresh.enrollment.sha256,
          opportunities: onTime
            ? CASH_V2_POLICY.subjects.map((subject) => {
                const candidate = eligibleView(inputs, subject, fresh, now)
                return {
                  subjectId: subject.id,
                  status: candidate.status,
                  issue:
                    candidate.status === 'issued'
                      ? issuePayload(fresh, subject, candidate.view, now)
                      : null,
                }
              })
            : [],
        }),
        inputs,
        root,
        now,
        minFreeBytes,
      ),
    )
    slot += scheduleMs
  }
  return {
    status: added.length ? 'recorded' : 'already_recorded',
    ticks: added,
    issues: verifyCashProspectiveV2Ledger(inputs, root).issues.filter((row) =>
      added.some(
        (tick) =>
          row.sha256 ===
          sha256(
            JSON.stringify({
              tickSha256: tick.sha256,
              subjectId: row.payload.subjectId,
              issue: row.payload,
            }),
          ),
      ),
    ),
  }
}

function currentCandidates(inputs, subject, cutoff) {
  const source = verifiedSource(inputs, subject)
  return source.verified.records
    .filter((row) => row.sequence > cutoff.sequence && row.collectionMode === 'current')
    .map((receipt) => sourceView(receipt, subject, source.manifest.sha256))
    .filter(Boolean)
    .sort(
      (a, b) =>
        canonicalUtc(a.sourceAtUtc) - canonicalUtc(b.sourceAtUtc) || a.sequence - b.sequence,
    )
}

/** Compatibility readback: --tick commits all opportunity decisions and forecasts atomically. */
export function issueCashProspectiveV2(inputs, options = {}) {
  const root = options.root ?? LOCAL_CASH_PROSPECTIVE_V2_ROOT
  const state = verifyCashProspectiveV2Ledger(inputs, root)
  const current = Math.floor((options.now ?? Date.now()) / scheduleMs) * scheduleMs
  const tick = state.ticks.at(-1)
  if (!tick || canonicalUtc(tick.payload.slotAtUtc) !== current)
    return { status: 'no_current_tick', issues: [] }
  return {
    status: 'already_decided',
    issues: state.issues.filter((row) =>
      tick.payload.opportunities.some(
        (opportunity) =>
          opportunity.status === 'issued' &&
          opportunity.subjectId === row.payload.subjectId &&
          row.recordedAtUtc === tick.recordedAtUtc,
      ),
    ),
  }
}

function scoreOutcome(issue, target) {
  const value = cashRaw(target.cashRaw)
  const projection = issue.payload.projection
  const absolute = (a, b) => (a > b ? a - b : b - a)
  return {
    targetCashRaw: target.cashRaw,
    covered: value >= cashRaw(projection.lowRaw) && value <= cashRaw(projection.highRaw),
    modelAbsoluteErrorRaw: absolute(value, cashRaw(projection.pointRaw)).toString(),
    persistenceAbsoluteErrorRaw: absolute(value, cashRaw(projection.persistenceRaw)).toString(),
  }
}

export function scoreCashProspectiveV2(inputs, options = {}) {
  const root = options.root ?? LOCAL_CASH_PROSPECTIVE_V2_ROOT
  const now = options.now ?? Date.now()
  const minFreeBytes = options.minFreeBytes ?? DEFAULT_FREE
  const state = verifyCashProspectiveV2Ledger(inputs, root)
  if (!state.enrollment && state.records.length === 0) return { status: 'not_enrolled', scores: [] }
  if (!state.enrollment) fail('not_enrolled')
  const added = []
  for (const issue of state.issues) {
    if (state.scores.some((row) => row.payload.issueSha256 === issue.sha256)) continue
    const subject = SUBJECTS.get(issue.payload.subjectId)
    if (now <= canonicalUtc(issue.payload.graceUntilUtc)) continue
    const target = selectedTarget(inputs, subject, state, issue)
    if (target) {
      added.push(
        append(
          'score',
          {
            issueSha256: issue.sha256,
            subjectId: subject.id,
            status: 'observed',
            scoredAtUtc: iso(now),
            target,
            outcome: scoreOutcome(issue, target),
            reason: null,
          },
          inputs,
          root,
          now,
          minFreeBytes,
        ),
      )
    } else if (now > canonicalUtc(issue.payload.graceUntilUtc)) {
      added.push(
        append(
          'score',
          {
            issueSha256: issue.sha256,
            subjectId: subject.id,
            status: 'censored',
            scoredAtUtc: iso(now),
            target: null,
            outcome: null,
            reason: 'target_window_unobserved',
          },
          inputs,
          root,
          now,
          minFreeBytes,
        ),
      )
    }
  }
  return { status: added.length ? 'scored' : 'nothing_due', scores: added }
}

export function evaluateCashProspectiveV2State(state, now = Date.now()) {
  return {
    study: LOCAL_CASH_PROSPECTIVE_V2_STUDY,
    claimClass: 'aggregate_cash_proxy_only',
    holderExecutableExit: false,
    records: state.records.length,
    subjects: CASH_V2_POLICY.subjects.map((subject) => {
      const issues = state.issues.filter((row) => row.payload.subjectId === subject.id)
      const scores = state.scores.filter((row) => row.payload.subjectId === subject.id)
      const observed = scores.filter((row) => row.payload.status === 'observed')
      const matured = issues.filter((row) => canonicalUtc(row.payload.graceUntilUtc) < now)
      const maturedIds = new Set(matured.map((row) => row.sha256))
      const observedMatured = observed.filter((row) => maturedIds.has(row.payload.issueSha256))
      const covered = observed.filter((row) => row.payload.outcome.covered).length
      const errors = observed.reduce(
        (sum, row) => sum + BigInt(row.payload.outcome.modelAbsoluteErrorRaw),
        0n,
      )
      const persistence = observed.reduce(
        (sum, row) => sum + BigInt(row.payload.outcome.persistenceAbsoluteErrorRaw),
        0n,
      )
      const onTime = state.ticks.filter((row) => row.payload.status === 'on_time').length
      const expected = state.ticks.length
      const due = state.ticks
        .flatMap((row) => row.payload.opportunities)
        .filter((row) => row.subjectId === subject.id && row.status !== 'not_due')
      const available = due.filter((row) => row.status === 'issued').length
      const scheduleCurrent =
        expected > 0 &&
        now - canonicalUtc(state.ticks.at(-1).payload.slotAtUtc) <=
          CASH_V2_POLICY.scheduleCurrentWithinHours * HOUR_MS
      const outcomeCoverage = matured.length === 0 ? 0 : observedMatured.length / matured.length
      const intervalCoverage = observed.length === 0 ? 0 : covered / observed.length
      const scheduleCoverage = expected === 0 ? 0 : onTime / expected
      const sourceAvailability = due.length === 0 ? 0 : available / due.length
      return {
        subjectId: subject.id,
        routeKey: subject.routeKey,
        destination: subject.destination,
        asset: subject.asset,
        horizonHours: CASH_V2_POLICY.horizonHours,
        independentIssued: issues.length,
        independentObserved: observed.length,
        censored: scores.length - observed.length,
        expectedScheduleHours: expected,
        onTimeScheduleHours: onTime,
        dueOpportunities: due.length,
        sourceAvailableOpportunities: available,
        sourceUnavailableOpportunities: due.length - available,
        sourceAvailabilityPercent: Math.floor(sourceAvailability * 100),
        outcomeAvailabilityPercent: Math.floor(outcomeCoverage * 100),
        intervalCoveragePercent: Math.floor(intervalCoverage * 100),
        scheduleCoveragePercent: Math.floor(scheduleCoverage * 100),
        pointBeatsPersistence: observed.length > 0 && errors < persistence,
        scheduleCurrent,
        prospectiveValidated:
          observed.length >= CASH_V2_POLICY.minimumIndependentObserved &&
          outcomeCoverage >= threshold &&
          intervalCoverage >= threshold &&
          scheduleCoverage >= threshold &&
          sourceAvailability >= CASH_V2_POLICY.sourceAvailabilityMinimumPercent / 100 &&
          scheduleCurrent &&
          errors < persistence,
        holderExecutableExit: false,
      }
    }),
  }
}

export function evaluateCashProspectiveV2(inputs, options = {}) {
  const state = verifyCashProspectiveV2Ledger(
    inputs,
    options.root ?? LOCAL_CASH_PROSPECTIVE_V2_ROOT,
    { recoverHead: options.recoverHead },
  )
  return evaluateCashProspectiveV2State(state, options.now ?? Date.now())
}
