/**
 * Ditto Contract Types
 * 
 * Core type definitions for the Ditto companion system.
 * These types define the structure of messages, shortcuts, page contracts,
 * and the global activation state machine.
 */

// ============================================================================
// SEVERITY & MESSAGE TYPES
// ============================================================================

/**
 * Message severity levels for styling and priority
 * - info: neutral information, cyan/blue styling
 * - warn: caution/attention needed, yellow/orange styling  
 * - danger: critical/blocking issue, red styling
 */
export type DittoSeverity = 'info' | 'warn' | 'danger'

/**
 * Message types - only these 4 are allowed
 * Priority: ALERT > UPDATE > INSIGHT > SHORTCUT
 */
export type DittoMessageType = 'ALERT' | 'UPDATE' | 'INSIGHT' | 'SHORTCUT'

/**
 * How the message should be displayed
 * - toast: proactive non-blocking message near Ditto
 * - badge: indicator on Ditto avatar (dot/number)
 * - panel: shown when user opens Ditto
 */
export type DittoShowAs = 'toast' | 'badge' | 'panel'

// ============================================================================
// ACTIVATION STATE MACHINE
// ============================================================================

/**
 * Ditto's activation states
 * 
 * DORMANT: collapsed, no badge, no message
 * IDLE: collapsed, can be opened, no proactive message
 * BADGED: collapsed with badge indicating something new
 * OPEN: expanded panel (user opened)
 * PROACTIVE_TOAST: brief toast-style line near Ditto (non-blocking)
 * LOCKED: temporarily suppressed (user mid-action)
 */
export type DittoActivationState =
    | 'DORMANT'
    | 'IDLE'
    | 'BADGED'
    | 'OPEN'
    | 'PROACTIVE_TOAST'
    | 'LOCKED'

/**
 * Events that trigger state transitions
 */
export type DittoEvent =
    | 'PAGE_ENTER'
    | 'USER_OPEN'
    | 'USER_CLOSE'
    | 'USER_INTERACTING'
    | 'USER_IDLE'
    | 'DATA_CHANGED'
    | 'RISK_THRESHOLD_CROSSED'
    | 'ACTION_BLOCKED'
    | 'TX_PENDING'
    | 'TX_CONFIRMED'
    | 'TX_FAILED'
    | 'DISMISS'

// ============================================================================
// MESSAGE & SHORTCUT DEFINITIONS
// ============================================================================

/**
 * A Ditto message definition
 */
export interface DittoMessage {
    /** Stable unique key for cooldown/dedupe */
    id: string
    
    /** Message type (ALERT, UPDATE, INSIGHT, SHORTCUT) */
    type: DittoMessageType
    
    /** Severity level for styling */
    severity: DittoSeverity
    
    /** Optional short title */
    title?: string
    
    /** Message body - 1-2 lines, max 3 for danger alerts */
    body: string
    
    /** 
     * Boolean expression over page facts
     * Uses template syntax: {factName} for interpolation
     * Example: 'hasDeposit && riskScore > 70'
     */
    when: string
    
    /** Per-message cooldown in seconds (0 = no cooldown) */
    cooldownSec: number
    
    /** Preferred display surface */
    showAs: DittoShowAs
    
    /** List of action IDs this message explains (for ACTION_BLOCKED) */
    blocks?: string[]
}

/**
 * A Ditto shortcut - one-tap action shown when user opens Ditto
 */
export interface DittoShortcut {
    /** Unique identifier */
    id: string
    
    /** Short verb phrase label */
    label: string
    
    /** Availability condition expression */
    when: string
    
    /** App action identifier to execute */
    action: string
}

// ============================================================================
// PAGE CONTRACT
// ============================================================================

/**
 * A page's Ditto contract - defines all facts, messages, and shortcuts
 * that Ditto can use on a specific page
 */
export interface DittoPageContract {
    /** Unique page identifier */
    pageId: string
    
    /** 
     * Facts Ditto can use as inputs
     * Key: fact name, Value: human-readable description
     */
    facts: Record<string, string>
    
    /** All messages for this page */
    messages: DittoMessage[]
    
    /** All shortcuts for this page */
    shortcuts: DittoShortcut[]
    
    /** Optional threshold values for conditions */
    thresholds?: Record<string, number>
}

// ============================================================================
// RUNTIME TYPES
// ============================================================================

/**
 * Runtime fact values provided by the page
 */
export type DittoFacts = Record<string, unknown>

/**
 * Evaluated message ready for display
 */
export interface EvaluatedMessage extends DittoMessage {
    /** Interpolated body with fact values */
    interpolatedBody: string
    
    /** Whether this message is currently on cooldown */
    onCooldown: boolean
    
    /** Timestamp when message was last shown */
    lastShownAt?: number
}

/**
 * Message history entry for cooldown tracking
 */
export interface MessageHistoryEntry {
    messageId: string
    shownAt: number
    severity: DittoSeverity
}

/**
 * State machine configuration
 */
export interface DittoStateMachineConfig {
    /** Max proactive messages per page per this many seconds */
    proactiveWindowSec: number
    
    /** Same message cooldown unless severity increases */
    sameMessageCooldownSec: number
    
    /** Idle timeout before returning from LOCKED state */
    idleTimeoutMs: number
    
    /** Toast auto-dismiss duration */
    toastDurationMs: number
}

/**
 * Default configuration values
 */
export const DEFAULT_DITTO_CONFIG: DittoStateMachineConfig = {
    proactiveWindowSec: 90,
    sameMessageCooldownSec: 600, // 10 minutes
    idleTimeoutMs: 3000,
    toastDurationMs: 5000,
}

// ============================================================================
// PRIORITY HELPERS
// ============================================================================

/**
 * Priority values for message types (higher = more important)
 */
export const MESSAGE_TYPE_PRIORITY: Record<DittoMessageType, number> = {
    ALERT: 100,
    UPDATE: 75,
    INSIGHT: 50,
    SHORTCUT: 25,
}

/**
 * Priority values for severity levels (higher = more important)
 */
export const SEVERITY_PRIORITY: Record<DittoSeverity, number> = {
    danger: 100,
    warn: 50,
    info: 25,
}

/**
 * Calculate combined priority score for a message
 */
export const getMessagePriority = (message: DittoMessage): number => {
    return MESSAGE_TYPE_PRIORITY[message.type] + SEVERITY_PRIORITY[message.severity]
}








