import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import contracts from '@/config/contracts.json'
import type { UserIntentsResponse } from '@/types/acquisitionIntents'

// Set to true to use mock data instead of querying contract
const USE_MOCK_DATA_TRANSMUTER = true // Change to false when contract is ready

/**
 * Get transmuter contract rate/APR
 */
export const getTransmuterRate = async (
    client: CosmWasmClient | null,
    contractAddr?: string
) => {
    // Use mock data if enabled
    if (USE_MOCK_DATA_TRANSMUTER) {
        await new Promise(resolve => setTimeout(resolve, 100))
        return { active: true } // Mock rate
    }

    if (!client) return null

    const transmuterContract = contractAddr || (contracts as any).transmuter
    if (!transmuterContract || transmuterContract === "") return null

    try {
        // Query rate or APR if available
        const response = await client.queryContractSmart(transmuterContract, {
            config: {}
        })
        // Adjust based on actual contract response structure
        return response
    } catch (error) {
        console.error("Error querying transmuter rate:", error)
        return null
    }
}

/**
 * Get transmuter rate history
 */
export const getTransmuterRateHistory = async (
    client: CosmWasmClient | null,
    contractAddr?: string,
    limit?: number
) => {
    // Use mock data if enabled
    if (USE_MOCK_DATA_TRANSMUTER) {
        await new Promise(resolve => setTimeout(resolve, 100))
        return getMockTransmuterRateHistory()
    }

    if (!client) return null

    const transmuterContract = contractAddr || (contracts as any).transmuter
    if (!transmuterContract || transmuterContract === "") return null

    try {
        const response = await client.queryContractSmart(transmuterContract, {
            rate_history: {
                limit: limit || 365,
                start_after: null
            }
        })
        return response
    } catch (error) {
        console.error("Error querying transmuter rate history:", error)
        return null
    }
}

/**
 * Calculate APR from rate history
 * Compares current rate to rate from 30 days ago and annualizes the return
 */
const calculateAPRFromRateHistory = (rateHistory: any[]): number | null => {
    if (!rateHistory || rateHistory.length < 2) return null

    // Sort by timestamp (oldest first)
    const sorted = [...rateHistory].sort((a, b) => {
        const timeA = a.timestamp?.seconds || a.timestamp || 0
        const timeB = b.timestamp?.seconds || b.timestamp || 0
        return timeA - timeB
    })

    const current = sorted[sorted.length - 1]
    const currentRate = parseFloat(current.conversion_rate || "0")
    const currentTime = current.timestamp?.seconds || current.timestamp || 0

    if (currentRate === 0) return null

    // Find rate from approximately 30 days ago (prefer closest to 30 days)
    const targetTime = currentTime - (30 * 24 * 60 * 60) // 30 days in seconds
    let pastRate = null
    let pastTime = 0

    // Find the closest entry to 30 days ago
    for (let i = sorted.length - 2; i >= 0; i--) {
        const entry = sorted[i]
        const entryTime = entry.timestamp?.seconds || entry.timestamp || 0
        const daysAgo = (currentTime - entryTime) / (24 * 60 * 60)

        // Use entry if it's between 20-40 days ago (prefer closer to 30)
        if (daysAgo >= 20 && daysAgo <= 40) {
            pastRate = parseFloat(entry.conversion_rate || "0")
            pastTime = entryTime
            break
        }
        // If we go too far back, use the last valid entry
        if (daysAgo > 40 && pastRate === null) {
            pastRate = parseFloat(entry.conversion_rate || "0")
            pastTime = entryTime
            break
        }
    }

    // If no suitable past rate found, try using the oldest entry if it's at least 7 days old
    if (pastRate === null && sorted.length > 0) {
        const oldest = sorted[0]
        const oldestTime = oldest.timestamp?.seconds || oldest.timestamp || 0
        const daysAgo = (currentTime - oldestTime) / (24 * 60 * 60)

        if (daysAgo >= 7) {
            pastRate = parseFloat(oldest.conversion_rate || "0")
            pastTime = oldestTime
        }
    }

    if (pastRate === null || pastRate === 0) return null

    // Calculate rate change
    const rateRatio = currentRate / pastRate

    // Calculate days between rates
    const daysElapsed = (currentTime - pastTime) / (24 * 60 * 60)

    if (daysElapsed <= 0) return null

    // Annualize: (rate_ratio)^(365/days_elapsed) - 1
    const annualizedReturn = Math.pow(rateRatio, 365 / daysElapsed) - 1

    // Convert to percentage
    return annualizedReturn * 100
}

/**
 * Get transmuter APR calculated from rate history
 */
export const getTransmuterAPR = async (
    client: CosmWasmClient | null,
    contractAddr?: string
): Promise<number | null> => {
    // Use mock data if enabled
    if (USE_MOCK_DATA_TRANSMUTER) {
        await new Promise(resolve => setTimeout(resolve, 100))
        const mockHistory = getMockTransmuterRateHistory()
        return calculateAPRFromRateHistory(mockHistory.records) || 4.5 // Fallback to 4.5% if calculation fails
    }

    if (!client) return null

    const transmuterContract = contractAddr || (contracts as any).transmuter
    if (!transmuterContract || transmuterContract === "") return null

    try {
        // Query rate history
        const rateHistory = await getTransmuterRateHistory(client, transmuterContract, 365)

        if (!rateHistory?.records || rateHistory.records.length < 2) {
            return null
        }

        // Calculate APR from rate history
        return calculateAPRFromRateHistory(rateHistory.records)
    } catch (error) {
        console.error("Error querying transmuter APR:", error)
        return null
    }
}

/**
 * Get transmuter volume history
 */
export const getTransmuterVolumeHistory = async (
    client: CosmWasmClient | null,
    contractAddr?: string,
    limit?: number
) => {
    // Use mock data if enabled
    if (USE_MOCK_DATA_TRANSMUTER) {
        await new Promise(resolve => setTimeout(resolve, 100))
        return getMockTransmuterVolumeHistory()
    }

    if (!client) return null

    const transmuterContract = contractAddr || (contracts as any).transmuter
    if (!transmuterContract || transmuterContract === "") return null

    try {
        const response = await client.queryContractSmart(transmuterContract, {
            volume_history: {
                limit: limit || 100,
                start_after: null
            }
        })
        return response
    } catch (error) {
        console.error("Error querying transmuter volume history:", error)
        return null
    }
}

/**
 * Mock volume history data
 */
const getMockTransmuterVolumeHistory = () => {
    const now = Math.floor(Date.now() / 1000)
    const daysAgo = 30
    const records = []

    // Start with a base cumulative volume (simulating historical volume before the 30-day window)
    // Using a smaller base to make the chart more readable (50M USDC = 50,000 after dividing by 1M)
    let cumulativeVolume = 50_000_000_000 // 50M in base units (50M USDC equivalent)

    for (let i = daysAgo; i >= 0; i--) {
        const timestamp = now - (i * 24 * 60 * 60)
        // Simulate volume windows every day with some variation
        const cdtSwapped = Math.floor(Math.random() * 3_000_000) + 500_000
        const cdtReceived = Math.floor(Math.random() * 2_900_000) + 490_000
        const pairedSwapped = Math.floor(Math.random() * 2_500_000) + 400_000
        const pairedReceived = Math.floor(Math.random() * 2_400_000) + 390_000

        // Calculate window total volume and add to cumulative
        // This represents the total volume for this time window
        const windowVolume = cdtSwapped + cdtReceived + pairedSwapped + pairedReceived
        cumulativeVolume += windowVolume

        records.push({
            cdt_swapped: String(cdtSwapped),
            cdt_received: String(cdtReceived),
            paired_asset_swapped: String(pairedSwapped),
            paired_asset_received: String(pairedReceived),
            block_time: { seconds: timestamp },
            cumulative_volume: String(cumulativeVolume)
        })
    }

    const result = {
        records: records.slice(-30), // Last 30 days
        total: records.length,
        next_start_after: null
    }

    return result
}

/**
 * Mock rate history data
 * Simulates rate history with increasing conversion rates to show positive APR
 */
const getMockTransmuterRateHistory = () => {
    const now = Math.floor(Date.now() / 1000)
    const daysAgo = 365
    const records = []

    // Start with a base rate (base tokens per 1_000_000_000_000 vault tokens)
    // Simulate a rate that increases over time to show yield
    // Starting rate: 1,000,000,000,000 (1:1 ratio initially)
    let baseRate = 1_000_000_000_000

    // Target APR: ~4.5% annually, so rate should increase by ~4.5% over 365 days
    // Daily increase: (1.045)^(1/365) - 1 ≈ 0.0001206 per day
    const dailyGrowthFactor = Math.pow(1.045, 1 / 365)

    for (let i = daysAgo; i >= 0; i--) {
        const timestamp = now - (i * 24 * 60 * 60)

        // Calculate rate for this day (increasing over time)
        // Add some small random variation to make it realistic
        const variation = 1 + (Math.random() - 0.5) * 0.001 // ±0.05% variation
        const currentRate = Math.floor(baseRate * variation)

        records.push({
            conversion_rate: String(currentRate),
            timestamp: { seconds: timestamp }
        })

        // Update base rate for next iteration (growing over time)
        baseRate = baseRate * dailyGrowthFactor
    }

    const result = {
        records: records.slice(-365), // Last 365 days
        total: records.length,
        next_start_after: null
    }

    return result
}

/**
 * Transform transmuter history to chart data format
 */
export interface TransmuterChartDataPoint {
    timestamp: number
    balance: number
    tvl: number
}

export const transformTransmuterToChartData = (
    history: any[]
): TransmuterChartDataPoint[] => {
    if (!history || history.length === 0) return []

    return history.map((entry) => ({
        timestamp: entry.timestamp || entry.time || 0,
        balance: parseFloat(entry.balance || entry.amount || "0") / 1_000_000,
        tvl: parseFloat(entry.tvl || entry.total_deposit_value || "0") / 1_000_000,
    })).sort((a, b) => a.timestamp - b.timestamp)
}

/**
 * Transform volume history to chart data format
 */
export interface TransmuterVolumeChartPoint {
    timestamp: number
    volume: number // Total volume (swapped + received)
}

export const transformVolumeHistoryToChartData = (
    volumeHistory: any[]
): TransmuterVolumeChartPoint[] => {
    if (!volumeHistory || volumeHistory.length === 0) {
        return []
    }

    const transformed = volumeHistory.map((window: any) => {
        // Use cumulative_volume field from the window
        const cumulativeVolumeStr = window.cumulative_volume || "0"
        const cumulativeVolume = parseFloat(cumulativeVolumeStr) / 1_000_000

        const timestamp = window.block_time?.seconds || window.block_time || 0

        return {
            timestamp,
            volume: cumulativeVolume
        }
    }).sort((a, b) => a.timestamp - b.timestamp)

    return transformed
}

/**
 * Get transmuter config (includes usage_fee and utilization threshold)
 */
export const getTransmuterConfig = async (
    client: CosmWasmClient | null,
    contractAddr?: string
) => {
    if (USE_MOCK_DATA_TRANSMUTER) {
        await new Promise(resolve => setTimeout(resolve, 100))
        return {
            usage_fee: "0.005", // 0.5%
            usage_fee_utilization_threshold: "0.8", // 80%
        }
    }

    if (!client) return null

    const transmuterContract = contractAddr || (contracts as any).transmuter
    if (!transmuterContract || transmuterContract === "") return null

    try {
        const response = await client.queryContractSmart(transmuterContract, {
            config: {}
        })
        return response
    } catch (error) {
        console.error("Error querying transmuter config:", error)
        return null
    }
}

/**
 * Get vault token denom from transmuter config
 */
export const getTransmuterVaultDenom = async (
    client: CosmWasmClient | null,
    contractAddr?: string
): Promise<string | null> => {
    if (USE_MOCK_DATA_TRANSMUTER) {
        return "factory/neutron1transmuter/vault-token"
    }

    if (!client) return null

    const transmuterContract = contractAddr || (contracts as any).transmuter
    if (!transmuterContract || transmuterContract === "") return null

    try {
        const response = await client.queryContractSmart(transmuterContract, {
            config: {}
        })
        return response?.vault_token_denom || null
    } catch (error) {
        console.error("Error querying transmuter vault denom:", error)
        return null
    }
}

/**
 * Get user's base transmuter deposit (vault tokens converted to USDC)
 */
export const getUserTransmuterDeposit = async (
    client: CosmWasmClient | null,
    userAddress: string,
    contractAddr?: string
): Promise<{ vaultTokens: string; underlyingUsdc: string } | null> => {
    if (USE_MOCK_DATA_TRANSMUTER) {
        await new Promise(resolve => setTimeout(resolve, 100))
        return { vaultTokens: "5000000000", underlyingUsdc: "5100000000" } // ~5.1K USDC
    }

    if (!client || !userAddress) return null

    const transmuterContract = contractAddr || (contracts as any).transmuter
    if (!transmuterContract || transmuterContract === "") return null

    try {
        // 1. Get vault token denom
        const vaultDenom = await getTransmuterVaultDenom(client, transmuterContract)
        if (!vaultDenom) return null

        // 2. Query user's vault token balance
        const balanceResponse = await client.getBalance(userAddress, vaultDenom)
        const vaultTokens = balanceResponse?.amount || "0"
        if (vaultTokens === "0") return { vaultTokens: "0", underlyingUsdc: "0" }

        // 3. Convert vault tokens to underlying USDC via VaultUnderlying query
        const underlyingResponse = await client.queryContractSmart(transmuterContract, {
            vault_underlying: { amount: vaultTokens }
        })
        const underlyingUsdc = underlyingResponse?.amount || vaultTokens

        return { vaultTokens, underlyingUsdc }
    } catch (error) {
        console.error("Error querying user transmuter deposit:", error)
        return null
    }
}

/**
 * Get transmuter vault info (balances for utilization calculation)
 */
export const getTransmuterVaultInfo = async (
    client: CosmWasmClient | null,
    contractAddr?: string
) => {
    if (USE_MOCK_DATA_TRANSMUTER) {
        await new Promise(resolve => setTimeout(resolve, 100))
        return {
            total_deposit_value: "50000000000", // 50M
            paired_asset_balance: "10000000000", // 10M → 80% utilization
            cdt_balance: "40000000000",
            deposit_total: "50000000000",
        }
    }

    if (!client) return null

    const transmuterContract = contractAddr || (contracts as any).transmuter
    if (!transmuterContract || transmuterContract === "") return null

    try {
        const response = await client.queryContractSmart(transmuterContract, {
            vault_info: {}
        })
        return response
    } catch (error) {
        console.error("Error querying transmuter vault info:", error)
        return null
    }
}

/**
 * Get user's intents from the transmuter contract
 * These intents control how the base transmuter deposit is directed (e.g., to insurance slots)
 */
export const getUserTransmuterIntents = async (
    client: CosmWasmClient | null,
    user: string,
    contractAddr?: string
): Promise<UserIntentsResponse | null> => {
    if (USE_MOCK_DATA_TRANSMUTER) {
        await new Promise(resolve => setTimeout(resolve, 100))
        // Mock: base transmuter deposit directed to Slot 3 (higher risk/higher reward)
        return {
            intents: [
                {
                    intent_type: {
                        deposit_via_mars_mirror: {
                            asset: "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4",
                            slot: 3,
                        },
                    },
                    ratio: "1.0",
                    lock: null,
                },
            ],
        }
    }

    if (!client || !user) return null

    const transmuterContract = contractAddr || (contracts as any).transmuter
    if (!transmuterContract || transmuterContract === "") return null

    try {
        const response = await client.queryContractSmart(transmuterContract, {
            user_intents: { user }
        })
        return response as UserIntentsResponse
    } catch (error) {
        console.error("Error querying transmuter user intents:", error)
        return null
    }
}

