// record-net-apy.ts — one net-APY recorder tick. Local-first: writes only under
// .data/net-apy (lib/netApy/store.ts); no Neon.
//
//   pnpm netapy:record            (tsx; from the membrane-app root)
//
//   1. Read every registered venue at the finalized block (one anchor) and store the set.
//   2. Pull live Merkl campaigns and store the trimmed pull.
//   3. Diff against the tick's own baselines and append changes to events.jsonl:
//      campaign_new · campaign_end_changed · campaign_gone_early (lapsed before its end
//      date) · campaign_ended · param_changed (slopes, kink, fees, caps).
//
// The tick itself is lib/netApy/tick.ts (runNetApyTick); this file wires the RPC client
// and the Merkl fetch into it. A failed Merkl pull skips the campaign diff and keeps the
// old baseline, so a Merkl outage never reads as "every campaign ended". RPC from
// .env.local aliases; output prints only the env:<host> label, never a URL.

import { fetchMerklOpportunities } from '../lib/netApy/incentives'
import { readAllVenues } from '../lib/netApy/read'
import { netApyClient, redactError } from '../lib/netApy/rpc'
import { runNetApyTick } from '../lib/netApy/tick'
import { NET_APY_VENUES } from '../lib/netApy/venues'

runNetApyTick({
  readSet: () => {
    const { client, label } = netApyClient()
    return readAllVenues(client, NET_APY_VENUES, label)
  },
  fetchMerkl: () => fetchMerklOpportunities(),
}).then(
  ({ code }) => process.exit(code),
  (e) => {
    console.error(`[net-apy] failed: ${redactError(e)}`)
    process.exit(1)
  },
)
