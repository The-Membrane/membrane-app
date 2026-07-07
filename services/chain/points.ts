import type { PublicClient } from 'viem'
import { pointsSystemAbi } from '@/contracts/abis/pointsSystem'
import { getContractAddress, type Address } from '@/config/evm/contracts'

/**
 * Points read service (EVM) — replaces the CosmWasm read functions in
 * services/points.ts (PointsQueryClient).
 *
 * Follows the service contract (see services/chain/README.md and cdp.ts):
 * null on failure, never throw; optional address override with config fallback.
 *
 * ARCHITECTURE DIVERGENCE (see membrane-solidity PointsSystem.sol):
 *   - Points are AWARDED ON-CHAIN by authorized peer contracts (CDP, Transmuter,
 *     LtvDisco, RevDist, LiquidationEngine, Governance) via awardActionPoints /
 *     awardAffiliateFee / awardManagerFee / awardManagementPoints. The Cosmos
 *     "user submits checkClaims/givePoints message" pattern is GONE — there is no
 *     user-callable earn path, so nothing here builds an earn tx.
 *   - The Rust `total_points / claimable_points` UserStats split is collapsed to a
 *     single `balances[user]` scalar (per the port master plan). "points" and
 *     "claimable" are the same number now.
 *   - The only user-callable write is `redeem(token, points)` (burns points →
 *     transfers token). See redeemCall() below.
 *
 * Cosmos → EVM read map:
 *   PointsClient.userStats (getAllUserPoints)  → getLeaderboard (event reconstruction)
 *   PointsClient.userStats single-user         → getUserPoints (balances(user))
 *   points_multipliers (getPointsMultipliers)  → STUB (computed at callsite on-chain)
 *   user_conversion_rates (get*ConversionRates)→ STUB (vault conversion tracking, Cosmos-only)
 */

/**
 * Points are stored on-chain with 6 decimals (PointsSystem.sol:120 —
 * MANAGEMENT_POINTS_PER_ACTION = 5_000_000 == 5 points). The UI's level math
 * (useSoloLevel) works in human-scale points, so raw balances are shifted by
 * -POINTS_DECIMALS at the hook layer.
 */
export const POINTS_DECIMALS = 6

// ---------------------------------------------------------------------------
// address helper
// ---------------------------------------------------------------------------

function pointsSystemAddress(client: PublicClient, override?: Address): Address | undefined {
  return override ?? (client.chain ? getContractAddress(client.chain.id, 'pointsSystem') : undefined)
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** A single user's raw points balance (6-dec). Cosmos `userStats` for one user. */
export async function getUserPoints(
  client: PublicClient | null,
  user: Address,
  contractAddr?: Address,
): Promise<bigint | null> {
  if (!client) return null
  const address = pointsSystemAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: pointsSystemAbi,
      functionName: 'balances',
      args: [user],
    })
  } catch (error) {
    console.error('Error querying PointsSystem balances:', error)
    return null
  }
}

/** Aggregate of all outstanding points across every user (6-dec). */
export async function getTotalPointsOutstanding(
  client: PublicClient | null,
  contractAddr?: Address,
): Promise<bigint | null> {
  if (!client) return null
  const address = pointsSystemAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: pointsSystemAbi,
      functionName: 'totalPointsOutstanding',
    })
  } catch (error) {
    console.error('Error querying PointsSystem totalPointsOutstanding:', error)
    return null
  }
}

export type LeaderboardEntry = {
  user: Address
  /** raw points balance (6-dec), reconstructed net of redemptions */
  points: bigint
}

/**
 * All users' current points balances — the EVM equivalent of the Cosmos
 * `userStats({ limit })` all-users query. PointsSystem.sol has NO per-user
 * enumeration view (the `balances` mapping isn't iterable), so balances are
 * reconstructed from the indexed `PointsAwarded(user, amount, source)` and
 * `PointsRedeemed(user, token, points, tokenAmount)` events:
 *
 *   balance[user] = Σ awarded.amount − Σ redeemed.points
 *
 * which is exactly what `_addPoints` / `redeem` maintain on-chain. Entries with a
 * non-positive net (fully redeemed) are dropped. Sorted by points descending so
 * callers can index rank directly. Returns null on failure.
 */
export async function getLeaderboard(
  client: PublicClient | null,
  fromBlock?: bigint,
  contractAddr?: Address,
): Promise<LeaderboardEntry[] | null> {
  if (!client) return null
  const address = pointsSystemAddress(client, contractAddr)
  if (!address) return null
  try {
    const [awarded, redeemed] = await Promise.all([
      client.getContractEvents({
        address,
        abi: pointsSystemAbi,
        eventName: 'PointsAwarded',
        fromBlock: fromBlock ?? 'earliest',
        toBlock: 'latest',
      }),
      client.getContractEvents({
        address,
        abi: pointsSystemAbi,
        eventName: 'PointsRedeemed',
        fromBlock: fromBlock ?? 'earliest',
        toBlock: 'latest',
      }),
    ])

    const totals = new Map<string, bigint>()
    for (const log of awarded) {
      const user = log.args.user
      const amount = log.args.amount
      if (!user || amount === undefined) continue
      totals.set(user, (totals.get(user) ?? 0n) + amount)
    }
    for (const log of redeemed) {
      const user = log.args.user
      const points = log.args.points
      if (!user || points === undefined) continue
      totals.set(user, (totals.get(user) ?? 0n) - points)
    }

    return Array.from(totals.entries())
      .filter(([, points]) => points > 0n)
      .map(([user, points]) => ({ user: user as Address, points }))
      .sort((a, b) => (b.points > a.points ? 1 : b.points < a.points ? -1 : 0))
  } catch (error) {
    console.error('Error reconstructing PointsSystem leaderboard:', error)
    return null
  }
}

/** Whether the redemption path is globally paused. */
export async function getRedemptionsPaused(
  client: PublicClient | null,
  contractAddr?: Address,
): Promise<boolean | null> {
  if (!client) return null
  const address = pointsSystemAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: pointsSystemAbi,
      functionName: 'redemptionsPaused',
    })
  } catch (error) {
    console.error('Error querying PointsSystem redemptionsPaused:', error)
    return null
  }
}

/** Per-token redemption rate (token units per point, DECIMAL_FRACTIONAL scaled). */
export async function getRedemptionRate(
  client: PublicClient | null,
  token: Address,
  contractAddr?: Address,
): Promise<bigint | null> {
  if (!client) return null
  const address = pointsSystemAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: pointsSystemAbi,
      functionName: 'redemptionRates',
      args: [token],
    })
  } catch (error) {
    console.error('Error querying PointsSystem redemptionRates:', error)
    return null
  }
}

/** The token amount `points` would redeem into for `token` (reverts→null). */
export async function getPreviewRedeem(
  client: PublicClient | null,
  token: Address,
  points: bigint,
  contractAddr?: Address,
): Promise<bigint | null> {
  if (!client) return null
  const address = pointsSystemAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: pointsSystemAbi,
      functionName: 'previewRedeem',
      args: [token, points],
    })
  } catch (error) {
    console.error('Error querying PointsSystem previewRedeem:', error)
    return null
  }
}

/** The registered reward tokens, read via rewardTokenCount + rewardTokens(i). */
export async function getRewardTokens(
  client: PublicClient | null,
  contractAddr?: Address,
): Promise<Address[] | null> {
  if (!client) return null
  const address = pointsSystemAddress(client, contractAddr)
  if (!address) return null
  try {
    const count = await client.readContract({
      address,
      abi: pointsSystemAbi,
      functionName: 'rewardTokenCount',
    })
    const idxs = Array.from({ length: Number(count) }, (_, i) => BigInt(i))
    const tokens = await Promise.all(
      idxs.map((i) =>
        client.readContract({
          address,
          abi: pointsSystemAbi,
          functionName: 'rewardTokens',
          args: [i],
        }),
      ),
    )
    return tokens as Address[]
  } catch (error) {
    console.error('Error querying PointsSystem rewardTokens:', error)
    return null
  }
}

// ---------------------------------------------------------------------------
// Writes (user-callable) — msg builder for the CTA pipeline (EvmCall shape)
// ---------------------------------------------------------------------------

/**
 * Build the `redeem(token, points)` call. This is the ONLY user-callable state
 * change on PointsSystem (all earn paths are peer-contract only). Returns the
 * EvmCall for the tx pipeline; the reward token does not need a prior approve —
 * PointsSystem pushes the token to the user, it does not pull.
 */
export function redeemCall(
  contractAddr: Address,
  token: Address,
  points: bigint,
) {
  return {
    address: contractAddr,
    abi: pointsSystemAbi,
    functionName: 'redeem',
    args: [token, points],
  } as const
}

// ---------------------------------------------------------------------------
// Honest stubs — no PointsSystem equivalent (Cosmos-only concepts)
// ---------------------------------------------------------------------------

/**
 * TODO(evm-migration): PointsSystem.sol has NO `points_multipliers` view. In the
 * Cosmos points contract, per-action multipliers (interest_rate, vault_yields,
 * liquidation_execution, governance_votes, transmuter_swap_fees, disco_revenue)
 * were stored in-contract and queryable. In the Solidity port the multiplier is
 * applied AT THE CALLSITE by the awarding organ (see PointsSystem.sol:385-400 —
 * "each pre-computes its own point amount based on its multiplier"); the raw
 * `points`/`dollarValue` arrives pre-scaled. There is nothing to read.
 */
export async function getPointsMultipliers(_client: PublicClient | null): Promise<null> {
  return null
}

/**
 * TODO(evm-migration): no equivalent in the Solidity port. The Cosmos
 * `user_conversion_rates` query tracked per-vault conversion-rate / vault-token
 * snapshots used for yield-based points accrual. That accrual moved on-chain into
 * the awarding organs, so the snapshot ledger no longer exists here.
 */
export async function getUserConversionRates(_client: PublicClient | null): Promise<null> {
  return null
}

/**
 * TODO(evm-migration): no equivalent in the Solidity port (see
 * getUserConversionRates). The all-users conversion-rate table is Cosmos-only.
 */
export async function getAllConversionRates(_client: PublicClient | null): Promise<null> {
  return null
}
