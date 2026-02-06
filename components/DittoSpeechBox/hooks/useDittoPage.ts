import { useEffect, useCallback, useMemo, useRef } from 'react'
import { useRouter } from 'next/router'
import {
    DittoPageContract,
    DittoFacts,
    DittoMessage,
    DittoShortcut,
    EvaluatedMessage,
} from '../types/dittoContract'
import { useDittoStateMachine } from './useDittoStateMachine'
import { useDittoMessageEngine } from './useDittoMessageEngine'
import { useInteractionDetection } from './useInteractionDetection'
import { getContractForRoute } from '@/contracts'

// ============================================================================
// TYPES
// ============================================================================

interface UseDittoPageOptions {
    /** The page contract (if not using route-based lookup) */
    contract?: DittoPageContract
    
    /** Current fact values from the page */
    facts: DittoFacts
    
    /** Callback when a shortcut is triggered */
    onShortcut?: (shortcutId: string, action: string) => void
    
    /** Whether to enable interaction detection */
    enableInteractionDetection?: boolean
}

interface UseDittoPageResult {
    // Message state
    /** Current toast message (if showing) */
    toastMessage: DittoMessage | null
    
    /** Badge count for updates */
    badgeCount: number
    
    /** All matching messages for panel display */
    panelMessages: EvaluatedMessage[]
    
    /** Alerts currently active */
    alerts: EvaluatedMessage[]
    
    /** Updates currently active */
    updates: EvaluatedMessage[]
    
    /** Insights currently active */
    insights: EvaluatedMessage[]
    
    /** Available shortcuts */
    shortcuts: DittoShortcut[]
    
    // State
    /** Current activation state */
    activationState: string
    
    /** Whether Ditto is currently locked */
    isLocked: boolean
    
    /** Whether Ditto is showing a toast */
    isShowingToast: boolean
    
    // Actions
    /** Report an action was blocked */
    reportActionBlocked: (actionId: string) => void
    
    /** Report a risk threshold was crossed */
    reportRiskThreshold: (thresholdId: string) => void
    
    /** Dismiss current toast */
    dismissToast: () => void
    
    /** Open Ditto panel */
    openPanel: () => void
    
    /** Close Ditto panel */
    closePanel: () => void
    
    /** Execute a shortcut */
    executeShortcut: (shortcutId: string) => void
    
    /** Check if an action is blocked */
    isActionBlocked: (actionId: string) => boolean
    
    /** Get blocking reason for an action */
    getBlockingReason: (actionId: string) => string | null
    
    // Transaction lifecycle
    /** Call when starting a transaction */
    startTransaction: () => void
    
    /** Call when transaction completes */
    endTransaction: (success: boolean) => void
}

// ============================================================================
// HOOK
// ============================================================================

/**
 * Unified hook for page-level Ditto integration
 * 
 * Usage:
 * ```tsx
 * const ditto = useDittoPage({
 *   facts: {
 *     hasDeposit: hasPosition,
 *     depositAmount: position?.amount || 0,
 *     currentLoop: currentLoopLevel,
 *     ...
 *   },
 *   onShortcut: (id, action) => {
 *     if (action === 'scrollToPosition') scrollToPosition()
 *   }
 * })
 * 
 * // In render:
 * <Button isDisabled={ditto.isActionBlocked('loop')}>Loop</Button>
 * ```
 */
export const useDittoPage = ({
    contract: providedContract,
    facts,
    onShortcut,
    enableInteractionDetection = true,
}: UseDittoPageOptions): UseDittoPageResult => {
    const router = useRouter()
    const prevFactsRef = useRef<DittoFacts>({})
    
    // Get contract from route if not provided
    const contract = useMemo(() => {
        if (providedContract) return providedContract
        return getContractForRoute(router.pathname)
    }, [providedContract, router.pathname])
    
    // State machine
    const stateMachine = useDittoStateMachine()
    
    // Interaction detection
    const interaction = useInteractionDetection({
        idleTimeoutMs: stateMachine.config.idleTimeoutMs,
    })
    
    // Message engine
    const messageEngine = useDittoMessageEngine({
        contract: contract || {
            pageId: 'unknown',
            facts: {},
            messages: [],
            shortcuts: [],
        },
        facts,
        previousFacts: prevFactsRef.current,
    })
    
    // Update previous facts ref
    useEffect(() => {
        prevFactsRef.current = facts
    }, [facts])
    
    // Enter page on mount
    useEffect(() => {
        if (contract) {
            stateMachine.enterPage(contract.pageId)
        }
    }, [contract?.pageId])
    
    // Process messages and queue updates
    useEffect(() => {
        if (!contract) return
        
        // Queue UPDATE messages as badges
        const updates = messageEngine.updates
        if (updates.length > 0) {
            stateMachine.reportDataChanged(updates.map(u => ({
                ...u,
                body: u.interpolatedBody,
            })))
        }
    }, [messageEngine.updates, contract, stateMachine])
    
    // Report action blocked
    const reportActionBlocked = useCallback((actionId: string) => {
        const blockingMessage = messageEngine.getBlockedReason(actionId)
        if (blockingMessage) {
            stateMachine.reportActionBlocked(actionId, {
                ...blockingMessage,
                body: blockingMessage.interpolatedBody,
            })
        }
    }, [messageEngine, stateMachine])
    
    // Report risk threshold crossed
    const reportRiskThreshold = useCallback((thresholdId: string) => {
        // Find the first ALERT with matching threshold
        const riskAlert = messageEngine.alerts.find(a => 
            a.id.includes('risk') || a.when.includes(thresholdId)
        )
        if (riskAlert) {
            stateMachine.reportRiskThreshold({
                ...riskAlert,
                body: riskAlert.interpolatedBody,
            })
        }
    }, [messageEngine, stateMachine])
    
    // Dismiss toast
    const dismissToast = useCallback(() => {
        stateMachine.dispatch('DISMISS')
    }, [stateMachine])
    
    // Open/close panel
    const openPanel = useCallback(() => {
        stateMachine.dispatch('USER_OPEN')
    }, [stateMachine])
    
    const closePanel = useCallback(() => {
        stateMachine.dispatch('USER_CLOSE')
    }, [stateMachine])
    
    // Execute shortcut
    const executeShortcut = useCallback((shortcutId: string) => {
        if (!contract) return
        
        const shortcut = contract.shortcuts.find(s => s.id === shortcutId)
        if (shortcut && onShortcut) {
            onShortcut(shortcutId, shortcut.action)
        }
    }, [contract, onShortcut])
    
    // Check if action is blocked
    const isActionBlocked = useCallback((actionId: string) => {
        return messageEngine.getBlockedReason(actionId) !== null
    }, [messageEngine])
    
    // Get blocking reason
    const getBlockingReason = useCallback((actionId: string): string | null => {
        const reason = messageEngine.getBlockedReason(actionId)
        return reason?.interpolatedBody || null
    }, [messageEngine])
    
    // Transaction lifecycle
    const startTransaction = useCallback(() => {
        interaction.startTxSigning()
    }, [interaction])
    
    const endTransaction = useCallback((success: boolean) => {
        interaction.endTxSigning(success)
    }, [interaction])
    
    // Filter shortcuts by condition
    const availableShortcuts = useMemo(() => {
        if (!contract) return []
        
        // Evaluate shortcut conditions
        return contract.shortcuts.filter(shortcut => {
            try {
                // Simple truthy check for 'true' condition
                if (shortcut.when === 'true') return true
                
                // Evaluate condition against facts
                const keys = Object.keys(facts)
                const values = Object.values(facts)
                // eslint-disable-next-line no-new-func
                const evaluator = new Function(
                    ...keys,
                    `"use strict"; return Boolean(${shortcut.when});`
                )
                return evaluator(...values)
            } catch {
                return false
            }
        })
    }, [contract, facts])
    
    // Panel messages (sorted by priority)
    const panelMessages = useMemo(() => {
        return messageEngine.matchingMessages.filter(m => 
            m.showAs === 'panel' || m.type === 'INSIGHT'
        )
    }, [messageEngine.matchingMessages])
    
    return {
        // Message state
        toastMessage: stateMachine.currentMessage,
        badgeCount: stateMachine.badgeCount,
        panelMessages,
        alerts: messageEngine.alerts,
        updates: messageEngine.updates,
        insights: messageEngine.insights,
        shortcuts: availableShortcuts,
        
        // State
        activationState: stateMachine.activationState,
        isLocked: stateMachine.activationState === 'LOCKED',
        isShowingToast: stateMachine.activationState === 'PROACTIVE_TOAST',
        
        // Actions
        reportActionBlocked,
        reportRiskThreshold,
        dismissToast,
        openPanel,
        closePanel,
        executeShortcut,
        isActionBlocked,
        getBlockingReason,
        
        // Transaction lifecycle
        startTransaction,
        endTransaction,
    }
}

export default useDittoPage








