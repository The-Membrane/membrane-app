import React, { useMemo } from 'react'
import { Box, VStack, HStack, Text, Divider, Image } from '@chakra-ui/react'
import { useRouter } from 'next/router'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
import { TxButton } from '@/components/TxButton'
import { shiftDigits } from '@/helpers/math'
import { useAcquisition, useUserAcquisitionDeposits, useAcquisitionConfig } from '@/hooks/useAcquisition'
import { useLockdropClaimsReady } from '@/components/DittoSpeechBox/hooks/useAcquisitionNotifications'
import { useChainRoute } from '@/hooks/useChainRoute'
import useWallet from '@/hooks/useWallet'
import { AcquisitionClaimCard } from '@/components/acquisition/AcquisitionClaimCard'

export const AcquisitionInfo: React.FC = () => {
    const router = useRouter()
    const { chainName } = useChainRoute()
    const { address } = useWallet()
    // Use test address for mock data when wallet is not connected
    const testAddress = address || 'test_user_mock'
    const { deposits, totalPoints, allocations } = useAcquisition()
    const { data: userDeposits, isLoading: isLoadingDeposits } = useUserAcquisitionDeposits(testAddress)
    const { data: config } = useAcquisitionConfig()
    const { claimsReady, claimableAmount } = useLockdropClaimsReady()

    // Get total lockdrop incentive size
    const totalIncentive = useMemo(() => {
        if (!config?.config?.lockdrop_incentive_size) return 0
        const incentiveSize = typeof config.config.lockdrop_incentive_size === 'string'
            ? config.config.lockdrop_incentive_size
            : String(config.config.lockdrop_incentive_size)
        return shiftDigits(incentiveSize, -6).toNumber()
    }, [config])

    // Calculate user's total deposit amount
    const userTotalDeposit = useMemo(() => {
        if (!userDeposits?.deposits || userDeposits.deposits.length === 0) return 0
        return userDeposits.deposits.reduce((sum: number, deposit: any) => {
            const amount = typeof deposit.amount === 'string' ? parseFloat(deposit.amount) : deposit.amount
            return sum + shiftDigits(String(amount), -6).toNumber()
        }, 0)
    }, [userDeposits])

    // Calculate user's total points
    const userTotalPoints = useMemo(() => {
        if (!userDeposits?.deposits || userDeposits.deposits.length === 0) return 0
        return userDeposits.deposits.reduce((sum: number, deposit: any) => {
            const amount = typeof deposit.amount === 'string' ? parseFloat(deposit.amount) : deposit.amount
            const lockDays = deposit.intended_lock_days || 0
            const points = amount * (1 + lockDays / 365)
            return sum + points
        }, 0)
    }, [userDeposits])

    // Calculate user's share percentage
    const userSharePercentage = useMemo(() => {
        if (!totalPoints || totalPoints === 0 || userTotalPoints === 0) return 0
        return (userTotalPoints / totalPoints) * 100
    }, [userTotalPoints, totalPoints])

    // Calculate user's expected claim amount
    const userClaimAmount = useMemo(() => {
        if (!totalPoints || totalPoints === 0 || userTotalPoints === 0 || !totalIncentive) return 0
        return (userTotalPoints / totalPoints) * totalIncentive
    }, [userTotalPoints, totalPoints, totalIncentive])

    const hasDeposits = userDeposits?.deposits && userDeposits.deposits.length > 0

    return (
        <Card
            bg={SEMANTIC_COLORS.bgSecondary}
            borderRadius={0}
            borderColor={SEMANTIC_COLORS.borderMedium}
            p={SPACING.lg}
        >
            <VStack spacing={SPACING.base} align="stretch">
                {/* Header */}
                <HStack justify="space-between">
                    <HStack spacing={SPACING.sm}>
                        <Image src="/images/mbrn.svg" alt="MBRN" w="24px" h="24px" />
                        <Text
                            fontSize="lg"
                            fontWeight={TYPOGRAPHY.bold}
                            color={SEMANTIC_COLORS.primary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            textTransform="uppercase"
                        >
                            Acquisition
                        </Text>
                    </HStack>
                </HStack>

                <Divider borderColor={SEMANTIC_COLORS.borderMedium} />

                {hasDeposits ? (
                    <>
                        {/* User Stats */}
                        <VStack spacing={SPACING.md} align="stretch">
                            <HStack justify="space-between" align="flex-start">
                                <VStack spacing={0} align="flex-start">
                                    <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                                        Total Deposited
                                    </Text>
                                    <Text fontSize="xs" color={SEMANTIC_COLORS.textTertiary} fontFamily={TYPOGRAPHY.fontMono}>
                                        {userDeposits.deposits.length} deposit{userDeposits.deposits.length !== 1 ? 's' : ''}
                                    </Text>
                                </VStack>
                                <HStack spacing={SPACING.xs}>
                                    <Image src="/images/usdc.png" alt="USDC" w="14px" h="14px" />
                                    <Text fontSize="md" color={SEMANTIC_COLORS.info} fontFamily={TYPOGRAPHY.fontMono} fontWeight={TYPOGRAPHY.bold} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                        {userTotalDeposit.toFixed(2)}
                                    </Text>
                                </HStack>
                            </HStack>

                            <HStack justify="space-between">
                                <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                                    Your Share
                                </Text>
                                <Text fontSize="md" color={SEMANTIC_COLORS.info} fontFamily={TYPOGRAPHY.fontMono} fontWeight={TYPOGRAPHY.bold} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                    {userSharePercentage.toFixed(4)}%
                                </Text>
                            </HStack>

                            {/* <HStack justify="space-between">
                                <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                                    Total Points
                                </Text>
                                <Text fontSize="md" color={SEMANTIC_COLORS.primary} fontFamily={TYPOGRAPHY.fontMono} fontWeight={TYPOGRAPHY.bold} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                    {shiftDigits(String(userTotalPoints), -6).toNumber().toFixed(2)}
                                </Text>
                            </HStack> */}
                        </VStack>

                        <Divider borderColor={SEMANTIC_COLORS.borderMedium} />

                        {/* Expected Claim */}
                        <Box
                            bg={SEMANTIC_COLORS.bgTertiary}
                            borderRadius={0}
                            p={SPACING.base}
                            border="1px solid"
                            borderColor={SEMANTIC_COLORS.success}
                        >
                            <VStack spacing={SPACING.sm}>
                                <Text fontSize="sm" color={SEMANTIC_COLORS.success} fontFamily={TYPOGRAPHY.fontMono}>
                                    Expected Claim
                                </Text>
                                <HStack spacing={SPACING.sm}>
                                    <Image src="/images/mbrn.svg" alt="MBRN" w="20px" h="20px" />
                                    <Text fontSize="2xl" fontWeight={TYPOGRAPHY.bold} color={SEMANTIC_COLORS.success} fontFamily={TYPOGRAPHY.fontMono} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                        {userClaimAmount.toFixed(2)}
                                    </Text>
                                </HStack>
                            </VStack>
                        </Box>

                        {/* Claim Card */}
                        {claimsReady && claimableAmount > 0 ? (
                            <AcquisitionClaimCard
                                claimableAmount={claimableAmount}
                                onClaimSuccess={() => {
                                    // Refresh data after claim
                                }}
                            />
                        ) : (
                            <TxButton
                                size="md"
                                w="full"
                                isDisabled={true}
                                colorScheme="phosphor"
                                borderRadius={0}
                                _focus={FOCUS_STYLES.ring}
                            >
                                {claimableAmount <= 0
                                    ? 'No Claims Available'
                                    : 'Claims Available After Withdrawal Period'}
                            </TxButton>
                        )}
                    </>
                ) : (
                    <>
                        {/* No Deposits State */}
                        <VStack spacing={SPACING.md} py={SPACING.base}>
                            <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono} textAlign="center">
                                You have no deposits in the Acquisition
                            </Text>
                            <Text fontSize="xs" color={SEMANTIC_COLORS.textTertiary} fontFamily={TYPOGRAPHY.fontMono} textAlign="center" lineHeight="1.6">
                                Participate to earn MBRN rewards based on your deposit amount and lock duration
                            </Text>
                            <Box w="full" mt={SPACING.sm}>
                                <TxButton
                                    size="md"
                                    w="full"
                                    colorScheme="phosphor"
                                    borderRadius={0}
                                    _focus={FOCUS_STYLES.ring}
                                    onClick={() => {
                                        router.push(`/${chainName}/transmuter`)
                                    }}
                                >
                                    Go to Transmuter
                                </TxButton>
                            </Box>
                        </VStack>
                    </>
                )}
            </VStack>
        </Card>
    )
}
