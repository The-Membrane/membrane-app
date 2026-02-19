import { BasketPositionsResponse, PositionResponse } from '@/contracts/generated/positions/Positions.types'
import { Price } from '@/services/oracle'
import { DebtRowData } from './types'

/**
 * Mock data for testing the Borrow Modal
 * This provides sample position data, vault summary, and prices
 * 
 * To enable mock data, set USE_MOCK_DATA to true in:
 * - components/NeutronMint/hooks/useBorrowModal.ts
 * - components/NeutronMint/BorrowModal.tsx
 * 
 * Mock position includes:
 * - 500 NTRN ($480)
 * - 100 ATOM ($845)
 * - 50 TIA ($615)
 * Total collateral: ~$1,940
 * Current debt: $200 CDT
 * Max borrowable: $800 (based on maxMint of $1000 - current debt of $200)
 */

// Mock prices for common assets
export const mockPrices: Price[] = [
    {
        denom: 'untrn',
        price: '0.96',
    },
    {
        denom: 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2', // ATOM
        price: '8.45',
    },
    {
        denom: 'ibc/D79E7D83AB399BFFF93433E54FAA480C191248FC556924A2A8351AE2638B3877', // TIA
        price: '12.30',
    },
    {
        denom: 'ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4', // USDC
        price: '1.00',
    },
    {
        denom: 'factory/osmo1z0qrq605sjgcqpylfl4aa6s90x738j7m58wyatt0tdzflg2ha26q67k743/wbtc', // WBTC
        price: '43250.00',
    },
]

// Mock basket positions with collateral
export const mockBasketPositions: BasketPositionsResponse[] = [
    {
        user: 'mock-user-address',
        positions: [
            {
                position_id: '1',
                collateral_assets: [
                    {
                        asset: {
                            info: {
                                native_token: {
                                    denom: 'untrn',
                                },
                            },
                            amount: '500000000', // 500 NTRN (6 decimals)
                        },
                        max_LTV: '0.75',
                        max_borrow_LTV: '0.70',
                        rate_index: '0',
                    },
                    {
                        asset: {
                            info: {
                                native_token: {
                                    denom: 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2', // ATOM
                                },
                            },
                            amount: '100000000', // 100 ATOM (6 decimals)
                        },
                        max_LTV: '0.75',
                        max_borrow_LTV: '0.70',
                        rate_index: '1',
                    },
                    {
                        asset: {
                            info: {
                                native_token: {
                                    denom: 'ibc/D79E7D83AB399BFFF93433E54FAA480C191248FC556924A2A8351AE2638B3877', // TIA
                                },
                            },
                            amount: '50000000', // 50 TIA (6 decimals)
                        },
                        max_LTV: '0.75',
                        max_borrow_LTV: '0.70',
                        rate_index: '2',
                    },
                ],
                credit_amount: '200000000', // 200 CDT debt (6 decimals)
                avg_borrow_LTV: '0.1667',
                avg_max_LTV: '0.75',
                cAsset_ratios: ['0.4', '0.4', '0.2'],
            },
        ],
    },
]

// Mock vault summary data
export const mockVaultSummary = {
    maxMint: 1000, // Max borrowable: $1000
    debtAmount: 200, // Current debt: $200
    tvl: 1200, // Total value locked: $1200
    liquidValue: 960, // Liquidation value: $960 (80% of TVL)
    ltv: 16.67, // Current LTV: 200/1200 * 100 = 16.67%
    borrowLTV: 83.33, // Max borrow LTV: 1000/1200 * 100 = 83.33%
    liqudationLTV: 80, // Liquidation LTV: 80%
    cost: 4.2, // Base cost: 4.2%
    discountedCost: 4.2, // Discounted cost: 4.2%
    newDebtAmount: 200, // New debt amount (same as current for now)
}

// Mock rate segments (CDT debt broken down by rate type)
// Total: 200 CDT = 120 Variable + 50 Fixed 3-Month + 30 Fixed 6-Month
export const mockRateSegments: DebtRowData[] = [
    {
        type: 'Variable',
        rate: 4.2,
        amount: 120,
    },
    {
        type: 'Fixed 3-Month',
        rate: 6.3,
        amount: 50,
        endTime: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 47, // ~47 days from now
        rollover: true,
    },
    {
        type: 'Fixed 6-Month',
        rate: 8.4,
        amount: 30,
        endTime: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 132, // ~132 days from now
        rollover: false,
    },
]

// Mock peg rate segments (USDC debt via transmuter)
export const mockPegRateSegments: DebtRowData[] = [
    {
        type: 'Variable',
        rate: 3.1,
        amount: 0, // No USDC debt for now
    },
]

// Helper to get mock data
export const getMockBorrowData = () => {
    return {
        basketPositions: mockBasketPositions,
        prices: mockPrices,
        vaultSummary: mockVaultSummary,
        rateSegments: mockRateSegments,
        pegRateSegments: mockPegRateSegments,
    }
}

