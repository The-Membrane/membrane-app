import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import contracts from '@/config/contracts.json'
import { getMockPendingLocks, getMockUserDeposits, getMockUserHistory, getMockLockdropConfig, getMockUserIntents } from '@/components/acquisition/mockData'
import type { UserIntentsResponse } from '@/types/acquisitionIntents'

// Set to true to use mock data instead of querying contract
const USE_MOCK_DATA = true // Change to false when contract is ready

/**
 * Get user deposits from acquisition contract
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

    const lockdropContract = contractAddr || (contracts as any).acquisition
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

    // Use mock data if enabled
    if (USE_MOCK_DATA) {
        // Simulate async delay
        await new Promise(resolve => setTimeout(resolve, 150))
        const result = getMockPendingLocks()
        return result
    }

    if (!client) {
        return null
    }

    const lockdropContract = contractAddr || (contracts as any).acquisition
    if (!lockdropContract || lockdropContract === "") {
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

    const lockdropContract = contractAddr || (contracts as any).acquisition
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

    const lockdropContract = contractAddr || (contracts as any).acquisition
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

    const lockdropContract = contractAddr || (contracts as any).acquisition
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
 * Get user's stored ongoing intents from acquisition contract
 */
/**
 * Types for acquisition history and model state
 */
export interface AcquisitionHistoryEntry {
    window_id: number
    timestamp: number
    current_acquisition_rate: string
    bump_rate: string
    accrued_pool: string
    pool_maxed: boolean
    utilization: string
    efficiency: string | null
    total_new_deposits: string
}

export interface AcquisitionHistoryResponse {
    history: AcquisitionHistoryEntry[]
}

export interface AcquisitionModelStateData {
    current_acquisition_rate: string
    accrued_pool: string
    last_accrual_time: number
    pool_maxed: boolean
    bump_rate: string
    last_bump_time: number
    window_timers_started: boolean
    first_deposit_time: number | null
    deposit_event_count: number
    total_new_deposits: string
    last_mutation_efficiency: string | null
    last_mutation_time: number | null
    efficiency_clamped: boolean
}

export interface AcquisitionModelStateResponse {
    state: AcquisitionModelStateData | null
}

export interface AcquisitionWindowData {
    window_id: number
    start_time: number
    deposit_end: number
    withdrawal_end: number
    deposit_period_days: number
    total_deposit_amount: string
    acquisition_budget: string
}

export interface CurrentAcquisitionWindowResponse {
    window: AcquisitionWindowData | null
}

// Mock acquisition history (simulates ~30 days of control system snapshots)
const getMockAcquisitionHistory = (): AcquisitionHistoryResponse => {
    const now = Math.floor(Date.now() / 1000)
    const DAY = 86400
    const history: AcquisitionHistoryEntry[] = []

    for (let i = 30; i >= 0; i--) {
        const ts = now - i * DAY
        const dayIndex = 30 - i
        // Rate starts at 0.5 and adjusts based on utilization
        const rate = 0.5 + dayIndex * 0.02 + Math.sin(dayIndex * 0.4) * 0.05
        // Bump rate increases when utilization is above target
        const bump = Math.max(0, dayIndex * 0.003 + Math.sin(dayIndex * 0.3) * 0.002)
        // Accrued pool grows over time
        const accrued = dayIndex * 1_500_000
        // Utilization oscillates around target
        const util = 0.45 + Math.sin(dayIndex * 0.25) * 0.15
        // Efficiency = deposits / accrued
        const totalDeposits = dayIndex * 800_000
        const eff = accrued > 0 ? totalDeposits / accrued : null

        history.push({
            window_id: 1,
            timestamp: ts,
            current_acquisition_rate: rate.toFixed(6),
            bump_rate: bump.toFixed(6),
            accrued_pool: String(Math.round(accrued) * 1_000_000), // uMBRN
            pool_maxed: dayIndex > 25,
            utilization: util.toFixed(6),
            efficiency: eff !== null ? eff.toFixed(6) : null,
            total_new_deposits: String(Math.round(totalDeposits) * 1_000_000), // uCDT
        })
    }

    return { history }
}

const getMockAcquisitionModelState = (): AcquisitionModelStateResponse => {
    const now = Math.floor(Date.now() / 1000)
    return {
        state: {
            current_acquisition_rate: '1.100000',
            accrued_pool: '45000000000000', // 45M uMBRN
            last_accrual_time: now - 3600,
            pool_maxed: false,
            bump_rate: '0.090000',
            last_bump_time: now - 7200,
            window_timers_started: true,
            first_deposit_time: now - 86400 * 25,
            deposit_event_count: 147,
            total_new_deposits: '24000000000000', // 24M uCDT
            last_mutation_efficiency: '0.533333',
            last_mutation_time: now - 3600,
            efficiency_clamped: false,
        }
    }
}

const getMockCurrentAcquisitionWindow = (): CurrentAcquisitionWindowResponse => {
    const now = Math.floor(Date.now() / 1000)
    return {
        window: {
            window_id: 1,
            start_time: now - 86400 * 30,
            deposit_end: now - 86400 * 16,
            withdrawal_end: now - 86400 * 9,
            deposit_period_days: 14,
            total_deposit_amount: '24000000000000', // 24M uCDT
            acquisition_budget: '45000000000000', // 45M uMBRN
        }
    }
}

/**
 * Get acquisition history entries from contract
 */
export const getAcquisitionHistory = async (
    client: CosmWasmClient | null,
    windowId?: number,
    contractAddr?: string
): Promise<AcquisitionHistoryResponse | null> => {
    if (USE_MOCK_DATA) {
        await new Promise(resolve => setTimeout(resolve, 100))
        return getMockAcquisitionHistory()
    }

    if (!client) return null

    const acquisitionContract = contractAddr || (contracts as any).acquisition
    if (!acquisitionContract || acquisitionContract === '') return null

    try {
        const response = await client.queryContractSmart(acquisitionContract, {
            acquisition_history: { window_id: windowId ?? null }
        })
        return response as AcquisitionHistoryResponse
    } catch (error) {
        console.error('Error querying acquisition history:', error)
        return null
    }
}

/**
 * Get live acquisition model state
 */
export const getAcquisitionModelState = async (
    client: CosmWasmClient | null,
    contractAddr?: string
): Promise<AcquisitionModelStateResponse | null> => {
    if (USE_MOCK_DATA) {
        await new Promise(resolve => setTimeout(resolve, 100))
        return getMockAcquisitionModelState()
    }

    if (!client) return null

    const acquisitionContract = contractAddr || (contracts as any).acquisition
    if (!acquisitionContract || acquisitionContract === '') return null

    try {
        const response = await client.queryContractSmart(acquisitionContract, {
            acquisition_model_state: {}
        })
        return response as AcquisitionModelStateResponse
    } catch (error) {
        console.error('Error querying acquisition model state:', error)
        return null
    }
}

/**
 * Get current acquisition window details
 */
export const getCurrentAcquisitionWindow = async (
    client: CosmWasmClient | null,
    contractAddr?: string
): Promise<CurrentAcquisitionWindowResponse | null> => {
    if (USE_MOCK_DATA) {
        await new Promise(resolve => setTimeout(resolve, 100))
        return getMockCurrentAcquisitionWindow()
    }

    if (!client) return null

    const acquisitionContract = contractAddr || (contracts as any).acquisition
    if (!acquisitionContract || acquisitionContract === '') return null

    try {
        const response = await client.queryContractSmart(acquisitionContract, {
            current_acquisition_window: {}
        })
        return response as CurrentAcquisitionWindowResponse
    } catch (error) {
        console.error('Error querying current acquisition window:', error)
        return null
    }
}

/**
 * Get user's stored ongoing intents from acquisition contract
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

    const lockdropContract = contractAddr || (contracts as any).acquisition
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

