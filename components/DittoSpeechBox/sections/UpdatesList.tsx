import React from 'react'
import { VStack, HStack, Text, Box, Icon } from '@chakra-ui/react'
import { m } from 'framer-motion'
import { DollarSign, Star, Bell, Megaphone, Wrench, Sparkles, Lock, Gift, TrendingUp } from 'lucide-react'
import { ProtocolUpdate } from '@/persisted-state/useUpdatesState'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'

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
            return SEMANTIC_COLORS.success
        case 'reward':
            return SEMANTIC_COLORS.primary
        case 'feature':
            return SEMANTIC_COLORS.info
        case 'announcement':
            return SEMANTIC_COLORS.warning
        case 'maintenance':
            return SEMANTIC_COLORS.warning
        case 'lockdrop-ending':
            return SEMANTIC_COLORS.primary
        case 'lockdrop-claims-ready':
            return SEMANTIC_COLORS.success
        case 'intent-fulfilled':
            return SEMANTIC_COLORS.info
        default:
            return SEMANTIC_COLORS.textSecondary
    }
}

const getPriorityColor = (priority?: ProtocolUpdate['priority']) => {
    switch (priority) {
        case 'critical':
            return SEMANTIC_COLORS.danger
        case 'important':
            return SEMANTIC_COLORS.warning
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
                            bg={SEMANTIC_COLORS.bgSecondary}
                            border="1px solid"
                            borderColor={update.read ? SEMANTIC_COLORS.borderSubtle : SEMANTIC_COLORS.borderStrong}
                            borderLeft={update.priority ? '3px solid' : undefined}
                            borderLeftColor={getPriorityColor(update.priority)}
                            borderRadius={0}
                            p={SPACING.md}
                            cursor="pointer"
                            role="button"
                            tabIndex={0}
                            transition={TRANSITIONS.colors}
                            _hover={HOVER_EFFECTS.borderHighlight}
                            _focus={FOCUS_STYLES.ring}
                            _focusVisible={FOCUS_STYLES.ring}
                            onClick={() => markAsRead(update.id)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault()
                                    markAsRead(update.id)
                                }
                            }}
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
                                        <Text fontSize="sm" fontWeight="medium" color={SEMANTIC_COLORS.textPrimary}>
                                            {update.title}
                                        </Text>
                                        {!update.read && (
                                            <Box
                                                w={2}
                                                h={2}
                                                borderRadius="full"
                                                bg={SEMANTIC_COLORS.primary}
                                            />
                                        )}
                                    </HStack>
                                    <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} noOfLines={2}>
                                        {update.message}
                                    </Text>
                                    <Text fontSize="xs" color={SEMANTIC_COLORS.textTertiary}>
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
