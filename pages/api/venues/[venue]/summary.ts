import type { NextApiRequest, NextApiResponse } from 'next'
import { readFileSync } from 'fs'
import { join } from 'path'

import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { LABELS } from '@/pages/api/_lib/radarReads'
// Import the SAME pure helper the alarm checker uses — do NOT duplicate the
// uncovered-signal logic (precedent: pages/api/_lib/radarReads.ts imports
// @/scripts/lib/position-reads.mjs from TS, so a .mjs import compiles here).
import { uncoveredFor } from '@/scripts/lib/alarmRules.mjs'

// PUBLIC. The per-venue SUMMARY the /venue/[name] permalink is built on. One
// request assembles the venue's latest observed state, its recorder-corpus
// coverage, the worst recorded realized outflows, and the honest danger picture
// (open alarms + the blind-spot list). Everything is READ FROM THE RECORDER DB —
// no chain reads. Numbers-first, provenance-stamped: a figure with no
// measurement date is a rumour (db/schema.sql).
//
// News and the venue change-log are served by their own endpoints
// (/api/venues/news?venue= and /api/venues/log) and fetched separately by the
// page — this route stays the state+coverage+danger core. Cached s-maxage 300.

type FullVenueConfig = {
  name: string
  kind: string
  enabled: boolean
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
  corpus: {
    snapshots: number
    snapshotsObserved: number
    snapshotSpan: { start: string | null; end: string | null }
    flows: number
    flowSpan: { start: string | null; end: string | null }
    news: number
  }
  worstOutflows: {
    d1: { usd: number; date: string } | null
    d7: { usd: number; date: string } | null
  }
  alarms: {
    open: Array<{
      kind: string
      severity: 'watch' | 'alarm'
      evidence: Record<string, unknown> | null
      firedAt: string
    }>
    uncovered: Array<{ id: string; label: string; memo: string }>
  }
}

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null)
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v)

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

  // 1) Latest OBSERVED snapshot — state + params.
  const latestRes = await db.execute(sql`
    SELECT block, observed_at, instant_usd, params
    FROM venue_snapshots
    WHERE venue = ${venue} AND source = 'observed'
    ORDER BY observed_at DESC
    LIMIT 1`)
  const latest = (latestRes.rows as any[])[0]
  const params = (latest?.params ?? {}) as Record<string, unknown>

  const observed = latest
    ? {
        block: Number(latest.block),
        observedAt: new Date(latest.observed_at as string).toISOString(),
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

  // 3) Worst recorded realized outflows over the trailing 90d (+ their dates).
  //    assets_raw is underlying base units; all four venues' underlying is
  //    18-decimal (SCALE 1e18), matching scripts/check-venue-alarms.mjs.
  const worst1dRes = await db.execute(sql`
    WITH daily AS (
      SELECT date_trunc('day', block_time) AS d, SUM(assets_raw::numeric) / 1e18 AS out_usd
      FROM venue_flows
      WHERE venue = ${venue} AND direction = 'out' AND block_time > now() - interval '90 days'
      GROUP BY 1
    )
    SELECT d, out_usd FROM daily ORDER BY out_usd DESC LIMIT 1`)
  const w1 = (worst1dRes.rows as any[])[0]
  const worst7dRes = await db.execute(sql`
    WITH daily AS (
      SELECT date_trunc('day', block_time) AS d, SUM(assets_raw::numeric) / 1e18 AS out_usd
      FROM venue_flows
      WHERE venue = ${venue} AND direction = 'out' AND block_time > now() - interval '97 days'
      GROUP BY 1
    ), roll AS (
      SELECT d, SUM(out_usd) OVER (
               ORDER BY d RANGE BETWEEN interval '6 days' PRECEDING AND CURRENT ROW
             ) AS w7
      FROM daily
    )
    SELECT d, w7 FROM roll WHERE d > now() - interval '90 days' ORDER BY w7 DESC LIMIT 1`)
  const w7 = (worst7dRes.rows as any[])[0]

  // 4) Open alarms for this venue + the honest uncovered (blind-spot) list.
  const openRes = await db.execute(sql`
    SELECT kind, severity, evidence, fired_at AS "firedAt"
    FROM venue_alarms
    WHERE venue = ${venue} AND cleared_at IS NULL
    ORDER BY fired_at DESC`)

  const hasInstant = !!observed && observed.instantUsd !== null
  const depthCovered =
    (cfg.depthMarkets ?? []).some((m) => m.enabled) || cfg.depthCoveredByInstant === true
  const termsCovered = !!cfg.termsUrl
  const uncovered = uncoveredFor({ hasInstant, depthCovered, termsCovered })

  const summary: VenueSummary = {
    venue,
    label: LABELS[venue] ?? venue,
    kind: cfg.kind,
    observed,
    corpus: {
      snapshots: Number(sc.rows ?? 0),
      snapshotsObserved: Number(sc.observed ?? 0),
      snapshotSpan: { start: iso(sc.span_start), end: iso(sc.span_end) },
      flows: Number(fc.rows ?? 0),
      flowSpan: { start: iso(fc.span_start), end: iso(fc.span_end) },
      news: Number(nc.rows ?? 0),
    },
    worstOutflows: {
      d1: w1 ? { usd: Number(w1.out_usd), date: new Date(w1.d as string).toISOString() } : null,
      d7: w7 ? { usd: Number(w7.w7), date: new Date(w7.d as string).toISOString() } : null,
    },
    alarms: {
      open: (openRes.rows as any[]).map((r) => ({
        kind: r.kind as string,
        severity: r.severity as 'watch' | 'alarm',
        evidence: (r.evidence as Record<string, unknown>) ?? null,
        firedAt: new Date(r.firedAt as string).toISOString(),
      })),
      uncovered,
    },
  }

  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
  return res.status(200).json(summary)
}
