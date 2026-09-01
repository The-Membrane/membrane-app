import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useRouter } from 'next/router'

import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { queryClient } from '@/pages/_app'
import type { EvmCall } from '@/services/chain/types'

/**
 * RangeBound LP vault "manage" CTA (Cosmos `rangeboundLP.manage_vault`).
 *
 * TODO(evm-migration): the RangeBound LP vault has no ported Solidity contract (rangeboundLP
 * is absent from config/evm/contracts.ts). Msg building is stubbed until an RBLP-vault
 * service exists.
 */
const onInitialSuccess = () => {
  queryClient.invalidateQueries({ queryKey: ['balances'] })
}

const useBoundedManage = () => {
  const { address } = useWallet()
  const router = useRouter()

  const { data: queryData } = useQuery<{ msgs: EvmCall[] | undefined }>({
    queryKey: ['quick_action_LP_manage', address, router.pathname],
    queryFn: () => {
      // TODO(evm-migration): no RBLP manage_vault on EVM.
      return { msgs: undefined }
    },
    enabled: !!address,
  })

  const { msgs } = useMemo(() => queryData ?? { msgs: undefined }, [queryData])

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['quick_action_LP_manage_sim', (msgs?.toString() ?? '0')],
      onSuccess: onInitialSuccess,
      enabled: !!msgs,
    }),
    msgs,
  }
}

export default useBoundedManage
