// Public-chain proof first, then draft SQL issue inside an intentional rollback.
// No scheduler, committed issue, future outcome, holder, Q, or URL is printed.
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
  captureFreshDirectBaseline,
  discoverDirectIssuerCandidate,
} from '../lib/carry-exit-v2-direct-issuer-prep.mjs'
import { readEnv } from '../lib/venue-reads.mjs'
import { configuredRpcUrls, rpcTransport } from '../record-carry-morpho-exit-v2-issues.mjs'
import {
  directCaseFromMeasurement,
  selectDirectOrigin,
} from '../record-carry-direct-exit-v2-issues.mjs'

const SENTINEL = 'carry_direct_exit_v2_intentional_rollback'
const SECOND_ORIGIN = 'https://eth.drpc.org'
const OBJECTS_SQL = `SELECT
  (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname LIKE 'carry_exit_v2_%') AS relations,
  (SELECT count(*)::integer FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'carry_exit_v2_%') AS functions`

export function buildDirectRollbackPlan({
  route,
  baseline,
  candidate,
  slotAt,
  candidateDigest,
  cases,
}) {
  if (
    !candidate?.holder ||
    !/^[0-9a-f]{64}$/.test(candidateDigest ?? '') ||
    !['aave', 'spark', 'comet'].includes(route.kind)
  )
    throw Error('candidate_not_issuable')
  const labels = candidate.evidenceDoc?.ladder?.labels
  const positive = labels?.filter((entry) => entry.assetsRaw != null)
  if (
    !Array.isArray(positive) ||
    positive.length < 1 ||
    positive.length > 6 ||
    !Array.isArray(cases) ||
    cases.length !== positive.length ||
    cases.some((item, index) => item.assetsRaw !== positive[index].assetsRaw)
  )
    throw Error('positive_q_mismatch')
  if (!cases.some((item) => item.baselineStatus === 'success'))
    throw Error('verified_direct_success_unavailable')
  const omittedLadder = labels
    .filter((entry) => entry.reason)
    .map((entry) => ({
      label: entry.label,
      reason: entry.reason,
      duplicateOf: entry.duplicateOf ?? null,
    }))
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
    candidateProvenance:
      route.kind === 'comet' ? 'receipt_verified_supply' : 'receipt_verified_transfer',
    candidateEvidenceSha256: candidateDigest,
    candidateEvidenceDoc: candidate.evidenceDoc,
    canonicalityEvidenceDoc: baseline.canonicalityEvidenceDoc,
    omittedLadder,
    cases,
  }
}

async function objectCounts(client) {
  const { rows } = await client.query(OBJECTS_SQL)
  return rows[0]
}

async function publicCandidate(route, urls) {
  for (const url of urls) {
    const primary = await selectDirectOrigin([url], route, rpcTransport)
    if (!primary) continue
    try {
      const baseline = await captureFreshDirectBaseline({
        ...route,
        provider: primary.provider,
        source: 'carry_exit_v2_direct_rollback_gate',
        request: primary.request.bind(primary),
      })
      const candidate = await discoverDirectIssuerCandidate({
        baseline,
        request: primary.request.bind(primary),
      })
      if (candidate?.holder) return { primary, baseline, candidate }
    } catch {
      /* Try another public origin. */
    }
  }
  throw Error('public_candidate_unavailable')
}

/** Every Q is attempted before any database connection is opened. */
async function publicCases({ route, primary, secondary, baseline, candidate }) {
  const labels = candidate.evidenceDoc.ladder.labels.filter((entry) => entry.assetsRaw != null)
  if (!labels.length) throw Error('positive_q_unavailable')
  const cases = []
  for (const label of labels) {
    let result = directCaseFromMeasurement(label.assetsRaw, null, null)
    try {
      const frozen = {
        ...route,
        holder: candidate.holder,
        assetsRaw: label.assetsRaw,
        blockNumber: baseline.targetBlock,
        blockHash: baseline.targetHash,
      }
      const collected = await collectCarryExitV2RpcProof({
        ...route,
        holder: candidate.holder,
        assetsRaw: label.assetsRaw,
        target: baseline,
        provider: primary.provider,
        source: 'carry_exit_v2_direct_rollback_gate',
        send: primary.send.bind(primary),
      })
      const replay = await verifyCarryExitV2IndependentReplay({
        ...frozen,
        proof: collected.proof,
        identityEvidence: collected.identityEvidence,
        primary: { url: primary.url, request: primary.send.bind(primary) },
        secondary: { url: secondary.url, request: secondary.send.bind(secondary) },
      })
      if (replay.status === 'verified') {
        const evidence = assembleCarryExitV2CallEvidence({ collector: collected, replay, frozen })
        const decoded = validateCarryExitV2RpcProof({ proof: collected.proof, ...frozen })
        result = directCaseFromMeasurement(label.assetsRaw, evidence, decoded)
      }
    } catch {
      /* A failed Q remains a predeclared unavailable denominator. */
    }
    cases.push(result)
  }
  if (!cases.some((item) => item.baselineStatus === 'success'))
    throw Error('verified_direct_success_unavailable')
  return cases
}

async function sameXidWitnessRejected(client, batchId) {
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

/** Deliberately rollback the complete schema, batch, cases and plans. */
export async function runDirectRollbackGate({ dbUrl, rpcUrls, secondaryUrl = SECOND_ORIGIN }) {
  const route = CARRY_EXIT_V2_FROZEN_ROUTES.find((entry) => entry.kind === 'spark')
  if (!route) throw Error('frozen_direct_route_unavailable')
  const urls = configuredRpcUrls(rpcUrls)
  const preferred = [urls[1], urls[2], urls[6], ...urls].filter(Boolean)
  const { primary, baseline, candidate } = await publicCandidate(route, [...new Set(preferred)])
  const secondary = rpcTransport(secondaryUrl)
  if (new URL(primary.url).hostname === new URL(secondary.url).hostname)
    throw Error('secondary_origin_not_independent')
  const cases = await publicCases({ route, primary, secondary, baseline, candidate })
  // Database access begins only after all holder/Q RPC calls have finished.
  const pool = new Pool({ connectionString: dbUrl, max: 1, connectionTimeoutMillis: 15_000 })
  let client,
    began = false,
    result,
    phase = 'connect'
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
    const digest = async (doc) => {
      const rows = await client.query(
        `SELECT encode(sha256(convert_to(($1::jsonb)::text, 'UTF8')), 'hex') AS digest`,
        [JSON.stringify(doc)],
      )
      return rows.rows[0].digest
    }
    const candidateDigest = await digest(candidate.evidenceDoc)
    for (const item of cases) {
      if (item.callEvidenceDoc) item.callEvidenceSha256 = await digest(item.callEvidenceDoc)
      if (item.entitlementEvidenceDoc)
        item.entitlementEvidenceSha256 = await digest(item.entitlementEvidenceDoc)
    }
    const plan = buildDirectRollbackPlan({
      route,
      baseline,
      candidate,
      slotAt: slot.rows[0].slot_at.toISOString(),
      candidateDigest,
      cases,
    })
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
      throw Error(
        allowed.has(error.message)
          ? `issue_${error.message.slice('exit_v2_'.length)}`
          : 'issue_unknown',
      )
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
          WHERE batch_id = $1 AND baseline_status = 'success') AS success,
        (SELECT count(*)::integer FROM carry_exit_v2_cases
          WHERE batch_id = $1 AND baseline_status = 'ineligible') AS ineligible,
        (SELECT count(*)::integer FROM carry_exit_v2_cases
          WHERE batch_id = $1 AND baseline_status = 'covered_revert') AS covered_revert,
        (SELECT count(*)::integer FROM carry_exit_v2_cases
          WHERE batch_id = $1 AND baseline_status = 'inconclusive') AS inconclusive,
        (SELECT count(*)::integer FROM carry_exit_v2_cases
          WHERE batch_id = $1 AND baseline_status = 'unavailable') AS unavailable`,
      [batchId],
    )
    const tally = counts.rows[0]
    const expected = Object.fromEntries(
      ['success', 'ineligible', 'covered_revert', 'inconclusive', 'unavailable'].map((status) => [
        status,
        plan.cases.filter((item) => item.baselineStatus === status).length,
      ]),
    )
    if (
      tally.cases !== plan.cases.length ||
      tally.plans !== 5 * tally.cases ||
      tally.success < 1 ||
      Object.entries(expected).some(([status, count]) => tally[status] !== count)
    )
      throw Error('issue_count_mismatch')
    phase = 'witness'
    const witness = await sameXidWitnessRejected(client, batchId)
    result = {
      baseline: 'fresh_finalized',
      candidate: 'receipt_verified_positive_balance',
      cases: tally.cases,
      plans: tally.plans,
      caseStatuses: expected,
      sameXidWitness: witness,
    }
    throw Error(SENTINEL)
  } catch (error) {
    if (began) {
      await client.query('ROLLBACK')
      began = false
    }
    if (client && error.message !== 'v2_objects_already_present') {
      const after = await objectCounts(client)
      if (after.relations !== 0 || after.functions !== 0) throw Error('rollback_left_v2_objects')
    }
    if (error.message !== SENTINEL) {
      const known = new Set([
        'v2_objects_already_present',
        'issue_not_created',
        'issue_count_mismatch',
        'same_xid_witness_accepted',
        'unexpected_witness_rejection',
      ])
      throw Error(
        known.has(error.message) || /^issue_[a-z_]+$/.test(error.message)
          ? error.message
          : `sql_${phase}_failed`,
      )
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
  if (!dbUrl || !rpcUrls) {
    process.stderr.write('carry_direct_exit_v2_gate_configuration_missing\n')
    process.exitCode = 1
  } else {
    runDirectRollbackGate({
      dbUrl,
      rpcUrls,
      secondaryUrl: process.env.CARRY_EXIT_V2_VERIFY_RPC_URL || SECOND_ORIGIN,
    })
      .then((value) => process.stdout.write(`${JSON.stringify(value)}\n`))
      .catch((error) => {
        const known = new Set([
          'frozen_direct_route_unavailable',
          'public_candidate_unavailable',
          'positive_q_unavailable',
          'verified_direct_success_unavailable',
          'secondary_origin_not_independent',
          'candidate_not_issuable',
          'positive_q_mismatch',
          'v2_objects_already_present',
          'issue_not_created',
          'issue_count_mismatch',
          'same_xid_witness_accepted',
          'unexpected_witness_rejection',
          'rollback_left_v2_objects',
        ])
        const safe =
          known.has(error.message) ||
          /^sql_[a-z_]+_failed$/.test(error.message) ||
          /^issue_[a-z_]+$/.test(error.message)
        process.stderr.write(
          `carry_direct_exit_v2_gate_failed:${safe ? error.message : 'integration_error'}\n`,
        )
        process.exitCode = 1
      })
  }
}
