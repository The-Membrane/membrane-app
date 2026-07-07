import type { PublicClient } from 'viem'
import { stringToHex, toHex, keccak256, size as byteSize } from 'viem'
import { liqQueueAbi } from '@/contracts/abis/liqQueue'
import { liquidationEngineAbi } from '@/contracts/abis/liquidationEngine'
import { getContractAddress, type Address } from '@/config/evm/contracts'

/**
 * Liquidation / bidding read service (EVM) — replaces the CosmWasm read functions in
 * services/liquidation.ts (LiquidationQueue) and services/stabilityPool.ts.
 *
 * Follows the service contract (see .claude/skills/hook-query-patterns and cdp.ts):
 * null on failure, never throw; optional address override with config fallback.
 *
 * ARCHITECTURE DIVERGENCE (see membrane-solidity LiqQueue.sol / LiquidationEngine.sol):
 * the Solidity port has NO Cosmos-style stability pool — `inv_no_stability_pool` is a
 * hard invariant (LiqQueue.sol:297,1318). Liquidation collateral is distributed
 * pro-rata to individual premium-queue bidders (Liquity-style product/sum), never to a
 * pooled-deposit contract. Every stability-pool concept below is therefore an honest
 * STUB, not a mapping.
 *
 * Cosmos → EVM read map:
 *   liquidationClient.premiumSlots (getLiquidationQueue) → getPremiumSlots (loop getSlot)
 *   liquidationClient.queue         (getQueue)           → getQueue
 *   liquidationClient.queues        (getAllQueues)       → STUB (no enumeration view)
 *   liquidationClient.bidsByUser    (getUserBids)        → getUserBids (event reconstruction)
 *   liquidationClient.userClaims    (getUserClaims LQ)   → getClaimableCollateral
 *   stabilityPool.userClaims/assetPool/capitalAhead      → STUB (no stability pool)
 */

// ---------------------------------------------------------------------------
// address helpers
// ---------------------------------------------------------------------------

function liqQueueAddress(client: PublicClient, override?: Address): Address | undefined {
  return override ?? (client.chain ? getContractAddress(client.chain.id, 'liqQueue') : undefined)
}

function liquidationEngineAddress(client: PublicClient, override?: Address): Address | undefined {
  return (
    override ?? (client.chain ? getContractAddress(client.chain.id, 'liquidationEngine') : undefined)
  )
}

/**
 * Derive the LiqQueue `bytes32` asset key from a denom/symbol string.
 *
 * TODO(evm-migration): the canonical denom→bytes32 convention is deployment-defined and
 * opaque on-chain (LiqQueue.sol has no keccak derivation; the engine uses literals like
 * bytes32("cdt")). Short keys are stored as right-padded ASCII (Solidity bytes32("cdt")
 * === stringToHex('cdt', {size:32})); anything longer than 32 bytes falls back to a keccak
 * hash here so this never throws. Confirm against the actual deployment/registry before
 * relying on write paths — reads simply return null when the key/addresses are unset.
 */
export function assetKey(denomOrSymbol: string): `0x${string}` {
  const raw = denomOrSymbol ?? ''
  try {
    if (byteSize(toHex(raw)) <= 32) return stringToHex(raw, { size: 32 })
  } catch {
    /* fall through to keccak */
  }
  return keccak256(toHex(raw))
}

// ---------------------------------------------------------------------------
// LiqQueue reads
// ---------------------------------------------------------------------------

/** Queue config for a collateral asset (maxPremium, bidThreshold, currentBidId). */
export async function getQueue(
  client: PublicClient | null,
  asset: `0x${string}`,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = liqQueueAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: liqQueueAbi,
      functionName: 'getQueue',
      args: [asset],
    })
  } catch (error) {
    console.error('Error querying LiqQueue getQueue:', error)
    return null
  }
}

/** Aggregate snapshot of a single premium slot (totalBidAmount, activeBids, etc.). */
export async function getSlot(
  client: PublicClient | null,
  asset: `0x${string}`,
  premium: number | bigint,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = liqQueueAddress(client, contractAddr)
  if (!address) return null
  try {
    const [
      totalBidAmount,
      productSnapshot,
      sumSnapshot,
      currentEpoch,
      currentScale,
      activeBids,
      waitingBidsLen,
    ] = await client.readContract({
      address,
      abi: liqQueueAbi,
      functionName: 'getSlot',
      args: [asset, BigInt(premium)],
    })
    return {
      premium: Number(premium),
      totalBidAmount,
      productSnapshot,
      sumSnapshot,
      currentEpoch,
      currentScale,
      activeBids,
      waitingBidsLen,
    }
  } catch (error) {
    console.error('Error querying LiqQueue getSlot:', error)
    return null
  }
}

/**
 * All premium slots 0..maxPremium for an asset — the EVM equivalent of the Cosmos
 * `premiumSlots` query (there is no batch view; slots are read per-premium and viem
 * batches them via multicall). Returns null on failure; slot entries that error are
 * dropped.
 */
export async function getPremiumSlots(
  client: PublicClient | null,
  asset: `0x${string}`,
  maxPremium: number,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = liqQueueAddress(client, contractAddr)
  if (!address) return null
  try {
    const premiums = Array.from({ length: maxPremium + 1 }, (_, p) => p)
    const slots = await Promise.all(premiums.map((p) => getSlot(client, asset, p, address)))
    return slots.filter((s): s is NonNullable<typeof s> => s !== null)
  } catch (error) {
    console.error('Error querying LiqQueue premium slots:', error)
    return null
  }
}

/** Total CDT bid supply across all slots for an asset. */
export async function getTotalBidSupply(
  client: PublicClient | null,
  asset: `0x${string}`,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = liqQueueAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: liqQueueAbi,
      functionName: 'totalBidSupply',
      args: [asset],
    })
  } catch (error) {
    console.error('Error querying LiqQueue totalBidSupply:', error)
    return null
  }
}

/** Locate a bid by id — returns {premium, indexPlusOne, waiting, exists}. */
export async function getBidLoc(
  client: PublicClient | null,
  asset: `0x${string}`,
  bidId: bigint,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = liqQueueAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: liqQueueAbi,
      functionName: 'getBidLoc',
      args: [asset, bidId],
    })
  } catch (error) {
    console.error('Error querying LiqQueue getBidLoc:', error)
    return null
  }
}

/** Read-only pending collateral a still-active bid would yield if claimed now. */
export async function getPendingCollateral(
  client: PublicClient | null,
  asset: `0x${string}`,
  bidId: bigint,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = liqQueueAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: liqQueueAbi,
      functionName: 'pendingCollateral',
      args: [asset, bidId],
    })
  } catch (error) {
    console.error('Error querying LiqQueue pendingCollateral:', error)
    return null
  }
}

/**
 * Claimable (already-drained) collateral aggregate for a user in one asset — the EVM
 * mapping for the Cosmos `userClaims` LQ path. NOTE: this only covers collateral from
 * fully-drained bids; collateral accrued to partially-consumed *active* bids lives in
 * per-bid `pendingLiquidatedCollateral` and must be swept via getUserBids +
 * getPendingCollateral + claimLiquidations(asset, bidIds).
 */
export async function getClaimableCollateral(
  client: PublicClient | null,
  asset: `0x${string}`,
  user: Address,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = liqQueueAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: liqQueueAbi,
      functionName: 'claimableCollateral',
      args: [asset, user],
    })
  } catch (error) {
    console.error('Error querying LiqQueue claimableCollateral:', error)
    return null
  }
}

export type UserBid = {
  id: bigint
  user: Address
  amount: bigint
  liqPremium: bigint
  pendingLiquidatedCollateral: bigint
  waiting: boolean
  premium: number
}

/**
 * A user's bids for an asset — the EVM equivalent of the Cosmos `bidsByUser` query.
 *
 * LiqQueue.sol has NO per-user enumeration view, so bid ids are reconstructed from the
 * indexed `BidSubmitted(asset, bidId, user, ...)` event, then located via getBidLoc and
 * hydrated via getActiveBid / getWaitingBid. Bids that no longer exist (fully consumed
 * or retracted) are dropped. Returns null on failure.
 */
export async function getUserBids(
  client: PublicClient | null,
  asset: `0x${string}`,
  user: Address,
  fromBlock?: bigint,
  contractAddr?: Address,
): Promise<UserBid[] | null> {
  if (!client) return null
  const address = liqQueueAddress(client, contractAddr)
  if (!address) return null
  try {
    const logs = await client.getContractEvents({
      address,
      abi: liqQueueAbi,
      eventName: 'BidSubmitted',
      args: { asset, user },
      fromBlock: fromBlock ?? 'earliest',
      toBlock: 'latest',
    })

    // dedupe bid ids
    const bidIds = Array.from(
      new Set(logs.map((l) => l.args.bidId).filter((id): id is bigint => id !== undefined)),
    )

    const bids = await Promise.all(
      bidIds.map(async (bidId) => {
        const loc = await getBidLoc(client, asset, bidId, address)
        if (!loc || !loc.exists) return null
        try {
          const bid = await client.readContract({
            address,
            abi: liqQueueAbi,
            functionName: loc.waiting ? 'getWaitingBid' : 'getActiveBid',
            args: [asset, loc.premium, loc.indexPlusOne - 1n],
          })
          if (bid.user.toLowerCase() !== user.toLowerCase()) return null
          return {
            id: bid.id,
            user: bid.user,
            amount: bid.amount,
            liqPremium: bid.liqPremium,
            pendingLiquidatedCollateral: bid.pendingLiquidatedCollateral,
            waiting: bid.waiting,
            premium: Number(loc.premium),
          } as UserBid
        } catch {
          return null
        }
      }),
    )

    return bids.filter((b): b is UserBid => b !== null)
  } catch (error) {
    console.error('Error querying LiqQueue user bids:', error)
    return null
  }
}

// ---------------------------------------------------------------------------
// LiquidationEngine reads
// ---------------------------------------------------------------------------

/** Whether a liquidation delay timer is armed and still within its window for a position. */
export async function isTimerActive(
  client: PublicClient | null,
  positionId: bigint,
  owner: Address,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = liquidationEngineAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: liquidationEngineAbi,
      functionName: 'isTimerActive',
      args: [positionId, owner],
    })
  } catch (error) {
    console.error('Error querying LiquidationEngine isTimerActive:', error)
    return null
  }
}

/** Number of historical liquidation events in the engine's capped ring buffer. */
export async function getStatsLength(client: PublicClient | null, contractAddr?: Address) {
  if (!client) return null
  const address = liquidationEngineAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: liquidationEngineAbi,
      functionName: 'statsLength',
    })
  } catch (error) {
    console.error('Error querying LiquidationEngine statsLength:', error)
    return null
  }
}

/** One historical liquidation event by index. */
export async function getStatAt(client: PublicClient | null, i: bigint, contractAddr?: Address) {
  if (!client) return null
  const address = liquidationEngineAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: liquidationEngineAbi,
      functionName: 'statAt',
      args: [i],
    })
  } catch (error) {
    console.error('Error querying LiquidationEngine statAt:', error)
    return null
  }
}

// ---------------------------------------------------------------------------
// Honest stubs — no LiquidationEngine/LiqQueue equivalent
// ---------------------------------------------------------------------------

/**
 * TODO(evm-migration): LiqQueue has no queue-enumeration view (Cosmos `queues` listed
 * every registered queue). The set of queued collateral assets must come from an
 * external source (the CDP basket / a deployment registry); callers should iterate that
 * list and call getQueue per asset.
 */
export async function getAllQueues(_client: PublicClient | null): Promise<null> {
  return null
}

/**
 * TODO(evm-migration): no stability pool in the Solidity port (inv_no_stability_pool,
 * LiqQueue.sol:297). Cosmos `stabilityPool.userClaims` has no equivalent — SP claims do
 * not exist; only per-asset LiqQueue collateral claims do (getClaimableCollateral).
 */
export async function getStabilityPoolClaims(_client: PublicClient | null): Promise<null> {
  return null
}

/**
 * TODO(evm-migration): no stability pool in the Solidity port. Cosmos
 * `stabilityPool.assetPool` (a user's pool deposit) has no equivalent.
 */
export async function getStabilityPoolDeposit(_client: PublicClient | null): Promise<null> {
  return null
}

/**
 * TODO(evm-migration): no stability pool in the Solidity port. Cosmos
 * `stabilityPool.capitalAheadOfDeposit` has no equivalent (the LiqQueue is a
 * premium-ordered bid book, not a FIFO deposit pool).
 */
export async function getCapitalAheadOfDeposit(_client: PublicClient | null): Promise<null> {
  return null
}

// ---------------------------------------------------------------------------
// Minimal ERC20 approve ABI — the EVM layer has no erc20 abi yet, and submitBid pulls
// the bid asset (CDT) via transferFrom, so CTA hooks need an approve call. Kept here so
// the liquidation domain is self-contained.
// ---------------------------------------------------------------------------

export const erc20ApproveAbi = [
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const
