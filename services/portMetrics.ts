import { shiftDigits } from '@/helpers/math'
import { getUserLifetimeRevenue } from './disco'
import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate'

export interface RevenueSource {
    source: 'disco' | 'transmuter' | 'manic'
    amount: number // USD value
    timestamp: number
}

export interface PortMetrics {
    totalRevenue: number
    revenuePerSecond: number
    revenueBySource: {
        disco: number
        transmuter: number
        manic: number
    }
    revenuePerSecondBySource: {
        disco: number
        transmuter: number
        manic: number
    }
    lastUpdated: number
}

/**
 * Aggregate revenue from Disco
 */
export const getDiscoRevenue = async (
    client: CosmWasmClient | null,
    user: string,
    assets: string[] = []
): Promise<number> => {
    if (!client || !user || assets.length === 0) return 0

    try {
        // Get lifetime revenue for all assets
        const revenuePromises = assets.map(asset =>
            getUserLifetimeRevenue(client, user, asset)
        )
        const revenues = await Promise.all(revenuePromises)

        // Sum all lifetime revenue
        let totalRevenue = 0
        revenues.forEach((revenue) => {
            if (revenue && Array.isArray(revenue)) {
                revenue.forEach((entry: any) => {
                    const claimed = entry.total_claimed || entry.amount || entry.revenue || '0'
                    const value = shiftDigits(claimed, -6).toNumber()
                    totalRevenue += value
                })
            } else if (revenue) {
                const claimed = revenue.total_claimed || revenue.amount || revenue.revenue || '0'
                const value = shiftDigits(claimed, -6).toNumber()
                totalRevenue += value
            }
        })

        return totalRevenue
    } catch (error) {
        console.error('Error calculating Disco revenue:', error)
        return 0
    }
}

/**
 * Calculate Transmuter revenue
 * Note: This is a placeholder - actual implementation depends on transmuter contract structure
 */
export const getTransmuterRevenue = async (
    client: CosmWasmClient | null,
    user: string
): Promise<number> => {
    // TODO: Implement actual transmuter revenue query
    // Mock data for now
    if (!client || !user) {
        return 125.50 // Mock transmuter revenue
    }
    return 0
}

/**
 * Calculate Manic Vault revenue
 * Note: This is a placeholder - actual implementation depends on manic vault structure
 */
export const getManicRevenue = async (
    client: CosmWasmClient | null,
    user: string
): Promise<number> => {
    // TODO: Implement actual manic vault revenue query
    // Mock data for now
    if (!client || !user) {
        return 87.25 // Mock manic vault revenue
    }
    return 0
}

/**
 * Get mock revenue data
 */
const getMockRevenue = (): PortMetrics => {
    const discoRevenue = 250.75
    const transmuterRevenue = 125.50
    const manicRevenue = 87.25
    const totalRevenue = discoRevenue + transmuterRevenue + manicRevenue

    // Mock RPS: assume revenue accumulated over 30 days
    const secondsIn30Days = 30 * 24 * 60 * 60
    const revenuePerSecond = totalRevenue / secondsIn30Days

    return {
        totalRevenue,
        revenuePerSecond,
        revenueBySource: {
            disco: discoRevenue,
            transmuter: transmuterRevenue,
            manic: manicRevenue
        },
        revenuePerSecondBySource: {
            disco: discoRevenue / secondsIn30Days,
            transmuter: transmuterRevenue / secondsIn30Days,
            manic: manicRevenue / secondsIn30Days
        },
        lastUpdated: Date.now()
    }
}

/**
 * Aggregate all revenue sources
 */
export const aggregateRevenue = async (
    client: CosmWasmClient | null,
    user: string,
    discoAssets: string[] = []
): Promise<PortMetrics> => {
    // Return mock data if client or user is not available
    if (!client || !user) {
        return getMockRevenue()
    }

    const [discoRevenue, transmuterRevenue, manicRevenue] = await Promise.all([
        getDiscoRevenue(client, user, discoAssets),
        getTransmuterRevenue(client, user),
        getManicRevenue(client, user)
    ])

    const totalRevenue = discoRevenue + transmuterRevenue + manicRevenue

    // If no real revenue found, use mock data
    if (totalRevenue === 0 && discoAssets.length === 0) {
        return getMockRevenue()
    }

    // Calculate revenue per second (simplified - would need historical data for accurate calculation)
    // For now, use a placeholder calculation based on 30 days
    const secondsIn30Days = 30 * 24 * 60 * 60
    const revenuePerSecond = totalRevenue > 0
        ? totalRevenue / secondsIn30Days
        : 0

    return {
        totalRevenue,
        revenuePerSecond,
        revenueBySource: {
            disco: discoRevenue,
            transmuter: transmuterRevenue,
            manic: manicRevenue
        },
        revenuePerSecondBySource: {
            disco: discoRevenue > 0 ? discoRevenue / secondsIn30Days : 0,
            transmuter: transmuterRevenue > 0 ? transmuterRevenue / secondsIn30Days : 0,
            manic: manicRevenue > 0 ? manicRevenue / secondsIn30Days : 0
        },
        lastUpdated: Date.now()
    }
}
