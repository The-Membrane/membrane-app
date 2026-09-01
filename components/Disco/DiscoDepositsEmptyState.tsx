import React from 'react'
import { Box, Text } from '@chakra-ui/react'
import { PRIMARY_PURPLE } from './DiscoDepositsShared'
import type { DiscoDepositsData } from './hooks/useDiscoDepositsData'

type DiscoDepositsEmptyStateProps = Pick<DiscoDepositsData, 'isLoading'>

export const DiscoDepositsEmptyState: React.FC<DiscoDepositsEmptyStateProps> = ({ isLoading }) => {
    return (
        <Box
            bg="rgba(10, 10, 10, 0.8)"
            p={8}
            borderRadius="md"
            border="2px solid"
            borderColor={PRIMARY_PURPLE}
            boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
            textAlign="center"
        >
            <Text fontSize="sm" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                {isLoading ? 'Loading deposits...' : 'No deposits found'}
            </Text>
        </Box>
    )
}
