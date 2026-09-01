import React from 'react'
import { VStack, HStack, Text, Box, Button, Divider, Icon } from '@chakra-ui/react'
import { m } from 'framer-motion'
import { Clock } from 'lucide-react'
import dayjs from 'dayjs'
import duration from 'dayjs/plugin/duration'

import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'

dayjs.extend(duration)

const MotionBox = m(Box)

interface IdleGains {
    timeElapsed: number
    revenueAccumulated: number
    pointsEarned: number
    mbrnEarned: number
}

interface UpdatesIdleGainsCardProps {
    idleGains: IdleGains
    onDismiss: () => void
}

// Format duration from milliseconds
const formatDuration = (ms: number): string => {
    const dur = dayjs.duration(ms)
    const hours = dur.hours()
    const minutes = dur.minutes()

    if (hours > 0) {
        return `${hours}h ${minutes}m`
    }
    return `${minutes}m`
}

/**
 * Format MBRN value by truncating to nearest non-zero decimal place
 * Removes trailing zeros and decimal point if not needed
 * Examples: 90.9000 → "90.9", 90.0000 → "90", 0.123456 → "0.123456"
 */
const formatMBRNTruncated = (value: number): string => {
    if (value === 0) return '0'
    // Convert to string with enough precision, then remove trailing zeros
    const str = value.toFixed(10)
    // Remove trailing zeros
    const trimmed = str.replace(/\.?0+$/, '')
    return trimmed
}

export const UpdatesIdleGainsCard: React.FC<UpdatesIdleGainsCardProps> = ({ idleGains, onDismiss }) => {
    return (
        <MotionBox
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
        >
            <Box
                bg={SEMANTIC_COLORS.bgSecondary}
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                borderRadius={0}
                p={SPACING.base}
            >
                <VStack spacing={3} align="stretch">
                    <HStack justify="space-between">
                        <HStack spacing={2}>
                            <Icon as={Clock} w={4} h={4} color={SEMANTIC_COLORS.info} />
                            <Text fontSize="sm" color={SEMANTIC_COLORS.info} fontWeight="bold">
                                While You Were Away
                            </Text>
                        </HStack>
                        <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                            {formatDuration(idleGains.timeElapsed)}
                        </Text>
                    </HStack>

                    <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                        The system continued generating value in your absence.
                    </Text>

                    <Divider borderColor="#9bdc4f30" />

                    {/* Stats */}
                    <VStack spacing={2} align="stretch">
                        <HStack justify="space-between">
                            <Text fontSize="xs" color={SEMANTIC_COLORS.success}>
                                Revenue Accumulated
                            </Text>
                            <Text fontSize="sm" fontWeight="bold" color={SEMANTIC_COLORS.success}>
                                ${idleGains.revenueAccumulated.toFixed(2)}
                            </Text>
                        </HStack>
                        <HStack justify="space-between">
                            <Text fontSize="xs" color={SEMANTIC_COLORS.primary}>
                                Points Earned
                            </Text>
                            <VStack align="flex-end" spacing={0}>
                                <Text fontSize="sm" fontWeight="bold" color={SEMANTIC_COLORS.primary}>
                                    +{idleGains.pointsEarned.toFixed(1)}
                                </Text>
                                <Text fontSize="xs" color={SEMANTIC_COLORS.primary}>
                                    +{formatMBRNTruncated(idleGains.mbrnEarned)} MBRN
                                </Text>
                            </VStack>
                        </HStack>
                    </VStack>

                    <Button
                        size="xs"
                        variant="ghost"
                        color={SEMANTIC_COLORS.textSecondary}
                        onClick={onDismiss}
                        _hover={{ color: SEMANTIC_COLORS.textPrimary, bg: '#9bdc4f20' }}
                    >
                        Dismiss
                    </Button>
                </VStack>
            </Box>
        </MotionBox>
    )
}
