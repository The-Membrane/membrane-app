import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import contracts from '@/config/contracts.json'
import { getMockPendingLocks, getMockUserDeposits, getMockUserHistory, getMockLockdropConfig, getMockUserIntents } from '@/components/trans-lockdrop/mockData'
import type { UserIntentsResponse } from '@/types/lockdropIntents'

// Set to true to use mock data instead of querying contract
const USE_MOCK_DATA = true // Change to false when contract is ready

/**
 * Get user deposits from transmuter-lockdrop contract
 */
export const getUserDeposits = async (
    client: CosmWasmClient | null,
    user: string,
    contractAddr?: string
) => {
    // Use mock data if enabled
    if (USE_MOCK_DATA) {
        const mockData = getMockUserDeposits(user)
        if (mockData) {
            // Simulate async delay
            await new Promise(resolve => setTimeout(resolve, 100))
            return mockData
        }
        return null
    }

    if (!client) return null

    const lockdropContract = contractAddr || (contracts as any).transmuter_lockdrop
    if (!lockdropContract || lockdropContract === "") return null

    try {
        const response = await client.queryContractSmart(lockdropContract, {
            user_deposits: { user }
        })
        return response
    } catch (error) {
        console.error("Error querying user deposits:", error)
        return null
    }
}

/**
 * Get pending locks (list of users with pending locks)
 */
export const getPendingLocks = async (
    client: CosmWasmClient | null,
    contractAddr?: string
) => {
    console.log('getPendingLocks called, USE_MOCK_DATA:', USE_MOCK_DATA)

    // Use mock data if enabled
    if (USE_MOCK_DATA) {
        // Simulate async delay
        await new Promise(resolve => setTimeout(resolve, 150))
        const result = getMockPendingLocks()
        console.log('getPendingLocks returning mock data:', result)
        return result
    }

    if (!client) {
        console.log('getPendingLocks: No client, returning null')
        return null
    }

    const lockdropContract = contractAddr || (contracts as any).transmuter_lockdrop
    if (!lockdropContract || lockdropContract === "") {
        console.log('getPendingLocks: No contract address, returning null')
        return null
    }

    try {
        const response = await client.queryContractSmart(lockdropContract, {
            pending_locks: {}
        })
        return response
    } catch (error) {
        console.error("Error querying pending locks:", error)
        return null
    }
}

/**
 * Get current lockdrop state
 */
export const getCurrentLockdrop = async (
    client: CosmWasmClient | null,
    contractAddr?: string
) => {
    // Use mock data if enabled
    if (USE_MOCK_DATA) {
        // Simulate async delay
        await new Promise(resolve => setTimeout(resolve, 100))
        // Return mock lockdrop state with withdrawal_end in the past (for testing claims)
        const now = Math.floor(Date.now() / 1000)
        return {
            lockdrop: {
                start_time: now - 86400 * 30, // Started 30 days ago
                deposit_end: now - 86400 * 16, // Ended 16 days ago
                withdrawal_end: now - 86400 * 9, // Withdrawal ended 9 days ago (claims ready)
                total_deposit_points: "1000000000000", // Mock total points for calculations
            }
        }
    }

    if (!client) return null

    const lockdropContract = contractAddr || (contracts as any).transmuter_lockdrop
    if (!lockdropContract || lockdropContract === "") return null

    try {
        const response = await client.queryContractSmart(lockdropContract, {
            current_lockdrop: {}
        })
        return response
    } catch (error) {
        console.error("Error querying current lockdrop:", error)
        return null
    }
}

/**
 * Get all deposits from all users (queries pending locks users and aggregates)
 * Note: This queries users from pending_locks. For complete data, you may need
 * to query all users separately if there's a way to enumerate them.
 */
export const getAllDeposits = async (
    client: CosmWasmClient | null,
    contractAddr?: string
) => {
    if (!client) return null

    const pendingLocks = await getPendingLocks(client, contractAddr)
    if (!pendingLocks?.users || pendingLocks.users.length === 0) {
        return []
    }

    // Query deposits for all users
    const depositPromises = pendingLocks.users.map((user: string) =>
        getUserDeposits(client, user, contractAddr)
    )

    const results = await Promise.all(depositPromises)

    // Aggregate all deposits with user addresses
    const allDeposits: Array<{ user: string; deposit: any }> = []
    results.forEach((result, index) => {
        if (result?.deposits) {
            result.deposits.forEach((deposit: any) => {
                allDeposits.push({
                    user: pendingLocks.users[index],
                    deposit
                })
            })
        }
    })

    return allDeposits
}

/**
 * Get user's lockdrop history
 */
export const getUserHistory = async (
    client: CosmWasmClient | null,
    user: string,
    contractAddr?: string
) => {
    // Use mock data if enabled
    if (USE_MOCK_DATA) {
        await new Promise(resolve => setTimeout(resolve, 100))
        return getMockUserHistory(user)
    }

    if (!client) return null

    const lockdropContract = contractAddr || (contracts as any).transmuter_lockdrop
    if (!lockdropContract || lockdropContract === "") return null

    try {
        const response = await client.queryContractSmart(lockdropContract, {
            user_history: { user }
        })
        return response
    } catch (error) {
        console.error("Error querying user history:", error)
        return null
    }
}

/**
 * Get lockdrop config
 */
export const getLockdropConfig = async (
    client: CosmWasmClient | null,
    contractAddr?: string
) => {
    // Use mock data if enabled
    if (USE_MOCK_DATA) {
        await new Promise(resolve => setTimeout(resolve, 100))
        return getMockLockdropConfig()
    }

    if (!client) return null

    const lockdropContract = contractAddr || (contracts as any).transmuter_lockdrop
    if (!lockdropContract || lockdropContract === "") return null

    try {
        const response = await client.queryContractSmart(lockdropContract, {
            config: {}
        })
        return response
    } catch (error) {
        console.error("Error querying lockdrop config:", error)
        return null
    }
}

/**
 * Get user's stored ongoing intents from transmuter-lockdrop contract
 */
export const getUserIntents = async (
    client: CosmWasmClient | null,
    user: string,
    contractAddr?: string
): Promise<UserIntentsResponse | null> => {
    // Use mock data if enabled
    if (USE_MOCK_DATA) {
        await new Promise(resolve => setTimeout(resolve, 100))
        return getMockUserIntents(user)
    }

    if (!client || !user) return null

    const lockdropContract = contractAddr || (contracts as any).transmuter_lockdrop
    if (!lockdropContract || lockdropContract === "") return null

    try {
        const response = await client.queryContractSmart(lockdropContract, {
            user_intents: { user }
        })
        return response as UserIntentsResponse
    } catch (error) {
        // Query might not exist in contract yet, return null
        console.error("Error querying user intents (query may not exist):", error)
        return null
    }
}

