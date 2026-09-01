import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/router'

import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { queryClient } from '@/pages/_app'
import type { EvmCall } from '@/services/chain/types'

/**
 * Allocates RangeBound LP points to users whose conversion rate has advanced (Cosmos points
 * `give_points { rangebound_user }`).
 *
 * TODO(evm-migration): the points `give_points` rangebound API has no ported Solidity
 * equivalent (PointsSystem.sol exposes awardActionPoints/awardManagementPoints only) and the
 * RangeBound LP vault it references is not deployed on EVM. Msg building is stubbed.
 */
const onInitialSuccess = () => {
  queryClient.invalidateQueries({ queryKey: ['dashboard_rblp_give_points'] })
}

const useGiveRBLPPoints = () => {
  const { address } = useWallet()
  const router = useRouter()

  const { data: queryData } = useQuery<{ msgs: EvmCall[] | undefined }>({
    queryKey: ['rblp_points_allocation_msg_creator', router.pathname],
    queryFn: async () => {
      // TODO(evm-migration): no rangebound give_points on EVM.
      return { msgs: undefined }
    },
    enabled: !!address,
  })

  const msgs = queryData?.msgs

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['dashboard_rblp_give_points', (msgs?.toString() ?? '0')],
      onSuccess: onInitialSuccess,
      enabled: !!msgs,
    }),
  }
}

export default useGiveRBLPPoints
