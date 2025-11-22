// Mock data for user deposits
export const mockUserDeposits = [
    {
        user: "osmo1mockuser1",
        vault_tokens: "1000000000", // 1000 MBRN (6 decimals)
        locked_vault_tokens: "500000000", // 500 MBRN locked
        max_borrow_ltv: "0.75",
        last_claimed: Math.floor(Date.now() / 1000) - 86400,
        locked: {
            locked_until: Math.floor(Date.now() / 1000) + (30 * 86400), // 30 days from now
            perpetual_lock: false,
        },
        start_time: Math.floor(Date.now() / 1000) - (60 * 86400), // 60 days ago
        compound_claims: false,
        manager: null,
        asset: "MBRN",
        ltv: "0.65",
        max_ltv: "0.65",
        deposit_id: "1",
    },
    {
        user: "osmo1mockuser1",
        vault_tokens: "2000000000", // 2000 MBRN
        locked_vault_tokens: "0",
        max_borrow_ltv: "0.80",
        last_claimed: Math.floor(Date.now() / 1000) - 172800,
        locked: null,
        start_time: Math.floor(Date.now() / 1000) - (45 * 86400),
        compound_claims: true,
        manager: null,
        asset: "MBRN",
        ltv: "0.70",
        max_ltv: "0.70",
        deposit_id: "2",
    },
    {
        user: "osmo1mockuser1",
        vault_tokens: "500000000", // 500 MBRN
        locked_vault_tokens: "500000000",
        max_borrow_ltv: "0.85",
        last_claimed: Math.floor(Date.now() / 1000) - 43200,
        locked: {
            locked_until: Math.floor(Date.now() / 1000) + (90 * 86400), // 90 days from now
            perpetual_lock: false,
        },
        start_time: Math.floor(Date.now() / 1000) - (30 * 86400),
        compound_claims: false,
        manager: null,
        asset: "MBRN",
        ltv: "0.75",
        max_ltv: "0.75",
        deposit_id: "3",
    },
    {
        user: "osmo1mockuser1",
        vault_tokens: "1500000000", // 1500 MBRN
        locked_vault_tokens: "0",
        max_borrow_ltv: "0.70",
        last_claimed: Math.floor(Date.now() / 1000) - 259200,
        locked: null,
        start_time: Math.floor(Date.now() / 1000) - (90 * 86400),
        compound_claims: true,
        manager: null,
        asset: "MBRN",
        ltv: "0.60",
        max_ltv: "0.60",
        deposit_id: "4",
    },
    {
        user: "osmo1mockuser1",
        vault_tokens: "3000000000", // 3000 MBRN
        locked_vault_tokens: "2000000000", // 2000 MBRN locked
        max_borrow_ltv: "0.90",
        last_claimed: Math.floor(Date.now() / 1000) - 7200,
        locked: {
            locked_until: Math.floor(Date.now() / 1000) + (180 * 86400), // 180 days from now
            perpetual_lock: true,
        },
        start_time: Math.floor(Date.now() / 1000) - (120 * 86400),
        compound_claims: false,
        manager: null,
        asset: "MBRN",
        ltv: "0.85",
        max_ltv: "0.85",
        deposit_id: "5",
    },
]

