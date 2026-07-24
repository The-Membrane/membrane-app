import React from 'react'
import { Box, VStack, HStack, Text, Button } from '@chakra-ui/react'
import { PRIMARY_PURPLE } from './DiscoPageConstants'
import type { DiscoPageState } from './hooks/useDiscoPage'

interface DiscoPageUserTotalsProps {
    userDeposits: DiscoPageState['userDeposits']
    depositCarouselData: DiscoPageState['depositCarouselData']
    cumulativeTotals: DiscoPageState['cumulativeTotals']
    weightedAPR: number
    totalUnstaking: number
    handleClaimAll: DiscoPageState['handleClaimAll']
    claimHook: DiscoPageState['claimHook']
}

/** Left column of "Your Deposits": total MBRN, cumulative totals, claim-all. */
export const DiscoPageUserTotals: React.FC<DiscoPageUserTotalsProps> = ({
    userDeposits,
    depositCarouselData,
    cumulativeTotals,
    weightedAPR,
    totalUnstaking,
    handleClaimAll,
    claimHook,
}) => {
    return (
        <VStack spacing={4} align="stretch">
            {/* Your Total MBRN Deposits */}
            <Box
                bg="rgba(10, 10, 10, 0.8)"
                p={4}
                borderRadius="md"
                border="2px solid"
                borderColor={PRIMARY_PURPLE}
                boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
                textAlign="center"
            >
                <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="1px" mb={2}>
                    Your Total MBRN Deposits
                </Text>
                <Text
                    fontSize="xl"
                    fontWeight="bold"
                    color={PRIMARY_PURPLE}
                    fontFamily="'Neon Tubes', mono"
                >
                    {userDeposits.totalMBRN > 0 ? `${userDeposits.totalMBRN.toFixed(2)} MBRN` : '—'}
                </Text>
            </Box>

            {/* Cumulative Totals */}
            {depositCarouselData.length > 0 && (
                <Box
                    bg="rgba(10, 10, 10, 0.8)"
                    p={4}
                    borderRadius="md"
                    border="2px solid"
                    borderColor={PRIMARY_PURPLE}
                    boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
                >
                    <Text
                        fontSize="sm"
                        fontWeight="bold"
                        color={PRIMARY_PURPLE}
                        fontFamily="mono"
                        letterSpacing="1px"
                        mb={3}
                        textAlign="center"
                    >
                        Cumulative Totals
                    </Text>
                    <VStack spacing={3} align="stretch">
                        <HStack justify="space-between">
                            <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                                Lifetime Earnings
                            </Text>
                            <Text fontSize="sm" fontWeight="bold" color="white" fontFamily="'Neon Tubes', mono">
                                {cumulativeTotals.lifetime.toFixed(2)} CDT
                            </Text>
                        </HStack>
                        <HStack justify="space-between">
                            <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                                Weighted Avg APR
                            </Text>
                            <Text fontSize="sm" fontWeight="bold" color="secondary.400" fontFamily="'Neon Tubes', mono">
                                {weightedAPR.toFixed(2)}%
                            </Text>
                        </HStack>
                        <HStack justify="space-between">
                            <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                                Claimable CDT
                            </Text>
                            <Text fontSize="sm" color="secondary.400" fontWeight="bold" fontFamily="'Neon Tubes', mono">
                                +{cumulativeTotals.claimable.toFixed(2)} CDT
                            </Text>
                        </HStack>
                        {totalUnstaking > 0 && (
                            <HStack justify="space-between">
                                <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                                    Unstaking
                                </Text>
                                <Text fontSize="sm" color="orange.300" fontWeight="bold" fontFamily="'Neon Tubes', mono">
                                    {totalUnstaking.toLocaleString(undefined, { maximumFractionDigits: 0 })} MBRN
                                </Text>
                            </HStack>
                        )}
                    </VStack>
                </Box>
            )}

            {/* Claim All Button */}
            {cumulativeTotals.claimable > 0 && (
                <Button
                    w="100%"
                    variant="ghost"
                    color="green.400"
                    fontFamily="'Neon Tubes', mono"
                    fontSize="lg"
                    fontWeight="bold"
                    py={6}
                    _hover={{
                        bg: 'rgba(72, 187, 120, 0.1)',
                    }}
                    onClick={handleClaimAll}
                    isLoading={claimHook.action?.simulate?.isLoading || claimHook.action?.tx?.isLoading}
                    isDisabled={cumulativeTotals.claimable <= 0 || !claimHook.action?.simulate?.isSuccess}
                >
                    Claim All
                </Button>
            )}
        </VStack>
    )
}
