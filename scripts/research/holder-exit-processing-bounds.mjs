// Historical request→operator-processing interval for a right-censored queue.
// This concerns the intermediate queue stage, not holder payout or forecast.
export const PROCESSING_HORIZON_SECONDS = 86_400

const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0
const fail = () => {
  throw Error('processing_bounds_input_invalid')
}

export function historicalProcessingWithin24h(cohort) {
  const episodes = cohort?.episodes
  const counts = cohort?.summary?.counts
  if (
    !Array.isArray(episodes) ||
    !episodes.length ||
    !counts ||
    !nonnegative(counts.requested) ||
    !nonnegative(counts.processed) ||
    !nonnegative(counts.pendingCensored) ||
    counts.requested !== episodes.length ||
    counts.processed + counts.pendingCensored !== counts.requested
  )
    fail()

  const ids = new Set()
  let processed = 0
  let censored = 0
  let confirmedProcessed = 0
  let censoredBeforeHorizon = 0
  for (const episode of episodes) {
    if (
      typeof episode?.ticketId !== 'string' ||
      !/^(0|[1-9]\d*)$/.test(episode.ticketId) ||
      ids.has(episode.ticketId) ||
      !nonnegative(episode.waitSeconds) ||
      typeof episode.waitCensored !== 'boolean'
    )
      fail()
    ids.add(episode.ticketId)
    if (episode.waitCensored) {
      if (episode.status !== 'pending_at_cutoff' || episode.processedBlock !== null) fail()
      censored++
      if (episode.waitSeconds < PROCESSING_HORIZON_SECONDS) censoredBeforeHorizon++
    } else {
      if (
        !['claimed', 'processed_unclaimed'].includes(episode.status) ||
        !Number.isSafeInteger(episode.processedBlock) ||
        episode.processedBlock <= 0
      )
        fail()
      processed++
      if (episode.waitSeconds <= PROCESSING_HORIZON_SECONDS) confirmedProcessed++
    }
  }
  if (processed !== counts.processed || censored !== counts.pendingCensored) fail()
  return {
    horizonSeconds: PROCESSING_HORIZON_SECONDS,
    confirmedProcessed,
    possibleProcessed: confirmedProcessed + censoredBeforeHorizon,
    censoredBeforeHorizon,
  }
}

export function validateProcessingWithin24h(value, { requests, processed, pendingCensored }) {
  if (
    !value ||
    Object.keys(value).sort().join(',') !==
      'censoredBeforeHorizon,confirmedProcessed,horizonSeconds,possibleProcessed' ||
    value.horizonSeconds !== PROCESSING_HORIZON_SECONDS ||
    !nonnegative(requests) ||
    !nonnegative(processed) ||
    !nonnegative(pendingCensored) ||
    processed + pendingCensored !== requests ||
    !nonnegative(value.confirmedProcessed) ||
    !nonnegative(value.possibleProcessed) ||
    !nonnegative(value.censoredBeforeHorizon) ||
    value.confirmedProcessed > processed ||
    value.censoredBeforeHorizon > pendingCensored ||
    value.possibleProcessed !== value.confirmedProcessed + value.censoredBeforeHorizon ||
    value.possibleProcessed > requests
  )
    fail()
  return value
}
