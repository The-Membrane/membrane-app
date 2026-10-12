import type { Chain } from 'viem'

/**
 * Block-explorer page for an EVM transaction: the viem Chain's `blockExplorers.default.url`
 * + `/tx/<hash>` (config/evm/chains.ts). Was: hard-coded Cosmos explorers (celatone/mintscan).
 *
 * Returns undefined when there is no hash or the chain has no explorer (e.g. local anvil) —
 * callers show the hash unlinked rather than point at the wrong explorer.
 */
export const getTxExplorerUrl = (
  chain: Pick<Chain, 'blockExplorers'> | undefined,
  txHash: string | undefined,
): string | undefined => {
  const baseUrl = chain?.blockExplorers?.default?.url
  if (!baseUrl || !txHash) return undefined
  return `${baseUrl.replace(/\/+$/, '')}/tx/${txHash}`
}
