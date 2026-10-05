// record-net-apy.ts — one net-APY recorder tick. Local-first: writes only under
// .data/net-apy (lib/netApy/store.ts); no Neon.
//
//   pnpm netapy:record            (tsx; from the membrane-app root)
//
//   1. Read every registered venue at the latest block (one anchor) and store the set.
//   2. Pull live Merkl campaigns and store the trimmed pull.
//   3. Diff against the previous tick and append changes to events.jsonl:
//      campaign_new · campaign_end_changed · campaign_gone_early (lapsed before its end
//      date) · campaign_ended · param_changed (slopes, kink, fees, caps).
//
// A failed Merkl pull skips the campaign diff and keeps the old baseline, so a Merkl
// outage never reads as "every campaign ended". RPC from .env.local aliases; output
// prints only the env:<host> label, never a URL.

import { diffCampaigns, diffParams } from '../lib/netApy/history'
import { extractCampaigns, fetchMerklOpportunities } from '../lib/netApy/incentives'
import { readAllVenues } from '../lib/netApy/read'
import { netApyClient, redactError } from '../lib/netApy/rpc'
import {
  appendEvents,
  loadCampaignState,
  loadLatestSnapshotSet,
  saveCampaignState,
  saveMerklPull,
  saveSnapshotSet,
  storeDir,
} from '../lib/netApy/store'
import { NET_APY_VENUES, venueByKey } from '../lib/netApy/venues'

const vaultOf = (k: string) => {
  const d = venueByKey(k)
  return d && d.protocol === 'euler-v2' ? d.vault : null
}

async function main(): Promise<number> {
  const prevSet = loadLatestSnapshotSet(Number.POSITIVE_INFINITY)
  const { client, label } = netApyClient()
  const set = await readAllVenues(client, NET_APY_VENUES, label)
  const nowTs = Number(set.anchor.blockTimestamp)
  console.log(`[net-apy] block ${set.anchor.blockNumber} via ${label}: ${set.snapshots.length}/${NET_APY_VENUES.length} venues read`)
  for (const e of set.errors) console.log(`  read error ${e.venueKey}: ${e.message}`)
  if (set.snapshots.length === 0) return 1
  saveSnapshotSet(set)

  const events = prevSet ? diffParams(prevSet.snapshots, set.snapshots, nowTs) : []

  try {
    const pull = { fetchedAt: Math.floor(Date.now() / 1000), opportunities: await fetchMerklOpportunities() }
    saveMerklPull(pull)
    const campaigns = extractCampaigns(pull.opportunities, set.snapshots, vaultOf, nowTs)
    const prev = loadCampaignState()
    if (prev) events.push(...diffCampaigns(prev.campaigns, campaigns, nowTs))
    saveCampaignState({ observedAt: nowTs, campaigns })
    console.log(`[net-apy] merkl: ${pull.opportunities.length} opportunities, ${campaigns.length} pay covered venues`)
  } catch (e) {
    console.log(`[net-apy] merkl unavailable, campaign diff skipped: ${redactError(e)}`)
  }

  appendEvents(events)
  for (const e of events) console.log(`  event ${JSON.stringify(e)}`)
  console.log(`[net-apy] ${events.length} change(s) → ${storeDir()}`)
  return 0
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`[net-apy] failed: ${redactError(e)}`)
    process.exit(1)
  },
)
