import { useMemo, useCallback, useRef } from 'react'
import { useDiscoAssets, useDiscoUserMetrics } from '@/hooks/useDiscoData'
import { useTransmuterLockdrop, useUserLockdropDeposits, useLockdropConfig } from '@/hooks/useTransmuterLockdrop'
import useWallet from '@/hooks/useWallet'
import { shiftDigits } from '@/helpers/math'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import { useQueries } from '@tanstack/react-query'
import { getLTVQueue } from '@/services/disco'
import useSessionTrackingState from '@/persisted-state/useSessionTrackingState'

/**
 * Hook to track TVL and claims, and detect intent fulfillment
 */
export const useIntentFulfillment = () => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)
    const { address } = useWallet()
    const testAddress = address || 'test_user_mock'
    const { data: assets } = useDiscoAssets()
    const { trackingState, setTrackingState } = useSessionTrackingState()
    
    // Get Disco user metrics for claims
    const { pendingClaims } = useDiscoUserMetrics(testAddress)
    
    // Get lockdrop data
    const { deposits: lockdropDeposits } = useTransmuterLockdrop()
    const { data: userLockdropDeposits } = useUserLockdropDeposits(testAddress)
    const { data: lockdropConfig } = useLockdropConfig()
    const { totalPoints } = useTransmuterLockdrop()

    // Query LTV queues for all assets to calculate Disco TVL
    const assetsToQuery = assets?.assets && assets.assets.length > 0
        ? assets.assets
        : ['ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4'] // Default USDC denom

    const ltvQueueQueries = useQueries({
        queries: assetsToQuery.map((asset: string) => ({
            queryKey: ['disco', 'ltv_queue', asset, appState.rpcUrl],
            queryFn: () => getLTVQueue(client || null, asset),
            enabled: !!asset,
            staleTime: 1000 * 60 * 5,
        }))
    })

    // Calculate current Disco TVL
    const currentDiscoTVL = useMemo(() => {
        let totalDeposits = 0
        
        ltvQueueQueries.forEach((query: any) => {
            const queue = query.data?.queue
            if (queue?.slots) {
                queue.slots.forEach((slot: any) => {
                    const depositTokens = slot.total_deposit_tokens
                    const depositTokensStr = typeof depositTokens === 'string'
                        ? depositTokens
                        : depositTokens?.toString() || '0'
                    const weight = parseFloat(depositTokensStr) || 0
                    totalDeposits += weight
                })
            }
        })
        
        // Convert from base units to MBRN (shift by -6)
        return shiftDigits(totalDeposits.toString(), -6).toNumber()
    }, [ltvQueueQueries])

    // Calculate current Lockdrop TVL
    const currentLockdropTVL = useMemo(() => {
        if (!lockdropDeposits || lockdropDeposits.length === 0) return 0
        return lockdropDeposits.reduce((sum: number, deposit: any) => {
            const amount = typeof deposit.amount === 'string' ? parseFloat(deposit.amount) : deposit.amount
            return sum + shiftDigits(String(amount), -6).toNumber()
        }, 0)
    }, [lockdropDeposits])

    // Calculate user's Disco claims (sum of pending claims)
    const currentDiscoClaims = useMemo(() => {
        if (!pendingClaims || pendingClaims.length === 0) return 0
        return pendingClaims.reduce((sum: number, claim: any) => {
            const amount = claim.pending_amount || "0"
            return sum + shiftDigits(amount, -6).toNumber()
        }, 0)
    }, [pendingClaims])

    // Calculate user's Lockdrop claims
    const currentLockdropClaims = useMemo(() => {
        if (!userLockdropDeposits?.deposits || userLockdropDeposits.deposits.length === 0) return 0
        if (!totalPoints || totalPoints === 0) return 0
        
        const totalIncentive = lockdropConfig?.config?.lockdrop_incentive_size
            ? shiftDigits(
                typeof lockdropConfig.config.lockdrop_incentive_size === 'string'
                    ? lockdropConfig.config.lockdrop_incentive_size
                    : String(lockdropConfig.config.lockdrop_incentive_size),
                -6
            ).toNumber()
            : 0

        if (totalIncentive === 0) return 0

        // Calculate user's total points
        const userTotalPoints = userLockdropDeposits.deposits.reduce((sum: number, deposit: any) => {
            const amount = typeof deposit.amount === 'string' ? parseFloat(deposit.amount) : deposit.amount
            const lockDays = deposit.intended_lock_days || 0
            const points = amount * (1 + lockDays / 365)
            return sum + points
        }, 0)

        return totalPoints > 0 ? (userTotalPoints / totalPoints) * totalIncentive : 0
    }, [userLockdropDeposits, totalPoints, lockdropConfig])

    // Calculate total TVL and total claims
    const currentTotalTVL = useMemo(() => {
        return currentDiscoTVL + currentLockdropTVL
    }, [currentDiscoTVL, currentLockdropTVL])

    const currentTotalClaims = useMemo(() => {
        return currentDiscoClaims + currentLockdropClaims
    }, [currentDiscoClaims, currentLockdropClaims])

    // Detect intent fulfillment: TVL increased AND claims decreased
    const intentFulfilled = useMemo(() => {
        const previousTVL = trackingState.discoTVL + trackingState.lockdropTVL
        const previousClaims = trackingState.userDiscoClaims + trackingState.userLockdropClaims

        // Only check if we have previous session data
        if (!trackingState.lastSessionTime) return false

        const tvlIncreased = currentTotalTVL > previousTVL
        const claimsDecreased = currentTotalClaims < previousClaims

        return tvlIncreased && claimsDecreased
    }, [
        currentTotalTVL,
        currentTotalClaims,
        trackingState.discoTVL,
        trackingState.lockdropTVL,
        trackingState.userDiscoClaims,
        trackingState.userLockdropClaims,
        trackingState.lastSessionTime,
    ])

    // Track last update time to prevent too frequent updates
    const lastUpdateTimeRef = useRef<number>(0)
    const MIN_UPDATE_INTERVAL = 1000 // Minimum 1 second between updates

    // Update tracking state with current values
    const updateTrackingState = useCallback(() => {
        const now = Date.now()
        // Throttle updates to prevent infinite loops
        if (now - lastUpdateTimeRef.current < MIN_UPDATE_INTERVAL) {
            return
        }
        lastUpdateTimeRef.current = now

        setTrackingState({
            discoTVL: currentDiscoTVL,
            lockdropTVL: currentLockdropTVL,
            userDiscoClaims: currentDiscoClaims,
            userLockdropClaims: currentLockdropClaims,
            lastSessionTime: now,
        })
    }, [currentDiscoTVL, currentLockdropTVL, currentDiscoClaims, currentLockdropClaims, setTrackingState])

    return {
        // Current values
        currentDiscoTVL,
        currentLockdropTVL,
        currentTotalTVL,
        currentDiscoClaims,
        currentLockdropClaims,
        currentTotalClaims,
        
        // Previous values
        previousDiscoTVL: trackingState.discoTVL,
        previousLockdropTVL: trackingState.lockdropTVL,
        previousTotalTVL: trackingState.discoTVL + trackingState.lockdropTVL,
        previousDiscoClaims: trackingState.userDiscoClaims,
        previousLockdropClaims: trackingState.userLockdropClaims,
        previousTotalClaims: trackingState.userDiscoClaims + trackingState.userLockdropClaims,
        
        // Detection
        intentFulfilled,
        
        // Actions
        updateTrackingState,
        
        // State
        hasPreviousSession: !!trackingState.lastSessionTime,
    }
}

