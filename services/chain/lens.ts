import type { PublicClient } from 'viem'
import { erc20Abi } from 'viem'
import { frontendLensAbi } from '@/contracts/abis/frontendLens'
import { getContractAddress, type Address } from '@/config/evm/contracts'

/**
 * FrontendLens.sol read service (EVM). The lens is a thin aggregator over Collateral.sol
 * + Cdp.sol + Auction.sol that returns denormalized, UI-shaped structs in a single call,
 * so the app can rebuild the Cosmos "basket" without touching each contract directly.
 *
 * Follows the service contract (see services/chain/README.md and cdp.ts):
 * null on failure, never throw; optional address override with config fallback.
 *
 * SHAPE NOTES (authoritative: contracts/abis/frontendLens.ts):
 *  - `getAllCollateralParams` / `getCollateralParamsRange` return CollateralParams structs:
 *      denom (bytes32), token (ERC20 address), currentMaxLTV / tempLtv / maxThresholdToDelay
 *      (all 1e18-scaled uints), enabled, isInOnboarding, onboardingWindowEnd (unix secs),
 *      supplyCapRegistered, supplyCap + currentSupply (base-unit uints).
 *      This port has NO separate maxBorrowLTV — `currentMaxLTV` IS the borrow-gating LTV.
 *  - `liveFeeAuctions` returns LiveAuction structs: denom (bytes32), amount (base-unit),
 *      startTime (unix secs). Already filtered to live auctions on-chain.
 *  - `tokenOf(denom)` / `denomOf(token)` bridge the bytes32 denom key ⇄ ERC20 address.
 */

type Bytes32 = `0x${string}`

function lensAddress(client: PublicClient, override?: Address): Address | undefined {
  return override ?? (client.chain ? getContractAddress(client.chain.id, 'frontendLens') : undefined)
}

// ---------------------------------------------------------------------------
// Types (mirror the on-chain structs; all *LTV / threshold values are 1e18-scaled)
// ---------------------------------------------------------------------------

export type EvmCollateralParams = {
  denom: Bytes32
  token: Address
  currentMaxLTV: bigint
  tempLtv: bigint
  maxThresholdToDelay: bigint
  enabled: boolean
  isInOnboarding: boolean
  onboardingWindowEnd: bigint
  supplyCapRegistered: boolean
  supplyCap: bigint
  currentSupply: bigint
}

export type EvmLiveAuction = {
  denom: Bytes32
  amount: bigint
  startTime: bigint
}

export type Erc20Metadata = {
  address: Address
  symbol: string
  decimals: number
  name: string
}

// The ABI returns readonly structs with the exact CollateralParams field names — map to a
// plain, mutable EvmCollateralParams (normalizing uint64 → bigint) for downstream consumers.
function toCollateralParams(
  r: {
    denom: Bytes32
    token: Address
    currentMaxLTV: bigint
    tempLtv: bigint
    maxThresholdToDelay: bigint
    enabled: boolean
    isInOnboarding: boolean
    onboardingWindowEnd: bigint | number
    supplyCapRegistered: boolean
    supplyCap: bigint
    currentSupply: bigint
  },
): EvmCollateralParams {
  return {
    denom: r.denom,
    token: r.token,
    currentMaxLTV: r.currentMaxLTV,
    tempLtv: r.tempLtv,
    maxThresholdToDelay: r.maxThresholdToDelay,
    enabled: r.enabled,
    isInOnboarding: r.isInOnboarding,
    onboardingWindowEnd: BigInt(r.onboardingWindowEnd),
    supplyCapRegistered: r.supplyCapRegistered,
    supplyCap: r.supplyCap,
    currentSupply: r.currentSupply,
  }
}

// ---------------------------------------------------------------------------
// Collateral params
// ---------------------------------------------------------------------------

/**
 * Every registered collateral's params in one call. The queryable-plus-LTV superset of the
 * Cosmos `Basket` (collateral_supply_caps + per-asset max_LTV that used to require a
 * separate Collateral read). Consumers that want the legacy basket shape should use
 * services/chain/cdp.ts `getBasket`, which reshapes this output.
 */
export async function getAllCollateralParams(
  client: PublicClient | null,
  contractAddr?: Address,
): Promise<EvmCollateralParams[] | null> {
  if (!client) return null
  const address = lensAddress(client, contractAddr)
  if (!address) return null
  try {
    const out = await client.readContract({
      address,
      abi: frontendLensAbi,
      functionName: 'getAllCollateralParams',
    })
    return out.map(toCollateralParams)
  } catch (error) {
    console.error('Error querying FrontendLens getAllCollateralParams:', error)
    return null
  }
}

/** Paginated slice of the collateral roster (start index + count). */
export async function getCollateralParamsRange(
  client: PublicClient | null,
  start: bigint,
  count: bigint,
  contractAddr?: Address,
): Promise<EvmCollateralParams[] | null> {
  if (!client) return null
  const address = lensAddress(client, contractAddr)
  if (!address) return null
  try {
    const out = await client.readContract({
      address,
      abi: frontendLensAbi,
      functionName: 'getCollateralParamsRange',
      args: [start, count],
    })
    return out.map(toCollateralParams)
  } catch (error) {
    console.error('Error querying FrontendLens getCollateralParamsRange:', error)
    return null
  }
}

// ---------------------------------------------------------------------------
// denom ⇄ token bridges
// ---------------------------------------------------------------------------

/** ERC20 token address for a bytes32 collateral denom key (zero address if unset). */
export async function tokenOf(
  client: PublicClient | null,
  denom: Bytes32,
  contractAddr?: Address,
): Promise<Address | null> {
  if (!client) return null
  const address = lensAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: frontendLensAbi,
      functionName: 'tokenOf',
      args: [denom],
    })
  } catch (error) {
    console.error('Error querying FrontendLens tokenOf:', error)
    return null
  }
}

/** bytes32 collateral denom key for an ERC20 token address (zero bytes if unregistered). */
export async function denomOf(
  client: PublicClient | null,
  token: Address,
  contractAddr?: Address,
): Promise<Bytes32 | null> {
  if (!client) return null
  const address = lensAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: frontendLensAbi,
      functionName: 'denomOf',
      args: [token],
    })
  } catch (error) {
    console.error('Error querying FrontendLens denomOf:', error)
    return null
  }
}

// ---------------------------------------------------------------------------
// Fee auctions
// ---------------------------------------------------------------------------

/**
 * All currently-live fee auctions in one call — the lens pre-filters to live auctions and
 * returns {denom, amount, startTime}. This is the primary source for services/chain/auction.ts
 * getLiveFeeAuctions; the event-reconstruction path there is the fallback when the lens
 * address is not configured.
 */
export async function liveFeeAuctions(
  client: PublicClient | null,
  contractAddr?: Address,
): Promise<EvmLiveAuction[] | null> {
  if (!client) return null
  const address = lensAddress(client, contractAddr)
  if (!address) return null
  try {
    const out = await client.readContract({
      address,
      abi: frontendLensAbi,
      functionName: 'liveFeeAuctions',
    })
    return out.map((a) => ({ denom: a.denom, amount: a.amount, startTime: BigInt(a.startTime) }))
  } catch (error) {
    console.error('Error querying FrontendLens liveFeeAuctions:', error)
    return null
  }
}

// ---------------------------------------------------------------------------
// ERC20 metadata (for collateral tokens not yet in config/evm/tokens.ts)
// ---------------------------------------------------------------------------

/**
 * symbol / decimals / name for an ERC20, so collateral tokens render even before the static
 * token registry lists them. Multicall-batched by the public client. Returns null on failure.
 */
export async function getErc20Metadata(
  client: PublicClient | null,
  token: Address,
): Promise<Erc20Metadata | null> {
  if (!client) return null
  try {
    const [symbol, decimals, name] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
      client.readContract({ address: token, abi: erc20Abi, functionName: 'name' }),
    ])
    return { address: token, symbol, decimals, name }
  } catch (error) {
    console.error('Error querying ERC20 metadata:', error)
    return null
  }
}
