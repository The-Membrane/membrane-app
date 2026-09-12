// THE SECONDARY PROOF'S ONE FETCH.
//
// Both the hero (in 'history' variant) and HistoryProof need the same scan, and they
// must never disagree about it. react-query dedupes on `queryKey`, so both call this
// hook with the same address and exactly one request goes out.
//
// `refetchOnMount: true` overrides the app-wide default (which is false): an empty or
// errored first fetch must not stick for the whole session on a page whose entire
// second proof is this number.

import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import type { HistoryResponse } from '@/lib/position-sim/history'

export type SimHistory = HistoryResponse

export function useSimHistory(address: string | null | undefined): UseQueryResult<SimHistory> {
  return useQuery<SimHistory>({
    queryKey: ['sim_history', (address ?? '').toLowerCase()],
    enabled: !!address,
    queryFn: async () => {
      const r = await fetch(`/api/sim/history/${address}`)
      if (!r.ok) throw new Error(`sim history ${r.status}`)
      return r.json()
    },
    // The server caches for 24h; the client holds it for the session's first 10 minutes.
    staleTime: 1000 * 60 * 10,
    refetchOnMount: true,
    retry: 1,
  })
}

/** The saved figure, or 0 when the scan has not landed / found nothing. Never null —
 *  the hero's fallback rule keys off `> 0`, and an undefined would read as truthy in
 *  a careless comparison. */
export const savedUsdOf = (h: SimHistory | undefined): number =>
  h && !h.error ? h.totals.savedUsd : 0

export const savedCountOf = (h: SimHistory | undefined): number =>
  h && !h.error ? h.totals.savedCount : 0
