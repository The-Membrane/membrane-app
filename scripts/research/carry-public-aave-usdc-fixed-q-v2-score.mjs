// Same-holder, same-raw-Q Aave USDC future replay, including covered baseline reverts.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { selectCarryExitV2FirstFinalizedBlock } from '../lib/carry-exit-v2-block-auditor.mjs'
import { assembleCarryExitV2CallEvidence } from '../lib/carry-exit-v2-proof-assembly.mjs'
import { measureCarryExitV2Verified } from '../lib/carry-exit-v2-verified-measurement.mjs'
import { validateCarryExitV2RpcProof } from '../lib/carry-exit-v2-rpc-proof.mjs'
import { readEnv } from '../lib/venue-reads.mjs'
import {
  DIRECT_MARKETS,
  OUT as V1_OUT,
  configuredPublicRpcUrls,
  verifyPublicDirectIssues,
} from './carry-public-direct-exit-issue.mjs'
import {
  OUT as ISSUE_OUT,
  verifyAaveFrozenQIssues,
} from './carry-public-aave-usdc-fixed-q-v2-issue.mjs'
import {
  BLOCK_HASH,
  DECIMAL,
  HASH,
  appendNumbered,
  readNumbered,
  rotatingSghoOriginPairs,
  same,
  sha,
  utc,
} from './carry-public-sgho-exit-common.mjs'
import {
  confirmStusdsDeadlinePassed,
  validStusdsDeadlineWitness,
} from './carry-public-stusds-exit-score.mjs'

export const STUDY = 'carry_public_aave_usdc_frozen_q_score_v2'
export const OUT = resolve('data/research/venue-signals/carry-public-aave-usdc-frozen-q-v2-scores')
const ROUTE = DIRECT_MARKETS.aaveV3Usdc

export function classifyAaveFrozenQOutcome(decoded, assetsRaw) {
  if (decoded?.routeKind !== 'aave') throw Error('aave_frozen_q_kind_invalid')
  if (decoded.simulationStatus === 'success') return 'simulated_withdraw_success'
  if (decoded.simulationStatus !== 'evm_revert') throw Error('aave_frozen_q_status_invalid')
  if (BigInt(decoded.holderCoverageRaw) < BigInt(assetsRaw)) return 'holder_attrition'
  if (decoded.coveredRevert) return 'covered_withdraw_revert'
  throw Error('aave_frozen_q_revert_unclassified')
}

export function classifyAaveFrozenQTransition(baselineStatus, outcome) {
  if (outcome === 'holder_attrition') return 'holder_attrition'
  if (baselineStatus === 'success')
    return outcome === 'simulated_withdraw_success' ? 'remained_exitable' : 'lost_exitability'
  if (baselineStatus === 'covered_revert')
    return outcome === 'simulated_withdraw_success' ? 'simulated_recovery' : 'still_reverting'
  throw Error('aave_frozen_q_baseline_invalid')
}

function validateTarget(parent, plan, target) {
  const doc = target?.canonicalityEvidenceDoc
  const second = target?.secondOriginCanonicalityEvidenceDoc
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
    second?.schema !== 'carry_exit_v2_headers_v1' ||
    second.chainId !== '1' ||
    second.finalityTag !== 'finalized' ||
    second.source !== STUDY ||
    typeof second.provider !== 'string' ||
    !second.provider ||
    second.provider === doc.provider ||
    second.targetAt !== plan.targetAtUtc ||
    second.baselineHeader?.number !== parent.baseline.targetBlock ||
    second.baselineHeader?.hash !== parent.baseline.targetHash ||
    second.targetHeader?.number !== target.targetBlock ||
    second.targetHeader?.hash !== target.targetHash ||
    second.targetHeader?.timestamp !== target.targetBlockAt ||
    second.targetHeader?.parentHash !== target.targetParentHash ||
    second.parentHeader?.number !== target.targetParentBlock ||
    second.parentHeader?.hash !== target.targetParentHash ||
    second.parentHeader?.timestamp !== target.targetParentBlockAt ||
    !DECIMAL.test(second.finalizedHead?.number ?? '') ||
    BigInt(second.finalizedHead.number) < BigInt(target.targetBlock) ||
    utc(second.observedAt) < utc(target.targetBlockAt) ||
    utc(second.observedAt) > utc(plan.captureDeadlineUtc) ||
    !DECIMAL.test(doc.finalizedHead?.number ?? '') ||
    BigInt(doc.finalizedHead.number) < BigInt(target.targetBlock) ||
    BigInt(target.targetBlock) <= BigInt(parent.baseline.targetBlock) ||
    BigInt(target.targetBlock) !== BigInt(target.targetParentBlock) + 1n ||
    utc(target.targetParentBlockAt) >= utc(plan.targetAtUtc) ||
    utc(target.targetBlockAt) < utc(plan.targetAtUtc) ||
    utc(target.targetBlockAt) > utc(plan.captureDeadlineUtc) ||
    utc(target.targetObservedAt) < utc(target.targetBlockAt)
  )
    throw Error('aave_frozen_q_target_invalid')
}

export function verifyAaveFrozenQMeasurement({ issue, entry, target, measurement, scoredAtUtc }) {
  const evidence = measurement?.evidence
  if (
    evidence?.verificationStatus !== 'verified' ||
    measurement.evidenceSha256 !== sha(JSON.stringify(evidence)) ||
    evidence.identityEvidence?.holder !== issue.holder ||
    evidence.identityEvidence?.asset !== ROUTE.asset ||
    evidence.identityEvidence?.destination !== ROUTE.destination ||
    evidence.identityEvidence?.source !== STUDY ||
    evidence.identityEvidence?.provider !== target.canonicalityEvidenceDoc.provider ||
    evidence.replayEvidenceDoc?.origins?.primary !== target.canonicalityEvidenceDoc.provider ||
    evidence.replayEvidenceDoc?.origins?.secondary !==
      target.secondOriginCanonicalityEvidenceDoc?.provider ||
    evidence.identityEvidence?.blockNumber !== target.targetBlock ||
    evidence.identityEvidence?.blockHash !== target.targetHash ||
    evidence.replayEvidenceDoc?.blockNumber !== target.targetBlock ||
    evidence.replayEvidenceDoc?.blockHash !== target.targetHash ||
    utc(evidence.replayEvidenceDoc?.observedAt) < utc(target.targetBlockAt) ||
    utc(evidence.replayEvidenceDoc.observedAt) > utc(scoredAtUtc)
  )
    throw Error('aave_frozen_q_measurement_identity_invalid')
  for (const origin of ['primary', 'secondary'])
    for (const phase of ['before', 'after']) {
      const header = evidence.replayEvidenceDoc.headers?.[origin]?.[phase]?.target
      if (
        header?.hash !== target.targetHash ||
        header?.parentHash !== target.targetParentHash ||
        BigInt(header?.number ?? -1) !== BigInt(target.targetBlock) ||
        new Date(Number(BigInt(header?.timestamp ?? -1)) * 1000).toISOString() !==
          target.targetBlockAt
      )
        throw Error('aave_frozen_q_measurement_header_invalid')
    }
  const frozen = {
    ...ROUTE,
    holder: issue.holder,
    assetsRaw: entry.assetsRaw,
    blockNumber: target.targetBlock,
    blockHash: target.targetHash,
  }
  const decoded = validateCarryExitV2RpcProof({ proof: evidence, ...frozen })
  const reconstructed = assembleCarryExitV2CallEvidence({
    frozen,
    collector: {
      status: 'raw_rpc_collected',
      blockNumber: target.targetBlock,
      blockHash: target.targetHash,
      routeKind: 'aave',
      provider: evidence.identityEvidence.provider,
      source: STUDY,
      proof: evidence,
      identityEvidence: evidence.identityEvidence,
    },
    replay: {
      status: 'verified',
      verdict: { simulationStatus: decoded.simulationStatus, coveredRevert: decoded.coveredRevert },
      replayEvidenceDoc: evidence.replayEvidenceDoc,
    },
  })
  if (
    !same(reconstructed, evidence) ||
    measurement.simulationStatus !== decoded.simulationStatus ||
    measurement.holderCoverageRaw !== decoded.holderCoverageRaw ||
    measurement.actualConsumedRaw !== decoded.actualConsumedRaw ||
    measurement.coveredRevert !== decoded.coveredRevert
  )
    throw Error('aave_frozen_q_measurement_replay_invalid')
  return decoded
}

export function validateAaveFrozenQScore(score, issues, parents) {
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
    score.marketKey !== issue.marketKey ||
    score.routeKey !== issue.routeKey ||
    score.destination !== issue.destination ||
    score.originalAsset !== issue.originalAsset ||
    score.holder !== issue.holder ||
    score.targetAtUtc !== plan.targetAtUtc ||
    score.captureDeadlineUtc !== plan.captureDeadlineUtc ||
    !Array.isArray(score.cases) ||
    score.cases.length !== issue.cases.length
  )
    throw Error('aave_frozen_q_score_binding_invalid')
  const scored = utc(score.scoredAtUtc)
  if (scored < utc(plan.targetAtUtc)) throw Error('aave_frozen_q_score_clock_invalid')
  if (score.status === 'censored') {
    if (
      score.target !== null ||
      scored <= utc(plan.captureDeadlineUtc) ||
      !validStusdsDeadlineWitness(score.deadlineWitness, plan.captureDeadlineUtc) ||
      scored < utc(score.deadlineWitness.atUtc) ||
      score.cases.some(
        (row, index) =>
          row.label !== issue.cases[index].label ||
          row.assetsRaw !== issue.cases[index].assetsRaw ||
          row.status !== 'censored' ||
          row.measurement !== null ||
          row.outcome !== null ||
          row.transition !== 'censored',
      )
    )
      throw Error('aave_frozen_q_censor_invalid')
    return score
  }
  if (
    score.status !== 'measured' ||
    score.deadlineWitness !== null ||
    scored > utc(plan.captureDeadlineUtc)
  )
    throw Error('aave_frozen_q_score_status_invalid')
  validateTarget(parent, plan, score.target)
  if (utc(score.target.targetObservedAt) > scored)
    throw Error('aave_frozen_q_score_target_after_record')
  for (const [index, row] of score.cases.entries()) {
    const entry = issue.cases[index]
    if (row.label !== entry.label || row.assetsRaw !== entry.assetsRaw || row.status !== 'measured')
      throw Error('aave_frozen_q_case_binding_invalid')
    const decoded = verifyAaveFrozenQMeasurement({
      issue,
      entry,
      target: score.target,
      measurement: row.measurement,
      scoredAtUtc: score.scoredAtUtc,
    })
    if (utc(row.measurement.evidence.replayEvidenceDoc.observedAt) > utc(plan.captureDeadlineUtc))
      throw Error('aave_frozen_q_late_replay')
    const outcome = classifyAaveFrozenQOutcome(decoded, entry.assetsRaw)
    if (
      row.outcome !== outcome ||
      row.transition !== classifyAaveFrozenQTransition(entry.baselineStatus, outcome)
    )
      throw Error('aave_frozen_q_outcome_invalid')
  }
  return score
}

export function buildAaveFrozenQScore({
  issue,
  issues,
  parents,
  horizonHours,
  target,
  measurements,
  deadlineWitness = null,
  scoredAtUtc,
  sequence,
  previousSha256,
}) {
  const plan = issue.targets.find((entry) => entry.horizonHours === horizonHours)
  if (!plan) throw Error('aave_frozen_q_horizon_invalid')
  const censored = target === null
  if (censored !== (measurements === null)) throw Error('aave_frozen_q_measurements_missing')
  const cases = issue.cases.map((entry) => {
    if (censored)
      return {
        label: entry.label,
        assetsRaw: entry.assetsRaw,
        status: 'censored',
        measurement: null,
        outcome: null,
        transition: 'censored',
      }
    const measurement = measurements[entry.label]
    if (!measurement) throw Error('aave_frozen_q_case_missing')
    const decoded = verifyAaveFrozenQMeasurement({ issue, entry, target, measurement, scoredAtUtc })
    const outcome = classifyAaveFrozenQOutcome(decoded, entry.assetsRaw)
    return {
      label: entry.label,
      assetsRaw: entry.assetsRaw,
      status: 'measured',
      measurement,
      outcome,
      transition: classifyAaveFrozenQTransition(entry.baselineStatus, outcome),
    }
  })
  const payload = {
    study: STUDY,
    sequence,
    previousSha256,
    issueSequence: issue.sequence,
    issueSha256: issue.sha256,
    marketKey: issue.marketKey,
    routeKey: issue.routeKey,
    destination: issue.destination,
    originalAsset: issue.originalAsset,
    holder: issue.holder,
    horizonHours,
    targetAtUtc: plan.targetAtUtc,
    captureDeadlineUtc: plan.captureDeadlineUtc,
    scoredAtUtc,
    status: censored ? 'censored' : 'measured',
    target,
    deadlineWitness,
    cases,
  }
  validateAaveFrozenQScore(payload, issues, parents)
  return { ...payload, sha256: sha(JSON.stringify(payload)) }
}

export async function verifyAaveFrozenQScores(out = OUT, issueOut = ISSUE_OUT, v1Out = V1_OUT) {
  const [issues, parents] = await Promise.all([
    verifyAaveFrozenQIssues(issueOut, v1Out),
    verifyPublicDirectIssues(v1Out),
  ])
  const rows = await readNumbered(out)
  const seen = new Set()
  for (const row of rows) {
    validateAaveFrozenQScore(row, issues, parents)
    const key = `${row.issueSequence}:${row.horizonHours}`
    if (seen.has(key)) throw Error('aave_frozen_q_duplicate_target')
    seen.add(key)
  }
  return rows
}

export async function appendAaveFrozenQScore(row, out = OUT, issueOut = ISSUE_OUT, v1Out = V1_OUT) {
  const [issues, parents, prior] = await Promise.all([
    verifyAaveFrozenQIssues(issueOut, v1Out),
    verifyPublicDirectIssues(v1Out),
    verifyAaveFrozenQScores(out, issueOut, v1Out),
  ])
  validateAaveFrozenQScore(row, issues, parents)
  if (
    prior.some(
      (entry) =>
        entry.issueSequence === row.issueSequence && entry.horizonHours === row.horizonHours,
    )
  )
    throw Error('aave_frozen_q_duplicate_target')
  return appendNumbered(row, out, (path) => verifyAaveFrozenQScores(path, issueOut, v1Out))
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
    throw Error('aave_frozen_q_origin_disagreement')
  return { ...a, secondOriginCanonicalityEvidenceDoc: b.canonicalityEvidenceDoc }
}

async function measureFuture(issue, entry, target, pair, now) {
  const verified = await measureCarryExitV2Verified({
    ...ROUTE,
    holder: issue.holder,
    assetsRaw: entry.assetsRaw,
    target,
    provider: pair[0].provider,
    source: STUDY,
    send: pair[0].send,
    primary: { url: pair[0].url, request: pair[0].send },
    secondary: { url: pair[1].url, request: pair[1].send },
    now,
  })
  if (verified.status !== 'verified') throw Error('aave_frozen_q_future_unavailable')
  const evidence = verified.callEvidenceDoc
  const decoded = validateCarryExitV2RpcProof({
    proof: evidence,
    ...ROUTE,
    holder: issue.holder,
    assetsRaw: entry.assetsRaw,
    blockNumber: target.targetBlock,
    blockHash: target.targetHash,
  })
  return {
    simulationStatus: decoded.simulationStatus,
    holderCoverageRaw: decoded.holderCoverageRaw,
    actualConsumedRaw: decoded.actualConsumedRaw,
    coveredRevert: decoded.coveredRevert,
    evidence,
    evidenceSha256: sha(JSON.stringify(evidence)),
  }
}

export async function scoreAaveFrozenQ({
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
  loadIssues = verifyAaveFrozenQIssues,
  loadParents = verifyPublicDirectIssues,
  loadScores = verifyAaveFrozenQScores,
  append = appendAaveFrozenQScore,
}) {
  const [issues, parents, prior] = await Promise.all([
    loadIssues(issueOut, v1Out),
    loadParents(v1Out),
    loadScores(out, issueOut, v1Out),
  ])
  const issue = issues[issueSequence - 1]
  const parent = issue && parents[issue.v1IssueSequence - 1]
  const plan = issue?.targets.find((entry) => entry.horizonHours === horizonHours)
  if (!issue || !parent || !plan) throw Error('aave_frozen_q_unknown_issue_or_horizon')
  if (now().getTime() < utc(plan.targetAtUtc)) return { status: 'not_due' }
  if (prior.some((row) => row.issueSequence === issueSequence && row.horizonHours === horizonHours))
    return { status: 'already_scored' }
  const pairs =
    originPairs?.filter(
      (pair) =>
        pair?.length === 2 &&
        pair[0]?.provider &&
        pair[1]?.provider &&
        pair[0].provider !== pair[1].provider,
    ) ?? []
  if (!pairs.length || pairs.length > 24) throw Error('aave_frozen_q_two_origins_required')
  const deadline = utc(plan.captureDeadlineUtc)
  let target = null
  let measurements = null
  const retryCauses = new Set()
  if (now().getTime() <= deadline) {
    for (const pair of pairs) {
      let selected
      try {
        selected = await selectTarget(parent, plan, pair, select, now)
      } catch (error) {
        retryCauses.add(
          typeof error?.code === 'string' && /^[a-z0-9_]{1,64}$/.test(error.code)
            ? error.code
            : 'target_unavailable',
        )
        continue
      }
      try {
        const captured = {}
        for (const entry of issue.cases)
          captured[entry.label] = await measure(issue, entry, selected, pair, now)
        if (now().getTime() > deadline) break
        target = selected
        measurements = captured
        break
      } catch {
        retryCauses.add('replay_unavailable')
      }
    }
  }
  let deadlineWitness = null
  if (!target) {
    if (now().getTime() <= deadline)
      return { status: 'retry_replay_unavailable', causes: [...retryCauses].sort() }
    deadlineWitness = await confirmDeadline(pairs, deadline)
    if (!deadlineWitness) return { status: 'retry_deadline_witness_unavailable' }
  }
  const scoredAtUtc = now().toISOString()
  if (target && utc(scoredAtUtc) > deadline) return { status: 'retry_deadline_witness_unavailable' }
  const row = buildAaveFrozenQScore({
    issue,
    issues,
    parents,
    horizonHours,
    target,
    measurements,
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
    const scores = await verifyAaveFrozenQScores()
    process.stdout.write(
      `${JSON.stringify({ status: 'verified_local_chain', scores: scores.length })}\n`,
    )
    return
  }
  if (mode !== '--score' || !DECIMAL.test(issueRaw ?? '') || !DECIMAL.test(horizonRaw ?? ''))
    throw Error('aave_frozen_q_score_usage')
  const originPairs = rotatingSghoOriginPairs(configuredPublicRpcUrls(readEnv()))
  process.stdout.write(
    `${JSON.stringify(await scoreAaveFrozenQ({ issueSequence: Number(issueRaw), horizonHours: Number(horizonRaw), originPairs }))}\n`,
  )
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  cli().catch(() => {
    process.stderr.write('public_aave_frozen_q_score_failed\n')
    process.exitCode = 1
  })
