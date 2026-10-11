// Prospective fixed-Q replay of hypothetical cooldown initiation, never an unstake receipt.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { selectCarryExitV2FirstFinalizedBlock } from '../lib/carry-exit-v2-block-auditor.mjs'
import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls } from './carry-public-direct-exit-issue.mjs'
import { OUT as ISSUE_OUT, verifySusdeIssues } from './susde-public-initiation-issue.mjs'
import {
  BLOCK_HASH,
  DECIMAL,
  HASH,
  ROUTE,
  appendNumbered,
  measureInitiation,
  readNumbered,
  rotatingSusdeOriginPairs,
  same,
  seal,
  sha,
  utc,
  verifyMeasurement,
  witnessBlock,
} from './susde-public-initiation-common.mjs'

export const STUDY = 'susde_public_hypothetical_initiation_score_v2'
const LEGACY_STUDY = 'susde_public_hypothetical_initiation_score_v1'
const LEGACY_ISSUE_STUDY = 'susde_public_hypothetical_initiation_issue_v1'
const DEPLOYED_MEASUREMENT = 'susde_public_cooldown_initiation_measurement_v2'
const LEGACY_MEASUREMENT = 'susde_public_cooldown_initiation_measurement_v1'
const isSuccess = (row) =>
  row.status === 'measured' && row.measurement?.status === 'simulated_initiation_success'
const isDeployedSuccess = (row) =>
  isSuccess(row) && row.measurement.evidence?.schema === DEPLOYED_MEASUREMENT
const isLegacySuccess = (row) =>
  isSuccess(row) && row.measurement.evidence?.schema === LEGACY_MEASUREMENT
export const OUT = resolve('data/research/venue-signals/susde-public-initiation-scores')

export function validateSusdeScore(score, issues) {
  const issue = issues[score?.issueSequence - 1]
  const plan = issue?.targets.find((row) => row.horizonHours === score.horizonHours)
  if (
    !issue ||
    !plan ||
    ![LEGACY_STUDY, STUDY].includes(score.study) ||
    (score.study === LEGACY_STUDY && issue.study !== LEGACY_ISSUE_STUDY) ||
    !Number.isSafeInteger(score.sequence) ||
    score.sequence < 1 ||
    (score.sequence === 1
      ? score.previousSha256 !== null
      : !HASH.test(score.previousSha256 ?? '')) ||
    score.issueSha256 !== issue.sha256 ||
    !same(score.route, ROUTE) ||
    score.holder !== issue.candidate.holder ||
    score.targetAtUtc !== plan.targetAtUtc ||
    score.captureDeadlineUtc !== plan.captureDeadlineUtc ||
    score.interpretation !== 'hypothetical_future_cooldown_initiation_only' ||
    !Array.isArray(score.cases) ||
    score.cases.length !== issue.cases.length
  )
    throw Error('susde_score_identity_invalid')
  const scored = utc(score.scoredAtUtc)
  const onTime = scored <= utc(plan.captureDeadlineUtc)
  if (scored < utc(plan.targetAtUtc) || score.onTime !== onTime)
    throw Error('susde_score_clock_invalid')
  const target = score.target
  if (
    onTime !== (target !== null) &&
    !(score.study === STUDY && target === null && !issue.cases.some(isDeployedSuccess))
  )
    throw Error('susde_score_target_status_invalid')
  if (target) {
    const doc = target.canonicalityEvidenceDoc
    if (
      !DECIMAL.test(target.targetBlock ?? '') ||
      !BLOCK_HASH.test(target.targetHash ?? '') ||
      doc?.schema !== 'carry_exit_v2_headers_v1' ||
      doc.chainId !== '1' ||
      doc.finalityTag !== 'finalized' ||
      doc.targetAt !== plan.targetAtUtc ||
      doc.baselineHeader?.number !== issue.baseline.block.number ||
      doc.baselineHeader?.hash !== issue.baseline.block.hash ||
      doc.targetHeader?.number !== target.targetBlock ||
      doc.targetHeader?.hash !== target.targetHash ||
      doc.targetHeader?.timestamp !== target.targetBlockAt ||
      doc.parentHeader?.number !== target.targetParentBlock ||
      doc.parentHeader?.hash !== target.targetParentHash ||
      target.targetParentHash !== target.parentHeaderHash ||
      target.targetParentHash !== doc.targetHeader.parentHash ||
      BigInt(target.targetBlock) !== BigInt(target.targetParentBlock) + 1n ||
      BigInt(target.targetBlock) <= BigInt(issue.baseline.block.number) ||
      utc(target.targetParentBlockAt) >= utc(plan.targetAtUtc) ||
      utc(target.targetBlockAt) < utc(plan.targetAtUtc) ||
      utc(target.targetBlockAt) > utc(plan.captureDeadlineUtc) ||
      utc(target.targetObservedAt) > scored ||
      !Array.isArray(score.targetWitnesses) ||
      score.targetWitnesses.length !== 2 ||
      score.targetWitnesses[0].provider === score.targetWitnesses[1].provider ||
      score.targetWitnesses.some(
        (witness) =>
          !same(witness.observed, {
            number: target.targetBlock,
            hash: target.targetHash,
            parentHash: target.targetParentHash,
            at: target.targetBlockAt,
          }) ||
          BigInt(witness.finalized?.number ?? -1) < BigInt(target.targetBlock) ||
          utc(witness.observedAtUtc) > scored,
      )
    )
      throw Error('susde_score_target_invalid')
  } else if (score.targetWitnesses !== null) throw Error('susde_score_late_witness_invalid')
  for (let i = 0; i < score.cases.length; i++) {
    const row = score.cases[i]
    const original = issue.cases[i]
    if (row.label !== original.label || row.assetsRaw !== original.assetsRaw)
      throw Error('susde_score_q_changed')
    const legacySelector = score.study === STUDY && isLegacySuccess(original)
    const eligible =
      score.study === LEGACY_STUDY ? isSuccess(original) : isDeployedSuccess(original)
    if (legacySelector) {
      if (
        !same(row, {
          label: original.label,
          assetsRaw: original.assetsRaw,
          status: 'unavailable',
          reason: 'legacy_selector_unassessed',
          outcome: null,
          measurement: null,
        })
      )
        throw Error('susde_score_legacy_selector_invalid')
    } else if (!eligible) {
      if (
        !same(row, {
          label: original.label,
          assetsRaw: original.assetsRaw,
          status: 'ineligible',
          reason: 'baseline_not_success',
          outcome: null,
          measurement: null,
        })
      )
        throw Error('susde_score_ineligible_invalid')
    } else if (!onTime) {
      if (
        !same(row, {
          label: original.label,
          assetsRaw: original.assetsRaw,
          status: 'unavailable',
          reason: 'capture_window_missed',
          outcome: null,
          measurement: null,
        })
      )
        throw Error('susde_score_censor_invalid')
    } else {
      if (row.status !== 'measured' || row.reason !== null || !row.measurement || !target)
        throw Error('susde_score_measurement_invalid')
      verifyMeasurement(row.measurement, {
        block: {
          number: target.targetBlock,
          hash: target.targetHash,
          parentHash: target.targetParentHash,
          at: target.targetBlockAt,
        },
        holder: issue.candidate.holder,
        assetsRaw: original.assetsRaw,
        earliestUtc: target.targetObservedAt,
        latestUtc: score.scoredAtUtc,
        allowLegacy: score.study === LEGACY_STUDY,
      })
      if (score.study === STUDY && row.measurement.evidence.schema !== DEPLOYED_MEASUREMENT)
        throw Error('susde_score_legacy_selector_invalid')
      if (
        row.measurement.evidence.origins[0].provider !== docProvider(target) ||
        row.measurement.evidence.origins[0].provider !== score.targetWitnesses[0].provider ||
        row.measurement.evidence.origins[1].provider !== score.targetWitnesses[1].provider ||
        utc(row.measurement.evidence.measuredAtUtc) > utc(plan.captureDeadlineUtc) ||
        row.outcome !== row.measurement.status
      )
        throw Error('susde_score_outcome_invalid')
    }
  }
  const { sha256: _seal, ...body } = score
  if (score.sha256 !== sha(JSON.stringify(body))) throw Error('susde_score_seal_invalid')
  return score
}

const docProvider = (target) => target.canonicalityEvidenceDoc.provider

export function buildSusdeScore({
  issue,
  horizonHours,
  target,
  targetWitnesses,
  measurements,
  scoredAtUtc,
  sequence,
  previousSha256,
}) {
  const plan = issue.targets.find((row) => row.horizonHours === horizonHours)
  if (!plan) throw Error('susde_score_plan_invalid')
  const onTime = utc(scoredAtUtc) <= utc(plan.captureDeadlineUtc)
  if (!onTime && (target || Object.keys(measurements).length))
    throw Error('susde_score_late_measurement_invalid')
  const cases = issue.cases.map((original) => {
    const identity = { label: original.label, assetsRaw: original.assetsRaw }
    if (isLegacySuccess(original))
      return {
        ...identity,
        status: 'unavailable',
        reason: 'legacy_selector_unassessed',
        outcome: null,
        measurement: null,
      }
    if (!isDeployedSuccess(original))
      return {
        ...identity,
        status: 'ineligible',
        reason: 'baseline_not_success',
        outcome: null,
        measurement: null,
      }
    if (!onTime)
      return {
        ...identity,
        status: 'unavailable',
        reason: 'capture_window_missed',
        outcome: null,
        measurement: null,
      }
    const measurement = measurements[original.label]
    if (!measurement) throw Error('susde_score_case_missing')
    return {
      ...identity,
      status: 'measured',
      reason: null,
      outcome: measurement.status,
      measurement,
    }
  })
  return seal({
    study: STUDY,
    sequence,
    previousSha256,
    issueSequence: issue.sequence,
    issueSha256: issue.sha256,
    route: ROUTE,
    holder: issue.candidate.holder,
    horizonHours,
    targetAtUtc: plan.targetAtUtc,
    captureDeadlineUtc: plan.captureDeadlineUtc,
    scoredAtUtc,
    onTime,
    target,
    targetWitnesses,
    cases,
    interpretation: 'hypothetical_future_cooldown_initiation_only',
  })
}

export async function verifySusdeScores(out = OUT, issueOut = ISSUE_OUT) {
  const issues = await verifySusdeIssues(issueOut)
  const scores = await readNumbered(out)
  const seen = new Set()
  for (const row of scores) {
    validateSusdeScore(row, issues)
    const key = `${row.issueSequence}:${row.horizonHours}`
    if (seen.has(key)) throw Error('susde_score_duplicate_target')
    seen.add(key)
  }
  return scores
}

export async function appendSusdeScore(score, out = OUT, issueOut = ISSUE_OUT) {
  if (score.study !== STUDY) throw Error('susde_score_study_downgrade')
  validateSusdeScore(score, await verifySusdeIssues(issueOut))
  if (
    (await verifySusdeScores(out, issueOut)).some(
      (row) => row.issueSequence === score.issueSequence && row.horizonHours === score.horizonHours,
    )
  )
    throw Error('susde_score_duplicate_target')
  return appendNumbered(score, out, (path) => verifySusdeScores(path, issueOut))
}

export async function selectSusdeTarget({
  issue,
  plan,
  pair,
  now = () => new Date(),
  select = selectCarryExitV2FirstFinalizedBlock,
}) {
  const selected = await Promise.all(
    pair.map((client) =>
      select({
        targetAt: plan.targetAtUtc,
        baselineBlock: issue.baseline.block.number,
        baselineHash: issue.baseline.block.hash,
        provider: client.provider,
        source: STUDY,
        request: client.request.bind(client),
        now,
      }),
    ),
  )
  if (
    selected[0].targetBlock !== selected[1].targetBlock ||
    selected[0].targetHash !== selected[1].targetHash ||
    selected[0].targetParentHash !== selected[1].targetParentHash ||
    selected[0].targetBlockAt !== selected[1].targetBlockAt
  )
    throw Error('susde_target_origin_disagreement')
  const block = {
    number: selected[0].targetBlock,
    hash: selected[0].targetHash,
    parentHash: selected[0].targetParentHash,
    at: selected[0].targetBlockAt,
  }
  const targetWitnesses = await witnessBlock(pair, block, now)
  return { target: selected[0], targetWitnesses, block }
}

export async function scorePublicSusdeInitiation({
  issueSequence,
  horizonHours,
  originPairs,
  out = OUT,
  issueOut = ISSUE_OUT,
  now = () => new Date(),
  select = selectSusdeTarget,
  measure = measureInitiation,
  append = appendSusdeScore,
  loadIssues = verifySusdeIssues,
  loadScores = verifySusdeScores,
}) {
  const issues = await loadIssues(issueOut)
  const issue = issues[issueSequence - 1]
  const plan = issue?.targets.find((row) => row.horizonHours === horizonHours)
  if (!issue || !plan) throw Error('susde_score_unknown_issue_or_horizon')
  if (now().getTime() < utc(plan.targetAtUtc)) return { status: 'not_due' }
  const prior = await loadScores(out, issueOut)
  if (prior.some((row) => row.issueSequence === issueSequence && row.horizonHours === horizonHours))
    return { status: 'already_scored' }
  if (!issue.cases.some(isDeployedSuccess) && issue.cases.some(isLegacySuccess)) {
    const score = buildSusdeScore({
      issue,
      horizonHours,
      target: null,
      targetWitnesses: null,
      measurements: {},
      scoredAtUtc: now().toISOString(),
      sequence: prior.length + 1,
      previousSha256: prior.at(-1)?.sha256 ?? null,
    })
    return { status: 'legacy_selector_unassessed', ...(await append(score, out, issueOut)) }
  }
  if (!issue.cases.some(isDeployedSuccess)) return { status: 'no_eligible_baseline' }
  if (!Array.isArray(originPairs) || !originPairs.length || originPairs.length > 24)
    throw Error('susde_origins_invalid')
  let target = null
  let targetWitnesses = null
  let measurements = {}
  const deadline = utc(plan.captureDeadlineUtc)
  if (now().getTime() <= deadline) {
    for (const pair of originPairs) {
      if (now().getTime() > deadline) break
      try {
        const selected = await select({ issue, plan, pair, now })
        const attempts = {}
        for (const row of issue.cases) {
          if (!isDeployedSuccess(row)) continue
          if (now().getTime() > deadline) throw Error('susde_capture_deadline')
          attempts[row.label] = await measure({
            pair,
            block: selected.block,
            holder: issue.candidate.holder,
            assetsRaw: row.assetsRaw,
            now,
          })
        }
        if (now().getTime() > deadline) break
        target = selected.target
        targetWitnesses = selected.targetWitnesses
        measurements = attempts
        break
      } catch {
        // Try another independent public origin pair within the issue's capture window.
      }
    }
  }
  const scoredAtUtc = now().toISOString()
  if (utc(scoredAtUtc) > deadline) {
    target = null
    targetWitnesses = null
    measurements = {}
  }
  if (!target && utc(scoredAtUtc) <= deadline)
    return { status: 'retry_target_or_replay_unavailable' }
  const score = buildSusdeScore({
    issue,
    horizonHours,
    target,
    targetWitnesses,
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
    process.stdout.write(
      `${JSON.stringify({ status: 'verified', scores: (await verifySusdeScores()).length })}\n`,
    )
    return
  }
  if (mode !== '--score' || !DECIMAL.test(sequenceRaw ?? '') || !DECIMAL.test(horizonRaw ?? ''))
    throw Error('susde_score_usage')
  const originPairs = rotatingSusdeOriginPairs(configuredPublicRpcUrls(readEnv()))
  const result = await scorePublicSusdeInitiation({
    issueSequence: Number(sequenceRaw),
    horizonHours: Number(horizonRaw),
    originPairs,
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch(() => {
    process.stderr.write('susde_public_score_failed\n')
    process.exitCode = 1
  })
}
