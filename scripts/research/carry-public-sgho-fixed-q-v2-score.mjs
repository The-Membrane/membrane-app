// Independent fixed-Q future replay and recovery labels for sGHO holders.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { selectCarryExitV2FirstFinalizedBlock } from '../lib/carry-exit-v2-block-auditor.mjs'
import { measureCarryExitV2Verified } from '../lib/carry-exit-v2-verified-measurement.mjs'
import { validateCarryExitV2RpcProof } from '../lib/carry-exit-v2-rpc-proof.mjs'
import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls } from './carry-public-direct-exit-issue.mjs'
import { OUT as V1_OUT, verifySghoIssues } from './carry-public-sgho-exit-issue.mjs'
import {
  OUT as ISSUE_OUT,
  FIXED_Q_RAW,
  verifySghoFixedQIssues,
} from './carry-public-sgho-fixed-q-v2-issue.mjs'
import {
  BLOCK_HASH,
  DECIMAL,
  HASH,
  ROUTE,
  appendNumbered,
  readNumbered,
  rotatingSghoOriginPairs,
  sha,
  utc,
  verifySghoMeasurement,
} from './carry-public-sgho-exit-common.mjs'
import {
  confirmStusdsDeadlinePassed,
  validStusdsDeadlineWitness,
} from './carry-public-stusds-exit-score.mjs'

export const STUDY = 'carry_public_sgho_fixed_q_score_v2'
export const OUT = resolve('data/research/venue-signals/carry-public-sgho-fixed-q-v2-scores')

export function classifySghoFixedQOutcome(decoded) {
  if (decoded?.routeKind !== 'sgho') throw Error('sgho_fixed_q_kind_invalid')
  if (decoded.simulationStatus === 'success') {
    if (!DECIMAL.test(decoded.actualConsumedRaw ?? '') || BigInt(decoded.actualConsumedRaw) === 0n)
      throw Error('sgho_fixed_q_burn_missing')
    return 'simulated_withdraw_success'
  }
  if (decoded.simulationStatus !== 'evm_revert') throw Error('sgho_fixed_q_status_invalid')
  if (BigInt(decoded.holderCoverageRaw) === 0n) return 'holder_shares_zero'
  if (BigInt(decoded.requiredCoverageRaw) > BigInt(decoded.holderCoverageRaw))
    return 'preview_share_gap'
  if (decoded.coveredRevert) return 'withdraw_revert_cause_unknown'
  throw Error('sgho_fixed_q_revert_unclassified')
}

export function classifySghoFixedQTransition(baselineStatus, outcome) {
  if (baselineStatus === 'success')
    return outcome === 'simulated_withdraw_success'
      ? 'remained_exitable'
      : ['holder_shares_zero', 'preview_share_gap'].includes(outcome)
        ? 'holder_attrition'
        : 'lost_exitability'
  if (baselineStatus === 'covered_revert')
    return outcome === 'simulated_withdraw_success'
      ? 'simulated_recovery'
      : ['holder_shares_zero', 'preview_share_gap'].includes(outcome)
        ? 'holder_attrition'
        : 'still_reverting'
  throw Error('sgho_fixed_q_baseline_invalid')
}

function validateTarget(parent, plan, target) {
  const doc = target?.canonicalityEvidenceDoc
  if (
    !DECIMAL.test(target?.targetBlock ?? '') ||
    !BLOCK_HASH.test(target?.targetHash ?? '') ||
    !BLOCK_HASH.test(target?.targetParentHash ?? '') ||
    doc?.schema !== 'carry_exit_v2_headers_v1' ||
    doc.chainId !== '1' ||
    doc.finalityTag !== 'finalized' ||
    doc.source !== STUDY ||
    doc.targetAt !== plan.targetAtUtc ||
    doc.baselineHeader?.number !== parent.baseline.targetBlock ||
    doc.baselineHeader?.hash !== parent.baseline.targetHash ||
    doc.targetHeader?.number !== target.targetBlock ||
    doc.targetHeader?.hash !== target.targetHash ||
    doc.targetHeader?.timestamp !== target.targetBlockAt ||
    doc.targetHeader?.parentHash !== target.targetParentHash ||
    doc.parentHeader?.number !== target.targetParentBlock ||
    doc.parentHeader?.hash !== target.targetParentHash ||
    doc.parentHeader?.timestamp !== target.targetParentBlockAt ||
    doc.observedAt !== target.targetObservedAt ||
    !DECIMAL.test(doc.finalizedHead?.number ?? '') ||
    BigInt(doc.finalizedHead.number) < BigInt(target.targetBlock) ||
    BigInt(target.targetBlock) <= BigInt(parent.baseline.targetBlock) ||
    BigInt(target.targetBlock) !== BigInt(target.targetParentBlock) + 1n ||
    utc(target.targetParentBlockAt) >= utc(plan.targetAtUtc) ||
    utc(target.targetBlockAt) < utc(plan.targetAtUtc) ||
    utc(target.targetBlockAt) > utc(plan.captureDeadlineUtc) ||
    utc(target.targetObservedAt) < utc(target.targetBlockAt)
  )
    throw Error('sgho_fixed_q_target_invalid')
}

export function validateSghoFixedQScore(score, issues, parents) {
  const issue = issues[score?.issueSequence - 1]
  const parent = issue && parents[issue.v1IssueSequence - 1]
  const plan = issue?.targets.find((entry) => entry.horizonHours === score.horizonHours)
  if (
    !issue ||
    !parent ||
    !plan ||
    score.study !== STUDY ||
    !Number.isSafeInteger(score.sequence) ||
    score.sequence < 1 ||
    (score.sequence === 1
      ? score.previousSha256 !== null
      : !HASH.test(score.previousSha256 ?? '')) ||
    score.issueSha256 !== issue.sha256 ||
    score.routeKey !== ROUTE.routeKey ||
    score.destination !== ROUTE.destination ||
    score.originalAsset !== ROUTE.asset ||
    score.holder !== issue.holder ||
    score.assetsRaw !== FIXED_Q_RAW ||
    score.targetAtUtc !== plan.targetAtUtc ||
    score.captureDeadlineUtc !== plan.captureDeadlineUtc
  )
    throw Error('sgho_fixed_q_score_binding_invalid')
  const scored = utc(score.scoredAtUtc)
  if (scored < utc(plan.targetAtUtc)) throw Error('sgho_fixed_q_score_clock_invalid')
  if (score.status === 'censored') {
    if (
      score.target !== null ||
      score.measurement !== null ||
      score.outcome !== null ||
      score.transition !== 'censored' ||
      scored <= utc(plan.captureDeadlineUtc) ||
      !validStusdsDeadlineWitness(score.deadlineWitness, plan.captureDeadlineUtc) ||
      scored < utc(score.deadlineWitness.atUtc)
    )
      throw Error('sgho_fixed_q_censor_invalid')
    return score
  }
  if (
    score.status !== 'measured' ||
    score.deadlineWitness !== null ||
    scored > utc(plan.captureDeadlineUtc)
  )
    throw Error('sgho_fixed_q_score_status_invalid')
  validateTarget(parent, plan, score.target)
  if (utc(score.target.targetObservedAt) > scored)
    throw Error('sgho_fixed_q_score_target_after_record')
  const decoded = verifySghoMeasurement({
    holder: issue.holder,
    assetsRaw: FIXED_Q_RAW,
    blockNumber: score.target.targetBlock,
    blockHash: score.target.targetHash,
    blockAtUtc: score.target.targetBlockAt,
    source: STUDY,
    measurement: score.measurement,
    beforeAtUtc: score.target.targetBlockAt,
    afterAtUtc: score.scoredAtUtc,
  })
  const evidence = score.measurement.evidence
  if (
    evidence.identityEvidence.provider !== score.target.canonicalityEvidenceDoc.provider ||
    utc(evidence.replayEvidenceDoc.observedAt) > utc(plan.captureDeadlineUtc)
  )
    throw Error('sgho_fixed_q_score_source_invalid')
  for (const origin of ['primary', 'secondary'])
    for (const phase of ['before', 'after']) {
      const header = evidence.replayEvidenceDoc.headers?.[origin]?.[phase]?.target
      if (
        header?.hash !== score.target.targetHash ||
        header?.parentHash !== score.target.targetParentHash ||
        new Date(Number(BigInt(header?.timestamp ?? -1)) * 1000).toISOString() !==
          score.target.targetBlockAt
      )
        throw Error('sgho_fixed_q_score_header_invalid')
    }
  const outcome = classifySghoFixedQOutcome(decoded)
  if (
    score.outcome !== outcome ||
    score.transition !== classifySghoFixedQTransition(issue.baselineStatus, outcome)
  )
    throw Error('sgho_fixed_q_score_outcome_invalid')
  return score
}

export function buildSghoFixedQScore({
  issue,
  issues,
  parents,
  horizonHours,
  target,
  measurement,
  deadlineWitness = null,
  scoredAtUtc,
  sequence,
  previousSha256,
}) {
  const plan = issue.targets.find((entry) => entry.horizonHours === horizonHours)
  if (!plan) throw Error('sgho_fixed_q_horizon_invalid')
  const censored = target === null
  if (censored !== (measurement === null)) throw Error('sgho_fixed_q_measurement_missing')
  const decoded = censored
    ? null
    : verifySghoMeasurement({
        holder: issue.holder,
        assetsRaw: FIXED_Q_RAW,
        blockNumber: target.targetBlock,
        blockHash: target.targetHash,
        blockAtUtc: target.targetBlockAt,
        source: STUDY,
        measurement,
        beforeAtUtc: target.targetBlockAt,
        afterAtUtc: scoredAtUtc,
      })
  const outcome = decoded ? classifySghoFixedQOutcome(decoded) : null
  const payload = {
    study: STUDY,
    sequence,
    previousSha256,
    issueSequence: issue.sequence,
    issueSha256: issue.sha256,
    routeKey: ROUTE.routeKey,
    destination: ROUTE.destination,
    originalAsset: ROUTE.asset,
    holder: issue.holder,
    assetsRaw: FIXED_Q_RAW,
    horizonHours,
    targetAtUtc: plan.targetAtUtc,
    captureDeadlineUtc: plan.captureDeadlineUtc,
    scoredAtUtc,
    status: censored ? 'censored' : 'measured',
    target,
    measurement,
    deadlineWitness,
    outcome,
    transition: decoded ? classifySghoFixedQTransition(issue.baselineStatus, outcome) : 'censored',
  }
  validateSghoFixedQScore(payload, issues, parents)
  return { ...payload, sha256: sha(JSON.stringify(payload)) }
}

export async function verifySghoFixedQScores(out = OUT, issueOut = ISSUE_OUT, v1Out = V1_OUT) {
  const [issues, parents] = await Promise.all([
    verifySghoFixedQIssues(issueOut, v1Out),
    verifySghoIssues(v1Out),
  ])
  const rows = await readNumbered(out)
  const seen = new Set()
  for (const row of rows) {
    validateSghoFixedQScore(row, issues, parents)
    const key = `${row.issueSequence}:${row.horizonHours}`
    if (seen.has(key)) throw Error('sgho_fixed_q_duplicate_target')
    seen.add(key)
  }
  return rows
}

export async function appendSghoFixedQScore(
  row,
  out = OUT,
  issueOut = ISSUE_OUT,
  v1Out = V1_OUT,
  stat,
  options,
) {
  const [issues, parents, prior] = await Promise.all([
    verifySghoFixedQIssues(issueOut, v1Out),
    verifySghoIssues(v1Out),
    verifySghoFixedQScores(out, issueOut, v1Out),
  ])
  validateSghoFixedQScore(row, issues, parents)
  if (
    prior.some(
      (entry) =>
        entry.issueSequence === row.issueSequence && entry.horizonHours === row.horizonHours,
    )
  )
    throw Error('sgho_fixed_q_duplicate_target')
  return appendNumbered(
    row,
    out,
    (path) => verifySghoFixedQScores(path, issueOut, v1Out),
    stat,
    options,
  )
}

async function selectTarget(parent, plan, pair, select, now) {
  const request = (client) =>
    select({
      targetAt: plan.targetAtUtc,
      baselineBlock: parent.baseline.targetBlock,
      baselineHash: parent.baseline.targetHash,
      provider: client.provider,
      source: STUDY,
      request: client.request.bind(client),
      now,
    })
  const [a, b] = await Promise.all(pair.map(request))
  if (
    a.targetBlock !== b.targetBlock ||
    a.targetHash !== b.targetHash ||
    a.targetBlockAt !== b.targetBlockAt ||
    a.targetParentHash !== b.targetParentHash ||
    a.targetParentBlockAt !== b.targetParentBlockAt
  )
    throw Error('sgho_fixed_q_origin_disagreement')
  return a
}

async function measureFuture(issue, target, pair, now) {
  const verified = await measureCarryExitV2Verified({
    ...ROUTE,
    holder: issue.holder,
    assetsRaw: FIXED_Q_RAW,
    target,
    provider: pair[0].provider,
    source: STUDY,
    send: pair[0].send,
    primary: { url: pair[0].url, request: pair[0].send },
    secondary: { url: pair[1].url, request: pair[1].send },
    now,
  })
  if (verified.status !== 'verified') throw Error('sgho_fixed_q_future_unavailable')
  const evidence = verified.callEvidenceDoc
  const decoded = validateCarryExitV2RpcProof({
    proof: evidence,
    ...ROUTE,
    holder: issue.holder,
    assetsRaw: FIXED_Q_RAW,
    blockNumber: target.targetBlock,
    blockHash: target.targetHash,
  })
  return {
    simulationStatus: decoded.simulationStatus,
    holderSharesRaw: decoded.holderCoverageRaw,
    previewWithdrawSharesRaw: decoded.requiredCoverageRaw,
    burnedSharesRaw: decoded.actualConsumedRaw,
    coveredRevert: decoded.coveredRevert,
    evidence,
    evidenceSha256: sha(JSON.stringify(evidence)),
  }
}

export async function scoreSghoFixedQ({
  issueSequence,
  horizonHours,
  originPairs,
  out = OUT,
  issueOut = ISSUE_OUT,
  v1Out = V1_OUT,
  now = () => new Date(),
  select = selectCarryExitV2FirstFinalizedBlock,
  measure = measureFuture,
  confirmDeadline = confirmStusdsDeadlinePassed,
  loadIssues = verifySghoFixedQIssues,
  loadParents = verifySghoIssues,
  loadScores = verifySghoFixedQScores,
  append = appendSghoFixedQScore,
}) {
  const [issues, parents, prior] = await Promise.all([
    loadIssues(issueOut, v1Out),
    loadParents(v1Out),
    loadScores(out, issueOut, v1Out),
  ])
  const issue = issues[issueSequence - 1]
  const parent = issue && parents[issue.v1IssueSequence - 1]
  const plan = issue?.targets.find((entry) => entry.horizonHours === horizonHours)
  if (!issue || !parent || !plan) throw Error('sgho_fixed_q_unknown_issue_or_horizon')
  if (now().getTime() < utc(plan.targetAtUtc)) return { status: 'not_due' }
  if (prior.some((row) => row.issueSequence === issueSequence && row.horizonHours === horizonHours))
    return { status: 'already_scored' }
  if (!Array.isArray(originPairs) || !originPairs.length || originPairs.length > 24)
    throw Error('sgho_fixed_q_two_origins_required')
  const pairs = originPairs.filter(
    (pair) =>
      pair?.length === 2 &&
      pair[0]?.provider &&
      pair[1]?.provider &&
      pair[0].provider !== pair[1].provider,
  )
  if (!pairs.length) throw Error('sgho_fixed_q_two_origins_required')
  const deadline = utc(plan.captureDeadlineUtc)
  let target = null
  let measurement = null
  if (now().getTime() <= deadline) {
    for (const pair of pairs) {
      try {
        const selected = await selectTarget(parent, plan, pair, select, now)
        const measured = await measure(issue, selected, pair, now)
        if (now().getTime() > deadline) break
        target = selected
        measurement = measured
        break
      } catch {
        /* Retry an independent origin pair while the window is open. */
      }
    }
  }
  let deadlineWitness = null
  if (!target) {
    if (now().getTime() <= deadline) return { status: 'retry_replay_unavailable' }
    deadlineWitness = await confirmDeadline(pairs, deadline)
    if (!deadlineWitness) return { status: 'retry_deadline_witness_unavailable' }
  }
  const scoredAtUtc = now().toISOString()
  if (target && utc(scoredAtUtc) > deadline) return { status: 'retry_deadline_witness_unavailable' }
  const row = buildSghoFixedQScore({
    issue,
    issues,
    parents,
    horizonHours,
    target,
    measurement,
    deadlineWitness,
    scoredAtUtc,
    sequence: prior.length + 1,
    previousSha256: prior.at(-1)?.sha256 ?? null,
  })
  return { status: 'scored', ...(await append(row, out, issueOut, v1Out)) }
}

async function cli() {
  const [mode, issueRaw, horizonRaw] = process.argv.slice(2)
  if (mode === '--verify') {
    const scores = await verifySghoFixedQScores()
    process.stdout.write(
      `${JSON.stringify({ status: 'verified_local_chain', scores: scores.length })}\n`,
    )
    return
  }
  if (mode !== '--score' || !DECIMAL.test(issueRaw ?? '') || !DECIMAL.test(horizonRaw ?? ''))
    throw Error('sgho_fixed_q_score_usage')
  const originPairs = rotatingSghoOriginPairs(configuredPublicRpcUrls(readEnv()))
  process.stdout.write(
    `${JSON.stringify(
      await scoreSghoFixedQ({
        issueSequence: Number(issueRaw),
        horizonHours: Number(horizonRaw),
        originPairs,
      }),
    )}\n`,
  )
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  cli().catch(() => {
    process.stderr.write('public_sgho_fixed_q_score_failed\n')
    process.exitCode = 1
  })
