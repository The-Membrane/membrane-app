import { useMemo, useCallback, useRef } from 'react'
import {
    DittoMessage,
    DittoPageContract,
    DittoFacts,
    EvaluatedMessage,
    getMessagePriority,
    DittoSeverity,
} from '../types/dittoContract'
import { useDittoStateMachine } from './useDittoStateMachine'

// ============================================================================
// CONDITION EVALUATION
// ============================================================================

/**
 * Parse and evaluate a condition expression against facts
 * 
 * Supports:
 * - Simple facts: "hasDeposit" (truthy check)
 * - Negation: "!hasDeposit"
 * - Comparisons: "riskScore >= 85", "loopCapacity < capacityRequired"
 * - Thresholds: "riskScore >= thresholds.riskDanger"
 * - Compound: "hasDeposit && currentLoop != targetLoop"
 * - Change detection: "baseAPR.changed" (requires previous facts)
 */
const evaluateCondition = (
    condition: string,
    facts: DittoFacts,
    thresholds: Record<string, number> = {},
    previousFacts?: DittoFacts
): boolean => {
    if (!condition || condition.trim() === '') return true

    try {
        // Create evaluation context with facts, thresholds, and change detection
        const context: Record<string, unknown> = { ...facts }
        
        // Add thresholds to context
        context.thresholds = thresholds

        // Add change detection for each fact
        if (previousFacts) {
            Object.keys(facts).forEach(key => {
                const current = facts[key]
                const previous = previousFacts[key]
                
                // Create change tracking object
                context[`${key}_changed`] = current !== previous
                context[`${key}_delta`] = typeof current === 'number' && typeof previous === 'number'
                    ? current - previous
                    : 0
            })
        }

        // Handle .changed and .delta syntax
        let processedCondition = condition
            .replace(/(\w+)\.changed/g, '$1_changed')
            .replace(/(\w+)\.delta/g, '$1_delta')

        // Build safe evaluation function
        const keys = Object.keys(context)
        const values = Object.values(context)

        // Create a function that evaluates the condition
        // Using Function constructor for dynamic evaluation
        // eslint-disable-next-line no-new-func
        const evaluator = new Function(
            ...keys,
            `"use strict"; return Boolean(${processedCondition});`
        )

        return evaluator(...values)
    } catch (error) {
        console.warn('[DittoMessageEngine] Failed to evaluate condition:', condition, error)
        return false
    }
}

/**
 * Interpolate fact values into message body
 * Replaces {factName} with actual values
 */
const interpolateBody = (body: string, facts: DittoFacts): string => {
    return body.replace(/\{(\w+)\}/g, (match, factName) => {
        const value = facts[factName]
        if (value === undefined || value === null) return match
        
        // Format numbers nicely
        if (typeof value === 'number') {
            return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
        }
        
        return String(value)
    })
}

// ============================================================================
// HOOK
// ============================================================================

interface UseDittoMessageEngineOptions {
    /** The page contract to use */
    contract: DittoPageContract
    
    /** Current fact values */
    facts: DittoFacts
    
    /** Previous fact values for change detection */
    previousFacts?: DittoFacts
}

interface UseDittoMessageEngineResult {
    /** All messages that currently match their conditions */
    matchingMessages: EvaluatedMessage[]
    
    /** Highest priority message */
    topMessage: EvaluatedMessage | null
    
    /** All ALERT messages that match */
    alerts: EvaluatedMessage[]
    
    /** All UPDATE messages that match */
    updates: EvaluatedMessage[]
    
    /** All INSIGHT messages that match */
    insights: EvaluatedMessage[]
    
    /** All SHORTCUT messages that match */
    shortcuts: EvaluatedMessage[]
    
    /** Check if a specific action is blocked (and get explanation) */
    getBlockedReason: (actionId: string) => EvaluatedMessage | null
    
    /** Get messages that explain why an action is blocked */
    getBlockingMessages: (actionId: string) => EvaluatedMessage[]
}

/**
 * Evaluates page facts against message conditions
 * Returns prioritized, filtered messages ready for display
 */
export const useDittoMessageEngine = ({
    contract,
    facts,
    previousFacts,
}: UseDittoMessageEngineOptions): UseDittoMessageEngineResult => {
    const { isMessageOnCooldown } = useDittoStateMachine()
    
    // Keep track of previous facts for change detection
    const prevFactsRef = useRef<DittoFacts | undefined>(previousFacts)

    // Evaluate all messages
    const evaluatedMessages = useMemo(() => {
        const results: EvaluatedMessage[] = []
        const thresholds = contract.thresholds || {}
        const prevFacts = previousFacts || prevFactsRef.current

        for (const message of contract.messages) {
            // Evaluate condition
            const conditionMet = evaluateCondition(
                message.when,
                facts,
                thresholds,
                prevFacts
            )

            if (!conditionMet) continue

            // Check cooldown
            const onCooldown = message.cooldownSec > 0 && 
                isMessageOnCooldown(message.id, message.severity)

            // Interpolate body
            const interpolatedBody = interpolateBody(message.body, facts)

            results.push({
                ...message,
                interpolatedBody,
                onCooldown,
            })
        }

        // Sort by priority (highest first)
        results.sort((a, b) => getMessagePriority(b) - getMessagePriority(a))

        return results
    }, [contract, facts, previousFacts, isMessageOnCooldown])

    // Update previous facts ref
    prevFactsRef.current = facts

    // Filter by type
    const matchingMessages = useMemo(() => 
        evaluatedMessages.filter(m => !m.onCooldown),
        [evaluatedMessages]
    )

    const alerts = useMemo(() => 
        matchingMessages.filter(m => m.type === 'ALERT'),
        [matchingMessages]
    )

    const updates = useMemo(() => 
        matchingMessages.filter(m => m.type === 'UPDATE'),
        [matchingMessages]
    )

    const insights = useMemo(() => 
        matchingMessages.filter(m => m.type === 'INSIGHT'),
        [matchingMessages]
    )

    const shortcuts = useMemo(() => 
        matchingMessages.filter(m => m.type === 'SHORTCUT'),
        [matchingMessages]
    )

    const topMessage = matchingMessages[0] || null

    // Get blocking messages for an action
    const getBlockingMessages = useCallback((actionId: string): EvaluatedMessage[] => {
        return matchingMessages.filter(m => 
            m.blocks && m.blocks.includes(actionId)
        )
    }, [matchingMessages])

    // Get first blocking reason for an action
    const getBlockedReason = useCallback((actionId: string): EvaluatedMessage | null => {
        const blocking = getBlockingMessages(actionId)
        return blocking[0] || null
    }, [getBlockingMessages])

    return {
        matchingMessages,
        topMessage,
        alerts,
        updates,
        insights,
        shortcuts,
        getBlockedReason,
        getBlockingMessages,
    }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Utility to create a change-tracking facts object
 * Call this on each render to track changes
 */
export const useFactsWithChangeTracking = (facts: DittoFacts) => {
    const prevFactsRef = useRef<DittoFacts>(facts)
    
    const factsWithChanges = useMemo(() => {
        const result: DittoFacts = { ...facts }
        const prevFacts = prevFactsRef.current
        
        // Add change tracking for each fact
        Object.keys(facts).forEach(key => {
            const current = facts[key]
            const previous = prevFacts[key]
            
            result[`${key}Changed`] = current !== previous
            
            if (typeof current === 'number' && typeof previous === 'number') {
                result[`${key}Delta`] = current - previous
            }
        })
        
        return result
    }, [facts])
    
    // Update ref after computing changes
    prevFactsRef.current = facts
    
    return factsWithChanges
}

/**
 * Evaluate a single message condition (for testing/debugging)
 */
export const testCondition = (
    condition: string,
    facts: DittoFacts,
    thresholds?: Record<string, number>
): boolean => {
    return evaluateCondition(condition, facts, thresholds)
}

export default useDittoMessageEngine








