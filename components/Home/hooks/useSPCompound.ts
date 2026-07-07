import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { queryClient } from '@/pages/_app'
import type { EvmCall } from '@/services/chain/types'

/**
 * Auto Stability Pool "compound" CTA.
 *
 * TODO(evm-migration): the AutoStabilityPool vault (Cosmos `contracts.autoStabilityPool`)
 * has no ported Solidity contract — it is absent from config/evm/contracts.ts and has no
 * ABI in contracts/abis. `compound {}` therefore has no EVM call target. Msg building is
 * stubbed (returns undefined) until an AutoStabilityPool.sol service exists.
 */
const useSPCompound = () => {
  const { address } = useWallet()

  const { data: queryData } = useQuery<{ msgs: EvmCall[] | undefined }>({
    queryKey: ['quick_action_SP_compound', address],
    queryFn: () => {
      // TODO(evm-migration): no AutoStabilityPool contract on EVM.
      return { msgs: undefined }
    },
    enabled: !!address,
  })

  const { msgs } = useMemo(() => queryData ?? { msgs: undefined }, [queryData])

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['balances'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['quick_action_SP_compound_sim', (msgs?.toString() ?? '0')],
      onSuccess: onInitialSuccess,
      enabled: !!msgs,
    }),
  }
}

export default useSPCompound
