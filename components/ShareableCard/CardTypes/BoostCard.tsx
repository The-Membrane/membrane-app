import React from 'react'
import { Box, VStack, HStack, Text, Progress } from '@chakra-ui/react'
import { ShareableCard } from '../ShareableCard'
import type { ShareableCardData } from '@/services/shareableCard'

interface BoostCardProps {
    data: ShareableCardData
    cardRef?: React.RefObject<HTMLDivElement>
}

const MAX_MBRN = 100_000_000 // 100M MBRN

/**
 * Boost level achievement card for sharing
 * Displays boost percentage, MBRN locked, and progress
 * Matches the BoostLevelBar component layout
 */
export const BoostCard: React.FC<BoostCardProps> = ({ data, cardRef }) => {
    const { boostPercentage = 0, mbrnAmount = 0, nextMilestone = 0 } = data

    // Format MBRN for display
    const formatMBRN = (amount: number): string => {
        if (amount >= 1_000_000) {
            return `${(amount / 1_000_000).toFixed(2)}M`
        } else if (amount >= 1_000) {
            return `${(amount / 1_000).toFixed(2)}K`
        }
        return amount.toFixed(0)
    }

    const progress = Math.min(100, (mbrnAmount / MAX_MBRN) * 100)
    const mbrnNeeded = Math.max(0, nextMilestone - mbrnAmount)
    const nextMilestoneBoost = (nextMilestone / MAX_MBRN) * 100

    // Determine tier based on boost
    const getTierInfo = () => {
        if (boostPercentage >= 50) return { tier: 'Legendary', color: 'yellow' }
        if (boostPercentage >= 25) return { tier: 'Elite', color: 'purple' }
        if (boostPercentage >= 10) return { tier: 'Advanced', color: 'cyan' }
        if (boostPercentage >= 1) return { tier: 'Rising', color: 'blue' }
        return { tier: 'Starter', color: 'gray' }
    }

    const tierInfo = getTierInfo()

    return (
        <ShareableCard title="BOOST LEVEL" subtitle="Manic Vault Multiplier" cardRef={cardRef}>
            <VStack spacing={2} align="stretch" h="100%">
                {/* Header with boost percentage and tier badge on same line */}
                <Box display="flex" justifyContent="space-between" alignItems="baseline" mb={1} w="100%">
                    <Text
                        fontSize="sm"
                        color="white"
                        fontFamily="mono"
                        fontWeight="medium"
                        lineHeight="1.2"
                        m={0}
                        p={0}
                    >
                        {boostPercentage.toFixed(2)}% Boost
                    </Text>
                    {/* <Box
                        data-tier-badge="true"
                        px={2.5}
                        py={0.5}
                        bg={`${tierInfo.color}.500`}
                        borderRadius="full"
                        border="1px solid"
                        borderColor={`${tierInfo.color}.300`}
                        display="inline-flex"
                        alignItems="center"
                        justifyContent="center"
                        m={0}
                        flexShrink={0}
                        verticalAlign="baseline"
                    >
                        <Text
                            fontSize="xs"
                            fontWeight="bold"
                            color="white"
                            fontFamily="mono"
                            textTransform="uppercase"
                            lineHeight="1.2"
                            m={0}
                            p={0}
                        >
                            {tierInfo.tier}
                        </Text>
                    </Box> */}
                </Box>

                {/* MBRN Amount and Progress */}
                <VStack spacing={1.5} align="stretch" flex={1}>
                    <HStack justify="space-between" align="center">
                        <Text fontSize="xs" color="gray.400" fontFamily="mono">
                            MBRN Amount
                        </Text>
                        <Text fontSize="sm" fontWeight="bold" color="cyan.400" fontFamily="mono">
                            {formatMBRN(mbrnAmount)} / {formatMBRN(MAX_MBRN)} MBRN
                        </Text>
                    </HStack>

                    <Progress
                        value={progress}
                        colorScheme="purple"
                        size="md"
                        borderRadius="full"
                        bg="gray.700"
                        sx={{
                            '& > div': {
                                background: 'linear-gradient(90deg, #8A2BE2 0%, #6FFFC2 100%)',
                            },
                        }}
                    />

                    <HStack justify="space-between" fontSize="2xs" color="gray.500" fontFamily="mono" mt={-1}>
                        <Text>0 MBRN</Text>
                        <Text>{formatMBRN(MAX_MBRN)} MBRN</Text>
                    </HStack>
                </VStack>

                {/* Next milestone */}
                {mbrnAmount < MAX_MBRN && (
                    <Box
                        mt="auto"
                        p={2}
                        bg="gray.700"
                        borderRadius="md"
                        border="1px solid"
                        borderColor="gray.600"
                        style={{ padding: '8px', marginTop: 'auto' }}
                    >
                        <VStack spacing={0.5} align="stretch">
                            <Text fontSize="2xs" color="gray.400" fontFamily="mono" mb={0.5}>
                                Next Milestone
                            </Text>
                            <HStack justify="space-between" align="center">
                                <Text fontSize="xs" color="gray.300" fontFamily="mono">
                                    Target:
                                </Text>
                                <Text fontSize="xs" color="purple.400" fontFamily="mono" fontWeight="bold">
                                    {formatMBRN(nextMilestone)} MBRN ({nextMilestoneBoost.toFixed(2)}% boost)
                                </Text>
                            </HStack>
                            <HStack justify="space-between" align="center">
                                <Text fontSize="xs" color="gray.300" fontFamily="mono">
                                    MBRN Needed:
                                </Text>
                                <Text fontSize="xs" color="cyan.400" fontFamily="mono" fontWeight="bold">
                                    {formatMBRN(mbrnNeeded)} MBRN
                                </Text>
                            </HStack>
                        </VStack>
                    </Box>
                )}

                {mbrnAmount >= MAX_MBRN && (
                    <Box
                        mt="auto"
                        p={2}
                        bg="green.900"
                        borderRadius="md"
                        border="1px solid"
                        borderColor="green.500"
                        style={{ padding: '8px', marginTop: 'auto' }}
                    >
                        <Text fontSize="xs" color="green.400" fontFamily="mono" textAlign="center">
                            Maximum Boost Achieved! (100M MBRN = 100% boost)
                        </Text>
                    </Box>
                )}
            </VStack>
        </ShareableCard>
    )
}

export default BoostCard


