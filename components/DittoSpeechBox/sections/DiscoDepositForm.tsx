import React, { useState, useMemo } from 'react'
import { VStack, Text, Box, HStack, Button, NumberInput, NumberInputField } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'
import { getAssetQueue, getCumulativeRevenue } from '@/services/disco'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import { shiftDigits } from '@/helpers/math'
import { getSlotLabel } from '@/components/Disco/types'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

interface DiscoDepositFormProps {
    deposit: {
        asset: string
        slot?: number
        apr?: number
    }
    walletBalanceMBRN: string
    onCancel: () => void
    onSubmit: (amount: string) => void
}

export const DiscoDepositForm: React.FC<DiscoDepositFormProps> = ({
    deposit,
    walletBalanceMBRN,
    onCancel,
    onSubmit,
}) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)
    const [amount, setAmount] = useState('')

    const handleMaxClick = () => {
        if (walletBalanceMBRN) {
            setAmount(walletBalanceMBRN)
        }
    }

    const handleSubmit = () => {
        if (!amount || parseFloat(amount) <= 0) return
        onSubmit(amount)
    }

    // Query asset queue to get slot TVL
    const slotQueueData = useQuery({
        queryKey: ['disco', 'slot_queue_deposit', deposit.asset, deposit.slot, appState.rpcUrl],
        queryFn: async () => {
            if (!client || !deposit.asset || !deposit.slot) return null

            try {
                const queueResponse = await getAssetQueue(client, deposit.asset)
                if (!queueResponse?.queue?.slots) return null

                const slot = queueResponse.queue.slots.find((s: any) => s.index === deposit.slot)
                if (!slot) return null

                return {
                    totalDepositTokens: slot.total_deposit_tokens || '0',
                    totalVaultTokens: slot.total_vault_tokens || '0',
                }
            } catch (error) {
                console.error('Error querying slot queue for deposit:', error)
                return null
            }
        },
        enabled: Boolean(client && deposit.asset && deposit.slot),
        staleTime: 1000 * 60 * 5,
    })

    // Query revenue for deposit's slot
    const revenueData = useQuery({
        queryKey: ['disco', 'slot_revenue_deposit', deposit.asset, deposit.slot, appState.rpcUrl],
        queryFn: async () => {
            if (!client || !deposit.asset || !deposit.slot) return null

            try {
                const revenueEntries = await getCumulativeRevenue(
                    client,
                    deposit.asset,
                    deposit.slot
                )

                if (!revenueEntries || !Array.isArray(revenueEntries) || revenueEntries.length === 0) {
                    return null
                }

                const sortedEntries = revenueEntries
                    .map((entry: any) => ({
                        timestamp: entry.timestamp || 0,
                        total_revenue: parseFloat(shiftDigits(entry.total_revenue || '0', -6).toString())
                    }))
                    .sort((a: any, b: any) => a.timestamp - b.timestamp)

                if (sortedEntries.length < 2) return null

                const firstEntry = sortedEntries[0]
                const lastEntry = sortedEntries[sortedEntries.length - 1]
                const currentTime = Math.floor(Date.now() / 1000)
                const daysActive = Math.max(1, (currentTime - firstEntry.timestamp) / 86400)
                const totalRevenue = lastEntry.total_revenue - firstEntry.total_revenue

                return {
                    totalRevenue,
                    daysActive,
                    dailyRevenue: daysActive > 0 ? totalRevenue / daysActive : 0
                }
            } catch (error) {
                console.error('Error querying revenue for deposit:', error)
                return null
            }
        },
        enabled: Boolean(client && deposit.asset && deposit.slot),
        staleTime: 1000 * 60 * 5,
    })

    // Calculate revenue per day using deposit amount share
    const revenuePerDay = useMemo(() => {
        if (!amount || parseFloat(amount) <= 0) return 0
        if (!slotQueueData.data || !revenueData.data) return 0

        const depositAmount = parseFloat(amount)
        const totalDeposit = parseFloat(shiftDigits(slotQueueData.data.totalDepositTokens, -6).toString())

        if (totalDeposit <= 0 || depositAmount <= 0) return 0

        const userShare = depositAmount / totalDeposit
        return revenueData.data.dailyRevenue * userShare
    }, [amount, slotQueueData.data, revenueData.data])

    return (
        <VStack spacing={SPACING.base} align="stretch">
            {/* Section Details Display */}
            <Box
                bg={SEMANTIC_COLORS.bgTertiary}
                p={SPACING.md}
                borderRadius={0}
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
            >
                <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.label}
                    fontWeight={TYPOGRAPHY.bold}
                    color={SEMANTIC_COLORS.textSecondary}
                    letterSpacing="0.28em"
                    mb={SPACING.sm}
                    textTransform="uppercase"
                >
                    Slot Details
                </Text>
                <VStack spacing={SPACING.sm} align="stretch">
                    <HStack justify="space-between">
                        <Text
                            fontSize={TYPOGRAPHY.xs}
                            color={SEMANTIC_COLORS.textSecondary}
                            fontFamily={TYPOGRAPHY.fontMono}
                        >
                            Risk Slot
                        </Text>
                        <Text
                            fontSize={TYPOGRAPHY.xs}
                            fontWeight={TYPOGRAPHY.bold}
                            color={SEMANTIC_COLORS.textPrimary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            sx={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                            {deposit.slot ? `Slot ${getSlotLabel(deposit.slot || 0)}` : 'N/A'}
                        </Text>
                    </HStack>
                    <HStack justify="space-between">
                        <Text
                            fontSize={TYPOGRAPHY.xs}
                            color={SEMANTIC_COLORS.textSecondary}
                            fontFamily={TYPOGRAPHY.fontMono}
                        >
                            APR
                        </Text>
                        <Text
                            fontSize={TYPOGRAPHY.xs}
                            fontWeight={TYPOGRAPHY.bold}
                            color={deposit.apr ? SEMANTIC_COLORS.info : SEMANTIC_COLORS.textTertiary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            sx={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                            {deposit.apr ? `${deposit.apr.toFixed(2)}%` : 'N/A'}
                        </Text>
                    </HStack>
                </VStack>
            </Box>

            {/* Amount Input */}
            <Box>
                <HStack justify="space-between" mb={SPACING.sm}>
                    <Text
                        fontSize={TYPOGRAPHY.label}
                        color={SEMANTIC_COLORS.textSecondary}
                        fontFamily={TYPOGRAPHY.fontMono}
                        textTransform="uppercase"
                        letterSpacing="0.28em"
                    >
                        Amount (MBRN)
                    </Text>
                    <Text
                        as="button"
                        type="button"
                        fontSize={TYPOGRAPHY.xs}
                        color={SEMANTIC_COLORS.primary}
                        fontFamily={TYPOGRAPHY.fontMono}
                        letterSpacing="0.05em"
                        cursor="pointer"
                        aria-label="Use full wallet balance"
                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                        transition={TRANSITIONS.colors}
                        _hover={{ textDecoration: 'underline' }}
                        _focus={FOCUS_STYLES.ring}
                        _focusVisible={FOCUS_STYLES.ring}
                        onClick={handleMaxClick}
                    >
                        Wallet: {parseFloat(walletBalanceMBRN || '0').toLocaleString('en-US')}
                    </Text>
                </HStack>
                <NumberInput
                    value={amount}
                    onChange={(valueString) => setAmount(valueString)}
                    min={0}
                    max={parseFloat(walletBalanceMBRN || '0')}
                >
                    <NumberInputField
                        bg={SEMANTIC_COLORS.bgSecondary}
                        border="1px solid"
                        borderRadius={0}
                        borderColor={SEMANTIC_COLORS.borderSubtle}
                        color={SEMANTIC_COLORS.textPrimary}
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.small}
                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                        transition={TRANSITIONS.colors}
                        _hover={HOVER_EFFECTS.borderHighlight}
                        _focus={FOCUS_STYLES.ring}
                        _focusVisible={FOCUS_STYLES.ring}
                        placeholder="0.00"
                        autoFocus
                    />
                </NumberInput>
            </Box>

            {/* Revenue per Day and Action Buttons */}
            <VStack spacing={SPACING.sm} align="stretch">
                <Text
                    fontSize={TYPOGRAPHY.xs}
                    color={revenuePerDay > 0 ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.textTertiary}
                    fontFamily={TYPOGRAPHY.fontMono}
                    letterSpacing="0.05em"
                    textAlign="center"
                    sx={{ fontVariantNumeric: 'tabular-nums' }}
                >
                    +{revenuePerDay.toFixed(4)} CDT/day
                </Text>
                <HStack spacing={SPACING.sm}>
                    <Button
                        flex={1}
                        size="sm"
                        variant="outline"
                        borderRadius={0}
                        borderColor={SEMANTIC_COLORS.borderSubtle}
                        color={SEMANTIC_COLORS.textSecondary}
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.xs}
                        transition={TRANSITIONS.colors}
                        _hover={HOVER_EFFECTS.borderHighlight}
                        _active={ACTIVE_EFFECTS.dim}
                        _focus={FOCUS_STYLES.ring}
                        _focusVisible={FOCUS_STYLES.ring}
                        onClick={onCancel}
                    >
                        Cancel
                    </Button>
                    <Button
                        flex={1}
                        size="sm"
                        borderRadius={0}
                        bg={SEMANTIC_COLORS.primary}
                        color={SEMANTIC_COLORS.bgPrimary}
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.xs}
                        fontWeight={TYPOGRAPHY.bold}
                        transition={TRANSITIONS.colors}
                        _hover={HOVER_EFFECTS.borderHighlight}
                        _active={ACTIVE_EFFECTS.dim}
                        _focus={FOCUS_STYLES.ring}
                        _focusVisible={FOCUS_STYLES.ring}
                        isDisabled={!amount || parseFloat(amount) <= 0}
                        onClick={handleSubmit}
                    >
                        Deposit
                    </Button>
                </HStack>
            </VStack>
        </VStack>
    )
}
