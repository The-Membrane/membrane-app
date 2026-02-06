import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import contracts from '@/config/contracts.json'
import { BasketPositionsResponse } from '@/contracts/codegen/positions/Positions.types'
import { shiftDigits } from '@/helpers/math'

/**
 * Type definitions for yield-arb contract responses
 */
export interface DeploymentSnapshot {
    collateral_assets: Array<{
        asset: {
            amount: string
            info: any
        }
        max_borrow_LTV: string
        max_LTV: string
        rate_index: string
        pool_info: any | null
        individual_cost: any | null
    }>
    block_time: number
    amount_looped: string
    debt_taken: string
}

export interface UserPosition {
    user: string
    collateral_amount: string
    debt_amount: string
    position_id: string
    timestamp: number
}

export interface MarketConditions {
    cdt_mint_cost: string
    vault_apr: string
    vault_cost: string
    timestamp: number
}

export interface ChartDataPoint {
    timestamp: number
    profit: number
    collateralValue: number
    debt: number
    amountLooped: number
    apr?: number // Historical APR at this point
}

// Set to true to use mock data instead of querying contract
const USE_MOCK_DATA_TRANSMUTER = true // Change to false when contract is ready

/**
 * Get transmuter contract USDC balance
 */
export const getTransmuterUSDCBalance = async (
    client: CosmWasmClient | null,
    contractAddr?: string
) => {
    // Use mock data if enabled
    if (USE_MOCK_DATA_TRANSMUTER) {
        await new Promise(resolve => setTimeout(resolve, 100))
        return "8500000" // 8.5 USDC (6 decimals)
    }

    if (!client) return null

    const transmuterContract = contractAddr || (contracts as any).transmuter
    if (!transmuterContract || transmuterContract === "") return null

    try {
        // Query USDC balance - assuming USDC denom on Osmosis
        const usdcDenom = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4"
        const balance = await client.getBalance(transmuterContract, usdcDenom)
        return balance.amount
    } catch (error) {
        console.error("Error querying transmuter USDC balance:", error)
        return null
    }
}

/**
 * Find user's USDC-only looping position
 * Returns the position that only has USDC as collateral
 */
export const findUSDCLoopingPosition = (
    basketPositions: BasketPositionsResponse | undefined
) => {
    if (!basketPositions || !basketPositions.positions) return null

    // Find position with only USDC collateral
    const usdcDenom = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4"

    for (const position of basketPositions.positions) {
        // Check if this position has only USDC collateral
        if (position.collateral_assets.length === 1) {
            const collateral = position.collateral_assets[0]
            // @ts-ignore - asset info structure
            const collateralDenom = collateral.asset?.info?.native_token?.denom

            if (collateralDenom === usdcDenom) {
                return {
                    positionId: position.position_id,
                    collateralAmount: shiftDigits(collateral.asset.amount, -6).toNumber(),
                    debtAmount: shiftDigits(position.credit_amount, -6).toNumber(),
                    collateral: collateral
                }
            }
        }
    }

    return null
}

/**
 * Calculate funnel fill ratio as user's progress towards max boost
 * Max boost is 10x the base APR
 * Fill ratio = (current boost / max boost) where current boost = collateralAmount / baseCollateral
 */
export const calculateFunnelFillRatio = (
    collateralAmount: number | undefined,
    debtAmount: number | undefined
): number => {
    if (!collateralAmount || !debtAmount || collateralAmount === 0) {
        return 0
    }

    // Calculate base collateral (collateral - debt)
    const baseCollateral = collateralAmount - debtAmount

    if (baseCollateral <= 0) {
        return 0
    }

    // Calculate current boost ratio: collateralAmount / baseCollateral
    const currentBoostRatio = collateralAmount / baseCollateral

    // Max boost is 10x (maxAPR = baseAPR * 10)
    const maxBoostRatio = 10

    // Calculate progress towards max boost
    const fillRatio = currentBoostRatio / maxBoostRatio

    // Cap at 100%
    return Math.min(fillRatio, 1)
}

/**
 * Calculate APR metrics for the looping position
 * Base APR comes from Mars USDC vault
 * User boost is calculated from leverage (debt / base collateral)
 * Max APR is base x 10
 */
export const calculateAPRMetrics = (
    baseAPR: number,
    collateralAmount: number | undefined,
    debtAmount: number | undefined
) => {
    if (!collateralAmount || !debtAmount || collateralAmount === 0) {
        return {
            baseAPR,
            userAPR: baseAPR,
            boostPercent: 0,
            maxAPR: baseAPR * 10
        }
    }

    // Calculate base collateral (collateral - debt)
    const baseCollateral = collateralAmount - debtAmount

    if (baseCollateral <= 0) {
        return {
            baseAPR,
            userAPR: baseAPR,
            boostPercent: 0,
            maxAPR: baseAPR * 10
        }
    }

    // Calculate boost percentage: debt / base collateral
    const boostPercent = (debtAmount / baseCollateral) * 100

    // Calculate user APR: baseAPR * (1 + debt/base)
    const userAPR = baseAPR * (collateralAmount / baseCollateral)

    return {
        baseAPR,
        userAPR,
        boostPercent,
        maxAPR: baseAPR * 10
    }
}

/**
 * Get Mars USDC vault APR
 */
export const getMarsVaultAPR = async (
    client: CosmWasmClient | null,
    contractAddr?: string,
    chainName?: string
) => {
    if (!client) return null

    // Use Neutron Mars vault if on Neutron, otherwise Osmosis
    const vaultContract = chainName === 'neutron'
        ? (contracts as any).marsUSDCvault_neutron || contractAddr
        : contracts.marsUSDCvault

    if (!vaultContract || vaultContract === "") return null

    try {
        const response = await client.queryContractSmart(vaultContract, {
            a_p_r: {}
        })
        return response
    } catch (error) {
        console.error("Error querying Mars vault APR:", error)
        return null
    }
}

/**
 * Get Mars USDC vault cost
 */
export const getMarsVaultCost = async (
    client: CosmWasmClient | null,
    contractAddr?: string,
    chainName?: string
) => {
    if (!client) return null

    // Use Neutron Mars vault if on Neutron, otherwise Osmosis
    const vaultContract = chainName === 'neutron'
        ? (contracts as any).marsUSDCvault_neutron || contractAddr
        : contracts.marsUSDCvault

    if (!vaultContract || vaultContract === "") return null

    try {
        const response = await client.queryContractSmart(vaultContract, {
            cost: {}
        })
        return response
    } catch (error) {
        console.error("Error querying Mars vault cost:", error)
        return null
    }
}

/**
 * Get deployment snapshot for a user from yield-arb contract
 */
export const getDeploymentSnapshot = async (
    client: CosmWasmClient | null,
    userAddress: string,
    contractAddr?: string
): Promise<DeploymentSnapshot | null> => {
    if (!client || !userAddress) return null

    const yieldArbContract = contractAddr || (contracts as any).yield_arb
    if (!yieldArbContract || yieldArbContract === "") return null

    try {
        const response = await client.queryContractSmart(yieldArbContract, {
            get_deployment_snapshot: {
                user: userAddress
            }
        })
        return response as DeploymentSnapshot
    } catch (error) {
        console.error("Error querying deployment snapshot:", error)
        return null
    }
}

/**
 * Get user positions from yield-arb contract
 */
export const getUserPositions = async (
    client: CosmWasmClient | null,
    userAddress: string,
    limit: number = 100,
    contractAddr?: string
): Promise<UserPosition[] | null> => {
    if (!client || !userAddress) return null

    const yieldArbContract = contractAddr || (contracts as any).yield_arb
    if (!yieldArbContract || yieldArbContract === "") return null

    try {
        const response = await client.queryContractSmart(yieldArbContract, {
            get_user_positions: {
                user: userAddress,
                limit: limit,
                start_after: null
            }
        })
        return response as UserPosition[]
    } catch (error) {
        console.error("Error querying user positions:", error)
        return null
    }
}

/**
 * Get market conditions (historical APR data) from yield-arb contract
 */
/**
 * Generate mock market conditions data
 */
const getMockMarketConditions = (limit: number = 100): MarketConditions[] => {
    console.log('[getMockMarketConditions] Generating mock data with limit:', limit)
    const now = Math.floor(Date.now() / 1000)
    const conditions: MarketConditions[] = []

    // Base APR that varies slightly over time
    let baseVaultAPR = 0.045 // 4.5%
    let baseVaultCost = 0.005 // 0.5%

    // Generate limit + 1 entries (from 0 to limit, inclusive)
    for (let i = 0; i <= limit; i++) {
        const timestamp = now - ((limit - i) * 24 * 60 * 60) // Daily entries, oldest first

        // Simulate slight variations in APR and cost
        const aprVariation = (Math.random() - 0.5) * 0.002 // ±0.2%
        const costVariation = (Math.random() - 0.5) * 0.0005 // ±0.05%

        const vaultAPR = Math.max(0.04, Math.min(0.05, baseVaultAPR + aprVariation))
        const vaultCost = Math.max(0.004, Math.min(0.006, baseVaultCost + costVariation))

        // Slight trend over time
        baseVaultAPR += 0.00001
        baseVaultCost += 0.000001

        conditions.push({
            cdt_mint_cost: "0.001", // Fixed mint cost
            vault_apr: vaultAPR.toString(),
            vault_cost: vaultCost.toString(),
            timestamp,
        })
    }

    console.log('[getMockMarketConditions] Generated', conditions.length, 'entries')
    return conditions
}

export const getMarketConditions = async (
    client: CosmWasmClient | null,
    limit: number = 100,
    contractAddr?: string
): Promise<MarketConditions[] | null> => {
    console.log('[getMarketConditions] Called with:', { USE_MOCK_DATA_TRANSMUTER, limit, hasClient: !!client })

    // Use mock data if enabled
    if (USE_MOCK_DATA_TRANSMUTER) {
        await new Promise(resolve => setTimeout(resolve, 100))
        const mockData = getMockMarketConditions(limit)
        console.log('[getMarketConditions] Generated mock data:', mockData.length, 'entries')
        console.log('[getMarketConditions] First entry:', mockData[0])
        console.log('[getMarketConditions] Last entry:', mockData[mockData.length - 1])
        return mockData
    }

    if (!client) {
        console.log('[getMarketConditions] No client, returning null')
        return null
    }

    const yieldArbContract = contractAddr || (contracts as any).yield_arb
    if (!yieldArbContract || yieldArbContract === "") return null

    try {
        const response = await client.queryContractSmart(yieldArbContract, {
            get_market_conditions: {
                limit: limit,
                start_after: null
            }
        })
        return response as MarketConditions[]
    } catch (error) {
        console.error("Error querying market conditions:", error)
        return null
    }
}

/**
 * Calculate initial position value from deployment snapshot
 */
export const calculateInitialValue = (
    snapshot: DeploymentSnapshot,
    prices: Record<string, number>
): number => {
    let totalValue = 0

    for (const collateral of snapshot.collateral_assets) {
        const amount = shiftDigits(collateral.asset.amount, -6).toNumber()
        // For USDC, assume 1:1 with USD
        // In a real implementation, you'd look up the price from the prices object
        totalValue += amount
    }

    // Subtract initial debt (which would be 0 or minimal at first loop)
    const initialDebt = shiftDigits(snapshot.debt_taken, -6).toNumber()
    return Math.max(0, totalValue - initialDebt)
}

/**
 * Calculate profit for a position snapshot
 */
export const calculateProfit = (
    position: UserPosition,
    initialValue: number,
    prices: Record<string, number>
): number => {
    const collateralValue = shiftDigits(position.collateral_amount, -6).toNumber()
    const debt = shiftDigits(position.debt_amount, -6).toNumber()
    const currentValue = collateralValue - debt

    return currentValue - initialValue
}

/**
 * Find the closest market condition (APR) for a given timestamp
 */
const findClosestAPR = (
    timestamp: number,
    marketConditions: MarketConditions[]
): number | undefined => {
    if (!marketConditions || marketConditions.length === 0) return undefined

    // Find the market condition with the closest timestamp (before or at the position timestamp)
    let closest: MarketConditions | null = null
    let minDiff = Infinity

    for (const mc of marketConditions) {
        const diff = timestamp - mc.timestamp
        if (diff >= 0 && diff < minDiff) {
            minDiff = diff
            closest = mc
        }
    }

    // If no condition before timestamp, use the first one
    if (!closest && marketConditions.length > 0) {
        closest = marketConditions[0]
    }

    if (closest) {
        // Parse APR from Decimal string and convert to percentage
        return parseFloat(closest.vault_apr) * 100
    }

    return undefined
}

/**
 * Transform positions and snapshot into chart data format
 */
export const transformToChartData = (
    positions: UserPosition[],
    snapshot: DeploymentSnapshot | null,
    prices: Record<string, number>,
    marketConditions?: MarketConditions[]
): ChartDataPoint[] => {
    if (!snapshot || !positions || positions.length === 0) return []

    const initialValue = calculateInitialValue(snapshot, prices)

    return positions.map(position => {
        const profit = calculateProfit(position, initialValue, prices)
        const collateralValue = shiftDigits(position.collateral_amount, -6).toNumber()
        const debt = shiftDigits(position.debt_amount, -6).toNumber()
        const amountLooped = snapshot ? shiftDigits(snapshot.amount_looped, -6).toNumber() : 0

        // Find historical APR for this timestamp
        const apr = marketConditions ? findClosestAPR(position.timestamp, marketConditions) : undefined

        return {
            timestamp: position.timestamp,
            profit,
            collateralValue,
            debt,
            amountLooped,
            apr
        }
    }).sort((a, b) => a.timestamp - b.timestamp) // Sort by timestamp ascending
}

