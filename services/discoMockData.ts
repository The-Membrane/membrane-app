/**
 * Mock data for Disco section
 */

const USDC_DENOM = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4"

/**
 * Mock user deposits for Disco
 */
export const getMockDiscoUserDeposits = (user: string, asset: string) => {
    // Return mock deposits for any user
    // Note: vault_tokens is in MBRN (6 decimals), deposits should have vault_tokens field
    const now = Math.floor(Date.now() / 1000)
    return {
        deposits: [
            {
                vault_tokens: "5000000000", // 5000 MBRN
                asset: {
                    amount: "5000000", // 5 USDC (6 decimals) - legacy field
                    info: {
                        native_token: {
                            denom: asset || USDC_DENOM
                        }
                    }
                },
                max_ltv: "0.75",
                max_borrow_ltv: "0.70",
                start_time: now - (60 * 86400), // 60 days ago
                last_claimed: now - (1 * 86400), // 1 day ago
            },
            {
                vault_tokens: "3000000000", // 3000 MBRN
                asset: {
                    amount: "3000000", // 3 USDC
                    info: {
                        native_token: {
                            denom: asset || USDC_DENOM
                        }
                    }
                },
                max_ltv: "0.80",
                max_borrow_ltv: "0.75",
                start_time: now - (45 * 86400), // 45 days ago
                last_claimed: now - (2 * 86400), // 2 days ago
            },
            {
                vault_tokens: "2000000000", // 2000 MBRN
                asset: {
                    amount: "2000000", // 2 USDC
                    info: {
                        native_token: {
                            denom: asset || USDC_DENOM
                        }
                    }
                },
                max_ltv: "0.70",
                max_borrow_ltv: "0.65",
                start_time: now - (30 * 86400), // 30 days ago
                last_claimed: now - (3 * 86400), // 3 days ago
            },
            {
                vault_tokens: "7500000000", // 7500 MBRN
                asset: {
                    amount: "7500000", // 7.5 USDC
                    info: {
                        native_token: {
                            denom: asset || USDC_DENOM
                        }
                    }
                },
                max_ltv: "0.85",
                max_borrow_ltv: "0.80",
                start_time: now - (90 * 86400), // 90 days ago
                last_claimed: now - (5 * 86400), // 5 days ago
            },
            {
                vault_tokens: "1500000000", // 1500 MBRN
                asset: {
                    amount: "1500000", // 1.5 USDC
                    info: {
                        native_token: {
                            denom: asset || USDC_DENOM
                        }
                    }
                },
                max_ltv: "0.65",
                max_borrow_ltv: "0.60",
                start_time: now - (20 * 86400), // 20 days ago
                last_claimed: now - (7 * 86400), // 7 days ago
            },
            {
                vault_tokens: "4000000000", // 4000 MBRN
                asset: {
                    amount: "4000000", // 4 USDC
                    info: {
                        native_token: {
                            denom: asset || USDC_DENOM
                        }
                    }
                },
                max_ltv: "0.72",
                max_borrow_ltv: "0.68",
                start_time: now - (75 * 86400), // 75 days ago
                last_claimed: now - (10 * 86400), // 10 days ago
            }
        ]
    }
}

/**
 * Mock lifetime revenue for Disco
 * Returns array of UserLifetimeRevenueEntry with total_claimed in CDT
 * The latest entry contains the cumulative total_claimed for the asset
 */
export const getMockDiscoLifetimeRevenue = (user: string, asset: string) => {
    const now = Math.floor(Date.now() / 1000)
    return [
        {
            timestamp: now - (90 * 86400), // 90 days ago
            total_claimed: "250000" // 0.25 CDT
        },
        {
            timestamp: now - (75 * 86400), // 75 days ago
            total_claimed: "400000" // 0.4 CDT (cumulative)
        },
        {
            timestamp: now - (60 * 86400), // 60 days ago
            total_claimed: "600000" // 0.6 CDT (cumulative)
        },
        {
            timestamp: now - (45 * 86400), // 45 days ago
            total_claimed: "750000" // 0.75 CDT (cumulative)
        },
        {
            timestamp: now - (30 * 86400), // 30 days ago
            total_claimed: "900000" // 0.9 CDT (cumulative)
        },
        {
            timestamp: now - (20 * 86400), // 20 days ago
            total_claimed: "1050000" // 1.05 CDT (cumulative)
        },
        {
            timestamp: now - (10 * 86400), // 10 days ago
            total_claimed: "1200000" // 1.2 CDT (cumulative)
        },
        {
            timestamp: now, // Now
            total_claimed: "1350000" // 1.35 CDT (cumulative total)
        }
    ]
}

/**
 * Mock assets list
 */
export const getMockDiscoAssets = () => {
    return {
        assets: [USDC_DENOM]
    }
}

