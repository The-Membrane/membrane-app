import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { queryClient } from '@/pages/_app'
import useQuickActionState from './useQuickActionState'
import type { EvmCall } from '@/services/chain/types'

/**
 * Buy CDT then redeem collateral at a discount, then withdraw the redeemed vault token.
 *
 * TODO(evm-migration): multi-step flow with no EVM equivalent — it chained the Osmosis swap
 * router (`swapToCDTMsg`), the CDP `redeem_collateral` message, and a marsUSDC vault
 * `exit_vault`. Cdp.sol has no ported redemption surface (services/chain/cdp.ts
 * getUserRedemptionInfo is a stub), there is no EVM swap router, and the marsUSDC vault is
 * not deployed on EVM. Msg building is stubbed until those land.
 */
const useBuyAndRedeem = () => {
  const { address } = useWallet()
  const { quickActionState } = useQuickActionState()

  const { data: queryData } = useQuery<{ msgs: EvmCall[] | undefined }>({
    queryKey: ['home_page_swap_and_redeem_msg_creation', address, quickActionState.redeemSwapAmount],
    queryFn: () => {
      // TODO(evm-migration): no EVM swap router / CDP redemption / marsUSDC vault.
      return { msgs: undefined }
    },
    enabled: !!address,
  })

  const { msgs } = useMemo(() => queryData ?? { msgs: undefined }, [queryData])

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['home_page_swap_and_redeem_sim', (msgs?.toString() ?? '0')],
      onSuccess: onInitialSuccess,
      enabled: !!msgs,
    }),
  }
}

export default useBuyAndRedeem
