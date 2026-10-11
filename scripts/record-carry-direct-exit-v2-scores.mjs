// Prospective outcomes for the three frozen direct supplier positions. A
// successful Comet borrow is not a supplier exit when pinned balance is < Q.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { neon } from '@neondatabase/serverless'

import { readEnv } from './lib/venue-reads.mjs'
import {
  resolveCarryExitV2Route,
  validateCarryExitV2RpcProof,
} from './lib/carry-exit-v2-rpc-proof.mjs'
import { prepareCarryExitV2Control } from './lib/carry-exit-v2-scorer.mjs'
import {
  exactUtcMicros,
  selectCarryExitV2FirstFinalizedBlock,
} from './lib/carry-exit-v2-block-auditor.mjs'
import { measureCarryExitV2Verified } from './lib/carry-exit-v2-verified-measurement.mjs'
import { configuredRpcUrls, rpcTransport } from './record-carry-morpho-exit-v2-issues.mjs'
import { readPriorMorphoScores, writeMorphoScore } from './record-carry-morpho-exit-v2-scores.mjs'
import {
  probeMorphoMissingCapture,
  readMorphoMissingReceipt,
  writeMorphoMissingReceipt,
} from './record-carry-morpho-exit-v2-missing.mjs'

const LIMIT = 48
const BUDGET_MS = 10 * 60_000
const SOURCE = 'carry_exit_v2_direct_score'
const MISSING_SOURCE = 'carry_exit_v2_direct_missing'
const ADDRESS = /^0x[0-9a-f]{40}$/
const KINDS = new Set(['aave', 'spark', 'comet'])
const time = (value) => exactUtcMicros(value)
const detail = (error) => error?.code ?? 'unavailable'

async function committed(writeScore, row) {
  try {
    return await writeScore(row)
  } catch {
    const failure = Error('score_write_failed')
    failure.fatal = true
    throw failure
  }
}

/** The due view keeps every predeclared Q/horizon denominator. */
export async function readDueDirectScores(sql, limit = LIMIT) {
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT) throw Error('score_limit_invalid')
  return sql`SELECT d.batch_id::text AS "batchId", d.case_id::text AS "caseId",
      d.horizon_h AS "horizonH", d.issued_at_exact AS "issuedAt",
      d.target_at_exact AS "targetAt", d.deadline_at_exact AS "deadlineAt",
      b.route_key AS "routeKey", b.destination, b.asset, b.holder,
      b.baseline_block::text AS "baselineBlock", b.baseline_hash AS "baselineHash",
      to_char(b.baseline_block_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "baselineBlockAt",
      c.assets_raw::text AS "assetsRaw", c.baseline_status AS "baselineStatus",
      p.predecessor_h AS "predecessorH", p.conditional_recovery AS "conditionalRecovery"
    FROM carry_exit_v2_due d
      JOIN carry_exit_v2_cases c ON c.id = d.case_id
      JOIN carry_exit_v2_batches b ON b.id = d.batch_id
      JOIN carry_exit_v2_plans p ON p.case_id = d.case_id AND p.horizon_h = d.horizon_h
    WHERE d.target_at_exact::timestamptz <= clock_timestamp()
      AND b.route_key IN ('USDC → supply on Aave V3',
        'USDC → supply on Compound v3', 'USDT → supply on Spark')
      AND (d.horizon_h = 1 OR EXISTS (
        SELECT 1 FROM carry_exit_v2_scores preceding
        WHERE preceding.case_id = d.case_id AND preceding.horizon_h = p.predecessor_h
      ))
      AND (p.deadline_at >= clock_timestamp() OR
        c.baseline_status IN ('ineligible','inconclusive','unavailable') OR
        EXISTS (SELECT 1 FROM carry_exit_v2_missing_receipts m
          WHERE m.case_id = d.case_id AND m.horizon_h = d.horizon_h))
    ORDER BY (p.deadline_at < clock_timestamp()), p.deadline_at, d.case_id
    LIMIT ${limit}`
}

export async function readDirectPendingScoreAudit(sql) {
  const rows = await sql`SELECT
      count(*) FILTER (WHERE measurement_eligible AND deadline_at < clock_timestamp())::int
        AS "expiredEligiblePending",
      count(*) FILTER (WHERE measurement_eligible AND deadline_at >= clock_timestamp())::int
        AS "liveEligiblePending",
      count(*) FILTER (WHERE NOT measurement_eligible)::int AS "controlOrCensoredPending"
    FROM carry_exit_v2_coverage
    WHERE status = 'pending' AND route_key IN (
      'USDC → supply on Aave V3', 'USDC → supply on Compound v3',
      'USDT → supply on Spark')`
  return rows[0]
}

function frozen(row) {
  if (
    !ADDRESS.test(row.destination ?? '') ||
    !ADDRESS.test(row.asset ?? '') ||
    !ADDRESS.test(row.holder ?? '') ||
    !KINDS.has(resolveCarryExitV2Route(row.routeKey, row.destination, row.asset).kind)
  )
    throw Error('non_direct_frozen_route')
  return {
    batch: {
      id: row.batchId,
      issuedAt: row.issuedAt,
      routeKey: row.routeKey,
      destination: row.destination,
      asset: row.asset,
      holder: row.holder,
      baselineBlock: row.baselineBlock,
      baselineHash: row.baselineHash,
      baselineBlockAt: row.baselineBlockAt,
    },
    caseRow: {
      id: row.caseId,
      batchId: row.batchId,
      assetsRaw: row.assetsRaw,
      baselineStatus: row.baselineStatus,
    },
    plan: {
      caseId: row.caseId,
      horizonH: row.horizonH,
      predecessorH: row.predecessorH,
      conditionalRecovery: row.conditionalRecovery,
      targetAt: row.targetAt,
      deadlineAt: row.deadlineAt,
    },
  }
}

function entitlementProof(call, method = 'exact_asset_balance') {
  return {
    ...call,
    purpose: 'entitlement',
    withdrawRpc: null,
    actualConsumedRaw: null,
    simulationStatus: null,
    entitlementMethod: method,
    inconclusiveReason: null,
  }
}

/** Classification requires the independent verified exact holder/Q proof. */
export function classifyDirectScore({ core, target, verified, row, capturedAt }) {
  if (verified?.status !== 'verified' || !verified.callEvidenceDoc)
    throw Error('independent_measurement_required')
  const call = verified.callEvidenceDoc
  const decoded = validateCarryExitV2RpcProof({
    proof: call,
    routeKey: row.routeKey,
    destination: row.destination,
    asset: row.asset,
    holder: row.holder,
    assetsRaw: row.assetsRaw,
    blockNumber: target.targetBlock,
    blockHash: target.targetHash,
  })
  if (
    !KINDS.has(decoded.routeKind) ||
    call.verificationStatus !== 'verified' ||
    !call.replayEvidenceDoc
  )
    throw Error('direct_replay_required')
  const q = BigInt(row.assetsRaw)
  if (decoded.requiredCoverageRaw !== row.assetsRaw) throw Error('direct_coverage_mismatch')
  const base = {
    ...core,
    ...target,
    capturedAt,
    coverageKind: 'assets',
    holderCoverageRaw: decoded.holderCoverageRaw,
    requiredCoverageRaw: row.assetsRaw,
    actualConsumedRaw: null,
    simulationStatus: null,
    callEvidenceDoc: null,
    entitlementMethod: null,
    entitlementEvidenceDoc: null,
    inconclusiveReason: null,
    missingReason: null,
    missingReceiptId: null,
  }
  const balance = BigInt(decoded.holderCoverageRaw)
  if (balance < q)
    return {
      ...base,
      status: 'holder_attrition',
      entitlementMethod: 'exact_asset_balance',
      entitlementEvidenceDoc: entitlementProof(call),
    }
  if (decoded.simulationStatus === 'success')
    return {
      ...base,
      status: 'success',
      simulationStatus: 'success',
      callEvidenceDoc: call,
    }
  if (decoded.simulationStatus === 'evm_revert' && decoded.coveredRevert)
    return {
      ...base,
      status: 'covered_revert',
      simulationStatus: 'evm_revert',
      callEvidenceDoc: call,
    }
  if (decoded.simulationStatus === 'evm_revert')
    return {
      ...base,
      status: 'inconclusive',
      simulationStatus: 'evm_revert',
      callEvidenceDoc: { ...call, inconclusiveReason: 'ambiguous_revert' },
      entitlementEvidenceDoc: {
        ...entitlementProof(call, null),
        simulationStatus: 'evm_revert',
        inconclusiveReason: 'ambiguous_revert',
      },
      inconclusiveReason: 'ambiguous_revert',
    }
  throw Error('unclassifiable_measurement')
}

export async function scoreDirectDue({
  readDue,
  readPrior,
  chooseTarget,
  measure,
  writeScore,
  readMissing = null,
  probeMissing = null,
  writeMissing = null,
  auditPending = null,
  now = () => new Date(),
  limit = LIMIT,
  budgetMs = BUDGET_MS,
}) {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > LIMIT ||
    !Number.isInteger(budgetMs) ||
    budgetMs < 1 ||
    budgetMs > BUDGET_MS
  )
    throw Error('score_budget_invalid')
  const started = Date.now()
  const due = await readDue(limit)
  if (!Array.isArray(due) || due.length > limit) throw Error('score_due_scan_invalid')
  const counts = {}
  const count = (name) => {
    counts[name] = (counts[name] ?? 0) + 1
  }
  for (const row of due) {
    if (Date.now() - started >= budgetMs) {
      count('budget_exhausted')
      break
    }
    try {
      const { batch, caseRow, plan } = frozen(row)
      const priorScores = await readPrior(row.caseId, Number(row.horizonH))
      const prepared = prepareCarryExitV2Control({ batch, caseRow, plan, priorScores })
      if (prepared.kind === 'control') {
        if (time(now().toISOString()) <= time(row.deadlineAt)) {
          count('control_wait')
          continue
        }
        count((await committed(writeScore, prepared.row)) ? prepared.row.status : 'already_scored')
        continue
      }
      if (time(now().toISOString()) > time(row.deadlineAt)) {
        const receipt = readMissing ? await readMissing(row.caseId, Number(row.horizonH)) : null
        if (!receipt) {
          count('missing_receipt_required')
          continue
        }
        const missing = {
          ...prepared.core,
          status: 'missing',
          missingReason: receipt.missingReason,
          missingReceiptId: receipt.id,
        }
        count((await committed(writeScore, missing)) ? 'missing' : 'already_scored')
        continue
      }
      let target
      try {
        target = await chooseTarget(row)
      } catch (error) {
        if (detail(error) === 'rpc_unavailable' && probeMissing && writeMissing) {
          const evidence = await probeMissing(row)
          if (evidence) await committed(writeMissing, evidence)
        }
        count(detail(error) === 'target_not_finalized' ? 'await_finality' : 'score_unavailable')
        continue
      }
      if (time(target.targetObservedAt) > time(row.deadlineAt)) {
        count('missing_receipt_required')
        continue
      }
      const verified = await measure(row, target)
      if (verified.status !== 'verified') {
        if (probeMissing && writeMissing) {
          const evidence = await probeMissing(row)
          if (evidence) await committed(writeMissing, evidence)
        }
        count('missing_receipt_required')
        continue
      }
      const capturedAt = now().toISOString()
      if (time(capturedAt) > time(row.deadlineAt)) {
        count('missing_receipt_required')
        continue
      }
      const score = classifyDirectScore({ core: prepared.core, target, verified, row, capturedAt })
      count((await committed(writeScore, score)) ? score.status : 'already_scored')
    } catch (error) {
      if (error?.fatal) throw error
      count(detail(error) === 'target_not_finalized' ? 'await_finality' : 'score_unavailable')
    }
  }
  return {
    scanned: due.length,
    counts,
    pending: auditPending ? await auditPending() : null,
    forecastValidated: false,
  }
}

function twoOrigins(urls) {
  const clients = urls.map((url) => rpcTransport(url))
  const host = (client) => new URL(client.url).hostname.replace(/^www\./, '')
  const primary = clients[0]
  const secondary = clients.find((client) => host(client) !== host(primary))
  if (!secondary) throw Error('independent_origin_missing')
  return { primary, secondary }
}

async function main() {
  if (process.argv.length !== 2) throw Error('usage: no arguments')
  const { get } = readEnv()
  const db =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  if (!db) throw Error('score_database_missing')
  const rawUrls =
    process.env.RECORDER_RPC_URLS ||
    process.env.RECORDER_RPC_URL ||
    get('RECORDER_RPC_URLS') ||
    get('RECORDER_RPC_URL')
  const urls = configuredRpcUrls(rawUrls)
  const { primary, secondary } = twoOrigins(urls)
  const sql = neon(db, { fetchOptions: { signal: AbortSignal.timeout(15_000) } })
  const targetCache = new Map()
  return scoreDirectDue({
    readDue: (limit) => readDueDirectScores(sql, limit),
    readPrior: (caseId, horizon) => readPriorMorphoScores(sql, caseId, horizon),
    writeScore: (row) => writeMorphoScore(sql, row),
    readMissing: (caseId, horizon) => readMorphoMissingReceipt(sql, caseId, horizon),
    probeMissing: async (row) => {
      const receipt = await probeMorphoMissingCapture({ row, primary, secondary })
      return (
        receipt && {
          ...receipt,
          evidenceDoc: { ...receipt.evidenceDoc, source: MISSING_SOURCE },
          verifierDoc: { ...receipt.verifierDoc, source: MISSING_SOURCE },
        }
      )
    },
    writeMissing: (receipt) => writeMorphoMissingReceipt(sql, receipt),
    auditPending: () => readDirectPendingScoreAudit(sql),
    chooseTarget: (row) => {
      const key = `${row.batchId}:${row.horizonH}`
      if (!targetCache.has(key))
        targetCache.set(
          key,
          selectCarryExitV2FirstFinalizedBlock({
            targetAt: row.targetAt,
            baselineBlock: row.baselineBlock,
            baselineHash: row.baselineHash,
            provider: primary.provider,
            source: SOURCE,
            request: (method, params) => primary.request(method, params),
          }),
        )
      return targetCache.get(key)
    },
    measure: (row, target) =>
      measureCarryExitV2Verified({
        routeKey: row.routeKey,
        destination: row.destination,
        asset: row.asset,
        holder: row.holder,
        assetsRaw: row.assetsRaw,
        target,
        provider: primary.provider,
        source: SOURCE,
        send: (envelope) => primary.send(envelope),
        primary: { url: primary.url, request: (envelope) => primary.send(envelope) },
        secondary: { url: secondary.url, request: (envelope) => secondary.send(envelope) },
      }),
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => {
      process.stderr.write('carry_exit_v2_direct_score_failed\n')
      process.exitCode = 1
    })
}
