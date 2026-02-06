import React, { useMemo } from 'react'
import { Box, VStack, HStack, Text, Divider, Image } from '@chakra-ui/react'
import { useRouter } from 'next/router'
import { TxButton } from '@/components/TxButton'
import { shiftDigits } from '@/helpers/math'
import { useTransmuterLockdrop, useUserLockdropDeposits, useLockdropConfig } from '@/hooks/useTransmuterLockdrop'
import { useLockdropClaimsReady } from '@/components/DittoSpeechBox/hooks/useLockdropNotifications'
import { useChainRoute } from '@/hooks/useChainRoute'
import useWallet from '@/hooks/useWallet'
import { LockdropClaimCard } from '@/components/trans-lockdrop/LockdropClaimCard'

export const TransmuterLockdropInfo: React.FC = () => {
    const router = useRouter()
    const { chainName } = useChainRoute()
    const { address } = useWallet()
    // Use test address for mock data when wallet is not connected
    const testAddress = address || 'test_user_mock'
    const { deposits, totalPoints, allocations } = useTransmuterLockdrop()
    const { data: userDeposits, isLoading: isLoadingDeposits } = useUserLockdropDeposits(testAddress)
    const { data: config } = useLockdropConfig()
    const { claimsReady, claimableAmount } = useLockdropClaimsReady()

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/2832749a-788e-42b9-9c1d-ba475ed16f2f', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'TransmuterLockdropInfo.tsx:20', message: 'Component render', data: { address, testAddress, hasUserDeposits: !!userDeposits?.deposits?.length, userDepositsCount: userDeposits?.deposits?.length || 0, isLoadingDeposits, userDeposits }, timestamp: Date.now(), sessionId: 'debug-session', runId: 'initial', hypothesisId: 'B' }) }).catch(() => { });
    // #endregion

    // Debug: Log when userDeposits changes
    React.useEffect(() => {
        console.log('TransmuterLockdropInfo: userDeposits changed', {
            testAddress,
            hasData: !!userDeposits,
            depositsCount: userDeposits?.deposits?.length || 0,
            deposits: userDeposits?.deposits,
            isLoading: isLoadingDeposits
        })
    }, [userDeposits, testAddress, isLoadingDeposits])

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
        <Box
            bg="gray.800"
            borderRadius="lg"
            p={6}
            border="1px solid"
            borderColor="purple.500"
            boxShadow="0 0 20px rgba(168, 85, 247, 0.2)"
        >
            <VStack spacing={4} align="stretch">
                {/* Header */}
                <HStack justify="space-between">
                    <HStack spacing={2}>
                        <Image src="/images/mbrn.png" alt="MBRN" w="24px" h="24px" />
                        <Text
                            fontSize="lg"
                            fontWeight="bold"
                            color="purple.400"
                            fontFamily="mono"
                            textTransform="uppercase"
                        >
                            Transmuter Lockdrop
                        </Text>
                    </HStack>
                </HStack>

                <Divider borderColor="gray.700" />

                {hasDeposits ? (
                    <>
                        {/* User Stats */}
                        <VStack spacing={3} align="stretch">
                            <HStack justify="space-between" align="flex-start">
                                <VStack spacing={0} align="flex-start">
                                    <Text fontSize="sm" color="gray.400" fontFamily="mono">
                                        Total Deposited
                                    </Text>
                                    <Text fontSize="xs" color="gray.500" fontFamily="mono">
                                        {userDeposits.deposits.length} deposit{userDeposits.deposits.length !== 1 ? 's' : ''}
                                    </Text>
                                </VStack>
                                <HStack spacing={1}>
                                    <Image src="/images/usdc.png" alt="USDC" w="14px" h="14px" />
                                    <Text fontSize="md" color="purple.300" fontFamily="mono" fontWeight="bold">
                                        {userTotalDeposit.toFixed(2)}
                                    </Text>
                                </HStack>
                            </HStack>

                            <HStack justify="space-between">
                                <Text fontSize="sm" color="gray.400" fontFamily="mono">
                                    Your Share
                                </Text>
                                <Text fontSize="md" color="cyan.400" fontFamily="mono" fontWeight="bold">
                                    {userSharePercentage.toFixed(4)}%
                                </Text>
                            </HStack>

                            {/* <HStack justify="space-between">
                                <Text fontSize="sm" color="gray.400" fontFamily="mono">
                                    Total Points
                                </Text>
                                <Text fontSize="md" color="purple.300" fontFamily="mono" fontWeight="bold">
                                    {shiftDigits(String(userTotalPoints), -6).toNumber().toFixed(2)}
                                </Text>
                            </HStack> */}
                        </VStack>

                        <Divider borderColor="gray.700" />

                        {/* Expected Claim */}
                        <Box
                            bg="green.900"
                            borderRadius="md"
                            p={4}
                            border="1px solid"
                            borderColor="green.500"
                        >
                            <VStack spacing={2}>
                                <Text fontSize="sm" color="green.300" fontFamily="mono">
                                    Expected Claim
                                </Text>
                                <HStack spacing={2}>
                                    <Image src="/images/mbrn.png" alt="MBRN" w="20px" h="20px" />
                                    <Text fontSize="2xl" fontWeight="bold" color="green.300" fontFamily="mono">
                                        {userClaimAmount.toFixed(2)}
                                    </Text>
                                </HStack>
                            </VStack>
                        </Box>

                        {/* Claim Card */}
                        {claimsReady && claimableAmount > 0 ? (
                            <LockdropClaimCard
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
                                colorScheme="purple"
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
                        <VStack spacing={3} py={4}>
                            <Text fontSize="sm" color="gray.400" fontFamily="mono" textAlign="center">
                                You have no deposits in the Transmuter Lockdrop
                            </Text>
                            <Text fontSize="xs" color="gray.500" fontFamily="mono" textAlign="center" lineHeight="1.6">
                                Participate to earn MBRN rewards based on your deposit amount and lock duration
                            </Text>
                            <Box w="full" mt={2}>
                                <TxButton
                                    size="md"
                                    w="full"
                                    colorScheme="purple"
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
        </Box>
    )
}

