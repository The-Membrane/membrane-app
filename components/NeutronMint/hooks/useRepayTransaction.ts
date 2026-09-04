import { useQuery } from '@tanstack/react-query'
import { cdpAbi } from '@/contracts/abis/cdp'
import { assetKey } from '@/services/chain/liquidation'
import { buildApproveIfNeeded } from '@/services/chain/allowance'
import { getContractAddress, type Address } from '@/config/evm/contracts'
import type { EvmCall } from '@/services/chain/types'
import useWallet from '@/hooks/useWallet'
import { shiftDigits } from '@/helpers/math'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { queryClient } from '@/pages/_app'
import { useUserPositions } from '@/hooks/useCDP'
import { useAssetBySymbol } from '@/hooks/useAssets'

interface UseRepayTransactionProps {
  repayAmount: number
  assetSymbol?: 'CDT' | 'USDC'
  assetDenom?: string
  positionIndex?: number
  enabled?: boolean
  onSuccess?: () => void
  /** Rendered consequence for the success toast (see positionDelta.ts). */
  successMessage?: string
}

/**
 * Repay CTA — EVM port. Migration counterpart: CosmWasm `repay` with CDT attached as funds,
 * sandwiched by Points check/give msgs. On EVM repay pulls CDT (18 decimals) via transferFrom,
 * so this builds erc20(CDT).approve(cdp, amount) + cdp.repay(id, owner, amount, cdtDenom)
 * (contracts/abis/cdp.ts). NOT atomic — two wallet signatures (services/chain/types.ts).
 *
 * TODO(evm-migration): the Points check/give sandwich (PointsMsgComposer) is dropped — the
 * EVM Points surface is not wired into the CDP domain yet. Only CDT repay is modeled; a USDC
 * repay would need a CDT swap path that does not exist in the port yet.
 */
export const useRepayTransaction = ({
  repayAmount,
  assetSymbol = 'CDT',
  assetDenom,
  positionIndex = 0,
  enabled = true,
  onSuccess,
  successMessage,
}: UseRepayTransactionProps) => {
  const { address, chain, publicClient } = useWallet()
  const { data: positions } = useUserPositions()
  const cdtAsset = useAssetBySymbol('CDT')

  const cdpAddr = chain ? getContractAddress(chain.id, 'cdp') : undefined
  const positionId =
    positions && positions.length > positionIndex ? positions[positionIndex].positionId : 0n

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: [
      'repay_transaction',
      'evm',
      address ?? '',
      cdpAddr ?? '',
      positionId.toString(),
      assetSymbol,
      String(repayAmount),
    ],
    staleTime: 1000 * 60 * 5,
    queryFn: async () => {
      if (!address || !cdpAddr || !cdtAsset || !repayAmount || repayAmount <= 0 || !enabled) return undefined
      // Only CDT repay is supported on EVM (see file-level TODO).
      if (assetSymbol !== 'CDT') return undefined

      const amount = BigInt(shiftDigits(repayAmount, cdtAsset.decimal).dp(0).toString())
      const cdtToken = cdtAsset.base as Address
      // Approve gated on the standing allowance (services/chain/allowance.ts).
      return [
        ...(await buildApproveIfNeeded(publicClient ?? null, {
          token: cdtToken,
          owner: address as Address,
          spender: cdpAddr as Address,
          amount,
        })),
        {
          address: cdpAddr,
          abi: cdpAbi,
          functionName: 'repay',
          args: [positionId, address, amount, assetKey('CDT')],
        },
      ]
    },
    enabled: enabled && !!address && !!cdpAddr && repayAmount > 0,
  })

  const handleSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['vault summary'] })
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['credit rate'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    // Allowance read inside the msg builder changed with this tx — rebuild msgs.
    queryClient.invalidateQueries({ queryKey: ['repay_transaction', 'evm'] })
    onSuccess?.()
  }

  return useSimulateAndBroadcast({
    msgs,
    queryKey: ['repay', assetSymbol, String(repayAmount)],
    amount: String(repayAmount),
    enabled: enabled && !!msgs && msgs.length > 0,
    onSuccess: handleSuccess,
    successMessage,
  })
}
