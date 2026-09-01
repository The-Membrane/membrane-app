import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import useClaimLiquidation from '@/components/Bid/hooks/useClaimLiquidation'
import { useStakingClaim } from '@/components/Stake/hooks/useStakingClaim'
import useStaked from '@/components/Stake/hooks/useStaked'
import { getTimeLeft } from '@/components/Stake/unstakingUtils'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useMemo } from 'react'
import { num } from '@/helpers/num'
import { Coin } from '@cosmjs/stargate'
import { claimstoCoins } from '@/services/liquidation'
import useClaimUnstake from '@/components/Stake/hooks/useClaimUnstake'
import { useCheckClaims } from '@/hooks/useLiquidations'
import type { EvmCall } from '@/services/chain/types'
import { getPublicClient } from '@/services/chain/client'
import { getContractAddress } from '@/config/evm/contracts'
import { vestingAbi } from '@/contracts/abis/vesting'

/**
 * Protocol-wide claims aggregator — EVM rewire.
 *
 * The tx currency is now EvmCall[] (services/chain/types.ts); each entry is a separate
 * wallet signature, NOT an atomic multi-msg tx. Contributions:
 *   - Liquidation: from useCheckClaims (EVM) + useClaimLiquidation (Bid, migrated).
 *   - Staking: reward claim (Staking.claimRewards) + matured-unstake withdrawal
 *     (Staking.withdrawMatured), from the migrated Stake hooks.
 *   - Vesting: Vesting.sol withdrawUnlocked(), gated on unlockedFor(user, now) > 0.
 *   - SP unstaking + Lockdrop: empty — no stability pool and no Cosmos lockdrop in the
 *     Solidity port (Acquisition replaces launch mechanics). See TODOs below.
 *
 * NOTE on staking rewards: Staking.sol has no pending-rewards view (getUserRewards is a
 * null-stub, useStaked returns rewards: []), so reward amounts can't be shown or gated on
 * an amount. The claim call is emitted whenever the user has an active stake; simulation
 * drops it if there is nothing to claim.
 */

type ClaimsSummary = {
  liquidation: Coin[]
  sp_unstaking: Coin[]
  staking: Coin[]
  vesting: Coin[]
}

type QueryData = {
  msgs: EvmCall[] | undefined
  claims: ClaimsSummary
}

const emptySummary = (): ClaimsSummary => ({
  liquidation: [],
  sp_unstaking: [],
  staking: [],
  vesting: [],
})

const onSuccess = () => {
  queryClient.invalidateQueries({ queryKey: ['protocol_claim_sim'] })
  queryClient.invalidateQueries({ queryKey: ['msg_all_protocol_claims'] })
  queryClient.invalidateQueries({ queryKey: ['liquidation claims'] })
  queryClient.invalidateQueries({ queryKey: ['staked'] })
  queryClient.invalidateQueries({ queryKey: ['balances'] })
}

const useProtocolClaims = ({ run }: { run: boolean }) => {
  const { address, chain } = useWallet()

  // Liquidations
  const { data: claims } = useCheckClaims(run)
  const claimLiq = useClaimLiquidation(claims, undefined, run)

  // Staking
  const { data: stakeData } = useStaked(run)
  const { staked = 0, unstaking = [] } = stakeData || {}
  const stakingClaim = useStakingClaim(false, false, run)
  const unstakeClaim = useClaimUnstake({ address: address, sim: false, run: run })
  const mbrnAsset = useAssetBySymbol('MBRN')

  const ClaimMsgs = useMemo(() => claimLiq.msgs, [claimLiq.msgs])
  const StakingMsgs = useMemo(() => stakingClaim.msgs, [stakingClaim.msgs])
  const UnstakeMsgs = useMemo(() => unstakeClaim.msgs, [unstakeClaim.msgs])

  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'msg_all_protocol_claims',
      run,
      address,
      chain?.id,
      JSON.stringify(ClaimMsgs),
      JSON.stringify(StakingMsgs),
      JSON.stringify(UnstakeMsgs),
      JSON.stringify(claims),
      staked,
      JSON.stringify(unstaking),
    ],
    queryFn: async (): Promise<QueryData> => {
      const summary = emptySummary()
      if (!run || !address) return { msgs: [], claims: summary }

      let msgs: EvmCall[] = []

      ///// Liquidation claims /////
      const nonZeroClaims = (claims ?? []).filter((claim) =>
        num(claim.pending_liquidated_collateral).isGreaterThan(0),
      )
      if (nonZeroClaims.length > 0) {
        msgs = msgs.concat(claimLiq.msgs ?? [])
        summary.liquidation = claimstoCoins(nonZeroClaims)
      }

      ///// Staking reward claims /////
      // No pending-rewards view on EVM — emit the claim when there is an active stake and
      // let simulation drop it if empty. Amounts are not surfaced (no view to read them).
      if (num(staked).isGreaterThan(0)) {
        msgs = msgs.concat(stakingClaim.msgs ?? [])
      }

      ///// Matured unstake withdrawal /////
      const maturedUnstakes = unstaking.filter(
        (u: any) => getTimeLeft(u.unstake_start_time).minutesLeft <= 0,
      )
      if (maturedUnstakes.length > 0) {
        msgs = msgs.concat(unstakeClaim.msgs ?? [])
        summary.staking = summary.staking.concat(
          maturedUnstakes.map((u: any) => ({
            denom: (mbrnAsset?.base as string) ?? '',
            amount: u.amount,
          })),
        )
      }

      ///// Vesting (Vesting.sol withdrawUnlocked) /////
      const vestingAddr = chain ? getContractAddress(chain.id, 'vesting') : undefined
      if (vestingAddr) {
        try {
          const client = getPublicClient()
          const nowTs = BigInt(Math.floor(Date.now() / 1000))
          const unlocked = (await client.readContract({
            address: vestingAddr,
            abi: vestingAbi,
            functionName: 'unlockedFor',
            args: [address as `0x${string}`, nowTs],
          })) as bigint
          if (unlocked > 0n) {
            msgs = msgs.concat([
              {
                address: vestingAddr,
                abi: vestingAbi,
                functionName: 'withdrawUnlocked',
                args: [],
              },
            ])
            summary.vesting = [
              { denom: (mbrnAsset?.base as string) ?? '', amount: unlocked.toString() },
            ]
          }
        } catch (e) {
          console.error('Error reading vesting unlockedFor:', e)
        }
      }

      // TODO(evm-migration): SP unstaking contribution dropped — no stability pool in the
      // Solidity port (inv_no_stability_pool). summary.sp_unstaking stays empty.
      // TODO(evm-migration): Lockdrop contribution dropped — the Cosmos lockdrop does not
      // exist in the port (Acquisition replaces launch mechanics).

      return { msgs, claims: summary }
    },
    enabled: !!address,
  })

  const { msgs, claims: queryClaimsSummary } = useMemo(() => {
    if (!queryData) return { msgs: [] as EvmCall[], claims: emptySummary() }
    return queryData
  }, [queryData])

  // Transform claim summary to a single list of Coin, aggregating same-denom entries.
  const claims_summ = Object.values(queryClaimsSummary).reduce(
    (acc, val) => acc.concat(val),
    [] as Coin[],
  )
  const definedClaims = claims_summ.filter((coin) => coin !== undefined)
  const agg_claims = definedClaims
    .filter((coin) => num(coin.amount).isGreaterThan(0))
    .reduce((acc, claim) => {
      const existing = acc.find((c) => c.denom === claim.denom)
      if (existing) {
        acc = acc.filter((c) => c.denom !== claim.denom)
        acc.push({
          denom: claim.denom,
          amount: num(claim.amount).plus(existing.amount).toString(),
        })
      } else {
        acc.push(claim)
      }
      return acc
    }, [] as Coin[])

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['protocol_claim_sim', msgs?.toString() ?? '0'],
      onSuccess,
      enabled: run,
    }),
    claims_summary: agg_claims,
  }
}

export default useProtocolClaims
