import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import type { EvmCall } from '@/services/chain/types'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import useEarnState from './useEarnState'

/**
 * "Redeem CDT for collateral at a premium" CTA.
 *
 * TODO(evm-migration): the Cosmos flow was PositionsMsgComposer.redeemCollateral + a follow-up
 * marsUSDCvault exit_vault. The port has NO redemption surface:
 *   - Cdp.sol exposes no redeemCollateral / redeemability view (see services/chain/cdp.ts
 *     getUserRedemptionInfo — also a stub).
 *   - The Transmuter's user-facing swap is paired→CDT (`transmute(cdtIn=false)`); the reverse
 *     CDT→paired direction is restricted to the CDP/self (CdtToPairedRestricted in Transmuter.sol),
 *     so there is no user-callable "redeem CDT" path.
 * Msgs are stubbed to undefined until redemption is ported; the CTA stays disabled (enabled: !!msgs).
 */
const useCDPRedeem = () => {
  const { address } = useWallet()
  const { earnState } = useEarnState()

  const { data: queryData } = useQuery<{ msgs: EvmCall[] | undefined }>({
    queryKey: ['earn_page_management_redeem_msg_creation', address, earnState.redeemAmount],
    queryFn: () => {
      if (!address || !earnState.redeemAmount) return { msgs: undefined }
      // TODO(evm-migration): no user-facing CDT redemption exists in the port (see doc above).
      return { msgs: undefined }
    },
    enabled: !!address,
  })

  const { msgs } = useMemo(() => queryData ?? { msgs: undefined }, [queryData])

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['useVaultInfo'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['earn_page_management_redeem', (msgs?.toString() ?? '0')],
      onSuccess: onInitialSuccess,
      enabled: !!msgs,
    }),
  }
}

export default useCDPRedeem
