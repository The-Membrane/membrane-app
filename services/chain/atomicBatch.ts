/**
 * EIP-5792 atomic-batch capability detection.
 *
 * Top rung of the execution ladder (see approve ladder in txRunner.ts): when
 * the wallet reports atomic support for the chain, a multi-call batch goes out
 * as ONE all-or-nothing wallet_sendCalls submission — the approve and the
 * action land or revert together, so no dangling allowance survives a failed
 * flow, and the whole batch is a single confirmation.
 *
 * Status meanings (EIP-5792 `atomic` capability):
 *   supported   — wallet executes the batch atomically today
 *   ready       — an EOA that will prompt a one-time EIP-7702 upgrade first
 *   unsupported — no batching; run the sequential/permit paths instead
 *
 * API drift note: the current capability shape is `atomic.status`; the older
 * v1 shape was `atomicBatch.supported`. Both are read. Chain keys appear as
 * numbers or hex strings depending on client version; `0x0` means all chains.
 *
 * Failure contract: null-ish clients, a missing getCapabilities method, or a
 * thrown request all resolve to 'unsupported' — detection never blocks a tx.
 */

export type AtomicStatus = 'supported' | 'ready' | 'unsupported'

// wallet-uid:chainId → status. Per-session cache; 'ready' → 'supported'
// upgrades change nothing here since both attempt the batch.
const statusCache = new Map<string, AtomicStatus>()

/** Test seam — capability probes cache per wallet uid + chain. */
export function clearAtomicStatusCache() {
  statusCache.clear()
}

function readEntryStatus(entry: any): AtomicStatus {
  const status = entry?.atomic?.status
  if (status === 'supported' || status === 'ready') return status
  // legacy v1 shape
  if (entry?.atomicBatch?.supported === true) return 'supported'
  return 'unsupported'
}

export async function getAtomicStatus(
  walletClient: any,
  chainId: number | undefined,
): Promise<AtomicStatus> {
  if (!walletClient || !chainId || typeof walletClient.getCapabilities !== 'function') {
    return 'unsupported'
  }
  const key = `${walletClient.uid ?? 'wallet'}:${chainId}`
  const cached = statusCache.get(key)
  if (cached) return cached

  let status: AtomicStatus = 'unsupported'
  try {
    const caps = await walletClient.getCapabilities()
    const entry =
      caps?.[chainId] ?? caps?.[`0x${chainId.toString(16)}`] ?? caps?.['0x0'] ?? caps?.[0]
    status = readEntryStatus(entry)
  } catch (error) {
    console.error('Error querying wallet_getCapabilities:', error)
  }
  statusCache.set(key, status)
  return status
}
