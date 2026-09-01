import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import type { EvmCall } from '@/services/chain/types'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import useEarnState from './useEarnState'

/**
 * Earn "loop" (leverage-up the vault CDP) CTA.
 *
 * TODO(evm-migration): the Cosmos flow was a single atomic EarnMsgComposer.loopCDP({ max_mint_amount })
 * against the Earn contract. The port has NO Earn/loop contract and NO multi-step router/multicall
 * (an EvmCall[] of length > 1 is not atomic — see services/chain/types.ts). A loop is a
 * borrow→swap→re-deposit cycle that must run atomically, so it needs a dedicated router contract
 * that does not exist yet. Msgs are stubbed to undefined until that router lands; the CTA stays
 * disabled (enabled: !!msgs).
 */
const onInitialSuccess = () => {
  queryClient.invalidateQueries({ queryKey: ['useVaultInfo'] })
  queryClient.invalidateQueries({ queryKey: ['earn_page_management_loop_sim'] })
}

const useEarnLoop = () => {
  const { address } = useWallet()
  const { earnState } = useEarnState()

  const { data: queryData } = useQuery<{ msgs: EvmCall[] | undefined }>({
    queryKey: ['earn_page_management_loop_msg_creation', address, earnState.loopMax],
    queryFn: () => {
      if (!address) return { msgs: undefined }
      // TODO(evm-migration): build the atomic loop once an EVM router/multicall exists.
      // No enterVault/borrow composition here — a non-atomic EvmCall[] would half-execute
      // and leave the position unbalanced.
      return { msgs: undefined }
    },
    enabled: !!address,
  })

  const { msgs } = useMemo(() => queryData ?? { msgs: undefined }, [queryData])

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['earn_page_management_loop_sim', (msgs?.toString() ?? '0')],
      onSuccess: onInitialSuccess,
      enabled: !!msgs,
    }),
  }
}

export default useEarnLoop
