// Future same-holder, same-USDS-Q sUSDS withdraw simulations, never mined delivery.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { selectCarryExitV2FirstFinalizedBlock } from '../lib/carry-exit-v2-block-auditor.mjs'
import { measureCarryExitV2Verified } from '../lib/carry-exit-v2-verified-measurement.mjs'
import { validateCarryExitV2RpcProof } from '../lib/carry-exit-v2-rpc-proof.mjs'
import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls } from './carry-public-direct-exit-issue.mjs'
import { OUT as ISSUE_OUT, verifySusdsIssues } from './carry-public-susds-exit-issue.mjs'
import {
  BLOCK_HASH,
  DECIMAL,
  HASH,
  ROUTE,
  appendNumbered,
  readNumbered,
  rotatingSusdsOriginPairs,
  sha,
  utc,
  verifySusdsMeasurement,
} from './carry-public-susds-exit-common.mjs'

export const STUDY = 'carry_public_susds_exit_score_v1'
export const OUT = resolve('data/research/venue-signals/carry-public-susds-exit-scores')

export function classifySusdsFutureOutcome(decoded) {
  if (decoded?.routeKind !== 'susds') throw Error('susds_score_kind_invalid')
  if (decoded.simulationStatus === 'success') {
    if (!DECIMAL.test(decoded.actualConsumedRaw ?? '') || BigInt(decoded.actualConsumedRaw) === 0n)
      throw Error('susds_score_burn_missing')
    return 'simulated_withdraw_success'
  }
  if (decoded.simulationStatus !== 'evm_revert') throw Error('susds_score_status_invalid')
  if (decoded.coveredRevert) return 'withdraw_revert_cause_unknown'
  if (BigInt(decoded.holderCoverageRaw) === 0n) return 'holder_shares_zero'
  if (BigInt(decoded.requiredCoverageRaw) > BigInt(decoded.holderCoverageRaw))
    return 'preview_share_gap'
  throw Error('susds_score_revert_unclassified')
}

function validateTarget(issue, plan, target) {
  if (target === null) return
  const doc = target?.canonicalityEvidenceDoc
  if (
    !DECIMAL.test(target?.targetBlock ?? '') ||
    !BLOCK_HASH.test(target?.targetHash ?? '') ||
    doc?.schema !== 'carry_exit_v2_headers_v1' ||
    doc.chainId !== '1' ||
    doc.finalityTag !== 'finalized' ||
    doc.targetAt !== plan.targetAtUtc ||
    doc.baselineHeader?.number !== issue.baseline.targetBlock ||
    doc.baselineHeader?.hash !== issue.baseline.targetHash ||
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
    BigInt(target.targetBlock) <= BigInt(issue.baseline.targetBlock) ||
    BigInt(target.targetBlock) !== BigInt(target.targetParentBlock) + 1n ||
    utc(target.targetParentBlockAt) >= utc(plan.targetAtUtc) ||
    utc(target.targetBlockAt) < utc(plan.targetAtUtc) ||
    utc(target.targetBlockAt) > utc(plan.captureDeadlineUtc) ||
    utc(target.targetObservedAt) < utc(target.targetBlockAt)
  )
    throw Error('susds_score_target_invalid')
}

export function validateSusdsScore(score, issues) {
  const issue = issues[score?.issueSequence - 1]
  const plan = issue?.targets.find((entry) => entry.horizonHours === score.horizonHours)
  if (
    !issue ||
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
    score.holder !== issue.candidate.holder ||
    score.targetAtUtc !== plan.targetAtUtc ||
    score.captureDeadlineUtc !== plan.captureDeadlineUtc ||
    !Array.isArray(score.cases) ||
    score.cases.length !== 6
  )
    throw Error('susds_score_issue_binding_invalid')
  const scored = utc(score.scoredAtUtc)
  const expectedOnTime = scored <= utc(plan.captureDeadlineUtc)
  if (scored < utc(plan.targetAtUtc) || score.onTime !== expectedOnTime)
    throw Error('susds_score_clock_invalid')
  validateTarget(issue, plan, score.target)
  if (score.onTime && score.target === null) throw Error('susds_score_ontime_target_missing')
  if (!score.onTime && score.target !== null) throw Error('susds_score_late_target_invalid')
  if (score.target && utc(score.target.targetObservedAt) > scored)
    throw Error('susds_score_target_after_record')
  for (const [index, row] of score.cases.entries()) {
    const original = issue.cases[index]
    if (row.label !== original.label || row.assetsRaw !== original.assetsRaw)
      throw Error('susds_score_q_binding_invalid')
    if (original.status !== 'measured' || original.measurement?.baselineStatus !== 'success') {
      if (
        row.status !== 'ineligible' ||
        row.reason !== 'baseline_not_success' ||
        row.outcome !== null ||
        row.measurement !== null
      )
        throw Error('susds_score_ineligible_invalid')
      continue
    }
    if (row.status === 'unavailable') {
      if (
        score.onTime ||
        row.reason !== 'capture_window_missed' ||
        row.outcome !== null ||
        row.measurement !== null
      )
        throw Error('susds_score_censor_invalid')
      continue
    }
    if (!score.onTime || !score.target || row.status !== 'measured' || row.reason !== null)
      throw Error('susds_score_measurement_invalid')
    const decoded = verifySusdsMeasurement({
      holder: issue.candidate.holder,
      assetsRaw: original.assetsRaw,
      blockNumber: score.target.targetBlock,
      blockHash: score.target.targetHash,
      blockAtUtc: score.target.targetBlockAt,
      source: STUDY,
      measurement: row.measurement,
      beforeAtUtc: score.target.targetBlockAt,
      afterAtUtc: score.scoredAtUtc,
    })
    const evidence = row.measurement.evidence
    if (
      evidence.identityEvidence.provider !== score.target.canonicalityEvidenceDoc.provider ||
      utc(evidence.replayEvidenceDoc.observedAt) > utc(plan.captureDeadlineUtc)
    )
      throw Error('susds_score_source_invalid')
    for (const origin of ['primary', 'secondary'])
      for (const phase of ['before', 'after']) {
        const header = evidence.replayEvidenceDoc.headers?.[origin]?.[phase]?.target
        if (
          header?.hash !== score.target.targetHash ||
          header?.parentHash !== score.target.targetParentHash ||
          new Date(Number(BigInt(header?.timestamp ?? -1)) * 1000).toISOString() !==
            score.target.targetBlockAt
        )
          throw Error('susds_score_header_invalid')
      }
    if (row.outcome !== classifySusdsFutureOutcome(decoded))
      throw Error('susds_score_outcome_invalid')
  }
  return score
}

export function buildSusdsScore({
  issue,
  issues,
  horizonHours,
  target,
  measurements,
  scoredAtUtc,
  sequence,
  previousSha256,
}) {
  const plan = issue.targets.find((entry) => entry.horizonHours === horizonHours)
  if (!plan) throw Error('susds_score_horizon_invalid')
  const onTime = utc(scoredAtUtc) <= utc(plan.captureDeadlineUtc)
  if (!onTime && (target !== null || Object.keys(measurements ?? {}).length))
    throw Error('susds_score_late_measurement_invalid')
  const cases = issue.cases.map((entry) => {
    const base = { label: entry.label, assetsRaw: entry.assetsRaw }
    if (entry.status !== 'measured' || entry.measurement?.baselineStatus !== 'success')
      return {
        ...base,
        status: 'ineligible',
        reason: 'baseline_not_success',
        outcome: null,
        measurement: null,
      }
    const measurement = measurements?.[entry.label] ?? null
    if (!measurement) {
      if (onTime) throw Error('susds_score_pending_replay')
      return {
        ...base,
        status: 'unavailable',
        reason: 'capture_window_missed',
        outcome: null,
        measurement: null,
      }
    }
    const decoded = verifySusdsMeasurement({
      holder: issue.candidate.holder,
      assetsRaw: entry.assetsRaw,
      blockNumber: target.targetBlock,
      blockHash: target.targetHash,
      blockAtUtc: target.targetBlockAt,
      source: STUDY,
      measurement,
      beforeAtUtc: target.targetBlockAt,
      afterAtUtc: scoredAtUtc,
    })
    return {
      ...base,
      status: 'measured',
      reason: null,
      outcome: classifySusdsFutureOutcome(decoded),
      measurement,
    }
  })
  const payload = {
    study: STUDY,
    sequence,
    previousSha256,
    issueSequence: issue.sequence,
    issueSha256: issue.sha256,
    routeKey: ROUTE.routeKey,
    destination: ROUTE.destination,
    originalAsset: ROUTE.asset,
    holder: issue.candidate.holder,
    horizonHours,
    targetAtUtc: plan.targetAtUtc,
    captureDeadlineUtc: plan.captureDeadlineUtc,
    scoredAtUtc,
    onTime,
    target,
    cases,
  }
  validateSusdsScore(payload, issues)
  return { ...payload, sha256: sha(JSON.stringify(payload)) }
}

export async function verifySusdsScores(out = OUT, issueOut = ISSUE_OUT) {
  const issues = await verifySusdsIssues(issueOut)
  const rows = await readNumbered(out)
  const seen = new Set()
  for (const row of rows) {
    validateSusdsScore(row, issues)
    const key = `${row.issueSequence}:${row.horizonHours}`
    if (seen.has(key)) throw Error('susds_score_duplicate_target')
    seen.add(key)
  }
  return rows
}

export async function appendSusdsScore(score, out = OUT, issueOut = ISSUE_OUT, stat, options) {
  const issues = await verifySusdsIssues(issueOut)
  validateSusdsScore(score, issues)
  const prior = await verifySusdsScores(out, issueOut)
  if (
    prior.some(
      (entry) =>
        entry.issueSequence === score.issueSequence && entry.horizonHours === score.horizonHours,
    )
  )
    throw Error('susds_score_duplicate_target')
  return appendNumbered(score, out, (path) => verifySusdsScores(path, issueOut), stat, options)
}

export async function selectMatchingSusdsTarget({
  issue,
  plan,
  clients,
  select = selectCarryExitV2FirstFinalizedBlock,
  now = () => new Date(),
}) {
  const args = (client) => ({
    targetAt: plan.targetAtUtc,
    baselineBlock: issue.baseline.targetBlock,
    baselineHash: issue.baseline.targetHash,
    provider: client.provider,
    source: STUDY,
    request: client.request.bind(client),
    now,
  })
  const first = await select(args(clients[0]))
  const second = await select(args(clients[1]))
  if (
    first.targetBlock !== second.targetBlock ||
    first.targetHash !== second.targetHash ||
    first.targetBlockAt !== second.targetBlockAt ||
    first.targetParentHash !== second.targetParentHash ||
    first.targetParentBlockAt !== second.targetParentBlockAt
  )
    throw Error('susds_score_origin_disagreement')
  return first
}

async function measureFuture({ issue, entry, target, primary, secondary, now }) {
  const verified = await measureCarryExitV2Verified({
    ...ROUTE,
    holder: issue.candidate.holder,
    assetsRaw: entry.assetsRaw,
    target,
    provider: primary.provider,
    source: STUDY,
    send: primary.send,
    primary: { url: primary.url, request: primary.send },
    secondary: { url: secondary.url, request: secondary.send },
    now,
  })
  if (verified.status !== 'verified') throw Error('susds_future_replay_unavailable')
  const frozen = {
    ...ROUTE,
    holder: issue.candidate.holder,
    assetsRaw: entry.assetsRaw,
    blockNumber: target.targetBlock,
    blockHash: target.targetHash,
  }
  const decoded = validateCarryExitV2RpcProof({ proof: verified.callEvidenceDoc, ...frozen })
  return {
    simulationStatus: decoded.simulationStatus,
    holderSharesRaw: decoded.holderCoverageRaw,
    previewWithdrawSharesRaw: decoded.requiredCoverageRaw,
    burnedSharesRaw: decoded.actualConsumedRaw,
    coveredRevert: decoded.coveredRevert,
    evidence: verified.callEvidenceDoc,
    evidenceSha256: sha(JSON.stringify(verified.callEvidenceDoc)),
  }
}

export async function scorePublicSusdsExit({
  issueSequence,
  horizonHours,
  clients,
  originPairs,
  out = OUT,
  issueOut = ISSUE_OUT,
  now = () => new Date(),
  select = selectCarryExitV2FirstFinalizedBlock,
  measure = measureFuture,
  append = appendSusdsScore,
  loadIssues = verifySusdsIssues,
  loadScores = verifySusdsScores,
}) {
  const issues = await loadIssues(issueOut)
  const issue = issues[issueSequence - 1]
  const plan = issue?.targets.find((entry) => entry.horizonHours === horizonHours)
  if (!issue || !plan) throw Error('susds_score_unknown_issue_or_horizon')
  if (now().getTime() < utc(plan.targetAtUtc)) return { status: 'not_due' }
  const prior = await loadScores(out, issueOut)
  if (prior.some((row) => row.issueSequence === issueSequence && row.horizonHours === horizonHours))
    return { status: 'already_scored' }
  if (
    !issue.cases.some(
      (row) => row.status === 'measured' && row.measurement?.baselineStatus === 'success',
    )
  )
    return { status: 'no_eligible_baseline' }
  const pairs = originPairs ?? (Array.isArray(clients) && clients.length === 2 ? [clients] : null)
  if (!Array.isArray(pairs) || !pairs.length || pairs.length > 24)
    throw Error('susds_two_public_origins_required')
  const issuePrimary = issue.baseline.canonicalityEvidenceDoc.provider
  const issueSecondary = issue.baselineWitness.provider
  const orderedPairs = pairs
    .filter(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        pair[0]?.provider &&
        pair[1]?.provider &&
        pair[0].provider !== pair[1].provider,
    )
    .map((pair, index) => ({
      pair,
      index,
      priority:
        pair[0].provider === issuePrimary && pair[1].provider === issueSecondary
          ? 0
          : pair[0].provider === issueSecondary && pair[1].provider === issuePrimary
            ? 1
            : 2,
    }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
  if (!orderedPairs.length) throw Error('susds_two_public_origins_required')
  const deadlineMs = utc(plan.captureDeadlineUtc)
  let target = null
  let measurements = {}
  let retryStatus = 'retry_target_unavailable'
  if (now().getTime() <= deadlineMs) {
    for (const { pair } of orderedPairs) {
      if (now().getTime() > deadlineMs) break
      const attempted = {}
      let selected
      try {
        selected = await selectMatchingSusdsTarget({ issue, plan, clients: pair, select, now })
      } catch {
        continue
      }
      retryStatus = 'retry_replay_unavailable'
      let failed = false
      for (const entry of issue.cases) {
        if (entry.status !== 'measured' || entry.measurement?.baselineStatus !== 'success') continue
        if (now().getTime() > deadlineMs) {
          failed = true
          break
        }
        try {
          attempted[entry.label] = await measure({
            issue,
            entry,
            target: selected,
            primary: pair[0],
            secondary: pair[1],
            now,
          })
        } catch {
          failed = true
          break
        }
      }
      if (!failed && now().getTime() <= deadlineMs) {
        target = selected
        measurements = attempted
        break
      }
    }
  }
  const scoredAtUtc = now().toISOString()
  if (utc(scoredAtUtc) > deadlineMs) {
    target = null
    measurements = {}
  }
  if (!target && utc(scoredAtUtc) <= deadlineMs) return { status: retryStatus }
  const score = buildSusdsScore({
    issue,
    issues,
    horizonHours,
    target,
    measurements,
    scoredAtUtc,
    sequence: prior.length + 1,
    previousSha256: prior.at(-1)?.sha256 ?? null,
  })
  return { status: 'scored', ...(await append(score, out, issueOut)) }
}

async function cli() {
  const [mode, sequenceRaw, horizonRaw] = process.argv.slice(2)
  if (mode === '--verify') {
    const scores = await verifySusdsScores()
    process.stdout.write(
      `${JSON.stringify({ status: 'verified_local_chain', scores: scores.length })}\n`,
    )
    return
  }
  if (mode !== '--score' || !DECIMAL.test(sequenceRaw ?? '') || !DECIMAL.test(horizonRaw ?? ''))
    throw Error('susds_score_usage')
  const originPairs = rotatingSusdsOriginPairs(configuredPublicRpcUrls(readEnv()))
  const result = await scorePublicSusdsExit({
    issueSequence: Number(sequenceRaw),
    horizonHours: Number(horizonRaw),
    originPairs,
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch(() => {
    process.stderr.write('public_susds_score_failed\n')
    process.exitCode = 1
  })
}
