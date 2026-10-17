// What the Morpho API reports about the market a lender supplies: rewards, warnings, bad
// debt, and 30 days of liquidity. Reported, not read on-chain; the lending block marks it
// so. A failure is named, never read as "no rewards" or "no history".

import { useQuery } from '@tanstack/react-query'

import { MORPHO_REPORT_URL, parseReport, reportQuery, type LenderReport } from '@/lib/position/lender'

const TIMEOUT_MS = 12_000

export function useLenderReport(marketId: string | null) {
  return useQuery<LenderReport>({
    queryKey: ['position-lender-report', marketId],
    enabled: !!marketId,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async ({ signal }) => {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
      signal?.addEventListener('abort', () => ctl.abort())
      try {
        const now = Date.now()
        const res = await fetch(MORPHO_REPORT_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(reportQuery(marketId as string, now / 1000)),
          signal: ctl.signal,
        })
        if (!res.ok) throw new Error(`Morpho API HTTP ${res.status}`)
        return parseReport(await res.json(), now)
      } finally {
        clearTimeout(timer)
      }
    },
  })
}
