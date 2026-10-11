// Public-chain-only, append-only direct-supplier withdrawal evidence. A paired
// eth_getLogs response corroborates an empty range; it does not prove an RPC
// provider is honest. No private forecast DB is opened by this module.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeEventLog, padHex, parseAbiItem, toEventSelector } from 'viem'
import { CARRY_EXIT_V2_FROZEN_ROUTES } from '../lib/carry-exit-v2-rpc-proof.mjs'
import { reconcileDirectSupplierWithdrawal } from '../lib/carry-direct-supplier-withdrawal-receipt.mjs'
import { reconcileDirectSupplierSupply } from '../lib/carry-direct-supplier-supply-receipt.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { writeDirectSupplierFlowPublicationWitness } from './carry-direct-supplier-flow-publication-witness.mjs'

export const STUDY = 'carry-direct-supplier-flow-receipts-v1'
export const SUPPLY_STUDY = 'carry-direct-supplier-supply-flow-receipts-v1'
export const STUDY_V2 = 'carry-direct-supplier-flow-receipts-v2'
export const SUPPLY_STUDY_V2 = 'carry-direct-supplier-supply-flow-receipts-v2'
export const SEGMENT_BLOCKS = 64
export const LOG_SLICE_BLOCKS = 10
export const MAX_CANDIDATES = 1000
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const HEX = /^0x(?:[0-9a-f]{2})*$/
const AAVE_WITHDRAW = parseAbiItem(
  'event Withdraw(address indexed reserve,address indexed user,address indexed to,uint256 amount)',
)
const COMET_WITHDRAW = parseAbiItem(
  'event Withdraw(address indexed src,address indexed to,uint256 amount)',
)
const AAVE_SUPPLY = parseAbiItem(
  'event Supply(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint16 indexed referralCode)',
)
const COMET_SUPPLY = parseAbiItem(
  'event Supply(address indexed from,address indexed dst,uint256 amount)',
)
const IDENTITIES = Object.freeze({
  aaveV3Usdc: { kind: 'aave', routeKey: 'USDC → supply on Aave V3' },
  aaveV3Usde: { kind: 'aave', routeKey: 'USDe → supply on Aave V3' },
  sparkLendUsdt: { kind: 'spark', routeKey: 'USDT → supply on Spark' },
  compoundV3Usdc: { kind: 'comet', routeKey: 'USDC → supply on Compound v3' },
})
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : '')
const fail = (condition, code) => {
  if (!condition) throw new Error(code)
}
const digest = (body) => createHash('sha256').update(JSON.stringify(body)).digest('hex')
const hexBlock = (number) => `0x${number.toString(16)}`

function uint(value, code) {
  const okay =
    (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === 'bigint' && value >= 0n)
  fail(okay, code)
  const number = Number(BigInt(value))
  fail(Number.isSafeInteger(number) && number >= 0, code)
  return number
}

function market(marketKey, flowKind = 'withdraw') {
  fail(flowKind === 'withdraw' || flowKind === 'supply', 'unsupported_direct_flow_kind')
  const identity = IDENTITIES[marketKey]
  fail(identity, 'unsupported_direct_market')
  const frozen = CARRY_EXIT_V2_FROZEN_ROUTES.find(
    (route) => route.kind === identity.kind && route.routeKey === identity.routeKey,
  )
  fail(frozen, 'frozen_direct_market_missing')
  const emitter = lower(frozen.withdrawTarget)
  const asset = lower(frozen.asset)
  fail(ADDRESS.test(emitter) && ADDRESS.test(asset), 'invalid_frozen_direct_market')
  const abi =
    identity.kind === 'comet'
      ? flowKind === 'supply'
        ? COMET_SUPPLY
        : COMET_WITHDRAW
      : flowKind === 'supply'
        ? AAVE_SUPPLY
        : AAVE_WITHDRAW
  const topics =
    identity.kind === 'comet'
      ? [toEventSelector(abi).toLowerCase()]
      : [toEventSelector(abi).toLowerCase(), padHex(asset, { size: 32 }).toLowerCase()]
  return { emitter, asset, destination: lower(frozen.destination), topics, abi }
}

function header(raw) {
  fail(
    raw && HASH.test(lower(raw.hash)) && HASH.test(lower(raw.parentHash)),
    'invalid_block_header',
  )
  return {
    number: uint(raw.number, 'invalid_block_number'),
    hash: lower(raw.hash),
    parentHash: lower(raw.parentHash),
    timestampSec: uint(raw.timestamp, 'invalid_block_timestamp'),
  }
}

function log(raw) {
  fail(raw && raw.removed !== true && lower(raw.removed) !== 'true', 'removed_direct_log')
  fail(
    ADDRESS.test(lower(raw.address)) &&
      HASH.test(lower(raw.blockHash)) &&
      HASH.test(lower(raw.transactionHash)) &&
      Array.isArray(raw.topics) &&
      raw.topics.every((topic) => HASH.test(lower(topic))) &&
      HEX.test(lower(raw.data)),
    'invalid_direct_log',
  )
  return {
    address: lower(raw.address),
    blockNumber: uint(raw.blockNumber, 'invalid_log_block_number'),
    blockHash: lower(raw.blockHash),
    transactionHash: lower(raw.transactionHash),
    transactionIndex: uint(raw.transactionIndex, 'invalid_transaction_index'),
    logIndex: uint(raw.logIndex, 'invalid_log_index'),
    topics: raw.topics.map(lower),
    data: lower(raw.data),
  }
}

function receipt(raw) {
  fail(
    raw && HASH.test(lower(raw.blockHash)) && HASH.test(lower(raw.transactionHash)),
    'invalid_receipt',
  )
  fail(Array.isArray(raw.logs), 'incomplete_receipt_logs')
  const status =
    raw.status === 'success' || raw.status === '0x1' || raw.status === 1
      ? 'success'
      : raw.status === 'reverted' || raw.status === '0x0' || raw.status === 0
        ? 'reverted'
        : null
  fail(status !== null, 'invalid_receipt_status')
  return {
    status,
    blockNumber: uint(raw.blockNumber, 'invalid_receipt_block_number'),
    blockHash: lower(raw.blockHash),
    transactionHash: lower(raw.transactionHash),
    transactionIndex: uint(raw.transactionIndex, 'invalid_receipt_transaction_index'),
    logs: raw.logs.map(log),
  }
}

function compareLogs(a, b) {
  return (
    a.blockNumber - b.blockNumber ||
    a.transactionIndex - b.transactionIndex ||
    a.logIndex - b.logIndex
  )
}

function expectedLogSlices(fromBlock, toBlock) {
  const slices = []
  for (let first = fromBlock; first <= toBlock; first += LOG_SLICE_BLOCKS) {
    slices.push({ fromBlock: first, toBlock: Math.min(first + LOG_SLICE_BLOCKS - 1, toBlock) })
  }
  return slices
}

function validateReceipt(value, candidate, blocks) {
  fail(value.status === 'success', 'unsuccessful_direct_receipt')
  fail(
    value.blockNumber === candidate.blockNumber &&
      value.blockHash === candidate.blockHash &&
      value.transactionHash === candidate.transactionHash &&
      value.transactionIndex === candidate.transactionIndex,
    'receipt_candidate_mismatch',
  )
  const seen = new Set()
  let priorLogIndex = null
  for (const item of value.logs) {
    fail(
      item.blockNumber === value.blockNumber &&
        item.blockHash === value.blockHash &&
        item.transactionHash === value.transactionHash &&
        item.transactionIndex === value.transactionIndex &&
        item.blockHash === blocks.get(item.blockNumber)?.hash &&
        !seen.has(item.logIndex),
      'receipt_log_envelope_mismatch',
    )
    fail(
      priorLogIndex === null || item.logIndex === priorLogIndex + 1,
      'incomplete_direct_receipt_log_sequence',
    )
    seen.add(item.logIndex)
    priorLogIndex = item.logIndex
  }
  fail(
    value.logs.some((item) => JSON.stringify(item) === JSON.stringify(candidate)),
    'candidate_missing_from_receipt',
  )
}

function bodyOf(document) {
  fail(
    document && typeof document === 'object' && !Array.isArray(document),
    'invalid_direct_segment',
  )
  const { sha256, ...body } = document
  fail(/^[0-9a-f]{64}$/.test(sha256) && digest(body) === sha256, 'direct_segment_digest_mismatch')
  return body
}

/** Pure reconstruction from sealed, public-only evidence. */
export function verifyDirectSupplierFlowSegment(document) {
  const body = bodyOf(document)
  const v2 = body.study === STUDY_V2 || body.study === SUPPLY_STUDY_V2
  const flowKind =
    body.study === SUPPLY_STUDY || body.study === SUPPLY_STUDY_V2 ? 'supply' : 'withdraw'
  const pinned = market(body.marketKey, flowKind)
  const from = body.range?.fromBlock
  const to = body.range?.toBlock
  fail(
    [STUDY, SUPPLY_STUDY, STUDY_V2, SUPPLY_STUDY_V2].includes(body.study) &&
      body.chainId === 1 &&
      body.sourceAgreement === 'two_public_rpc_origins_agree_not_absolute_completeness' &&
      Number.isSafeInteger(from) &&
      Number.isSafeInteger(to) &&
      from >= 0 &&
      to >= from &&
      to - from + 1 <= SEGMENT_BLOCKS,
    'invalid_direct_segment_range',
  )
  fail(
    body.filter?.address === pinned.emitter &&
      JSON.stringify(body.filter.topics) === JSON.stringify(pinned.topics),
    'direct_market_filter_mismatch',
  )
  fail(Array.isArray(body.finalized) && body.finalized.length === 2, 'missing_finality_pair')
  fail(
    Array.isArray(body.originFingerprints) &&
      body.originFingerprints.length === 2 &&
      body.originFingerprints.every((fingerprint) => /^[0-9a-f]{64}$/.test(fingerprint)) &&
      body.originFingerprints[0] !== body.originFingerprints[1],
    'two_distinct_direct_rpc_origins_required',
  )
  const sparse = body.headerCoverage === 'sparse_boundary_candidate_blocks'
  const legacyFull = body.headerCoverage === undefined
  fail(
    Array.isArray(body.blocks) &&
      body.blocks.length >= 2 &&
      body.blocks.length <= to - from + 2 &&
      (sparse || (legacyFull && body.blocks.length === to - from + 2)),
    'incomplete_block_headers',
  )
  const blocks = new Map()
  for (const [i, item] of body.blocks.entries()) {
    const previous = body.blocks[i - 1]
    fail(
      Number.isSafeInteger(item.number) &&
        item.number >= from &&
        item.number <= to + 1 &&
        (i === 0 ? item.number === from : item.number > previous.number) &&
        (i !== body.blocks.length - 1 || item.number === to + 1) &&
        (sparse || item.number === from + i) &&
        HASH.test(item.hash) &&
        HASH.test(item.parentHash) &&
        Number.isSafeInteger(item.timestampSec) &&
        item.timestampSec >= 0 &&
        Number.isSafeInteger(item.timestampSec * 1000) &&
        (i === 0 ||
          (item.timestampSec > previous.timestampSec &&
            (item.number !== previous.number + 1 || item.parentHash === previous.hash))),
      'noncanonical_direct_block_sequence',
    )
    blocks.set(item.number, item)
  }
  for (const final of body.finalized) {
    fail(
      Number.isSafeInteger(final.number) &&
        final.number >= to + 1 &&
        HASH.test(final.hash) &&
        (final.number !== to + 1 || final.hash === blocks.get(to + 1).hash),
      'direct_range_not_finalized',
    )
  }
  let availability = {
    status: 'unknown',
    reason: 'legacy_segment_without_capture_clock',
    firstLocalReceiptAt: null,
    availableAtIssue: false,
  }
  if (v2) {
    const startedMs = Date.parse(body.captureStartedAt)
    const completedMs = Date.parse(body.captureCompletedAt)
    fail(
      typeof body.captureStartedAt === 'string' &&
        typeof body.captureCompletedAt === 'string' &&
        Number.isSafeInteger(startedMs) &&
        Number.isSafeInteger(completedMs) &&
        new Date(startedMs).toISOString() === body.captureStartedAt &&
        new Date(completedMs).toISOString() === body.captureCompletedAt &&
        startedMs >= blocks.get(to + 1).timestampSec * 1000 &&
        completedMs >= startedMs,
      'direct_capture_clock_invalid',
    )
    availability = {
      status: 'capture_clock_only',
      reason: 'post_publication_receipt_unverified',
      firstLocalReceiptAt: null,
      availableAtIssue: false,
      captureClockBasis: 'local_operator_clock_unwitnessed',
      captureStartedAt: body.captureStartedAt,
      captureCompletedAt: body.captureCompletedAt,
    }
  } else {
    fail(
      body.captureStartedAt === undefined && body.captureCompletedAt === undefined,
      'direct_capture_clock_unversioned',
    )
  }
  fail(Array.isArray(body.logSets) && body.logSets.length === 2, 'missing_direct_log_pair')
  if (body.logQueries !== undefined) {
    fail(
      Array.isArray(body.logQueries) && body.logQueries.length === 2,
      'incomplete_direct_log_slices',
    )
    const expectedSlices = expectedLogSlices(from, to)
    for (const [index, query] of body.logQueries.entries()) {
      fail(
        query.origin === (index === 0 ? 'primary' : 'secondary') &&
          Array.isArray(query.slices) &&
          query.slices.length === expectedSlices.length,
        'incomplete_direct_log_slices',
      )
      for (const [sliceIndex, slice] of query.slices.entries()) {
        const expected = expectedSlices[sliceIndex]
        fail(
          slice.fromBlock === expected.fromBlock &&
            slice.toBlock === expected.toBlock &&
            Array.isArray(slice.logs) &&
            slice.logs.every(
              (item) =>
                item.blockNumber >= expected.fromBlock && item.blockNumber <= expected.toBlock,
            ),
          'invalid_direct_log_slice',
        )
        fail(
          JSON.stringify(slice.logs) === JSON.stringify(body.logQueries[0].slices[sliceIndex].logs),
          'direct_provider_log_disagreement',
        )
      }
      fail(
        JSON.stringify(query.slices.flatMap((slice) => slice.logs).sort(compareLogs)) ===
          JSON.stringify(body.logSets[index]?.logs),
        'direct_log_slice_flatten_mismatch',
      )
    }
  }
  const candidateSets = []
  for (const [index, set] of body.logSets.entries()) {
    fail(
      set.origin === (index === 0 ? 'primary' : 'secondary') && Array.isArray(set.logs),
      'invalid_direct_log_set',
    )
    fail(set.logs.length <= MAX_CANDIDATES, 'unbounded_direct_log_set')
    const seen = new Set()
    let previous = null
    for (const item of set.logs) {
      const key = `${item.blockHash}/${item.transactionHash}/${item.logIndex}`
      fail(
        item.address === pinned.emitter &&
          item.topics.length === pinned.abi.inputs.filter((input) => input.indexed).length + 1 &&
          JSON.stringify(item.topics.slice(0, pinned.topics.length)) ===
            JSON.stringify(pinned.topics) &&
          item.blockNumber >= from &&
          item.blockNumber <= to &&
          item.blockHash === blocks.get(item.blockNumber)?.hash &&
          HASH.test(item.transactionHash) &&
          HEX.test(item.data) &&
          Number.isSafeInteger(item.transactionIndex) &&
          item.transactionIndex >= 0 &&
          Number.isSafeInteger(item.logIndex) &&
          item.logIndex >= 0 &&
          !seen.has(key) &&
          (!previous || compareLogs(previous, item) < 0),
        'invalid_direct_candidate_log',
      )
      seen.add(key)
      previous = item
    }
    candidateSets.push(set.logs)
  }
  fail(
    JSON.stringify(candidateSets[0]) === JSON.stringify(candidateSets[1]),
    'direct_provider_log_disagreement',
  )
  const candidates = candidateSets[0]
  if (sparse) {
    const expected = [
      ...new Set([from, to + 1, ...candidates.map((item) => item.blockNumber)]),
    ].sort((a, b) => a - b)
    fail(
      JSON.stringify(body.blocks.map((point) => point.number)) === JSON.stringify(expected),
      'incomplete_or_extraneous_sparse_headers',
    )
  }
  const transactions = new Map()
  for (const item of candidates) {
    const bucket = transactions.get(item.transactionHash) ?? []
    bucket.push(item)
    transactions.set(item.transactionHash, bucket)
  }
  fail(
    Array.isArray(body.receipts) && body.receipts.length === transactions.size,
    'incomplete_direct_receipts',
  )
  const withdrawals = []
  const supplies = []
  const unclassifiedWithdrawals = []
  const seenTransactions = new Set()
  for (const pair of body.receipts) {
    fail(
      pair && HASH.test(pair.transactionHash) && !seenTransactions.has(pair.transactionHash),
      'duplicate_direct_receipt',
    )
    seenTransactions.add(pair.transactionHash)
    const txCandidates = transactions.get(pair.transactionHash)
    fail(txCandidates && pair.primary && pair.secondary, 'unexpected_direct_receipt')
    fail(
      JSON.stringify(pair.primary) === JSON.stringify(pair.secondary),
      'direct_provider_receipt_disagreement',
    )
    validateReceipt(pair.primary, txCandidates[0], blocks)
    const receiptWithdrawIndices = pair.primary.logs
      .filter(
        (item) =>
          item.address === pinned.emitter &&
          JSON.stringify(item.topics.slice(0, pinned.topics.length)) ===
            JSON.stringify(pinned.topics),
      )
      .map((item) => item.logIndex)
      .sort((a, b) => a - b)
    fail(
      JSON.stringify(receiptWithdrawIndices) ===
        JSON.stringify(txCandidates.map((item) => item.logIndex).sort((a, b) => a - b)),
      'incomplete_direct_withdraw_candidates',
    )
    for (const candidate of txCandidates) {
      validateReceipt(pair.primary, candidate, blocks)
      const decoded = decodeEventLog({
        abi: [pinned.abi],
        topics: candidate.topics,
        data: candidate.data,
        strict: true,
      })
      if (body.marketKey !== 'compoundV3Usdc')
        fail(lower(decoded.args.reserve) === pinned.asset, 'wrong_direct_reserve')
      const holder = lower(
        body.marketKey === 'compoundV3Usdc'
          ? flowKind === 'supply'
            ? decoded.args.from
            : decoded.args.src
          : decoded.args.user,
      )
      fail(ADDRESS.test(holder), 'invalid_direct_holder')
      const reconciliation =
        flowKind === 'supply'
          ? reconcileDirectSupplierSupply({
              marketKey: body.marketKey,
              receipt: pair.primary,
              selectedSupplyLogIndex: candidate.logIndex,
            })
          : reconcileDirectSupplierWithdrawal({
              marketKey: body.marketKey,
              holder,
              receipt: pair.primary,
              selectedWithdrawLogIndex: candidate.logIndex,
            })
      const reconciled =
        reconciliation.status ===
          (flowKind === 'supply'
            ? 'reconciled_supplier_supply'
            : 'reconciled_supplier_withdrawal') &&
        reconciliation.evidence?.[flowKind === 'supply' ? 'supplyLogIndex' : 'withdrawLogIndex'] ===
          candidate.logIndex
      if (!reconciled) {
        // A Comet Withdraw can be borrowing or a mixed transaction. Preserve
        // the corroborated market event without claiming supplier settlement.
        fail(
          body.marketKey === 'compoundV3Usdc' &&
            flowKind === 'withdraw' &&
            reconciliation.status === 'ambiguous' &&
            [
              'mixed_or_multiple_market_flows',
              'withdraw_payout_mismatch',
              'comet_borrow_or_share_burn_mismatch',
            ].includes(reconciliation.reason),
          'ambiguous_direct_supplier_receipt',
        )
        unclassifiedWithdrawals.push({
          marketKey: body.marketKey,
          blockHash: candidate.blockHash,
          transactionHash: candidate.transactionHash,
          logIndex: candidate.logIndex,
          timestampMs: blocks.get(candidate.blockNumber).timestampSec * 1000,
          eventAmountRaw: decoded.args.amount.toString(),
          reason: reconciliation.reason,
        })
        continue
      }
      const witnessed = {
        marketKey: body.marketKey,
        blockHash: candidate.blockHash,
        transactionHash: candidate.transactionHash,
        logIndex: candidate.logIndex,
        timestampMs: blocks.get(candidate.blockNumber).timestampSec * 1000,
        reconciliation,
      }
      if (flowKind === 'supply') supplies.push(witnessed)
      else withdrawals.push(witnessed)
    }
  }
  withdrawals.sort(
    (a, b) =>
      a.timestampMs - b.timestampMs ||
      a.transactionHash.localeCompare(b.transactionHash) ||
      a.logIndex - b.logIndex,
  )
  supplies.sort(
    (a, b) =>
      a.timestampMs - b.timestampMs ||
      a.transactionHash.localeCompare(b.transactionHash) ||
      a.logIndex - b.logIndex,
  )
  return {
    flowKind,
    availability,
    marketKey: body.marketKey,
    fromBlock: from,
    toBlock: to,
    firstBlockHash: blocks.get(from).hash,
    nextBlockHash: blocks.get(to + 1).hash,
    coverage: {
      marketKey: body.marketKey,
      startMs: blocks.get(from).timestampSec * 1000,
      endMs: blocks.get(to + 1).timestampSec * 1000,
      intervals: [
        {
          startMs: blocks.get(from).timestampSec * 1000,
          endMs: blocks.get(to + 1).timestampSec * 1000,
          finalized: true,
          receiptsComplete: unclassifiedWithdrawals.length === 0,
          ambiguousReceipts: unclassifiedWithdrawals.length,
        },
      ],
    },
    withdrawals,
    supplies,
    unclassifiedWithdrawals,
    candidateCount: candidates.length,
  }
}

/** Combine consecutive sealed segments into maxDirectSupplierWithdrawalWindow input. */
export function verifyDirectSupplierFlowSegments(documents) {
  fail(Array.isArray(documents) && documents.length > 0, 'missing_direct_segments')
  const verified = documents.map(verifyDirectSupplierFlowSegment)
  const marketKey = verified[0].marketKey
  const flowKind = verified[0].flowKind
  for (let i = 1; i < verified.length; i++) {
    const prior = verified[i - 1]
    const next = verified[i]
    fail(
      next.marketKey === marketKey &&
        next.flowKind === flowKind &&
        next.fromBlock === prior.toBlock + 1 &&
        next.firstBlockHash === prior.nextBlockHash &&
        next.coverage.startMs === prior.coverage.endMs,
      'noncontiguous_direct_segments',
    )
  }
  return {
    segmentAvailability: verified.map((part) => ({
      fromBlock: part.fromBlock,
      toBlock: part.toBlock,
      ...part.availability,
    })),
    coverage: {
      marketKey,
      startMs: verified[0].coverage.startMs,
      endMs: verified.at(-1).coverage.endMs,
      intervals: verified.flatMap((part) => part.coverage.intervals),
    },
    withdrawals: verified.flatMap((part) => part.withdrawals),
    supplies: verified.flatMap((part) => part.supplies),
    unclassifiedWithdrawals: verified.flatMap((part) => part.unclassifiedWithdrawals),
  }
}

export async function collectDirectSupplierFlowSegment({
  primary,
  secondary,
  primaryOrigin,
  secondaryOrigin,
  marketKey,
  fromBlock,
  toBlock,
  flowKind = 'withdraw',
}) {
  const captureStartedAt = new Date().toISOString()
  fail(
    primary?.request && secondary?.request && primary !== secondary,
    'two_direct_rpc_origins_required',
  )
  fail(
    typeof primaryOrigin === 'string' &&
      typeof secondaryOrigin === 'string' &&
      primaryOrigin.length > 0 &&
      secondaryOrigin.length > 0 &&
      primaryOrigin !== secondaryOrigin,
    'two_distinct_direct_rpc_origins_required',
  )
  const pinned = market(marketKey, flowKind)
  fail(
    Number.isSafeInteger(fromBlock) &&
      Number.isSafeInteger(toBlock) &&
      fromBlock >= 0 &&
      toBlock >= fromBlock &&
      toBlock - fromBlock + 1 <= SEGMENT_BLOCKS,
    'invalid_direct_segment_range',
  )
  const request = (client, method, params) => client.request({ method, params })
  const origins = [primary, secondary]
  const chainIds = await Promise.all(origins.map((client) => request(client, 'eth_chainId', [])))
  fail(
    chainIds.every((id) => uint(id, 'invalid_chain_id') === 1),
    'wrong_direct_chain',
  )
  const finalized = await Promise.all(
    origins.map(async (client) =>
      header(await request(client, 'eth_getBlockByNumber', ['finalized', false])),
    ),
  )
  fail(
    finalized.every((point) => point.number >= toBlock + 1),
    'direct_range_not_finalized',
  )
  const filter = { address: pinned.emitter, topics: pinned.topics }
  const slices = expectedLogSlices(fromBlock, toBlock)
  const logQueries = await Promise.all(
    origins.map(async (client, index) => {
      const responses = []
      for (const slice of slices) {
        const response = await request(client, 'eth_getLogs', [
          { ...filter, fromBlock: hexBlock(slice.fromBlock), toBlock: hexBlock(slice.toBlock) },
        ])
        fail(
          Array.isArray(response) && response.length <= MAX_CANDIDATES,
          'incomplete_direct_log_response',
        )
        responses.push({ ...slice, logs: response.map(log).sort(compareLogs) })
      }
      return {
        origin: index === 0 ? 'primary' : 'secondary',
        slices: responses,
      }
    }),
  )
  fail(
    logQueries.every(
      (query) => query.slices.flatMap((slice) => slice.logs).length <= MAX_CANDIDATES,
    ),
    'unbounded_direct_log_set',
  )
  const logSets = logQueries.map((query) => ({
    origin: query.origin,
    logs: query.slices.flatMap((slice) => slice.logs).sort(compareLogs),
  }))
  fail(
    JSON.stringify(logSets[0].logs) === JSON.stringify(logSets[1].logs),
    'direct_provider_log_disagreement',
  )
  // Boundaries make adjacent segment coverage half-open in time. Candidate
  // blocks are the only interior headers needed to pin withdrawal timestamps.
  const headerNumbers = [
    ...new Set([fromBlock, toBlock + 1, ...logSets[0].logs.map((item) => item.blockNumber)]),
  ].sort((a, b) => a - b)
  const headerSets = await Promise.all(
    origins.map(async (client) => {
      const rows = []
      for (const number of headerNumbers) {
        const point = header(
          await request(client, 'eth_getBlockByNumber', [hexBlock(number), false]),
        )
        fail(point.number === number, 'wrong_direct_block_number')
        rows.push(point)
      }
      return rows
    }),
  )
  fail(
    JSON.stringify(headerSets[0]) === JSON.stringify(headerSets[1]),
    'direct_provider_header_disagreement',
  )
  const transactions = [...new Set(logSets[0].logs.map((item) => item.transactionHash))].sort()
  const receipts = await Promise.all(
    transactions.map(async (transactionHash) => {
      const [first, second] = await Promise.all(
        origins.map(async (client) =>
          receipt(await request(client, 'eth_getTransactionReceipt', [transactionHash])),
        ),
      )
      return { transactionHash, primary: first, secondary: second }
    }),
  )
  const body = {
    study: flowKind === 'supply' ? SUPPLY_STUDY_V2 : STUDY_V2,
    captureStartedAt,
    captureCompletedAt: new Date().toISOString(),
    sourceAgreement: 'two_public_rpc_origins_agree_not_absolute_completeness',
    originFingerprints: [digest(primaryOrigin), digest(secondaryOrigin)],
    marketKey,
    chainId: 1,
    range: { fromBlock, toBlock },
    headerCoverage: 'sparse_boundary_candidate_blocks',
    filter,
    finalized,
    blocks: headerSets[0],
    logQueries,
    logSets,
    receipts,
  }
  const document = { ...body, sha256: digest(body) }
  const verified = verifyDirectSupplierFlowSegment(document)
  return { document, verified }
}

function cliOptions(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    fail(
      [
        '--market',
        '--from',
        '--to',
        '--out',
        '--primary-rpc',
        '--secondary-rpc',
        '--flow',
      ].includes(key) && argv[i + 1],
      'invalid_direct_collector_option',
    )
    options[key] = argv[i + 1]
  }
  return options
}

export function selectDirectRpcOrigins({ primaryRpc, secondaryRpc, rpcUrls, rpcUrl } = {}) {
  const configured = String(rpcUrls || rpcUrl || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
  const primaryUrl = primaryRpc || configured[0]
  const secondaryUrl = secondaryRpc || configured[1]
  fail(primaryUrl && secondaryUrl, 'two_distinct_direct_rpc_origins_required')
  const primaryOrigin = new URL(primaryUrl).origin
  const secondaryOrigin = new URL(secondaryUrl).origin
  fail(primaryOrigin !== secondaryOrigin, 'two_distinct_direct_rpc_origins_required')
  return { primaryUrl, secondaryUrl, primaryOrigin, secondaryOrigin }
}

export function publishDirectSegmentAtomic(path, document) {
  const temporary = join(dirname(path), `.direct-flow-stage-${randomUUID()}.tmp`)
  let fd
  try {
    fd = openSync(temporary, 'wx', 0o444)
    writeFileSync(fd, `${JSON.stringify(document)}\n`)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    linkSync(temporary, path)
    const directory = openSync(dirname(path), 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

async function main() {
  const options = cliOptions(process.argv.slice(2))
  const needConfig = !options['--primary-rpc'] || !options['--secondary-rpc']
  const local =
    needConfig && !process.env.RECORDER_RPC_URLS && !process.env.RECORDER_RPC_URL ? readEnv() : null
  const { primaryUrl, secondaryUrl, primaryOrigin, secondaryOrigin } = selectDirectRpcOrigins({
    primaryRpc: options['--primary-rpc'],
    secondaryRpc: options['--secondary-rpc'],
    rpcUrls: process.env.RECORDER_RPC_URLS || local?.get('RECORDER_RPC_URLS'),
    rpcUrl: process.env.RECORDER_RPC_URL || local?.get('RECORDER_RPC_URL'),
  })
  fail(
    options['--out'] && resolve(options['--out']) === options['--out'],
    'absolute_direct_output_required',
  )
  const { document, verified } = await collectDirectSupplierFlowSegment({
    primary: makeClient(primaryUrl),
    secondary: makeClient(secondaryUrl),
    primaryOrigin,
    secondaryOrigin,
    marketKey: options['--market'],
    flowKind: options['--flow'] ?? 'withdraw',
    fromBlock: Number(options['--from']),
    toBlock: Number(options['--to']),
  })
  // Exclusive create: an existing segment is never overwritten or silently amended.
  publishDirectSegmentAtomic(options['--out'], document)
  writeDirectSupplierFlowPublicationWitness(options['--out'], document)
  process.stdout.write(
    JSON.stringify({
      study: document.study,
      marketKey: verified.marketKey,
      fromBlock: verified.fromBlock,
      toBlock: verified.toBlock,
      candidateCount: verified.candidateCount,
      reconciledCount:
        verified.flowKind === 'supply' ? verified.supplies.length : verified.withdrawals.length,
      sha256: document.sha256,
    }) + '\n',
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    // Upstream RPC errors can embed credential-bearing request URLs.
    process.stderr.write('direct_collector_failed\n')
    process.exitCode = 1
  })
}
