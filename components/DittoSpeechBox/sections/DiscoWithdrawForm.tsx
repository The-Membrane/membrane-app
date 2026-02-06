import React, { useState, useMemo } from 'react'
import { VStack, Text, Box, HStack, Button, NumberInput, NumberInputField } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'
import { getLTVQueue, getCumulativeRevenue } from '@/services/disco'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import { shiftDigits } from '@/helpers/math'

interface DiscoWithdrawFormProps {
    deposit: {
        asset: string
        amount: number
        maxLtv?: string | number
        maxBorrowLtv?: string | number
        apr?: number
        lockDaysRemaining?: number
    }
    onCancel: () => void
    onSubmit: (amount: string) => void
}

export const DiscoWithdrawForm: React.FC<DiscoWithdrawFormProps> = ({
    deposit,
    onCancel,
    onSubmit,
}) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)
    const [amount, setAmount] = useState('')

    const handleMaxClick = () => {
        if (deposit.amount) {
            setAmount(deposit.amount.toFixed(2))
        }
    }

    const handleSubmit = () => {
        if (!amount || parseFloat(amount) <= 0) return
        onSubmit(amount)
    }

    // Query LTV queue to get total_locked_vault_tokens for deposit's LTV section
    const ltvQueueData = useQuery({
        queryKey: ['disco', 'ltv_queue_withdraw', deposit.asset, deposit.maxLtv, deposit.maxBorrowLtv, appState.rpcUrl],
        queryFn: async () => {
            if (!client || !deposit.asset || !deposit.maxLtv) return null

            try {
                const queueResponse = await getLTVQueue(client, deposit.asset)
                if (!queueResponse?.queue?.slots) return null

                const liquidationLTV = typeof deposit.maxLtv === 'string'
                    ? parseFloat(deposit.maxLtv)
                    : parseFloat(deposit.maxLtv.toString() || '0')

                const slot = queueResponse.queue.slots.find((s: any) => {
                    const slotLtv = typeof s.ltv === 'string' ? parseFloat(s.ltv) : parseFloat(s.ltv?.toString() || '0')
                    return Math.abs(slotLtv - liquidationLTV) < 0.001
                })

                if (!slot || !slot.deposit_groups) return null

                if (deposit.maxBorrowLtv) {
                    const borrowLTV = typeof deposit.maxBorrowLtv === 'string'
                        ? parseFloat(deposit.maxBorrowLtv)
                        : parseFloat(deposit.maxBorrowLtv.toString() || '0')

                    const group = slot.deposit_groups.find((g: any) => {
                        const groupBorrowLtv = typeof g.max_borrow_ltv === 'string'
                            ? parseFloat(g.max_borrow_ltv)
                            : parseFloat(g.max_borrow_ltv?.toString() || '0')
                        return Math.abs(groupBorrowLtv - borrowLTV) < 0.001
                    })

                    if (group) {
                        const totalLockedVaultTokens = group.total_locked_vault_tokens || '0'
                        return {
                            totalLockedVaultTokens: typeof totalLockedVaultTokens === 'string'
                                ? totalLockedVaultTokens
                                : totalLockedVaultTokens.toString()
                        }
                    }
                }

                const totalLockedVaultTokens = slot.deposit_groups.reduce((sum: number, g: any) => {
                    const tokens = g.total_locked_vault_tokens || '0'
                    const tokensNum = typeof tokens === 'string' ? parseFloat(tokens) : parseFloat(tokens.toString() || '0')
                    return sum + tokensNum
                }, 0)

                return {
                    totalLockedVaultTokens: totalLockedVaultTokens.toString()
                }
            } catch (error) {
                console.error('Error querying LTV queue for withdraw:', error)
                return null
            }
        },
        enabled: Boolean(client && deposit.asset && deposit.maxLtv),
        staleTime: 1000 * 60 * 5,
    })

    // Query revenue for deposit's LTV section
    const revenueData = useQuery({
        queryKey: ['disco', 'ltv_revenue_withdraw', deposit.asset, deposit.maxLtv, deposit.maxBorrowLtv, appState.rpcUrl],
        queryFn: async () => {
            if (!client || !deposit.asset || !deposit.maxLtv) return null

            try {
                const revenueEntries = await getCumulativeRevenue(
                    client,
                    deposit.asset,
                    deposit.maxLtv.toString(),
                    deposit.maxBorrowLtv?.toString()
                )

                if (!revenueEntries || !Array.isArray(revenueEntries) || revenueEntries.length === 0) {
                    return null
                }

                const sortedEntries = revenueEntries
                    .map((entry: any) => ({
                        timestamp: entry.timestamp || 0,
                        total_revenue: parseFloat(shiftDigits(entry.total_revenue || '0', -6).toString())
                    }))
                    .sort((a, b) => a.timestamp - b.timestamp)

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
                console.error('Error querying revenue for withdraw:', error)
                return null
            }
        },
        enabled: Boolean(client && deposit.asset && deposit.maxLtv),
        staleTime: 1000 * 60 * 5,
    })

    // Calculate revenue loss per day using effective MBRN share
    // Use current deposit's lock days to calculate effective MBRN
    const revenueLossPerDay = useMemo(() => {
        if (!amount || parseFloat(amount) <= 0) {
            return 0
        }

        // Calculate effective MBRN: amount * (lockDays + 1)
        const lockDays = deposit.lockDaysRemaining || 0
        const effectiveMBRN = parseFloat(amount) * (lockDays + 1)

        if (!ltvQueueData.data || !revenueData.data || effectiveMBRN <= 0) {
            return 0
        }

        const totalLockedVaultTokens = parseFloat(shiftDigits(ltvQueueData.data.totalLockedVaultTokens, -6).toString())

        if (totalLockedVaultTokens <= 0 || effectiveMBRN <= 0) {
            return 0
        }

        const userShare = effectiveMBRN / totalLockedVaultTokens
        const dailyRevenueLoss = revenueData.data.dailyRevenue * userShare

        return dailyRevenueLoss
    }, [amount, deposit.lockDaysRemaining, ltvQueueData.data, revenueData.data])

    return (
        <VStack spacing={4} align="stretch">
            {/* Section Details Display */}
            <Box
                bg="rgba(166, 146, 255, 0.1)"
                p={3}
                borderRadius="md"
                border="1px solid"
                borderColor="rgba(166, 146, 255, 0.25)"
            >
                <Text
                    fontSize="sm"
                    fontWeight="bold"
                    color="rgb(166, 146, 255)"
                    fontFamily="mono"
                    letterSpacing="1px"
                    mb={2}
                    textTransform="uppercase"
                >
                    Section Details
                </Text>
                <VStack spacing={1.5} align="stretch">
                    {deposit.maxBorrowLtv ? (
                        <>
                            <HStack justify="space-between">
                                <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono">
                                    Liquidation LTV
                                </Text>
                                <Text fontSize="xs" fontWeight="bold" color="rgb(166, 146, 255)" fontFamily="mono">
                                    {deposit.maxLtv ? (parseFloat(deposit.maxLtv.toString()) * 100).toFixed(0) : '0'}%
                                </Text>
                            </HStack>
                            <HStack justify="space-between">
                                <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono">
                                    Borrow LTV
                                </Text>
                                <Text fontSize="xs" fontWeight="bold" color="cyan.400" fontFamily="mono">
                                    {deposit.maxBorrowLtv ? (parseFloat(deposit.maxBorrowLtv.toString()) * 100).toFixed(0) : '0'}%
                                </Text>
                            </HStack>
                        </>
                    ) : (
                        <HStack justify="space-between">
                            <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono">
                                LTV
                            </Text>
                            <Text fontSize="xs" fontWeight="bold" color="rgb(166, 146, 255)" fontFamily="mono">
                                {deposit.maxLtv ? (parseFloat(deposit.maxLtv.toString()) * 100).toFixed(0) : '0'}%
                            </Text>
                        </HStack>
                    )}
                    <HStack justify="space-between">
                        <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono">
                            APR
                        </Text>
                        <Text fontSize="xs" fontWeight="bold" color={deposit.apr ? "cyan.400" : "whiteAlpha.500"} fontFamily="mono">
                            {deposit.apr ? `${deposit.apr.toFixed(2)}%` : 'N/A'}
                        </Text>
                    </HStack>
                </VStack>
            </Box>

            {/* Amount Input */}
            <Box>
                <HStack justify="space-between" mb={2}>
                    <Text
                        fontSize="xs"
                        color="whiteAlpha.600"
                        fontFamily="mono"
                        letterSpacing="0.5px"
                    >
                        Amount (MBRN)
                    </Text>
                    <Text
                        fontSize="xs"
                        color="rgb(166, 146, 255)"
                        fontFamily="mono"
                        letterSpacing="0.5px"
                        cursor="pointer"
                        _hover={{
                            color: 'rgb(186, 166, 255)',
                            textDecoration: 'underline'
                        }}
                        onClick={handleMaxClick}
                    >
                        Max: {deposit.amount.toFixed(2) || '0.00'}
                    </Text>
                </HStack>
                <NumberInput
                    value={amount}
                    onChange={(valueString) => setAmount(valueString)}
                    min={0}
                    max={deposit.amount || 0}
                >
                    <NumberInputField
                        bg="rgba(10, 10, 10, 0.8)"
                        border="1px solid"
                        borderColor="rgba(166, 146, 255, 0.25)"
                        color="white"
                        fontFamily="mono"
                        fontSize="sm"
                        _hover={{ borderColor: 'rgba(166, 146, 255, 0.4)' }}
                        _focus={{
                            borderColor: 'rgb(166, 146, 255)',
                            boxShadow: '0 0 0 1px rgba(166, 146, 255, 0.25)'
                        }}
                        placeholder="0.00"
                        autoFocus
                    />
                </NumberInput>
            </Box>

            {/* Revenue Loss per Day and Action Buttons */}
            <VStack spacing={2} align="stretch">
                <Text
                    fontSize="xs"
                    color={revenueLossPerDay > 0 ? "red.400" : "whiteAlpha.400"}
                    fontFamily="mono"
                    letterSpacing="0.5px"
                    textAlign="center"
                >
                    -{revenueLossPerDay.toFixed(4)} CDT/day
                </Text>
                <HStack spacing={2}>
                    <Button
                        flex={1}
                        size="sm"
                        variant="outline"
                        borderColor="rgba(166, 146, 255, 0.25)"
                        color="whiteAlpha.700"
                        fontFamily="mono"
                        fontSize="xs"
                        _hover={{
                            borderColor: 'rgb(166, 146, 255)',
                            color: 'white'
                        }}
                        onClick={onCancel}
                    >
                        Cancel
                    </Button>
                    <Button
                        flex={1}
                        size="sm"
                        bg="rgb(166, 146, 255)"
                        color="white"
                        fontFamily="mono"
                        fontSize="xs"
                        fontWeight="bold"
                        _hover={{
                            bg: 'rgb(186, 166, 255)',
                            boxShadow: '0 0 15px rgba(166, 146, 255, 0.4)'
                        }}
                        isDisabled={!amount || parseFloat(amount) <= 0}
                        onClick={handleSubmit}
                    >
                        Withdraw
                    </Button>
                </HStack>
            </VStack>
        </VStack>
    )
}






























