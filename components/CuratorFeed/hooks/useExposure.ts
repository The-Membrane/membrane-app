// The viewer's exposure: an address (typed, or the connected wallet's) read on Ethereum
// mainnet over the vaults and markets §07 lists. Read-only: the keyless public clients
// from lib/position-sim/rpc, never a wallet client; nothing is signed. Errors come back by
// name (lib/exposure/resolve.ts); a failed query is not retried behind the reader's back.

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAccount } from 'wagmi'

import {
  resolveExposure,
  viemReader,
  type ExposureReport,
  type ExposureTargets,
} from '@/lib/exposure'
import { getMainnetClient } from '@/lib/position-sim/rpc'

import { commitTyped, viewerOf, type Typed } from '../oracleGapView'

/** A short, stable key for a target list (djb2 over the joined ids). */
function targetsKey(t: ExposureTargets): string {
  let h = 5381
  for (const s of [...t.vaults, '|', ...t.markets, '|', ...(t.liveQueue ?? [])])
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `${t.vaults.length}:${t.markets.length}:${(h >>> 0).toString(36)}`
}

export function useExposure(address: `0x${string}` | null, targets: ExposureTargets | null) {
  const key = useMemo(() => (targets ? targetsKey(targets) : ''), [targets])
  return useQuery<ExposureReport, Error>({
    queryKey: ['wallet_exposure', address, key],
    queryFn: () => resolveExposure(viemReader(getMainnetClient()), address!, targets!),
    enabled: !!address && !!targets && targets.vaults.length + targets.markets.length > 0,
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  })
}

/**
 * The address the viewer is read as (oracleGapView viewerOf): what they typed, else the
 * connected account, followed across a wallet switch. Clearing the field goes back to the
 * wallet; an invalid entry reads nothing and says why.
 */
export function useViewerAddress() {
  const { address: wallet } = useAccount()
  const [typed, setTyped] = useState<Typed>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const v = viewerOf(wallet, typed)
  const input = draft ?? v.address ?? ''
  const commit = () => {
    if (draft === null) return
    const t = commitTyped(draft)
    setTyped(t)
    if (!t?.error) setDraft(null)
  }
  return { input, setInput: setDraft, commit, ...v }
}
