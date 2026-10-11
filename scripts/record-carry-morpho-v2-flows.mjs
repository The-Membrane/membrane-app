// Exact 49-vault, finalized, prospective Morpho VaultV2 flow capture.
// Apply schema, enroll once at a fresh finalized block, then capture hourly.
// Every successful range records a receipt, including zero-event ranges.
// These events do not establish holder-executable exit or external transfer.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'
import { parseAbiItem, toEventHash } from 'viem'

import { ROOT, makeClient, readEnv } from './lib/venue-reads.mjs'
import { loadRouteVaultUniverse } from './record-carry-route-vaults.mjs'

const MANIFEST_PATH = join(ROOT, 'lib/carry/morpho-v2-asset-identities.json')
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const MAX_RANGE = 512n
const MAX_INTERVALS_PER_SUBJECT = 4
// The launchd stage has a 300-second hard timeout. Leave time to emit a
// freshness result after the last atomic interval rather than being killed.
const CAPTURE_TIME_BUDGET_MS = 240_000
const MAX_HEAD_AGE_MS = 2 * 60 * 60 * 1000
const PINNED_MANIFEST_SHA256 = '8dd54bbb3dea0842bb67e582f0725adcafb7594107933122c5fa381c083566da'
const PINNED_SEED_SHA256 = 'c3e85a98ff3b634c8e6c4bdd4cc64e94f3bdcc417c071125cd40cdff09a21243'
const PINNED_BOARD_SHA256 = '37ac4ce12ebcd1fce9f8ebf4e7d303435a14c3eed24157ff69e9992722137413'
const PINNED_DISPLAY_SHA256 = 'fb78f028b1a5889d226153da103e68c8c55ad75e0c23326721e0dd8808a9e61e'
const DEPOSIT = parseAbiItem(
  'event Deposit(address indexed sender,address indexed onBehalf,uint256 assets,uint256 shares)',
)
const WITHDRAW = parseAbiItem(
  'event Withdraw(address indexed sender,address indexed receiver,address indexed onBehalf,uint256 assets,uint256 shares)',
)
const FORCE = parseAbiItem(
  'event ForceDeallocate(address indexed sender,address adapter,uint256 assets,address indexed onBehalf,bytes32[] ids,uint256 penaltyAssets)',
)
const EVENT_TOPICS = new Map([
  [toEventHash(DEPOSIT).toLowerCase(), 'deposit'],
  [toEventHash(WITHDRAW).toLowerCase(), 'withdraw'],
  [toEventHash(FORCE).toLowerCase(), 'force'],
])
const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex')
const lower = (value) => String(value ?? '').toLowerCase()

function checkedHash(value) {
  const result = lower(value)
  if (!HASH.test(result)) throw new Error('invalid_block_or_transaction_hash')
  return result
}
function checkedAddress(value) {
  const result = lower(value)
  if (!ADDRESS.test(result)) throw new Error('invalid_flow_address')
  return result
}
function checkedIndex(value) {
  if (
    (typeof value !== 'number' && typeof value !== 'bigint') ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 0
  )
    throw new Error('invalid_flow_index')
  return Number(value)
}
function checkedRaw(value) {
  if (typeof value !== 'bigint' || value < 0n || value >= 1n << 256n)
    throw new Error('invalid_flow_uint256')
  return value.toString()
}
function blockHeader(block, expected = null, now = Date.now()) {
  if (
    typeof block?.number !== 'bigint' ||
    block.number < 1n ||
    (expected !== null && block.number !== expected) ||
    typeof block.timestamp !== 'bigint'
  )
    throw new Error('invalid_finalized_block_header')
  const hash = checkedHash(block.hash)
  const observedAt = new Date(Number(block.timestamp) * 1000)
  if (
    !Number.isFinite(observedAt.getTime()) ||
    now < observedAt.getTime() ||
    now - observedAt.getTime() > MAX_HEAD_AGE_MS
  )
    throw new Error('finalized_head_stale')
  return { block: block.number.toString(), blockHash: hash, observedAt: observedAt.toISOString() }
}

/** Factory event identity, route seed and rendered board must agree exactly. */
export async function loadMorphoFlowSubjects(
  manifestPath = MANIFEST_PATH,
  loadUniverse = loadRouteVaultUniverse,
) {
  const [{ universe, provenance }, bytes] = await Promise.all([
    loadUniverse(),
    readFile(manifestPath),
  ])
  const manifest = JSON.parse(bytes.toString())
  const manifestSha256 = hashBytes(bytes)
  if (
    manifest.schemaVersion !== 1 ||
    manifest.chainId !== 1 ||
    manifest.cohortId !== provenance.cohortId ||
    manifest.sourceArtifact?.sha256 !==
      '745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa' ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length !== 49 ||
    universe.subjects.length !== 64 ||
    universe.displayedRouteCount !== 25 ||
    manifestSha256 !== PINNED_MANIFEST_SHA256 ||
    provenance.seedSha256 !== PINNED_SEED_SHA256 ||
    provenance.boardSha256 !== PINNED_BOARD_SHA256 ||
    provenance.displayedRoutesSha256 !== PINNED_DISPLAY_SHA256
  )
    throw new Error('morpho_flow_cohort_changed')
  const routeMap = new Map()
  for (const row of universe.subjects) {
    const vault = checkedAddress(row.vault)
    const routes = routeMap.get(vault) || new Set()
    routes.add(row.routeKey)
    routeMap.set(vault, routes)
  }
  const seen = new Set()
  const subjects = manifest.entries
    .map((entry) => {
      const vault = checkedAddress(entry.vault)
      const asset = checkedAddress(entry.asset)
      const routeKeys = [...(routeMap.get(vault) || [])].sort()
      if (
        seen.has(vault) ||
        !routeKeys.length ||
        !routeKeys.every((key) => key.includes('→ VaultV2 [')) ||
        !HASH.test(lower(entry.creation?.blockHash)) ||
        !HASH.test(lower(entry.creation?.txHash))
      )
        throw new Error('morpho_flow_manifest_route_mismatch')
      seen.add(vault)
      return {
        vault,
        asset,
        routeKeys,
        manifestSha256,
        seedSha256: provenance.seedSha256,
        boardSha256: provenance.boardSha256,
        displayedRoutesSha256: provenance.displayedRoutesSha256,
        cohortId: provenance.cohortId,
      }
    })
    .sort((a, b) => a.vault.localeCompare(b.vault))
  if (seen.size !== 49) throw new Error('morpho_flow_duplicate_vault')
  return subjects
}

export function planRange(cursor, finalized) {
  const last = BigInt(cursor.last_block ?? cursor.lastBlock)
  const head = BigInt(finalized)
  if (last < 1n || head < 1n || !HASH.test(lower(cursor.last_hash ?? cursor.lastHash)))
    throw new Error('invalid_morpho_flow_cursor')
  if (head <= last) return null
  return {
    fromBlock: last + 1n,
    toBlock: last + MAX_RANGE < head ? last + MAX_RANGE : head,
    priorHash: lower(cursor.last_hash ?? cursor.lastHash),
  }
}

export function classifyFlowEvent(kind, receiver, vault, forceEventInTransaction) {
  if (kind === 'deposit') return 'deposit_observed'
  if (kind !== 'withdraw') throw new Error('unknown_morpho_flow_event')
  if (checkedAddress(receiver) !== checkedAddress(vault)) return 'external_receiver_unreconciled'
  return forceEventInTransaction ? 'internal_force_deallocate' : 'internal_vault_receiver'
}

export function normalizeFlowLogs(vault, depositLogs, withdrawLogs, forceLogs, fromBlock, toBlock) {
  const forceTx = new Set(forceLogs.map((log) => checkedHash(log.transactionHash)))
  const rows = []
  const seen = new Set()
  for (const [kind, logs] of [
    ['deposit', depositLogs],
    ['withdraw', withdrawLogs],
  ]) {
    for (const log of logs) {
      const block = BigInt(log.blockNumber)
      const tx = checkedHash(log.transactionHash)
      const logIndex = checkedIndex(log.logIndex)
      const key = `${tx}:${logIndex}`
      if (
        block < fromBlock ||
        block > toBlock ||
        checkedAddress(log.address) !== checkedAddress(vault) ||
        log.removed === true ||
        seen.has(key)
      )
        throw new Error('invalid_or_duplicate_flow_log')
      seen.add(key)
      const owner = checkedAddress(log.args?.onBehalf)
      const receiver = kind === 'withdraw' ? checkedAddress(log.args?.receiver) : null
      const force = forceTx.has(tx)
      rows.push({
        block: block.toString(),
        block_hash: checkedHash(log.blockHash),
        transaction_hash: tx,
        transaction_index: checkedIndex(log.transactionIndex),
        log_index: logIndex,
        event_kind: kind,
        sender: checkedAddress(log.args?.sender),
        owner,
        receiver,
        assets_raw: checkedRaw(log.args?.assets),
        shares_raw: checkedRaw(log.args?.shares),
        flow_class: classifyFlowEvent(kind, receiver, vault, force),
        force_event_in_transaction: force,
      })
    }
  }
  rows.sort((a, b) =>
    BigInt(a.block) < BigInt(b.block)
      ? -1
      : BigInt(a.block) > BigInt(b.block)
        ? 1
        : a.log_index - b.log_index,
  )
  if (rows.length > 10000) throw new Error('morpho_flow_range_too_many_events')
  for (const log of forceLogs) {
    const block = BigInt(log.blockNumber)
    if (
      block < fromBlock ||
      block > toBlock ||
      checkedAddress(log.address) !== checkedAddress(vault) ||
      log.removed === true
    )
      throw new Error('invalid_force_deallocate_log')
  }
  return rows
}

/** Compare two provider queries with different topic shapes, including raw data. */
export function compareCombinedLogs(depositLogs, withdrawLogs, forceLogs, combinedLogs) {
  function key(log, expectedKind = null) {
    const topic = lower(log.topics?.[0])
    const kind = EVENT_TOPICS.get(topic)
    if (
      !kind ||
      (expectedKind && kind !== expectedKind) ||
      typeof log.data !== 'string' ||
      !/^0x[0-9a-f]*$/i.test(log.data)
    )
      throw new Error('morpho_flow_event_topic_or_data_invalid')
    return JSON.stringify([
      checkedAddress(log.address),
      String(BigInt(log.blockNumber)),
      checkedHash(log.blockHash),
      checkedHash(log.transactionHash),
      checkedIndex(log.transactionIndex),
      checkedIndex(log.logIndex),
      kind,
      log.topics.map(lower),
      lower(log.data),
    ])
  }
  const separate = [
    ...depositLogs.map((log) => key(log, 'deposit')),
    ...withdrawLogs.map((log) => key(log, 'withdraw')),
    ...forceLogs.map((log) => key(log, 'force')),
  ].sort()
  const combined = combinedLogs.map((log) => key(log)).sort()
  if (
    separate.length !== new Set(separate).size ||
    combined.length !== new Set(combined).size ||
    JSON.stringify(separate) !== JSON.stringify(combined)
  )
    throw new Error('morpho_flow_combined_topic_disagreement')
  return hashBytes(JSON.stringify(combined))
}

export async function collectFlowInterval(client, subject, cursor, finalized) {
  const finalizedHeadHash = checkedHash(finalized?.hash)
  const plan = planRange(cursor, finalized.number)
  if (!plan) return null
  const { fromBlock, toBlock, priorHash } = plan
  const prior = await client.getBlock({ blockNumber: fromBlock - 1n })
  if (prior?.number !== fromBlock - 1n || checkedHash(prior.hash) !== priorHash)
    throw new Error('morpho_flow_prior_hash_changed')
  const [start, end] = await Promise.all([
    client.getBlock({ blockNumber: fromBlock }),
    client.getBlock({ blockNumber: toBlock }),
  ])
  if (
    start?.number !== fromBlock ||
    end?.number !== toBlock ||
    !HASH.test(lower(start.hash)) ||
    !HASH.test(lower(end.hash))
  )
    throw new Error('morpho_flow_invalid_range_headers')
  if (toBlock === finalized.number && checkedHash(end.hash) !== finalizedHeadHash)
    throw new Error('morpho_flow_finalized_head_hash_changed')
  const [depositLogs, withdrawLogs, forceLogs, combinedLogs] = await Promise.all([
    client.getLogs({ address: subject.vault, event: DEPOSIT, fromBlock, toBlock }),
    client.getLogs({ address: subject.vault, event: WITHDRAW, fromBlock, toBlock }),
    client.getLogs({ address: subject.vault, event: FORCE, fromBlock, toBlock }),
    client.getLogs({
      address: subject.vault,
      events: [DEPOSIT, WITHDRAW, FORCE],
      fromBlock,
      toBlock,
    }),
  ])
  const combinedSetSha256 = compareCombinedLogs(depositLogs, withdrawLogs, forceLogs, combinedLogs)
  const events = normalizeFlowLogs(
    subject.vault,
    depositLogs,
    withdrawLogs,
    forceLogs,
    fromBlock,
    toBlock,
  )
  const eventBlockHashes = new Map()
  for (const log of [...depositLogs, ...withdrawLogs, ...forceLogs]) {
    const number = BigInt(log.blockNumber)
    const hash = checkedHash(log.blockHash)
    if (eventBlockHashes.has(number) && eventBlockHashes.get(number) !== hash)
      throw new Error('morpho_flow_event_block_hash_disagreement')
    eventBlockHashes.set(number, hash)
  }
  for (const [number, hash] of eventBlockHashes) {
    const header = await client.getBlock({ blockNumber: number })
    if (header?.number !== number || checkedHash(header.hash) !== hash)
      throw new Error('morpho_flow_event_block_hash_changed')
  }
  // A separate late header read catches endpoint disagreement/reorganization.
  const [priorAgain, startAgain, endAgain] = await Promise.all([
    client.getBlock({ blockNumber: fromBlock - 1n }),
    client.getBlock({ blockNumber: fromBlock }),
    client.getBlock({ blockNumber: toBlock }),
  ])
  if (
    checkedHash(priorAgain?.hash) !== priorHash ||
    checkedHash(startAgain?.hash) !== checkedHash(start.hash) ||
    checkedHash(endAgain?.hash) !== checkedHash(end.hash) ||
    endAgain.number !== end.number
  )
    throw new Error('morpho_flow_range_hash_changed')
  if (toBlock === finalized.number && checkedHash(endAgain.hash) !== finalizedHeadHash)
    throw new Error('morpho_flow_finalized_head_hash_changed')
  const payload = {
    vault: subject.vault,
    asset: subject.asset,
    manifestSha256: subject.manifestSha256,
    seedSha256: subject.seedSha256,
    boardSha256: subject.boardSha256,
    displayedRoutesSha256: subject.displayedRoutesSha256,
    cohortId: subject.cohortId,
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    priorHash,
    toHash: checkedHash(end.hash),
    finalizedHeadBlock: finalized.number.toString(),
    finalizedHeadHash,
    toObservedAt: new Date(Number(end.timestamp) * 1000).toISOString(),
    combinedSetSha256,
    events,
  }
  return { ...payload, payloadSha256: hashBytes(JSON.stringify(payload)) }
}

const SAFE_FAILURE_CODES = new Set([
  'morpho_flow_wrong_chain',
  'finalized_head_stale',
  'morpho_flow_cohort_changed',
  'morpho_flow_prior_hash_changed',
  'morpho_flow_invalid_range_headers',
  'morpho_flow_finalized_head_hash_changed',
  'morpho_flow_range_hash_changed',
  'morpho_flow_event_block_hash_changed',
  'morpho_flow_event_block_hash_disagreement',
  'morpho_flow_combined_topic_disagreement',
  'morpho_flow_event_topic_or_data_invalid',
  'morpho_flow_subjects_not_enrolled_exactly',
  'morpho_flow_unexpected_replay',
  'morpho_flow_enrollment_block_changed',
  'morpho_flow_enrollment_replay_disagreement',
  'recorder_rpc_and_database_url_required',
])
export function safeFailureCode(error) {
  return SAFE_FAILURE_CODES.has(error?.message) ? error.message : 'morpho_flow_recorder_failed'
}

export async function enrollSubjects(sql, client, subjects, now = Date.now()) {
  if ((await client.getChainId()) !== 1) throw new Error('morpho_flow_wrong_chain')
  const finalized = await client.getBlock({ blockTag: 'finalized' })
  const header = blockHeader(finalized, null, now)
  for (const subject of subjects) {
    const liveAsset = await client.readContract({
      address: subject.vault,
      abi: [
        {
          type: 'function',
          name: 'asset',
          stateMutability: 'view',
          inputs: [],
          outputs: [{ type: 'address' }],
        },
      ],
      functionName: 'asset',
      blockNumber: finalized.number,
    })
    if (checkedAddress(liveAsset) !== subject.asset)
      throw new Error(`morpho_flow_asset_identity_changed:${subject.vault}`)
  }
  const again = await client.getBlock({ blockNumber: finalized.number })
  if (checkedHash(again.hash) !== header.blockHash)
    throw new Error('morpho_flow_enrollment_block_changed')
  const queries = subjects.map((subject) => {
    const payload = JSON.stringify({
      ...subject,
      block: header.block,
      blockHash: header.blockHash,
      observedAt: header.observedAt,
    })
    return sql`SELECT carry_morpho_v2_enroll(${payload}::jsonb) AS exact`
  })
  const results = await sql.transaction(queries)
  if (results.length !== subjects.length || results.some((rows) => rows[0]?.exact !== true))
    throw new Error('morpho_flow_enrollment_replay_disagreement')
  return { enrolled: subjects.length, ...header }
}

export function summarizeCursorFreshness(cursors, subjects, finalizedBlock) {
  const head = BigInt(finalizedBlock)
  let maxLagBlocks = 0n
  let totalLagBlocks = 0n
  let staleSubjectCount = 0
  for (const subject of subjects) {
    const cursor = cursors.get(subject.vault)
    if (!cursor) throw new Error('morpho_flow_subjects_not_enrolled_exactly')
    const last = BigInt(cursor.last_block ?? cursor.lastBlock)
    if (last < 1n || last > head || !HASH.test(lower(cursor.last_hash ?? cursor.lastHash)))
      throw new Error('invalid_morpho_flow_cursor')
    const lag = head - last
    if (lag > 0n) staleSubjectCount++
    if (lag > maxLagBlocks) maxLagBlocks = lag
    totalLagBlocks += lag
  }
  return {
    cursorFreshness: staleSubjectCount === 0 ? 'aligned' : 'lagging',
    caughtUp: subjects.length - staleSubjectCount,
    staleSubjectCount,
    maxLagBlocks: maxLagBlocks.toString(),
    totalLagBlocks: totalLagBlocks.toString(),
  }
}

/** Oldest cursor first prevents a deadline from repeatedly starving tail vaults. */
export function orderSubjectsByCursor(subjects, cursors) {
  return [...subjects].sort((a, b) => {
    const left = cursors.get(a.vault)
    const right = cursors.get(b.vault)
    if (!left || !right) throw new Error('morpho_flow_subjects_not_enrolled_exactly')
    const l = BigInt(left.last_block ?? left.lastBlock)
    const r = BigInt(right.last_block ?? right.lastBlock)
    return l < r ? -1 : l > r ? 1 : a.vault.localeCompare(b.vault)
  })
}

export async function captureSubjects(
  sql,
  client,
  subjects,
  now = Date.now(),
  { maxIntervalsPerSubject = MAX_INTERVALS_PER_SUBJECT,
    timeBudgetMs = CAPTURE_TIME_BUDGET_MS,
    clock = Date.now } = {},
) {
  if (!Number.isSafeInteger(maxIntervalsPerSubject) || maxIntervalsPerSubject < 1 ||
      !Number.isSafeInteger(timeBudgetMs) || timeBudgetMs < 1)
    throw new Error('invalid_morpho_flow_capture_budget')
  const deadline = clock() + timeBudgetMs
  if ((await client.getChainId()) !== 1) throw new Error('morpho_flow_wrong_chain')
  const finalized = await client.getBlock({ blockTag: 'finalized' })
  const head = blockHeader(finalized, null, now)
  const cursors = await sql`SELECT vault, last_block::text, last_hash
    FROM carry_morpho_v2_flow_cursors ORDER BY vault`
  const byVault = new Map(cursors.map((row) => [row.vault, row]))
  if (byVault.size !== 49 || subjects.some((s) => !byVault.has(s.vault)))
    throw new Error('morpho_flow_subjects_not_enrolled_exactly')
  let recorded = 0
  let eventCount = 0
  let budgetExhausted = false
  // Round robin keeps every vault's lag visible and bounds provider load.
  // Each range is at most 512 blocks and is persisted atomically before the
  // in-memory cursor advances. A failure never seals the missing interval.
  outer: for (let pass = 0; pass < maxIntervalsPerSubject; pass++) {
    let advanced = 0
    for (const subject of orderSubjectsByCursor(subjects, byVault)) {
      if (clock() >= deadline) {
        budgetExhausted = true
        break outer
      }
      const cursor = byVault.get(subject.vault)
      if (BigInt(cursor.last_block) >= finalized.number) continue
      const payload = await collectFlowInterval(client, subject, cursor, finalized)
      if (!payload) continue
      const encoded = JSON.stringify(payload)
      const rows = await sql`SELECT carry_morpho_v2_record_interval(${encoded}::jsonb) AS inserted`
      if (rows[0]?.inserted !== true) throw new Error('morpho_flow_unexpected_replay')
      byVault.set(subject.vault, { vault: subject.vault,
        last_block: payload.toBlock, last_hash: payload.toHash })
      recorded++
      advanced++
      eventCount += payload.events.length
    }
    if (advanced === 0) break
  }
  const freshness = summarizeCursorFreshness(byVault, subjects, finalized.number)
  return { ...head, recorded, eventCount, subjectCount: subjects.length,
    maxIntervalsPerSubject, budgetExhausted, ...freshness }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !['--enroll', '--capture'].includes(argv[0]))
    throw new Error('usage: node scripts/record-carry-morpho-v2-flows.mjs --enroll|--capture')
  const { get } = readEnv()
  const rpc =
    process.env.RECORDER_RPC_URLS ||
    process.env.RECORDER_RPC_URL ||
    get('RECORDER_RPC_URLS') ||
    get('RECORDER_RPC_URL')
  const db =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  if (!rpc || !db) throw new Error('recorder_rpc_and_database_url_required')
  const subjects = await loadMorphoFlowSubjects()
  const sql = neon(db)
  const client = makeClient(rpc)
  const result =
    argv[0] === '--enroll'
      ? await enrollSubjects(sql, client, subjects)
      : await captureSubjects(sql, client, subjects)
  process.stdout.write(JSON.stringify({ status: 'recorded', mode: argv[0], ...result }) + '\n')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${safeFailureCode(error)}\n`)
    process.exitCode = 1
  })
}
