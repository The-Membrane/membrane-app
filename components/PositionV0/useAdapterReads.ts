// Reads one address with every adapter, publishing each result as it lands so the page can
// show per-protocol progress. Read-only: the adapters hold no signer and send nothing.
//
// The address is an input, not state: the hook reads whatever `target` the page derives
// (the URL's ?address=, or a wallet the reader asked for). `nonce` forces a re-read of the
// same address. Results are keyed by the read they belong to, so a stale read can never
// show under a newer address.

import { useCallback, useEffect, useRef, useState } from 'react'

import { ADAPTERS, runAdapter } from '@/lib/position-sim/adapters'
import type { AdapterResult, ProtocolId } from '@/lib/position-sim/types'

export const ADAPTER_ORDER: readonly { id: ProtocolId; label: string }[] = ADAPTERS.map((a) => ({
  id: a.id,
  label: a.label,
}))

type Results = Partial<Record<ProtocolId, AdapterResult>>

const NONE: Results = {}

export interface AdapterReads {
  results: Results
  /** Reads one venue again (a timed-out or failed one) for the same address and read. */
  retry: (protocol: ProtocolId) => void
}

export function useAdapterReads(target: `0x${string}` | null, nonce: number): AdapterReads {
  const [store, setStore] = useState<{ read: string; results: Results }>({ read: '', results: NONE })
  const readId = target ? `${target}#${nonce}` : ''
  // The read a retry belongs to; a retry that lands after the address changed is dropped.
  const current = useRef('')

  const publish = useCallback((id: string, r: AdapterResult) => {
    if (current.current !== id) return
    setStore((prev) => ({
      read: id,
      results: { ...(prev.read === id ? prev.results : NONE), [r.protocol]: r },
    }))
  }, [])

  useEffect(() => {
    if (!target) return
    const id = `${target}#${nonce}`
    current.current = id
    for (const adapter of ADAPTERS) {
      // runAdapter never rejects: every failure, including Fluid's declared gap and a read
      // past its deadline, comes back as an AdapterResult with its own status.
      void runAdapter(adapter, target).then((r) => publish(id, r))
    }
    return () => {
      current.current = ''
    }
  }, [target, nonce, publish])

  const retry = useCallback(
    (protocol: ProtocolId) => {
      const adapter = ADAPTERS.find((a) => a.id === protocol)
      if (!target || !adapter) return
      const id = `${target}#${nonce}`
      // Back to "reading…" for that venue only; the others stand.
      setStore((prev) => {
        if (prev.read !== id) return prev
        const results = { ...prev.results }
        delete results[protocol]
        return { read: id, results }
      })
      void runAdapter(adapter, target).then((r) => publish(id, r))
    },
    [target, nonce, publish],
  )

  return { results: readId !== '' && store.read === readId ? store.results : NONE, retry }
}
