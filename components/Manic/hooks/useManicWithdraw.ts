import { useQuery } from '@tanstack/react-query'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import type { EvmCall } from '@/services/chain/types'

/**
 * Parameters for withdrawing from the looping vault
 */
interface UseManicWithdrawParams {
  /** Amount of collateral to withdraw (human-readable). */
  amount?: string
  /** If true, exits the vault completely */
  exitFully?: boolean
  /** Optional callback on successful transaction */
  txSuccess?: () => void
}

/**
 * TODO(evm-migration): the Manic / USDC-looping "Earn" vault does NOT exist in the Solidity
 * port — no earn (margin/looping) contract was ported, so there is no exitVault/unloopCDP
 * to map. This hook returns no msgs so the withdraw CTA stays inert; the Manic UI it serves
 * is slated for removal in the component-layer wave. {action, msgs} shape and params
 * preserved.
 */
const useManicWithdraw = ({ amount, exitFully = false, txSuccess }: UseManicWithdrawParams) => {
  const { address } = useWallet()

  const { data: queryMsgs } = useQuery<EvmCall[] | undefined>({
    queryKey: ['manic_withdraw', 'msgs', address, amount, exitFully],
    queryFn: () => [] as EvmCall[],
    enabled: !!address && (!!amount || exitFully),
  })

  const msgs = queryMsgs ?? []

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['usdc_looping_position'] })
    queryClient.invalidateQueries({ queryKey: ['transmuter_usdc_balance'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['basket'] })
    txSuccess?.()
  }

  const action = useSimulateAndBroadcast({
    msgs,
    queryKey: ['manic_withdraw_sim', msgs?.toString() ?? '0'],
    enabled: !!msgs?.length,
    onSuccess,
  })

  return {
    action,
    msgs,
  }
}

export default useManicWithdraw
