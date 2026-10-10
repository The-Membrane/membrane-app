// Public-first, rollback-only integration gate for the frozen USD3 sync vault.
// It never commits an issue, creates a witness, schedules a job, or scores an outcome.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from '@neondatabase/serverless'

import { apply } from '../apply-carry-exit-v2-ddl.mjs'
import {
  CARRY_EXIT_V2_FROZEN_ROUTES,
  validateCarryExitV2RpcProof,
} from '../lib/carry-exit-v2-rpc-proof.mjs'
import {
  captureFreshSyncVaultBaseline,
  discoverSyncVaultIssuerCandidate,
} from '../lib/carry-exit-v2-sync-vault-issuer-prep.mjs'
import { collectCarryExitV2RpcProof } from '../lib/carry-exit-v2-rpc-collector.mjs'
import { verifyCarryExitV2IndependentReplay } from '../lib/carry-exit-v2-independent-replay.mjs'
import { assembleCarryExitV2CallEvidence } from '../lib/carry-exit-v2-proof-assembly.mjs'
import {
  configuredRpcUrls,
  rpcTransport,
  selectHealthyOrigin,
} from '../record-carry-morpho-exit-v2-issues.mjs'
import { syncVaultCaseFromMeasurement } from '../record-carry-sync-vault-exit-v2-issues.mjs'
import { readEnv } from '../lib/venue-reads.mjs'

const ROLLBACK_SENTINEL = 'carry_sync_vault_exit_v2_intentional_rollback'
const SECOND_ORIGIN = 'https://eth.drpc.org'
const USD3_ROUTE_KEY = 'USDC → USD3 [USDC]'
const OBJECTS_SQL = `SELECT
  (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname LIKE 'carry_exit_v2_%') AS relations,
  (SELECT count(*)::integer FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'carry_exit_v2_%') AS functions`
const DIGEST_SQL = `SELECT encode(sha256(convert_to(($1::jsonb)::text, 'UTF8')), 'hex') AS digest`
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

export function frozenUsd3Route() {
  const route = CARRY_EXIT_V2_FROZEN_ROUTES.find((entry) => entry.routeKey === USD3_ROUTE_KEY)
  if (route?.kind !== 'usd3') throw Error('frozen_route_unavailable')
  return route
}

export function buildSyncVaultRollbackPlan({
  route,
  baseline,
  candidate,
  cases,
  slotAt,
  candidateDigest,
}) {
  if (route?.routeKey !== USD3_ROUTE_KEY || route.kind !== 'usd3')
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
      (item) => item.baselineStatus === 'inconclusive' && item.simulationStatus === 'evm_revert',
    )
  )
    throw Error('inconclusive_q_unavailable')
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

/** Complete all public holder/Q RPC work before returning to the DB caller. */
export async function derivePublicUsd3Evidence({ rpcUrls, secondaryUrl = SECOND_ORIGIN }) {
  const route = frozenUsd3Route()
  const urls = configuredRpcUrls(rpcUrls)
  let primary, baseline, candidate
  for (const url of urls) {
    const origin = await selectHealthyOrigin([url], route, rpcTransport)
    if (!origin) continue
    try {
      const fresh = await captureFreshSyncVaultBaseline({
        ...route,
        provider: origin.provider,
        source: 'carry_sync_vault_exit_v2_rollback_gate',
        request: origin.request.bind(origin),
      })
      const found = await discoverSyncVaultIssuerCandidate({
        baseline: fresh,
        request: origin.request.bind(origin),
      })
      if (found?.holder && found.evidenceDoc?.selectedHolderCommitment) {
        primary = origin
        baseline = fresh
        candidate = found
        break
      }
    } catch {
      /* This public origin cannot support receipt-verified discovery. */
    }
  }
  if (!primary || !candidate) throw Error('candidate_discovery_unavailable')
  const secondary = rpcTransport(secondaryUrl)
  if (host(primary.url) === host(secondary.url)) throw Error('secondary_origin_not_independent')
  const labels = candidate.evidenceDoc?.ladder?.labels
  if (!Array.isArray(labels) || labels.length !== 6) throw Error('ladder_invalid')
  const positive = labels.filter((entry) => entry.assetsRaw != null)
  if (!positive.length) throw Error('positive_q_unavailable')
  const cases = []
  for (const entry of positive) {
    let measured = emptyCase(entry.assetsRaw)
    try {
      const frozen = {
        ...route,
        holder: candidate.holder,
        assetsRaw: entry.assetsRaw,
        blockNumber: baseline.targetBlock,
        blockHash: baseline.targetHash,
      }
      const collected = await collectCarryExitV2RpcProof({
        ...route,
        holder: candidate.holder,
        assetsRaw: entry.assetsRaw,
        target: baseline,
        provider: primary.provider,
        source: 'carry_sync_vault_exit_v2_rollback_gate',
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
        const assembled = assembleCarryExitV2CallEvidence({ collector: collected, replay, frozen })
        const decoded = validateCarryExitV2RpcProof({ proof: collected.proof, ...frozen })
        measured = syncVaultCaseFromMeasurement(entry.assetsRaw, assembled, decoded)
      }
    } catch {
      /* The frozen Q remains explicitly unavailable. */
    }
    cases.push(measured)
  }
  if (
    !cases.some(
      (item) => item.baselineStatus === 'inconclusive' && item.simulationStatus === 'evm_revert',
    )
  )
    throw Error('inconclusive_q_unavailable')
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
export async function runSyncVaultRollbackGate({
  dbUrl,
  rpcUrls,
  secondaryUrl,
  publicEvidence = derivePublicUsd3Evidence,
  poolFactory = (url) =>
    new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000 }),
  applyDdl = apply,
}) {
  if (!dbUrl || !rpcUrls) throw Error('gate_configuration_missing')
  const publicBundle = await publicEvidence({ rpcUrls, secondaryUrl })
  const { route, baseline, candidate, cases } = publicBundle
  // This pre-connection validation also rejects a fake private-derived Q list.
  buildSyncVaultRollbackPlan({
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
    const slot = await client.query(`SELECT date_bin('15 minutes'::interval,
      clock_timestamp(), '2000-01-01 00:10:00+00'::timestamptz) AS slot_at`)
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
    const plan = buildSyncVaultRollbackPlan({
      route,
      baseline,
      candidate,
      cases: prepared,
      slotAt: slot.rows[0].slot_at.toISOString(),
      candidateDigest: digest.rows[0].digest,
    })
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
      route: 'USD3',
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
  const secondaryUrl =
    process.env.CARRY_EXIT_V2_VERIFY_RPC_URL || get('CARRY_EXIT_V2_VERIFY_RPC_URL') || SECOND_ORIGIN
  if (!dbUrl || !rpcUrls) {
    process.stderr.write('carry_sync_vault_exit_v2_gate_configuration_missing\n')
    process.exitCode = 1
  } else {
    runSyncVaultRollbackGate({ dbUrl, rpcUrls, secondaryUrl })
      .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch((error) => {
        const known = new Set([
          'frozen_route_unavailable',
          'candidate_discovery_unavailable',
          'secondary_origin_not_independent',
          'ladder_invalid',
          'positive_q_unavailable',
          'inconclusive_q_unavailable',
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
        process.stderr.write(`carry_sync_vault_exit_v2_gate_${code}\n`)
        process.exitCode = 1
      })
  }
}
