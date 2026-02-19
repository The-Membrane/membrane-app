import { useQuery } from '@tanstack/react-query'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from '@cosmjs/encoding'
import useWallet from '@/hooks/useWallet'
import { shiftDigits } from '@/helpers/math'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { queryClient } from '@/pages/_app'
import { BorrowRate } from './useBorrowModal'
import contracts from '@/config/contracts.json'

interface UseBorrowTransactionProps {
  asset: {
    symbol: 'CDT' | 'USDC'
    denom: string
  }
  borrowAmount: number
  selectedRate: BorrowRate
  receiveToWallet: boolean
  positionIndex?: number
  enabled?: boolean
  onSuccess?: () => void
}

export const useBorrowTransaction = ({
  asset,
  borrowAmount,
  selectedRate,
  receiveToWallet,
  positionIndex = 0,
  enabled = true,
  onSuccess,
}: UseBorrowTransactionProps) => {
  const { address } = useWallet()

  // For CDT, we need to determine which contract to use
  // CDT can be borrowed from the CDP contract (mint) or managed market
  // For now, using managed market pattern
  // TODO: Determine correct contract based on asset and position
  
  // Get the market contract - for CDT this might be the CDP contract
  // For USDC, this would be a managed market contract
  const marketContract = asset.symbol === 'CDT' 
    ? contracts.cdp 
    : contracts.marketManager // Would need to get specific market contract for USDC

  // Build borrow message
  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[]>({
    queryKey: [
      'borrow_transaction',
      address,
      asset.denom,
      borrowAmount,
      selectedRate,
      receiveToWallet,
      positionIndex,
      marketContract,
    ],
    queryFn: () => {
      if (!address || !borrowAmount || borrowAmount <= 0 || !enabled) {
        return []
      }

      // Convert borrow amount to micro units (assuming 6 decimals for CDT/USDC)
      const microAmount = shiftDigits(borrowAmount, 6).toFixed(0)

      // Build increase_debt message
      const borrowMsg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: marketContract,
          msg: toUtf8(
            JSON.stringify({
              increase_debt: {
                position_id: String(positionIndex + 1),
                amount: microAmount,
                mint_to_addr: receiveToWallet ? address : undefined,
                // USDC borrows mint CDT then swap via transmuter (peg_debt)
                peg_debt: asset.symbol === 'USDC' ? true : undefined,
              },
            })
          ),
          funds: [],
        }),
      }

      return [borrowMsg]
    },
    enabled: enabled && !!address && borrowAmount > 0,
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
    queryKey: ['borrow', asset.symbol, borrowAmount],
    amount: borrowAmount.toString(),
    enabled: enabled && !!msgs && msgs.length > 0,
    onSuccess: handleSuccess,
  })
}






