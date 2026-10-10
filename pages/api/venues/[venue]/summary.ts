import type { NextApiRequest, NextApiResponse } from 'next'
import { readFileSync } from 'fs'
import { join } from 'path'

import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { LABELS } from '@/pages/api/_lib/radarReads'
// Import the SAME pure helper the alarm checker uses — do NOT duplicate the
// uncovered-signal logic (precedent: pages/api/_lib/radarReads.ts imports
// @/scripts/lib/position-reads.mjs from TS, so a .mjs import compiles here).
import { coverageFor, instantExitUsd } from '@/scripts/lib/alarmRules.mjs'
import { aTokenSuppliedUsd } from '@/scripts/lib/venue-reads.mjs'
import {
  localObservationIsNewer,
  localOnlyVenueSummary,
  readLocalVenueSummary,
} from '@/scripts/lib/venueSummaryLocal.mjs'
import { isSuspendedFlowAlarm } from '@/components/Radar/alertLogic'

// PUBLIC. The per-venue SUMMARY the /venue/[name] permalink is built on. One
// request assembles the venue's latest observed state, its recorder-corpus
// coverage, outflow availability, and the honest danger picture
// (open alarms + the blind-spot list). Observed state can also come from the
// verified local snapshot chain on this Mac; there are no chain reads. Numbers-first,
// provenance-stamped: a figure with no
// measurement date is a rumour (db/schema.sql).
//
// News and the venue change-log are served by their own endpoints
// (/api/venues/news?venue= and /api/venues/log) and fetched separately by the
// page — this route stays the state+coverage+danger core. Cached s-maxage 300.

type FullVenueConfig = {
  name: string
  kind: string
  enabled: boolean
  address?: string
  underlying?: string
  decimals?: number
  termsUrl?: string
  depthCoveredByInstant?: boolean
  depthMarkets?: Array<{ enabled?: boolean }>
}

function loadFullVenues(): FullVenueConfig[] {
  const raw = readFileSync(join(process.cwd(), 'tools', 'venue-recorder.config.json'), 'utf8')
  return (JSON.parse(raw).venues as FullVenueConfig[]).filter((v) => v.enabled)
}

export type VenueSummary = {
  venue: string
  label: string
  kind: string
  observed: {
    block: number
    observedAt: string
    sourceAt?: string
    fetchedAt?: string
    firstLocalReceiptAt?: string
    instantUsd: number | null
    params: {
      totalAssets: string | null
      cooldownDuration: number | null
      utilizationPct: number | null
      depthUsd: number | null
      depthSkewPct: number | null
      depthMarkets: Array<Record<string, unknown>> | null
    }
  } | null
  /** Latest verified Aave supplied-stock read; it may predate `observed`. */
  suppliedTvl: { usd: number; block: number; observedAt: string } | null
  corpus: {
    snapshots: number
    snapshotsObserved: number
    snapshotSpan: { start: string | null; end: string | null }
    flows: number | null
    flowSpan: { start: string | null; end: string | null }
    news: number | null
    status: 'database' | 'database_unreconciled' | 'local_only'
  }
  worstOutflows: {
    d1: { usd: number; date: string } | null
    d7: { usd: number; date: string } | null
    status: 'unavailable'
    reason: 'legacy_flow_coverage_uncertified'
  }
  alarms: {
    open: Array<{
      kind: string
      severity: 'watch' | 'alarm' | 'notice'
      evidence: Record<string, unknown> | null
      firedAt: string
    }>
    uncovered: Array<{ id: string; label: string; memo: string }>
    status: 'available' | 'database_unreconciled' | 'unknown'
  }
  provenance: {
    storage: 'database' | 'local_mac_recorder'
    observationStatus: 'fresh' | 'stale' | 'missing' | 'unknown'
    databaseStatus: 'available' | 'available_lagging' | 'unavailable'
    sourceAt: string | null
    fetchedAt: string | null
    firstLocalReceiptAt: string | null
  }
}

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null)
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const LOCAL_MAX_AGE_MS = 3 * 60 * 60 * 1_000
const FUTURE_SKEW_MS = 5 * 60 * 1_000
const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/
const BLOCK_NUMBER = /^\d{1,78}$/

// DB observed_at is fetch time; the saved finalized block seal supplies source time.
function sealedDatabaseSourceAt(
  row: Record<string, unknown>,
  observedAt: string,
  nowMs: number,
): string | null {
  const params = row.params as Record<string, unknown> | null
  const block = String(row.block ?? '')
  const sealedBlock = String(params?.read_block_number ?? '')
  const seconds = params?.read_block_time
  if (
    params?.read_block_finalized !== true ||
    params.read_block_pinned !== true ||
    typeof params.read_block_hash !== 'string' ||
    !BLOCK_HASH.test(params.read_block_hash) ||
    !BLOCK_NUMBER.test(block) ||
    !BLOCK_NUMBER.test(sealedBlock) ||
    BigInt(block) !== BigInt(sealedBlock) ||
    typeof seconds !== 'number' ||
    !Number.isSafeInteger(seconds) ||
    seconds <= 0
  )
    return null
  const sourceMs = seconds * 1_000
  const fetchedMs = Date.parse(observedAt)
  if (
    !Number.isFinite(sourceMs) ||
    !Number.isFinite(fetchedMs) ||
    sourceMs > fetchedMs + 120_000 ||
    sourceMs > nowMs + FUTURE_SKEW_MS ||
    sourceMs > 8_640_000_000_000_000
  )
    return null
  return new Date(sourceMs).toISOString()
}

const isLocalDevelopment = (req: NextApiRequest) =>
  process.env.NODE_ENV === 'development' &&
  (req.socket?.remoteAddress === '127.0.0.1' ||
    req.socket?.remoteAddress === '::1' ||
    req.socket?.remoteAddress === '::ffff:127.0.0.1')

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const raw = req.query.venue
  const venue = Array.isArray(raw) ? raw[0] : raw
  const venues = loadFullVenues()
  const cfg = venue ? venues.find((v) => v.name === venue) : undefined
  if (!venue || !cfg) {
    return res.status(404).json({
      error: 'unknown venue',
      validVenues: venues.map((v) => v.name),
    })
  }

  // A local chain can advance after the legacy recorder stops writing to DB.
  // A failed local verification never replaces a working DB result.
  let localSnapshot: ReturnType<typeof readLocalVenueSummary> | null = null
  let localSnapshotStatus = 'unavailable'
  if (isLocalDevelopment(req)) {
    try {
      localSnapshot = readLocalVenueSummary(venue, cfg)
      localSnapshotStatus = localSnapshot.status
    } catch {
      localSnapshotStatus = 'invalid'
    }
  }

  try {
    // 1) Latest OBSERVED snapshot — state + params.
    const latestRes = await db.execute(sql`
    SELECT block, observed_at, instant_usd, params
    FROM venue_snapshots
    WHERE venue = ${venue} AND source = 'observed'
    ORDER BY observed_at DESC
    LIMIT 1`)
    const latest = (latestRes.rows as any[])[0]
    const params = (latest?.params ?? {}) as Record<string, unknown>

    // The latest cash snapshot and latest *valid supply* snapshot are independent.
    // A failed totalSupply read on a later hourly tick must not erase a prior
    // measured stock or pretend that stock was read at the latest cash block.
    // Query only saved rows: this does not poll the chain or change recorder cadence.
    let suppliedTvl: VenueSummary['suppliedTvl'] = null
    if (cfg.kind === 'atoken-liquidity') {
      const supplyRes = await db.execute(sql`
      SELECT block, observed_at, params
      FROM venue_snapshots
      WHERE venue = ${venue} AND source = 'observed'
        AND lower(params ->> 'aToken') = lower(${cfg.address ?? ''})
        AND lower(params ->> 'underlying') = lower(${cfg.underlying ?? ''})
        AND params ->> 'underlyingIdentity' = 'match'
        AND params ->> 'decimalsIdentity' = 'match'
        AND params ->> 'decimals' = ${String(cfg.decimals ?? '')}
        AND params ->> 'priceAssumptionUsd' = '1'
        AND params -> 'reads' ->> 'totalSupply' = 'true'
        AND params ->> 'totalSupply' ~ '^[0-9]{1,78}$'
      ORDER BY observed_at DESC, block DESC
      LIMIT 1`)
      const source = (supplyRes.rows as any[])[0]
      const usd = source ? aTokenSuppliedUsd(source.params) : null
      if (usd !== null) {
        suppliedTvl = {
          usd,
          block: Number(source.block),
          observedAt: new Date(source.observed_at as string).toISOString(),
        }
      }
    }

    const nowMs = Date.now()
    const fetchedAt = latest ? new Date(latest.observed_at as string).toISOString() : null
    const sourceAt = latest && fetchedAt ? sealedDatabaseSourceAt(latest, fetchedAt, nowMs) : null
    const observed =
      latest && fetchedAt
        ? {
            block: Number(latest.block),
            observedAt: fetchedAt,
            ...(sourceAt ? { sourceAt } : {}),
            instantUsd: numOrNull(latest.instant_usd),
            params: {
              totalAssets: params.totalAssets != null ? String(params.totalAssets) : null,
              cooldownDuration: numOrNull(params.cooldownDuration),
              utilizationPct: numOrNull(params.utilization_pct),
              depthUsd: numOrNull(params.depth_usd),
              depthSkewPct: numOrNull(params.depth_skew_pct),
              depthMarkets: Array.isArray(params.depthMarkets)
                ? (params.depthMarkets as Array<Record<string, unknown>>)
                : null,
            },
          }
        : null

    // 2) Corpus coverage — counts + spans for snapshots, flows, news.
    const snapCorpusRes = await db.execute(sql`
    SELECT COUNT(*) AS rows,
           COUNT(*) FILTER (WHERE source = 'observed') AS observed,
           MIN(observed_at) AS span_start, MAX(observed_at) AS span_end
    FROM venue_snapshots WHERE venue = ${venue}`)
    const sc = (snapCorpusRes.rows as any[])[0] ?? {}
    const flowCorpusRes = await db.execute(sql`
    SELECT COUNT(*) AS rows, MIN(block_time) AS span_start, MAX(block_time) AS span_end
    FROM venue_flows WHERE venue = ${venue}`)
    const fc = (flowCorpusRes.rows as any[])[0] ?? {}
    const newsCorpusRes = await db.execute(sql`
    SELECT COUNT(*) AS rows FROM venue_news WHERE venue = ${venue}`)
    const nc = (newsCorpusRes.rows as any[])[0] ?? {}

    // 3) Open alarms for this venue + the honest uncovered (blind-spot) list.
    const openRes = await db.execute(sql`
    SELECT kind, severity, evidence, fired_at AS "firedAt"
    FROM venue_alarms
    WHERE venue = ${venue} AND cleared_at IS NULL
      AND kind NOT IN ('net_outflow_streak', 'headroom_thin')
    ORDER BY fired_at DESC`)

    // instant_usd, else the recorded instant swap-out depth (depth_usd) — the same
    // capacity the checker's headroom rule judges (alarmRules.mjs instantExitUsd).
    const hasInstant = instantExitUsd(latest) !== null
    const uncovered = coverageFor(cfg, { hasInstant })

    const summary: VenueSummary = {
      venue,
      label: LABELS[venue] ?? venue,
      kind: cfg.kind,
      observed,
      suppliedTvl,
      corpus: {
        snapshots: Number(sc.rows ?? 0),
        snapshotsObserved: Number(sc.observed ?? 0),
        snapshotSpan: { start: iso(sc.span_start), end: iso(sc.span_end) },
        flows: Number(fc.rows ?? 0),
        flowSpan: { start: iso(fc.span_start), end: iso(fc.span_end) },
        news: Number(nc.rows ?? 0),
        status: 'database',
      },
      worstOutflows: {
        d1: null,
        d7: null,
        status: 'unavailable',
        reason: 'legacy_flow_coverage_uncertified',
      },
      alarms: {
        open: (openRes.rows as any[])
          .filter((r) => !isSuspendedFlowAlarm(r))
          .map((r) => ({
            kind: r.kind as string,
            severity: r.severity as 'watch' | 'alarm' | 'notice',
            evidence: (r.evidence as Record<string, unknown>) ?? null,
            firedAt: new Date(r.firedAt as string).toISOString(),
          })),
        uncovered,
        status: 'available',
      },
      provenance: {
        storage: 'database',
        observationStatus: !observed
          ? 'missing'
          : !sourceAt
            ? 'stale'
            : Date.parse(observed.observedAt) > nowMs + FUTURE_SKEW_MS
              ? 'unknown'
              : nowMs - Date.parse(observed.observedAt) > LOCAL_MAX_AGE_MS ||
                  nowMs - Date.parse(sourceAt) > LOCAL_MAX_AGE_MS
                ? 'stale'
                : 'fresh',
        databaseStatus: 'available',
        sourceAt,
        fetchedAt,
        firstLocalReceiptAt: null,
      },
    }

    if (
      localSnapshot?.observed &&
      localSnapshot.times &&
      localObservationIsNewer(localSnapshot, observed)
    ) {
      summary.observed = localSnapshot.observed
      summary.suppliedTvl = localSnapshot.suppliedTvl ?? suppliedTvl
      summary.alarms.uncovered = coverageFor(cfg, { hasInstant: localSnapshot.hasInstant })
      summary.alarms.status = 'database_unreconciled'
      summary.corpus.status = 'database_unreconciled'
      summary.provenance = {
        storage: 'local_mac_recorder',
        observationStatus: localSnapshot.status === 'stale' ? 'stale' : 'fresh',
        databaseStatus: 'available_lagging',
        sourceAt: localSnapshot.times.sourceAt,
        fetchedAt: localSnapshot.times.fetchedAt,
        firstLocalReceiptAt: localSnapshot.times.firstLocalReceiptAt,
      }
    }

    res.setHeader(
      'Cache-Control',
      summary.provenance.storage === 'local_mac_recorder'
        ? 'no-store'
        : 'public, s-maxage=300, stale-while-revalidate=600',
    )
    return res.status(200).json(summary)
  } catch {
    if (!localSnapshot?.observed || localSnapshot.status === 'unknown')
      return res.status(503).json({
        error: 'venue_summary_unavailable',
        databaseStatus: 'unavailable',
        localSnapshotStatus,
      })
    try {
      const summary = localOnlyVenueSummary(venue, LABELS[venue] ?? venue, cfg, localSnapshot)
      res.setHeader('Cache-Control', 'no-store')
      return res.status(200).json(summary)
    } catch {
      return res.status(503).json({
        error: 'venue_summary_unavailable',
        databaseStatus: 'unavailable',
        localSnapshotStatus: 'invalid',
      })
    }
  }
}
