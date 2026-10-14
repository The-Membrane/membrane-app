// Reads one address with every adapter, publishing each result as it lands so the page can
// show per-protocol progress. Read-only: the adapters hold no signer and send nothing.
//
// The address is an input, not state: the hook reads whatever `target` the page derives
// (the URL's ?address=, or a wallet the reader asked for). `nonce` forces a re-read of the
// same address. Results are keyed by the read they belong to, so a stale read can never
// show under a newer address.

import { useEffect, useState } from 'react'

import { ADAPTERS, runAdapter } from '@/lib/position-sim/adapters'
import type { AdapterResult, ProtocolId } from '@/lib/position-sim/types'

export const ADAPTER_ORDER: readonly { id: ProtocolId; label: string }[] = ADAPTERS.map((a) => ({
  id: a.id,
  label: a.label,
}))

type Results = Partial<Record<ProtocolId, AdapterResult>>

const NONE: Results = {}

export function useAdapterReads(target: `0x${string}` | null, nonce: number): Results {
  const [store, setStore] = useState<{ read: string; results: Results }>({ read: '', results: NONE })
  const readId = target ? `${target}#${nonce}` : ''

  useEffect(() => {
    if (!target) return
    const id = `${target}#${nonce}`
    let live = true
    for (const adapter of ADAPTERS) {
      // runAdapter never rejects: every failure, including Fluid's declared gap, comes
      // back as an AdapterResult with its own status.
      void runAdapter(adapter, target).then((r) => {
        if (!live) return
        setStore((prev) => ({
          read: id,
          results: { ...(prev.read === id ? prev.results : NONE), [r.protocol]: r },
        }))
      })
    }
    return () => {
      live = false
    }
  }, [target, nonce])

  return readId !== '' && store.read === readId ? store.results : NONE
}
