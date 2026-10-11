/**
 * THE ON-APP SET — venues the app already shows, so the scout never reports them as new.
 *
 * Built at scan time from the checked-out code, never hand-copied:
 *   R1  tools/venue-recorder.config.json — every entry, enabled or not (the one venue
 *       registry: docs/NET_APY_AT_SIZE.md, "venue-key").
 *   R2  NET_APY_VENUES (lib/netApy/venues.ts). Aave/Spark entries resolve to their aToken
 *       through Pool.getReserveData at scan time (the caller passes `aTokenOf`); a Morpho
 *       market is `1:<morpho>:<marketId>`; an Euler entry is its vault.
 *   R3  KNOWN_VENUES (lib/position-sim/venues.ts), which adds sDAI and sfrxUSD.
 *   R4  the /carry ROUTES labels (components/Carry/fixtures.ts), resolved through
 *       ./onAppAliases.json; a label that is not one venue is an explicit waiver.
 *
 * Keys are `1:<lowercase address>` and are compared lowercase.
 */

import ROUTES_ALIASES from './onAppAliases.json'
import RECORDER from '../../tools/venue-recorder.config.json'
import { ROUTES } from '../../components/Carry/fixtures'
import type { Route } from '../../components/Carry/types'
import { KNOWN_VENUES } from '../position-sim/venues'
import { MORPHO_BLUE, NET_APY_VENUES, type VenueDef } from '../netApy/venues'

export const keyOf = (address: string): string => `1:${address.toLowerCase()}`
export const morphoMarketKey = (marketId: string): string =>
  `1:${MORPHO_BLUE.toLowerCase()}:${marketId.toLowerCase()}`

export type OnAppSource = 'R1' | 'R2' | 'R3' | 'R4'

export interface OnAppSet {
  keys: Set<string>
  /** key → which lists named it (for the "NOW ON APP" note and the tests). */
  bySource: Map<string, Set<OnAppSource>>
  waivers: { label: string; reason: string }[]
  /** R2 Aave/Spark venues whose aToken could not be resolved this run. */
  unresolved: string[]
}

export interface OnAppInputs {
  recorder: { venues: { name: string; address?: string }[] }
  netApyVenues: readonly VenueDef[]
  knownVenues: readonly { address: string }[]
  routes: readonly Pick<Route, 'src' | 'dst'>[]
  aliases: { routes: Record<string, { addresses?: string[]; waiver?: string }> }
}

export const routeLabel = (r: Pick<Route, 'src' | 'dst'>): string => `${r.src} → ${r.dst}`

export const DEFAULT_ON_APP_INPUTS: OnAppInputs = {
  recorder: RECORDER as OnAppInputs['recorder'],
  netApyVenues: NET_APY_VENUES,
  knownVenues: KNOWN_VENUES,
  routes: ROUTES,
  aliases: ROUTES_ALIASES as OnAppInputs['aliases'],
}

/**
 * Pure: builds the set from the four lists. `aTokens` maps an R2 Aave/Spark venueKey to
 * the aToken read on-chain this run; a missing one is reported in `unresolved`.
 */
export function buildOnAppSet(inputs: OnAppInputs, aTokens: ReadonlyMap<string, string>): OnAppSet {
  const keys = new Set<string>()
  const bySource = new Map<string, Set<OnAppSource>>()
  const add = (k: string, src: OnAppSource) => {
    keys.add(k)
    if (!bySource.has(k)) bySource.set(k, new Set())
    bySource.get(k)!.add(src)
  }

  for (const v of inputs.recorder.venues) {
    if (v.address && /^0x[0-9a-fA-F]{40}$/.test(v.address)) add(keyOf(v.address), 'R1')
  }

  const unresolved: string[] = []
  for (const d of inputs.netApyVenues) {
    if (d.protocol === 'aave-v3' || d.protocol === 'spark') {
      const a = aTokens.get(d.venueKey)
      if (a) add(keyOf(a), 'R2')
      else unresolved.push(d.venueKey)
    } else if (d.protocol === 'morpho-blue') {
      add(morphoMarketKey(d.marketId), 'R2')
    } else if (d.protocol === 'euler-v2') {
      add(keyOf(d.vault), 'R2')
    }
  }

  for (const k of inputs.knownVenues) add(keyOf(k.address), 'R3')

  const waivers: OnAppSet['waivers'] = []
  for (const r of inputs.routes) {
    const label = routeLabel(r)
    const entry = inputs.aliases.routes[label]
    if (!entry)
      throw new Error(
        `onAppAliases.json has no entry for the /carry route "${label}" — add its address(es) or a waiver`,
      )
    if (entry.addresses?.length) for (const a of entry.addresses) add(keyOf(a), 'R4')
    else if (entry.waiver) waivers.push({ label, reason: entry.waiver })
    else throw new Error(`onAppAliases.json entry "${label}" has neither addresses nor a waiver`)
  }

  return { keys, bySource, waivers, unresolved }
}

/** The R2 Aave/Spark venues whose aToken must be read on-chain before building the set. */
export const aaveLikeVenues = (defs: readonly VenueDef[] = NET_APY_VENUES) =>
  defs.filter(
    (d): d is Extract<VenueDef, { protocol: 'aave-v3' | 'spark' }> =>
      d.protocol === 'aave-v3' || d.protocol === 'spark',
  )
