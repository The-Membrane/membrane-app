import React from 'react'
import { HStack, Button } from '@chakra-ui/react'
import { UpdateFilter } from '../hooks/useProtocolUpdates'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

interface UpdatesFilterTabsProps {
    filter: UpdateFilter
    setFilter: (filter: UpdateFilter) => void
}

export const UpdatesFilterTabs: React.FC<UpdatesFilterTabsProps> = ({ filter, setFilter }) => {
    return (
        <HStack
            spacing={SPACING.sm}
            overflowX="auto"
            overflowY="hidden"
            pb={SPACING.sm}
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
                    background: SEMANTIC_COLORS.borderStrong,
                    borderRadius: 0,
                },
            }}
        >
            <Button
                size="sm"
                variant={filter === 'all' ? 'outline' : 'ghost'}
                bg={filter === 'all' ? SEMANTIC_COLORS.bgTertiary : 'transparent'}
                color={filter === 'all' ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textSecondary}
                border="1px solid"
                borderColor={filter === 'all' ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.borderSubtle}
                borderRadius={0}
                px={SPACING.base}
                py={SPACING.xs}
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.label}
                fontWeight={filter === 'all' ? TYPOGRAPHY.semibold : TYPOGRAPHY.normal}
                transition={TRANSITIONS.colors}
                _hover={{
                    bg: SEMANTIC_COLORS.bgTertiary,
                    borderColor: filter === 'all' ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.borderStrong,
                    color: filter === 'all' ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textPrimary
                }}
                _focus={FOCUS_STYLES.ring}
                _focusVisible={FOCUS_STYLES.ring}
                aria-pressed={filter === 'all'}
                onClick={() => setFilter('all')}
                whiteSpace="nowrap"
                flexShrink={0}
                w="50%"
            >
                All
            </Button>
            <Button
                size="sm"
                variant={filter === 'unread' ? 'outline' : 'ghost'}
                bg={filter === 'unread' ? SEMANTIC_COLORS.bgTertiary : 'transparent'}
                color={filter === 'unread' ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textSecondary}
                border="1px solid"
                borderColor={filter === 'unread' ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.borderSubtle}
                borderRadius={0}
                px={SPACING.base}
                py={SPACING.xs}
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.label}
                fontWeight={filter === 'unread' ? TYPOGRAPHY.semibold : TYPOGRAPHY.normal}
                transition={TRANSITIONS.colors}
                _hover={{
                    bg: SEMANTIC_COLORS.bgTertiary,
                    borderColor: filter === 'unread' ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.borderStrong,
                    color: filter === 'unread' ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textPrimary
                }}
                _focus={FOCUS_STYLES.ring}
                _focusVisible={FOCUS_STYLES.ring}
                aria-pressed={filter === 'unread'}
                onClick={() => setFilter('unread')}
                whiteSpace="nowrap"
                flexShrink={0}
                w="50%"
            >
                Unread
            </Button>
        </HStack>
    )
}
