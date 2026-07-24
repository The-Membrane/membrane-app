import React, { useState, useMemo } from 'react'
import { VStack, Text, Box, HStack, Button, NumberInput, NumberInputField } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'
import { getAssetQueue, getCumulativeRevenue } from '@/services/disco'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import { shiftDigits } from '@/helpers/math'
import { getSlotLabel } from '@/components/Disco/types'

interface DiscoUnstakeFormProps {
    deposit: {
        asset: string
        amount: number
        slot?: number
        depositId?: string
        apr?: number
    }
    onCancel: () => void
    onSubmit: (amount: string) => void
}

export const DiscoWithdrawForm: React.FC<DiscoUnstakeFormProps> = ({
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

    // Query asset queue to get slot TVL
    const slotQueueData = useQuery({
        queryKey: ['disco', 'slot_queue_unstake', deposit.asset, deposit.slot, appState.rpcUrl],
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
                console.error('Error querying slot queue for unstake:', error)
                return null
            }
        },
        enabled: Boolean(client && deposit.asset && deposit.slot),
        staleTime: 1000 * 60 * 5,
    })

    // Query revenue for deposit's slot
    const revenueData = useQuery({
        queryKey: ['disco', 'slot_revenue_unstake', deposit.asset, deposit.slot, appState.rpcUrl],
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
                console.error('Error querying revenue for unstake:', error)
                return null
            }
        },
        enabled: Boolean(client && deposit.asset && deposit.slot),
        staleTime: 1000 * 60 * 5,
    })

    // Calculate revenue loss per day
    const revenueLossPerDay = useMemo(() => {
        if (!amount || parseFloat(amount) <= 0) return 0
        if (!slotQueueData.data || !revenueData.data) return 0

        const unstakeAmount = parseFloat(amount)
        const totalDeposit = parseFloat(shiftDigits(slotQueueData.data.totalDepositTokens, -6).toString())

        if (totalDeposit <= 0 || unstakeAmount <= 0) return 0

        const userShare = unstakeAmount / totalDeposit
        return revenueData.data.dailyRevenue * userShare
    }, [amount, slotQueueData.data, revenueData.data])

    return (
        <VStack spacing={4} align="stretch">
            {/* Section Details Display */}
            <Box
                bg="rgba(155, 220, 79, 0.1)"
                p={3}
                borderRadius="md"
                border="1px solid"
                borderColor="rgba(155, 220, 79, 0.25)"
            >
                <Text
                    fontSize="sm"
                    fontWeight="bold"
                    color="rgb(155, 220, 79)"
                    fontFamily="mono"
                    letterSpacing="1px"
                    mb={2}
                    textTransform="uppercase"
                >
                    Unstake Details
                </Text>
                <VStack spacing={1.5} align="stretch">
                    <HStack justify="space-between">
                        <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono">
                            Risk Slot
                        </Text>
                        <Text fontSize="xs" fontWeight="bold" color="rgb(155, 220, 79)" fontFamily="mono">
                            {deposit.slot ? `Slot ${getSlotLabel(deposit.slot || 0)}` : 'N/A'}
                        </Text>
                    </HStack>
                    <HStack justify="space-between">
                        <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono">
                            APR
                        </Text>
                        <Text fontSize="xs" fontWeight="bold" color={deposit.apr ? "secondary.400" : "whiteAlpha.500"} fontFamily="mono">
                            {deposit.apr ? `${deposit.apr.toFixed(2)}%` : 'N/A'}
                        </Text>
                    </HStack>
                    <HStack justify="space-between">
                        <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono">
                            Cooldown
                        </Text>
                        <Text fontSize="xs" fontWeight="bold" color="yellow.400" fontFamily="mono">
                            2 days after request
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
                        color="rgb(155, 220, 79)"
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
                        borderColor="rgba(155, 220, 79, 0.25)"
                        color="white"
                        fontFamily="mono"
                        fontSize="sm"
                        _hover={{ borderColor: 'rgba(155, 220, 79, 0.4)' }}
                        _focus={{
                            borderColor: 'rgb(155, 220, 79)',
                            boxShadow: '0 0 0 1px rgba(155, 220, 79, 0.25)'
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
                        borderColor="rgba(155, 220, 79, 0.25)"
                        color="whiteAlpha.700"
                        fontFamily="mono"
                        fontSize="xs"
                        _hover={{
                            borderColor: 'rgb(155, 220, 79)',
                            color: 'white'
                        }}
                        onClick={onCancel}
                    >
                        Cancel
                    </Button>
                    <Button
                        flex={1}
                        size="sm"
                        bg="rgb(155, 220, 79)"
                        color="white"
                        fontFamily="mono"
                        fontSize="xs"
                        fontWeight="bold"
                        _hover={{
                            bg: 'rgb(186, 166, 255)',
                            boxShadow: '0 0 15px rgba(155, 220, 79, 0.4)'
                        }}
                        isDisabled={!amount || parseFloat(amount) <= 0}
                        onClick={handleSubmit}
                    >
                        Request Unstake
                    </Button>
                </HStack>
            </VStack>
        </VStack>
    )
}
