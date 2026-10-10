// Receipt-level, exact vault Withdraw -> underlying Transfer reconciliation.
// This is a separate append-only layer; it never rewrites the flow ledger.
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  parseAbiItem,
  toEventHash,
} from 'viem'

import { makeClient, readEnv } from './lib/venue-reads.mjs'

const WITHDRAW = parseAbiItem(
  'event Withdraw(address indexed sender,address indexed receiver,address indexed onBehalf,uint256 assets,uint256 shares)',
)
const FORCE = parseAbiItem(
  'event ForceDeallocate(address indexed sender,address adapter,uint256 assets,address indexed onBehalf,bytes32[] ids,uint256 penaltyAssets)',
)
const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from,address indexed to,uint256 value)',
)
const ASSET = parseAbi(['function asset() view returns (address)'])
const WITHDRAW_TOPIC = toEventHash(WITHDRAW).toLowerCase()
const FORCE_TOPIC = toEventHash(FORCE).toLowerCase()
const TRANSFER_TOPIC = toEventHash(TRANSFER).toLowerCase()
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const ZERO = '0x0000000000000000000000000000000000000000'
const SLOT_MS = 15 * 60_000
const MAX_TX = 20
const MAX_MS = 90_000
// Full receipt replay is retained; allow large bundled transactions while
// bounding each immutable proof to at most 256 KiB of serialized log evidence.
export const MAX_RECEIPT_LOG_BYTES = 262_144
const lower = (x) => String(x ?? '').toLowerCase()
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}
const sha = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex')

function validAddress(x) {
  return ADDRESS.test(lower(x))
}
function validHash(x) {
  return HASH.test(lower(x))
}
function safeUInt(x) {
  try {
    const n = BigInt(x)
    return n >= 0n && n < 1n << 256n ? n : null
  } catch {
    return null
  }
}

export function sourceIdentity(row) {
  const value = {
    vault: lower(row.vault),
    asset: lower(row.asset),
    manifestSha256: row.manifest_sha256,
    seedSha256: row.seed_sha256,
    boardSha256: row.board_sha256,
    displayedRoutesSha256: row.displayed_routes_sha256,
    cohortId: row.cohort_id,
    intervalFromBlock: String(row.interval_from_block),
    block: String(row.block),
    blockHash: lower(row.block_hash),
    transactionHash: lower(row.transaction_hash),
    transactionIndex: Number(row.transaction_index),
    logIndex: Number(row.log_index),
    eventKind: row.event_kind,
    sender: lower(row.sender),
    owner: lower(row.owner),
    receiver: lower(row.receiver),
    assetsRaw: String(row.assets_raw),
    sharesRaw: String(row.shares_raw),
    flowClass: row.flow_class,
    forceEventInTransaction: row.force_event_in_transaction,
  }
  if (
    !validAddress(value.vault) ||
    !validAddress(value.asset) ||
    !validAddress(value.sender) ||
    !validAddress(value.owner) ||
    !validAddress(value.receiver) ||
    !validHash(value.blockHash) ||
    !validHash(value.transactionHash) ||
    value.eventKind !== 'withdraw' ||
    safeUInt(value.assetsRaw) === null ||
    safeUInt(value.sharesRaw) === null ||
    !Number.isSafeInteger(value.transactionIndex) ||
    value.transactionIndex < 0 ||
    !Number.isSafeInteger(value.logIndex) ||
    value.logIndex < 0
  ) {
    throw new Error('invalid_morpho_withdraw_source')
  }
  return value
}

/** Recompute the sealed source and receipt envelope before derived use. */
export function verifyReconciliationProof(row, record) {
  try {
    const source = sourceIdentity(row)
    const evidence = record?.evidence
    if (
      !evidence ||
      record.source_sha256 !== sha(source) ||
      record.evidence_sha256 !== sha(evidence) ||
      sha(evidence.source) !== sha(source) ||
      evidence.vault !== source.vault ||
      evidence.asset !== source.asset ||
      evidence.block !== source.block ||
      evidence.blockHash !== source.blockHash ||
      evidence.transactionHash !== source.transactionHash ||
      evidence.logIndex !== source.logIndex ||
      evidence.receiptStatus !== 'success' ||
      evidence.receiptBlockHash !== source.blockHash ||
      evidence.canonicalHeaderHash !== source.blockHash ||
      evidence.liveAsset !== source.asset ||
      BigInt(evidence.finalizedBlock ?? -1) < BigInt(source.block) ||
      !validHash(evidence.finalizedHash)
    )
      return false
    if (record.status === 'reconciled_external_supplier') {
      const group = evidence.group
      if (
        !group ||
        group.receiver !== source.receiver ||
        safeUInt(group.withdrawAssetsRaw) === null ||
        safeUInt(group.paidAssetsRaw) === null ||
        BigInt(group.withdrawAssetsRaw) !== BigInt(group.paidAssetsRaw) ||
        BigInt(group.withdrawAssetsRaw) <= 0n ||
        !Array.isArray(group.withdrawLogIndices) ||
        !group.withdrawLogIndices.includes(source.logIndex) ||
        !Array.isArray(group.transferLogIndices) ||
        group.transferLogIndices.length < 1 ||
        new Set(group.transferLogIndices).size !== group.transferLogIndices.length
      )
        return false
    }
    return true
  } catch {
    return false
  }
}

function receiptLog(log, receipt) {
  return {
    address: lower(log.address),
    topics: log.topics.map(lower),
    data: lower(log.data),
    logIndex: Number(log.logIndex),
    blockHash: lower(log.blockHash),
    transactionHash: lower(log.transactionHash),
    transactionIndex: Number(log.transactionIndex),
    block: String(log.blockNumber ?? log.block),
    receiptBlockHash: lower(receipt.blockHash),
  }
}

function decoded(log, event) {
  try {
    return decodeEventLog({ abi: [event], data: log.data, topics: log.topics, strict: true }).args
  } catch {
    return null
  }
}

function proofFor(row, base, status, reason, group = null) {
  const source = sourceIdentity(row)
  const evidence = {
    ...base,
    vault: source.vault,
    asset: source.asset,
    block: source.block,
    blockHash: source.blockHash,
    transactionHash: source.transactionHash,
    logIndex: source.logIndex,
    source,
    group,
  }
  return {
    vault: source.vault,
    transactionHash: source.transactionHash,
    logIndex: source.logIndex,
    status,
    reason,
    sourceSha256: sha(source),
    evidence,
    evidenceSha256: sha(evidence),
  }
}

/** Pure receipt checker. Every receipt Withdraw of this vault must be in the ledger. */
export function reconcileTransaction(rows, receipt, header, finalized, liveAsset) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('withdraw_rows_required')
  const sources = rows.map(sourceIdentity)
  const vault = sources[0].vault
  const asset = sources[0].asset
  const tx = sources[0].transactionHash
  const block = sources[0].block
  const blockHash = sources[0].blockHash
  const base = {
    finalizedBlock: String(finalized?.number ?? ''),
    finalizedHash: lower(finalized?.hash),
    receiptStatus: receipt?.status ?? null,
    receiptBlockHash: lower(receipt?.blockHash),
    receiptTransactionIndex:
      receipt?.transactionIndex == null ? null : Number(receipt.transactionIndex),
    canonicalHeaderHash: lower(header?.hash),
    liveAsset: lower(liveAsset),
  }
  const all = (status, reason) => rows.map((row) => proofFor(row, base, status, reason))
  if (!receipt || !header || !finalized || !liveAsset)
    return all('unavailable', 'missing_receipt_or_header')
  if (receipt.status !== 'success') return all('ambiguous', 'receipt_not_successful')
  if (
    lower(receipt.transactionHash) !== tx ||
    String(receipt.blockNumber) !== block ||
    lower(receipt.blockHash) !== blockHash ||
    String(header.number) !== block ||
    lower(header.hash) !== blockHash ||
    BigInt(finalized.number) < BigInt(block) ||
    lower(liveAsset) !== asset ||
    Number(receipt.transactionIndex) !== sources[0].transactionIndex ||
    rows.some(
      (row) =>
        lower(row.vault) !== vault ||
        lower(row.asset) !== asset ||
        lower(row.transaction_hash) !== tx ||
        String(row.block) !== block ||
        lower(row.block_hash) !== blockHash,
    )
  )
    return all('ambiguous', 'canonical_or_asset_identity_mismatch')
  if (!Array.isArray(receipt.logs)) return all('unavailable', 'receipt_logs_missing')
  const logs = receipt.logs.map((log) => receiptLog(log, receipt))
  if (logs.length > 500 || canonicalJson(logs).length > MAX_RECEIPT_LOG_BYTES)
    return all('unavailable', 'receipt_log_bound_exceeded')
  if (
    logs.some(
      (log) =>
        log.block !== block ||
        log.blockHash !== blockHash ||
        log.transactionHash !== tx ||
        log.transactionIndex !== sources[0].transactionIndex ||
        !validAddress(log.address) ||
        !Number.isSafeInteger(log.logIndex) ||
        log.logIndex < 0 ||
        !/^0x[0-9a-f]*$/.test(log.data),
    )
  )
    return all('ambiguous', 'receipt_log_identity_mismatch')
  if (new Set(logs.map((log) => log.logIndex)).size !== logs.length)
    return all('ambiguous', 'duplicate_receipt_log_index')
  base.receiptLogs = logs
  const withdrawLogs = logs.filter(
    (log) => log.address === vault && log.topics[0] === WITHDRAW_TOPIC,
  )
  if (
    withdrawLogs.length !== rows.length ||
    new Set(rows.map((row) => Number(row.log_index))).size !== rows.length
  )
    return all('ambiguous', 'ledger_receipt_withdraw_set_mismatch')
  for (const row of rows) {
    const source = sourceIdentity(row)
    const log = withdrawLogs.find((item) => item.logIndex === source.logIndex)
    const args = log && decoded(log, WITHDRAW)
    if (
      !args ||
      lower(args.sender) !== source.sender ||
      lower(args.receiver) !== source.receiver ||
      lower(args.onBehalf) !== source.owner ||
      args.assets !== BigInt(source.assetsRaw) ||
      args.shares !== BigInt(source.sharesRaw)
    )
      return all('ambiguous', 'exact_withdraw_event_mismatch')
  }
  const forceLogs = logs.filter((log) => log.address === vault && log.topics[0] === FORCE_TOPIC)
  if (forceLogs.some((log) => !decoded(log, FORCE)))
    return all('ambiguous', 'force_event_decode_failed')
  if (forceLogs.length || rows.some((row) => row.force_event_in_transaction)) {
    if (!forceLogs.length || rows.some((row) => !row.force_event_in_transaction))
      return all('ambiguous', 'force_path_ledger_receipt_mismatch')
    if (rows.some((row) => lower(row.receiver) !== vault))
      return all('ambiguous', 'force_and_external_withdraw_same_transaction')
    return all('internal_force_deallocate', 'force_deallocate_in_transaction')
  }
  const transfers = logs.filter((log) => log.address === asset && log.topics[0] === TRANSFER_TOPIC)
  if (transfers.some((log) => !decoded(log, TRANSFER)))
    return all('ambiguous', 'asset_transfer_decode_failed')
  const byReceiver = new Map()
  for (const row of rows) {
    const receiver = lower(row.receiver)
    const group = byReceiver.get(receiver) || []
    group.push(row)
    byReceiver.set(receiver, group)
  }
  const result = []
  for (const [receiver, groupRows] of byReceiver) {
    if (receiver === vault) {
      result.push(
        ...groupRows.map((row) => proofFor(row, base, 'internal_vault_receiver', 'vault_receiver')),
      )
      continue
    }
    if (receiver === ZERO || !validAddress(receiver)) {
      result.push(
        ...groupRows.map((row) => proofFor(row, base, 'unreconciled', 'invalid_external_receiver')),
      )
      continue
    }
    const matching = transfers
      .map((log) => ({ log, args: decoded(log, TRANSFER) }))
      .filter(({ args }) => lower(args.from) === vault && lower(args.to) === receiver)
    const withdrawAssets = groupRows.reduce((sum, row) => sum + BigInt(row.assets_raw), 0n)
    const paidAssets = matching.reduce((sum, { args }) => sum + args.value, 0n)
    const groupProof = {
      receiver,
      withdrawLogIndices: groupRows.map((row) => Number(row.log_index)).sort((a, b) => a - b),
      transferLogIndices: matching.map(({ log }) => log.logIndex).sort((a, b) => a - b),
      withdrawAssetsRaw: withdrawAssets.toString(),
      paidAssetsRaw: paidAssets.toString(),
      transferCount: matching.length,
    }
    const matched = withdrawAssets > 0n && matching.length > 0 && paidAssets === withdrawAssets
    const status = matched
      ? 'reconciled_external_supplier'
      : paidAssets > withdrawAssets
        ? 'ambiguous'
        : 'unreconciled'
    const reason = matched
      ? 'exact_group_underlying_transfer'
      : paidAssets > withdrawAssets
        ? 'excess_group_transfer_allocation_ambiguous'
        : 'missing_or_insufficient_transfer'
    result.push(...groupRows.map((row) => proofFor(row, base, status, reason, groupProof)))
  }
  return result.sort((a, b) => a.logIndex - b.logIndex)
}

export async function reconcilePending(
  sql,
  client,
  {
    dryRun = true,
    maxTransactions = MAX_TX,
    timeBudgetMs = MAX_MS,
    now = Date.now(),
    clock = Date.now,
  } = {},
) {
  if (
    !Number.isSafeInteger(maxTransactions) ||
    maxTransactions < 1 ||
    maxTransactions > 100 ||
    !Number.isSafeInteger(timeBudgetMs) ||
    timeBudgetMs < 1 ||
    timeBudgetMs > 300_000
  )
    throw new Error('invalid_reconciliation_budget')
  if ((await client.getChainId()) !== 1) throw new Error('wrong_chain')
  const finalized = await client.getBlock({ blockTag: 'finalized' })
  if (!finalized?.hash || !finalized?.number) throw new Error('finalized_header_unavailable')
  const attemptSlot = Math.floor(now / SLOT_MS)
  const deadline = clock() + timeBudgetMs
  const candidates = dryRun
    ? await sql`SELECT DISTINCT e.vault, e.transaction_hash, e.block
    FROM carry_morpho_v2_flow_events e
    WHERE e.event_kind = 'withdraw' AND e.block <= ${String(finalized.number)}
    ORDER BY e.block DESC, e.vault, e.transaction_hash LIMIT ${maxTransactions}`
    : await sql`WITH latest AS (
      SELECT DISTINCT ON (vault, transaction_hash, log_index)
        vault, transaction_hash, log_index, status, attempt_slot
      FROM carry_morpho_v2_withdraw_reconciliation
      ORDER BY vault, transaction_hash, log_index, attempt_slot DESC
    )
    SELECT DISTINCT e.vault, e.transaction_hash, e.block
    FROM carry_morpho_v2_flow_events e
    LEFT JOIN latest l ON l.vault = e.vault AND l.transaction_hash = e.transaction_hash
      AND l.log_index = e.log_index
    WHERE e.event_kind = 'withdraw' AND e.block <= ${String(finalized.number)}
      AND (l.status IS NULL OR (l.status = 'unavailable' AND l.attempt_slot < ${attemptSlot}))
    ORDER BY e.block, e.vault, e.transaction_hash LIMIT ${maxTransactions}`
  let processed = 0
  const statuses = {}
  const samples = []
  for (const candidate of candidates) {
    if (clock() >= deadline) break
    const rows = await sql`SELECT e.*, e.assets_raw::text, e.shares_raw::text,
        s.asset, s.manifest_sha256, s.seed_sha256, s.board_sha256,
        s.displayed_routes_sha256, s.cohort_id
      FROM carry_morpho_v2_flow_events e
      JOIN carry_morpho_v2_flow_subjects s ON s.vault = e.vault
      WHERE e.vault = ${candidate.vault} AND e.transaction_hash = ${candidate.transaction_hash}
        AND e.event_kind = 'withdraw' ORDER BY e.log_index`
    if (!rows.length) continue
    let proofs
    try {
      const receipt = await client.getTransactionReceipt({ hash: candidate.transaction_hash })
      const header = await client.getBlock({ blockNumber: BigInt(candidate.block) })
      const data = await client.call({
        to: candidate.vault,
        data: encodeFunctionData({ abi: ASSET, functionName: 'asset' }),
        blockHash: header.hash,
      })
      const liveAsset = decodeFunctionResult({ abi: ASSET, functionName: 'asset', data: data.data })
      proofs = reconcileTransaction(rows, receipt, header, finalized, liveAsset)
    } catch {
      proofs = rows.map((row) =>
        proofFor(
          row,
          {
            finalizedBlock: String(finalized.number),
            finalizedHash: lower(finalized.hash),
            receiptStatus: null,
            receiptBlockHash: null,
            receiptTransactionIndex: null,
            canonicalHeaderHash: null,
            liveAsset: null,
          },
          'unavailable',
          'rpc_or_archive_unavailable',
        ),
      )
    }
    for (const proof of proofs) {
      const payload = { ...proof, attemptSlot: String(attemptSlot) }
      if (!dryRun) {
        const saved = await sql`SELECT carry_morpho_v2_record_withdraw_reconciliation(
          ${JSON.stringify(payload)}::jsonb) AS inserted`
        if (!saved.length) throw new Error('reconciliation_write_failed')
      }
      statuses[proof.status] = (statuses[proof.status] || 0) + 1
    }
    samples.push({
      vault: candidate.vault,
      transactionHash: candidate.transaction_hash,
      block: String(candidate.block),
      statuses: proofs.map((proof) => proof.status),
    })
    processed++
  }
  return {
    dryRun,
    finalizedBlock: String(finalized.number),
    finalizedHash: lower(finalized.hash),
    attemptSlot,
    candidateTransactions: candidates.length,
    processedTransactions: processed,
    remainingBudgetMs: Math.max(0, deadline - clock()),
    statuses,
    samples,
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !['--dry-run', '--run'].includes(argv[0]))
    throw new Error('usage: node scripts/reconcile-carry-morpho-v2-withdrawals.mjs --dry-run|--run')
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
  const result = await reconcilePending(neon(db), makeClient(rpc), {
    dryRun: argv[0] === '--dry-run',
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('morpho_withdraw_reconciliation_failed\n')
    process.exitCode = 1
  })
}
