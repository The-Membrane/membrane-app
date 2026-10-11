// Fresh, pinned direct-market candidate discovery. Events nominate holders;
// a successful receipt, finalized EOA code, and positive supplied balance qualify them.
import { createHash } from 'node:crypto'
import { toEventSelector, toFunctionSelector } from 'viem'
import { resolveCarryExitV2Route } from './carry-exit-v2-rpc-proof.mjs'

const HASH = /^0x[0-9a-f]{64}$/
const WORD = /^0x[0-9a-f]{64}$/
const TRANSFER = toEventSelector('Transfer(address,address,uint256)').toLowerCase()
const SUPPLY = toEventSelector('Supply(address,address,uint256)').toLowerCase()
const ZERO = '0x0000000000000000000000000000000000000000'
const LOOKBACK = 4_096n
const selector = (signature) => toFunctionSelector(signature)
const BALANCE = selector('balanceOf(address)')
const TOTAL_SUPPLY = selector('totalSupply()')
const DECIMALS = selector('decimals()')
const BASE_TOKEN = selector('baseToken()')
const UNDERLYING = selector('UNDERLYING_ASSET_ADDRESS()')
const sha = (value) => createHash('sha256').update(value).digest('hex')
const tag = (hash) => ({ blockHash: hash, requireCanonical: true })
const hex = (value) => `0x${value.toString(16)}`
const same = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const word = (value) => {
  if (!WORD.test(value ?? '')) throw Error('pinned_word_invalid')
  return BigInt(value)
}
const directRoute = (route) => {
  const fixed = resolveCarryExitV2Route(route.routeKey, route.destination, route.asset)
  if (!['aave', 'spark', 'comet'].includes(fixed.kind)) throw Error('direct_route_required')
  return fixed
}
const evidenceHeader = (h) => ({
  number: h.number.toString(),
  hash: h.hash,
  parentHash: h.parentHash,
  timestamp: new Date(Number(h.timestamp) * 1000).toISOString(),
})
async function header(request, blockTag) {
  const raw = await request('eth_getBlockByNumber', [blockTag, false])
  if (!HASH.test(raw?.hash ?? '') || !HASH.test(raw?.parentHash ?? ''))
    throw Error('header_invalid')
  const number = BigInt(raw.number)
  const timestamp = BigInt(raw.timestamp)
  if (
    number < 1n ||
    timestamp < 1n ||
    timestamp > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000))
  )
    throw Error('header_invalid')
  return { number, hash: raw.hash, parentHash: raw.parentHash, timestamp }
}
async function callWord(request, address, data, hash) {
  return word(await request('eth_call', [{ to: address, data }, tag(hash)]))
}
async function recheck(request, baseline) {
  const current = await header(request, hex(BigInt(baseline.targetBlock)))
  const parent = await header(request, hex(BigInt(baseline.targetParentBlock)))
  const finalized = await header(request, 'finalized')
  if (
    current.hash !== baseline.targetHash ||
    parent.hash !== baseline.targetParentHash ||
    current.parentHash !== parent.hash ||
    finalized.number < current.number ||
    (finalized.number === current.number && finalized.hash !== current.hash)
  )
    throw Error('baseline_reorg')
}

export async function captureFreshDirectBaseline({
  routeKey,
  destination,
  asset,
  provider,
  source,
  request,
  now = () => new Date(),
}) {
  const route = directRoute({ routeKey, destination, asset })
  if (
    typeof request !== 'function' ||
    !provider?.trim() ||
    !source?.trim() ||
    provider.length > 160 ||
    source.length > 160
  )
    throw Error('issuer_input_invalid')
  if ((await request('eth_chainId', [])) !== '0x1') throw Error('wrong_chain')
  const target = await header(request, 'finalized')
  const parent = await header(request, hex(target.number - 1n))
  if (target.parentHash !== parent.hash || parent.timestamp >= target.timestamp)
    throw Error('baseline_parent_invalid')
  const code = await request('eth_getCode', [route.destination, tag(target.hash)])
  if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})+$/.test(code))
    throw Error('market_code_missing')
  const [marketSupply, decimals, liveAsset] = await Promise.all([
    callWord(request, route.destination, TOTAL_SUPPLY, target.hash),
    callWord(request, route.asset, DECIMALS, target.hash),
    callWord(
      request,
      route.destination,
      route.kind === 'comet' ? BASE_TOKEN : UNDERLYING,
      target.hash,
    ),
  ])
  if (
    !same(`0x${liveAsset.toString(16).padStart(40, '0')}`, route.asset) ||
    decimals > 36n ||
    marketSupply < 1n
  )
    throw Error('market_identity_invalid')
  await recheck(request, {
    targetBlock: target.number.toString(),
    targetHash: target.hash,
    targetParentBlock: parent.number.toString(),
    targetParentHash: parent.hash,
  })
  const observedAt = now().toISOString()
  const targetAt = evidenceHeader(target).timestamp
  if (
    Date.parse(observedAt) - Date.parse(targetAt) < -120_000 ||
    Date.parse(observedAt) - Date.parse(targetAt) > 3_600_000
  )
    throw Error('baseline_stale')
  const canonicalityEvidenceDoc = {
    schema: 'carry_exit_v2_headers_v1',
    chainId: '1',
    finalityTag: 'finalized',
    provider,
    source,
    targetAt,
    observedAt,
    baselineHeader: evidenceHeader(target),
    targetHeader: evidenceHeader(target),
    parentHeader: evidenceHeader(parent),
    finalizedHead: evidenceHeader(await header(request, 'finalized')),
  }
  return {
    routeKey,
    destination,
    asset,
    kind: route.kind,
    targetBlock: target.number.toString(),
    targetHash: target.hash,
    targetBlockAt: targetAt,
    targetParentBlock: parent.number.toString(),
    targetParentHash: parent.hash,
    parentHeaderHash: parent.hash,
    targetParentBlockAt: evidenceHeader(parent).timestamp,
    targetObservedAt: observedAt,
    marketSupplyRaw: marketSupply.toString(),
    assetDecimals: Number(decimals),
    canonicalityEvidenceDoc,
  }
}

export function freezeDirectQLadder({ marketSupplyRaw, selectedAssetBalanceRaw = null }) {
  const supply = BigInt(marketSupplyRaw)
  const balance = selectedAssetBalanceRaw === null ? null : BigInt(selectedAssetBalanceRaw)
  if (supply < 1n || (balance !== null && balance < 1n)) throw Error('ladder_input_invalid')
  const cap = supply / 100_000n > 0n ? supply / 100_000n : 1n
  const half = balance === null ? null : balance / 2n > 0n ? balance / 2n : 1n
  const values = [
    ['holder_half_balance_capped_market_0p001pct', half === null ? null : half < cap ? half : cap],
    ['market_0p001pct', supply / 100_000n],
    ['market_0p01pct', supply / 10_000n],
    ['market_0p1pct', supply / 1_000n],
    ['market_0p5pct', supply / 200n],
    ['market_1pct', supply / 100n],
  ]
  const seen = new Map()
  const labels = values.map(([label, value]) => {
    if (value === null) return { label, assetsRaw: null, reason: 'no_selected_holder' }
    if (value === 0n) return { label, assetsRaw: null, reason: 'zero_sized' }
    if (seen.has(value.toString()))
      return {
        label,
        assetsRaw: null,
        reason: 'duplicate_q',
        duplicateOf: seen.get(value.toString()),
      }
    seen.set(value.toString(), label)
    return { label, assetsRaw: value.toString(), reason: null }
  })
  return {
    basis: 'frozen_holder_balance_and_market_supply_raw',
    marketSupplyRaw: supply.toString(),
    selectedAssetBalanceRaw: balance?.toString() ?? null,
    holderQRule: 'min(max(1,floor(holder_balance/2)),max(1,floor(market_supply/100000)))',
    labels,
  }
}

function candidateLog(log, route, from, through) {
  const topic = route.kind === 'comet' ? SUPPLY : TRANSFER
  if (
    !same(log.address, route.destination) ||
    !same(log.topics?.[0], topic) ||
    log.topics?.length !== 3 ||
    !WORD.test(log.topics[1] ?? '') ||
    !WORD.test(log.topics[2] ?? '') ||
    !WORD.test(log.data ?? '') ||
    !HASH.test(log.transactionHash ?? '') ||
    !HASH.test(log.blockHash ?? '')
  )
    throw Error('candidate_log_invalid')
  const block = BigInt(log.blockNumber)
  if (block < from || block > through) throw Error('candidate_log_invalid')
  const owner = `0x${log.topics[2].slice(-40)}`
  const amount = BigInt(log.data)
  if (owner === ZERO || amount === 0n) return null
  return {
    log,
    owner,
    amount,
    block,
    txIndex: BigInt(log.transactionIndex),
    index: BigInt(log.logIndex),
  }
}
function receiptMatches(log, receipt, route) {
  if (
    log.removed === true ||
    receipt?.status !== '0x1' ||
    !same(receipt.transactionHash, log.transactionHash) ||
    !same(receipt.blockHash, log.blockHash) ||
    receipt.blockNumber !== log.blockNumber
  )
    return false
  const matching = receipt.logs?.filter((row) => row.logIndex === log.logIndex) ?? []
  const row = matching[0]
  return (
    matching.length === 1 &&
    row.removed !== true &&
    same(row.address, route.destination) &&
    same(row.transactionHash, log.transactionHash) &&
    same(row.blockHash, log.blockHash) &&
    row.blockNumber === log.blockNumber &&
    same(row.data, log.data) &&
    JSON.stringify(row.topics?.map((x) => x.toLowerCase())) ===
      JSON.stringify(log.topics.map((x) => x.toLowerCase()))
  )
}

/** Bound the scan and receipt checks. A failed scan is unavailable, never no-holder. */
export async function discoverDirectIssuerCandidate({ baseline, request, candidateLimit = 8 }) {
  const route = directRoute(baseline)
  if (
    typeof request !== 'function' ||
    !Number.isInteger(candidateLimit) ||
    candidateLimit < 1 ||
    candidateLimit > 8
  )
    throw Error('candidate_input_invalid')
  const block = BigInt(baseline.targetBlock)
  const from = block > LOOKBACK ? block - LOOKBACK : 1n
  const through = block - 1n
  const topic = route.kind === 'comet' ? SUPPLY : TRANSFER
  const logs = []
  let width = 512n
  let requests = 0
  for (let start = from; start <= through; ) {
    if (++requests > 136) throw Error('candidate_log_request_limit')
    const end = start + width - 1n < through ? start + width - 1n : through
    let chunk
    try {
      chunk = await request('eth_getLogs', [
        { address: route.destination, topics: [topic], fromBlock: hex(start), toBlock: hex(end) },
      ])
    } catch (error) {
      if (
        width <= 32n ||
        !(
          [35, -32615].includes(error?.code) ||
          /\brpc_http_(?:400|413)\b/.test(error?.message ?? '')
        )
      )
        throw Error('candidate_logs_unavailable')
      width /= 2n
      continue
    }
    if (!Array.isArray(chunk) || chunk.length > 4_096 || logs.length + chunk.length > 4_096)
      throw Error('candidate_logs_unavailable')
    logs.push(...chunk)
    start = end + 1n
  }
  const ranked = logs
    .map((log) => candidateLog(log, route, from, through))
    .filter(Boolean)
    .sort((a, b) =>
      a.amount === b.amount
        ? a.block === b.block
          ? a.txIndex === b.txIndex
            ? a.index === b.index
              ? a.owner.localeCompare(b.owner)
              : a.index > b.index
                ? -1
                : 1
            : a.txIndex > b.txIndex
              ? -1
              : 1
          : a.block > b.block
            ? -1
            : 1
        : a.amount > b.amount
          ? -1
          : 1,
    )
  const seen = new Set()
  const distinct = ranked.filter((row) => {
    if (seen.has(row.owner)) return false
    seen.add(row.owner)
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
      observedIncomingAssetsRaw: candidate.amount.toString(),
      status: 'rpc_unavailable',
    }
    screened.push(row)
    try {
      const receipt = await request('eth_getTransactionReceipt', [candidate.log.transactionHash])
      const discovered = await header(request, hex(candidate.block))
      if (
        !receiptMatches(candidate.log, receipt, route) ||
        discovered.hash !== candidate.log.blockHash ||
        candidate.block >= block
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
      const code = await request('eth_getCode', [candidate.owner, tag(baseline.targetHash)])
      if (code !== '0x') {
        row.status = 'contract_holder'
        continue
      }
      const balance = await callWord(
        request,
        route.destination,
        `${BALANCE}${candidate.owner.slice(2).padStart(64, '0')}`,
        baseline.targetHash,
      )
      if (balance === 0n) {
        row.status = 'no_baseline_balance'
        continue
      }
      row.status = 'eligible_holder'
      row.assetBalanceRaw = balance.toString()
      if (!selected || balance > BigInt(selected.assetBalanceRaw))
        selected = {
          holder: candidate.owner,
          assetBalanceRaw: row.assetBalanceRaw,
          holderCommitment: row.holderCommitment,
        }
    } catch {
      row.status = 'rpc_unavailable'
    }
  }
  await recheck(request, baseline)
  if (
    (await callWord(request, route.destination, TOTAL_SUPPLY, baseline.targetHash)).toString() !==
    baseline.marketSupplyRaw
  )
    throw Error('baseline_state_mismatch')
  const ladder = freezeDirectQLadder({
    marketSupplyRaw: baseline.marketSupplyRaw,
    selectedAssetBalanceRaw: selected?.assetBalanceRaw ?? null,
  })
  const evidenceDoc = {
    schema: 'carry_exit_v2_direct_candidate_v1',
    chainId: '1',
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    baselineBlock: baseline.targetBlock,
    baselineHash: baseline.targetHash,
    parentHash: baseline.targetParentHash,
    baselineState: {
      marketSupplyRaw: baseline.marketSupplyRaw,
      assetDecimals: baseline.assetDecimals,
    },
    candidateWindow: {
      fromBlock: from.toString(),
      throughBlock: through.toString(),
      transferLogs: logs.length,
      distinctRecipients: distinct.length,
      attempted: screened.length,
      candidateLimit,
      rankingRule: 'largest_single_pre_baseline_incoming_assets_then_recency_then_owner',
    },
    screenedCandidates: screened,
    selectionRule:
      'largest_pinned_asset_balance_among_top_event_ranked_bounded_receipt_verified_eoas_tie_by_rank',
    selectedHolderCommitment: selected?.holderCommitment ?? null,
    selectedAssetBalanceRaw: selected?.assetBalanceRaw ?? null,
    unavailableReason: selected
      ? null
      : distinct.length === 0
        ? 'no_pre_baseline_event_recipient'
        : distinct.length > candidateLimit
          ? 'no_eligible_holder_in_bounded_candidates'
          : 'no_pre_baseline_eoa_with_positive_balance',
    ladder,
  }
  return { holder: selected?.holder ?? null, evidenceDoc, digest: sha(JSON.stringify(evidenceDoc)) }
}
