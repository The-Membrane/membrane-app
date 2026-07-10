/**
 * Mock data for acquisition visualizer testing
 * Simulates real UserDeposit structure from the contract
 */

export interface MockUserDeposit {
    amount: string // Uint128 as string
    intended_lock_days: number
    deposit_time: number
    intents?: any[]
}

export interface MockUserDepositsResponse {
    deposits: MockUserDeposit[]
}

/**
 * Generate mock deposits with varied amounts and lock days
 * Creates realistic test data with different lock day groups
 */
export const generateMockDeposits = (): Array<{ user: string; deposits: MockUserDeposit[] }> => {
    const users: Array<{ user: string; deposits: MockUserDeposit[] }> = []
    const baseTime = Math.floor(Date.now() / 1000) - 86400 * 30 // 30 days ago

    // Group 1: Short locks (3-30 days) - smaller deposits
    for (let i = 0; i < 8; i++) {
        users.push({
            user: `user_short_${i}`,
            deposits: [{
                amount: String(Math.floor(Math.random() * 500_000) + 50_000), // 50k - 550k
                intended_lock_days: Math.floor(Math.random() * 27) + 3, // 3-30 days
                deposit_time: baseTime + Math.random() * 86400 * 10,
            }]
        })
    }

    // Group 2: Medium locks (31-90 days) - medium deposits
    for (let i = 0; i < 12; i++) {
        users.push({
            user: `user_medium_${i}`,
            deposits: [{
                amount: String(Math.floor(Math.random() * 2_000_000) + 200_000), // 200k - 2.2M
                intended_lock_days: Math.floor(Math.random() * 60) + 31, // 31-90 days
                deposit_time: baseTime + Math.random() * 86400 * 15,
            }]
        })
    }

    // Group 3: Long locks (91-180 days) - larger deposits
    for (let i = 0; i < 10; i++) {
        users.push({
            user: `user_long_${i}`,
            deposits: [{
                amount: String(Math.floor(Math.random() * 5_000_000) + 500_000), // 500k - 5.5M
                intended_lock_days: Math.floor(Math.random() * 90) + 91, // 91-180 days
                deposit_time: baseTime + Math.random() * 86400 * 20,
            }]
        })
    }

    // Group 4: Very long locks (181-365 days) - largest deposits
    for (let i = 0; i < 6; i++) {
        users.push({
            user: `user_verylong_${i}`,
            deposits: [{
                amount: String(Math.floor(Math.random() * 8_000_000) + 1_000_000), // 1M - 9M
                intended_lock_days: Math.floor(Math.random() * 185) + 181, // 181-365 days
                deposit_time: baseTime + Math.random() * 86400 * 25,
            }]
        })
    }

    // Add some users with multiple deposits
    users.push({
        user: 'user_multiple_1',
        deposits: [
            {
                amount: String(1_500_000),
                intended_lock_days: 90,
                deposit_time: baseTime,
            },
            {
                amount: String(2_000_000),
                intended_lock_days: 180,
                deposit_time: baseTime + 86400 * 5,
            }
        ]
    })

    users.push({
        user: 'user_multiple_2',
        deposits: [
            {
                amount: String(500_000),
                intended_lock_days: 30,
                deposit_time: baseTime,
            },
            {
                amount: String(3_000_000),
                intended_lock_days: 365,
                deposit_time: baseTime + 86400 * 10,
            },
            {
                amount: String(1_000_000),
                intended_lock_days: 120,
                deposit_time: baseTime + 86400 * 15,
            }
        ]
    })

    return users
}

/**
 * Mock pending locks response (list of user addresses)
 */
export const getMockPendingLocks = () => {
    const mockUsers = generateMockDeposits()
    const users = mockUsers.map(u => u.user)
    const result = {
        users
    }
    return result
}

/**
 * Mock user deposits response for a specific user.
 * Returns fallback deposits for any unrecognized address (e.g. real wallet)
 * so the Currently Lent section can be tested.
 */
export const getMockUserDeposits = (user: string): MockUserDepositsResponse | null => {
    const mockUsers = generateMockDeposits()
    const userData = mockUsers.find(u => u.user === user)

    if (userData) {
        return { deposits: userData.deposits }
    }

    // Fallback: return mock deposits for any address (e.g. connected wallet)
    const now = Math.floor(Date.now() / 1000)
    return {
        deposits: [
            {
                amount: String(10_000_000_000), // 10,000 USDC (6 decimals)
                intended_lock_days: 120,
                deposit_time: now - 86400 * 45, // 45 days ago (mid-cliff)
            },
            {
                amount: String(5_000_000_000), // 5,000 USDC
                intended_lock_days: 180,
                deposit_time: now - 86400 * 30, // 30 days ago
            },
        ]
    }
}

/**
 * Mock user history response
 */
export const getMockUserHistory = (user: string) => {
    const now = Math.floor(Date.now() / 1000)
    const daysAgo = 30 // 30 days of history
    const history = []
    
    let runningTotalClaims = 0
    
    // Generate history entries over the past 30 days
    for (let i = daysAgo; i >= 0; i--) {
        const timestamp = now - (i * 24 * 60 * 60)
        
        // Simulate deposits and claims over time
        if (i % 7 === 0) { // Every 7 days
            const depositAmount = Math.floor(Math.random() * 2_000_000) + 500_000
            const shareOfClaims = Math.random() * 0.1 + 0.05 // 5-15% share
            runningTotalClaims += depositAmount * shareOfClaims
            
            history.push({
                deposit: String(depositAmount),
                running_total_claims: String(Math.floor(runningTotalClaims)),
                share_of_claims: shareOfClaims.toString(),
                time: timestamp,
            })
        }
    }
    
    return {
        history: history.slice(-10) // Return last 10 entries
    }
}

/**
 * Mock acquisition config
 */
/**
 * Mock user intents response
 */
export const getMockUserIntents = (user: string) => {
    if (!user) return null
    // Simulate a user that has set ongoing intents
    if (user.includes('multiple')) {
        return {
            intents: [
                {
                    intent_type: { stake: {} },
                    ratio: "0.7",
                    lock: null,
                },
                {
                    intent_type: { send_to_address: { address: user } },
                    ratio: "0.3",
                    lock: null,
                },
            ]
        }
    }
    // Default: return a deposit_via_mars_mirror intent for insurance APR testing
    return {
        intents: [
            {
                intent_type: {
                    deposit_via_mars_mirror: {
                        asset: "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4",
                        slot: 5,
                    },
                },
                ratio: "1.0",
                lock: null,
            },
        ]
    }
}

/**
 * Mock intent boosts response
 */
export const getMockIntentBoosts = (intents: any) => {
    if (!intents || !intents.intents || intents.intents.length === 0) {
        return { boosts: [] }
    }
    // Return a boost for each intent
    return {
        boosts: intents.intents.map(() => "0.05") // 5% boost per intent
    }
}

/**
 * Mock acquisition config
 */
export const getMockLockdropConfig = () => {
    return {
        config: {
            owner: "neutron1mockowner",
            transmuter_contract: "neutron1transmuter",
            neutron_proxy: "neutron1proxy",
            cdp_contract: "neutron1cdp",
            deposit_period_days: 14,
            withdrawal_period_days: 7,
            cliff_period_days: 90,
            deposit_token: "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4",
            minimum_deposit: "1000000", // 1 USDC (6 decimals)
            mbrn_denom: "factory/neutron1mock/mbrn",
            staking_contract: null,
            mars_mirror_contract: null,
            ltv_disco_contract: null,
            discounts_contract: "neutron1discounts",
            emissions_voting_contract: null,
            minimum_lock_days: 3,
        },
        acquisition_model: {
            base_acquisition_rate: "0.000826719", // ~826.719 uMBRN/sec
            max_mbrn_emission: "1000000000000", // 1M MBRN (6 decimals)
            target_utilization: "0.50",
            bump_increment: "0.001",
            bump_interval_seconds: 17280,
            reduction_speed_multiplier: "2.0",
            efficiency_threshold: "0.20",
            max_rate_change_per_mutation: "0.20",
        },
    }
}


