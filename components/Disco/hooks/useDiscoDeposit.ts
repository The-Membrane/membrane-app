import { useQuery } from '@tanstack/react-query'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from '@cosmjs/encoding'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import contracts from '@/config/contracts.json'
import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { coin } from '@cosmjs/stargate'

/**
 * Parameters for depositing to LTV Disco
 */
interface UseDiscoDepositParams {
  /** The asset denom being deposited (backing asset for LTV tier) */
  asset: string
  /** Maximum LTV for the deposit tier (e.g., "0.75") */
  maxLtv: string
  /** Maximum borrow LTV for the deposit tier (e.g., "0.70") */
  maxBorrowLtv: string
  /** Amount of MBRN to deposit (human-readable) */
  amount: string
  /** Optional callback on successful transaction */
  txSuccess?: () => void
}

/**
 * Hook to deposit MBRN tokens to LTV Disco at a selected LTV pair.
 * 
 * @example
 * ```typescript
 * const deposit = useDiscoDeposit({
 *   asset: 'factory/osmo.../CDT',
 *   maxLtv: '0.75',
 *   maxBorrowLtv: '0.70',
 *   amount: '100',
 *   txSuccess: () => console.log('Deposit successful!'),
 * })
 * 
 * // Use with Ditto confirmation
 * openConfirmation(deposit.action, <Details />, { label: 'Deposit', actionType: 'deposit' })
 * ```
 */
const useDiscoDeposit = ({
  asset,
  maxLtv,
  maxBorrowLtv,
  amount,
  txSuccess,
}: UseDiscoDepositParams) => {
  const { address } = useWallet()
  const mbrnAsset = useAssetBySymbol('MBRN')
  const discoContract = (contracts as any).ltv_disco

  type QueryData = { msgs: MsgExecuteContractEncodeObject[] | undefined }

  const { data: queryData } = useQuery<QueryData>({
    queryKey: ['disco_deposit', 'msgs', address, asset, maxLtv, maxBorrowLtv, amount],
    queryFn: () => {
      if (!address || !asset || !maxLtv || !maxBorrowLtv || !amount || !mbrnAsset) {
        return { msgs: undefined }
      }
      if (!discoContract || discoContract === '') {
        return { msgs: undefined }
      }

      const microAmount = shiftDigits(amount, 6).dp(0).toString()
      const funds = [coin(microAmount, mbrnAsset.base)]

      const msg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: discoContract,
          msg: toUtf8(JSON.stringify({
            deposit: {
              asset,
              max_ltv: maxLtv,
              max_borrow_ltv: maxBorrowLtv,
            }
          })),
          funds,
        }),
      }

      return { msgs: [msg] }
    },
    enabled: !!address && !!asset && !!maxLtv && !!maxBorrowLtv && !!amount && !!mbrnAsset,
  })

  const msgs = queryData?.msgs ?? []

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['disco_user_deposits'] })
    queryClient.invalidateQueries({ queryKey: ['disco_ltv_queue'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    txSuccess?.()
  }

  const action = useSimulateAndBroadcast({
    msgs,
    queryKey: ['disco_deposit_sim', (msgs?.toString() ?? '0')],
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

























