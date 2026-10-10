import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import contracts from '@/config/contracts.json'

// Set to true to use mock data instead of querying contract
const USE_MOCK_DATA = true // Change to false when contract is ready

/**
 * Reward history entry from the acquisition contract
 */
export interface RewardHistoryEntry {
    amount: string       // Uint128 as string
    asset: string        // Denom of the reward asset
    timestamp: number    // Unix timestamp
    source: string       // What generated the reward (e.g. "lockdrop", "staking")
}

export interface RewardHistoryResponse {
    history: RewardHistoryEntry[]
}

/**
 * Mock reward history for development
 */
const getMockRewardHistory = (user: string): RewardHistoryResponse => {
    if (!user) return { history: [] }

    const now = Math.floor(Date.now() / 1000)
    const history: RewardHistoryEntry[] = []

    // Generate 30 days of mock reward history entries
    for (let i = 30; i >= 0; i--) {
        if (i % 3 === 0) { // Entry every ~3 days
            const timestamp = now - (i * 24 * 60 * 60)
            const amount = String(Math.floor(Math.random() * 500_000) + 50_000)

            history.push({
                amount,
                asset: 'factory/neutron1mock/mbrn',
                timestamp,
                source: i % 6 === 0 ? 'staking' : 'lockdrop',
            })
        }
    }

    return { history }
}

/**
 * Get user's reward history from the acquisition contract.
 * Query msg: { get_reward_history: { user } }
 *
 * Returns { history: RewardHistoryEntry[] } or null on failure.
 */
export const getRewardHistory = async (
    client: CosmWasmClient | null,
    user: string,
    contractAddr?: string
): Promise<RewardHistoryResponse | null> => {
    // Use mock data if enabled
    if (USE_MOCK_DATA) {
        await new Promise(resolve => setTimeout(resolve, 100))
        return getMockRewardHistory(user)
    }

    if (!client || !user) return null

    const acquisitionContract = contractAddr || (contracts as any).acquisition
    if (!acquisitionContract || acquisitionContract === '') return null

    try {
        const response = await client.queryContractSmart(acquisitionContract, {
            get_reward_history: { user }
        })
        return response as RewardHistoryResponse
    } catch (error) {
        console.error('Error querying reward history:', error)
        return null
    }
}
