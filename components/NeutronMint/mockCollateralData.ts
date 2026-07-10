import { Basket, SupplyCap } from '@/contracts/generated/positions/Positions.types'
import { Price } from '@/services/oracle'

/**
 * Mock data for testing Supply Cap UI states in AvailableCollateral (EVM route).
 *
 * These are EVM-appropriate collateral assets (matching the /ethereum route), not
 * the Cosmos assets the older mock used. Identities use mainnet-style ERC-20
 * addresses as the `denom` and correct EVM decimals (WETH/wstETH 18, WBTC 8,
 * USDC 6). Values are illustrative only.
 *
 * Supply-cap scenarios exercised:
 * 1. WETH   - Under cap (40% of 85%)   -> normal state, cyan progress bar
 * 2. wstETH - Approaching cap (68% of 80%) -> warning state, yellow progress bar
 * 3. WBTC   - Near cap (87% of 90%)    -> danger state, orange progress bar
 * 4. USDC   - At cap (95% of 95%)      -> cap reached, red bar, deposits disabled
 *
 * ## How to Enable Mock Data:
 *
 * 1. `USE_MOCK_COLLATERAL_DATA` below is gated to non-production automatically.
 *    In local dev it resolves to `true`; in a production build it is always
 *    `false`, so real users never see fabricated collateral/APRs.
 *
 * 2. AvailableCollateral.tsx already consumes it:
 * ```typescript
 * const mockData = USE_MOCK_COLLATERAL_DATA ? getMockCollateralData() : null
 * const basketData = mockData?.basket || basket
 * const pricesData = mockData?.prices || prices
 * ```
 */

// Toggle for mock data. Gated so production builds NEVER render fabricated
// collateral — active only in local dev / non-production environments.
export const USE_MOCK_COLLATERAL_DATA = process.env.NODE_ENV !== 'production'

// EVM collateral identities (ERC-20 addresses used as denom on the /ethereum route)
const WETH_DENOM = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const WSTETH_DENOM = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0'
const WBTC_DENOM = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'
const USDC_DENOM = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

interface EvmMockAsset {
  denom: string
  symbol: string
  logo: string
  decimals: number
}

// Identity table drives symbol/logo/decimal derivation below.
const EVM_MOCK_ASSETS: Record<string, EvmMockAsset> = {
  [WETH_DENOM]: { denom: WETH_DENOM, symbol: 'WETH', logo: '/images/eth.svg', decimals: 18 },
  [WSTETH_DENOM]: { denom: WSTETH_DENOM, symbol: 'wstETH', logo: '/images/wsteth.svg', decimals: 18 },
  [WBTC_DENOM]: { denom: WBTC_DENOM, symbol: 'WBTC', logo: '/images/wbtc.svg', decimals: 8 },
  [USDC_DENOM]: { denom: USDC_DENOM, symbol: 'USDC', logo: '/images/usdc.svg', decimals: 6 },
}

// Mock prices for assets (illustrative)
export const mockCollateralPrices: Price[] = [
  { denom: WETH_DENOM, price: '3500.00' }, // WETH
  { denom: WSTETH_DENOM, price: '4100.00' }, // wstETH
  { denom: WBTC_DENOM, price: '68000.00' }, // WBTC
  { denom: USDC_DENOM, price: '1.00' }, // USDC
]

// Mock supply caps with different scenarios.
// NOTE: AvailableCollateral shifts `current_supply` by the asset's decimals and
// `debt_total` by 6, so amounts below are chosen to produce the documented ratios.
export const mockSupplyCaps: SupplyCap[] = [
  // 1. WETH - Under cap (40% of 85% cap): 5000 / (5000 + 7500) = 0.40
  {
    asset_info: { native_token: { denom: WETH_DENOM } },
    current_supply: '5000000000000000000000', // 5,000 WETH (18 decimals)
    debt_total: '7500000000', // 7,500 (6 decimals)
    supply_cap_ratio: '0.85',
    lp: false,
    stability_pool_ratio_for_debt_cap: null,
  },

  // 2. wstETH - Approaching cap (68% of 80% cap): 3000 / (3000 + 1412) = 0.68
  {
    asset_info: { native_token: { denom: WSTETH_DENOM } },
    current_supply: '3000000000000000000000', // 3,000 wstETH (18 decimals)
    debt_total: '1412000000', // 1,412 (6 decimals)
    supply_cap_ratio: '0.80',
    lp: false,
    stability_pool_ratio_for_debt_cap: null,
  },

  // 3. WBTC - Near cap (87% of 90% cap): 400 / (400 + 59.77) = 0.87
  {
    asset_info: { native_token: { denom: WBTC_DENOM } },
    current_supply: '40000000000', // 400 WBTC (8 decimals)
    debt_total: '59770000', // 59.77 (6 decimals)
    supply_cap_ratio: '0.90',
    lp: false,
    stability_pool_ratio_for_debt_cap: null,
  },

  // 4. USDC - At cap (95% of 95% cap): 950k / (950k + 50k) = 0.95 -> disabled
  {
    asset_info: { native_token: { denom: USDC_DENOM } },
    current_supply: '950000000000', // 950,000 USDC (6 decimals)
    debt_total: '50000000000', // 50,000 (6 decimals)
    supply_cap_ratio: '0.95',
    lp: false,
    stability_pool_ratio_for_debt_cap: null,
  },
]

// Mock basket with supply caps
export const mockCollateralBasket: Partial<Basket> = {
  collateral_supply_caps: mockSupplyCaps,
  collateral_types: [
    {
      asset: { info: { native_token: { denom: WETH_DENOM } }, amount: '5000000000000000000000' },
      max_LTV: '0.82',
      max_borrow_LTV: '0.78',
      rate_index: '1.0',
      pool_info: null,
    },
    {
      asset: { info: { native_token: { denom: WSTETH_DENOM } }, amount: '3000000000000000000000' },
      max_LTV: '0.80',
      max_borrow_LTV: '0.75',
      rate_index: '1.0',
      pool_info: null,
    },
    {
      asset: { info: { native_token: { denom: WBTC_DENOM } }, amount: '40000000000' },
      max_LTV: '0.78',
      max_borrow_LTV: '0.73',
      rate_index: '1.0',
      pool_info: null,
    },
    {
      asset: { info: { native_token: { denom: USDC_DENOM } }, amount: '950000000000' },
      max_LTV: '0.90',
      max_borrow_LTV: '0.87',
      rate_index: '1.0',
      pool_info: null,
    },
  ],
  credit_price: {
    price: '1.0',
    decimals: 6,
  },
  multi_asset_supply_caps: [],
  liq_queue: null,
  base_interest_rate: '0.05',
  pending_revenue: '0',
  negative_rates: false,
  cpc_margin_of_error: '0.01',
  frozen: false,
  rev_to_stakers: true,
  credit_last_accrued: 0,
  rates_last_accrued: 0,
  oracle_set: false,
}

// Mock basket assets (derived from collateral_types)
export const mockBasketAssets = mockCollateralBasket.collateral_types?.map((collateralType, index) => {
  const supplyCap = mockSupplyCaps[index]
  const denom = collateralType.asset.info.native_token?.denom || ''
  const identity = EVM_MOCK_ASSETS[denom]
  return {
    asset: {
      base: denom,
      symbol: identity?.symbol || denom,
      logo: identity?.logo || '/images/default-token.svg',
      decimal: identity?.decimals ?? 18,
      description: '',
    },
    interestRate: 0,
    rateIndex: Number(collateralType.rate_index),
    maxLTV: Number(collateralType.max_LTV),
    maxBorrowLTV: Number(collateralType.max_borrow_LTV),
    supplyCapRatio: supplyCap?.supply_cap_ratio || '0',
    SPCapRatio: supplyCap?.stability_pool_ratio_for_debt_cap,
  }
})

// Mock Historical LTV Data for charts
export interface MockLTVSnapshot {
  timestamp: number  // Unix timestamp in seconds
  ltv: number        // LTV as percentage (e.g., 45.2 for 45.2%)
  currentLtv: number // The active liquidation LTV at this point in time
}

export interface MockLTVData {
  denom: string
  historicalSnapshots: MockLTVSnapshot[]
  currentLTV: number
  pendingLTV: number
  shiftTime: number      // Unix timestamp when shift occurs
  maxLTV: number         // Max LTV threshold
}

// Generate mock historical LTV data for the past 30 days
const generateHistoricalLTV = (
  startLTV: number,
  endLTV: number,
  volatility: number = 5
): MockLTVSnapshot[] => {
  const now = Math.floor(Date.now() / 1000)
  const thirtyDaysAgo = now - (30 * 24 * 60 * 60)
  const snapshots: MockLTVSnapshot[] = []

  // Generate snapshots every 6 hours for 30 days (120 snapshots)
  const interval = 6 * 60 * 60 // 6 hours in seconds
  const steps = 120

  for (let i = 0; i < steps; i++) {
    const timestamp = thirtyDaysAgo + (i * interval)
    const progress = i / (steps - 1)
    // Interpolate between start and end with some randomness
    const baseLTV = startLTV + (endLTV - startLTV) * progress
    const noise = (Math.random() - 0.5) * volatility
    const ltv = Math.max(0, Math.min(100, baseLTV + noise))
    // currentLtv is a smoother stepped line (updates daily, less noise)
    const dayProgress = Math.floor(progress * 30) / 30
    const currentLtv = startLTV + (endLTV - startLTV) * dayProgress

    snapshots.push({
      timestamp,
      ltv: Number(ltv.toFixed(2)),
      currentLtv: Number(currentLtv.toFixed(2)),
    })
  }

  return snapshots
}

// Mock LTV data for each collateral type
export const mockHistoricalLTVData: Record<string, MockLTVData> = {
  // WETH - Gradually increasing LTV
  [WETH_DENOM]: {
    denom: WETH_DENOM,
    historicalSnapshots: generateHistoricalLTV(45, 58, 3),
    currentLTV: 58.2,
    pendingLTV: 62.5,
    shiftTime: Math.floor(Date.now() / 1000) + (24 * 60 * 60), // 24 hours from now
    maxLTV: 82.0,
  },

  // wstETH - Stable LTV around 60%
  [WSTETH_DENOM]: {
    denom: WSTETH_DENOM,
    historicalSnapshots: generateHistoricalLTV(58, 62, 4),
    currentLTV: 61.3,
    pendingLTV: 59.8,
    shiftTime: Math.floor(Date.now() / 1000) + (12 * 60 * 60), // 12 hours from now
    maxLTV: 80.0,
  },

  // WBTC - Higher, more volatile LTV
  [WBTC_DENOM]: {
    denom: WBTC_DENOM,
    historicalSnapshots: generateHistoricalLTV(50, 68, 8),
    currentLTV: 67.5,
    pendingLTV: 64.3,
    shiftTime: Math.floor(Date.now() / 1000) + (3 * 60 * 60), // 3 hours from now
    maxLTV: 78.0,
  },

  // USDC - Very stable low LTV (stablecoin)
  [USDC_DENOM]: {
    denom: USDC_DENOM,
    historicalSnapshots: generateHistoricalLTV(40, 43, 1),
    currentLTV: 42.8,
    pendingLTV: 42.5,
    shiftTime: Math.floor(Date.now() / 1000) + (18 * 60 * 60), // 18 hours from now
    maxLTV: 90.0,
  },
}

// Helper to get mock collateral data
export const getMockCollateralData = () => {
  return {
    basket: mockCollateralBasket as Basket,
    prices: mockCollateralPrices,
    supplyCaps: mockSupplyCaps,
    basketAssets: mockBasketAssets,
    historicalLTVData: mockHistoricalLTVData,
  }
}

/**
 * Supply cap calculation examples:
 *
 * Formula: currentRatio = current_supply / (current_supply + debt_total)
 * Cap reached when: currentRatio >= supply_cap_ratio
 *
 * 1. WETH:   5,000 / (5,000 + 7,500)   = 0.40 (40%) < 0.85 -> Allowed (cyan)
 * 2. wstETH: 3,000 / (3,000 + 1,412)   = 0.68 (68%) < 0.80 -> Allowed (yellow warning)
 * 3. WBTC:   400 / (400 + 59.77)       = 0.87 (87%) < 0.90 -> Allowed (orange danger)
 * 4. USDC:   950k / (950k + 50k)       = 0.95 (95%) >= 0.95 -> Cap reached (red, disabled)
 */
