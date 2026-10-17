// What is reported about the market a lender supplies, from the source that covers its
// venue (lib/position/lender.ts reportRequest): the Morpho API for a Morpho market or vault,
// DefiLlama's yields chart for an Aave V3 / Spark reserve or a Compound V3 Comet. Reported,
// not read on-chain; the lending block marks it so. A failure is named, never read as "no
// rewards" or "no history".

import { useQuery } from '@tanstack/react-query'

import {
  LLAMA_CHART_URL,
  MORPHO_REPORT_URL,
  parseLlamaChart,
  parseReport,
  parseVaultReport,
  reportQuery,
  vaultReportQuery,
  type LenderReport,
  type ReportRequest,
} from '@/lib/position/lender'

const TIMEOUT_MS = 12_000

async function post(body: unknown, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(MORPHO_REPORT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) throw new Error(`Morpho API HTTP ${res.status}`)
  return res.json()
}

export function useLenderReport(req: ReportRequest) {
  const key = req.kind === 'morpho-market' ? req.id : req.kind === 'morpho-vault' ? req.address : req.kind === 'llama' ? req.pool : null
  return useQuery<LenderReport>({
    queryKey: ['position-lender-report', req.kind, key],
    enabled: req.kind !== 'none',
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async ({ signal }) => {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
      signal?.addEventListener('abort', () => ctl.abort())
      try {
        const now = Date.now()
        if (req.kind === 'morpho-market') return parseReport(await post(reportQuery(req.id, now / 1000), ctl.signal), now)
        if (req.kind === 'morpho-vault') return parseVaultReport(await post(vaultReportQuery(req.address, now / 1000), ctl.signal), now)
        if (req.kind === 'llama') {
          const res = await fetch(`${LLAMA_CHART_URL}${req.pool}`, { signal: ctl.signal })
          if (!res.ok) throw new Error(`DefiLlama HTTP ${res.status}`)
          return parseLlamaChart(await res.json(), now)
        }
        throw new Error(req.reason)
      } finally {
        clearTimeout(timer)
      }
    },
  })
}
