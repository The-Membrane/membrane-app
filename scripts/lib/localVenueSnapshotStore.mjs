// Bounded, append-only fallback for finalized venue market observations when
// the database cannot accept the hourly recorder pass. These are point-in-time
// measurements; a gap between files is not evidence of zero flow or continuity.
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  openSync,
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statfsSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const LOCAL_VENUE_SNAPSHOT_ROOT = resolve(
  'data/research/venue-signals/local-market-snapshots',
)
export const LOCAL_VENUE_SNAPSHOT_STUDY = 'venue-finalized-market-snapshots-v1'
export const MAX_LOCAL_SNAPSHOTS_PER_VENUE = 100_000
export const MAX_LOCAL_SNAPSHOT_BYTES = 64 * 1024
const MAX_LOCAL_ATTEMPT_BYTES = 2048
const ATTEMPT_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const MIN_LOCAL_SNAPSHOT_FREE_BYTES = 1024 * 1024 * 1024
const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/
const VENUE_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/
const FILE_NAME = /^(\d{12})\.json$/
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const filename = (sequence) => `${String(sequence).padStart(12, '0')}.json`

function canonicalUtc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
    throw new Error('local_snapshot_invalid_time')
  if (new Date(value).toISOString() !== value) throw new Error('local_snapshot_invalid_time')
  return value
}

function finiteOrNull(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error('local_snapshot_invalid_measured_usd')
  return value
}

function rawOrNull(value) {
  if (value === null || value === undefined) return null
  if (!/^\d+$/.test(String(value))) throw new Error('local_snapshot_invalid_raw_balance')
  return String(value)
}

function validatedInput(input) {
  if (!VENUE_NAME.test(input?.venue ?? '')) throw new Error('local_snapshot_invalid_venue')
  if (!VENUE_NAME.test(input?.chain ?? '')) throw new Error('local_snapshot_invalid_chain')
  const { source, params } = input
  if (
    !source ||
    !/^\d+$/.test(String(source.block ?? '')) ||
    !BLOCK_HASH.test(source.hash ?? '') ||
    !Number.isSafeInteger(source.timestamp) ||
    source.timestamp <= 0 ||
    source.finalized !== true ||
    source.pinned !== true ||
    !params ||
    typeof params !== 'object' ||
    Array.isArray(params) ||
    params.read_block_finalized !== true ||
    params.read_block_pinned !== true ||
    String(params.read_block_number) !== String(source.block) ||
    params.read_block_hash !== source.hash ||
    params.read_block_time !== source.timestamp
  )
    throw new Error('local_snapshot_unsealed_source')
  const observedAtUtc = canonicalUtc(input.observedAtUtc)
  if (Date.parse(observedAtUtc) + 120_000 < source.timestamp * 1000)
    throw new Error('local_snapshot_observed_before_source')
  return {
    venue: input.venue,
    chain: input.chain,
    source: {
      block: String(source.block),
      hash: source.hash,
      timestamp: source.timestamp,
      finalized: true,
      pinned: true,
    },
    observedAtUtc,
    ...(input.localAttemptToken === undefined
      ? {}
      : ATTEMPT_TOKEN.test(input.localAttemptToken)
        ? { localAttemptToken: input.localAttemptToken }
        : (() => {
            throw new Error('local_snapshot_attempt_token_invalid')
          })()),
    measurement: {
      instantUsd: finiteOrNull(input.instantUsd),
      coolingUsd: finiteOrNull(input.coolingUsd),
      strandedUsd: finiteOrNull(input.strandedUsd),
      depthUsd: finiteOrNull(params.depth_usd),
      totalAssetsRaw: rawOrNull(params.totalAssets),
      totalSupplyRaw: rawOrNull(params.totalSupply),
      underlyingBalanceRaw: rawOrNull(params.underlyingBalance),
      params,
    },
  }
}

function numberDelta(before, after) {
  if (before === null || after === null) return null
  return {
    previous: before,
    current: after,
    absolute: after - before,
    percent: before === 0 ? null : ((after - before) / Math.abs(before)) * 100,
  }
}

function rawDelta(before, after) {
  if (before === null || after === null) return null
  return {
    previous: before,
    current: after,
    absolute: (BigInt(after) - BigInt(before)).toString(),
    percent:
      before === '0' ? null : (Number(BigInt(after) - BigInt(before)) / Number(before)) * 100,
  }
}

function comparison(previous, next) {
  if (!previous)
    return {
      status: 'no_previous_observation',
      previousSequence: null,
      previousBlock: null,
      elapsedSourceSeconds: null,
      deltas: null,
      flowStatus: 'not_measured',
      continuity: 'not_established',
    }
  const a = previous.measurement
  const b = next.measurement
  return {
    status: 'two_observed_points',
    previousSequence: previous.sequence,
    previousBlock: previous.source.block,
    elapsedSourceSeconds: next.source.timestamp - previous.source.timestamp,
    deltas: {
      instantUsd: numberDelta(a.instantUsd, b.instantUsd),
      coolingUsd: numberDelta(a.coolingUsd, b.coolingUsd),
      strandedUsd: numberDelta(a.strandedUsd, b.strandedUsd),
      depthUsd: numberDelta(a.depthUsd, b.depthUsd),
      totalAssetsRaw: rawDelta(a.totalAssetsRaw, b.totalAssetsRaw),
      totalSupplyRaw: rawDelta(a.totalSupplyRaw, b.totalSupplyRaw),
      underlyingBalanceRaw: rawDelta(a.underlyingBalanceRaw, b.underlyingBalanceRaw),
    },
    flowStatus: 'not_measured',
    continuity: 'not_established',
  }
}

function readRecord(path) {
  const stats = lstatSync(path)
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_LOCAL_SNAPSHOT_BYTES)
    throw new Error('local_snapshot_invalid_file')
  const bytes = readFileSync(path, 'utf8')
  if (Buffer.byteLength(bytes) > MAX_LOCAL_SNAPSHOT_BYTES)
    throw new Error('local_snapshot_size_limit')
  const record = JSON.parse(bytes)
  if (bytes !== `${JSON.stringify(record)}\n`)
    throw new Error('local_snapshot_physical_bytes_mismatch')
  const { sha256, ...body } = record
  if (sha256 !== sha(JSON.stringify(body))) throw new Error('local_snapshot_sha_mismatch')
  if (record.study !== LOCAL_VENUE_SNAPSHOT_STUDY) throw new Error('local_snapshot_study_mismatch')
  return record
}

function verifyRecordBody(record, previous) {
  const normalized = validatedInput({
    venue: record.venue,
    chain: record.chain,
    source: record.source,
    observedAtUtc: record.observedAtUtc,
    ...(record.localAttemptToken === undefined
      ? {}
      : { localAttemptToken: record.localAttemptToken }),
    params: record.measurement?.params,
    instantUsd: record.measurement?.instantUsd,
    coolingUsd: record.measurement?.coolingUsd,
    strandedUsd: record.measurement?.strandedUsd,
  })
  if (
    JSON.stringify(normalized.source) !== JSON.stringify(record.source) ||
    JSON.stringify(normalized.measurement) !== JSON.stringify(record.measurement) ||
    canonicalUtc(record.firstLocalReceiptAtUtc) < record.observedAtUtc ||
    (previous && record.firstLocalReceiptAtUtc < previous.firstLocalReceiptAtUtc)
  )
    throw new Error('local_snapshot_body_mismatch')
  if (JSON.stringify(record.comparison) !== JSON.stringify(comparison(previous, record)))
    throw new Error('local_snapshot_comparison_mismatch')
}

function namesForVenue(dir) {
  if (!existsSync(dir)) return []
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
  if (names.length > MAX_LOCAL_SNAPSHOTS_PER_VENUE) throw new Error('local_snapshot_count_limit')
  for (const [index, name] of names.entries()) {
    if (!FILE_NAME.test(name) || name !== filename(index + 1))
      throw new Error('local_snapshot_sequence_gap')
  }
  return names
}

function diskGuard(out, proposedBytes, stat = statfsSync) {
  let ancestor = out
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new Error('local_snapshot_no_output_ancestor')
    ancestor = parent
  }
  const disk = stat(ancestor)
  if (Number(disk.bavail) * Number(disk.bsize) - proposedBytes < MIN_LOCAL_SNAPSHOT_FREE_BYTES)
    throw new Error('local_snapshot_disk_reserve_reached')
}

export function verifyLocalVenueSnapshots(venue, out = LOCAL_VENUE_SNAPSHOT_ROOT) {
  if (!VENUE_NAME.test(venue)) throw new Error('local_snapshot_invalid_venue')
  const dir = join(out, venue)
  const names = namesForVenue(dir)
  let previous = null
  for (const [index, name] of names.entries()) {
    const record = readRecord(join(dir, name))
    if (
      record.venue !== venue ||
      record.sequence !== index + 1 ||
      record.previousSha256 !== (previous?.sha256 ?? null) ||
      (previous &&
        (BigInt(record.source.block) <= BigInt(previous.source.block) ||
          record.source.timestamp < previous.source.timestamp))
    )
      throw new Error('local_snapshot_chain_mismatch')
    verifyRecordBody(record, previous)
    previous = record
  }
  return { count: names.length, last: previous }
}

const attemptPath = (venue, out) => join(out, venue, 'latest-attempt')

function attemptIdentity(identity) {
  if (
    !identity ||
    !VENUE_NAME.test(identity.venue ?? '') ||
    !VENUE_NAME.test(identity.chain ?? '') ||
    typeof identity.kind !== 'string' ||
    !identity.kind ||
    typeof identity.address !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(identity.address) ||
    (identity.underlying != null && !/^0x[0-9a-fA-F]{40}$/.test(identity.underlying)) ||
    (identity.decimals != null &&
      (!Number.isSafeInteger(identity.decimals) || identity.decimals < 0))
  )
    throw new Error('local_snapshot_attempt_identity_invalid')
  return {
    venue: identity.venue,
    chain: identity.chain,
    kind: identity.kind,
    address: identity.address.toLowerCase(),
    underlying: identity.underlying?.toLowerCase() ?? null,
    decimals: identity.decimals ?? null,
  }
}

function writeAttempt(input, out) {
  const identity = attemptIdentity(input.identity)
  const attemptedAtUtc = canonicalUtc(input.attemptedAtUtc)
  const token = input.token
  if (!ATTEMPT_TOKEN.test(token)) throw new Error('local_snapshot_attempt_token_invalid')
  const lock = writerPath(identity.venue, out)
  if (!existsSync(lock)) throw new Error('local_snapshot_writer_ownership_missing')
  const owner = JSON.parse(readFileSync(lock, 'utf8'))
  if (owner.token !== token || JSON.stringify(owner.identity) !== JSON.stringify(identity))
    throw new Error('local_snapshot_writer_ownership_mismatch')
  if (!['capture_in_progress', 'capture_failed'].includes(input.status))
    throw new Error('local_snapshot_attempt_status_invalid')
  const body = {
    study: 'venue-finalized-market-attempt-v1',
    identity,
    status: input.status,
    attemptedAtUtc,
    token,
  }
  const record = { ...body, sha256: sha(JSON.stringify(body)) }
  const bytes = `${JSON.stringify(record)}\n`
  if (Buffer.byteLength(bytes) > MAX_LOCAL_ATTEMPT_BYTES)
    throw new Error('local_snapshot_attempt_size_limit')
  const dir = join(out, identity.venue)
  mkdirSync(dir, { recursive: true })
  const target = attemptPath(identity.venue, out)
  const temp = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    renameSync(temp, target)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
}

export function markLocalVenueSnapshotAttempt(input, out = LOCAL_VENUE_SNAPSHOT_ROOT) {
  writeAttempt(input, out)
}

const writerPath = (venue, out) => join(out, venue, 'writer-lock')

export function acquireLocalVenueSnapshotWriter(identityInput, out = LOCAL_VENUE_SNAPSHOT_ROOT) {
  const identity = attemptIdentity(identityInput)
  const dir = join(out, identity.venue)
  mkdirSync(dir, { recursive: true })
  const token = randomUUID()
  const lock = writerPath(identity.venue, out)
  let fd
  try {
    fd = openSync(lock, 'wx', 0o600)
    writeFileSync(
      fd,
      `${JSON.stringify({ token, identity, acquiredAtUtc: new Date().toISOString() })}\n`,
    )
    return token
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('local_snapshot_writer_busy')
    throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function releaseLocalVenueSnapshotWriter(venue, token, out = LOCAL_VENUE_SNAPSHOT_ROOT) {
  const lock = writerPath(venue, out)
  if (!existsSync(lock)) return false
  const stats = lstatSync(lock)
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_LOCAL_ATTEMPT_BYTES)
    throw new Error('local_snapshot_writer_lock_invalid')
  const owner = JSON.parse(readFileSync(lock, 'utf8'))
  if (owner.token !== token) return false
  unlinkSync(lock)
  return true
}

export function clearLocalVenueSnapshotAttempt(venue, token, out = LOCAL_VENUE_SNAPSHOT_ROOT) {
  const target = attemptPath(venue, out)
  if (!existsSync(target)) return
  const stats = lstatSync(target)
  if (!stats.isFile() || stats.isSymbolicLink())
    throw new Error('local_snapshot_attempt_not_regular_file')
  const attempt = readLocalVenueSnapshotAttempt(venue, null, out)
  if (attempt.token !== token) return false
  const { last } = verifyLocalVenueSnapshots(venue, out)
  if (last?.localAttemptToken !== token) return false
  unlinkSync(target)
  return true
}

export function readLocalVenueSnapshotAttempt(venue, identity, out = LOCAL_VENUE_SNAPSHOT_ROOT) {
  const target = attemptPath(venue, out)
  if (!existsSync(target)) {
    const lock = writerPath(venue, out)
    if (!existsSync(lock)) return null
    const lockStats = lstatSync(lock)
    if (
      !lockStats.isFile() ||
      lockStats.isSymbolicLink() ||
      lockStats.size > MAX_LOCAL_ATTEMPT_BYTES
    )
      throw new Error('local_snapshot_writer_lock_invalid')
    const owner = JSON.parse(readFileSync(lock, 'utf8'))
    if (!ATTEMPT_TOKEN.test(owner.token ?? '') || owner.identity?.venue !== venue)
      throw new Error('local_snapshot_writer_lock_invalid')
    if (identity && JSON.stringify(owner.identity) !== JSON.stringify(attemptIdentity(identity)))
      throw new Error('local_snapshot_writer_lock_identity_mismatch')
    canonicalUtc(owner.acquiredAtUtc)
    return {
      status: 'capture_in_progress',
      attemptedAtUtc: owner.acquiredAtUtc,
      token: owner.token,
    }
  }
  const stats = lstatSync(target)
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_LOCAL_ATTEMPT_BYTES)
    throw new Error('local_snapshot_attempt_invalid_file')
  const bytes = readFileSync(target, 'utf8')
  const record = JSON.parse(bytes)
  if (bytes !== `${JSON.stringify(record)}\n`)
    throw new Error('local_snapshot_attempt_bytes_mismatch')
  const { sha256, ...body } = record
  if (sha256 !== sha(JSON.stringify(body))) throw new Error('local_snapshot_attempt_sha_mismatch')
  if (
    body.study !== 'venue-finalized-market-attempt-v1' ||
    body.identity.venue !== venue ||
    (identity && JSON.stringify(body.identity) !== JSON.stringify(attemptIdentity(identity))) ||
    !['capture_in_progress', 'capture_failed'].includes(body.status)
  )
    throw new Error('local_snapshot_attempt_identity_mismatch')
  canonicalUtc(body.attemptedAtUtc)
  if (!ATTEMPT_TOKEN.test(body.token ?? '')) throw new Error('local_snapshot_attempt_token_invalid')
  return { status: body.status, attemptedAtUtc: body.attemptedAtUtc, token: body.token }
}

export function appendLocalVenueSnapshot(
  input,
  {
    out = LOCAL_VENUE_SNAPSHOT_ROOT,
    now = () => new Date(),
    stat = statfsSync,
    publish = linkSync,
    localAttemptToken,
  } = {},
) {
  const next = validatedInput({ ...input, ...(localAttemptToken ? { localAttemptToken } : {}) })
  const dir = join(out, next.venue)
  const { count, last: previous } = verifyLocalVenueSnapshots(next.venue, out)
  if (count >= MAX_LOCAL_SNAPSHOTS_PER_VENUE) throw new Error('local_snapshot_count_limit')
  if (previous && BigInt(next.source.block) <= BigInt(previous.source.block)) {
    if (next.source.block === previous.source.block && next.source.hash === previous.source.hash)
      return { status: 'already_recorded', record: previous }
    throw new Error('local_snapshot_nonmonotonic_source')
  }
  if (previous && next.source.timestamp < previous.source.timestamp)
    throw new Error('local_snapshot_source_time_regression')
  const firstLocalReceiptAtUtc = canonicalUtc(now().toISOString())
  if (firstLocalReceiptAtUtc < next.observedAtUtc)
    throw new Error('local_snapshot_receipt_before_observation')
  const body = {
    study: LOCAL_VENUE_SNAPSHOT_STUDY,
    sequence: count + 1,
    previousSha256: previous?.sha256 ?? null,
    ...next,
    firstLocalReceiptAtUtc,
    comparison: comparison(previous, next),
  }
  const record = { ...body, sha256: sha(JSON.stringify(body)) }
  const bytes = `${JSON.stringify(record)}\n`
  const size = Buffer.byteLength(bytes)
  if (size > MAX_LOCAL_SNAPSHOT_BYTES) throw new Error('local_snapshot_size_limit')
  diskGuard(out, size, stat)
  mkdirSync(dir, { recursive: true })
  const target = join(dir, filename(record.sequence))
  const temp = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    publish(temp, target)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  return { status: 'recorded', record }
}

export async function runDatabaseOrLocal(databaseTask, localTask) {
  try {
    return { sink: 'database', result: await databaseTask() }
  } catch {
    return { sink: 'local', result: await localTask() }
  }
}
