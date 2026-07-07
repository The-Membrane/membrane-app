import type { PublicClient } from 'viem'
import { formatEther } from 'viem'
import { cdpAbi } from '@/contracts/abis/cdp'
import { getContractAddress, type Address } from '@/config/evm/contracts'
import { getAllCollateralParams, type EvmCollateralParams } from './lens'

/**
 * Cdp.sol read service — the reference implementation for the EVM service layer.
 * Follows the existing service contract (see .claude/skills/hook-query-patterns):
 * null on failure, never throw; optional address override with config fallback.
 *
 * Migration counterpart: services/cdp.ts (queryContractSmart against the CosmWasm
 * positions contract). The pure data-transform helpers in that file (getBasketAssets,
 * getPositions, getTVL, calculateVaultSummary, …) stay there; only the network reads
 * (queryContractSmart / PositionsQueryClient calls) move here.
 *
 * IMPORTANT shape note: CosmWasm returned deeply-nested JSON (Basket, BasketPositions
 * with AssetInfo.native_token.denom, decimal-string amounts). Cdp.sol returns flat
 * Solidity structs — bytes32 asset denoms and bigint (base-unit) amounts. These EVM
 * services return the raw Solidity shapes; consumers that still expect the CosmWasm
 * shape must be adapted at their call sites (tracked as consumer breakage).
 */

// bytes32 asset key used throughout Cdp.sol (keccak/padded denom identifier).
type Bytes32 = `0x${string}`

function cdpAddress(client: PublicClient, override?: Address): Address | undefined {
  return override ?? (client.chain ? getContractAddress(client.chain.id, 'cdp') : undefined)
}

// ---------------------------------------------------------------------------
// Simple scalar reads (clean 1:1 view mappings)
// ---------------------------------------------------------------------------

/** Total CDT minted against the CDP (protocol-wide, public — no wallet required). */
export async function getCreditMinted(client: PublicClient | null, contractAddr?: Address) {
  if (!client) return null
  const address = cdpAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({ address, abi: cdpAbi, functionName: 'creditMinted' })
  } catch (error) {
    console.error('Error querying CDP creditMinted:', error)
    return null
  }
}

/** Current adaptive borrow rate for a collateral denom (bytes32 asset key; public). */
export async function getCurrentAdaptiveRate(
  client: PublicClient | null,
  assetDenom: Bytes32,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = cdpAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: cdpAbi,
      functionName: 'currentAdaptiveRate',
      args: [assetDenom],
    })
  } catch (error) {
    console.error('Error querying CDP currentAdaptiveRate:', error)
    return null
  }
}

/**
 * Current credit (CDT) price snapshot, 1e18-fractional.
 * Cosmos counterpart: `Basket.credit_price.price` (read via getBasket().credit_price).
 */
export async function getCreditPrice(client: PublicClient | null, contractAddr?: Address) {
  if (!client) return null
  const address = cdpAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({ address, abi: cdpAbi, functionName: 'creditPriceSnapshot' })
  } catch (error) {
    console.error('Error querying CDP creditPriceSnapshot:', error)
    return null
  }
}

export type EvmRatesConfig = {
  baseInterestRate: bigint
  maxAdaptiveRate: bigint
  minAdaptiveRate: bigint
  cpcMultiplier: bigint
  cpcMarginOfError: bigint
  acquisitionBumpRate: bigint
  adjustmentSpeed: bigint
}

/**
 * Global rate configuration (base rate, adaptive-rate bounds, CPC params).
 * Closest clean equivalent to the Cosmos `getRates()` aggregate; per-asset
 * borrow rates come from getCurrentAdaptiveRate / getCollateralInterest.
 */
export async function getRatesConfig(
  client: PublicClient | null,
  contractAddr?: Address,
): Promise<EvmRatesConfig | null> {
  if (!client) return null
  const address = cdpAddress(client, contractAddr)
  if (!address) return null
  try {
    const r = await client.readContract({ address, abi: cdpAbi, functionName: 'ratesConfig' })
    return {
      baseInterestRate: r[0],
      maxAdaptiveRate: r[1],
      minAdaptiveRate: r[2],
      cpcMultiplier: r[3],
      cpcMarginOfError: r[4],
      acquisitionBumpRate: r[5],
      adjustmentSpeed: r[6],
    }
  } catch (error) {
    console.error('Error querying CDP ratesConfig:', error)
    return null
  }
}

/** ERC20 token address configured for a bytes32 asset denom. */
export async function getAssetToken(
  client: PublicClient | null,
  assetDenom: Bytes32,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = cdpAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: cdpAbi,
      functionName: 'assetToken',
      args: [assetDenom],
    })
  } catch (error) {
    console.error('Error querying CDP assetToken:', error)
    return null
  }
}

/** Total CDT borrowed against a given collateral asset (bytes32 denom). */
export async function getTotalBorrowedAgainst(
  client: PublicClient | null,
  assetDenom: Bytes32,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = cdpAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: cdpAbi,
      functionName: 'totalBorrowedAgainstAsset',
      args: [assetDenom],
    })
  } catch (error) {
    console.error('Error querying CDP totalBorrowedAgainstAsset:', error)
    return null
  }
}

/** Next position id counter (also == total positions ever opened). */
export async function getCurrentPositionId(client: PublicClient | null, contractAddr?: Address) {
  if (!client) return null
  const address = cdpAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({ address, abi: cdpAbi, functionName: 'currentPositionId' })
  } catch (error) {
    console.error('Error querying CDP currentPositionId:', error)
    return null
  }
}

/**
 * CDP borrow-rate discount for a user (1e18-fractional).
 * Cosmos counterpart: getUserDiscount (system_discounts `user_discount`). Cdp.sol
 * `borrowRateDiscount` delegates to systemDiscounts.getDiscountFor(user), so this is
 * the clean 1:1 replacement — no separate systemDiscounts read needed.
 */
export async function getUserBorrowRateDiscount(
  client: PublicClient | null,
  user: Address,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = cdpAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: cdpAbi,
      functionName: 'borrowRateDiscount',
      args: [user],
    })
  } catch (error) {
    console.error('Error querying CDP borrowRateDiscount:', error)
    return null
  }
}

// ---------------------------------------------------------------------------
// Supply caps (the queryable slice of the Cosmos "basket")
// ---------------------------------------------------------------------------

export type EvmSupplyCap = {
  assetDenom: Bytes32
  cap: bigint
  current: bigint
  debtTotal: bigint
}

/** Number of registered supply caps (== number of accepted collateral denoms). */
export async function getSupplyCapsLength(client: PublicClient | null, contractAddr?: Address) {
  if (!client) return null
  const address = cdpAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({ address, abi: cdpAbi, functionName: 'supplyCapsLength' })
  } catch (error) {
    console.error('Error querying CDP supplyCapsLength:', error)
    return null
  }
}

/** Single supply-cap entry by index. */
export async function getSupplyCap(
  client: PublicClient | null,
  index: bigint,
  contractAddr?: Address,
): Promise<EvmSupplyCap | null> {
  if (!client) return null
  const address = cdpAddress(client, contractAddr)
  if (!address) return null
  try {
    const r = await client.readContract({
      address,
      abi: cdpAbi,
      functionName: 'supplyCaps',
      args: [index],
    })
    return { assetDenom: r[0], cap: r[1], current: r[2], debtTotal: r[3] }
  } catch (error) {
    console.error('Error querying CDP supplyCaps:', error)
    return null
  }
}

/**
 * All supply caps (collateral roster) — composed from supplyCapsLength + supplyCaps(i).
 * Multicall-batched by the public client. This is the queryable subset of the Cosmos
 * `Basket` (collateral_supply_caps + the set of accepted collateral denoms). It does NOT
 * include per-asset max_LTV / max_borrow_LTV (see getBasket stub below).
 */
export async function getSupplyCaps(
  client: PublicClient | null,
  contractAddr?: Address,
): Promise<EvmSupplyCap[] | null> {
  if (!client) return null
  const address = cdpAddress(client, contractAddr)
  if (!address) return null
  try {
    const len = await client.readContract({ address, abi: cdpAbi, functionName: 'supplyCapsLength' })
    const caps: EvmSupplyCap[] = []
    for (let i = 0n; i < len; i++) {
      const r = await client.readContract({
        address,
        abi: cdpAbi,
        functionName: 'supplyCaps',
        args: [i],
      })
      caps.push({ assetDenom: r[0], cap: r[1], current: r[2], debtTotal: r[3] })
    }
    return caps
  } catch (error) {
    console.error('Error querying CDP supplyCaps roster:', error)
    return null
  }
}

/**
 * Per-collateral adaptive borrow rates, aligned to the supply-cap roster order.
 * Cosmos counterpart: getCollateralInterest() (CollateralInterestResponse.rates).
 *
 * NOTE: this returns the *adaptive* component per denom (currentAdaptiveRate), which is
 * how the reference service already models the per-asset borrow rate. The flat base rate
 * lives separately in getRatesConfig().baseInterestRate; total displayed interest may
 * need base+adaptive composition depending on how Cdp.sol accrues (see TODO).
 */
export async function getCollateralInterest(
  client: PublicClient | null,
  contractAddr?: Address,
): Promise<{ denom: Bytes32; rate: bigint }[] | null> {
  if (!client) return null
  const address = cdpAddress(client, contractAddr)
  if (!address) return null
  try {
    const caps = await getSupplyCaps(client, contractAddr)
    if (!caps) return null
    const rates: { denom: Bytes32; rate: bigint }[] = []
    for (const c of caps) {
      const rate = await client.readContract({
        address,
        abi: cdpAbi,
        functionName: 'currentAdaptiveRate',
        args: [c.assetDenom],
      })
      // TODO(evm-migration): confirm whether the UI's displayed collateral interest
      // is base+adaptive; if so add getRatesConfig().baseInterestRate here. Kept as the
      // adaptive component only to match the existing getCurrentAdaptiveRate mapping.
      rates.push({ denom: c.assetDenom, rate })
    }
    return rates
  } catch (error) {
    console.error('Error querying CDP collateral interest:', error)
    return null
  }
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export type EvmPositionCollateral = {
  assets: readonly Bytes32[]
  amounts: readonly bigint[]
  ratios: readonly bigint[]
  prices: readonly bigint[]
  avgMaxLtv: bigint
  avgMaxBorrowLtv: bigint
  avgMaxThresholdToDelay: bigint
  currentLtv: bigint
  anyAssetFrozen: boolean
}

export type EvmPositionDebt = {
  totalDebt: bigint
  creditPrice: bigint
  venueRecallAmount: bigint
}

export type EvmUserPosition = {
  positionId: bigint
  collateral: EvmPositionCollateral
  debt: EvmPositionDebt
}

/** Position header: (id, owner, pendingInterest, totalAccrued, collateralLen, segmentsLen). */
export async function getPosition(
  client: PublicClient | null,
  positionId: bigint,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = cdpAddress(client, contractAddr)
  if (!address) return null
  try {
    const r = await client.readContract({
      address,
      abi: cdpAbi,
      functionName: 'position',
      args: [positionId],
    })
    return {
      id: r[0],
      owner: r[1],
      pendingInterest: r[2],
      totalAccrued: r[3],
      collateralLen: r[4],
      segmentsLen: r[5],
    }
  } catch (error) {
    console.error('Error querying CDP position:', error)
    return null
  }
}

/** Position collateral snapshot + LTV scalars (mirrors Collateral::RefreshAndAssess). */
export async function getPositionCollateral(
  client: PublicClient | null,
  positionId: bigint,
  positionOwner: Address,
  contractAddr?: Address,
): Promise<EvmPositionCollateral | null> {
  if (!client) return null
  const address = cdpAddress(client, contractAddr)
  if (!address) return null
  try {
    const r = await client.readContract({
      address,
      abi: cdpAbi,
      functionName: 'positionCollateral',
      args: [positionId, positionOwner],
    })
    return {
      assets: r[0],
      amounts: r[1],
      ratios: r[2],
      prices: r[3],
      avgMaxLtv: r[4],
      avgMaxBorrowLtv: r[5],
      avgMaxThresholdToDelay: r[6],
      currentLtv: r[7],
      anyAssetFrozen: r[8],
    }
  } catch (error) {
    console.error('Error querying CDP positionCollateral:', error)
    return null
  }
}

/** Position debt view: (totalDebt, creditPrice, venueRecallAmount). */
export async function getPositionDebt(
  client: PublicClient | null,
  positionId: bigint,
  positionOwner: Address,
  contractAddr?: Address,
): Promise<EvmPositionDebt | null> {
  if (!client) return null
  const address = cdpAddress(client, contractAddr)
  if (!address) return null
  try {
    const r = await client.readContract({
      address,
      abi: cdpAbi,
      functionName: 'positionDebt',
      args: [positionId, positionOwner],
    })
    return { totalDebt: r[0], creditPrice: r[1], venueRecallAmount: r[2] }
  } catch (error) {
    console.error('Error querying CDP positionDebt:', error)
    return null
  }
}

/** USD value of a position's collateral (1e18-fractional). */
export async function getPositionCollateralValue(
  client: PublicClient | null,
  positionId: bigint,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = cdpAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: cdpAbi,
      functionName: 'positionCollateralValue',
      args: [positionId],
    })
  } catch (error) {
    console.error('Error querying CDP positionCollateralValue:', error)
    return null
  }
}

/** Single position id owned by `user` at array index `idx`. */
export async function getUserPositionIdAt(
  client: PublicClient | null,
  user: Address,
  idx: bigint,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = cdpAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: cdpAbi,
      functionName: 'userPositionIds',
      args: [user, idx],
    })
  } catch (error) {
    // Out-of-bounds reverts are expected as the loop terminator; log others only.
    return null
  }
}

/**
 * All position ids owned by `user`. Cdp.sol exposes only the array getter
 * userPositionIds(address,uint256) with NO length accessor, so we enumerate by index
 * until an out-of-bounds revert. Capped at MAX_POSITIONS_AMOUNT (256) as a safety bound.
 */
export async function getUserPositionIds(
  client: PublicClient | null,
  user: Address,
  contractAddr?: Address,
): Promise<bigint[] | null> {
  if (!client) return null
  const address = cdpAddress(client, contractAddr)
  if (!address) return null
  const ids: bigint[] = []
  for (let i = 0n; i < 256n; i++) {
    try {
      const id = await client.readContract({
        address,
        abi: cdpAbi,
        functionName: 'userPositionIds',
        args: [user, i],
      })
      ids.push(id)
    } catch {
      // Out-of-bounds → we've read every id.
      break
    }
  }
  return ids
}

/**
 * Full positions for a user — Cosmos counterpart: getUserPositions / getBasketPositions({user}).
 * Reconstructed from getUserPositionIds + per-position getPositionCollateral + getPositionDebt.
 *
 * NOTE: returns the flat EVM shape (EvmUserPosition[]), NOT the CosmWasm
 * BasketPositionsResponse[] shape. Consumers that call the legacy getPositions/getDebt
 * transforms in services/cdp.ts must be adapted to this shape (tracked as consumer breakage).
 */
export async function getUserPositions(
  client: PublicClient | null,
  user: Address,
  contractAddr?: Address,
): Promise<EvmUserPosition[] | null> {
  if (!client) return null
  const address = cdpAddress(client, contractAddr)
  if (!address) return null
  try {
    const ids = await getUserPositionIds(client, user, contractAddr)
    if (!ids) return null
    const positions: EvmUserPosition[] = []
    for (const positionId of ids) {
      const [collateral, debt] = await Promise.all([
        getPositionCollateral(client, positionId, user, contractAddr),
        getPositionDebt(client, positionId, user, contractAddr),
      ])
      if (!collateral || !debt) continue
      positions.push({ positionId, collateral, debt })
    }
    return positions
  } catch (error) {
    console.error('Error querying CDP user positions:', error)
    return null
  }
}

// ---------------------------------------------------------------------------
// Stubs — no clean Cdp.sol view equivalent (do NOT invent mappings)
// ---------------------------------------------------------------------------

/**
 * Legacy-shaped "basket" — the minimal faithful subset the surviving Cosmos-era consumers
 * read (components/Bid/hooks/useCollateralAssets, hooks/useEarnQueries → getBasketAssets):
 * `collateral_types[]` (asset identity + per-asset LTVs) and `collateral_supply_caps[]`.
 *
 * Backed by FrontendLens.getAllCollateralParams (services/chain/lens.ts), which aggregates
 * Collateral.sol + Cdp.sol so we no longer need a separate Collateral read.
 *
 * PRECISION / SEMANTICS:
 *  - Cosmos returned LTVs as decimal STRINGS ("0.45"); the lens returns 1e18-scaled uints.
 *    We convert via formatEther so the UI's existing Number()/num() math keeps working
 *    ("0.8", "0.04", …).
 *  - This port has NO separate max_borrow_LTV — `currentMaxLTV` IS the borrow-gating LTV,
 *    so max_LTV and max_borrow_LTV are both set from currentMaxLTV.
 *  - `asset.info.token.address` carries the ERC20 address (EVM identity); `denom` is the
 *    on-chain bytes32 key. native_token.denom is intentionally omitted so consumers that
 *    fall back `native_token?.denom || token?.address` resolve to the ERC20 address.
 *
 * STILL MISSING (not derivable from the lens; left undefined rather than faked):
 *  - credit_price / credit_asset — read separately via getCreditPrice() (creditPriceSnapshot).
 *  - rate_index per collateral — Cdp.sol accrues via currentAdaptiveRate (see
 *    getCollateralInterest); no cumulative rate index is exposed on the lens.
 *  - multi_asset_supply_caps / stability_pool ratios — no ported equivalent (LiqQueue.sol
 *    has no stability pool), so SPCapRatio is left undefined.
 *  - per-asset debt_total on the supply caps — the lens exposes supplyCap + currentSupply
 *    only; borrowed-debt per denom is a separate CDP read (getSupplyCap().debtTotal /
 *    getTotalBorrowedAgainst). Cosmos-style "supply-cap-reached" math that reads
 *    supplyCap.debt_total must be adapted to fetch it from the CDP.
 */
export type EvmBasketAsset = {
  amount: string
  info: { token: { address: Address }; native_token?: { denom: string } }
}
export type EvmBasketCollateralType = {
  asset: EvmBasketAsset
  denom: Bytes32
  max_LTV: string
  max_borrow_LTV: string
  enabled: boolean
  is_in_onboarding: boolean
  supply_cap: string
  current_supply: string
  supply_cap_ratio: string
}
export type EvmBasketSupplyCap = {
  denom: Bytes32
  supply_cap: string
  current_supply: string
  supply_cap_ratio: string
}
export type EvmBasket = {
  collateral_types: EvmBasketCollateralType[]
  collateral_supply_caps: EvmBasketSupplyCap[]
}

/** current/cap as a 0..1 decimal string ("0" when the cap is zero/unlimited or drained). */
function capRatio(current: bigint, cap: bigint): string {
  if (cap <= 0n) return '0'
  return (Number(current) / Number(cap)).toString()
}

function toBasketCollateralType(p: EvmCollateralParams): EvmBasketCollateralType {
  const maxLtv = formatEther(p.currentMaxLTV)
  return {
    asset: { amount: '0', info: { token: { address: p.token } } },
    denom: p.denom,
    max_LTV: maxLtv,
    max_borrow_LTV: maxLtv,
    enabled: p.enabled,
    is_in_onboarding: p.isInOnboarding,
    supply_cap: p.supplyCap.toString(),
    current_supply: p.currentSupply.toString(),
    supply_cap_ratio: capRatio(p.currentSupply, p.supplyCap),
  }
}

export async function getBasket(
  client: PublicClient | null,
  contractAddr?: Address,
): Promise<EvmBasket | null> {
  if (!client) return null
  // contractAddr, if supplied, is the FrontendLens address override (basket now sources
  // from the lens, not the CDP). The CDP scalar reads above keep their own address book.
  const params = await getAllCollateralParams(client, contractAddr)
  if (!params) return null
  const collateral_types = params.map(toBasketCollateralType)
  const collateral_supply_caps: EvmBasketSupplyCap[] = collateral_types.map((c) => ({
    denom: c.denom,
    supply_cap: c.supply_cap,
    current_supply: c.current_supply,
    supply_cap_ratio: c.supply_cap_ratio,
  }))
  return { collateral_types, collateral_supply_caps }
}

/**
 * Cosmos getRates() returned the protocol rate aggregate.
 * TODO(evm-migration): closest clean read is getRatesConfig() (global rate config) plus
 * per-asset getCollateralInterest(); there is no single Cdp.sol view that reproduces the
 * old combined response, so callers should compose those two instead of this stub.
 */
export async function getRates(_client: PublicClient | null, _contractAddr?: Address) {
  return null
}

/**
 * Cosmos getCreditRate() returned the credit-redemption interest rate.
 * TODO(evm-migration): Cdp.sol exposes credit *price* (getCreditPrice / creditPriceSnapshot)
 * and the CPC config in getRatesConfig(), but no standalone credit-redemption-rate scalar —
 * price movement is driven by the CreditPriceController. No clean equivalent view exists.
 */
export async function getCreditRate(_client: PublicClient | null, _contractAddr?: Address) {
  return null
}

/**
 * Cosmos getBasketPositions() enumerated ALL positions across ALL owners (paginated).
 * TODO(evm-migration): Cdp.sol has no protocol-wide position enumeration. userPositionIds is
 * keyed per-owner and there is no global owner/position registry view, so the "all positions"
 * query (used for risk scanning / liquidation lists) cannot be reproduced on-chain. Needs an
 * off-chain indexer or a new contract view. Use getUserPositions(user) for a single owner.
 */
export async function getBasketPositions(_client: PublicClient | null, _contractAddr?: Address) {
  return null
}

/**
 * Cosmos getUserRedemptionInfo() returned RedeemabilityResponse (get_basket_redeemability).
 * TODO(evm-migration): Cdp.sol has no redeemability view — the CosmWasm redemption feature
 * has no ported Solidity equivalent surface. Stubbed until (and if) redemption lands in the port.
 */
export async function getUserRedemptionInfo(
  _client: PublicClient | null,
  _user: Address,
  _contractAddr?: Address,
) {
  return null
}
