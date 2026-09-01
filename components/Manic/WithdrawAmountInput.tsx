import React, { ChangeEvent } from 'react'
import { Box, HStack, VStack, Text, Input, Image } from '@chakra-ui/react'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Asset } from '@/helpers/chain'

interface WithdrawAmountInputProps {
    withdrawAmount: string
    handleWithdrawAmountChange: (e: ChangeEvent<HTMLInputElement>) => void
    usdWithdrawValue: string
    currentEquity: number
    usdcAsset: Asset | null
    handleMaxWithdrawClick: () => void
}

export const WithdrawAmountInput: React.FC<WithdrawAmountInputProps> = ({
    withdrawAmount,
    handleWithdrawAmountChange,
    usdWithdrawValue,
    currentEquity,
    usdcAsset,
    handleMaxWithdrawClick,
}) => {
    const handleMaxKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleMaxWithdrawClick()
        }
    }

    return (
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
                        fontSize="2xl"
                        fontWeight={TYPOGRAPHY.bold}
                        fontFamily={TYPOGRAPHY.fontMono}
                        color={SEMANTIC_COLORS.textPrimary}
                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                        value={withdrawAmount}
                        onChange={handleWithdrawAmountChange}
                        type="text"
                        placeholder="0"
                        aria-label="Withdraw amount"
                        w="100%"
                        borderRadius={0}
                        _placeholder={{ color: SEMANTIC_COLORS.textTertiary }}
                        _focus={FOCUS_STYLES.ring}
                        paddingInlineEnd="3"
                    />
                    <Text
                        color={SEMANTIC_COLORS.textSecondary}
                        fontSize={TYPOGRAPHY.small}
                        fontFamily={TYPOGRAPHY.fontMono}
                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                        ~ ${usdWithdrawValue}
                    </Text>
                    <Text
                        color={SEMANTIC_COLORS.textTertiary}
                        fontSize={TYPOGRAPHY.xs}
                        fontFamily={TYPOGRAPHY.fontMono}
                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                        Max: {currentEquity.toFixed(2)} USDC (available equity)
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
                                boxSize="20px"
                            />
                        )}
                        <Text
                            color={SEMANTIC_COLORS.textPrimary}
                            fontWeight={TYPOGRAPHY.bold}
                            fontSize={TYPOGRAPHY.small}
                            fontFamily={TYPOGRAPHY.fontMono}
                        >
                            USDC
                        </Text>
                    </HStack>
                    <VStack
                        role="button"
                        tabIndex={0}
                        aria-label="Use full available equity"
                        cursor="pointer"
                        onClick={handleMaxWithdrawClick}
                        onKeyDown={handleMaxKeyDown}
                        transition={TRANSITIONS.colors}
                        _focus={FOCUS_STYLES.ring}
                        sx={{
                            '&:hover > .equity-hover-text': {
                                textDecoration: 'underline',
                                color: SEMANTIC_COLORS.primary,
                            },
                        }}
                    >
                        <Text
                            className="equity-hover-text"
                            color={SEMANTIC_COLORS.textSecondary}
                            fontSize={TYPOGRAPHY.xs}
                            fontFamily={TYPOGRAPHY.fontMono}
                        >
                            Equity
                        </Text>
                        <Text
                            className="equity-hover-text"
                            color={SEMANTIC_COLORS.textSecondary}
                            fontSize={TYPOGRAPHY.xs}
                            fontFamily={TYPOGRAPHY.fontMono}
                            sx={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                            {currentEquity.toFixed(2)}
                        </Text>
                    </VStack>
                </VStack>
            </HStack>
        </Box>
    )
}
