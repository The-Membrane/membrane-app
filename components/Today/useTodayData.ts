import { useQueries, useQuery } from '@tanstack/react-query'

import type { AlarmLike } from '@/components/Radar/alertLogic'
import type { VenueSummary } from '@/pages/api/venues/[venue]/summary'

import { RECORDER_VENUES, type Load, type NetApyList, type StratsDemand } from './opportunitiesView'

// The Today bodies' reads. Client-side, like every other data surface in the app; each
// body reserves its rows while these load. The view models (opportunitiesView.ts,
// safetyView.ts) take the `Load` shape these return, so the states are tested in node.

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url} ${r.status}`)
  return r.json() as Promise<T>
}

const load = <T>(q: { status: Load<T>['status']; data: T | undefined }): Load<T> => ({
  status: q.status,
  data: q.data,
})

/** Venue supply rates at the reader's size. The route reuses one chain read for 120 s,
 *  so a size change is cheap; the body shows its reserved dashes meanwhile. */
export function useNetApyList(sizeUsd: number): Load<NetApyList> {
  const q = useQuery({
    queryKey: ['today_net_apy', sizeUsd],
    queryFn: () => getJson<NetApyList>(`/api/net-apy?size=${sizeUsd}&side=supply`),
    staleTime: 60_000,
    refetchInterval: 120_000,
    refetchOnMount: true,
    retry: 1,
  })
  return load(q)
}

/** The recorder's last reading of each venue. Same key and payload as the venue page. */
export function useRecorderSummaries(): { venue: string; load: Load<VenueSummary> }[] {
  const qs = useQueries({
    queries: RECORDER_VENUES.map((venue) => ({
      queryKey: ['venue_summary', venue],
      queryFn: () => getJson<VenueSummary>(`/api/venues/${encodeURIComponent(venue)}/summary`),
      staleTime: 5 * 60_000,
      refetchInterval: 5 * 60_000,
      refetchOnMount: true,
      retry: 1,
    })),
  })
  return RECORDER_VENUES.map((venue, i) => ({ venue, load: load(qs[i]) }))
}

export function useVenueAlarms(): Load<{ open: AlarmLike[] }> {
  const q = useQuery({
    queryKey: ['today_venue_alarms'],
    queryFn: () => getJson<{ open: AlarmLike[] }>('/api/venues/alarms'),
    staleTime: 2 * 60_000,
    refetchInterval: 2 * 60_000,
    refetchOnMount: true,
    retry: 1,
  })
  return load(q)
}

export function useStratsDemand(): Load<StratsDemand> {
  const q = useQuery({
    queryKey: ['today_strats'],
    queryFn: () => getJson<StratsDemand>('/api/strats'),
    // Keep only what the line prints: the board's full rows are not needed here.
    select: (d: StratsDemand): StratsDemand => ({
      count: d.count,
      total_usd: d.total_usd,
      freshest_scan: d.freshest_scan,
    }),
    staleTime: 5 * 60_000,
    refetchOnMount: true,
    retry: 1,
  })
  return load(q)
}
