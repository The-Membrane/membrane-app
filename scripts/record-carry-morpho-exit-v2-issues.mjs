// Prospective Morpho VaultV2 exit-ability baselines. One frozen route per tick.
// The separate observer must witness each committed batch before its H1 target.
import { createHash } from 'node:crypto'
import { open, mkdir, stat, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { neon } from '@neondatabase/serverless'

import { ROOT, readEnv } from './lib/venue-reads.mjs'
import {
  CARRY_EXIT_V2_FROZEN_ROUTES,
  validateCarryExitV2RpcProof,
} from './lib/carry-exit-v2-rpc-proof.mjs'
import {
  captureFreshMorphoBaseline,
  discoverMorphoIssuerCandidate,
} from './lib/carry-exit-v2-morpho-issuer-prep.mjs'
import { collectCarryExitV2RpcProof } from './lib/carry-exit-v2-rpc-collector.mjs'
import { verifyCarryExitV2IndependentReplay } from './lib/carry-exit-v2-independent-replay.mjs'
import { assembleCarryExitV2CallEvidence } from './lib/carry-exit-v2-proof-assembly.mjs'
import {
  appendLocalCarryExitV2IssuerAttempt,
  appendLocalCarryExitV2IssuerIssues,
  recoverLocalCarryExitV2IssuedSlot,
} from './lib/localCarryExitV2Issuer.mjs'
import { loadMorphoFlowSubjects } from './record-carry-morpho-v2-flows.mjs'

const SLOT_MS = 15 * 60_000
const TICK_BUDGET_MS = 4 * 60_000
const RPC_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 1_000_000
const MAX_URLS = 8
const PRIOR_RECOVERY_LIMIT = 4
const MAX_PRIOR_RECOVERY_LIMIT = 8
const RECOVERY_SOURCE_SCHEMA = {
  morpho: 'carry_exit_v2_morpho_candidate_v1',
  direct: 'carry_exit_v2_direct_candidate_v1',
  sync_vault: 'carry_exit_v2_sync_vault_candidate_v1',
}
const ATTEMPTS_PATH = join(ROOT, 'lib/carry/research/carry-exit-v2-issue-attempts.jsonl')
const LOCK_PATH = join(ROOT, 'lib/carry/research/carry-exit-v2-issue.lock')

function origin(url) {
  const parsed = new URL(url)
  if (
    !['https:', 'http:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  )
    throw Error('invalid_rpc_url')
  return `${parsed.protocol}//${parsed.host}`
}

export function configuredRpcUrls(value) {
  const urls = String(value ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  if (!urls.length || urls.length > MAX_URLS || new Set(urls).size !== urls.length)
    throw Error('invalid_rpc_urls')
  urls.forEach(origin)
  return urls
}

export function selectedMorphoRoute(subjects, nowMs) {
  if (subjects.length !== 49) throw Error('morpho_subject_count_changed')
  const manifestRoutes = subjects.flatMap(({ vault, asset, routeKeys }) =>
    routeKeys.map((routeKey) => ({ routeKey, destination: vault, asset })),
  )
  const frozenRoutes = CARRY_EXIT_V2_FROZEN_ROUTES.filter((route) => route.kind === 'morpho')
  if (manifestRoutes.length !== frozenRoutes.length) throw Error('morpho_route_count_changed')
  const frozen = new Set(
    frozenRoutes.map((route) => `${route.routeKey}\u0000${route.destination}\u0000${route.asset}`),
  )
  if (
    manifestRoutes.some(
      (route) => !frozen.has(`${route.routeKey}\u0000${route.destination}\u0000${route.asset}`),
    )
  )
    throw Error('morpho_route_manifest_mismatch')
  const ordered = manifestRoutes.sort((a, b) =>
    `${a.destination}\u0000${a.routeKey}`.localeCompare(`${b.destination}\u0000${b.routeKey}`),
  )
  // The native issue tick runs at :10/:25/:40/:55, not wall-clock quarters.
  const slot = Math.floor((nowMs - 10 * 60_000) / SLOT_MS)
  return { slot, route: ordered[slot % ordered.length], routeCount: ordered.length }
}

/** One immutable transport origin for all baseline, candidate, and quote reads. */
export function rpcTransport(url, fetchImpl = fetch) {
  const provider = origin(url)
  return {
    url,
    provider,
    async send(envelope) {
      const response = await fetchImpl(url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      })
      if (!response.ok) throw Error(`rpc_http_${response.status}`)
      const body = await response.text()
      if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES)
        throw Error('rpc_response_too_large')
      const parsed = JSON.parse(body)
      if (
        parsed?.jsonrpc !== '2.0' ||
        parsed.id !== envelope.id ||
        Object.hasOwn(parsed, 'result') === Object.hasOwn(parsed, 'error')
      )
        throw Error('rpc_response_invalid')
      return parsed
    },
    async request(method, params) {
      const result = await this.send({ jsonrpc: '2.0', id: 1, method, params })
      if (Object.hasOwn(result, 'error')) {
        const error = Error('rpc_response_invalid')
        error.code = result.error?.code
        throw error
      }
      return result.result
    },
  }
}

/** Select a provider with finalized reads and the minimum log-range support. */
export async function selectHealthyOrigin(
  urls,
  route,
  transport = rpcTransport,
  deadlineMs = Date.now() + TICK_BUDGET_MS,
) {
  for (const url of urls) {
    if (Date.now() >= deadlineMs) break
    const client = transport(url)
    try {
      if ((await client.request('eth_chainId', [])) !== '0x1') continue
      const head = await client.request('eth_getBlockByNumber', ['finalized', false])
      const number = BigInt(head.number)
      if (number < 33n) continue
      const logs = await client.request('eth_getLogs', [
        {
          address: route.destination,
          topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'],
          fromBlock: `0x${(number - 32n).toString(16)}`,
          toBlock: `0x${(number - 1n).toString(16)}`,
        },
      ])
      if (Array.isArray(logs)) return client
    } catch {
      /* Provider cannot support this pinned issuance. */
    }
  }
  return null
}

export function caseFromMeasurement(q, assembled, decoded) {
  const basic = {
    assetsRaw: q,
    baselineStatus: 'unavailable',
    coverageKind: null,
    holderCoverageRaw: null,
    requiredCoverageRaw: null,
    actualConsumedRaw: null,
    simulationStatus: null,
    callEvidenceDoc: null,
    callEvidenceSha256: null,
    entitlementMethod: null,
    entitlementEvidenceDoc: null,
    entitlementEvidenceSha256: null,
    inconclusiveReason: null,
    unavailableReason: 'quote_unavailable',
  }
  if (!assembled || decoded?.routeKind !== 'morpho') return basic
  if (
    decoded.simulationStatus === 'evm_revert' &&
    !decoded.coveredRevert &&
    BigInt(decoded.holderCoverageRaw) > 0n &&
    BigInt(decoded.requiredCoverageRaw) < BigInt(q)
  ) {
    return {
      ...basic,
      baselineStatus: 'ineligible',
      coverageKind: 'morpho_shares_claim',
      holderCoverageRaw: decoded.holderCoverageRaw,
      requiredCoverageRaw: decoded.requiredCoverageRaw,
      entitlementMethod: 'morpho_claim_below_q',
      entitlementEvidenceDoc: {
        ...assembled,
        purpose: 'entitlement',
        withdrawRpc: null,
        actualConsumedRaw: null,
        simulationStatus: null,
        entitlementMethod: 'morpho_claim_below_q',
      },
      unavailableReason: null,
    }
  }
  const status =
    decoded.simulationStatus === 'success' && decoded.actualConsumedRaw != null
      ? 'success'
      : decoded.coveredRevert && BigInt(decoded.requiredCoverageRaw) >= BigInt(q)
        ? 'covered_revert'
        : null
  if (!status) return basic
  return {
    ...basic,
    baselineStatus: status,
    coverageKind: 'morpho_shares_claim',
    holderCoverageRaw: decoded.holderCoverageRaw,
    requiredCoverageRaw: decoded.requiredCoverageRaw,
    actualConsumedRaw: status === 'success' ? decoded.actualConsumedRaw : null,
    simulationStatus: decoded.simulationStatus,
    callEvidenceDoc: assembled,
    // The database computes the JSONB canonical digest in the issue query.
    callEvidenceSha256: null,
    unavailableReason: null,
  }
}

export function attemptRecord({
  slot,
  route,
  status,
  reason = null,
  baseline = null,
  candidate = null,
  caseStatuses = [],
  omittedLadder = [],
  batchId = null,
  at = new Date(),
}) {
  return {
    schema: 'carry_exit_v2_issue_attempt_v1',
    slot,
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    at: at.toISOString(),
    status,
    reason,
    baselineEvidenceDoc: baseline?.canonicalityEvidenceDoc ?? null,
    candidateEvidenceSha256: candidate?.digest ?? null,
    // Local file is 0600 and retains the redacted source witness, including
    // non-insertable zero/duplicate Q labels and no-holder discovery details.
    candidateEvidenceDoc: candidate?.evidenceDoc ?? null,
    caseStatuses,
    omittedLadder,
    batchId: batchId == null ? null : String(batchId),
  }
}

export async function appendDurableAttempt(
  record,
  path = ATTEMPTS_PATH,
  appendLocalAttempt = appendLocalCarryExitV2IssuerAttempt,
) {
  await mkdir(dirname(path), { recursive: true })
  const file = await open(path, 'a', 0o600)
  try {
    await file.writeFile(`${JSON.stringify(record)}\n`)
    await file.sync()
  } finally {
    await file.close()
  }
  await appendLocalAttempt('morpho', record)
}

async function withLock(fn, path = LOCK_PATH, nowMs = Date.now()) {
  await mkdir(dirname(path), { recursive: true })
  let handle
  try {
    handle = await open(path, 'wx', 0o600)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const metadata = await stat(path).catch(() => null)
    if (!metadata || nowMs - metadata.mtimeMs < 2 * TICK_BUDGET_MS) return { status: 'locked' }
    await rm(path, { force: true })
    handle = await open(path, 'wx', 0o600)
  }
  try {
    return await fn()
  } finally {
    await handle.close()
    await rm(path, { force: true })
  }
}

/** Auto-commit issue call. The observer witnesses the committed row separately. */
export async function issuePlan(sql, plan) {
  const value = JSON.stringify(plan)
  const rows = await sql`SELECT carry_exit_v2_issue(jsonb_build_object(
    'plan', ${value}::jsonb,
    'planSha256', encode(sha256(convert_to((${value}::jsonb)::text, 'UTF8')), 'hex')
  )) AS batch_id`
  if (!rows?.[0]?.batch_id) throw Error('issue_batch_missing')
  return String(rows[0].batch_id)
}

export async function digestEvidence(sql, doc) {
  const value = JSON.stringify(doc)
  const rows = await sql`SELECT encode(sha256(convert_to(
    (${value}::jsonb)::text, 'UTF8')), 'hex') AS digest`
  const digest = rows?.[0]?.digest
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest))
    throw Error('evidence_digest_unavailable')
  return digest
}

/** The SQL attempt ledger is one durable DB-clock denominator per route/tick. */
export async function recordDatabaseAttempt(sql, route, slot, status, reason, batchId = null) {
  const slotAt = new Date(slot * SLOT_MS + 10 * 60_000).toISOString()
  const rows = await sql`SELECT carry_exit_v2_record_attempt(
    ${route.routeKey}, ${route.destination}, ${route.asset},
    ${status}, ${reason}, ${slotAt}::timestamptz,
    ${batchId}::bigint) AS attempt_id`
  if (!rows?.[0]?.attempt_id) throw Error('issue_attempt_missing')
  return String(rows[0].attempt_id)
}

/** Mark a batch mirrored only after its local exact-Q records have fsynced. */
export async function recordLocalMirrorCheckpoint(sql, route, slot, batchId) {
  const value = String(batchId ?? '')
  if (!/^[1-9][0-9]*$/.test(value)) throw Error('local_mirror_batch_id_invalid')
  const slotAt = new Date(slot * SLOT_MS + 10 * 60_000).toISOString()
  const rows = await sql`SELECT carry_exit_v2_record_local_mirror(
    ${value}::bigint, ${route.routeKey}, ${route.destination}, ${route.asset},
    ${slotAt}::timestamptz) AS mirrored_at`
  if (!rows?.[0]?.mirrored_at) throw Error('local_mirror_checkpoint_missing')
  return rows[0].mirrored_at
}

export async function readCurrentAttempt(sql, route, slot) {
  const slotAt = new Date(slot * SLOT_MS + 10 * 60_000).toISOString()
  const rows = await sql`SELECT id::text AS id, status, reason, batch_id::text AS batch_id
    FROM carry_exit_v2_attempts
    WHERE route_key = ${route.routeKey}
      AND slot_at = ${slotAt}::timestamptz
      AND destination = ${route.destination}
      AND asset = ${route.asset}
    LIMIT 1`
  return rows?.[0] ?? null
}

export async function findIssuedBatch(sql, plan) {
  const value = JSON.stringify(plan)
  const rows = await sql`SELECT id::text AS id FROM carry_exit_v2_batches
    WHERE plan_doc = ${value}::jsonb LIMIT 1`
  return rows?.[0]?.id ?? null
}

export async function findIssuedSlotBatch(sql, route, slot, plan = null) {
  const slotAt = new Date(slot * SLOT_MS + 10 * 60_000).toISOString()
  if (plan) {
    const value = JSON.stringify(plan)
    const rows = await sql`SELECT id::text AS id FROM carry_exit_v2_batches
      WHERE route_key = ${route.routeKey} AND slot_at = ${slotAt}::timestamptz
        AND destination = ${route.destination} AND asset = ${route.asset}
        AND plan_doc = ${value}::jsonb
      LIMIT 1`
    return rows?.[0]?.id ?? null
  }
  const rows = await sql`SELECT id::text AS id FROM carry_exit_v2_batches
    WHERE route_key = ${route.routeKey} AND slot_at = ${slotAt}::timestamptz
      AND destination = ${route.destination} AND asset = ${route.asset}
    LIMIT 1`
  return rows?.[0]?.id ?? null
}

/** Read the authoritative stored JSON plan for local crash recovery. */
export async function findIssuedSlotBatchPlan(sql, route, slot, batchId = null) {
  const slotAt = new Date(slot * SLOT_MS + 10 * 60_000).toISOString()
  const expectedBatchId = batchId == null ? null : String(batchId)
  const rows = await sql`SELECT b.id::text AS id, b.plan_doc, b.plan_sha256,
      b.plan_sha256 = encode(sha256(convert_to(b.plan_doc::text, 'UTF8')), 'hex')
        AS plan_digest_valid,
      b.plan_doc->>'candidateEvidenceSha256' IS NOT DISTINCT FROM encode(sha256(convert_to(
        (b.plan_doc->'candidateEvidenceDoc')::text, 'UTF8')), 'hex')
        AS candidate_digest_valid,
      NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(b.plan_doc->'cases') AS stored(item)
        WHERE (nullif(stored.item->'callEvidenceDoc', 'null'::jsonb) IS NULL
            AND stored.item->>'callEvidenceSha256' IS NOT NULL)
          OR (nullif(stored.item->'callEvidenceDoc', 'null'::jsonb) IS NOT NULL
            AND stored.item->>'callEvidenceSha256' IS DISTINCT FROM encode(sha256(convert_to(
              (stored.item->'callEvidenceDoc')::text, 'UTF8')), 'hex'))
          OR (nullif(stored.item->'entitlementEvidenceDoc', 'null'::jsonb) IS NULL
            AND stored.item->>'entitlementEvidenceSha256' IS NOT NULL)
          OR (nullif(stored.item->'entitlementEvidenceDoc', 'null'::jsonb) IS NOT NULL
            AND stored.item->>'entitlementEvidenceSha256' IS DISTINCT FROM encode(sha256(convert_to(
              (stored.item->'entitlementEvidenceDoc')::text, 'UTF8')), 'hex'))
      ) AS case_digests_valid,
      (
        (SELECT count(*) FROM carry_exit_v2_cases c WHERE c.batch_id = b.id)
          = jsonb_array_length(b.plan_doc->'cases')
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(b.plan_doc->'cases') WITH ORDINALITY expected(item, ord)
          LEFT JOIN carry_exit_v2_cases c
            ON c.batch_id = b.id AND c.case_index = expected.ord
          WHERE c.id IS NULL
            OR c.assets_raw::text IS DISTINCT FROM expected.item->>'assetsRaw'
            OR c.baseline_status IS DISTINCT FROM expected.item->>'baselineStatus'
            OR c.coverage_kind IS DISTINCT FROM expected.item->>'coverageKind'
            OR c.holder_coverage_raw::text IS DISTINCT FROM expected.item->>'holderCoverageRaw'
            OR c.required_coverage_raw::text IS DISTINCT FROM expected.item->>'requiredCoverageRaw'
            OR c.actual_consumed_raw::text IS DISTINCT FROM expected.item->>'actualConsumedRaw'
            OR c.simulation_status IS DISTINCT FROM expected.item->>'simulationStatus'
            OR c.call_evidence_doc IS DISTINCT FROM
              nullif(expected.item->'callEvidenceDoc', 'null'::jsonb)
            OR c.call_evidence_sha256 IS DISTINCT FROM expected.item->>'callEvidenceSha256'
            OR c.entitlement_method IS DISTINCT FROM expected.item->>'entitlementMethod'
            OR c.entitlement_evidence_doc IS DISTINCT FROM
              nullif(expected.item->'entitlementEvidenceDoc', 'null'::jsonb)
            OR c.entitlement_evidence_sha256 IS DISTINCT FROM
              expected.item->>'entitlementEvidenceSha256'
            OR c.inconclusive_reason IS DISTINCT FROM expected.item->>'inconclusiveReason'
            OR c.unavailable_reason IS DISTINCT FROM expected.item->>'unavailableReason'
        )
        AND (SELECT count(*) FROM carry_exit_v2_plans p
          JOIN carry_exit_v2_cases c ON c.id = p.case_id WHERE c.batch_id = b.id)
          = 5 * jsonb_array_length(b.plan_doc->'cases')
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(b.plan_doc->'cases') WITH ORDINALITY expected(item, ord)
          CROSS JOIN unnest(ARRAY[1,4,24,48,168]::smallint[]) AS horizon(horizon_h)
          LEFT JOIN carry_exit_v2_cases c
            ON c.batch_id = b.id AND c.case_index = expected.ord
          LEFT JOIN carry_exit_v2_plans p
            ON p.case_id = c.id AND p.horizon_h = horizon.horizon_h
          WHERE c.id IS NULL OR p.case_id IS NULL
            OR p.predecessor_h IS DISTINCT FROM CASE horizon.horizon_h
              WHEN 1 THEN 0 WHEN 4 THEN 1 WHEN 24 THEN 4 WHEN 48 THEN 24 ELSE 48 END
            OR p.conditional_recovery IS DISTINCT FROM false
            OR p.target_at IS DISTINCT FROM
              b.issued_at + make_interval(hours => horizon.horizon_h)
            OR p.deadline_at IS DISTINCT FROM
              b.issued_at + make_interval(hours => horizon.horizon_h + 2)
        )
      ) AS child_rows_valid
    FROM carry_exit_v2_batches b
    WHERE b.route_key = ${route.routeKey} AND b.slot_at = ${slotAt}::timestamptz
      AND b.destination = ${route.destination} AND b.asset = ${route.asset}
      AND (${expectedBatchId}::bigint IS NULL OR b.id = ${expectedBatchId}::bigint)
    LIMIT 2`
  if (!rows?.length) return null
  if (rows.length !== 1) throw Error('exit_v2_slot_batch_ambiguous')
  return {
    batchId: String(rows[0].id),
    plan: rows[0].plan_doc,
    planSha256: rows[0].plan_sha256,
    digestIntegrity: {
      plan: rows[0].plan_digest_valid,
      candidate: rows[0].candidate_digest_valid,
      cases: rows[0].case_digests_valid,
    },
    childRowsValid: rows[0].child_rows_valid,
  }
}

/** Oldest first so a bounded restart sweep makes deterministic forward progress. */
export async function findOutstandingIssuedBatchRefs(
  sql,
  source,
  beforeSlot,
  limit = PRIOR_RECOVERY_LIMIT,
) {
  const schema = RECOVERY_SOURCE_SCHEMA[source]
  if (!schema) throw Error('exit_v2_recovery_source_invalid')
  if (!Number.isSafeInteger(beforeSlot)) throw Error('exit_v2_recovery_slot_invalid')
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PRIOR_RECOVERY_LIMIT)
    throw Error('exit_v2_recovery_limit_invalid')
  const beforeSlotAt = new Date(beforeSlot * SLOT_MS + 10 * 60_000).toISOString()
  const rows = await sql`SELECT b.id::text AS id, b.route_key, b.destination, b.asset,
      ((extract(epoch FROM b.slot_at) * 1000)::bigint)::text AS slot_ms
    FROM carry_exit_v2_batches b
    LEFT JOIN carry_exit_v2_local_mirrors mirror ON mirror.batch_id = b.id
    WHERE mirror.batch_id IS NULL
      AND b.slot_at < ${beforeSlotAt}::timestamptz
      AND b.plan_doc->'candidateEvidenceDoc'->>'schema' = ${schema}
    ORDER BY b.slot_at ASC, b.id ASC
    LIMIT ${limit}`
  if (!Array.isArray(rows) || rows.length > limit) throw Error('exit_v2_recovery_rows_invalid')
  const ids = new Set()
  return rows.map((row) => {
    const slotMs = Number(row.slot_ms)
    const shifted = slotMs - 10 * 60_000
    const batchId = String(row.id ?? '')
    if (
      !/^[1-9][0-9]*$/.test(batchId) ||
      ids.has(batchId) ||
      typeof row.route_key !== 'string' ||
      !/^0x[0-9a-f]{40}$/.test(row.destination ?? '') ||
      !/^0x[0-9a-f]{40}$/.test(row.asset ?? '') ||
      !Number.isSafeInteger(slotMs) ||
      shifted % SLOT_MS !== 0
    )
      throw Error('exit_v2_recovery_row_invalid')
    const slot = shifted / SLOT_MS
    if (slot >= beforeSlot) throw Error('exit_v2_recovery_row_not_prior')
    ids.add(batchId)
    return {
      batchId,
      slot,
      route: { routeKey: row.route_key, destination: row.destination, asset: row.asset },
    }
  })
}

export async function reconcilePriorLocalIssueMirrors({
  sql,
  source,
  beforeSlot,
  limit = PRIOR_RECOVERY_LIMIT,
  findOutstanding = findOutstandingIssuedBatchRefs,
  loadStoredBatch = findIssuedSlotBatchPlan,
  recordLocalIssues = appendLocalCarryExitV2IssuerIssues,
  appendAttempt,
  makeAttempt,
  recordCheckpoint = recordLocalMirrorCheckpoint,
  now = () => new Date(),
}) {
  if (typeof appendAttempt !== 'function' || typeof makeAttempt !== 'function')
    throw Error('exit_v2_recovery_attempt_writer_required')
  const refs = await findOutstanding(sql, source, beforeSlot, limit)
  const recovered = []
  for (const ref of refs) {
    const at = now()
    const stored = await recoverLocalCarryExitV2IssuedSlot({
      source,
      route: ref.route,
      slotAt: new Date(ref.slot * SLOT_MS + 10 * 60_000).toISOString(),
      loadStoredBatch: () => loadStoredBatch(sql, ref.route, ref.slot, ref.batchId),
      recordLocalIssues,
      recordedAt: at,
    })
    if (!stored || stored.batchId !== ref.batchId) throw Error('exit_v2_recovery_batch_invalid')
    await appendAttempt(
      makeAttempt({
        slot: ref.slot,
        route: ref.route,
        status: 'issued_recovered',
        reason: 'prior_unmirrored_batch_reconciled',
        batchId: ref.batchId,
        at,
      }),
    )
    await recordCheckpoint(sql, ref.route, ref.slot, ref.batchId)
    recovered.push({ batchId: ref.batchId, slot: ref.slot, routeKey: ref.route.routeKey })
  }
  return recovered
}

/** Keep every current-slot recovery durable before sealing its SQL mirror checkpoint. */
export async function finalizeRecoveredCurrentLocalMirror({
  sql,
  route,
  slot,
  recovered,
  existingAttempt = null,
  appendAttempt,
  makeAttempt,
  recordCheckpoint = recordLocalMirrorCheckpoint,
  recordDbAttempt = recordDatabaseAttempt,
}) {
  if (!recovered) return false
  if (typeof appendAttempt !== 'function' || typeof makeAttempt !== 'function')
    throw Error('exit_v2_recovery_attempt_writer_required')
  await appendAttempt(
    makeAttempt({
      slot,
      route,
      status: 'issued_recovered',
      reason: existingAttempt
        ? 'issued_attempt_local_mirror_reconciled'
        : 'orphan_batch_reconciled',
      batchId: recovered.batchId,
    }),
  )
  await recordCheckpoint(sql, route, slot, recovered.batchId)
  if (!existingAttempt) await recordDbAttempt(sql, route, slot, 'issued', null, recovered.batchId)
  return true
}

export function recoverMorphoLocalIssueMirror({
  sql,
  route,
  slot,
  existingAttempt = null,
  loadStoredBatch = (expectedBatchId) => findIssuedSlotBatchPlan(sql, route, slot, expectedBatchId),
  recordLocalIssues = appendLocalCarryExitV2IssuerIssues,
  recordedAt = new Date(),
}) {
  return recoverLocalCarryExitV2IssuedSlot({
    source: 'morpho',
    route,
    slotAt: new Date(slot * SLOT_MS + 10 * 60_000).toISOString(),
    existingAttempt,
    loadStoredBatch,
    recordLocalIssues,
    recordedAt,
  })
}

export async function issueMorphoV2Route({
  sql,
  slot,
  route,
  primary,
  secondary,
  appendAttempt = appendDurableAttempt,
  now = () => new Date(),
  captureBaseline = captureFreshMorphoBaseline,
  discoverCandidate = discoverMorphoIssuerCandidate,
  collect = collectCarryExitV2RpcProof,
  verify = verifyCarryExitV2IndependentReplay,
  assemble = assembleCarryExitV2CallEvidence,
  persist = issuePlan,
  hashEvidence = digestEvidence,
  recordDbAttempt = recordDatabaseAttempt,
  recoverIssuedBatch = findIssuedBatch,
  recoverIssuedSlotBatch = findIssuedSlotBatch,
  recordLocalIssues = appendLocalCarryExitV2IssuerIssues,
}) {
  const slotAt = new Date(slot * SLOT_MS + 10 * 60_000).toISOString()
  const slotEndMs = (slot + 1) * SLOT_MS + 10 * 60_000
  const deadline = Math.min(now().getTime() + TICK_BUDGET_MS, slotEndMs - 30_000)
  const boundedRequest = async (method, params) => {
    if (now().getTime() >= deadline) throw Error('issuer_deadline_elapsed')
    return primary.request(method, params)
  }
  const boundedSend = async (envelope) => {
    if (now().getTime() >= deadline) throw Error('issuer_deadline_elapsed')
    return primary.send(envelope)
  }
  const record = async (status, reason, dbReason, extra = {}) => {
    // Even when the DB is down, retain the denominator and exact reason on
    // the Mac. A DB failure must never be counted as a validated issue.
    await appendAttempt(attemptRecord({ slot, route, status, reason, at: now(), ...extra }))
    await recordDbAttempt(
      sql,
      route,
      slot,
      status === 'issued' ? 'issued' : 'unavailable',
      status === 'issued' ? null : dbReason,
      extra.batchId ?? null,
    )
  }
  if (now().getTime() >= deadline) {
    if (now().getTime() < slotEndMs) {
      try {
        await record('unavailable', 'native_issue_slot_elapsed', 'plan_invalid')
      } catch {
        // The local attempt was already appended; DB absence remains auditable.
      }
    } else
      await appendAttempt(
        attemptRecord({
          slot,
          route,
          status: 'slot_elapsed',
          reason: 'native_issue_slot_elapsed',
          at: now(),
        }),
      )
    return { status: 'slot_elapsed', reason: 'native_issue_slot_elapsed' }
  }
  if (!primary) {
    await record('unavailable', 'primary_rpc_unavailable', 'rpc_unavailable')
    return { status: 'unavailable', reason: 'primary_rpc_unavailable' }
  }
  let baseline, candidate
  let stage = 'baseline'
  try {
    baseline = await captureBaseline({
      ...route,
      provider: primary.provider,
      source: 'carry_exit_v2_issuer',
      request: boundedRequest,
      now,
    })
    stage = 'candidate'
    candidate = await discoverCandidate({ baseline, request: boundedRequest })
  } catch (error) {
    const reason =
      stage === 'candidate' && error?.message === 'candidate_log_throttle_exhausted'
        ? 'candidate_log_throttle_exhausted'
        : `${stage}_unavailable`
    await record('unavailable', reason, `${stage}_unavailable`, { baseline })
    return { status: 'unavailable', reason }
  }
  const ladder = candidate?.evidenceDoc?.ladder?.labels
  if (
    !Array.isArray(ladder) ||
    ladder.length !== 6 ||
    !/^[0-9a-f]{64}$/.test(candidate.digest ?? '') ||
    createHash('sha256').update(JSON.stringify(candidate.evidenceDoc)).digest('hex') !==
      candidate.digest ||
    new Set(ladder.map((entry) => entry.label)).size !== 6 ||
    ladder.some((entry) => entry.assetsRaw !== null && !/^[1-9][0-9]*$/.test(entry.assetsRaw ?? ''))
  ) {
    await record('unavailable', 'candidate_evidence_invalid', 'candidate_unavailable', { baseline })
    return { status: 'unavailable', reason: 'candidate_evidence_invalid' }
  }
  const omittedLadder = ladder
    .filter((entry) => entry.reason)
    .map((entry) => ({
      label: entry.label,
      reason: entry.reason,
      duplicateOf: entry.duplicateOf ?? null,
    }))
  if (!candidate.holder) {
    await record('unavailable', candidate.evidenceDoc.unavailableReason, 'no_eligible_holder', {
      baseline,
      candidate,
      omittedLadder,
    })
    return { status: 'unavailable', reason: candidate.evidenceDoc.unavailableReason }
  }
  const positive = ladder.filter((entry) => entry.assetsRaw != null)
  if (!positive.length) {
    await record('unavailable', 'no_positive_unique_q', 'zero_or_duplicate_q', {
      baseline,
      candidate,
      omittedLadder,
    })
    return { status: 'unavailable', reason: 'no_positive_unique_q' }
  }
  const cases = []
  const caseStatuses = []
  for (const entry of positive) {
    let result = caseFromMeasurement(entry.assetsRaw, null, null)
    if (secondary && now().getTime() < deadline) {
      try {
        const frozen = {
          ...route,
          holder: candidate.holder,
          assetsRaw: entry.assetsRaw,
          blockNumber: baseline.targetBlock,
          blockHash: baseline.targetHash,
        }
        const collected = await collect({
          ...route,
          holder: candidate.holder,
          assetsRaw: entry.assetsRaw,
          target: baseline,
          provider: primary.provider,
          source: 'carry_exit_v2_issuer',
          send: boundedSend,
          now,
        })
        const replay = await verify({
          ...frozen,
          proof: collected.proof,
          identityEvidence: collected.identityEvidence,
          primary: { url: primary.url, request: boundedSend },
          secondary: { url: secondary.url, request: secondary.send.bind(secondary) },
          now,
        })
        if (replay.status === 'verified') {
          const evidence = assemble({ collector: collected, replay, frozen })
          const decoded = validateCarryExitV2RpcProof({ proof: collected.proof, ...frozen })
          result = caseFromMeasurement(entry.assetsRaw, evidence, decoded)
        }
      } catch {
        /* Explicit unavailable Q remains in the frozen plan. */
      }
    }
    cases.push(result)
    caseStatuses.push({
      label: entry.label,
      status: result.baselineStatus,
      reason: result.unavailableReason,
    })
  }
  // Hash JSONB's exact text representation, not JSON.stringify's bytes.
  for (let i = 0; i < cases.length; i++) {
    const evidence = cases[i].callEvidenceDoc ?? cases[i].entitlementEvidenceDoc
    if (!evidence) continue
    try {
      const digest = await hashEvidence(sql, evidence)
      if (cases[i].callEvidenceDoc) cases[i].callEvidenceSha256 = digest
      else cases[i].entitlementEvidenceSha256 = digest
    } catch {
      cases[i] = caseFromMeasurement(cases[i].assetsRaw, null, null)
      caseStatuses[i] = { ...caseStatuses[i], status: 'unavailable', reason: 'quote_unavailable' }
    }
  }
  let candidateEvidenceSha256
  try {
    candidateEvidenceSha256 = await hashEvidence(sql, candidate.evidenceDoc)
  } catch {
    await appendAttempt(
      attemptRecord({
        slot,
        route,
        status: 'issue_unknown',
        reason: 'candidate_digest_unavailable',
        baseline,
        candidate,
        caseStatuses,
        omittedLadder,
        at: now(),
      }),
    )
    return { status: 'issue_unknown', reason: 'candidate_digest_unavailable' }
  }
  const plan = {
    version: 'carry_exit_v2',
    clock: 'db_issued_at',
    endpointSelection: 'first_finalized_at_or_after_target',
    captureDeadlineHours: 2,
    horizons: [1, 4, 24, 48, 168],
    routeKey: route.routeKey,
    slotAt,
    destination: route.destination,
    asset: route.asset,
    assetDecimals: baseline.assetDecimals,
    holder: candidate.holder,
    baselineBlock: baseline.targetBlock,
    baselineHash: baseline.targetHash,
    baselineBlockAt: baseline.targetBlockAt,
    baselineObservedAt: baseline.targetObservedAt,
    candidateProvenance: 'receipt_verified_transfer',
    candidateEvidenceSha256,
    candidateEvidenceDoc: candidate.evidenceDoc,
    canonicalityEvidenceDoc: baseline.canonicalityEvidenceDoc,
    omittedLadder,
    cases,
  }
  let batchId
  try {
    batchId = await persist(sql, plan)
  } catch {
    // An HTTP failure may happen after the DB committed. Never label an
    // unknown commit as unavailable without a fresh DB read.
    try {
      batchId = await recoverIssuedBatch(sql, plan)
    } catch {
      /* Connection state is unknown. */
    }
    if (!batchId) {
      let priorBatchId
      try {
        priorBatchId = await recoverIssuedSlotBatch(sql, route, slot, plan)
      } catch {
        /* Connection state is unknown. */
      }
      if (priorBatchId) {
        await recordLocalIssues({
          source: 'morpho',
          batchId: priorBatchId,
          plan,
          recordedAt: now(),
        })
        await appendAttempt(
          attemptRecord({
            slot,
            route,
            status: 'issued_recovered',
            reason: 'slot_batch_reconciled',
            batchId: priorBatchId,
            at: now(),
          }),
        )
        await recordDbAttempt(sql, route, slot, 'issued', null, priorBatchId)
        return { status: 'issued_recovered', batchId: priorBatchId }
      }
    }
    if (!batchId) {
      await appendAttempt(
        attemptRecord({
          slot,
          route,
          status: 'issue_unknown',
          reason: 'db_commit_unknown',
          baseline,
          candidate,
          caseStatuses,
          omittedLadder,
          at: now(),
        }),
      )
      return { status: 'issue_unknown', reason: 'db_commit_unknown' }
    }
  }
  await recordLocalIssues({ source: 'morpho', batchId, plan, recordedAt: now() })
  await record('issued', null, null, { baseline, candidate, caseStatuses, omittedLadder, batchId })
  return {
    status: 'issued',
    batchId,
    cases: caseStatuses.length,
    unavailableCases: caseStatuses.filter((entry) => entry.status === 'unavailable').length,
    omittedCases: omittedLadder.length,
  }
}

async function main() {
  if (process.argv.length !== 2) throw Error('usage: no arguments')
  const { get } = readEnv()
  const db =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  const rawUrls =
    process.env.RECORDER_RPC_URLS ||
    process.env.RECORDER_RPC_URL ||
    get('RECORDER_RPC_URLS') ||
    get('RECORDER_RPC_URL')
  const verifyUrl =
    process.env.CARRY_EXIT_V2_VERIFY_RPC_URL ||
    get('CARRY_EXIT_V2_VERIFY_RPC_URL') ||
    'https://eth.drpc.org'
  if (!db || !rawUrls) throw Error('recorder_configuration_missing')
  return withLock(async () => {
    const subjects = await loadMorphoFlowSubjects()
    const sql = neon(db)
    const beforeSlot = selectedMorphoRoute(subjects, Date.now()).slot
    await reconcilePriorLocalIssueMirrors({
      sql,
      source: 'morpho',
      beforeSlot,
      appendAttempt: appendDurableAttempt,
      makeAttempt: attemptRecord,
    })
    const { slot, route, routeCount } = selectedMorphoRoute(subjects, Date.now())
    const existing = await readCurrentAttempt(sql, route, slot)
    const recovered = await recoverMorphoLocalIssueMirror({
      sql,
      route,
      slot,
      existingAttempt: existing,
    })
    await finalizeRecoveredCurrentLocalMirror({
      sql,
      route,
      slot,
      recovered,
      existingAttempt: existing,
      appendAttempt: appendDurableAttempt,
      makeAttempt: attemptRecord,
    })
    if (existing)
      return {
        slot,
        routeCount,
        routeKey: route.routeKey,
        status: 'already_recorded',
        recordedStatus: existing.status,
        prospectivelyValidated: false,
        futureExitForecast: false,
      }
    if (recovered) {
      return {
        slot,
        routeCount,
        routeKey: route.routeKey,
        status: 'issued_recovered',
        batchId: recovered.batchId,
        prospectivelyValidated: false,
        futureExitForecast: false,
      }
    }
    const primary = await selectHealthyOrigin(configuredRpcUrls(rawUrls), route)
    const secondary =
      verifyUrl && primary && origin(verifyUrl) !== primary.provider
        ? rpcTransport(verifyUrl)
        : null
    const result = await issueMorphoV2Route({ sql, slot, route, primary, secondary })
    if (result.batchId) await recordLocalMirrorCheckpoint(sql, route, slot, result.batchId)
    return {
      slot,
      routeCount,
      routeKey: route.routeKey,
      ...result,
      prospectivelyValidated: false,
      futureExitForecast: false,
    }
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => {
      process.stderr.write('carry_morpho_exit_v2_issue_failed\n')
      process.exitCode = 1
    })
}
