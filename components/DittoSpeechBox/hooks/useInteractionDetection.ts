import { useEffect, useRef, useCallback } from 'react'
import { useDittoStateMachine } from './useDittoStateMachine'

interface UseInteractionDetectionOptions {
    /** Time in ms before considering user idle (default: 3000) */
    idleTimeoutMs?: number
    
    /** Whether to track keyboard input (default: true) */
    trackKeyboard?: boolean
    
    /** Whether to track mouse dragging (default: true) */
    trackDrag?: boolean
    
    /** Whether to track form focus (default: true) */
    trackFocus?: boolean
    
    /** Specific element to monitor (default: document) */
    targetRef?: React.RefObject<HTMLElement>
}

/**
 * Detects user interaction to manage LOCKED state
 * 
 * Tracks:
 * - Slider drags
 * - Input typing
 * - Form focus
 * - Transaction signing (via explicit API)
 * 
 * Dispatches USER_INTERACTING when interaction starts,
 * USER_IDLE after timeout of no interaction.
 */
export const useInteractionDetection = (options: UseInteractionDetectionOptions = {}) => {
    const {
        idleTimeoutMs = 3000,
        trackKeyboard = true,
        trackDrag = true,
        trackFocus = true,
        targetRef,
    } = options

    const { dispatch, activationState } = useDittoStateMachine()
    
    const isInteractingRef = useRef(false)
    const idleTimeoutRef = useRef<NodeJS.Timeout | null>(null)
    const isTxSigningRef = useRef(false)

    // Clear idle timeout
    const clearIdleTimeout = useCallback(() => {
        if (idleTimeoutRef.current) {
            clearTimeout(idleTimeoutRef.current)
            idleTimeoutRef.current = null
        }
    }, [])

    // Start idle timer
    const startIdleTimer = useCallback(() => {
        clearIdleTimeout()
        
        idleTimeoutRef.current = setTimeout(() => {
            // Don't trigger idle if tx signing is in progress
            if (isTxSigningRef.current) return
            
            if (isInteractingRef.current) {
                isInteractingRef.current = false
                dispatch('USER_IDLE')
            }
        }, idleTimeoutMs)
    }, [clearIdleTimeout, dispatch, idleTimeoutMs])

    // Mark user as interacting
    const markInteracting = useCallback(() => {
        if (!isInteractingRef.current) {
            isInteractingRef.current = true
            dispatch('USER_INTERACTING')
        }
        startIdleTimer()
    }, [dispatch, startIdleTimer])

    // Keyboard event handlers
    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        // Only track if typing in an input/textarea
        const target = e.target as HTMLElement
        const isInput = target.tagName === 'INPUT' || 
                       target.tagName === 'TEXTAREA' ||
                       target.isContentEditable

        if (isInput) {
            markInteracting()
        }
    }, [markInteracting])

    // Mouse drag handlers
    const handleMouseDown = useCallback((e: MouseEvent) => {
        const target = e.target as HTMLElement
        
        // Check if this is a slider or draggable element
        const isSlider = target.closest('[role="slider"]') ||
                        target.closest('input[type="range"]') ||
                        target.closest('[data-draggable]')
        
        if (isSlider) {
            markInteracting()
        }
    }, [markInteracting])

    // Focus handlers
    const handleFocusIn = useCallback((e: FocusEvent) => {
        const target = e.target as HTMLElement
        const isInput = target.tagName === 'INPUT' || 
                       target.tagName === 'TEXTAREA' ||
                       target.isContentEditable

        if (isInput) {
            markInteracting()
        }
    }, [markInteracting])

    const handleFocusOut = useCallback((e: FocusEvent) => {
        // Start idle timer when focus leaves input
        startIdleTimer()
    }, [startIdleTimer])

    // Touch handlers for mobile
    const handleTouchStart = useCallback((e: TouchEvent) => {
        const target = e.target as HTMLElement
        
        const isSlider = target.closest('[role="slider"]') ||
                        target.closest('input[type="range"]') ||
                        target.closest('[data-draggable]')
        
        if (isSlider) {
            markInteracting()
        }
    }, [markInteracting])

    // Setup event listeners
    useEffect(() => {
        const target = targetRef?.current || document

        if (trackKeyboard) {
            target.addEventListener('keydown', handleKeyDown as EventListener)
        }
        
        if (trackDrag) {
            target.addEventListener('mousedown', handleMouseDown as EventListener)
            target.addEventListener('touchstart', handleTouchStart as EventListener)
        }
        
        if (trackFocus) {
            target.addEventListener('focusin', handleFocusIn as EventListener)
            target.addEventListener('focusout', handleFocusOut as EventListener)
        }

        return () => {
            if (trackKeyboard) {
                target.removeEventListener('keydown', handleKeyDown as EventListener)
            }
            if (trackDrag) {
                target.removeEventListener('mousedown', handleMouseDown as EventListener)
                target.removeEventListener('touchstart', handleTouchStart as EventListener)
            }
            if (trackFocus) {
                target.removeEventListener('focusin', handleFocusIn as EventListener)
                target.removeEventListener('focusout', handleFocusOut as EventListener)
            }
            clearIdleTimeout()
        }
    }, [
        targetRef,
        trackKeyboard,
        trackDrag,
        trackFocus,
        handleKeyDown,
        handleMouseDown,
        handleTouchStart,
        handleFocusIn,
        handleFocusOut,
        clearIdleTimeout,
    ])

    // API for transaction signing
    const startTxSigning = useCallback(() => {
        isTxSigningRef.current = true
        dispatch('TX_PENDING')
    }, [dispatch])

    const endTxSigning = useCallback((success: boolean) => {
        isTxSigningRef.current = false
        dispatch(success ? 'TX_CONFIRMED' : 'TX_FAILED')
    }, [dispatch])

    // Force interaction state (for custom interactions)
    const forceInteracting = useCallback(() => {
        markInteracting()
    }, [markInteracting])

    const forceIdle = useCallback(() => {
        clearIdleTimeout()
        if (isInteractingRef.current) {
            isInteractingRef.current = false
            dispatch('USER_IDLE')
        }
    }, [clearIdleTimeout, dispatch])

    return {
        /** Whether user is currently interacting */
        isInteracting: isInteractingRef.current,
        
        /** Whether a transaction is being signed */
        isTxSigning: isTxSigningRef.current,
        
        /** Current activation state */
        activationState,
        
        /** Call when starting tx signing */
        startTxSigning,
        
        /** Call when tx signing ends */
        endTxSigning,
        
        /** Force interaction state */
        forceInteracting,
        
        /** Force idle state */
        forceIdle,
    }
}

export default useInteractionDetection









