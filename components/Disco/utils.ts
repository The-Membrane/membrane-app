// LTV can be Decimal, string, or number

/**
 * Maps LTV to layer number (0-9)
 * Layers: 60-63, 63-66, 66-69, 69-72, 72-75, 75-78, 78-81, 81-84, 84-87, 87-90
 */
export const getLTVLayer = (ltv: Decimal | string | number): number => {
    const ltvNum = typeof ltv === 'string'
        ? parseFloat(ltv)
        : typeof ltv === 'number'
            ? ltv
            : parseFloat(ltv.toString())

    if (ltvNum < 60) return 0
    if (ltvNum >= 90) return 9

    // Each layer is 3 LTV wide: 60-63, 63-66, etc.
    const layer = Math.floor((ltvNum - 60) / 3)
    return Math.min(9, Math.max(0, layer))
}

/**
 * Gets LTV range for a specific layer
 */
export const getLTVRange = (layer: number): { min: number; max: number } => {
    const min = 60 + (layer * 3)
    const max = min + 3
    return { min, max: Math.min(90, max) }
}

/**
 * Groups deposits by (ltv, max_borrow_ltv) pairs
 */
export const groupDepositsByLTVPair = (deposits: any[]) => {
    const groups: Record<string, any[]> = {}

    deposits.forEach(deposit => {
        const ltv = deposit.ltv || deposit.max_ltv || '0'
        const maxBorrowLtv = deposit.max_borrow_ltv || '0'
        // Convert to strings to ensure proper key generation
        const ltvStr = typeof ltv === 'object' ? (ltv?.toString?.() || String(ltv)) : String(ltv)
        const maxBorrowLtvStr = typeof maxBorrowLtv === 'object' ? (maxBorrowLtv?.toString?.() || String(maxBorrowLtv)) : String(maxBorrowLtv)
        const key = `${ltvStr}-${maxBorrowLtvStr}`

        if (!groups[key]) {
            groups[key] = []
        }
        groups[key].push(deposit)
    })

    return groups
}

/**
 * Calculates TVL for a specific LTV layer from queue data
 */
export const calculateLayerTVL = (queue: any, layer: number): string => {
    if (!queue || !queue.slots) return "0"

    const { min, max } = getLTVRange(layer)
    let total = 0

    queue.slots.forEach((slot: any) => {
        const slotLtv = parseFloat(slot.ltv || '0')
        if (slotLtv >= min && slotLtv < max) {
            slot.deposit_groups?.forEach((group: any) => {
                total += parseFloat(group.total_deposit_tokens || '0')
            })
        }
    })

    return total.toString()
}

/**
 * Formats lock duration for display
 */
export const formatLockDuration = (locked: any): string => {
    if (!locked || !locked.locked_until) return "Not locked"

    const now = Math.floor(Date.now() / 1000)
    const lockedUntil = parseInt(locked.locked_until || '0')

    if (lockedUntil <= now) return "Unlocked"

    const secondsRemaining = lockedUntil - now
    const days = Math.floor(secondsRemaining / 86400)
    const hours = Math.floor((secondsRemaining % 86400) / 3600)

    if (days > 0) {
        return `${days}d ${hours}h`
    }
    return `${hours}h`
}

/**
 * Filters user deposits by LTV layer
 */
export const getUserDepositsInLayer = (deposits: any[], layer: number): any[] => {
    const { min, max } = getLTVRange(layer)

    return deposits.filter(deposit => {
        const ltv = parseFloat(deposit.ltv || deposit.max_ltv || '0')
        return ltv >= min && ltv < max
    })
}

/**
 * Sorts deposits by LTV pair (lowest at bottom, highest at top)
 */
export const sortDepositsByLTVPair = (deposits: any[]): any[] => {
    return [...deposits].sort((a, b) => {
        const aLtv = parseFloat(a.ltv || a.max_ltv || '0')
        const bLtv = parseFloat(b.ltv || b.max_ltv || '0')
        const aBorrow = parseFloat(a.max_borrow_ltv || '0')
        const bBorrow = parseFloat(b.max_borrow_ltv || '0')

        // First sort by max_borrow_ltv, then by ltv
        if (aBorrow !== bBorrow) {
            return aBorrow - bBorrow
        }
        return aLtv - bLtv
    })
}

