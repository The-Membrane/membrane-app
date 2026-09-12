import type { NextApiRequest, NextApiResponse } from 'next'
import { getAddress, isAddress } from 'viem'
import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { scanHistory } from '@/lib/position-sim/historyScan'
import {
  HISTORY_SCHEMA_VERSION,
  ZERO_TOTALS,
  type HistoryResponse,
} from '@/lib/position-sim/history'

/**
 * THE SECONDARY PROOF, SERVED. `GET /api/sim/history/0x…`
 *
 * "The amount of liquidations this position would've been saved from, from position
 * creation to now, due to the delay infra" (owner brief 2026-09-12), computed against
 * the address's REAL Aave V3 liquidation history and served from a Neon cache.
 *
 * WHY THIS IS A SERVER ROUTE AND NOT A HOOK. The scan walks ~7.5M blocks of logs plus a
 * Chainlink round window per event. Doing that per render — or per visitor — would melt
 * the keyless RPC ring and make the page's number depend on which endpoint answered.
 * So: one scan per address per day, stored in `sim_history`, everything after that is a
 * table read. The brief's constraint, verbatim: "cache on-chain data, no per-render
 * live requeries".
 *
 * THE HONESTY RULES, ENFORCED HERE:
 *   - A wallet with no history gets totals of ZERO and `since.firstEventTs: null`. It
 *     never gets a manufactured near-miss, and the UI prints a sentence, not a number.
 *   - A scan that FAILED is not a wallet with no history. It comes back with `error`
 *     set and is NOT written to the cache, so the next request retries instead of
 *     serving a zero that was really an outage.
 *   - `provenance` is 'observed': every event in the list actually happened.
 *   - A cache row written by an OLDER scan shape is not served. The summary carries
 *     `version`; anything other than HISTORY_SCHEMA_VERSION is a miss, so the
 *     single-event rows written before the 2026-09-12 episode ruling are rescanned
 *     rather than rendered against an episode UI that would show them as empty.
 */

/** A cached scan is good for a day. Older than that and we rescan. */
const CACHE_TTL_HOURS = 24

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }

  const raw = req.query.address
  const addrStr = Array.isArray(raw) ? raw[0] : raw
  if (!addrStr || !isAddress(addrStr)) {
    return res.status(400).json({ error: 'invalid address' })
  }
  const address = getAddress(addrStr)
  const force = req.query.force === '1'

  // ------------------------------------------------------------------ cache
  if (!force) {
    const cached = await readCache(address)
    if (cached) {
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600')
      return res.status(200).json(cached)
    }
  }

  // ------------------------------------------------------------------- scan
  let scanned: HistoryResponse
  try {
    scanned = await scanHistory(address)
  } catch (e) {
    return res.status(200).json(emptyWithError(address, e instanceof Error ? e.message : String(e)))
  }

  // A failed scan is never cached — a zero caused by an outage must not stick for a day.
  if (!scanned.error) await writeCache(scanned)

  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600')
  return res.status(200).json(scanned)
}

// --------------------------------------------------------------------- neon

async function readCache(address: string): Promise<HistoryResponse | null> {
  try {
    const rows = (
      await db.execute(sql`
        SELECT address, scanned_at, to_block, events, summary
        FROM sim_history
        WHERE address = ${address}
          AND scanned_at > now() - (${CACHE_TTL_HOURS} || ' hours')::interval
        LIMIT 1`)
    ).rows as Array<Record<string, unknown>>
    const row = rows[0]
    if (!row) return null
    const summary = (row.summary ?? {}) as Partial<HistoryResponse>
    // A row from an older scan shape is a MISS, not a hit. Serving it would render
    // yesterday's single-event rows into today's episode UI as a blank list.
    if (summary.version !== HISTORY_SCHEMA_VERSION) return null
    return {
      address: String(row.address),
      since: summary.since ?? { firstEventTs: null },
      episodes: summary.episodes ?? [],
      events: (row.events ?? []) as HistoryResponse['events'],
      totals: summary.totals ?? { ...ZERO_TOTALS },
      method: summary.method ?? '',
      provenance: 'observed',
      scannedAt: new Date(row.scanned_at as string).toISOString(),
      scannedToBlock: row.to_block == null ? undefined : String(row.to_block),
      notScanned: summary.notScanned,
      version: summary.version,
    }
  } catch {
    // No database, or a schema that has not had the DDL applied yet. A cache miss is
    // the correct degradation — the scan below still answers.
    return null
  }
}

async function writeCache(r: HistoryResponse): Promise<void> {
  try {
    const events = JSON.stringify(r.events)
    // The `events` column keeps the flat decoded events; the summary keeps everything
    // the UI renders, including the EPISODES the events were clustered into.
    const summary = JSON.stringify({
      since: r.since,
      episodes: r.episodes,
      totals: r.totals,
      method: r.method,
      notScanned: r.notScanned ?? [],
      version: r.version ?? HISTORY_SCHEMA_VERSION,
    })
    const toBlock = r.scannedToBlock ? Number(r.scannedToBlock) : null
    await db.execute(sql`
      INSERT INTO sim_history (address, scanned_at, to_block, events, summary)
      VALUES (${r.address}, now(), ${toBlock}, ${events}::jsonb, ${summary}::jsonb)
      ON CONFLICT (address) DO UPDATE
        SET scanned_at = now(),
            to_block = EXCLUDED.to_block,
            events = EXCLUDED.events,
            summary = EXCLUDED.summary`)
  } catch {
    // The proof does not depend on the cache. A write failure costs a rescan, nothing
    // else, and must never turn a good scan into an error on screen.
  }
}

function emptyWithError(address: string, message: string): HistoryResponse {
  return {
    address,
    since: { firstEventTs: null },
    episodes: [],
    events: [],
    totals: { ...ZERO_TOTALS },
    method: 'The liquidation-history scan did not run.',
    provenance: 'observed',
    scannedAt: new Date().toISOString(),
    version: HISTORY_SCHEMA_VERSION,
    error: message,
  }
}
