/**
 * ONE RECORDER TICK for net-APY-at-size, with its I/O injected so it can be tested.
 * scripts/record-net-apy.ts is the CLI around it: the RPC client, the Merkl fetch and
 * the exit code. Local-first: writes only under the store (store.ts); no Neon.
 *
 *   1. Read every registered venue at the finalized block (one anchor) and store the set.
 *   2. Diff IRM and fee params against the tick's OWN baseline (store.ts ParamBaseline),
 *      never against the newest stored set: API reads store sets between ticks too.
 *   3. Pull live Merkl campaigns, store the trimmed pull, and diff against the campaigns
 *      the last SUCCESSFUL pull matched: campaign_new · campaign_end_changed ·
 *      campaign_gone_early (lapsed before its end date) · campaign_ended.
 *   4. Append every change to events.jsonl.
 *
 * A failed Merkl pull skips the campaign diff and keeps the old baseline, so a Merkl
 * outage never reads as "every campaign ended".
 */

import { diffCampaigns, diffParams, type NetApyEvent } from './history'
import { extractCampaigns, type MerklOpportunity } from './incentives'
import type { SnapshotSet } from './read'
import { redactError } from './rpc'
import {
  appendEvents,
  loadCampaignState,
  loadLatestSnapshotSet,
  loadParamBaseline,
  saveCampaignState,
  saveMerklPull,
  saveParamBaseline,
  saveSnapshotSet,
  storeDir,
} from './store'
import { asOfOf, type VenueSnapshot } from './types'
import { NET_APY_VENUES, venueByKey } from './venues'

export interface NetApyTickDeps {
  /** Every registered venue at the finalized anchor (read.ts readAllVenues). */
  readSet: () => Promise<SnapshotSet>
  /** Live Merkl opportunities (incentives.ts fetchMerklOpportunities). */
  fetchMerkl: () => Promise<MerklOpportunity[]>
  /** Wall clock, unix seconds: stamps the Merkl pull and judges campaign liveness. */
  now?: () => number
  log?: (line: string) => void
}

export interface NetApyTickResult {
  /** The CLI exit code: 1 when no venue could be read. */
  code: number
  events: NetApyEvent[]
}

const vaultOf = (k: string) => {
  const d = venueByKey(k)
  return d && d.protocol === 'euler-v2' ? d.vault : null
}

const wallClockS = () => Math.floor(Date.now() / 1000)

/**
 * The previous baseline with this tick's reads laid over it, per venue. A venue that
 * failed to read keeps its last-known snapshot, so its next change is still logged. A
 * read older than the one held never replaces it: a lagging RPC must not make the next
 * tick log a change again.
 */
export function mergeBaseline(
  prev: readonly VenueSnapshot[],
  next: readonly VenueSnapshot[],
): VenueSnapshot[] {
  const out = new Map(prev.map((s) => [s.venueKey, s]))
  for (const s of next) {
    const held = out.get(s.venueKey)
    if (!held || held.anchor.blockNumber <= s.anchor.blockNumber) out.set(s.venueKey, s)
  }
  return [...out.values()]
}

/** Baseline snapshots strictly older than this tick's read of the same venue: a
 *  baseline at or past the new anchor is never diffed backwards. */
function olderThan(prev: readonly VenueSnapshot[], next: readonly VenueSnapshot[]) {
  const block = new Map(next.map((s) => [s.venueKey, s.anchor.blockNumber]))
  return prev.filter((p) => {
    const b = block.get(p.venueKey)
    return b !== undefined && p.anchor.blockNumber < b
  })
}

export async function runNetApyTick(deps: NetApyTickDeps): Promise<NetApyTickResult> {
  const { readSet, fetchMerkl, now = wallClockS, log = console.log } = deps
  // One-time migration: before the baseline file existed, the newest stored set was the
  // baseline. Loaded before this tick's set is stored, so it is never this tick's own.
  const baseline =
    loadParamBaseline()?.snapshots ??
    loadLatestSnapshotSet(Number.POSITIVE_INFINITY)?.snapshots ??
    []
  const set = await readSet()
  // Param events carry the read's wall clock (asOf), not its finalized anchor time.
  const nowTs = asOfOf(set)
  const read = `${set.snapshots.length}/${NET_APY_VENUES.length}`
  log(`[net-apy] block ${set.anchor.blockNumber} via ${set.rpc}: ${read} venues read`)
  for (const e of set.errors) log(`  read error ${e.venueKey}: ${e.message}`)
  if (set.snapshots.length === 0) return { code: 1, events: [] }
  saveSnapshotSet(set)

  const events = diffParams(olderThan(baseline, set.snapshots), set.snapshots, nowTs)

  try {
    // Campaign liveness is the pull's wall clock. The finalized anchor is ~13–19 min
    // old: judging by it would log an on-time end as campaign_gone_early.
    const pull = { fetchedAt: now(), opportunities: await fetchMerkl() }
    saveMerklPull(pull)
    const campaigns = extractCampaigns(pull.opportunities, set.snapshots, vaultOf, pull.fetchedAt)
    const prev = loadCampaignState()
    if (prev) events.push(...diffCampaigns(prev.campaigns, campaigns, pull.fetchedAt))
    saveCampaignState({ observedAt: pull.fetchedAt, campaigns })
    const pays = `${campaigns.length} pay covered venues`
    log(`[net-apy] merkl: ${pull.opportunities.length} opportunities, ${pays}`)
  } catch (e) {
    log(`[net-apy] merkl unavailable, campaign diff skipped: ${redactError(e)}`)
  }

  appendEvents(events)
  // After the append: a crash in between re-logs a change rather than losing it.
  saveParamBaseline({ observedAt: nowTs, snapshots: mergeBaseline(baseline, set.snapshots) })
  for (const e of events) log(`  event ${JSON.stringify(e)}`)
  log(`[net-apy] ${events.length} change(s) → ${storeDir()}`)
  return { code: 0, events }
}
