import React, { useMemo } from 'react'
import { VStack, Text, Box, HStack, Divider } from '@chakra-ui/react'
import { SectionComponentProps } from '../types'
import { useAcquisition, useUserAcquisitionDeposits, useCurrentAcquisition, useUserAcquisitionHistory, useAcquisitionConfig } from '@/hooks/useAcquisition'
import { useLockdropClaimsReady } from '../hooks/useAcquisitionNotifications'
import useWallet from '@/hooks/useWallet'
import { shiftDigits } from '@/helpers/math'
import { ProfitChart } from './ProfitChart'
import { AcquisitionClaimCard } from '@/components/acquisition/AcquisitionClaimCard'

import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'

interface ChartDataPoint {
    timestamp: number
    profit: number
    collateralValue?: number
    debt?: number
    amountLooped?: number
    apr?: number
}

export const AcquisitionSection: React.FC<SectionComponentProps & { tabIndex?: number; hideCharts?: boolean }> = ({ onBack, tabIndex = 0, hideCharts = false }) => {
    // Note: tabIndex is kept for compatibility but we now show all content merged
    const { address } = useWallet()
    const { deposits, totalPoints, allocations } = useAcquisition()
    const { data: userDeposits } = useUserAcquisitionDeposits(address)
    const { data: currentLockdrop } = useCurrentAcquisition()
    const { data: userHistory } = useUserAcquisitionHistory(address)
    const { data: config } = useAcquisitionConfig()
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
        // `userDeposits` is the raw acquisition-contract query response, which is untyped;
        // rows carry `amount` (Uint128 string) and `intended_lock_days`.
        const userPoints = userDeposits.deposits.reduce((sum: number, deposit: any) => {
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
        }).sort((a: ChartDataPoint, b: ChartDataPoint) => a.timestamp - b.timestamp)
    }, [userHistory])

    // Data Tab (index 0)
    if (tabIndex === 0) {
        return (
            <VStack spacing={3} align="stretch" w="100%">
                <Box>
                    <HStack spacing={4} align="flex-start" wrap="wrap" justifyContent={"center"}>
                        <VStack>
                            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} mb={1}>
                                Pending Locked TVL
                            </Text>
                            <Text fontSize="sm" fontWeight="bold" color={SEMANTIC_COLORS.textPrimary} mb={3}>
                                {pendingLockedTVL > 0 ? `${pendingLockedTVL.toFixed(2)} USDC` : '—'}
                            </Text>
                        </VStack>

                        <VStack>
                            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} mb={1}>
                                Pending Claim Amount
                            </Text>
                            <Text fontSize="sm" fontWeight="bold" color={SEMANTIC_COLORS.success} mb={3}>
                                {pendingClaimAmount > 0 ? `${pendingClaimAmount.toFixed(2)} MBRN` : '—'}
                            </Text>
                        </VStack>

                        <VStack>
                            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} mb={1}>
                                Your Pending Share
                            </Text>
                            <Text fontSize="sm" fontWeight="bold" color={SEMANTIC_COLORS.info}>
                                {userPendingShare > 0 ? `${(userPendingShare * 100).toFixed(2)}%` : '—'}
                            </Text>
                        </VStack>
                    </HStack>
                </Box>

                {userDeposits?.deposits && userDeposits.deposits.length > 0 && (
                    <>
                        <Divider mb={4} />
                        <Box>
                            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} mb={2}>
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
                                            key={deposit.deposit_time}
                                            bg={SEMANTIC_COLORS.bgSecondary}
                                            border="1px solid"
                                            borderColor={SEMANTIC_COLORS.borderSubtle}
                                            borderRadius={0}
                                            p={SPACING.md}
                                        >
                                            <VStack spacing={1} align="stretch">
                                                <HStack justify="space-between">
                                                    <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                                                        Amount
                                                    </Text>
                                                    <Text fontSize="xs" color={SEMANTIC_COLORS.textPrimary}>
                                                        {amountValue.toFixed(2)} USDC
                                                    </Text>
                                                </HStack>
                                                <HStack justify="space-between">
                                                    <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                                                        Lock Days
                                                    </Text>
                                                    <Text fontSize="xs" color={SEMANTIC_COLORS.textPrimary}>
                                                        {lockDays}
                                                    </Text>
                                                </HStack>
                                                {allocation && (
                                                    <HStack justify="space-between">
                                                        <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                                                            Claim Amount
                                                        </Text>
                                                        <Text fontSize="xs" color={SEMANTIC_COLORS.success} fontWeight="bold">
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
                            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} mb={2}>
                                All-Time MBRN Claims
                            </Text>
                            <ProfitChart data={chartData} isLoading={false} />
                        </Box>
                    </>
                )}

                {userDeposits?.deposits && userDeposits.deposits.length === 0 && (
                    <Box>
                        <Text fontSize="xs" color={SEMANTIC_COLORS.textTertiary} textAlign="center">
                            No locked deposits found
                        </Text>
                    </Box>
                )}

                {/* Claim Card Section - Merged from Actions tab */}
                <Divider mt={4} mb={4} />
                <AcquisitionClaimCard
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
                <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} mb={2}>
                    No metrics available
                </Text>
            </Box>
        )
    }

    // Default view (shouldn't reach here with merged content)
    return null
}


