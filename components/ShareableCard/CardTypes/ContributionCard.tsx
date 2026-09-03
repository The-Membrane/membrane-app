import React from 'react'
import { Box, VStack, HStack, Text } from '@chakra-ui/react'
import { ShareableCard } from '../ShareableCard'
import type { ShareableCardData } from '@/services/shareableCard'

interface ContributionCardProps {
    data: ShareableCardData
    cardRef?: React.RefObject<HTMLDivElement>
}

const GAUGE_COLOR = '#22D3EE'

const formatShare = (value: number): string => {
    if (value < 0.1) return value.toFixed(4)
    if (value < 1) return value.toFixed(3)
    if (value < 10) return value.toFixed(2)
    return value.toFixed(1)
}

/**
 * System-contribution share card. Renders the user's share of system TVL and
 * revenue as plain facts — no tier ladder, no composite score. The old
 * Stabilizer→Prime Engineer tiers graded 80% wealth share + 20% revenue share,
 * which BADASS_RULESET.md §11 prohibits (progression keyed to capital/returns).
 */
export const ContributionCard: React.FC<ContributionCardProps> = ({ data, cardRef }) => {
    const {
        tvlContribution = 0,
        revenueContribution = 0,
    } = data

    // Gauge shows the on-chain-verifiable fact: share of system TVL
    const progressPercent = Math.min(tvlContribution, 100)
    const angle = (progressPercent / 100) * 360

    return (
        <ShareableCard title="SYSTEM CONTRIBUTION" subtitle="Protocol Status" cardRef={cardRef}>
                <HStack spacing={6} h="100%" align="center" style={{ gap: '24px' }}>
                    {/* Circular TVL-share display */}
                    <Box position="relative" w="140px" h="140px" flexShrink={0}>
                        {/* Background circle */}
                        <Box
                            position="absolute"
                            top={0}
                            left={0}
                            w="140px"
                            h="140px"
                            borderRadius="50%"
                            bg="gray.700"
                            style={{ backgroundColor: '#374151' }}
                        />
                        {/* Progress circle using conic-gradient */}
                        <Box
                            position="absolute"
                            top={0}
                            left={0}
                            w="140px"
                            h="140px"
                            borderRadius="50%"
                            style={{
                                background: `conic-gradient(from -90deg, ${GAUGE_COLOR} 0deg ${angle}deg, transparent ${angle}deg 360deg)`,
                                mask: 'radial-gradient(circle, transparent 60px, black 61px)',
                                WebkitMask: 'radial-gradient(circle, transparent 60px, black 61px)',
                            }}
                        />
                        {/* Inner circle (background) */}
                        <Box
                            position="absolute"
                            top="10px"
                            left="10px"
                            w="120px"
                            h="120px"
                            borderRadius="50%"
                            bg="#1a1a2e"
                        />
                        {/* Center content */}
                        <Box
                            position="absolute"
                            top="50%"
                            left="50%"
                            transform="translate(-50%, -50%)"
                            textAlign="center"
                        >
                            <VStack spacing={0}>
                                <Text
                                    fontSize="2xl"
                                    fontWeight="bold"
                                    color="cyan.400"
                                    fontFamily="mono"
                                    lineHeight="1.2"
                                >
                                    {formatShare(tvlContribution)}%
                                </Text>
                                <Text fontSize="xs" color="gray.400" fontFamily="mono" mt={0.5}>
                                    OF SYSTEM TVL
                                </Text>
                            </VStack>
                        </Box>
                    </Box>

                    {/* Share-of-system facts */}
                    <VStack spacing={3} align="stretch" flex={1}>
                        <Box
                            p={3}
                            bg="gray.800"
                            borderRadius="md"
                            border="1px solid"
                            borderColor="gray.600"
                            style={{ padding: '12px' }}
                        >
                            <VStack spacing={2} align="stretch">
                                <HStack justify="space-between">
                                    <Text fontSize="xs" color="gray.400" fontFamily="mono">
                                        MY DEPOSITS BACK
                                    </Text>
                                    <Text fontSize="sm" color="cyan.400" fontFamily="mono" fontWeight="bold">
                                        {formatShare(tvlContribution)}% of TVL
                                    </Text>
                                </HStack>
                                <HStack justify="space-between">
                                    <Text fontSize="xs" color="gray.400" fontFamily="mono">
                                        MY SHARE OF REVENUE
                                    </Text>
                                    <Text fontSize="sm" color="purple.400" fontFamily="mono" fontWeight="bold">
                                        {formatShare(revenueContribution)}%
                                    </Text>
                                </HStack>
                            </VStack>
                        </Box>
                    </VStack>
                </HStack>
            </ShareableCard>
    )
}

export default ContributionCard
