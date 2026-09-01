import React from 'react'
import { Box, Text, Icon } from '@chakra-ui/react'
import { CheckCircle } from 'lucide-react'
import { UpdateFilter } from '../hooks/useProtocolUpdates'

import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

interface UpdatesEmptyStateProps {
    filter: UpdateFilter
}

export const UpdatesEmptyState: React.FC<UpdatesEmptyStateProps> = ({ filter }) => {
    return (
        <Box
            bg={SEMANTIC_COLORS.bgSecondary}
            borderRadius={0}
            p={SPACING.lg}
            textAlign="center"
        >
            <Icon as={CheckCircle} w={8} h={8} color={SEMANTIC_COLORS.success} mb={SPACING.sm} />
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary}>
                You&apos;re all caught up!
            </Text>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary} mt={SPACING.xs}>
                No {filter !== 'all' ? filter : ''} updates at this time.
            </Text>
        </Box>
    )
}
