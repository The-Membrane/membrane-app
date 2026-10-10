// Scores the first finalized horizon block for the same owner and whole pending
// amount. Simulated unstake is executability evidence, never a mined payout.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { selectCarryExitV2FirstFinalizedBlock } from '../lib/carry-exit-v2-block-auditor.mjs'
import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import { OUT as ISSUE_OUT, verifyIssues } from './susde-public-pending-exit-issue.mjs'
import {
  DECIMAL,
  HASH,
  ROUTE_KEY,
  SILO,
  USDE,
  VAULT,
  appendLedger,
  measureTwoOrigins,
  numberHex,
  publicOriginPairs,
  readLedger,
  seal,
  utc,
  validatePendingMeasurement,
} from './susde-public-pending-exit-common.mjs'

export const STUDY = 'susde_public_pending_exit_score_v1'
export const OUT = resolve('data/research/venue-signals/susde-public-pending-exit-scores')

export function classifyPendingOutcome(issue, measurement) {
  if (
    measurement.holder !== issue.holder ||
    measurement.blockNumber === issue.anchor.blockNumber ||
    !DECIMAL.test(measurement.pendingAssetsRaw ?? '')
  )
    throw Error('susde_score_measurement_invalid')
  const pending = BigInt(measurement.pendingAssetsRaw)
  const original = BigInt(issue.pendingAssetsRaw)
  if (pending === 0n) return 'queue_absent_cause_unknown'
  if (pending < original) return 'queue_amount_changed_cause_unknown'
  if (pending > original || measurement.cooldownEndUtc !== issue.cooldownEndUtc)
    return 'queue_reset_or_replaced'
  if (measurement.claim === 'not_yet_eligible') return 'not_yet_eligible'
  if (measurement.claim === 'simulated_unstake_success')
    return 'simulated_whole_queue_unstake_success'
  if (measurement.claim === 'unstake_revert_cause_unknown') return 'unstake_revert_cause_unknown'
  throw Error('susde_score_claim_invalid')
}

export function validateScore(score, issues) {
  const issue = issues[score?.issueSequence - 1]
  const plan = issue?.targets.find((t) => t.horizonHours === score.horizonHours)
  if (
    !issue ||
    !plan ||
    score.study !== STUDY ||
    !Number.isSafeInteger(score.sequence) ||
    score.sequence < 1 ||
    score.issueSha256 !== issue.sha256 ||
    score.routeKey !== ROUTE_KEY ||
    score.vault !== VAULT ||
    score.originalAsset !== USDE ||
    score.silo !== SILO ||
    score.holder !== issue.holder ||
    score.pendingAssetsRaw !== issue.pendingAssetsRaw ||
    score.cooldownEndUtc !== issue.cooldownEndUtc ||
    score.targetAtUtc !== plan.targetAtUtc ||
    score.captureDeadlineUtc !== plan.captureDeadlineUtc ||
    score.minedDeliveryProven !== false
  )
    throw Error('susde_score_issue_binding_invalid')
  const scored = utc(score.scoredAtUtc)
  const onTime = scored <= utc(plan.captureDeadlineUtc)
  if (scored < utc(plan.targetAtUtc) || score.onTime !== onTime)
    throw Error('susde_score_time_invalid')
  if (!onTime) {
    if (
      score.outcome !== 'capture_window_missed' ||
      score.target !== null ||
      score.measurement !== null
    )
      throw Error('susde_score_late_invalid')
    return score
  }
  const target = score.target
  const doc = target?.canonicalityEvidenceDoc
  if (
    !target ||
    !DECIMAL.test(target.targetBlock ?? '') ||
    !HASH.test(target.targetHash ?? '') ||
    target.targetBlock !== score.measurement?.blockNumber ||
    target.targetHash !== score.measurement?.blockHash ||
    BigInt(target.targetBlock) <= BigInt(issue.anchor.blockNumber) ||
    doc?.schema !== 'carry_exit_v2_headers_v1' ||
    doc.chainId !== '1' ||
    doc.finalityTag !== 'finalized' ||
    doc.targetAt !== plan.targetAtUtc ||
    doc.baselineHeader?.hash !== issue.anchor.blockHash ||
    doc.baselineHeader?.number !== issue.anchor.blockNumber ||
    doc.targetHeader?.hash !== target.targetHash ||
    doc.targetHeader?.number !== target.targetBlock ||
    doc.targetHeader?.timestamp !== target.targetBlockAt ||
    doc.targetHeader?.parentHash !== target.targetParentHash ||
    doc.parentHeader?.number !== target.targetParentBlock ||
    doc.parentHeader?.hash !== target.targetParentHash ||
    doc.parentHeader?.timestamp !== target.targetParentBlockAt ||
    BigInt(target.targetBlock) !== BigInt(target.targetParentBlock) + 1n ||
    utc(target.targetParentBlockAt) >= utc(plan.targetAtUtc) ||
    doc.observedAt !== target.targetObservedAt ||
    utc(target.targetBlockAt) < utc(plan.targetAtUtc) ||
    utc(target.targetBlockAt) > utc(plan.captureDeadlineUtc) ||
    utc(target.targetObservedAt) < utc(target.targetBlockAt) ||
    utc(target.targetObservedAt) > scored ||
    utc(target.targetObservedAt) > utc(plan.captureDeadlineUtc) ||
    score.measurement?.readOnly !== true ||
    score.measurement?.minedDeliveryProven !== false ||
    score.measurement?.primaryProvider !== doc.provider ||
    score.measurement?.primaryProvider === score.measurement?.secondaryProvider ||
    score.outcome !== classifyPendingOutcome(issue, score.measurement)
  )
    throw Error('susde_score_target_invalid')
  validatePendingMeasurement(
    score.measurement,
    {
      blockNumber: target.targetBlock,
      blockHash: target.targetHash,
      blockAtUtc: target.targetBlockAt,
    },
    issue.holder,
  )
  return score
}

export function buildScore({
  issue,
  issues,
  horizonHours,
  target,
  measurement,
  scoredAtUtc,
  sequence,
  previousSha256,
}) {
  const plan = issue.targets.find((t) => t.horizonHours === horizonHours)
  if (!plan) throw Error('susde_score_horizon_invalid')
  const onTime = utc(scoredAtUtc) <= utc(plan.captureDeadlineUtc)
  if (!onTime && (target || measurement)) throw Error('susde_score_late_measurement_forbidden')
  if (onTime && (!target || !measurement)) throw Error('susde_score_ontime_missing')
  const body = {
    study: STUDY,
    sequence,
    previousSha256,
    issueSequence: issue.sequence,
    issueSha256: issue.sha256,
    routeKey: ROUTE_KEY,
    vault: VAULT,
    originalAsset: USDE,
    silo: SILO,
    holder: issue.holder,
    pendingAssetsRaw: issue.pendingAssetsRaw,
    cooldownEndUtc: issue.cooldownEndUtc,
    horizonHours,
    targetAtUtc: plan.targetAtUtc,
    captureDeadlineUtc: plan.captureDeadlineUtc,
    scoredAtUtc,
    onTime,
    target,
    measurement,
    outcome: onTime ? classifyPendingOutcome(issue, measurement) : 'capture_window_missed',
    minedDeliveryProven: false,
  }
  validateScore(body, issues)
  return seal(body)
}

export async function verifyScores(out = OUT, issueOut = ISSUE_OUT) {
  const [scores, issues] = await Promise.all([readLedger(out), verifyIssues(issueOut)])
  scores.forEach((score) => validateScore(score, issues))
  const pairs = new Set()
  for (const row of scores) {
    const key = `${row.issueSequence}:${row.horizonHours}`
    if (pairs.has(key)) throw Error('susde_duplicate_score')
    pairs.add(key)
  }
  return scores
}

export async function scorePending({
  issueSequence,
  horizonHours,
  urls,
  out = OUT,
  issueOut = ISSUE_OUT,
  now = () => new Date(),
  clients = publicRpcClients,
  select = selectCarryExitV2FirstFinalizedBlock,
} = {}) {
  const issues = await verifyIssues(issueOut)
  const issue = issues[issueSequence - 1]
  const plan = issue?.targets.find((t) => t.horizonHours === horizonHours)
  if (!issue || !plan) throw Error('susde_score_plan_unknown')
  const scores = await verifyScores(out, issueOut)
  if (scores.some((s) => s.issueSequence === issueSequence && s.horizonHours === horizonHours))
    throw Error('susde_score_already_recorded')
  const write = async (target, measurement) => {
    const score = buildScore({
      issue,
      issues,
      horizonHours,
      target,
      measurement,
      scoredAtUtc: now().toISOString(),
      sequence: scores.length + 1,
      previousSha256: scores.at(-1)?.sha256 ?? null,
    })
    await appendLedger(out, score, (directory) => verifyScores(directory, issueOut))
    return { sequence: score.sequence, outcome: score.outcome }
  }
  const at = now().toISOString()
  if (utc(at) < utc(plan.targetAtUtc)) throw Error('susde_score_not_due')
  if (utc(at) > utc(plan.captureDeadlineUtc)) return write(null, null)
  const failures = []
  for (const [primary, secondary] of publicOriginPairs(urls, clients)) {
    try {
      const target = await select({
        targetAt: plan.targetAtUtc,
        baselineBlock: issue.anchor.blockNumber,
        baselineHash: issue.anchor.blockHash,
        provider: primary.provider,
        source: STUDY,
        request: primary.request,
        now,
      })
      const block = await secondary.request('eth_getBlockByNumber', [
        numberHex(target.targetBlock),
        false,
      ])
      const finalized = await secondary.request('eth_getBlockByNumber', ['finalized', false])
      assertSecondaryFinalizedTarget(target, block, finalized)
      const earlierDisagreement = failures.find((message) =>
        /^susde_.*disagreement$/.test(message ?? ''),
      )
      if (earlierDisagreement) throw Error(earlierDisagreement)
      const measurement = await measureTwoOrigins(
        primary,
        secondary,
        {
          blockNumber: target.targetBlock,
          blockHash: target.targetHash,
          blockAtUtc: target.targetBlockAt,
        },
        issue.holder,
      )
      return write(target, measurement)
    } catch (error) {
      failures.push(error?.message)
    }
  }
  // A healthy origin's lag evidence survives unrelated RPC failures. An
  // origin disagreement or exhausted budget still takes precedence.
  const disagreement = failures.find((message) => /^susde_.*disagreement$/.test(message ?? ''))
  if (disagreement) throw Error(disagreement)
  if (failures.includes('susde_rpc_budget_exhausted')) throw Error('susde_rpc_budget_exhausted')
  if (
    failures.some((message) =>
      ['target_not_finalized', 'susde_score_target_not_finalized'].includes(message),
    )
  )
    throw Error('susde_score_target_not_finalized')
  throw Error('susde_score_rpc_unavailable')
}

export function assertSecondaryFinalizedTarget(target, block, finalized) {
  if (!block || !finalized?.number) throw Error('susde_score_rpc_unavailable')
  if (block.hash !== target.targetHash || block.parentHash !== target.targetParentHash)
    throw Error('susde_score_origin_target_disagreement')
  const finalizedNumber = BigInt(finalized.number)
  const targetNumber = BigInt(target.targetBlock)
  if (finalizedNumber < targetNumber) throw Error('susde_score_target_not_finalized')
  if (finalizedNumber === targetNumber && finalized.hash !== target.targetHash)
    throw Error('susde_score_origin_target_disagreement')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === '--verify')
      console.log(JSON.stringify({ verified: (await verifyScores()).length }))
    else if (process.argv[2] === '--score') {
      const sequence = Number(process.argv[3])
      const horizon = Number(process.argv[4])
      if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(horizon))
        throw Error('susde_score_usage')
      const result = await scorePending({
        issueSequence: sequence,
        horizonHours: horizon,
        urls: configuredPublicRpcUrls(readEnv()),
      })
      console.log(JSON.stringify(result))
    } else throw Error('susde_score_usage')
  } catch (error) {
    console.error(error?.message?.startsWith('susde_') ? error.message : 'susde_score_failed')
    process.exitCode = 1
  }
}
