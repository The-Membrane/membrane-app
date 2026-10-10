// Local Mac read-only cash capture for the frozen August 25 Carry route groups.
// This measures aggregate underlying-token cash at a pinned Ethereum block.
// It does not measure holder execution, route conversion, competing flow, or
// expected future cash. History is reconstructed and labelled separately.
//
// node --import tsx scripts/record-carry-cash-local.mjs --current
// node --import tsx scripts/record-carry-cash-local.mjs --history --lookback-hours 24
// node --import tsx scripts/record-carry-cash-local.mjs --history --as-of 2026-09-30T22:00:00.000Z --lookback-hours 720 --step-hours 24 --max-anchors 2
// node --import tsx scripts/record-carry-cash-local.mjs --verify
// node --import tsx scripts/record-carry-cash-local.mjs --coverage
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import { buildSubjectManifest } from './record-carry-cash-issues.mjs'
import {
  collectAnchor,
  resolveAnchorBlock,
  validateManifest,
} from './backfill-carry-cash-archive.mjs'
import { makeClient, readEnv } from './lib/venue-reads.mjs'
import { appendLocalCarryCash, verifyLocalCarryCash } from './lib/localCarryCashStore.mjs'

const HOUR_MS = 3_600_000
const HASH = /^0x[0-9a-f]{64}$/

export function parseOptions(argv) {
  let mode = null
  const values = new Map()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (['--current', '--history', '--verify', '--coverage'].includes(arg)) {
      if (mode) throw new Error('carry_cash_local_multiple_modes')
      mode = arg.slice(2)
    } else if (arg === '--as-of') {
      if (values.has(arg) || !argv[i + 1])
        throw new Error('carry_cash_local_duplicate_or_missing_option')
      values.set(arg, argv[++i])
    } else if (['--lookback-hours', '--step-hours', '--max-anchors'].includes(arg)) {
      if (values.has(arg) || !argv[i + 1])
        throw new Error('carry_cash_local_duplicate_or_missing_option')
      values.set(arg, Number(argv[++i]))
    } else throw new Error('carry_cash_local_unknown_option')
  }
  mode ??= 'current'
  if (mode !== 'history' && values.size) throw new Error('carry_cash_local_history_options_only')
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
    throw new Error('carry_cash_local_history_bounds')
  return { mode, lookbackHours, stepHours, maxAnchors, asOf }
}

export function historicalAnchorGrid(finalizedAt, options) {
  const finalizedMs = Date.parse(finalizedAt)
  if (!Number.isSafeInteger(finalizedMs)) throw new Error('carry_cash_local_invalid_finalized_time')
  const hour =
    options.asOf == null
      ? Math.floor(finalizedMs / (24 * HOUR_MS)) * 24 * HOUR_MS
      : Date.parse(options.asOf)
  if (!Number.isSafeInteger(hour) || hour > finalizedMs || finalizedMs - hour > 120 * 24 * HOUR_MS)
    throw new Error('carry_cash_local_invalid_as_of')
  const anchors = []
  for (let hours = options.lookbackHours; hours >= 24; hours -= options.stepHours)
    anchors.push(new Date(hour - hours * HOUR_MS).toISOString())
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
    throw new Error('carry_cash_local_invalid_header')
  return {
    number: block.number,
    hash: block.hash.toLowerCase(),
    timestamp: block.timestamp,
    at: new Date(Number(block.timestamp) * 1000).toISOString(),
  }
}

async function collectAndAppend(client, manifest, collectionMode, anchorAt, block, root) {
  const rows = await collectAnchor(client, anchorAt, block, manifest)
  // A transient RPC miss is not a measured zero. Leave the anchor open for a
  // later retry rather than sealing an unavailable batch as historical data.
  if (rows.some((row) => row.state === 'read_unavailable'))
    throw new Error('carry_cash_local_transient_subject_read')
  const check = header(await client.getBlock({ blockNumber: block.number }))
  if (
    check.number !== block.number ||
    check.hash !== block.hash ||
    check.timestamp !== block.timestamp
  )
    throw new Error('carry_cash_local_source_changed')
  const outcome = appendLocalCarryCash(
    {
      collectionMode,
      anchorAt,
      block,
      rows,
      firstLocalReceiptAt: new Date().toISOString(),
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
  const states = ['observed', 'no_code', 'identity_mismatch', 'unassessed']
  const counts = (items) =>
    Object.fromEntries(
      states.map((state) => [state, items.filter((item) => item.row.state === state).length]),
    )
  return manifest.subjects.map((subject) => {
    const matched = records.flatMap((receipt) =>
      receipt.rows
        .filter(
          (row) => row.routeKey === subject.route_key && row.destination === subject.destination,
        )
        .map((row) => ({ receipt, row })),
    )
    const observed = matched.filter((item) => item.row.state === 'observed')
    const observedTimes = observed.map((item) => item.row.blockAt).sort()
    return {
      routeKey: subject.route_key,
      destination: subject.destination,
      expectedAsset: subject.asset,
      current: counts(matched.filter((item) => item.receipt.collectionMode === 'current')),
      retrospective: counts(
        matched.filter((item) => item.receipt.collectionMode === 'retrospective'),
      ),
      firstObservedSourceAt: observedTimes[0] ?? null,
      lastObservedSourceAt: observedTimes.at(-1) ?? null,
      firstLocalReceiptAt: matched.length
        ? matched.map((item) => item.receipt.firstLocalReceiptAt).sort()[0]
        : null,
    }
  })
}

export async function run(client, manifest, options, root, clock = Date.now) {
  validateManifest(manifest)
  const prior = verifyLocalCarryCash(manifest, root)
  if (options.mode === 'verify' || options.mode === 'coverage')
    return {
      mode: options.mode,
      count: prior.count,
      lastSha256: prior.last?.sha256 ?? null,
      current: prior.records.filter((row) => row.collectionMode === 'current').length,
      retrospective: prior.records.filter((row) => row.collectionMode === 'retrospective').length,
      ...(options.mode === 'coverage'
        ? { subjects: subjectCoverage(manifest, prior.records) }
        : {}),
    }
  if ((await client.getChainId()) !== 1) throw new Error('carry_cash_local_wrong_chain')
  const finalized = header(await client.getBlock({ blockTag: 'finalized' }))
  const age = clock() - Date.parse(finalized.at)
  if (!Number.isSafeInteger(age) || age < -120_000 || age > 2 * HOUR_MS)
    throw new Error('carry_cash_local_finalized_stale')
  if (options.mode === 'current') {
    const key = `current\0${finalized.at}`
    if (prior.keys.has(key))
      return {
        mode: 'current',
        skipped: 1,
        captures: [],
        count: prior.count,
      }
    const capture = await collectAndAppend(
      client,
      manifest,
      'current',
      finalized.at,
      finalized,
      root,
    )
    return { mode: 'current', skipped: 0, captures: [capture], count: prior.count + 1 }
  }
  const pending = historicalAnchorGrid(finalized.at, options).filter(
    (anchor) => !prior.keys.has(`retrospective\0${anchor}`),
  )
  const captures = []
  let lower = 1n
  for (const anchor of pending.slice(0, options.maxAnchors)) {
    const block = await resolveAnchorBlock(client, anchor, finalized, lower)
    captures.push(await collectAndAppend(client, manifest, 'retrospective', anchor, block, root))
    lower = block.number
  }
  return {
    mode: 'history',
    requestedAnchors: historicalAnchorGrid(finalized.at, options).length,
    remaining: pending.length - captures.length,
    captures,
    count: prior.count + captures.length,
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv)
  const manifest = await buildSubjectManifest()
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
  if (!rpcUrl) throw new Error('carry_cash_local_rpc_required')
  process.stdout.write(JSON.stringify(await run(makeClient(rpcUrl), manifest, options)) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // RPC failures can contain credential-bearing URLs; print only our code.
    process.stderr.write(`${String(error?.message ?? 'carry_cash_local_failed').split(' ')[0]}\n`)
    process.exitCode = 1
  })
}
