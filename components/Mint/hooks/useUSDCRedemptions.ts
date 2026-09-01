import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import type { EvmCall } from '@/services/chain/types'

/**
 * TODO(evm-migration): the CosmWasm "productized redemptions" flow (deposit Mars USDC +
 * edit_redeemability premium) has NO ported Solidity surface — Cdp.sol exposes no
 * redeemability entrypoint or view (see the getUserRedemptionInfo stub in
 * services/chain/cdp.ts). Gutted to a no-op that emits no msgs so the export keeps
 * compiling; re-implement if/when redemption lands in the port.
 */
const msgs: EvmCall[] = []

const useUSDCRedemptions = ({ onSuccess }: { onSuccess: () => void; run: boolean }) => {
  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['USDC_redemption_sim', 'evm-stub'],
      onSuccess: () => {
        onSuccess()
      },
      enabled: false,
    }),
  }
}

export default useUSDCRedemptions
