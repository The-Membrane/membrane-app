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
 * balanceOf reads batch through Multicall3 (etched on anvil by
 * membrane-solidity script/DeployLocalExtras.s.sol / anvil_setCode).
 */
export const useBalance = (_legacyChainID?: string, inputedAddress?: string) => {
  const { address, chain, publicClient } = useWallet()
  const addressToUse = (inputedAddress || address) as `0x${string}` | undefined

  return useQuery<BalanceEntry[] | null>({
    queryKey: ['evm balances', addressToUse, chain.id],
    queryFn: async () => {
      if (!addressToUse || !publicClient) return null

      const assets = getAssets()
      const erc20s = assets.filter((a) => a.base !== 'native')
      const native = assets.find((a) => a.base === 'native')

      const [nativeWei, tokenResults] = await Promise.all([
        native ? publicClient.getBalance({ address: addressToUse }).catch(() => null) : null,
        erc20s.length
          ? publicClient.multicall({
              contracts: erc20s.map((a) => ({
                address: a.base as `0x${string}`,
                abi: erc20Abi,
                functionName: 'balanceOf' as const,
                args: [addressToUse],
              })),
              allowFailure: true,
            })
          : [],
      ])

      const entries: BalanceEntry[] = []
      if (nativeWei !== null && nativeWei !== undefined) {
        entries.push({ denom: 'native', amount: nativeWei.toString() })
      }
      tokenResults.forEach((res, i) => {
        // failed slots = token not deployed on this chain — omit
        if (res.status === 'success') {
          entries.push({ denom: erc20s[i].base, amount: (res.result as bigint).toString() })
        }
      })

      return entries
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
