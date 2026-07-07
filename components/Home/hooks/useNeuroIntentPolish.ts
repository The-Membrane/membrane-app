import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'

import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { queryClient } from '@/pages/_app'
import useToaster from '@/hooks/useToaster'
import type { EvmCall } from '@/services/chain/types'

/**
 * Cleans up RangeBound LP vault purchase-intent yield splits (Cosmos
 * `rangeboundLP.set_user_intents`).
 *
 * TODO(evm-migration): the RangeBound LP vault and its `set_user_intents` API have no
 * ported Solidity contract (rangeboundLP is absent from config/evm/contracts.ts). Msg
 * building is stubbed until an RBLP-vault service exists.
 */
const useNeuroIntentPolish = () => {
  const { address } = useWallet()
  const toaster = useToaster()

  const { data: queryData } = useQuery<{ msgs: EvmCall[] | undefined }>({
    queryKey: ['neuro_intent_polish', address],
    queryFn: () => {
      // TODO(evm-migration): no RBLP set_user_intents on EVM.
      return { msgs: undefined }
    },
    enabled: !!address,
  })

  const msgs = queryData?.msgs

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    toaster.dismiss()
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['home_page_intent_polish', (msgs?.toString() ?? '0')],
      onSuccess: onInitialSuccess,
      enabled: !!msgs,
    }),
  }
}

export default useNeuroIntentPolish
