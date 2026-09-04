import useSimulate from './useSimulate'
import useTransaction from './useTransaction'
import type { EvmCall } from '@/services/chain/types'

type SimulateAndBroadcast = {
  simulate: ReturnType<typeof useSimulate>
  tx: ReturnType<typeof useTransaction>
}

type Props = {
  msgs?: EvmCall[]
  queryKey?: string[]
  enabled?: boolean
  amount?: string
  onSuccess?: () => void
  /** legacy param, ignored — chain comes from the wagmi account context */
  chain_id?: string
  shrinkMessage?: boolean
  /** Rendered consequence for the success toast (e.g. "Debt $X→$Y · LTV A%→B%").
   *  Falls back to the generic 'Transaction Successful' when omitted. */
  successMessage?: JSX.Element | string
  /** Mutation-time batch rewrite (permit embedding) — see useTransaction. */
  prepareMsgs?: (msgs: EvmCall[]) => Promise<EvmCall[]>
}

const useSimulateAndBroadcast = ({
  msgs,
  queryKey,
  amount,
  onSuccess,
  enabled = false,
  shrinkMessage = false,
  successMessage,
  prepareMsgs,
}: Props): SimulateAndBroadcast => {
  const simulate = useSimulate({
    msgs,
    amount,
    queryKey,
    enabled,
  })

  const [fee] = simulate.data || []

  const tx = useTransaction({
    msgs,
    fee,
    onSuccess,
    shrinkMessage,
    successMessage,
    prepareMsgs,
  })

  return {
    simulate,
    tx,
  }
}

export default useSimulateAndBroadcast
