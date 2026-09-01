// Client hook for GET /api/game/points — the Phase 5 off-chain game points ledger
// (docs/OFFCHAIN_QRACING_PLAN.md, Phase 5). See lib/game/points.ts for the ledger's
// write side.
//
// IMPORTANT — this is a SEPARATE points system from the on-chain PointsSystem.sol /
// MBRN-claimable points (services/chain/points.ts, rendered — and used to build the
// real redeem() call — in components/Nav/PointsLevel.tsx and
// components/Nav/hooks/usePointsClaim.ts). That figure backs an actual MBRN claim and
// must stay wallet/on-chain-accurate; this hook does NOT feed it and should not be
// wired into that widget. `persisted-state/useAppState.ts`'s `totalPoints` array is a
// per-wallet localStorage cache of THAT on-chain figure, not of this ledger.
//
// Precedence implemented below (as required by the Phase 5 spec, "prefer server points
// when the query succeeds, localStorage stays as fallback for wallet-less legacy"):
//   1. GET /api/game/points succeeds (player cookie present, DB reachable) -> use the
//      server total (`source: 'server'`). This is the real, cross-device number.
//   2. Query hasn't resolved yet (loading) or failed (no cookie minted yet, DB down,
//      etc.) -> fall back to the connected wallet's cached on-chain figure in
//      `useAppState().totalPoints` (`source: 'legacy'`), purely so a "Points" affordance
//      never renders a hard blank/zero mid-load. This is a DIFFERENT metric (on-chain
//      protocol points, not game points) — callers that must not conflate the two should
//      branch on `source` rather than trust the raw number across a fallback boundary.
//   3. Neither is available -> 0 (`source: 'none'`).

import { useQuery } from '@tanstack/react-query'

import useAppState from '@/persisted-state/useAppState'
import useWallet from '@/hooks/useWallet'

export const SERVER_POINTS_KEY = ['offchain-game', 'points'] as const

export type ServerPointsEntry = {
  id: string
  delta: string
  reason: string
  meta: unknown
  createdAt: string
}

export type ServerPointsResponse = {
  totalPoints: string
  recent: ServerPointsEntry[]
}

async function fetchServerPoints(): Promise<ServerPointsResponse> {
  const res = await fetch('/api/game/points', { credentials: 'same-origin' })
  if (!res.ok) {
    const err = new Error(`points_fetch_failed_${res.status}`) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  return res.json()
}

export type PointsSource = 'server' | 'legacy' | 'none'

export type UseServerPointsResult = {
  totalPoints: number
  source: PointsSource
  recent: ServerPointsEntry[]
  isLoading: boolean
}

export function useServerPoints(): UseServerPointsResult {
  const { address } = useWallet()
  const { appState } = useAppState()

  const query = useQuery<ServerPointsResponse>({
    queryKey: SERVER_POINTS_KEY,
    queryFn: fetchServerPoints,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    retry: 1,
  })

  if (query.isSuccess && query.data) {
    return {
      totalPoints: Number(query.data.totalPoints) || 0,
      source: 'server',
      recent: query.data.recent,
      isLoading: false,
    }
  }

  const legacy = appState.totalPoints?.find((p) => p.user === address)
  if (legacy?.points) {
    return {
      totalPoints: parseFloat(legacy.points) || 0,
      source: 'legacy',
      recent: [],
      isLoading: query.isLoading,
    }
  }

  return { totalPoints: 0, source: 'none', recent: [], isLoading: query.isLoading }
}

export default useServerPoints
