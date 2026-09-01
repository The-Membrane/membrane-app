import { useState, useEffect, useRef } from 'react'
import { usePortMetrics } from './usePortMetrics'
import usePortState from '@/persisted-state/usePortState'

/**
 * Hook to calculate and track revenue per second
 * Uses historical data to calculate accurate RPS
 * Also tracks cumulative revenue counter that accumulates over time
 */
// Use mock data if metrics not available (these are per-second rates)
const mockRevenuePerSecondBySource = {
    disco: 0.0000967,    // ~250.75 / (30 * 24 * 60 * 60)
    transmuter: 0.0000484, // ~125.50 / (30 * 24 * 60 * 60)
    manic: 0.0000337,    // ~87.25 / (30 * 24 * 60 * 60)
}

export const useRevenuePerSecond = () => {
    const { data: metrics } = usePortMetrics()
    const { portState, setPortState } = usePortState()
    const [currentRPS, setCurrentRPS] = useState(0)
    const [cumulativeRevenue, setCumulativeRevenue] = useState(0)
    const lastUpdateTimeRef = useRef<number>(Date.now())
    const lastPersistTimeRef = useRef<number>(Date.now())
    const initializedRef = useRef(false)

    // Initialize cumulative revenue from portState or metrics
    useEffect(() => {
        if (!initializedRef.current) {
            const initialCumulative = portState.cumulativeRevenue ||
                (metrics?.totalRevenue || 0)
            setCumulativeRevenue(initialCumulative)
            lastUpdateTimeRef.current = Date.now()
            initializedRef.current = true
        }
    }, [portState.cumulativeRevenue, metrics?.totalRevenue])

    // Calculate RPS from historical data
    useEffect(() => {
        if (!metrics) {
            // Use mock RPS if no metrics
            setCurrentRPS(0.000462)
            return
        }

        const revenueHistory = portState.revenueHistory || []
        const now = Date.now()

        // Get revenue from last 60 seconds
        const recentHistory = revenueHistory.filter(
            (entry) => now - entry.timestamp < 60000
        )

        if (recentHistory.length >= 2) {
            const oldest = recentHistory[0]
            const newest = recentHistory[recentHistory.length - 1]
            const timeDiff = (newest.timestamp - oldest.timestamp) / 1000 // seconds
            const revenueDiff = newest.totalRevenue - oldest.totalRevenue

            if (timeDiff > 0) {
                const calculatedRPS = revenueDiff / timeDiff
                setCurrentRPS(Math.max(0, calculatedRPS))
            }
        } else if (metrics.totalRevenue > 0) {
            // Fallback: estimate RPS from total revenue
            // This is a placeholder - in production, use actual historical data
            const estimatedRPS = metrics.totalRevenue / (30 * 24 * 60 * 60) // Assume 30 days
            setCurrentRPS(estimatedRPS)
        }

        // Update revenue history only if metrics changed
        const lastEntry = revenueHistory[revenueHistory.length - 1]
        const shouldUpdate = !lastEntry ||
            lastEntry.totalRevenue !== metrics.totalRevenue ||
            now - lastEntry.timestamp > 1000 // Update at most once per second

        if (shouldUpdate) {
            const newEntry = {
                timestamp: now,
                totalRevenue: metrics.totalRevenue,
            }

            const updatedHistory = [...revenueHistory, newEntry]
                .filter((entry) => now - entry.timestamp < 24 * 60 * 60 * 1000) // Keep last 24 hours
                .slice(-100) // Keep max 100 entries

            setPortState({ revenueHistory: updatedHistory })
        }
        // Intentionally minimal deps: portState.revenueHistory is WRITTEN by this effect
        // (setPortState above), so adding it as a dep is self-referential and would only be
        // held back from looping by the timing-based shouldUpdate guard. Keep the metrics-driven
        // trigger to avoid that fragile re-run cycle.
    }, [metrics?.totalRevenue, setPortState])

    // Smooth animation update for RPS
    useEffect(() => {
        const interval = setInterval(() => {
            // Smooth transition towards target RPS
            setCurrentRPS((prev) => {
                const target = metrics?.revenuePerSecond || 0
                const diff = target - prev
                return prev + diff * 0.1 // Smooth interpolation
            })
        }, 100) // Update every 100ms for smooth animation

        return () => clearInterval(interval)
    }, [metrics?.revenuePerSecond])

    // Cumulative revenue counter - updates at 2fps instead of 60fps
    useEffect(() => {
        let lastUpdateTime = Date.now()

        const interval = setInterval(() => {
            const now = Date.now()
            const elapsedSeconds = (now - lastUpdateTime) / 1000
            lastUpdateTime = now

            const rps = currentRPS || (metrics?.revenuePerSecond || 0)
            const increment = rps * elapsedSeconds

            if (increment > 0) {
                setCumulativeRevenue((prev) => prev + increment)
            }
        }, 500) // Update every 500ms (2fps) instead of 60fps

        return () => clearInterval(interval)
    }, [currentRPS, metrics?.revenuePerSecond, setPortState])

    // Persist cumulative revenue to portState, throttled to at most once per 5s.
    // Kept out of the setCumulativeRevenue updater so the updater stays pure.
    useEffect(() => {
        const now = Date.now()
        if (now - lastPersistTimeRef.current >= 5000) {
            setPortState({ cumulativeRevenue })
            lastPersistTimeRef.current = now
        }
    }, [cumulativeRevenue, setPortState])

    return {
        revenuePerSecond: currentRPS || (metrics?.revenuePerSecond || 0.000179),
        cumulativeRevenue: cumulativeRevenue || portState.cumulativeRevenue || 0,
        revenueBySource: metrics?.revenueBySource || { disco: 0, transmuter: 0, manic: 0 },
        revenuePerSecondBySource: metrics?.revenuePerSecondBySource || mockRevenuePerSecondBySource,
        isLoading: false, // Never show loading state
    }
}
