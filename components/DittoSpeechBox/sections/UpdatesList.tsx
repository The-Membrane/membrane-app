import React from 'react'
import { VStack, HStack, Text, Box, Icon } from '@chakra-ui/react'
import { m } from 'framer-motion'
import { DollarSign, Star, Bell, Megaphone, Wrench, Sparkles, Lock, Gift, TrendingUp } from 'lucide-react'
import { ProtocolUpdate } from '@/persisted-state/useUpdatesState'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'

dayjs.extend(relativeTime)

const MotionBox = m(Box)

interface UpdatesListProps {
    updates: ProtocolUpdate[]
    markAsRead: (id: string) => void
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
            return 'primary.400'
        case 'feature':
            return 'secondary.400'
        case 'announcement':
            return 'yellow.400'
        case 'maintenance':
            return 'orange.400'
        case 'lockdrop-ending':
            return 'primary.400'
        case 'lockdrop-claims-ready':
            return 'green.400'
        case 'intent-fulfilled':
            return 'secondary.400'
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

export const UpdatesList: React.FC<UpdatesListProps> = ({ updates, markAsRead }) => {
    return (
        <VStack spacing={2} align="stretch" maxH="250px" overflow="auto">
            {updates.reduce<{ nodes: React.ReactNode[]; visibleIndex: number }>((acc, update) => {
                if (update.type === 'idle-gains') return acc
                const index = acc.visibleIndex
                acc.nodes.push(
                    <MotionBox
                        key={update.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.3, delay: Math.min(index * 0.05, 0.3) }}
                    >
                        <Box
                            bg="#1A1D26"
                            border="1px solid"
                            borderColor={update.read ? '#9bdc4f20' : '#9bdc4f40'}
                            borderLeft={update.priority ? '3px solid' : undefined}
                            borderLeftColor={getPriorityColor(update.priority)}
                            borderRadius="md"
                            p={3}
                            cursor="pointer"
                            transition="all 0.2s"
                            _hover={{
                                bg: '#9bdc4f10',
                                borderColor: '#9bdc4f60',
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
                                        <Text fontSize="sm" fontWeight="medium" color="#ece6d8">
                                            {update.title}
                                        </Text>
                                        {!update.read && (
                                            <Box
                                                w={2}
                                                h={2}
                                                borderRadius="full"
                                                bg="primary.400"
                                            />
                                        )}
                                    </HStack>
                                    <Text fontSize="xs" color="#ece6d880" noOfLines={2}>
                                        {update.message}
                                    </Text>
                                    <Text fontSize="xs" color="#ece6d840">
                                        {formatRelativeTime(update.timestamp)}
                                    </Text>
                                </VStack>
                            </HStack>
                        </Box>
                    </MotionBox>
                )
                acc.visibleIndex += 1
                return acc
            }, { nodes: [], visibleIndex: 0 }).nodes}
        </VStack>
    )
}
