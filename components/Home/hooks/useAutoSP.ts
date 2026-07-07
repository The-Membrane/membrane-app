import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { queryClient } from '@/pages/_app'
import useQuickActionState from './useQuickActionState'
import type { EvmCall } from '@/services/chain/types'

/**
 * Auto Stability Pool enter/exit CTA.
 *
 * TODO(evm-migration): the AutoStabilityPool vault (Cosmos `contracts.autoStabilityPool`,
 * `enter_vault`/`exit_vault`) has no ported Solidity contract (absent from
 * config/evm/contracts.ts + contracts/abis). Deposit/withdraw msg building is stubbed
 * until an AutoStabilityPool.sol service exists.
 */
const useAutoSP = () => {
  const { address } = useWallet()
  const { quickActionState, setQuickActionState } = useQuickActionState()

  // Debounce the slider value to prevent too many queries
  const [debouncedValue, setDebouncedValue] = useState<{ withdraw: number; deposit: number }>({
    withdraw: 0,
    deposit: 0,
  })

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue({
        withdraw: quickActionState.autoSPwithdrawal,
        deposit: quickActionState.autoSPdeposit,
      })
    }, 300)
    return () => clearTimeout(timer)
  }, [quickActionState.autoSPwithdrawal, quickActionState.autoSPdeposit])

  const { data: queryData } = useQuery<{ msgs: EvmCall[] | undefined }>({
    queryKey: ['autoSP_msg_creation', address, debouncedValue],
    queryFn: () => {
      // TODO(evm-migration): no AutoStabilityPool contract on EVM (enter_vault/exit_vault).
      return { msgs: undefined }
    },
    enabled: !!address && (debouncedValue.withdraw !== 0 || debouncedValue.deposit !== 0),
  })

  const msgs = queryData?.msgs

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    setQuickActionState({ autoSPdeposit: 0, autoSPwithdrawal: 0 })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['home_page_autoSP', (msgs?.toString() ?? '0')],
      onSuccess: onInitialSuccess,
      enabled: !!msgs,
    }),
  }
}

export default useAutoSP
