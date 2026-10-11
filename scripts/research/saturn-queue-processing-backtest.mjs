// Exploratory chronological check of an intermediate queue stage. This is
// not a holder exit, an untouched holdout, or a deployable forecast.
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

import { TO } from './saturn-queue-event-cohort.mjs'
import { verifyEpisodes } from './saturn-queue-episode-cohort.mjs'

export const HORIZON_SECONDS = 86_400
const isTime = (value) => Number.isSafeInteger(value) && value > 0
const utc = (seconds) => new Date(seconds * 1_000).toISOString()

function outcomeAt(episode, asOf, horizonSeconds) {
  const requestAt = episode.requestTimestamp
  const processedAt = episode.waitCensored ? null : requestAt + episode.waitSeconds
  if (requestAt > asOf) return null
  if (processedAt !== null && processedAt <= asOf && episode.waitSeconds <= horizonSeconds)
    return true
  if (requestAt + horizonSeconds <= asOf) return false
  return null
}

const ticketOrder = (a, b) =>
  a.requestTimestamp - b.requestTimestamp ||
  a.requestBlock - b.requestBlock ||
  (BigInt(a.ticketId) < BigInt(b.ticketId) ? -1 : BigInt(a.ticketId) > BigInt(b.ticketId) ? 1 : 0)

function tally(episodes, asOf, horizonSeconds) {
  let processedWithinHorizon = 0
  let notProcessedWithinHorizon = 0
  let censored = 0
  for (const episode of episodes) {
    const outcome = outcomeAt(episode, asOf, horizonSeconds)
    if (outcome === true) processedWithinHorizon++
    else if (outcome === false) notProcessedWithinHorizon++
    else censored++
  }
  const evaluable = processedWithinHorizon + notProcessedWithinHorizon
  return {
    requested: episodes.length,
    evaluable,
    processedWithinHorizon,
    notProcessedWithinHorizon,
    censored,
    observedRate: evaluable ? processedWithinHorizon / evaluable : null,
  }
}

/** Simulate an as-of estimate from early tickets, then inspect later tickets. */
export function diagnoseSaturnQueueProcessing(
  episodes,
  finalCutoffTimestamp,
  { horizonSeconds = HORIZON_SECONDS } = {},
) {
  if (
    !Array.isArray(episodes) ||
    episodes.length < 4 ||
    !isTime(finalCutoffTimestamp) ||
    !isTime(horizonSeconds)
  )
    throw Error('saturn_processing_diagnostic_input_invalid')
  const ids = new Set()
  for (const episode of episodes) {
    if (
      !/^(0|[1-9]\d*)$/.test(episode?.ticketId ?? '') ||
      ids.has(episode.ticketId) ||
      !isTime(episode.requestTimestamp) ||
      !Number.isSafeInteger(episode.requestBlock) ||
      episode.requestBlock <= 0 ||
      !Number.isSafeInteger(episode.waitSeconds) ||
      episode.waitSeconds < 0 ||
      typeof episode.waitCensored !== 'boolean' ||
      (episode.waitCensored &&
        episode.requestTimestamp + episode.waitSeconds !== finalCutoffTimestamp) ||
      episode.requestTimestamp + episode.waitSeconds > finalCutoffTimestamp
    )
      throw Error('saturn_processing_diagnostic_episode_invalid')
    ids.add(episode.ticketId)
  }
  const ordered = [...episodes].sort(ticketOrder)
  const splitTimestamp = ordered[Math.floor(ordered.length / 2)].requestTimestamp
  if (splitTimestamp <= ordered[0].requestTimestamp || splitTimestamp >= finalCutoffTimestamp)
    throw Error('saturn_processing_diagnostic_split_invalid')
  const early = ordered.filter((episode) => episode.requestTimestamp < splitTimestamp)
  const later = ordered.filter((episode) => episode.requestTimestamp >= splitTimestamp)
  const train = tally(early, splitTimestamp, horizonSeconds)
  const evaluation = tally(later, finalCutoffTimestamp, horizonSeconds)
  const probability = train.observedRate
  return {
    study: 'saturn_queue_processing_chronological_diagnostic_v1',
    scope: 'request_to_operator_processing_only',
    horizonSeconds,
    split: {
      method: 'retrospective_median_request_timestamp',
      atUtc: utc(splitTimestamp),
      finalCutoffAtUtc: utc(finalCutoffTimestamp),
    },
    train,
    later: evaluation,
    comparison:
      probability === null || evaluation.observedRate === null
        ? null
        : {
            earlyRateAppliedToLater: probability,
            expectedLaterProcessed: probability * evaluation.evaluable,
            observedLaterProcessed: evaluation.processedWithinHorizon,
            absoluteRateError: Math.abs(probability - evaluation.observedRate),
          },
    prospectiveValidated: false,
    fullRouteExitAssessed: false,
  }
}

export async function readVerifiedSaturnProcessingDiagnostic() {
  const cohort = await verifyEpisodes()
  const cutoff = cohort.headers.find((header) => header.number === TO)?.timestamp
  if (!isTime(cutoff)) throw Error('saturn_processing_diagnostic_cutoff_missing')
  return {
    sourceEpisodeSha256: cohort.sha256,
    ...diagnoseSaturnQueueProcessing(cohort.episodes, cutoff),
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] !== '--verify')
    throw Error(
      'usage: node --import tsx scripts/research/saturn-queue-processing-backtest.mjs --verify',
    )
  console.log(JSON.stringify(await readVerifiedSaturnProcessingDiagnostic()))
}
