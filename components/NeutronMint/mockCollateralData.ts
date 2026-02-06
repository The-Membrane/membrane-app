import { Basket, SupplyCap } from '@/contracts/generated/positions/Positions.types'
import { Price } from '@/services/oracle'

/**
 * Mock data for testing Supply Cap UI states in AvailableCollateral
 *
 * This provides sample basket data with various supply cap scenarios:
 * 1. NTRN - Under cap (40/99%) - Normal state, cyan progress bar
 * 2. ATOM - Approaching cap (65/80%) - Warning state, yellow progress bar
 * 3. TIA - Near cap (85/90%) - Danger state, orange progress bar
 * 4. USDC - At cap (95/95%) - Cap reached, red progress bar, disabled deposits
 * 5. WBTC - Over cap (99.01/99%) - Cap reached, red progress bar, disabled deposits
 * 6. DYDX - Zero cap - Expunged asset, should not appear in UI
 *
 * ## How to Enable Mock Data:
 *
 * 1. Set `USE_MOCK_COLLATERAL_DATA = true` in this file
 *
 * 2. In AvailableCollateral.tsx, add at the top of the component:
 * ```typescript
 * import { getMockCollateralData, USE_MOCK_COLLATERAL_DATA } from './mockCollateralData'
 *
 * // Inside the component, before the useMemo:
 * const mockData = USE_MOCK_COLLATERAL_DATA ? getMockCollateralData() : null
 * const basketData = mockData?.basket || basket
 * const pricesData = mockData?.prices || prices
 *
 * // Then use basketData and pricesData instead of basket and prices in the useMemo
 * ```
 *
 * 3. Make sure to also mock basketAssets if needed by filtering basketData.collateral_types
 */

// Toggle this to enable/disable mock data
export const USE_MOCK_COLLATERAL_DATA = true

// Mock prices for assets
export const mockCollateralPrices: Price[] = [
  {
    denom: 'untrn', // NTRN - Under cap (40%)
    price: '0.96',
  },
  {
    denom: 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2', // ATOM - Approaching cap (65%)
    price: '8.45',
  },
  {
    denom: 'ibc/D79E7D83AB399BFFF93433E54FAA480C191248FC556924A2A8351AE2638B3877', // TIA - Near cap (85%)
    price: '12.30',
  },
  {
    denom: 'ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4', // USDC - At cap (100%)
    price: '1.00',
  },
  {
    denom: 'factory/osmo1z0qrq605sjgcqpylfl4aa6s90x738j7m58wyatt0tdzflg2ha26q67k743/wbtc', // WBTC - Over cap (105%)
    price: '43250.00',
  },
  {
    denom: 'ibc/831F0B1BBB1D08A2B75311892876D71565478C532967545476DF4C2D7492E48C', // DYDX - Zero cap (expunged)
    price: '2.15',
  },
]

// Mock supply caps with different scenarios
export const mockSupplyCaps: SupplyCap[] = [
  // 1. NTRN - Under cap (40% of 99% cap)
  {
    asset_info: {
      native_token: {
        denom: 'untrn',
      },
    },
    current_supply: '400000000000', // 400k NTRN (current supply)
    debt_total: '600000000000', // 600k NTRN worth of debt
    supply_cap_ratio: '0.99', // 99% cap
    lp: false,
    stability_pool_ratio_for_debt_cap: null,
  },

  // 2. ATOM - Approaching cap (65% of 80% cap)
  {
    asset_info: {
      native_token: {
        denom: 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2',
      },
    },
    current_supply: '65000000000', // 65k ATOM
    debt_total: '35000000000', // 35k ATOM worth of debt
    supply_cap_ratio: '0.80', // 80% cap
    lp: false,
    stability_pool_ratio_for_debt_cap: null,
  },

  // 3. TIA - Near cap (85% of 90% cap)
  {
    asset_info: {
      native_token: {
        denom: 'ibc/D79E7D83AB399BFFF93433E54FAA480C191248FC556924A2A8351AE2638B3877',
      },
    },
    current_supply: '85000000000', // 85k TIA
    debt_total: '15000000000', // 15k TIA worth of debt
    supply_cap_ratio: '0.90', // 90% cap
    lp: false,
    stability_pool_ratio_for_debt_cap: null,
  },

  // 4. USDC - At cap (100% of 95% cap)
  {
    asset_info: {
      native_token: {
        denom: 'ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4',
      },
    },
    current_supply: '950000000000', // 950k USDC
    debt_total: '50000000000', // 50k USDC worth of debt
    supply_cap_ratio: '0.95', // 95% cap
    lp: false,
    stability_pool_ratio_for_debt_cap: null,
  },

  // 5. WBTC - Over cap (>99% cap) - Should show as disabled
  {
    asset_info: {
      native_token: {
        denom: 'factory/osmo1z0qrq605sjgcqpylfl4aa6s90x738j7m58wyatt0tdzflg2ha26q67k743/wbtc',
      },
    },
    current_supply: '5000000', // 5 BTC (over the cap)
    debt_total: '50000', // 0.05 BTC worth of debt
    supply_cap_ratio: '0.99', // 99% cap
    lp: false,
    stability_pool_ratio_for_debt_cap: null,
  },

  // 6. DYDX - Zero cap (expunged asset, should not appear in UI)
  {
    asset_info: {
      native_token: {
        denom: 'ibc/831F0B1BBB1D08A2B75311892876D71565478C532967545476DF4C2D7492E48C',
      },
    },
    current_supply: '100000000000', // 100k DYDX
    debt_total: '0',
    supply_cap_ratio: '0', // Zero cap = expunged
    lp: false,
    stability_pool_ratio_for_debt_cap: null,
  },
]

// Mock basket with supply caps
export const mockCollateralBasket: Partial<Basket> = {
  collateral_supply_caps: mockSupplyCaps,
  collateral_types: [
    {
      asset: {
        info: {
          native_token: {
            denom: 'untrn',
          },
        },
        amount: '400000000000',
      },
      max_LTV: '0.75',
      max_borrow_LTV: '0.70',
      rate_index: '1.0',
      pool_info: null,
    },
    {
      asset: {
        info: {
          native_token: {
            denom: 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2',
          },
        },
        amount: '65000000000',
      },
      max_LTV: '0.75',
      max_borrow_LTV: '0.70',
      rate_index: '1.0',
      pool_info: null,
    },
    {
      asset: {
        info: {
          native_token: {
            denom: 'ibc/D79E7D83AB399BFFF93433E54FAA480C191248FC556924A2A8351AE2638B3877',
          },
        },
        amount: '85000000000',
      },
      max_LTV: '0.75',
      max_borrow_LTV: '0.70',
      rate_index: '1.0',
      pool_info: null,
    },
    {
      asset: {
        info: {
          native_token: {
            denom: 'ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4',
          },
        },
        amount: '950000000000',
      },
      max_LTV: '0.65',
      max_borrow_LTV: '0.60',
      rate_index: '1.0',
      pool_info: null,
    },
    {
      asset: {
        info: {
          native_token: {
            denom: 'factory/osmo1z0qrq605sjgcqpylfl4aa6s90x738j7m58wyatt0tdzflg2ha26q67k743/wbtc',
          },
        },
        amount: '5000000',
      },
      max_LTV: '0.80',
      max_borrow_LTV: '0.75',
      rate_index: '1.0',
      pool_info: null,
    },
    {
      asset: {
        info: {
          native_token: {
            denom: 'ibc/831F0B1BBB1D08A2B75311892876D71565478C532967545476DF4C2D7492E48C',
          },
        },
        amount: '100000000000',
      },
      max_LTV: '0.70',
      max_borrow_LTV: '0.65',
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
  return {
    asset: {
      base: collateralType.asset.info.native_token?.denom || '',
      symbol: collateralType.asset.info.native_token?.denom === 'untrn' ? 'NTRN' :
              collateralType.asset.info.native_token?.denom === 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2' ? 'ATOM' :
              collateralType.asset.info.native_token?.denom === 'ibc/D79E7D83AB399BFFF93433E54FAA480C191248FC556924A2A8351AE2638B3877' ? 'TIA' :
              collateralType.asset.info.native_token?.denom === 'ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4' ? 'USDC' :
              collateralType.asset.info.native_token?.denom === 'factory/osmo1z0qrq605sjgcqpylfl4aa6s90x738j7m58wyatt0tdzflg2ha26q67k743/wbtc' ? 'WBTC' :
              'DYDX',
      logo: collateralType.asset.info.native_token?.denom === 'untrn' ? '/images/ntrn.svg' :
            collateralType.asset.info.native_token?.denom === 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2' ? '/images/atom.svg' :
            collateralType.asset.info.native_token?.denom === 'ibc/D79E7D83AB399BFFF93433E54FAA480C191248FC556924A2A8351AE2638B3877' ? '/images/tia.svg' :
            collateralType.asset.info.native_token?.denom === 'ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4' ? '/images/usdc.svg' :
            collateralType.asset.info.native_token?.denom === 'factory/osmo1z0qrq605sjgcqpylfl4aa6s90x738j7m58wyatt0tdzflg2ha26q67k743/wbtc' ? '/images/wbtc.svg' :
            '/images/dydx.svg',
      decimal: 6,
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

    snapshots.push({
      timestamp,
      ltv: Number(ltv.toFixed(2))
    })
  }

  return snapshots
}

// Mock LTV data for each collateral type
export const mockHistoricalLTVData: Record<string, MockLTVData> = {
  // NTRN - Gradually increasing LTV
  'untrn': {
    denom: 'untrn',
    historicalSnapshots: generateHistoricalLTV(35, 48, 3),
    currentLTV: 48.2,
    pendingLTV: 52.5,
    shiftTime: Math.floor(Date.now() / 1000) + (24 * 60 * 60), // 24 hours from now
    maxLTV: 75.0,
  },

  // ATOM - Stable LTV around 60%
  'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2': {
    denom: 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2',
    historicalSnapshots: generateHistoricalLTV(58, 62, 4),
    currentLTV: 61.3,
    pendingLTV: 59.8,
    shiftTime: Math.floor(Date.now() / 1000) + (12 * 60 * 60), // 12 hours from now
    maxLTV: 75.0,
  },

  // TIA - Decreasing LTV (risk reduction)
  'ibc/D79E7D83AB399BFFF93433E54FAA480C191248FC556924A2A8351AE2638B3877': {
    denom: 'ibc/D79E7D83AB399BFFF93433E54FAA480C191248FC556924A2A8351AE2638B3877',
    historicalSnapshots: generateHistoricalLTV(70, 55, 6),
    currentLTV: 54.7,
    pendingLTV: 50.2,
    shiftTime: Math.floor(Date.now() / 1000) + (6 * 60 * 60), // 6 hours from now
    maxLTV: 75.0,
  },

  // USDC - Very stable low LTV (stablecoin)
  'ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4': {
    denom: 'ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4',
    historicalSnapshots: generateHistoricalLTV(40, 43, 1),
    currentLTV: 42.8,
    pendingLTV: 42.5,
    shiftTime: Math.floor(Date.now() / 1000) + (18 * 60 * 60), // 18 hours from now
    maxLTV: 65.0,
  },

  // WBTC - High volatile LTV
  'factory/osmo1z0qrq605sjgcqpylfl4aa6s90x738j7m58wyatt0tdzflg2ha26q67k743/wbtc': {
    denom: 'factory/osmo1z0qrq605sjgcqpylfl4aa6s90x738j7m58wyatt0tdzflg2ha26q67k743/wbtc',
    historicalSnapshots: generateHistoricalLTV(50, 72, 8),
    currentLTV: 71.5,
    pendingLTV: 68.3,
    shiftTime: Math.floor(Date.now() / 1000) + (3 * 60 * 60), // 3 hours from now
    maxLTV: 80.0,
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
 * 1. NTRN: 400k / (400k + 600k) = 0.40 (40%) < 0.99 (99%) ✓ Allowed (cyan)
 * 2. ATOM: 65k / (65k + 35k) = 0.65 (65%) < 0.80 (80%) ✓ Allowed (yellow warning)
 * 3. TIA: 85k / (85k + 15k) = 0.85 (85%) < 0.90 (90%) ✓ Allowed (orange danger)
 * 4. USDC: 950k / (950k + 50k) = 0.95 (95%) >= 0.95 (95%) ✗ Cap reached (red, disabled)
 * 5. WBTC: 5M / (5M + 50k) = 0.9901 (99.01%) > 0.99 (99%) ✗ Cap reached (red, disabled)
 * 6. DYDX: 0% cap = expunged, should not appear in UI
 */
