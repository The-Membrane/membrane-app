import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { useNetApy } from '@/components/NetApy/NetApyCard'
import { venueByKey } from '@/lib/netApy/venues'
import { APR_ANCHOR_MAX_AGE_S, classify, UTILIZATION_MAX_AGE_S } from '@/lib/userAlerts/freshness'

/**
 * The live venue values an "Alert me at" control prefills from — the SAME queries
 * the venue page runs (same keys, same endpoints), so on that page they cost no
 * extra request, and on Radar they read what the venue page would show:
 *  - utilization: /api/venues/[venue]/summary → observed.params.utilizationPct
 *    (the recorder's latest observed snapshot; only lending venues carry it)
 *  - APR: /api/net-apy?venue=… (the "Net at your size" card's default read) →
 *    breakdown.now.supplyApr, in percent
 * Each is null when the page has no live value, and the caller then shows no control
 * for it (utilization) or one without a prefill (APR).
 */

type SummaryLike = {
  observed: { observedAt: string; params: { utilizationPct: number | null } } | null
}

/**
 * `stale` uses the SAME max ages as the server evaluator (lib/userAlerts/freshness.ts),
 * so the control never promises a check the evaluator would skip. APR is judged on
 * its finalized-anchor age only: the read-age check is the server's (it re-reads
 * every 120 s), while this copy has passed through the CDN's stale-while-revalidate.
 */
export type LiveValue = { value: number; asOf: string | null; stale: boolean }

/** A live value classified against the clock when its data arrives; null when there is none. */
const live = (value: number | null | undefined, asOfMs: number | null, maxAgeS: number): LiveValue | null => {
  if (value === null || value === undefined || !Number.isFinite(value) || asOfMs === null || !Number.isFinite(asOfMs)) return null
  const r = classify({ status: 'raw', value, asOfMs, source: 'page', maxAgeS }, Date.now())
  return { value, asOf: new Date(asOfMs).toISOString(), stale: r.status !== 'ok' }
}

/** The net-APY card's default size (NetApyCard defaultSizeUsd): shares its cache entry. */
const NET_APY_CARD_SIZE = 100_000

export const useVenueAlertValues = (venue: string, enabled: boolean) => {
  const summary = useQuery<SummaryLike>({
    queryKey: ['venue_summary', venue],
    enabled,
    queryFn: async () => {
      const r = await fetch(`/api/venues/${venue}/summary`)
      if (!r.ok) throw new Error(`venue summary ${r.status}`)
      return r.json()
    },
    staleTime: 1000 * 60 * 5,
    refetchOnMount: true,
  })
  const aprCovered = venueByKey(venue) !== null
  const net = useNetApy(venue, NET_APY_CARD_SIZE, 'supply', enabled && aprCovered)

  const obs = summary.data?.observed ?? null
  const b = net.data?.breakdown
  const utilization = useMemo(() => live(obs?.params.utilizationPct, obs ? Date.parse(obs.observedAt) : null, UTILIZATION_MAX_AGE_S), [obs])
  const apr = useMemo(
    () => live(b ? b.now.supplyApr * 100 : null, b ? Number(b.anchor.blockTimestamp) * 1000 : null, APR_ANCHOR_MAX_AGE_S),
    [b],
  )

  // The summary decides which controls exist; wait for it so a card never swaps one control for another.
  return { utilization, apr, aprCovered, settled: summary.isFetched }
}
