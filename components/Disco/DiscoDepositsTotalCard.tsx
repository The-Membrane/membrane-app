import React from 'react'
import { Box, Text } from '@chakra-ui/react'
import { PRIMARY_PURPLE } from './DiscoDepositsShared'
import type { DiscoDepositsData } from './hooks/useDiscoDepositsData'

type DiscoDepositsTotalCardProps = Pick<DiscoDepositsData, 'totalMBRN'>

export const DiscoDepositsTotalCard: React.FC<DiscoDepositsTotalCardProps> = ({ totalMBRN }) => {
    return (
        <Box
            bg="rgba(10, 10, 10, 0.8)"
            p={6}
            borderRadius="md"
            border="2px solid"
            borderColor={PRIMARY_PURPLE}
            boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
            textAlign="center"
        >
            <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="1px" mb={2}>
                Your Total MBRN Deposits
            </Text>
            <Text
                fontSize={{ base: '2xl', md: '3xl' }}
                fontWeight="bold"
                color={PRIMARY_PURPLE}
                fontFamily="mono"
                textShadow={`0 0 10px ${PRIMARY_PURPLE}`}
            >
                {totalMBRN > 0 ? `${totalMBRN.toFixed(2)} MBRN` : '—'}
            </Text>
        </Box>
    )
}
