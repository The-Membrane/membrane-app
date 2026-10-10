// Live integration gate only. Every v2 object and issue is deliberately rolled back.
// This script never commits, schedules a recorder, or publishes an outcome.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from '@neondatabase/serverless'

import { apply } from '../apply-carry-exit-v2-ddl.mjs'
import {
  CARRY_EXIT_V2_FROZEN_ROUTES,
  validateCarryExitV2RpcProof,
} from '../lib/carry-exit-v2-rpc-proof.mjs'
import { collectCarryExitV2RpcProof } from '../lib/carry-exit-v2-rpc-collector.mjs'
import { verifyCarryExitV2IndependentReplay } from '../lib/carry-exit-v2-independent-replay.mjs'
import { assembleCarryExitV2CallEvidence } from '../lib/carry-exit-v2-proof-assembly.mjs'
import {
  captureFreshMorphoBaseline,
  discoverMorphoIssuerCandidate,
} from '../lib/carry-exit-v2-morpho-issuer-prep.mjs'
import { readEnv } from '../lib/venue-reads.mjs'
import {
  caseFromMeasurement,
  configuredRpcUrls,
  rpcTransport,
  selectHealthyOrigin,
} from '../record-carry-morpho-exit-v2-issues.mjs'

const ROLLBACK_SENTINEL = 'carry_exit_v2_intentional_rollback'
const ROUTE_DESTINATION = '0x36cfe1568461e499391ef0a555300f1ae2da2439'
const SECOND_ORIGIN = 'https://eth.drpc.org'
const OBJECTS_SQL = `SELECT
  (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname LIKE 'carry_exit_v2_%') AS relations,
  (SELECT count(*)::integer FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'carry_exit_v2_%') AS functions`

export function buildUnavailablePlan({ route, baseline, candidate, slotAt, candidateDigest }) {
  if (!candidate?.holder || !/^[0-9a-f]{64}$/.test(candidateDigest ?? ''))
    throw Error('candidate_not_issuable')
  const cases = candidate.evidenceDoc?.ladder?.labels
    ?.filter((label) => label.assetsRaw != null)
    .map((label) => ({
      assetsRaw: label.assetsRaw,
      baselineStatus: 'unavailable',
      unavailableReason: 'quote_unavailable',
    }))
  if (!cases?.length || cases.length > 6) throw Error('positive_q_unavailable')
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
    cases,
  }
}

async function objectCounts(client) {
  const { rows } = await client.query(OBJECTS_SQL)
  return rows[0]
}

async function measuredCase({ route, primary, secondary, baseline, candidate }) {
  const label = candidate.evidenceDoc.ladder.labels
    .filter((entry) => entry.assetsRaw != null)
    .sort((a, b) =>
      BigInt(a.assetsRaw) > BigInt(b.assetsRaw)
        ? -1
        : BigInt(a.assetsRaw) < BigInt(b.assetsRaw)
          ? 1
          : 0,
    )[0]
  if (!label) throw Error('positive_q_unavailable')
  const frozen = {
    ...route,
    holder: candidate.holder,
    assetsRaw: label.assetsRaw,
    blockNumber: baseline.targetBlock,
    blockHash: baseline.targetHash,
  }
  let collected
  try {
    collected = await collectCarryExitV2RpcProof({
      ...route,
      holder: candidate.holder,
      assetsRaw: label.assetsRaw,
      target: baseline,
      provider: primary.provider,
      source: 'carry_exit_v2_rollback_gate',
      send: primary.send.bind(primary),
    })
  } catch {
    throw Error('proof_collect_failed')
  }
  let replay
  try {
    replay = await verifyCarryExitV2IndependentReplay({
      ...frozen,
      proof: collected.proof,
      identityEvidence: collected.identityEvidence,
      primary: { url: primary.url, request: primary.send.bind(primary) },
      secondary: { url: secondary.url, request: secondary.send.bind(secondary) },
    })
  } catch {
    throw Error('proof_replay_failed')
  }
  if (replay.status !== 'verified') throw Error('proof_replay_unavailable')
  let assembled, decoded
  try {
    assembled = assembleCarryExitV2CallEvidence({ collector: collected, replay, frozen })
    decoded = validateCarryExitV2RpcProof({ proof: collected.proof, ...frozen })
  } catch {
    throw Error('proof_assembly_failed')
  }
  const measured = caseFromMeasurement(label.assetsRaw, assembled, decoded)
  if (measured.baselineStatus === 'unavailable')
    throw Error(
      `proof_unmeasured_${decoded.simulationStatus === 'evm_revert' ? 'revert' : 'success'}_${decoded.coveredRevert ? 'covered' : 'uncovered'}_${decoded.actualConsumedRaw == null ? 'no_consumed' : 'consumed'}`,
    )
  return measured
}

async function checkSameXidWitness(client, batchId) {
  await client.query('SAVEPOINT witness_probe')
  try {
    await client.query('SELECT carry_exit_v2_witness_committed_issue($1::bigint)', [batchId])
    throw Error('same_xid_witness_accepted')
  } catch (error) {
    // PostgreSQL aborts this statement, not the outer test transaction.
    await client.query('ROLLBACK TO SAVEPOINT witness_probe')
    if (error.message === 'same_xid_witness_accepted') throw error
    if (error.message !== 'exit_v2_issue_not_visibly_committed_before_first_target')
      throw Error('unexpected_witness_rejection')
    return 'rejected'
  }
}

export async function runLiveGate({ dbUrl, rpcUrls }) {
  const route = CARRY_EXIT_V2_FROZEN_ROUTES.find(
    (entry) => entry.kind === 'morpho' && entry.destination === ROUTE_DESTINATION,
  )
  if (!route) throw Error('frozen_route_unavailable')
  let baseline, candidate, primary
  let supportedOrigins = 0
  const urls = configuredRpcUrls(rpcUrls)
  // Prefer origins that have served a full 4096-block receipt screen before.
  const preferred = [urls[2], urls[6], ...urls].filter(Boolean)
  for (const url of [...new Set(preferred)]) {
    const origin = await selectHealthyOrigin([url], route, rpcTransport)
    if (!origin) continue
    supportedOrigins++
    try {
      const fresh = await captureFreshMorphoBaseline({
        ...route,
        provider: origin.provider,
        source: 'carry_exit_v2_rollback_gate',
        request: origin.request.bind(origin),
      })
      const discovered = await discoverMorphoIssuerCandidate({
        baseline: fresh,
        request: origin.request.bind(origin),
      })
      if (discovered?.holder) {
        baseline = fresh
        candidate = discovered
        primary = origin
        break
      }
    } catch {
      // This origin cannot support full pinned discovery; use the next one.
    }
  }
  if (!supportedOrigins) throw Error('healthy_rpc_unavailable')
  if (!candidate) throw Error('candidate_discovery_unavailable')
  if (!candidate?.holder || candidate.evidenceDoc?.selectedHolderCommitment == null)
    throw Error('receipt_verified_candidate_unavailable')
  const secondaryUrl = process.env.CARRY_EXIT_V2_VERIFY_RPC_URL || SECOND_ORIGIN
  const secondary = rpcTransport(secondaryUrl)
  if (new URL(primary.url).hostname === new URL(secondary.url).hostname)
    throw Error('secondary_origin_not_independent')
  const actualCase = await measuredCase({ route, primary, secondary, baseline, candidate })

  const pool = new Pool({ connectionString: dbUrl, max: 1, connectionTimeoutMillis: 15_000 })
  let client
  let began = false
  let result
  let phase = 'connect'
  try {
    client = await pool.connect()
    phase = 'preflight'
    const before = await objectCounts(client)
    if (before.relations !== 0 || before.functions !== 0) throw Error('v2_objects_already_present')
    await client.query('BEGIN')
    began = true
    await client.query("SET LOCAL statement_timeout = '45s'")
    phase = 'ddl'
    await apply(client)
    phase = 'plan'
    const slot = await client.query(`SELECT date_bin('15 minutes'::interval,
      clock_timestamp(), '2000-01-01 00:10:00+00'::timestamptz) AS slot_at`)
    const digest = await client.query(
      `SELECT encode(sha256(convert_to(($1::jsonb)::text, 'UTF8')), 'hex') AS digest`,
      [JSON.stringify(candidate.evidenceDoc)],
    )
    const plan = buildUnavailablePlan({
      route,
      baseline,
      candidate,
      slotAt: slot.rows[0].slot_at.toISOString(),
      candidateDigest: digest.rows[0].digest,
    })
    const caseIndex = plan.cases.findIndex((item) => item.assetsRaw === actualCase.assetsRaw)
    if (caseIndex < 0) throw Error('measured_case_not_planned')
    const evidenceDoc = actualCase.callEvidenceDoc ?? actualCase.entitlementEvidenceDoc
    const evidenceDigest = await client.query(
      `SELECT encode(sha256(convert_to(($1::jsonb)::text, 'UTF8')), 'hex') AS digest`,
      [JSON.stringify(evidenceDoc)],
    )
    if (actualCase.callEvidenceDoc) actualCase.callEvidenceSha256 = evidenceDigest.rows[0].digest
    else actualCase.entitlementEvidenceSha256 = evidenceDigest.rows[0].digest
    plan.cases[caseIndex] = actualCase
    phase = 'issue'
    let issued
    try {
      issued = await client.query(
        `SELECT carry_exit_v2_issue(jsonb_build_object('plan', $1::jsonb,
          'planSha256', encode(sha256(convert_to(($1::jsonb)::text, 'UTF8')), 'hex')))
          AS batch_id`,
        [JSON.stringify(plan)],
      )
    } catch (error) {
      const allowed = new Set([
        'exit_v2_batch_plan_invalid',
        'exit_v2_case_plan_mismatch',
        'exit_v2_baseline_call_evidence_invalid',
        'exit_v2_baseline_revert_not_covered',
        'exit_v2_baseline_entitlement_evidence_invalid',
        'exit_v2_horizon_plan_mismatch',
      ])
      const reason = allowed.has(error.message)
        ? error.message.slice('exit_v2_'.length)
        : error.code === '23514'
          ? 'check_constraint'
          : error.code === '22001'
            ? 'length_constraint'
            : 'unknown'
      throw Error(`issue_${reason}`)
    }
    const batchId = issued.rows[0]?.batch_id
    if (batchId == null) throw Error('issue_not_created')
    phase = 'counts'
    const counts = await client.query(
      `SELECT (SELECT count(*)::integer FROM carry_exit_v2_cases WHERE batch_id = $1) AS cases,
        (SELECT count(*)::integer FROM carry_exit_v2_plans p
          JOIN carry_exit_v2_cases c ON c.id = p.case_id
          WHERE c.batch_id = $1) AS plans,
        (SELECT count(*)::integer FROM carry_exit_v2_cases
          WHERE batch_id = $1 AND baseline_status = 'unavailable') AS unavailable,
        (SELECT count(*)::integer FROM carry_exit_v2_cases
          WHERE batch_id = $1 AND baseline_status <> 'unavailable') AS measured`,
      [batchId],
    )
    const tally = counts.rows[0]
    if (
      tally.cases !== plan.cases.length ||
      tally.plans !== plan.cases.length * 5 ||
      Number(tally.unavailable) !== plan.cases.length - 1 ||
      Number(tally.measured) !== 1
    )
      throw Error('issue_count_mismatch')
    phase = 'witness'
    const witness = await checkSameXidWitness(client, batchId)
    result = {
      baseline: 'fresh_finalized',
      candidate: 'receipt_verified_positive_claim',
      cases: tally.cases,
      plans: tally.plans,
      measuredCaseStatus: actualCase.baselineStatus,
      otherCaseStatus: 'explicitly_unavailable',
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
    if (error.message !== ROLLBACK_SENTINEL)
      throw Error(
        new Set([
          'v2_objects_already_present',
          'issue_not_created',
          'issue_count_mismatch',
          'same_xid_witness_accepted',
          'unexpected_witness_rejection',
        ]).has(error.message) || /^issue_[a-z_]+$/.test(error.message)
          ? error.message
          : `sql_${phase}_failed`,
      )
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
  if (!dbUrl || !rpcUrls) {
    process.stderr.write('carry_exit_v2_rollback_gate_configuration_missing\n')
    process.exitCode = 1
  } else {
    runLiveGate({ dbUrl, rpcUrls })
      .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch((error) => {
        // No holder, Q, endpoint, credential, SQL error body, or raw stack escapes.
        const known = new Set([
          'frozen_route_unavailable',
          'healthy_rpc_unavailable',
          'baseline_unavailable',
          'candidate_discovery_unavailable',
          'receipt_verified_candidate_unavailable',
          'positive_q_unavailable',
          'secondary_origin_not_independent',
          'proof_collect_failed',
          'proof_replay_failed',
          'proof_replay_unavailable',
          'proof_assembly_failed',
          'proof_unmeasured',
          'v2_objects_already_present',
          'issue_not_created',
          'issue_count_mismatch',
          'same_xid_witness_accepted',
          'unexpected_witness_rejection',
          'rollback_left_v2_objects',
          'sql_connect_failed',
          'sql_preflight_failed',
          'sql_ddl_failed',
          'sql_plan_failed',
          'sql_issue_failed',
          'sql_counts_failed',
          'sql_witness_failed',
        ])
        const safe =
          known.has(error.message) ||
          /^proof_unmeasured_(?:revert|success)_(?:covered|uncovered)_(?:no_consumed|consumed)$/.test(
            error.message,
          ) ||
          /^issue_(?:batch_plan_invalid|case_plan_mismatch|baseline_call_evidence_invalid|baseline_revert_not_covered|baseline_entitlement_evidence_invalid|horizon_plan_mismatch|check_constraint|length_constraint|unknown)$/.test(
            error.message,
          )
        process.stderr.write(
          `carry_exit_v2_rollback_gate_failed:${safe ? error.message : 'integration_error'}\n`,
        )
        process.exitCode = 1
      })
  }
}
