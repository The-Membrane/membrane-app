import contracts from '@/config/contracts.json'
import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import type { MbrnIntentOption } from '@/types/lockdropIntents'
import { getMockIntentBoosts } from '@/components/trans-lockdrop/mockData'

// Set to true to use mock data instead of querying contract
const USE_MOCK_DATA = true // Change to false when contract is ready

export interface UserBoostResponse {
    user: string
    boost: string // Decimal string
}

export interface UserDiscountResponse {
    user: string
    discount: string // Decimal string
}

export interface IntentBoostsResponse {
    boosts: string[] // Array of Decimal strings representing boost percentages
}

/**
 * Get mock boost data
 */
const getMockBoost = (user: string): UserBoostResponse => {
    // Mock: 15M MBRN = 15% boost
    return {
        user,
        boost: '0.15' // 15% boost
    }
}

/**
 * Get mock discount data
 */
const getMockDiscount = (user: string): UserDiscountResponse => {
    // Mock: 5% discount (based on MBRN holdings and time in network)
    return {
        user,
        discount: '0.05' // 5% discount
    }
}

/**
 * Query user boost from system_discounts contract
 */
export const getUserBoost = async (
    client: CosmWasmClient | null,
    user: string
): Promise<UserBoostResponse | null> => {
    if (!client || !user) {
        return getMockBoost(user || 'mock-user')
    }

    const systemDiscountsContract = (contracts as any).system_discounts
    if (!systemDiscountsContract || systemDiscountsContract === '') {
        return getMockBoost(user)
    }

    try {
        const response = await client.queryContractSmart(systemDiscountsContract, {
            user_boost: { user }
        })
        return response as UserBoostResponse
    } catch (error) {
        console.error('Error querying user boost:', error)
        // Return mock data on error
        return getMockBoost(user)
    }
}

/**
 * Query user discount from system_discounts contract
 */
export const getUserDiscount = async (
    client: CosmWasmClient | null,
    user: string
): Promise<UserDiscountResponse | null> => {
    if (!client || !user) {
        return getMockDiscount(user || 'mock-user')
    }

    const systemDiscountsContract = (contracts as any).system_discounts
    if (!systemDiscountsContract || systemDiscountsContract === '') {
        return getMockDiscount(user)
    }

    try {
        const response = await client.queryContractSmart(systemDiscountsContract, {
            user_discount: { user }
        })
        return response as UserDiscountResponse
    } catch (error) {
        console.error('Error querying user discount:', error)
        // Return mock data on error
        return getMockDiscount(user)
    }
}

/**
 * Query intent boosts from system_discounts contract
 */
export const getIntentBoosts = async (
    client: CosmWasmClient | null,
    intents: MbrnIntentOption[]
): Promise<IntentBoostsResponse | null> => {
    // Use mock data if enabled
    if (USE_MOCK_DATA) {
        await new Promise(resolve => setTimeout(resolve, 100))
        return getMockIntentBoosts(intents)
    }

    if (!client || !intents || intents.length === 0) {
        return { boosts: [] }
    }

    const systemDiscountsContract = (contracts as any).system_discounts
    if (!systemDiscountsContract || systemDiscountsContract === '') {
        return { boosts: [] }
    }

    try {
        const response = await client.queryContractSmart(systemDiscountsContract, {
            intent_boosts: { intents }
        })
        return response as IntentBoostsResponse
    } catch (error) {
        console.error('Error querying intent boosts:', error)
        return { boosts: [] }
    }
}
