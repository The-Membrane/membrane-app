import { useQuery } from '@tanstack/react-query'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from '@cosmjs/encoding'
import { coin } from '@cosmjs/stargate'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import contracts from '@/config/contracts.json'
import { shiftDigits } from '@/helpers/math'

/**
 * Parameters for executing a transmuter swap
 */
interface UseTransmuterSwapParams {
  /** The input asset denom (e.g. CDT or USDC ibc denom) */
  inputDenom: string
  /** The output asset denom (e.g. USDC or CDT ibc denom) */
  outputDenom: string
  /** Amount to swap (human-readable, e.g. "100") */
  amount: string
  /** Optional callback on successful transaction */
  txSuccess?: () => void
}

/**
 * Hook to execute a swap on the Transmuter contract.
 *
 * Follows the standard CTA hook pattern: useQuery builds messages,
 * piped into useSimulateAndBroadcast for fee estimation and signing.
 *
 * The transmuter swap sends the input asset as funds and specifies
 * the desired output asset denom in the execute message.
 *
 * @example
 * ```typescript
 * const { action, msgs } = useTransmuterSwap({
 *   inputDenom: 'factory/.../ucdt',
 *   outputDenom: 'ibc/...usdc',
 *   amount: '1000',
 *   txSuccess: () => console.log('Swap successful!'),
 * })
 *
 * <Button
 *   onClick={() => action.tx.mutate()}
 *   isLoading={action.simulate.isLoading || action.tx.isLoading}
 *   isDisabled={!action.simulate.isSuccess}
 * >
 *   Swap
 * </Button>
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

  // LAYER 1: Build messages
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

      const msg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: transmuterContract,
          msg: toUtf8(JSON.stringify({
            swap: {
              input_asset: inputDenom,
              output_asset: outputDenom,
            },
          })),
          funds: [coin(microAmount, inputDenom)],
        }),
      }

      return { msgs: [msg] }
    },
    enabled: !!address && !!inputDenom && !!outputDenom && !!amount,
  })

  const msgs = queryData?.msgs ?? []

  // LAYER 2 + 3: Simulate & Broadcast
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
