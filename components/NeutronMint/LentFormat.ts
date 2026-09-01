// Match formatLargeNumber from AvailableCollateral
export const formatLargeNumber = (value: number): string => {
    if (value >= 1_000_000) {
        const millions = value / 1_000_000
        return `$${millions.toFixed(millions >= 10 ? 1 : 2)}M`
    } else if (value >= 1_000) {
        const thousands = value / 1_000
        return `$${thousands.toFixed(thousands >= 10 ? 0 : 1)}K`
    } else {
        return `$${value.toFixed(0)}`
    }
}

// Match formatMbrn from AvailableToLend (includes " MBRN" suffix)
export const formatMbrn = (amount: number): string => {
    if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M MBRN`
    if (amount >= 1_000) return `${(amount / 1_000).toFixed(0)}K MBRN`
    return `${amount.toFixed(0)} MBRN`
}
