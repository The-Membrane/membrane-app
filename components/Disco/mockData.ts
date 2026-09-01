// Mock data for Disco metrics (9-slot system)

import type { UserDepositInfo, UnstakeRequest } from './types'

const USDC_DENOM = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4"

// Mock data for user deposits across various slots
export const mockUserDeposits: UserDepositInfo[] = [
    // Slot 1 (Highest Risk) - Multiple deposits
    {
        asset: USDC_DENOM,
        slot: 1,
        deposit_id: "1",
        deposit: {
            user: "osmo1mockuser1",
            vault_tokens: "800000000",
            last_claimed: Math.floor(Date.now() / 1000) - 86400,
            start_time: Math.floor(Date.now() / 1000) - (60 * 86400),
            compound_claims: false,
            withdrawals_enabled: true,
        },
        deposit_tokens: "800000000",
    },
    {
        asset: USDC_DENOM,
        slot: 1,
        deposit_id: "2",
        deposit: {
            user: "osmo1mockuser1",
            vault_tokens: "1200000000",
            last_claimed: Math.floor(Date.now() / 1000) - 172800,
            start_time: Math.floor(Date.now() / 1000) - (45 * 86400),
            compound_claims: true,
            withdrawals_enabled: true,
        },
        deposit_tokens: "1200000000",
    },

    // Slot 2 (Very High Risk)
    {
        asset: USDC_DENOM,
        slot: 2,
        deposit_id: "3",
        deposit: {
            user: "osmo1mockuser1",
            vault_tokens: "1500000000",
            last_claimed: Math.floor(Date.now() / 1000) - 3600,
            start_time: Math.floor(Date.now() / 1000) - (30 * 86400),
            compound_claims: false,
            withdrawals_enabled: true,
        },
        deposit_tokens: "1500000000",
    },
    {
        asset: USDC_DENOM,
        slot: 2,
        deposit_id: "4",
        deposit: {
            user: "osmo1mockuser1",
            vault_tokens: "1000000000",
            last_claimed: Math.floor(Date.now() / 1000) - 43200,
            start_time: Math.floor(Date.now() / 1000) - (30 * 86400),
            compound_claims: false,
            withdrawals_enabled: true,
        },
        deposit_tokens: "1000000000",
    },

    // Slot 3 (High Risk)
    {
        asset: USDC_DENOM,
        slot: 3,
        deposit_id: "6",
        deposit: {
            user: "osmo1mockuser1",
            vault_tokens: "2000000000",
            last_claimed: Math.floor(Date.now() / 1000) - 259200,
            start_time: Math.floor(Date.now() / 1000) - (90 * 86400),
            compound_claims: true,
            withdrawals_enabled: true,
        },
        deposit_tokens: "2000000000",
    },

    // Slot 4 (Med-High Risk)
    {
        asset: USDC_DENOM,
        slot: 4,
        deposit_id: "7",
        deposit: {
            user: "osmo1mockuser1",
            vault_tokens: "1800000000",
            last_claimed: Math.floor(Date.now() / 1000) - 7200,
            start_time: Math.floor(Date.now() / 1000) - (15 * 86400),
            compound_claims: true,
            withdrawals_enabled: true,
        },
        deposit_tokens: "1800000000",
    },
    {
        asset: USDC_DENOM,
        slot: 4,
        deposit_id: "8",
        deposit: {
            user: "osmo1mockuser1",
            vault_tokens: "2200000000",
            last_claimed: Math.floor(Date.now() / 1000) - 14400,
            start_time: Math.floor(Date.now() / 1000) - (65 * 86400),
            compound_claims: true,
            withdrawals_enabled: true,
        },
        deposit_tokens: "2200000000",
    },

    // Slot 5 (Medium Risk)
    {
        asset: USDC_DENOM,
        slot: 5,
        deposit_id: "9",
        deposit: {
            user: "osmo1mockuser1",
            vault_tokens: "1000000000",
            last_claimed: Math.floor(Date.now() / 1000) - 28800,
            start_time: Math.floor(Date.now() / 1000) - (20 * 86400),
            compound_claims: false,
            withdrawals_enabled: true,
        },
        deposit_tokens: "1000000000",
    },
    {
        asset: USDC_DENOM,
        slot: 5,
        deposit_id: "10",
        deposit: {
            user: "osmo1mockuser1",
            vault_tokens: "1500000000",
            last_claimed: Math.floor(Date.now() / 1000) - 7200,
            start_time: Math.floor(Date.now() / 1000) - (120 * 86400),
            compound_claims: false,
            withdrawals_enabled: true,
        },
        deposit_tokens: "1500000000",
    },

    // Slot 6 (Med-Low Risk)
    {
        asset: USDC_DENOM,
        slot: 6,
        deposit_id: "12",
        deposit: {
            user: "osmo1mockuser1",
            vault_tokens: "2500000000",
            last_claimed: Math.floor(Date.now() / 1000) - 1800,
            start_time: Math.floor(Date.now() / 1000) - (12 * 86400),
            compound_claims: true,
            withdrawals_enabled: true,
        },
        deposit_tokens: "2500000000",
    },

    // Slot 7 (Low Risk)
    {
        asset: USDC_DENOM,
        slot: 7,
        deposit_id: "13",
        deposit: {
            user: "osmo1mockuser1",
            vault_tokens: "1200000000",
            last_claimed: Math.floor(Date.now() / 1000) - 900,
            start_time: Math.floor(Date.now() / 1000) - (8 * 86400),
            compound_claims: false,
            withdrawals_enabled: true,
        },
        deposit_tokens: "1200000000",
    },
    {
        asset: USDC_DENOM,
        slot: 7,
        deposit_id: "14",
        deposit: {
            user: "osmo1mockuser1",
            vault_tokens: "1800000000",
            last_claimed: Math.floor(Date.now() / 1000) - 8640,
            start_time: Math.floor(Date.now() / 1000) - (35 * 86400),
            compound_claims: false,
            withdrawals_enabled: true,
        },
        deposit_tokens: "1800000000",
    },

    // Slot 8 (Very Low Risk)
    {
        asset: USDC_DENOM,
        slot: 8,
        deposit_id: "17",
        deposit: {
            user: "osmo1mockuser1",
            vault_tokens: "3000000000",
            last_claimed: Math.floor(Date.now() / 1000) - 4500,
            start_time: Math.floor(Date.now() / 1000) - (18 * 86400),
            compound_claims: true,
            withdrawals_enabled: true,
        },
        deposit_tokens: "3000000000",
    },

    // Slot 9 (Lowest Risk)
    {
        asset: USDC_DENOM,
        slot: 9,
        deposit_id: "18",
        deposit: {
            user: "osmo1mockuser1",
            vault_tokens: "1400000000",
            last_claimed: Math.floor(Date.now() / 1000) - 2700,
            start_time: Math.floor(Date.now() / 1000) - (5 * 86400),
            compound_claims: false,
            withdrawals_enabled: true,
        },
        deposit_tokens: "1400000000",
    },
    {
        asset: USDC_DENOM,
        slot: 9,
        deposit_id: "19",
        deposit: {
            user: "osmo1mockuser1",
            vault_tokens: "2000000000",
            last_claimed: Math.floor(Date.now() / 1000) - 6300,
            start_time: Math.floor(Date.now() / 1000) - (50 * 86400),
            compound_claims: true,
            withdrawals_enabled: true,
        },
        deposit_tokens: "2000000000",
    },
]

// Mock pending claims (slot-based)
export const mockPendingClaims = [
    { slot: 1, deposit_id: "1", pending_amount: "50000000" },
    { slot: 1, deposit_id: "2", pending_amount: "75000000" },
    { slot: 3, deposit_id: "6", pending_amount: "40000000" },
    { slot: 5, deposit_id: "9", pending_amount: "30000000" },
    { slot: 7, deposit_id: "13", pending_amount: "20000000" },
    { slot: 9, deposit_id: "18", pending_amount: "15000000" },
]

// Mock lifetime revenue
export const mockLifetimeRevenue = [
    { user: "osmo1mockuser1", asset: "MBRN", total_revenue: "2500000000" },
    { user: "osmo1mockuser1", asset: "MBRN", total_revenue: "1800000000" },
]

// Mock data for daily TVL history (last 30 days)
export const mockDailyTVL = (() => {
    const entries = []
    const now = Math.floor(Date.now() / 1000)
    const baseTVL = 50000000000 // 50,000 MBRN base

    for (let i = 29; i >= 0; i--) {
        const timestamp = now - (i * 86400)
        const variation = (Math.random() - 0.5) * 5000000000
        const tvl = baseTVL + variation + (i * 100000000)

        entries.push({
            timestamp,
            tvl: Math.floor(tvl).toString(),
        })
    }

    return { entries }
})()

// Mock total insurance
export const mockTotalInsurance = "15000000000"

// Mock data for daily deposits history per asset (replaces mockDailyLTV)
export const mockDailyDeposits = (() => {
    const entries = []
    const now = Math.floor(Date.now() / 1000)
    const baseDeposits = 190000000000 // 190,000 MBRN base (sum of all slots)

    for (let i = 29; i >= 0; i--) {
        const timestamp = now - (i * 86400)
        const variation = (Math.random() - 0.5) * 10000000000
        const depositTokens = baseDeposits + variation + (i * 200000000)

        entries.push({
            timestamp,
            deposit_tokens: Math.floor(depositTokens).toString(),
        })
    }

    return { entries }
})()

// Mock epoch revenue (per asset, in CDT base units)
export const mockEpochRevenue = {
    revenue: [
        ["USDC", "5000000000"],
        ["ATOM", "3200000000"],
        ["OSMO", "1800000000"],
        ["MBRN", "1200000000"],
        ["STARS", "800000000"],
    ]
}

// Mock epoch countdown
export const mockEpochCountdown = {
    seconds_remaining: 259200,
    epoch_start: Math.floor(Date.now() / 1000) - (4 * 86400),
    epoch_end: Math.floor(Date.now() / 1000) + 259200,
    current_time: Math.floor(Date.now() / 1000)
}

// Mock unstake requests
export const mockUnstakeRequests: UnstakeRequest[] = [
    {
        user: "osmo1mockuser1",
        asset: USDC_DENOM,
        slot: 5,
        deposit_id: "9",
        vault_tokens: "500000000",
        request_time: Math.floor(Date.now() / 1000) - (1 * 86400),
        unlock_time: Math.floor(Date.now() / 1000) + (1 * 86400),
    },
]
