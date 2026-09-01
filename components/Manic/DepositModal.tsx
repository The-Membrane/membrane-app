import React, { useState, ChangeEvent } from 'react'
import {
    Box,
    VStack,
    HStack,
    Input,
    Text,
    Image,
    Button,
    IconButton
} from '@chakra-ui/react'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { m, AnimatePresence } from 'framer-motion'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useChainRoute } from '@/hooks/useChainRoute'
import { Formatter } from '@/helpers/formatter'
import { num } from '@/helpers/num'
import { CloseIcon } from '@chakra-ui/icons'

interface DepositCardProps {
    isOpen: boolean
    onClose: () => void
    onDeposit: (amount: string) => void
    inline?: boolean
    hideUsdValue?: boolean
}

export const DepositCard: React.FC<DepositCardProps> = ({
    isOpen,
    onClose,
    onDeposit,
    inline = false,
    hideUsdValue = false,
}) => {
    const { chainName } = useChainRoute()
    const usdcAsset = useAssetBySymbol('USDC', chainName)
    const usdcBalance = useBalanceByAsset(usdcAsset)
    const [amount, setAmount] = useState('')

    const handleAmountChange = (e: ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value
        // Allow empty string, numbers, and one decimal point
        if (value === '' || /^\d*\.?\d*$/.test(value)) {
            setAmount(value)
        }
    }

    const handleMaxClick = () => {
        setAmount(usdcBalance.toString())
    }

    const handleMaxKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleMaxClick()
        }
    }

    const handleDeposit = () => {
        if (amount && parseFloat(amount) > 0) {
            onDeposit(amount)
            setAmount('')
        }
    }

    // USDC price is typically 1, but get from oracle if available
    const usdcPrice = 1 // USDC is typically $1
    const usdValue = num(amount || 0).times(usdcPrice).toFixed(2)

    return (
        <m.div
            key="deposit-card"
            initial={{ opacity: 0, scale: inline ? 1 : 0.3 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: inline ? 1 : 0.3 }}
            transition={{
                duration: 0.4,
                ease: [0.16, 1, 0.3, 1],
                opacity: { duration: 0.3 },
                scale: { duration: 0.4 }
            }}
            style={{
                position: inline ? 'relative' : 'absolute',
                transformOrigin: 'center center',
                width: inline ? '100%' : '500px',
                zIndex: inline ? 1 : 30
            }}
        >
            <Box
                bg={SEMANTIC_COLORS.bgSecondary}
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderStrong}
                borderRadius={0}
                p={SPACING.lg}
                position="relative"
            >
                {/* Close button */}
                <Box position="absolute" top={SPACING.base} right={SPACING.base} width="15%" display="flex" justifyContent="flex-end">
                    <IconButton
                        aria-label="Close"
                        icon={<CloseIcon />}
                        size="sm"
                        variant="ghost"
                        color={SEMANTIC_COLORS.textSecondary}
                        onClick={onClose}
                        transition={TRANSITIONS.colors}
                        _hover={HOVER_EFFECTS.brighten}
                        _active={ACTIVE_EFFECTS.dim}
                        _focus={FOCUS_STYLES.ring}
                    />
                </Box>

                <VStack spacing={SPACING.lg} align="stretch">
                    {/* Header */}
                    <Text
                        fontSize={TYPOGRAPHY.h3}
                        fontWeight={TYPOGRAPHY.bold}
                        color={SEMANTIC_COLORS.textPrimary}
                        fontFamily={TYPOGRAPHY.fontDisplay}
                    >
                        Deposit USDC
                    </Text>

                    {/* Amount input section */}
                    <Box
                        w="100%"
                        bg={SEMANTIC_COLORS.bgTertiary}
                        border="1px solid"
                        borderColor={SEMANTIC_COLORS.borderSubtle}
                        borderRadius={0}
                        p={SPACING.base}
                    >
                        <HStack justify="space-between" align="flex-start" w="100%">
                            <VStack align="flex-start" spacing={SPACING.xs} flex={1}>
                                <Text
                                    color={SEMANTIC_COLORS.textSecondary}
                                    fontSize={TYPOGRAPHY.label}
                                    fontFamily={TYPOGRAPHY.fontMono}
                                    fontWeight={TYPOGRAPHY.medium}
                                    textTransform="uppercase"
                                    letterSpacing="0.28em"
                                >
                                    Deposit Amount
                                </Text>
                                <Input
                                    variant="unstyled"
                                    fontSize="3xl"
                                    fontWeight={TYPOGRAPHY.bold}
                                    fontFamily={TYPOGRAPHY.fontMono}
                                    color={SEMANTIC_COLORS.textPrimary}
                                    sx={{ fontVariantNumeric: 'tabular-nums' }}
                                    value={amount}
                                    onChange={handleAmountChange}
                                    type="text"
                                    placeholder="0"
                                    w="100%"
                                    borderRadius={0}
                                    _placeholder={{ color: SEMANTIC_COLORS.textTertiary }}
                                    _focus={FOCUS_STYLES.ring}
                                    paddingInlineEnd="3"
                                    autoFocus
                                />
                                {!hideUsdValue && (
                                    <Text
                                        color={SEMANTIC_COLORS.textSecondary}
                                        fontSize={TYPOGRAPHY.small}
                                        fontFamily={TYPOGRAPHY.fontMono}
                                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                                    >
                                        ~ ${usdValue}
                                    </Text>
                                )}
                            </VStack>
                            <VStack align="flex-end" spacing={SPACING.sm}>
                                <HStack
                                    bg={SEMANTIC_COLORS.bgSecondary}
                                    border="1px solid"
                                    borderColor={SEMANTIC_COLORS.borderSubtle}
                                    borderRadius="full"
                                    px={SPACING.md}
                                    py={SPACING.xs}
                                    spacing={SPACING.sm}
                                >
                                    {usdcAsset?.logo && (
                                        <Image
                                            src={usdcAsset.logo}
                                            alt="USDC"
                                            boxSize="24px"
                                        />
                                    )}
                                    <Text
                                        color={SEMANTIC_COLORS.textPrimary}
                                        fontWeight={TYPOGRAPHY.bold}
                                        fontFamily={TYPOGRAPHY.fontMono}
                                    >
                                        USDC
                                    </Text>
                                </HStack>
                                <VStack
                                    role="button"
                                    tabIndex={0}
                                    aria-label="Use full wallet balance"
                                    cursor="pointer"
                                    onClick={handleMaxClick}
                                    onKeyDown={handleMaxKeyDown}
                                    transition={TRANSITIONS.colors}
                                    _focus={FOCUS_STYLES.ring}
                                    sx={{
                                        '&:hover > .wallet-hover-text': {
                                            textDecoration: 'underline',
                                            color: SEMANTIC_COLORS.primary,
                                        },
                                    }}
                                >
                                    <Text
                                        className="wallet-hover-text"
                                        color={SEMANTIC_COLORS.textSecondary}
                                        fontSize={TYPOGRAPHY.small}
                                        fontFamily={TYPOGRAPHY.fontMono}
                                    >
                                        Wallet
                                    </Text>
                                    <Text
                                        className="wallet-hover-text"
                                        color={SEMANTIC_COLORS.textSecondary}
                                        fontSize={TYPOGRAPHY.small}
                                        fontFamily={TYPOGRAPHY.fontMono}
                                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                                    >
                                        {Formatter.toNearestNonZero(usdcBalance)}
                                    </Text>
                                </VStack>
                            </VStack>
                        </HStack>
                    </Box>

                    {/* Deposit button */}
                    <Button
                        size="lg"
                        isDisabled={!amount || parseFloat(amount) <= 0 || parseFloat(amount) > Number(usdcBalance)}
                        onClick={handleDeposit}
                        transition={TRANSITIONS.colors}
                        _active={ACTIVE_EFFECTS.dim}
                        _focus={FOCUS_STYLES.ring}
                    >
                        Deposit
                    </Button>
                </VStack>
            </Box>
        </m.div>
    )
}

interface WithdrawCardProps {
    isOpen: boolean
    onClose: () => void
    onWithdraw: (amount: string) => void
    inline?: boolean
    tvlAmount?: number // TVL amount to use as max
}

export const WithdrawCard: React.FC<WithdrawCardProps> = ({
    isOpen,
    onClose,
    onWithdraw,
    inline = false,
    tvlAmount = 0,
}) => {
    const { chainName } = useChainRoute()
    const usdcAsset = useAssetBySymbol('USDC', chainName)
    const [amount, setAmount] = useState('')

    const handleAmountChange = (e: ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value
        // Allow empty string, numbers, and one decimal point
        if (value === '' || /^\d*\.?\d*$/.test(value)) {
            setAmount(value)
        }
    }

    const handleMaxClick = () => {
        setAmount(tvlAmount.toString())
    }

    const handleMaxKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleMaxClick()
        }
    }

    const handleWithdraw = () => {
        if (amount && parseFloat(amount) > 0) {
            onWithdraw(amount)
            setAmount('')
        }
    }

    // USDC price is typically 1, but get from oracle if available
    const usdcPrice = 1 // USDC is typically $1
    const usdValue = num(amount || 0).times(usdcPrice).toFixed(2)

    return (
        <m.div
            key="withdraw-card"
            initial={{ opacity: 0, scale: inline ? 1 : 0.3 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: inline ? 1 : 0.3 }}
            transition={{
                duration: 0.4,
                ease: [0.16, 1, 0.3, 1],
                opacity: { duration: 0.3 },
                scale: { duration: 0.4 }
            }}
            style={{
                position: inline ? 'relative' : 'absolute',
                transformOrigin: 'center center',
                width: inline ? '100%' : '500px',
                zIndex: inline ? 1 : 30
            }}
        >
            <Box
                bg={SEMANTIC_COLORS.bgSecondary}
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderStrong}
                borderRadius={0}
                p={SPACING.lg}
                position="relative"
            >
                {/* Close button */}
                <Box position="absolute" top={SPACING.base} right={SPACING.base} width="15%" display="flex" justifyContent="flex-end">
                    <IconButton
                        aria-label="Close"
                        icon={<CloseIcon />}
                        size="sm"
                        variant="ghost"
                        color={SEMANTIC_COLORS.textSecondary}
                        onClick={onClose}
                        transition={TRANSITIONS.colors}
                        _hover={HOVER_EFFECTS.brighten}
                        _active={ACTIVE_EFFECTS.dim}
                        _focus={FOCUS_STYLES.ring}
                    />
                </Box>

                <VStack spacing={SPACING.lg} align="stretch">
                    {/* Header */}
                    <Text
                        fontSize={TYPOGRAPHY.h3}
                        fontWeight={TYPOGRAPHY.bold}
                        color={SEMANTIC_COLORS.textPrimary}
                        fontFamily={TYPOGRAPHY.fontDisplay}
                    >
                        Withdraw USDC
                    </Text>

                    {/* Amount input section */}
                    <Box
                        w="100%"
                        bg={SEMANTIC_COLORS.bgTertiary}
                        border="1px solid"
                        borderColor={SEMANTIC_COLORS.borderSubtle}
                        borderRadius={0}
                        p={SPACING.base}
                    >
                        <HStack justify="space-between" align="flex-start" w="100%">
                            <VStack align="flex-start" spacing={SPACING.xs} flex={1}>
                                <Text
                                    color={SEMANTIC_COLORS.textSecondary}
                                    fontSize={TYPOGRAPHY.label}
                                    fontFamily={TYPOGRAPHY.fontMono}
                                    fontWeight={TYPOGRAPHY.medium}
                                    textTransform="uppercase"
                                    letterSpacing="0.28em"
                                >
                                    Withdraw Amount
                                </Text>
                                <Input
                                    variant="unstyled"
                                    fontSize="3xl"
                                    fontWeight={TYPOGRAPHY.bold}
                                    fontFamily={TYPOGRAPHY.fontMono}
                                    color={SEMANTIC_COLORS.textPrimary}
                                    sx={{ fontVariantNumeric: 'tabular-nums' }}
                                    value={amount}
                                    onChange={handleAmountChange}
                                    type="text"
                                    placeholder="0"
                                    w="100%"
                                    borderRadius={0}
                                    _placeholder={{ color: SEMANTIC_COLORS.textTertiary }}
                                    _focus={FOCUS_STYLES.ring}
                                    paddingInlineEnd="3"
                                    autoFocus
                                />
                                <Text
                                    color={SEMANTIC_COLORS.textSecondary}
                                    fontSize={TYPOGRAPHY.small}
                                    fontFamily={TYPOGRAPHY.fontMono}
                                    sx={{ fontVariantNumeric: 'tabular-nums' }}
                                >
                                    ~ ${usdValue}
                                </Text>
                            </VStack>
                            <VStack align="flex-end" spacing={SPACING.sm}>
                                <HStack
                                    bg={SEMANTIC_COLORS.bgSecondary}
                                    border="1px solid"
                                    borderColor={SEMANTIC_COLORS.borderSubtle}
                                    borderRadius="full"
                                    px={SPACING.md}
                                    py={SPACING.xs}
                                    spacing={SPACING.sm}
                                >
                                    {usdcAsset?.logo && (
                                        <Image
                                            src={usdcAsset.logo}
                                            alt="USDC"
                                            boxSize="24px"
                                        />
                                    )}
                                    <Text
                                        color={SEMANTIC_COLORS.textPrimary}
                                        fontWeight={TYPOGRAPHY.bold}
                                        fontFamily={TYPOGRAPHY.fontMono}
                                    >
                                        USDC
                                    </Text>
                                </HStack>
                                <VStack
                                    role="button"
                                    tabIndex={0}
                                    aria-label="Use full TVL amount"
                                    cursor="pointer"
                                    onClick={handleMaxClick}
                                    onKeyDown={handleMaxKeyDown}
                                    transition={TRANSITIONS.colors}
                                    _focus={FOCUS_STYLES.ring}
                                    sx={{
                                        '&:hover > .tvl-hover-text': {
                                            textDecoration: 'underline',
                                            color: SEMANTIC_COLORS.primary,
                                        },
                                    }}
                                >
                                    <Text
                                        className="tvl-hover-text"
                                        color={SEMANTIC_COLORS.textSecondary}
                                        fontSize={TYPOGRAPHY.small}
                                        fontFamily={TYPOGRAPHY.fontMono}
                                    >
                                        TVL
                                    </Text>
                                    <Text
                                        className="tvl-hover-text"
                                        color={SEMANTIC_COLORS.textSecondary}
                                        fontSize={TYPOGRAPHY.small}
                                        fontFamily={TYPOGRAPHY.fontMono}
                                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                                    >
                                        {Formatter.toNearestNonZero(tvlAmount)}
                                    </Text>
                                </VStack>
                            </VStack>
                        </HStack>
                    </Box>

                    {/* Withdraw button */}
                    <Button
                        size="lg"
                        isDisabled={!amount || parseFloat(amount) <= 0 || parseFloat(amount) > tvlAmount}
                        onClick={handleWithdraw}
                        transition={TRANSITIONS.colors}
                        _active={ACTIVE_EFFECTS.dim}
                        _focus={FOCUS_STYLES.ring}
                    >
                        Withdraw
                    </Button>
                </VStack>
            </Box>
        </m.div>
    )
}
