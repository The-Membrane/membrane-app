import { useQuery } from '@tanstack/react-query'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import contracts from '@/config/contracts.json'
import { EarnMsgComposer } from '@/contracts/codegen/earn/Earn.message-composer'
import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { coin } from '@cosmjs/stargate'

/**
 * Parameters for depositing USDC to the looping vault
 */
interface UseManicDepositParams {
  /** Amount of USDC to deposit (human-readable) */
  amount: string
  /** Optional callback on successful transaction */
  txSuccess?: () => void
}

/**
 * Hook to deposit USDC to create/add to a looping position.
 * 
 * Uses the Earn contract's `enterVault` function to deposit USDC.
 * 
 * @example
 * ```typescript
 * const deposit = useManicDeposit({
 *   amount: '1000',
 *   txSuccess: () => console.log('Deposit successful!'),
 * })
 * 
 * // Use with Ditto confirmation
 * openConfirmation(deposit.action, <Details />, { label: 'Deposit', actionType: 'deposit' })
 * ```
 */
const useManicDeposit = ({
  amount,
  txSuccess,
}: UseManicDepositParams) => {
  const { address } = useWallet()
  const usdcAsset = useAssetBySymbol('USDC')
  const earnContract = contracts.earn

  type QueryData = { msgs: MsgExecuteContractEncodeObject[] | undefined }

  const { data: queryData } = useQuery<QueryData>({
    queryKey: ['manic_deposit', 'msgs', address, amount],
    queryFn: () => {
      if (!address || !amount || !usdcAsset) {
        return { msgs: undefined }
      }
      if (!earnContract || earnContract === '') {
        return { msgs: undefined }
      }

      const microAmount = shiftDigits(amount, 6).dp(0).toString()
      const funds = [coin(microAmount, usdcAsset.base)]

      const messageComposer = new EarnMsgComposer(address, earnContract)
      const msg = messageComposer.enterVault(funds)

      return { msgs: [msg] }
    },
    enabled: !!address && !!amount && !!usdcAsset,
  })

  const msgs = queryData?.msgs ?? []

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['usdc_looping_position'] })
    queryClient.invalidateQueries({ queryKey: ['transmuter_usdc_balance'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    txSuccess?.()
  }

  const action = useSimulateAndBroadcast({
    msgs,
    queryKey: ['manic_deposit_sim', (msgs?.toString() ?? '0')],
    amount,
    enabled: !!msgs?.length,
    onSuccess,
  })

  return {
    action,
    msgs,
  }
}

export default useManicDeposit


























