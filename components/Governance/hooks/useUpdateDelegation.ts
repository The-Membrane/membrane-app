import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { queryClient } from '@/pages/_app'
import useDelegateState from './useDelegateState'

/**
 * Stake delegation update.
 *
 * TODO(evm-migration): delegation has no equivalent in Governance.sol — it is a
 * Staking-organ feature (the Cosmos hook built its message via
 * services/staking `buildUpdateDelegationMsg`). Reimplement onto the EVM staking
 * write service when the Staking domain is migrated. Stubbed to an empty
 * (disabled) pipeline so the {simulate, tx} shape ConfirmModal consumes is
 * preserved without faking a governance mapping.
 */
const useUpdateDelegation = () => {
  // Kept so the delegate UI state wiring stays intact for the eventual re-impl.
  useDelegateState()

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['delegations'] })
    queryClient.invalidateQueries({ queryKey: ['delegator'] })
  }

  return useSimulateAndBroadcast({
    msgs: undefined,
    queryKey: ['update delegation sim'],
    enabled: false,
    onSuccess,
  })
}

export default useUpdateDelegation
