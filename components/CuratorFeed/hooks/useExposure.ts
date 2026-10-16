// The viewer's exposure: an address (pasted, or the connected wallet's) read on Ethereum
// mainnet over the vaults and markets §07 lists. Read-only: the keyless public client
// from lib/position-sim/rpc, never a wallet client; nothing is signed. Errors come back by
// name (lib/exposure/resolve.ts); a failed query is not retried behind the reader's back.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAccount } from 'wagmi'

import {
  resolveExposure,
  viemReader,
  type ExposureReport,
  type ExposureTargets,
} from '@/lib/exposure'
import { getMainnetClient, parseAddress } from '@/lib/position-sim/rpc'

/** A short, stable key for a target list (djb2 over the joined ids). */
function targetsKey(t: ExposureTargets): string {
  let h = 5381
  for (const s of [...t.vaults, '|', ...t.markets])
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

export const ADDRESS_HINT = 'Not an address: 0x and 40 hex characters.'

/**
 * The address the viewer is read as: what they pasted, else the connected wallet's
 * (prefilled once, while nothing was typed). Disconnecting clears a wallet-filled one.
 */
export function useViewerAddress() {
  const { address: wallet } = useAccount()
  const [input, setInput] = useState('')
  const [address, setAddress] = useState<`0x${string}` | null>(null)
  const [fromWallet, setFromWallet] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const typed = useRef(false)

  useEffect(() => {
    const w = wallet ? parseAddress(wallet) : null
    if (w && !typed.current && !address) {
      setInput(w)
      setAddress(w)
      setFromWallet(true)
    }
    if (!w && fromWallet) {
      setInput('')
      setAddress(null)
      setFromWallet(false)
    }
  }, [wallet, address, fromWallet])

  const commit = (raw: string) => {
    typed.current = true
    const s = raw.trim()
    if (!s) {
      setAddress(null)
      setFromWallet(false)
      setError(null)
      return
    }
    const a = parseAddress(s)
    if (!a) {
      setError(ADDRESS_HINT)
      return
    }
    setError(null)
    setFromWallet(!!wallet && a === wallet.toLowerCase())
    setAddress(a)
  }

  return { input, setInput, address, fromWallet, error, commit }
}
