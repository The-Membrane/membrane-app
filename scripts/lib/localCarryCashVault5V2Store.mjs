// Independent, immutable five-vault prospective aggregate-cash experiment.
import { createHash, randomUUID } from 'node:crypto'
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
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { LOCAL_CARRY_CASH_ROOT, verifyLocalCarryCash } from './localCarryCashStore.mjs'
import {
  VAULT5_SUBJECTS,
  VAULT5_V2_POLICY,
  VAULT5_V2_POLICY_SHA256,
  assertVault5Manifest,
  assessVault5Subjects,
  fitVault5Parameters,
  projectVault5Cash,
} from '../research/carry-cash-vault5-v2-policy.mjs'

export const VAULT5_V2_ROOT = resolve('data/research/venue-signals/local-carry-cash-vault5-v2')
const STUDY = VAULT5_V2_POLICY.study
const HOUR = 3_600_000
const HORIZON = VAULT5_V2_POLICY.horizonHours * HOUR
const TOLERANCE = VAULT5_V2_POLICY.targetToleranceHours * HOUR
const GRACE = VAULT5_V2_POLICY.targetReceiptGraceHours * HOUR
const SOURCE_MAX_AGE = VAULT5_V2_POLICY.sourceMaximumAgeHours * HOUR
const ISSUE_WINDOW = VAULT5_V2_POLICY.issueWindowHours * HOUR
const SHA = /^[0-9a-f]{64}$/
const FILE = /^\d{12}\.json$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const file = (sequence) => `${String(sequence).padStart(12, '0')}.json`
const headPath = (root) => `${root}.head.json`
const time = (value) => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error('vault5_invalid_time')
  return Date.parse(value)
}
const iso = (ms) => new Date(ms).toISOString()
export class Vault5V2LedgerError extends Error {
  constructor(code) {
    const stableCode = `vault5_${code}`
    super(stableCode)
    this.name = 'Vault5V2LedgerError'
    this.code = stableCode
  }
}

const fail = (code) => {
  throw new Vault5V2LedgerError(code)
}
const abs = (value) => (value < 0n ? -value : value)
const receiptBySha = (cash) => new Map(cash.records.map((row) => [row.sha256, row]))
const subjectRow = (receipt, subject) => {
  const rows = receipt.rows.filter(
    (row) => row.routeKey === subject.routeKey && row.destination === subject.destination,
  )
  if (
    rows.length !== 1 ||
    rows[0].asset !== subject.asset ||
    rows[0].state !== 'observed' ||
    !/^(0|[1-9][0-9]*)$/.test(rows[0].cashRaw ?? '')
  )
    fail('subject_row')
  return rows[0]
}

function completeVault5Receipt(receipt) {
  return VAULT5_SUBJECTS.every((subject) => {
    const rows = receipt.rows.filter(
      (row) => row.routeKey === subject.routeKey && row.destination === subject.destination,
    )
    return (
      rows.length === 1 &&
      rows[0].state === 'observed' &&
      rows[0].asset === subject.asset &&
      /^(0|[1-9][0-9]*)$/.test(rows[0].cashRaw ?? '')
    )
  })
}

function targetCandidates(cash, issue, at) {
  const center = time(issue.content.sourceAt) + HORIZON
  return cash.records
    .filter(
      (receipt) =>
        receipt.collectionMode === 'current' &&
        time(receipt.blockAt) >= time(issue.content.targetLow) &&
        time(receipt.blockAt) <= time(issue.content.targetHigh) &&
        time(receipt.firstLocalReceiptAt) > time(issue.recordedAt) &&
        time(receipt.firstLocalReceiptAt) <= time(issue.content.targetReceiptDeadline) &&
        time(receipt.firstLocalReceiptAt) <= time(at) &&
        completeVault5Receipt(receipt),
    )
    .sort(
      (a, b) =>
        Math.abs(time(a.blockAt) - center) - Math.abs(time(b.blockAt) - center) ||
        time(a.blockAt) - time(b.blockAt) ||
        a.sequence - b.sequence,
    )
}

export function latestCurrentSource(cash, enrollment, at) {
  return cash.records
    .filter(
      (receipt) =>
        receipt.collectionMode === 'current' &&
        time(receipt.firstLocalReceiptAt) <= time(at) &&
        time(receipt.firstLocalReceiptAt) > time(enrollment.recordedAt) &&
        time(receipt.blockAt) > time(enrollment.recordedAt) &&
        time(receipt.blockAt) <= time(at) &&
        time(at) - time(receipt.blockAt) <= SOURCE_MAX_AGE &&
        completeVault5Receipt(receipt),
    )
    .sort((a, b) => b.blockAt.localeCompare(a.blockAt) || b.sequence - a.sequence)[0]
}

function tickReason(now, slotAt, latest, priorIssue) {
  return time(now) >= time(slotAt) + ISSUE_WINDOW
    ? 'slot_expired'
    : !latest
      ? 'current_source_missing'
      : priorIssue && time(latest.blockAt) <= time(priorIssue.content.targetHigh)
        ? 'cluster_embargo'
        : null
}

function cashBoundary(cash, at) {
  const last = cash.records.filter((row) => time(row.firstLocalReceiptAt) <= time(at)).at(-1)
  return { cashBoundarySequence: last?.sequence ?? 0, cashBoundarySha256: last?.sha256 ?? null }
}

function cashAtBoundary(cash, content, at) {
  const sequence = content.cashBoundarySequence
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    sequence > cash.records.length ||
    (cash.records[sequence - 1]?.sha256 ?? null) !== content.cashBoundarySha256 ||
    (sequence && time(cash.records[sequence - 1].firstLocalReceiptAt) > time(at))
  )
    fail('cash_boundary')
  return { records: cash.records.slice(0, sequence) }
}

function developmentReceipts(cash, cutoffAt) {
  const rows = cash.records
    .filter(
      (row) =>
        row.collectionMode === 'retrospective' &&
        row.anchorAt.endsWith('T00:00:00.000Z') &&
        time(row.firstLocalReceiptAt) <= time(cutoffAt),
    )
    .sort((a, b) => a.anchorAt.localeCompare(b.anchorAt) || a.sequence - b.sequence)
    .slice(-VAULT5_V2_POLICY.developmentPairsPerSubject * 2)
  if (
    rows.length !== VAULT5_V2_POLICY.developmentPairsPerSubject * 2 ||
    rows.some(
      (row, index) => index > 0 && time(row.anchorAt) - time(rows[index - 1].anchorAt) !== HORIZON,
    )
  )
    fail('development_history')
  return rows
}

export function buildVault5Artifact(manifest, cash, cutoffAt) {
  assertVault5Manifest(manifest)
  time(cutoffAt)
  const receipts = developmentReceipts(cash, cutoffAt)
  const digest = sha(
    JSON.stringify(
      receipts.map((row) => ({
        sequence: row.sequence,
        sha256: row.sha256,
        anchorAt: row.anchorAt,
      })),
    ),
  )
  const subjects = VAULT5_SUBJECTS.map((subject) => {
    const changes = []
    for (let index = 0; index < receipts.length; index += 2) {
      const left = receipts[index]
      const right = receipts[index + 1]
      if (
        time(right.blockAt) - time(left.blockAt) < HORIZON - TOLERANCE ||
        time(right.blockAt) - time(left.blockAt) > HORIZON + TOLERANCE
      )
        fail('development_pair_time')
      changes.push(
        (
          BigInt(subjectRow(right, subject).cashRaw) - BigInt(subjectRow(left, subject).cashRaw)
        ).toString(),
      )
    }
    return {
      ...subject,
      developmentPairs: changes.length,
      parameters: fitVault5Parameters(changes),
    }
  })
  return {
    policySha256: VAULT5_V2_POLICY_SHA256,
    manifestSha256: manifest.sha256,
    development: {
      receiptShas: receipts.map((row) => row.sha256),
      receiptCount: VAULT5_V2_POLICY.developmentPairsPerSubject * 2,
      pairCountPerSubject: VAULT5_V2_POLICY.developmentPairsPerSubject,
      firstAnchorAt: receipts[0].anchorAt,
      lastAnchorAt: receipts.at(-1).anchorAt,
      digestSha256: digest,
      cutoffAt,
    },
    subjects,
    claim: 'aggregate_cash_proxy_only',
    holderExecutableExit: false,
    competingFlowMeasured: false,
    durationForecast: false,
  }
}

function canonical(path) {
  const bytes = readFileSync(path, 'utf8')
  if (bytes.length > 64 * 1024) fail('record_oversize')
  const record = JSON.parse(bytes)
  if (bytes !== `${JSON.stringify(record)}\n`) fail('physical_bytes')
  const { sha256, ...body } = record
  if (!SHA.test(sha256 ?? '') || sha(JSON.stringify(body)) !== sha256) fail('hash')
  if (record.kind !== 'cohort_bundle') return [record]
  if (
    record.bundleSchema !== 1 ||
    !Array.isArray(record.records) ||
    record.records.length !== 2 ||
    !(
      (record.records[0]?.kind === 'cohort_tick' && record.records[1]?.kind === 'cohort_issue') ||
      (record.records[0]?.kind === 'cohort_artifact' &&
        record.records[1]?.kind === 'cohort_enrollment')
    ) ||
    record.records[1]?.previousSha256 !== record.records[0]?.sha256
  )
    fail('bundle_shape')
  for (const item of record.records) {
    const { sha256: itemSha, ...itemBody } = item
    if (!SHA.test(itemSha ?? '') || sha(JSON.stringify(itemBody)) !== itemSha)
      fail('bundle_record_hash')
  }
  return record.records
}

function readHead(root, manifestSha256) {
  const path = headPath(root)
  if (!existsSync(path)) return null
  const bytes = readFileSync(path, 'utf8')
  if (bytes.length > 2048) fail('head_oversize')
  const head = JSON.parse(bytes)
  if (bytes !== `${JSON.stringify(head)}\n`) fail('head_physical_bytes')
  const { sha256, ...body } = head
  if (
    !SHA.test(sha256 ?? '') ||
    sha(JSON.stringify(body)) !== sha256 ||
    body.schema !== 'carry_vault5_v2_head_v1' ||
    body.study !== STUDY ||
    body.policySha256 !== VAULT5_V2_POLICY_SHA256 ||
    body.manifestSha256 !== manifestSha256 ||
    !Number.isSafeInteger(body.sequence) ||
    body.sequence < 0 ||
    (body.sequence === 0 ? body.lastSha256 !== null : !SHA.test(body.lastSha256 ?? ''))
  )
    fail('head_invalid')
  return head
}

function writeHead(root, manifestSha256, sequence, lastSha256) {
  const body = {
    schema: 'carry_vault5_v2_head_v1',
    study: STUDY,
    policySha256: VAULT5_V2_POLICY_SHA256,
    manifestSha256,
    sequence,
    lastSha256,
  }
  const head = { ...body, sha256: sha(JSON.stringify(body)) }
  const path = headPath(root)
  const tmp = `${path}.${randomUUID()}.tmp`
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(head)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, path)
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp)
  }
  const parent = openSync(dirname(path), 'r')
  try {
    fsyncSync(parent)
  } finally {
    closeSync(parent)
  }
  return head
}

function reconcileHead(root, manifestSha256, records, recoverHead) {
  const head = readHead(root, manifestSha256)
  if (!head) {
    if (records.length) fail('head_missing_for_nonempty_ledger')
    return null
  }
  if (head.sequence > records.length) fail('head_ahead_ledger_rollback')
  if ((records[head.sequence - 1]?.sha256 ?? null) !== head.lastSha256) fail('head_prefix_mismatch')
  // Only a fully replayed suffix reaches this point. A crash after the atomic
  // record link but before the head rename can therefore be committed safely.
  if (head.sequence < records.length) {
    if (!recoverHead) fail('head_lag_recovery_required')
    return writeHead(root, manifestSha256, records.length, records.at(-1).sha256)
  }
  return head
}

export function verifyVault5V2Ledger(
  manifest,
  { cashRoot = LOCAL_CARRY_CASH_ROOT, root = VAULT5_V2_ROOT, recoverHead = true } = {},
) {
  assertVault5Manifest(manifest)
  const cash = verifyLocalCarryCash(manifest, cashRoot)
  const bySha = receiptBySha(cash)
  const empty = {
    count: 0,
    last: null,
    records: [],
    artifact: null,
    enrollment: null,
    ticks: [],
    issues: [],
    scores: [],
    cash,
  }
  if (!existsSync(root)) {
    reconcileHead(root, manifest.sha256, [], recoverHead)
    return empty
  }
  const files = readdirSync(root)
    .filter((entry) => !/^\.[0-9a-f-]{36}\.tmp$/.test(entry))
    .sort()
  if (files.length > 100_000) fail('sequence')
  const physicalRecords = []
  for (const name of files) {
    if (!FILE.test(name) || name !== file(physicalRecords.length + 1)) fail('sequence')
    physicalRecords.push(...canonical(join(root, name)))
  }
  const state = { ...empty, records: [] }
  const issuesBySha = new Map()
  const scored = new Set()
  let priorIssue = null
  for (const [index, row] of physicalRecords.entries()) {
    if (
      row.study !== STUDY ||
      row.schemaVersion !== 2 ||
      row.sequence !== index + 1 ||
      row.previousSha256 !== (state.last?.sha256 ?? null) ||
      row.policySha256 !== VAULT5_V2_POLICY_SHA256 ||
      time(row.recordedAt) < (state.last ? time(state.last.recordedAt) : 0)
    )
      fail('record_identity')
    if (row.kind === 'cohort_artifact') {
      if (state.artifact || index !== 0 || row.content.development.cutoffAt !== row.recordedAt)
        fail('artifact_order')
      const expected = buildVault5Artifact(manifest, cash, row.recordedAt)
      if (JSON.stringify(row.content) !== JSON.stringify(expected)) fail('artifact_replay')
      state.artifact = row
    } else if (row.kind === 'cohort_enrollment') {
      if (
        !state.artifact ||
        state.enrollment ||
        row.content.artifactSha256 !== state.artifact.sha256 ||
        row.content.manifestSha256 !== manifest.sha256 ||
        row.content.cutoverAt !== row.recordedAt ||
        time(row.recordedAt) <= time(state.artifact.recordedAt) ||
        time(row.content.firstSlotAt) <= time(row.recordedAt) ||
        time(row.content.firstSlotAt) % HOUR !== 0
      )
        fail('enrollment')
      state.enrollment = row
    } else if (row.kind === 'cohort_tick') {
      const visibleCash = cashAtBoundary(cash, row.content, row.recordedAt)
      const latest =
        state.enrollment && latestCurrentSource(visibleCash, state.enrollment, row.recordedAt)
      const expectedReason =
        state.enrollment && tickReason(row.recordedAt, row.content.slotAt, latest, priorIssue)
      if (
        !state.enrollment ||
        !['issued', 'missed'].includes(row.content.status) ||
        row.content.slotIndex !== state.ticks.length ||
        row.content.slotAt !==
          iso(
            time(state.enrollment.content.firstSlotAt) +
              state.ticks.length * VAULT5_V2_POLICY.tickIntervalHours * HOUR,
          ) ||
        time(row.recordedAt) < time(row.content.slotAt) ||
        (row.content.status === 'issued' &&
          time(row.recordedAt) >= time(row.content.slotAt) + ISSUE_WINDOW) ||
        row.content.reason !== expectedReason ||
        row.content.status !== (expectedReason ? 'missed' : 'issued') ||
        (row.content.status === 'missed' &&
          time(row.recordedAt) < time(row.content.slotAt) + ISSUE_WINDOW)
      )
        fail('tick')
      state.ticks.push(row)
    } else if (row.kind === 'cohort_issue') {
      const tick = state.ticks.at(-1)
      const source = bySha.get(row.content.sourceReceiptSha256)
      const visibleCash = tick && cashAtBoundary(cash, tick.content, tick.recordedAt)
      const latest =
        state.enrollment && latestCurrentSource(visibleCash, state.enrollment, row.recordedAt)
      if (
        !tick ||
        tick.content.status !== 'issued' ||
        row.content.tickSha256 !== tick.sha256 ||
        state.issues.some((issue) => issue.content.tickSha256 === tick.sha256) ||
        !source ||
        source.collectionMode !== 'current' ||
        source.sha256 !== latest?.sha256 ||
        time(source.firstLocalReceiptAt) <= time(state.enrollment.recordedAt) ||
        time(source.blockAt) <= time(state.enrollment.recordedAt) ||
        time(source.firstLocalReceiptAt) > time(row.recordedAt) ||
        time(row.recordedAt) - time(source.blockAt) > SOURCE_MAX_AGE ||
        time(row.recordedAt) < time(source.blockAt) ||
        time(row.recordedAt) >= time(source.blockAt) + HORIZON - TOLERANCE ||
        (priorIssue && time(source.blockAt) <= time(priorIssue.content.targetHigh)) ||
        row.content.sourceBlock !== source.block ||
        row.content.sourceBlockHash !== source.blockHash ||
        row.content.sourceAt !== source.blockAt ||
        row.content.targetLow !== iso(time(source.blockAt) + HORIZON - TOLERANCE) ||
        row.content.targetHigh !== iso(time(source.blockAt) + HORIZON + TOLERANCE) ||
        row.content.targetReceiptDeadline !==
          iso(time(source.blockAt) + HORIZON + TOLERANCE + GRACE) ||
        row.content.attempts?.length !== 5
      )
        fail('issue')
      const expected = state.artifact.content.subjects.map((subject) => ({
        routeKey: subject.routeKey,
        destination: subject.destination,
        asset: subject.asset,
        ...projectVault5Cash(subjectRow(source, subject).cashRaw, subject.parameters),
      }))
      if (JSON.stringify(row.content.attempts) !== JSON.stringify(expected)) fail('issue_attempts')
      state.issues.push(row)
      issuesBySha.set(row.sha256, row)
      priorIssue = row
    } else if (row.kind === 'cohort_score') {
      const issue = issuesBySha.get(row.content.issueSha256)
      if (
        !issue ||
        scored.has(issue.sha256) ||
        time(row.recordedAt) <= time(issue.content.targetReceiptDeadline) ||
        !['observed', 'censored'].includes(row.content.status)
      )
        fail('score')
      const visibleCash = cashAtBoundary(cash, row.content, row.recordedAt)
      const target = targetCandidates(visibleCash, issue, row.recordedAt)[0]
      if (row.content.status === 'observed') {
        if (
          !target ||
          row.content.targetReceiptSha256 !== target.sha256 ||
          row.content.targetBlock !== target.block ||
          row.content.targetBlockHash !== target.blockHash ||
          row.content.targetAt !== target.blockAt ||
          row.content.outcomes?.length !== 5
        )
          fail('score_target')
        const expected = issue.content.attempts.map((attempt) => {
          const observedRaw = subjectRow(target, attempt).cashRaw
          const observed = BigInt(observedRaw)
          const modelWidth = BigInt(attempt.highRaw) - BigInt(attempt.lowRaw)
          const baselineWidth = BigInt(attempt.baselineHighRaw) - BigInt(attempt.baselineLowRaw)
          return {
            routeKey: attempt.routeKey,
            destination: attempt.destination,
            asset: attempt.asset,
            status: 'observed',
            observedRaw,
            covered: observed >= BigInt(attempt.lowRaw) && observed <= BigInt(attempt.highRaw),
            modelAbsoluteErrorRaw: abs(observed - BigInt(attempt.pointRaw)).toString(),
            baselineAbsoluteErrorRaw: abs(observed - BigInt(attempt.baselinePointRaw)).toString(),
            modelWidthRaw: modelWidth.toString(),
            baselineWidthRaw: baselineWidth.toString(),
          }
        })
        if (JSON.stringify(row.content.outcomes) !== JSON.stringify(expected))
          fail('score_outcomes')
      } else if (
        target ||
        time(row.recordedAt) < time(issue.content.targetReceiptDeadline) ||
        row.content.targetReceiptSha256 !== null ||
        row.content.targetBlock !== null ||
        row.content.targetBlockHash !== null ||
        row.content.targetAt !== null ||
        JSON.stringify(row.content.outcomes) !==
          JSON.stringify(VAULT5_SUBJECTS.map((subject) => ({ ...subject, status: 'censored' })))
      )
        fail('score_censor')
      scored.add(issue.sha256)
      state.scores.push(row)
    } else fail('kind')
    state.records.push(row)
    state.last = row
  }
  if (
    state.ticks.some(
      (tick) =>
        tick.content.status === 'issued' &&
        !state.issues.some((issue) => issue.content.tickSha256 === tick.sha256),
    )
  )
    fail('issued_tick_without_issue')
  state.count = state.records.length
  state.head = reconcileHead(root, manifest.sha256, state.records, recoverHead)
  return state
}

function appendBodies(manifest, bodies, options) {
  const root = options.root ?? VAULT5_V2_ROOT
  mkdirSync(root, { recursive: true })
  const lock = `${root}.lock`
  let lockFd
  try {
    lockFd = openSync(lock, 'wx')
  } catch (error) {
    if (error?.code === 'EEXIST') fail('lock_held_manual_inspection_required')
    throw error
  }
  try {
    const prior = verifyVault5V2Ledger(manifest, options)
    if (!readHead(root, manifest.sha256)) writeHead(root, manifest.sha256, 0, null)
    const disk = statfsSync(root)
    if (Number(disk.bavail) * Number(disk.bsize) < 1024 * 1024 * 1024) fail('disk_reserve')
    const appended = []
    let previous = prior.last
    for (const requested of bodies) {
      const body =
        requested.kind === 'cohort_issue' && requested.content.tickSha256 === '__PREVIOUS_TICK__'
          ? { ...requested, content: { ...requested.content, tickSha256: previous.sha256 } }
          : requested.kind === 'cohort_enrollment' &&
              requested.content.artifactSha256 === '__PREVIOUS_ARTIFACT__'
            ? { ...requested, content: { ...requested.content, artifactSha256: previous.sha256 } }
            : requested
      const recordBody = {
        study: STUDY,
        schemaVersion: 2,
        sequence: (previous?.sequence ?? 0) + 1,
        previousSha256: previous?.sha256 ?? null,
        policySha256: VAULT5_V2_POLICY_SHA256,
        ...body,
      }
      const record = { ...recordBody, sha256: sha(JSON.stringify(recordBody)) }
      appended.push(record)
      previous = record
    }
    if (
      appended.length !== 1 &&
      !(
        appended.length === 2 &&
        ((appended[0].kind === 'cohort_tick' && appended[1].kind === 'cohort_issue') ||
          (appended[0].kind === 'cohort_artifact' && appended[1].kind === 'cohort_enrollment'))
      )
    )
      fail('append_bundle_shape')
    const physicalBody =
      appended.length === 1
        ? appended[0]
        : {
            kind: 'cohort_bundle',
            bundleSchema: 1,
            records: appended,
          }
    const physical =
      appended.length === 1
        ? physicalBody
        : { ...physicalBody, sha256: sha(JSON.stringify(physicalBody)) }
    const tmp = join(root, `.${randomUUID()}.tmp`)
    const target = join(root, file(appended[0].sequence))
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      writeFileSync(fd, `${JSON.stringify(physical)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      linkSync(tmp, target)
    } finally {
      unlinkSync(tmp)
    }
    const dir = openSync(root, 'r')
    try {
      fsyncSync(dir)
    } finally {
      closeSync(dir)
    }
    verifyVault5V2Ledger(manifest, options)
    return appended
  } finally {
    closeSync(lockFd)
    unlinkSync(lock)
  }
}

export function registerVault5V2(manifest, options = {}, now = new Date().toISOString()) {
  const current = verifyVault5V2Ledger(manifest, options)
  if (current.enrollment)
    return {
      status: 'already_registered',
      artifactSha256: current.artifact.sha256,
      enrollmentSha256: current.enrollment.sha256,
      cutoverAt: current.enrollment.content.cutoverAt,
      firstSlotAt: current.enrollment.content.firstSlotAt,
    }
  if (current.artifact) fail('partial_registration')
  const enrolledAt = iso(time(now) + 1)
  const firstSlotAt = iso(Math.ceil((time(enrolledAt) + ISSUE_WINDOW) / HOUR) * HOUR)
  const [saved, enrollment] = appendBodies(
    manifest,
    [
      {
        kind: 'cohort_artifact',
        recordedAt: now,
        content: buildVault5Artifact(manifest, current.cash, now),
      },
      {
        kind: 'cohort_enrollment',
        recordedAt: enrolledAt,
        content: {
          artifactSha256: '__PREVIOUS_ARTIFACT__',
          manifestSha256: manifest.sha256,
          cutoverAt: enrolledAt,
          firstSlotAt,
        },
      },
    ],
    options,
  )
  return {
    status: 'registered',
    artifactSha256: saved.sha256,
    enrollmentSha256: enrollment.sha256,
    cutoverAt: enrolledAt,
    firstSlotAt,
  }
}

export function tickVault5V2(manifest, options = {}, now = new Date().toISOString()) {
  const state = verifyVault5V2Ledger(manifest, options)
  if (!state.enrollment) fail('not_enrolled')
  const slotAt = iso(
    time(state.enrollment.content.firstSlotAt) +
      state.ticks.length * VAULT5_V2_POLICY.tickIntervalHours * HOUR,
  )
  if (time(now) < time(slotAt)) return { status: 'not_due', slotAt }
  const latest = latestCurrentSource(state.cash, state.enrollment, now)
  const prior = state.issues.at(-1)
  const reason = tickReason(now, slotAt, latest, prior)
  if (reason && time(now) < time(slotAt) + ISSUE_WINDOW)
    return { status: 'pending', reason, slotAt }
  const tickBody = {
    kind: 'cohort_tick',
    recordedAt: now,
    content: {
      slotIndex: state.ticks.length,
      slotAt,
      status: reason ? 'missed' : 'issued',
      reason,
      ...cashBoundary(state.cash, now),
    },
  }
  if (reason) {
    const [tick] = appendBodies(manifest, [tickBody], options)
    return { status: 'missed', reason, slotAt, tickSha256: tick.sha256 }
  }
  const targetLow = iso(time(latest.blockAt) + HORIZON - TOLERANCE)
  const targetHigh = iso(time(latest.blockAt) + HORIZON + TOLERANCE)
  const attempts = state.artifact.content.subjects.map((subject) => ({
    routeKey: subject.routeKey,
    destination: subject.destination,
    asset: subject.asset,
    ...projectVault5Cash(subjectRow(latest, subject).cashRaw, subject.parameters),
  }))
  const [, issue] = appendBodies(
    manifest,
    [
      tickBody,
      {
        kind: 'cohort_issue',
        recordedAt: now,
        content: {
          tickSha256: '__PREVIOUS_TICK__',
          sourceReceiptSha256: latest.sha256,
          sourceBlock: latest.block,
          sourceBlockHash: latest.blockHash,
          sourceAt: latest.blockAt,
          targetLow,
          targetHigh,
          targetReceiptDeadline: iso(time(latest.blockAt) + HORIZON + TOLERANCE + GRACE),
          attempts,
        },
      },
    ],
    options,
  )
  return { status: 'issued', issueSha256: issue.sha256, slotAt }
}

export function scoreVault5V2(manifest, options = {}, now = new Date().toISOString()) {
  const state = verifyVault5V2Ledger(manifest, options)
  const scored = new Set(state.scores.map((row) => row.content.issueSha256))
  const issue = state.issues.find((row) => !scored.has(row.sha256))
  if (!issue) return { status: 'nothing_due' }
  if (time(now) <= time(issue.content.targetReceiptDeadline))
    return { status: 'pending', targetReceiptDeadline: issue.content.targetReceiptDeadline }
  const target = targetCandidates(state.cash, issue, now)[0]
  const outcomes = target
    ? issue.content.attempts.map((attempt) => {
        const observedRaw = subjectRow(target, attempt).cashRaw
        const observed = BigInt(observedRaw)
        return {
          routeKey: attempt.routeKey,
          destination: attempt.destination,
          asset: attempt.asset,
          status: 'observed',
          observedRaw,
          covered: observed >= BigInt(attempt.lowRaw) && observed <= BigInt(attempt.highRaw),
          modelAbsoluteErrorRaw: abs(observed - BigInt(attempt.pointRaw)).toString(),
          baselineAbsoluteErrorRaw: abs(observed - BigInt(attempt.baselinePointRaw)).toString(),
          modelWidthRaw: (BigInt(attempt.highRaw) - BigInt(attempt.lowRaw)).toString(),
          baselineWidthRaw: (
            BigInt(attempt.baselineHighRaw) - BigInt(attempt.baselineLowRaw)
          ).toString(),
        }
      })
    : VAULT5_SUBJECTS.map((subject) => ({ ...subject, status: 'censored' }))
  const [score] = appendBodies(
    manifest,
    [
      {
        kind: 'cohort_score',
        recordedAt: now,
        content: {
          issueSha256: issue.sha256,
          status: target ? 'observed' : 'censored',
          ...cashBoundary(state.cash, now),
          targetReceiptSha256: target?.sha256 ?? null,
          targetBlock: target?.block ?? null,
          targetBlockHash: target?.blockHash ?? null,
          targetAt: target?.blockAt ?? null,
          outcomes,
        },
      },
    ],
    options,
  )
  return { status: target ? 'observed' : 'censored', scoreSha256: score.sha256 }
}

export function evaluateVault5V2State(state) {
  return {
    ledgerRecords: state.count,
    enrollmentSha256: state.enrollment?.sha256 ?? null,
    ...assessVault5Subjects(state.issues, state.scores, state.ticks),
  }
}

export function evaluateVault5V2(manifest, options = {}) {
  return evaluateVault5V2State(verifyVault5V2Ledger(manifest, options))
}
