import React from 'react'
import { VStack, Text, Box, HStack } from '@chakra-ui/react'
import { DiscoSectionData } from './DiscoSection.hooks'

type DiscoSectionCumulativeTotalsProps = Pick<DiscoSectionData, 'cumulativeTotals' | 'weightedAPR'>

export const DiscoSectionCumulativeTotals: React.FC<DiscoSectionCumulativeTotalsProps> = ({ cumulativeTotals, weightedAPR }) => {
    return (
        <Box mb={4} pb={4} borderBottom="1px solid" borderColor="gray.700">
            <Text fontSize="sm" color="#ece6d880" mb={2} justifySelf={"center"}>
                Cumulative Totals
            </Text>
            <VStack spacing={2} align="stretch">
                <HStack justify="space-between">
                    <Text fontSize="md" color="#ece6d880">
                        Lifetime Earnings
                    </Text>
                    <Text fontSize="md" fontWeight="bold">
                        {cumulativeTotals.lifetime.toFixed(2)} CDT
                    </Text>
                </HStack>
                <HStack justify="space-between">
                    <Text fontSize="md" color="#ece6d880">
                        Weighted Avg APR
                    </Text>
                    <Text fontSize="md" fontWeight="bold">
                        {weightedAPR.toFixed(2)}%
                    </Text>
                </HStack>
                <HStack justify="space-between">
                    <Text fontSize="md" color="#ece6d880">
                        Claimable CDT
                    </Text>
                    <Text fontSize="md" color="green.400" fontWeight="bold">
                        +{cumulativeTotals.claimable.toFixed(2)} CDT
                    </Text>
                </HStack>
            </VStack>
        </Box>
    )
}
