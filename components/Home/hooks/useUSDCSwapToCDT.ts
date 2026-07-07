import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'

import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { queryClient } from '@/pages/_app'
import useQuickActionState from './useQuickActionState'
import type { EvmCall } from '@/services/chain/types'

/**
 * Swap USDC -> CDT (+ optional RangeBound LP enter).
 *
 * TODO(evm-migration): this is a multi-step DEX flow — the Cosmos version used the Osmosis
 * swap router (`swapToCDTMsg`) plus the RangeBound LP `enter_vault`. There is no EVM swap
 * router in this codebase (EvmCall[] is non-atomic; see services/chain/types.ts) and no
 * RBLP vault contract on EVM. Msg building is stubbed until a router/vault service exists.
 */
const useSwapToCDT = ({ onSuccess }: { onSuccess: () => void; run: boolean }) => {
  const { address } = useWallet()
  const { quickActionState } = useQuickActionState()

  const { data: queryData } = useQuery<{ msgs: EvmCall[] | undefined; tokenOutMinAmount: number }>({
    queryKey: ['home_page_swap', address, quickActionState?.usdcSwapToCDT],
    queryFn: () => {
      // TODO(evm-migration): no EVM swap router / RBLP vault.
      return { msgs: undefined, tokenOutMinAmount: 0 }
    },
    enabled: !!address,
  })

  const msgs = queryData?.msgs
  const tokenOutMinAmount = queryData?.tokenOutMinAmount ?? 0

  const onInitialSuccess = () => {
    onSuccess()
    queryClient.invalidateQueries({ queryKey: ['balances'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['home_page_swap_sim', (msgs?.toString() ?? '0')],
      onSuccess: onInitialSuccess,
      enabled: false,
    }),
    tokenOutMinAmount,
  }
}

export default useSwapToCDT
