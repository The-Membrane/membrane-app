import React from 'react'
import { Box, VStack, HStack, Text, Progress, Center } from '@chakra-ui/react'
import { ShareableCard } from '../ShareableCard'
import type { ShareableCardData } from '@/services/shareableCard'

interface RevenueCardProps {
    data: ShareableCardData
    cardRef?: React.RefObject<HTMLDivElement>
}

/**
 * Revenue achievement card for sharing
 * Displays lifetime revenue, milestones, and earnings rate
 */
export const RevenueCard: React.FC<RevenueCardProps> = ({ data, cardRef }) => {
    const { totalRevenue = 0, revenuePerSecond = 0, milestones = [] } = data

    // Format revenue display
    const formatRevenue = (value: number): string => {
        if (value >= 1000000) {
            return `$${(value / 1000000).toFixed(2)}M`
        } else if (value >= 1000) {
            return `$${(value / 1000).toFixed(2)}K`
        }
        return `$${value.toFixed(2)}`
    }

    // Format milestone value
    const formatMilestone = (value: number): string => {
        if (value >= 1000000) {
            return `$${value / 1000000}M`
        } else if (value >= 1000) {
            return `$${value / 1000}K`
        }
        return `$${value}`
    }

    // Calculate progress to next milestone
    const achievedMilestones = milestones.filter((m) => m.achieved)
    const nextMilestone = milestones.find((m) => !m.achieved)
    const progressToNext = nextMilestone
        ? (totalRevenue / nextMilestone.value) * 100
        : 100

    return (
        <ShareableCard title="LIFETIME EARNINGS" subtitle="Membrane Revenue" cardRef={cardRef}>
            <VStack spacing={3} align="stretch" h="100%">
                {/* Main revenue display */}
                <Box textAlign="center" py={2} style={{ paddingTop: '8px', paddingBottom: '8px' }}>
                    <Text
                        fontSize="4xl"
                        fontWeight="bold"
                        color="cyan.300"
                        fontFamily="mono"
                        lineHeight="1.1"
                    >
                        {formatRevenue(totalRevenue)}
                    </Text>
                    <Text fontSize="sm" color="gray.400" fontFamily="mono" mt={1}>
                        earning ${revenuePerSecond.toFixed(6)}/sec
                    </Text>
                </Box>

                {/* Progress to next milestone */}
                {nextMilestone && (
                    <Box>
                        <HStack justify="space-between" mb={1}>
                            <Text fontSize="xs" color="gray.500" fontFamily="mono">
                                Progress to {formatMilestone(nextMilestone.value)}
                            </Text>
                            <Text fontSize="xs" color="cyan.400" fontFamily="mono" fontWeight="bold">
                                {Math.min(progressToNext, 100).toFixed(1)}%
                            </Text>
                        </HStack>
                        <Progress
                            value={Math.min(progressToNext, 100)}
                            size="sm"
                            colorScheme="purple"
                            borderRadius="full"
                            bg="gray.700"
                            sx={{
                                '& > div': {
                                    background: 'linear-gradient(90deg, #8A2BE2 0%, #6FFFC2 100%)',
                                },
                            }}
                        />
                    </Box>
                )}

                {/* Milestone badges - centered to fill space */}
                <Box
                    display="flex"
                    justifyContent="center"
                    alignItems="center"
                    flexWrap="wrap"
                    gap="8px"
                    style={{ gap: '8px' }}
                    flex="1"
                    mt="auto"
                >
                    {milestones.slice(0, 7).map((milestone) => (
                        <Box
                            key={milestone.value}
                            data-milestone-badge="true"
                            px={3}
                            minW="50px"
                            h="28px"
                            bg={milestone.achieved ? 'green.500' : 'gray.700'}
                            borderRadius="md"
                            border="1px solid"
                            borderColor={milestone.achieved ? 'green.400' : 'gray.600'}
                            fontSize={milestone.achieved ? 'lg' : 'xs'}
                            fontFamily="mono"
                            color={milestone.achieved ? 'white' : 'gray.500'}
                            fontWeight={milestone.achieved ? 700 : 400}
                            display="flex"
                            alignItems="center"
                            justifyContent="center"
                            style={{ paddingLeft: '12px', paddingRight: '12px' }}
                        >
                            {formatMilestone(milestone.value)}
                        </Box>
                    ))}
                </Box>
            </VStack>
        </ShareableCard>
    )
}

export default RevenueCard


