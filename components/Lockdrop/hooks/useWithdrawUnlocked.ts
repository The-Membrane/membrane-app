import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { getContractAddress } from '@/config/evm/contracts'
import { vestingAbi } from '@/contracts/abis/vesting'
import type { EvmCall } from '@/services/chain/types'

/**
 * Vesting.withdrawUnlocked() — REAL mapping (NOT a stub).
 *
 * The Lockdrop "Token Allocation" panel withdraws unlocked MBRN from Vesting.sol, which
 * DOES exist in the Solidity port (contracts/abis/vesting.ts). This mirrors how
 * components/Nav/hooks/useClaims.ts reads unlockedFor(user, now) and emits
 * withdrawUnlocked(). Here we gate only on address (per spec) and let simulation surface a
 * `NothingUnlocked` revert when there is nothing to withdraw.
 *
 * Return shape is the tx mutation (isPending / mutate) so the existing consumer
 * (components/Lockdrop/TokenAllocation.tsx) keeps compiling unchanged.
 */
const useWithdrawUnlocked = () => {
  const { address, chain } = useWallet()
  const vestingAddr = chain ? getContractAddress(chain.id, 'vesting') : undefined

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: ['msg_vesting_withdraw_unlocked', address, vestingAddr],
    queryFn: () => {
      if (!address || !vestingAddr) return undefined
      return [
        {
          address: vestingAddr,
          abi: vestingAbi,
          functionName: 'withdrawUnlocked',
          args: [],
        },
      ]
    },
    enabled: !!address && !!vestingAddr,
  })

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['allocations'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
  }

  const { tx } = useSimulateAndBroadcast({
    msgs,
    queryKey: ['vesting_withdraw_unlocked_sim', msgs?.toString() ?? '0'],
    enabled: !!msgs?.length,
    onSuccess,
  })

  return tx
}

export default useWithdrawUnlocked
