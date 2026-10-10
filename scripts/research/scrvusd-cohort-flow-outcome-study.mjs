// Offline, as-of join of sealed cohort flow context to later sampled exit outcomes.
// Descriptive research only: neither a remaining-life forecast nor a live alert.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  OUT as DURATION_OUT,
  STUDY as DURATION_STUDY,
  verify as verifyDuration,
} from './scrvusd-cohort-duration.mjs'
import {
  OUT as CONTEXT_OUT,
  STUDY as CONTEXT_STUDY,
  readSealed as readContext,
  verify as verifyContext,
} from './scrvusd-cohort-flow-context.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const validTime = (value) => Number.isSafeInteger(Date.parse(value))
const nameFor = (block) => `${String(block.number).padStart(12, '0')}-${block.hash.slice(2)}.json`
const sameBlock = (a, b) =>
  a?.number === b?.number && a?.hash === b?.hash && a?.timestamp === b?.timestamp
const validBlock = (block) =>
  Number.isSafeInteger(block?.number) &&
  Number.isSafeInteger(block?.timestamp) &&
  /^0x[0-9a-f]{64}$/.test(block?.hash ?? '')

function readSealed(path) {
  const bytes = readFileSync(path)
  const saved = JSON.parse(bytes)
  const { sha256, ...unsigned } = saved
  if (
    !bytes.equals(Buffer.from(`${JSON.stringify(saved)}\n`)) ||
    sha256 !== sha(JSON.stringify(unsigned))
  )
    throw new Error('Cohort outcome source physical or logical seal mismatch')
  return { saved, physicalSha256: sha(bytes) }
}

function ref(filename, source) {
  return { filename, logicalSha256: source.saved.sha256, physicalSha256: source.physicalSha256 }
}

function successSamples({ score, observed, anchor }) {
  if (!score) return [0]
  const future = score.futureSource?.quotes?.map((row) => row.block)
  if (
    !Array.isArray(future) ||
    future.some(
      (block, index) =>
        !validBlock(block) ||
        block.number <= (future[index - 1]?.number ?? anchor.number) ||
        block.timestamp <= (future[index - 1]?.timestamp ?? anchor.timestamp) ||
        block.number > score.through.block.number,
    ) ||
    !sameBlock(future.at(-1), score.through.block)
  )
    throw new Error('Invalid cohort score sample schedule')
  const lastSuccessBlock =
    observed.status === 'first_loss_observed'
      ? observed.firstLoss?.intervalStartBlock
      : observed.censor
        ? observed.censor.lastCleanSuccessBlock
        : score.through.block.number
  const samples = [anchor, ...future.filter((block) => block.number <= lastSuccessBlock)]
  const last = samples.at(-1)
  const lastElapsed = last.timestamp - anchor.timestamp
  if (
    !last ||
    (observed.status === 'first_loss_observed' &&
      (lastElapsed !== observed.firstLoss.lowerSeconds ||
        future.find((block) => block.number === observed.firstLoss.intervalEndBlock)?.timestamp -
          anchor.timestamp !==
          observed.firstLoss.upperSeconds)) ||
    (observed.status === 'right_censored' &&
      lastElapsed !== (observed.observedSeconds ?? observed.censor?.observedLowerSeconds))
  )
    throw new Error('Cohort score member disagrees with sealed sample schedule')
  return samples.map((block) => block.timestamp - anchor.timestamp)
}

function outcomeAtHorizon(observed, sampledSuccessSeconds, horizonSeconds) {
  if (sampledSuccessSeconds.includes(horizonSeconds)) return 'sampled_success_at_horizon'
  if (!observed) return 'pending_followup'
  if (observed.status === 'unexposed_at_issue') return 'unexposed_at_issue'
  if (observed.status === 'first_loss_observed') {
    const { upperSeconds } = observed.firstLoss
    if (horizonSeconds >= upperSeconds) return 'first_revert_observed_by_horizon'
    if (horizonSeconds < sampledSuccessSeconds.at(-1)) return 'unobserved_between_samples'
    return 'first_loss_interval_straddles_horizon'
  }
  if (observed.status !== 'right_censored') throw new Error('Unknown cohort outcome status')
  if (horizonSeconds < sampledSuccessSeconds.at(-1)) return 'unobserved_between_samples'
  return observed.censor ? 'ambiguous_right_censor' : 'observed_success_right_censor'
}

export function joinIssue({ duration, durationRef, context, contextRef, scores = [] }) {
  if (
    duration?.study !== DURATION_STUDY ||
    context?.study !== CONTEXT_STUDY ||
    !sameBlock(duration.block, context.block) ||
    !validTime(duration.issuedAtUtc) ||
    !validTime(context.issuedAtUtc) ||
    Date.parse(context.issuedAtUtc) < Date.parse(duration.issuedAtUtc) ||
    context.historicalSuffix?.evidenceCutoffUtc !== duration.issuedAtUtc ||
    context.cohortDurationIssue?.filename !== nameFor(duration.block) ||
    context.cohortDurationIssue?.logicalSha256 !== duration.sha256 ||
    context.cohortDurationIssue?.physicalSha256 !== durationRef?.physicalSha256 ||
    contextRef?.filename !== nameFor(duration.block) ||
    contextRef?.logicalSha256 !== context.sha256 ||
    durationRef?.filename !== nameFor(duration.block) ||
    durationRef?.logicalSha256 !== duration.sha256 ||
    duration.riskSet?.forecast?.status !== 'unavailable' ||
    duration.riskSet?.pairCount !== 16 ||
    context.cohort?.pairCount !== 16 ||
    context.cohort?.distinctHolderCount !== 5 ||
    context.cohort?.vaultCount !== 1
  )
    throw new Error('Cohort context does not bind exact duration issue and as-of cutoff')
  const flow = context.sameBlockFlowFeatureIssue
  if (!['available', 'unavailable'].includes(flow?.status))
    throw new Error('Unknown same-block flow status')
  if (
    flow.status === 'available' &&
    (!validTime(flow.issuedAtUtc) ||
      Date.parse(flow.issuedAtUtc) > Date.parse(duration.issuedAtUtc) ||
      flow.flowFeatures?.checkpoint?.blockNumber !== duration.block.number ||
      flow.flowFeatures?.checkpoint?.blockHash !== duration.block.hash ||
      flow.flowFeatures?.checkpoint?.timestamp !== duration.block.timestamp)
  )
    throw new Error('Same-block flow unavailable as of duration issue')
  if (
    !context.historicalSuffix?.maximumObservedCompleteWindow ||
    !context.historicalSuffix?.maximumObservedCompleteWindowNetDepletion
  )
    throw new Error('Historical complete-window context unavailable')

  const candidates = scores.map(({ score, scoreRef }) => {
    if (
      score?.study !== `${DURATION_STUDY}-score-v1` ||
      score.issueSha256 !== duration.sha256 ||
      !validTime(score.scoredAtUtc) ||
      Date.parse(score.scoredAtUtc) < Date.parse(duration.issuedAtUtc) ||
      scoreRef?.logicalSha256 !== score.sha256 ||
      !validBlock(score.through?.block) ||
      score.through.block.number <= duration.block.number ||
      score.members?.length !== duration.riskSet.members.length ||
      score.members.some(
        (member, index) =>
          member.holder !== duration.riskSet.members[index].holder ||
          member.rawCrvUsd !== duration.riskSet.members[index].rawCrvUsd,
      )
    )
      throw new Error('Cohort score does not bind duration issue and fixed roster')
    return { score, scoreRef }
  })
  candidates.sort((a, b) => a.score.through.block.number - b.score.through.block.number)
  const latest = candidates.at(-1) ?? null
  const members = duration.riskSet.members.map((entry, index) => ({
    holder: entry.holder,
    rawCrvUsd: entry.rawCrvUsd,
    cleanSuccessAtAnchor: entry.cleanSuccessAtAnchor,
    observed: latest?.score.members[index].observed ?? null,
    sampledSuccessSeconds: entry.cleanSuccessAtAnchor
      ? successSamples({
          score: latest?.score ?? null,
          observed: latest?.score.members[index].observed ?? null,
          anchor: duration.block,
        })
      : [],
  }))
  return {
    anchor: duration.block,
    anchorIssuedAtUtc: duration.issuedAtUtc,
    durationIssue: durationRef,
    flowContextIssue: contextRef,
    flowContextRecordedAtUtc: context.issuedAtUtc,
    sameBlockFlow: flow,
    historicalSuffix: {
      evidenceCutoffUtc: context.historicalSuffix.evidenceCutoffUtc,
      coverage: context.historicalSuffix.coverage,
      completeToFirstLive: context.historicalSuffix.completeToFirstLive,
      maximumObservedCompleteWindow: context.historicalSuffix.maximumObservedCompleteWindow,
      maximumObservedCompleteWindowNetDepletion:
        context.historicalSuffix.maximumObservedCompleteWindowNetDepletion,
    },
    latestScore: latest
      ? {
          ...latest.scoreRef,
          scoredAtUtc: latest.score.scoredAtUtc,
          through: latest.score.through.block,
        }
      : { status: 'pending_followup' },
    members,
  }
}

export function summarize(issues, horizonSeconds) {
  if (!Number.isSafeInteger(horizonSeconds) || horizonSeconds < 0)
    throw new Error('Invalid horizon seconds')
  const rows = issues.flatMap((issue) =>
    issue.members.map((member) => ({
      anchor: issue.anchor,
      holder: member.holder,
      rawCrvUsd: member.rawCrvUsd,
      class: member.cleanSuccessAtAnchor
        ? outcomeAtHorizon(member.observed, member.sampledSuccessSeconds, horizonSeconds)
        : 'unexposed_at_issue',
    })),
  )
  const counts = rows.reduce((result, row) => {
    result[row.class] = (result[row.class] ?? 0) + 1
    return result
  }, {})
  return {
    horizonSeconds,
    horizonOrigin: 'anchor_block_time',
    dependentAnchorPairCount: rows.length,
    distinctHolderCount: new Set(rows.map((row) => row.holder)).size,
    vaultCount: issues.length ? 1 : 0,
    counts,
    forecast: { status: 'unavailable', reason: 'no_independent_calibration' },
    caveat:
      'A clean sample proves only that sampled checkpoint, not every intervening second. A first revert observed by a horizon does not describe exit ability at that horizon. These overlapping pairs share one vault; no probability, continuous exit guarantee, remaining-life estimate, or cash runway is established.',
  }
}

export function study({
  durationOut = DURATION_OUT,
  contextOut = CONTEXT_OUT,
  horizons = [],
} = {}) {
  verifyDuration({ out: durationOut })
  verifyContext({ out: contextOut })
  const issueDir = join(durationOut, 'issues')
  const scoreDir = join(durationOut, 'scores')
  const filenames = existsSync(issueDir)
    ? readdirSync(issueDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
  const scoreNames = existsSync(scoreDir)
    ? readdirSync(scoreDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
  const issues = filenames.map((filename) => {
    const duration = readSealed(join(issueDir, filename))
    if (filename !== nameFor(duration.saved.block))
      throw new Error('Invalid duration issue filename')
    const context = readContext(join(contextOut, filename))
    const contextBytes = readFileSync(join(contextOut, filename))
    const scores = scoreNames
      .filter((name) => name.startsWith(`${filename}.through-`))
      .map((name) => {
        const source = readSealed(join(scoreDir, name))
        if (
          name !==
          `${filename}.through-${String(source.saved.through.block.number).padStart(12, '0')}.json`
        )
          throw new Error('Invalid cohort score filename')
        return { score: source.saved, scoreRef: ref(name, source) }
      })
    return joinIssue({
      duration: duration.saved,
      durationRef: ref(filename, duration),
      context,
      contextRef: { filename, logicalSha256: context.sha256, physicalSha256: sha(contextBytes) },
      scores,
    })
  })
  return {
    study: 'scrvusd-cohort-flow-outcome-study-v1',
    status: issues.length ? 'descriptive_uncalibrated' : 'unavailable',
    issues,
    horizons: horizons.map((horizon) => summarize(issues, horizon)),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const horizons = process.argv.slice(2).map(Number)
    console.log(JSON.stringify(study({ horizons })))
  } catch {
    console.error('[scrvusd-cohort-flow-outcome-study] unavailable')
    process.exitCode = 1
  }
}
