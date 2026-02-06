import React from 'react'
import { Box, VStack, HStack, Text, SimpleGrid } from '@chakra-ui/react'
import { ShareableCard } from '../ShareableCard'
import type { ShareableCardData } from '@/services/shareableCard'

interface PortfolioCardProps {
    data: ShareableCardData
    cardRef?: React.RefObject<HTMLDivElement>
}

/**
 * Combined portfolio card for sharing
 * Displays all major metrics: revenue, boost, contribution, and points
 */
export const PortfolioCard: React.FC<PortfolioCardProps> = ({ data, cardRef }) => {
    const {
        totalRevenue = 0,
        boostPercentage = 0,
        rank = 0,
        totalPoints = 0,
        level = 1,
    } = data

    // Format revenue display
    const formatRevenue = (value: number): string => {
        if (value >= 1000000) {
            return `$${(value / 1000000).toFixed(1)}M`
        } else if (value >= 1000) {
            return `$${(value / 1000).toFixed(1)}K`
        }
        return `$${value.toFixed(2)}`
    }

    // Format points
    const formatPoints = (points: number): string => {
        if (points >= 1000) {
            return `${(points / 1000).toFixed(1)}K`
        }
        return points.toFixed(0)
    }

    return (
        <ShareableCard title="MY MEMBRANE PORTFOLIO" subtitle="Protocol Overview" cardRef={cardRef}>
                <VStack spacing={2} h="100%" style={{ gap: '8px' }}>
                    {/* 2x2 Grid of metrics */}
                    <SimpleGrid columns={2} spacing={2} w="100%" style={{ gap: '8px', marginTop: '24px' }}>
                        {/* Revenue - Top Left */}
                        <Box
                            p={2}
                            bg="gray.800"
                            borderRadius="md"
                            border="1px solid"
                            borderColor="cyan.500"
                            textAlign="center"
                            style={{ padding: '8px' }}
                        >
                            <Text fontSize="2xs" color="gray.500" fontFamily="mono" textTransform="uppercase" mb={0.5}>
                                Lifetime Revenue
                            </Text>
                            <Text
                                fontSize="xl"
                                fontWeight="bold"
                                color="cyan.400"
                                fontFamily="mono"
                                lineHeight="1.1"
                            >
                                {formatRevenue(totalRevenue)}
                            </Text>
                        </Box>

                        {/* Rank - Top Right */}
                        <Box
                            p={2}
                            bg="gray.800"
                            borderRadius="md"
                            border="1px solid"
                            borderColor="yellow.500"
                            textAlign="center"
                            style={{ padding: '8px' }}
                        >
                            <Text fontSize="2xs" color="gray.500" fontFamily="mono" textTransform="uppercase" mb={0.5}>
                                Leaderboard Rank
                            </Text>
                            <Text
                                fontSize="xl"
                                fontWeight="bold"
                                color="yellow.400"
                                fontFamily="mono"
                                lineHeight="1.1"
                            >
                                #{rank}
                            </Text>
                        </Box>

                        {/* Boost - Bottom Left */}
                        <Box
                            p={2}
                            bg="gray.800"
                            borderRadius="md"
                            border="1px solid"
                            borderColor="purple.600"
                            textAlign="center"
                            style={{ padding: '8px' }}
                        >
                            <Text fontSize="2xs" color="gray.500" fontFamily="mono" textTransform="uppercase" mb={0.5}>
                                Boost
                            </Text>
                            <Text
                                fontSize="xl"
                                fontWeight="bold"
                                color="purple.400"
                                fontFamily="mono"
                                lineHeight="1.1"
                            >
                                {boostPercentage.toFixed(1)}%
                            </Text>
                        </Box>

                        {/* Points - Bottom Right */}
                        <Box
                            p={2}
                            bg="gray.800"
                            borderRadius="md"
                            border="1px solid"
                            borderColor="cyan.600"
                            textAlign="center"
                            position="relative"
                            style={{ padding: '8px' }}
                        >
                            <Box
                                position="absolute"
                                top="4px"
                                right="4px"
                                px={1.5}
                                py={0.5}
                                bg="purple.600"
                                borderRadius="md"
                            >
                                <Text fontSize="2xs" fontWeight="bold" color="white" fontFamily="mono">
                                    LVL {level}
                                </Text>
                            </Box>
                            <Text fontSize="2xs" color="gray.500" fontFamily="mono" textTransform="uppercase" mb={0.5}>
                                Points
                            </Text>
                            <Text
                                fontSize="xl"
                                fontWeight="bold"
                                color="cyan.400"
                                fontFamily="mono"
                                lineHeight="1.1"
                            >
                                {formatPoints(totalPoints)}
                            </Text>
                        </Box>
                    </SimpleGrid>

                    {/* Tagline */}
                    <Text
                        fontSize="2xs"
                        color="gray.500"
                        fontFamily="mono"
                        textAlign="center"
                        fontStyle="italic"
                        mt="auto"
                        lineHeight="1.2"
                    >
                        Building wealth through decentralized finance
                    </Text>
                </VStack>
            </ShareableCard>
    )
}

export default PortfolioCard


