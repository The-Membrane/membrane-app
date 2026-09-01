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
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
import { useUserBoost } from './hooks/useUserBoost'
import { ShareButton } from '@/components/ShareableCard/ShareButton'

const MAX_MBRN = 100_000_000 // 100M MBRN

// Format MBRN for display
const formatMBRN = (amount: number): string => {
    if (amount >= 1_000_000) {
        return `${(amount / 1_000_000).toFixed(2)}M`
    } else if (amount >= 1_000) {
        return `${(amount / 1_000).toFixed(2)}K`
    }
    return amount.toFixed(0)
}

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
    const mbrnAmount = (boostPercentage / 100) * MAX_MBRN

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

    const nextMilestoneBoost = (nextMilestone / MAX_MBRN) * 100

    return (
        <Card
            bg={SEMANTIC_COLORS.bgSecondary}
            borderColor={SEMANTIC_COLORS.borderMedium}
            borderRadius={0}
            p={SPACING.lg}
        >
            <VStack spacing={SPACING.base} align="stretch">
                <HStack justify="space-between" align="center">
                    <VStack align="flex-start" spacing={0}>
                        <HStack spacing={SPACING.sm} align="flex-start" >
                            <Text
                                fontSize="sm"
                                color={SEMANTIC_COLORS.textSecondary}
                                fontFamily={TYPOGRAPHY.fontMono}
                                textTransform="uppercase"
                                letterSpacing="wide"
                            >
                                Boost Level
                            </Text>
                            <ShareButton cardType="boost" size="xs" />
                            <Tooltip
                                label="Boost increases your Manic Vault yields and MBRN points received based on your total MBRN locked in LTV Disco. The boost percentage equals your MBRN amount as a percentage of 100M MBRN (e.g., 30M MBRN = 30% boost)."
                                fontSize="xs"
                                bg={SEMANTIC_COLORS.bgSecondary}
                                color={SEMANTIC_COLORS.textPrimary}
                                border="1px solid"
                                borderColor={SEMANTIC_COLORS.borderMedium}
                                borderRadius={0}
                                p={SPACING.md}
                                hasArrow
                                maxW="300px"
                            >
                                <IconButton
                                    aria-label="Boost Info"
                                    icon={<InfoIcon />}
                                    pt={"3%"}
                                    size="xs"
                                    variant="ghost"
                                    color={SEMANTIC_COLORS.textSecondary}
                                    alignItems={"flex-start"}
                                    transition={TRANSITIONS.colors}
                                    _hover={HOVER_EFFECTS.brighten}
                                    _focus={FOCUS_STYLES.ring}
                                    minW="auto"
                                    w="auto"
                                    h="auto"
                                />
                            </Tooltip>
                        </HStack>
                        <Text
                            fontSize="xs"
                            color={SEMANTIC_COLORS.textTertiary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            sx={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                            {boostPercentage.toFixed(2)}% Boost
                        </Text>
                    </VStack>
                </HStack>

                <VStack spacing={SPACING.sm} align="stretch">
                    <HStack justify="space-between">
                        <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                            MBRN Amount
                        </Text>
                        <Text fontSize="lg" fontWeight={TYPOGRAPHY.bold} color={SEMANTIC_COLORS.info} fontFamily={TYPOGRAPHY.fontMono} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                            {formatMBRN(mbrnAmount)} / {formatMBRN(MAX_MBRN)} MBRN
                        </Text>
                    </HStack>

                    <Progress
                        value={progress}
                        size="lg"
                        borderRadius={0}
                        bg={SEMANTIC_COLORS.bgTertiary}
                        sx={{
                            '& > div': {
                                background: SEMANTIC_COLORS.info,
                            },
                        }}
                    />

                    <HStack justify="space-between" fontSize="xs" color={SEMANTIC_COLORS.textTertiary} fontFamily={TYPOGRAPHY.fontMono}>
                        <Text>0 MBRN</Text>
                        <Text>{formatMBRN(MAX_MBRN)} MBRN</Text>
                    </HStack>
                </VStack>

                {mbrnAmount < MAX_MBRN && (
                    <Box
                        mt={SPACING.sm}
                        p={SPACING.md}
                        bg={SEMANTIC_COLORS.bgTertiary}
                        borderRadius={0}
                        border="1px solid"
                        borderColor={SEMANTIC_COLORS.borderMedium}
                    >
                        <VStack spacing={SPACING.xs} align="stretch">
                            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                                Next Milestone
                            </Text>
                            <HStack justify="space-between">
                                <Text fontSize="sm" color={SEMANTIC_COLORS.textPrimary} fontFamily={TYPOGRAPHY.fontMono}>
                                    Target:
                                </Text>
                                <Text fontSize="sm" color={SEMANTIC_COLORS.info} fontFamily={TYPOGRAPHY.fontMono} fontWeight={TYPOGRAPHY.bold} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                    {formatMBRN(nextMilestone)} MBRN ({nextMilestoneBoost.toFixed(2)}% boost)
                                </Text>
                            </HStack>
                            <HStack justify="space-between">
                                <Text fontSize="sm" color={SEMANTIC_COLORS.textPrimary} fontFamily={TYPOGRAPHY.fontMono}>
                                    MBRN Needed:
                                </Text>
                                <Text fontSize="sm" color={SEMANTIC_COLORS.info} fontFamily={TYPOGRAPHY.fontMono} fontWeight={TYPOGRAPHY.bold} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                    {formatMBRN(mbrnNeeded)} MBRN
                                </Text>
                            </HStack>
                        </VStack>
                    </Box>
                )}

                {mbrnAmount >= MAX_MBRN && (
                    <Box
                        mt={SPACING.sm}
                        p={SPACING.md}
                        bg={SEMANTIC_COLORS.bgTertiary}
                        borderRadius={0}
                        border="1px solid"
                        borderColor={SEMANTIC_COLORS.success}
                    >
                        <Text fontSize="sm" color={SEMANTIC_COLORS.success} fontFamily={TYPOGRAPHY.fontMono} textAlign="center">
                            Maximum Boost Achieved! (100M MBRN = 100% boost)
                        </Text>
                    </Box>
                )}

            </VStack>
        </Card>
    )
}
