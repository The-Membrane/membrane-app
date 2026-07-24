import React from 'react'
import { Box, Text, Icon } from '@chakra-ui/react'
import { CheckCircle } from 'lucide-react'
import { UpdateFilter } from '../hooks/useProtocolUpdates'

interface UpdatesEmptyStateProps {
    filter: UpdateFilter
}

export const UpdatesEmptyState: React.FC<UpdatesEmptyStateProps> = ({ filter }) => {
    return (
        <Box
            bg="#1A1D26"
            borderRadius="md"
            p={6}
            textAlign="center"
        >
            <Icon as={CheckCircle} w={8} h={8} color="green.400" mb={2} />
            <Text fontSize="sm" color="#ece6d8">
                You're all caught up!
            </Text>
            <Text fontSize="xs" color="#ece6d880" mt={1}>
                No {filter !== 'all' ? filter : ''} updates at this time.
            </Text>
        </Box>
    )
}
