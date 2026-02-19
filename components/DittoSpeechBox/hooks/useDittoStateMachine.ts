import { useCallback, useRef, useMemo } from 'react'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import {
    DittoActivationState,
    DittoEvent,
    DittoMessage,
    DittoSeverity,
    MessageHistoryEntry,
    DittoStateMachineConfig,
    DEFAULT_DITTO_CONFIG,
    getMessagePriority,
} from '../types/dittoContract'

// ============================================================================
// STATE MACHINE STORE
// ============================================================================

interface DittoStateMachineState {
    /** Current activation state */
    activationState: DittoActivationState
    
    /** State before entering LOCKED (to return to) */
    priorState: DittoActivationState | null
    
    /** Currently displayed message (for toast/badge) */
    currentMessage: DittoMessage | null
    
    /** Badge count for BADGED state */
    badgeCount: number
    
    /** Pending messages waiting for display */
    pendingMessages: DittoMessage[]
    
    /** Message history for cooldown tracking */
    messageHistory: MessageHistoryEntry[]
    
    /** Last proactive message timestamp (for 90s window) */
    lastProactiveAt: number | null
    
    /** Current page ID */
    currentPageId: string | null
    
    /** Configuration */
    config: DittoStateMachineConfig
}

interface DittoStateMachineActions {
    /** Dispatch an event to the state machine */
    dispatch: (event: DittoEvent, payload?: DittoEventPayload) => void
    
    /** Set current page */
    setCurrentPage: (pageId: string) => void
    
    /** Queue a message for display */
    queueMessage: (message: DittoMessage) => boolean
    
    /** Clear current message */
    clearCurrentMessage: () => void
    
    /** Check if a message is on cooldown */
    isMessageOnCooldown: (messageId: string, severity: DittoSeverity) => boolean
    
    /** Record that a message was shown */
    recordMessageShown: (messageId: string, severity: DittoSeverity) => void
    
    /** Check if proactive message is allowed (90s window) */
    canShowProactive: () => boolean
    
    /** Reset state machine */
    reset: () => void
    
    /** Update configuration */
    updateConfig: (config: Partial<DittoStateMachineConfig>) => void
}

type DittoEventPayload = {
    message?: DittoMessage
    messages?: DittoMessage[]
}

type DittoStateMachineStore = DittoStateMachineState & DittoStateMachineActions

const initialState: DittoStateMachineState = {
    activationState: 'DORMANT',
    priorState: null,
    currentMessage: null,
    badgeCount: 0,
    pendingMessages: [],
    messageHistory: [],
    lastProactiveAt: null,
    currentPageId: null,
    config: DEFAULT_DITTO_CONFIG,
}

// ============================================================================
// STATE TRANSITIONS
// ============================================================================

/**
 * Compute the next state based on current state and event
 */
const computeNextState = (
    currentState: DittoActivationState,
    event: DittoEvent,
    state: DittoStateMachineState
): { nextState: DittoActivationState; priorState: DittoActivationState | null } => {
    let nextState = currentState
    let priorState = state.priorState

    switch (event) {
        case 'PAGE_ENTER':
            if (currentState === 'DORMANT') {
                nextState = 'IDLE'
            }
            break

        case 'USER_OPEN':
            if (currentState === 'IDLE' || currentState === 'BADGED') {
                nextState = 'OPEN'
            }
            break

        case 'USER_CLOSE':
            if (currentState === 'OPEN') {
                nextState = 'IDLE'
            }
            break

        case 'USER_INTERACTING':
            if (currentState !== 'LOCKED' && currentState !== 'OPEN') {
                priorState = currentState
                nextState = 'LOCKED'
            }
            break

        case 'USER_IDLE':
            if (currentState === 'LOCKED') {
                // Return to prior state, or IDLE if none
                nextState = priorState || 'IDLE'
                priorState = null
            }
            break

        case 'DATA_CHANGED':
            if (currentState === 'IDLE' && state.pendingMessages.length > 0) {
                nextState = 'BADGED'
            }
            break

        case 'RISK_THRESHOLD_CROSSED':
        case 'ACTION_BLOCKED':
            // Only show toast if not locked and within proactive limits
            if (currentState === 'IDLE' || currentState === 'BADGED') {
                const now = Date.now()
                const windowMs = state.config.proactiveWindowSec * 1000
                const canShowProactive = !state.lastProactiveAt || 
                    (now - state.lastProactiveAt) >= windowMs
                
                if (canShowProactive && state.currentMessage) {
                    nextState = 'PROACTIVE_TOAST'
                }
            }
            break

        case 'DISMISS':
            if (currentState === 'PROACTIVE_TOAST') {
                // Go to BADGED if there are pending messages, else IDLE
                nextState = state.pendingMessages.length > 0 ? 'BADGED' : 'IDLE'
            }
            break

        case 'TX_PENDING':
            // Lock during transaction
            if (currentState !== 'LOCKED') {
                priorState = currentState
                nextState = 'LOCKED'
            }
            break

        case 'TX_CONFIRMED':
        case 'TX_FAILED':
            // Return from locked if we were in tx
            if (currentState === 'LOCKED') {
                nextState = priorState || 'IDLE'
                priorState = null
            }
            break
    }

    return { nextState, priorState }
}

// ============================================================================
// STORE CREATION
// ============================================================================

export const useDittoStateMachineStore = create<DittoStateMachineStore>()(
    devtools(
        (set, get) => ({
            ...initialState,

            dispatch: (event: DittoEvent, payload?: DittoEventPayload) => {
                const state = get()
                
                // Don't process events in LOCKED state (except USER_IDLE and TX events)
                if (state.activationState === 'LOCKED' && 
                    !['USER_IDLE', 'TX_CONFIRMED', 'TX_FAILED'].includes(event)) {
                    return
                }

                const { nextState, priorState } = computeNextState(
                    state.activationState,
                    event,
                    state
                )

                // Handle message payload for ACTION_BLOCKED and RISK_THRESHOLD_CROSSED
                let currentMessage = state.currentMessage
                let lastProactiveAt = state.lastProactiveAt
                
                if (payload?.message && 
                    (event === 'ACTION_BLOCKED' || event === 'RISK_THRESHOLD_CROSSED')) {
                    currentMessage = payload.message
                    if (nextState === 'PROACTIVE_TOAST') {
                        lastProactiveAt = Date.now()
                    }
                }

                set({
                    activationState: nextState,
                    priorState,
                    currentMessage,
                    lastProactiveAt,
                }, false, `dispatch/${event}`)
            },

            setCurrentPage: (pageId: string) => {
                const state = get()
                
                // Reset state when changing pages
                set({
                    currentPageId: pageId,
                    activationState: 'IDLE',
                    priorState: null,
                    currentMessage: null,
                    badgeCount: 0,
                    pendingMessages: [],
                }, false, 'setCurrentPage')
            },

            queueMessage: (message: DittoMessage) => {
                const state = get()
                
                // Check if message is on cooldown
                if (state.isMessageOnCooldown(message.id, message.severity)) {
                    return false
                }

                // Check proactive limits for toast messages
                if (message.showAs === 'toast') {
                    if (!state.canShowProactive()) {
                        // Queue as badge instead
                        set((s) => ({
                            pendingMessages: [...s.pendingMessages, message],
                            badgeCount: s.badgeCount + 1,
                            activationState: s.activationState === 'IDLE' ? 'BADGED' : s.activationState,
                        }), false, 'queueMessage/badge')
                        return true
                    }
                }

                // Sort by priority and take highest
                const allMessages = [...state.pendingMessages, message]
                    .sort((a, b) => getMessagePriority(b) - getMessagePriority(a))

                set({
                    pendingMessages: allMessages,
                    badgeCount: allMessages.length,
                }, false, 'queueMessage')

                return true
            },

            clearCurrentMessage: () => {
                set({ currentMessage: null }, false, 'clearCurrentMessage')
            },

            isMessageOnCooldown: (messageId: string, severity: DittoSeverity) => {
                const state = get()
                const now = Date.now()
                
                const lastEntry = state.messageHistory.find(h => h.messageId === messageId)
                if (!lastEntry) return false

                // Check if cooldown has passed
                const cooldownMs = state.config.sameMessageCooldownSec * 1000
                const elapsed = now - lastEntry.shownAt

                if (elapsed >= cooldownMs) return false

                // Allow if severity increased
                const severityOrder: DittoSeverity[] = ['info', 'warn', 'danger']
                const lastIndex = severityOrder.indexOf(lastEntry.severity)
                const currentIndex = severityOrder.indexOf(severity)
                
                return currentIndex <= lastIndex
            },

            recordMessageShown: (messageId: string, severity: DittoSeverity) => {
                const now = Date.now()
                
                set((state) => {
                    // Remove old entry for this message
                    const filtered = state.messageHistory.filter(h => h.messageId !== messageId)
                    
                    // Add new entry
                    const newEntry: MessageHistoryEntry = {
                        messageId,
                        shownAt: now,
                        severity,
                    }

                    // Keep only last 100 entries
                    const history = [newEntry, ...filtered].slice(0, 100)

                    return { messageHistory: history }
                }, false, 'recordMessageShown')
            },

            canShowProactive: () => {
                const state = get()
                const now = Date.now()
                const windowMs = state.config.proactiveWindowSec * 1000
                
                if (!state.lastProactiveAt) return true
                
                return (now - state.lastProactiveAt) >= windowMs
            },

            reset: () => {
                set(initialState, false, 'reset')
            },

            updateConfig: (config: Partial<DittoStateMachineConfig>) => {
                set((state) => ({
                    config: { ...state.config, ...config },
                }), false, 'updateConfig')
            },
        }),
        { name: 'dittoStateMachine' }
    )
)

// ============================================================================
// HOOK
// ============================================================================

/**
 * Hook to interact with the Ditto state machine
 */
export const useDittoStateMachine = () => {
    const store = useDittoStateMachineStore()
    const toastTimeoutRef = useRef<NodeJS.Timeout | null>(null)

    // Auto-dismiss toast after duration
    const showToast = useCallback((message: DittoMessage) => {
        // Clear any existing timeout
        if (toastTimeoutRef.current) {
            clearTimeout(toastTimeoutRef.current)
        }

        // Set the message and transition to toast state
        store.dispatch('ACTION_BLOCKED', { message })
        store.recordMessageShown(message.id, message.severity)

        // Auto-dismiss
        toastTimeoutRef.current = setTimeout(() => {
            store.dispatch('DISMISS')
            toastTimeoutRef.current = null
        }, store.config.toastDurationMs)
    }, [store])

    // Handle page enter
    const enterPage = useCallback((pageId: string) => {
        store.setCurrentPage(pageId)
        store.dispatch('PAGE_ENTER')
    }, [store])

    // Report action blocked
    const reportActionBlocked = useCallback((actionId: string, message: DittoMessage) => {
        if (store.activationState === 'LOCKED') return
        if (!store.canShowProactive()) return
        if (store.isMessageOnCooldown(message.id, message.severity)) return

        showToast(message)
    }, [store, showToast])

    // Report risk threshold crossed
    const reportRiskThreshold = useCallback((message: DittoMessage) => {
        if (store.activationState === 'LOCKED') return
        if (!store.canShowProactive()) return
        if (store.isMessageOnCooldown(message.id, message.severity)) return

        showToast(message)
    }, [store, showToast])

    // Report data changed
    const reportDataChanged = useCallback((messages: DittoMessage[]) => {
        messages.forEach(msg => {
            if (!store.isMessageOnCooldown(msg.id, msg.severity)) {
                store.queueMessage(msg)
            }
        })
        store.dispatch('DATA_CHANGED')
    }, [store])

    // Get highest priority pending message
    const getTopMessage = useCallback((): DittoMessage | null => {
        if (store.pendingMessages.length === 0) return null
        return store.pendingMessages[0]
    }, [store.pendingMessages])

    // Consume the top message (mark as shown and remove from queue)
    const consumeTopMessage = useCallback(() => {
        const top = getTopMessage()
        if (!top) return null

        store.recordMessageShown(top.id, top.severity)
        
        useDittoStateMachineStore.setState((state) => ({
            pendingMessages: state.pendingMessages.slice(1),
            badgeCount: Math.max(0, state.badgeCount - 1),
        }))

        return top
    }, [getTopMessage, store])

    return {
        // State
        activationState: store.activationState,
        currentMessage: store.currentMessage,
        badgeCount: store.badgeCount,
        pendingMessages: store.pendingMessages,
        currentPageId: store.currentPageId,
        config: store.config,

        // Actions
        dispatch: store.dispatch,
        enterPage,
        reportActionBlocked,
        reportRiskThreshold,
        reportDataChanged,
        showToast,
        clearCurrentMessage: store.clearCurrentMessage,
        getTopMessage,
        consumeTopMessage,
        canShowProactive: store.canShowProactive,
        isMessageOnCooldown: store.isMessageOnCooldown,
        reset: store.reset,
        updateConfig: store.updateConfig,
    }
}

export default useDittoStateMachine









