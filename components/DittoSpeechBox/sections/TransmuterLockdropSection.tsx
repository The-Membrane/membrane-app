import React, { useMemo } from 'react'
import { VStack, Text, Box, HStack, Divider, Button } from '@chakra-ui/react'
import { SectionComponentProps } from '../types'
import { useTransmuterLockdrop, useUserLockdropDeposits, useCurrentLockdrop, useUserLockdropHistory, useLockdropConfig } from '@/hooks/useTransmuterLockdrop'
import { useLockdropClaimsReady } from '../hooks/useLockdropNotifications'
import useWallet from '@/hooks/useWallet'
import { shiftDigits } from '@/helpers/math'
import { ProfitChart } from './ProfitChart'
import { LockdropClaimCard } from '@/components/trans-lockdrop/LockdropClaimCard'

interface ChartDataPoint {
    timestamp: number
    profit: number
    collateralValue?: number
    debt?: number
    amountLooped?: number
    apr?: number
}

export const TransmuterLockdropSection: React.FC<SectionComponentProps & { tabIndex?: number; hideCharts?: boolean }> = ({ onBack, tabIndex = 0, hideCharts = false }) => {
    // Note: tabIndex is kept for compatibility but we now show all content merged
    const { address } = useWallet()
    const { deposits, totalPoints, allocations } = useTransmuterLockdrop()
    const { data: userDeposits } = useUserLockdropDeposits(address)
    const { data: currentLockdrop } = useCurrentLockdrop()
    const { data: userHistory } = useUserLockdropHistory(address)
    const { data: config } = useLockdropConfig()
    const { claimsReady, claimableAmount } = useLockdropClaimsReady()

    // Calculate pending locked TVL (sum of all deposits)
    const pendingLockedTVL = useMemo(() => {
        if (!deposits || deposits.length === 0) return 0
        return deposits.reduce((sum, deposit) => {
            const amount = typeof deposit.amount === 'string' ? parseFloat(deposit.amount) : deposit.amount
            return sum + shiftDigits(String(amount), -6).toNumber()
        }, 0)
    }, [deposits])

    // Get pending claim amount from lockdrop config
    const pendingClaimAmount = useMemo(() => {
        if (!config?.config?.lockdrop_incentive_size) return 0
        const incentiveSize = typeof config.config.lockdrop_incentive_size === 'string'
            ? config.config.lockdrop_incentive_size
            : String(config.config.lockdrop_incentive_size)
        return shiftDigits(incentiveSize, -6).toNumber()
    }, [config])

    // Calculate user's pending share of claims
    const userPendingShare = useMemo(() => {
        if (!userDeposits?.deposits || userDeposits.deposits.length === 0 || !totalPoints || totalPoints === 0) return 0

        // Calculate user's total points
        const userPoints = userDeposits.deposits.reduce((sum, deposit) => {
            const amount = typeof deposit.amount === 'string' ? parseFloat(deposit.amount) : deposit.amount
            const lockDays = deposit.intended_lock_days || 0
            const points = amount * (1 + lockDays / 365) // Simplified points calculation
            return sum + points
        }, 0)

        // User's share = userPoints / totalPoints
        return totalPoints > 0 ? userPoints / totalPoints : 0
    }, [userDeposits, totalPoints])

    // Transform user history to chart data
    const chartData = useMemo((): ChartDataPoint[] => {
        if (!userHistory?.history || userHistory.history.length === 0) return []

        return userHistory.history.map((entry: any) => {
            const runningTotalClaims = typeof entry.running_total_claims === 'string'
                ? parseFloat(entry.running_total_claims)
                : entry.running_total_claims || 0

            return {
                timestamp: entry.time || 0,
                profit: shiftDigits(String(runningTotalClaims), -6).toNumber(), // Use running_total_claims as MBRN claims
            }
        }).sort((a, b) => a.timestamp - b.timestamp)
    }, [userHistory])

    // Data Tab (index 0)
    if (tabIndex === 0) {
        return (
            <VStack spacing={3} align="stretch" w="100%">
                <Box>
                    <HStack spacing={4} align="flex-start" wrap="wrap" justifyContent={"center"}>
                        <VStack>
                            <Text fontSize="xs" color="#F5F5F580" mb={1}>
                                Pending Locked TVL
                            </Text>
                            <Text fontSize="sm" fontWeight="bold" color="#F5F5F5" mb={3}>
                                {pendingLockedTVL > 0 ? `${pendingLockedTVL.toFixed(2)} USDC` : '—'}
                            </Text>
                        </VStack>

                        <VStack>
                            <Text fontSize="xs" color="#F5F5F580" mb={1}>
                                Pending Claim Amount
                            </Text>
                            <Text fontSize="sm" fontWeight="bold" color="green.400" mb={3}>
                                {pendingClaimAmount > 0 ? `${pendingClaimAmount.toFixed(2)} MBRN` : '—'}
                            </Text>
                        </VStack>

                        <VStack>
                            <Text fontSize="xs" color="#F5F5F580" mb={1}>
                                Your Pending Share
                            </Text>
                            <Text fontSize="sm" fontWeight="bold" color="cyan.400">
                                {userPendingShare > 0 ? `${(userPendingShare * 100).toFixed(2)}%` : '—'}
                            </Text>
                        </VStack>
                    </HStack>
                </Box>

                {userDeposits?.deposits && userDeposits.deposits.length > 0 && (
                    <>
                        <Divider mb={4} />
                        <Box>
                            <Text fontSize="xs" color="#F5F5F580" mb={2}>
                                Locked Deposits ({userDeposits.deposits.length})
                            </Text>

                            <VStack spacing={2} align="stretch" maxH="200px" overflowY="auto">
                                {userDeposits.deposits.map((deposit: any, index: number) => {
                                    const amount = typeof deposit.amount === 'string'
                                        ? parseFloat(deposit.amount)
                                        : deposit.amount || 0
                                    const amountValue = shiftDigits(String(amount), -6).toNumber()
                                    const lockDays = deposit.intended_lock_days || 0

                                    // Find allocation for this deposit
                                    const allocation = allocations.find((a: any) =>
                                        a.amount === String(amount) && a.lockDays === lockDays
                                    )
                                    const claimAmount = allocation && pendingClaimAmount > 0
                                        ? allocation.allocation * pendingClaimAmount
                                        : 0

                                    return (
                                        <Box
                                            key={index}
                                            bg="gray.800"
                                            border="1px solid"
                                            borderColor="purple.500"
                                            borderRadius="md"
                                            p={3}
                                        >
                                            <VStack spacing={1} align="stretch">
                                                <HStack justify="space-between">
                                                    <Text fontSize="xs" color="#F5F5F580">
                                                        Amount
                                                    </Text>
                                                    <Text fontSize="xs" color="#F5F5F5">
                                                        {amountValue.toFixed(2)} USDC
                                                    </Text>
                                                </HStack>
                                                <HStack justify="space-between">
                                                    <Text fontSize="xs" color="#F5F5F580">
                                                        Lock Days
                                                    </Text>
                                                    <Text fontSize="xs" color="#F5F5F5">
                                                        {lockDays}
                                                    </Text>
                                                </HStack>
                                                {allocation && (
                                                    <HStack justify="space-between">
                                                        <Text fontSize="xs" color="#F5F5F580">
                                                            Claim Amount
                                                        </Text>
                                                        <Text fontSize="xs" color="green.400" fontWeight="bold">
                                                            {claimAmount > 0 ? `${claimAmount.toFixed(2)} MBRN` : '—'}
                                                        </Text>
                                                    </HStack>
                                                )}
                                            </VStack>
                                        </Box>
                                    )
                                })}
                            </VStack>
                        </Box>
                    </>
                )}

                {!hideCharts && chartData.length > 0 && (
                    <>
                        <Divider mb={4} mt={4} />
                        <Box>
                            <Text fontSize="xs" color="#F5F5F580" mb={2}>
                                All-Time MBRN Claims
                            </Text>
                            <ProfitChart data={chartData} isLoading={false} />
                        </Box>
                    </>
                )}

                {userDeposits?.deposits && userDeposits.deposits.length === 0 && (
                    <Box>
                        <Text fontSize="xs" color="#F5F5F540" textAlign="center">
                            No locked deposits found
                        </Text>
                    </Box>
                )}

                {/* Claim Card Section - Merged from Actions tab */}
                <Divider mt={4} mb={4} />
                <LockdropClaimCard
                    claimableAmount={claimableAmount}
                    onClaimSuccess={() => {
                        // Refresh data after claim
                    }}
                />
            </VStack>
        )
    }

    // Metrics Tab (index 1) - kept for compatibility but not used
    if (tabIndex === 1) {
        return (
            <Box>
                <Text fontSize="xs" color="#F5F5F580" mb={2}>
                    No metrics available
                </Text>
            </Box>
        )
    }

    // Default view (shouldn't reach here with merged content)
    return null
}

