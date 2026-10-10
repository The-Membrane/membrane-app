// Local Mac, Neon-free cash capture for the single supplemental Aave V3 USDe
// subject. Current finalized observations and retrospective reconstructions
// share one immutable receipt format but retain distinct evidence labels.
//
// node --import tsx scripts/record-supplemental-aave-usde-cash-local.mjs --current
// node --import tsx scripts/record-supplemental-aave-usde-cash-local.mjs --history --lookback-hours 2880 --step-hours 24 --max-anchors 2
// node --import tsx scripts/record-supplemental-aave-usde-cash-local.mjs --verify
// node --import tsx scripts/record-supplemental-aave-usde-cash-local.mjs --coverage
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import { readDirectCash, resolveAnchorBlock } from './backfill-carry-cash-archive.mjs'
import {
  appendLocalSupplementalAaveUsdeCash,
  buildSupplementalAaveUsdeCashManifest,
  LOCAL_SUPPLEMENTAL_AAVE_USDE_CASH_ROOT,
  supplementalAaveUsdeDirectMarket,
  validateSupplementalAaveUsdeCashManifest,
  verifyLocalSupplementalAaveUsdeCash,
} from './lib/localSupplementalAaveUsdeCashStore.mjs'
import { makeClient, readEnv } from './lib/venue-reads.mjs'

const HOUR_MS = 3_600_000
const HASH = /^0x[0-9a-f]{64}$/
const RAW = /^(0|[1-9][0-9]*)$/
const MAX_U256 = (1n << 256n) - 1n

export function parseOptions(argv) {
  let mode = null
  const values = new Map()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (['--current', '--history', '--verify', '--coverage'].includes(arg)) {
      if (mode) throw new Error('supplemental_aave_usde_cash_multiple_modes')
      mode = arg.slice(2)
    } else if (arg === '--as-of') {
      if (values.has(arg) || !argv[i + 1])
        throw new Error('supplemental_aave_usde_cash_duplicate_or_missing_option')
      values.set(arg, argv[++i])
    } else if (['--lookback-hours', '--step-hours', '--max-anchors'].includes(arg)) {
      if (values.has(arg) || !argv[i + 1])
        throw new Error('supplemental_aave_usde_cash_duplicate_or_missing_option')
      values.set(arg, Number(argv[++i]))
    } else throw new Error('supplemental_aave_usde_cash_unknown_option')
  }
  mode ??= 'current'
  if (mode !== 'history' && values.size)
    throw new Error('supplemental_aave_usde_cash_history_options_only')
  const lookbackHours = values.get('--lookback-hours') ?? 24
  const stepHours = values.get('--step-hours') ?? 24
  const maxAnchors = values.get('--max-anchors') ?? 2
  const asOf = values.get('--as-of') ?? null
  if (
    mode === 'history' &&
    (![lookbackHours, stepHours, maxAnchors].every(Number.isInteger) ||
      lookbackHours < 24 ||
      lookbackHours > 2880 ||
      stepHours < 1 ||
      stepHours > 24 ||
      maxAnchors < 1 ||
      maxAnchors > 4 ||
      (asOf !== null &&
        (!/^\d{4}-\d\d-\d\dT\d\d:00:00\.000Z$/.test(asOf) ||
          !Number.isFinite(Date.parse(asOf)) ||
          new Date(asOf).toISOString() !== asOf)))
  )
    throw new Error('supplemental_aave_usde_cash_history_bounds')
  return { mode, lookbackHours, stepHours, maxAnchors, asOf }
}

export function historicalAnchorGrid(finalizedAt, options) {
  const finalizedMs = Date.parse(finalizedAt)
  if (!Number.isSafeInteger(finalizedMs))
    throw new Error('supplemental_aave_usde_cash_invalid_finalized_time')
  const asOfMs =
    options.asOf == null
      ? Math.floor(finalizedMs / (24 * HOUR_MS)) * 24 * HOUR_MS
      : Date.parse(options.asOf)
  if (
    !Number.isSafeInteger(asOfMs) ||
    asOfMs > finalizedMs ||
    finalizedMs - asOfMs > 120 * 24 * HOUR_MS
  )
    throw new Error('supplemental_aave_usde_cash_invalid_as_of')
  const anchors = []
  for (let hours = options.lookbackHours; hours >= 24; hours -= options.stepHours)
    anchors.push(new Date(asOfMs - hours * HOUR_MS).toISOString())
  return anchors
}

function header(block) {
  if (
    typeof block?.number !== 'bigint' ||
    block.number < 1n ||
    !HASH.test(String(block.hash).toLowerCase()) ||
    typeof block.timestamp !== 'bigint' ||
    block.timestamp < 1n
  )
    throw new Error('supplemental_aave_usde_cash_invalid_header')
  const milliseconds = Number(block.timestamp) * 1000
  if (!Number.isSafeInteger(milliseconds))
    throw new Error('supplemental_aave_usde_cash_invalid_clock')
  return {
    number: block.number,
    hash: block.hash.toLowerCase(),
    timestamp: block.timestamp,
    at: new Date(milliseconds).toISOString(),
  }
}

function rowForState(manifest, anchorAt, block, state) {
  const subject = validateSupplementalAaveUsdeCashManifest(manifest)
  let normalized = state
  if (state?.state === 'observed') {
    if (
      state.asset !== subject.asset ||
      state.shareDecimals !== subject.asset_decimals ||
      state.assetDecimals !== subject.asset_decimals ||
      !RAW.test(state.cashRaw ?? '') ||
      BigInt(state.cashRaw) > MAX_U256 ||
      state.reason !== null
    )
      normalized = { state: 'identity_mismatch', reason: 'pinned_expected_asset_mismatch' }
  }
  if (normalized?.state === 'read_unavailable')
    throw new Error('supplemental_aave_usde_cash_transient_subject_read')
  if (!['observed', 'no_code', 'identity_mismatch'].includes(normalized?.state))
    throw new Error('supplemental_aave_usde_cash_invalid_subject_read')
  return {
    captureKind: 'backfilled',
    routeKey: subject.route_key,
    marketKey: subject.market_key,
    sourceKind: subject.source_kind,
    subjectKind: 'direct',
    venueKind: subject.venue_kind,
    destination: subject.destination,
    anchorAt,
    chainId: 1,
    block: block.number.toString(),
    blockHash: block.hash,
    blockAt: block.at,
    asset: normalized.state === 'observed' ? normalized.asset : null,
    shareDecimals: normalized.state === 'observed' ? normalized.shareDecimals : null,
    assetDecimals: normalized.state === 'observed' ? normalized.assetDecimals : null,
    cashRaw: normalized.state === 'observed' ? normalized.cashRaw : null,
    state: normalized.state,
    reason: normalized.reason,
    cohortId: subject.cohort_id,
    subjectManifestSha256: manifest.sha256,
  }
}

async function collectAndAppend(
  client,
  manifest,
  collectionMode,
  anchorAt,
  block,
  root,
  dependencies,
) {
  const market = supplementalAaveUsdeDirectMarket(manifest)
  const readCash = dependencies.readCash ?? readDirectCash
  const state = await readCash(client, market, block.number)
  const row = rowForState(manifest, anchorAt, block, state)
  const check = header(await client.getBlock({ blockNumber: block.number }))
  if (
    check.number !== block.number ||
    check.hash !== block.hash ||
    check.timestamp !== block.timestamp
  )
    throw new Error('supplemental_aave_usde_cash_source_changed')
  const firstLocalReceiptMs = dependencies.clock()
  if (
    !Number.isSafeInteger(firstLocalReceiptMs) ||
    firstLocalReceiptMs < Number(block.timestamp) * 1000
  )
    throw new Error('supplemental_aave_usde_cash_invalid_local_clock')
  const outcome = appendLocalSupplementalAaveUsdeCash(
    {
      collectionMode,
      anchorAt,
      block,
      rows: [row],
      firstLocalReceiptAt: new Date(firstLocalReceiptMs).toISOString(),
    },
    manifest,
    root,
  )
  return {
    status: outcome.status,
    anchorAt,
    block: block.number.toString(),
    blockHash: block.hash,
    coverage: outcome.record.coverage,
    sha256: outcome.record.sha256,
  }
}

export function subjectCoverage(manifest, records) {
  const subject = validateSupplementalAaveUsdeCashManifest(manifest)
  const states = ['observed', 'no_code', 'identity_mismatch']
  const counts = (items) =>
    Object.fromEntries(
      states.map((state) => [state, items.filter((item) => item.row.state === state).length]),
    )
  const matched = records.flatMap((receipt) =>
    receipt.rows
      .filter(
        (row) => row.routeKey === subject.route_key && row.destination === subject.destination,
      )
      .map((row) => ({ receipt, row })),
  )
  const observedTimes = matched
    .filter((item) => item.row.state === 'observed')
    .map((item) => item.row.blockAt)
    .sort()
  return [
    {
      routeKey: subject.route_key,
      destination: subject.destination,
      expectedAsset: subject.asset,
      assetDecimals: subject.asset_decimals,
      venueKind: subject.venue_kind,
      cohortId: subject.cohort_id,
      current: counts(matched.filter((item) => item.receipt.collectionMode === 'current')),
      retrospective: counts(
        matched.filter((item) => item.receipt.collectionMode === 'retrospective'),
      ),
      firstObservedSourceAt: observedTimes[0] ?? null,
      lastObservedSourceAt: observedTimes.at(-1) ?? null,
      firstLocalReceiptAt: matched.length
        ? matched.map((item) => item.receipt.firstLocalReceiptAt).sort()[0]
        : null,
    },
  ]
}

export async function run(
  client,
  manifest,
  options,
  root = LOCAL_SUPPLEMENTAL_AAVE_USDE_CASH_ROOT,
  deps = {},
) {
  validateSupplementalAaveUsdeCashManifest(manifest)
  const dependencies = {
    clock: deps.clock ?? Date.now,
    readCash: deps.readCash,
    resolveBlock: deps.resolveBlock ?? resolveAnchorBlock,
  }
  const prior = verifyLocalSupplementalAaveUsdeCash(manifest, root)
  if (options.mode === 'verify' || options.mode === 'coverage')
    return {
      mode: options.mode,
      schemaVersion: manifest.schemaVersion,
      study: manifest.study,
      manifestSha256: manifest.sha256,
      count: prior.count,
      lastSha256: prior.last?.sha256 ?? null,
      current: prior.records.filter((row) => row.collectionMode === 'current').length,
      retrospective: prior.records.filter((row) => row.collectionMode === 'retrospective').length,
      ...(options.mode === 'coverage'
        ? { subjects: subjectCoverage(manifest, prior.records) }
        : {}),
    }
  if (!client || (await client.getChainId()) !== 1)
    throw new Error('supplemental_aave_usde_cash_wrong_chain')
  const finalized = header(await client.getBlock({ blockTag: 'finalized' }))
  const now = dependencies.clock()
  const age = now - Date.parse(finalized.at)
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(age) || age < 0 || age > 2 * HOUR_MS)
    throw new Error('supplemental_aave_usde_cash_finalized_stale')
  if (options.mode === 'current') {
    const key = `current\0${finalized.at}`
    if (prior.keys.has(key))
      return { mode: 'current', skipped: 1, captures: [], count: prior.count }
    const capture = await collectAndAppend(
      client,
      manifest,
      'current',
      finalized.at,
      finalized,
      root,
      dependencies,
    )
    return { mode: 'current', skipped: 0, captures: [capture], count: prior.count + 1 }
  }
  const requested = historicalAnchorGrid(finalized.at, options)
  const pending = requested.filter((anchor) => !prior.keys.has(`retrospective\0${anchor}`))
  const captures = []
  let lower = 1n
  for (const anchor of pending.slice(0, options.maxAnchors)) {
    const block = header(await dependencies.resolveBlock(client, anchor, finalized, lower))
    captures.push(
      await collectAndAppend(client, manifest, 'retrospective', anchor, block, root, dependencies),
    )
    lower = block.number
  }
  return {
    mode: 'history',
    requestedAnchors: requested.length,
    remaining: pending.length - captures.length,
    captures,
    count: prior.count + captures.length,
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv)
  const manifest = await buildSupplementalAaveUsdeCashManifest()
  if (options.mode === 'verify' || options.mode === 'coverage') {
    process.stdout.write(JSON.stringify(await run(null, manifest, options)) + '\n')
    return
  }
  const { get } = readEnv()
  const rpcUrl =
    process.env.RECORDER_RPC_URLS ||
    process.env.RECORDER_RPC_URL ||
    get('RECORDER_RPC_URLS') ||
    get('RECORDER_RPC_URL')
  if (!rpcUrl) throw new Error('supplemental_aave_usde_cash_rpc_required')
  process.stdout.write(JSON.stringify(await run(makeClient(rpcUrl), manifest, options)) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // RPC failures can contain credential-bearing URLs; print only our code.
    process.stderr.write(
      `${String(error?.message ?? 'supplemental_aave_usde_cash_failed').split(' ')[0]}\n`,
    )
    process.exitCode = 1
  })
}
