import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/router'

import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { queryClient } from '@/pages/_app'
import type { EvmCall } from '@/services/chain/types'

/**
 * Fulfils outstanding RangeBound LP purchase intents (Cosmos
 * `rangeboundLP.ful_fill_user_intents`).
 *
 * TODO(evm-migration): the RangeBound LP vault and its intent-fulfilment API have no ported
 * Solidity contract (rangeboundLP is absent from config/evm/contracts.ts). Msg building is
 * stubbed until an RBLP-vault service exists.
 */
const onInitialSuccess = () => {
  queryClient.invalidateQueries({ queryKey: ['balances'] })
  queryClient.invalidateQueries({ queryKey: ['positions'] })
}

const useFulfillIntents = ({ run, skipIDs }: { run: boolean; skipIDs: number[] }) => {
  const { address } = useWallet()
  const router = useRouter()

  const { data: queryData } = useQuery<{ msgs: EvmCall[] | undefined }>({
    queryKey: ['fillIntents_msg_creator', run, skipIDs, router.pathname],
    queryFn: async () => {
      // TODO(evm-migration): no RBLP ful_fill_user_intents on EVM.
      return { msgs: undefined }
    },
    enabled: !!address,
  })

  const msgs = queryData?.msgs

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['dashboard_fulfillment', (msgs?.toString() ?? '0')],
      onSuccess: onInitialSuccess,
      enabled: !!msgs,
    }),
  }
}

export default useFulfillIntents
