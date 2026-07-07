import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { queryClient } from '@/pages/_app'
import type { EvmCall } from '@/services/chain/types'

/**
 * Unwind (deleverage) a looped position by repeatedly repaying + withdrawing + swapping.
 *
 * TODO(evm-migration): multi-step deleverage flow. The Cosmos version used `unloopPosition`
 * from services/osmosis, which chains repay + withdraw + Osmosis-router swap. On EVM there
 * is no swap router and an EvmCall[] of length > 1 is NOT atomic (services/chain/types.ts),
 * so the loop cannot be reproduced. It also depends on `useBasket` and `useOraclePrice`
 * (both stubbed) and on the CosmWasm BasketPositions shape (useUserPositions now returns the
 * flat EvmUserPosition[]). Msg building is stubbed until a router/multicall exists.
 */
const useUnLoop = (_positionIndex: number, desiredWithdrawal?: number) => {
  const { address } = useWallet()

  const { data: queryData } = useQuery<{
    msgs: EvmCall[] | undefined
    newPositionValue: number
    newLTV: number
  }>({
    queryKey: ['quick action unloop', address, desiredWithdrawal],
    queryFn: () => {
      // TODO(evm-migration): no EVM deleverage router; basket/price data stubbed.
      return { msgs: undefined, newPositionValue: 0, newLTV: 0 }
    },
    enabled: !!address,
  })

  const { msgs, newPositionValue, newLTV } = useMemo(
    () => queryData ?? { msgs: undefined, newPositionValue: 0, newLTV: 0 },
    [queryData],
  )

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['quick action loops', (msgs?.toString() ?? '0')],
      onSuccess,
    }),
    newPositionValue,
    newLTV,
  }
}

export default useUnLoop
