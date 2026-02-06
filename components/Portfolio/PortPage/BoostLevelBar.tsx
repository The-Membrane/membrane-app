import React, { useMemo } from 'react'
import {
    Box,
    VStack,
    HStack,
    Text,
    Progress,
    Tooltip,
    IconButton,
} from '@chakra-ui/react'
import { InfoIcon } from '@chakra-ui/icons'
import { useUserBoost } from './hooks/useUserBoost'
import { ShareButton } from '@/components/ShareableCard/ShareButton'

const MAX_MBRN = 100_000_000 // 100M MBRN

export const BoostLevelBar: React.FC = () => {
    const { data: boostData } = useUserBoost()

    // Parse boost percentage from Decimal string
    const boostPercentage = useMemo(() => {
        if (!boostData?.boost) return 0
        // Convert Decimal string to number (e.g., "0.30" = 30%)
        return parseFloat(boostData.boost) * 100
    }, [boostData])

    // Calculate MBRN amount from boost percentage
    // boostPercentage = (mbrnAmount / 100M) * 100
    // Therefore: mbrnAmount = (boostPercentage / 100) * 100M
    const mbrnAmount = useMemo(() => {
        return (boostPercentage / 100) * MAX_MBRN
    }, [boostPercentage])

    // Calculate progress percentage (0-100%)
    const progress = useMemo(() => {
        return Math.min(100, (mbrnAmount / MAX_MBRN) * 100)
    }, [mbrnAmount])

    // Find next milestone (10M, 20M, 30M, etc.)
    const nextMilestone = useMemo(() => {
        const milestones = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
        const currentMilestone = Math.floor(mbrnAmount / 1_000_000) * 1_000_000
        const nextMilestoneValue = milestones.find(
            (m) => m * 1_000_000 > mbrnAmount
        )
        return nextMilestoneValue ? nextMilestoneValue * 1_000_000 : MAX_MBRN
    }, [mbrnAmount])

    const mbrnNeeded = useMemo(() => {
        return Math.max(0, nextMilestone - mbrnAmount)
    }, [nextMilestone, mbrnAmount])

    const nextMilestoneBoost = useMemo(() => {
        return (nextMilestone / MAX_MBRN) * 100
    }, [nextMilestone])

    // Format MBRN for display
    const formatMBRN = (amount: number): string => {
        if (amount >= 1_000_000) {
            return `${(amount / 1_000_000).toFixed(2)}M`
        } else if (amount >= 1_000) {
            return `${(amount / 1_000).toFixed(2)}K`
        }
        return amount.toFixed(0)
    }

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
                background: 'linear-gradient(135deg, rgba(138, 43, 226, 0.1) 0%, rgba(111, 255, 194, 0.1) 100%)',
                pointerEvents: 'none',
            }}
        >
            <VStack spacing={4} align="stretch" position="relative" zIndex={1}>
                <HStack justify="space-between" align="center">
                    <VStack align="flex-start" spacing={0}>
                        <HStack spacing={2} align="flex-start" >
                            <Text
                                fontSize="sm"
                                color="gray.400"
                                fontFamily="mono"
                                textTransform="uppercase"
                                letterSpacing="wide"
                            >
                                Boost Level
                            </Text>
                            <ShareButton cardType="boost" size="xs" />
                            <Tooltip
                                label="Boost increases your Manic Vault yields and MBRN points received based on your total MBRN locked in LTV Disco. The boost percentage equals your MBRN amount as a percentage of 100M MBRN (e.g., 30M MBRN = 30% boost)."
                                fontSize="xs"
                                bg="gray.800"
                                color="#F5F5F5"
                                border="1px solid"
                                borderColor="purple.500"
                                borderRadius="md"
                                p={3}
                                hasArrow
                                maxW="300px"
                            >
                                <IconButton
                                    aria-label="Boost Info"
                                    icon={<InfoIcon />}
                                    pt={"3%"}
                                    size="xs"
                                    variant="ghost"
                                    color="gray.400"
                                    alignItems={"flex-start"}
                                    _hover={{ color: 'cyan.400' }}
                                    minW="auto"
                                    w="auto"
                                    h="auto"
                                />
                            </Tooltip>
                        </HStack>
                        <Text
                            fontSize="xs"
                            color="gray.500"
                            fontFamily="mono"
                        >
                            {boostPercentage.toFixed(2)}% Boost
                        </Text>
                    </VStack>
                </HStack>

                <VStack spacing={2} align="stretch">
                    <HStack justify="space-between">
                        <Text fontSize="sm" color="gray.400" fontFamily="mono">
                            MBRN Amount
                        </Text>
                        <Text fontSize="lg" fontWeight="bold" color="cyan.400" fontFamily="mono">
                            {formatMBRN(mbrnAmount)} / {formatMBRN(MAX_MBRN)} MBRN
                        </Text>
                    </HStack>

                    <Progress
                        value={progress}
                        colorScheme="purple"
                        size="lg"
                        borderRadius="full"
                        bg="gray.700"
                        sx={{
                            '& > div': {
                                background: 'linear-gradient(90deg, #8A2BE2 0%, #6FFFC2 100%)',
                            },
                        }}
                    />

                    <HStack justify="space-between" fontSize="xs" color="gray.500" fontFamily="mono">
                        <Text>0 MBRN</Text>
                        <Text>{formatMBRN(MAX_MBRN)} MBRN</Text>
                    </HStack>
                </VStack>

                {mbrnAmount < MAX_MBRN && (
                    <Box
                        mt={2}
                        p={3}
                        bg="gray.700"
                        borderRadius="md"
                        border="1px solid"
                        borderColor="gray.600"
                    >
                        <VStack spacing={1} align="stretch">
                            <Text fontSize="xs" color="gray.400" fontFamily="mono">
                                Next Milestone
                            </Text>
                            <HStack justify="space-between">
                                <Text fontSize="sm" color="gray.300" fontFamily="mono">
                                    Target:
                                </Text>
                                <Text fontSize="sm" color="purple.400" fontFamily="mono" fontWeight="bold">
                                    {formatMBRN(nextMilestone)} MBRN ({nextMilestoneBoost.toFixed(2)}% boost)
                                </Text>
                            </HStack>
                            <HStack justify="space-between">
                                <Text fontSize="sm" color="gray.300" fontFamily="mono">
                                    MBRN Needed:
                                </Text>
                                <Text fontSize="sm" color="cyan.400" fontFamily="mono" fontWeight="bold">
                                    {formatMBRN(mbrnNeeded)} MBRN
                                </Text>
                            </HStack>
                        </VStack>
                    </Box>
                )}

                {mbrnAmount >= MAX_MBRN && (
                    <Box
                        mt={2}
                        p={3}
                        bg="green.900"
                        borderRadius="md"
                        border="1px solid"
                        borderColor="green.500"
                    >
                        <Text fontSize="sm" color="green.400" fontFamily="mono" textAlign="center">
                            Maximum Boost Achieved! (100M MBRN = 100% boost)
                        </Text>
                    </Box>
                )}

            </VStack>
        </Box>
    )
}
