/**
 * Service layer for the LTV Disco contract.
 * Slots are keyed by LTV percentage (higher LTV = riskiest, lower LTV = safest).
 *
 * Withdrawal is 2-step: request_unstake → cooldown (2 days) → complete_unstake.
 * Claims are per-asset: claim_revenue_for_user { user, asset }.
 */

import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import contracts from '@/config/contracts.json'
import {
  getMockDiscoUserDeposits,
  getMockDiscoLifetimeRevenue,
  getMockDiscoAssets,
  getMockPendingClaims,
  getMockUnstakeRequests,
  getMockSlotWeights,
  getMockAssetQueue,
  getMockManagerPerformance,
} from './discoMockData'
import type { ManagerPerformanceResponse } from '@/components/Disco/types'

// Set to true to use mock data instead of querying contract
const USE_MOCK_DATA = true // Change to false when contract is ready

/**
 * Get asset queue(s) containing LTV-designated slots.
 * If assets is empty, returns all queues (paginated).
 * Returns { queues: [asset_name, queue][] }
 */
export const getAssetQueues = async (
    client: CosmWasmClient | null,
    assets: string[],
    contractAddr?: string,
    limit?: number,
    startAfter?: string
) => {
    if (USE_MOCK_DATA) {
        await new Promise(resolve => setTimeout(resolve, 100))
        return getMockAssetQueue(assets)
    }

    if (!client) return null

    const discoContract = contractAddr || (contracts as any).ltv_disco
    if (!discoContract || discoContract === "") return null

    try {
        const response = await client.queryContractSmart(discoContract, {
            get_asset_queue: {
                assets,
                limit: limit ?? null,
                start_after: startAfter ?? null,
            }
        })
        return response as { queues: [string, any][] }
    } catch (error) {
        console.error("Error querying asset queues:", error)
        return null
    }
}

/**
 * Get asset queue for a single asset (convenience wrapper).
 * Returns { queue: { slots: DiscoSlot[], current_deposit_id, min_ltv, max_ltv } } or null.
 */
export const getAssetQueue = async (
    client: CosmWasmClient | null,
    asset: string,
    contractAddr?: string
) => {
    const response = await getAssetQueues(client, [asset], contractAddr)
    if (!response || !response.queues || response.queues.length === 0) return null
    return { queue: response.queues[0][1] }
}

/**
 * Get all user deposits across all assets.
 * Returns { deposits: UserDepositInfo[] }
 */
export const getAllUserDeposits = async (
    client: CosmWasmClient | null,
    user: string,
    contractAddr?: string
) => {
    if (USE_MOCK_DATA) {
        await new Promise(resolve => setTimeout(resolve, 100))
        return getMockDiscoUserDeposits(user)
    }

    if (!client) return null

    const discoContract = contractAddr || (contracts as any).ltv_disco
    if (!discoContract || discoContract === "") return null

    try {
        const response = await client.queryContractSmart(discoContract, {
            get_all_user_deposits: { user }
        })
        return response
    } catch (error) {
        console.error("Error querying all user deposits:", error)
        return null
    }
}

/**
 * Get pending unstake requests for a user and asset.
 * Returns { requests: UnstakeRequest[] }
 */
export const getUnstakeRequests = async (
    client: CosmWasmClient | null,
    user: string,
    asset: string,
    contractAddr?: string
) => {
    if (USE_MOCK_DATA) {
        await new Promise(resolve => setTimeout(resolve, 100))
        return getMockUnstakeRequests(user, asset)
    }

    if (!client) return null

    const discoContract = contractAddr || (contracts as any).ltv_disco
    if (!discoContract || discoContract === "") return null

    try {
        const response = await client.queryContractSmart(discoContract, {
            get_unstake_requests: { user, asset }
        })
        return response
    } catch (error) {
        console.error("Error querying unstake requests:", error)
        return null
    }
}

/**
 * Get effective unlock time for an unstake request, accounting for liquidation lockout.
 * Returns { request_unlock_time, effective_unlock_time, last_liquidation_timestamp, is_locked_by_liquidation }
 */
export const getEffectiveUnlockTime = async (
    client: CosmWasmClient | null,
    asset: string,
    slot: number,
    depositId: string,
    user: string,
    contractAddr?: string
) => {
    if (!client) return null

    const discoContract = contractAddr || (contracts as any).ltv_disco
    if (!discoContract || discoContract === "") return null

    try {
        const response = await client.queryContractSmart(discoContract, {
            get_effective_unlock_time: {
                asset,
                slot,
                deposit_id: depositId,
                user,
            }
        })
        return response as {
            request_unlock_time: number
            effective_unlock_time: number
            last_liquidation_timestamp: number | null
            is_locked_by_liquidation: boolean
        }
    } catch (error) {
        console.error("Error querying effective unlock time:", error)
        return null
    }
}

/**
 * Get user's lifetime revenue for an asset.
 * Returns UserLifetimeRevenueEntry[]
 */
export const getUserLifetimeRevenue = async (
    client: CosmWasmClient | null,
    user: string,
    asset: string,
    contractAddr?: string
) => {
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
 * Get pending claims for a user and asset.
 * Returns { claims: { slot, deposit_id, pending_amount }[] }
 */
export const getPendingClaims = async (
    client: CosmWasmClient | null,
    user: string,
    asset: string,
    contractAddr?: string
) => {
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
 * Get daily TVL history.
 * Returns { entries: TVLEntry[] }
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
 * Get daily deposit history for an asset.
 * Returns { entries: DepositEntry[] }
 */
export const getDailyDeposits = async (
    client: CosmWasmClient | null,
    asset: string,
    contractAddr?: string
) => {
    if (!client) return null

    const discoContract = contractAddr || (contracts as any).ltv_disco
    if (!discoContract || discoContract === "") return null

    try {
        const response = await client.queryContractSmart(discoContract, {
            get_daily_deposits: { asset }
        })
        return response
    } catch (error) {
        console.error("Error querying daily deposits:", error)
        return null
    }
}

/**
 * Get revenue events for a specific slot.
 */
export const getRevenueEvents = async (
    client: CosmWasmClient | null,
    asset: string,
    slot: number,
    contractAddr?: string
) => {
    if (!client) return null

    const discoContract = contractAddr || (contracts as any).ltv_disco
    if (!discoContract || discoContract === "") return null

    try {
        const response = await client.queryContractSmart(discoContract, {
            get_revenue_events: { asset, slot }
        })
        return response
    } catch (error) {
        console.error("Error querying revenue events:", error)
        return null
    }
}

/**
 * Get cumulative revenue for an asset, optionally filtered by slot.
 */
export const getCumulativeRevenue = async (
    client: CosmWasmClient | null,
    asset: string,
    slot?: number,
    contractAddr?: string
) => {
    if (!client) return null

    const discoContract = contractAddr || (contracts as any).ltv_disco
    if (!discoContract || discoContract === "") return null

    try {
        const query: any = { asset }
        if (slot !== undefined) {
            query.slot = slot
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
 * Get computed revenue weights for all slots.
 * Returns { weights: [slot, decimal_weight][] }
 */
export const getSlotWeights = async (
    client: CosmWasmClient | null,
    asset: string,
    contractAddr?: string
) => {
    if (USE_MOCK_DATA) {
        await new Promise(resolve => setTimeout(resolve, 100))
        return getMockSlotWeights(asset)
    }

    if (!client) return null

    const discoContract = contractAddr || (contracts as any).ltv_disco
    if (!discoContract || discoContract === "") return null

    try {
        const response = await client.queryContractSmart(discoContract, {
            get_slot_weights: { asset }
        })
        return response
    } catch (error) {
        console.error("Error querying slot weights:", error)
        return null
    }
}

/**
 * Get user's total deposits value.
 * Returns { total_deposits: Uint128 }
 */
export const getUserTotalDeposits = async (
    client: CosmWasmClient | null,
    user: string,
    contractAddr?: string
) => {
    if (!client) return null

    const discoContract = contractAddr || (contracts as any).ltv_disco
    if (!discoContract || discoContract === "") return null

    try {
        const response = await client.queryContractSmart(discoContract, {
            user_total_deposits: { user }
        })
        return response
    } catch (error) {
        console.error("Error querying user total deposits:", error)
        return null
    }
}

/**
 * Convert vault tokens to deposit tokens for a slot.
 */
export const getVaultTokenConversion = async (
    client: CosmWasmClient | null,
    asset: string,
    slot: number,
    vaultTokens: string,
    contractAddr?: string
) => {
    if (!client) return null

    const discoContract = contractAddr || (contracts as any).ltv_disco
    if (!discoContract || discoContract === "") return null

    try {
        const response = await client.queryContractSmart(discoContract, {
            vault_token_conversion: {
                asset,
                slot,
                vault_tokens: vaultTokens,
            }
        })
        return response
    } catch (error) {
        console.error("Error querying vault token conversion:", error)
        return null
    }
}

/**
 * Get all assets that have queues.
 * Returns { assets: string[] }
 */
export const getAssets = async (
    client: CosmWasmClient | null,
    contractAddr?: string
) => {
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
 * Get historic manager performance (fees, losses, capital managed over time).
 * Returns { manager, entries: ManagerPerformanceEntry[] }
 */
export const getManagerPerformance = async (
    client: CosmWasmClient | null,
    manager: string,
    contractAddr?: string
): Promise<ManagerPerformanceResponse | null> => {
    if (USE_MOCK_DATA) {
        await new Promise(resolve => setTimeout(resolve, 100))
        return getMockManagerPerformance(manager)
    }

    if (!client || !manager) return null

    const discoContract = contractAddr || (contracts as any).ltv_disco
    if (!discoContract || discoContract === "") return null

    try {
        const response = await client.queryContractSmart(discoContract, {
            get_manager_performance: { manager }
        })
        return response as ManagerPerformanceResponse
    } catch (error) {
        console.error("Error querying manager performance:", error)
        return null
    }
}

/**
 * Get total insurance (reuses from flywheel service)
 */
export { getDiscoTotalInsurance as getTotalInsurance } from '@/services/flywheel'

/**
 * Alias for backwards compatibility.
 */
export const getUserDeposits = getAllUserDeposits

/**
 * Stub: locked deposits were removed in the slot-based disco refactor.
 * Returns empty locked_deposits so consumers degrade gracefully.
 */
export const getUserLockedDeposits = async (
    _client: CosmWasmClient | null,
    _user: string,
    _contractAddr?: string
) => {
    return { locked_deposits: [] as any[] }
}

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
