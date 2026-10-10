// Bounded, resumable Aave V3 USDC market-cash flow pilot. Reuses the exact
// Pool/USDC receipt collector and its endpoint balance reconciliation. The
// resulting 24h maxima describe this one observed ~25h range only; they are
// not holder exits, protocol maxima, forecasts, or provider-independent proof.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { MAX_BLOCKS, collect, verify as verifyCollector } from './aave-core-operation-collector.mjs'

export const STUDY = 'aave-usdc-24h-market-cash-flow-pilot-v1'
export const OUT = resolve('data/research/venue-signals/aave-usdc-24h-flow-pilot')
export const HORIZON_SECONDS = 86_400
export const TARGET_SPAN_SECONDS = 90_000 // 25h gives more than one complete 24h window.
export const MAX_RANGE_BLOCKS = 9_000
const HASH = /^0x[0-9a-f]{64}$/
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const iso = (seconds) => new Date(seconds * 1000).toISOString()
const hex = (number) => `0x${number.toString(16)}`
const lower = (value) => String(value ?? '').toLowerCase()
const insist = (ok, reason) => {
  if (!ok) throw new Error(reason)
}

function header(value) {
  const number = Number(BigInt(value?.number ?? -1))
  const timestamp = Number(BigInt(value?.timestamp ?? -1))
  const blockHash = lower(value?.hash)
  insist(
    Number.isSafeInteger(number) &&
      number >= 0 &&
      Number.isSafeInteger(timestamp) &&
      timestamp > 0 &&
      HASH.test(blockHash),
    'invalid_pinned_block_header',
  )
  return { number, hash: blockHash, timestamp }
}

async function blockAt(client, number) {
  const result = header(
    await client.request({ method: 'eth_getBlockByNumber', params: [hex(number), false] }),
  )
  insist(result.number === number, 'block_number_mismatch')
  return result
}

async function buildPlan(client) {
  const chain = Number(BigInt(await client.request({ method: 'eth_chainId', params: [] })))
  insist(chain === 1, 'wrong_chain')
  const finalized = header(
    await client.request({ method: 'eth_getBlockByNumber', params: ['finalized', false] }),
  )
  insist(Date.now() / 1000 - finalized.timestamp <= 3600, 'stale_finalized_head')
  const desired = finalized.timestamp - TARGET_SPAN_SECONDS
  let low = Math.max(0, finalized.number - MAX_RANGE_BLOCKS)
  let high = finalized.number
  const first = await blockAt(client, low)
  insist(first.timestamp <= desired, 'bounded_range_does_not_reach_25h')
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if ((await blockAt(client, mid)).timestamp <= desired) low = mid
    else high = mid - 1
  }
  const from = await blockAt(client, low)
  const to = await blockAt(client, finalized.number)
  insist(
    to.hash === finalized.hash &&
      to.timestamp - from.timestamp >= HORIZON_SECONDS &&
      to.number - from.number <= MAX_RANGE_BLOCKS,
    'range_not_complete_24h',
  )
  return {
    study: STUDY,
    market: 'USDC',
    chainId: 1,
    horizonSeconds: HORIZON_SECONDS,
    targetSpanSeconds: TARGET_SPAN_SECONDS,
    maxRangeBlocks: MAX_RANGE_BLOCKS,
    from,
    to,
    createdAt: new Date().toISOString(),
  }
}

function readPlan(out) {
  const plan = JSON.parse(readFileSync(join(out, 'pilot.plan'), 'utf8'))
  const { sha256, ...body } = plan
  insist(
    sha256 === hash(body) &&
      plan.study === STUDY &&
      plan.market === 'USDC' &&
      plan.chainId === 1 &&
      plan.horizonSeconds === HORIZON_SECONDS &&
      plan.maxRangeBlocks === MAX_RANGE_BLOCKS &&
      plan.to.number - plan.from.number <= MAX_RANGE_BLOCKS &&
      plan.to.timestamp - plan.from.timestamp >= HORIZON_SECONDS &&
      HASH.test(plan.from.hash) &&
      HASH.test(plan.to.hash),
    'invalid_flow_pilot_plan',
  )
  return plan
}

function receiptFiles(out) {
  return readdirSync(out)
    .filter((name) => name.endsWith('.json'))
    .sort()
}

function readReceipts(out, plan) {
  verifyCollector({ out })
  const receipts = receiptFiles(out).map((name) =>
    JSON.parse(readFileSync(join(out, name), 'utf8')),
  )
  let next = plan.from.number
  let nextHash = plan.from.hash
  for (const receipt of receipts) {
    insist(receipt.market === 'USDC', 'wrong_receipt_market')
    insist(
      receipt.from.blockNumber === next &&
        receipt.from.blockHash === nextHash &&
        receipt.to.blockNumber > next &&
        receipt.to.blockNumber - next <= MAX_BLOCKS,
      'receipt_gap_overlap_or_hash_disagreement',
    )
    next = receipt.to.blockNumber
    nextHash = receipt.to.blockHash
  }
  insist(next <= plan.to.number, 'receipts_run_past_plan')
  if (next === plan.to.number) insist(nextHash === plan.to.hash, 'final_hash_disagreement')
  return { receipts, next, complete: next === plan.to.number }
}

function units(raw) {
  const negative = raw < 0n
  const positive = negative ? -raw : raw
  const whole = positive / 1_000_000n
  const fraction = (positive % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

function lowerBound(events, timestamp) {
  let low = 0
  let high = events.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (events[mid].timestamp < timestamp) low = mid + 1
    else high = mid
  }
  return low
}

/** Exact half-open 24h event-time windows over a verified contiguous source range. */
export function maximumWindows(events, coverageFrom, coverageToExclusive) {
  const latestStart = coverageToExclusive - HORIZON_SECONDS
  insist(latestStart >= coverageFrom, 'less_than_one_complete_24h_window')
  const ordered = [...events].sort(
    (a, b) => a.timestamp - b.timestamp || a.blockNumber - b.blockNumber || a.logIndex - b.logIndex,
  )
  const grossIn = [0n]
  const grossOut = [0n]
  for (const event of ordered) {
    grossIn.push(grossIn.at(-1) + (event.direction === 'in' ? BigInt(event.amountRaw) : 0n))
    grossOut.push(grossOut.at(-1) + (event.direction === 'out' ? BigInt(event.amountRaw) : 0n))
  }
  const grossCandidates = new Set([coverageFrom])
  const netCandidates = new Set([coverageFrom])
  for (const event of ordered) {
    const candidate =
      event.direction === 'out' ? event.timestamp - HORIZON_SECONDS + 1 : event.timestamp + 1
    if (candidate >= coverageFrom && candidate <= latestStart) netCandidates.add(candidate)
    if (event.direction === 'out' && candidate >= coverageFrom && candidate <= latestStart)
      grossCandidates.add(candidate)
  }
  const evaluate = (start) => {
    const left = lowerBound(ordered, start)
    const right = lowerBound(ordered, start + HORIZON_SECONDS)
    const inbound = grossIn[right] - grossIn[left]
    const outbound = grossOut[right] - grossOut[left]
    return { start, inbound, outbound, net: outbound - inbound, transferCount: right - left }
  }
  const best = (candidates, metric) => {
    let selected = null
    for (const start of [...candidates].sort((a, b) => a - b)) {
      const row = evaluate(start)
      if (selected === null || row[metric] > selected[metric]) selected = row
    }
    return {
      startUtc: iso(selected.start),
      endExclusiveUtc: iso(selected.start + HORIZON_SECONDS),
      grossCashInRaw: String(selected.inbound),
      grossCashOutRaw: String(selected.outbound),
      netCashOutRaw: String(selected.net),
      grossCashOutUsdc: units(selected.outbound),
      netCashOutUsdc: units(selected.net),
      transferCount: selected.transferCount,
    }
  }
  return {
    maximumGrossCashOut: best(grossCandidates, 'outbound'),
    maximumSignedNetCashOut: best(netCandidates, 'net'),
    evaluatedGrossCandidateCount: grossCandidates.size,
    evaluatedNetCandidateCount: netCandidates.size,
  }
}

function readHeaders(out) {
  const saved = JSON.parse(readFileSync(join(out, 'event-headers.headers'), 'utf8'))
  const { sha256, ...body } = saved
  insist(sha256 === hash(body), 'event_header_digest_mismatch')
  insist(body.study === STUDY && Array.isArray(body.blocks), 'invalid_event_headers')
  return saved
}

async function captureEventHeaders(client, out, receipts, plan) {
  const known = new Map([
    [plan.from.number, plan.from.hash],
    [plan.to.number, plan.to.hash],
  ])
  for (const receipt of receipts) {
    for (const event of [...receipt.operations, ...receipt.transfers]) {
      const prior = known.get(event.blockNumber)
      insist(!prior || prior === event.blockHash, 'event_block_hash_conflict')
      known.set(event.blockNumber, event.blockHash)
    }
  }
  const numbers = [...known.keys()].sort((a, b) => a - b)
  const blocks = []
  // Bound concurrency to avoid provider throttling; all timestamps are from
  // headers whose hashes must match the already sealed event receipts.
  for (let i = 0; i < numbers.length; i += 8) {
    const batch = await Promise.all(
      numbers.slice(i, i + 8).map((number) => blockAt(client, number)),
    )
    for (const item of batch) {
      insist(item.hash === known.get(item.number), 'event_header_hash_mismatch')
      blocks.push(item)
    }
  }
  const body = { study: STUDY, source: 'rpc:eth_getBlockByNumber', blocks }
  const saved = { ...body, sha256: hash(body) }
  writeFileSync(join(out, 'event-headers.headers'), `${JSON.stringify(saved)}\n`, { flag: 'wx' })
  return saved
}

export function summarize(plan, receipts, headerManifest) {
  insist(receipts.length > 0, 'no_receipts')
  const byNumber = new Map(headerManifest.blocks.map((row) => [row.number, row]))
  insist(
    byNumber.get(plan.from.number)?.hash === plan.from.hash &&
      byNumber.get(plan.from.number)?.timestamp === plan.from.timestamp &&
      byNumber.get(plan.to.number)?.hash === plan.to.hash &&
      byNumber.get(plan.to.number)?.timestamp === plan.to.timestamp,
    'plan_endpoint_header_mismatch',
  )
  const operations = receipts.flatMap((receipt) => receipt.operations)
  const transfers = receipts.flatMap((receipt) => receipt.transfers)
  const cashEvents = []
  const aToken = receipts[0].aToken
  for (const event of [...operations, ...transfers]) {
    const item = byNumber.get(event.blockNumber)
    insist(item?.hash === event.blockHash, 'missing_or_mismatched_event_header')
  }
  for (const event of transfers) {
    const timestamp = byNumber.get(event.blockNumber).timestamp
    const from = lower(event.from)
    const to = lower(event.to)
    if (from === aToken && to === aToken) continue
    const direction = from === aToken ? 'out' : to === aToken ? 'in' : null
    insist(direction, 'transfer_misses_atoken')
    cashEvents.push({
      timestamp,
      blockNumber: event.blockNumber,
      logIndex: event.logIndex,
      direction,
      amountRaw: event.amountRaw,
    })
  }
  const out = cashEvents.reduce(
    (sum, event) => sum + (event.direction === 'out' ? BigInt(event.amountRaw) : 0n),
    0n,
  )
  const inbound = cashEvents.reduce(
    (sum, event) => sum + (event.direction === 'in' ? BigInt(event.amountRaw) : 0n),
    0n,
  )
  const endpointDelta = BigInt(receipts.at(-1).to.cashRaw) - BigInt(receipts[0].from.cashRaw)
  insist(endpointDelta === inbound - out, 'pilot_endpoint_cash_reconciliation_failed')
  const byKind = Object.fromEntries(
    ['Supply', 'Withdraw', 'Borrow', 'Repay'].map((kind) => [
      kind,
      operations.filter((event) => event.kind === kind).length,
    ]),
  )
  return {
    study: STUDY,
    status: 'observed_descriptive_only',
    identity: {
      market: 'Aave V3 USDC',
      chainId: 1,
      pool: receipts[0].pool,
      underlying: receipts[0].underlying,
      aToken,
      decimals: 6,
    },
    coverage: {
      fromExclusive: plan.from,
      toInclusive: plan.to,
      seconds: plan.to.timestamp - plan.from.timestamp,
      receiptCount: receipts.length,
      receiptSha256: receipts.map((receipt) => receipt.sha256),
      poolChunkCount: receipts.reduce(
        (sum, receipt) => sum + receipt.chunks.poolOperations.length,
        0,
      ),
      transferChunkCount: receipts.reduce(
        (sum, receipt) => sum + receipt.chunks.underlyingTransfers.length,
        0,
      ),
      eventHeaderCount: headerManifest.blocks.length,
      eventHeaderSha256: headerManifest.sha256,
      sourceStatus: 'rpc_returned_complete_and_endpoint_reconciled_single_provider',
    },
    counts: {
      poolOperations: operations.length,
      poolByKind: byKind,
      underlyingTransfers: transfers.length,
      cashMovingTransfers: cashEvents.length,
      grossMismatchedTransactions: receipts.reduce(
        (sum, receipt) => sum + receipt.reconciliation.counts.grossMismatch,
        0,
      ),
      operationOnlyTransactions: receipts.reduce(
        (sum, receipt) => sum + receipt.reconciliation.counts.operationOnly,
        0,
      ),
      transferOnlyTransactions: receipts.reduce(
        (sum, receipt) => sum + receipt.reconciliation.counts.transferOnly,
        0,
      ),
    },
    totals: {
      grossCashInRaw: String(inbound),
      grossCashOutRaw: String(out),
      signedNetCashOutRaw: String(out - inbound),
      endpointCashDeltaRaw: String(endpointDelta),
    },
    observed24h: maximumWindows(cashEvents, plan.from.timestamp + 1, plan.to.timestamp + 1),
    caveat:
      'Observed aggregate market cash flow only. One RPC provider returned the complete queried ranges and USDC transfers reconcile endpoint balances, but offsetting omissions cannot be excluded. No holder-specific exit, likely future duration, forecast validation, or executable alert follows.',
  }
}

export function verifyPilot({ out = OUT } = {}) {
  const plan = readPlan(out)
  const { receipts, complete } = readReceipts(out, plan)
  insist(complete, 'pilot_range_incomplete')
  const summary = summarize(plan, receipts, readHeaders(out))
  const saved = JSON.parse(readFileSync(join(out, 'pilot.summary'), 'utf8'))
  insist(JSON.stringify(saved) === JSON.stringify(summary), 'pilot_summary_mismatch')
  return summary
}

export async function run({ client, out = OUT } = {}) {
  insist(client?.request, 'rpc_client_required')
  mkdirSync(out, { recursive: true })
  const planPath = join(out, 'pilot.plan')
  if (!existsSync(planPath)) {
    const plan = await buildPlan(client)
    writeFileSync(planPath, `${JSON.stringify({ ...plan, sha256: hash(plan) })}\n`, { flag: 'wx' })
  }
  const plan = readPlan(out)
  let current = readReceipts(out, plan)
  while (!current.complete) {
    const next = Math.min(current.next + MAX_BLOCKS, plan.to.number)
    await collect({ client, marketName: 'USDC', fromBlock: current.next, toBlock: next, out })
    current = readReceipts(out, plan)
  }
  if (!existsSync(join(out, 'event-headers.headers')))
    await captureEventHeaders(client, out, current.receipts, plan)
  const summary = summarize(plan, current.receipts, readHeaders(out))
  const summaryPath = join(out, 'pilot.summary')
  if (!existsSync(summaryPath))
    writeFileSync(summaryPath, `${JSON.stringify(summary)}\n`, { flag: 'wx' })
  return verifyPilot({ out })
}

async function main(argv = process.argv.slice(2)) {
  insist(argv.length === 1 && ['--run', '--verify'].includes(argv[0]), 'usage: --run | --verify')
  if (argv[0] === '--verify') return console.log(JSON.stringify(verifyPilot()))
  const { get } = readEnv()
  const rpc =
    process.env.RECORDER_RPC_URLS ||
    process.env.RECORDER_RPC_URL ||
    get('RECORDER_RPC_URLS') ||
    get('RECORDER_RPC_URL')
  insist(rpc, 'recorder_rpc_required')
  console.log(JSON.stringify(await run({ client: makeClient(rpc) })))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    // Provider errors can include credential-bearing RPC URLs.
    console.error(JSON.stringify({ status: 'error', study: STUDY, reason: 'pilot_failed_closed' }))
    process.exitCode = 1
  })
