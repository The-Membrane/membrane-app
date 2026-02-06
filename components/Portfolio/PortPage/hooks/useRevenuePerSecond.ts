import { useState, useEffect, useRef } from 'react'
import { usePortMetrics } from './usePortMetrics'
import usePortState from '@/persisted-state/usePortState'

/**
 * Hook to calculate and track revenue per second
 * Uses historical data to calculate accurate RPS
 * Also tracks cumulative revenue counter that accumulates over time
 */
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

    // Cumulative revenue counter - increments based on RPS
    // Use requestAnimationFrame for smoother updates that sync with browser repaints
    useEffect(() => {
        let animationFrameId: number
        let lastFrameTime = Date.now()

        const updateCounter = () => {
            const now = Date.now()
            const elapsedSeconds = (now - lastFrameTime) / 1000
            lastFrameTime = now

            // Calculate increment based on current RPS
            const rps = currentRPS || (metrics?.revenuePerSecond || 0)
            const increment = rps * elapsedSeconds

            if (increment > 0) {
                setCumulativeRevenue((prev) => {
                    const newValue = prev + increment
                    // Persist to portState periodically (every 5 seconds)
                    if (now - lastPersistTimeRef.current >= 5000) {
                        setPortState({ cumulativeRevenue: newValue })
                        lastPersistTimeRef.current = now
                    }
                    return newValue
                })
            }

            animationFrameId = requestAnimationFrame(updateCounter)
        }

        // Initialize lastFrameTime
        lastFrameTime = Date.now()
        animationFrameId = requestAnimationFrame(updateCounter)

        return () => {
            if (animationFrameId) {
                cancelAnimationFrame(animationFrameId)
            }
        }
    }, [currentRPS, metrics?.revenuePerSecond, setPortState])

    // Use mock data if metrics not available (these are per-second rates)
    const mockRevenuePerSecondBySource = {
        disco: 0.0000967,    // ~250.75 / (30 * 24 * 60 * 60)
        transmuter: 0.0000484, // ~125.50 / (30 * 24 * 60 * 60)
        manic: 0.0000337,    // ~87.25 / (30 * 24 * 60 * 60)
    }

    return {
        revenuePerSecond: currentRPS || (metrics?.revenuePerSecond || 0.000179),
        cumulativeRevenue: cumulativeRevenue || portState.cumulativeRevenue || 0,
        revenueBySource: metrics?.revenueBySource || { disco: 0, transmuter: 0, manic: 0 },
        revenuePerSecondBySource: metrics?.revenuePerSecondBySource || mockRevenuePerSecondBySource,
        isLoading: false, // Never show loading state
    }
}
