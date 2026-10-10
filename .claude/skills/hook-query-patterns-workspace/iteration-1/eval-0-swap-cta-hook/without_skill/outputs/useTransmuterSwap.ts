import { useQuery } from '@tanstack/react-query'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from '@cosmjs/encoding'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import contracts from '@/config/contracts.json'
import { shiftDigits } from '@/helpers/math'
import { coin } from '@cosmjs/stargate'

/**
 * Parameters for executing a transmuter swap
 */
interface UseTransmuterSwapParams {
  /** The denom of the asset being sent (input) */
  inputDenom: string
  /** The denom of the asset being received (output) */
  outputDenom: string
  /** Amount to swap in human-readable units (e.g. "1000" for 1000 USDC) */
  amount: string
  /** Optional callback on successful transaction */
  txSuccess?: () => void
}

/**
 * Hook to execute a swap on the Transmuter contract.
 *
 * Sends the input asset to the transmuter and receives the output asset in return.
 * The swap message includes the output denom so the contract knows which asset to return.
 *
 * @example
 * ```typescript
 * const swap = useTransmuterSwap({
 *   inputDenom: 'ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4', // USDC
 *   outputDenom: 'factory/osmo.../CDT', // CDT
 *   amount: '1000',
 *   txSuccess: () => console.log('Swap successful!'),
 * })
 *
 * // Execute the swap
 * await swap.action.tx.mutateAsync()
 * ```
 */
const useTransmuterSwap = ({
  inputDenom,
  outputDenom,
  amount,
  txSuccess,
}: UseTransmuterSwapParams) => {
  const { address } = useWallet()
  const transmuterContract = (contracts as any).transmuter

  type QueryData = { msgs: MsgExecuteContractEncodeObject[] | undefined }

  const { data: queryData } = useQuery<QueryData>({
    queryKey: ['transmuter_swap', 'msgs', address, inputDenom, outputDenom, amount],
    queryFn: () => {
      if (!address || !inputDenom || !outputDenom || !amount) {
        return { msgs: undefined }
      }
      if (!transmuterContract || transmuterContract === '') {
        return { msgs: undefined }
      }

      const microAmount = shiftDigits(amount, 6).dp(0).toString()
      if (microAmount === '0' || microAmount === 'NaN') {
        return { msgs: undefined }
      }

      const funds = [coin(microAmount, inputDenom)]

      const msg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: transmuterContract,
          msg: toUtf8(JSON.stringify({
            swap: {
              output_denom: outputDenom,
            }
          })),
          funds,
        }),
      }

      return { msgs: [msg] }
    },
    enabled: !!address && !!inputDenom && !!outputDenom && !!amount && parseFloat(amount) > 0,
  })

  const msgs = queryData?.msgs ?? []

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['transmuter'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    txSuccess?.()
  }

  const action = useSimulateAndBroadcast({
    msgs,
    queryKey: ['transmuter_swap_sim', (msgs?.toString() ?? '0')],
    amount,
    enabled: !!msgs?.length,
    onSuccess,
  })

  return {
    action,
    msgs,
  }
}

export default useTransmuterSwap
