import React from 'react'
import { VStack, HStack, Text, Box, Button, Divider, Icon } from '@chakra-ui/react'
import { m } from 'framer-motion'
import { Clock } from 'lucide-react'
import dayjs from 'dayjs'
import duration from 'dayjs/plugin/duration'

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
                bg="linear-gradient(135deg, #1A1D26 0%, #0D4436 100%)"
                border="1px solid"
                borderColor="green.500"
                borderRadius="md"
                p={4}
            >
                <VStack spacing={3} align="stretch">
                    <HStack justify="space-between">
                        <HStack spacing={2}>
                            <Icon as={Clock} w={4} h={4} color="secondary.400" />
                            <Text fontSize="sm" color="secondary.400" fontWeight="bold">
                                While You Were Away
                            </Text>
                        </HStack>
                        <Text fontSize="xs" color="#ece6d880">
                            {formatDuration(idleGains.timeElapsed)}
                        </Text>
                    </HStack>

                    <Text fontSize="xs" color="#ece6d880">
                        The system continued generating value in your absence.
                    </Text>

                    <Divider borderColor="#9bdc4f30" />

                    {/* Stats */}
                    <VStack spacing={2} align="stretch">
                        <HStack justify="space-between">
                            <Text fontSize="xs" color="green.300">
                                Revenue Accumulated
                            </Text>
                            <Text fontSize="sm" fontWeight="bold" color="green.300">
                                ${idleGains.revenueAccumulated.toFixed(2)}
                            </Text>
                        </HStack>
                        <HStack justify="space-between">
                            <Text fontSize="xs" color="primary.300">
                                Points Earned
                            </Text>
                            <VStack align="flex-end" spacing={0}>
                                <Text fontSize="sm" fontWeight="bold" color="primary.300">
                                    +{idleGains.pointsEarned.toFixed(1)}
                                </Text>
                                <Text fontSize="xs" color="primary.200">
                                    +{formatMBRNTruncated(idleGains.mbrnEarned)} MBRN
                                </Text>
                            </VStack>
                        </HStack>
                    </VStack>

                    <Button
                        size="xs"
                        variant="ghost"
                        color="#ece6d880"
                        onClick={onDismiss}
                        _hover={{ color: '#ece6d8', bg: '#9bdc4f20' }}
                    >
                        Dismiss
                    </Button>
                </VStack>
            </Box>
        </MotionBox>
    )
}
