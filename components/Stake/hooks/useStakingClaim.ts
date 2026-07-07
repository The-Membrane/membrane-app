import { zeroAddress } from 'viem'
import { stakingAbi } from '@/contracts/abis/staking'
import { getContractAddress } from '@/config/evm/contracts'
import useWallet from '@/hooks/useWallet'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import type { EvmCall } from '@/services/chain/types'
import { useRouter } from 'next/router'

/**
 * Claim staking rewards. EVM rewire: Staking.sol `claimRewards(denom, sendTo)` is
 * per-fee-denom, so we emit one call per configured reward denom (MBRN + CDT). This is
 * NOT atomic — one wallet signature per denom (see services/chain/types.ts).
 *
 * NOTE: the legacy `restake` flag (claim-and-restake rewards) has no EVM equivalent —
 * Staking.sol.claimRewards has no restake option. The flag is accepted for call-site
 * compatibility but does not change the emitted calls.
 */
export const useStakingClaim = (
  restake: boolean = false,
  sim: boolean = true,
  run: boolean = true,
) => {
  const { address, chain } = useWallet()
  const router = useRouter()

  const stakingAddr = chain ? getContractAddress(chain.id, 'staking') : undefined
  const mbrnAddr = chain ? getContractAddress(chain.id, 'mbrn') : undefined
  const cdtAddr = chain ? getContractAddress(chain.id, 'cdt') : undefined

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: ['staking', 'claims_msg', address, stakingAddr, mbrnAddr, cdtAddr, run, router.pathname],
    queryFn: () => {
      if (router.pathname != '/stake' && !run) return undefined
      if (!address || !stakingAddr) return undefined

      const denoms = [mbrnAddr, cdtAddr].filter((d): d is `0x${string}` => !!d)
      if (denoms.length === 0) return undefined

      // sendTo = zero ⇒ msg.sender
      return denoms.map((denom) => ({
        address: stakingAddr,
        abi: stakingAbi,
        functionName: 'claimRewards',
        args: [denom, zeroAddress],
      }))
    },
    enabled: !!address && !!stakingAddr,
  })

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['staked'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['staking_claim', address ?? '', String(restake)],
      enabled: sim && !!msgs?.length,
      onSuccess,
    }),
    msgs,
  }
}

export default useStakingClaim
