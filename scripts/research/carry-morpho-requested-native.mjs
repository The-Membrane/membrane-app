// Opt-in local intake and bounded native tick for the exact owner/Q Morpho study.
// No read-only simulation here proves key control, execution, or mined payout.
import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'

import { readEnv } from '../lib/venue-reads.mjs'
import {
  DEFAULT_DIR as STUDY_DIR,
  MAX_ISSUES,
  exactSubject,
  issue,
  originHost,
  score,
  verify,
} from './carry-morpho-requested-holder.mjs'

export const QUEUE_DIR = resolve('data/research/venue-signals/carry-morpho-requested-intake-v1')
export const ORIGIN_OPERATORS = Object.freeze(['ankr', 'drpc'])
const MAX_REQUEST_BYTES = 2048
const RESERVE_BYTES = 1024 ** 3
const MAX_ACTIVE_WATCHES = 12
const MAX_INTAKE_FAILURES_PER_TUPLE = 12
const REARM_DELAY_MS = 6 * 60 * 60_000
const FAILURE_NAME = /^\.fail-([0-9a-f]{64})-(0[1-9]|1[0-2])\.json$/
const SHA = /^[0-9a-f]{64}$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const canonical = (request) => JSON.stringify(request)
const normalizeRequest = (request) => ({
  routeKey: request.routeKey,
  destinationAddress: request.destinationAddress,
  owner: request.owner,
  assetsRaw: request.assetsRaw,
})
const queueId = (request) => sha(canonical(normalizeRequest(request)))
const isPrivate = (path) => {
  const stat = lstatSync(path)
  return stat.isDirectory() && (stat.mode & 0o077) === 0
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!isPrivate(dir)) throw Error('requested_native_directory_not_private')
  const disk = statfsSync(dir)
  if (Number(disk.bavail) * Number(disk.bsize) < RESERVE_BYTES)
    throw Error('requested_native_disk_reserve')
}

function readFilePrivate(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_REQUEST_BYTES || stat.mode & 0o077)
      throw Error('requested_native_record_invalid')
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

function validateRecord(record, name) {
  if (
    Object.keys(record ?? {})
      .sort()
      .join() !== 'frozen,id,queuedAtMs,request,schemaVersion,sha256' ||
    record?.schemaVersion !== 1 ||
    record.id !== name.slice(0, -5) ||
    !SHA.test(record.id) ||
    !Number.isSafeInteger(record.queuedAtMs) ||
    record.queuedAtMs < 0 ||
    record.id !== queueId(record.request) ||
    canonical(record.request) !== canonical(normalizeRequest(record.request)) ||
    canonical(exactSubject(record.request)) !== canonical(record.frozen) ||
    record.sha256 !==
      sha(
        canonical({
          schemaVersion: 1,
          id: record.id,
          request: record.request,
          frozen: record.frozen,
          queuedAtMs: record.queuedAtMs,
        }),
      )
  )
    throw Error('requested_native_record_invalid')
  return record
}

export function readQueue(dir = QUEUE_DIR) {
  if (!existsSync(dir)) return []
  if (!isPrivate(dir)) throw Error('requested_native_directory_not_private')
  const names = readdirSync(dir).sort()
  const permanent = names.filter(
    (name) =>
      !/^\.(?:intake\.lock|requested-[0-9a-f-]{36}\.tmp|fail-[0-9a-f]{64}-(?:0[1-9]|1[0-2])\.json)$/.test(
        name,
      ),
  )
  if (permanent.length > MAX_ISSUES) throw Error('requested_native_queue_limit')
  const records = []
  for (const name of names) {
    if (name === '.intake.lock') continue
    if (/^\.requested-[0-9a-f-]{36}\.tmp$/.test(name)) continue
    if (FAILURE_NAME.test(name)) continue
    if (!/^[0-9a-f]{64}\.json$/.test(name)) throw Error('requested_native_filename_invalid')
    const text = readFilePrivate(join(dir, name))
    const record = JSON.parse(text)
    if (text !== `${canonical(record)}\n`) throw Error('requested_native_record_invalid')
    records.push(validateRecord(record, name))
  }
  return records.sort((a, b) => a.queuedAtMs - b.queuedAtMs || a.id.localeCompare(b.id))
}

export function readFailures(dir = QUEUE_DIR) {
  if (!existsSync(dir)) return new Map()
  if (!isPrivate(dir)) throw Error('requested_native_directory_not_private')
  const failures = new Map()
  const names = readdirSync(dir).sort()
  if (
    names.filter((name) => FAILURE_NAME.test(name)).length >
    MAX_ISSUES * MAX_INTAKE_FAILURES_PER_TUPLE
  )
    throw Error('requested_native_failure_limit')
  for (const name of names) {
    const match = FAILURE_NAME.exec(name)
    if (!match) continue
    const text = readFilePrivate(join(dir, name))
    const row = JSON.parse(text)
    const attempt = Number(match[2])
    const pause = attempt % 3 === 0
    const body = {
      schemaVersion: 1,
      id: match[1],
      attempt,
      attemptedAtMs: row.attemptedAtMs,
      nextAttemptAtMs: row.nextAttemptAtMs,
      terminal: pause,
    }
    if (
      text !== `${canonical(row)}\n` ||
      Object.keys(row).sort().join() !==
        'attempt,attemptedAtMs,id,nextAttemptAtMs,schemaVersion,sha256,terminal' ||
      canonical({ ...body, sha256: sha(canonical(body)) }) !== canonical(row) ||
      !Number.isSafeInteger(body.attemptedAtMs) ||
      body.attemptedAtMs < 0 ||
      body.nextAttemptAtMs !==
        (attempt === MAX_INTAKE_FAILURES_PER_TUPLE
          ? null
          : body.attemptedAtMs + (pause ? REARM_DELAY_MS : 30 * 60_000))
    )
      throw Error('requested_native_failure_record_invalid')
    const prior = failures.get(row.id) ?? []
    if (
      prior.length + 1 !== row.attempt ||
      (prior.length && row.attemptedAtMs < prior.at(-1).nextAttemptAtMs)
    )
      throw Error('requested_native_failure_sequence_invalid')
    prior.push(row)
    failures.set(row.id, prior)
  }
  return failures
}

function appendFailure(dir, id, prior, at) {
  if (prior.length >= MAX_INTAKE_FAILURES_PER_TUPLE) throw Error('requested_native_failure_limit')
  const attempt = prior.length + 1
  const pause = attempt % 3 === 0
  const body = {
    schemaVersion: 1,
    id,
    attempt,
    attemptedAtMs: at,
    nextAttemptAtMs:
      attempt === MAX_INTAKE_FAILURES_PER_TUPLE
        ? null
        : at + (pause ? REARM_DELAY_MS : 30 * 60_000),
    terminal: pause,
  }
  const record = { ...body, sha256: sha(canonical(body)) }
  const temp = join(dir, `.requested-${randomUUID()}.tmp`)
  const target = join(dir, `.fail-${id}-${String(body.attempt).padStart(2, '0')}.json`)
  let fd
  try {
    fd = openSync(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    )
    writeFileSync(fd, `${canonical(record)}\n`)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    linkSync(temp, target)
    const directory = openSync(dir, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temp)) unlinkSync(temp)
  }
  return record
}

const PYTHON_FLOCK = String.raw`import fcntl, os, sys, time
fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
for _ in range(80):
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        time.sleep(0.025)
else:
    sys.exit(2)
sys.stdout.write('LOCKED\n')
sys.stdout.flush()
sys.stdin.read()
`

async function withIntakeLock(dir, work) {
  const child = spawn('/usr/bin/python3', ['-c', PYTHON_FLOCK, join(dir, '.intake.lock')], {
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const exited = new Promise((resolve) => child.once('close', resolve))
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
        reject(Error('requested_native_intake_lock_failed'))
      }, 4000)
      const fail = () => {
        clearTimeout(timeout)
        reject(Error('requested_native_intake_lock_failed'))
      }
      child.stdout.once('data', (bytes) => {
        clearTimeout(timeout)
        if (String(bytes) === 'LOCKED\n') resolve()
        else fail()
      })
      child.once('error', fail)
      child.once('exit', fail)
    })
    return await work()
  } finally {
    child.stdin.end()
    await exited
  }
}

export async function enqueue(
  request,
  { dir = QUEUE_DIR, studyDir = STUDY_DIR, now = Date.now } = {},
) {
  // Preserve the caller's exact tuple. The study performs the same frozen-roster validation.
  if (
    Object.keys(request ?? {})
      .sort()
      .join() !== 'assetsRaw,destinationAddress,owner,routeKey'
  )
    throw Error('requested_native_request_invalid')
  request = normalizeRequest(request)
  const frozen = exactSubject(request)
  const id = queueId(request)
  ensureDir(dir)
  return withIntakeLock(dir, async () => {
    const prior = readQueue(dir)
    if (prior.some((row) => row.id === id)) return { status: 'already_queued', id }
    if (prior.length >= MAX_ISSUES) throw Error('requested_native_queue_limit')
    const state = await verify(studyDir)
    const failures = readFailures(dir)
    const scored = new Set(state.scores.map((row) => `${row.issueId}:${row.horizonHours}`))
    const activeIds = new Set()
    for (const studyIssue of state.issues) {
      if (
        studyIssue.targets.some(
          (target) => !scored.has(`${studyIssue.issueId}:${target.horizonHours}`),
        )
      )
        activeIds.add(queueId(studyIssue.request))
    }
    for (const row of prior) {
      if (
        !state.issues.some((studyIssue) => queueId(studyIssue.request) === row.id) &&
        failures.get(row.id)?.at(-1)?.nextAttemptAtMs !== null
      )
        activeIds.add(row.id)
    }
    if (activeIds.size >= MAX_ACTIVE_WATCHES) throw Error('requested_native_active_limit')
    const queuedAtMs = now()
    if (!Number.isSafeInteger(queuedAtMs) || queuedAtMs < 0)
      throw Error('requested_native_time_invalid')
    const body = { schemaVersion: 1, id, request, frozen, queuedAtMs }
    const record = { ...body, sha256: sha(canonical(body)) }
    const bytes = `${canonical(record)}\n`
    if (Buffer.byteLength(bytes) > MAX_REQUEST_BYTES)
      throw Error('requested_native_record_oversize')
    const temp = join(dir, `.requested-${randomUUID()}.tmp`)
    const target = join(dir, `${id}.json`)
    let fd
    try {
      fd = openSync(
        temp,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      )
      writeFileSync(fd, bytes)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      linkSync(temp, target)
      const directory = openSync(dir, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        fsyncSync(directory)
      } finally {
        closeSync(directory)
      }
    } finally {
      if (fd !== undefined) closeSync(fd)
      if (existsSync(temp)) unlinkSync(temp)
    }
    return { status: 'queued', id }
  })
}

export function configuredOrigins(raw) {
  const urls = String(raw ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  const selected = ORIGIN_OPERATORS.map((operator) =>
    urls.find((url) => {
      try {
        return originHost(url) === operator
      } catch {
        return false
      }
    }),
  )
  if (selected.some((x) => !x) || selected[0] === selected[1])
    throw Error('requested_native_two_origins_required')
  return selected
}

export async function statusForRequest(
  request,
  { dir = QUEUE_DIR, studyDir = STUDY_DIR, now = Date.now } = {},
) {
  if (
    Object.keys(request ?? {})
      .sort()
      .join() !== 'assetsRaw,destinationAddress,owner,routeKey'
  )
    throw Error('requested_native_request_invalid')
  exactSubject(request)
  const id = queueId(request)
  const queue = readQueue(dir)
  const failures = readFailures(dir)
  const state = await verify(studyDir)
  const queued = queue.some((row) => row.id === id)
  const studyIssue = state.issues.find((row) => queueId(row.request) === id)
  const failure = failures.get(id)?.at(-1)
  const intakeState = studyIssue
    ? 'issued'
    : !queued
      ? 'absent'
      : failure?.nextAttemptAtMs === null
        ? 'exhausted'
        : failure?.terminal && now() < failure.nextAttemptAtMs
          ? 'quarantined'
          : failure
            ? 'retrying'
            : 'queued'
  const horizons = [1, 24].map((horizonHours) => {
    const observed =
      studyIssue &&
      state.scores.find(
        (row) => row.issueId === studyIssue.issueId && row.horizonHours === horizonHours,
      )
    return {
      horizonHours,
      state: observed?.outcome ?? (studyIssue ? 'pending' : intakeState),
    }
  })
  return {
    id,
    state: intakeState,
    horizons,
    forecastValidated: false,
  }
}

export function compareDueTargets(a, b, tickAt, attemptsByTarget) {
  const aDeadline = Date.parse(a.target.deadlineUtc)
  const bDeadline = Date.parse(b.target.deadlineUtc)
  const aExpired = aDeadline < tickAt
  const bExpired = bDeadline < tickAt
  const aCount = attemptsByTarget.get(`${a.row.issueId}:${a.target.horizonHours}`)?.count ?? 0
  const bCount = attemptsByTarget.get(`${b.row.issueId}:${b.target.horizonHours}`)?.count ?? 0
  return Number(aExpired) - Number(bExpired) || aDeadline - bDeadline || aCount - bCount
}

export async function tick({
  dir = QUEUE_DIR,
  studyDir = STUDY_DIR,
  now = Date.now,
  originUrls,
  clients,
  readQuote,
  singleAction = false,
} = {}) {
  const queue = readQueue(dir)
  const failures = readFailures(dir)
  const state = await verify(studyDir)
  const issuedIds = new Set(state.issues.map((row) => queueId(row.request)))
  const tickAt = now()
  const next = queue.find((row) => {
    const failure = failures.get(row.id)?.at(-1)
    return (
      !issuedIds.has(row.id) &&
      (!failure || (failure.nextAttemptAtMs !== null && failure.nextAttemptAtMs <= tickAt))
    )
  })
  let issued = 0
  let scored = 0
  let pending = 0
  let intakeFailed = 0
  // Score existing due targets before an intake RPC can fail.
  const scoredKeys = new Set(state.scores.map((row) => `${row.issueId}:${row.horizonHours}`))
  const attemptsByTarget = new Map()
  for (const attempt of state.attempts) {
    const key = `${attempt.issueId}:${attempt.horizonHours}`
    const prior = attemptsByTarget.get(key) ?? { count: 0, latest: 0 }
    attemptsByTarget.set(key, {
      count: prior.count + 1,
      latest: Math.max(prior.latest, Date.parse(attempt.attemptedAtUtc)),
    })
  }
  const due = state.issues
    .flatMap((row) => row.targets.map((target) => ({ row, target })))
    .filter(({ row, target }) => {
      const key = `${row.issueId}:${target.horizonHours}`
      const attempts = attemptsByTarget.get(key) ?? { count: 0, latest: 0 }
      const expired = tickAt > Date.parse(target.deadlineUtc)
      return (
        !scoredKeys.has(key) &&
        Date.parse(target.targetAtUtc) <= tickAt &&
        (expired || (attempts.count < 2 && tickAt - attempts.latest >= 30 * 60_000))
      )
    })
    .sort((a, b) => compareDueTargets(a, b, tickAt, attemptsByTarget))
    .slice(0, singleAction ? 1 : 3)
  for (const { row, target } of due) {
    const result = await score({
      issueId: row.issueId,
      horizonHours: target.horizonHours,
      request: row.request,
      clients,
      originUrls,
      dir: studyDir,
      now,
      readQuote,
    })
    if (result.status === 'pending') pending++
    else scored++
  }
  // Capture at most one queued request per tick. The tuple was durable before RPC.
  if (next && (!singleAction || due.length === 0)) {
    if (state.issues.length >= MAX_ISSUES) throw Error('requested_native_issue_limit')
    try {
      await issue({ request: next.request, clients, originUrls, dir: studyDir, now, readQuote })
      issued = 1
    } catch {
      appendFailure(dir, next.id, failures.get(next.id) ?? [], tickAt)
      intakeFailed = 1
    }
  }
  return { queued: queue.length, issued, scored, pending, intakeFailed, forecastValidated: false }
}

async function main() {
  const mode = process.argv[2]
  if (mode === '--enqueue' && process.argv.length === 3) {
    let raw = ''
    for await (const chunk of process.stdin) {
      raw += chunk
      if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) throw Error('requested_native_input_oversize')
    }
    const result = await enqueue(JSON.parse(raw))
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } else if (mode === '--tick' && process.argv.length === 3) {
    // Avoid secret-bearing URLs and provider exception text in scheduler logs.
    const raw = process.env.RECORDER_RPC_URL ?? readEnv().get('RECORDER_RPC_URL')
    const originUrls = configuredOrigins(raw)
    const clients = originUrls.map((url) =>
      createPublicClient({
        chain: mainnet,
        transport: http(url, { timeout: 8000, retryCount: 0 }),
      }),
    )
    process.stdout.write(
      `${JSON.stringify(
        await tick({
          originUrls,
          clients,
          singleAction: process.env.MORPHO_REQUESTED_SINGLE_ACTION === '1',
        }),
      )}\n`,
    )
  } else if (mode === '--verify' && process.argv.length === 3) {
    const queue = readQueue()
    const state = await verify()
    process.stdout.write(
      `${JSON.stringify({ queued: queue.length, issues: state.issues.length, scores: state.scores.length, attempts: state.attempts.length })}\n`,
    )
  } else throw Error('requested_native_usage')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.umask(0o077)
  main().catch(() => {
    process.stderr.write('requested_native_failed\n')
    process.exitCode = 1
  })
}
