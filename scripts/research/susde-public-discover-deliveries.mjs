// One foreground owner-filtered discovery pass. A discovered log is never a
// payout proof; only attestMinedDelivery may append to the verified ledger.
import { pathToFileURL } from 'node:url'

import { toEventSelector } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import { verifyIssues } from './susde-public-pending-exit-issue.mjs'
import { attestMinedDelivery, verifyDeliveries } from './susde-public-mined-delivery.mjs'
import { SILO, USDE } from './susde-public-pending-exit-common.mjs'

const TRANSFER = toEventSelector('Transfer(address,address,uint256)').toLowerCase()
const SELECTED = [1, 5, 9, 10, 12, 13, 14]
const STEP = 1000
const MAX_SPAN = 24_000
const HASH = /^0x[0-9a-f]{64}$/
const RAW = /^0x[0-9a-f]{64}$/
const fail = (okay, code) => {
  if (!okay) throw Error(code)
}
const word = (address) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`
const blockNumber = (raw) => {
  fail(/^0x[0-9a-f]+$/i.test(raw ?? ''), 'susde_discovery_block_invalid')
  const value = Number(BigInt(raw))
  fail(Number.isSafeInteger(value), 'susde_discovery_block_invalid')
  return value
}

export function candidateMatches(log, issues) {
  fail(
    log?.address?.toLowerCase() === USDE &&
      Array.isArray(log.topics) &&
      log.topics.length === 3 &&
      log.topics[0]?.toLowerCase() === TRANSFER &&
      log.topics[1]?.toLowerCase() === word(SILO) &&
      RAW.test(log.topics[2] ?? '') &&
      RAW.test(log.data ?? '') &&
      HASH.test(log.transactionHash ?? '') &&
      HASH.test(log.blockHash ?? '') &&
      log.removed !== true,
    'susde_discovery_log_invalid',
  )
  const holder = `0x${log.topics[2].slice(-40)}`
  const amount = BigInt(log.data).toString()
  const at = blockNumber(log.blockNumber)
  return issues.filter(
    (issue) =>
      issue.holder.toLowerCase() === holder &&
      issue.pendingAssetsRaw === amount &&
      at > Number(issue.anchor.blockNumber),
  )
}

export async function discoverAndAttest({
  urls = configuredPublicRpcUrls(readEnv()),
  clients = publicRpcClients,
  loadIssues = verifyIssues,
  loadDeliveries = verifyDeliveries,
  attest = attestMinedDelivery,
} = {}) {
  const [issues, deliveries] = await Promise.all([loadIssues(), loadDeliveries()])
  const delivered = new Set(deliveries.map((row) => row.issueSequence))
  const pending = SELECTED.map((sequence) => issues[sequence - 1]).filter(
    (issue) => issue && !delivered.has(issue.sequence),
  )
  fail(pending.length > 0, 'susde_discovery_no_pending_issues')
  const origins = clients(urls)
  const ankr = origins.find((row) => new URL(row.url).hostname === 'rpc.ankr.com')
  const alchemy = origins.find((row) => new URL(row.url).hostname === 'eth-mainnet.g.alchemy.com')
  fail(ankr && alchemy, 'susde_discovery_origins_missing')
  const headers = await Promise.all(
    [ankr, alchemy].map((origin) => origin.request('eth_getBlockByNumber', ['finalized', false])),
  )
  fail(
    headers[0]?.hash === headers[1]?.hash &&
      headers[0]?.number === headers[1]?.number &&
      HASH.test(headers[0]?.hash ?? ''),
    'susde_discovery_finalized_disagreement',
  )
  const end = blockNumber(headers[0].number)
  const start = Math.min(...pending.map((issue) => Number(issue.anchor.blockNumber))) + 1
  fail(end >= start && end - start + 1 <= MAX_SPAN, 'susde_discovery_span_exceeded')
  const topics = [...new Set(pending.map((issue) => word(issue.holder)))]
  const byIssue = new Map()
  let windows = 0
  let logsSeen = 0
  for (let from = start; from <= end; from += STEP) {
    const to = Math.min(from + STEP - 1, end)
    const logs = await ankr.request('eth_getLogs', [
      {
        address: USDE,
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
        topics: [TRANSFER, word(SILO), topics],
      },
    ])
    fail(Array.isArray(logs) && logs.length <= 1000, 'susde_discovery_log_bound')
    windows++
    logsSeen += logs.length
    for (const log of logs) {
      const matches = candidateMatches(log, pending)
      for (const issue of matches) {
        const hits = byIssue.get(issue.sequence) ?? new Set()
        hits.add(log.transactionHash.toLowerCase())
        byIssue.set(issue.sequence, hits)
      }
    }
  }
  const result = {
    fromBlock: start,
    throughFinalizedBlock: end,
    windows,
    logsSeen,
    pendingIssues: pending.length,
    uniqueCandidates: 0,
    ambiguousIssues: 0,
    newlyAttested: 0,
    attestUnavailable: 0,
  }
  for (const issue of pending) {
    const hits = [...(byIssue.get(issue.sequence) ?? [])]
    if (hits.length > 1) {
      result.ambiguousIssues++
      continue
    }
    if (hits.length === 0) continue
    result.uniqueCandidates++
    const proof = await attest({ issueSequence: issue.sequence, transactionHash: hits[0], urls })
    if (proof.status === 'attested') result.newlyAttested++
    else if (proof.status !== 'already_attested') result.attestUnavailable++
  }
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    fail(process.argv.length === 3 && process.argv[2] === '--run', 'susde_discovery_usage')
    process.stdout.write(`${JSON.stringify(await discoverAndAttest())}\n`)
  } catch (error) {
    process.stderr.write(
      `${/^susde_discovery_/.test(error?.message) ? error.message : 'susde_discovery_run_failed'}\n`,
    )
    process.exitCode = 1
  }
}
