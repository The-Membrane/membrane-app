import { useQuery } from '@tanstack/react-query'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from '@cosmjs/encoding'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import contracts from '@/config/contracts.json'

/**
 * Parameters for withdrawing USDC from acquisition
 */
interface UseAcquisitionWithdrawParams {
  /** Optional callback on successful transaction */
  txSuccess?: () => void
}

/**
 * Hook to withdraw USDC from the acquisition contract.
 * 
 * Note: This is only available during the withdrawal period after lockdrop ends.
 * 
 * @example
 * ```typescript
 * const withdraw = useAcquisitionWithdraw({
 *   txSuccess: () => console.log('Withdraw successful!'),
 * })
 * 
 * // Use with Ditto confirmation
 * openConfirmation(withdraw.action, <Details />, { label: 'Withdraw', actionType: 'withdraw' })
 * ```
 */
const useAcquisitionWithdraw = ({
  txSuccess,
}: UseAcquisitionWithdrawParams = {}) => {
  const { address } = useWallet()
  const lockdropContract = (contracts as any).acquisition

  type QueryData = { msgs: MsgExecuteContractEncodeObject[] | undefined }

  const { data: queryData } = useQuery<QueryData>({
    queryKey: ['acquisition_withdraw', 'msgs', address],
    queryFn: () => {
      if (!address) {
        return { msgs: undefined }
      }
      if (!lockdropContract || lockdropContract === '') {
        return { msgs: undefined }
      }

      const msg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: lockdropContract,
          msg: toUtf8(JSON.stringify({ withdraw: {} })),
          funds: [],
        }),
      }

      return { msgs: [msg] }
    },
    enabled: !!address,
  })

  const msgs = queryData?.msgs ?? []

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['acquisition_user'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    txSuccess?.()
  }

  const action = useSimulateAndBroadcast({
    msgs,
    queryKey: ['acquisition_withdraw_sim', (msgs?.toString() ?? '0')],
    enabled: !!msgs?.length,
    onSuccess,
  })

  return {
    action,
    msgs,
  }
}

export default useAcquisitionWithdraw


























