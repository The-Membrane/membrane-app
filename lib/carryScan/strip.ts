/**
 * The slice of the scan the /carry strip needs: the top NEW ranked rows, nothing else, so
 * /carry never downloads the whole file.
 */

import type { CarryScanView } from './load'
import type { Carry, CarryB, ScoutStatus } from './types'

export interface StripRow {
  key: string | null
  label: string
  protocol: string
  stable: string
  rank: number | null
  status: ScoutStatus | null
  carryA: Carry | null
  carryB: CarryB
  notDeployable: boolean
}

export interface StripPayload {
  week: string
  asOf: number
  source: CarryScanView['source']
  banner: string | null
  ranked: number
  rows: StripRow[]
}

export function stripOf(view: CarryScanView, n = 3): StripPayload {
  const ranked = view.file.rows.filter((r) => r.list === 'ranked')
  const fresh = ranked
    .filter((r) => r.status === 'NEW')
    .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))
  return {
    week: view.file.week,
    asOf: view.file.asOf,
    source: view.source,
    banner: view.banner,
    ranked: ranked.length,
    rows: fresh.slice(0, n).map((r) => ({
      key: r.key,
      label: r.label,
      protocol: r.protocol,
      stable: r.stable,
      rank: r.rank,
      status: r.status,
      carryA: r.carryA['100k'],
      carryB: r.carryB['100k'],
      notDeployable: r.readiness.tier === 'not-deployable',
    })),
  }
}
