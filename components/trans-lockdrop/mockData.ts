/**
 * Mock data for transmuter-lockdrop visualizer testing
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
    console.log('getMockPendingLocks: Starting...')
    const mockUsers = generateMockDeposits()
    console.log('getMockPendingLocks: Generated', mockUsers.length, 'mock users')
    const users = mockUsers.map(u => u.user)
    console.log('getMockPendingLocks: Returning', users.length, 'users:', users.slice(0, 5), '...')
    const result = {
        users
    }
    console.log('getMockPendingLocks: Result:', result)
    return result
}

/**
 * Mock user deposits response for a specific user
 */
export const getMockUserDeposits = (user: string): MockUserDepositsResponse | null => {
    const mockUsers = generateMockDeposits()
    const userData = mockUsers.find(u => u.user === user)

    if (!userData) {
        console.warn('getMockUserDeposits: User not found:', user)
        return null
    }

    console.log('getMockUserDeposits: Found', userData.deposits.length, 'deposits for user:', user)
    return {
        deposits: userData.deposits
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
 * Mock lockdrop config
 */
export const getMockLockdropConfig = () => {
    return {
        config: {
            owner: "neutron1mockowner",
            transmuter_contract: "neutron1transmuter",
            neutron_proxy: "neutron1proxy",
            lockdrop_incentive_size: "10000000000", // 10,000 MBRN (6 decimals)
            deposit_period_days: 14,
            withdrawal_period_days: 7,
            deposit_token: "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4",
            minimum_deposit: "1000000", // 1 USDC (6 decimals)
            mbrn_denom: "factory/neutron1mock/mbrn",
            staking_contract: null,
            mars_mirror_contract: null,
            ltv_disco_contract: null,
            discounts_contract: "neutron1discounts",
            maximum_boost: "2.0",
            minimum_lock_days: 3,
        }
    }
}


