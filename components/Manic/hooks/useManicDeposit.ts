import { useQuery } from '@tanstack/react-query'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import type { EvmCall } from '@/services/chain/types'

/**
 * Parameters for depositing USDC to the looping vault
 */
interface UseManicDepositParams {
  /** Amount of USDC to deposit (human-readable) */
  amount: string
  /** Optional callback on successful transaction */
  txSuccess?: () => void
}

/**
 * TODO(evm-migration): the Manic / USDC-looping "Earn" vault does NOT exist in the Solidity
 * port — no earn (margin/looping) contract was ported. This hook returns no msgs so the
 * deposit CTA stays inert; the Manic UI it serves is slated for removal in the
 * component-layer wave. {action, msgs} shape and params preserved.
 */
const useManicDeposit = ({ amount, txSuccess }: UseManicDepositParams) => {
  const { address } = useWallet()

  const { data: queryMsgs } = useQuery<EvmCall[] | undefined>({
    queryKey: ['manic_deposit', 'msgs', address, amount],
    queryFn: () => [] as EvmCall[],
    enabled: !!address && !!amount,
  })

  const msgs = queryMsgs ?? []

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['usdc_looping_position'] })
    queryClient.invalidateQueries({ queryKey: ['transmuter_usdc_balance'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    txSuccess?.()
  }

  const action = useSimulateAndBroadcast({
    msgs,
    queryKey: ['manic_deposit_sim', msgs?.toString() ?? '0'],
    amount,
    enabled: !!msgs?.length,
    onSuccess,
  })

  return {
    action,
    msgs,
  }
}

export default useManicDeposit
