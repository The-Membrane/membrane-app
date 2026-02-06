import { useEffect, useMemo, useCallback, useRef } from 'react'
import useUpdatesState, { ProtocolUpdate } from '@/persisted-state/useUpdatesState'
import { useIdleGains } from '@/components/Portfolio/PortPage/hooks/useIdleGains'
import { useLockdropEnding, useLockdropClaimsReady } from './useLockdropNotifications'
import { useIntentFulfillment } from './useIntentFulfillment'
import useSessionTrackingState from '@/persisted-state/useSessionTrackingState'

// Static protocol updates (could be fetched from API in production)
const staticUpdates: Omit<ProtocolUpdate, 'read'>[] = [
    {
        id: 'ditto-launch',
        type: 'feature',
        title: 'Meet Ditto!',
        message: 'Your new companion for navigating the Membrane protocol. Click me anytime for quick actions and updates!',
        timestamp: Date.now() - 86400000, // 1 day ago
        priority: 'important',
    },
    {
        id: 'manic-update',
        type: 'announcement',
        title: 'Manic APR Boost',
        message: 'Enhanced yields now available on Manic. Your positions will compound even faster.',
        timestamp: Date.now() - 172800000, // 2 days ago
        priority: 'info',
    },
]

export type UpdateFilter = 'all' | 'unread' | ProtocolUpdate['type']

export const useProtocolUpdates = () => {
    const { updatesState, addUpdate, markAsRead, markAllAsRead, clearOldUpdates, getUnreadCount } = useUpdatesState()
    const { idleGains, closeModal: dismissIdleGains } = useIdleGains()
    const { isEnding: lockdropEnding, hasDeposits: hasLockdropDeposits } = useLockdropEnding()
    const { claimsReady: lockdropClaimsReady, claimableAmount } = useLockdropClaimsReady()
    const { intentFulfilled, updateTrackingState, hasPreviousSession } = useIntentFulfillment()
    const { clearOldData } = useSessionTrackingState()
    
    // Track which notifications we've already sent to avoid duplicates
    const notificationsSentRef = useRef<Set<string>>(new Set())

    // Initialize static updates on mount
    useEffect(() => {
        staticUpdates.forEach(update => {
            addUpdate(update)
        })
    }, [addUpdate])

    // Add idle gains as an update when detected
    useEffect(() => {
        if (idleGains) {
            const updateId = `idle-gains-${Date.now()}`
            if (!notificationsSentRef.current.has(updateId)) {
                const idleGainsUpdate: Omit<ProtocolUpdate, 'read'> = {
                    id: updateId,
                    type: 'idle-gains',
                    title: 'While You Were Away',
                    message: `You earned $${idleGains.revenueAccumulated.toFixed(2)} in revenue and ${idleGains.pointsEarned.toFixed(1)} points.`,
                    timestamp: Date.now(),
                    priority: 'important',
                    data: idleGains,
                }
                addUpdate(idleGainsUpdate)
                notificationsSentRef.current.add(updateId)
            }
        }
    }, [idleGains, addUpdate])

    // Check for lockdrop ending notification
    useEffect(() => {
        console.log('[Notifications] Lockdrop ending check:', { lockdropEnding, hasLockdropDeposits })
        if (lockdropEnding && hasLockdropDeposits) {
            const updateId = 'lockdrop-ending'
            if (!notificationsSentRef.current.has(updateId)) {
                console.log('[Notifications] Adding lockdrop ending notification')
                const lockdropEndingUpdate: Omit<ProtocolUpdate, 'read'> = {
                    id: updateId,
                    type: 'lockdrop-ending',
                    title: 'Lockdrop Period Ended',
                    message: 'The lockdrop withdrawal period has ended. Your deposits are now being processed.',
                    timestamp: Date.now(),
                    priority: 'important',
                }
                addUpdate(lockdropEndingUpdate)
                notificationsSentRef.current.add(updateId)
            }
        }
    }, [lockdropEnding, hasLockdropDeposits, addUpdate])

    // Check for lockdrop claims ready notification
    useEffect(() => {
        console.log('[Notifications] Lockdrop claims ready check:', { lockdropClaimsReady, claimableAmount })
        if (lockdropClaimsReady && claimableAmount > 0) {
            const updateId = 'lockdrop-claims-ready'
            if (!notificationsSentRef.current.has(updateId)) {
                console.log('[Notifications] Adding lockdrop claims ready notification')
                const claimsReadyUpdate: Omit<ProtocolUpdate, 'read'> = {
                    id: updateId,
                    type: 'lockdrop-claims-ready',
                    title: 'Lockdrop Claims Ready',
                    message: `Your lockdrop claims are ready! You can claim ${claimableAmount.toFixed(2)} MBRN.`,
                    timestamp: Date.now(),
                    priority: 'important',
                    data: { claimableAmount },
                }
                addUpdate(claimsReadyUpdate)
                notificationsSentRef.current.add(updateId)
            }
        }
    }, [lockdropClaimsReady, claimableAmount, addUpdate])

    // Check for intent fulfillment notification on session start
    const hasCheckedIntentRef = useRef(false)
    useEffect(() => {
        console.log('[Notifications] Intent fulfillment check:', { intentFulfilled, hasPreviousSession, hasChecked: hasCheckedIntentRef.current })
        // Only check once on mount (session start)
        if (!hasCheckedIntentRef.current && intentFulfilled && hasPreviousSession) {
            hasCheckedIntentRef.current = true
            const updateId = `intent-fulfilled-${Date.now()}`
            if (!notificationsSentRef.current.has('intent-fulfilled-session')) {
                console.log('[Notifications] Adding intent fulfilled notification')
                const intentFulfilledUpdate: Omit<ProtocolUpdate, 'read'> = {
                    id: updateId,
                    type: 'intent-fulfilled',
                    title: 'Intent Fulfilled',
                    message: 'Your intent has been fulfilled. Check your positions to see the changes.',
                    timestamp: Date.now(),
                    priority: 'info',
                }
                addUpdate(intentFulfilledUpdate)
                notificationsSentRef.current.add('intent-fulfilled-session')
            }
        }
    }, [intentFulfilled, hasPreviousSession, addUpdate])

    // Update tracking state on mount and periodically
    const hasUpdatedTrackingRef = useRef(false)
    useEffect(() => {
        // Only update once on mount (after a delay to allow intent check)
        if (!hasUpdatedTrackingRef.current) {
            const timeout = setTimeout(() => {
                updateTrackingState()
                hasUpdatedTrackingRef.current = true
            }, 2000) // Increased delay to ensure intent check completes
            
            return () => clearTimeout(timeout)
        }
    }, []) // Empty deps - only run on mount

    // Update tracking state periodically (every 5 minutes)
    useEffect(() => {
        const interval = setInterval(() => {
            updateTrackingState()
        }, 5 * 60 * 1000)

        return () => {
            clearInterval(interval)
        }
    }, [updateTrackingState])

    // Save final state on unmount
    useEffect(() => {
        return () => {
            updateTrackingState()
        }
    }, [updateTrackingState])

    // Clear old updates periodically
    useEffect(() => {
        clearOldUpdates()
    }, [clearOldUpdates])

    // Clear old tracking data on mount
    useEffect(() => {
        clearOldData()
    }, [clearOldData])

    // Filtered updates
    const getFilteredUpdates = useCallback((filter: UpdateFilter = 'all'): ProtocolUpdate[] => {
        const updates = updatesState.updates

        switch (filter) {
            case 'all':
                return updates
            case 'unread':
                return updates.filter(u => !u.read)
            default:
                return updates.filter(u => u.type === filter)
        }
    }, [updatesState.updates])

    // Group updates by priority
    const groupedUpdates = useMemo(() => {
        const updates = updatesState.updates
        return {
            critical: updates.filter(u => u.priority === 'critical'),
            important: updates.filter(u => u.priority === 'important'),
            info: updates.filter(u => u.priority === 'info' || !u.priority),
        }
    }, [updatesState.updates])

    // Categorized updates
    const categorizedUpdates = useMemo(() => {
        const updates = updatesState.updates
        return {
            idleGains: updates.filter(u => u.type === 'idle-gains'),
            announcements: updates.filter(u => u.type === 'announcement'),
            features: updates.filter(u => u.type === 'feature'),
            maintenance: updates.filter(u => u.type === 'maintenance'),
            rewards: updates.filter(u => u.type === 'reward'),
            lockdropEnding: updates.filter(u => u.type === 'lockdrop-ending'),
            lockdropClaimsReady: updates.filter(u => u.type === 'lockdrop-claims-ready'),
            intentFulfilled: updates.filter(u => u.type === 'intent-fulfilled'),
        }
    }, [updatesState.updates])

    // Get latest update
    const latestUpdate = useMemo(() => {
        return updatesState.updates[0] || null
    }, [updatesState.updates])

    // Check if there are any unread critical updates
    const hasCriticalUnread = useMemo(() => {
        return updatesState.updates.some(u => u.priority === 'critical' && !u.read)
    }, [updatesState.updates])

    return {
        // All updates
        updates: updatesState.updates,
        
        // Counts
        unreadCount: getUnreadCount(),
        totalCount: updatesState.updates.length,
        
        // Filtered/Grouped
        getFilteredUpdates,
        groupedUpdates,
        categorizedUpdates,
        latestUpdate,
        
        // Flags
        hasCriticalUnread,
        hasUnread: getUnreadCount() > 0,
        
        // Actions
        markAsRead,
        markAllAsRead,
        addUpdate,
        
        // Idle gains specific
        idleGains,
        dismissIdleGains,
    }
}

