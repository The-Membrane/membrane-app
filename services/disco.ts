/**
 * TODO: EMISSIONS VOTING INTEGRATION  
 * When a user has active votes in the emissions_voting contract, they cannot withdraw
 * or reduce lock durations on their disco deposits. The frontend should:
 * 1. Query HasAnyVotes before withdraw/lock reduction
 * 2. If user has votes, sandwich the operation with RemoveVote calls before and Vote calls after
 * 3. Flow: RemoveVote (all graphs) -> Withdraw/Reduce Lock -> Re-Vote (same values)
 * 
 * This allows users to perform operations without manually removing votes.
 * The emissions_voting contract address can be queried from ltv_disco config.
 */

import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import contracts from '@/config/contracts.json'
import { getMockDiscoUserDeposits, getMockDiscoLifetimeRevenue, getMockDiscoAssets } from './discoMockData'

// Set to true to use mock data instead of querying contract
const USE_MOCK_DATA = true // Change to false when contract is ready

/**
 * Get LTV queue(s) for asset(s).
 * If assets is empty, returns all queues (paginated).
 * Returns { queues: [asset_name, queue][] }
 */
export const getLTVQueues = async (
    client: CosmWasmClient | null,
    assets: string[],
    contractAddr?: string,
    limit?: number,
    startAfter?: string
) => {
    if (!client) return null

    const discoContract = contractAddr || (contracts as any).ltv_disco
    if (!discoContract || discoContract === "") return null

    try {
        const response = await client.queryContractSmart(discoContract, {
            get_ltv_queue: {
                assets,
                limit: limit ?? null,
                start_after: startAfter ?? null,
            }
        })
        return response as { queues: [string, any][] }
    } catch (error) {
        console.error("Error querying LTV queues:", error)
        return null
    }
}

/**
 * Get LTV queue for a single asset (convenience wrapper).
 * Returns the queue object directly, or null if not found.
 */
export const getLTVQueue = async (
    client: CosmWasmClient | null,
    asset: string,
    contractAddr?: string
) => {
    const response = await getLTVQueues(client, [asset], contractAddr)
    if (!response || !response.queues || response.queues.length === 0) return null
    // Return in the shape { queue: ... } for backward compatibility with existing callers
    return { queue: response.queues[0][1] }
}

/**
 * Get user's backing deposits for an asset
 */
export const getUserDeposits = async (
    client: CosmWasmClient | null,
    user: string,
    asset: string,
    contractAddr?: string,
    limit?: number,
    startAfter?: string
) => {
    // Use mock data if enabled
    if (USE_MOCK_DATA) {
        await new Promise(resolve => setTimeout(resolve, 100))
        return getMockDiscoUserDeposits(user, asset)
    }

    if (!client) return null

    const discoContract = contractAddr || (contracts as any).ltv_disco
    if (!discoContract || discoContract === "") return null

    try {
        const response = await client.queryContractSmart(discoContract, {
            get_backing_deposits_by_user: {
                user,
                asset,
                limit,
                start_after: startAfter ? parseInt(startAfter) : undefined
            }
        })
        return response
    } catch (error) {
        console.error("Error querying user deposits:", error)
        return null
    }
}

/**
 * Get user's locked deposits
 */
export const getUserLockedDeposits = async (
    client: CosmWasmClient | null,
    user: string,
    contractAddr?: string
) => {
    if (!client) return null

    const discoContract = contractAddr || (contracts as any).ltv_disco
    if (!discoContract || discoContract === "") return null

    try {
        const response = await client.queryContractSmart(discoContract, {
            get_locked_deposits: { user }
        })
        return response
    } catch (error) {
        console.error("Error querying locked deposits:", error)
        return null
    }
}

/**
 * Get user's lifetime revenue for an asset
 */
export const getUserLifetimeRevenue = async (
    client: CosmWasmClient | null,
    user: string,
    asset: string,
    contractAddr?: string
) => {
    // Use mock data if enabled
    if (USE_MOCK_DATA) {
        await new Promise(resolve => setTimeout(resolve, 100))
        return getMockDiscoLifetimeRevenue(user, asset)
    }

    if (!client) return null

    const discoContract = contractAddr || (contracts as any).ltv_disco
    if (!discoContract || discoContract === "") return null

    try {
        const response = await client.queryContractSmart(discoContract, {
            get_user_lifetime_revenue: { user, asset }
        })
        return response
    } catch (error) {
        console.error("Error querying lifetime revenue:", error)
        return null
    }
}

/**
 * Mock pending claims data
 */
const getMockPendingClaims = (user: string, asset: string) => {
    // Return mock claims that match various LTV combinations
    return {
        claims: [
            {
                max_ltv: "0.75",
                max_borrow_ltv: "0.70",
                pending_amount: "125000" // 0.125 CDT
            },
            {
                max_ltv: "0.80",
                max_borrow_ltv: "0.75",
                pending_amount: "90000" // 0.09 CDT
            },
            {
                max_ltv: "0.70",
                max_borrow_ltv: "0.65",
                pending_amount: "60000" // 0.06 CDT
            },
            {
                max_ltv: "0.85",
                max_borrow_ltv: "0.80",
                pending_amount: "187500" // 0.1875 CDT
            },
            {
                max_ltv: "0.65",
                max_borrow_ltv: "0.60",
                pending_amount: "45000" // 0.045 CDT
            },
            {
                max_ltv: "0.72",
                max_borrow_ltv: "0.68",
                pending_amount: "100000" // 0.1 CDT
            }
        ]
    }
}

/**
 * Get pending claims for a user and asset
 */
export const getPendingClaims = async (
    client: CosmWasmClient | null,
    user: string,
    asset: string,
    contractAddr?: string
) => {
    // Use mock data if enabled
    if (USE_MOCK_DATA) {
        await new Promise(resolve => setTimeout(resolve, 100))
        return getMockPendingClaims(user, asset)
    }

    if (!client) return null

    const discoContract = contractAddr || (contracts as any).ltv_disco
    if (!discoContract || discoContract === "") return null

    try {
        const response = await client.queryContractSmart(discoContract, {
            pending_claims: { user, asset }
        })
        return response
    } catch (error) {
        console.error("Error querying pending claims:", error)
        return null
    }
}

/**
 * Get daily TVL history
 */
export const getDailyTVL = async (
    client: CosmWasmClient | null,
    contractAddr?: string
) => {
    if (!client) return null

    const discoContract = contractAddr || (contracts as any).ltv_disco
    if (!discoContract || discoContract === "") return null

    try {
        const response = await client.queryContractSmart(discoContract, {
            get_daily_tvl: {}
        })
        return response
    } catch (error) {
        console.error("Error querying daily TVL:", error)
        return null
    }
}

/**
 * Get daily LTV history for an asset
 */
export const getDailyLTV = async (
    client: CosmWasmClient | null,
    asset: string,
    contractAddr?: string
) => {
    if (!client) return null

    const discoContract = contractAddr || (contracts as any).ltv_disco
    if (!discoContract || discoContract === "") return null

    try {
        const response = await client.queryContractSmart(discoContract, {
            get_daily_ltv: { asset }
        })
        return response
    } catch (error) {
        console.error("Error querying daily LTV:", error)
        return null
    }
}

/**
 * Get revenue events for a specific group
 */
export const getRevenueEvents = async (
    client: CosmWasmClient | null,
    asset: string,
    ltv: string,
    maxBorrowLtv: string,
    contractAddr?: string
) => {
    if (!client) return null

    const discoContract = contractAddr || (contracts as any).ltv_disco
    if (!discoContract || discoContract === "") return null

    try {
        const response = await client.queryContractSmart(discoContract, {
            get_revenue_events: {
                asset,
                max_ltv: ltv,
                max_borrow_ltv: maxBorrowLtv
            }
        })
        return response
    } catch (error) {
        console.error("Error querying revenue events:", error)
        return null
    }
}

/**
 * Get cumulative revenue for an asset, optionally filtered by LTV
 */
export const getCumulativeRevenue = async (
    client: CosmWasmClient | null,
    asset: string,
    maxLtv?: string,
    maxBorrowLtv?: string,
    contractAddr?: string
) => {
    if (!client) return null

    const discoContract = contractAddr || (contracts as any).ltv_disco
    if (!discoContract || discoContract === "") return null

    try {
        const query: any = {
            asset
        }
        if (maxLtv) {
            query.max_ltv = maxLtv
        }
        if (maxBorrowLtv) {
            query.max_borrow_ltv = maxBorrowLtv
        }

        const response = await client.queryContractSmart(discoContract, {
            get_cumulative_revenue: query
        })
        return response
    } catch (error) {
        console.error("Error querying cumulative revenue:", error)
        return null
    }
}

/**
 * Get all assets that have LTV queues
 */
export const getAssets = async (
    client: CosmWasmClient | null,
    contractAddr?: string
) => {
    // Use mock data if enabled
    if (USE_MOCK_DATA) {
        await new Promise(resolve => setTimeout(resolve, 100))
        return getMockDiscoAssets()
    }

    if (!client) return null

    const discoContract = contractAddr || (contracts as any).ltv_disco
    if (!discoContract || discoContract === "") return null

    try {
        const response = await client.queryContractSmart(discoContract, {
            get_assets: {}
        })
        return response
    } catch (error) {
        console.error("Error querying assets:", error)
        return null
    }
}

/**
 * Get total insurance (reuses from flywheel service)
 */
export { getDiscoTotalInsurance as getTotalInsurance } from '@/services/flywheel'

/**
 * Chart data point for Disco revenue
 */
export interface DiscoChartDataPoint {
    timestamp: number
    revenue: number
    tvl?: number
}

/**
 * Transform disco revenue events or lifetime revenue into chart data format
 */
export const transformDiscoToChartData = (
    revenueData: any[],
    dailyTVL?: any[]
): DiscoChartDataPoint[] => {
    if (!revenueData || revenueData.length === 0) return []

    // Create a map of TVL by timestamp if available
    const tvlMap = new Map<number, number>()
    if (dailyTVL && Array.isArray(dailyTVL)) {
        dailyTVL.forEach((entry: any) => {
            const timestamp = entry.timestamp || entry.time || 0
            const tvl = parseFloat(entry.tvl || entry.value || "0") / 1_000_000
            tvlMap.set(timestamp, tvl)
        })
    }

    return revenueData.map((entry) => {
        const timestamp = entry.timestamp || entry.time || 0
        const revenue = parseFloat(entry.revenue || entry.amount || "0") / 1_000_000
        const tvl = tvlMap.get(timestamp)

        return {
            timestamp,
            revenue,
            ...(tvl !== undefined && { tvl }),
        }
    }).sort((a, b) => a.timestamp - b.timestamp)
}

