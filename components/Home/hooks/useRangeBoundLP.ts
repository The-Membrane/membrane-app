import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'

import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { queryClient } from '@/pages/_app'
import useQuickActionState from './useQuickActionState'
import type { EvmCall } from '@/services/chain/types'

/**
 * Range-Bound LP vault enter/exit CTA (+ points check_claims).
 *
 * TODO(evm-migration): the RangeBound LP vault (Cosmos `contracts.rangeboundLP`,
 * `enter_vault`/`exit_vault`) and the points `check_claims` flow have no ported Solidity
 * contracts (rangeboundLP is absent from config/evm/contracts.ts; PointsSystem.sol exposes
 * awardActionPoints/awardManagementPoints, not the rangebound check_claims API). All msg
 * building is stubbed until an RBLP-vault service exists.
 */
const useBoundedLP = ({
  onSuccess,
}: { onSuccess?: () => void; run?: boolean; swapToCDT?: boolean } = {}) => {
  const { address } = useWallet()
  const { quickActionState, setQuickActionState } = useQuickActionState()

  const { data: queryData } = useQuery<{ msgs: EvmCall[] | undefined }>({
    queryKey: [
      'bounded_msg_creation',
      address,
      quickActionState.rangeBoundLPwithdrawal,
      quickActionState.rangeBoundLPdeposit,
    ],
    queryFn: () => {
      // TODO(evm-migration): no RangeBound LP vault contract on EVM.
      return { msgs: undefined }
    },
    enabled: !!address,
  })

  const msgs = queryData?.msgs

  const onInitialSuccess = () => {
    if (onSuccess) onSuccess()
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    setQuickActionState({ rangeBoundLPdeposit: 0, rangeBoundLPwithdrawal: 0 })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['home_page_bounded', (msgs?.toString() ?? '0')],
      onSuccess: onInitialSuccess,
      enabled: false,
    }),
  }
}

export default useBoundedLP
