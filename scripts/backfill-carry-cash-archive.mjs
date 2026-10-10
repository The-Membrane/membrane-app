// Bounded archive-state pilot for the exact 25 displayed Carry route groups.
// Every row is historical reconstruction, never a prospective observation.
// Usage: node --import tsx scripts/backfill-carry-cash-archive.mjs
//   --hours 24 --step-hours 1 [--as-of 2026-09-28T00:00:00.000Z]
//   [--research-30d-lookback] [--dry-run|--commit]
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { neon } from '@neondatabase/serverless'
import { isAddress } from 'viem'

import * as marketConstants from '../lib/carry/directSupplyMarketConstants.ts'
import { buildSubjectManifest } from './record-carry-cash-issues.mjs'
import { makeClient, readEnv } from './lib/venue-reads.mjs'

const TWYNE_WRAPPER = '0x0af56afbddcb140323445bd7211ba90e54e5fd1c'
const DIRECT_SUPPLY_MARKETS =
  marketConstants.DIRECT_SUPPLY_MARKETS ?? marketConstants.default?.DIRECT_SUPPLY_MARKETS
const HASH = /^0x[0-9a-f]{64}$/
const RAW = /^(0|[1-9][0-9]*)$/
const HOUR_MS = 3_600_000
const MAX_ANCHORS = 24
const PILOT_LOOKBACK_MS = 168 * HOUR_MS
const RESEARCH_LOOKBACK_MS = 30 * 24 * HOUR_MS
const MAX_FINALIZED_AGE_MS = 2 * HOUR_MS
const MAX_U256 = (1n << 256n) - 1n
const ABI = [
  {
    type: 'function',
    name: 'asset',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'UNDERLYING_ASSET_ADDRESS',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'baseToken',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
]

function address(value) {
  if (!isAddress(value, { strict: false })) throw new Error('invalid_address')
  return value.toLowerCase()
}
function decimal(value) {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error('invalid_decimals')
  return value
}
function raw(value) {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_U256)
    throw new Error('invalid_raw_cash')
  return value.toString()
}
function header(block) {
  if (
    typeof block?.number !== 'bigint' ||
    block.number < 1n ||
    !HASH.test(String(block.hash).toLowerCase()) ||
    typeof block?.timestamp !== 'bigint' ||
    block.timestamp < 1n
  )
    throw new Error('invalid_archive_header')
  const milliseconds = Number(block.timestamp) * 1000
  if (!Number.isSafeInteger(milliseconds)) throw new Error('invalid_archive_clock')
  return {
    number: block.number,
    hash: block.hash.toLowerCase(),
    timestamp: block.timestamp,
    at: new Date(milliseconds).toISOString(),
  }
}

/** A fixed UTC-hour grid has at most 24 anchors in this pilot. */
export function parseOptions(argv) {
  const values = new Map()
  let mode = 'dry-run'
  let research30dLookback = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run' || arg === '--commit') {
      if (values.has('mode')) throw new Error('mode_specified_twice')
      mode = arg.slice(2)
      values.set('mode', mode)
    } else if (arg === '--research-30d-lookback') {
      if (research30dLookback) throw new Error('lookback_flag_specified_twice')
      research30dLookback = true
    } else if (['--hours', '--step-hours', '--as-of'].includes(arg)) {
      if (values.has(arg) || !argv[i + 1]) throw new Error('duplicate_or_missing_option')
      values.set(arg, argv[++i])
    } else throw new Error('unknown_option')
  }
  const hours = Number(values.get('--hours') ?? 24)
  const stepHours = Number(values.get('--step-hours') ?? 1)
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(stepHours) ||
    hours < 1 ||
    hours > 168 ||
    stepHours < 1 ||
    stepHours > hours ||
    Math.ceil(hours / stepHours) > MAX_ANCHORS
  )
    throw new Error('archive_pilot_bounds_exceeded')
  const asOf = values.get('--as-of')
  if (
    asOf !== undefined &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(asOf) ||
      !Number.isFinite(Date.parse(asOf)) ||
      new Date(Date.parse(asOf)).toISOString() !== asOf)
  )
    throw new Error('as_of_must_be_exact_utc_hour')
  return { hours, stepHours, asOf, mode, research30dLookback }
}

export function anchorGrid(options, finalizedAt) {
  const finalizedMs = Date.parse(finalizedAt)
  if (!Number.isSafeInteger(finalizedMs)) throw new Error('invalid_finalized_time')
  const maxLookbackMs =
    options.research30dLookback === true ? RESEARCH_LOOKBACK_MS : PILOT_LOOKBACK_MS
  const endMs = options.asOf
    ? Date.parse(options.asOf)
    : Math.floor(finalizedMs / HOUR_MS) * HOUR_MS - HOUR_MS
  if (!Number.isSafeInteger(endMs) || endMs > finalizedMs || finalizedMs - endMs > maxLookbackMs)
    throw new Error('anchor_outside_pilot_window')
  const count = Math.ceil(options.hours / options.stepHours)
  if (finalizedMs - (endMs - (count - 1) * options.stepHours * HOUR_MS) > maxLookbackMs)
    throw new Error('anchor_outside_pilot_window')
  return Array.from({ length: count }, (_, i) =>
    new Date(endMs - (count - 1 - i) * options.stepHours * HOUR_MS).toISOString(),
  )
}

/** Last canonical block at or before the anchor; verify the next block is later. */
export async function resolveAnchorBlock(client, anchorAt, finalizedHeader, firstBlock = 1n) {
  const anchorSeconds = BigInt(Date.parse(anchorAt) / 1000)
  if (anchorSeconds > finalizedHeader.timestamp) throw new Error('anchor_after_finalized')
  let low = firstBlock
  let high = finalizedHeader.number
  let answer = null
  while (low <= high) {
    const middle = (low + high) / 2n
    const candidate = header(await client.getBlock({ blockNumber: middle }))
    if (candidate.number !== middle) throw new Error('archive_block_number_mismatch')
    if (candidate.timestamp <= anchorSeconds) {
      answer = candidate
      low = middle + 1n
    } else high = middle - 1n
  }
  if (!answer) throw new Error('archive_anchor_precedes_chain')
  if (answer.number < finalizedHeader.number) {
    const next = header(await client.getBlock({ blockNumber: answer.number + 1n }))
    if (next.number !== answer.number + 1n || next.timestamp <= anchorSeconds)
      throw new Error('archive_anchor_not_bracketed')
  }
  return answer
}

async function boundedMap(items, limit, fn) {
  const output = new Array(items.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(items.length, limit) }, async () => {
      while (cursor < items.length) {
        const index = cursor++
        output[index] = await fn(items[index])
      }
    }),
  )
  return output
}

/** Reject an absent, altered, or incomplete independently pinned asset manifest. */
export function validateManifest(manifest) {
  const subjects = manifest?.subjects
  if (
    !Array.isArray(subjects) ||
    subjects.length !== 67 ||
    JSON.stringify(subjects) !== manifest.payload ||
    createHash('sha256').update(manifest.payload).digest('hex') !== manifest.sha256 ||
    new Set(subjects.map((s) => `${s.route_key}\0${s.destination}`)).size !== 67 ||
    new Set(subjects.map((s) => s.route_key)).size !== 25 ||
    subjects.filter((s) => s.source_kind === 'vault').length !== 64 ||
    subjects.filter((s) => s.source_kind === 'market').length !== 3 ||
    new Set(subjects.filter((s) => s.source_kind === 'vault').map((s) => s.destination)).size !== 63
  )
    throw new Error('archive_subject_manifest_invalid')
  const direct = new Map(
    DIRECT.map((m) => [
      `${m.routeKey}\0${address(m.destination)}`,
      { asset: address(m.underlying), venueKind: m.venueKind },
    ]),
  )
  for (const subject of subjects) {
    const key = `${subject.route_key}\0${subject.destination}`
    if (
      !subject.route_key ||
      address(subject.destination) !== subject.destination ||
      address(subject.asset) !== subject.asset
    )
      throw new Error('archive_subject_manifest_invalid')
    if (subject.source_kind === 'market') {
      const expected = direct.get(key)
      if (
        !expected ||
        subject.asset !== expected.asset ||
        subject.venue_kind !== expected.venueKind ||
        subject.cohort_id !== null ||
        subject.seed_source_sha256 !== null ||
        subject.seed_sha256 !== null ||
        subject.board_sha256 !== null ||
        subject.displayed_routes_sha256 !== null
      )
        throw new Error('archive_direct_subject_manifest_mismatch')
    } else if (subject.source_kind === 'vault') {
      if (
        subject.venue_kind !== null ||
        !subject.cohort_id ||
        ![
          subject.seed_source_sha256,
          subject.seed_sha256,
          subject.board_sha256,
          subject.displayed_routes_sha256,
        ].every((value) => /^[0-9a-f]{64}$/.test(value))
      )
        throw new Error('archive_vault_subject_manifest_mismatch')
    } else throw new Error('archive_subject_kind_invalid')
  }
  return new Map(subjects.map((s) => [`${s.route_key}\0${s.destination}`, s]))
}

function subjectBase(subject, anchorAt, block, manifestSha256) {
  return {
    captureKind: 'backfilled',
    routeKey: subject.route_key,
    subjectKind: subject.source_kind === 'market' ? 'direct' : 'vault',
    venueKind: subject.source_kind === 'market' ? subject.venue_kind : 'erc4626',
    destination: subject.destination,
    anchorAt,
    chainId: 1,
    block: block.number.toString(),
    blockHash: block.hash,
    blockAt: block.at,
    asset: null,
    shareDecimals: null,
    assetDecimals: null,
    cashRaw: null,
    state: 'read_unavailable',
    reason: 'archive_state_read_failed',
    cohortId: subject.cohort_id,
    subjectManifestSha256: manifestSha256,
    seedSourceSha256: subject.seed_source_sha256,
    seedSha256: subject.seed_sha256,
    boardSha256: subject.board_sha256,
    displayedRoutesSha256: subject.displayed_routes_sha256,
  }
}

async function codeState(client, contract, blockNumber) {
  const code = await client.getCode({ address: contract, blockNumber })
  return typeof code === 'string' && code !== '0x'
}

/** Only exact pinned-block RPC state can produce an observed row. */
export async function readVaultCash(client, vault, blockNumber) {
  const destination = address(vault)
  try {
    if (!(await codeState(client, destination, blockNumber)))
      return { state: 'no_code', reason: 'destination_not_deployed' }
    if (destination === TWYNE_WRAPPER)
      return { state: 'unassessed', reason: 'twyne_wrapped_atoken_cash_unassessed' }
    const call = (contract, functionName, args) =>
      client.readContract({
        address: contract,
        abi: ABI,
        functionName,
        ...(args ? { args } : {}),
        blockNumber,
      })
    const [assetValue, shareDecimalsValue] = await Promise.all([
      call(destination, 'asset'),
      call(destination, 'decimals'),
    ])
    const asset = address(assetValue)
    const shareDecimals = decimal(shareDecimalsValue)
    if (!(await codeState(client, asset, blockNumber)))
      return { state: 'no_code', reason: 'asset_not_deployed' }
    const [assetDecimalsValue, cashValue] = await Promise.all([
      call(asset, 'decimals'),
      call(asset, 'balanceOf', [destination]),
    ])
    return {
      state: 'observed',
      reason: null,
      asset,
      shareDecimals,
      assetDecimals: decimal(assetDecimalsValue),
      cashRaw: raw(cashValue),
    }
  } catch {
    return { state: 'read_unavailable', reason: 'archive_state_read_failed' }
  }
}

const DIRECT = [
  {
    ...DIRECT_SUPPLY_MARKETS.aaveV3Usdc,
    venueKind: 'aave_v3_atoken',
    identityFn: 'UNDERLYING_ASSET_ADDRESS',
  },
  {
    ...DIRECT_SUPPLY_MARKETS.compoundV3Usdc,
    venueKind: 'compound_v3_comet',
    identityFn: 'baseToken',
  },
  {
    ...DIRECT_SUPPLY_MARKETS.sparkLendUsdt,
    venueKind: 'spark_lend_atoken',
    identityFn: 'UNDERLYING_ASSET_ADDRESS',
  },
]
export const DIRECT_CASH_MARKETS = DIRECT

export async function readDirectCash(client, market, blockNumber) {
  const destination = address(market.destination)
  const asset = address(market.underlying)
  try {
    if (
      !(await codeState(client, destination, blockNumber)) ||
      !(await codeState(client, asset, blockNumber))
    )
      return { state: 'no_code', reason: 'market_or_asset_not_deployed' }
    const call = (contract, functionName, args) =>
      client.readContract({
        address: contract,
        abi: ABI,
        functionName,
        ...(args ? { args } : {}),
        blockNumber,
      })
    const [identity, shareDecimalsValue, assetDecimalsValue, cashValue] = await Promise.all([
      call(destination, market.identityFn),
      call(destination, 'decimals'),
      call(asset, 'decimals'),
      call(asset, 'balanceOf', [destination]),
    ])
    if (
      address(identity) !== asset ||
      decimal(shareDecimalsValue) !== market.decimals ||
      decimal(assetDecimalsValue) !== market.decimals
    )
      return { state: 'identity_mismatch', reason: 'market_identity_or_decimals_mismatch' }
    return {
      state: 'observed',
      reason: null,
      asset,
      shareDecimals: market.decimals,
      assetDecimals: market.decimals,
      cashRaw: raw(cashValue),
    }
  } catch {
    return { state: 'read_unavailable', reason: 'archive_state_read_failed' }
  }
}

function bindObservedAsset(state, expectedAsset) {
  if (state?.state !== 'observed') return state
  if (address(state.asset) === expectedAsset) return state
  return { state: 'identity_mismatch', reason: 'pinned_expected_asset_mismatch' }
}

/** One anchor yields exactly 64 route-vault and three direct rows. */
export async function collectAnchor(client, anchorAt, block, manifest, readers = {}) {
  validateManifest(manifest)
  const vaultSubjects = manifest.subjects.filter((subject) => subject.source_kind === 'vault')
  const vaults = [...new Set(vaultSubjects.map((subject) => subject.destination))].sort()
  const readVault = readers.readVaultCash ?? readVaultCash
  const readDirect = readers.readDirectCash ?? readDirectCash
  const vaultStates = await boundedMap(vaults, 4, (vault) => readVault(client, vault, block.number))
  const stateByVault = new Map(vaults.map((vault, i) => [vault, vaultStates[i]]))
  const vaultRows = vaultSubjects.map((subject) => ({
    ...subjectBase(subject, anchorAt, block, manifest.sha256),
    ...bindObservedAsset(stateByVault.get(subject.destination), subject.asset),
  }))
  const directStates = await boundedMap(DIRECT, 3, (market) =>
    readDirect(client, market, block.number),
  )
  const directRows = DIRECT.map((market, i) => {
    const subject = manifest.subjects.find(
      (row) => row.route_key === market.routeKey && row.destination === address(market.destination),
    )
    return {
      ...subjectBase(subject, anchorAt, block, manifest.sha256),
      ...bindObservedAsset(directStates[i], subject.asset),
    }
  })
  const rows = [...vaultRows, ...directRows]
  validateBatch(rows, anchorAt, block, manifest)
  return rows
}

/** Canonical strings preserve uint256 raw amounts without JS numeric coercion. */
export function validateBatch(rows, anchorAt, block, manifest) {
  const subjectMap = validateManifest(manifest)
  if (!Array.isArray(rows) || rows.length !== 67) throw new Error('incomplete_archive_batch')
  const keys = new Set()
  for (const row of rows) {
    const key = `${row.routeKey}\0${row.destination}`
    const subject = subjectMap.get(key)
    if (
      keys.has(key) ||
      !subject ||
      row.captureKind !== 'backfilled' ||
      row.anchorAt !== anchorAt ||
      row.chainId !== 1 ||
      row.block !== block.number.toString() ||
      row.blockHash !== block.hash ||
      row.blockAt !== block.at ||
      row.subjectKind !== (subject.source_kind === 'market' ? 'direct' : 'vault') ||
      row.venueKind !== (subject.source_kind === 'market' ? subject.venue_kind : 'erc4626') ||
      row.subjectManifestSha256 !== manifest.sha256 ||
      row.cohortId !== subject.cohort_id ||
      row.seedSourceSha256 !== subject.seed_source_sha256 ||
      row.seedSha256 !== subject.seed_sha256 ||
      row.boardSha256 !== subject.board_sha256 ||
      row.displayedRoutesSha256 !== subject.displayed_routes_sha256 ||
      address(row.destination) !== row.destination ||
      !['observed', 'no_code', 'read_unavailable', 'identity_mismatch', 'unassessed'].includes(
        row.state,
      )
    )
      throw new Error('invalid_archive_batch_identity')
    if (row.state === 'observed') {
      if (
        address(row.asset) !== subject.asset ||
        !Number.isInteger(row.shareDecimals) ||
        row.shareDecimals < 0 ||
        row.shareDecimals > 255 ||
        !Number.isInteger(row.assetDecimals) ||
        row.assetDecimals < 0 ||
        row.assetDecimals > 255 ||
        typeof row.cashRaw !== 'string' ||
        !RAW.test(row.cashRaw) ||
        BigInt(row.cashRaw) > MAX_U256 ||
        row.reason !== null
      )
        throw new Error('invalid_archive_cash')
    } else if (
      row.asset !== null ||
      row.shareDecimals !== null ||
      row.assetDecimals !== null ||
      row.cashRaw !== null ||
      typeof row.reason !== 'string' ||
      !row.reason
    )
      throw new Error('invalid_archive_missing_state')
    keys.add(key)
  }
  if (keys.size !== subjectMap.size) throw new Error('incomplete_archive_subjects')
  return rows
}

/** Conflict is accepted only for the exact original UTF-8 payload text. */
export async function persistAnchor(sql, rows, anchorAt, block, manifest) {
  validateBatch(rows, anchorAt, block, manifest)
  const payload = JSON.stringify(
    rows.map((row) => ({
      anchor_at: row.anchorAt,
      route_key: row.routeKey,
      subject_kind: row.subjectKind,
      venue_kind: row.venueKind,
      destination: row.destination,
      capture_kind: row.captureKind,
      chain_id: row.chainId,
      block: row.block,
      block_hash: row.blockHash,
      block_at: row.blockAt,
      asset: row.asset,
      share_decimals: row.shareDecimals,
      asset_decimals: row.assetDecimals,
      cash_raw: row.cashRaw,
      state: row.state,
      reason: row.reason,
      cohort_id: row.cohortId,
      subject_manifest_sha256: row.subjectManifestSha256,
      seed_source_sha256: row.seedSourceSha256,
      seed_sha256: row.seedSha256,
      board_sha256: row.boardSha256,
      displayed_routes_sha256: row.displayedRoutesSha256,
      payload_bytes: JSON.stringify(row),
    })),
  )
  await sql.transaction([
    sql`INSERT INTO carry_cash_backfill
      (anchor_at, route_key, subject_kind, venue_kind, destination, capture_kind,
       chain_id, block, block_hash, block_at, asset, share_decimals, asset_decimals,
       cash_raw, state, reason, cohort_id, subject_manifest_sha256,
       seed_source_sha256, seed_sha256, board_sha256,
       displayed_routes_sha256, payload_bytes)
      SELECT anchor_at, route_key, subject_kind, venue_kind, destination, capture_kind,
        chain_id, block, block_hash, block_at, asset, share_decimals, asset_decimals,
        cash_raw, state, reason, cohort_id, subject_manifest_sha256,
        seed_source_sha256, seed_sha256, board_sha256,
        displayed_routes_sha256, payload_bytes
      FROM jsonb_to_recordset(${payload}::jsonb) AS r(
        anchor_at timestamptz, route_key text, subject_kind text, venue_kind text,
        destination text, capture_kind text, chain_id smallint, block bigint,
        block_hash text, block_at timestamptz, asset text, share_decimals smallint,
        asset_decimals smallint, cash_raw numeric, state text, reason text,
        cohort_id text, subject_manifest_sha256 text, seed_source_sha256 text,
        seed_sha256 text, board_sha256 text,
        displayed_routes_sha256 text, payload_bytes text)
      ON CONFLICT (anchor_at, route_key, destination) DO NOTHING`,
    sql`SELECT 1 / CASE WHEN (
      SELECT count(*) FROM jsonb_to_recordset(${payload}::jsonb) AS r(
        anchor_at timestamptz, route_key text, destination text, payload_bytes text)
      JOIN carry_cash_backfill b USING (anchor_at, route_key, destination)
      WHERE b.capture_kind = 'backfilled' AND b.payload_bytes = r.payload_bytes
    ) = 67 THEN 1 ELSE 0 END AS exact_batch`,
  ])
}

export async function run(client, sql, options, manifest, clock = Date.now) {
  validateManifest(manifest)
  if ((await client.getChainId()) !== 1) throw new Error('archive_wrong_chain')
  const finalized = header(await client.getBlock({ blockTag: 'finalized' }))
  const finalizedAgeMs = clock() - Date.parse(finalized.at)
  if (
    !Number.isSafeInteger(finalizedAgeMs) ||
    finalizedAgeMs < -120_000 ||
    finalizedAgeMs > MAX_FINALIZED_AGE_MS
  )
    throw new Error('archive_finalized_head_stale')
  const anchors = anchorGrid(options, finalized.at)
  const output = []
  let lower = 1n
  for (const anchorAt of anchors) {
    const block = await resolveAnchorBlock(client, anchorAt, finalized, lower)
    const rows = await collectAnchor(client, anchorAt, block, manifest)
    const after = header(await client.getBlock({ blockNumber: block.number }))
    if (
      after.number !== block.number ||
      after.hash !== block.hash ||
      after.timestamp !== block.timestamp
    )
      throw new Error('archive_block_changed')
    if (options.mode === 'commit') {
      if (rows.some((row) => row.state === 'read_unavailable'))
        throw new Error('archive_transient_read_unavailable')
      await persistAnchor(sql, rows, anchorAt, block, manifest)
    }
    output.push({
      anchorAt,
      block: block.number.toString(),
      blockHash: block.hash,
      observed: rows.filter((row) => row.state === 'observed').length,
      missing: rows.filter((row) => row.state !== 'observed').length,
    })
    lower = block.number
  }
  return { mode: options.mode, captureKind: 'backfilled', anchors: output }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv)
  const { get } = readEnv()
  const rpcUrl =
    process.env.RECORDER_RPC_URLS ||
    process.env.RECORDER_RPC_URL ||
    get('RECORDER_RPC_URLS') ||
    get('RECORDER_RPC_URL')
  const dbUrl =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  if (!rpcUrl || (options.mode === 'commit' && !dbUrl))
    throw new Error('archive_rpc_or_database_url_required')
  const manifest = await buildSubjectManifest()
  const result = await run(
    makeClient(rpcUrl),
    options.mode === 'commit' ? neon(dbUrl) : null,
    options,
    manifest,
  )
  process.stdout.write(JSON.stringify(result) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // RPC/database errors can contain credential-bearing URLs.
    process.stderr.write(
      'Carry archive backfill failed closed; no prospective rows were written.\n',
    )
    process.exitCode = 1
  })
}
