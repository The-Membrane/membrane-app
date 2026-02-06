import { useQuery } from '@tanstack/react-query'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from '@cosmjs/encoding'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import contracts from '@/config/contracts.json'
import type { MbrnClaimIntent } from '@/types/lockdropIntents'

/**
 * Parameters for claiming MBRN allocation from lockdrop
 */
interface UseTransLockdropClaimParams {
  /** Optional MBRN claim intent configuration */
  mbrnIntent?: MbrnClaimIntent
  /** Optional callback on successful transaction */
  txSuccess?: () => void
}

/**
 * Hook to claim MBRN allocation from the transmuter lockdrop.
 * 
 * @example
 * ```typescript
 * const claim = useTransLockdropClaim({
 *   txSuccess: () => console.log('Claim successful!'),
 * })
 * 
 * // Use with Ditto confirmation
 * openConfirmation(claim.action, <Details />, { label: 'Claim', actionType: 'withdraw' })
 * ```
 */
const useTransLockdropClaim = ({
  mbrnIntent,
  txSuccess,
}: UseTransLockdropClaimParams = {}) => {
  const { address } = useWallet()
  const lockdropContract = (contracts as any).transmuter_lockdrop

  type QueryData = { msgs: MsgExecuteContractEncodeObject[] | undefined }

  const { data: queryData } = useQuery<QueryData>({
    queryKey: ['trans_lockdrop_claim', 'msgs', address, JSON.stringify(mbrnIntent)],
    queryFn: () => {
      if (!address) {
        return { msgs: undefined }
      }
      if (!lockdropContract || lockdropContract === '') {
        return { msgs: undefined }
      }

      // Build claim message with users array and optional mbrn_intent
      const claimMsg: any = {
        users: [address], // User claims for themselves
      }
      if (mbrnIntent) {
        claimMsg.mbrn_intent = mbrnIntent
      }

      const msg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: lockdropContract,
          msg: toUtf8(JSON.stringify({ claim: claimMsg })),
          funds: [],
        }),
      }

      return { msgs: [msg] }
    },
    enabled: !!address,
  })

  const msgs = queryData?.msgs ?? []

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['transmuter_lockdrop_user'] })
    queryClient.invalidateQueries({ queryKey: ['user_lockdrop_intents'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    txSuccess?.()
  }

  const action = useSimulateAndBroadcast({
    msgs,
    queryKey: ['trans_lockdrop_claim_sim', (msgs?.toString() ?? '0')],
    enabled: !!msgs?.length,
    onSuccess,
  })

  return {
    action,
    msgs,
  }
}

export default useTransLockdropClaim






