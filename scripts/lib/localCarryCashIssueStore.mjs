// Local prospective persistence baseline for the frozen Carry cash cohort.
// Self-sealed on one Mac: hashes detect later edits, but do not attest the clock
// or provide an independent publication timestamp.
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
  rmdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import {
  localCarryCashObservationsFromVerified,
  readLocalCarryCashObservations,
} from './localCarryCashStore.mjs'

export const LOCAL_CARRY_ISSUE_ROOT = resolve(
  'data/research/venue-signals/local-carry-cash-issues-v1',
)
const HOUR = 3_600_000
const SHA = /^[0-9a-f]{64}$/
const MIN_FREE = 1024 * 1024 * 1024
const MAX_BYTES = 256 * 1024
const MAX_REPLAY_TIMES = 4096
const hash = (value) => createHash('sha256').update(value).digest('hex')
const filename = (n) => `${String(n).padStart(12, '0')}.json`
const subjectKey = (route, destination) => `${route}\0${destination}`

function time(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(parsed) ||
    new Date(value).toISOString() !== value
  )
    throw new Error('local_cash_issue_bad_time')
  return parsed
}

function replayTime() {
  // Only fully validated canonical timestamps survive within this invocation.
  // Bound memory even when replaying a ledger with many distinct timestamps.
  const cache = new Map()
  return (value) => {
    if (cache.has(value)) return cache.get(value)
    const parsed = time(value)
    if (cache.size === MAX_REPLAY_TIMES) cache.delete(cache.keys().next().value)
    cache.set(value, parsed)
    return parsed
  }
}

function currentObservations(manifest, cashRoot, verifiedCash = null) {
  const observations = verifiedCash
    ? localCarryCashObservationsFromVerified(verifiedCash)
    : readLocalCarryCashObservations(manifest, cashRoot)
  return observations.filter(
    (receipt) =>
      receipt.collectionMode === 'current' &&
      receipt.evidenceKind === 'current_finalized_observation',
  )
}

function subjectRow(receipt, subject) {
  return receipt.subjects.find(
    (row) => row.routeKey === subject.route_key && row.destination === subject.destination,
  )
}

function identity(row, subject) {
  return (
    row?.state === 'observed' &&
    row.asset === subject.asset &&
    Number.isInteger(row.assetDecimals) &&
    row.assetDecimals >= 0 &&
    row.assetDecimals <= 255 &&
    typeof row.cashRaw === 'string' &&
    /^\d+$/.test(row.cashRaw)
  )
}

export function buildIssueAttempts(manifest, observations, issuedAt) {
  return issueAttempts(manifest, observations, issuedAt, replayTime())
}

function issueAttempts(manifest, observations, issuedAt, time) {
  const issuedMs = time(issuedAt)
  const attempts = []
  for (const subject of manifest.subjects) {
    const candidates = observations
      .filter((receipt) => {
        const observed = time(receipt.source.blockAt)
        const received = time(receipt.firstLocalReceiptAt)
        return (
          receipt.collectionMode === 'current' &&
          receipt.evidenceKind === 'current_finalized_observation' &&
          receipt.manifestSha256 === manifest.sha256 &&
          received <= issuedMs &&
          observed <= issuedMs &&
          issuedMs - observed <= 2 * HOUR &&
          received >= observed
        )
      })
      .sort(
        (a, b) =>
          time(b.source.blockAt) - time(a.source.blockAt) ||
          time(b.firstLocalReceiptAt) - time(a.firstLocalReceiptAt),
      )
    const receipt = candidates[0]
    const row = receipt && subjectRow(receipt, subject)
    const usable = receipt && identity(row, subject)
    for (const horizonHours of [1, 24]) {
      const targetMs = issuedMs + horizonHours * HOUR
      const halfWindow = horizonHours === 1 ? 15 * 60_000 : HOUR
      attempts.push({
        routeKey: subject.route_key,
        destination: subject.destination,
        asset: subject.asset,
        horizonHours,
        status: usable ? 'issued' : row?.state === 'unassessed' ? 'unassessed' : 'source_missing',
        targetAt: new Date(targetMs).toISOString(),
        targetLowAt: new Date(targetMs - halfWindow).toISOString(),
        targetHighAt: new Date(targetMs + halfWindow).toISOString(),
        source: usable
          ? {
              receiptSha256: receipt.receiptSha256,
              firstLocalReceiptAt: receipt.firstLocalReceiptAt,
              block: receipt.source.block,
              blockHash: receipt.source.blockHash,
              blockAt: receipt.source.blockAt,
              assetDecimals: row.assetDecimals,
              cashRaw: row.cashRaw,
            }
          : null,
        forecastCashRaw: usable ? row.cashRaw : null,
      })
    }
  }
  if (attempts.length !== 134) throw new Error('local_cash_issue_manifest_count')
  return attempts
}

export function buildScoreAttempts(issue, manifest, observations, scoredAt, horizonHours = null) {
  return scoreAttempts(issue, manifest, observations, scoredAt, horizonHours, replayTime())
}

function scoreAttempts(issue, manifest, observations, scoredAt, horizonHours, time) {
  const scoreMs = time(scoredAt)
  const issueMs = time(issue.issuedAt)
  const attempts =
    horizonHours === null
      ? issue.attempts
      : issue.attempts.filter((attempt) => attempt.horizonHours === horizonHours)
  return attempts.map((attempt) => {
    if (attempt.status !== 'issued') return null
    const highMs = time(attempt.targetHighAt)
    // Wait one hour after the high boundary for delayed receipt, then censor.
    if (scoreMs < highMs + HOUR) return null
    const subject = manifest.subjects.find(
      (row) =>
        subjectKey(row.route_key, row.destination) ===
        subjectKey(attempt.routeKey, attempt.destination),
    )
    if (!subject) throw new Error('local_cash_score_unknown_subject')
    const targetMs = time(attempt.targetAt)
    const options = observations
      .flatMap((receipt) => {
        const blockMs = time(receipt.source.blockAt)
        const receiptMs = time(receipt.firstLocalReceiptAt)
        if (
          receipt.collectionMode !== 'current' ||
          receipt.evidenceKind !== 'current_finalized_observation' ||
          receipt.manifestSha256 !== manifest.sha256 ||
          receiptMs <= issueMs ||
          receiptMs > scoreMs ||
          receiptMs > highMs + HOUR ||
          blockMs < time(attempt.targetLowAt) ||
          blockMs > highMs ||
          blockMs <= time(attempt.source.blockAt) ||
          receiptMs < blockMs
        )
          return []
        const row = subjectRow(receipt, subject)
        if (!identity(row, subject) || row.assetDecimals !== attempt.source.assetDecimals) return []
        return [{ receipt, row, blockMs }]
      })
      .sort(
        (a, b) =>
          Math.abs(a.blockMs - targetMs) - Math.abs(b.blockMs - targetMs) || a.blockMs - b.blockMs,
      )
    const best = options[0]
    return {
      routeKey: attempt.routeKey,
      destination: attempt.destination,
      horizonHours: attempt.horizonHours,
      status: best ? 'scored' : 'censored_no_target',
      target: best
        ? {
            receiptSha256: best.receipt.receiptSha256,
            firstLocalReceiptAt: best.receipt.firstLocalReceiptAt,
            block: best.receipt.source.block,
            blockHash: best.receipt.source.blockHash,
            blockAt: best.receipt.source.blockAt,
            asset: best.row.asset,
            assetDecimals: best.row.assetDecimals,
            cashRaw: best.row.cashRaw,
          }
        : null,
      absoluteErrorRaw: best
        ? (BigInt(best.row.cashRaw) >= BigInt(attempt.forecastCashRaw)
            ? BigInt(best.row.cashRaw) - BigInt(attempt.forecastCashRaw)
            : BigInt(attempt.forecastCashRaw) - BigInt(best.row.cashRaw)
          ).toString()
        : null,
    }
  })
}

function canonical(path) {
  const bytes = readFileSync(path, 'utf8')
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('local_cash_issue_oversize')
  const record = JSON.parse(bytes)
  if (bytes !== `${JSON.stringify(record)}\n`) throw new Error('local_cash_issue_noncanonical')
  const { sha256, ...body } = record
  if (!SHA.test(sha256 ?? '') || hash(JSON.stringify(body)) !== sha256)
    throw new Error('local_cash_issue_hash_mismatch')
  return record
}

export function verifyLocalCashIssueLedger(
  manifest,
  cashRoot,
  root = LOCAL_CARRY_ISSUE_ROOT,
  verifiedCash = null,
) {
  const time = replayTime()
  if (verifiedCash?.records.some((record) => record.manifestSha256 !== manifest.sha256))
    throw new Error('local_cash_issue_verified_manifest')
  const observations = currentObservations(manifest, cashRoot, verifiedCash)
  if (!existsSync(root)) return { count: 0, last: null, records: [], observations }
  const files = readdirSync(root)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
  if (files.length > 10_000) throw new Error('local_cash_issue_count_limit')
  const records = []
  const issues = new Map()
  const scoreKeys = new Set()
  for (const [index, file] of files.entries()) {
    if (file !== filename(index + 1)) throw new Error('local_cash_issue_sequence_gap')
    const record = canonical(join(root, file))
    if (
      record.sequence !== index + 1 ||
      record.previousSha256 !== (records.at(-1)?.sha256 ?? null) ||
      record.manifestSha256 !== manifest.sha256
    )
      throw new Error('local_cash_issue_chain_identity')
    if (record.kind === 'issue') {
      time(record.issuedAt)
      if (
        issues.has(record.slotAt) ||
        record.clock !== 'local_mac_wall_clock_unanchored' ||
        record.model !== 'persistence_raw_cash_v1' ||
        record.slotAt !== new Date(Math.floor(time(record.issuedAt) / HOUR) * HOUR).toISOString() ||
        JSON.stringify(record.attempts) !==
          JSON.stringify(issueAttempts(manifest, observations, record.issuedAt, time))
      )
        throw new Error('local_cash_issue_replay_mismatch')
      issues.set(record.slotAt, record)
    } else if (record.kind === 'score') {
      time(record.scoredAt)
      const issue = issues.get(record.issueSlotAt)
      // Old score records contain both horizons and no horizonHours field.
      // New records score one horizon as soon as its capture window closes.
      const legacy = !Object.hasOwn(record, 'horizonHours')
      const horizons = legacy ? [1, 24] : [record.horizonHours]
      const attempts =
        issue?.attempts.filter(
          (attempt) => legacy || attempt.horizonHours === record.horizonHours,
        ) ?? []
      if (
        !issue ||
        (!legacy && record.horizonHours !== 1 && record.horizonHours !== 24) ||
        record.clock !== 'local_mac_wall_clock_unanchored' ||
        record.issueSha256 !== issue.sha256 ||
        horizons.some((horizon) => scoreKeys.has(`${record.issueSlotAt}\0${horizon}`)) ||
        !attempts.some((attempt) => attempt.status === 'issued') ||
        !attempts.every(
          (attempt) =>
            attempt.status !== 'issued' ||
            time(record.scoredAt) >= time(attempt.targetHighAt) + HOUR,
        ) ||
        record.attempts.length !== (legacy ? 134 : 67) ||
        JSON.stringify(record.attempts) !==
          JSON.stringify(
            scoreAttempts(
              issue,
              manifest,
              observations,
              record.scoredAt,
              legacy ? null : record.horizonHours,
              time,
            ),
          )
      )
        throw new Error('local_cash_score_replay_mismatch')
      for (const horizon of horizons) scoreKeys.add(`${record.issueSlotAt}\0${horizon}`)
    } else throw new Error('local_cash_issue_kind')
    records.push(record)
  }
  return { count: records.length, last: records.at(-1) ?? null, records, observations }
}

/** Reuse a canonical cash verification result without scanning its files again. */
export function verifyLocalCashIssueLedgerFromVerified(
  manifest,
  verifiedCash,
  root = LOCAL_CARRY_ISSUE_ROOT,
) {
  return verifyLocalCashIssueLedger(manifest, null, root, verifiedCash)
}

function reserve(root, bytes) {
  let path = root
  while (!existsSync(path)) {
    const parent = dirname(path)
    if (parent === path) throw new Error('local_cash_issue_disk_root')
    path = parent
  }
  const fs = statfsSync(path)
  if (Number(fs.bavail) * Number(fs.bsize) - bytes < MIN_FREE)
    throw new Error('local_cash_issue_disk_reserve')
}

function append(body, manifest, cashRoot, root) {
  mkdirSync(dirname(root), { recursive: true })
  const lock = `${root}.lock`
  mkdirSync(lock)
  try {
    const prior = verifyLocalCashIssueLedger(manifest, cashRoot, root)
    if (
      body.kind === 'issue' &&
      prior.records.some((row) => row.kind === 'issue' && row.slotAt === body.slotAt)
    )
      return { status: 'already_recorded', count: prior.count }
    if (
      body.kind === 'score' &&
      prior.records.some(
        (row) =>
          row.kind === 'score' &&
          row.issueSlotAt === body.issueSlotAt &&
          (!Object.hasOwn(row, 'horizonHours') || row.horizonHours === body.horizonHours),
      )
    )
      return { status: 'already_recorded', count: prior.count }
    if (prior.count >= 10_000) throw new Error('local_cash_issue_count_limit')
    const core = {
      sequence: prior.count + 1,
      previousSha256: prior.last?.sha256 ?? null,
      manifestSha256: manifest.sha256,
      ...body,
    }
    const record = { ...core, sha256: hash(JSON.stringify(core)) }
    const bytes = `${JSON.stringify(record)}\n`
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('local_cash_issue_oversize')
    reserve(root, Buffer.byteLength(bytes))
    mkdirSync(root, { recursive: true })
    const tmp = join(root, `.${randomUUID()}.tmp`)
    let fd
    try {
      fd = openSync(tmp, 'wx', 0o600)
      writeFileSync(fd, bytes)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      linkSync(tmp, join(root, filename(record.sequence)))
    } finally {
      if (fd !== undefined) closeSync(fd)
      if (existsSync(tmp)) unlinkSync(tmp)
    }
    return { status: 'recorded', count: record.sequence, sha256: record.sha256 }
  } finally {
    if (existsSync(lock)) rmdirSync(lock)
  }
}

export function issueLocalCash(
  manifest,
  cashRoot,
  root = LOCAL_CARRY_ISSUE_ROOT,
  now = new Date().toISOString(),
) {
  const prior = verifyLocalCashIssueLedger(manifest, cashRoot, root)
  const slotAt = new Date(Math.floor(time(now) / HOUR) * HOUR).toISOString()
  const attempts = buildIssueAttempts(manifest, prior.observations, now)
  return append(
    {
      kind: 'issue',
      slotAt,
      issuedAt: now,
      clock: 'local_mac_wall_clock_unanchored',
      model: 'persistence_raw_cash_v1',
      attempts,
    },
    manifest,
    cashRoot,
    root,
  )
}

export function scoreLocalCash(
  manifest,
  cashRoot,
  root = LOCAL_CARRY_ISSUE_ROOT,
  now = new Date().toISOString(),
) {
  const prior = verifyLocalCashIssueLedger(manifest, cashRoot, root)
  const existing = new Set(
    prior.records
      .filter((row) => row.kind === 'score')
      .flatMap((row) =>
        (Object.hasOwn(row, 'horizonHours') ? [row.horizonHours] : [1, 24]).map(
          (horizon) => `${row.issueSlotAt}\0${horizon}`,
        ),
      ),
  )
  const due = prior.records
    .filter((row) => row.kind === 'issue')
    .flatMap((issue) =>
      [1, 24]
        .filter((horizonHours) => {
          const attempts = issue.attempts.filter((attempt) => attempt.horizonHours === horizonHours)
          return (
            !existing.has(`${issue.slotAt}\0${horizonHours}`) &&
            attempts.some((attempt) => attempt.status === 'issued') &&
            attempts.every(
              (attempt) =>
                attempt.status !== 'issued' || time(now) >= time(attempt.targetHighAt) + HOUR,
            )
          )
        })
        .map((horizonHours) => ({ issue, horizonHours })),
    )
  const results = []
  for (const { issue, horizonHours } of due.slice(0, 4)) {
    results.push(
      append(
        {
          kind: 'score',
          horizonHours,
          issueSlotAt: issue.slotAt,
          issueSha256: issue.sha256,
          scoredAt: now,
          clock: 'local_mac_wall_clock_unanchored',
          attempts: buildScoreAttempts(issue, manifest, prior.observations, now, horizonHours),
        },
        manifest,
        cashRoot,
        root,
      ),
    )
  }
  return { due: due.length, results }
}
