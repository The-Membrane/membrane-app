import {
  issueCarryExitV2Horizons,
  carryExitV2Predecessor,
} from './carry-exit-v2-umbrella-gho-policy.mjs'
import { reobserveUmbrellaGhoGate } from './carry-exit-v2-umbrella-gho-classifier.mjs'
// Local prospective Carry Exit V2 evidence. The operator clock is not an
// independent timestamp, and eth_call/readback is not a mined payout.
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
  rmdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export const LOCAL_CARRY_EXIT_V2_STUDY = 'carry_local_exit_v2_v1'
export const LOCAL_CARRY_EXIT_V2_ROOT = resolve('data/research/venue-signals/carry-local-exit-v2')
export const CARRY_EXIT_V2_HORIZONS = Object.freeze([1, 4, 24, 48, 168])
export const CARRY_EXIT_V2_PREDECESSOR = Object.freeze({ 1: 0, 4: 1, 24: 4, 48: 24, 168: 48 })

const SHA = /^[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const BLOCK_HASH = /^0x[0-9a-f]{64}$/
const UINT = /^(0|[1-9][0-9]*)$/
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
const FILE = /^\d{12}\.json$/
const HOUR = 3_600_000
const MAX_RECORD_BYTES = 512 * 1024
const MAX_RECORDS = 1_000_000
const MIN_FREE_BYTES = 64 * 1024 * 1024
const OUTCOME = new Set([
  'success',
  'covered_revert',
  'holder_attrition',
  'inconclusive',
  'not_eligible',
  'episode_censored',
])
const MISSING = new Set(['missing', 'censored', 'unavailable'])
const BASELINE = new Set(['success', 'covered_revert', 'ineligible', 'inconclusive', 'unavailable'])
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const file = (sequence) => `${String(sequence).padStart(12, '0')}.json`
const headPath = (root) => `${root}.head.json`
const lockPath = (root) => `${root}.lock`

export class LocalCarryExitV2StoreError extends Error {
  constructor(code) {
    super(`local_carry_exit_v2_${code}`)
    this.name = 'LocalCarryExitV2StoreError'
    this.code = `local_carry_exit_v2_${code}`
  }
}

function fail(code) {
  throw new LocalCarryExitV2StoreError(code)
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function time(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail('time_invalid')
  return Date.parse(value)
}

function boundedString(value, max = 256) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f]/.test(value)
  )
}

function identifier(value) {
  return typeof value === 'string' && ID.test(value)
}

function uint(value, positive = false) {
  return (
    typeof value === 'string' &&
    value.length <= 78 &&
    UINT.test(value) &&
    (!positive || BigInt(value) > 0n)
  )
}

function boundedJson(value, depth = 0) {
  if (depth > 16) fail('payload_depth')
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'string') {
    if (value.length > 262_144) fail('payload_string_oversize')
    return
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('payload_number_invalid')
    return
  }
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1
    )
      fail('payload_non_plain')
    if (value.length > 2_000) fail('payload_array_oversize')
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('payload_non_plain')
      boundedJson(descriptor.value, depth + 1)
    }
    return
  }
  if (
    !object(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    fail('payload_non_plain')
  const keys = Reflect.ownKeys(value)
  if (keys.length > 2_000) fail('payload_shape')
  for (const key of keys) {
    if (!boundedString(key, 256)) fail('payload_key_invalid')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('payload_non_plain')
    boundedJson(descriptor.value, depth + 1)
  }
}

function canonicalPayload(value) {
  const copy = (item) => {
    if (item === null || typeof item !== 'object') return item
    if (Array.isArray(item))
      return Array.from({ length: item.length }, (_, index) =>
        copy(Object.getOwnPropertyDescriptor(item, String(index)).value),
      )
    const result = Object.create(null)
    for (const key of Object.keys(item).sort())
      result[key] = copy(Object.getOwnPropertyDescriptor(item, key).value)
    return result
  }
  try {
    boundedJson(value)
    return JSON.parse(JSON.stringify(copy(value)))
  } catch (error) {
    if (error instanceof LocalCarryExitV2StoreError) throw error
    fail('payload_non_plain')
  }
}

function subjectOf(payload) {
  if (
    !boundedString(payload.routeKey, 256) ||
    !ADDRESS.test(payload.destination ?? '') ||
    !ADDRESS.test(payload.asset ?? '') ||
    !Number.isInteger(payload.decimals) ||
    payload.decimals < 0 ||
    payload.decimals > 36 ||
    !uint(payload.assetsRaw, true)
  )
    fail('subject_invalid')
  return [
    payload.routeKey,
    payload.destination,
    payload.asset,
    payload.decimals,
    payload.assetsRaw,
  ].join('\u001f')
}

export function localCarryExitV2SubjectKey(subject) {
  return subjectOf(subject)
}

function planFor(issue, horizonH) {
  return issue.payload.plan.find((plan) => plan.horizonH === horizonH)
}

function validatePlan(payload) {
  const horizons = issueCarryExitV2Horizons(payload)
  if (!Array.isArray(payload.plan) || payload.plan.length !== horizons.length)
    fail('plan_horizons_invalid')
  const issuedMs = time(payload.issuedAtUtc)
  for (const [index, horizonH] of horizons.entries()) {
    const plan = payload.plan[index]
    if (
      !object(plan) ||
      plan.horizonH !== horizonH ||
      plan.predecessorH !== carryExitV2Predecessor(horizons, horizonH) ||
      plan.conditionalRecovery !== false ||
      time(plan.targetAtUtc) !== issuedMs + horizonH * HOUR ||
      time(plan.deadlineAtUtc) !== issuedMs + (horizonH + 2) * HOUR
    )
      fail('plan_target_deadline_invalid')
  }
}

function outcomeKey(payload) {
  if (
    !identifier(payload.issueId) ||
    !Number.isSafeInteger(payload.horizonH) ||
    payload.horizonH < 1 ||
    payload.horizonH > 744
  )
    fail('outcome_key_invalid')
  return `${payload.issueId}\u001f${payload.horizonH}`
}

function checkCausal(record, state) {
  const p = record.payload
  if (!object(p)) fail('payload_invalid')
  boundedJson(p)
  if (record.kind === 'attempt') {
    if (!identifier(p.attemptId) || !boundedString(p.stage, 64) || !boundedString(p.status, 64))
      fail('attempt_invalid')
    if (p.routeKey !== undefined) subjectOf(p)
    if (state.attempts.has(p.attemptId)) fail('duplicate_attempt')
    state.attempts.set(p.attemptId, record)
    return
  }
  if (record.kind === 'issue') {
    const subjectKey = subjectOf(p)
    if (
      !identifier(p.issueId) ||
      !BASELINE.has(p.baselineStatus) ||
      !uint(p.baselineBlock, true) ||
      !BLOCK_HASH.test(p.baselineHash ?? '') ||
      !object(p.proofEnvelope) ||
      Object.keys(p.proofEnvelope).length === 0 ||
      !object(p.issueEnvelope) ||
      Object.keys(p.issueEnvelope).length === 0 ||
      time(p.baselineBlockAtUtc) > time(p.issuedAtUtc) ||
      time(p.issuedAtUtc) > time(record.recordedAtUtc)
    )
      fail('issue_invalid')
    validatePlan(p)
    if (state.issues.has(p.issueId)) fail('duplicate_issue')
    // An issue is an episode. A later issue may repeat the same exact Q, but
    // cannot reuse the same local-clock episode anchor for that exact subject.
    const episodeKey = `${subjectKey}\u001f${p.issuedAtUtc}`
    if (state.episodes.has(episodeKey)) fail('duplicate_episode')
    state.episodes.add(episodeKey)
    state.issues.set(p.issueId, record)
    return
  }
  if (record.kind === 'readback') {
    if (
      !identifier(p.issueId) ||
      !identifier(p.witnessId) ||
      !object(p.readbackProof) ||
      Object.keys(p.readbackProof).length === 0
    )
      fail('readback_invalid')
    const issue = state.issues.get(p.issueId)
    if (!issue) fail('readback_before_issue')
    if (state.readbacks.has(p.issueId) || state.witnessIds.has(p.witnessId))
      fail('duplicate_readback')
    if (
      time(p.readbackAtUtc) < time(issue.payload.issuedAtUtc) ||
      time(p.readbackAtUtc) < time(issue.recordedAtUtc) ||
      time(p.readbackAtUtc) > time(record.recordedAtUtc) ||
      time(p.readbackAtUtc) >= time(issue.payload.plan[0].targetAtUtc) ||
      time(record.recordedAtUtc) >= time(issue.payload.plan[0].targetAtUtc)
    )
      fail('readback_time_invalid')
    if (p.issueSha256 !== issue.sha256) fail('readback_issue_mismatch')
    state.readbacks.set(p.issueId, record)
    state.witnessIds.add(p.witnessId)
    return
  }
  if (record.kind !== 'missing' && record.kind !== 'score') fail('kind_invalid')
  const key = outcomeKey(p)
  const issue = state.issues.get(p.issueId)
  if (!issue) fail('outcome_before_issue')
  if (!state.readbacks.has(p.issueId)) fail('outcome_before_readback')
  if (state.outcomes.has(key)) fail('duplicate_outcome')
  const plan = planFor(issue, p.horizonH)
  if (!plan) fail('outcome_undeclared_horizon')
  if (
    p.targetAtUtc !== plan.targetAtUtc ||
    p.deadlineAtUtc !== plan.deadlineAtUtc ||
    p.predecessorH !== plan.predecessorH
  )
    fail('outcome_plan_mismatch')
  const previous =
    p.predecessorH === 0 ? null : state.outcomes.get(`${p.issueId}\u001f${p.predecessorH}`)
  if (p.predecessorH !== 0 && !previous) fail('predecessor_missing')
  if (p.predecessorSha256 !== (previous?.sha256 ?? null)) fail('predecessor_mismatch')
  const priorStatus = previous?.payload.status ?? issue.payload.baselineStatus
  const mustCensor = ['holder_attrition', 'censored', 'episode_censored'].includes(priorStatus)
  const mustMarkIneligible =
    ['ineligible', 'inconclusive', 'unavailable'].includes(issue.payload.baselineStatus) &&
    !reobserveUmbrellaGhoGate(issue)
  if (record.kind === 'missing') {
    const allowedStatus = mustCensor
      ? p.status === 'censored'
      : mustMarkIneligible
        ? p.status === 'unavailable'
        : p.status === 'missing' || p.status === 'unavailable'
    if (
      !MISSING.has(p.status) ||
      !boundedString(p.reason, 512) ||
      time(record.recordedAtUtc) < time(plan.deadlineAtUtc) ||
      !allowedStatus
    )
      fail('missing_invalid')
    if (p.receiptAtUtc !== record.recordedAtUtc) fail('missing_receipt_time_invalid')
  } else {
    if (
      !OUTCOME.has(p.status) ||
      !object(p.scoreEnvelope) ||
      !object(p.proofEnvelope) ||
      Object.keys(p.scoreEnvelope).length === 0 ||
      Object.keys(p.proofEnvelope).length === 0
    )
      fail('score_invalid')
    if (time(record.recordedAtUtc) < time(plan.targetAtUtc)) fail('score_before_target')
    if (time(record.recordedAtUtc) > time(plan.deadlineAtUtc)) fail('score_after_deadline')
    if (p.scoredAtUtc !== record.recordedAtUtc) fail('score_time_invalid')
    const targetRequired = [
      'success',
      'covered_revert',
      'holder_attrition',
      'inconclusive',
    ].includes(p.status)
    if (targetRequired) {
      if (
        !uint(p.targetBlock, true) ||
        !BLOCK_HASH.test(p.targetHash ?? '') ||
        BigInt(p.targetBlock) <= BigInt(issue.payload.baselineBlock) ||
        (previous?.payload.targetBlock != null &&
          BigInt(p.targetBlock) <= BigInt(previous.payload.targetBlock)) ||
        time(p.targetBlockAtUtc) < time(plan.targetAtUtc) ||
        time(p.targetBlockAtUtc) > time(plan.deadlineAtUtc) ||
        time(p.observedAtUtc) < time(p.targetBlockAtUtc) ||
        time(p.observedAtUtc) > time(plan.deadlineAtUtc) ||
        time(p.observedAtUtc) > time(record.recordedAtUtc) ||
        time(p.observedAtUtc) <= time(state.readbacks.get(p.issueId).recordedAtUtc)
      )
        fail('score_target_invalid')
    } else if (
      p.targetBlock !== null ||
      p.targetHash !== null ||
      p.targetBlockAtUtc !== null ||
      p.observedAtUtc !== null
    )
      fail('score_control_target_invalid')
    if (
      p.status === 'not_eligible' &&
      !['ineligible', 'inconclusive', 'unavailable'].includes(issue.payload.baselineStatus)
    )
      fail('score_control_invalid')
    if (
      p.status === 'episode_censored' &&
      ![...state.outcomes.values()].some(
        (row) =>
          row.payload.issueId === p.issueId &&
          (row.payload.status === 'holder_attrition' ||
            row.payload.status === 'censored' ||
            row.payload.status === 'episode_censored'),
      )
    )
      fail('score_control_invalid')
    if (
      (mustCensor && p.status !== 'episode_censored') ||
      (mustMarkIneligible && p.status !== 'not_eligible') ||
      (!mustMarkIneligible && p.status === 'not_eligible')
    )
      fail('score_control_invalid')
  }
  state.outcomes.set(key, record)
}

function checkRecord(record, prior, state) {
  if (!object(record)) fail('record_invalid')
  const { sha256, ...body } = record
  if (
    record.study !== LOCAL_CARRY_EXIT_V2_STUDY ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence !== (prior?.sequence ?? 0) + 1 ||
    record.previousSha256 !== (prior?.sha256 ?? null) ||
    !SHA.test(sha256 ?? '') ||
    sha256 !== sha(JSON.stringify(body))
  )
    fail('chain_invalid')
  time(record.recordedAtUtc)
  if (prior && time(record.recordedAtUtc) < time(prior.recordedAtUtc)) fail('clock_regression')
  checkCausal(record, state)
}

function readHead(root) {
  const path = headPath(root)
  if (!existsSync(path)) return null
  const bytes = readFileSync(path, 'utf8')
  if (Buffer.byteLength(bytes) > 2048) fail('head_oversize')
  let head
  try {
    head = JSON.parse(bytes)
  } catch {
    fail('head_invalid')
  }
  const { sha256, ...body } = head
  if (
    bytes !== `${JSON.stringify(head)}\n` ||
    !SHA.test(sha256 ?? '') ||
    sha256 !== sha(JSON.stringify(body)) ||
    body.schema !== 'carry_local_exit_v2_head_v1' ||
    body.study !== LOCAL_CARRY_EXIT_V2_STUDY ||
    !Number.isSafeInteger(body.sequence) ||
    body.sequence < 0 ||
    (body.sequence === 0 ? body.lastSha256 !== null : !SHA.test(body.lastSha256 ?? ''))
  )
    fail('head_invalid')
  return head
}

function syncDirectory(path) {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function writeHead(root, sequence, lastSha256, initial = false) {
  const body = {
    schema: 'carry_local_exit_v2_head_v1',
    study: LOCAL_CARRY_EXIT_V2_STUDY,
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
    if (initial) linkSync(tmp, path)
    else renameSync(tmp, path)
    syncDirectory(dirname(path))
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp)
  }
  return head
}

function emptyState() {
  return {
    records: [],
    attempts: new Map(),
    episodes: new Set(),
    issues: new Map(),
    readbacks: new Map(),
    witnessIds: new Set(),
    outcomes: new Map(),
    head: null,
  }
}

function verifyLedger({
  root = LOCAL_CARRY_EXIT_V2_ROOT,
  recoverHead = false,
  lockHeld = false,
} = {}) {
  const state = emptyState()
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
    if (head?.sequence > 0) fail('head_ahead_ledger_rollback')
    state.head = head
    return state
  }
  const files = readdirSync(root).sort()
  if (files.length > MAX_RECORDS || files.some((name) => !FILE.test(name))) fail('unexpected_file')
  for (const [index, name] of files.entries()) {
    if (name !== file(index + 1)) fail('sequence_gap')
    const bytes = readFileSync(join(root, name), 'utf8')
    if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES) fail('record_oversize')
    let record
    try {
      record = JSON.parse(bytes)
    } catch {
      fail('record_parse_invalid')
    }
    if (bytes !== `${JSON.stringify(record)}\n`) fail('record_bytes_invalid')
    checkRecord(record, state.records.at(-1), state)
    state.records.push(record)
  }
  if (state.records.length && !head) fail('head_missing_manual_inspection_required')
  if (
    head &&
    (head.sequence > state.records.length ||
      (state.records[head.sequence - 1]?.sha256 ?? null) !== head.lastSha256)
  )
    fail('head_ahead_or_prefix_mismatch')
  if (head && head.sequence < state.records.length) {
    if (!recoverHead) fail('head_lag_recovery_required')
    if (!lockHeld) fail('recovery_requires_lock')
    state.head = writeHead(root, state.records.length, state.records.at(-1).sha256)
  } else state.head = head
  return state
}

// Public verification is always read-only. Only the recorder and the explicit
// recovery entry point call the private verifier while holding the writer lock.
export function verifyLocalCarryExitV2Ledger({ root = LOCAL_CARRY_EXIT_V2_ROOT } = {}) {
  return verifyLedger({ root })
}

function withLock(root, work) {
  mkdirSync(dirname(root), { recursive: true })
  try {
    mkdirSync(lockPath(root))
  } catch (error) {
    if (error?.code === 'EEXIST') fail('lock_manual_inspection_required')
    throw error
  }
  try {
    return work()
  } finally {
    rmdirSync(lockPath(root))
  }
}

export function recoverLocalCarryExitV2Head({ root = LOCAL_CARRY_EXIT_V2_ROOT } = {}) {
  return withLock(root, () => verifyLedger({ root, recoverHead: true, lockHeld: true }).head)
}

function reserve(root, bytes, minFreeBytes) {
  let path = root
  while (!existsSync(path)) path = dirname(path)
  const disk = statfsSync(path)
  if (Number(disk.bavail) * Number(disk.bsize) - bytes < minFreeBytes) fail('disk_reserve')
}

function existingFor(state, kind, payload) {
  if (kind === 'attempt') return state.attempts.get(payload.attemptId)
  if (kind === 'issue') return state.issues.get(payload.issueId)
  if (kind === 'readback') return state.readbacks.get(payload.issueId)
  if (kind === 'missing' || kind === 'score')
    return state.outcomes.get(`${payload.issueId}\u001f${payload.horizonH}`)
  return null
}

export function appendLocalCarryExitV2Record(
  kind,
  payload,
  { root = LOCAL_CARRY_EXIT_V2_ROOT, now = Date.now(), minFreeBytes = MIN_FREE_BYTES } = {},
) {
  if (!['attempt', 'issue', 'readback', 'missing', 'score'].includes(kind)) fail('kind_invalid')
  if (!object(payload)) fail('payload_invalid')
  if (
    !Number.isSafeInteger(now) ||
    !Number.isFinite(new Date(now).getTime()) ||
    !Number.isSafeInteger(minFreeBytes) ||
    minFreeBytes < 0
  )
    fail('clock_or_reserve_invalid')
  return withLock(root, () => {
    const state = verifyLedger({ root, recoverHead: true, lockHeld: true })
    const canonical = canonicalPayload(payload)
    const existing = existingFor(state, kind, canonical)
    if (existing) {
      if (existing.kind === kind && JSON.stringify(existing.payload) === JSON.stringify(canonical))
        return existing
      fail('duplicate_logical_key')
    }
    if (state.records.length >= MAX_RECORDS) fail('record_limit')
    const body = {
      study: LOCAL_CARRY_EXIT_V2_STUDY,
      sequence: state.records.length + 1,
      previousSha256: state.records.at(-1)?.sha256 ?? null,
      kind,
      recordedAtUtc: new Date(now).toISOString(),
      payload: canonical,
    }
    const record = { ...body, sha256: sha(JSON.stringify(body)) }
    checkRecord(record, state.records.at(-1), state)
    const bytes = `${JSON.stringify(record)}\n`
    if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES) fail('record_oversize')
    reserve(root, Buffer.byteLength(bytes), minFreeBytes)
    mkdirSync(root, { recursive: true })
    if (!readHead(root)) writeHead(root, 0, null, true)
    const tmp = `${root}.pending.${randomUUID()}.tmp`
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      writeFileSync(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      linkSync(tmp, join(root, file(record.sequence)))
      syncDirectory(root)
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp)
    }
    writeHead(root, record.sequence, record.sha256)
    return record
  })
}

export function getLocalCarryExitV2Prior(state, issueId, horizonH) {
  if (!identifier(issueId)) fail('outcome_key_invalid')
  const issue = state.issues.get(issueId)
  if (!issue) fail('issue_not_found')
  const predecessorH = carryExitV2Predecessor(issueCarryExitV2Horizons(issue.payload), horizonH)
  return predecessorH === 0
    ? {
        predecessorH: 0,
        predecessorSha256: null,
        predecessorStatus: issue.payload.baselineStatus,
        predecessorBlock: issue.payload.baselineBlock,
        predecessorHash: issue.payload.baselineHash,
        predecessorBlockAtUtc: issue.payload.baselineBlockAtUtc,
      }
    : (() => {
        const prior = state.outcomes.get(`${issueId}\u001f${predecessorH}`)
        if (!prior) return null
        return {
          predecessorH,
          predecessorSha256: prior.sha256,
          predecessorStatus:
            prior.payload.status === 'unavailable'
              ? 'missing'
              : prior.payload.status === 'censored'
                ? 'episode_censored'
                : prior.payload.status,
          predecessorBlock: prior.payload.targetBlock ?? null,
          predecessorHash: prior.payload.targetHash ?? null,
          predecessorBlockAtUtc: prior.payload.targetBlockAtUtc ?? null,
        }
      })()
}

export function dueLocalCarryExitV2Targets(state, now = Date.now()) {
  if (!Number.isSafeInteger(now)) fail('clock_invalid')
  const due = []
  for (const issue of state.issues.values()) {
    if (!state.readbacks.has(issue.payload.issueId)) continue
    for (const plan of issue.payload.plan) {
      if (Date.parse(plan.targetAtUtc) > now) continue
      if (state.outcomes.has(`${issue.payload.issueId}\u001f${plan.horizonH}`)) continue
      const predecessor = getLocalCarryExitV2Prior(state, issue.payload.issueId, plan.horizonH)
      if (!predecessor) continue
      due.push({
        issueId: issue.payload.issueId,
        issueSha256: issue.sha256,
        subjectKey: subjectOf(issue.payload),
        horizonH: plan.horizonH,
        targetAtUtc: plan.targetAtUtc,
        deadlineAtUtc: plan.deadlineAtUtc,
        overdue: now >= Date.parse(plan.deadlineAtUtc),
        ...predecessor,
      })
    }
  }
  return due.sort(
    (a, b) => a.targetAtUtc.localeCompare(b.targetAtUtc) || a.issueId.localeCompare(b.issueId),
  )
}

// A caller-supplied validator must be deterministic and source-specific. It
// receives copies of the private evidence, while the returned grid remains a
// strict public allowlist. Without one, no score is counted as measured.
export function projectLocalCarryExitV2Coverage(
  state,
  now = Date.now(),
  { measurementValidator = null, validatorId = null } = {},
) {
  if (!Number.isSafeInteger(now)) fail('clock_invalid')
  if (
    measurementValidator === null
      ? validatorId !== null
      : typeof measurementValidator !== 'function' || !identifier(validatorId)
  )
    fail('measurement_validator_invalid')
  const subjects = new Map()
  for (const issue of state.issues.values()) {
    const p = issue.payload
    const key = subjectOf(p)
    const witnessed = state.readbacks.has(p.issueId)
    const readbackWindowElapsed = !witnessed && now >= Date.parse(p.plan[0].targetAtUtc)
    if (!subjects.has(key))
      subjects.set(key, {
        routeKey: p.routeKey,
        destination: p.destination,
        asset: p.asset,
        decimals: p.decimals,
        assetsRaw: p.assetsRaw,
        issued: 0,
        pending: 0,
        recorded_unverified: 0,
        measured: 0,
        missing: 0,
        censored: 0,
        unavailable: 0,
        cells: [],
      })
    const row = subjects.get(key)
    row.issued += 1
    for (const plan of p.plan) {
      const outcome = state.outcomes.get(`${p.issueId}\u001f${plan.horizonH}`)
      let scoreValidated = false
      if (outcome?.kind === 'score' && measurementValidator) {
        const input = JSON.parse(
          JSON.stringify({
            issueRecord: issue,
            readbackRecord: state.readbacks.get(p.issueId),
            scoreRecord: outcome,
            plan,
          }),
        )
        try {
          scoreValidated = measurementValidator(input)
        } catch {
          fail('measurement_validator_failed')
        }
        if (typeof scoreValidated !== 'boolean') fail('measurement_validator_invalid_result')
      }
      const status = outcome
        ? outcome.kind === 'missing'
          ? outcome.payload.status
          : !scoreValidated
            ? 'recorded_unverified'
            : outcome.payload.status === 'episode_censored'
              ? 'censored'
              : ['not_eligible', 'inconclusive'].includes(outcome.payload.status)
                ? 'unavailable'
                : 'measured'
        : readbackWindowElapsed
          ? 'unavailable'
          : 'pending'
      const reason = !outcome && readbackWindowElapsed ? 'readback_not_sealed_before_h1' : null
      row[status] += 1
      row.cells.push({
        horizonH: plan.horizonH,
        targetAtUtc: plan.targetAtUtc,
        deadlineAtUtc: plan.deadlineAtUtc,
        status,
        reason,
        due: now >= Date.parse(plan.targetAtUtc),
        witnessed,
      })
    }
  }
  return {
    study: LOCAL_CARRY_EXIT_V2_STUDY,
    provenance: 'local_operator_clock',
    independentTimestamp: false,
    independentWitness: false,
    externalMonotonicCheckpoint: false,
    rollbackProof: false,
    chainLimitation: 'Local SHA chain has no external monotonic checkpoint or rollback proof.',
    measurementValidatorId: validatorId,
    minedPayoutProven: false,
    prospectiveValidated: false,
    forecastValidated: false,
    holderExecutableExit: false,
    calibratedForecast: false,
    subjects: [...subjects.values()].sort((a, b) => {
      const identity =
        a.routeKey.localeCompare(b.routeKey) ||
        a.destination.localeCompare(b.destination) ||
        a.asset.localeCompare(b.asset) ||
        a.decimals - b.decimals
      if (identity) return identity
      return BigInt(a.assetsRaw) < BigInt(b.assetsRaw)
        ? -1
        : BigInt(a.assetsRaw) > BigInt(b.assetsRaw)
          ? 1
          : 0
    }),
  }
}
