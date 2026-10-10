import { boundedReceiptBudget, readBoundedReceiptFile } from './boundedLocalReceiptFile.mjs'
// Immutable local receipts for the frozen August Carry cash cohort.
// Each receipt is one complete 67-subject finalized-block batch. The chain is
// in first-local-receipt order; retrospective anchors are never disguised as
// prospective observations or as holder-executable exits.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { validateBatch, validateManifest } from '../backfill-carry-cash-archive.mjs'

export const LOCAL_CARRY_CASH_ROOT = resolve('data/research/venue-signals/local-carry-cash-v1')
export const LOCAL_CARRY_CASH_STUDY = 'carry-aug-2026-67-subject-finalized-cash-v1'
const FILE = /^(\d{12})\.json$/
const SHA = /^[0-9a-f]{64}$/
const BLOCK_HASH = /^0x[0-9a-f]{64}$/
const MIN_FREE_BYTES = 1024 * 1024 * 1024
const MAX_RECEIPTS = 10_000
const MAX_RECORD_BYTES = 128 * 1024
const sha = (value) => createHash('sha256').update(value).digest('hex')
const name = (sequence) => `${String(sequence).padStart(12, '0')}.json`

function utc(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    new Date(value).toISOString() !== value
  )
    throw new Error('carry_cash_local_invalid_time')
  return value
}

function canonicalFile(path, budget) {
  const bytes = readBoundedReceiptFile(path, budget)
  if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES)
    throw new Error('carry_cash_local_record_oversize')
  const record = JSON.parse(bytes)
  if (bytes !== `${JSON.stringify(record)}\n`) throw new Error('carry_cash_local_physical_bytes')
  const { sha256, ...body } = record
  if (!SHA.test(sha256 ?? '') || sha(JSON.stringify(body)) !== sha256)
    throw new Error('carry_cash_local_hash_mismatch')
  return record
}

function validateReceipt(record, previous, manifest) {
  if (
    record.study !== LOCAL_CARRY_CASH_STUDY ||
    record.sequence !== (previous?.sequence ?? 0) + 1 ||
    record.previousSha256 !== (previous?.sha256 ?? null) ||
    record.manifestSha256 !== manifest.sha256 ||
    !['current', 'retrospective'].includes(record.collectionMode) ||
    record.metric !== 'aggregate_underlying_cash_raw_proxy' ||
    record.holderExitAbility !== 'not_measured' ||
    record.competingFlow !== 'not_measured' ||
    record.chainId !== 1 ||
    !/^\d+$/.test(record.block ?? '') ||
    !BLOCK_HASH.test(record.blockHash ?? '') ||
    !Number.isSafeInteger(record.blockTimestamp) ||
    record.blockTimestamp < 1 ||
    utc(record.blockAt) !== new Date(record.blockTimestamp * 1000).toISOString() ||
    utc(record.anchorAt) !== record.anchorAt ||
    utc(record.firstLocalReceiptAt) !== record.firstLocalReceiptAt ||
    Date.parse(record.firstLocalReceiptAt) < record.blockTimestamp * 1000 ||
    (previous && record.firstLocalReceiptAt < previous.firstLocalReceiptAt) ||
    (record.collectionMode === 'current' && record.anchorAt !== record.blockAt) ||
    (record.collectionMode === 'retrospective' &&
      Date.parse(record.anchorAt) < record.blockTimestamp * 1000)
  )
    throw new Error('carry_cash_local_receipt_identity')
  const block = { number: BigInt(record.block), hash: record.blockHash, at: record.blockAt }
  validateBatch(record.rows, record.anchorAt, block, manifest)
  if (record.rows.some((row) => row.state === 'read_unavailable'))
    throw new Error('carry_cash_local_transient_read')
  const counts = Object.fromEntries(
    ['observed', 'no_code', 'identity_mismatch', 'unassessed'].map((state) => [
      state,
      record.rows.filter((row) => row.state === state).length,
    ]),
  )
  if (
    JSON.stringify(counts) !== JSON.stringify(record.coverage) ||
    Object.values(counts).reduce((a, b) => a + b, 0) !== 67
  )
    throw new Error('carry_cash_local_coverage_mismatch')
  return record
}

export function verifyLocalCarryCash(manifest, root = LOCAL_CARRY_CASH_ROOT, limits) {
  const budget = boundedReceiptBudget(limits, MAX_RECEIPTS, MAX_RECORD_BYTES)
  validateManifest(manifest)
  if (!existsSync(root))
    return {
      count: 0,
      last: null,
      records: [],
      keys: new Set(),
      ...(limits === undefined ? {} : { totalBytes: 0 }),
    }
  const files = readdirSync(root)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
  if (files.length > budget.maxRecords) throw new Error('carry_cash_local_count_limit')
  const records = []
  const keys = new Set()
  let previous = null
  for (const [index, file] of files.entries()) {
    if (!FILE.test(file) || file !== name(index + 1))
      throw new Error('carry_cash_local_sequence_gap')
    const record = validateReceipt(canonicalFile(join(root, file), budget), previous, manifest)
    const key = `${record.collectionMode}\0${record.anchorAt}`
    if (keys.has(key)) throw new Error('carry_cash_local_duplicate_anchor')
    keys.add(key)
    records.push(record)
    previous = record
  }
  return {
    count: records.length,
    last: previous,
    records,
    keys,
    ...(limits === undefined ? {} : { totalBytes: budget.totalBytes }),
  }
}

/**
 * Consumer-facing view. The shared archive reader stamps `backfilled` on all
 * raw rows because it was built for archive batches, including a batch read
 * from the current finalized head. That raw implementation label is not the
 * collection mode. Verify the immutable receipt first, then remove the raw
 * label and attach the receipt's authoritative mode to every subject row.
 * Existing sealed receipts remain byte-for-byte unchanged.
 */
export function readLocalCarryCashObservations(manifest, root = LOCAL_CARRY_CASH_ROOT) {
  return localCarryCashObservationsFromVerified(verifyLocalCarryCash(manifest, root))
}

/**
 * Reuse a ledger returned by verifyLocalCarryCash without reading every
 * receipt again. Callers must pass that verifier's result, not raw records.
 */
export function localCarryCashObservationsFromVerified(verified) {
  if (
    !verified ||
    !Array.isArray(verified.records) ||
    verified.count !== verified.records.length ||
    (verified.count
      ? verified.last?.sha256 !== verified.records.at(-1)?.sha256
      : verified.last !== null)
  )
    throw new Error('carry_cash_local_verified_input')
  return verified.records.map((receipt) => {
    const evidenceKind =
      receipt.collectionMode === 'current'
        ? 'current_finalized_observation'
        : 'retrospective_reconstruction'
    return {
      receiptSha256: receipt.sha256,
      manifestSha256: receipt.manifestSha256,
      collectionMode: receipt.collectionMode,
      evidenceKind,
      metric: receipt.metric,
      holderExitAbility: receipt.holderExitAbility,
      competingFlow: receipt.competingFlow,
      source: {
        chainId: receipt.chainId,
        block: receipt.block,
        blockHash: receipt.blockHash,
        blockAt: receipt.blockAt,
      },
      anchorAt: receipt.anchorAt,
      firstLocalReceiptAt: receipt.firstLocalReceiptAt,
      coverage: receipt.coverage,
      subjects: receipt.rows.map(({ captureKind, ...row }) => {
        if (captureKind !== 'backfilled') throw new Error('carry_cash_local_reader_kind_changed')
        return {
          ...row,
          collectionMode: receipt.collectionMode,
          evidenceKind,
          firstLocalReceiptAt: receipt.firstLocalReceiptAt,
          receiptSha256: receipt.sha256,
        }
      }),
    }
  })
}

function reserveDisk(root, bytes) {
  let ancestor = root
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new Error('carry_cash_local_no_disk_ancestor')
    ancestor = parent
  }
  const disk = statfsSync(ancestor)
  if (Number(disk.bavail) * Number(disk.bsize) - bytes < MIN_FREE_BYTES)
    throw new Error('carry_cash_local_disk_reserve')
}

export function appendLocalCarryCash(input, manifest, root = LOCAL_CARRY_CASH_ROOT) {
  validateManifest(manifest)
  const lock = `${root}.lock`
  mkdirSync(dirname(root), { recursive: true })
  mkdirSync(lock)
  try {
    const prior = verifyLocalCarryCash(manifest, root)
    const key = `${input.collectionMode}\0${input.anchorAt}`
    if (prior.keys.has(key))
      return {
        status: 'already_recorded',
        record: prior.records.find((row) => `${row.collectionMode}\0${row.anchorAt}` === key),
      }
    if (prior.count >= MAX_RECEIPTS) throw new Error('carry_cash_local_count_limit')
    const coverage = Object.fromEntries(
      ['observed', 'no_code', 'identity_mismatch', 'unassessed'].map((state) => [
        state,
        input.rows.filter((row) => row.state === state).length,
      ]),
    )
    const body = {
      study: LOCAL_CARRY_CASH_STUDY,
      sequence: prior.count + 1,
      previousSha256: prior.last?.sha256 ?? null,
      manifestSha256: manifest.sha256,
      collectionMode: input.collectionMode,
      metric: 'aggregate_underlying_cash_raw_proxy',
      holderExitAbility: 'not_measured',
      competingFlow: 'not_measured',
      chainId: 1,
      anchorAt: input.anchorAt,
      block: String(input.block.number),
      blockHash: input.block.hash,
      blockTimestamp: Number(input.block.timestamp),
      blockAt: input.block.at,
      firstLocalReceiptAt: input.firstLocalReceiptAt ?? new Date().toISOString(),
      coverage,
      rows: input.rows,
    }
    validateReceipt({ ...body, sha256: sha(JSON.stringify(body)) }, prior.last, manifest)
    const record = { ...body, sha256: sha(JSON.stringify(body)) }
    const bytes = `${JSON.stringify(record)}\n`
    if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES)
      throw new Error('carry_cash_local_record_oversize')
    reserveDisk(root, Buffer.byteLength(bytes))
    mkdirSync(root, { recursive: true })
    const target = join(root, name(record.sequence))
    const temp = join(root, `.${randomUUID()}.tmp`)
    let fd
    try {
      fd = openSync(temp, 'wx', 0o600)
      writeFileSync(fd, bytes)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      linkSync(temp, target)
    } finally {
      if (fd !== undefined) closeSync(fd)
      if (existsSync(temp)) unlinkSync(temp)
    }
    return { status: 'recorded', record }
  } finally {
    // A failed process leaves the lock for manual inspection; a normal error
    // after entry can release it because no caller can race the chain.
    if (existsSync(lock)) rmdirSync(lock)
  }
}
