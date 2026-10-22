/**
 * Which (metric, subject) pairs a user may set a threshold on — derived from live
 * config, never hand-listed, so a venue the recorder stops reading drops out here too.
 *
 *   price        asset:ETH, asset:BTC — the verified Chainlink feeds (values.ts)
 *   utilization  venue:<name> for ENABLED recorder venues with a variableDebtToken:
 *                only those snapshots carry params.utilization_pct
 *                (scripts/lib/venue-reads.mjs), the value the venue page shows
 *   apr          venue:<name> for ENABLED recorder venues that the net-APY registry
 *                also reads (lib/netApy/venues.ts) — the supply APR the venue
 *                page's "Net at your size" card is built on
 *
 * Server-side (imports the recorder config). The UI never needs the list: it shows a
 * control only where the page already has the live value.
 */

import venueConfig from '@/tools/venue-recorder.config.json'
import { venueByKey } from '@/lib/netApy/venues'

import { PRICE_SUBJECTS, venueSubject, type Metric } from './metrics'

export type RecorderVenue = { name: string; enabled: boolean; variableDebtToken?: string }

export type AllowList = Record<Metric, ReadonlySet<string>>

export const allowListFrom = (venues: readonly RecorderVenue[]): AllowList => {
  const enabled = venues.filter((v) => v.enabled)
  return {
    price: new Set(PRICE_SUBJECTS),
    utilization: new Set(enabled.filter((v) => !!v.variableDebtToken).map((v) => venueSubject(v.name))),
    apr: new Set(enabled.filter((v) => venueByKey(v.name) !== null).map((v) => venueSubject(v.name))),
  }
}

let cached: AllowList | null = null

/** The allow-list for this deploy's recorder config. */
export const liveAllowList = (): AllowList =>
  (cached ??= allowListFrom((venueConfig as { venues: RecorderVenue[] }).venues))
