import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import contracts from '@/config/contracts.json'

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

    console.log('[getMockTransmuterVolumeHistory] Generated mock data:', {
        recordCount: result.records.length,
        firstRecord: result.records[0],
        lastRecord: result.records[result.records.length - 1],
        firstCumulative: result.records[0]?.cumulative_volume,
        lastCumulative: result.records[result.records.length - 1]?.cumulative_volume
    })

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

    console.log('[getMockTransmuterRateHistory] Generated mock rate history:', {
        recordCount: result.records.length,
        firstRate: result.records[0]?.conversion_rate,
        lastRate: result.records[result.records.length - 1]?.conversion_rate,
        firstTimestamp: result.records[0]?.timestamp,
        lastTimestamp: result.records[result.records.length - 1]?.timestamp
    })

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
        console.log('[transformVolumeHistoryToChartData] No volume history provided')
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

    console.log('[transformVolumeHistoryToChartData] Transformed data:', {
        inputLength: volumeHistory.length,
        outputLength: transformed.length,
        firstPoint: transformed[0],
        lastPoint: transformed[transformed.length - 1]
    })

    return transformed
}

