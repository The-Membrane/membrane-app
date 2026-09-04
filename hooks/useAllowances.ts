import { useQuery } from '@tanstack/react-query'
import { getPublicClient } from '@/services/chain/client'
import { readAllowance } from '@/services/chain/allowance'
import { getContractAddress, type Address, type ContractName } from '@/config/evm/contracts'
import type { Asset } from '@/helpers/chain'
import useAssets from '@/hooks/useAssets'
import useWallet from '@/hooks/useWallet'

/**
 * Live ERC-20 allowances the connected wallet has granted to OUR spender
 * contracts — the data behind the wallet-section allowance panel.
 *
 * Because every approve the app emits is exact-amount and consumed by its
 * action in the same flow, a nonzero row here almost always means an abandoned
 * flow left a dangling allowance — exactly what the panel exists to surface
 * and revoke. Empty result = nothing rendered.
 *
 * Reads are wallet-independent (services/chain/client.ts) and the client
 * multicall-batches them, so the assets × spenders fan-out lands in a couple
 * of RPC round trips and costs the user zero transactions.
 */

// Every first-party contract any CTA hook approves tokens to.
const SPENDERS: { name: ContractName; label: string }[] = [
  { name: 'cdp', label: 'CDP' },
  { name: 'cdpRouter', label: 'CDP Router' },
  { name: 'transmuter', label: 'Transmuter' },
  { name: 'staking', label: 'Staking' },
  { name: 'auction', label: 'Auction' },
  { name: 'liqQueue', label: 'Liquidation Queue' },
]

export type AllowanceRow = {
  asset: Asset
  spender: Address
  spenderLabel: string
  /** exact remaining allowance, base units */
  amount: bigint
}

export const useAllowances = () => {
  const { address, chain } = useWallet()
  const assets = useAssets()

  return useQuery<AllowanceRow[]>({
    queryKey: ['allowances', address ?? '', chain?.id ?? 0, assets?.length ?? 0],
    queryFn: async () => {
      if (!address || !chain || !assets?.length) return []
      const client = getPublicClient()
      const erc20Assets = assets.filter((a: Asset) => a.base?.startsWith('0x'))
      const spenders = SPENDERS.map((s) => ({
        ...s,
        address: getContractAddress(chain.id, s.name),
      })).filter((s): s is (typeof SPENDERS)[number] & { address: Address } => !!s.address)

      const rows = await Promise.all(
        erc20Assets.flatMap((asset: Asset) =>
          spenders.map(async (spender): Promise<AllowanceRow | null> => {
            const amount = await readAllowance(
              client,
              asset.base as Address,
              address as Address,
              spender.address,
            )
            if (!amount || amount <= 0n) return null
            return { asset, spender: spender.address, spenderLabel: spender.label, amount }
          }),
        ),
      )
      return rows.filter((r: AllowanceRow | null): r is AllowanceRow => r !== null)
    },
    enabled: !!address && !!chain && !!assets?.length,
    staleTime: 1000 * 30,
  })
}

export default useAllowances
