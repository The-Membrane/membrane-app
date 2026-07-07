import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'

import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useToaster from '@/hooks/useToaster'
import type { EvmCall } from '@/services/chain/types'

/**
 * Sets up the user's RangeBound LP points-claim conversion rate (Cosmos points
 * `check_claims { rangebound_user }`).
 *
 * TODO(evm-migration): the points `check_claims` rangebound API has no ported Solidity
 * equivalent (PointsSystem.sol exposes awardActionPoints/awardManagementPoints only), and
 * the RangeBound LP vault it references is not deployed on EVM. Msg building is stubbed.
 */
const useSetUserRBClaims = () => {
  const { address } = useWallet()
  const toaster = useToaster()

  const { data: queryData } = useQuery<{ msgs: EvmCall[] | undefined }>({
    queryKey: ['toaster_set_RB_claim_msg_creator', address],
    queryFn: async () => {
      // TODO(evm-migration): no rangebound points check_claims on EVM.
      return { msgs: undefined }
    },
    enabled: !!address,
  })

  const msgs = queryData?.msgs

  const onInitialSuccess = () => {
    toaster.dismiss()
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['toaster_set_RB_claim_sim', (msgs?.toString() ?? '0')],
      onSuccess: onInitialSuccess,
      enabled: !!msgs,
    }),
  }
}

export default useSetUserRBClaims
