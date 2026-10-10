// Exact six post-upgrade Saturn request arguments versus the pre-request quote.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import { requestWithRetries, writeExclusive } from './apyusd-receipt-cohort-source.mjs'
import { verifyQueueEvents } from './saturn-queue-event-cohort.mjs'
import { verifyPending } from './saturn-queue-pending-terms.mjs'
import { verifyBoundary } from './saturn-queue-upgrade-boundary.mjs'

export const OUT = resolve(
  'data/research/venue-signals/saturn-queue-postupgrade-request-inputs-v1.json',
)
const VAULT = '0xd166337499e176bbc38a1fbd113ab144e5bd2df7'
const QUEUE = '0x4bc9fec04f0f95e9b42a3ef18f3c96fb57923d2e'
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const QUEUE_V2 = '0xdaf6f8523d7a707d173a12041e1523fdf1373f23'
const ABI = parseAbi([
  'function requestRedeem(uint256 shares,uint256 minSharePrice) returns (uint256)',
  'function previewRedeem(uint256 shares) view returns (uint256)',
])
const HASH = /^0x[0-9a-f]{64}$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const canonical = JSON.stringify
const hex = (n) => `0x${n.toString(16)}`
const ticketId = (log) => BigInt(log.topics[1]).toString()
const eventShares = (log) => BigInt(`0x${log.data.slice(2, 66)}`).toString()

function requestLogs(events, boundary) {
  const ids = new Set(boundary.classification.afterUpgradeTicketIds)
  const logs = events.logs.filter((log) => log.kind === 'requested' && ids.has(ticketId(log)))
  if (logs.length !== ids.size || logs.some((log) => log.blockNumber <= boundary.firstNewBlock))
    throw Error('saturn_postupgrade_request_denominator_invalid')
  return logs
}

function normalizeTx(tx, log, pendingTicket) {
  const blockNumber = Number(BigInt(tx?.blockNumber ?? '0x0'))
  const input = tx?.input?.toLowerCase()
  if (
    tx?.hash?.toLowerCase() !== log.transactionHash ||
    blockNumber !== log.blockNumber ||
    tx?.to?.toLowerCase() !== VAULT ||
    tx?.from?.toLowerCase() !== `0x${log.topics[2].slice(-40)}` ||
    !/^0x[0-9a-f]+$/.test(input ?? '')
  )
    throw Error('saturn_postupgrade_request_tx_invalid')
  let args
  try {
    args = decodeFunctionData({ abi: ABI, data: input })
  } catch {
    throw Error('saturn_postupgrade_request_selector_invalid')
  }
  if (
    args.functionName !== 'requestRedeem' ||
    args.args[0].toString() !== eventShares(log) ||
    args.args[0].toString() !== pendingTicket.sharesRaw ||
    args.args[1].toString() !== pendingTicket.minSharePriceRaw
  )
    throw Error('saturn_postupgrade_request_args_invalid')
  return {
    ticketId: ticketId(log),
    transactionHash: log.transactionHash,
    blockNumber,
    from: tx.from.toLowerCase(),
    to: VAULT,
    input,
    sharesRaw: args.args[0].toString(),
    submittedMinRaw: args.args[1].toString(),
  }
}

function rowFrom(tx, wholeQuoteRaw, implementation) {
  const shares = BigInt(tx.sharesRaw)
  const quote = BigInt(wholeQuoteRaw)
  const minimum = BigInt(tx.submittedMinRaw)
  const netSharePrice = (quote * 10n ** 18n) / shares
  return {
    ...tx,
    preRequestBlock: tx.blockNumber - 1,
    queueImplementation: implementation,
    wholeTicketNetQuoteRaw: wholeQuoteRaw,
    netSharePriceRaw: netSharePrice.toString(),
    wholeQuoteMinus10bpsRaw: ((quote * 9990n) / 10_000n).toString(),
    minMatchesWholeQuoteMinus10bps: minimum === (quote * 9990n) / 10_000n,
    minAboveNetSharePrice: minimum > netSharePrice,
  }
}

function validateRow(row, log, pendingTicket) {
  if (
    !row ||
    row.ticketId !== ticketId(log) ||
    row.transactionHash !== log.transactionHash ||
    row.blockNumber !== log.blockNumber ||
    row.preRequestBlock !== log.blockNumber - 1 ||
    row.queueImplementation !== QUEUE_V2 ||
    !HASH.test(row.transactionHash ?? '')
  )
    throw Error('saturn_postupgrade_row_invalid')
  const tx = normalizeTx(
    {
      hash: row.transactionHash,
      blockNumber: hex(row.blockNumber),
      from: row.from,
      to: row.to,
      input: row.input,
    },
    log,
    pendingTicket,
  )
  const recomputed = rowFrom(tx, row.wholeTicketNetQuoteRaw, row.queueImplementation)
  if (canonical(recomputed) !== canonical(row)) throw Error('saturn_postupgrade_row_replay_changed')
  return row
}

async function captureRow(origins, log, pendingTicket) {
  const block = log.blockNumber - 1
  const data = encodeFunctionData({
    abi: ABI,
    functionName: 'previewRedeem',
    args: [BigInt(pendingTicket.sharesRaw)],
  })
  const reads = await Promise.all(
    origins.map(async (origin) => {
      const [tx, quoteRaw, implementationRaw] = await Promise.all([
        requestWithRetries(origin, 'eth_getTransactionByHash', [log.transactionHash]),
        requestWithRetries(origin, 'eth_call', [{ to: VAULT, data }, hex(block)]),
        requestWithRetries(origin, 'eth_getStorageAt', [QUEUE, SLOT, hex(block)]),
      ])
      return rowFrom(
        normalizeTx(tx, log, pendingTicket),
        decodeFunctionResult({
          abi: ABI,
          functionName: 'previewRedeem',
          data: quoteRaw,
        }).toString(),
        `0x${implementationRaw.slice(-40).toLowerCase()}`,
      )
    }),
  )
  if (canonical(reads[0]) !== canonical(reads[1]) || reads[0].queueImplementation !== QUEUE_V2)
    throw Error('saturn_postupgrade_origins_disagree')
  return validateRow(reads[0], log, pendingTicket)
}

async function sources() {
  const [events, pending, boundary] = await Promise.all([
    verifyQueueEvents(),
    verifyPending(),
    verifyBoundary(),
  ])
  return { events, pending, boundary, logs: requestLogs(events, boundary) }
}

export async function capturePostUpgrade({
  urls = configuredPublicRpcUrls(readEnv()),
  out = OUT,
} = {}) {
  const { events, pending, boundary, logs } = await sources()
  const clients = publicRpcClients(urls)
  const origins = ['rpc.ankr.com', 'eth-mainnet.g.alchemy.com'].map((host) =>
    clients.find((client) => new URL(client.url).hostname === host),
  )
  if (origins.some((origin) => !origin)) throw Error('saturn_postupgrade_origins_unavailable')
  const rows = []
  for (const log of logs) {
    const ticket = pending.tickets.find((entry) => entry.ticketId === ticketId(log))
    if (!ticket) throw Error('saturn_postupgrade_ticket_missing')
    rows.push(await captureRow(origins, log, ticket))
  }
  const summary = {
    postUpgradePending: rows.length,
    wholeTicketMinSubmittedAsSharePrice: rows.filter((row) => row.minMatchesWholeQuoteMinus10bps)
      .length,
    minAboveRequestSharePrice: rows.filter((row) => row.minAboveNetSharePrice).length,
  }
  const body = {
    study: 'saturn_queue_postupgrade_request_inputs_v1',
    sourceEventSha256: events.sha256,
    sourcePendingSha256: pending.sha256,
    sourceBoundarySha256: boundary.sha256,
    origins: ['rpc.ankr.com', 'eth-mainnet.g.alchemy.com'],
    rows,
    summary,
  }
  const row = { ...body, sha256: sha(canonical(body)) }
  await writeExclusive(out, row)
  return row
}

export async function verifyPostUpgrade(out = OUT) {
  const { events, pending, boundary, logs } = await sources()
  const bytes = await readFile(out)
  if (bytes.length > 16_384) throw Error('saturn_postupgrade_artifact_oversize')
  const row = JSON.parse(bytes.toString('utf8'))
  const { sha256: _seal, ...body } = row
  if (
    bytes.toString('utf8') !== `${canonical(row)}\n` ||
    row.study !== 'saturn_queue_postupgrade_request_inputs_v1' ||
    row.sourceEventSha256 !== events.sha256 ||
    row.sourcePendingSha256 !== pending.sha256 ||
    row.sourceBoundarySha256 !== boundary.sha256 ||
    canonical(row.origins) !== canonical(['rpc.ankr.com', 'eth-mainnet.g.alchemy.com']) ||
    row.sha256 !== sha(canonical(body)) ||
    row.rows?.length !== logs.length
  )
    throw Error('saturn_postupgrade_artifact_invalid')
  const rows = logs.map((log, index) =>
    validateRow(
      row.rows[index],
      log,
      pending.tickets.find((ticket) => ticket.ticketId === ticketId(log)),
    ),
  )
  const summary = {
    postUpgradePending: rows.length,
    wholeTicketMinSubmittedAsSharePrice: rows.filter(
      (entry) => entry.minMatchesWholeQuoteMinus10bps,
    ).length,
    minAboveRequestSharePrice: rows.filter((entry) => entry.minAboveNetSharePrice).length,
  }
  if (canonical(row.summary) !== canonical(summary))
    throw Error('saturn_postupgrade_summary_invalid')
  return row
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const row = process.argv.includes('--verify')
    ? await verifyPostUpgrade()
    : await capturePostUpgrade()
  console.log(JSON.stringify({ summary: row.summary, sha256: row.sha256 }))
}
