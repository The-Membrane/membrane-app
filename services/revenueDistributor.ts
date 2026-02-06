import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate'

/**
 * Get current epoch revenue accumulation per asset
 */
export const getCurrentEpochRevenue = async (
    client: CosmWasmClient | null,
    contractAddr: string
) => {
    if (!client || !contractAddr) return null

    try {
        const response = await client.queryContractSmart(contractAddr, {
            current_epoch_revenue: {}
        })
        return response
    } catch (error) {
        console.error("Error querying current epoch revenue:", error)
        return null
    }
}

/**
 * Get epoch countdown information
 */
export const getEpochCountdown = async (
    client: CosmWasmClient | null,
    contractAddr: string
) => {
    if (!client || !contractAddr) return null

    try {
        const response = await client.queryContractSmart(contractAddr, {
            epoch_countdown: {}
        })
        return response
    } catch (error) {
        console.error("Error querying epoch countdown:", error)
        return null
    }
}


