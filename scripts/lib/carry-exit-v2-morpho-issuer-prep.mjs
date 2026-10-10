// Read-only preparation for pinned Morpho V2 issuance. No future block selection,
// SQL, outcome classification, or holder address is placed in the evidence doc.
import { createHash } from 'node:crypto'
import { resolveCarryExitV2Route } from './carry-exit-v2-rpc-proof.mjs'

const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const WORD = /^0x[0-9a-f]{64}$/
const HEX = /^0x[0-9a-f]+$/
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ZERO = '0x0000000000000000000000000000000000000000'
const FRACTIONS = [
  ['vault_0p001pct', 100_000n],
  ['vault_0p01pct', 10_000n],
  ['vault_0p1pct', 1_000n],
  ['vault_0p5pct', 200n],
  ['vault_1pct', 100n],
]
const LOOKBACK = 4_096
const LOG_CHUNK = 512n
const MIN_LOG_CHUNK = 32n
const MAX_LOG_REQUESTS = 136
const MAX_LOG_THROTTLE_RETRIES = 2
const LOG_THROTTLE_BACKOFF_MS = [150, 300]
const sha = (value) => createHash('sha256').update(value).digest('hex')
const hexNumber = (value) => `0x${value.toString(16)}`
const pinned = (hash) => ({ blockHash: hash, requireCanonical: true })
const word = (value) => value.toString(16).padStart(64, '0')
const same = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const logRangeLimit = (error) =>
  [35, -32615].includes(error?.code) || /\brpc_http_(?:400|413)\b/.test(error?.message ?? '')
const asBigint = (value, code) => {
  if (!HEX.test(value ?? '')) throw Error(code)
  return BigInt(value)
}
const date = (seconds) => {
  if (seconds <= 0n || seconds > BigInt(Number.MAX_SAFE_INTEGER) / 1000n)
    throw Error('header_timestamp_invalid')
  return new Date(Number(seconds) * 1000).toISOString()
}
const header = (raw, expected) => {
  if (!raw || !HASH.test(raw.hash ?? '') || !HASH.test(raw.parentHash ?? ''))
    throw Error('header_invalid')
  const number = asBigint(raw.number, 'header_number_invalid')
  const timestamp = asBigint(raw.timestamp, 'header_timestamp_invalid')
  if (number <= 0n || (expected != null && number !== expected))
    throw Error('header_number_invalid')
  return { number, hash: raw.hash, parentHash: raw.parentHash, timestamp, at: date(timestamp) }
}
const evidenceHeader = (h) => ({
  number: h.number.toString(),
  hash: h.hash,
  parentHash: h.parentHash,
  timestamp: h.at,
})
const equalHeader = (a, b) =>
  a.number === b.number &&
  a.hash === b.hash &&
  a.parentHash === b.parentHash &&
  a.timestamp === b.timestamp
const routeFor = ({ routeKey, destination, asset }) => {
  const route = resolveCarryExitV2Route(routeKey, destination, asset)
  if (route.kind !== 'morpho') throw Error('morpho_route_required')
  return route
}

async function readHeader(request, number) {
  return header(
    await request('eth_getBlockByNumber', [
      typeof number === 'bigint' ? hexNumber(number) : number,
      false,
    ]),
    typeof number === 'bigint' ? number : null,
  )
}

async function canonicalCall(request, target, data, hash) {
  const result = await request('eth_call', [{ to: target, data }, pinned(hash)])
  if (!WORD.test(result ?? '')) throw Error('pinned_call_result_invalid')
  return BigInt(result)
}

/** Fresh finalized baseline only; the prospective target selector is never called. */
export async function captureFreshMorphoBaseline({
  routeKey,
  destination,
  asset,
  provider,
  source,
  request,
  now = () => new Date(),
}) {
  const route = routeFor({ routeKey, destination, asset })
  if (
    typeof request !== 'function' ||
    !provider?.trim() ||
    provider.length > 160 ||
    !source?.trim() ||
    source.length > 160
  )
    throw Error('issuer_input_invalid')
  if ((await request('eth_chainId', [])) !== '0x1') throw Error('wrong_chain')
  const baseline = await readHeader(request, 'finalized')
  const parent = await readHeader(request, baseline.number - 1n)
  if (baseline.parentHash !== parent.hash || parent.timestamp >= baseline.timestamp)
    throw Error('baseline_parent_invalid')
  // EIP-1898 requireCanonical is used on code and state reads at the frozen hash.
  const code = await request('eth_getCode', [route.destination, pinned(baseline.hash)])
  if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})+$/.test(code))
    throw Error('baseline_vault_code_missing')
  const totalAssetsRaw = await canonicalCall(
    request,
    route.destination,
    '0x01e1d114',
    baseline.hash,
  )
  const assetResult = await request('eth_call', [
    { to: route.destination, data: '0x38d52e0f' },
    pinned(baseline.hash),
  ])
  if (!WORD.test(assetResult ?? '') || !same(`0x${assetResult.slice(-40)}`, route.asset))
    throw Error('baseline_asset_mismatch')
  const decimals = await canonicalCall(request, route.asset, '0x313ce567', baseline.hash)
  if (decimals > 36n) throw Error('asset_decimals_invalid')
  const baselineAgain = await readHeader(request, baseline.number)
  const parentAgain = await readHeader(request, parent.number)
  const finalizedAgain = await readHeader(request, 'finalized')
  if (
    !equalHeader(baseline, baselineAgain) ||
    !equalHeader(parent, parentAgain) ||
    finalizedAgain.number < baseline.number ||
    (finalizedAgain.number === baseline.number && !equalHeader(finalizedAgain, baseline))
  )
    throw Error('baseline_reorg')
  const observedAt = now().toISOString()
  const ageMs = Date.parse(observedAt) - Date.parse(baseline.at)
  if (ageMs < -120_000) throw Error('observation_before_baseline')
  if (ageMs > 3_600_000) throw Error('baseline_stale')
  const doc = {
    schema: 'carry_exit_v2_headers_v1',
    chainId: '1',
    finalityTag: 'finalized',
    provider,
    source,
    targetAt: baseline.at,
    observedAt,
    baselineHeader: evidenceHeader(baseline),
    targetHeader: evidenceHeader(baseline),
    parentHeader: evidenceHeader(parent),
    finalizedHead: evidenceHeader(finalizedAgain),
  }
  return {
    routeKey,
    destination,
    asset,
    targetBlock: baseline.number.toString(),
    targetHash: baseline.hash,
    targetBlockAt: baseline.at,
    targetParentBlock: parent.number.toString(),
    targetParentHash: parent.hash,
    parentHeaderHash: parent.hash,
    targetParentBlockAt: parent.at,
    targetObservedAt: observedAt,
    totalAssetsRaw: totalAssetsRaw.toString(),
    assetDecimals: Number(decimals),
    canonicalityEvidenceDoc: doc,
  }
}

function transferCandidate(log, vault, from, baselineNumber) {
  if (
    !same(log.address, vault) ||
    !same(log.topics?.[0], TRANSFER) ||
    log.topics?.length !== 3 ||
    !WORD.test(log.topics[1] ?? '') ||
    !WORD.test(log.topics[2] ?? '') ||
    !WORD.test(log.data ?? '')
  )
    throw Error('malformed_transfer_log')
  const block = asBigint(log.blockNumber, 'malformed_transfer_log')
  const txIndex = asBigint(log.transactionIndex, 'malformed_transfer_log')
  const index = asBigint(log.logIndex, 'malformed_transfer_log')
  const owner = `0x${log.topics[2].slice(-40)}`
  if (
    !HASH.test(log.blockHash ?? '') ||
    !HASH.test(log.transactionHash ?? '') ||
    block < from ||
    block >= baselineNumber
  )
    throw Error('malformed_transfer_log')
  const transferredShares = BigInt(log.data)
  if (owner === ZERO || transferredShares === 0n) return null
  return { owner, block, txIndex, index, transferredShares, log }
}

function receiptMatches(log, receipt, vault) {
  if (
    log.removed === true ||
    !receipt ||
    receipt.status !== '0x1' ||
    !same(receipt.transactionHash, log.transactionHash) ||
    !same(receipt.blockHash, log.blockHash) ||
    receipt.blockNumber !== log.blockNumber
  )
    return false
  const matching = receipt.logs?.filter((x) => x.logIndex === log.logIndex) ?? []
  if (matching.length !== 1) return false
  const exact = matching[0]
  return (
    exact.removed !== true &&
    same(exact.address, vault) &&
    same(exact.transactionHash, log.transactionHash) &&
    same(exact.blockHash, log.blockHash) &&
    exact.blockNumber === log.blockNumber &&
    same(exact.data, log.data) &&
    JSON.stringify(exact.topics?.map((x) => x.toLowerCase())) ===
      JSON.stringify(log.topics.map((x) => x.toLowerCase()))
  )
}

/** Fixed six labels; missing and duplicate amounts remain explicit in the record. */
export function dedupeMorphoQEntries(entries) {
  const seen = new Map()
  return entries.map((entry) => {
    const { label, assetsRaw } = entry
    if (assetsRaw == null)
      return { ...entry, assetsRaw: null, reason: entry.reason ?? 'not_applicable' }
    const q = BigInt(assetsRaw)
    if (q === 0n) return { ...entry, assetsRaw: null, reason: entry.reason ?? 'zero_sized' }
    const prior = seen.get(q.toString())
    if (prior)
      return {
        ...entry,
        assetsRaw: null,
        reason: 'duplicate_q',
        duplicateOf: prior,
      }
    seen.set(q.toString(), label)
    return { ...entry, assetsRaw: q.toString(), reason: null }
  })
}

export function freezeMorphoQLadder({ totalAssetsRaw, selectedClaimRaw = null }) {
  const total = BigInt(totalAssetsRaw)
  const claim = selectedClaimRaw === null ? null : BigInt(selectedClaimRaw)
  if (total < 0n || (claim !== null && claim <= 0n)) throw Error('ladder_input_invalid')
  const smallestVaultQ = total / 100_000n
  // A positive claimed holder always gets a positive exact-asset Q within
  // its claim, even when integer floors would otherwise make Q zero.
  const halfClaim = claim === null ? null : claim / 2n > 0n ? claim / 2n : 1n
  const vaultCap = smallestVaultQ > 0n ? smallestVaultQ : 1n
  const holderQ = halfClaim === null ? null : halfClaim < vaultCap ? halfClaim : vaultCap
  return {
    basis: 'frozen_holder_claim_and_vault_total_assets_raw',
    totalAssetsRaw: total.toString(),
    selectedClaimRaw: claim?.toString() ?? null,
    holderQRule: 'min(max(1,floor(claim/2)),max(1,floor(vault_total_assets/100000)))',
    labels: dedupeMorphoQEntries([
      {
        label: 'holder_half_claim_capped_vault_0p001pct',
        basis: 'selected_holder_claim_raw_and_frozen_vault_total_assets_raw',
        fractionDenominator: null,
        assetsRaw: holderQ?.toString() ?? null,
        reason: claim === null ? 'no_selected_holder' : null,
      },
      ...FRACTIONS.map(([label, denominator]) => ({
        label,
        basis: 'frozen_vault_total_assets_raw',
        fractionDenominator: denominator.toString(),
        assetsRaw: (total / denominator).toString(),
      })),
    ]),
  }
}

/** Receipt-verified pre-baseline EOA. Only the return value's holder is private. */
export async function discoverMorphoIssuerCandidate({
  baseline,
  request,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  candidateLimit = 8,
  lookbackBlocks = LOOKBACK,
}) {
  const route = routeFor(baseline)
  const headers = baseline.canonicalityEvidenceDoc
  if (
    typeof request !== 'function' ||
    headers?.schema !== 'carry_exit_v2_headers_v1' ||
    headers.targetHeader?.hash !== baseline.targetHash ||
    headers.targetHeader?.number !== baseline.targetBlock ||
    !Number.isSafeInteger(candidateLimit) ||
    candidateLimit < 1 ||
    candidateLimit > 8 ||
    !Number.isSafeInteger(lookbackBlocks) ||
    lookbackBlocks < 32 ||
    lookbackBlocks > LOOKBACK
  )
    throw Error('candidate_input_invalid')
  const baselineNumber = BigInt(baseline.targetBlock)
  const lookback = BigInt(lookbackBlocks)
  const from = baselineNumber > lookback ? baselineNumber - lookback : 1n
  const logs = []
  let width = LOG_CHUNK
  let logRequests = 0
  for (let start = from; start < baselineNumber; ) {
    const end = start + width - 1n < baselineNumber ? start + width - 1n : baselineNumber - 1n
    let chunk
    let throttleRetries = 0
    let rangeLimited = false
    while (true) {
      if (++logRequests > MAX_LOG_REQUESTS) throw Error('candidate_log_request_limit')
      try {
        chunk = await request('eth_getLogs', [
          {
            address: route.destination,
            topics: [TRANSFER],
            fromBlock: hexNumber(start),
            toBlock: hexNumber(end),
          },
        ])
        break
      } catch (error) {
        if (/\brpc_http_429\b/.test(error?.message ?? '')) {
          if (throttleRetries >= MAX_LOG_THROTTLE_RETRIES)
            throw Error('candidate_log_throttle_exhausted')
          await wait(LOG_THROTTLE_BACKOFF_MS[throttleRetries++])
          continue
        }
        if (!logRangeLimit(error) || width <= MIN_LOG_CHUNK)
          throw Error('candidate_logs_unavailable')
        width /= 2n
        rangeLimited = true
        break
      }
    }
    if (rangeLimited) {
      // A range-limit response shrinks this same provider's next request.
      continue
    }
    if (!Array.isArray(chunk) || chunk.length > 4_096 || logs.length + chunk.length > 4_096)
      throw Error('candidate_logs_unavailable')
    logs.push(...chunk)
    start = end + 1n
  }
  const ranked = logs
    .map((log) => transferCandidate(log, route.destination, from, baselineNumber))
    .filter(Boolean)
    .sort((a, b) => {
      // The ranked event itself gets receipt-verified before its owner can be
      // selected. Largest incoming share transfer is a screening heuristic;
      // pinned current shares and claim decide whether the holder is eligible.
      if (a.transferredShares !== b.transferredShares)
        return a.transferredShares > b.transferredShares ? -1 : 1
      if (a.block !== b.block) return a.block > b.block ? -1 : 1
      if (a.txIndex !== b.txIndex) return a.txIndex > b.txIndex ? -1 : 1
      if (a.index !== b.index) return a.index > b.index ? -1 : 1
      return a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0
    })
  // Keep one ranked, receipt-checkable event per recipient. A Map would
  // overwrite the strongest event with a weaker later occurrence.
  const seenOwners = new Set()
  const distinct = ranked.filter((candidate) => {
    if (seenOwners.has(candidate.owner)) return false
    seenOwners.add(candidate.owner)
    return true
  })
  const screened = []
  let selected = null
  for (const candidate of distinct.slice(0, candidateLimit)) {
    const row = {
      holderCommitment: sha(`${route.destination}:${candidate.owner}`),
      discoveryTransactionHash: candidate.log.transactionHash,
      discoveryLogIndex: candidate.index.toString(),
      discoveryBlock: candidate.block.toString(),
      observedIncomingSharesRaw: candidate.transferredShares.toString(),
      status: 'rpc_unavailable',
    }
    screened.push(row)
    try {
      const receipt = await request('eth_getTransactionReceipt', [candidate.log.transactionHash])
      const discoveryHeader = await readHeader(request, candidate.block)
      if (
        !receiptMatches(candidate.log, receipt, route.destination) ||
        discoveryHeader.hash !== candidate.log.blockHash ||
        discoveryHeader.timestamp > BigInt(Date.parse(baseline.targetBlockAt) / 1000)
      ) {
        row.status = 'receipt_or_header_mismatch'
        continue
      }
      row.receiptDigest = sha(
        JSON.stringify({
          transactionHash: receipt.transactionHash,
          blockHash: receipt.blockHash,
          status: receipt.status,
          logs: receipt.logs,
        }),
      )
      const code = await request('eth_getCode', [candidate.owner, pinned(baseline.targetHash)])
      if (code !== '0x') {
        row.status = 'contract_holder'
        continue
      }
      const shares = await canonicalCall(
        request,
        route.destination,
        `0x70a08231${candidate.owner.slice(2).padStart(64, '0')}`,
        baseline.targetHash,
      )
      if (shares === 0n) {
        row.status = 'no_baseline_shares'
        continue
      }
      const claim = await canonicalCall(
        request,
        route.destination,
        `0x4cdad506${word(shares)}`,
        baseline.targetHash,
      )
      if (claim === 0n) {
        row.status = 'no_baseline_claim'
        continue
      }
      row.status = 'eligible_holder'
      row.sharesRaw = shares.toString()
      row.claimRaw = claim.toString()
      if (!selected || claim > BigInt(selected.claimRaw)) {
        selected = {
          holder: candidate.owner,
          sharesRaw: row.sharesRaw,
          claimRaw: row.claimRaw,
          holderCommitment: row.holderCommitment,
        }
      }
    } catch {
      row.status = 'rpc_unavailable'
    }
  }
  const baselineAgain = await readHeader(request, baselineNumber)
  const parentAgain = await readHeader(request, baselineNumber - 1n)
  if (
    baselineAgain.hash !== baseline.targetHash ||
    parentAgain.hash !== baseline.targetParentHash ||
    baselineAgain.parentHash !== parentAgain.hash
  )
    throw Error('baseline_reorg')
  const totalAssetsAgain = await canonicalCall(
    request,
    route.destination,
    '0x01e1d114',
    baseline.targetHash,
  )
  if (totalAssetsAgain.toString() !== baseline.totalAssetsRaw)
    throw Error('baseline_state_mismatch')
  const ladder = freezeMorphoQLadder({
    totalAssetsRaw: baseline.totalAssetsRaw,
    selectedClaimRaw: selected?.claimRaw ?? null,
  })
  const evidenceDoc = {
    schema: 'carry_exit_v2_morpho_candidate_v1',
    chainId: '1',
    routeKey: baseline.routeKey,
    destination: baseline.destination,
    asset: baseline.asset,
    baselineBlock: baseline.targetBlock,
    baselineHash: baseline.targetHash,
    parentHash: baseline.targetParentHash,
    baselineState: {
      totalAssetsRaw: baseline.totalAssetsRaw,
      assetDecimals: baseline.assetDecimals,
    },
    candidateWindow: {
      fromBlock: from.toString(),
      throughBlock: (baselineNumber - 1n).toString(),
      scope: 'bounded_recent_transfer_recipient_sample',
      exhaustiveHolderSearch: false,
      transferLogs: logs.length,
      distinctRecipients: distinct.length,
      attempted: screened.length,
      candidateLimit,
      rankingRule: 'largest_single_pre_baseline_incoming_share_transfer_then_recency_then_owner',
    },
    screenedCandidates: screened,
    selectionRule:
      'largest_pinned_claim_among_top_transfer_ranked_bounded_receipt_verified_eoas_tie_by_rank',
    selectedHolderCommitment: selected?.holderCommitment ?? null,
    selectedSharesRaw: selected?.sharesRaw ?? null,
    selectedClaimRaw: selected?.claimRaw ?? null,
    unavailableReason: selected
      ? null
      : distinct.length === 0
        ? lookbackBlocks < LOOKBACK
          ? 'no_transfer_recipient_in_bounded_window'
          : 'no_pre_baseline_transfer_recipient'
        : distinct.length > candidateLimit
          ? 'no_eligible_holder_in_bounded_candidates'
          : 'no_pre_baseline_eoa_with_positive_claim',
    ladder,
  }
  const digest = sha(JSON.stringify(evidenceDoc))
  return { holder: selected?.holder ?? null, evidenceDoc, digest }
}
