import { useQuery } from '@tanstack/react-query'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import contracts from '@/config/contracts.json'
import { EarnMsgComposer } from '@/contracts/codegen/earn/Earn.message-composer'
import { shiftDigits } from '@/helpers/math'

/**
 * Parameters for withdrawing from the looping vault
 */
interface UseManicWithdrawParams {
  /** Amount of collateral to withdraw (human-readable). Uses unloopCDP for partial, exitVault for full. */
  amount?: string
  /** If true, exits the vault completely */
  exitFully?: boolean
  /** Optional callback on successful transaction */
  txSuccess?: () => void
}

/**
 * Hook to withdraw USDC from a looping position.
 * 
 * - If `exitFully` is true, uses `exitVault` to close the entire position
 * - If `amount` is provided, uses `unloopCDP` to withdraw a specific amount
 * 
 * @example
 * ```typescript
 * // Partial withdrawal
 * const withdrawPartial = useManicWithdraw({
 *   amount: '500',
 *   txSuccess: () => console.log('Partial withdraw successful!'),
 * })
 * 
 * // Full exit
 * const withdrawFull = useManicWithdraw({
 *   exitFully: true,
 *   txSuccess: () => console.log('Exit successful!'),
 * })
 * 
 * // Use with Ditto confirmation
 * openConfirmation(withdraw.action, <Details />, { label: 'Withdraw', actionType: 'withdraw' })
 * ```
 */
const useManicWithdraw = ({
  amount,
  exitFully = false,
  txSuccess,
}: UseManicWithdrawParams) => {
  const { address } = useWallet()
  const earnContract = contracts.earn

  type QueryData = { msgs: MsgExecuteContractEncodeObject[] | undefined }

  const { data: queryData } = useQuery<QueryData>({
    queryKey: ['manic_withdraw', 'msgs', address, amount, exitFully],
    queryFn: () => {
      if (!address) {
        return { msgs: undefined }
      }
      if (!earnContract || earnContract === '') {
        return { msgs: undefined }
      }

      // Need either amount (for partial) or exitFully flag
      if (!amount && !exitFully) {
        return { msgs: undefined }
      }

      const messageComposer = new EarnMsgComposer(address, earnContract)

      let msg: MsgExecuteContractEncodeObject

      if (exitFully) {
        // Full exit - close the entire position
        msg = messageComposer.exitVault()
      } else if (amount) {
        // Partial withdrawal - unloop a specific amount
        const microAmount = shiftDigits(amount, 6).dp(0).toString()
        msg = messageComposer.unloopCDP({
          desiredCollateralWithdrawal: microAmount,
        })
      } else {
        return { msgs: undefined }
      }

      return { msgs: [msg] }
    },
    enabled: !!address && (!!amount || exitFully),
  })

  const msgs = queryData?.msgs ?? []

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['usdc_looping_position'] })
    queryClient.invalidateQueries({ queryKey: ['transmuter_usdc_balance'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['basket'] })
    txSuccess?.()
  }

  const action = useSimulateAndBroadcast({
    msgs,
    queryKey: ['manic_withdraw_sim', (msgs?.toString() ?? '0')],
    enabled: !!msgs?.length,
    onSuccess,
  })

  return {
    action,
    msgs,
  }
}

export default useManicWithdraw

























