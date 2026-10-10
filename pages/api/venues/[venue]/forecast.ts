import type { NextApiRequest, NextApiResponse } from 'next'

import {
  forecastSampledCapacity,
  measureSampledCapacityPersistence,
} from '@/lib/venueForecast/sampledCapacity'
import { loadVenues } from '@/pages/api/_lib/radarReads'
import {
  readVenueForecastEvidence,
  readVenueMeasuredPersistenceEvidence,
} from '@/pages/api/_lib/venueForecastReads'

// PUBLIC, read-only. Answers an amount/horizon question for one measured route.
// A research proxy projection is never promoted to an executable exit forecast.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  const venue = Array.isArray(req.query.venue) ? req.query.venue[0] : req.query.venue
  const amountRaw = Array.isArray(req.query.amountUsd) ? '' : req.query.amountUsd
  const horizonRaw = Array.isArray(req.query.horizonHours) ? '' : req.query.horizonHours
  const amountUsd = Number(amountRaw)
  const horizonHours = Number(horizonRaw)
  const costCapRaw = Array.isArray(req.query.costCapPct) ? '' : req.query.costCapPct
  const costCapPct = costCapRaw === undefined ? undefined : Number(costCapRaw)
  if (
    !amountRaw ||
    !horizonRaw ||
    !Number.isFinite(amountUsd) ||
    amountUsd <= 0 ||
    !Number.isInteger(horizonHours) ||
    horizonHours < 1 ||
    horizonHours > 720
  ) {
    const error = 'amountUsd must be positive and horizonHours must be a whole number from 1 to 720'
    return res.status(400).json({ error })
  }
  if (costCapPct !== undefined && (!costCapRaw || !Number.isFinite(costCapPct) || costCapPct <= 0))
    return res.status(400).json({ error: 'costCapPct must be a positive recorded cost level' })
  if (typeof venue !== 'string' || !loadVenues().some((entry) => entry.name === venue)) {
    return res.status(404).json({ error: 'unknown venue' })
  }

  const allowLocalFallback =
    process.env.NODE_ENV === 'development' &&
    (req.socket?.remoteAddress === '127.0.0.1' ||
      req.socket?.remoteAddress === '::1' ||
      req.socket?.remoteAddress === '::ffff:127.0.0.1')
  let evidence: Awaited<ReturnType<typeof readVenueForecastEvidence>>
  try {
    evidence = await readVenueForecastEvidence(venue, { allowLocalFallback })
  } catch {
    res.setHeader('Cache-Control', 'no-store')
    return res.status(503).json({ error: 'venue forecast evidence unavailable' })
  }
  const asOf = new Date().toISOString()
  const routeKey = `1:${evidence.venue}:${evidence.route.metric}:${evidence.route.exitFrom.toLowerCase()}`
  const forecast = forecastSampledCapacity({
    routeKey,
    metric: evidence.route.metric,
    amountUsd,
    horizonHours,
    asOf,
    snapshots: (evidence.coverage.latestAttempt ? [] : evidence.samples).map((sample) => ({
      block: sample.block,
      observedAt: sample.observedAt,
      firstAvailableAt: sample.firstAvailableAt,
      capacityUsd: sample.capacityUsd,
      sourceId: sample.sourceId,
      coverage: sample.coverage,
    })),
  })
  const measuredEvidence = await readVenueMeasuredPersistenceEvidence(venue, {
    allowLocalFallback,
    forecastEvidence: evidence,
    ...(costCapPct === undefined ? {} : { costCapPct }),
  })
  const measuredPersistenceResult = measureSampledCapacityPersistence({
    venue: measuredEvidence.venue,
    routeKey: measuredEvidence.routeKey,
    costCapPct: measuredEvidence.costCapPct,
    amountUsd,
    asOf,
    cadenceHours: measuredEvidence.cadenceHours,
    snapshots: measuredEvidence.samples,
  })
  if (evidence.coverage.latestAttempt && measuredEvidence.source === 'recorded_cash') {
    measuredPersistenceResult.currentStatus = 'censored'
    measuredPersistenceResult.currentCensorReason =
      evidence.coverage.latestAttempt.status === 'capture_in_progress'
        ? 'latest_capture_in_progress'
        : 'latest_capture_failed'
    measuredPersistenceResult.currentRun = null
  }
  const measuredPersistence = {
    ...measuredPersistenceResult,
    source: measuredEvidence.source,
    storage: measuredEvidence.storage,
    costCapSelection: measuredEvidence.costCapSelection,
    evidenceCoverage: measuredEvidence.coverage,
    unavailableReason: measuredEvidence.unavailableReason,
  }

  res.setHeader(
    'Cache-Control',
    allowLocalFallback ? 'no-store' : 'public, s-maxage=60, stale-while-revalidate=60',
  )
  return res.status(200).json({
    venue: evidence.venue,
    chainId: evidence.chainId,
    storage: evidence.storage,
    route: evidence.route,
    latest: evidence.latest,
    coverage: evidence.coverage,
    forecast,
    measuredPersistence,
    validation: {
      holderExit: 'unavailable',
      conditionDuration: 'unavailable',
      predictiveAlert: 'unavailable',
      reason: 'independent_executable_exit_and_recovery_holdout_missing',
    },
  })
}
