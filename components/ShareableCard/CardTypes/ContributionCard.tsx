import React from 'react'
import { Box, VStack, HStack, Text, Badge } from '@chakra-ui/react'
import { ShareableCard } from '../ShareableCard'
import type { ShareableCardData } from '@/services/shareableCard'

interface ContributionCardProps {
    data: ShareableCardData
    cardRef?: React.RefObject<HTMLDivElement>
}

const tierConfig: Record<string, { color: string; message: string }> = {
    Stabilizer: {
        color: 'gray',
        message: 'A silent guardian. Your presence maintains the balance.',
    },
    Contributor: {
        color: 'blue',
        message: "You've carved your mark. The system recognizes your resonance.",
    },
    'Top 1% Contributor': {
        color: 'purple',
        message: 'You stand among the elite. Your domain expansion echoes.',
    },
    'Prime Engineer': {
        color: 'cyan',
        message: 'A master architect. You are the foundation of the system.',
    },
}

// Get color value from Chakra color scheme
const getColorValue = (color: string): string => {
    const colorMap: Record<string, string> = {
        gray: '#9CA3AF',
        blue: '#60A5FA',
        purple: '#A78BFA',
        cyan: '#22D3EE',
    }
    return colorMap[color] || colorMap.gray
}

/**
 * Contribution tier achievement card for sharing
 * Displays tier badge, contribution percentage, and breakdown
 */
export const ContributionCard: React.FC<ContributionCardProps> = ({ data, cardRef }) => {
    const {
        contributionPercentage = 0,
        tvlContribution = 0,
        revenueContribution = 0,
        tier = 'Stabilizer',
    } = data

    const tierInfo = tierConfig[tier] || tierConfig.Stabilizer
    const progressValue = Math.min(contributionPercentage, 100)
    const progressPercent = progressValue
    const colorValue = getColorValue(tierInfo.color)
    
    // Calculate the angle for the progress (0-360 degrees)
    const angle = (progressPercent / 100) * 360

    return (
        <ShareableCard title="SYSTEM CONTRIBUTION" subtitle="Protocol Status" cardRef={cardRef}>
                <HStack spacing={6} h="100%" align="center" style={{ gap: '24px' }}>
                    {/* Custom circular contribution display */}
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
                                background: `conic-gradient(from -90deg, ${colorValue} 0deg ${angle}deg, transparent ${angle}deg 360deg)`,
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
                                    color={`${tierInfo.color}.400`}
                                    fontFamily="mono"
                                    lineHeight="1.2"
                                >
                                    {contributionPercentage < 0.1 
                                        ? contributionPercentage.toFixed(4) 
                                        : contributionPercentage < 1 
                                        ? contributionPercentage.toFixed(3) 
                                        : contributionPercentage < 10 
                                        ? contributionPercentage.toFixed(2) 
                                        : contributionPercentage.toFixed(1)}%
                                </Text>
                                <Text fontSize="xs" color="gray.400" fontFamily="mono" mt={0.5}>
                                    TOTAL
                                </Text>
                            </VStack>
                        </Box>
                    </Box>

                    {/* Stats and tier info */}
                    <VStack spacing={3} align="stretch" flex={1}>
                        {/* Tier badge */}
                        <Badge
                            colorScheme={tierInfo.color}
                            fontSize="sm"
                            px={4}
                            py={2}
                            borderRadius="full"
                            fontFamily="mono"
                            textTransform="uppercase"
                            textAlign="center"
                            w="fit-content"
                        >
                            {tier}
                        </Badge>

                        {/* Contribution breakdown */}
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
                                        TVL (80%)
                                    </Text>
                                    <Text fontSize="sm" color="cyan.400" fontFamily="mono" fontWeight="bold">
                                        {tvlContribution.toFixed(2)}%
                                    </Text>
                                </HStack>
                                <HStack justify="space-between">
                                    <Text fontSize="xs" color="gray.400" fontFamily="mono">
                                        Revenue (20%)
                                    </Text>
                                    <Text fontSize="sm" color="purple.400" fontFamily="mono" fontWeight="bold">
                                        {revenueContribution.toFixed(2)}%
                                    </Text>
                                </HStack>
                            </VStack>
                        </Box>

                        {/* Tier message */}
                        <Box
                            p={2}
                            bg={`${tierInfo.color}.900`}
                            borderRadius="md"
                            border="1px solid"
                            borderColor={`${tierInfo.color}.500`}
                            style={{ padding: '8px' }}
                        >
                            <Text
                                fontSize="xs"
                                color={`${tierInfo.color}.200`}
                                fontFamily="mono"
                                fontStyle="italic"
                                textAlign="center"
                            >
                                {tierInfo.message}
                            </Text>
                        </Box>
                    </VStack>
                </HStack>
            </ShareableCard>
    )
}

export default ContributionCard


