import { useEffect, useState, useRef } from 'react'
import usePortState from '@/persisted-state/usePortState'
import { usePortMetrics } from './usePortMetrics'
import { pointsPerMBRN } from '@/config/defaults'

/**
 * Hook to track idle gains and detect when user returns
 */
export const useIdleGains = () => {
    const { portState, setPortState } = usePortState()
    const { data: metrics } = usePortMetrics()
    const [showModal, setShowModal] = useState(false)
    const [idleGains, setIdleGains] = useState<{
        timeElapsed: number
        revenueAccumulated: number
        pointsEarned: number
        mbrnEarned: number
    } | null>(null)
    const hasCheckedRef = useRef(false)

    useEffect(() => {
        // Only check once when component mounts and metrics are available
        if (hasCheckedRef.current || !metrics) return

        const lastSessionTime = portState.lastSessionTime
        const now = Date.now()

        if (lastSessionTime) {
            const timeElapsed = now - lastSessionTime
            const minutesElapsed = timeElapsed / (1000 * 60)

            // Show modal if user was away for more than 5 minutes
            if (minutesElapsed > 5) {
                const previousRevenue = portState.lastSessionRevenue || 0
                const currentRevenue = metrics.totalRevenue || 0
                const revenueAccumulated = Math.max(0, currentRevenue - previousRevenue)

                // Estimate points (placeholder calculation)
                const pointsEarned = revenueAccumulated * 0.1 // 0.1 points per dollar
                // Calculate MBRN earned: points / pointsPerMBRN
                const mbrnEarned = pointsEarned / pointsPerMBRN

                setIdleGains({
                    timeElapsed,
                    revenueAccumulated,
                    pointsEarned,
                    mbrnEarned,
                })
                setShowModal(true)
            }
        }

        // Update last session time
        setPortState({
            lastSessionTime: now,
            lastSessionRevenue: metrics.totalRevenue || 0,
        })

        hasCheckedRef.current = true
    }, [metrics?.totalRevenue]) // Only depend on metrics, not portState

    const closeModal = () => {
        setShowModal(false)
        setIdleGains(null)
    }

    return {
        showModal,
        idleGains,
        closeModal,
    }
}
