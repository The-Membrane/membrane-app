import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import contracts from '@/config/contracts.json'

/**
 * Get LTV queue for an asset
 */
export const getLTVQueue = async (
    client: CosmWasmClient | null,
    asset: string,
    contractAddr?: string
) => {
    if (!client) return null

    const discoContract = contractAddr || (contracts as any).ltv_disco
    if (!discoContract || discoContract === "") return null

    try {
        const response = await client.queryContractSmart(discoContract, {
            get_ltv_queue: { asset }
        })
        return response
    } catch (error) {
        console.error("Error querying LTV queue:", error)
        return null
    }
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
 * Get pending claims for a user and asset
 */
export const getPendingClaims = async (
    client: CosmWasmClient | null,
    user: string,
    asset: string,
    contractAddr?: string
) => {
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
 * Get all assets that have LTV queues
 */
export const getAssets = async (
    client: CosmWasmClient | null,
    contractAddr?: string
) => {
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

