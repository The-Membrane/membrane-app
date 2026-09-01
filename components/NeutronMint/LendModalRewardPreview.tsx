import React from 'react'
import { Box, VStack, HStack, Text, Image, Divider } from '@chakra-ui/react'
import { TYPOGRAPHY } from '@/helpers/typography'
import { num } from '@/helpers/num'

interface LendModalRewardPreviewProps {
    depositAmount: number
    projectedPoints: number
    projectedShare: number
    acquisitionModel: { rewardRate: number }
    projectedMbrn: number
}

// Format MBRN for display
const formatMbrn = (amount: number) => {
    if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`
    if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K`
    if (amount >= 1) return amount.toFixed(2)
    if (amount > 0) return amount.toFixed(4)
    return '0'
}

export const LendModalRewardPreview: React.FC<LendModalRewardPreviewProps> = ({
    depositAmount,
    projectedPoints,
    projectedShare,
    acquisitionModel,
    projectedMbrn,
}) => {
    return (
        <Box
            bg="rgba(10, 10, 10, 0.8)"
            borderRadius="lg"
            p={4}
            border="1px solid"
            borderColor="whiteAlpha.200"
        >
            <VStack spacing={3} align="stretch">
                <Text color="white" fontSize={TYPOGRAPHY.h4} fontWeight={TYPOGRAPHY.semibold}>
                    Reward Preview
                </Text>

                <Divider borderColor="whiteAlpha.100" />

                <HStack justify="space-between">
                    <Text color="whiteAlpha.600" fontSize="sm">Your Deposit</Text>
                    <HStack spacing={1}>
                        <Image src="/images/usdc.svg" alt="USDC" w="14px" h="14px" borderRadius="full" />
                        <Text color="white" fontSize="sm" fontWeight="medium">
                            {depositAmount > 0 ? num(depositAmount).toFixed(2) : '0.00'} USDC
                        </Text>
                    </HStack>
                </HStack>

                <HStack justify="space-between">
                    <Text color="whiteAlpha.600" fontSize="sm">Your Points</Text>
                    <Text color="purple.300" fontSize="sm" fontWeight="medium">
                        {projectedPoints > 0 ? num(projectedPoints).toFixed(2) : '0.00'}
                    </Text>
                </HStack>

                <HStack justify="space-between">
                    <Text color="whiteAlpha.600" fontSize="sm">Your Share</Text>
                    <Text color="purple.300" fontSize="sm" fontWeight="medium">
                        {projectedShare > 0 ? `${(projectedShare * 100).toFixed(4)}%` : '0.00%'}
                    </Text>
                </HStack>

                <HStack justify="space-between">
                    <Text color="whiteAlpha.600" fontSize="sm">Reward Rate</Text>
                    <Text color="white" fontSize="sm" fontWeight="medium">
                        {acquisitionModel.rewardRate > 0
                            ? `${acquisitionModel.rewardRate.toFixed(2)} MBRN per USDC`
                            : '-'}
                    </Text>
                </HStack>

                {/* Projected MBRN — highlighted */}
                <Box
                    bg="rgba(166, 146, 255, 0.1)"
                    borderRadius="md"
                    p={3}
                    border="1px solid"
                    borderColor="purple.500"
                >
                    <HStack justify="space-between">
                        <Text color="whiteAlpha.600" fontSize="sm">Projected MBRN</Text>
                        <HStack spacing={1}>
                            <Image src="/images/mbrn.png" alt="MBRN" w="16px" h="16px" />
                            <Text color="purple.300" fontSize="md" fontWeight="bold">
                                {formatMbrn(projectedMbrn)}
                            </Text>
                        </HStack>
                    </HStack>
                </Box>
            </VStack>
        </Box>
    )
}
