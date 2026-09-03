/**
 * Ditto Companion Messages Configuration
 * 
 * This file contains:
 * 1. Legacy timed messages (for backwards compatibility)
 * 2. Transaction acknowledgements
 * 3. New standardized message types following the Ditto charter
 * 
 * For new implementations, use page contracts in /contracts/ instead.
 * See docs/DITTO_RULES.md for the full specification.
 */

import {
    DittoMessage,
    DittoSeverity,
    DittoMessageType,
} from '@/components/DittoSpeechBox/types/dittoContract'

// ============================================================================
// LEGACY TIMED MESSAGES (Backwards Compatibility)
// ============================================================================

/**
 * @deprecated Use page contracts instead. See /contracts/ directory.
 */
export interface TimedMessage {
    id: string
    page: string
    delay: number
    message: string
    condition?: {
        hasPosition?: boolean
        hasDeposit?: boolean
        firstVisit?: boolean
    }
    showOnce?: boolean
    priority?: number
}

/**
 * @deprecated Use page contracts instead
 */
export const timedMessages: TimedMessage[] = [
    // Manic page messages
    {
        id: 'manic-first-visit',
        page: '/manic',
        delay: 3,
        message: "Click if ur cool 😎",
        condition: { firstVisit: true },
        showOnce: true,
        priority: 10,
    },
    {
        id: 'manic-no-position',
        page: '/manic',
        delay: 7,
        message: "Don't forget the APR will compound exponentially!",
        condition: { hasPosition: false },
        showOnce: false,
        priority: 5,
    },
    {
        id: 'manic-has-position',
        page: '/manic',
        delay: 10,
        message: "Your position is actively earning! Consider looping for more.",
        condition: { hasPosition: true },
        showOnce: true,
        priority: 3,
    },
    // Disco page messages
    {
        id: 'disco-no-deposits',
        page: '/disco',
        delay: 5,
        message: "Start earning by depositing assets into Disco!",
        condition: { hasDeposit: false },
        showOnce: true,
        priority: 5,
    },
    {
        id: 'disco-has-deposits',
        page: '/disco',
        delay: 8,
        message: "Your deposits are earning MBRN rewards. Nice!",
        condition: { hasDeposit: true },
        showOnce: true,
        priority: 3,
    },
    // Transmuter page messages
    {
        id: 'transmuter-first-visit',
        page: '/transmuter',
        delay: 4,
        message: "The Transmuter lets you swap between CDT and USDC!",
        condition: { firstVisit: true },
        showOnce: true,
        priority: 5,
    },
    // Portfolio page messages
    {
        id: 'portfolio-welcome',
        page: '/portfolio',
        delay: 5,
        message: "Track all your positions and earnings right here!",
        condition: { firstVisit: true },
        showOnce: true,
        priority: 5,
    },
]

/**
 * @deprecated Use page contracts instead
 */
export const getMessagesForPage = (page: string): TimedMessage[] => {
    return timedMessages
        .filter(msg => page.includes(msg.page))
        .sort((a, b) => (b.priority || 0) - (a.priority || 0))
}

// ============================================================================
// TRANSACTION ACKNOWLEDGEMENTS
// ============================================================================

export interface TxAcknowledgement {
    actionType: 'deposit' | 'withdraw' | 'loop' | 'mint' | 'stake' | 'unstake' | 'swap' | 'lock' | 'unlock' | 'claim'
    page?: string
    message: string | ((txData: any) => string)
    priority?: number
    /** New: severity for styling */
    severity?: DittoSeverity
}

// Acknowledgements name the action that landed, nothing more. The celebratory
// per-page copy ("Loop complete! Your position has been optimized") was removed:
// it rendered zero numbers, so it told instead of taught (Badass rule 1). The
// rendered consequence (Points delta, position state) is the teach moment.
export const txAcknowledgements: TxAcknowledgement[] = [
    { actionType: 'deposit', message: "Deposit landed.", priority: 1, severity: 'info' },
    { actionType: 'withdraw', message: "Withdrawal landed.", priority: 1, severity: 'info' },
    { actionType: 'loop', message: "Loop executed.", priority: 1, severity: 'info' },
    { actionType: 'claim', message: "Claim landed.", priority: 1, severity: 'info' },
    { actionType: 'stake', message: "Stake landed.", priority: 1, severity: 'info' },
    { actionType: 'unstake', message: "Unstake landed.", priority: 1, severity: 'info' },
    { actionType: 'mint', message: "Mint landed.", priority: 1, severity: 'info' },
    { actionType: 'lock', message: "Lock landed.", priority: 1, severity: 'info' },
    { actionType: 'unlock', message: "Unlock landed.", priority: 1, severity: 'info' },
    { actionType: 'swap', message: "Swap landed.", priority: 1, severity: 'info' },
]

/**
 * Get acknowledgement for a specific action and page
 */
export const getAcknowledgement = (actionType: TxAcknowledgement['actionType'], page?: string): string => {
    const acks = txAcknowledgements
        .filter(ack => ack.actionType === actionType)
        .sort((a, b) => (b.priority || 0) - (a.priority || 0))

    if (page) {
        // js-set-map-lookups FP: `page` is a string (route path); `.includes()` here is
        // String.prototype substring matching, not array membership — a Set doesn't apply.
        const pageAck = acks.find(ack => ack.page && page.includes(ack.page))
        if (pageAck) {
            return typeof pageAck.message === 'function' ? pageAck.message({}) : pageAck.message
        }
    }

    const genericAck = acks.find(ack => !ack.page)
    if (genericAck) {
        return typeof genericAck.message === 'function' ? genericAck.message({}) : genericAck.message
    }

    return 'Transaction successful!'
}

/**
 * Get acknowledgement as a DittoMessage (new format)
 */
export const getAcknowledgementMessage = (
    actionType: TxAcknowledgement['actionType'],
    page?: string
): DittoMessage | null => {
    const acks = txAcknowledgements
        .filter(ack => ack.actionType === actionType)
        .sort((a, b) => (b.priority || 0) - (a.priority || 0))

    let ack: TxAcknowledgement | undefined
    
    if (page) {
        // js-set-map-lookups FP: `page` is a string (route path); `.includes()` here is
        // String.prototype substring matching, not array membership — a Set doesn't apply.
        ack = acks.find(a => a.page && page.includes(a.page))
    }
    
    if (!ack) {
        ack = acks.find(a => !a.page)
    }

    if (!ack) return null

    const body = typeof ack.message === 'function' ? ack.message({}) : ack.message

    return {
        id: `tx-ack-${actionType}-${Date.now()}`,
        type: 'UPDATE' as DittoMessageType,
        severity: ack.severity || 'info',
        body,
        when: 'true',
        cooldownSec: 0,
        showAs: 'toast',
    }
}

// ============================================================================
// NEW STANDARDIZED MESSAGES
// ============================================================================

/**
 * Global alert messages that apply across the app
 */
export const globalAlerts: DittoMessage[] = [
    {
        id: 'global-wallet-disconnected',
        type: 'ALERT',
        severity: 'info',
        body: 'Connect wallet to access all features',
        when: '!isConnected',
        cooldownSec: 300,
        showAs: 'panel',
        blocks: ['deposit', 'withdraw', 'loop', 'swap', 'claim'],
    },
    {
        id: 'global-network-error',
        type: 'ALERT',
        severity: 'danger',
        body: 'Network error — some data may be stale',
        when: 'networkError',
        cooldownSec: 60,
        showAs: 'toast',
    },
]

/**
 * Convert legacy TimedMessage to new DittoMessage format
 */
export const convertLegacyMessage = (legacy: TimedMessage): DittoMessage => {
    // Build condition string from legacy conditions
    const conditions: string[] = []
    if (legacy.condition?.hasPosition !== undefined) {
        conditions.push(legacy.condition.hasPosition ? 'hasPosition' : '!hasPosition')
    }
    if (legacy.condition?.hasDeposit !== undefined) {
        conditions.push(legacy.condition.hasDeposit ? 'hasDeposit' : '!hasDeposit')
    }
    if (legacy.condition?.firstVisit !== undefined) {
        conditions.push(legacy.condition.firstVisit ? 'isFirstVisit' : '!isFirstVisit')
    }

    return {
        id: legacy.id,
        type: 'INSIGHT', // Legacy messages are treated as insights
        severity: 'info',
        body: legacy.message,
        when: conditions.length > 0 ? conditions.join(' && ') : 'true',
        cooldownSec: legacy.showOnce ? 86400 : 600, // 24h if showOnce, otherwise 10min
        showAs: 'panel',
    }
}

/**
 * Get all messages for a page in the new format
 */
export const getStandardizedMessagesForPage = (page: string): DittoMessage[] => {
    const legacyMessages = getMessagesForPage(page)
    return legacyMessages.map(convertLegacyMessage)
}
