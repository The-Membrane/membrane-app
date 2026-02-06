import React from 'react'
import {
    Box,
    VStack,
    HStack,
    Text,
    CircularProgress,
    CircularProgressLabel,
    Badge,
} from '@chakra-ui/react'
import { useContributionPercentage } from './hooks/useContributionPercentage'
import { ShareButton } from '@/components/ShareableCard/ShareButton'

const tierConfig = {
    Stabilizer: {
        color: 'gray',
        threshold: 1,
    },
    Contributor: {
        color: 'blue',
        threshold: 5,
    },
    'Top 1% Contributor': {
        color: 'purple',
        threshold: 10,
    },
    'Prime Engineer': {
        color: 'cyan',
        threshold: Infinity,
    },
}

export const ContributionMeter: React.FC = () => {
    const { percentage, tvlContribution, revenueContribution, tier } = useContributionPercentage()

    const tierInfo = tierConfig[tier]

    return (
        <Box
            bg="gray.800"
            border="1px solid"
            borderColor="purple.500"
            borderRadius="md"
            p={6}
            position="relative"
            overflow="hidden"
            _before={{
                content: '""',
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: `linear-gradient(135deg, rgba(111, 255, 194, 0.05) 0%, rgba(138, 43, 226, 0.05) 100%)`,
                pointerEvents: 'none',
            }}
        >
            <VStack spacing={4} align="stretch" position="relative" zIndex={1}>
                <HStack justify="space-between" align="center">
                    <HStack spacing={2}>
                        <Text
                            fontSize="sm"
                            color="gray.400"
                            fontFamily="mono"
                            textTransform="uppercase"
                            letterSpacing="wide"
                        >
                            System Contribution
                        </Text>
                        <ShareButton cardType="contribution" size="xs" />
                    </HStack>
                    <Badge
                        colorScheme={tierInfo.color}
                        fontSize="xs"
                        px={3}
                        py={1}
                        borderRadius="full"
                        fontFamily="mono"
                        textTransform="uppercase"
                    >
                        {tier}
                    </Badge>
                </HStack>

                <HStack justify="center" spacing={8}>
                    <VStack spacing={2}>
                        <CircularProgress
                            value={percentage}
                            size="120px"
                            thickness="8px"
                            color={`${tierInfo.color}.400`}
                            trackColor="gray.700"
                        >
                            <CircularProgressLabel>
                                <VStack spacing={0}>
                                    <Text fontSize="2xl" fontWeight="bold" color={`${tierInfo.color}.400`} fontFamily="mono">
                                        {percentage.toFixed(2)}%
                                    </Text>
                                    <Text fontSize="xs" color="gray.400" fontFamily="mono">
                                        Total
                                    </Text>
                                </VStack>
                            </CircularProgressLabel>
                        </CircularProgress>
                    </VStack>
                </HStack>

                <Box
                    mt={4}
                    p={4}
                    bg="gray.700"
                    borderRadius="md"
                    border="1px solid"
                    borderColor="gray.600"
                >
                    <VStack spacing={2} align="stretch">
                        <Text fontSize="xs" color="gray.400" fontFamily="mono" textTransform="uppercase">
                            Contribution Breakdown
                        </Text>
                        <HStack justify="space-between">
                            <Text fontSize="sm" color="gray.300" fontFamily="mono">
                                TVL Contribution (80%):
                            </Text>
                            <Text fontSize="sm" color="cyan.400" fontFamily="mono" fontWeight="bold">
                                {tvlContribution.toFixed(2)}%
                            </Text>
                        </HStack>
                        <HStack justify="space-between">
                            <Text fontSize="sm" color="gray.300" fontFamily="mono">
                                Revenue Contribution (20%):
                            </Text>
                            <Text fontSize="sm" color="purple.400" fontFamily="mono" fontWeight="bold">
                                {revenueContribution.toFixed(2)}%
                            </Text>
                        </HStack>
                    </VStack>
                </Box>

                <Box
                    mt={2}
                    p={3}
                    bg={`${tierInfo.color}.900`}
                    borderRadius="md"
                    border="1px solid"
                    borderColor={`${tierInfo.color}.500`}
                >
                    <Text fontSize="xs" color={`${tierInfo.color}.300`} fontFamily="mono" textAlign="center" fontStyle="italic">
                        {tier === 'Stabilizer' && 'A silent guardian in the depths. Your presence maintains the balance.'}
                        {tier === 'Contributor' && 'You\'ve carved your mark in the shadows. The system recognizes your resonance.'}
                        {tier === 'Top 1% Contributor' && 'You stand among the elite. Your domain expansion echoes through the network.'}
                        {tier === 'Prime Engineer' && 'A cursed technique master. You are the foundation upon which the system thrives.'}
                    </Text>
                </Box>
            </VStack>
        </Box>
    )
}
