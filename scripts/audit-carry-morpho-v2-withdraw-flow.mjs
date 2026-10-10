// Read-only realized supplier-withdrawal maxima. No exit probability or duration claim.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'
import { makeClient, readEnv } from './lib/venue-reads.mjs'
import {
  MAX_RECEIPT_LOG_BYTES,
  canonicalJson,
  reconcileTransaction,
  verifyReconciliationProof,
} from './reconcile-carry-morpho-v2-withdrawals.mjs'

const DAY = 86_400n
const LOOKBACK = 14n * DAY
const MAX_HEAD_AGE_SECONDS = 2n * 3_600n
const WINDOWS = [DAY, 7n * DAY]
const MAX_EVENTS = 1_000
const MAX_INTERVALS = 2_000
const ADDRESS = /^0x[0-9a-f]{40}$/
const lower = (x) => String(x ?? '').toLowerCase()

/** Check exact block-contiguous coverage and each interval's linked endpoint hash. */
export function verifyCoverage(intervals, first, last) {
  if (BigInt(first) > BigInt(last)) return false
  const rows = [...intervals].sort((a, b) =>
    BigInt(a.from_block) < BigInt(b.from_block)
      ? -1
      : BigInt(a.from_block) > BigInt(b.from_block)
        ? 1
        : 0,
  )
  let next = BigInt(first)
  let priorHash = null
  for (const row of rows) {
    const from = BigInt(row.from_block)
    const to = BigInt(row.to_block)
    if (to < next) continue
    if (from > next || to < from) return false
    if (priorHash !== null && lower(row.prior_hash) !== priorHash) return false
    next = to + 1n
    priorHash = lower(row.to_hash)
    if (next > BigInt(last)) return true
  }
  return false
}

/** Recheck every sealed interval boundary, including empty interior ranges. */
export async function verifyCanonicalIntervalBoundaries(intervals, getHeader) {
  if (!Array.isArray(intervals) || intervals.length === 0 || intervals.length > MAX_INTERVALS)
    return false
  const expected = new Map()
  for (const interval of intervals) {
    const priorBlock = BigInt(interval.from_block) - 1n
    const endBlock = BigInt(interval.to_block)
    for (const [number, hash] of [
      [priorBlock, interval.prior_hash],
      [endBlock, interval.to_hash],
    ]) {
      if (number < 0n || !/^0x[0-9a-f]{64}$/.test(lower(hash))) return false
      const key = String(number)
      if (expected.has(key) && expected.get(key) !== lower(hash)) return false
      expected.set(key, lower(hash))
    }
  }
  const boundaries = [...expected]
  try {
    for (let offset = 0; offset < boundaries.length; offset += 8) {
      const batch = boundaries.slice(offset, offset + 8)
      const headers = await Promise.all(batch.map(([number]) => getHeader(BigInt(number))))
      if (
        headers.some(
          (header, index) =>
            BigInt(header?.number ?? -1) !== BigInt(batch[index][0]) ||
            lower(header?.hash) !== batch[index][1],
        )
      )
        return false
    }
  } catch {
    return false
  }
  return true
}

export function verifySupplierGroups(rows) {
  const byGroup = new Map()
  const byTransaction = new Map()
  for (const row of rows) {
    if (
      !row.status ||
      ![
        'reconciled_external_supplier',
        'internal_vault_receiver',
        'internal_force_deallocate',
      ].includes(row.status)
    )
      return false
    if (!verifyReconciliationProof(row, row)) return false
    const transactionKey = `${row.vault}:${row.transaction_hash}`
    const transaction = byTransaction.get(transactionKey) || []
    transaction.push(row)
    byTransaction.set(transactionKey, transaction)
    if (row.status !== 'reconciled_external_supplier') continue
    const group = row.evidence.group
    const key = `${row.vault}:${row.transaction_hash}:${row.receiver}`
    const bucket = byGroup.get(key) || []
    bucket.push(row)
    byGroup.set(key, bucket)
    if (group.receiver !== lower(row.receiver)) return false
  }
  for (const bucket of byGroup.values()) {
    const expected = bucket[0].evidence.group
    const indices = bucket.map((row) => Number(row.log_index)).sort((a, b) => a - b)
    const amount = bucket.reduce((sum, row) => sum + BigInt(row.assets_raw), 0n)
    if (
      canonicalJson(indices) !== canonicalJson(expected.withdrawLogIndices) ||
      amount !== BigInt(expected.withdrawAssetsRaw) ||
      bucket.some((row) => canonicalJson(row.evidence.group) !== canonicalJson(expected))
    )
      return false
  }
  // Replay each sealed full receipt log set against *all* recorded vault
  // Withdraw events in that transaction, including other receivers.
  for (const bucket of byTransaction.values()) {
    const first = bucket[0]
    const proof = first.evidence
    if (
      !Array.isArray(proof.receiptLogs) ||
      proof.receiptLogs.length > 500 ||
      canonicalJson(proof.receiptLogs).length > MAX_RECEIPT_LOG_BYTES ||
      bucket.some(
        (row) => canonicalJson(row.evidence.receiptLogs) !== canonicalJson(proof.receiptLogs),
      )
    )
      return false
    const receipt = {
      status: proof.receiptStatus,
      transactionHash: first.transaction_hash,
      blockNumber: BigInt(first.block),
      blockHash: first.block_hash,
      transactionIndex: proof.receiptTransactionIndex,
      logs: proof.receiptLogs,
    }
    const replay = reconcileTransaction(
      bucket,
      receipt,
      { number: BigInt(first.block), hash: proof.canonicalHeaderHash },
      { number: BigInt(proof.finalizedBlock), hash: proof.finalizedHash },
      proof.liveAsset,
    )
    if (
      replay.length !== bucket.length ||
      replay.some((item, index) => {
        const stored = bucket.find((row) => Number(row.log_index) === item.logIndex)
        return (
          !stored ||
          stored.status !== item.status ||
          canonicalJson(stored.evidence.group) !== canonicalJson(item.evidence.group)
        )
      })
    )
      return false
  }
  return true
}

/** Maximum sum in any complete rolling window within the certified span. */
export function maximumRollingFlow(events, startTime, endTime, windowSeconds) {
  const start = BigInt(startTime)
  const end = BigInt(endTime)
  const window = BigInt(windowSeconds)
  if (window <= 0n || end - start < window) return null
  const ordered = [...events]
    .map((row) => ({
      time: BigInt(row.time),
      amount: BigInt(row.assets_raw),
    }))
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
  if (ordered.some((row) => row.time < start || row.time > end || row.amount < 0n))
    throw new Error('rolling_flow_event_outside_coverage')
  let left = 0
  let right = 0
  let sum = 0n
  let maximum = 0n
  const candidateEnds = [
    start + window,
    end,
    ...ordered.map((row) => row.time).filter((time) => time >= start + window),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  for (const candidate of candidateEnds) {
    while (right < ordered.length && ordered[right].time <= candidate) {
      sum += ordered[right].amount
      right++
    }
    while (left < right && ordered[left].time < candidate - window) {
      sum -= ordered[left].amount
      left++
    }
    if (sum > maximum) maximum = sum
  }
  return maximum.toString()
}

export function certifiedWindowMaxima(external, startTime, endTime) {
  const start = BigInt(startTime)
  const end = BigInt(endTime)
  return Object.fromEntries(
    WINDOWS.map((window) => [
      window === DAY ? '24h' : '7d',
      end - start < window
        ? { status: 'unavailable', reason: 'insufficient_complete_history' }
        : {
            status: 'certified',
            maximumRawAssetUnits: maximumRollingFlow(external, start, end, window),
          },
    ]),
  )
}

async function blockAtOrAfter(client, startBlock, endBlock, targetTime) {
  let left = BigInt(startBlock)
  let right = BigInt(endBlock)
  while (left < right) {
    const mid = (left + right) / 2n
    const header = await client.getBlock({ blockNumber: mid })
    if (header.timestamp < targetTime) left = mid + 1n
    else right = mid
  }
  return left
}

export function assessCollectedEndpoint(
  finalized,
  collected,
  header,
  nowSeconds = BigInt(Math.floor(Date.now() / 1000)),
) {
  if (!collected) return { status: 'unavailable', reason: 'no_collected_interval' }
  if (
    !finalized?.number ||
    !finalized?.hash ||
    !finalized?.timestamp ||
    !header?.number ||
    !header?.hash ||
    !header?.timestamp
  )
    return { status: 'unavailable', reason: 'header_unavailable' }
  const current = BigInt(finalized.number)
  const end = BigInt(collected.to_block)
  const finalizedAge = BigInt(nowSeconds) - BigInt(finalized.timestamp)
  const lag = BigInt(finalized.timestamp) - BigInt(header.timestamp)
  const collectedAge = BigInt(nowSeconds) - BigInt(header.timestamp)
  if (finalizedAge < 0n || finalizedAge > MAX_HEAD_AGE_SECONDS)
    return { status: 'unavailable', reason: 'finalized_head_stale' }
  if (
    end > current ||
    BigInt(header.number) !== end ||
    lower(header.hash) !== lower(collected.to_hash) ||
    (end === current && lower(header.hash) !== lower(finalized.hash)) ||
    lag < 0n
  )
    return { status: 'unavailable', reason: 'collected_endpoint_not_canonical' }
  if (lag > MAX_HEAD_AGE_SECONDS || collectedAge < 0n || collectedAge > MAX_HEAD_AGE_SECONDS)
    return {
      status: 'unavailable',
      reason: 'collected_endpoint_stale',
      headLagSeconds: String(lag),
      collectedAgeSeconds: String(collectedAge),
    }
  return {
    status: 'usable',
    headLagSeconds: String(lag),
    finalizedHeadAgeSeconds: String(finalizedAge),
    collectedAgeSeconds: String(collectedAge),
  }
}

export async function auditVault(sql, client, vault) {
  if (!ADDRESS.test(lower(vault))) throw new Error('invalid_vault')
  if ((await client.getChainId()) !== 1) throw new Error('wrong_chain')
  const subject = (
    await sql`SELECT vault, asset, enrolled_block, enrolled_hash,
      manifest_sha256, seed_sha256, board_sha256, displayed_routes_sha256, cohort_id
    FROM carry_morpho_v2_flow_subjects WHERE vault = ${lower(vault)}`
  )[0]
  if (!subject) return { vault: lower(vault), status: 'unavailable', reason: 'not_enrolled' }
  const finalized = await client.getBlock({ blockTag: 'finalized' })
  const collected = (
    await sql`SELECT to_block, to_hash, to_observed_at
    FROM carry_morpho_v2_flow_intervals WHERE vault = ${lower(vault)}
    ORDER BY to_block DESC LIMIT 1`
  )[0]
  if (!collected)
    return { vault: lower(vault), status: 'unavailable', reason: 'no_collected_interval' }
  const endBlock = BigInt(collected.to_block)
  const endHeader = await client.getBlock({ blockNumber: endBlock })
  const endpoint = assessCollectedEndpoint(finalized, collected, endHeader)
  if (endpoint.status !== 'usable') return { vault: lower(vault), ...endpoint }
  const endTime = BigInt(endHeader.timestamp)
  const earliest = BigInt(subject.enrolled_block) + 1n
  if (earliest > endBlock)
    return { vault: lower(vault), status: 'unavailable', reason: 'no_finalized_span' }
  const target = endTime - LOOKBACK
  const startBlock = await blockAtOrAfter(client, earliest, endBlock, target)
  const startHeader = await client.getBlock({ blockNumber: startBlock })
  const startTime = BigInt(startHeader.timestamp)
  const intervals = await sql`SELECT from_block, to_block, prior_hash, to_hash
    FROM carry_morpho_v2_flow_intervals WHERE vault = ${lower(vault)}
      AND to_block >= ${String(startBlock)} AND from_block <= ${String(endBlock)}
    ORDER BY from_block LIMIT ${MAX_INTERVALS + 1}`
  if (intervals.length > MAX_INTERVALS)
    return { vault: lower(vault), status: 'unavailable', reason: 'interval_bound_exceeded' }
  if (
    !verifyCoverage(intervals, startBlock, endBlock) ||
    BigInt(intervals.at(-1)?.to_block ?? -1) !== endBlock ||
    lower(intervals.at(-1)?.to_hash) !== lower(endHeader.hash)
  )
    return {
      vault: lower(vault),
      status: 'unavailable',
      reason: 'flow_range_gap',
      startBlock: String(startBlock),
      endBlock: String(endBlock),
    }
  if (
    !(await verifyCanonicalIntervalBoundaries(intervals, (number) =>
      client.getBlock({ blockNumber: number }),
    ))
  )
    return { vault: lower(vault), status: 'unavailable', reason: 'flow_range_canonical_mismatch' }
  const events = await sql`SELECT e.*, e.assets_raw::text, e.shares_raw::text,
      s.asset, s.manifest_sha256, s.seed_sha256, s.board_sha256,
      s.displayed_routes_sha256, s.cohort_id,
      r.status, r.reason, r.source_sha256, r.evidence, r.evidence_sha256
    FROM carry_morpho_v2_flow_events e
    JOIN carry_morpho_v2_flow_subjects s ON s.vault = e.vault
    LEFT JOIN LATERAL (
      SELECT status, reason, source_sha256, evidence, evidence_sha256
      FROM carry_morpho_v2_withdraw_reconciliation r
      WHERE r.vault = e.vault AND r.transaction_hash = e.transaction_hash
        AND r.log_index = e.log_index ORDER BY attempt_slot DESC LIMIT 1
    ) r ON true
    WHERE e.vault = ${lower(vault)} AND e.event_kind = 'withdraw'
      AND e.block BETWEEN ${String(startBlock)} AND ${String(endBlock)}
    ORDER BY e.block, e.log_index LIMIT ${MAX_EVENTS + 1}`
  if (events.length > MAX_EVENTS)
    return { vault: lower(vault), status: 'unavailable', reason: 'event_bound_exceeded' }
  try {
    if (!verifySupplierGroups(events))
      return {
        vault: lower(vault),
        status: 'unavailable',
        reason: 'withdrawal_unreconciled',
        withdrawals: events.length,
      }
  } catch {
    return { vault: lower(vault), status: 'unavailable', reason: 'proof_validation_failed' }
  }
  const timestamps = new Map()
  for (const row of events) {
    const number = BigInt(row.block)
    if (!timestamps.has(number)) {
      const header = await client.getBlock({ blockNumber: number })
      if (lower(header.hash) !== lower(row.block_hash))
        return { vault: lower(vault), status: 'unavailable', reason: 'event_header_mismatch' }
      timestamps.set(number, BigInt(header.timestamp))
    }
  }
  const external = events
    .filter((row) => row.status === 'reconciled_external_supplier')
    .map((row) => ({
      time: timestamps.get(BigInt(row.block)).toString(),
      assets_raw: String(row.assets_raw),
    }))
  const maxima = certifiedWindowMaxima(external, startTime, endTime)
  return {
    vault: lower(vault),
    asset: lower(subject.asset),
    status: Object.values(maxima).every((window) => window.status === 'certified')
      ? 'certified'
      : 'partial',
    metric: 'realized_external_supplier_withdrawal_maximum',
    distinction: 'not_gross_market_cash_outflow_or_future_exit_ability',
    startBlock: String(startBlock),
    startHash: lower(startHeader.hash),
    endBlock: String(endBlock),
    endHash: lower(endHeader.hash),
    asOfBlock: String(endBlock),
    asOfBlockTimestamp: String(endTime),
    finalizedHeadBlock: String(finalized.number),
    finalizedHeadHash: lower(finalized.hash),
    headLagSeconds: endpoint.headLagSeconds,
    finalizedHeadAgeSeconds: endpoint.finalizedHeadAgeSeconds,
    collectedAgeSeconds: endpoint.collectedAgeSeconds,
    collectedObservedAt: collected.to_observed_at,
    startTime: String(startTime),
    endTime: String(endTime),
    withdrawalEvents: events.length,
    externalSupplierEvents: external.length,
    windows: maxima,
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== '--vault' || !ADDRESS.test(lower(argv[1])))
    throw new Error('usage: node scripts/audit-carry-morpho-v2-withdraw-flow.mjs --vault 0x...')
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
  if (!rpc || !db) throw new Error('rpc_and_database_url_required')
  const result = await auditVault(neon(db), makeClient(rpc), lower(argv[1]))
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('morpho_withdraw_flow_audit_failed\n')
    process.exitCode = 1
  })
}
