import React, { useMemo, useState } from 'react'
import {
    Box,
    VStack,
    HStack,
    Text,
    Progress,
    Tooltip,
    Icon,
} from '@chakra-ui/react'
import { InfoIcon } from '@chakra-ui/icons'
import { useUserPoints, useSoloLevel, useUserRank, usePointsMultipliers } from '@/hooks/usePoints'

// Vault address to name mapping
const VAULT_NAMES: Record<string, string> = {
    'osmo1fqcwupyh6s703rn0lkxfx0ch2lyrw6lz4dedecx0y3ced2jq04tq0mva2l': 'Mars USDC Vault',
    'osmo17rvvd6jc9javy3ytr0cjcypxs20ru22kkhrpwx7j3ym02znuz0vqa37ffx': 'Range Bound LP',
    'osmo1vf6e300hv2qe7r5rln8deft45ewgyytjnwfrdfcv5rgzrfy0s6cswjqf9r': 'Earn Vault',
    'osmo1jw6r68y0uhfmqagc7uhtdddctc7wq95pncvrqnvtd47w4hx46p7se9nju5': 'Auto Stability Pool',
}

interface PointsProgressCardProps {
    compact?: boolean
}

export const PointsProgressCard: React.FC<PointsProgressCardProps> = ({ compact = false }) => {
    const { data: pointsData } = useUserPoints()
    const { data: multipliersData } = usePointsMultipliers()
    const { data: levelData } = useSoloLevel()
    const { data: rank } = useUserRank()
    // console.log("post query", pointsData, multipliersData, levelData, rank)


    const totalPoints = useMemo(() => {
        // Mock value for testing
        return 8
        // return parseFloat(pointsData?.stats?.total_points || '0')
    }, [pointsData])

    const { level, points_in_level, levelup_max_points } = useMemo(() => {
        return levelData || {
            level: 1,
            points_in_level: 0,
            levelup_max_points: 1,
        }
    }, [levelData])

    // Mock multipliers data for testing/fallback
    const mockMultipliers = {
        interest_rate: '2.5',
        liquidation_execution: '3.0',
        liquidation_claims: '1.5',
        governance_votes: '2.0',
        transmuter_swap_fees: '1.8',
        disco_revenue: '2.2',
        vault_yields: [] as { vault_address: string; multiplier: string }[],
    }

    // Calculate conversion rate range from multipliers
    const conversionRateRange = useMemo(() => {
        const multipliers = multipliersData?.points_multipliers || mockMultipliers

        const rates = [
            parseFloat(multipliers.interest_rate || '0'),
            parseFloat(multipliers.liquidation_execution || '0'),
            parseFloat(multipliers.liquidation_claims || '0'),
            parseFloat(multipliers.governance_votes || '0'),
            parseFloat(multipliers.transmuter_swap_fees || '0'),
            parseFloat(multipliers.disco_revenue || '0'),
            ...(multipliers.vault_yields || []).map((v: any) => parseFloat(v.multiplier || '0')),
        ].filter(r => r > 0)

        if (rates.length === 0) return null

        const min = Math.min(...rates)
        const max = Math.max(...rates)
        return { min, max }
    }, [multipliersData])

    // Progress milestones: 1-9, then 20 (shown as vertical line)
    const milestones = useMemo(() => {
        return [1, 2, 3, 4, 5, 6, 7, 8, 9]
    }, [])

    const maxMilestone = 20

    const progressPercentage = useMemo(() => {
        // Calculate progress based on total points relative to max milestone (20)
        return (totalPoints / maxMilestone) * 100
    }, [totalPoints, maxMilestone])

    // Tooltip content for conversion rates
    const conversionRatesTooltip = useMemo(() => {
        const multipliers = multipliersData?.points_multipliers || mockMultipliers

        const rates = [
            { label: 'Interest Rate', value: parseFloat(multipliers.interest_rate || '0') },
            { label: 'Liquidation Execution', value: parseFloat(multipliers.liquidation_execution || '0') },
            { label: 'Liquidation Claims', value: parseFloat(multipliers.liquidation_claims || '0') },
            { label: 'Governance Votes', value: parseFloat(multipliers.governance_votes || '0') },
            { label: 'Transmuter Swap Fees', value: parseFloat(multipliers.transmuter_swap_fees || '0') },
            { label: 'Disco Revenue', value: parseFloat(multipliers.disco_revenue || '0') },
            ...(multipliers.vault_yields || []).map((v: any) => ({
                label: VAULT_NAMES[v.vault_address] || `Vault ${v.vault_address?.slice(0, 8) || 'unknown'}...`,
                value: parseFloat(v.multiplier || '0'),
            })),
        ].filter(r => r.value > 0)

        return rates.length > 0 ? rates : null
    }, [multipliersData])

    // console.log("reaching return", pointsData, multipliersData, levelData, rank)

    // Only use hover state for compact version
    const [isHovered, setIsHovered] = useState(false)

    if (compact) {
        return (
            <>
                <Box
                    bg="gray.800"
                    borderRadius="lg"
                    p={4}
                    border="1px solid"
                    borderColor="gray.700"
                >
                    <VStack spacing={3} align="stretch">
                        <HStack justify="flex-end" align="center" w="100%">
                            {/* <Text fontSize="sm" fontWeight="bold" color="white">
                                Keep earning points towards HIGHER yield
                            </Text> */}
                            {conversionRateRange && (
                                <HStack
                                    spacing={1}
                                    onMouseEnter={() => setIsHovered(true)}
                                    onMouseLeave={() => setIsHovered(false)}
                                    cursor="pointer"
                                >
                                    <Text fontSize="xs" color="gray.400" fontFamily="mono" textAlign="right">
                                        $1 = {conversionRateRange.min.toFixed(1)} - {conversionRateRange.max.toFixed(1)} points
                                    </Text>
                                    <Icon as={InfoIcon} w={3} h={3} color="gray.400" />
                                </HStack>
                            )}
                        </HStack>

                        <Box position="relative">
                            <Progress
                                value={progressPercentage}
                                size="md"
                                borderRadius="full"
                                bg="gray.700"
                                sx={{
                                    '& > div': {
                                        background: 'linear-gradient(90deg, #9F7AEA 0%, #22D3EE 100%)',
                                    },
                                }}
                            />
                            <Box
                                position="absolute"
                                left={`${progressPercentage}%`}
                                top="50%"
                                transform="translate(-50%, -50%)"
                                w="2px"
                                h="6"
                                bg="pink.400"
                                zIndex={2}
                            />
                        </Box>

                        <HStack justify="space-between">
                            <VStack align="start" spacing={0}>
                                <Text fontSize="2xl" fontWeight="bold" color="cyan.400" fontFamily="mono">
                                    {totalPoints.toFixed(0)}
                                </Text>
                                <Text fontSize="xs" color="gray.400" fontFamily="mono">
                                    Total points
                                </Text>
                            </VStack>
                            <Box
                                px={2}
                                py={1}
                                bg="purple.600"
                                borderRadius="md"
                            >
                                <Text fontSize="xs" fontWeight="bold" color="white" fontFamily="mono">
                                    LVL {level}
                                </Text>
                            </Box>
                        </HStack>
                    </VStack>
                </Box>

                {/* Fixed position card that animates up from bottom of speechbox on hover - COMPACT VERSION ONLY */}
                {/* {conversionRateRange && conversionRatesTooltip && (
                    <Box
                        position="fixed"
                        bottom={isHovered ? "181px" : "16px"}
                        left="16px"
                        w="353px"
                        bg="gray.800"
                        border="1px solid"
                        borderColor="gray.700"
                        borderRadius="md"
                        p={3}
                        boxShadow="lg"
                        zIndex={10010}
                        transition="bottom 0.3s ease-in-out, opacity 0.3s ease-in-out"
                        opacity={isHovered ? 1 : 0}
                        pointerEvents={isHovered ? "auto" : "none"}
                        transform={isHovered ? "translateY(0)" : "translateY(10px)"}
                    >
                        <VStack align="start" spacing={2}>
                            <Text fontSize="sm" fontWeight="bold" color="white" mb={1}>
                                Conversion Rates
                            </Text>
                            {conversionRatesTooltip.map((rate, idx) => (
                                <HStack key={idx} justify="space-between" w="100%">
                                    <Text fontSize="xs" color="purple.400">
                                        {rate.label}:
                                    </Text>
                                    <Text fontSize="xs" color="white" fontWeight="medium" fontFamily="mono">
                                        {rate.value.toFixed(1)} points
                                    </Text>
                                </HStack>
                            ))}
                        </VStack>
                    </Box>
                )} */}
            </>
        )
    }

    return (
        <Box
            bg="gray.800"
            borderRadius="xl"
            p={6}
            border="1px solid"
            borderColor="gray.700"
            boxShadow="lg"
        >
            <VStack spacing={4} align="stretch">
                {/* Header with headline and conversion rate */}
                <HStack justify="flex-end" align="flex-start" w="100%">
                    {/* <Text fontSize="lg" fontWeight="bold" color="white" lineHeight="1.2">
                        Keep earning points towards HIGHER yield
                    </Text> */}
                    {conversionRateRange && (
                        <Tooltip
                            label={
                                <VStack align="start" spacing={1} p={2}>
                                    {conversionRatesTooltip?.map((rate, idx) => (
                                        <HStack key={idx} justify="space-between" w="100%">
                                            <Text fontSize="xs" color="purple.400">
                                                {rate.label}:
                                            </Text>
                                            <Text fontSize="xs" color="white" fontWeight="medium" fontFamily="mono">
                                                {rate.value.toFixed(1)} points
                                            </Text>
                                        </HStack>
                                    ))}
                                </VStack>
                            }
                            hasArrow
                            placement="right"
                            bg="gray.800"
                            color="white"
                            borderRadius="md"
                            zIndex={10010}
                        >
                            <HStack spacing={1} cursor="pointer">
                                <Text fontSize="xs" color="gray.400" fontFamily="mono" textAlign="right">
                                    $1 = {conversionRateRange.min.toFixed(1)} - {conversionRateRange.max.toFixed(1)} points
                                </Text>
                                <Icon as={InfoIcon} w={3} h={3} color="gray.400" />
                            </HStack>
                        </Tooltip>
                    )}
                </HStack>

                {/* Progress bar */}
                <Box position="relative" py={2}>
                    <Box position="relative">
                        <Progress
                            value={progressPercentage}
                            size="lg"
                            borderRadius="full"
                            bg="gray.700"
                            h="8px"
                            sx={{
                                '& > div': {
                                    background: 'linear-gradient(90deg, #9F7AEA 0%, #22D3EE 100%)',
                                    borderRadius: 'full',
                                },
                            }}
                        />
                        {/* Current position indicator */}
                        <Box
                            position="absolute"
                            left={`${progressPercentage}%`}
                            top="50%"
                            transform="translate(-50%, -50%)"
                            w="2px"
                            h="8"
                            bg="pink.400"
                            zIndex={2}
                            boxShadow="0 0 4px rgba(236, 72, 153, 0.6)"
                        />
                    </Box>
                </Box>

                {/* Current points display */}
                <HStack justify="space-between" align="center">
                    <VStack align="start" spacing={0}>
                        <Text fontSize="3xl" fontWeight="bold" color="cyan.400" fontFamily="mono" lineHeight="1">
                            {totalPoints.toFixed(0)}
                        </Text>
                        <Text fontSize="sm" color="gray.400" fontFamily="mono">
                            Total points
                        </Text>
                    </VStack>
                    <HStack spacing={2}>
                        <Box
                            px={3}
                            py={1.5}
                            bg="purple.600"
                            borderRadius="md"
                        >
                            <Text fontSize="sm" fontWeight="bold" color="white" fontFamily="mono">
                                LVL {level}
                            </Text>
                        </Box>
                        {rank && (
                            <Box
                                px={3}
                                py={1.5}
                                bg="cyan.600"
                                borderRadius="md"
                            >
                                <Text fontSize="sm" fontWeight="bold" color="white" fontFamily="mono">
                                    Rank {rank}
                                </Text>
                            </Box>
                        )}
                    </HStack>
                </HStack>
            </VStack>
        </Box>
    )
}

