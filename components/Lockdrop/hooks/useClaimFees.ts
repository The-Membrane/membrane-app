import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import type { EvmCall } from '@/services/chain/types'

/**
 * TODO(evm-migration): the Cosmos lockdrop / vesting fee-claim flow does not exist in the
 * Solidity port — Acquisition replaces launch mechanics, and Vesting.sol has no
 * recipient/contract fee-claim wired into this UI. Honest stub: emits no calls and never
 * simulates. Kept so the Lockdrop component (TokenAllocation.tsx) keeps compiling. The
 * one live vesting claim (Vesting.sol withdrawUnlocked) is surfaced through the
 * protocol-claims aggregator (components/Nav/hooks/useClaims.ts), not here.
 */
const useClaimFees = (_run: boolean = true) => {
  const msgs: EvmCall[] | undefined = undefined

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['vesting_fee_claim_stub'],
      enabled: false,
    }),
    msgs,
  }
}

export default useClaimFees
