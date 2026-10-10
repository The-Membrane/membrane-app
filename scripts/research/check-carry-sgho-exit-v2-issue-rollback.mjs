// Public-first, rollback-only integration gate for exact GHO → sGHO.
// It never commits an issue, creates a witness, schedules a job, or scores an outcome.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from '@neondatabase/serverless'

import { apply } from '../apply-carry-exit-v2-ddl.mjs'
import {
  CARRY_EXIT_V2_FROZEN_ROUTES,
  validateCarryExitV2RpcProof,
} from '../lib/carry-exit-v2-rpc-proof.mjs'
import { measureCarryExitV2Verified } from '../lib/carry-exit-v2-verified-measurement.mjs'
import { configuredRpcUrls, rpcTransport } from '../record-carry-morpho-exit-v2-issues.mjs'
import {
  prepareSyncVaultOrigin,
  syncVaultCaseFromMeasurement,
} from '../record-carry-sync-vault-exit-v2-issues.mjs'
import { readEnv } from '../lib/venue-reads.mjs'

const ROLLBACK_SENTINEL = 'carry_sgho_exit_v2_intentional_rollback'
const SECOND_ORIGIN = 'https://eth.drpc.org'
const ROUTE_KEY = 'GHO → sGho [GHO]'
const VAULT = '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d'
const GHO = '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f'
const BUDGET_MS = 10 * 60_000
const OBJECTS_SQL = `SELECT
  (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname LIKE 'carry_exit_v2_%') AS relations,
  (SELECT count(*)::integer FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'carry_exit_v2_%') AS functions`
const DIGEST_SQL = `SELECT encode(sha256(convert_to(($1::jsonb)::text, 'UTF8')), 'hex') AS digest`
const DIAGNOSTICS_SQL = `WITH sample AS MATERIALIZED (SELECT clock_timestamp() AS at),
  input AS (SELECT $1::jsonb AS plan),
  ladder_input AS (SELECT
    (plan->'candidateEvidenceDoc'->'baselineState'->>'totalAssetsRaw')::numeric AS total,
    (plan->'candidateEvidenceDoc'->>'selectedClaimRaw')::numeric AS claim
    FROM input),
  ladder_q AS (SELECT grid.i,
    (ARRAY['holder_half_claim_capped_vault_0p001pct', 'vault_0p001pct',
      'vault_0p01pct', 'vault_0p1pct', 'vault_0p5pct', 'vault_1pct'])[grid.i] AS label,
    (ARRAY[0, 100000, 10000, 1000, 200, 100]::numeric[])[grid.i] AS divisor,
    CASE WHEN grid.i = 1 THEN least(greatest(1, div(claim, 2)),
      greatest(1, div(total, 100000)))
      ELSE div(total, (ARRAY[0, 100000, 10000, 1000, 200, 100]::numeric[])[grid.i])
    END AS q
    FROM ladder_input CROSS JOIN generate_series(1, 6) AS grid(i)),
  ladder_expected AS (SELECT cur.i,
    jsonb_build_object('label', cur.label,
      'basis', CASE WHEN cur.i = 1
        THEN 'selected_holder_claim_raw_and_frozen_vault_total_assets_raw'
        ELSE 'frozen_vault_total_assets_raw' END,
      'fractionDenominator', CASE WHEN cur.i = 1 THEN NULL
        ELSE cur.divisor::text END)
    || CASE WHEN cur.q = 0 THEN jsonb_build_object('assetsRaw', NULL, 'reason', 'zero_sized')
      WHEN previous.i IS NOT NULL THEN jsonb_build_object('assetsRaw', NULL,
        'reason', 'duplicate_q', 'duplicateOf', previous.label)
      ELSE jsonb_build_object('assetsRaw', cur.q::text, 'reason', NULL) END AS expected
    FROM ladder_q AS cur LEFT JOIN LATERAL (
      SELECT prior.i, prior.label FROM ladder_q AS prior
      WHERE prior.i < cur.i AND prior.q = cur.q ORDER BY prior.i LIMIT 1
    ) AS previous ON true),
  ladder_legacy_floor_q AS (SELECT grid.i,
    CASE WHEN grid.i = 1 THEN least(greatest(1, floor(claim / 2)),
      greatest(1, floor(total / 100000)))
      ELSE floor(total / (ARRAY[0, 100000, 10000, 1000, 200, 100]::numeric[])[grid.i])
    END AS q FROM ladder_input CROSS JOIN generate_series(1, 6) AS grid(i))
  SELECT
    round((extract(epoch FROM (sample.at - (input.plan->>'baselineBlockAt')::timestamptz)) / 60)::numeric, 2)::float8 AS baseline_age_minutes,
    ((input.plan->>'baselineBlockAt')::timestamptz BETWEEN sample.at - interval '30 minutes' AND sample.at) AS baseline_fresh,
    ((input.plan->>'slotAt')::timestamptz = date_bin('15 minutes'::interval,
      sample.at, '2000-01-01 00:10:00+00'::timestamptz)) AS slot_matches_current_bin,
    (input.plan->'candidateEvidenceDoc'->>'routeKey' = input.plan->>'routeKey'
      AND input.plan->'candidateEvidenceDoc'->>'destination' = input.plan->>'destination'
      AND input.plan->'candidateEvidenceDoc'->>'asset' = input.plan->>'asset'
      AND input.plan->'candidateEvidenceDoc'->>'baselineHash' = input.plan->>'baselineHash') AS candidate_identity_matches,
    (input.plan->'candidateEvidenceDoc'->>'schema' = 'carry_exit_v2_sync_vault_candidate_v1'
      AND input.plan->'candidateEvidenceDoc'->>'selectedHolderCommitment' =
        encode(sha256(convert_to((input.plan->>'destination') || ':' ||
          (input.plan->>'holder'), 'UTF8')), 'hex')) AS candidate_selection_valid,
    (input.plan->'candidateEvidenceDoc'->'ladder'->>'basis' =
      'frozen_holder_claim_and_vault_total_assets_raw') AS ladder_basis_matches,
    (input.plan->'candidateEvidenceDoc'->'ladder'->>'selectedClaimRaw' =
      input.plan->'candidateEvidenceDoc'->>'selectedClaimRaw') AS ladder_claim_matches,
    (input.plan->'candidateEvidenceDoc'->'ladder'->>'totalAssetsRaw' =
      input.plan->'candidateEvidenceDoc'->'baselineState'->>'totalAssetsRaw') AS ladder_total_matches,
    carry_exit_v2_vault_ladder_valid(input.plan->'candidateEvidenceDoc') AS candidate_ladder_valid,
    (SELECT jsonb_agg(
      (input.plan->'candidateEvidenceDoc'->'ladder'->'labels'->(expected.i - 1)) =
        expected.expected ORDER BY expected.i) FROM ladder_expected AS expected) AS ladder_label_matches,
    (SELECT jsonb_agg(legacy.q = exact.q ORDER BY exact.i)
      FROM ladder_q AS exact JOIN ladder_legacy_floor_q AS legacy USING (i)) AS legacy_floor_matches_exact_division,
    (coalesce((input.plan->'candidateEvidenceDoc'->>'selectedSharesRaw')::numeric > 0, false)
      AND coalesce((input.plan->'candidateEvidenceDoc'->>'selectedClaimRaw')::numeric > 0, false)
      AND coalesce((input.plan->'candidateEvidenceDoc'->'baselineState'->>'totalAssetsRaw')::numeric > 0, false)
      AND coalesce((input.plan->'candidateEvidenceDoc'->'baselineState'->>'totalSupplyRaw')::numeric > 0, false)
      AND (input.plan->'candidateEvidenceDoc'->'baselineState'->>'assetDecimals')::integer =
        (input.plan->>'assetDecimals')::integer
      AND (input.plan->'candidateEvidenceDoc'->'baselineState'->>'shareDecimals')::integer BETWEEN 0 AND 36) AS candidate_state_valid,
    (EXISTS (SELECT 1 FROM jsonb_array_elements(
      input.plan->'candidateEvidenceDoc'->'screenedCandidates') AS screened(item)
      WHERE screened.item->>'holderCommitment' =
        input.plan->'candidateEvidenceDoc'->>'selectedHolderCommitment'
        AND screened.item->>'status' = 'eligible_holder'
        AND screened.item->>'sharesRaw' =
          input.plan->'candidateEvidenceDoc'->>'selectedSharesRaw'
        AND screened.item->>'claimRaw' =
          input.plan->'candidateEvidenceDoc'->>'selectedClaimRaw')) AS candidate_screen_matches
  FROM sample, input`
const emptyCase = (assetsRaw) => ({
  assetsRaw,
  baselineStatus: 'unavailable',
  unavailableReason: 'quote_unavailable',
})
const host = (url) =>
  new URL(url).hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '')

export function frozenSghoRoute() {
  const matches = CARRY_EXIT_V2_FROZEN_ROUTES.filter(
    (entry) =>
      entry.routeKey === ROUTE_KEY &&
      entry.kind === 'sgho' &&
      entry.destination === VAULT &&
      entry.asset === GHO,
  )
  if (matches.length !== 1) throw Error('frozen_route_unavailable')
  return matches[0]
}

export function buildSghoRollbackPlan({
  route,
  baseline,
  candidate,
  cases,
  slotAt,
  candidateDigest,
}) {
  if (
    route?.routeKey !== ROUTE_KEY ||
    route.kind !== 'sgho' ||
    route.destination !== VAULT ||
    route.asset !== GHO
  )
    throw Error('frozen_route_unavailable')
  if (
    !candidate?.holder ||
    candidate.evidenceDoc?.schema !== 'carry_exit_v2_sync_vault_candidate_v1' ||
    !/^[0-9a-f]{64}$/.test(candidateDigest ?? '')
  )
    throw Error('candidate_not_issuable')
  const labels = candidate.evidenceDoc.ladder?.labels
  if (!Array.isArray(labels) || labels.length !== 6) throw Error('ladder_invalid')
  const positive = labels.filter((entry) => entry.assetsRaw != null)
  if (
    !positive.length ||
    positive.length > 6 ||
    !Array.isArray(cases) ||
    cases.length !== positive.length ||
    cases.some((item, index) => item.assetsRaw !== positive[index].assetsRaw)
  )
    throw Error('case_ladder_mismatch')
  if (
    !cases.some(
      (item) =>
        item.baselineStatus === 'success' &&
        item.simulationStatus === 'success' &&
        item.callEvidenceDoc &&
        item.coverageKind === 'shares' &&
        /^[1-9][0-9]*$/.test(item.actualConsumedRaw ?? ''),
    )
  )
    throw Error('measured_success_unavailable')
  return {
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
    candidateEvidenceSha256: candidateDigest,
    candidateEvidenceDoc: candidate.evidenceDoc,
    canonicalityEvidenceDoc: baseline.canonicalityEvidenceDoc,
    omittedLadder: labels
      .filter((x) => x.reason)
      .map((x) => ({ label: x.label, reason: x.reason, duplicateOf: x.duplicateOf ?? null })),
    cases,
  }
}

/** Complete public holder/Q/two-origin proof before the DB caller can open a pool. */
export async function derivePublicSghoEvidence({
  rpcUrls,
  secondaryUrl = SECOND_ORIGIN,
  now = () => new Date(),
  transport = rpcTransport,
  prepare = prepareSyncVaultOrigin,
  measure = measureCarryExitV2Verified,
  decode = validateCarryExitV2RpcProof,
}) {
  const route = frozenSghoRoute()
  const urls = configuredRpcUrls(rpcUrls)
  const started = now().getTime()
  if (!Number.isSafeInteger(started)) throw Error('public_clock_invalid')
  const deadlineMs = started + BUDGET_MS
  const slot = Math.floor((started - 10 * 60_000) / (15 * 60_000))
  const { primary, baseline, candidate } = await prepare({
    urls,
    route,
    slot,
    deadlineMs: deadlineMs - 120_000,
    transport,
    now,
  })
  if (!primary || !baseline || !candidate?.holder) throw Error('candidate_discovery_unavailable')
  if (baseline.routeKey !== ROUTE_KEY || baseline.destination !== VAULT || baseline.asset !== GHO)
    throw Error('baseline_identity_invalid')
  const secondary = transport(secondaryUrl)
  if (host(primary.url) === host(secondary.url)) throw Error('secondary_origin_not_independent')
  const labels = candidate.evidenceDoc?.ladder?.labels
  if (!Array.isArray(labels) || labels.length !== 6) throw Error('ladder_invalid')
  const positive = labels.filter((entry) => entry.assetsRaw != null)
  if (!positive.length) throw Error('positive_q_unavailable')
  const cases = []
  for (const entry of positive) {
    let measured = emptyCase(entry.assetsRaw)
    if (now().getTime() < deadlineMs) {
      try {
        const verified = await measure({
          routeKey: ROUTE_KEY,
          destination: VAULT,
          asset: GHO,
          holder: candidate.holder,
          assetsRaw: entry.assetsRaw,
          target: baseline,
          provider: primary.provider,
          source: 'carry_exit_v2_sgho_rollback_gate',
          send: (envelope) => primary.send(envelope),
          primary: { url: primary.url, request: (envelope) => primary.send(envelope) },
          secondary: { url: secondary.url, request: (envelope) => secondary.send(envelope) },
          now,
        })
        if (verified.status === 'verified') {
          const decoded = decode({
            proof: verified.callEvidenceDoc,
            routeKey: ROUTE_KEY,
            destination: VAULT,
            asset: GHO,
            holder: candidate.holder,
            assetsRaw: entry.assetsRaw,
            blockNumber: baseline.targetBlock,
            blockHash: baseline.targetHash,
          })
          measured = syncVaultCaseFromMeasurement(
            entry.assetsRaw,
            verified.callEvidenceDoc,
            decoded,
          )
        }
      } catch {
        /* A failed public Q stays unavailable in the denominator. */
      }
    }
    cases.push(measured)
  }
  if (!cases.some((item) => item.baselineStatus === 'success'))
    throw Error('measured_success_unavailable')
  return { route, baseline, candidate, cases }
}

async function objectCounts(client) {
  const { rows } = await client.query(OBJECTS_SQL)
  return rows[0]
}

async function checkSameXidWitness(client, batchId) {
  await client.query('SAVEPOINT witness_probe')
  try {
    await client.query('SELECT carry_exit_v2_witness_committed_issue($1::bigint)', [batchId])
    throw Error('same_xid_witness_accepted')
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT witness_probe')
    if (error.message === 'same_xid_witness_accepted') throw error
    if (error.message !== 'exit_v2_issue_not_visibly_committed_before_first_target')
      throw Error('unexpected_witness_rejection')
    return 'rejected'
  }
}

/** Public evidence is completed before poolFactory is invoked. */
export async function runSghoRollbackGate({
  dbUrl,
  rpcUrls,
  secondaryUrl,
  publicEvidence = derivePublicSghoEvidence,
  poolFactory = (url) =>
    new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000 }),
  applyDdl = apply,
}) {
  if (!dbUrl || !rpcUrls) throw Error('gate_configuration_missing')
  const publicBundle = await publicEvidence({ rpcUrls, secondaryUrl })
  const { route, baseline, candidate, cases } = publicBundle
  // This pre-connection validation also rejects a fake private-derived Q list.
  buildSghoRollbackPlan({
    route,
    baseline,
    candidate,
    cases,
    slotAt: '2026-01-01T00:10:00.000Z',
    candidateDigest: 'a'.repeat(64),
  })

  const pool = poolFactory(dbUrl)
  let client
  let began = false
  let phase = 'connect'
  let result
  let diagnostics = null
  try {
    client = await pool.connect()
    phase = 'preflight'
    const before = await objectCounts(client)
    if (before.relations !== 0 || before.functions !== 0) throw Error('v2_objects_already_present')
    await client.query('BEGIN')
    began = true
    await client.query("SET LOCAL statement_timeout = '45s'")
    phase = 'ddl'
    await applyDdl(client)
    phase = 'plan'
    const digest = await client.query(DIGEST_SQL, [JSON.stringify(candidate.evidenceDoc)])
    const prepared = structuredClone(cases)
    for (const item of prepared) {
      for (const [field, digestField] of [
        ['callEvidenceDoc', 'callEvidenceSha256'],
        ['entitlementEvidenceDoc', 'entitlementEvidenceSha256'],
      ]) {
        if (item[field]) {
          const evidenceDigest = await client.query(DIGEST_SQL, [JSON.stringify(item[field])])
          item[digestField] = evidenceDigest.rows[0].digest
        }
      }
    }
    // Read the current bin only after all digest work, immediately before issue.
    const slot = await client.query(`SELECT date_bin('15 minutes'::interval,
      clock_timestamp(), '2000-01-01 00:10:00+00'::timestamptz) AS slot_at`)
    const plan = buildSghoRollbackPlan({
      route,
      baseline,
      candidate,
      cases: prepared,
      slotAt: slot.rows[0].slot_at.toISOString(),
      candidateDigest: digest.rows[0].digest,
    })
    phase = 'diagnostics'
    const diagnosticRows = await client.query(DIAGNOSTICS_SQL, [JSON.stringify(plan)])
    const check = diagnosticRows.rows[0]
    diagnostics = {
      baselineAgeMinutes: check.baseline_age_minutes,
      baselineFresh: check.baseline_fresh,
      slotMatchesCurrentBin: check.slot_matches_current_bin,
      candidateIdentityMatches: check.candidate_identity_matches,
      candidateSelectionValid: check.candidate_selection_valid,
      ladderBasisMatches: check.ladder_basis_matches,
      ladderClaimMatches: check.ladder_claim_matches,
      ladderTotalMatches: check.ladder_total_matches,
      candidateLadderValid: check.candidate_ladder_valid,
      ladderLabelMatches: check.ladder_label_matches,
      legacyFloorMatchesExactDivision: check.legacy_floor_matches_exact_division,
      candidateStateValid: check.candidate_state_valid,
      candidateScreenMatches: check.candidate_screen_matches,
    }
    phase = 'issue'
    let issued
    try {
      issued = await client.query(
        `SELECT carry_exit_v2_issue(jsonb_build_object('plan', $1::jsonb,
        'planSha256', encode(sha256(convert_to(($1::jsonb)::text, 'UTF8')), 'hex'))) AS batch_id`,
        [JSON.stringify(plan)],
      )
    } catch (error) {
      const allowed = new Set([
        'exit_v2_batch_plan_invalid',
        'exit_v2_case_plan_mismatch',
        'exit_v2_baseline_call_evidence_invalid',
        'exit_v2_baseline_entitlement_evidence_invalid',
        'exit_v2_horizon_plan_mismatch',
      ])
      throw Error(allowed.has(error.message) ? `issue_${error.message.slice(8)}` : 'issue_rejected')
    }
    const batchId = issued.rows[0]?.batch_id
    if (batchId == null) throw Error('issue_not_created')
    phase = 'counts'
    const counts = await client.query(
      `SELECT
      (SELECT count(*)::integer FROM carry_exit_v2_cases WHERE batch_id = $1) AS cases,
      (SELECT count(*)::integer FROM carry_exit_v2_plans p JOIN carry_exit_v2_cases c ON c.id = p.case_id WHERE c.batch_id = $1) AS plans,
      (SELECT count(*)::integer FROM carry_exit_v2_cases WHERE batch_id = $1 AND baseline_status = 'inconclusive') AS inconclusive,
      (SELECT count(*)::integer FROM carry_exit_v2_cases WHERE batch_id = $1 AND baseline_status = 'unavailable') AS unavailable`,
      [batchId],
    )
    const tally = counts.rows[0]
    const expectedInconclusive = prepared.filter((x) => x.baselineStatus === 'inconclusive').length
    const expectedUnavailable = prepared.filter((x) => x.baselineStatus === 'unavailable').length
    if (
      tally.cases !== prepared.length ||
      tally.plans !== prepared.length * 5 ||
      tally.inconclusive !== expectedInconclusive ||
      tally.unavailable !== expectedUnavailable
    )
      throw Error('issue_count_mismatch')
    phase = 'witness'
    const witness = await checkSameXidWitness(client, batchId)
    result = {
      route: 'GHO → sGHO',
      candidate: 'receipt_verified_positive_claim',
      cases: tally.cases,
      plans: tally.plans,
      inconclusive: tally.inconclusive,
      unavailable: tally.unavailable,
      sameXidWitness: witness,
    }
    throw Error(ROLLBACK_SENTINEL)
  } catch (error) {
    if (began) {
      await client.query('ROLLBACK')
      began = false
    }
    if (client && error.message !== 'v2_objects_already_present') {
      const after = await objectCounts(client)
      if (after.relations !== 0 || after.functions !== 0) throw Error('rollback_left_v2_objects')
    }
    if (error.message !== ROLLBACK_SENTINEL) {
      const known = new Set([
        'v2_objects_already_present',
        'issue_not_created',
        'issue_count_mismatch',
        'same_xid_witness_accepted',
        'unexpected_witness_rejection',
        'rollback_left_v2_objects',
      ])
      const safeError = Error(
        known.has(error.message) || /^issue_[a-z_]+$/.test(error.message)
          ? error.message
          : `sql_${phase}_failed`,
      )
      if (diagnostics) safeError.diagnostics = diagnostics
      throw safeError
    }
    return { ...result, schema: 'absent_after_rollback' }
  } finally {
    if (began && client) await client.query('ROLLBACK')
    client?.release()
    await pool.end()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { get } = readEnv()
  const dbUrl =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  const rpcUrls =
    process.env.RECORDER_RPC_URLS ||
    process.env.RECORDER_RPC_URL ||
    get('RECORDER_RPC_URLS') ||
    get('RECORDER_RPC_URL')
  const secondaryUrl =
    process.env.CARRY_EXIT_V2_VERIFY_RPC_URL || get('CARRY_EXIT_V2_VERIFY_RPC_URL') || SECOND_ORIGIN
  if (!dbUrl || !rpcUrls) {
    process.stderr.write('carry_sgho_exit_v2_gate_configuration_missing\n')
    process.exitCode = 1
  } else {
    runSghoRollbackGate({ dbUrl, rpcUrls, secondaryUrl })
      .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch((error) => {
        const known = new Set([
          'frozen_route_unavailable',
          'candidate_discovery_unavailable',
          'secondary_origin_not_independent',
          'ladder_invalid',
          'positive_q_unavailable',
          'measured_success_unavailable',
          'candidate_not_issuable',
          'case_ladder_mismatch',
          'v2_objects_already_present',
          'issue_not_created',
          'issue_count_mismatch',
          'same_xid_witness_accepted',
          'unexpected_witness_rejection',
          'rollback_left_v2_objects',
        ])
        const code =
          known.has(error.message) ||
          /^issue_[a-z_]+$/.test(error.message) ||
          /^sql_[a-z_]+$/.test(error.message)
            ? error.message
            : 'public_rpc_unavailable'
        process.stderr.write(
          `${JSON.stringify({ code: `carry_sgho_exit_v2_gate_${code}`, ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}) })}\n`,
        )
        process.exitCode = 1
      })
  }
}
