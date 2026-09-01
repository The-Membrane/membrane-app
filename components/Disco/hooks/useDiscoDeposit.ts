import { useQuery } from '@tanstack/react-query'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from '@cosmjs/encoding'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import contracts from '@/config/contracts.json'
import { shiftDigits } from '@/helpers/math'
import useAppState from '@/persisted-state/useAppState'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { coin } from '@cosmjs/stargate'

/**
 * Parameters for depositing to Disco
 */
interface UseDiscoDepositParams {
  /** The asset denom being insured */
  asset: string
  /** Slot number (1-9) */
  slot: number
  /** Amount of MBRN to deposit (human-readable) */
  amount: string
  /** Optional deposit_id to top up an existing deposit (auto-claims first) */
  depositId?: string
  /** Optional callback on successful transaction */
  txSuccess?: () => void
}

/**
 * Hook to deposit MBRN tokens to a Disco slot.
 *
 * @example
 * ```typescript
 * const deposit = useDiscoDeposit({
 *   asset: 'ibc/...',
 *   slot: 3,
 *   amount: '100',
 *   txSuccess: () => console.log('Deposit successful!'),
 * })
 * ```
 */
const useDiscoDeposit = ({
  asset,
  slot,
  amount,
  depositId,
  txSuccess,
}: UseDiscoDepositParams) => {
  const { address } = useWallet()
  const { appState } = useAppState()
  const mbrnAsset = useAssetBySymbol('MBRN')
  const discoContract = (contracts as any).ltv_disco

  type QueryData = { msgs: MsgExecuteContractEncodeObject[] | undefined }

  const { data: queryData } = useQuery<QueryData>({
    queryKey: ['disco_deposit', 'msgs', address, asset, slot, amount, depositId, appState.rpcUrl],
    staleTime: 1000 * 60 * 5,
    queryFn: () => {
      if (!address || !asset || !slot || !amount || !mbrnAsset) {
        return { msgs: undefined }
      }
      if (!discoContract || discoContract === '') {
        return { msgs: undefined }
      }

      const microAmount = shiftDigits(amount, 6).dp(0).toString()
      const funds = [coin(microAmount, mbrnAsset.base)]

      const executeMsg: any = {
        submit_deposit: {
          deposit_input: { asset, slot },
        }
      }
      if (depositId) {
        executeMsg.submit_deposit.deposit_id = depositId
      }

      const msg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: discoContract,
          msg: toUtf8(JSON.stringify(executeMsg)),
          funds,
        }),
      }

      return { msgs: [msg] }
    },
    enabled: !!address && !!asset && slot >= 1 && slot <= 9 && !!amount && !!mbrnAsset,
  })

  const msgs = queryData?.msgs ?? []

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['disco'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    txSuccess?.()
  }

  const action = useSimulateAndBroadcast({
    msgs,
    queryKey: ['disco_deposit_sim', address, asset, slot, amount, depositId],
    amount,
    enabled: !!msgs?.length,
    onSuccess,
  })

  return {
    action,
    msgs,
  }
}

export default useDiscoDeposit
