import type { NextApiRequest, NextApiResponse } from 'next'

import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { LABELS, loadVenues, readCorpus } from '@/pages/api/_lib/radarReads'
import type { FlowStats } from '@/components/Radar/radarLogic'

// PUBLIC. The recorder's latest capacity picture for the simulator's venue
// visualizer (components/Simulator/VenueCapacity.tsx). Owner ruling 2026-09-12:
// "Show our venue visualizer for the carrier's deployments."
//
// WHY THIS ROUTE EXISTS AT ALL, rather than N calls to /api/venues/[venue]/summary:
//
//  1. THE BANDS ARE NOT IN THAT ROUTE, BECAUSE THEY ARE NOT IN THE DB. The ruling
//     asks for "instant / cooling / stranded USD from GET /api/venues/[venue]/summary".
//     venue_snapshots HAS cooling_usd and stranded_usd columns and they are NULL on
//     every row ever written — 0 of 993, measured 2026-09-12 — because
//     scripts/lib/venue-reads.mjs returns `coolingUsd: null, strandedUsd: null` from
//     every branch (:132, :182, :186), deliberately: "STORE-RAW, DO NOT DERIVE". So
//     summary.ts cannot serve three bands, and neither can anything else without
//     saying out loud how the other two were obtained. This route derives them from
//     recorded fields ONLY, and ships the derivation with them (`bands.rule`).
//  2. One request covers every venue the wallet holds, instead of one per venue.
//
// THE VERDICT IS NOT DERIVED HERE. It comes from computeVenueVerdict (radarLogic) on
// the client, fed the SAME four inputs Radar feeds it — tvl, instant_usd, cooldown,
// flow — via readCorpus, the same function /api/radar and /api/strats read. A venue
// must not be 'caution' on the Radar and 'clear' on the simulator.
//
// Everything below is READ FROM THE RECORDER DB. No chain reads. Cached s-maxage 300.

/** The three bands, derived from recorded fields. Nulls where nothing is recorded. */
export type CapacityBands = {
  /** What can leave today: the recorded instant read, or the recorded exit depth. */
  instantUsd: number | null
  /** Recorded book sitting behind a RECORDED cooldown gate. Null without a gate. */
  coolingUsd: number | null
  /** Recorded book with no recorded way out today (lent out, or beyond the depth). */
  strandedUsd: number | null
  /** The venue's whole recorded book, the denominator of the bar. */
  bookUsd: number | null
  /** Where `instantUsd` came from, so the bar is auditable. */
  instantSource: 'instant_usd' | 'depth_usd' | null
  /** The derivation, stated. Rendered as the panel's stamp detail. */
  rule: string
}

export type SimVenueCapacity = {
  venue: string
  label: string
  kind: string
  block: number | null
  observedAt: string | null
  /** Inputs to computeVenueVerdict — identical to what the Radar is given. */
  stress: {
    tvlUsd: number | null
    instantUsd: number | null
    cooldownSeconds: number | null
    flow: FlowStats | null
  }
  bands: CapacityBands
}

export type SimVenueCapacityResponse = {
  venues: SimVenueCapacity[]
  provenance: {
    source: 'venue recorder'
    window: string
    note: string
  }
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Underlying base units are 18-decimal for every recorded venue (summary.ts §3). */
const SCALE = 1e18

const BANDS_RULE =
  'cooling_usd and stranded_usd are NULL on every recorded row, so the split is derived ' +
  'from recorded fields: instant = instant_usd where the recorder reads one (aTokens), ' +
  'else depth_usd (the venue’s recorded exitable secondary depth), capped at the book; ' +
  'cooldown = the rest of the book when a cooldownDuration IS recorded; stranded = the ' +
  'remainder, which has no recorded way out today. Book = totalAssets, or for an aToken ' +
  'the underlying balance plus its recorded variable debt.'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const venues = loadVenues()
  const corpus = await readCorpus(venues)

  // The band inputs the radar corpus does not carry: exit depth, the aToken's own
  // debt, and the block/time of the read that produced them.
  const rows = (
    await db.execute(sql`
      SELECT DISTINCT ON (venue)
        venue,
        block,
        observed_at,
        instant_usd,
        (params ->> 'totalAssets')   AS total_assets_raw,
        (params ->> 'variableDebt')  AS variable_debt_raw,
        (params ->> 'depth_usd')     AS depth_usd
      FROM venue_snapshots
      WHERE source = 'observed'
      ORDER BY venue, observed_at DESC`)
  ).rows as Array<Record<string, unknown>>
  const byVenue = new Map(rows.map((r) => [String(r.venue), r]))

  const out: SimVenueCapacity[] = venues.map((v) => {
    const row = byVenue.get(v.name)
    const c = corpus.byVenue.get(v.name)
    const instantRead = row ? num(row.instant_usd) : null
    const depthUsd = row ? num(row.depth_usd) : null
    const totalAssetsRaw = row ? num(row.total_assets_raw) : null
    const variableDebtRaw = row ? num(row.variable_debt_raw) : null
    const debtUsd = variableDebtRaw != null ? variableDebtRaw / SCALE : null

    // The book: the vault's own totalAssets, or — for an aToken, which records no
    // totalAssets — what is withdrawable plus what is currently lent out.
    const bookUsd =
      totalAssetsRaw != null
        ? totalAssetsRaw / SCALE
        : instantRead != null && debtUsd != null
          ? instantRead + debtUsd
          : instantRead

    const instantSource: CapacityBands['instantSource'] =
      instantRead != null ? 'instant_usd' : depthUsd != null ? 'depth_usd' : null
    const rawInstant = instantRead ?? depthUsd
    const instantUsd =
      rawInstant == null ? null : bookUsd == null ? rawInstant : Math.min(rawInstant, bookUsd)

    const cooldownSeconds = c?.cooldownSeconds ?? null
    const remainder =
      bookUsd != null && instantUsd != null ? Math.max(bookUsd - instantUsd, 0) : null
    // A gate is a WAY OUT, just a slow one; no gate on record means the remainder has
    // no recorded exit today. Only one of the two is ever non-null, never both.
    const gated = cooldownSeconds != null && cooldownSeconds > 0
    const coolingUsd = remainder == null ? null : gated ? remainder : 0
    const strandedUsd = remainder == null ? null : gated ? 0 : remainder

    return {
      venue: v.name,
      label: LABELS[v.name] ?? v.name,
      kind: v.kind,
      block: row ? num(row.block) : null,
      observedAt: row?.observed_at ? new Date(row.observed_at as string).toISOString() : null,
      stress: {
        tvlUsd: c?.tvlUsd ?? null,
        instantUsd: c?.instantUsd ?? null,
        cooldownSeconds,
        flow: c?.flow ?? null,
      },
      bands: { instantUsd, coolingUsd, strandedUsd, bookUsd, instantSource, rule: BANDS_RULE },
    }
  })

  const body: SimVenueCapacityResponse = {
    venues: out,
    provenance: {
      source: 'venue recorder',
      window: corpus.window,
      note:
        'Latest OBSERVED snapshot per venue, read hourly by scripts/record-venue-liquidity.mjs. ' +
        'Stablecoin balances are valued at $1 per unit. Nothing here is a live chain read.',
    },
  }

  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
  return res.status(200).json(body)
}
