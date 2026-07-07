import type { PublicClient } from 'viem'
import { stringToHex, toHex, keccak256, size as byteSize } from 'viem'
import { transmuterAbi } from '@/contracts/abis/transmuter'
import { getContractAddress, type Address } from '@/config/evm/contracts'

/**
 * Transmuter.sol read service (EVM) — the Earn/vault domain's read seam. Replaces the
 * CosmWasm reads in services/earn.ts (EarnQueryClient / marsUSDCvault / autoStabilityPool
 * / rangeboundLP) and services/transmuter.ts (the legacy Cosmos WIP file, left untouched).
 *
 * Follows the service contract (see .claude/skills/hook-query-patterns, services/chain/README.md
 * and cdp.ts): null on failure, never throw; optional address override with config fallback;
 * works with no wallet connected.
 *
 * IMPORTANT DESIGN CONTEXT (membrane-solidity/contracts/Transmuter.sol): the port's Transmuter
 * is a PSM-style swap facility whose TRANCHE CAPITAL *IS* the swap inventory. There is no
 * Cosmos-style "Earn vault" (Mars-USDC looped CDP), no rangebound LP, and no external
 * lending-market APR. Two-sided liquidity is CDT (`cdtSideTotal`) + paired asset
 * (`pairedSideTotal`); composition is steered by `cdtTargetRatio`/`compositionLeeway`
 * (deposit-gating), NOT by reserving stake. Only `seniorRefillEscrow` is reserved.
 * Consequently many Cosmos "vault" reads have NO faithful equivalent and are honest STUBs.
 *
 * Cosmos (services/earn.ts) → EVM (this file) read map:
 *   EarnQueryClient.aPR / marsUSDCvault a_p_r  → STUB (no per-vault APR view; use rate history)
 *   getUnderlyingUSDC (vaultTokenUnderlying)   → getTrancheState + getTrancheUnderlying (VT→underlying, per tranche)
 *   getEarnUSDCRealizedAPR (ClaimTracker)      → getRateHistory (conversion_rate time series)
 *   getMarsUSDCSupplyAPR (Mars red bank)       → STUB (no external lending market in the port)
 *   getBounded* (rangebound LP)                → STUB (no rangebound LP contract in the port)
 *   user deposits (vault-token balances)       → getUserTranche / getUserPrincipalBase
 *   unstake queue / intents                    → getUserSwitchingIntents / getSwitchingIntent
 *   vault TVL                                  → getVaultInfoForAcquisition / getCdtSideTotal + getPairedSideTotal
 */

// bytes32 asset key used throughout Transmuter.sol (right-padded ASCII denom / keccak).
type Bytes32 = `0x${string}`

function transmuterAddress(client: PublicClient, override?: Address): Address | undefined {
  return override ?? (client.chain ? getContractAddress(client.chain.id, 'transmuter') : undefined)
}

/**
 * Derive the Transmuter `bytes32` asset key from a denom/symbol string. Same convention as
 * LiqQueue/CDP (services/chain/liquidation.ts:assetKey): short keys are right-padded ASCII
 * (Solidity `bytes32("cdt")` === `stringToHex('cdt', {size:32})`); >32 bytes falls back to
 * keccak so this never throws.
 *
 * TODO(evm-migration): the canonical denom→bytes32 convention is deployment-defined and
 * opaque on-chain; confirm against the actual deployment/registry before relying on it for
 * write paths. Reads simply return null when the key/addresses are unset.
 */
export function assetKey(denomOrSymbol: string): Bytes32 {
  const raw = denomOrSymbol ?? ''
  try {
    if (byteSize(toHex(raw)) <= 32) return stringToHex(raw, { size: 32 })
  } catch {
    /* fall through to keccak */
  }
  return keccak256(toHex(raw))
}

// ---------------------------------------------------------------------------
// Vault totals / composition (the "TVL" surface)
// ---------------------------------------------------------------------------

/** Total CDT-side inventory (base units, 18-dec CDT). */
export async function getCdtSideTotal(client: PublicClient | null, contractAddr?: Address) {
  if (!client) return null
  const address = transmuterAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({ address, abi: transmuterAbi, functionName: 'cdtSideTotal' })
  } catch (error) {
    console.error('Error querying Transmuter cdtSideTotal:', error)
    return null
  }
}

/** Total paired-asset-side inventory (base units of the paired asset). */
export async function getPairedSideTotal(client: PublicClient | null, contractAddr?: Address) {
  if (!client) return null
  const address = transmuterAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({ address, abi: transmuterAbi, functionName: 'pairedSideTotal' })
  } catch (error) {
    console.error('Error querying Transmuter pairedSideTotal:', error)
    return null
  }
}

/** Protocol-wide staked tranche total (sum across all tranches). */
export async function getTotalTrancheStaked(client: PublicClient | null, contractAddr?: Address) {
  if (!client) return null
  const address = transmuterAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: transmuterAbi,
      functionName: 'totalTrancheStaked',
    })
  } catch (error) {
    console.error('Error querying Transmuter totalTrancheStaked:', error)
    return null
  }
}

/** Staked amount for a single collateral tranche (both junior+senior). */
export async function getTrancheTotalStaked(
  client: PublicClient | null,
  asset: Bytes32,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = transmuterAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: transmuterAbi,
      functionName: 'trancheTotalStaked',
      args: [asset],
    })
  } catch (error) {
    console.error('Error querying Transmuter trancheTotalStaked:', error)
    return null
  }
}

/** Target CDT composition ratio (1e18-fractional) — deposit-gating steer, not a reserve. */
export async function getCdtTargetRatio(client: PublicClient | null, contractAddr?: Address) {
  if (!client) return null
  const address = transmuterAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({ address, abi: transmuterAbi, functionName: 'cdtTargetRatio' })
  } catch (error) {
    console.error('Error querying Transmuter cdtTargetRatio:', error)
    return null
  }
}

/** Composition leeway band around the target ratio (1e18-fractional). */
export async function getCompositionLeeway(client: PublicClient | null, contractAddr?: Address) {
  if (!client) return null
  const address = transmuterAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: transmuterAbi,
      functionName: 'compositionLeeway',
    })
  } catch (error) {
    console.error('Error querying Transmuter compositionLeeway:', error)
    return null
  }
}

export type EvmVaultInfoForAcquisition = {
  totalDepositValue: bigint
  pairedAssetBalance: bigint
}

/**
 * Aggregate vault value view — the closest EVM equivalent of the Cosmos "vault TVL" the
 * Earn page displayed. Returns (totalDepositValue, pairedAssetBalance). NOTE: this is the
 * value surface the acquisition module reads; there is no separate "leverage / debt / cost"
 * breakdown like useVaultInfo() computed for the Mars-USDC looped CDP (that vault does not
 * exist in the port).
 */
export async function getVaultInfoForAcquisition(
  client: PublicClient | null,
  contractAddr?: Address,
): Promise<EvmVaultInfoForAcquisition | null> {
  if (!client) return null
  const address = transmuterAddress(client, contractAddr)
  if (!address) return null
  try {
    const r = await client.readContract({
      address,
      abi: transmuterAbi,
      functionName: 'vaultInfoForAcquisition',
    })
    return { totalDepositValue: r[0], pairedAssetBalance: r[1] }
  } catch (error) {
    console.error('Error querying Transmuter vaultInfoForAcquisition:', error)
    return null
  }
}

// ---------------------------------------------------------------------------
// Rate / APR surface (rate history — the only on-chain yield time series)
// ---------------------------------------------------------------------------

export type EvmRatePoint = {
  timestamp: bigint
  conversionRate: bigint
}

/** Length of the append-only conversion-rate history. */
export async function getRateHistoryLength(client: PublicClient | null, contractAddr?: Address) {
  if (!client) return null
  const address = transmuterAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: transmuterAbi,
      functionName: 'rateHistoryLength',
    })
  } catch (error) {
    console.error('Error querying Transmuter rateHistoryLength:', error)
    return null
  }
}

/** Single conversion-rate history entry by index: (timestamp, conversion_rate). */
export async function getRateHistoryAt(
  client: PublicClient | null,
  index: bigint,
  contractAddr?: Address,
): Promise<EvmRatePoint | null> {
  if (!client) return null
  const address = transmuterAddress(client, contractAddr)
  if (!address) return null
  try {
    const r = await client.readContract({
      address,
      abi: transmuterAbi,
      functionName: 'rateHistory',
      args: [index],
    })
    return { timestamp: r[0], conversionRate: r[1] }
  } catch (error) {
    console.error('Error querying Transmuter rateHistory:', error)
    return null
  }
}

/**
 * Full conversion-rate history (bounded), composed from rateHistoryLength + rateHistory(i)
 * and multicall-batched by the public client. This is the yield time series that replaces
 * the Cosmos ClaimTracker (getEarnUSDCRealizedAPR): realized APR is derived off-chain by
 * differencing conversion_rate across timestamps. `maxPoints` caps the read cost.
 */
export async function getRateHistory(
  client: PublicClient | null,
  maxPoints = 512n,
  contractAddr?: Address,
): Promise<EvmRatePoint[] | null> {
  if (!client) return null
  const address = transmuterAddress(client, contractAddr)
  if (!address) return null
  try {
    const len = await client.readContract({
      address,
      abi: transmuterAbi,
      functionName: 'rateHistoryLength',
    })
    const count = len < maxPoints ? len : maxPoints
    const start = len - count
    const points: EvmRatePoint[] = []
    for (let i = start; i < len; i++) {
      const r = await client.readContract({
        address,
        abi: transmuterAbi,
        functionName: 'rateHistory',
        args: [i],
      })
      points.push({ timestamp: r[0], conversionRate: r[1] })
    }
    return points
  } catch (error) {
    console.error('Error querying Transmuter rate history:', error)
    return null
  }
}

/** Unix timestamp (uint64) of the last rate-history append. */
export async function getLastRateUpdate(client: PublicClient | null, contractAddr?: Address) {
  if (!client) return null
  const address = transmuterAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({ address, abi: transmuterAbi, functionName: 'lastRateUpdate' })
  } catch (error) {
    console.error('Error querying Transmuter lastRateUpdate:', error)
    return null
  }
}

/** Cumulative swap volume (CDT-denominated). */
export async function getCumulativeVolume(client: PublicClient | null, contractAddr?: Address) {
  if (!client) return null
  const address = transmuterAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: transmuterAbi,
      functionName: 'cumulativeVolume',
    })
  } catch (error) {
    console.error('Error querying Transmuter cumulativeVolume:', error)
    return null
  }
}

// ---------------------------------------------------------------------------
// User deposits (tranche shares) + VT→underlying conversion
// ---------------------------------------------------------------------------

/**
 * A user's vault-token (share) balance in a single (asset, junior) tranche.
 * `junior=false` is the senior tranche. Replaces the Cosmos per-user vault-token balance.
 */
export async function getUserTranche(
  client: PublicClient | null,
  user: Address,
  asset: Bytes32,
  junior: boolean,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = transmuterAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: transmuterAbi,
      functionName: 'userTranches',
      args: [user, asset, junior],
    })
  } catch (error) {
    console.error('Error querying Transmuter userTranches:', error)
    return null
  }
}

/** A user's principal base (deposit cost basis, CDT-denominated) across their tranches. */
export async function getUserPrincipalBase(
  client: PublicClient | null,
  user: Address,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = transmuterAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: transmuterAbi,
      functionName: 'userPrincipalBase',
      args: [user],
    })
  } catch (error) {
    console.error('Error querying Transmuter userPrincipalBase:', error)
    return null
  }
}

export type EvmTrancheState = {
  vaultTokenSupply: bigint
  totalStaked: bigint
}

/**
 * Per-tranche accounting: (vault_token_supply, total_staked). The VT→underlying conversion
 * for a tranche is `vtAmount * total_staked / vault_token_supply` — this is what replaces
 * the Cosmos `vault_token_underlying` query (getUnderlyingUSDC). See getTrancheUnderlying.
 */
export async function getTrancheState(
  client: PublicClient | null,
  asset: Bytes32,
  junior: boolean,
  contractAddr?: Address,
): Promise<EvmTrancheState | null> {
  if (!client) return null
  const address = transmuterAddress(client, contractAddr)
  if (!address) return null
  try {
    const r = await client.readContract({
      address,
      abi: transmuterAbi,
      functionName: 'trancheStates',
      args: [asset, junior],
    })
    return { vaultTokenSupply: r[0], totalStaked: r[1] }
  } catch (error) {
    console.error('Error querying Transmuter trancheStates:', error)
    return null
  }
}

/**
 * VT→underlying conversion for a tranche, computed from trancheStates. Replaces the Cosmos
 * `vault_token_underlying` contract query (there is NO equivalent view function on
 * Transmuter.sol — the conversion is a pure ratio over trancheStates). Returns 0n when the
 * tranche has no supply.
 */
export async function getTrancheUnderlying(
  client: PublicClient | null,
  asset: Bytes32,
  junior: boolean,
  vtAmount: bigint,
  contractAddr?: Address,
): Promise<bigint | null> {
  const state = await getTrancheState(client, asset, junior, contractAddr)
  if (!state) return null
  if (state.vaultTokenSupply === 0n) return 0n
  return (vtAmount * state.totalStaked) / state.vaultTokenSupply
}

// ---------------------------------------------------------------------------
// Unstaking queue (switching intents) — the "unbonding queue" surface
// ---------------------------------------------------------------------------

export type EvmSwitchingIntent = {
  id: bigint
  user: Address
  /** enum IntentKind: 0 JuniorToSenior, 1 JuniorExit, 2 SeniorOnboardingExit, 3 RemoveAsset. */
  kind: number
  data: Bytes32 | `0x${string}`
  createdAt: bigint
  unlockTime: bigint
  expireTime: bigint
}

/** Next intent id (== total intents ever created; upper bound for enumeration). */
export async function getNextIntentId(client: PublicClient | null, contractAddr?: Address) {
  if (!client) return null
  const address = transmuterAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({ address, abi: transmuterAbi, functionName: 'nextIntentId' })
  } catch (error) {
    console.error('Error querying Transmuter nextIntentId:', error)
    return null
  }
}

/** A single switching (unstake) intent by id. `user == zeroAddress` means consumed/absent. */
export async function getSwitchingIntent(
  client: PublicClient | null,
  id: bigint,
  contractAddr?: Address,
): Promise<EvmSwitchingIntent | null> {
  if (!client) return null
  const address = transmuterAddress(client, contractAddr)
  if (!address) return null
  try {
    const r = await client.readContract({
      address,
      abi: transmuterAbi,
      functionName: 'switchingIntents',
      args: [id],
    })
    return {
      id: r[0],
      user: r[1] as Address,
      kind: Number(r[2]),
      data: r[3] as `0x${string}`,
      createdAt: r[4],
      unlockTime: r[5],
      expireTime: r[6],
    }
  } catch (error) {
    console.error('Error querying Transmuter switchingIntents:', error)
    return null
  }
}

/** Whether `user` owns the intent at `id` (userIntentIndex mapping). */
export async function hasUserIntent(
  client: PublicClient | null,
  user: Address,
  id: bigint,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = transmuterAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: transmuterAbi,
      functionName: 'userIntentIndex',
      args: [user, id],
    })
  } catch (error) {
    console.error('Error querying Transmuter userIntentIndex:', error)
    return null
  }
}

/**
 * All pending switching (unstake) intents for a user — the EVM "unstaking queue". Transmuter.sol
 * has no per-user intent-list view, so we enumerate ids [0, nextIntentId) and keep those the
 * user owns (userIntentIndex) and that are still live (getSwitchingIntent returns non-zero
 * user; consumed/pruned intents are deleted). Bounded by nextIntentId and `maxScan`.
 *
 * NOTE: O(nextIntentId) reads (multicall-batched). For a large id space this should move to an
 * event-indexed source; acceptable while intent volume is low.
 */
export async function getUserSwitchingIntents(
  client: PublicClient | null,
  user: Address,
  maxScan = 1024n,
  contractAddr?: Address,
): Promise<EvmSwitchingIntent[] | null> {
  if (!client) return null
  const address = transmuterAddress(client, contractAddr)
  if (!address) return null
  try {
    const next = await client.readContract({
      address,
      abi: transmuterAbi,
      functionName: 'nextIntentId',
    })
    const upper = next < maxScan ? next : maxScan
    const intents: EvmSwitchingIntent[] = []
    for (let id = 0n; id < upper; id++) {
      const owns = await client.readContract({
        address,
        abi: transmuterAbi,
        functionName: 'userIntentIndex',
        args: [user, id],
      })
      if (!owns) continue
      const intent = await getSwitchingIntent(client, id, contractAddr)
      // Skip consumed/pruned intents (deleted → zero user).
      if (intent && intent.user.toLowerCase() === user.toLowerCase()) intents.push(intent)
    }
    return intents
  } catch (error) {
    console.error('Error querying Transmuter user switching intents:', error)
    return null
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type EvmTransmuterConfig = {
  discountsContract: Address
  cdpContract: Address
  collateralContract: Address
  acquisitionContract: Address
  revenueDistributor: Address
  cdtDenom: Bytes32
  pairedAssetDenom: Bytes32
  usageFee: bigint
  affiliateFee: bigint
  sendSwapFee: boolean
  revenueDistributorFeePercentage: bigint
  maxManagementFee: bigint
  switchingPeriod: bigint
  switchingExecutionWindow: bigint
}

/**
 * Full operational config. Notably exposes `usage_fee` (the swap/transmute fee),
 * `cdt_denom` / `paired_asset_denom` (the bytes32 asset keys the vault trades), and the
 * `switching_period` / `switching_execution_window` that time the unstake queue.
 */
export async function getConfig(
  client: PublicClient | null,
  contractAddr?: Address,
): Promise<EvmTransmuterConfig | null> {
  if (!client) return null
  const address = transmuterAddress(client, contractAddr)
  if (!address) return null
  try {
    const r = await client.readContract({ address, abi: transmuterAbi, functionName: 'config' })
    return {
      discountsContract: r[0] as Address,
      cdpContract: r[1] as Address,
      collateralContract: r[2] as Address,
      acquisitionContract: r[3] as Address,
      revenueDistributor: r[4] as Address,
      cdtDenom: r[5] as Bytes32,
      pairedAssetDenom: r[6] as Bytes32,
      usageFee: r[7],
      affiliateFee: r[8],
      sendSwapFee: r[9],
      revenueDistributorFeePercentage: r[10],
      maxManagementFee: r[11],
      switchingPeriod: r[12],
      switchingExecutionWindow: r[13],
    }
  } catch (error) {
    console.error('Error querying Transmuter config:', error)
    return null
  }
}

// ---------------------------------------------------------------------------
// Stubs — Cosmos "Earn vault" reads with NO Transmuter.sol equivalent
// (do NOT invent mappings — the port has a different economic model)
// ---------------------------------------------------------------------------

/**
 * Cosmos getVaultAPRResponse / getEarnUSDCRealizedAPR returned an APRResponse / ClaimTracker
 * for the Mars-USDC looped Earn vault.
 * TODO(evm-migration): the port has NO per-vault APR view and no ClaimTracker. Realized yield
 * must be derived off-chain from the conversion-rate time series (getRateHistory) by
 * differencing `conversion_rate` over `timestamp`. Left as a stub so callers migrate to
 * getRateHistory rather than expecting a ready-made APR scalar.
 */
export async function getVaultAPR(_client: PublicClient | null, _contractAddr?: Address) {
  return null
}

/**
 * Cosmos getMarsUSDCSupplyAPR read the external Mars red-bank lending market.
 * TODO(evm-migration): there is no external lending-market integration in the port (the
 * Transmuter is a self-contained PSM). No equivalent exists — stub.
 */
export async function getExternalSupplyAPR(_client: PublicClient | null, _contractAddr?: Address) {
  return null
}

/**
 * Cosmos getBoundedConfig / getBoundedTVL / getBoundedIntents / getBoundedUnderlyingCDT read
 * the rangebound-LP vault contract.
 * TODO(evm-migration): there is no rangebound-LP contract in the port. All rangebound reads
 * are stubs until (and if) that vault is ported.
 */
export async function getBoundedVault(_client: PublicClient | null, _contractAddr?: Address) {
  return null
}

/**
 * Cosmos useVaultInfo() reconstructed the Mars-USDC looped-CDP position (collateral value,
 * debt, leverage, cost) for the Earn page.
 * TODO(evm-migration): that leveraged vault does not exist in the port. The value surface that
 * DOES exist is getVaultInfoForAcquisition() (totalDepositValue + pairedAssetBalance) plus the
 * two-sided totals (getCdtSideTotal / getPairedSideTotal); there is no leverage/debt/cost
 * breakdown to reproduce. Stubbed so callers compose the real reads instead.
 */
export async function getVaultInfo(_client: PublicClient | null, _contractAddr?: Address) {
  return null
}

/**
 * Cosmos CDP redemption (redeem CDT for collateral at a premium) drove useCDPRedeem.
 * TODO(evm-migration): Cdp.sol has no redemption surface (see services/chain/cdp.ts
 * getUserRedemptionInfo) and the user-facing CDT→paired `transmute` direction is restricted to
 * the CDP/self (CdtToPairedRestricted). There is no user-callable "redeem CDT" path in the
 * port. Stubbed until redemption lands.
 */
export async function getUserRedemptionInfo(
  _client: PublicClient | null,
  _user: Address,
  _contractAddr?: Address,
) {
  return null
}
