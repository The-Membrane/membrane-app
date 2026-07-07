import type { PublicClient } from 'viem'
import { oracleAbi } from '@/contracts/abis/oracle'
import { twalOracleAbi } from '@/contracts/abis/twalOracle'
import { getContractAddress, type Address } from '@/config/evm/contracts'

/**
 * Oracle.sol / TwalOracle.sol read service.
 * Follows the service contract (see .claude/skills/hook-query-patterns and
 * services/chain/cdp.ts): null on failure, never throw; optional address override
 * with config fallback; reads work with no wallet connected.
 *
 * Migration counterpart: services/oracle.ts (CosmWasm OracleQueryClient). The big
 * shift is asset identity: the CosmWasm oracle was keyed by denom string (AssetInfo),
 * the EVM Oracle is keyed by a bytes32 asset identity. This service exposes the API
 * the way the ABI actually is (bytes32 keys). Legacy denom-keyed callers cannot be
 * adapted trivially — there is no on-chain denom→bytes32 registry (the oracle/
 * DenomResolver.sol library only normalizes the USD/USDC/USDT *quote* denomination,
 * not asset identity) — so those adapters are TODO-stubbed below.
 */

/** bytes32 asset identity key used by Oracle.sol / TwalOracle.sol. */
export type AssetKey = `0x${string}`

/** A single asset price reading, USD-scaled 1e18. */
export type OraclePrice = {
  /** USD price, 1e18-scaled (uint256). */
  price: bigint
  /** unix seconds of the reading. */
  timestamp: bigint
}

/**
 * Legacy denom-keyed price shape (structurally the CosmWasm services/oracle.ts
 * `Price`). Retained only to keep the denom-keyed adapter's interface contract so
 * existing consumers (`prices?.find(p => p.denom === ...)`) still type-check.
 */
export type DenomPrice = {
  price: string
  denom: string
}

function oracleAddress(client: PublicClient, override?: Address): Address | undefined {
  return override ?? (client.chain ? getContractAddress(client.chain.id, 'oracle') : undefined)
}

function twalOracleAddress(client: PublicClient, override?: Address): Address | undefined {
  return override ?? (client.chain ? getContractAddress(client.chain.id, 'twalOracle') : undefined)
}

// ---------------------------------------------------------------------------
// Oracle.sol — price reads (bytes32-keyed, the authoritative API)
// ---------------------------------------------------------------------------

/**
 * Canonical USD price for an asset (Oracle.getPrice).
 * Migration counterpart: OracleQueryClient.prices() (per-asset). Reverts on-chain
 * for stale/tripped/unconfigured assets — caught and surfaced as null.
 */
export async function getPrice(
  client: PublicClient | null,
  asset: AssetKey,
  contractAddr?: Address,
): Promise<OraclePrice | null> {
  if (!client) return null
  const address = oracleAddress(client, contractAddr)
  if (!address) return null
  try {
    const [price, timestamp] = await client.readContract({
      address,
      abi: oracleAbi,
      functionName: 'getPrice',
      args: [asset],
    })
    return { price, timestamp }
  } catch (error) {
    console.error('Error querying Oracle getPrice:', error)
    return null
  }
}

/**
 * Batch price fetch (Oracle.getPrice per asset).
 * Migration counterpart: OracleQueryClient.prices() over an AssetInfo[]. Uses the
 * public client's multicall batching (client.ts). Individual failures resolve to
 * null for that asset rather than failing the whole batch.
 */
export async function getPrices(
  client: PublicClient | null,
  assets: AssetKey[],
  contractAddr?: Address,
): Promise<Array<{ asset: AssetKey; price: OraclePrice | null }> | null> {
  if (!client) return null
  if (!assets.length) return []
  const address = oracleAddress(client, contractAddr)
  if (!address) return null
  const results = await Promise.all(
    assets.map(async (asset) => ({ asset, price: await getPrice(client, asset, address) })),
  )
  return results
}

/** Median-of-routes TWAP price without the fallback/deviation gating (Oracle.getMedianRoutePrice). */
export async function getMedianRoutePrice(
  client: PublicClient | null,
  asset: AssetKey,
  contractAddr?: Address,
): Promise<bigint | null> {
  if (!client) return null
  const address = oracleAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: oracleAbi,
      functionName: 'getMedianRoutePrice',
      args: [asset],
    })
  } catch (error) {
    console.error('Error querying Oracle getMedianRoutePrice:', error)
    return null
  }
}

/** Whether the asset's price passes the on-chain freshness/deviation safety checks (Oracle.isPriceSafe). */
export async function getIsPriceSafe(
  client: PublicClient | null,
  asset: AssetKey,
  contractAddr?: Address,
): Promise<boolean | null> {
  if (!client) return null
  const address = oracleAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: oracleAbi,
      functionName: 'isPriceSafe',
      args: [asset],
    })
  } catch (error) {
    console.error('Error querying Oracle isPriceSafe:', error)
    return null
  }
}

/**
 * Per-asset oracle source config (Oracle.sources).
 * Migration counterpart: OracleQueryClient.assets() — the EVM shape is a Uniswap-V3
 * source tuple (pool address + twap window), not the CosmWasm pool-ID list.
 */
export async function getSource(
  client: PublicClient | null,
  asset: AssetKey,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = oracleAddress(client, contractAddr)
  if (!address) return null
  try {
    const [uniswapPool, twapSecs, uniswapInverted, decimals, isUsdPar] = await client.readContract({
      address,
      abi: oracleAbi,
      functionName: 'sources',
      args: [asset],
    })
    return { uniswapPool, twapSecs, uniswapInverted, decimals, isUsdPar }
  } catch (error) {
    console.error('Error querying Oracle sources:', error)
    return null
  }
}

/**
 * Oracle configuration snapshot.
 * Migration counterpart: OracleQueryClient.config(). Oracle.sol has no single
 * config view; the equivalent scalar params are assembled from individual getters.
 */
export async function getOracleConfig(client: PublicClient | null, contractAddr?: Address) {
  if (!client) return null
  const address = oracleAddress(client, contractAddr)
  if (!address) return null
  try {
    const [fallbackStalenessS, maxDeviationPct, cbTripThresholdPct] = await Promise.all([
      client.readContract({ address, abi: oracleAbi, functionName: 'fallbackStalenessS' }),
      client.readContract({ address, abi: oracleAbi, functionName: 'maxDeviationPct' }),
      client.readContract({ address, abi: oracleAbi, functionName: 'cbTripThresholdPct' }),
    ])
    return { fallbackStalenessS, maxDeviationPct, cbTripThresholdPct }
  } catch (error) {
    console.error('Error querying Oracle config:', error)
    return null
  }
}

// ---------------------------------------------------------------------------
// TwalOracle.sol — time-weighted average liquidity reads (bytes32-keyed)
// ---------------------------------------------------------------------------

/** TWAL over the default window (TwalOracle.queryTwal). No CosmWasm counterpart. */
export async function getTwal(
  client: PublicClient | null,
  asset: AssetKey,
  contractAddr?: Address,
): Promise<bigint | null> {
  if (!client) return null
  const address = twalOracleAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: twalOracleAbi,
      functionName: 'queryTwal',
      args: [asset],
    })
  } catch (error) {
    console.error('Error querying TwalOracle queryTwal:', error)
    return null
  }
}

/** TWAL over a caller-supplied lookback window (TwalOracle.getTimeWeightedAverageLiquidity). */
export async function getTimeWeightedAverageLiquidity(
  client: PublicClient | null,
  asset: AssetKey,
  lookbackSeconds: bigint,
  contractAddr?: Address,
): Promise<bigint | null> {
  if (!client) return null
  const address = twalOracleAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: twalOracleAbi,
      functionName: 'getTimeWeightedAverageLiquidity',
      args: [asset, lookbackSeconds],
    })
  } catch (error) {
    console.error('Error querying TwalOracle getTimeWeightedAverageLiquidity:', error)
    return null
  }
}

// ---------------------------------------------------------------------------
// Legacy denom-keyed adapters (stubs — no invented mappings)
// ---------------------------------------------------------------------------

/**
 * Port of services/oracle.ts getOraclePrices(basket) — returns denom-keyed prices.
 *
 * STUB: the EVM Oracle is keyed by bytes32 asset identity and there is no on-chain
 * denom-string → bytes32 registry, so a trivial denom→price adapter is impossible.
 * Callers must migrate to getPrice/getPrices with bytes32 AssetKeys.
 */
export async function getOraclePricesByDenom(
  _client: PublicClient | null,
): Promise<DenomPrice[] | null> {
  // TODO(evm-migration): no denom-string → bytes32 asset-key mapping exists on-chain
  // (DenomResolver only normalizes the USD/USDC/USDT quote denomination). Migrate
  // callers to getPrice(client, assetKey: bytes32).
  return null
}

/**
 * Port of services/oracle.ts getOracleAssetInfos(assetInfos) — denom-keyed source config.
 *
 * STUB: same denom→bytes32 gap as above, and the EVM source shape (Uniswap-V3 pool
 * tuple) differs from the CosmWasm pool-ID list the legacy consumers expect.
 */
export async function getOracleSourcesByDenom(
  _client: PublicClient | null,
): Promise<null> {
  // TODO(evm-migration): no denom-string → bytes32 asset-key mapping; and source
  // shape changed (uniswapPool tuple, not pool IDs). Migrate callers to
  // getSource(client, assetKey: bytes32).
  return null
}
