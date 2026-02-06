import React, { useState, useMemo, useEffect } from 'react'
import { Box, VStack, Text, Button, NumberInput, NumberInputField, HStack } from '@chakra-ui/react'
import { motion, AnimatePresence } from 'framer-motion'
import { IndividualLTVData } from './LTVNumberLineCarousel'
import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useChainRoute } from '@/hooks/useChainRoute'
import { num } from '@/helpers/num'
import { useQuery } from '@tanstack/react-query'
import { getLTVQueue, getCumulativeRevenue } from '@/services/disco'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import { useDiscoAssets } from '@/hooks/useDiscoData'
import useDiscoDeposit from './hooks/useDiscoDeposit'
import { useEpochCountdown, useCurrentEpochRevenue } from '@/hooks/useEpochInfo'
import { mockLtvGroups } from './mockData'

// Color constants
const PRIMARY_PURPLE = 'rgb(166, 146, 255)'

interface LTVGroup {
    liquidationLtv: number
    borrowLtv: number
    tvl: number
}

interface SectionInfoCardProps {
    selectedLTV: IndividualLTVData | null
    isAdvancedMode: boolean
    allLtvGroups?: LTVGroup[]
    onOpenDepositForm?: () => void
    externalFormTrigger?: number
}

export const SectionInfoCard: React.FC<SectionInfoCardProps> = ({ selectedLTV, isAdvancedMode, allLtvGroups, onOpenDepositForm, externalFormTrigger }) => {
    const [showForm, setShowForm] = useState(false)
    const [amount, setAmount] = useState('')

    // Watch for external form trigger (counter-based to ensure it triggers each time)
    useEffect(() => {
        if (externalFormTrigger && externalFormTrigger > 0 && selectedLTV) {
            setShowForm(true)
        }
    }, [externalFormTrigger, selectedLTV])
    
    // Reset form when selectedLTV changes
    useEffect(() => {
        if (!selectedLTV) {
            setShowForm(false)
            setAmount('')
        }
    }, [selectedLTV])
    const { chainName } = useChainRoute()
    const { appState } = useAppState()
    const mbrnAsset = useAssetBySymbol('MBRN', chainName)
    const mbrnBalance = useBalanceByAsset(mbrnAsset)
    const { data: client } = useCosmWasmClient(appState.rpcUrl)
    const { data: assets } = useDiscoAssets()

    // Calculate wallet balance in MBRN (shift by -6 for display)
    const walletBalanceMBRN = useMemo(() => {
        if (!mbrnBalance) return '0'
        return shiftDigits(mbrnBalance, -6).toString()
    }, [mbrnBalance])

    // Calculate Loss Absorption Order and MBRN Defense Ahead
    const lossAbsorptionData = useMemo(() => {
        if (!selectedLTV) {
            return { position: null, totalGroups: 0, mbrnAhead: 0, hasTVL: false }
        }

        // Use mock data if real data is not available
        const groupsToUse = (!allLtvGroups || allLtvGroups.length === 0) ? mockLtvGroups : allLtvGroups

        // Sort ALL groups by loss absorption order (including those with 0 TVL)
        // First-Loss = highest Liquidation LTV, highest Borrow LTV
        const allOrderedGroups = [...groupsToUse]
            .sort((a, b) => {
                // Sort by Liquidation LTV descending (higher = first loss)
                if (b.liquidationLtv !== a.liquidationLtv) {
                    return b.liquidationLtv - a.liquidationLtv
                }
                // Within same liquidation LTV, sort by Borrow LTV descending
                return b.borrowLtv - a.borrowLtv
            })

        // Filter to only groups with TVL > 0 for position calculation
        const groupsWithTVL = allOrderedGroups.filter(g => g.tvl > 0)

        // Find the selected group in the full ordered list
        const selectedGroupIndex = allOrderedGroups.findIndex(g => 
            Math.abs(g.liquidationLtv - selectedLTV.ltv) < 0.001 && 
            (selectedLTV.borrowLTV === undefined || Math.abs(g.borrowLtv - selectedLTV.borrowLTV) < 0.001)
        )

        // Check if selected group has TVL
        const selectedGroup = selectedGroupIndex >= 0 ? allOrderedGroups[selectedGroupIndex] : null
        const hasTVL = selectedGroup ? selectedGroup.tvl > 0 : false

        // Position is only valid for groups with TVL
        let position: number | null = null
        if (hasTVL && selectedGroupIndex >= 0) {
            // Find position in the filtered list (only groups with TVL)
            position = groupsWithTVL.findIndex(g => 
                Math.abs(g.liquidationLtv - selectedLTV.ltv) < 0.001 && 
                (selectedLTV.borrowLTV === undefined || Math.abs(g.borrowLtv - selectedLTV.borrowLTV) < 0.001)
            ) + 1
        }

        // MBRN Ahead: Sum TVL from all groups with TVL that are ahead in the ordering
        // This works for both TVL and non-TVL groups
        let mbrnAhead = 0
        if (selectedGroupIndex >= 0) {
            // Sum TVL from all groups with TVL that come before this group in the ordering
            mbrnAhead = allOrderedGroups
                .slice(0, selectedGroupIndex)
                .filter(g => g.tvl > 0)
                .reduce((sum, g) => sum + g.tvl, 0)
        }

        return {
            position,
            totalGroups: groupsWithTVL.length,
            mbrnAhead,
            hasTVL
        }
    }, [selectedLTV, allLtvGroups])

    // Format ordinal number (1st, 2nd, 3rd, etc.)
    const formatOrdinal = (n: number) => {
        const s = ['th', 'st', 'nd', 'rd']
        const v = n % 100
        return n + (s[(v - 20) % 10] || s[v] || s[0])
    }

    // Calculate updated TVL and APR based on deposit amount
    const { updatedTVL, updatedAPR } = useMemo(() => {
        if (!selectedLTV || !amount || parseFloat(amount) <= 0) {
            return {
                updatedTVL: selectedLTV?.tvl || 0,
                updatedAPR: selectedLTV?.apr || null
            }
        }

        // Convert deposit amount to base units (shift by 6)
        const depositAmountBase = shiftDigits(amount, 6).toNumber()
        const currentTVLBase = selectedLTV.tvl || 0
        const newTVLBase = currentTVLBase + depositAmountBase

        // For APR, we'll keep the current APR for now since calculating new APR requires revenue data
        // In a real implementation, you'd recalculate APR based on new TVL and revenue
        const updatedTVL = newTVLBase
        const updatedAPR = selectedLTV.apr // Keep current APR, or calculate new one if revenue data available

        return { updatedTVL, updatedAPR }
    }, [selectedLTV, amount])

    // Query LTV queue to get total_locked_vault_tokens for selected LTV section
    const ltvQueueData = useQuery({
        queryKey: ['disco', 'ltv_queue_card', selectedLTV?.ltv, selectedLTV?.borrowLTV, assets?.assets?.[0], appState.rpcUrl],
        queryFn: async () => {
            if (!client || !selectedLTV?.ltv || !assets?.assets || assets.assets.length === 0) return null

            try {
                // Use first asset (typically USDC)
                const asset = assets.assets[0]
                const queueResponse = await getLTVQueue(client, asset)
                if (!queueResponse?.queue?.slots) return null

                // Find the slot matching liquidationLTV
                const slot = queueResponse.queue.slots.find((s: any) => {
                    const slotLtv = typeof s.ltv === 'string' ? parseFloat(s.ltv) : parseFloat(s.ltv?.toString() || '0')
                    return Math.abs(slotLtv - selectedLTV.ltv) < 0.001
                })

                if (!slot || !slot.deposit_groups) return null

                // If borrowLTV is specified, find matching group; otherwise sum all groups
                if (selectedLTV.borrowLTV !== undefined) {
                    const group = slot.deposit_groups.find((g: any) => {
                        const groupBorrowLtv = typeof g.max_borrow_ltv === 'string'
                            ? parseFloat(g.max_borrow_ltv)
                            : parseFloat(g.max_borrow_ltv?.toString() || '0')
                        return Math.abs(groupBorrowLtv - selectedLTV.borrowLTV!) < 0.001
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

                // Sum all groups in the slot
                const totalLockedVaultTokens = slot.deposit_groups.reduce((sum: number, g: any) => {
                    const tokens = g.total_locked_vault_tokens || '0'
                    const tokensNum = typeof tokens === 'string' ? parseFloat(tokens) : parseFloat(tokens.toString() || '0')
                    return sum + tokensNum
                }, 0)

                return {
                    totalLockedVaultTokens: totalLockedVaultTokens.toString()
                }
            } catch (error) {
                console.error('Error querying LTV queue:', error)
                return null
            }
        },
        enabled: Boolean(client && selectedLTV?.ltv && assets?.assets?.length && showForm),
        staleTime: 1000 * 60 * 5,
    })

    // Query revenue for selected LTV section
    const revenueData = useQuery({
        queryKey: ['disco', 'ltv_revenue_card', selectedLTV?.ltv, selectedLTV?.borrowLTV, assets?.assets?.[0], appState.rpcUrl],
        queryFn: async () => {
            if (!client || !selectedLTV?.ltv || !assets?.assets || assets.assets.length === 0) return null

            try {
                const asset = assets.assets[0]
                const revenueEntries = await getCumulativeRevenue(
                    client,
                    asset,
                    selectedLTV.ltv.toString(),
                    selectedLTV.borrowLTV?.toString()
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
                console.error('Error querying revenue:', error)
                return null
            }
        },
        enabled: Boolean(client && selectedLTV?.ltv && assets?.assets?.length && showForm),
        staleTime: 1000 * 60 * 5,
    })

    // Query epoch information
    const { data: epochCountdown } = useEpochCountdown()
    const { data: epochRevenue } = useCurrentEpochRevenue()

    // Format countdown time
    const formatCountdown = (seconds: number) => {
        const days = Math.floor(seconds / 86400)
        const hours = Math.floor((seconds % 86400) / 3600)
        const minutes = Math.floor((seconds % 3600) / 60)
        const secs = seconds % 60
        if (days > 0) return `${days}d ${hours}h ${minutes}m`
        if (hours > 0) return `${hours}h ${minutes}m ${secs}s`
        return `${minutes}m ${secs}s`
    }

    // Calculate revenue per day using effective MBRN share
    // For new deposits, effective MBRN = amount * (0 + 1) = amount (no lock initially)
    const revenuePerDay = useMemo(() => {
        if (!amount || parseFloat(amount) <= 0) {
            return 0
        }

        // For new deposits without lock, effective MBRN = amount
        const effectiveMBRN = parseFloat(amount)

        if (!ltvQueueData.data || !revenueData.data || effectiveMBRN <= 0) {
            return 0
        }

        const totalLockedVaultTokens = parseFloat(shiftDigits(ltvQueueData.data.totalLockedVaultTokens, -6).toString())

        // If total is 0 or user's effective MBRN is 0, return 0
        if (totalLockedVaultTokens <= 0 || effectiveMBRN <= 0) {
            return 0
        }

        // Calculate user's share: userEffectiveMBRN / totalEffectiveMBRN
        const userShare = effectiveMBRN / totalLockedVaultTokens

        // Calculate user's daily revenue: daily_revenue * user_share
        const dailyRevenue = revenueData.data.dailyRevenue * userShare

        return dailyRevenue
    }, [amount, ltvQueueData.data, revenueData.data])

    // Initialize deposit hook
    const asset = assets?.assets?.[0] || ''
    const depositHook = useDiscoDeposit({
        asset,
        maxLtv: selectedLTV?.ltv?.toString() ?? '',
        maxBorrowLtv: selectedLTV?.borrowLTV?.toString() ?? '',
        amount,
        txSuccess: () => {
            setShowForm(false)
            setAmount('')
        },
    })

    const handleMaxClick = () => {
        if (walletBalanceMBRN) {
            setAmount(walletBalanceMBRN)
        }
    }

    const handleDeposit = async () => {
        if (!amount || !depositHook.action?.simulate?.data) return
        await depositHook.action.tx.mutateAsync()
    }

    const handleCancel = () => {
        setShowForm(false)
        setAmount('')
    }

    return (
        <Box
            as={motion.div}
            layout
            bg="rgba(10, 10, 10, 0.95)"
            p={4}
            borderRadius="md"
            border="2px solid"
            borderColor={PRIMARY_PURPLE}
            boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
            w="215px"
            backdropFilter="blur(10px)"
            position="relative"
            overflow="hidden"
            h="fit-content"
            transition={{ layout: { duration: 0.3, ease: "easeInOut" } }}
            ml={isAdvancedMode ? '17px' : '-62px'}
        >
            <AnimatePresence mode="wait">
                {!showForm ? (
                    <motion.div
                        key="card"
                        initial={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        transition={{ duration: 0.2 }}
                    >
                        {selectedLTV ? (
                            <VStack spacing={3} align="stretch" >
                                <Text
                                    fontSize="sm"
                                    fontWeight="bold"
                                    color={PRIMARY_PURPLE}
                                    fontFamily="mono"
                                    letterSpacing="1px"
                                    textTransform="uppercase"
                                    mb={2}
                                >
                                    Section Details
                                </Text>

                                {/* LTV Values */}
                                {selectedLTV.borrowLTV !== undefined ? (
                                    <>
                                        {/* Liquidation LTV */}
                                        <VStack spacing={0} align="flex-start">
                                            <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                                                Liquidation LTV
                                            </Text>
                                            <Text
                                                fontSize="lg"
                                                fontWeight="bold"
                                                color={PRIMARY_PURPLE}
                                                fontFamily="mono"
                                                textShadow={`0 0 10px ${PRIMARY_PURPLE}`}
                                            >
                                                {(selectedLTV.ltv * 100).toFixed(0)}%
                                            </Text>
                                        </VStack>
                                        {/* Borrow LTV */}
                                        <VStack spacing={0} align="flex-start">
                                            <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                                                Borrow LTV
                                            </Text>
                                            <Text
                                                fontSize="lg"
                                                fontWeight="bold"
                                                color="cyan.400"
                                                fontFamily="mono"
                                                textShadow="0 0 10px rgba(56, 178, 172, 0.6)"
                                            >
                                                {(selectedLTV.borrowLTV * 100).toFixed(0)}%
                                            </Text>
                                        </VStack>
                                    </>
                                ) : (
                                    <VStack spacing={0} align="flex-start">
                                        <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                                            LTV
                                        </Text>
                                        <Text
                                            fontSize="lg"
                                            fontWeight="bold"
                                            color={PRIMARY_PURPLE}
                                            fontFamily="mono"
                                            textShadow={`0 0 10px ${PRIMARY_PURPLE}`}
                                        >
                                            {(selectedLTV.ltv * 100).toFixed(0)}%
                                        </Text>
                                    </VStack>
                                )}

                                {/* Loss Absorption Order */}
                                {selectedLTV && (
                                    <VStack spacing={0} align="flex-start">
                                        <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                                            Loss Absorption Order
                                        </Text>
                                        <Text
                                            fontSize="lg"
                                            fontWeight="bold"
                                            color={lossAbsorptionData.hasTVL 
                                                ? (lossAbsorptionData.position === 1 ? "red.400" : "orange.400")
                                                : "whiteAlpha.500"}
                                            fontFamily="mono"
                                            textShadow={lossAbsorptionData.hasTVL && lossAbsorptionData.position === 1 
                                                ? "0 0 10px rgba(245, 101, 101, 0.6)" 
                                                : lossAbsorptionData.hasTVL
                                                ? "0 0 10px rgba(237, 137, 54, 0.6)"
                                                : undefined}
                                        >
                                            {lossAbsorptionData.hasTVL && lossAbsorptionData.position !== null
                                                ? `${formatOrdinal(lossAbsorptionData.position)} Loss`
                                                : 'N/A'}
                                        </Text>
                                    </VStack>
                                )}

                                {/* MBRN Defense Ahead */}
                                {selectedLTV && (
                                    <VStack spacing={0} align="flex-start">
                                        <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                                            MBRN Defense Ahead
                                        </Text>
                                        <Text
                                            fontSize="lg"
                                            fontWeight="bold"
                                            color={lossAbsorptionData.mbrnAhead > 0 ? "green.400" : "whiteAlpha.500"}
                                            fontFamily="mono"
                                            textShadow={lossAbsorptionData.mbrnAhead > 0 ? "0 0 10px rgba(72, 187, 120, 0.6)" : undefined}
                                        >
                                            {parseFloat(shiftDigits(lossAbsorptionData.mbrnAhead.toString(), -6).toString()).toLocaleString(undefined, { maximumFractionDigits: 0 })} MBRN
                                        </Text>
                                    </VStack>
                                )}

                            </VStack>
                        ) : (
                            <VStack spacing={2} align="center" py={2}>
                                <Text
                                    fontSize="sm"
                                    color="whiteAlpha.600"
                                    fontFamily="mono"
                                    textAlign="center"
                                    letterSpacing="0.5px"
                                >
                                    Click a LTV to see info
                                </Text>
                            </VStack>
                        )}
                    </motion.div>
                ) : (
                    <motion.div
                        key="form"
                        initial={{ opacity: 0, y: 20, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -20, scale: 0.95 }}
                        transition={{
                            duration: 0.3,
                            ease: [0.4, 0, 0.2, 1] // Custom easing for smooth pull-up
                        }}
                    >
                        <VStack spacing={4} align="stretch">
                            {/* Section Info Display */}
                            <Box
                                bg="rgba(166, 146, 255, 0.1)"
                                p={3}
                                borderRadius="md"
                                border="1px solid"
                                borderColor={`${PRIMARY_PURPLE}40`}
                            >
                                <Text
                                    fontSize="sm"
                                    fontWeight="bold"
                                    color={PRIMARY_PURPLE}
                                    fontFamily="mono"
                                    letterSpacing="1px"
                                    mb={2}
                                    textTransform="uppercase"
                                >
                                    Section Details
                                </Text>
                                <VStack spacing={1.5} align="stretch">
                                    <HStack justify="space-between">
                                        <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono">
                                            TVL
                                        </Text>
                                        <Text fontSize="xs" fontWeight="bold" color="cyan.400" fontFamily="mono">
                                            {parseFloat(shiftDigits(updatedTVL.toString(), -6).toString()).toLocaleString()} MBRN
                                        </Text>
                                    </HStack>
                                    <HStack justify="space-between">
                                        <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono">
                                            APR
                                        </Text>
                                        <Text fontSize="xs" fontWeight="bold" color={updatedAPR ? "cyan.400" : "whiteAlpha.500"} fontFamily="mono">
                                            {updatedAPR || 'N/A'}
                                        </Text>
                                    </HStack>
                                    {selectedLTV?.borrowLTV !== undefined ? (
                                        <>
                                            <HStack justify="space-between">
                                                <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono">
                                                    Liquidation LTV
                                                </Text>
                                                <Text fontSize="xs" fontWeight="bold" color={PRIMARY_PURPLE} fontFamily="mono">
                                                    {(selectedLTV.ltv * 100).toFixed(0)}%
                                                </Text>
                                            </HStack>
                                            <HStack justify="space-between">
                                                <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono">
                                                    Borrow LTV
                                                </Text>
                                                <Text fontSize="xs" fontWeight="bold" color="cyan.400" fontFamily="mono">
                                                    {(selectedLTV.borrowLTV * 100).toFixed(0)}%
                                                </Text>
                                            </HStack>
                                        </>
                                    ) : (
                                        <HStack justify="space-between">
                                            <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono">
                                                LTV
                                            </Text>
                                            <Text fontSize="xs" fontWeight="bold" color={PRIMARY_PURPLE} fontFamily="mono">
                                                {(selectedLTV?.ltv ? selectedLTV.ltv * 100 : 0).toFixed(0)}%
                                            </Text>
                                        </HStack>
                                    )}
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
                                        color={PRIMARY_PURPLE}
                                        fontFamily="mono"
                                        letterSpacing="0.5px"
                                        cursor="pointer"
                                        _hover={{
                                            color: 'rgb(186, 166, 255)',
                                            textDecoration: 'underline'
                                        }}
                                        onClick={handleMaxClick}
                                    >
                                        Wallet: {parseFloat(walletBalanceMBRN || '0').toLocaleString()}
                                    </Text>
                                </HStack>
                                <NumberInput
                                    value={amount}
                                    onChange={(valueString) => setAmount(valueString)}
                                    min={0}
                                    max={parseFloat(walletBalanceMBRN || '0')}
                                >
                                    <NumberInputField
                                        bg="rgba(10, 10, 10, 0.8)"
                                        border="1px solid"
                                        borderColor={`${PRIMARY_PURPLE}40`}
                                        color="white"
                                        fontFamily="mono"
                                        fontSize="sm"
                                        _hover={{ borderColor: `${PRIMARY_PURPLE}60` }}
                                        _focus={{
                                            borderColor: PRIMARY_PURPLE,
                                            boxShadow: `0 0 0 1px ${PRIMARY_PURPLE}40`
                                        }}
                                        placeholder="0.00"
                                        autoFocus
                                    />
                                </NumberInput>
                            </Box>

                            {/* Revenue per Day and Action Buttons */}
                            <VStack spacing={2} align="stretch">
                                <Text
                                    fontSize="xs"
                                    color={revenuePerDay > 0 ? "green.400" : "whiteAlpha.400"}
                                    fontFamily="mono"
                                    letterSpacing="0.5px"
                                    textAlign="center"
                                >
                                    + {revenuePerDay.toFixed(4)} CDT/day
                                </Text>
                                <HStack spacing={2}>
                                    <Button
                                        flex={1}
                                        size="sm"
                                        variant="outline"
                                        borderColor={`${PRIMARY_PURPLE}40`}
                                        color="whiteAlpha.700"
                                        fontFamily="mono"
                                        fontSize="xs"
                                        _hover={{
                                            borderColor: PRIMARY_PURPLE,
                                            color: 'white'
                                        }}
                                        onClick={handleCancel}
                                    >
                                        Cancel
                                    </Button>
                                    <Button
                                        flex={1}
                                        size="sm"
                                        bg={PRIMARY_PURPLE}
                                        color="white"
                                        fontFamily="mono"
                                        fontSize="xs"
                                        fontWeight="bold"
                                        _hover={{
                                            bg: 'rgb(186, 166, 255)',
                                            boxShadow: `0 0 15px ${PRIMARY_PURPLE}60`
                                        }}
                                        isDisabled={!amount || parseFloat(amount) <= 0}
                                        isLoading={depositHook.action?.tx?.isPending}
                                        onClick={handleDeposit}
                                    >
                                        Deposit
                                    </Button>
                                </HStack>
                            </VStack>
                        </VStack>
                    </motion.div>
                )}
            </AnimatePresence>
        </Box>
    )
}

