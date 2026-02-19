import { Asset, CAsset, Rate, SupplyCap } from '@/contracts/generated/positions/Positions.types'

// Price history data from CoinGecko
export interface PriceHistoryData {
  prices: [number, number][] // [timestamp, price][]
  market_caps?: [number, number][]
  total_volumes?: [number, number][]
}

export interface PriceHistoryByAsset {
  [coinId: string]: PriceHistoryData
}

// Processed chart data point
export interface ChartDataPoint {
  date: string
  timestamp: number
  actual: number
  [key: string]: string | number // hypo_ATOM, hypo_TIA, etc.
}

// Table row types
export interface CollateralRowData {
  symbol: string
  logo: string
  subtext?: string
  denom: string
  apy: number
  depositAmount: number
  depositUsdValue: number
  price: number
  maxLTV?: number
  maxBorrowLTV?: number
  supplyCap?: SupplyCap
  isDeposited?: boolean
  isSupplyCapReached?: boolean
  currentRatio?: number
}

export interface BorrowRowData {
  symbol: string
  logo: string
  denom: string
  borrowApy: number
  liquidityAvailable: number
  liquidityUsdValue: number
}

// Rate segment types matching the Rust RateSegment struct
export interface FixedRateEnd {
  endTime: number      // Block time in seconds
  rollover: boolean    // Recalculate on expiry vs convert to variable
  durationMonths: number // 1, 3, or 6
}

export interface FixedRate {
  rate: number         // Fixed interest rate (as decimal, e.g. 0.05 = 5%)
  end: FixedRateEnd
}

export interface RateSegment {
  amount: number       // Debt amount in this segment (human-readable)
  fixedRate?: FixedRate // undefined = variable rate
}

// Debt row for the DebtCard table
export interface DebtRowData {
  type: 'Variable' | 'Fixed 1-Month' | 'Fixed 3-Month' | 'Fixed 6-Month'
  rate: number         // APR percentage (e.g. 4.2)
  amount: number       // Debt amount (human-readable USD)
  endTime?: number     // For fixed: when it expires (epoch seconds)
  rollover?: boolean   // For fixed: whether it auto-rolls
}

// Time range options for chart
export type TimeRange = 7 | 30 | 90 | 180

// Mock denoms for chart when no position exists
export const MOCK_CHART_DENOMS = [
  'untrn',  // NTRN
  'factory/osmo1z0qrq605sjgcqpylfl4aa6s90x738j7m58wyatt0tdzflg2ha26q67k743/wbtc', // BTC
  'ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4', // USDC
]

// Denom to CoinGecko ID mapping
export const DENOM_TO_COINGECKO: Record<string, string> = {
  // Native tokens
  'uosmo': 'osmosis',
  'untrn': 'neutron-3',

  // IBC tokens - ATOM
  'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2': 'cosmos',

  // TIA
  'ibc/D79E7D83AB399BFFF93433E54FAA480C191248FC556924A2A8351AE2638B3877': 'celestia',

  // DYDX
  'ibc/831F0B1BBB1D08A2B75311892876D71565478C532967545476DF4C2D7492E48C': 'dydx-chain',

  // ETH (ETH.axl canonical on Osmosis)
  'ibc/EA1D43981D5C9A1C4AAEA9C23BB1D4FA126BA9BC7020A25E0AE4AA841EA25DC5': 'ethereum',

  // WBTC
  'factory/osmo1z0qrq605sjgcqpylfl4aa6s90x738j7m58wyatt0tdzflg2ha26q67k743/wbtc': 'bitcoin',
  'ibc/D1542AA8762DB13087D8364F3EA6509FD6F009A34F00426AF9E4F9FA85CBBF1F': 'bitcoin', // WBTC.axl

  // Stablecoins
  'ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4': 'usd-coin', // USDC Noble
  'ibc/D189335C6E4A68B513C10AB227BF1C1D38C746766278BA3EEB4FB14124F1D858': 'usd-coin', // USDC.axl
  'ibc/4ABBEF4C8926DDDB320AE5188CFD63267ABBCEFC0583E4AE05D6E5AA2401DDAB': 'tether', // USDT

  // Other tokens
  'ibc/64BA6E31FE887D66C6F8F31C7B1A80C7CA179239677B4088BB55F5EA07DBE273': 'injective-protocol', // INJ

  // Stride staked tokens - use underlying asset price
  'ibc/C140AFD542AE77BD7DCC83F13FDD8C5E5BB8C4929785E6EC2F4C636F98F17901': 'cosmos', // stATOM
  'ibc/D176154B0C63D1F9C6DCFB4F70349EBF2E2B5A87A05902F57A6AE92B863E9AEC': 'osmosis', // stOSMO
}

// Chart colors for hypothetical lines
export const ASSET_COLORS = [
  '#22d3ee', // cyan
  '#a78bfa', // purple
  '#34d399', // green
  '#fb923c', // orange
  '#f472b6', // pink
  '#60a5fa', // blue
  '#fbbf24', // yellow
  '#f87171', // red
]

// Get symbol from asset info
export function getSymbolFromDenom(denom: string, basket?: any): string {
  // Common mappings
  const symbolMap: Record<string, string> = {
    'uosmo': 'OSMO',
    'untrn': 'NTRN',
    'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2': 'ATOM',
    'ibc/D79E7D83AB399BFFF93433E54FAA480C191248FC556924A2A8351AE2638B3877': 'TIA',
    'ibc/831F0B1BBB1D08A2B75311892876D71565478C532967545476DF4C2D7492E48C': 'DYDX',
    'ibc/EA1D43981D5C9A1C4AAEA9C23BB1D4FA126BA9BC7020A25E0AE4AA841EA25DC5': 'ETH',
    'ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4': 'USDC',
    'ibc/D189335C6E4A68B513C10AB227BF1C1D38C746766278BA3EEB4FB14124F1D858': 'USDC.axl',
    'ibc/4ABBEF4C8926DDDB320AE5188CFD63267ABBCEFC0583E4AE05D6E5AA2401DDAB': 'USDT',
    'ibc/D1542AA8762DB13087D8364F3EA6509FD6F009A34F00426AF9E4F9FA85CBBF1F': 'WBTC.axl',
    'ibc/C140AFD542AE77BD7DCC83F13FDD8C5E5BB8C4929785E6EC2F4C636F98F17901': 'stATOM',
    'ibc/D176154B0C63D1F9C6DCFB4F70349EBF2E2B5A87A05902F57A6AE92B863E9AEC': 'stOSMO',
    'ibc/64BA6E31FE887D66C6F8F31C7B1A80C7CA179239677B4088BB55F5EA07DBE273': 'INJ',
  }

  return symbolMap[denom] || denom.slice(0, 8) + '...'
}

// Get logo path for asset
export function getLogoFromSymbol(symbol: string): string {
  const logoMap: Record<string, string> = {
    'OSMO': '/images/osmo.svg',
    'NTRN': '/images/ntrn.svg',
    'BTC': '/images/wbtc.svg',
    'ATOM': '/images/atom.svg',
    'TIA': '/images/tia.svg',
    'DYDX': '/images/dydx.svg',
    'ETH': '/images/eth.svg',
    'USDC': '/images/usdc.svg',
    'USDC.axl': '/images/usdc.svg',
    'USDT': '/images/usdt.svg',
    'WBTC': '/images/wbtc.svg',
    'WBTC.axl': '/images/wbtc.svg',
    'stATOM': '/images/statom.svg',
    'stOSMO': '/images/stosmo.svg',
    'INJ': '/images/inj.svg',
    'CDT': '/images/cdt.svg',
  }

  return logoMap[symbol] || '/images/default-token.svg'
}
