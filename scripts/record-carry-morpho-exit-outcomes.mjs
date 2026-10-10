// Prospective exact-holder Morpho VaultV2 measurement; no future exit forecast.
// Run with: node --import tsx scripts/record-carry-morpho-exit-outcomes.mjs --score
// Schedule --score before --issue every 15 minutes. --audit is read-only.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'
import { parseAbi } from 'viem'

import quoteModule from '../lib/carry/morphoExitQuote.ts'
import { loadMorphoFlowSubjects } from './record-carry-morpho-v2-flows.mjs'
import { ROOT, makeClient, readEnv } from './lib/venue-reads.mjs'

const SHARE_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
])
// tsx exposes this TS module as CommonJS to an .mjs entry on this repo's setup.
const { readMorphoExitQuote } = quoteModule
const WINDOW_MS = 15 * 60_000
const SLOT_MS = 15 * 60_000
const MAX_RECENT_CANDIDATES = 4
const MAX_SEED_CANDIDATES = 4
const ADDRESS = /^0x[0-9a-f]{40}$/
const SEED_PATH = join(ROOT, 'scripts/route-cohort/aug-2026-ab-vault-seed.json')
const lower = (value) => String(value).toLowerCase()
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const slotOf = (now) => Math.floor(now / SLOT_MS)

/** Two deterministic issue slots per tick; all 49 vaults rotate in 25 ticks. */
export function issueVaults(subjects, now) {
  if (subjects.length !== 49) throw new Error('exit_subject_count_changed')
  const slot = slotOf(now)
  const start = (slot % 25) * 2
  return subjects.slice(start, start + 2)
}

/** Bounded historical-owner slice changes on each complete 25-slot sweep. */
export function seedCandidateSlice(owners, tickSlot) {
  if (!owners?.length) return []
  const sweep = Math.floor(tickSlot / 25)
  const start = (sweep * MAX_SEED_CANDIDATES) % owners.length
  return Array.from(
    { length: Math.min(MAX_SEED_CANDIDATES, owners.length) },
    (_, i) => owners[(start + i) % owners.length],
  )
}

/** Historical addresses only; all balances, claims, code, and quotes are read afresh. */
export async function loadSeedOwners(subjects, seedPath = SEED_PATH) {
  if (subjects.length !== 49) throw new Error('exit_subject_count_changed')
  const expectedHash = subjects[0].seedSha256
  if (!expectedHash || subjects.some((subject) => subject.seedSha256 !== expectedHash))
    throw new Error('exit_seed_identity_changed')
  const bytes = await readFile(seedPath)
  if (createHash('sha256').update(bytes).digest('hex') !== expectedHash)
    throw new Error('exit_seed_identity_changed')
  const seed = JSON.parse(bytes.toString())
  const vaults = new Set(subjects.map(({ vault }) => vault))
  if (
    seed.schemaVersion !== 1 ||
    seed.cohortId !== subjects[0].cohortId ||
    subjects.some((subject) => subject.cohortId !== seed.cohortId) ||
    !Array.isArray(seed.positions)
  )
    throw new Error('exit_seed_identity_changed')
  const owners = new Map(subjects.map(({ vault }) => [vault, new Set()]))
  let count = 0
  for (const position of seed.positions) {
    if (!vaults.has(position.vault)) continue
    const owner = lower(position.owner)
    if (!ADDRESS.test(owner) || owners.get(position.vault).has(owner))
      throw new Error('exit_seed_identity_changed')
    owners.get(position.vault).add(owner)
    count++
  }
  if (count !== 391 || [...owners.values()].some((entries) => entries.size === 0))
    throw new Error('exit_seed_identity_changed')
  return new Map([...owners].map(([vault, entries]) => [vault, [...entries].sort()]))
}

export function scoreDecision(issue, blockTimeMs, now) {
  const target = Date.parse(issue.target_at)
  if (!Number.isFinite(target)) throw new Error('exit_target_invalid')
  if (now < target - WINDOW_MS) return 'wait'
  if (now > target + WINDOW_MS) return 'target_window_missed'
  if (blockTimeMs < target - WINDOW_MS) return 'wait'
  if (blockTimeMs > target + WINDOW_MS) return 'target_block_outside_window'
  return 'probe'
}

function quoteIdentity(quote, issueLike) {
  return (
    quote.routeKey === issueLike.routeKey &&
    lower(quote.vault.address) === issueLike.vault &&
    lower(quote.request.assetsRaw) === String(issueLike.assetsRaw) &&
    quote.source.chainId === 1 &&
    quote.vault.identity === 'factory_receipt_verified' &&
    ['success', 'evm_revert'].includes(quote.simulation.status)
  )
}

function payloadWithHash(value) {
  // Local replay checksum over caller fields; this is not an independent attestation.
  return { ...value, callerChecksumSha256: digest(value) }
}

async function latestCandidates(sql, vault) {
  // Recent events from one active owner must not hide other candidate holders.
  return sql`SELECT owner, assets_raw::text AS assets_raw FROM (
      SELECT DISTINCT ON (e.owner) e.owner, e.assets_raw, e.event_kind,
        e.block, e.log_index
      FROM carry_morpho_v2_flow_events e
      JOIN carry_morpho_v2_flow_intervals r ON r.vault = e.vault
        AND r.from_block = e.interval_from_block
      WHERE e.vault = ${vault} AND e.assets_raw > 0 AND e.shares_raw > 0
        AND r.first_local_receipt_at >= clock_timestamp() - interval '30 days'
      ORDER BY e.owner, (e.event_kind = 'deposit') DESC, e.block DESC, e.log_index DESC
    ) latest_owner
    ORDER BY (event_kind = 'deposit') DESC, block DESC, log_index DESC
    LIMIT ${MAX_RECENT_CANDIDATES}`
}

async function candidateQuote(
  sql,
  client,
  subject,
  tickSlot,
  seedOwners,
  quoteReader = readMorphoExitQuote,
) {
  const recent = await latestCandidates(sql, subject.vault)
  const seed = seedCandidateSlice(seedOwners.get(subject.vault), tickSlot)
  const candidates = [
    ...recent.map((candidate) => ({ ...candidate, provenance: 'recent_sealed_flow' })),
    ...seed.map((owner) => ({ owner, provenance: 'august_seed_revalidated' })),
  ]
  const seen = new Set()
  let hadQuoteError = false
  for (const candidate of candidates) {
    const holder = lower(candidate.owner)
    if (seen.has(holder) || holder === subject.vault) continue
    seen.add(holder)
    try {
      const block = await client.getBlock({ blockTag: 'finalized' })
      if (!block?.hash || !block?.number) throw new Error('exit_finalized_unavailable')
      const code = await client.getCode({
        address: holder,
        blockHash: block.hash,
        requireCanonical: true,
      })
      if (code !== undefined && code !== '0x') continue
      const shares = await client.readContract({
        address: subject.vault,
        abi: SHARE_ABI,
        functionName: 'balanceOf',
        args: [holder],
        blockHash: block.hash,
        requireCanonical: true,
      })
      if (typeof shares !== 'bigint' || shares <= 0n) continue
      const claim = await client.readContract({
        address: subject.vault,
        abi: SHARE_ABI,
        functionName: 'previewRedeem',
        args: [shares],
        blockHash: block.hash,
        requireCanonical: true,
      })
      if (typeof claim !== 'bigint' || claim <= 0n) continue
      const q =
        candidate.provenance === 'recent_sealed_flow'
          ? (() => {
              const flow = BigInt(candidate.assets_raw)
              return flow < claim ? flow : claim
            })()
          : claim / 10n || 1n
      const assetsRaw = q.toString()
      if (assetsRaw === '0') continue
      const routeKey = subject.routeKeys[0]
      const quote = await quoteReader(client, {
        routeKey,
        destinationAddress: subject.vault,
        owner: holder,
        assetsRaw,
      })
      if (Date.now() - Date.parse(quote.source.blockTime) > 25 * 60_000)
        throw new Error('exit_issue_source_too_old')
      if (
        !quoteIdentity(quote, { routeKey, vault: subject.vault, assetsRaw }) ||
        BigInt(quote.position.sharesRaw) === 0n ||
        BigInt(quote.position.previewRedeemAssetsRaw) < BigInt(assetsRaw)
      )
        continue
      return { holder, assetsRaw, routeKey, quote, candidateProvenance: candidate.provenance }
    } catch {
      hadQuoteError = true
    }
  }
  return {
    unavailableReason: hadQuoteError
      ? 'quote_unavailable'
      : candidates.length
        ? 'sampled_candidate_exhausted'
        : 'no_recent_event_candidate',
  }
}

function issuePayload(subject, candidate, now) {
  const base = {
    tickSlot: String(slotOf(now)),
    vault: subject.vault,
    status: candidate.quote ? 'issued' : 'unavailable',
    unavailableReason: candidate.quote ? null : candidate.unavailableReason,
    candidateProvenance: candidate.candidateProvenance ?? null,
    routeKey: candidate.routeKey ?? null,
    holder: candidate.holder ?? null,
    assetsRaw: candidate.assetsRaw ?? null,
    holderClaimRaw: candidate.quote?.position.previewRedeemAssetsRaw ?? null,
    sourceBlock: candidate.quote ? String(candidate.quote.source.blockNumber) : null,
    sourceHash: candidate.quote ? lower(candidate.quote.source.blockHash) : null,
    sourceBlockAt: candidate.quote?.source.blockTime ?? null,
    sourceObservedAt: candidate.quote?.source.observedAt ?? null,
    issueSimulation: candidate.quote?.simulation.status ?? null,
  }
  return payloadWithHash(base)
}

export async function issue(
  sql,
  client,
  subjects,
  now = Date.now(),
  quoteReader = readMorphoExitQuote,
  seedOwners = null,
) {
  const result = { issued: 0, unavailable: 0, replayed: 0 }
  const sampledSeedOwners = seedOwners ?? (await loadSeedOwners(subjects))
  for (const subject of issueVaults(subjects, now)) {
    if (slotOf(Date.now()) !== slotOf(now)) throw new Error('exit_issue_slot_changed')
    // A replay does not repeat RPC work or change the frozen holder/amount.
    const prior = await sql`SELECT id FROM carry_morpho_exit_attempts
      WHERE vault = ${subject.vault} AND tick_slot = ${slotOf(now)}`
    if (prior.length) {
      result.replayed++
      continue
    }
    const candidate = await candidateQuote(
      sql,
      client,
      subject,
      slotOf(now),
      sampledSeedOwners,
      quoteReader,
    )
    const payload = issuePayload(subject, candidate, now)
    await sql`SELECT carry_morpho_exit_issue(${JSON.stringify(payload)}::jsonb)`
    result[payload.status]++
  }
  return result
}

function outcomePayload(issueRow, status, missingReason, quote, now) {
  return payloadWithHash({
    issueId: String(issueRow.id),
    tickSlot: String(slotOf(now)),
    status,
    missingReason,
    routeKey: issueRow.route_key,
    vault: issueRow.vault,
    holder: issueRow.holder,
    assetsRaw: issueRow.assets_raw,
    holderClaimRaw: quote?.position.previewRedeemAssetsRaw ?? null,
    sourceBlock: quote ? String(quote.source.blockNumber) : null,
    sourceHash: quote ? lower(quote.source.blockHash) : null,
    sourceBlockAt: quote?.source.blockTime ?? null,
    sourceObservedAt: quote?.source.observedAt ?? null,
  })
}

export async function score(sql, client, now = Date.now(), quoteReader = readMorphoExitQuote) {
  // Keep one of three score slots for expired backlog, even with a full live queue.
  const rows = await sql`WITH actionable AS (
      SELECT i.id, i.route_key, i.vault, i.holder, i.assets_raw::text AS assets_raw,
        i.source_block, i.target_at, 0 AS priority
      FROM carry_morpho_exit_attempts i
      LEFT JOIN carry_morpho_exit_outcomes o ON o.issue_id = i.id
      WHERE i.status = 'issued' AND o.issue_id IS NULL
        AND i.target_at BETWEEN clock_timestamp() - interval '15 minutes'
          AND clock_timestamp() + interval '15 minutes'
      ORDER BY i.target_at, i.id LIMIT 2
    ), backlog AS (
      SELECT i.id, i.route_key, i.vault, i.holder, i.assets_raw::text AS assets_raw,
        i.source_block, i.target_at, 1 AS priority
      FROM carry_morpho_exit_attempts i
      LEFT JOIN carry_morpho_exit_outcomes o ON o.issue_id = i.id
      WHERE i.status = 'issued' AND o.issue_id IS NULL
        AND i.target_at < clock_timestamp() - interval '15 minutes'
      ORDER BY i.target_at, i.id LIMIT 1
    ) SELECT * FROM actionable UNION ALL SELECT * FROM backlog
      ORDER BY priority, target_at, id`
  const result = { success: 0, evm_revert: 0, position_insufficient: 0, missing: 0, waiting: 0 }
  for (const row of rows) {
    let decision
    try {
      const block = await client.getBlock({ blockTag: 'finalized' })
      decision = scoreDecision(row, Number(block.timestamp) * 1000, Date.now())
    } catch {
      decision = scoreDecision(row, Number.NEGATIVE_INFINITY, Date.now())
      if (decision === 'wait') {
        result.waiting++
        continue
      }
      decision = 'quote_unavailable'
    }
    if (decision === 'wait') {
      result.waiting++
      continue
    }
    if (
      decision === 'target_block_outside_window' &&
      Date.now() <= Date.parse(row.target_at) + WINDOW_MS
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
          !quoteIdentity(quote, {
            routeKey: row.route_key,
            vault: row.vault,
            assetsRaw: row.assets_raw,
          })
        )
          throw new Error('exit_identity_changed')
        decision = scoreDecision(row, Date.parse(quote.source.blockTime), Date.now())
        if (BigInt(quote.source.blockNumber) <= BigInt(row.source_block))
          decision = 'quote_unavailable'
      } catch {
        if (Date.now() <= Date.parse(row.target_at) + WINDOW_MS) {
          result.waiting++
          continue
        }
        decision = 'quote_unavailable'
      }
    }
    if (decision === 'wait') {
      result.waiting++
      continue
    }
    if (
      decision === 'target_block_outside_window' &&
      Date.now() <= Date.parse(row.target_at) + WINDOW_MS
    ) {
      result.waiting++
      continue
    }
    // A decoded successful withdrawal is stronger evidence than a preview:
    // fee or rounding behavior can make previewRedeem appear smaller than Q.
    const status =
      decision === 'probe'
        ? quote.simulation.status === 'success'
          ? 'success'
          : BigInt(quote.position.previewRedeemAssetsRaw) < BigInt(row.assets_raw)
            ? 'position_insufficient'
            : quote.simulation.status
        : 'missing'
    const payload = outcomePayload(
      row,
      status,
      status === 'missing' ? decision : null,
      status === 'missing' ? null : quote,
      Date.now(),
    )
    await sql`SELECT carry_morpho_exit_score(${JSON.stringify(payload)}::jsonb)`
    result[status]++
  }
  return result
}

export async function audit(sql) {
  const [cohort, attempts, outcomes, routeAttempts, routeOutcomes, invalid, scheduled] =
    await Promise.all([
      sql`SELECT count(*)::integer AS n FROM carry_morpho_v2_flow_subjects`,
      sql`SELECT status,unavailable_reason,count(*)::integer AS n
      FROM carry_morpho_exit_attempts GROUP BY status,unavailable_reason`,
      sql`SELECT status,missing_reason,count(*)::integer AS n
      FROM carry_morpho_exit_outcomes GROUP BY status,missing_reason`,
      // Unavailable attempts have no route_key by schema. Keep them only in
      // overall counts rather than assigning one attempt to multiple routes.
      sql`SELECT route.route_key,i.status,i.unavailable_reason,count(i.id)::integer AS n
      FROM carry_morpho_v2_flow_subjects s
      CROSS JOIN LATERAL jsonb_array_elements_text(s.route_keys) AS route(route_key)
      LEFT JOIN carry_morpho_exit_attempts i ON i.vault=s.vault
        AND i.route_key=route.route_key
      GROUP BY route.route_key,i.status,i.unavailable_reason`,
      sql`WITH routes AS (
        SELECT DISTINCT route.route_key
        FROM carry_morpho_v2_flow_subjects s
        CROSS JOIN LATERAL jsonb_array_elements_text(s.route_keys) AS route(route_key)
      ) SELECT r.route_key,o.status,o.missing_reason,count(o.issue_id)::integer AS n
      FROM routes r LEFT JOIN carry_morpho_exit_outcomes o ON o.route_key=r.route_key
      GROUP BY r.route_key,o.status,o.missing_reason`,
      sql`SELECT count(*)::integer AS n FROM carry_morpho_exit_outcomes o
      JOIN carry_morpho_exit_attempts i ON i.id = o.issue_id
      WHERE i.status <> 'issued' OR o.route_key <> i.route_key OR o.vault <> i.vault
        OR o.holder <> i.holder OR o.assets_raw <> i.assets_raw
        OR (o.status <> 'missing' AND (o.source_block <= i.source_block
          OR o.source_block_at NOT BETWEEN i.target_at - interval '15 minutes'
            AND i.target_at + interval '15 minutes'
          OR o.recorded_at > i.target_at + interval '15 minutes'))`,
      sql`WITH bounds AS (
        SELECT min(tick_slot) AS first_slot,
          floor(extract(epoch FROM clock_timestamp()) / 900)::bigint - 1 AS last_slot
        FROM carry_morpho_exit_attempts
      ), slots AS (
        SELECT generate_series(first_slot, last_slot) AS tick_slot
        FROM bounds WHERE first_slot IS NOT NULL AND last_slot >= first_slot
      ), ranked AS (
        SELECT vault, row_number() OVER (ORDER BY vault) - 1 AS vault_index
        FROM carry_morpho_v2_flow_subjects
      )
      SELECT (SELECT first_slot FROM bounds) AS first_slot,
        (SELECT last_slot FROM bounds) AS last_slot,
        count(r.vault)::bigint AS expected,
        count(r.vault) FILTER (WHERE a.id IS NULL)::bigint AS missing,
        min(s.tick_slot) FILTER (WHERE r.vault IS NOT NULL AND a.id IS NULL)
          AS first_missing_slot
      FROM slots s
      JOIN ranked r ON r.vault_index IN ((s.tick_slot % 25) * 2,
        (s.tick_slot % 25) * 2 + 1)
      LEFT JOIN carry_morpho_exit_attempts a ON a.vault = r.vault
        AND a.tick_slot = s.tick_slot`,
    ])
  if (cohort[0].n !== 49 || invalid[0].n !== 0) throw new Error('exit_audit_invalid')
  const emptyCounts = () => ({
    attempts: { issued: 0, unavailable: 0 },
    unavailableReasons: {},
    outcomes: { success: 0, evm_revert: 0, position_insufficient: 0, missing: 0 },
    missingReasons: {},
  })
  const overall = emptyCounts()
  const byRoute = new Map()
  for (const row of routeAttempts) {
    const route = byRoute.get(row.route_key) ?? { routeKey: row.route_key, ...emptyCounts() }
    byRoute.set(row.route_key, route)
    if (row.status === null || row.n === 0) continue
    route.attempts[row.status] += row.n
    if (row.status === 'unavailable')
      route.unavailableReasons[row.unavailable_reason] =
        (route.unavailableReasons[row.unavailable_reason] ?? 0) + row.n
  }
  for (const row of routeOutcomes) {
    const route = byRoute.get(row.route_key)
    if (!route) throw new Error('exit_audit_route_unknown')
    if (row.status === null || row.n === 0) continue
    route.outcomes[row.status] += row.n
    if (row.status === 'missing')
      route.missingReasons[row.missing_reason] =
        (route.missingReasons[row.missing_reason] ?? 0) + row.n
  }
  for (const row of attempts) {
    overall.attempts[row.status] += row.n
    if (row.status === 'unavailable')
      overall.unavailableReasons[row.unavailable_reason] =
        (overall.unavailableReasons[row.unavailable_reason] ?? 0) + row.n
  }
  for (const row of outcomes) {
    overall.outcomes[row.status] += row.n
    if (row.status === 'missing')
      overall.missingReasons[row.missing_reason] =
        (overall.missingReasons[row.missing_reason] ?? 0) + row.n
  }
  return {
    cohort: cohort[0].n,
    attempts: Object.fromEntries(Object.entries(overall.attempts).filter(([, n]) => n > 0)),
    outcomes: Object.fromEntries(Object.entries(overall.outcomes).filter(([, n]) => n > 0)),
    diagnostics: {
      overall,
      byRoute: [...byRoute.values()].sort((a, b) => a.routeKey.localeCompare(b.routeKey)),
      unavailableRouteAttribution: 'unattributed_no_route_key',
    },
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
  return mode === '--issue'
    ? issue(sql, client, await loadMorphoFlowSubjects())
    : score(sql, client)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((summary) => process.stdout.write(`${JSON.stringify(summary)}\n`))
    .catch(() => {
      process.stderr.write('carry_morpho_exit_failed\n')
      process.exitCode = 1
    })
}
