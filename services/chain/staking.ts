import type { PublicClient } from 'viem'
import { stakingAbi } from '@/contracts/abis/staking'
import { getContractAddress, type Address } from '@/config/evm/contracts'

/**
 * Staking.sol read service — EVM counterpart of services/staking.ts (the CosmWasm
 * StakingQueryClient). Follows the service contract (see .claude/skills/hook-query-patterns
 * and services/chain/README.md): return null on failure, never throw; optional address
 * override with config fallback; works with no wallet connected.
 *
 * Cosmos → Solidity mapping (see the return block of the migration report):
 *   config()                         → getConfig            (Staking.sol `config`)
 *   userStake({staker})              → getUserStake         (`depositCountOf` + `depositOf`
 *                                                            reconstruct the deposit list;
 *                                                            `totalUserStake` for the sum)
 *   —                                → getTotalUserStake    (`totalUserStake`)
 *   —                                → getVotePower         (`votePower`)
 *   —                                → getStakingTotals     (`stakingTotals`)
 *   userRewards({user})              → STUB (no view equiv — see getUserRewards)
 *   delegations({user})              → STUB (no delegation in Staking.sol)
 */

function stakingAddress(client: PublicClient, override?: Address): Address | undefined {
  return override ?? (client.chain ? getContractAddress(client.chain.id, 'staking') : undefined)
}

/** Lock sub-struct mirrored from Staking.sol `struct Lock`. */
export type StakeLock = {
  lockedUntil: bigint
  perpetualLockDays: bigint
  intendedLockDays: bigint
  isLocked: boolean
}

/** One entry of Staking.sol `_deposits[user]` (`struct StakeDeposit`). */
export type StakeDeposit = {
  amount: bigint
  stakeTime: bigint
  /** 0n == not unstaking; otherwise the unix second unbonding started. */
  unstakeStartTime: bigint
  locked: StakeLock
}

/** Global config tuple — `Staking.sol config()`. */
export async function getConfig(client: PublicClient | null, contractAddr?: Address) {
  if (!client) return null
  const address = stakingAddress(client, contractAddr)
  if (!address) return null
  try {
    const [
      unstakingPeriodS,
      lockDurationCeilingS,
      maxCommissionRate,
      vestingRevMultiplier,
      positionsContract,
      auctionContract,
      vestingContract,
    ] = await client.readContract({ address, abi: stakingAbi, functionName: 'config' })
    return {
      unstakingPeriodS,
      lockDurationCeilingS,
      maxCommissionRate,
      vestingRevMultiplier,
      positionsContract,
      auctionContract,
      vestingContract,
    }
  } catch (error) {
    console.error('Error querying Staking config:', error)
    return null
  }
}

/**
 * Per-user stake. Cosmos `userStake` returned a `{ deposit_list }`; Staking.sol has no
 * single call for it, so we reconstruct the list from `depositCountOf` + `depositOf(i)`
 * (batched via the client's multicall) and read `totalUserStake` for the aggregate.
 */
export async function getUserStake(
  client: PublicClient | null,
  user: Address,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = stakingAddress(client, contractAddr)
  if (!address) return null
  try {
    const count = await client.readContract({
      address,
      abi: stakingAbi,
      functionName: 'depositCountOf',
      args: [user],
    })
    const deposits: StakeDeposit[] = []
    for (let i = 0n; i < count; i++) {
      const d = await client.readContract({
        address,
        abi: stakingAbi,
        functionName: 'depositOf',
        args: [user, i],
      })
      deposits.push({
        amount: d.amount,
        stakeTime: d.stakeTime,
        unstakeStartTime: d.unstakeStartTime,
        locked: {
          lockedUntil: d.locked.lockedUntil,
          perpetualLockDays: d.locked.perpetualLockDays,
          intendedLockDays: d.locked.intendedLockDays,
          isLocked: d.locked.isLocked,
        },
      })
    }
    const totalStaked = await client.readContract({
      address,
      abi: stakingAbi,
      functionName: 'totalUserStake',
      args: [user],
    })
    return { deposits, totalStaked }
  } catch (error) {
    console.error('Error querying Staking userStake:', error)
    return null
  }
}

/** Total staked MBRN for a user (incl. in-flight unbonding). `totalUserStake`. */
export async function getTotalUserStake(
  client: PublicClient | null,
  user: Address,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = stakingAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: stakingAbi,
      functionName: 'totalUserStake',
      args: [user],
    })
  } catch (error) {
    console.error('Error querying Staking totalUserStake:', error)
    return null
  }
}

/** Governance vote weight — deposits not yet unbonding (+ perpetual locks). `votePower`. */
export async function getVotePower(
  client: PublicClient | null,
  user: Address,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = stakingAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: stakingAbi,
      functionName: 'votePower',
      args: [user],
    })
  } catch (error) {
    console.error('Error querying Staking votePower:', error)
    return null
  }
}

/** Protocol-wide staking totals (stakers, vestingContract). `stakingTotals`. */
export async function getStakingTotals(client: PublicClient | null, contractAddr?: Address) {
  if (!client) return null
  const address = stakingAddress(client, contractAddr)
  if (!address) return null
  try {
    const [stakers, vestingContract] = await client.readContract({
      address,
      abi: stakingAbi,
      functionName: 'stakingTotals',
    })
    return { stakers, vestingContract }
  } catch (error) {
    console.error('Error querying Staking stakingTotals:', error)
    return null
  }
}

/**
 * Cosmos `userRewards` returned pending `{ accrued_interest, claimables }`.
 * Staking.sol exposes no equivalent view: `claimRewards` is a state-mutating call
 * (returns the claimed amount only on execution), and pending rewards would have to be
 * recomputed off-chain from `accFeePerUnit[denom]`, `lastIdx[user][i][denom]` and each
 * deposit's amount — but the `seenDenoms` array has no length getter, so its fee-denom
 * set can't be enumerated through views. No clean read equivalent exists.
 */
export async function getUserRewards(
  _client: PublicClient | null,
  _user: Address,
  _contractAddr?: Address,
) {
  // TODO(evm-migration): no pending-rewards view on Staking.sol; claimRewards is
  // mutating and seenDenoms is not enumerable via views. Add a rewards view (or an
  // off-chain accFeePerUnit/lastIdx indexer) to restore this read.
  return null
}

/**
 * Cosmos `delegations`/`getDelegatorInfo` — MBRN vote/commission delegation.
 * Staking.sol has no delegation feature at all (no delegate mapping, no delegations
 * view, no updateDelegations execute). The port dropped delegation entirely.
 */
export async function getUserDelegations(
  _client: PublicClient | null,
  _user: Address,
  _contractAddr?: Address,
) {
  // TODO(evm-migration): Staking.sol has no delegation feature; nothing to map.
  return null
}

/** See getUserDelegations — delegation does not exist in Staking.sol. */
export async function getDelegatorInfo(
  _client: PublicClient | null,
  _user: Address,
  _contractAddr?: Address,
) {
  // TODO(evm-migration): Staking.sol has no delegation feature; nothing to map.
  return null
}
