// App-native prospective H1 same-holder, same-amount checks for three pinned
// direct lending markets. This records labels; it publishes no future forecast.
// Run --score, --issue, --audit in that order on the 15-minute local tick.
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'
import { decodeEventLog, parseAbi, parseAbiItem, toEventSelector } from 'viem'

import quoteModule from '../lib/carry/directSupplyExitQuote.ts'
import constantsModule from '../lib/carry/directSupplyMarketConstants.ts'
import { makeClient, readEnv } from './lib/venue-reads.mjs'

const { readDirectSupplyExitQuote } = quoteModule
const { DIRECT_SUPPLY_MARKETS } = constantsModule
const lower = (value) => String(value).toLowerCase()
const MARKETS = ['aaveV3Usdc', 'compoundV3Usdc', 'sparkLendUsdt'].map((kind) => ({
  kind,
  ...DIRECT_SUPPLY_MARKETS[kind],
  destination: DIRECT_SUPPLY_MARKETS[kind].destination.toLowerCase(),
}))
const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from,address indexed to,uint256 value)',
)
const SUPPLY = parseAbiItem('event Supply(address indexed from,address indexed dst,uint256 amount)')
const TRANSFER_TOPIC = lower(toEventSelector(TRANSFER))
const SUPPLY_TOPIC = lower(toEventSelector(SUPPLY))
const BALANCE = parseAbi(['function balanceOf(address) view returns (uint256)'])
const ZERO = '0x0000000000000000000000000000000000000000'
const SLOT_MS = 15 * 60_000
const WINDOW_MS = 15 * 60_000
const MAX_CANDIDATES = 16
const SCAN_BLOCKS = 4096n
const SPARK_SCAN_WINDOWS = 16
const SPARK_WINDOWS_PER_TICK = 2
const SPARK_HOLDER_CHECKS_PER_TICK = 8
const SPARK_HOLDER_CHECKS_BY_WINDOW = [2, 3, 3]
const SPARK_RECEIPTS_PER_WINDOW = 8
const SPARK_QUOTES_PER_TICK = 2
const SPARK_SCAN_DEADLINE_MS = 25_000
const slotOf = (time) => Math.floor(time / SLOT_MS)
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const withChecksum = (body) => ({ ...body, callerChecksumSha256: hash(body) })

export function scoreDecision(issue, blockTimeMs, now) {
  const target = Date.parse(issue.target_at)
  if (!Number.isFinite(target)) throw new Error('direct_exit_target_invalid')
  if (now < target - WINDOW_MS) return 'wait'
  if (now > target + WINDOW_MS) return 'target_window_missed'
  if (blockTimeMs < target - WINDOW_MS) return 'wait'
  if (blockTimeMs > target + WINDOW_MS) return 'target_block_outside_window'
  return 'probe'
}

function quoteMatches(quote, market, holder, amount, allowInsufficient = false) {
  return (
    quote?.status === 'checked_at_finalized_block' &&
    quote?.source?.chainId === 1 &&
    quote?.market?.kind === market.kind &&
    quote?.market?.identity === 'pinned_market_and_live_underlying' &&
    lower(quote.market.address) === market.destination &&
    lower(quote.market.assetAddress) === lower(market.underlying) &&
    quote.market.assetDecimals === market.decimals &&
    quote.routeKey === market.routeKey &&
    quote.request.assetsRaw === amount &&
    typeof quote.position.suppliedBalanceRaw === 'string' &&
    (allowInsufficient
      ? ['success', 'evm_revert', 'not_holder_exit'].includes(quote.simulation.status)
      : ['success', 'evm_revert'].includes(quote.simulation.status)) &&
    /^0x[0-9a-fA-F]{64}$/.test(quote.source.blockHash) &&
    Number.isSafeInteger(quote.source.blockNumber) &&
    BigInt(quote.position.suppliedBalanceRaw) >= 0n &&
    lower(holder) !== market.destination
  )
}

// Aave/Spark emit aToken Transfers to possible holders, while Comet declares
// Supply(from,dst,amount) in its official ABI. Transfer includes zero-address
// mints and ordinary transfers, both suitable only for holder discovery.
// Events discover candidates only. Current finalized code, balance, market
// identity, and exact withdrawal are always independently checked below.
export async function recentRecipients(
  client,
  market,
  finalizedBlock,
  startOffset = 0n,
  receiptLimit = MAX_CANDIDATES,
  deadline = Infinity,
  receiptPage = 0,
) {
  const event = market.kind === 'compoundV3Usdc' ? SUPPLY : TRANSFER
  const logsFound = []
  const windowEnd = finalizedBlock - startOffset
  const windowStart = windowEnd - SCAN_BLOCKS + 1n
  for (let offset = 0n; offset < SCAN_BLOCKS; offset += 1024n) {
    if (Date.now() >= deadline) throw new Error('candidate_scan_deadline')
    const toBlock = finalizedBlock - startOffset - offset
    if (toBlock <= 0n) break
    const fromBlock = toBlock > 1023n ? toBlock - 1023n : 0n
    const logs = await client.getLogs({
      address: market.destination,
      event,
      fromBlock,
      toBlock,
    })
    logsFound.push(...logs)
  }
  const found = []
  const seen = new Set()
  let receiptChecks = 0
  const ordered = logsFound.sort(
    (a, b) => Number(b.blockNumber - a.blockNumber) || Number(b.logIndex - a.logIndex),
  )
  const pageStart =
    Number.isFinite(receiptLimit) && ordered.length
      ? (((receiptPage * receiptLimit) % ordered.length) + ordered.length) % ordered.length
      : 0
  for (let index = 0; index < ordered.length; index++) {
    const log = ordered[(pageStart + index) % ordered.length]
    const holder = lower(market.kind === 'compoundV3Usdc' ? log.args?.dst : log.args?.to)
    const topic = market.kind === 'compoundV3Usdc' ? SUPPLY_TOPIC : TRANSFER_TOPIC
    if (
      !/^0x[0-9a-f]{40}$/.test(holder) ||
      holder === ZERO ||
      seen.has(holder) ||
      typeof log.blockNumber !== 'bigint' ||
      log.blockNumber < windowStart ||
      log.blockNumber > windowEnd ||
      lower(log.address) !== market.destination ||
      lower(log.topics?.[0]) !== topic ||
      !/^0x[0-9a-fA-F]{64}$/.test(log.blockHash ?? '') ||
      !/^0x[0-9a-fA-F]{64}$/.test(log.transactionHash ?? '') ||
      typeof log.logIndex !== 'number' ||
      typeof log.args?.[market.kind === 'compoundV3Usdc' ? 'amount' : 'value'] !== 'bigint' ||
      log.args[market.kind === 'compoundV3Usdc' ? 'amount' : 'value'] <= 0n
    )
      continue
    if (receiptChecks >= receiptLimit) break
    if (Date.now() >= deadline) throw new Error('candidate_scan_deadline')
    receiptChecks++
    const receipt = await client.getTransactionReceipt({ hash: log.transactionHash })
    if (
      receipt?.status !== 'success' ||
      receipt.blockNumber !== log.blockNumber ||
      lower(receipt.blockHash) !== lower(log.blockHash)
    )
      continue
    const matching = receipt.logs?.find(
      (entry) =>
        entry.logIndex === log.logIndex &&
        lower(entry.address) === market.destination &&
        lower(entry.blockHash) === lower(log.blockHash) &&
        lower(entry.transactionHash) === lower(log.transactionHash) &&
        lower(entry.topics?.[0]) === topic &&
        JSON.stringify(entry.topics) === JSON.stringify(log.topics) &&
        lower(entry.data) === lower(log.data),
    )
    if (!matching) continue
    let decoded
    try {
      decoded = decodeEventLog({
        abi: [event],
        data: matching.data,
        topics: matching.topics,
        strict: true,
      })
    } catch {
      continue
    }
    if (
      lower(market.kind === 'compoundV3Usdc' ? decoded.args.dst : decoded.args.to) !== holder ||
      decoded.args[market.kind === 'compoundV3Usdc' ? 'amount' : 'value'] !==
        log.args[market.kind === 'compoundV3Usdc' ? 'amount' : 'value']
    )
      continue
    seen.add(holder)
    found.push({
      holder,
      event: market.kind === 'compoundV3Usdc' ? 'comet_supply' : 'atoken_transfer_recipient',
      eventBlock: log.blockNumber,
    })
    if (found.length >= MAX_CANDIDATES) break
  }
  if (Date.now() >= deadline) throw new Error('candidate_scan_deadline')
  return found
}

export async function candidateFor(client, market, quoteReader, now = Date.now()) {
  const head = await client.getBlock({ blockTag: 'finalized' })
  if (!head?.hash || typeof head.number !== 'bigint')
    return { unavailableReason: 'quote_unavailable' }
  let hadQuoteError = false
  let foundEventCandidate = false
  const spark = market.kind === 'sparkLendUsdt'
  const deadline = spark ? Date.now() + SPARK_SCAN_DEADLINE_MS : Infinity
  const scanSlot = slotOf(now)
  const rotation = scanSlot % SPARK_SCAN_WINDOWS
  // The current window plus two deterministic older windows cover all 16
  // older windows across eight ticks. At most 12 getLogs, 24 receipts, eight
  // holder checks, and two quotes run in one Spark tick. Old events only find
  // candidates; holder state and the exact withdrawal quote are always live.
  const offsets = spark
    ? [
        0n,
        ...Array.from(
          { length: SPARK_WINDOWS_PER_TICK },
          (_, index) => BigInt(1 + ((rotation + index * 8) % SPARK_SCAN_WINDOWS)) * SCAN_BLOCKS,
        ),
      ]
    : [0n]
  const checkedHolders = new Set()
  let quoteChecks = 0
  for (const [windowIndex, offset] of offsets.entries()) {
    let checkedInWindow = 0
    if (Date.now() >= deadline) return { unavailableReason: 'quote_unavailable' }
    if (spark && checkedHolders.size >= SPARK_HOLDER_CHECKS_PER_TICK) break
    if (spark && quoteChecks >= SPARK_QUOTES_PER_TICK) break
    let recipients
    try {
      recipients = await recentRecipients(
        client,
        market,
        head.number,
        offset,
        spark ? SPARK_RECEIPTS_PER_WINDOW : MAX_CANDIDATES,
        deadline,
        spark ? Math.floor(scanSlot / (windowIndex === 0 ? 1 : 8)) : 0,
      )
    } catch {
      return { unavailableReason: 'quote_unavailable' }
    }
    foundEventCandidate ||= recipients.length > 0
    for (const candidate of recipients) {
      if (checkedHolders.has(candidate.holder)) continue
      if (Date.now() >= deadline) return { unavailableReason: 'quote_unavailable' }
      if (spark && checkedHolders.size >= SPARK_HOLDER_CHECKS_PER_TICK) break
      if (spark && checkedInWindow >= SPARK_HOLDER_CHECKS_BY_WINDOW[windowIndex]) break
      if (spark && quoteChecks >= SPARK_QUOTES_PER_TICK) break
      checkedHolders.add(candidate.holder)
      checkedInWindow++
      try {
        const code = await client.getCode({
          address: candidate.holder,
          blockHash: head.hash,
          requireCanonical: true,
        })
        if (code !== undefined && code !== '0x') continue
        const balance = await client.readContract({
          address: market.destination,
          abi: BALANCE,
          functionName: 'balanceOf',
          args: [candidate.holder],
          blockHash: head.hash,
          requireCanonical: true,
        })
        if (typeof balance !== 'bigint' || balance <= 0n) continue
        const amount = (balance / 10n || 1n).toString()
        quoteChecks++
        const quote = await quoteReader(client, {
          routeKey: market.routeKey,
          destinationAddress: market.destination,
          owner: candidate.holder,
          assetsRaw: amount,
        })
        const sourceTime = Date.parse(quote?.source?.blockTime ?? '')
        if (
          !quoteMatches(quote, market, candidate.holder, amount) ||
          BigInt(quote.position.suppliedBalanceRaw) < BigInt(amount) ||
          BigInt(quote.source.blockNumber) < candidate.eventBlock ||
          !Number.isFinite(sourceTime) ||
          Date.now() - sourceTime < -120_000 ||
          Date.now() - sourceTime > 25 * 60_000
        )
          continue
        return { ...candidate, amount, quote }
      } catch {
        hadQuoteError = true
      }
    }
  }
  return {
    unavailableReason: hadQuoteError
      ? 'quote_unavailable'
      : spark || foundEventCandidate
        ? 'sampled_candidate_exhausted'
        : 'no_recent_event_candidate',
  }
}

function issuePayload(market, candidate, now) {
  const quote = candidate.quote
  const sourceTime = quote ? Date.parse(quote.source.blockTime) : null
  return withChecksum({
    tickSlot: String(slotOf(now)),
    marketKind: market.kind,
    destination: market.destination,
    routeKey: quote ? market.routeKey : null,
    status: quote ? 'issued' : 'unavailable',
    unavailableReason: quote ? null : candidate.unavailableReason,
    candidateEvent: quote ? candidate.event : null,
    candidateEventBlock: quote ? String(candidate.eventBlock) : null,
    holder: quote ? candidate.holder : null,
    assetsRaw: quote ? candidate.amount : null,
    holderBalanceRaw: quote ? quote.position.suppliedBalanceRaw : null,
    sourceBlock: quote ? String(quote.source.blockNumber) : null,
    sourceHash: quote ? lower(quote.source.blockHash) : null,
    sourceBlockAt: quote ? quote.source.blockTime : null,
    sourceObservedAt: quote ? quote.source.observedAt : null,
    issueSimulation: quote ? quote.simulation.status : null,
    targetAt: quote ? new Date(sourceTime + 60 * 60_000).toISOString() : null,
  })
}

async function persistIssue(sql, payload) {
  await sql`INSERT INTO carry_direct_exit_attempts
    (tick_slot,market_kind,destination,route_key,status,unavailable_reason,
     candidate_event,candidate_event_block,holder,assets_raw,holder_balance_raw,
     source_block,source_hash,source_block_at,source_observed_at,issue_simulation,
     target_at,caller_checksum_sha256)
    VALUES (${payload.tickSlot},${payload.marketKind},${payload.destination},
      ${payload.routeKey},${payload.status},${payload.unavailableReason},
      ${payload.candidateEvent},${payload.candidateEventBlock},${payload.holder},
      ${payload.assetsRaw},${payload.holderBalanceRaw},${payload.sourceBlock},
      ${payload.sourceHash},${payload.sourceBlockAt},${payload.sourceObservedAt},
      ${payload.issueSimulation},${payload.targetAt},${payload.callerChecksumSha256})
    ON CONFLICT (tick_slot,market_kind) DO NOTHING`
  const rows = await sql`SELECT caller_checksum_sha256 FROM carry_direct_exit_attempts
    WHERE tick_slot=${payload.tickSlot} AND market_kind=${payload.marketKind}`
  if (rows[0]?.caller_checksum_sha256 !== payload.callerChecksumSha256)
    throw new Error('direct_exit_issue_replay_mismatch')
}

export async function issue(
  sql,
  client,
  now = Date.now(),
  quoteReader = readDirectSupplyExitQuote,
  clock = Date.now,
) {
  const summary = { issued: 0, unavailable: 0, replayed: 0 }
  for (const market of MARKETS) {
    const existing = await sql`SELECT id FROM carry_direct_exit_attempts
      WHERE tick_slot=${String(slotOf(now))} AND market_kind=${market.kind}`
    if (existing.length) {
      summary.replayed++
      continue
    }
    const candidate = await candidateFor(client, market, quoteReader, now)
    const payload = issuePayload(market, candidate, now)
    if (slotOf(clock()) !== slotOf(now)) throw new Error('direct_exit_issue_slot_elapsed')
    await persistIssue(sql, payload)
    summary[payload.status]++
  }
  return summary
}

function outcomePayload(issue, status, reason, quote, now) {
  return withChecksum({
    issueId: String(issue.id),
    tickSlot: String(slotOf(now)),
    marketKind: issue.market_kind,
    routeKey: issue.route_key,
    destination: issue.destination,
    holder: issue.holder,
    assetsRaw: issue.assets_raw,
    status,
    missingReason: reason,
    holderBalanceRaw: quote?.position.suppliedBalanceRaw ?? null,
    sourceBlock: quote ? String(quote.source.blockNumber) : null,
    sourceHash: quote ? lower(quote.source.blockHash) : null,
    sourceBlockAt: quote?.source.blockTime ?? null,
    sourceObservedAt: quote?.source.observedAt ?? null,
  })
}

async function persistOutcome(sql, payload) {
  await sql`INSERT INTO carry_direct_exit_outcomes
    (issue_id,tick_slot,market_kind,route_key,destination,holder,assets_raw,
     status,missing_reason,holder_balance_raw,source_block,source_hash,
     source_block_at,source_observed_at,caller_checksum_sha256)
    VALUES (${payload.issueId},${payload.tickSlot},${payload.marketKind},
      ${payload.routeKey},${payload.destination},${payload.holder},${payload.assetsRaw},
      ${payload.status},${payload.missingReason},${payload.holderBalanceRaw},
      ${payload.sourceBlock},${payload.sourceHash},${payload.sourceBlockAt},
      ${payload.sourceObservedAt},${payload.callerChecksumSha256})
    ON CONFLICT (issue_id) DO NOTHING`
  const rows = await sql`SELECT caller_checksum_sha256 FROM carry_direct_exit_outcomes
    WHERE issue_id=${payload.issueId}`
  if (rows[0]?.caller_checksum_sha256 !== payload.callerChecksumSha256)
    throw new Error('direct_exit_score_replay_mismatch')
}

export async function score(
  sql,
  client,
  now = Date.now(),
  quoteReader = readDirectSupplyExitQuote,
) {
  const rows = await sql`WITH actionable AS (
      SELECT i.*, i.assets_raw::text AS amount, 0 AS priority
      FROM carry_direct_exit_attempts i
      LEFT JOIN carry_direct_exit_outcomes o ON o.issue_id=i.id
      WHERE i.status='issued' AND o.issue_id IS NULL
        AND i.target_at BETWEEN clock_timestamp() - interval '15 minutes'
          AND clock_timestamp() + interval '15 minutes'
      ORDER BY i.target_at, i.id LIMIT 3
    ), backlog AS (
      SELECT i.*, i.assets_raw::text AS amount, 1 AS priority
      FROM carry_direct_exit_attempts i
      LEFT JOIN carry_direct_exit_outcomes o ON o.issue_id=i.id
      WHERE i.status='issued' AND o.issue_id IS NULL
        AND i.target_at < clock_timestamp() - interval '15 minutes'
      ORDER BY i.target_at, i.id LIMIT 3
    ) SELECT * FROM actionable UNION ALL SELECT * FROM backlog
      ORDER BY priority,target_at,id`
  const result = { success: 0, evm_revert: 0, position_insufficient: 0, missing: 0, waiting: 0 }
  for (const row of rows) {
    let decision = scoreDecision(row, Number.NEGATIVE_INFINITY, Date.now())
    if (decision === 'wait') {
      try {
        const block = await client.getBlock({ blockTag: 'finalized' })
        decision = scoreDecision(row, Number(block.timestamp) * 1000, Date.now())
      } catch {
        /* a missing RPC response remains unscored until window close */
      }
    }
    if (decision === 'wait') {
      result.waiting++
      continue
    }
    let quote = null
    if (decision === 'probe') {
      try {
        const market = MARKETS.find((m) => m.kind === row.market_kind)
        if (!market || market.destination !== row.destination || market.routeKey !== row.route_key)
          throw new Error('direct_exit_market_changed')
        quote = await quoteReader(client, {
          routeKey: row.route_key,
          destinationAddress: row.destination,
          owner: row.holder,
          assetsRaw: row.amount,
        })
        if (
          !quoteMatches(quote, market, row.holder, row.amount, true) ||
          BigInt(quote.source.blockNumber) <= BigInt(row.source_block)
        )
          throw new Error('direct_exit_identity_changed')
        decision = scoreDecision(row, Date.parse(quote.source.blockTime), Date.now())
      } catch {
        decision = 'quote_unavailable'
      }
    }
    if (
      decision === 'wait' ||
      (decision !== 'probe' && Date.now() <= Date.parse(row.target_at) + WINDOW_MS)
    ) {
      result.waiting++
      continue
    }
    const status =
      decision !== 'probe'
        ? 'missing'
        : BigInt(quote.position.suppliedBalanceRaw) < BigInt(row.amount)
          ? 'position_insufficient'
          : quote.simulation.status
    if (!['missing', 'position_insufficient', 'success', 'evm_revert'].includes(status))
      throw new Error('direct_exit_score_status_invalid')
    const payload = outcomePayload(
      row,
      status,
      status === 'missing' ? decision : null,
      status === 'missing' ? null : quote,
      Date.now(),
    )
    await persistOutcome(sql, payload)
    result[status]++
  }
  return result
}

export async function audit(sql) {
  const [attempts, outcomes, invalid, scheduled] = await Promise.all([
    sql`SELECT market_kind,status,unavailable_reason,count(*)::integer AS n
      FROM carry_direct_exit_attempts GROUP BY market_kind,status,unavailable_reason`,
    sql`SELECT market_kind,status,missing_reason,count(*)::integer AS n
      FROM carry_direct_exit_outcomes GROUP BY market_kind,status,missing_reason`,
    sql`SELECT count(*)::integer AS n FROM carry_direct_exit_outcomes o
      JOIN carry_direct_exit_attempts i ON i.id=o.issue_id
      WHERE i.status <> 'issued' OR o.market_kind <> i.market_kind
        OR o.route_key <> i.route_key OR o.destination <> i.destination
        OR o.holder <> i.holder OR o.assets_raw <> i.assets_raw
        OR (o.status <> 'missing' AND
          (o.source_block <= i.source_block OR
           o.source_block_at NOT BETWEEN i.target_at - interval '15 minutes'
             AND i.target_at + interval '15 minutes'))`,
    sql`WITH bounds AS (
      SELECT min(tick_slot) AS first_slot,
        floor(extract(epoch FROM clock_timestamp())/900)::bigint - 1 AS last_slot
      FROM carry_direct_exit_attempts
    ), slots AS (
      SELECT generate_series(first_slot,last_slot) AS tick_slot
      FROM bounds WHERE first_slot IS NOT NULL AND last_slot >= first_slot
    ), markets AS (
      SELECT unnest(ARRAY['aaveV3Usdc','sparkLendUsdt','compoundV3Usdc']) AS market_kind
    ) SELECT (SELECT first_slot FROM bounds) AS first_slot,
      (SELECT last_slot FROM bounds) AS last_slot,
      count(*)::bigint AS expected,
      count(*) FILTER (WHERE a.id IS NULL)::bigint AS missing,
      min(s.tick_slot) FILTER (WHERE a.id IS NULL) AS first_missing_slot
      FROM slots s CROSS JOIN markets m
      LEFT JOIN carry_direct_exit_attempts a
        ON a.tick_slot=s.tick_slot AND a.market_kind=m.market_kind`,
  ])
  if (invalid[0].n !== 0) throw new Error('direct_exit_audit_invalid')
  const byRoute = MARKETS.map((market) => ({
    routeKey: market.routeKey,
    market: market.kind,
    attempts: { issued: 0, unavailable: 0 },
    unavailableReasons: {},
    outcomes: { success: 0, evm_revert: 0, position_insufficient: 0, missing: 0 },
    missingReasons: {},
  }))
  const byMarket = new Map(byRoute.map((entry) => [entry.market, entry]))
  const overall = {
    attempts: { issued: 0, unavailable: 0 },
    unavailableReasons: {},
    outcomes: { success: 0, evm_revert: 0, position_insufficient: 0, missing: 0 },
    missingReasons: {},
  }
  for (const row of attempts) {
    const route = byMarket.get(row.market_kind)
    if (!route) throw new Error('direct_exit_audit_market_unknown')
    route.attempts[row.status] += row.n
    overall.attempts[row.status] += row.n
    if (row.status === 'unavailable') {
      route.unavailableReasons[row.unavailable_reason] =
        (route.unavailableReasons[row.unavailable_reason] ?? 0) + row.n
      overall.unavailableReasons[row.unavailable_reason] =
        (overall.unavailableReasons[row.unavailable_reason] ?? 0) + row.n
    }
  }
  for (const row of outcomes) {
    const route = byMarket.get(row.market_kind)
    if (!route) throw new Error('direct_exit_audit_market_unknown')
    route.outcomes[row.status] += row.n
    overall.outcomes[row.status] += row.n
    if (row.status === 'missing') {
      route.missingReasons[row.missing_reason] =
        (route.missingReasons[row.missing_reason] ?? 0) + row.n
      overall.missingReasons[row.missing_reason] =
        (overall.missingReasons[row.missing_reason] ?? 0) + row.n
    }
  }
  return {
    markets: 3,
    attempts: byRoute.flatMap((route) =>
      Object.entries(route.attempts)
        .filter(([, count]) => count > 0)
        .map(([status, count]) => ({ market: route.market, status, count })),
    ),
    outcomes: byRoute.flatMap((route) =>
      Object.entries(route.outcomes)
        .filter(([, count]) => count > 0)
        .map(([status, count]) => ({ market: route.market, status, count })),
    ),
    diagnostics: { overall, byRoute },
    scheduled: {
      firstRecordedSlot: scheduled[0].first_slot,
      lastCompletedSlot: scheduled[0].last_slot,
      expectedAttempts: Number(scheduled[0].expected),
      missingAttempts: Number(scheduled[0].missing),
      firstMissingSlot: scheduled[0].first_missing_slot,
    },
    invalid: 0,
    prospectiveValidated: false,
    futureExitForecast: false,
  }
}

async function main() {
  const mode = process.argv[2]
  if (!['--issue', '--score', '--audit'].includes(mode) || process.argv.length !== 3)
    throw new Error('usage: --issue | --score | --audit')
  const { get } = readEnv()
  const db =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  if (!db) throw new Error('database_url_required')
  const sql = neon(db)
  if (mode === '--audit') return audit(sql)
  const rpc =
    process.env.RECORDER_RPC_URLS ||
    process.env.RECORDER_RPC_URL ||
    get('RECORDER_RPC_URLS') ||
    get('RECORDER_RPC_URL')
  if (!rpc) throw new Error('recorder_rpc_url_required')
  const client = makeClient(rpc)
  return mode === '--issue' ? issue(sql, client) : score(sql, client)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(
        error?.message === 'direct_exit_issue_slot_elapsed'
          ? 'direct_exit_issue_slot_elapsed\n'
          : 'carry_direct_exit_failed\n',
      )
      process.exitCode = 1
    })
}
