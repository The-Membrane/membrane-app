import React from 'react'
import { Box, VStack, HStack, Text, Progress, Badge } from '@chakra-ui/react'
import { ShareableCard } from '../ShareableCard'
import type { ShareableCardData } from '@/services/shareableCard'

interface PointsCardProps {
    data: ShareableCardData
    cardRef?: React.RefObject<HTMLDivElement>
}

/**
 * Points/leaderboard achievement card for sharing
 * Displays rank, total points, level, and progress
 */
export const PointsCard: React.FC<PointsCardProps> = ({ data, cardRef }) => {
    const {
        rank = 0,
        totalPoints = 0,
        level = 1,
        pointsInLevel = 0,
        levelUpMaxPoints = 10,
    } = data

    // Calculate level progress
    const levelProgress = levelUpMaxPoints > 0 ? (pointsInLevel / levelUpMaxPoints) * 100 : 0

    // Get rank tier color
    const getRankTier = () => {
        if (rank === 1) return { tier: 'Champion', color: 'yellow', emoji: '🏆' }
        if (rank <= 3) return { tier: 'Top 3', color: 'orange', emoji: '🥇' }
        if (rank <= 10) return { tier: 'Top 10', color: 'purple', emoji: '⭐' }
        if (rank <= 50) return { tier: 'Top 50', color: 'cyan', emoji: '🔥' }
        if (rank <= 100) return { tier: 'Top 100', color: 'blue', emoji: '💎' }
        return { tier: 'Ranked', color: 'gray', emoji: '📊' }
    }

    const rankTier = getRankTier()

    // Format points
    const formatPoints = (points: number): string => {
        if (points >= 1000000) {
            return `${(points / 1000000).toFixed(2)}M`
        } else if (points >= 1000) {
            return `${(points / 1000).toFixed(2)}K`
        }
        return points.toFixed(0)
    }

    return (
        <ShareableCard title="LEADERBOARD STATUS" subtitle="Points & Ranking" cardRef={cardRef}>
                <VStack spacing={4} h="100%">
                    {/* Main rank display */}
                    <HStack spacing={6} justify="center" w="100%" style={{ gap: '24px' }}>
                        {/* Rank */}
                        <VStack spacing={1}>
                            <Text fontSize="xs" color="gray.500" fontFamily="mono" textTransform="uppercase">
                                Rank
                            </Text>
                            <HStack>
                                <Text
                                    fontSize="4xl"
                                    fontWeight="bold"
                                    color="yellow.400"
                                    fontFamily="mono"
                                >
                                    #{rank}
                                </Text>
                            </HStack>
                            <Badge
                                colorScheme={rankTier.color}
                                fontSize="xs"
                                px={2}
                                py={1}
                                borderRadius="full"
                                fontFamily="mono"
                            >
                                {rankTier.emoji} {rankTier.tier}
                            </Badge>
                        </VStack>

                        {/* Divider */}
                        <Box w="1px" h="80px" bg="gray.600" />

                        {/* Points */}
                        <VStack spacing={1}>
                            <Text fontSize="xs" color="gray.500" fontFamily="mono" textTransform="uppercase">
                                Points
                            </Text>
                            <Text
                                fontSize="3xl"
                                fontWeight="bold"
                                color="cyan.400"
                                fontFamily="mono"
                            >
                                {formatPoints(totalPoints)}
                            </Text>
                            <Text fontSize="xs" color="gray.500" fontFamily="mono">
                                Total Earned
                            </Text>
                        </VStack>
                    </HStack>

                    {/* Level progress */}
                    <Box w="100%" p={3} bg="gray.800" borderRadius="md" border="1px solid" borderColor="gray.600" style={{ padding: '12px' }}>
                        <HStack justify="space-between" mb={2}>
                            <HStack spacing={2}>
                                <Box
                                    px={2}
                                    py={1}
                                    bg="purple.500"
                                    borderRadius="md"
                                >
                                    <Text fontSize="xs" fontWeight="bold" color="white" fontFamily="mono">
                                        LVL {level}
                                    </Text>
                                </Box>
                                <Text fontSize="xs" color="gray.400" fontFamily="mono">
                                    Level Progress
                                </Text>
                            </HStack>
                            <Text fontSize="xs" color="cyan.400" fontFamily="mono">
                                {pointsInLevel.toFixed(0)} / {levelUpMaxPoints.toFixed(0)}
                            </Text>
                        </HStack>
                        <Progress
                            value={levelProgress}
                            size="sm"
                            borderRadius="full"
                            bg="gray.700"
                            sx={{
                                '& > div': {
                                    background: 'linear-gradient(90deg, #8A2BE2 0%, #6FFFC2 100%)',
                                },
                            }}
                        />
                    </Box>

                    {/* Motivational message */}
                    <Box
                        p={2}
                        bg="rgba(138, 43, 226, 0.2)"
                        borderRadius="md"
                        border="1px solid"
                        borderColor="purple.500"
                        w="100%"
                        style={{ padding: '8px' }}
                    >
                        <Text
                            fontSize="xs"
                            color="purple.200"
                            fontFamily="mono"
                            textAlign="center"
                            fontStyle="italic"
                        >
                            {rank === 1 && "The throne is yours. Defend your legacy."}
                            {rank > 1 && rank <= 10 && "Among the elite. Your dedication is unmatched."}
                            {rank > 10 && rank <= 50 && "Rising through the ranks. Greatness awaits."}
                            {rank > 50 && rank <= 100 && "Climbing steadily. The top is within reach."}
                            {rank > 100 && "Every point brings you closer to glory."}
                        </Text>
                    </Box>
                </VStack>
            </ShareableCard>
    )
}

export default PointsCard


