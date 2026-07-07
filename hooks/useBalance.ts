import { shiftDigits } from '@/helpers/math'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { erc20Abi } from 'viem'
import useWallet from './useWallet'
import { Asset, getAssets } from '@/helpers/chain'

type BalanceEntry = {
  /** the asset's `base` — ERC-20 address, or 'native' */
  denom: string
  /** raw base-unit amount as string (18-dec for CDT/MBRN — see config/evm/tokens.ts) */
  amount: string
}

/**
 * All-balances hook — EVM internals (native getBalance + per-token balanceOf) behind
 * the Cosmos bank-query shape [{denom, amount}], so `.find(b => b.denom === asset.base)`
 * consumers keep working. Legacy chainID param accepted and ignored.
 *
 * Sequential readContract instead of multicall: anvil has no Multicall3 predeploy and
 * the registry is small.
 */
export const useBalance = (_legacyChainID?: string, inputedAddress?: string) => {
  const { address, chain, publicClient } = useWallet()
  const addressToUse = (inputedAddress || address) as `0x${string}` | undefined

  return useQuery<BalanceEntry[] | null>({
    queryKey: ['evm balances', addressToUse, chain.id],
    queryFn: async () => {
      if (!addressToUse || !publicClient) return null

      const assets = getAssets()
      const entries = await Promise.all(
        assets.map(async (asset): Promise<BalanceEntry | null> => {
          try {
            if (asset.base === 'native') {
              const wei = await publicClient.getBalance({ address: addressToUse })
              return { denom: 'native', amount: wei.toString() }
            }
            const raw = await publicClient.readContract({
              address: asset.base as `0x${string}`,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [addressToUse],
            })
            return { denom: asset.base, amount: raw.toString() }
          } catch {
            return null // token not deployed on this chain — omit
          }
        }),
      )

      return entries.filter((e): e is BalanceEntry => e !== null)
    },
    enabled: !!addressToUse && !!publicClient,
    staleTime: 1000 * 10,
    refetchOnWindowFocus: true,
  })
}

export const useBalanceByAsset = (asset: Asset | null, _legacyChainID?: string, inputedAddress?: string) => {
  // Always call useWallet to keep hook order consistent
  const { data: balances } = useBalance(undefined, inputedAddress)
  const { address } = useWallet()

  // Decide which address to use (prop wins if provided)
  const addressToUse = inputedAddress || address

  return useMemo(() => {
    if (!balances || !asset || !addressToUse) return '0'

    const balance = balances.find((b) => b.denom === asset.base)?.amount
    const decimals = asset.decimal || 18

    if (!balance) return '0'
    return shiftDigits(balance, -decimals).toString()
  }, [balances, asset?.base, asset?.decimal, addressToUse])
}

export default useBalance
