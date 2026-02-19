import { useMemo } from 'react'
import { useCurrentLockdrop, useUserLockdropDeposits, useLockdropConfig, useTransmuterLockdrop } from '@/hooks/useTransmuterLockdrop'
import useWallet from '@/hooks/useWallet'
import { shiftDigits } from '@/helpers/math'

/**
 * Hook to detect if lockdrop is ending (withdrawal period ended)
 */
export const useLockdropEnding = () => {
    const { data: currentLockdrop } = useCurrentLockdrop()
    const { address } = useWallet()
    const testAddress = address || 'test_user_mock'
    const { data: userDeposits } = useUserLockdropDeposits(testAddress)

    return useMemo(() => {
        if (!currentLockdrop?.lockdrop) return { isEnding: false, withdrawalEnd: null }
        
        const withdrawalEnd = currentLockdrop.lockdrop.withdrawal_end
        const currentTime = Math.floor(Date.now() / 1000)
        const hasDeposits = userDeposits?.deposits && userDeposits.deposits.length > 0
        
        // Lockdrop is ending if withdrawal period has passed and user has deposits
        const isEnding = currentTime > withdrawalEnd && hasDeposits

        return {
            isEnding,
            withdrawalEnd,
            currentTime,
            hasDeposits,
        }
    }, [currentLockdrop, userDeposits])
}

/**
 * Hook to detect if user's lockdrop claims are ready
 */
export const useLockdropClaimsReady = () => {
    const { data: currentLockdrop } = useCurrentLockdrop()
    const { address } = useWallet()
    const testAddress = address || 'test_user_mock'
    const { data: userDeposits } = useUserLockdropDeposits(testAddress)
    const { deposits, totalPoints } = useTransmuterLockdrop()
    const { data: config } = useLockdropConfig()

    return useMemo(() => {
        if (!currentLockdrop?.lockdrop || !userDeposits?.deposits || userDeposits.deposits.length === 0) {
            return { 
                claimsReady: false, 
                claimableAmount: 0,
                withdrawalEnd: null 
            }
        }

        const withdrawalEnd = currentLockdrop.lockdrop.withdrawal_end
        const currentTime = Math.floor(Date.now() / 1000)
        
        // Claims are ready if withdrawal period has ended
        const withdrawalPeriodEnded = currentTime > withdrawalEnd
        
        if (!withdrawalPeriodEnded) {
            return {
                claimsReady: false,
                claimableAmount: 0,
                withdrawalEnd,
            }
        }

        // Calculate user's claimable amount
        // User must have deposits that are not in PENDING_LOCKS (meaning they can claim)
        // If user has deposits in userDeposits, they can claim
        const hasClaimableDeposits = userDeposits.deposits.length > 0

        if (!hasClaimableDeposits || !totalPoints || totalPoints === 0) {
            return {
                claimsReady: false,
                claimableAmount: 0,
                withdrawalEnd,
            }
        }

        // Calculate user's total points
        const userTotalPoints = userDeposits.deposits.reduce((sum: number, deposit: any) => {
            const amount = typeof deposit.amount === 'string' ? parseFloat(deposit.amount) : deposit.amount
            const lockDays = deposit.intended_lock_days || 0
            const points = amount * (1 + lockDays / 365)
            return sum + points
        }, 0)

        // Calculate claimable amount
        const totalIncentive = config?.config?.lockdrop_incentive_size
            ? shiftDigits(
                typeof config.config.lockdrop_incentive_size === 'string'
                    ? config.config.lockdrop_incentive_size
                    : String(config.config.lockdrop_incentive_size),
                -6
            ).toNumber()
            : 0

        const claimableAmount = totalPoints > 0 && totalIncentive > 0
            ? (userTotalPoints / totalPoints) * totalIncentive
            : 0

        return {
            claimsReady: claimableAmount > 0,
            claimableAmount,
            withdrawalEnd,
        }
    }, [currentLockdrop, userDeposits, totalPoints, config])
}
































