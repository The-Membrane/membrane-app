/**
 * Mock data for the LTV-designated Disco slot system.
 * Slots are keyed by max_ltv (Decimal string) at 1% intervals.
 * Higher LTV = riskiest, lower LTV = safest.
 */

const USDC_DENOM = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4"
const ATOM_DENOM = "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2"
const STATOM_DENOM = "ibc/C140AFD542AE77BD7DCC83F13FDD8C5E5BB8C4929785E6EC2F4C636F98F17901"
const OSMO_DENOM = "ibc/ED07A3391A112B175915CD8FAF43A2DA8E4790EDE12566649D0C2F97716B8518"

/** Per-asset LTV range configs */
const ASSET_QUEUE_CONFIGS: Record<string, { min_ltv: string; max_ltv: string }> = {
    [USDC_DENOM]: { min_ltv: "0.50", max_ltv: "0.90" },
    [ATOM_DENOM]: { min_ltv: "0.45", max_ltv: "0.80" },
    [STATOM_DENOM]: { min_ltv: "0.40", max_ltv: "0.75" },
    [OSMO_DENOM]: { min_ltv: "0.35", max_ltv: "0.70" },
}

const DEFAULT_CONFIG = { min_ltv: "0.50", max_ltv: "0.90" }

/** Generate slots at 1% intervals for a given LTV range (descending by max_ltv) */
function generateMockSlots(minLtv: string, maxLtv: string) {
    const minPct = Math.round(parseFloat(minLtv) * 100)
    const maxPct = Math.round(parseFloat(maxLtv) * 100)
    const slots = []

    for (let ltv = maxPct; ltv >= minPct; ltv--) {
        // Higher LTV slots get more deposits (riskier = more capital seeking yield)
        const position = (ltv - minPct) / (maxPct - minPct) // 0 = lowest, 1 = highest
        const baseDeposit = 5000000000 + Math.round(position * 35000000000)
        // Add some variance
        const variance = Math.round((Math.sin(ltv * 7) * 0.15 + 1) * baseDeposit)
        const depositTokens = String(Math.max(variance, 1000000000))
        const hasBadDebt = ltv >= maxPct - 2 // Top 3 slots might have bad debt

        slots.push({
            max_ltv: (ltv / 100).toFixed(2),
            total_deposit_tokens: depositTokens,
            total_vault_tokens: hasBadDebt
                ? String(Math.round(parseInt(depositTokens) * 1.01))
                : depositTokens,
            bad_debt: hasBadDebt ? String(Math.round(parseInt(depositTokens) * 0.001)) : "0",
        })
    }

    return slots
}

/**
 * Mock asset queue with LTV-designated slots.
 * Returns { queues: [asset, queue][] }
 */
export const getMockAssetQueue = (assets: string[]) => {
    const asset = assets[0] || USDC_DENOM
    const config = ASSET_QUEUE_CONFIGS[asset] || DEFAULT_CONFIG
    return {
        queues: [[asset, {
            slots: generateMockSlots(config.min_ltv, config.max_ltv),
            current_deposit_id: "25",
            min_ltv: config.min_ltv,
            max_ltv: config.max_ltv,
        }]] as [string, any][]
    }
}

/**
 * Mock all user deposits across all assets.
 * Slot values are LTV percentages (e.g. 90, 85, 75...).
 * Returns { deposits: UserDepositInfo[] }
 */
export const getMockDiscoUserDeposits = (user: string) => {
    const now = Math.floor(Date.now() / 1000)
    return {
        deposits: [
            {
                asset: USDC_DENOM,
                slot: 90,
                deposit_id: "1",
                deposit: {
                    user,
                    vault_tokens: "5000000000",
                    last_claimed: now - (1 * 86400),
                    start_time: now - (60 * 86400),
                    deposit_time: now - (60 * 86400),
                    compound_claims: false,
                    withdrawals_enabled: true,
                },
                deposit_tokens: "5000000000",
            },
            {
                asset: USDC_DENOM,
                slot: 85,
                deposit_id: "5",
                deposit: {
                    user,
                    vault_tokens: "3000000000",
                    last_claimed: now - (2 * 86400),
                    start_time: now - (45 * 86400),
                    deposit_time: now - (45 * 86400),
                    compound_claims: true,
                    withdrawals_enabled: true,
                },
                deposit_tokens: "2950000000",
            },
            {
                asset: USDC_DENOM,
                slot: 75,
                deposit_id: "8",
                deposit: {
                    user,
                    vault_tokens: "7500000000",
                    last_claimed: now - (5 * 86400),
                    start_time: now - (90 * 86400),
                    deposit_time: now - (90 * 86400),
                    compound_claims: false,
                    withdrawals_enabled: true,
                },
                deposit_tokens: "7500000000",
            },
            {
                asset: USDC_DENOM,
                slot: 65,
                deposit_id: "12",
                deposit: {
                    user,
                    vault_tokens: "2000000000",
                    last_claimed: now - (3 * 86400),
                    start_time: now - (30 * 86400),
                    deposit_time: now - (30 * 86400),
                    compound_claims: false,
                    withdrawals_enabled: true,
                },
                deposit_tokens: "2000000000",
            },
            {
                asset: USDC_DENOM,
                slot: 55,
                deposit_id: "18",
                deposit: {
                    user,
                    vault_tokens: "1500000000",
                    last_claimed: now - (7 * 86400),
                    start_time: now - (20 * 86400),
                    deposit_time: now - (20 * 86400),
                    compound_claims: true,
                    withdrawals_enabled: true,
                },
                deposit_tokens: "1500000000",
            },
            {
                asset: USDC_DENOM,
                slot: 88,
                deposit_id: "21",
                deposit: {
                    user,
                    vault_tokens: "4000000000",
                    last_claimed: now - (10 * 86400),
                    start_time: now - (75 * 86400),
                    deposit_time: now - (75 * 86400),
                    compound_claims: false,
                    withdrawals_enabled: true,
                },
                deposit_tokens: "4000000000",
            },
        ]
    }
}

/**
 * Mock pending unstake requests.
 * Returns { requests: UnstakeRequest[] }
 */
export const getMockUnstakeRequests = (user: string, asset: string) => {
    const now = Math.floor(Date.now() / 1000)
    return {
        requests: [
            {
                user,
                asset: asset || USDC_DENOM,
                slot: 75,
                deposit_id: "8",
                vault_tokens: "2000000000",
                request_time: now - (1 * 86400),
                unlock_time: now + (1 * 86400),
            },
        ]
    }
}

/**
 * Mock pending claims.
 * Returns { claims: { slot, deposit_id, pending_amount }[] }
 */
export const getMockPendingClaims = (user: string, asset: string) => {
    return {
        claims: [
            { slot: 90, deposit_id: "1", pending_amount: "125000" },
            { slot: 85, deposit_id: "5", pending_amount: "90000" },
            { slot: 75, deposit_id: "8", pending_amount: "187500" },
            { slot: 65, deposit_id: "12", pending_amount: "60000" },
            { slot: 55, deposit_id: "18", pending_amount: "45000" },
            { slot: 88, deposit_id: "21", pending_amount: "100000" },
        ]
    }
}

/**
 * Mock slot weights.
 * Weights keyed by LTV percentage, higher LTV = higher weight.
 * Returns { weights: [slot, decimal_weight][] }
 */
export const getMockSlotWeights = (asset: string) => {
    const config = ASSET_QUEUE_CONFIGS[asset] || DEFAULT_CONFIG
    const minPct = Math.round(parseFloat(config.min_ltv) * 100)
    const maxPct = Math.round(parseFloat(config.max_ltv) * 100)
    const slotCount = maxPct - minPct + 1
    const weights: [number, string][] = []

    // Distribute weights: higher LTV gets more weight
    let totalWeight = 0
    const rawWeights: number[] = []
    for (let ltv = maxPct; ltv >= minPct; ltv--) {
        const position = (ltv - minPct) / (maxPct - minPct)
        const w = 0.5 + position * 2.0 // Range ~0.5 to 2.5
        rawWeights.push(w)
        totalWeight += w
    }

    let idx = 0
    for (let ltv = maxPct; ltv >= minPct; ltv--) {
        weights.push([ltv, (rawWeights[idx] / totalWeight).toFixed(4)])
        idx++
    }

    return { weights }
}

/**
 * Mock lifetime revenue for Disco.
 * Returns UserLifetimeRevenueEntry[] (latest entry = cumulative total)
 */
export const getMockDiscoLifetimeRevenue = (user: string, asset: string) => {
    const now = Math.floor(Date.now() / 1000)
    return [
        { timestamp: now - (90 * 86400), total_claimed: "250000" },
        { timestamp: now - (75 * 86400), total_claimed: "400000" },
        { timestamp: now - (60 * 86400), total_claimed: "600000" },
        { timestamp: now - (45 * 86400), total_claimed: "750000" },
        { timestamp: now - (30 * 86400), total_claimed: "900000" },
        { timestamp: now - (20 * 86400), total_claimed: "1050000" },
        { timestamp: now - (10 * 86400), total_claimed: "1200000" },
        { timestamp: now, total_claimed: "1350000" },
    ]
}

/**
 * Mock assets list
 */
export const getMockDiscoAssets = () => {
    return { assets: [USDC_DENOM, ATOM_DENOM, STATOM_DENOM, OSMO_DENOM] }
}

/**
 * Mock manager performance history.
 * Returns cumulative snapshots of fees earned, bad debt absorbed, and capital managed.
 */
export const getMockManagerPerformance = (manager: string) => {
    const now = Math.floor(Date.now() / 1000)
    const entries = []
    let cumulativeFees = 0
    let cumulativeBadDebt = 0

    for (let i = 11; i >= 0; i--) {
        const feesDelta = 50000 + Math.round(Math.random() * 100000)
        cumulativeFees += feesDelta
        // Bad debt is rare — only add in a couple of entries
        if (i === 7 || i === 3) {
            cumulativeBadDebt += 200000 + Math.round(Math.random() * 300000)
        }
        const capitalManaged = 50000000000 + Math.round(Math.sin(i) * 10000000000)

        entries.push({
            timestamp: now - (i * 7 * 86400),
            total_fees_earned: String(cumulativeFees),
            total_bad_debt_absorbed: String(cumulativeBadDebt),
            total_capital_managed: String(Math.max(capitalManaged, 10000000000)),
            assets_managed: [
                [USDC_DENOM, String(Math.round(capitalManaged * 0.6))],
                [ATOM_DENOM, String(Math.round(capitalManaged * 0.4))],
            ] as [string, string][],
        })
    }

    return { manager, entries }
}
