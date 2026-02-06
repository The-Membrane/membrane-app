import { useEffect, useState, useCallback, useRef } from 'react'

interface ActivityState {
    isActive: boolean
    isIdle: boolean
    lastActivity: number
    idleTime: number
    hasReturned: boolean
}

interface UseActivityDetectionOptions {
    idleThreshold?: number // milliseconds before considered idle
    returnThreshold?: number // milliseconds away before "return" triggers
    onIdle?: () => void
    onActive?: () => void
    onReturn?: (awayDuration: number) => void
}

/**
 * Hook to detect user activity and return events
 */
export const useActivityDetection = (options: UseActivityDetectionOptions = {}) => {
    const {
        idleThreshold = 30000, // 30 seconds
        returnThreshold = 300000, // 5 minutes
        onIdle,
        onActive,
        onReturn,
    } = options

    const [state, setState] = useState<ActivityState>({
        isActive: true,
        isIdle: false,
        lastActivity: Date.now(),
        idleTime: 0,
        hasReturned: false,
    })

    const lastActivityRef = useRef(Date.now())
    const idleTimerRef = useRef<NodeJS.Timeout | null>(null)
    const wasIdleRef = useRef(false)
    const leftAtRef = useRef<number | null>(null)

    // Reset idle timer
    const resetIdleTimer = useCallback(() => {
        if (idleTimerRef.current) {
            clearTimeout(idleTimerRef.current)
        }

        idleTimerRef.current = setTimeout(() => {
            setState(prev => ({
                ...prev,
                isIdle: true,
                idleTime: Date.now() - prev.lastActivity,
            }))
            wasIdleRef.current = true
            onIdle?.()
        }, idleThreshold)
    }, [idleThreshold, onIdle])

    // Handle activity
    const handleActivity = useCallback(() => {
        const now = Date.now()
        const timeSinceLastActivity = now - lastActivityRef.current

        // Check if this is a "return" event
        if (wasIdleRef.current || timeSinceLastActivity > returnThreshold) {
            const awayDuration = leftAtRef.current ? now - leftAtRef.current : timeSinceLastActivity
            setState(prev => ({
                ...prev,
                isActive: true,
                isIdle: false,
                lastActivity: now,
                hasReturned: true,
            }))
            onReturn?.(awayDuration)

            // Reset hasReturned after a short delay
            setTimeout(() => {
                setState(prev => ({ ...prev, hasReturned: false }))
            }, 2000)
        } else if (!state.isActive) {
            setState(prev => ({
                ...prev,
                isActive: true,
                isIdle: false,
                lastActivity: now,
            }))
            onActive?.()
        }

        lastActivityRef.current = now
        wasIdleRef.current = false
        leftAtRef.current = null
        resetIdleTimer()
    }, [returnThreshold, state.isActive, onReturn, onActive, resetIdleTimer])

    // Handle visibility change (tab focus)
    const handleVisibilityChange = useCallback(() => {
        if (document.hidden) {
            // User left the tab
            leftAtRef.current = Date.now()
        } else {
            // User returned to the tab
            handleActivity()
        }
    }, [handleActivity])

    // Set up event listeners
    useEffect(() => {
        const activityEvents = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'click']

        activityEvents.forEach(event => {
            window.addEventListener(event, handleActivity, { passive: true })
        })

        document.addEventListener('visibilitychange', handleVisibilityChange)

        // Initial idle timer
        resetIdleTimer()

        return () => {
            activityEvents.forEach(event => {
                window.removeEventListener(event, handleActivity)
            })
            document.removeEventListener('visibilitychange', handleVisibilityChange)

            if (idleTimerRef.current) {
                clearTimeout(idleTimerRef.current)
            }
        }
    }, [handleActivity, handleVisibilityChange, resetIdleTimer])

    // Update idle time periodically when idle
    useEffect(() => {
        if (!state.isIdle) return

        const interval = setInterval(() => {
            setState(prev => ({
                ...prev,
                idleTime: Date.now() - prev.lastActivity,
            }))
        }, 1000)

        return () => clearInterval(interval)
    }, [state.isIdle])

    return {
        ...state,
        // Utility functions
        triggerActivity: handleActivity,
        resetState: () => {
            setState({
                isActive: true,
                isIdle: false,
                lastActivity: Date.now(),
                idleTime: 0,
                hasReturned: false,
            })
            resetIdleTimer()
        },
    }
}

/**
 * Format idle time for display
 */
export const formatIdleTime = (ms: number): string => {
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)

    if (hours > 0) {
        return `${hours}h ${minutes % 60}m`
    }
    if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`
    }
    return `${seconds}s`
}

