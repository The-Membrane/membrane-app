import React, { useState } from 'react'
import { VStack, Text } from '@chakra-ui/react'
import { SectionComponentProps } from '../types'
import { useProtocolUpdates, UpdateFilter } from '../hooks/useProtocolUpdates'
import { UpdatesHeader } from './UpdatesHeader'
import { UpdatesFilterTabs } from './UpdatesFilterTabs'
import { UpdatesIdleGainsCard } from './UpdatesIdleGainsCard'
import { UpdatesList } from './UpdatesList'
import { UpdatesEmptyState } from './UpdatesEmptyState'

export const UpdatesSection: React.FC<SectionComponentProps> = ({ onBack }) => {
    const {
        updates,
        unreadCount,
        markAsRead,
        markAllAsRead,
        idleGains,
        dismissIdleGains,
    } = useProtocolUpdates()
    const [filter, setFilter] = useState<UpdateFilter>('all')

    const filteredUpdates = filter === 'all'
        ? updates
        : filter === 'unread'
            ? updates.filter(u => !u.read)
            : updates.filter(u => u.type === filter)

    return (
        <VStack spacing={3} align="stretch" w="100%">
            {/* Header */}
            <UpdatesHeader unreadCount={unreadCount} markAllAsRead={markAllAsRead} />

            {/* Filter Tabs */}
            <UpdatesFilterTabs filter={filter} setFilter={setFilter} />

            {/* Idle Gains Card (if available and filter allows) */}
            {idleGains && (filter === 'all' || filter === 'unread') && (
                <UpdatesIdleGainsCard idleGains={idleGains} onDismiss={dismissIdleGains} />
            )}

            {/* Updates List */}
            <UpdatesList updates={filteredUpdates} markAsRead={markAsRead} />

            {/* Empty State */}
            {filteredUpdates.length === 0 && !idleGains && (
                <UpdatesEmptyState filter={filter} />
            )}

            {/* Footer */}
            <Text fontSize="xs" color="#ece6d840" textAlign="center" mt={2}>
                Updates are automatically tracked while you're away
            </Text>
        </VStack>
    )
}
