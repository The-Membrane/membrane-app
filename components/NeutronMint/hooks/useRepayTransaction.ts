import { useQuery } from '@tanstack/react-query'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from '@cosmjs/encoding'
import useWallet from '@/hooks/useWallet'
import { shiftDigits } from '@/helpers/math'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { queryClient } from '@/pages/_app'
import contracts from '@/config/contracts.json'
import { denoms } from '@/config/defaults'

interface UseRepayTransactionProps {
  repayAmount: number
  assetSymbol?: 'CDT' | 'USDC'
  assetDenom?: string
  positionIndex?: number
  enabled?: boolean
  onSuccess?: () => void
}

export const useRepayTransaction = ({
  repayAmount,
  assetSymbol = 'CDT',
  assetDenom,
  positionIndex = 0,
  enabled = true,
  onSuccess,
}: UseRepayTransactionProps) => {
  const { address } = useWallet()

  // Resolve denom: use provided denom or fall back to defaults
  const repayDenom = assetDenom || (assetSymbol === 'USDC' ? denoms.USDC[0] as string : denoms.CDT[0] as string)

  // Build repay message
  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[]>({
    queryKey: [
      'repay_transaction',
      address,
      repayAmount,
      assetSymbol,
      positionIndex,
    ],
    queryFn: () => {
      if (!address || !repayAmount || repayAmount <= 0 || !enabled) {
        return []
      }

      // Convert repay amount to micro units (6 decimals for CDT/USDC)
      const microAmount = shiftDigits(repayAmount, 6).toFixed(0)

      // Build repay message - sends funds attached to the message
      const repayMsg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: contracts.cdp,
          msg: toUtf8(
            JSON.stringify({
              repay: {
                position_id: String(positionIndex + 1),
              },
            })
          ),
          funds: [
            {
              denom: repayDenom,
              amount: microAmount,
            },
          ],
        }),
      }

      return [repayMsg]
    },
    enabled: enabled && !!address && repayAmount > 0,
  })

  const handleSuccess = () => {
    // Invalidate relevant queries
    queryClient.invalidateQueries({ queryKey: ['vault summary'] })
    queryClient.invalidateQueries({ queryKey: ['basket positions'] })
    queryClient.invalidateQueries({ queryKey: ['credit rate'] })
    queryClient.invalidateQueries({ queryKey: ['user positions'] })
    onSuccess?.()
  }

  return useSimulateAndBroadcast({
    msgs,
    queryKey: ['repay', assetSymbol, String(repayAmount)],
    amount: repayAmount.toString(),
    enabled: enabled && !!msgs && msgs.length > 0,
    onSuccess: handleSuccess,
  })
}
