import React from 'react'
import { VStack, Text, Box, HStack, Button } from '@chakra-ui/react'
import { PRIMARY_PURPLE } from './DiscoDepositsShared'
import type { DiscoDepositsData } from './hooks/useDiscoDepositsData'

type DiscoDepositsSummaryViewProps = Pick<
    DiscoDepositsData,
    'cumulativeTotals' | 'weightedAPR' | 'claimHook' | 'handleClaimAll' | 'setShowDeposits'
>

export const DiscoDepositsSummaryView: React.FC<DiscoDepositsSummaryViewProps> = ({
    cumulativeTotals,
    weightedAPR,
    claimHook,
    handleClaimAll,
    setShowDeposits,
}) => {
    return (
        <Box display="flex" justifyContent="center" w="100%">
            <VStack spacing={4} align="stretch" w="100%" maxW="500px">
                {/* Cumulative Totals */}
                <Box
                    bg="rgba(10, 10, 10, 0.8)"
                    p={6}
                    borderRadius="md"
                    border="2px solid"
                    borderColor={PRIMARY_PURPLE}
                    boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
                >
                    <Text
                        fontSize="lg"
                        fontWeight="bold"
                        color={PRIMARY_PURPLE}
                        fontFamily="mono"
                        letterSpacing="1px"
                        mb={4}
                        textAlign="center"
                    >
                        Cumulative Totals
                    </Text>
                    <VStack spacing={4} align="stretch">
                        <HStack justify="space-between">
                            <Text fontSize="sm" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                                Lifetime Earnings
                            </Text>
                            <Text fontSize="md" fontWeight="bold" color="secondary.400" fontFamily="mono">
                                {cumulativeTotals.lifetime.toFixed(2)} CDT
                            </Text>
                        </HStack>
                        <HStack justify="space-between">
                            <Text fontSize="sm" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                                Weighted Avg APR
                            </Text>
                            <Text fontSize="md" fontWeight="bold" color="secondary.400" fontFamily="mono">
                                {weightedAPR.toFixed(2)}%
                            </Text>
                        </HStack>
                        <HStack justify="space-between">
                            <Text fontSize="sm" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                                Claimable CDT
                            </Text>
                            <Text fontSize="md" color="green.400" fontWeight="bold" fontFamily="mono">
                                +{cumulativeTotals.claimable.toFixed(2)} CDT
                            </Text>
                        </HStack>
                    </VStack>
                </Box>

                {/* Claim All Button */}
                {cumulativeTotals.claimable > 0 && (
                    <Button
                        w="100%"
                        color="white"
                        bg="transparent"
                        border="2px solid"
                        borderColor="green.400"
                        boxShadow="0 0 20px rgba(72, 187, 120, 0.6)"
                        fontFamily="mono"
                        fontSize="sm"
                        fontWeight="bold"
                        py={6}
                        _hover={{
                            bg: 'rgba(72, 187, 120, 0.2)',
                            boxShadow: '0 0 25px rgba(72, 187, 120, 0.8)',
                        }}
                        onClick={handleClaimAll}
                        isLoading={claimHook.action?.tx?.isPending}
                        isDisabled={!claimHook.msgs?.length || cumulativeTotals.claimable <= 0}
                    >
                        Claim All
                    </Button>
                )}

                {/* See All Deposits Button */}
                <Button
                    w="100%"
                    color="white"
                    bg="transparent"
                    border="2px solid"
                    borderColor={PRIMARY_PURPLE}
                    boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
                    fontFamily="mono"
                    fontSize="sm"
                    fontWeight="bold"
                    py={6}
                    _hover={{
                        bg: 'rgba(155, 220, 79, 0.2)',
                        boxShadow: `0 0 25px ${PRIMARY_PURPLE}60`,
                    }}
                    onClick={() => setShowDeposits(true)}
                >
                    See All Deposits
                </Button>
            </VStack>
        </Box>
    )
}
