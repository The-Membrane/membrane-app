// Prospective exact-holder Sky Savings sUSDS withdrawal labels. No forecast.
// Run --score before --issue every 15 minutes; --audit is read-only.
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'
import { decodeEventLog, parseAbi, parseAbiItem } from 'viem'

import quoteModule from '../lib/carry/susdsExitQuote.ts'
import { makeClient, readEnv } from './lib/venue-reads.mjs'

const { readSusdsExitQuote, SUSDS_ROUTE_KEY, SUSDS_VAULT } = quoteModule
const SHARE_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
])
const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)
const WINDOW_MS = 15 * 60_000
const SLOT_MS = 15 * 60_000
const LOOKBACK_BLOCKS = 2_048n
const RANGE_BLOCKS = 256n
const MAX_CANDIDATES = 12
const MAX_SCANNED_RECIPIENTS = 80
const lower = (value) => String(value).toLowerCase()
const same = (a, b) => lower(a) === lower(b)
const slotOf = (now) => Math.floor(now / SLOT_MS)
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const withChecksum = (value) => ({ ...value, callerChecksumSha256: digest(value) })

export function scoreDecision(issue, blockTimeMs, now) {
  const target = Date.parse(issue.target_at)
  if (!Number.isFinite(target)) throw new Error('susds_exit_target_invalid')
  if (now > target + WINDOW_MS) return 'target_window_missed'
  if (now < target - WINDOW_MS || blockTimeMs < target - WINDOW_MS) return 'wait'
  if (blockTimeMs > target + WINDOW_MS) return 'target_block_outside_window'
  return 'probe'
}

function quoteIdentity(quote, holder, q) {
  return (
    quote?.status === 'checked_at_finalized_block' &&
    quote.routeKey === SUSDS_ROUTE_KEY &&
    same(quote.vault?.address, SUSDS_VAULT) &&
    quote.vault?.identity === 'pinned_vault_and_live_asset' &&
    quote.source?.chainId === 1 &&
    quote.request?.assetsRaw === String(q) &&
    ['success', 'evm_revert', 'position_insufficient'].includes(quote.simulation?.status) &&
    /^0x[0-9a-f]{40}$/.test(lower(holder))
  )
}

export function receiptProvesTransfer(log, receipt) {
  if (
    !log?.transactionHash ||
    !Number.isInteger(log.logIndex) ||
    !receipt ||
    receipt.status !== 'success' ||
    !same(receipt.transactionHash, log.transactionHash) ||
    receipt.blockNumber !== log.blockNumber ||
    !same(receipt.blockHash, log.blockHash)
  )
    return false
  const exact = receipt.logs?.find((entry) => entry.logIndex === log.logIndex)
  if (
    !exact ||
    !same(exact.address, SUSDS_VAULT) ||
    !same(exact.transactionHash, log.transactionHash) ||
    !same(exact.blockHash, log.blockHash) ||
    exact.blockNumber !== log.blockNumber ||
    !same(exact.data, log.data) ||
    exact.topics?.length !== log.topics?.length ||
    exact.topics.some((topic, index) => !same(topic, log.topics[index]))
  )
    return false
  try {
    const decoded = decodeEventLog({
      abi: [TRANSFER],
      data: exact.data,
      topics: exact.topics,
      strict: true,
    })
    return (
      decoded.eventName === 'Transfer' &&
      same(decoded.args.to, log.args?.to) &&
      decoded.args.value === log.args?.value &&
      decoded.args.value > 0n
    )
  } catch {
    return false
  }
}

/** Bounded finalized lookback. Candidate discovery is never an exit outcome. */
export async function discoverTransferCandidates(client, head) {
  const found = []
  const seen = new Set()
  const floor = head.number > LOOKBACK_BLOCKS ? head.number - LOOKBACK_BLOCKS + 1n : 0n
  for (
    let end = head.number;
    end >= floor && found.length < MAX_CANDIDATES && seen.size < MAX_SCANNED_RECIPIENTS;
  ) {
    const start = end - RANGE_BLOCKS + 1n > floor ? end - RANGE_BLOCKS + 1n : floor
    const logs = await client.getLogs({
      address: SUSDS_VAULT,
      event: TRANSFER,
      fromBlock: start,
      toBlock: end,
    })
    for (const log of logs.slice().reverse()) {
      const holder = lower(log.args?.to)
      if (
        !/^0x[0-9a-f]{40}$/.test(holder) ||
        holder === '0x0000000000000000000000000000000000000000' ||
        holder === lower(SUSDS_VAULT) ||
        seen.has(holder) ||
        typeof log.args?.value !== 'bigint' ||
        log.args.value <= 0n
      )
        continue
      seen.add(holder)
      const code = await client.getCode({
        address: holder,
        blockHash: head.hash,
        requireCanonical: true,
      })
      if (code !== undefined && code !== '0x') continue
      found.push({ holder, log })
      if (found.length === MAX_CANDIDATES || seen.size === MAX_SCANNED_RECIPIENTS) break
    }
    if (start === floor) break
    end = start - 1n
  }
  return found
}

async function issueCandidate(client, now, quoteReader) {
  let head
  try {
    head = await client.getBlock({ blockTag: 'finalized' })
    if (!head?.hash || !head?.number) throw new Error('susds_exit_finalized_unavailable')
    const candidates = await discoverTransferCandidates(client, head)
    if (!candidates.length) return { unavailableReason: 'no_transfer_candidate' }
    let hadError = false
    // Rotate order across slots so active addresses do not monopolize labels.
    const pivot = slotOf(now) % candidates.length
    for (const { holder, log } of [...candidates.slice(pivot), ...candidates.slice(0, pivot)]) {
      try {
        const receipt = await client.getTransactionReceipt({ hash: log.transactionHash })
        if (!receiptProvesTransfer(log, receipt)) {
          hadError = true
          continue
        }
        const pinned = { blockHash: head.hash, requireCanonical: true }
        const code = await client.getCode({ address: holder, ...pinned })
        if (code !== undefined && code !== '0x') continue
        const [shares, claim] = await Promise.all([
          client.readContract({
            address: SUSDS_VAULT,
            abi: SHARE_ABI,
            functionName: 'balanceOf',
            args: [holder],
            ...pinned,
          }),
          client.readContract({
            address: SUSDS_VAULT,
            abi: SHARE_ABI,
            functionName: 'maxWithdraw',
            args: [holder],
            ...pinned,
          }),
        ])
        if (typeof shares !== 'bigint' || shares <= 0n || typeof claim !== 'bigint' || claim <= 0n)
          continue
        const assetsRaw = String(claim / 10n || 1n)
        const quote = await quoteReader(client, {
          routeKey: SUSDS_ROUTE_KEY,
          destinationAddress: SUSDS_VAULT,
          owner: holder,
          assetsRaw,
        })
        if (
          !quoteIdentity(quote, holder, assetsRaw) ||
          !['success', 'evm_revert'].includes(quote.simulation.status) ||
          BigInt(quote.position.balanceSharesRaw) <= 0n ||
          BigInt(quote.position.maxWithdrawAssetsRaw) < BigInt(assetsRaw) ||
          Date.now() - Date.parse(quote.source.blockTime) > 25 * 60_000 ||
          BigInt(quote.source.blockNumber) < log.blockNumber
        ) {
          hadError = true
          continue
        }
        return {
          holder,
          assetsRaw,
          quote,
          transfer: {
            txHash: lower(log.transactionHash),
            logIndex: log.logIndex,
            block: String(log.blockNumber),
            blockHash: lower(log.blockHash),
          },
        }
      } catch {
        hadError = true
      }
    }
    return {
      unavailableReason: hadError ? 'candidate_check_unavailable' : 'sampled_candidate_exhausted',
    }
  } catch {
    return { unavailableReason: 'discovery_unavailable' }
  }
}

function issuePayload(candidate, now) {
  const issued = Boolean(candidate.quote)
  return withChecksum({
    tickSlot: String(slotOf(now)),
    vault: lower(SUSDS_VAULT),
    status: issued ? 'issued' : 'unavailable',
    unavailableReason: issued ? null : candidate.unavailableReason,
    routeKey: issued ? SUSDS_ROUTE_KEY : null,
    holder: candidate.holder ?? null,
    assetsRaw: candidate.assetsRaw ?? null,
    holderClaimRaw: candidate.quote?.position.maxWithdrawAssetsRaw ?? null,
    sourceBlock: candidate.quote ? String(candidate.quote.source.blockNumber) : null,
    sourceHash: candidate.quote ? lower(candidate.quote.source.blockHash) : null,
    sourceBlockAt: candidate.quote?.source.blockTime ?? null,
    sourceObservedAt: candidate.quote?.source.observedAt ?? null,
    issueSimulation: candidate.quote?.simulation.status ?? null,
    transferTxHash: candidate.transfer?.txHash ?? null,
    transferLogIndex: candidate.transfer?.logIndex ?? null,
    transferBlock: candidate.transfer?.block ?? null,
    transferBlockHash: candidate.transfer?.blockHash ?? null,
  })
}

export async function issue(sql, client, now = Date.now(), quoteReader = readSusdsExitQuote) {
  const prior = await sql`SELECT id FROM carry_susds_exit_attempts
    WHERE vault = ${lower(SUSDS_VAULT)} AND tick_slot = ${slotOf(now)}`
  if (prior.length) return { issued: 0, unavailable: 0, replayed: 1 }
  if (slotOf(Date.now()) !== slotOf(now)) throw new Error('susds_exit_issue_slot_changed')
  const candidate = await issueCandidate(client, now, quoteReader)
  const payload = issuePayload(candidate, now)
  await sql`SELECT carry_susds_exit_issue(${JSON.stringify(payload)}::jsonb)`
  return { issued: candidate.quote ? 1 : 0, unavailable: candidate.quote ? 0 : 1, replayed: 0 }
}

function outcomePayload(row, status, missingReason, quote, now) {
  return withChecksum({
    issueId: String(row.id),
    tickSlot: String(slotOf(now)),
    routeKey: row.route_key,
    vault: row.vault,
    holder: row.holder,
    assetsRaw: row.assets_raw,
    status,
    missingReason,
    holderClaimRaw: quote?.position.maxWithdrawAssetsRaw ?? null,
    holderSharesRaw: quote?.position.balanceSharesRaw ?? null,
    previewSharesRaw: quote?.position.previewSharesRaw ?? null,
    sharesBurnedRaw:
      quote?.simulation.status === 'success' ? quote.simulation.sharesBurnedRaw : null,
    sourceBlock: quote ? String(quote.source.blockNumber) : null,
    sourceHash: quote ? lower(quote.source.blockHash) : null,
    sourceBlockAt: quote?.source.blockTime ?? null,
    sourceObservedAt: quote?.source.observedAt ?? null,
  })
}

export async function score(sql, client, now = Date.now(), quoteReader = readSusdsExitQuote) {
  const rows = await sql`WITH actionable AS (
      SELECT i.id, i.route_key, i.vault, i.holder, i.assets_raw::text AS assets_raw,
        i.source_block, i.target_at, 0 AS priority
      FROM carry_susds_exit_attempts i
      LEFT JOIN carry_susds_exit_outcomes o ON o.issue_id = i.id
      WHERE i.status = 'issued' AND o.issue_id IS NULL
        AND i.target_at BETWEEN clock_timestamp() - interval '15 minutes'
          AND clock_timestamp() + interval '15 minutes'
      ORDER BY i.target_at, i.id LIMIT 1
    ), backlog AS (
      SELECT i.id, i.route_key, i.vault, i.holder, i.assets_raw::text AS assets_raw,
        i.source_block, i.target_at, 1 AS priority
      FROM carry_susds_exit_attempts i
      LEFT JOIN carry_susds_exit_outcomes o ON o.issue_id = i.id
      WHERE i.status = 'issued' AND o.issue_id IS NULL
        AND i.target_at < clock_timestamp() - interval '15 minutes'
      ORDER BY i.target_at, i.id LIMIT 1
    ) SELECT * FROM actionable UNION ALL SELECT * FROM backlog
      ORDER BY priority, target_at, id`
  const result = { success: 0, evm_revert: 0, position_insufficient: 0, missing: 0, waiting: 0 }
  for (const row of rows) {
    let decision
    try {
      const head = await client.getBlock({ blockTag: 'finalized' })
      decision = scoreDecision(row, Number(head.timestamp) * 1000, Date.now())
    } catch {
      decision = scoreDecision(row, Number.NEGATIVE_INFINITY, Date.now())
      if (decision === 'wait') {
        result.waiting++
        continue
      }
      decision = 'quote_unavailable'
    }
    if (
      decision === 'wait' ||
      (decision === 'target_block_outside_window' &&
        Date.now() <= Date.parse(row.target_at) + WINDOW_MS)
    ) {
      result.waiting++
      continue
    }
    let quote = null
    if (decision === 'probe') {
      try {
        quote = await quoteReader(client, {
          routeKey: row.route_key,
          destinationAddress: row.vault,
          owner: row.holder,
          assetsRaw: row.assets_raw,
        })
        if (
          !quoteIdentity(quote, row.holder, row.assets_raw) ||
          BigInt(quote.source.blockNumber) <= BigInt(row.source_block)
        )
          throw new Error('susds_exit_score_identity_changed')
        const sharesCover =
          BigInt(quote.position.balanceSharesRaw) >= BigInt(quote.position.previewSharesRaw)
        const burned =
          quote.simulation.status === 'success' ? BigInt(quote.simulation.sharesBurnedRaw) : null
        if (
          BigInt(quote.position.previewSharesRaw) <= 0n ||
          (quote.simulation.status === 'position_insufficient' && sharesCover) ||
          (quote.simulation.status === 'evm_revert' && !sharesCover) ||
          (quote.simulation.status === 'success' &&
            (burned <= 0n || burned > BigInt(quote.position.balanceSharesRaw)))
        )
          throw new Error('susds_exit_position_diagnostic_conflict')
        decision = scoreDecision(row, Date.parse(quote.source.blockTime), Date.now())
      } catch {
        if (Date.now() <= Date.parse(row.target_at) + WINDOW_MS) {
          result.waiting++
          continue
        }
        decision = 'quote_unavailable'
      }
    }
    if (
      decision === 'wait' ||
      (decision === 'target_block_outside_window' &&
        Date.now() <= Date.parse(row.target_at) + WINDOW_MS)
    ) {
      result.waiting++
      continue
    }
    const status = decision === 'probe' ? quote.simulation.status : 'missing'
    const payload = outcomePayload(
      row,
      status,
      status === 'missing' ? decision : null,
      status === 'missing' ? null : quote,
      Date.now(),
    )
    await sql`SELECT carry_susds_exit_score(${JSON.stringify(payload)}::jsonb)`
    result[status]++
  }
  return result
}

export async function audit(sql) {
  const [attempts, outcomes, invalid, scheduled] = await Promise.all([
    sql`SELECT status, count(*)::integer AS n FROM carry_susds_exit_attempts GROUP BY status`,
    sql`SELECT status, count(*)::integer AS n FROM carry_susds_exit_outcomes GROUP BY status`,
    sql`SELECT count(*)::integer AS n FROM carry_susds_exit_outcomes o
      JOIN carry_susds_exit_attempts i ON i.id = o.issue_id
      WHERE i.status <> 'issued' OR o.route_key <> i.route_key OR
        o.vault <> i.vault OR o.holder <> i.holder OR o.assets_raw <> i.assets_raw OR
        (o.status <> 'missing' AND (o.preview_shares_raw <= 0 OR
          (o.status = 'success' AND
            (o.shares_burned_raw <= 0 OR o.shares_burned_raw > o.holder_shares_raw)) OR
          (o.status = 'position_insufficient' AND
            o.holder_shares_raw >= o.preview_shares_raw) OR
          (o.status = 'evm_revert' AND
            o.holder_shares_raw < o.preview_shares_raw) OR
          o.source_block <= i.source_block OR
          o.source_block_at NOT BETWEEN i.target_at - interval '15 minutes' AND
            i.target_at + interval '15 minutes' OR
          o.recorded_at > i.target_at + interval '15 minutes'))`,
    sql`WITH bounds AS (
        SELECT min(tick_slot) AS first_slot,
          floor(extract(epoch FROM clock_timestamp()) / 900)::bigint - 1 AS last_slot
        FROM carry_susds_exit_attempts
      ), slots AS (
        SELECT generate_series(first_slot, last_slot) AS tick_slot
        FROM bounds WHERE first_slot IS NOT NULL AND last_slot >= first_slot
      ) SELECT (SELECT first_slot FROM bounds) AS first_slot,
        (SELECT last_slot FROM bounds) AS last_slot,
        count(s.tick_slot)::bigint AS expected,
        count(s.tick_slot) FILTER (WHERE a.id IS NULL)::bigint AS missing,
        min(s.tick_slot) FILTER (WHERE a.id IS NULL) AS first_missing_slot
      FROM slots s LEFT JOIN carry_susds_exit_attempts a
        ON a.tick_slot = s.tick_slot AND a.vault = ${lower(SUSDS_VAULT)}`,
  ])
  if (Number(invalid[0].n) !== 0) throw new Error('susds_exit_audit_invalid')
  return {
    routeKey: SUSDS_ROUTE_KEY,
    vault: SUSDS_VAULT,
    attempts: Object.fromEntries(attempts.map((r) => [r.status, r.n])),
    outcomes: Object.fromEntries(outcomes.map((r) => [r.status, r.n])),
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
    .then((summary) => process.stdout.write(`${JSON.stringify(summary)}\n`))
    .catch(() => {
      process.stderr.write('carry_susds_exit_failed\n')
      process.exitCode = 1
    })
}
