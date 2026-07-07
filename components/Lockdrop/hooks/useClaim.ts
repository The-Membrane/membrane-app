import useWallet from '@/hooks/useWallet'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { useMemo } from 'react'
import type { EvmCall } from '@/services/chain/types'

/**
 * TODO(evm-migration): the Cosmos lockdrop does NOT exist in the Solidity port — Acquisition
 * replaces the launch/lockdrop mechanics, so there is no lockdrop `claim` to map. This hook
 * returns no msgs so the lockdrop-claim CTA stays inert; the lockdrop UI it serves is slated
 * for removal in the component-layer wave. {action, msgs} shape preserved.
 */
export const useClaim = () => {
  const { address } = useWallet()

  const { data: queryData } = useQuery<EvmCall[] | undefined>({
    queryKey: ['msg_lockdrop_claims', address],
    queryFn: () => [] as EvmCall[],
    enabled: !!address,
  })

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['staked'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    queryClient.invalidateQueries({ queryKey: ['lockdrop'] })
  }

  const msgs: EvmCall[] | undefined = useMemo(() => queryData, [queryData])

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['lockdrop_claim', msgs?.toString() ?? '0'],
      enabled: !!msgs,
      onSuccess,
    }),
    msgs,
  }
}

export default useClaim
