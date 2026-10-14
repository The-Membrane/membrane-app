import { useQuery } from '@tanstack/react-query'

import { useNetApy } from '@/components/NetApy/NetApyCard'
import { venueByKey } from '@/lib/netApy/venues'

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

export type LiveValue = { value: number; asOf: string | null }

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
  const u = obs?.params.utilizationPct
  const utilization: LiveValue | null = u !== null && u !== undefined && Number.isFinite(u) ? { value: u, asOf: obs?.observedAt ?? null } : null

  const b = net.data?.breakdown
  const apr: LiveValue | null =
    b && Number.isFinite(b.now.supplyApr)
      ? { value: b.now.supplyApr * 100, asOf: new Date(Number(b.anchor.blockTimestamp) * 1000).toISOString() }
      : null

  // The summary decides which controls exist; wait for it so a card never swaps one control for another.
  return { utilization, apr, aprCovered, settled: summary.isFetched }
}
