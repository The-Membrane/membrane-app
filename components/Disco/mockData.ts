// Mock data for Disco metrics

// Mock data for user deposits with various lock durations for testing segmented bars
// Lock ceiling is 1 year (365 days = 31536000 seconds)
// Opacity = secondsRemaining / 31536000
// Deposits are distributed across LTV layers to test segmented styling
export const mockUserDeposits = [
    // Layer 0 (60-63%): Multiple deposits with mixed lock status
    {
        user: "osmo1mockuser1",
        vault_tokens: "800000000", // 800 MBRN - Unlocked
        locked_vault_tokens: "0",
        max_borrow_ltv: "0.62",
        last_claimed: Math.floor(Date.now() / 1000) - 86400,
        locked: null,
        start_time: Math.floor(Date.now() / 1000) - (60 * 86400),
        compound_claims: false,
        manager: null,
        asset: "MBRN",
        ltv: "0.61",
        max_ltv: "0.61",
        deposit_id: "1",
    },
    {
        user: "osmo1mockuser1",
        vault_tokens: "1200000000", // 1200 MBRN - 3 months locked (25% opacity)
        locked_vault_tokens: "1200000000",
        max_borrow_ltv: "0.62",
        last_claimed: Math.floor(Date.now() / 1000) - 172800,
        locked: {
            locked_until: Math.floor(Date.now() / 1000) + (90 * 86400),
            perpetual_lock: false,
        },
        start_time: Math.floor(Date.now() / 1000) - (45 * 86400),
        compound_claims: true,
        manager: null,
        asset: "MBRN",
        ltv: "0.61",
        max_ltv: "0.61",
        deposit_id: "2",
    },

    // Layer 1 (63-66%): Multiple deposits
    {
        user: "osmo1mockuser1",
        vault_tokens: "1500000000", // 1500 MBRN - Unlocked
        locked_vault_tokens: "0",
        max_borrow_ltv: "0.65",
        last_claimed: Math.floor(Date.now() / 1000) - 3600,
        locked: null,
        start_time: Math.floor(Date.now() / 1000) - (30 * 86400),
        compound_claims: false,
        manager: null,
        asset: "MBRN",
        ltv: "0.64",
        max_ltv: "0.64",
        deposit_id: "3",
    },
    {
        user: "osmo1mockuser1",
        vault_tokens: "1000000000", // 1000 MBRN - 6 months locked (50% opacity)
        locked_vault_tokens: "1000000000",
        max_borrow_ltv: "0.65",
        last_claimed: Math.floor(Date.now() / 1000) - 43200,
        locked: {
            locked_until: Math.floor(Date.now() / 1000) + (180 * 86400),
            perpetual_lock: false,
        },
        start_time: Math.floor(Date.now() / 1000) - (30 * 86400),
        compound_claims: false,
        manager: null,
        asset: "MBRN",
        ltv: "0.64",
        max_ltv: "0.64",
        deposit_id: "4",
    },
    {
        user: "osmo1mockuser1",
        vault_tokens: "500000000", // 500 MBRN - 1.5 months locked (12.5% opacity)
        locked_vault_tokens: "500000000",
        max_borrow_ltv: "0.65",
        last_claimed: Math.floor(Date.now() / 1000) - 1800,
        locked: {
            locked_until: Math.floor(Date.now() / 1000) + (45 * 86400),
            perpetual_lock: false,
        },
        start_time: Math.floor(Date.now() / 1000) - (10 * 86400),
        compound_claims: false,
        manager: null,
        asset: "MBRN",
        ltv: "0.64",
        max_ltv: "0.64",
        deposit_id: "5",
    },

    // Layer 2 (66-69%): Single large deposit
    {
        user: "osmo1mockuser1",
        vault_tokens: "2000000000", // 2000 MBRN - 9 months locked (75% opacity)
        locked_vault_tokens: "2000000000",
        max_borrow_ltv: "0.68",
        last_claimed: Math.floor(Date.now() / 1000) - 259200,
        locked: {
            locked_until: Math.floor(Date.now() / 1000) + (270 * 86400),
            perpetual_lock: false,
        },
        start_time: Math.floor(Date.now() / 1000) - (90 * 86400),
        compound_claims: true,
        manager: null,
        asset: "MBRN",
        ltv: "0.67",
        max_ltv: "0.67",
        deposit_id: "6",
    },

    // Layer 3 (69-72%): Mixed deposits
    {
        user: "osmo1mockuser1",
        vault_tokens: "1800000000", // 1800 MBRN - Unlocked
        locked_vault_tokens: "0",
        max_borrow_ltv: "0.71",
        last_claimed: Math.floor(Date.now() / 1000) - 7200,
        locked: null,
        start_time: Math.floor(Date.now() / 1000) - (15 * 86400),
        compound_claims: true,
        manager: null,
        asset: "MBRN",
        ltv: "0.70",
        max_ltv: "0.70",
        deposit_id: "7",
    },
    {
        user: "osmo1mockuser1",
        vault_tokens: "2200000000", // 2200 MBRN - 10 months locked (83% opacity)
        locked_vault_tokens: "2200000000",
        max_borrow_ltv: "0.71",
        last_claimed: Math.floor(Date.now() / 1000) - 14400,
        locked: {
            locked_until: Math.floor(Date.now() / 1000) + (300 * 86400),
            perpetual_lock: false,
        },
        start_time: Math.floor(Date.now() / 1000) - (65 * 86400),
        compound_claims: true,
        manager: null,
        asset: "MBRN",
        ltv: "0.70",
        max_ltv: "0.70",
        deposit_id: "8",
    },

    // Layer 4 (72-75%): Multiple deposits with different locks
    {
        user: "osmo1mockuser1",
        vault_tokens: "1000000000", // 1000 MBRN - Unlocked
        locked_vault_tokens: "0",
        max_borrow_ltv: "0.74",
        last_claimed: Math.floor(Date.now() / 1000) - 28800,
        locked: null,
        start_time: Math.floor(Date.now() / 1000) - (20 * 86400),
        compound_claims: false,
        manager: null,
        asset: "MBRN",
        ltv: "0.73",
        max_ltv: "0.73",
        deposit_id: "9",
    },
    {
        user: "osmo1mockuser1",
        vault_tokens: "1500000000", // 1500 MBRN - 1 year locked (100% opacity)
        locked_vault_tokens: "1500000000",
        max_borrow_ltv: "0.74",
        last_claimed: Math.floor(Date.now() / 1000) - 7200,
        locked: {
            locked_until: Math.floor(Date.now() / 1000) + (365 * 86400),
            perpetual_lock: false,
        },
        start_time: Math.floor(Date.now() / 1000) - (120 * 86400),
        compound_claims: false,
        manager: null,
        asset: "MBRN",
        ltv: "0.73",
        max_ltv: "0.73",
        deposit_id: "10",
    },
    {
        user: "osmo1mockuser1",
        vault_tokens: "800000000", // 800 MBRN - 6 months locked (50% opacity)
        locked_vault_tokens: "800000000",
        max_borrow_ltv: "0.74",
        last_claimed: Math.floor(Date.now() / 1000) - 3600,
        locked: {
            locked_until: Math.floor(Date.now() / 1000) + (180 * 86400),
            perpetual_lock: false,
        },
        start_time: Math.floor(Date.now() / 1000) - (25 * 86400),
        compound_claims: false,
        manager: null,
        asset: "MBRN",
        ltv: "0.73",
        max_ltv: "0.73",
        deposit_id: "11",
    },

    // Layer 5 (75-78%): Single unlocked
    {
        user: "osmo1mockuser1",
        vault_tokens: "2500000000", // 2500 MBRN - Unlocked
        locked_vault_tokens: "0",
        max_borrow_ltv: "0.77",
        last_claimed: Math.floor(Date.now() / 1000) - 1800,
        locked: null,
        start_time: Math.floor(Date.now() / 1000) - (12 * 86400),
        compound_claims: true,
        manager: null,
        asset: "MBRN",
        ltv: "0.76",
        max_ltv: "0.76",
        deposit_id: "12",
    },

    // Layer 6 (78-81%): Mixed
    {
        user: "osmo1mockuser1",
        vault_tokens: "1200000000", // 1200 MBRN - Unlocked
        locked_vault_tokens: "0",
        max_borrow_ltv: "0.80",
        last_claimed: Math.floor(Date.now() / 1000) - 900,
        locked: null,
        start_time: Math.floor(Date.now() / 1000) - (8 * 86400),
        compound_claims: false,
        manager: null,
        asset: "MBRN",
        ltv: "0.79",
        max_ltv: "0.79",
        deposit_id: "13",
    },
    {
        user: "osmo1mockuser1",
        vault_tokens: "1800000000", // 1800 MBRN - 11 months locked (92% opacity)
        locked_vault_tokens: "1800000000",
        max_borrow_ltv: "0.80",
        last_claimed: Math.floor(Date.now() / 1000) - 8640,
        locked: {
            locked_until: Math.floor(Date.now() / 1000) + (330 * 86400),
            perpetual_lock: false,
        },
        start_time: Math.floor(Date.now() / 1000) - (35 * 86400),
        compound_claims: false,
        manager: null,
        asset: "MBRN",
        ltv: "0.79",
        max_ltv: "0.79",
        deposit_id: "14",
    },

    // Layer 7 (81-84%): Multiple locked with different opacities
    {
        user: "osmo1mockuser1",
        vault_tokens: "1000000000", // 1000 MBRN - 3 months locked (25% opacity)
        locked_vault_tokens: "1000000000",
        max_borrow_ltv: "0.83",
        last_claimed: Math.floor(Date.now() / 1000) - 5400,
        locked: {
            locked_until: Math.floor(Date.now() / 1000) + (90 * 86400),
            perpetual_lock: false,
        },
        start_time: Math.floor(Date.now() / 1000) - (40 * 86400),
        compound_claims: true,
        manager: null,
        asset: "MBRN",
        ltv: "0.82",
        max_ltv: "0.82",
        deposit_id: "15",
    },
    {
        user: "osmo1mockuser1",
        vault_tokens: "1600000000", // 1600 MBRN - 9 months locked (75% opacity)
        locked_vault_tokens: "1600000000",
        max_borrow_ltv: "0.83",
        last_claimed: Math.floor(Date.now() / 1000) - 10800,
        locked: {
            locked_until: Math.floor(Date.now() / 1000) + (270 * 86400),
            perpetual_lock: false,
        },
        start_time: Math.floor(Date.now() / 1000) - (85 * 86400),
        compound_claims: false,
        manager: null,
        asset: "MBRN",
        ltv: "0.82",
        max_ltv: "0.82",
        deposit_id: "16",
    },

    // Layer 8 (84-87%): Unlocked only
    {
        user: "osmo1mockuser1",
        vault_tokens: "3000000000", // 3000 MBRN - Unlocked
        locked_vault_tokens: "0",
        max_borrow_ltv: "0.86",
        last_claimed: Math.floor(Date.now() / 1000) - 4500,
        locked: null,
        start_time: Math.floor(Date.now() / 1000) - (18 * 86400),
        compound_claims: true,
        manager: null,
        asset: "MBRN",
        ltv: "0.85",
        max_ltv: "0.85",
        deposit_id: "17",
    },

    // Layer 9 (87-90%): Multiple deposits with various locks
    {
        user: "osmo1mockuser1",
        vault_tokens: "1400000000", // 1400 MBRN - Unlocked
        locked_vault_tokens: "0",
        max_borrow_ltv: "0.89",
        last_claimed: Math.floor(Date.now() / 1000) - 2700,
        locked: null,
        start_time: Math.floor(Date.now() / 1000) - (5 * 86400),
        compound_claims: false,
        manager: null,
        asset: "MBRN",
        ltv: "0.88",
        max_ltv: "0.88",
        deposit_id: "18",
    },
    {
        user: "osmo1mockuser1",
        vault_tokens: "2000000000", // 2000 MBRN - 6 months locked (50% opacity)
        locked_vault_tokens: "2000000000",
        max_borrow_ltv: "0.89",
        last_claimed: Math.floor(Date.now() / 1000) - 6300,
        locked: {
            locked_until: Math.floor(Date.now() / 1000) + (180 * 86400),
            perpetual_lock: false,
        },
        start_time: Math.floor(Date.now() / 1000) - (50 * 86400),
        compound_claims: true,
        manager: null,
        asset: "MBRN",
        ltv: "0.88",
        max_ltv: "0.88",
        deposit_id: "19",
    },
    {
        user: "osmo1mockuser1",
        vault_tokens: "1600000000", // 1600 MBRN - 1 year locked (100% opacity)
        locked_vault_tokens: "1600000000",
        max_borrow_ltv: "0.89",
        last_claimed: Math.floor(Date.now() / 1000) - 3600,
        locked: {
            locked_until: Math.floor(Date.now() / 1000) + (365 * 86400),
            perpetual_lock: false,
        },
        start_time: Math.floor(Date.now() / 1000) - (100 * 86400),
        compound_claims: false,
        manager: null,
        asset: "MBRN",
        ltv: "0.88",
        max_ltv: "0.88",
        deposit_id: "20",
    },
]

// Mock data for pending claims
export const mockPendingClaims = [
    {
        user: "osmo1mockuser1",
        asset: "MBRN",
        pending_amount: "50000000", // 50 CDT (6 decimals)
        claim_id: "1",
    },
    {
        user: "osmo1mockuser1",
        asset: "MBRN",
        pending_amount: "125000000", // 125 CDT
        claim_id: "2",
    },
    {
        user: "osmo1mockuser1",
        asset: "MBRN",
        pending_amount: "75000000", // 75 CDT
        claim_id: "3",
    },
]

// Mock data for lifetime revenue
export const mockLifetimeRevenue = [
    {
        user: "osmo1mockuser1",
        asset: "MBRN",
        total_revenue: "2500000000", // 2500 CDT (6 decimals)
    },
    {
        user: "osmo1mockuser1",
        asset: "MBRN",
        total_revenue: "1800000000", // 1800 CDT
    },
]

// Mock data for daily TVL history (last 30 days)
export const mockDailyTVL = (() => {
    const entries = []
    const now = Math.floor(Date.now() / 1000)
    const baseTVL = 50000000000 // 50,000 MBRN base

    for (let i = 29; i >= 0; i--) {
        const timestamp = now - (i * 86400) // 86400 seconds = 1 day
        // Add some variation to TVL over time (random walk)
        const variation = (Math.random() - 0.5) * 5000000000 // ±5,000 MBRN variation
        const tvl = baseTVL + variation + (i * 100000000) // Slight upward trend

        entries.push({
            timestamp,
            tvl: Math.floor(tvl).toString(),
        })
    }

    return { entries }
})()

// Mock data for total insurance
export const mockTotalInsurance = "15000000000" // 15,000 CDT (6 decimals)

// Mock data for daily LTV history (last 30 days)
export const mockDailyLTV = (() => {
    const entries = []
    const now = Math.floor(Date.now() / 1000)
    const baseLiquidationLTV = 0.75 // 75% base liquidation LTV
    const baseBorrowLTV = 0.65 // 65% base borrow LTV

    for (let i = 29; i >= 0; i--) {
        const timestamp = now - (i * 86400) // 86400 seconds = 1 day
        
        // Add some variation to LTVs over time (random walk with slight upward trend)
        const liquidationVariation = (Math.random() - 0.5) * 0.05 // ±2.5% variation
        const borrowVariation = (Math.random() - 0.5) * 0.05 // ±2.5% variation
        const trend = i * 0.0005 // Slight upward trend over time
        
        const averageMaxLTV = Math.max(0.60, Math.min(0.90, baseLiquidationLTV + liquidationVariation + trend))
        const averageMaxBorrowLTV = Math.max(0.60, Math.min(averageMaxLTV - 0.01, baseBorrowLTV + borrowVariation + trend))

        entries.push({
            timestamp,
            average_max_ltv: averageMaxLTV.toString(),
            average_max_borrow_ltv: averageMaxBorrowLTV.toString(),
        })
    }

    return { entries }
})()

// Mock data for current epoch revenue (per asset)
// Format: { revenue: [["ASSET_DENOM", "AMOUNT_IN_BASE_UNITS"], ...] }
// Amounts are in base units (6 decimals for CDT)
export const mockEpochRevenue = {
    revenue: [
        ["USDC", "5000000000"],      // 5,000 CDT (5000000000 / 10^6)
        ["ATOM", "3200000000"],      // 3,200 CDT
        ["OSMO", "1800000000"],      // 1,800 CDT
        ["MBRN", "1200000000"],      // 1,200 CDT
        ["STARS", "800000000"],      // 800 CDT
    ]
}

// Mock data for LTV groups (for Loss Absorption Order and MBRN Defense calculation)
// Loss absorption order: sorted by highest liquidation LTV, then highest borrow LTV
// First-Loss: 90% Liq / 85% Borrow, Last-Loss: 60% Liq / 60% Borrow
export const mockLtvGroups = [
    // 90% Liquidation LTV groups - First Loss tier
    { liquidationLtv: 0.90, borrowLtv: 0.85, tvl: 15000000000 },  // 15,000 MBRN - 1st Loss
    { liquidationLtv: 0.90, borrowLtv: 0.80, tvl: 12000000000 },  // 12,000 MBRN - 2nd Loss
    { liquidationLtv: 0.90, borrowLtv: 0.75, tvl: 8000000000 },   // 8,000 MBRN - 3rd Loss
    
    // 85% Liquidation LTV groups
    { liquidationLtv: 0.85, borrowLtv: 0.80, tvl: 20000000000 },  // 20,000 MBRN - 4th Loss
    { liquidationLtv: 0.85, borrowLtv: 0.75, tvl: 18000000000 },  // 18,000 MBRN - 5th Loss
    { liquidationLtv: 0.85, borrowLtv: 0.70, tvl: 10000000000 },  // 10,000 MBRN - 6th Loss
    
    // 80% Liquidation LTV groups
    { liquidationLtv: 0.80, borrowLtv: 0.75, tvl: 25000000000 },  // 25,000 MBRN - 7th Loss
    { liquidationLtv: 0.80, borrowLtv: 0.70, tvl: 22000000000 },  // 22,000 MBRN - 8th Loss
    { liquidationLtv: 0.80, borrowLtv: 0.65, tvl: 15000000000 },  // 15,000 MBRN - 9th Loss
    
    // 75% Liquidation LTV groups
    { liquidationLtv: 0.75, borrowLtv: 0.70, tvl: 30000000000 },  // 30,000 MBRN - 10th Loss
    { liquidationLtv: 0.75, borrowLtv: 0.65, tvl: 28000000000 },  // 28,000 MBRN - 11th Loss
    
    // 70% Liquidation LTV groups
    { liquidationLtv: 0.70, borrowLtv: 0.65, tvl: 35000000000 },  // 35,000 MBRN - 12th Loss
    { liquidationLtv: 0.70, borrowLtv: 0.60, tvl: 32000000000 },  // 32,000 MBRN - 13th Loss
    
    // 65% Liquidation LTV groups
    { liquidationLtv: 0.65, borrowLtv: 0.60, tvl: 40000000000 },  // 40,000 MBRN - 14th Loss
    
    // 62% Liquidation LTV groups (common default)
    { liquidationLtv: 0.62, borrowLtv: 0.60, tvl: 50000000000 },  // 50,000 MBRN - 15th Loss (Last)
]

// Mock epoch countdown data
export const mockEpochCountdown = {
    seconds_remaining: 259200, // 3 days
    epoch_start: Math.floor(Date.now() / 1000) - (4 * 86400), // Started 4 days ago
    epoch_end: Math.floor(Date.now() / 1000) + 259200, // Ends in 3 days
    current_time: Math.floor(Date.now() / 1000)
}

