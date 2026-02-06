import React, { useState } from 'react'
import { VStack, HStack, Text, Box, Button, Divider, Icon, Badge, Tabs, TabList, Tab, TabPanels, TabPanel } from '@chakra-ui/react'
import { motion } from 'framer-motion'
import { Clock, DollarSign, Star, Bell, CheckCircle, Megaphone, Wrench, Sparkles, Check, Lock, Gift, TrendingUp } from 'lucide-react'
import { SectionComponentProps } from '../types'
import { useProtocolUpdates, UpdateFilter } from '../hooks/useProtocolUpdates'
import { ProtocolUpdate } from '@/persisted-state/useUpdatesState'
import dayjs from 'dayjs'
import duration from 'dayjs/plugin/duration'
import relativeTime from 'dayjs/plugin/relativeTime'

dayjs.extend(duration)
dayjs.extend(relativeTime)

const MotionBox = motion(Box)

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

export const UpdatesSection: React.FC<SectionComponentProps> = ({ onBack }) => {
    const {
        updates,
        unreadCount,
        categorizedUpdates,
        markAsRead,
        markAllAsRead,
        idleGains,
        dismissIdleGains,
    } = useProtocolUpdates()
    const [filter, setFilter] = useState<UpdateFilter>('all')

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

    // Format relative time
    const formatRelativeTime = (timestamp: number): string => {
        return dayjs(timestamp).fromNow()
    }

    const getUpdateIcon = (type: ProtocolUpdate['type']) => {
        switch (type) {
            case 'idle-gains':
                return DollarSign
            case 'reward':
                return Star
            case 'feature':
                return Sparkles
            case 'announcement':
                return Megaphone
            case 'maintenance':
                return Wrench
            case 'lockdrop-ending':
                return Lock
            case 'lockdrop-claims-ready':
                return Gift
            case 'intent-fulfilled':
                return TrendingUp
            default:
                return Bell
        }
    }

    const getUpdateColor = (type: ProtocolUpdate['type']) => {
        switch (type) {
            case 'idle-gains':
                return 'green.400'
            case 'reward':
                return 'purple.400'
            case 'feature':
                return 'cyan.400'
            case 'announcement':
                return 'yellow.400'
            case 'maintenance':
                return 'orange.400'
            case 'lockdrop-ending':
                return 'purple.400'
            case 'lockdrop-claims-ready':
                return 'green.400'
            case 'intent-fulfilled':
                return 'cyan.400'
            default:
                return 'gray.400'
        }
    }

    const getPriorityColor = (priority?: ProtocolUpdate['priority']) => {
        switch (priority) {
            case 'critical':
                return 'red.400'
            case 'important':
                return 'yellow.400'
            default:
                return undefined
        }
    }

    const filteredUpdates = filter === 'all' 
        ? updates 
        : filter === 'unread' 
            ? updates.filter(u => !u.read)
            : updates.filter(u => u.type === filter)

    return (
        <VStack spacing={3} align="stretch" w="100%">
            {/* Header */}
            <HStack justify="space-between" align="center" mb={1}>
                <HStack spacing={2}>
                    <Text fontSize="sm" fontWeight="bold" color="#F5F5F5">
                        Updates
                    </Text>
                    {unreadCount > 0 && (
                        <Badge
                            colorScheme="purple"
                            borderRadius="full"
                            px={2}
                            fontSize="xs"
                        >
                            {unreadCount} new
                        </Badge>
                    )}
                </HStack>
                {unreadCount > 0 && (
                    <Button
                        size="xs"
                        variant="ghost"
                        color="#F5F5F580"
                        leftIcon={<Icon as={Check} w={3} h={3} />}
                        onClick={markAllAsRead}
                        _hover={{ color: '#F5F5F5', bg: '#6943FF20' }}
                    >
                        Mark all read
                    </Button>
                )}
            </HStack>

            {/* Filter Tabs */}
            <HStack 
                spacing={2} 
                overflowX="auto" 
                overflowY="hidden"
                pb={2}
                w="100%"
                align="flex-start"
                css={{
                    '&::-webkit-scrollbar': {
                        height: '4px',
                    },
                    '&::-webkit-scrollbar-track': {
                        background: 'transparent',
                    },
                    '&::-webkit-scrollbar-thumb': {
                        background: '#6943FF40',
                        borderRadius: '2px',
                    },
                }}
            >
                <Button
                    size="sm"
                    variant={filter === 'all' ? 'solid' : 'ghost'}
                    bg={filter === 'all' ? '#6943FF' : 'transparent'}
                    color={filter === 'all' ? 'white' : '#F5F5F580'}
                    border={filter === 'all' ? 'none' : '1px solid'}
                    borderColor={filter === 'all' ? 'transparent' : '#6943FF30'}
                    borderRadius="full"
                    px={4}
                    py={1.5}
                    fontSize="xs"
                    fontWeight={filter === 'all' ? 'semibold' : 'normal'}
                    _hover={{ 
                        bg: filter === 'all' ? '#6943FF' : '#6943FF20',
                        borderColor: filter === 'all' ? 'transparent' : '#6943FF50',
                        color: filter === 'all' ? 'white' : '#F5F5F5'
                    }}
                    onClick={() => setFilter('all')}
                    whiteSpace="nowrap"
                    flexShrink={0}
                    w="50%"
                >
                    All
                </Button>
                <Button
                    size="sm"
                    variant={filter === 'unread' ? 'solid' : 'ghost'}
                    bg={filter === 'unread' ? '#6943FF' : 'transparent'}
                    color={filter === 'unread' ? 'white' : '#F5F5F580'}
                    border={filter === 'unread' ? 'none' : '1px solid'}
                    borderColor={filter === 'unread' ? 'transparent' : '#6943FF30'}
                    borderRadius="full"
                    px={4}
                    py={1.5}
                    fontSize="xs"
                    fontWeight={filter === 'unread' ? 'semibold' : 'normal'}
                    _hover={{ 
                        bg: filter === 'unread' ? '#6943FF' : '#6943FF20',
                        borderColor: filter === 'unread' ? 'transparent' : '#6943FF50',
                        color: filter === 'unread' ? 'white' : '#F5F5F5'
                    }}
                    onClick={() => setFilter('unread')}
                    whiteSpace="nowrap"
                    flexShrink={0}
                    w="50%"
                >
                    Unread
                </Button>
            </HStack>

            {/* Idle Gains Card (if available and filter allows) */}
            {idleGains && (filter === 'all' || filter === 'unread') && (
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
                                    <Icon as={Clock} w={4} h={4} color="cyan.400" />
                                    <Text fontSize="sm" color="cyan.400" fontWeight="bold">
                                        While You Were Away
                                    </Text>
                                </HStack>
                                <Text fontSize="xs" color="#F5F5F580">
                                    {formatDuration(idleGains.timeElapsed)}
                                </Text>
                            </HStack>

                            <Text fontSize="xs" color="#F5F5F580">
                                The system continued generating value in your absence.
                            </Text>

                            <Divider borderColor="#6943FF30" />

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
                                    <Text fontSize="xs" color="purple.300">
                                        Points Earned
                                    </Text>
                                    <VStack align="flex-end" spacing={0}>
                                        <Text fontSize="sm" fontWeight="bold" color="purple.300">
                                            +{idleGains.pointsEarned.toFixed(1)}
                                        </Text>
                                        <Text fontSize="xs" color="purple.200">
                                            +{formatMBRNTruncated(idleGains.mbrnEarned)} MBRN
                                        </Text>
                                    </VStack>
                                </HStack>
                            </VStack>

                            <Button
                                size="xs"
                                variant="ghost"
                                color="#F5F5F580"
                                onClick={dismissIdleGains}
                                _hover={{ color: '#F5F5F5', bg: '#6943FF20' }}
                            >
                                Dismiss
                            </Button>
                        </VStack>
                    </Box>
                </MotionBox>
            )}

            {/* Updates List */}
            <VStack spacing={2} align="stretch" maxH="250px" overflow="auto">
                {filteredUpdates.filter(u => u.type !== 'idle-gains').map((update, index) => (
                    <MotionBox
                        key={update.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.3, delay: Math.min(index * 0.05, 0.3) }}
                    >
                        <Box
                            bg="#1A1D26"
                            border="1px solid"
                            borderColor={update.read ? '#6943FF20' : '#6943FF40'}
                            borderLeft={update.priority ? '3px solid' : undefined}
                            borderLeftColor={getPriorityColor(update.priority)}
                            borderRadius="md"
                            p={3}
                            cursor="pointer"
                            transition="all 0.2s"
                            _hover={{
                                bg: '#6943FF10',
                                borderColor: '#6943FF60',
                            }}
                            onClick={() => markAsRead(update.id)}
                        >
                            <HStack spacing={3} align="flex-start">
                                <Icon
                                    as={getUpdateIcon(update.type)}
                                    w={4}
                                    h={4}
                                    color={getUpdateColor(update.type)}
                                    mt={0.5}
                                />
                                <VStack align="stretch" spacing={1} flex={1}>
                                    <HStack justify="space-between">
                                        <Text fontSize="sm" fontWeight="medium" color="#F5F5F5">
                                            {update.title}
                                        </Text>
                                        {!update.read && (
                                            <Box
                                                w={2}
                                                h={2}
                                                borderRadius="full"
                                                bg="purple.400"
                                            />
                                        )}
                                    </HStack>
                                    <Text fontSize="xs" color="#F5F5F580" noOfLines={2}>
                                        {update.message}
                                    </Text>
                                    <Text fontSize="xs" color="#F5F5F540">
                                        {formatRelativeTime(update.timestamp)}
                                    </Text>
                                </VStack>
                            </HStack>
                        </Box>
                    </MotionBox>
                ))}
            </VStack>

            {/* Empty State */}
            {filteredUpdates.length === 0 && !idleGains && (
                <Box
                    bg="#1A1D26"
                    borderRadius="md"
                    p={6}
                    textAlign="center"
                >
                    <Icon as={CheckCircle} w={8} h={8} color="green.400" mb={2} />
                    <Text fontSize="sm" color="#F5F5F5">
                        You're all caught up!
                    </Text>
                    <Text fontSize="xs" color="#F5F5F580" mt={1}>
                        No {filter !== 'all' ? filter : ''} updates at this time.
                    </Text>
                </Box>
            )}

            {/* Footer */}
            <Text fontSize="xs" color="#F5F5F540" textAlign="center" mt={2}>
                Updates are automatically tracked while you're away
            </Text>
        </VStack>
    )
}

