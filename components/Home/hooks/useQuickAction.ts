import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { queryClient } from '@/pages/_app'
import useQuickActionState from './useQuickActionState'
import type { EvmCall } from '@/services/chain/types'

/**
 * Leverage quick-action: deposit collateral to a new position then loop (mint + swap +
 * re-deposit) up to a target LTV.
 *
 * TODO(evm-migration): this is a multi-step loop flow. The Cosmos version composed CDP
 * deposit msgs (`getDepostAndWithdrawMsgs`) with `loopPosition` from services/osmosis, which
 * chains mint + Osmosis-router swap + re-deposit. On EVM there is no swap router and an
 * EvmCall[] of length > 1 is NOT atomic (services/chain/types.ts), so the loop cannot be
 * reproduced. It also depends on `useBasket` (current_position_id) and `useOraclePrice`
 * (denom-keyed), both of which are stubbed in the migrated data layer. Msg building is
 * stubbed until a router/multicall + basket views exist.
 */
const useQuickAction = ({ borrowLTV }: { borrowLTV: number }) => {
  useQuickActionState()
  const { address } = useWallet()

  const positionId = ''

  const { data: queryData } = useQuery<{
    msgs: EvmCall[] | undefined
    loop_msgs: EvmCall[] | undefined
    newPositionValue: number
    summary: any[]
  }>({
    queryKey: ['quick action widget', address, borrowLTV],
    queryFn: () => {
      // TODO(evm-migration): no EVM loop router; useBasket/useOraclePrice are stubbed.
      return { msgs: undefined, loop_msgs: undefined, newPositionValue: 0, summary: [] }
    },
    enabled: !!address,
  })

  const { msgs, loop_msgs, newPositionValue, summary } = useMemo(
    () =>
      queryData ?? { msgs: undefined, loop_msgs: undefined, newPositionValue: 0, summary: [] },
    [queryData],
  )

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
  }

  const loop = useSimulateAndBroadcast({
    msgs: loop_msgs,
    queryKey: ['quick action loop', (loop_msgs?.toString() ?? '0')],
  })

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['quick action lev', (msgs?.toString() ?? '0')],
      onSuccess: onInitialSuccess,
    }),
    loop,
    newPositionValue,
    positionId,
    summary,
  }
}

export default useQuickAction
