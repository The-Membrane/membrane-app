import type { PublicClient } from 'viem'
import { auctionAbi } from '@/contracts/abis/auction'
import { getContractAddress, type Address } from '@/config/evm/contracts'
import { assetKey } from './liquidation'

/**
 * Fee-auction read service (EVM) — replaces the CosmWasm read functions in
 * services/asset_auction.ts (AuctionQueryClient).
 *
 * Follows the service contract (see services/chain/README.md and cdp.ts):
 * null on failure, never throw; optional address override with config fallback.
 *
 * SEMANTIC CHANGE (Auction.sol AUC-C-01 / A-D-01): the fee auction is a Dutch
 * auction where the QUOTE asset PULLED from the buyer is CDT (not MBRN as on
 * Cosmos). `swapForFee(denom, paid)` pulls `paid` CDT and pushes
 * `payout = min(auctionAssetAmount, (1 - discount) * paid)` of the fee asset
 * `denom`. Consumers sizing the buy must use the user's CDT balance.
 *
 * Cosmos → EVM read map:
 *   AuctionClient.ongoingFeeAuctions (getLiveFeeAuction) → getLiveFeeAuctions
 *                                                          (event reconstruction)
 *   feeAuctions(denom) single-auction                    → getFeeAuction
 *   discount params (Config)                             → getDiscountConfig
 *   discount at a start time                             → getDiscountRatio
 *   blacklistAuctions(positionId)                        → getBlacklistAuction
 *   feeAssetToken(denom)                                 → getFeeAssetToken
 */

// ---------------------------------------------------------------------------
// address helper
// ---------------------------------------------------------------------------

function auctionAddress(client: PublicClient, override?: Address): Address | undefined {
  return override ?? (client.chain ? getContractAddress(client.chain.id, 'auction') : undefined)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeeAuction = {
  /** the fee asset being auctioned (bytes32 denom key) */
  auctionAssetDenom: `0x${string}`
  /** remaining amount of the fee asset up for auction */
  auctionAssetAmount: bigint
  /** unix seconds the auction started (drives the Dutch discount ramp) */
  auctionStartTime: bigint
  exists: boolean
}

export type DiscountConfig = {
  initialDiscount: bigint
  discountIncreaseTimeframeS: bigint
  discountIncrease: bigint
  delayWindowM: bigint
  /** the auction's desired/quote asset denom key */
  desiredAsset: `0x${string}`
  mbrnDenom: `0x${string}`
  cdtDenom: `0x${string}`
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Live-auction state for one fee-asset denom. Returns null if the record errors. */
export async function getFeeAuction(
  client: PublicClient | null,
  denom: `0x${string}`,
  contractAddr?: Address,
): Promise<FeeAuction | null> {
  if (!client) return null
  const address = auctionAddress(client, contractAddr)
  if (!address) return null
  try {
    const [auctionAssetDenom, auctionAssetAmount, auctionStartTime, exists] =
      await client.readContract({
        address,
        abi: auctionAbi,
        functionName: 'feeAuctions',
        args: [denom],
      })
    return { auctionAssetDenom, auctionAssetAmount, auctionStartTime: BigInt(auctionStartTime), exists }
  } catch (error) {
    console.error('Error querying Auction feeAuctions:', error)
    return null
  }
}

/**
 * All currently-live fee auctions — the EVM equivalent of the Cosmos
 * `ongoingFeeAuctions` query. Auction.sol keys fee auctions by denom in a
 * non-enumerable mapping, so the candidate denom set is reconstructed from the
 * indexed `AuctionStarted(denom, ...)` event, then each denom is re-read via
 * `feeAuctions(denom)` and filtered to `exists` (a swap that drains an auction
 * `delete`s the record — see Auction.sol:515-519). Sorted by start time ascending
 * (oldest = deepest discount first), preserving getLiveFeeAuction semantics.
 * Returns null on failure.
 */
export async function getLiveFeeAuctions(
  client: PublicClient | null,
  fromBlock?: bigint,
  contractAddr?: Address,
): Promise<FeeAuction[] | null> {
  if (!client) return null
  const address = auctionAddress(client, contractAddr)
  if (!address) return null
  try {
    const logs = await client.getContractEvents({
      address,
      abi: auctionAbi,
      eventName: 'AuctionStarted',
      fromBlock: fromBlock ?? 'earliest',
      toBlock: 'latest',
    })

    const denoms = Array.from(
      new Set(
        logs
          .map((l) => l.args.denom)
          .filter((d): d is `0x${string}` => d !== undefined),
      ),
    )

    const auctions = await Promise.all(denoms.map((d) => getFeeAuction(client, d, address)))
    return auctions
      .filter((a): a is FeeAuction => a !== null && a.exists)
      .sort((a, b) => (a.auctionStartTime < b.auctionStartTime ? -1 : a.auctionStartTime > b.auctionStartTime ? 1 : 0))
  } catch (error) {
    console.error('Error reconstructing live fee auctions:', error)
    return null
  }
}

/** The auctioneer's Dutch-discount parameters (Config subset). */
export async function getDiscountConfig(
  client: PublicClient | null,
  contractAddr?: Address,
): Promise<DiscountConfig | null> {
  if (!client) return null
  const address = auctionAddress(client, contractAddr)
  if (!address) return null
  try {
    const cfg = await client.readContract({
      address,
      abi: auctionAbi,
      functionName: 'config',
    })
    // config() returns a positional tuple:
    // [mbrnDenom, cdtDenom, desiredAsset, positionsContract, stakingContract,
    //  twapTimeframeM, initialDiscount, discountIncreaseTimeframeS,
    //  discountIncrease, sendToStakers, delayWindowM]
    const [
      mbrnDenom,
      cdtDenom,
      desiredAsset,
      ,
      ,
      ,
      initialDiscount,
      discountIncreaseTimeframeS,
      discountIncrease,
      ,
      delayWindowM,
    ] = cfg
    return {
      mbrnDenom,
      cdtDenom,
      desiredAsset,
      initialDiscount,
      discountIncreaseTimeframeS,
      discountIncrease,
      delayWindowM,
    }
  } catch (error) {
    console.error('Error querying Auction config:', error)
    return null
  }
}

/**
 * On-chain discount ratio (DECIMAL_FRACTIONAL / 1e18 scaled) for an auction that
 * started at `auctionStart` (unix seconds). Prefer this over recomputing the ramp
 * client-side — it accounts for the mbrn-vs-fee-asset delay window (Auction.sol
 * _getDiscountRatio:1236).
 */
export async function getDiscountRatio(
  client: PublicClient | null,
  auctionStart: bigint,
  contractAddr?: Address,
): Promise<bigint | null> {
  if (!client) return null
  const address = auctionAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: auctionAbi,
      functionName: 'getDiscountRatio',
      args: [auctionStart],
    })
  } catch (error) {
    console.error('Error querying Auction getDiscountRatio:', error)
    return null
  }
}

export type BlacklistAuction = {
  sourcePositionId: bigint
  custodyClone: Address
  frozenUsdcAmount: bigint
  sendExcessTo: Address
  auctionStartTime: bigint
  auctionEndTime: bigint
  exists: boolean
}

/** A frozen-USDC (blacklist) Dutch auction, keyed by its source position id. */
export async function getBlacklistAuction(
  client: PublicClient | null,
  positionId: bigint,
  contractAddr?: Address,
): Promise<BlacklistAuction | null> {
  if (!client) return null
  const address = auctionAddress(client, contractAddr)
  if (!address) return null
  try {
    const [
      sourcePositionId,
      custodyClone,
      frozenUsdcAmount,
      sendExcessTo,
      auctionStartTime,
      auctionEndTime,
      exists,
    ] = await client.readContract({
      address,
      abi: auctionAbi,
      functionName: 'blacklistAuctions',
      args: [positionId],
    })
    return {
      sourcePositionId,
      custodyClone,
      frozenUsdcAmount,
      sendExcessTo,
      auctionStartTime: BigInt(auctionStartTime),
      auctionEndTime: BigInt(auctionEndTime),
      exists,
    }
  } catch (error) {
    console.error('Error querying Auction blacklistAuctions:', error)
    return null
  }
}

/** The ERC-20 mapped to a fee-asset denom (must be wired before swaps settle). */
export async function getFeeAssetToken(
  client: PublicClient | null,
  denom: `0x${string}`,
  contractAddr?: Address,
): Promise<Address | null> {
  if (!client) return null
  const address = auctionAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: auctionAbi,
      functionName: 'feeAssetToken',
      args: [denom],
    })
  } catch (error) {
    console.error('Error querying Auction feeAssetToken:', error)
    return null
  }
}

/** Re-export the shared denom→bytes32 key helper so auction callers can derive keys. */
export { assetKey }
