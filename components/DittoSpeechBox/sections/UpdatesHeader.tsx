import React from 'react'
import { HStack, Text, Button, Icon, Badge } from '@chakra-ui/react'
import { Check } from 'lucide-react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'

interface UpdatesHeaderProps {
    unreadCount: number
    markAllAsRead: () => void
}

export const UpdatesHeader: React.FC<UpdatesHeaderProps> = ({ unreadCount, markAllAsRead }) => {
    return (
        <HStack justify="space-between" align="center" mb={1}>
            <HStack spacing={2}>
                <Text fontSize="sm" fontWeight="bold" color={SEMANTIC_COLORS.textPrimary}>
                    Updates
                </Text>
                {unreadCount > 0 && (
                    <Badge
                        colorScheme="primary"
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
                    color={SEMANTIC_COLORS.textSecondary}
                    leftIcon={<Icon as={Check} w={3} h={3} />}
                    onClick={markAllAsRead}
                    _hover={{ color: SEMANTIC_COLORS.textPrimary, bg: 'color-mix(in srgb, var(--m-primary) 12%, transparent)' }}
                >
                    Mark all read
                </Button>
            )}
        </HStack>
    )
}
