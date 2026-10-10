// Read-only historical assay: a receipt-discovered holder at an exactly joined
// cash boundary. A successful eth_call is not key control or a future exit.
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseAbi } from 'viem'

import quoteModule from '../../lib/carry/directSupplyExitQuote.ts'
import marketModule from '../../lib/carry/directSupplyMarketConstants.ts'
import { DIRECT_FLOW_DIR } from '../record-carry-direct-supplier-flow.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls } from './carry-public-direct-exit-issue.mjs'
import { replayJoin } from './aave-usdc-cash-direct-flow-join.mjs'
import { verifyDirectSupplierFlowSegment } from './collect-carry-direct-supplier-flow.mjs'

const { readDirectSupplyExitQuote } = quoteModule
const { DIRECT_SUPPLY_MARKETS } = marketModule
export const STUDY = 'aave-usdc-holder-flow-pair-v1'
export const MAX_CANDIDATES = 32
export const FIXED_SMALL_Q_RAW = 1_000_000n // One USDC; smaller balances are ineligible.
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const balanceAbi = parseAbi(['function balanceOf(address) view returns (uint256)'])
const fail = (condition, code) => {
  if (!condition) throw new Error(code)
}
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : '')
const readBoundedJson = (path) => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    fail(stat.isFile() && stat.size > 0 && stat.size <= 2 * 1024 * 1024, 'holder_pair_source_bound')
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null)
      fail(count > 0, 'holder_pair_source_short_read')
      offset += count
    }
    fail(fstatSync(fd).size === stat.size, 'holder_pair_source_changed')
    return JSON.parse(bytes.toString('utf8'))
  } finally {
    closeSync(fd)
  }
}

/** Only a reconciled Supply beneficiary or Withdraw holder discovers a holder. */
export function candidatesAtEndpoint(rows, endpointBlock, endpointHash, limit = MAX_CANDIDATES) {
  fail(
    Array.isArray(rows) &&
      Number.isSafeInteger(endpointBlock) &&
      HASH.test(lower(endpointHash)) &&
      Number.isSafeInteger(limit) &&
      limit >= 1 &&
      limit <= MAX_CANDIDATES,
    'holder_pair_candidate_input_invalid',
  )
  const events = rows
    .filter((row) => Number.isSafeInteger(row?.blockNumber) && row.blockNumber <= endpointBlock)
    .map((row) => {
      const evidence = row?.event?.reconciliation?.evidence
      const kind = row?.kind
      const address = lower(kind === 'supply' ? evidence?.beneficiary : evidence?.holder)
      fail(
        (kind === 'supply' || kind === 'withdraw') &&
          row.event?.reconciliation?.status ===
            (kind === 'supply' ? 'reconciled_supplier_supply' : 'reconciled_supplier_withdrawal') &&
          ADDRESS.test(address) &&
          address !== '0x0000000000000000000000000000000000000000' &&
          Number.isSafeInteger(row.blockNumber) &&
          row.blockNumber >= 0 &&
          HASH.test(lower(row.event.blockHash)) &&
          HASH.test(lower(row.event.transactionHash)) &&
          (row.blockNumber !== endpointBlock ||
            lower(row.event.blockHash) === lower(endpointHash)) &&
          Number.isSafeInteger(row.event.logIndex) &&
          row.event.logIndex >= 0,
        'holder_pair_event_invalid',
      )
      return {
        holder: address,
        kind,
        blockNumber: row.blockNumber,
        blockHash: lower(row.event.blockHash),
        transactionHash: lower(row.event.transactionHash),
        logIndex: row.event.logIndex,
      }
    })
  // Latest witnessed activity first, then chain coordinates. No post-B event
  // can influence ordering or selection, including a post-B repeat of a holder.
  events.sort(
    (a, b) =>
      b.blockNumber - a.blockNumber ||
      b.logIndex - a.logIndex ||
      a.transactionHash.localeCompare(b.transactionHash) ||
      a.holder.localeCompare(b.holder),
  )
  const seen = new Set()
  return events
    .filter((event) => {
      if (seen.has(event.holder)) return false
      seen.add(event.holder)
      return true
    })
    .slice(0, limit)
}

/** Replay the whole source archive before extracting any candidate evidence. */
export function loadVerifiedEndpoint({ directOut = DIRECT_FLOW_DIR, throughBlock = null } = {}) {
  const joined = replayJoin({ directOut, throughBlock })
  const endpoint = joined.slices.at(-1)
  fail(
    endpoint?.toInclusive === joined.toBlock && HASH.test(endpoint.toHash),
    'holder_pair_endpoint_invalid',
  )
  const rows = []
  for (const [kind, sources] of [
    ['supply', joined.directSupplySourceFiles],
    ['withdraw', joined.directWithdrawalSourceFiles],
  ]) {
    fail(Array.isArray(sources) && sources.length <= 512, 'holder_pair_sources_invalid')
    for (const source of sources) {
      fail(
        /^(?:supply-)?aaveV3Usdc-[0-9]+-[0-9]+\.json$/.test(source.file),
        'holder_pair_source_filename_invalid',
      )
      const doc = readBoundedJson(join(directOut, source.file))
      fail(doc.sha256 === source.sha256, 'holder_pair_source_changed')
      const verified = verifyDirectSupplierFlowSegment(doc)
      fail(
        verified.flowKind === kind && verified.marketKey === 'aaveV3Usdc',
        'holder_pair_source_market_mismatch',
      )
      const headerByHash = new Map(doc.blocks.map((point) => [point.hash, point.number]))
      for (const event of kind === 'supply' ? verified.supplies : verified.withdrawals) {
        const blockNumber = headerByHash.get(event.blockHash)
        fail(Number.isSafeInteger(blockNumber), 'holder_pair_event_header_missing')
        rows.push({ kind, event, blockNumber })
      }
    }
  }
  const candidates = candidatesAtEndpoint(rows, joined.toBlock, endpoint.toHash)
  return {
    endpoint: {
      blockNumber: joined.toBlock,
      blockHash: endpoint.toHash,
      cashRaw: endpoint.cashAfterRaw,
    },
    candidates,
    source: {
      joinedContentSha256: createHash('sha256').update(JSON.stringify(joined)).digest('hex'),
      cashSlices: joined.slices.length,
      directSupplyFiles: joined.directSupplySourceFiles.length,
      directWithdrawalFiles: joined.directWithdrawalSourceFiles.length,
    },
  }
}

export function chooseQ(balanceRaw) {
  fail(typeof balanceRaw === 'bigint' && balanceRaw > 0n, 'holder_pair_balance_invalid')
  return balanceRaw >= FIXED_SMALL_Q_RAW ? FIXED_SMALL_Q_RAW : null
}

export function compareQuotes(left, right, expected) {
  const shape = (quote) => ({
    status: quote?.status,
    chainId: quote?.source?.chainId,
    blockNumber: quote?.source?.blockNumber,
    blockHash: lower(quote?.source?.blockHash),
    routeKey: quote?.routeKey,
    marketKind: quote?.market?.kind,
    marketAddress: lower(quote?.market?.address),
    assetAddress: lower(quote?.market?.assetAddress),
    assetDecimals: quote?.market?.assetDecimals,
    marketIdentity: quote?.market?.identity,
    balanceRaw: quote?.position?.suppliedBalanceRaw,
    assetsRaw: quote?.request?.assetsRaw,
    owner: lower(quote?.owner),
    simulation: quote?.simulation,
  })
  const a = shape(left)
  const b = shape(right)
  fail(
    a.blockNumber === expected.blockNumber &&
      a.blockHash === lower(expected.blockHash) &&
      a.status === 'checked_at_finalized_block' &&
      a.chainId === 1 &&
      a.marketKind === 'aaveV3Usdc' &&
      a.marketAddress === lower(expected.destination) &&
      a.assetAddress === lower(expected.underlying) &&
      a.assetDecimals === 6 &&
      a.marketIdentity === 'pinned_market_and_live_underlying' &&
      a.routeKey === expected.routeKey &&
      a.assetsRaw === expected.assetsRaw &&
      a.balanceRaw === expected.balanceRaw &&
      a.owner === lower(expected.holder) &&
      b.owner === lower(expected.holder) &&
      ['success', 'evm_revert'].includes(a.simulation?.status),
    'holder_pair_quote_identity_mismatch',
  )
  fail(JSON.stringify(a) === JSON.stringify(b), 'holder_pair_two_origin_disagreement')
  return a
}

const operatorIdentity = (url) => {
  const normalized = new URL(url).hostname.replace(/\.$/, '').replace(/^www\./, '')
  if (/^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/.test(normalized)) return 'loopback'
  const providers = [
    ['alchemy.com', 'alchemy'],
    ['infura.io', 'infura'],
    ['ankr.com', 'ankr'],
    ['quiknode.pro', 'quicknode'],
    ['drpc.live', 'drpc'],
    ['mevblocker.io', 'mevblocker'],
    ['flashbots.net', 'flashbots'],
  ]
  return providers.find(
    ([domain]) => normalized === domain || normalized.endsWith(`.${domain}`),
  )?.[1]
}

export function independentUrls(urls) {
  fail(
    Array.isArray(urls) && urls.length >= 2 && urls.length <= 8,
    'holder_pair_two_origins_required',
  )
  const parsed = urls.map((url) => new URL(url))
  fail(
    parsed.every(
      (url) => ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password,
    ),
    'holder_pair_two_origins_required',
  )
  const firstOperator = operatorIdentity(parsed[0].href)
  fail(firstOperator, 'holder_pair_two_origins_required')
  const second = parsed.findIndex(
    (url) => operatorIdentity(url.href) && operatorIdentity(url.href) !== firstOperator,
  )
  fail(second > 0, 'holder_pair_two_origins_required')
  return [urls[0], urls[second]]
}

export function preferredIndependentUrls(urls) {
  const priority = ['ankr', 'drpc', 'infura', 'alchemy', 'quicknode', 'mevblocker', 'flashbots']
  const rank = (url) => {
    const position = priority.indexOf(operatorIdentity(url))
    return position < 0 ? priority.length : position
  }
  return independentUrls([...urls].sort((left, right) => rank(left) - rank(right)))
}

/** One selected holder and one Q; all reads are pinned to the joined B/hash. */
export async function assayEndpoint({
  endpoint,
  candidates,
  clients,
  source,
  rpcOperators,
  quoteReader = readDirectSupplyExitQuote,
}) {
  fail(
    Array.isArray(clients) &&
      clients.length === 2 &&
      clients[0] !== clients[1] &&
      HASH.test(`0x${source?.joinedContentSha256 ?? ''}`) &&
      Array.isArray(rpcOperators) &&
      rpcOperators.length === 2 &&
      rpcOperators[0] !== rpcOperators[1] &&
      Array.isArray(candidates) &&
      candidates.length <= MAX_CANDIDATES &&
      Number.isSafeInteger(endpoint?.blockNumber) &&
      HASH.test(lower(endpoint?.blockHash)) &&
      candidates.every(
        (candidate) =>
          ADDRESS.test(candidate?.holder) &&
          Number.isSafeInteger(candidate?.blockNumber) &&
          candidate.blockNumber >= 0 &&
          candidate.blockNumber <= endpoint.blockNumber &&
          HASH.test(lower(candidate?.blockHash)) &&
          (candidate.blockNumber !== endpoint.blockNumber ||
            lower(candidate.blockHash) === lower(endpoint.blockHash)) &&
          HASH.test(lower(candidate?.transactionHash)) &&
          Number.isSafeInteger(candidate?.logIndex) &&
          candidate.logIndex >= 0 &&
          ['supply', 'withdraw'].includes(candidate?.kind),
      ),
    'holder_pair_assay_input_invalid',
  )
  const market = DIRECT_SUPPLY_MARKETS.aaveV3Usdc
  const pinned = { blockHash: endpoint.blockHash, requireCanonical: true }
  let selected = null
  const inspected = []
  for (const candidate of candidates) {
    const reads = await Promise.all(
      clients.map(async (client) => ({
        code: await client.request({
          method: 'eth_getCode',
          params: [candidate.holder, pinned],
        }),
        balance: await client.readContract({
          address: market.destination,
          abi: balanceAbi,
          functionName: 'balanceOf',
          args: [candidate.holder],
          ...pinned,
        }),
      })),
    )
    fail(
      reads[0].code === reads[1].code && reads[0].balance === reads[1].balance,
      'holder_pair_two_origin_disagreement',
    )
    inspected.push({
      holder: candidate.holder,
      discoveredAtBlock: candidate.blockNumber,
      code:
        reads[0].code === '0x'
          ? 'no_deployed_code'
          : typeof reads[0].code === 'string'
            ? 'deployed_code'
            : 'unavailable',
      aUsdcBalanceRaw: typeof reads[0].balance === 'bigint' ? reads[0].balance.toString() : null,
    })
    // Unknown code is not evidence of an account without deployed code.
    if (
      reads[0].code !== '0x' ||
      typeof reads[0].balance !== 'bigint' ||
      reads[0].balance < FIXED_SMALL_Q_RAW
    )
      continue
    selected = {
      candidate,
      balanceRaw: reads[0].balance.toString(),
      assetsRaw: chooseQ(reads[0].balance).toString(),
    }
    break
  }
  if (!selected)
    return {
      study: STUDY,
      endpoint,
      source,
      rpcOperators,
      inspected,
      status: 'no_eligible_holder_within_bounded_scan',
      forecast: false,
    }
  const request = {
    routeKey: market.routeKey,
    destinationAddress: market.destination,
    owner: selected.candidate.holder,
    assetsRaw: selected.assetsRaw,
  }
  const historical = {
    mode: 'internal_historical_finalized_block',
    blockNumber: BigInt(endpoint.blockNumber),
    blockHash: endpoint.blockHash,
  }
  const [left, right] = await Promise.all(
    clients.map((client) => quoteReader(client, request, () => Date.now(), historical)),
  )
  const comparison = compareQuotes(left, right, {
    ...endpoint,
    ...selected,
    destination: market.destination,
    underlying: market.underlying,
    holder: selected.candidate.holder,
    routeKey: market.routeKey,
  })
  return {
    study: STUDY,
    endpoint,
    source,
    rpcOperators,
    inspected,
    status: 'same_holder_same_block_two_origin_assay',
    holder: selected.candidate.holder,
    discoveredBy: selected.candidate,
    qRule: 'fixed_1_USDC_raw_1000000_requires_pinned_aUSDC_balance_at_least_q',
    balanceRaw: selected.balanceRaw,
    assetsRaw: selected.assetsRaw,
    simulation: comparison.simulation,
    noDeployedCodeAtEndpoint: true,
    forecast: false,
    keyControlVerified: false,
    transactionExecuted: false,
    futureExitVerified: false,
    restrictionDurationEstimated: false,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2] ?? '--dry-run'
    const hasLimit =
      mode === '--probe' && process.argv[3] === '--max-candidates' && process.argv.length === 5
    fail(
      ['--dry-run', '--probe'].includes(mode) &&
        (process.argv.length === 2 || process.argv.length === 3 || hasLimit),
      'holder_pair_invalid_arguments',
    )
    const probeLimit = hasLimit ? Number(process.argv[4]) : 4
    fail(
      Number.isSafeInteger(probeLimit) && probeLimit >= 1 && probeLimit <= MAX_CANDIDATES,
      'holder_pair_invalid_arguments',
    )
    const verified = loadVerifiedEndpoint()
    const rpcUrls =
      mode === '--probe' ? preferredIndependentUrls(configuredPublicRpcUrls(readEnv())) : []
    const result =
      mode === '--dry-run'
        ? {
            study: STUDY,
            endpoint: verified.endpoint,
            source: verified.source,
            candidates: verified.candidates.slice(0, probeLimit),
            network: false,
            forecast: false,
          }
        : await assayEndpoint({
            endpoint: verified.endpoint,
            candidates: verified.candidates.slice(0, probeLimit),
            source: verified.source,
            rpcOperators: rpcUrls.map(operatorIdentity),
            clients: rpcUrls.map(makeClient),
          })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    // viem transport errors can contain credentialed RPC URLs; do not echo them.
    const code =
      typeof error?.message === 'string' && /^holder_pair_[a-z_]+$/.test(error.message)
        ? error.message
        : 'holder_pair_rpc_or_source_unavailable'
    process.stderr.write(`${code}\n`)
    process.exitCode = 1
  }
}
