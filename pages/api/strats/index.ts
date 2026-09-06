import type { NextApiRequest, NextApiResponse } from 'next'
import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { loadVenues, readCorpus, assembleRadar } from '@/pages/api/_lib/radarReads'
import {
  shortAddress,
  worstVerdict,
  deltaOf,
  sortByCurrentDesc,
  totalOfPositions,
  type StratRow,
  type StratHeld,
} from '@/components/Strats/stratsLogic'
import type { Verdict } from '@/components/Radar/radarLogic'

// Carry Strats board (owner-approved auto-tracking). GET only, WALLET-FREE.
//
// Lists every AUTO-DISCOVERED or manually-watched strat (strat_watches) with its
// entry→now delta and a weakest-prong verdict. To stay shareable-fast it serves
// STORED current positions (last_scanned, written by scripts/refresh-strat-
// positions.mjs in one batched chain-read pass) rather than doing N addresses ×
// 4 venues of live reads per request. The address-independent recorded corpus is
// fetched ONCE and reused across all strats via assembleRadar → computeRadar, so
// verdicts here are byte-identical to the live radar's, with no logic drift.
//
// PROVENANCE (owner, docs/BRAND_CHARTS.md §4): positions are cached chain reads
// (freshness = last_scanned_at); capacity + flow are the recorded corpus; the
// delta is arithmetic between the entry snapshot and the last scan. Nothing modelled.

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }

  const venues = loadVenues()
  const corpus = await readCorpus(venues)

  const rows = (
    await db.execute(sql`
      SELECT address, label, entry_positions, created_at, last_scanned, last_scanned_at
      FROM strat_watches`)
  ).rows as Array<Record<string, unknown>>

  const strats: StratRow[] = rows.map((r) => {
    const address = r.address as string
    const label = (r.label as string | null) ?? null
    const watchedSince = new Date(r.created_at as string).toISOString()
    const entryTotalUsd = totalOfPositions(r.entry_positions as Array<{ usd?: number }> | null)

    const lastScanned = r.last_scanned as { at?: string; total_usd?: number; usdByVenue?: Record<string, number> } | null
    const lastScannedAt = r.last_scanned_at ? new Date(r.last_scanned_at as string).toISOString() : null

    // Build the current radar from STORED positions + the shared corpus, reusing
    // computeRadar (via assembleRadar). Never scanned ⇒ no positions, verdict clear.
    const usdByVenue = new Map<string, number>()
    if (lastScanned?.usdByVenue) {
      for (const [venue, usd] of Object.entries(lastScanned.usdByVenue)) usdByVenue.set(venue, Number(usd) || 0)
    }
    const at = lastScanned?.at ? new Date(lastScanned.at) : new Date()
    const payload = assembleRadar(address, usdByVenue, venues, corpus, at)

    const held: StratHeld[] = payload.positions.map((p) => ({
      venue: p.venue,
      label: p.label,
      usd: p.usd,
      verdict: p.verdict as Verdict,
    }))
    const verdict = worstVerdict(held.map((h) => h.verdict))
    const weakest = held.find((h) => h.verdict === verdict) ?? null

    const currentTotalUsd = payload.total_usd
    const { delta, dir } = deltaOf(entryTotalUsd, currentTotalUsd)

    return {
      address,
      short_address: shortAddress(address),
      label,
      watched_since: watchedSince,
      entry_total_usd: entryTotalUsd,
      current_total_usd: currentTotalUsd,
      delta_usd: delta,
      delta_dir: dir,
      held,
      verdict,
      weakest_venue: weakest ? weakest.label : null,
      last_scanned_at: lastScannedAt,
    }
  })

  const sorted = sortByCurrentDesc(strats)
  const totalUsd = sorted.reduce((s, x) => s + x.current_total_usd, 0)
  const freshestScan = sorted.reduce<string | null>(
    (m, x) => (x.last_scanned_at && (!m || x.last_scanned_at > m) ? x.last_scanned_at : m),
    null,
  )
  const totalFlowRows = corpus.perVenueProvenance.reduce((s, v) => s + v.flow_rows, 0)
  const totalSnapRows = corpus.perVenueProvenance.reduce((s, v) => s + v.snapshot_rows, 0)

  // Public, shareable: cache at the edge for 5 min, serve stale while revalidating.
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
  return res.status(200).json({
    count: sorted.length,
    total_usd: totalUsd,
    freshest_scan: freshestScan,
    strats: sorted,
    provenance: {
      recorded: {
        window: corpus.window,
        note: 'positions are cached chain reads (see freshest_scan); capacity + flow are the recorder corpus, never re-queried live',
        flow_rows: totalFlowRows,
        snapshot_rows: totalSnapRows,
        per_venue: corpus.perVenueProvenance,
      },
      modelled: null,
    },
  })
}
