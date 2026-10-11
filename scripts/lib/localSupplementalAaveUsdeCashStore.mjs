import { boundedReceiptBudget, readBoundedReceiptFile } from './boundedLocalReceiptFile.mjs'
// Immutable local receipts for the supplemental Aave V3 USDe cash subject.
// This is a separate versioned evidence lane. It never reads from or appends
// to the frozen August 25-route / 67-subject Carry cash ledger.
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

import * as marketConstants from '../../lib/carry/directSupplyMarketConstants.ts'
import { buildSubjectManifest } from '../record-carry-cash-issues.mjs'

export const LOCAL_SUPPLEMENTAL_AAVE_USDE_CASH_SCHEMA_VERSION = 1
export const LOCAL_SUPPLEMENTAL_AAVE_USDE_CASH_STUDY =
  'carry-supplemental-aave-v3-usde-finalized-cash-v1'
export const LOCAL_SUPPLEMENTAL_AAVE_USDE_CASH_ROOT = resolve(
  'data/research/venue-signals/local-carry-supplemental-aave-usde-cash-v1',
)

const DIRECT_SUPPLY_MARKETS =
  marketConstants.DIRECT_SUPPLY_MARKETS ?? marketConstants.default?.DIRECT_SUPPLY_MARKETS
const FILE = /^(\d{12})\.json$/
const SHA = /^[0-9a-f]{64}$/
const MIXED_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const BLOCK_HASH = /^0x[0-9a-f]{64}$/
const RAW = /^(0|[1-9][0-9]*)$/
const MAX_U256 = (1n << 256n) - 1n
const MIN_FREE_BYTES = 1024 * 1024 * 1024
const MAX_RECEIPTS = 10_000
const MAX_RECORD_BYTES = 32 * 1024
const MAX_ANCHOR_LAG_MS = 30 * 60 * 1000

const SUBJECT_KEYS = [
  'market_key',
  'route_key',
  'destination',
  'asset',
  'asset_decimals',
  'venue_kind',
  'source_kind',
  'cohort_id',
]
const DIRECT_MARKET_KEYS = ['routeKey', 'destination', 'underlying', 'decimals']
const ROW_KEYS = [
  'captureKind',
  'routeKey',
  'marketKey',
  'sourceKind',
  'subjectKind',
  'venueKind',
  'destination',
  'anchorAt',
  'chainId',
  'block',
  'blockHash',
  'blockAt',
  'asset',
  'shareDecimals',
  'assetDecimals',
  'cashRaw',
  'state',
  'reason',
  'cohortId',
  'subjectManifestSha256',
]
const RECEIPT_BODY_KEYS = [
  'study',
  'schemaVersion',
  'sequence',
  'previousSha256',
  'manifestSha256',
  'collectionMode',
  'metric',
  'holderExitAbility',
  'competingFlow',
  'chainId',
  'anchorAt',
  'block',
  'blockHash',
  'blockTimestamp',
  'blockAt',
  'firstLocalReceiptAt',
  'coverage',
  'rows',
]
const RECEIPT_KEYS = [...RECEIPT_BODY_KEYS, 'sha256']
const COVERAGE_KEYS = ['observed', 'no_code', 'identity_mismatch']
const EXPECTED_SUBJECT = Object.freeze({
  market_key: 'aaveV3Usde',
  route_key: 'USDe → supply on Aave V3',
  destination: '0x4f5923fc5fd4a93352581b38b7cd26943012decf',
  asset: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
  asset_decimals: 18,
  venue_kind: 'aave_v3_atoken',
  source_kind: 'market',
  cohort_id: 'supplemental-aave-v3-usde-2026-09',
})

const sha = (value) => createHash('sha256').update(value).digest('hex')
const name = (sequence) => `${String(sequence).padStart(12, '0')}.json`

function exactKeys(value, keys, ordered = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value)
  if (ordered) return JSON.stringify(actual) === JSON.stringify(keys)
  return JSON.stringify(actual.sort()) === JSON.stringify([...keys].sort())
}

function address(value) {
  if (typeof value !== 'string' || !MIXED_ADDRESS.test(value))
    throw new Error('supplemental_aave_usde_cash_invalid_address')
  return value.toLowerCase()
}

function utc(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    new Date(value).toISOString() !== value
  )
    throw new Error('supplemental_aave_usde_cash_invalid_time')
  return value
}

function sourceSubject(value) {
  if (!exactKeys(value, SUBJECT_KEYS))
    throw new Error('supplemental_aave_usde_cash_subject_identity')
  const subject = {
    market_key: value.market_key,
    route_key: value.route_key,
    destination: address(value.destination),
    asset: address(value.asset),
    asset_decimals: value.asset_decimals,
    venue_kind: value.venue_kind,
    source_kind: value.source_kind,
    cohort_id: value.cohort_id,
  }
  if (JSON.stringify(subject) !== JSON.stringify(EXPECTED_SUBJECT))
    throw new Error('supplemental_aave_usde_cash_subject_identity')
  return subject
}

function validateDirectMarket(value, subject) {
  if (!exactKeys(value, DIRECT_MARKET_KEYS))
    throw new Error('supplemental_aave_usde_cash_market_identity')
  if (
    value.routeKey !== subject.route_key ||
    address(value.destination) !== subject.destination ||
    address(value.underlying) !== subject.asset ||
    value.decimals !== subject.asset_decimals
  )
    throw new Error('supplemental_aave_usde_cash_market_identity')
  return value
}

/**
 * Build the one-subject manifest from both canonical identity sources. Tests
 * may provide snapshots of those sources; production always calls the real
 * buildSubjectManifest() and DIRECT_SUPPLY_MARKETS.aaveV3Usde.
 */
export async function buildSupplementalAaveUsdeCashManifest(options = {}) {
  const issueManifest = options.issueManifest ?? (await buildSubjectManifest())
  const directMarket = options.directMarket ?? DIRECT_SUPPLY_MARKETS?.aaveV3Usde
  if (
    !Array.isArray(issueManifest?.supplementalSubjects) ||
    issueManifest.supplementalSubjects.length !== 1
  )
    throw new Error('supplemental_aave_usde_cash_subject_count')
  const subject = sourceSubject(issueManifest.supplementalSubjects[0])
  validateDirectMarket(directMarket, subject)
  const subjects = [subject]
  const payload = JSON.stringify(subjects)
  return {
    schemaVersion: LOCAL_SUPPLEMENTAL_AAVE_USDE_CASH_SCHEMA_VERSION,
    study: LOCAL_SUPPLEMENTAL_AAVE_USDE_CASH_STUDY,
    subjects,
    payload,
    sha256: sha(payload),
  }
}

export function validateSupplementalAaveUsdeCashManifest(manifest) {
  if (
    !exactKeys(manifest, ['schemaVersion', 'study', 'subjects', 'payload', 'sha256']) ||
    manifest.schemaVersion !== LOCAL_SUPPLEMENTAL_AAVE_USDE_CASH_SCHEMA_VERSION ||
    manifest.study !== LOCAL_SUPPLEMENTAL_AAVE_USDE_CASH_STUDY ||
    !Array.isArray(manifest.subjects) ||
    manifest.subjects.length !== 1
  )
    throw new Error('supplemental_aave_usde_cash_manifest_invalid')
  const subject = sourceSubject(manifest.subjects[0])
  if (
    manifest.payload !== JSON.stringify([subject]) ||
    !SHA.test(manifest.sha256 ?? '') ||
    sha(manifest.payload) !== manifest.sha256
  )
    throw new Error('supplemental_aave_usde_cash_manifest_invalid')
  return subject
}

/** Identity-checked input expected by the shared pinned-block readDirectCash. */
export function supplementalAaveUsdeDirectMarket(
  manifest,
  directMarket = DIRECT_SUPPLY_MARKETS?.aaveV3Usde,
) {
  const subject = validateSupplementalAaveUsdeCashManifest(manifest)
  validateDirectMarket(directMarket, subject)
  return {
    routeKey: subject.route_key,
    destination: subject.destination,
    underlying: subject.asset,
    decimals: subject.asset_decimals,
    venueKind: subject.venue_kind,
    identityFn: 'UNDERLYING_ASSET_ADDRESS',
  }
}

function canonicalFile(path, budget) {
  const bytes = readBoundedReceiptFile(path, budget)
  if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES)
    throw new Error('supplemental_aave_usde_cash_record_oversize')
  const record = JSON.parse(bytes)
  if (bytes !== `${JSON.stringify(record)}\n`)
    throw new Error('supplemental_aave_usde_cash_physical_bytes')
  const { sha256, ...body } = record
  if (!SHA.test(sha256 ?? '') || sha(JSON.stringify(body)) !== sha256)
    throw new Error('supplemental_aave_usde_cash_hash_mismatch')
  return record
}

function validateRow(row, receipt, subject, manifestSha256) {
  if (
    !exactKeys(row, ROW_KEYS, true) ||
    row.captureKind !== 'backfilled' ||
    row.routeKey !== subject.route_key ||
    row.marketKey !== subject.market_key ||
    row.sourceKind !== subject.source_kind ||
    row.subjectKind !== 'direct' ||
    row.venueKind !== subject.venue_kind ||
    row.destination !== subject.destination ||
    row.anchorAt !== receipt.anchorAt ||
    row.chainId !== 1 ||
    row.block !== receipt.block ||
    row.blockHash !== receipt.blockHash ||
    row.blockAt !== receipt.blockAt ||
    row.cohortId !== subject.cohort_id ||
    row.subjectManifestSha256 !== manifestSha256 ||
    !['observed', 'no_code', 'identity_mismatch'].includes(row.state)
  )
    throw new Error('supplemental_aave_usde_cash_row_identity')
  if (row.state === 'observed') {
    if (
      row.asset !== subject.asset ||
      row.shareDecimals !== 18 ||
      row.assetDecimals !== 18 ||
      !RAW.test(row.cashRaw ?? '') ||
      BigInt(row.cashRaw) > MAX_U256 ||
      row.reason !== null
    )
      throw new Error('supplemental_aave_usde_cash_invalid_cash')
    return
  }
  if (
    row.asset !== null ||
    row.shareDecimals !== null ||
    row.assetDecimals !== null ||
    row.cashRaw !== null ||
    (row.state === 'no_code' && row.reason !== 'market_or_asset_not_deployed') ||
    (row.state === 'identity_mismatch' &&
      !['market_identity_or_decimals_mismatch', 'pinned_expected_asset_mismatch'].includes(
        row.reason,
      ))
  )
    throw new Error('supplemental_aave_usde_cash_invalid_state')
}

function validateReceipt(record, previous, manifest) {
  const subject = validateSupplementalAaveUsdeCashManifest(manifest)
  if (
    !exactKeys(record, RECEIPT_KEYS, true) ||
    record.study !== LOCAL_SUPPLEMENTAL_AAVE_USDE_CASH_STUDY ||
    record.schemaVersion !== LOCAL_SUPPLEMENTAL_AAVE_USDE_CASH_SCHEMA_VERSION ||
    record.sequence !== (previous?.sequence ?? 0) + 1 ||
    record.previousSha256 !== (previous?.sha256 ?? null) ||
    record.manifestSha256 !== manifest.sha256 ||
    !['current', 'retrospective'].includes(record.collectionMode) ||
    record.metric !== 'aggregate_underlying_cash_raw_proxy' ||
    record.holderExitAbility !== 'not_measured' ||
    record.competingFlow !== 'not_measured' ||
    record.chainId !== 1 ||
    !RAW.test(record.block ?? '') ||
    record.block === '0' ||
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
      (Date.parse(record.anchorAt) < record.blockTimestamp * 1000 ||
        Date.parse(record.anchorAt) - record.blockTimestamp * 1000 > MAX_ANCHOR_LAG_MS)) ||
    !Array.isArray(record.rows) ||
    record.rows.length !== 1
  )
    throw new Error('supplemental_aave_usde_cash_receipt_identity')
  validateRow(record.rows[0], record, subject, manifest.sha256)
  const coverage = Object.fromEntries(
    COVERAGE_KEYS.map((state) => [state, record.rows.filter((row) => row.state === state).length]),
  )
  if (
    !exactKeys(record.coverage, COVERAGE_KEYS, true) ||
    JSON.stringify(record.coverage) !== JSON.stringify(coverage) ||
    Object.values(coverage).reduce((sum, count) => sum + count, 0) !== 1
  )
    throw new Error('supplemental_aave_usde_cash_coverage_mismatch')
  return record
}

export function verifyLocalSupplementalAaveUsdeCash(
  manifest,
  root = LOCAL_SUPPLEMENTAL_AAVE_USDE_CASH_ROOT,
  limits,
) {
  const budget = boundedReceiptBudget(limits, MAX_RECEIPTS, MAX_RECORD_BYTES)
  validateSupplementalAaveUsdeCashManifest(manifest)
  const empty = {
    verification: 'local_supplemental_aave_usde_cash_v1',
    manifestSha256: manifest.sha256,
    count: 0,
    last: null,
    records: [],
    keys: new Set(),
    ...(limits === undefined ? {} : { totalBytes: 0 }),
  }
  if (!existsSync(root)) return empty
  const entries = readdirSync(root).sort()
  if (entries.length > budget.maxRecords) throw new Error('supplemental_aave_usde_cash_count_limit')
  if (entries.some((entry) => !FILE.test(entry)))
    throw new Error('supplemental_aave_usde_cash_unexpected_entry')
  const records = []
  const keys = new Set()
  let previous = null
  for (const [index, file] of entries.entries()) {
    if (file !== name(index + 1)) throw new Error('supplemental_aave_usde_cash_sequence_gap')
    const record = validateReceipt(canonicalFile(join(root, file), budget), previous, manifest)
    const key = `${record.collectionMode}\0${record.anchorAt}`
    if (keys.has(key)) throw new Error('supplemental_aave_usde_cash_duplicate_anchor')
    keys.add(key)
    records.push(record)
    previous = record
  }
  return {
    ...empty,
    count: records.length,
    last: previous,
    records,
    keys,
    ...(limits === undefined ? {} : { totalBytes: budget.totalBytes }),
  }
}

/** Consumer seam compatible with historicalCarryCashContext observations. */
export function readLocalSupplementalAaveUsdeCashObservations(
  manifest,
  root = LOCAL_SUPPLEMENTAL_AAVE_USDE_CASH_ROOT,
) {
  return localSupplementalAaveUsdeCashObservationsFromVerified(
    verifyLocalSupplementalAaveUsdeCash(manifest, root),
  )
}

/** Reuse a verified ledger without re-reading every immutable receipt. */
export function localSupplementalAaveUsdeCashObservationsFromVerified(verified) {
  if (
    verified?.verification !== 'local_supplemental_aave_usde_cash_v1' ||
    !SHA.test(verified.manifestSha256 ?? '') ||
    !Array.isArray(verified.records) ||
    verified.count !== verified.records.length ||
    (verified.count
      ? verified.last?.sha256 !== verified.records.at(-1)?.sha256
      : verified.last !== null)
  )
    throw new Error('supplemental_aave_usde_cash_verified_input')
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
        if (captureKind !== 'backfilled')
          throw new Error('supplemental_aave_usde_cash_reader_kind_changed')
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
    if (parent === ancestor) throw new Error('supplemental_aave_usde_cash_no_disk_ancestor')
    ancestor = parent
  }
  const disk = statfsSync(ancestor)
  if (Number(disk.bavail) * Number(disk.bsize) - bytes < MIN_FREE_BYTES)
    throw new Error('supplemental_aave_usde_cash_disk_reserve')
}

export function appendLocalSupplementalAaveUsdeCash(
  input,
  manifest,
  root = LOCAL_SUPPLEMENTAL_AAVE_USDE_CASH_ROOT,
) {
  validateSupplementalAaveUsdeCashManifest(manifest)
  const lock = `${root}.lock`
  mkdirSync(dirname(root), { recursive: true })
  mkdirSync(lock)
  try {
    const prior = verifyLocalSupplementalAaveUsdeCash(manifest, root)
    const key = `${input?.collectionMode}\0${input?.anchorAt}`
    if (prior.keys.has(key))
      return {
        status: 'already_recorded',
        record: prior.records.find((row) => `${row.collectionMode}\0${row.anchorAt}` === key),
      }
    if (prior.count >= MAX_RECEIPTS) throw new Error('supplemental_aave_usde_cash_count_limit')
    const rows = Array.isArray(input?.rows) ? input.rows : []
    const coverage = Object.fromEntries(
      COVERAGE_KEYS.map((state) => [state, rows.filter((row) => row.state === state).length]),
    )
    const body = {
      study: LOCAL_SUPPLEMENTAL_AAVE_USDE_CASH_STUDY,
      schemaVersion: LOCAL_SUPPLEMENTAL_AAVE_USDE_CASH_SCHEMA_VERSION,
      sequence: prior.count + 1,
      previousSha256: prior.last?.sha256 ?? null,
      manifestSha256: manifest.sha256,
      collectionMode: input?.collectionMode,
      metric: 'aggregate_underlying_cash_raw_proxy',
      holderExitAbility: 'not_measured',
      competingFlow: 'not_measured',
      chainId: 1,
      anchorAt: input?.anchorAt,
      block: String(input?.block?.number),
      blockHash: input?.block?.hash,
      blockTimestamp: Number(input?.block?.timestamp),
      blockAt: input?.block?.at,
      firstLocalReceiptAt: input?.firstLocalReceiptAt,
      coverage,
      rows,
    }
    const record = { ...body, sha256: sha(JSON.stringify(body)) }
    validateReceipt(record, prior.last, manifest)
    const bytes = `${JSON.stringify(record)}\n`
    if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES)
      throw new Error('supplemental_aave_usde_cash_record_oversize')
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
    if (existsSync(lock)) rmdirSync(lock)
  }
}
