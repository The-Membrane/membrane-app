import React, { useState } from 'react'
import {
    Box,
    Text,
    VStack,
    HStack,
    Icon,
    Popover,
    PopoverTrigger,
    PopoverContent,
    PopoverBody,
    Divider,
} from '@chakra-ui/react'
import { ChevronDown } from 'lucide-react'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useBoostBreakdown } from './hooks/useBoostBreakdown'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'

const formatMBRN = (amount: string) => {
    return shiftDigits(amount, -6).toFixed(2)
}

export const BoostBreakdown: React.FC = () => {
    const { data: breakdown, isLoading } = useBoostBreakdown()
    const [isOpen, setIsOpen] = useState(false)

    const boostPercent = breakdown
        ? num(breakdown.totalBoost).times(100).toFixed(2)
        : '0.00'

    // Show default breakdown if no data
    const displayBreakdown = breakdown || {
        totalBoost: '0',
        staking: {
            baseMBRN: '0',
            lockedDeposits: [],
            totalEffectiveMBRN: '0',
        },
        ltvDisco: {
            baseMBRN: '0',
            lockedDeposits: [],
            totalEffectiveMBRN: '0',
        },
    }

    return (
        <Box
            position="relative"
            onMouseEnter={() => setIsOpen(true)}
            onMouseLeave={() => setIsOpen(false)}
        >
            <Popover
                isOpen={isOpen}
                onOpen={() => setIsOpen(true)}
                onClose={() => setIsOpen(false)}
                placement="bottom-end"
                closeOnBlur={true}
            >
                <PopoverTrigger>
                    <Box
                        cursor="pointer"
                        px={SPACING.base}
                        py={SPACING.sm}
                        border="1px solid"
                        borderColor={SEMANTIC_COLORS.borderMedium}
                        borderRadius={0}
                        bg={SEMANTIC_COLORS.bgSecondary}
                        onClick={() => setIsOpen(!isOpen)}
                        transition={TRANSITIONS.colors}
                        _hover={HOVER_EFFECTS.borderHighlight}
                        _focus={FOCUS_STYLES.ring}
                    >
                    <HStack spacing={SPACING.sm}>
                        <Text
                            fontSize="lg"
                            fontWeight={TYPOGRAPHY.bold}
                            color={SEMANTIC_COLORS.primary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            sx={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                            {boostPercent}%
                        </Text>
                        <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono} textTransform="uppercase">
                            BOOST
                        </Text>
                        <Icon
                            as={ChevronDown}
                            w={4}
                            h={4}
                            color={SEMANTIC_COLORS.textSecondary}
                            transform={isOpen ? 'rotate(180deg)' : 'rotate(0deg)'}
                            transition="transform 0.2s"
                        />
                    </HStack>
                </Box>
            </PopoverTrigger>
            <PopoverContent
                bg={SEMANTIC_COLORS.bgSecondary}
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderMedium}
                borderRadius={0}
                w="400px"
                maxH="600px"
                overflowY="auto"
            >
                <PopoverBody p={SPACING.lg}>
                    <VStack align="stretch" spacing={SPACING.base}>
                        {/* Header */}
                        <VStack align="start" spacing={SPACING.xs}>
                            <Text
                                fontSize="xl"
                                fontWeight={TYPOGRAPHY.bold}
                                color={SEMANTIC_COLORS.textPrimary}
                                fontFamily={TYPOGRAPHY.fontMono}
                                textTransform="uppercase"
                            >
                                Boost Breakdown
                            </Text>
                            <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                Total Boost: {boostPercent}%
                            </Text>
                        </VStack>

                        <Divider borderColor={SEMANTIC_COLORS.borderMedium} />

                        {/* Staking Section */}
                        <VStack align="stretch" spacing={SPACING.md}>
                            <Text
                                fontSize="sm"
                                fontWeight={TYPOGRAPHY.bold}
                                color={SEMANTIC_COLORS.info}
                                fontFamily={TYPOGRAPHY.fontMono}
                                textTransform="uppercase"
                            >
                                Staking
                            </Text>
                            <VStack align="stretch" spacing={SPACING.sm} pl={SPACING.base}>
                                <HStack justify="space-between">
                                    <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                                        Base MBRN
                                    </Text>
                                        <Text fontSize="xs" color={SEMANTIC_COLORS.textPrimary} fontFamily={TYPOGRAPHY.fontMono} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                            {formatMBRN(displayBreakdown.staking.baseMBRN)} MBRN
                                        </Text>
                                    </HStack>
                                    {displayBreakdown.staking.lockedDeposits.length > 0 && (
                                        <>
                                            <Text fontSize="xs" color={SEMANTIC_COLORS.textTertiary} fontFamily={TYPOGRAPHY.fontMono} mt={SPACING.sm}>
                                                Locked Deposits:
                                            </Text>
                                            {displayBreakdown.staking.lockedDeposits.map((deposit, idx) => (
                                            <Box
                                                key={`${deposit.lockedUntil}-${deposit.amount}`}
                                                pl={SPACING.sm}
                                                borderLeft="1px solid"
                                                borderColor={SEMANTIC_COLORS.borderStrong}
                                                py={SPACING.xs}
                                            >
                                                <HStack justify="space-between" mb={SPACING.xs}>
                                                    <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                                                        Deposit
                                                    </Text>
                                                    <Text fontSize="xs" color={SEMANTIC_COLORS.textPrimary} fontFamily={TYPOGRAPHY.fontMono} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                                        {formatMBRN(deposit.amount)} MBRN
                                                    </Text>
                                                </HStack>
                                                <HStack justify="space-between" mb={SPACING.xs}>
                                                    <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                                                        Lock Duration
                                                    </Text>
                                                    <Text fontSize="xs" color={SEMANTIC_COLORS.info} fontFamily={TYPOGRAPHY.fontMono} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                                        {deposit.daysRemaining} days
                                                    </Text>
                                                </HStack>
                                                <HStack justify="space-between">
                                                    <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                                                        Boost Contribution
                                                    </Text>
                                                    <Text fontSize="xs" color={SEMANTIC_COLORS.info} fontFamily={TYPOGRAPHY.fontMono} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                                        +{formatMBRN(deposit.boostAmount)} MBRN
                                                    </Text>
                                                </HStack>
                                            </Box>
                                        ))}
                                    </>
                                )}
                                <Divider borderColor={SEMANTIC_COLORS.borderMedium} mt={SPACING.sm} />
                                <HStack justify="space-between">
                                    <Text fontSize="xs" fontWeight={TYPOGRAPHY.bold} color={SEMANTIC_COLORS.textPrimary} fontFamily={TYPOGRAPHY.fontMono}>
                                        Total Effective MBRN
                                    </Text>
                                        <Text fontSize="xs" fontWeight={TYPOGRAPHY.bold} color={SEMANTIC_COLORS.info} fontFamily={TYPOGRAPHY.fontMono} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                            {formatMBRN(displayBreakdown.staking.totalEffectiveMBRN)} MBRN
                                        </Text>
                                    </HStack>
                                </VStack>
                            </VStack>

                            <Divider borderColor={SEMANTIC_COLORS.borderMedium} />

                            {/* LTV Disco Section */}
                            <VStack align="stretch" spacing={SPACING.md}>
                                <Text
                                    fontSize="sm"
                                    fontWeight={TYPOGRAPHY.bold}
                                    color={SEMANTIC_COLORS.primary}
                                    fontFamily={TYPOGRAPHY.fontMono}
                                    textTransform="uppercase"
                                >
                                    LTV Disco
                                </Text>
                                <VStack align="stretch" spacing={SPACING.sm} pl={SPACING.base}>
                                    <HStack justify="space-between">
                                        <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                                            Base MBRN
                                        </Text>
                                        <Text fontSize="xs" color={SEMANTIC_COLORS.textPrimary} fontFamily={TYPOGRAPHY.fontMono} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                            {formatMBRN(displayBreakdown.ltvDisco.baseMBRN)} MBRN
                                        </Text>
                                    </HStack>
                                    {displayBreakdown.ltvDisco.lockedDeposits.length > 0 && (
                                        <>
                                            <Text fontSize="xs" color={SEMANTIC_COLORS.textTertiary} fontFamily={TYPOGRAPHY.fontMono} mt={SPACING.sm}>
                                                Locked Deposits:
                                            </Text>
                                            {displayBreakdown.ltvDisco.lockedDeposits.map((deposit, idx) => (
                                            <Box
                                                key={`${deposit.lockedUntil}-${deposit.amount}`}
                                                pl={SPACING.sm}
                                                borderLeft="1px solid"
                                                borderColor={SEMANTIC_COLORS.borderStrong}
                                                py={SPACING.xs}
                                            >
                                                <HStack justify="space-between" mb={SPACING.xs}>
                                                    <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                                                        Deposit
                                                    </Text>
                                                    <Text fontSize="xs" color={SEMANTIC_COLORS.textPrimary} fontFamily={TYPOGRAPHY.fontMono} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                                        {formatMBRN(deposit.amount)} MBRN
                                                    </Text>
                                                </HStack>
                                                <HStack justify="space-between" mb={SPACING.xs}>
                                                    <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                                                        Lock Duration
                                                    </Text>
                                                    <Text fontSize="xs" color={SEMANTIC_COLORS.info} fontFamily={TYPOGRAPHY.fontMono} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                                        {deposit.daysRemaining} days
                                                    </Text>
                                                </HStack>
                                                <HStack justify="space-between">
                                                    <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                                                        Boost Contribution
                                                    </Text>
                                                    <Text fontSize="xs" color={SEMANTIC_COLORS.info} fontFamily={TYPOGRAPHY.fontMono} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                                        +{formatMBRN(deposit.boostAmount)} MBRN
                                                    </Text>
                                                </HStack>
                                            </Box>
                                        ))}
                                    </>
                                )}
                                <Divider borderColor={SEMANTIC_COLORS.borderMedium} mt={SPACING.sm} />
                                <HStack justify="space-between">
                                    <Text fontSize="xs" fontWeight={TYPOGRAPHY.bold} color={SEMANTIC_COLORS.textPrimary} fontFamily={TYPOGRAPHY.fontMono}>
                                        Total Effective MBRN
                                    </Text>
                                    <Text fontSize="xs" fontWeight={TYPOGRAPHY.bold} color={SEMANTIC_COLORS.primary} fontFamily={TYPOGRAPHY.fontMono} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                        {formatMBRN(displayBreakdown.ltvDisco.totalEffectiveMBRN)} MBRN
                                    </Text>
                                </HStack>
                            </VStack>
                        </VStack>
                    </VStack>
                </PopoverBody>
            </PopoverContent>
        </Popover>
        </Box>
    )
}
