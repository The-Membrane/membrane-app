import type { NextApiRequest, NextApiResponse } from 'next'

import { neon } from '@neondatabase/serverless'

// A read-only view of recorder-published, verified research receipts. The
// publisher owns artifact verification; this boundary checks the evidence it
// receives again and releases only a small allowlist of fields.
const POINT_STUDY = 'curve-crvusd-secondary-prospective-forecast-v1'
const DURATION_STUDY = 'curve-crvusd-secondary-prospective-duration-v1'
const HORIZONS = { point_issue: [24, 168], duration_issue: [24, 72, 168] } as const
const FRESH_MS = 2 * 60 * 60 * 1000
const SHA = /^[a-f0-9]{64}$/i
const BLOCK_HASH = /^0x[a-f0-9]{64}$/i
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i

type Receipt = {
  receipt_key: unknown
  study: unknown
  kind: unknown
  status: unknown
  horizon_hours: unknown
  source_block: unknown
  source_block_hash: unknown
  source_block_at: unknown
  capture_start_at: unknown
  capture_end_at: unknown
  issued_at: unknown
  inserted_at: unknown
  source_checkpoint_sha256: unknown
  source_checkpoint_physical_sha256: unknown
  artifact_sha256: unknown
  artifact_physical_sha256: unknown
  payload: unknown
}

type JsonObject = Record<string, unknown>
const object = (value: unknown): value is JsonObject =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const sha = (value: unknown): value is string => typeof value === 'string' && SHA.test(value)
const isoTime = (value: unknown): number | null => {
  if (value instanceof Date && !Number.isFinite(value.getTime())) return null
  const raw = value instanceof Date ? value.toISOString() : value
  if (typeof raw !== 'string' || !ISO.test(raw)) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : null
}
const isoString = (ms: number) => new Date(ms).toISOString()

function readReceipt(row: Receipt, now: number) {
  const kind = row.kind
  if (kind !== 'point_issue' && kind !== 'duration_issue') return null
  const horizon = Number(row.horizon_hours)
  const block = Number(row.source_block)
  const blockAt = isoTime(row.source_block_at)
  const captureStart = isoTime(row.capture_start_at)
  const captureEnd = isoTime(row.capture_end_at)
  const issued = isoTime(row.issued_at)
  const inserted = isoTime(row.inserted_at)
  const payload = row.payload
  if (
    typeof row.receipt_key !== 'string' ||
    !row.receipt_key ||
    !HORIZONS[kind].includes(horizon as never) ||
    !Number.isSafeInteger(block) ||
    block <= 0 ||
    typeof row.source_block_hash !== 'string' ||
    !BLOCK_HASH.test(row.source_block_hash) ||
    blockAt === null ||
    captureStart === null ||
    captureEnd === null ||
    issued === null ||
    inserted === null ||
    blockAt > captureStart ||
    captureStart > captureEnd ||
    captureEnd > issued ||
    issued > inserted ||
    issued - captureEnd > FRESH_MS ||
    issued > now ||
    inserted > now + 60_000 ||
    !sha(row.source_checkpoint_sha256) ||
    !sha(row.source_checkpoint_physical_sha256) ||
    !sha(row.artifact_sha256) ||
    !sha(row.artifact_physical_sha256) ||
    !object(payload) ||
    row.study !== (kind === 'point_issue' ? POINT_STUDY : DURATION_STUDY) ||
    !finite(payload.currentQuote) ||
    payload.currentQuote <= 0 ||
    payload.currentQuote > 2
  )
    return null

  const shared = {
    kind,
    horizonHours: horizon,
    status: row.status as string,
    issuedAt: isoString(issued),
    targetAt: isoString(blockAt + horizon * 60 * 60 * 1000),
    currentQuote: payload.currentQuote,
  }
  if (kind === 'point_issue') {
    if (!['research_forecast', 'unavailable', 'insufficient_sample'].includes(shared.status))
      return null
    if (shared.status === 'research_forecast') {
      const interval = payload.empiricalAnalogInterval
      if (
        !finite(payload.projectedQuote) ||
        payload.projectedQuote < 0 ||
        payload.projectedQuote > 2 ||
        !Array.isArray(interval) ||
        interval.length !== 2 ||
        !finite(interval[0]) ||
        !finite(interval[1]) ||
        interval[0] < 0 ||
        interval[0] > interval[1] ||
        interval[1] > 2
      )
        return null
      return {
        ...shared,
        projectedQuote: payload.projectedQuote,
        empiricalAnalogInterval: interval,
      }
    }
    return shared
  }
  if (
    !['research_only', 'ineligible_anchor', 'incomplete_24h_history'].includes(shared.status) ||
    !finite(payload.threshold) ||
    payload.threshold <= 0 ||
    payload.threshold > 2
  )
    return null
  // Deliberately omit analog/unconditional survival values: they have not been
  // calibrated against prospective outcomes and are not exit probabilities.
  return { ...shared, threshold: payload.threshold }
}

function unavailable(res: NextApiResponse, reason: string) {
  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).json({ status: 'unavailable', reason, scope: 'nominal_quote_research' })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })
  if (req.query.venue !== 'scrvUSD') return res.status(404).json({ error: 'unsupported venue' })

  let rows: Receipt[]
  try {
    const url = process.env.FORECAST_READ_DATABASE_URL
    if (!url) throw new Error('FORECAST_READ_DATABASE_URL is required')
    // Dedicated read credential; never use the application's generic db.
    const readSql = neon(url)
    const result = await readSql`
      SELECT receipt_key, study, kind, status, horizon_hours, source_block,
             source_block_hash, source_block_at, capture_start_at, capture_end_at,
             issued_at, inserted_at, source_checkpoint_sha256,
             source_checkpoint_physical_sha256, artifact_sha256,
             artifact_physical_sha256, payload
      FROM public.curve_forecast_receipts
      WHERE kind IN ('point_issue', 'duration_issue')
        AND source_block = (
          SELECT MAX(source_block) FROM public.curve_forecast_receipts
          WHERE kind IN ('point_issue', 'duration_issue')
        )
      ORDER BY kind, horizon_hours`
    rows = result as Receipt[]
  } catch {
    res.setHeader('Cache-Control', 'no-store')
    return res.status(503).json({ status: 'unavailable', reason: 'forecast_store_unavailable' })
  }
  if (!rows.length) return unavailable(res, 'no_published_issues')
  if (rows.length !== 5) return unavailable(res, 'incomplete_latest_group')

  const now = Date.now()
  const first = rows[0]
  const blockAt = isoTime(first.source_block_at)
  const captureEnd = isoTime(first.capture_end_at)
  if (
    blockAt === null ||
    captureEnd === null ||
    blockAt > now ||
    captureEnd > now ||
    now - blockAt > FRESH_MS ||
    now - captureEnd > FRESH_MS
  ) {
    return unavailable(res, 'stale_source')
  }
  const items = rows.map((row) => readReceipt(row, now))
  if (items.some((item) => item === null)) return unavailable(res, 'invalid_receipt')
  const keys = new Set<string>()
  for (const row of rows) {
    const key = `${row.kind}:${row.horizon_hours}`
    if (
      keys.has(key) ||
      row.source_block !== first.source_block ||
      row.source_block_hash !== first.source_block_hash ||
      row.source_checkpoint_sha256 !== first.source_checkpoint_sha256 ||
      row.source_checkpoint_physical_sha256 !== first.source_checkpoint_physical_sha256 ||
      isoTime(row.source_block_at) !== blockAt ||
      isoTime(row.capture_start_at) !== isoTime(first.capture_start_at) ||
      isoTime(row.capture_end_at) !== captureEnd
    )
      return unavailable(res, 'mixed_latest_group')
    keys.add(key)
  }
  for (const [kind, horizons] of Object.entries(HORIZONS)) {
    for (const horizon of horizons) {
      if (!keys.has(`${kind}:${horizon}`)) return unavailable(res, 'incomplete_latest_group')
    }
  }
  const point = items.filter((item) => item?.kind === 'point_issue')
  const duration = items.filter((item) => item?.kind === 'duration_issue')
  const thresholds = duration.map((item) => (item && 'threshold' in item ? item.threshold : null))
  if (
    items.some((item) => item?.currentQuote !== items[0]?.currentQuote) ||
    thresholds.some((threshold) => threshold !== thresholds[0])
  ) {
    return unavailable(res, 'mixed_latest_group')
  }
  const hasEstimate = point.some((item) => item?.status === 'research_forecast')
  res.setHeader(
    'Cache-Control',
    hasEstimate ? 'public, s-maxage=30, stale-while-revalidate=30' : 'no-store',
  )
  return res.status(200).json({
    status: hasEstimate ? 'research_only' : 'unavailable',
    reason: hasEstimate ? null : 'forecast_abstained',
    scope: 'nominal_quote_research',
    venue: 'scrvUSD',
    input: { amount: '1000000', asset: 'crvUSD', output: 'USDT_or_USDC_nominal_usd' },
    caveat:
      'Nominal Curve get_dy quote research only. The analog interval is uncalibrated; no vault withdrawal, executable fill, or calibrated exit probability.',
    source: {
      block: Number(first.source_block),
      blockHash: first.source_block_hash,
      blockAt: isoString(blockAt),
      captureEndAt: isoString(captureEnd),
      checkpointSha256: first.source_checkpoint_sha256,
      checkpointPhysicalSha256: first.source_checkpoint_physical_sha256,
    },
    point,
    duration,
  })
}
