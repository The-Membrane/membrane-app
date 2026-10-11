import type { NextApiRequest, NextApiResponse } from 'next'

import { readVerifiedHolderExitForceabilityMatrix } from '@/scripts/research/holder-exit-forceability-matrix.mjs'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i
const CLOUD_MARKERS = [
  'VERCEL',
  'VERCEL_ENV',
  'AWS_LAMBDA_FUNCTION_NAME',
  'K_SERVICE',
  'FLY_APP_NAME',
  'RAILWAY_ENVIRONMENT',
  'RENDER',
] as const
const CACHE_MS = 30_000

type Matrix = Awaited<ReturnType<typeof readVerifiedHolderExitForceabilityMatrix>>
let cache: { matrix: Matrix; until: number } | null = null
let loading: Promise<Matrix> | null = null

function isLocalDevelopment(req: NextApiRequest): boolean {
  if (process.env.NODE_ENV !== 'development' || CLOUD_MARKERS.some((name) => process.env[name]))
    return false
  if (!LOOPBACK.has(req.socket?.remoteAddress ?? '')) return false
  const host = req.headers.host
  if (typeof host !== 'string' || !LOCAL_HOST.test(host)) return false
  const port = host.match(/:(\d+)$/)?.[1]
  if (port && Number(port) > 65535) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const url = new URL(origin)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.host.toLowerCase() === host.toLowerCase()
    )
  } catch {
    return false
  }
}

function parseSubject(query: NextApiRequest['query']) {
  if (Object.keys(query).length !== 2 || !('routeKey' in query) || !('destination' in query))
    return null
  const { routeKey, destination } = query
  if (
    typeof routeKey !== 'string' ||
    !routeKey ||
    routeKey.length > 200 ||
    routeKey !== routeKey.trim() ||
    /[\x00-\x1f\x7f]/.test(routeKey) ||
    typeof destination !== 'string' ||
    !ADDRESS.test(destination)
  )
    return null
  return { routeKey, destination: destination.toLowerCase() }
}

async function verifiedMatrix(): Promise<Matrix> {
  if (cache && Date.now() < cache.until) return cache.matrix
  if (loading) return loading
  loading = readVerifiedHolderExitForceabilityMatrix()
  try {
    const matrix = await loading
    cache = { matrix, until: Date.now() + CACHE_MS }
    return matrix
  } finally {
    loading = null
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (!isLocalDevelopment(req))
    return res.status(503).json({ status: 'unavailable', reason: 'local_only' })
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ status: 'unavailable', reason: 'get_only' })
  }
  const selected = parseSubject(req.query)
  if (!selected) return res.status(400).json({ status: 'unavailable', reason: 'invalid_subject' })
  try {
    const matrix = await verifiedMatrix()
    const matches = matrix.subjects.filter(
      (row) =>
        row.routeKey === selected.routeKey &&
        row.destination.toLowerCase() === selected.destination,
    )
    if (matches.length > 1)
      return res.status(503).json({ status: 'unavailable', reason: 'verification_unavailable' })
    if (matches.length === 0)
      return res.status(404).json({ status: 'unavailable', reason: 'subject_not_tracked' })
    const row = matches[0]
    return res.status(200).json({
      status: 'available',
      routeKey: selected.routeKey,
      destination: selected.destination,
      manifestSha256: matrix.manifestSha256,
      mechanismVersion: matrix.mechanismVersion,
      forecastValidated: false,
      holderExecutableExit: false,
      summary: {
        routeGroups: matrix.summary.routeGroups,
        exactSubjects: matrix.summary.exactSubjects,
        subjectsWithMeasuredDirectBaseline: matrix.summary.subjectsWithMeasuredDirectBaseline,
        subjectsWithHistoricalDirectFinalAssetPayout:
          matrix.summary.subjectsWithHistoricalDirectFinalAssetPayout,
        historicalDirectFinalAssetPayoutTransactions:
          matrix.summary.historicalDirectFinalAssetPayoutTransactions,
        subjectsWithHistoricalSupplierPayoutEvidence:
          matrix.summary.subjectsWithHistoricalSupplierPayoutEvidence,
        historicalSupplierSameHolderPayoutCount:
          matrix.summary.historicalSupplierSameHolderPayoutCount,
        subjectsWithStageIssue: matrix.summary.subjectsWithStageIssue,
        subjectsWithSameEpisodeFinalAssetPaidProof:
          matrix.summary.subjectsWithSameEpisodeFinalAssetPaidProof,
        subjectsWithHistoricalReceiptCohort: matrix.summary.subjectsWithHistoricalReceiptCohort,
        historicalSameReceiptHolderPaidClaims: matrix.summary.historicalSameReceiptHolderPaidClaims,
        subjectsWithHistoricalIntermediateQueue:
          matrix.summary.subjectsWithHistoricalIntermediateQueue,
        historicalIntermediatePaidClaims: matrix.summary.historicalIntermediatePaidClaims,
        historicalPendingAboveCurrentLimit: matrix.summary.historicalPendingAboveCurrentLimit,
        subjectsWithHistoricalPublicConversionQuote:
          matrix.summary.subjectsWithHistoricalPublicConversionQuote,
        subjectsWithCalibratedImpairmentDuration:
          matrix.summary.subjectsWithCalibratedImpairmentDuration,
        subjectsWithProspectiveCalibration: matrix.summary.subjectsWithProspectiveCalibration,
      },
      subject: {
        originalAsset: row.originalAsset,
        mechanism: row.mechanism,
        directIssueBaseline: row.directIssueBaseline,
        directIssueCellObservations: row.directIssueCellObservations,
        measuredDirectBaselineCellObservations: row.measuredDirectBaselineCellObservations,
        historicalDirectFinalAssetPayoutTransactions:
          row.historicalDirectFinalAssetPayoutTransactions,
        historicalSupplierPayoutEvidence: row.historicalSupplierPayoutEvidence
          ? row.historicalSupplierPayoutEvidence.status === 'observed'
            ? {
                status: 'observed',
                evidenceClass: row.historicalSupplierPayoutEvidence.evidenceClass,
                coverage: {
                  fromBlock: row.historicalSupplierPayoutEvidence.coverage.fromBlock,
                  throughBlock: row.historicalSupplierPayoutEvidence.coverage.throughBlock,
                  startMs: row.historicalSupplierPayoutEvidence.coverage.startMs,
                  endMs: row.historicalSupplierPayoutEvidence.coverage.endMs,
                  segmentCount: row.historicalSupplierPayoutEvidence.coverage.segmentCount,
                },
                classifiedReceiptPayoutCount:
                  row.historicalSupplierPayoutEvidence.classifiedReceiptPayoutCount,
                sameHolderPayoutCount: row.historicalSupplierPayoutEvidence.sameHolderPayoutCount,
                sameHolderPayoutRaw: row.historicalSupplierPayoutEvidence.sameHolderPayoutRaw,
                unclassifiedWithdrawalCount:
                  row.historicalSupplierPayoutEvidence.unclassifiedWithdrawalCount,
                historicalMax24hGrossWithdrawal:
                  row.historicalSupplierPayoutEvidence.historicalMax24hGrossWithdrawal,
                historicalMax24hGrossCometWithdrawEvents:
                  row.historicalSupplierPayoutEvidence.historicalMax24hGrossCometWithdrawEvents ??
                  null,
              }
            : { status: 'unavailable', reason: row.historicalSupplierPayoutEvidence.reason }
          : null,
        historicalStableSimulatedReverts: row.historicalStableSimulatedReverts.map((episode) => ({
          anchorBlock: episode.anchorBlock,
          anchorAtUtc: episode.anchorAtUtc,
          qLabel: episode.qLabel,
          sampledHours: episode.sampledHours,
          planSha256: episode.planSha256,
          cellSha256: episode.cellSha256,
          provenance: episode.provenance,
        })),
        stageIssue: row.stageIssue,
        stageIssueObservations: row.stageIssueObservations,
        terminalSameEpisodeFinalAssetPaidProof: row.terminalSameEpisodeFinalAssetPaidProof,
        terminalSameEpisodeFinalAssetPaidProofs: row.terminalSameEpisodeFinalAssetPaidProofs,
        historicalReceiptCohort: row.historicalReceiptCohort,
        latestOpenReceiptObservation: row.latestOpenReceiptObservation,
        historicalIntermediateQueue: row.historicalIntermediateQueue,
        latestPendingTicketObservation: row.latestPendingTicketObservation,
        historicalPublicConversionQuote: row.historicalPublicConversionQuote,
        observedRequestToPayoutSeconds: row.observedRequestToPayoutSeconds,
        calibratedImpairmentDuration: row.calibratedImpairmentDuration,
        prospectiveCalibration: row.prospectiveCalibration,
        holderExecutableExit: false,
        forecastValidated: false,
        reasons: row.reasons,
      },
    })
  } catch (error) {
    if (process.env.NODE_ENV === 'development')
      console.error('holder_exit_forceability_verification_failed', error)
    return res.status(503).json({ status: 'unavailable', reason: 'verification_unavailable' })
  }
}
