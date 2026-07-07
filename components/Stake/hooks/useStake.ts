import { erc20Abi, zeroAddress } from 'viem'
import { stakingAbi } from '@/contracts/abis/staking'
import { getContractAddress } from '@/config/evm/contracts'
import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import type { EvmCall } from '@/services/chain/types'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import useStakeState from './useStakeState'

type UseStake = {}

/** Zero lock — a plain (non-locked) stake. Mirrors Staking.sol `Lock` default. */
const NO_LOCK = {
  lockedUntil: 0n,
  perpetualLockDays: 0n,
  intendedLockDays: 0n,
  isLocked: false,
} as const

const useStakeing = ({ }: UseStake) => {
  const { address, chain } = useWallet()
  const mbrnAsset = useAssetBySymbol('MBRN')
  const { stakeState } = useStakeState()
  const { amount, txType } = stakeState

  const stakingAddr = chain ? getContractAddress(chain.id, 'staking') : undefined
  const mbrnAddr = chain ? getContractAddress(chain.id, 'mbrn') : undefined

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: ['staking', 'msg', address, stakingAddr, mbrnAddr, amount, txType],
    queryFn: () => {
      if (!address || !mbrnAsset || !stakingAddr) return undefined
      const microAmount = BigInt(shiftDigits(amount, mbrnAsset.decimal).dp(0).toString())
      if (microAmount <= 0n) return undefined

      if (txType === 'Stake') {
        if (!mbrnAddr) return undefined
        // ERC-20 pattern: approve then stake. NOT atomic — two wallet signatures
        // (see services/chain/types.ts). Staking.sol.stake pulls MBRN via transferFrom.
        return [
          {
            address: mbrnAddr,
            abi: erc20Abi,
            functionName: 'approve',
            args: [stakingAddr, microAmount],
          },
          {
            address: stakingAddr,
            abi: stakingAbi,
            functionName: 'stake',
            // stake(target, amount, lockOpt) — zero target ⇒ msg.sender
            args: [zeroAddress, microAmount, NO_LOCK],
          },
        ]
      }

      if (txType === 'Unstake') {
        return [
          {
            address: stakingAddr,
            abi: stakingAbi,
            functionName: 'unstake',
            // unstake(mbrnAmount, hasActiveGovernanceLock). false: governance-lock
            // gating (emissions-voting sandwich) is handled elsewhere; a live lock
            // surfaces as a GovernanceLockActive revert in simulation.
            args: [microAmount, false],
          },
        ]
      }

      return undefined
    },
    enabled: !!address && !!mbrnAsset && !!stakingAddr,
  })

  const finalMsgs = useMemo(() => msgs, [msgs])

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['staked'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs: finalMsgs,
      queryKey: ['manage_staking', address ?? '', amount, txType ?? ''],
      amount,
      onSuccess: onInitialSuccess,
      enabled: !!finalMsgs?.length,
    }),
  }
}

export default useStakeing
