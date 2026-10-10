import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import contracts from '@/config/contracts.json'

const USE_MOCK_DATA = true

/**
 * Reward history entry returned from the contract
 */
export interface RewardHistoryEntry {
    timestamp: number
    amount: string
    reward_type?: string
}

/**
 * Response shape for the get_reward_history query
 */
export interface RewardHistoryResponse {
    history: RewardHistoryEntry[]
}

/**
 * Mock reward history data for development
 */
const getMockRewardHistory = (user: string): RewardHistoryResponse => {
    if (!user) return { history: [] }

    const now = Math.floor(Date.now() / 1000)
    const history: RewardHistoryEntry[] = []

    // Generate 15 reward history entries over the past 30 days
    for (let i = 14; i >= 0; i--) {
        const timestamp = now - (i * 2 * 86400) // Every 2 days
        const amount = String(Math.floor(Math.random() * 500_000) + 50_000) // 50k - 550k uMBRN

        history.push({
            timestamp,
            amount,
            reward_type: i % 3 === 0 ? 'lockdrop' : 'acquisition',
        })
    }

    return { history }
}

/**
 * Get user's acquisition reward history from the contract
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

    const lockdropContract = contractAddr || (contracts as any).acquisition
    if (!lockdropContract || lockdropContract === "") return null

    try {
        const response = await client.queryContractSmart(lockdropContract, {
            get_reward_history: { user }
        })
        return response as RewardHistoryResponse
    } catch (error) {
        console.error("Error querying reward history:", error)
        return null
    }
}
