// Future same-holder, same-USDC-Q USD3 withdraw simulations, never mined delivery.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { selectCarryExitV2FirstFinalizedBlock } from '../lib/carry-exit-v2-block-auditor.mjs'
import { measureCarryExitV2Verified } from '../lib/carry-exit-v2-verified-measurement.mjs'
import { validateCarryExitV2RpcProof } from '../lib/carry-exit-v2-rpc-proof.mjs'
import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls } from './carry-public-direct-exit-issue.mjs'
import { OUT as ISSUE_OUT, verifyUsd3Issues } from './carry-public-usd3-exit-issue.mjs'
import {
  BLOCK_HASH,
  DECIMAL,
  HASH,
  ROUTE,
  assertUsd3ImplementationPair,
  appendNumbered,
  readNumbered,
  rotatingUsd3OriginPairs,
  sha,
  utc,
  verifyUsd3Measurement,
} from './carry-public-usd3-exit-common.mjs'

export const STUDY = 'carry_public_usd3_exit_score_v1'
export const OUT = resolve('data/research/venue-signals/carry-public-usd3-exit-scores')

export function classifyUsd3FutureOutcome(decoded) {
  if (decoded?.routeKind !== 'usd3') throw Error('usd3_score_kind_invalid')
  if (decoded.simulationStatus === 'success') {
    if (!DECIMAL.test(decoded.actualConsumedRaw ?? '') || BigInt(decoded.actualConsumedRaw) === 0n)
      throw Error('usd3_score_burn_missing')
    return 'simulated_withdraw_success'
  }
  if (decoded.simulationStatus !== 'evm_revert') throw Error('usd3_score_status_invalid')
  if (decoded.coveredRevert) return 'withdraw_revert_cause_unknown'
  if (BigInt(decoded.holderCoverageRaw) === 0n) return 'holder_shares_zero'
  if (BigInt(decoded.requiredCoverageRaw) > BigInt(decoded.holderCoverageRaw))
    return 'preview_share_gap'
  throw Error('usd3_score_revert_unclassified')
}

export const usd3ScorableBaseline = (entry) =>
  entry.status === 'measured' &&
  ['success', 'covered_revert'].includes(entry.measurement?.baselineStatus)

export function classifyUsd3ImpairedTransition(outcome) {
  if (outcome === 'simulated_withdraw_success') return 'simulated_recovery'
  if (outcome === 'holder_shares_zero') return 'holder_attrition'
  if (['withdraw_revert_cause_unknown', 'preview_share_gap'].includes(outcome))
    return 'still_reverting'
  throw Error('usd3_impaired_transition_invalid')
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
    throw Error('usd3_score_target_invalid')
}

export function validateUsd3Score(score, issues) {
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
    throw Error('usd3_score_issue_binding_invalid')
  const scored = utc(score.scoredAtUtc)
  const expectedOnTime = scored <= utc(plan.captureDeadlineUtc)
  if (scored < utc(plan.targetAtUtc) || score.onTime !== expectedOnTime)
    throw Error('usd3_score_clock_invalid')
  validateTarget(issue, plan, score.target)
  if (score.onTime && score.target === null) throw Error('usd3_score_ontime_target_missing')
  if (!score.onTime && score.target !== null) throw Error('usd3_score_late_target_invalid')
  if (score.onTime && score.deadlineWitness != null)
    throw Error('usd3_score_deadline_witness_invalid')
  if (
    !score.onTime &&
    (!validUsd3DeadlineWitness(score.deadlineWitness, plan.captureDeadlineUtc) ||
      scored < utc(score.deadlineWitness.atUtc))
  )
    throw Error('usd3_score_deadline_witness_invalid')
  if (score.target && utc(score.target.targetObservedAt) > scored)
    throw Error('usd3_score_target_after_record')
  for (const [index, row] of score.cases.entries()) {
    const original = issue.cases[index]
    if (row.label !== original.label || row.assetsRaw !== original.assetsRaw)
      throw Error('usd3_score_q_binding_invalid')
    if (!usd3ScorableBaseline(original)) {
      if (
        row.status !== 'ineligible' ||
        row.reason !== 'baseline_not_success' ||
        row.outcome !== null ||
        row.measurement !== null ||
        row.transition !== null
      )
        throw Error('usd3_score_ineligible_invalid')
      continue
    }
    if (row.status === 'unavailable') {
      if (
        score.onTime ||
        row.reason !== 'capture_window_missed' ||
        row.outcome !== null ||
        row.measurement !== null ||
        row.transition !==
          (original.measurement.baselineStatus === 'covered_revert' ? 'censored' : null)
      )
        throw Error('usd3_score_censor_invalid')
      continue
    }
    if (!score.onTime || !score.target || row.status !== 'measured' || row.reason !== null)
      throw Error('usd3_score_measurement_invalid')
    const decoded = verifyUsd3Measurement({
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
      throw Error('usd3_score_source_invalid')
    for (const origin of ['primary', 'secondary'])
      for (const phase of ['before', 'after']) {
        const header = evidence.replayEvidenceDoc.headers?.[origin]?.[phase]?.target
        if (
          header?.hash !== score.target.targetHash ||
          header?.parentHash !== score.target.targetParentHash ||
          new Date(Number(BigInt(header?.timestamp ?? -1)) * 1000).toISOString() !==
            score.target.targetBlockAt
        )
          throw Error('usd3_score_header_invalid')
      }
    if (row.outcome !== classifyUsd3FutureOutcome(decoded))
      throw Error('usd3_score_outcome_invalid')
    const expectedTransition =
      original.measurement.baselineStatus === 'covered_revert'
        ? classifyUsd3ImpairedTransition(row.outcome)
        : null
    if (row.transition !== expectedTransition || row.onTime !== true)
      throw Error('usd3_score_transition_invalid')
  }
  return score
}

export function buildUsd3Score({
  issue,
  issues,
  horizonHours,
  target,
  measurements,
  scoredAtUtc,
  sequence,
  previousSha256,
  deadlineWitness = null,
}) {
  const plan = issue.targets.find((entry) => entry.horizonHours === horizonHours)
  if (!plan) throw Error('usd3_score_horizon_invalid')
  const onTime = utc(scoredAtUtc) <= utc(plan.captureDeadlineUtc)
  if (!onTime && (target !== null || Object.keys(measurements ?? {}).length))
    throw Error('usd3_score_late_measurement_invalid')
  const cases = issue.cases.map((entry) => {
    const base = { label: entry.label, assetsRaw: entry.assetsRaw }
    if (!usd3ScorableBaseline(entry))
      return {
        ...base,
        status: 'ineligible',
        reason: 'baseline_not_success',
        outcome: null,
        measurement: null,
        transition: null,
      }
    const measurement = measurements?.[entry.label] ?? null
    if (!measurement) {
      if (onTime) throw Error('usd3_score_pending_replay')
      return {
        ...base,
        status: 'unavailable',
        reason: 'capture_window_missed',
        outcome: null,
        measurement: null,
        transition: entry.measurement.baselineStatus === 'covered_revert' ? 'censored' : null,
      }
    }
    const decoded = verifyUsd3Measurement({
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
    const outcome = classifyUsd3FutureOutcome(decoded)
    return {
      ...base,
      status: 'measured',
      reason: null,
      outcome,
      measurement,
      onTime: true,
      transition:
        entry.measurement.baselineStatus === 'covered_revert'
          ? classifyUsd3ImpairedTransition(outcome)
          : null,
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
    deadlineWitness,
    cases,
  }
  validateUsd3Score(payload, issues)
  return { ...payload, sha256: sha(JSON.stringify(payload)) }
}

export async function verifyUsd3Scores(out = OUT, issueOut = ISSUE_OUT) {
  const issues = await verifyUsd3Issues(issueOut)
  const rows = await readNumbered(out)
  const seen = new Set()
  for (const row of rows) {
    validateUsd3Score(row, issues)
    const key = `${row.issueSequence}:${row.horizonHours}`
    if (seen.has(key)) throw Error('usd3_score_duplicate_target')
    seen.add(key)
  }
  return rows
}

export async function appendUsd3Score(score, out = OUT, issueOut = ISSUE_OUT, stat, options) {
  const issues = await verifyUsd3Issues(issueOut)
  validateUsd3Score(score, issues)
  const prior = await verifyUsd3Scores(out, issueOut)
  if (
    prior.some(
      (entry) =>
        entry.issueSequence === score.issueSequence && entry.horizonHours === score.horizonHours,
    )
  )
    throw Error('usd3_score_duplicate_target')
  return appendNumbered(score, out, (path) => verifyUsd3Scores(path, issueOut), stat, options)
}

export async function selectMatchingUsd3Target({
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
    throw Error('usd3_score_origin_disagreement')
  return first
}

export function validUsd3DeadlineWitness(witness, deadlineUtc) {
  return (
    witness &&
    DECIMAL.test(witness.number ?? '') &&
    BLOCK_HASH.test(witness.hash ?? '') &&
    utc(witness.atUtc) > utc(deadlineUtc) &&
    Array.isArray(witness.providers) &&
    witness.providers.length === 2 &&
    witness.providers[0] !== witness.providers[1] &&
    Array.isArray(witness.finalizedHeads) &&
    witness.finalizedHeads.length === 2 &&
    witness.finalizedHeads.every(
      (head) =>
        DECIMAL.test(head.number ?? '') &&
        BLOCK_HASH.test(head.hash ?? '') &&
        BigInt(head.number) >= BigInt(witness.number),
    )
  )
}

/** Seal a miss only after two distinct origins share a finalized header past deadline. */
export async function confirmUsd3DeadlinePassed(pairs, deadlineMs) {
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair[0].provider === pair[1].provider) continue
    try {
      const [a, b] = await Promise.all(
        pair.map(async (entry) => {
          if ((await entry.request('eth_chainId', [])) !== '0x1') throw Error('usd3_chain_invalid')
          return entry.request('eth_getBlockByNumber', ['finalized', false])
        }),
      )
      const number = BigInt(a.number) < BigInt(b.number) ? BigInt(a.number) : BigInt(b.number)
      const [left, right] = await Promise.all(
        pair.map((entry) =>
          entry.request('eth_getBlockByNumber', [`0x${number.toString(16)}`, false]),
        ),
      )
      const atMs = Number(BigInt(left.timestamp)) * 1000
      if (
        left.hash !== right.hash ||
        left.parentHash !== right.parentHash ||
        left.timestamp !== right.timestamp ||
        BigInt(left.number) !== number ||
        BigInt(right.number) !== number ||
        !BLOCK_HASH.test(left.hash ?? '') ||
        !Number.isSafeInteger(atMs) ||
        atMs <= deadlineMs
      )
        continue
      return {
        number: number.toString(),
        hash: left.hash,
        atUtc: new Date(atMs).toISOString(),
        providers: pair.map((entry) => entry.provider),
        finalizedHeads: [a, b].map((head) => ({
          number: BigInt(head.number).toString(),
          hash: head.hash,
        })),
      }
    } catch {
      // Another independent pair can still provide the finalized proof.
    }
  }
  return null
}

async function measureFuture({ issue, entry, target, primary, secondary, now }) {
  await assertUsd3ImplementationPair(primary, secondary, target.targetHash)
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
  if (verified.status !== 'verified') throw Error('usd3_future_replay_unavailable')
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

export async function scorePublicUsd3Exit({
  issueSequence,
  horizonHours,
  clients,
  originPairs,
  out = OUT,
  issueOut = ISSUE_OUT,
  now = () => new Date(),
  select = selectCarryExitV2FirstFinalizedBlock,
  confirmDeadline = confirmUsd3DeadlinePassed,
  measure = measureFuture,
  append = appendUsd3Score,
  loadIssues = verifyUsd3Issues,
  loadScores = verifyUsd3Scores,
}) {
  const issues = await loadIssues(issueOut)
  const issue = issues[issueSequence - 1]
  const plan = issue?.targets.find((entry) => entry.horizonHours === horizonHours)
  if (!issue || !plan) throw Error('usd3_score_unknown_issue_or_horizon')
  if (now().getTime() < utc(plan.targetAtUtc)) return { status: 'not_due' }
  const prior = await loadScores(out, issueOut)
  if (prior.some((row) => row.issueSequence === issueSequence && row.horizonHours === horizonHours))
    return { status: 'already_scored' }
  if (!issue.cases.some(usd3ScorableBaseline)) return { status: 'no_eligible_baseline' }
  const pairs = originPairs ?? (Array.isArray(clients) && clients.length === 2 ? [clients] : null)
  if (!Array.isArray(pairs) || !pairs.length || pairs.length > 24)
    throw Error('usd3_two_public_origins_required')
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
  if (!orderedPairs.length) throw Error('usd3_two_public_origins_required')
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
        selected = await selectMatchingUsd3Target({ issue, plan, clients: pair, select, now })
      } catch {
        continue
      }
      retryStatus = 'retry_replay_unavailable'
      let failed = false
      for (const entry of issue.cases) {
        if (!usd3ScorableBaseline(entry)) continue
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
  let deadlineWitness = null
  if (utc(scoredAtUtc) > deadlineMs) {
    deadlineWitness = await confirmDeadline(
      orderedPairs.map(({ pair }) => pair),
      deadlineMs,
    )
    if (!deadlineWitness || utc(scoredAtUtc) < utc(deadlineWitness.atUtc))
      return { status: 'retry_target_unavailable' }
    target = null
    measurements = {}
  }
  if (!target && utc(scoredAtUtc) <= deadlineMs) return { status: retryStatus }
  const score = buildUsd3Score({
    issue,
    issues,
    horizonHours,
    target,
    measurements,
    scoredAtUtc,
    sequence: prior.length + 1,
    previousSha256: prior.at(-1)?.sha256 ?? null,
    deadlineWitness,
  })
  return { status: 'scored', ...(await append(score, out, issueOut)) }
}

async function cli() {
  const [mode, sequenceRaw, horizonRaw] = process.argv.slice(2)
  if (mode === '--verify') {
    const scores = await verifyUsd3Scores()
    process.stdout.write(
      `${JSON.stringify({ status: 'verified_local_chain', scores: scores.length })}\n`,
    )
    return
  }
  if (mode !== '--score' || !DECIMAL.test(sequenceRaw ?? '') || !DECIMAL.test(horizonRaw ?? ''))
    throw Error('usd3_score_usage')
  const originPairs = rotatingUsd3OriginPairs(configuredPublicRpcUrls(readEnv()))
  const result = await scorePublicUsd3Exit({
    issueSequence: Number(sequenceRaw),
    horizonHours: Number(horizonRaw),
    originPairs,
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch(() => {
    process.stderr.write('public_usd3_score_failed\n')
    process.exitCode = 1
  })
}
