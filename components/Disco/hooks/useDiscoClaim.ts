import { useQuery } from '@tanstack/react-query'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from '@cosmjs/encoding'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import contracts from '@/config/contracts.json'

/**
 * Parameters for claiming revenue from LTV Disco
 */
interface UseDiscoClaimParams {
  /** The asset denom to claim revenue for */
  asset: string
  /** Maximum LTV for the deposit tier */
  maxLtv: string
  /** Maximum borrow LTV for the deposit tier */
  maxBorrowLtv: string
  /** Optional callback on successful transaction */
  txSuccess?: () => void
}

/**
 * Hook to claim pending CDT revenue from Disco deposits.
 * 
 * Claims are not affected by emissions voting, so no sandwich logic is needed.
 * 
 * @example
 * ```typescript
 * const claim = useDiscoClaim({
 *   asset: 'factory/osmo.../CDT',
 *   maxLtv: '0.75',
 *   maxBorrowLtv: '0.70',
 *   txSuccess: () => console.log('Claim successful!'),
 * })
 * 
 * // Use with Ditto confirmation
 * openConfirmation(claim.action, <Details />, { label: 'Claim', actionType: 'withdraw' })
 * ```
 */
const useDiscoClaim = ({
  asset,
  maxLtv,
  maxBorrowLtv,
  txSuccess,
}: UseDiscoClaimParams) => {
  const { address } = useWallet()
  const discoContract = (contracts as any).ltv_disco

  type QueryData = { msgs: MsgExecuteContractEncodeObject[] | undefined }

  const { data: queryData } = useQuery<QueryData>({
    queryKey: ['disco_claim', 'msgs', address, asset, maxLtv, maxBorrowLtv],
    queryFn: () => {
      if (!address || !asset || !maxLtv || !maxBorrowLtv) {
        return { msgs: undefined }
      }
      if (!discoContract || discoContract === '') {
        return { msgs: undefined }
      }

      const msg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: discoContract,
          msg: toUtf8(JSON.stringify({
            claim: {
              asset,
              max_ltv: maxLtv,
              max_borrow_ltv: maxBorrowLtv,
            }
          })),
          funds: [],
        }),
      }

      return { msgs: [msg] }
    },
    enabled: !!address && !!asset && !!maxLtv && !!maxBorrowLtv,
  })

  const msgs = queryData?.msgs ?? []

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['disco_pending_claims'] })
    queryClient.invalidateQueries({ queryKey: ['disco_user_revenue'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    txSuccess?.()
  }

  const action = useSimulateAndBroadcast({
    msgs,
    queryKey: ['disco_claim_sim', (msgs?.toString() ?? '0')],
    enabled: !!msgs?.length,
    onSuccess,
  })

  return {
    action,
    msgs,
  }
}

export default useDiscoClaim


























