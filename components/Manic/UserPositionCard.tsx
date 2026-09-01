import React, { useMemo } from 'react'
import {
    Box,
    Card,
    VStack,
    HStack,
    Text,
    Button,
    Progress,
    Tooltip,
    IconButton,
} from '@chakra-ui/react'
import { InfoIcon } from '@chakra-ui/icons'
import { m, AnimatePresence } from 'framer-motion'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { DepositCard } from './DepositModal'
import { BoostBreakdown } from './BoostBreakdown'

const MotionBox = m(Box)
const MotionVStack = m(VStack)

interface UserPositionCardProps {
    hasPosition: boolean
    collateralAmount: number
    debtAmount: number
    userAPR: number
    baseAPR: number
    isDepositOpen: boolean
    onDepositClick: () => void
    onDeposit: (amount: string) => void
    onCloseDeposit: () => void
}

export const UserPositionCard: React.FC<UserPositionCardProps> = ({
    hasPosition,
    collateralAmount,
    debtAmount,
    userAPR,
    baseAPR,
    isDepositOpen,
    onDepositClick,
    onDeposit,
    onCloseDeposit,
}) => {
    // Calculate current loop level: collateral / (collateral - debt)
    const currentLoopLevel = useMemo(() => {
        if (!hasPosition || collateralAmount <= 0) return 1
        const equity = collateralAmount - debtAmount
        if (equity <= 0) return 10 // Max loop level if no equity
        return Math.min(collateralAmount / equity, 10)
    }, [hasPosition, collateralAmount, debtAmount])

    // Calculate current LTV for health indicator
    const currentLTV = useMemo(() => {
        if (!hasPosition || collateralAmount <= 0) return 0
        return (debtAmount / collateralAmount) * 100
    }, [hasPosition, collateralAmount, debtAmount])

    // Health indicator: Phosphor < 60%, Gold 60-80%, Blood > 80%
    const healthColor = useMemo(() => {
        if (currentLTV < 60) return SEMANTIC_COLORS.success
        if (currentLTV < 80) return SEMANTIC_COLORS.warning
        return SEMANTIC_COLORS.danger
    }, [currentLTV])

    const healthLabel = useMemo(() => {
        if (currentLTV < 60) return 'Healthy'
        if (currentLTV < 80) return 'Moderate'
        return 'At Risk'
    }, [currentLTV])

    // Empty state - no position
    if (!hasPosition) {
        return (
            <MotionBox
                layout
                transition={{ duration: 0.3, ease: "easeInOut" }}
            >
                <Card
                    borderRadius={0}
                    p={SPACING.xl}
                    w="100%"
                    overflow="hidden"
                >
                    <MotionVStack
                        spacing={SPACING.lg}
                        align="center"
                        layout
                        transition={{ duration: 0.3, ease: "easeInOut" }}
                    >
                        <VStack spacing={SPACING.sm}>
                            <AnimatePresence mode="wait">
                                {!isDepositOpen && (
                                    <MotionBox
                                        key="title"
                                        // Auto-height reveal: scaleY would squash the text,
                                        // so animate grid-template-rows 0fr→1fr — the grid row
                                        // drives the reveal (no per-frame box layout) and the
                                        // content clips instead of distorting (react.doctor
                                        // Case C recipe for unknown-size reveals).
                                        initial={{ opacity: 0, gridTemplateRows: '0fr' }}
                                        animate={{ opacity: 1, gridTemplateRows: '1fr' }}
                                        exit={{ opacity: 0, gridTemplateRows: '0fr' }}
                                        transition={{ duration: 0.2 }}
                                        display="grid"
                                        overflow="hidden"
                                    >
                                        <Box minH={0} overflow="hidden">
                                        <Text
                                            fontSize={TYPOGRAPHY.h3}
                                            fontWeight={TYPOGRAPHY.bold}
                                            color={SEMANTIC_COLORS.textSecondary}
                                            fontFamily={TYPOGRAPHY.fontDisplay}
                                        >
                                            No Position Found
                                        </Text>
                                        </Box>
                                    </MotionBox>
                                )}
                            </AnimatePresence>
                            <Text
                                fontSize={TYPOGRAPHY.small}
                                color={SEMANTIC_COLORS.textTertiary}
                                fontFamily={TYPOGRAPHY.fontMono}
                                textAlign="center"
                            >
                                Deposit USDC to enable looping
                            </Text>
                        </VStack>

                        <AnimatePresence mode="wait">
                            {isDepositOpen ? (
                                <MotionBox
                                    key="deposit-form"
                                    w="100%"
                                    maxW="500px"
                                    // Auto-height reveal of a form: scaleY would squash the
                                    // inputs, so animate grid-template-rows 0fr→1fr — the grid
                                    // row drives the reveal (no per-frame box layout) and the
                                    // form clips instead of distorting (react.doctor Case C).
                                    initial={{ opacity: 0, gridTemplateRows: '0fr' }}
                                    animate={{ opacity: 1, gridTemplateRows: '1fr' }}
                                    exit={{ opacity: 0, gridTemplateRows: '0fr' }}
                                    transition={{ duration: 0.3, ease: "easeInOut" }}
                                    display="grid"
                                    overflow="hidden"
                                >
                                    <Box minH={0} overflow="hidden">
                                    <DepositCard
                                        isOpen={isDepositOpen}
                                        onClose={onCloseDeposit}
                                        onDeposit={onDeposit}
                                        inline={true}
                                        hideUsdValue={true}
                                    />
                                    </Box>
                                </MotionBox>
                            ) : (
                                <MotionBox
                                    key="deposit-button"
                                    initial={{ opacity: 0, scale: 0.9 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.9 }}
                                    transition={{ duration: 0.2 }}
                                >
                                    <Button
                                        size="lg"
                                        onClick={onDepositClick}
                                        w="20%"
                                        minW="150px"
                                        transition={TRANSITIONS.colors}
                                        _active={ACTIVE_EFFECTS.dim}
                                        _focus={FOCUS_STYLES.ring}
                                    >
                                        Deposit USDC
                                    </Button>
                                </MotionBox>
                            )}
                        </AnimatePresence>
                    </MotionVStack>
                </Card>
            </MotionBox>
        )
    }

    // Has position - show position details
    return (
        <Card
            borderRadius={0}
            p={SPACING_PATTERNS.modalPadding}
            w="100%"
        >
            <VStack spacing={SPACING.lg} align="stretch">
                {/* Header */}
                <HStack justify="space-between" align="center">
                    <HStack spacing={SPACING.sm}>
                        <Text
                            fontSize={TYPOGRAPHY.h4}
                            fontWeight={TYPOGRAPHY.bold}
                            color={SEMANTIC_COLORS.textPrimary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            textTransform="uppercase"
                            letterSpacing="0.12em"
                        >
                            Your Position
                        </Text>
                        <Tooltip
                            label="Your current USDC looping position. Loop level shows how leveraged your position is."
                            hasArrow
                        >
                            <IconButton
                                aria-label="Position Info"
                                icon={<InfoIcon />}
                                size="xs"
                                variant="ghost"
                                color={SEMANTIC_COLORS.textSecondary}
                                transition={TRANSITIONS.colors}
                                _hover={HOVER_EFFECTS.brighten}
                                _active={ACTIVE_EFFECTS.dim}
                                _focus={FOCUS_STYLES.ring}
                                minW="auto"
                                w="auto"
                                h="auto"
                            />
                        </Tooltip>
                    </HStack>
                    <BoostBreakdown />
                </HStack>

                {/* Position Stats Grid */}
                <HStack spacing={SPACING.lg} w="100%" justify="space-between">
                    {/* Deposited Amount */}
                    <VStack align="start" spacing={SPACING.xs} flex={1}>
                        <Text
                            fontSize={TYPOGRAPHY.label}
                            color={SEMANTIC_COLORS.textSecondary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            textTransform="uppercase"
                            letterSpacing="0.28em"
                        >
                            Deposited
                        </Text>
                        <Text
                            fontSize="2xl"
                            fontWeight={TYPOGRAPHY.bold}
                            color={SEMANTIC_COLORS.textPrimary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            sx={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                            {collateralAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC
                        </Text>
                    </VStack>

                    {/* Current Loop Level */}
                    <VStack align="start" spacing={SPACING.xs} flex={1}>
                        <Text
                            fontSize={TYPOGRAPHY.label}
                            color={SEMANTIC_COLORS.textSecondary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            textTransform="uppercase"
                            letterSpacing="0.28em"
                        >
                            Loop Level
                        </Text>
                        <Text
                            fontSize="2xl"
                            fontWeight={TYPOGRAPHY.bold}
                            color={SEMANTIC_COLORS.info}
                            fontFamily={TYPOGRAPHY.fontMono}
                            sx={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                            {currentLoopLevel.toFixed(1)}x
                        </Text>
                    </VStack>

                    {/* Current Net APR */}
                    <VStack align="start" spacing={SPACING.xs} flex={1}>
                        <Text
                            fontSize={TYPOGRAPHY.label}
                            color={SEMANTIC_COLORS.textSecondary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            textTransform="uppercase"
                            letterSpacing="0.28em"
                        >
                            Net APR
                        </Text>
                        <Text
                            fontSize="2xl"
                            fontWeight={TYPOGRAPHY.bold}
                            color={SEMANTIC_COLORS.success}
                            fontFamily={TYPOGRAPHY.fontMono}
                            sx={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                            {userAPR.toFixed(2)}%
                        </Text>
                    </VStack>

                    {/* Health Indicator */}
                    <VStack align="start" spacing={SPACING.xs} flex={1}>
                        <Text
                            fontSize={TYPOGRAPHY.label}
                            color={SEMANTIC_COLORS.textSecondary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            textTransform="uppercase"
                            letterSpacing="0.28em"
                        >
                            Health
                        </Text>
                        <VStack align="start" spacing={SPACING.xs} w="100%">
                            <HStack spacing={SPACING.sm}>
                                <Text
                                    fontSize={TYPOGRAPHY.h4}
                                    fontWeight={TYPOGRAPHY.bold}
                                    color={healthColor}
                                    fontFamily={TYPOGRAPHY.fontMono}
                                >
                                    {healthLabel}
                                </Text>
                                <Text
                                    fontSize={TYPOGRAPHY.small}
                                    color={SEMANTIC_COLORS.textTertiary}
                                    fontFamily={TYPOGRAPHY.fontMono}
                                    sx={{ fontVariantNumeric: 'tabular-nums' }}
                                >
                                    ({currentLTV.toFixed(0)}% LTV)
                                </Text>
                            </HStack>
                            <Progress
                                value={currentLTV}
                                max={100}
                                size="xs"
                                bg={SEMANTIC_COLORS.bgTertiary}
                                borderRadius={0}
                                w="100%"
                                sx={{ '& > div': { backgroundColor: healthColor } }}
                            />
                        </VStack>
                    </VStack>
                </HStack>
            </VStack>
        </Card>
    )
}
