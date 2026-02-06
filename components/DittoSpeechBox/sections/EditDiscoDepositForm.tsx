import React, { useState, useMemo, useEffect } from 'react'
import {
    VStack,
    Text,
    Box,
    HStack,
    Button,
    Slider,
    SliderTrack,
    SliderFilledTrack,
    SliderThumb,
    Switch,
    Tooltip,
    Icon,
} from '@chakra-ui/react'
import { InfoIcon } from '@chakra-ui/icons'
import { useQuery } from '@tanstack/react-query'
import { CompactLTVCarousel } from './CompactLTVCarousel'
import { getCumulativeRevenue, getLTVQueue } from '@/services/disco'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import { useChainRoute } from '@/hooks/useChainRoute'
import useAppState from '@/persisted-state/useAppState'
import { shiftDigits } from '@/helpers/math'
import { useDiscoAssets } from '@/hooks/useDiscoData'
import { useMarsLTVInfo } from '@/hooks/useMarsMirror'
import contracts from '@/config/contracts.json'

interface EditDiscoDepositFormProps {
    deposit: {
        id: number
        asset: string
        amount: number
        maxLtv?: string | number
        maxBorrowLtv?: string | number
        startTime?: number
    }
    currentLiquidationLTV: string | number | undefined
    currentBorrowLTV: string | number | undefined
    currentLockDays: number
    onClose: () => void
    onSubmit: (newLiquidationLTV: number, newBorrowLTV: number, newLockDays: number) => void
    currentAPR?: number | string | null
    isLoading?: boolean
}

const LTV_MIN = 0.60 // 60%
const LTV_MAX = 0.90 // 90%

export const EditDiscoDepositForm: React.FC<EditDiscoDepositFormProps> = ({
    deposit,
    currentLiquidationLTV,
    currentBorrowLTV,
    currentLockDays,
    onClose,
    onSubmit,
    currentAPR,
    isLoading,
}) => {
    const { chainName } = useChainRoute()
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)
    const { data: assets } = useDiscoAssets()
    const discoContract = (contracts as any).ltv_disco
    
    // Query disco config to get mars_mirror contract address
    const { data: discoConfig } = useQuery({
        queryKey: ['disco_config', discoContract, appState.rpcUrl],
        queryFn: async () => {
            if (!client || !discoContract || discoContract === '') return null
            try {
                const config = await client.queryContractSmart(discoContract, { config: {} })
                return config
            } catch (error) {
                console.error('Error fetching disco config:', error)
                return null
            }
        },
        enabled: !!client && !!discoContract && discoContract !== '',
        staleTime: 1000 * 60 * 5, // 5 minutes
    })
    
    const marsMirrorContract = discoConfig?.mars_mirror_contract
    
    // Query Mars LTVs when automation is enabled
    const [marsAutomationEnabled, setMarsAutomationEnabled] = useState(false)
    const { data: marsLTVInfo } = useMarsLTVInfo(
        marsMirrorContract,
        marsAutomationEnabled ? deposit.asset : undefined
    )
    
    // Apply Mars LTVs when automation is enabled and data is available
    useEffect(() => {
        if (marsAutomationEnabled && marsLTVInfo) {
            // Round down as per mars-mirror contract logic
            const marsMaxLTV = Math.floor(parseFloat(marsLTVInfo.max_ltv || '0') * 100) / 100
            const marsMaxBorrowLTV = Math.floor(parseFloat(marsLTVInfo.max_borrow_ltv || '0') * 100) / 100
            
            // Ensure constraints: liquidation LTV > borrow LTV
            if (marsMaxLTV > marsMaxBorrowLTV) {
                setLiquidationLTV(marsMaxLTV)
                setBorrowLTV(marsMaxBorrowLTV)
            }
        }
    }, [marsAutomationEnabled, marsLTVInfo])
    // Parse current LTVs (handle string or number)
    const currentLiqLTV = useMemo(() => {
        if (currentLiquidationLTV === undefined || currentLiquidationLTV === null) return 0.75
        const parsed = typeof currentLiquidationLTV === 'string' ? parseFloat(currentLiquidationLTV) : currentLiquidationLTV
        return isNaN(parsed) ? 0.75 : parsed
    }, [currentLiquidationLTV])

    const currentBorrowLTVNum = useMemo(() => {
        if (currentBorrowLTV === undefined || currentBorrowLTV === null) return 0.60
        const parsed = typeof currentBorrowLTV === 'string' ? parseFloat(currentBorrowLTV) : currentBorrowLTV
        return isNaN(parsed) ? 0.60 : parsed
    }, [currentBorrowLTV])

    const [liquidationLTV, setLiquidationLTV] = useState(currentLiqLTV)
    const [borrowLTV, setBorrowLTV] = useState(currentBorrowLTVNum)
    const [lockDays, setLockDays] = useState(Math.max(currentLockDays, 0))

    const maxLockDays = 365
    const canExtend = lockDays > currentLockDays
    const hasLTVChanges = liquidationLTV !== currentLiqLTV || borrowLTV !== currentBorrowLTVNum
    const hasLockChanges = lockDays !== currentLockDays

    // Constraint: Liquidation LTV must be > Borrow LTV
    const isConstraintViolation = liquidationLTV <= borrowLTV
    const canSubmit = (hasLTVChanges || hasLockChanges) && !isConstraintViolation

    // Calculate effective MBRN: amount * (lockDays + 1)
    const effectiveMBRN = useMemo(() => {
        return deposit.amount * (lockDays + 1)
    }, [deposit.amount, lockDays])

    // Query LTV queue to get total_locked_vault_tokens for the selected LTV section
    const ltvQueueData = useQuery({
        queryKey: ['disco', 'ltv_queue', deposit.asset, liquidationLTV, borrowLTV, appState.rpcUrl],
        queryFn: async () => {
            if (!client || !liquidationLTV || !deposit.asset) return null

            try {
                const queueResponse = await getLTVQueue(client, deposit.asset)
                if (!queueResponse?.queue?.slots) return null

                // Find the slot matching liquidationLTV
                const slot = queueResponse.queue.slots.find((s: any) => {
                    const slotLtv = typeof s.ltv === 'string' ? parseFloat(s.ltv) : parseFloat(s.ltv?.toString() || '0')
                    return Math.abs(slotLtv - liquidationLTV) < 0.001 // Allow small floating point differences
                })

                if (!slot || !slot.deposit_groups) return null

                // Find the group matching borrowLTV
                const group = slot.deposit_groups.find((g: any) => {
                    const groupBorrowLtv = typeof g.max_borrow_ltv === 'string'
                        ? parseFloat(g.max_borrow_ltv)
                        : parseFloat(g.max_borrow_ltv?.toString() || '0')
                    return borrowLTV && Math.abs(groupBorrowLtv - borrowLTV) < 0.001
                })

                if (!group) return null

                // Get total_locked_vault_tokens (in base units, 6 decimals)
                const totalLockedVaultTokens = group.total_locked_vault_tokens || '0'
                return {
                    totalLockedVaultTokens: typeof totalLockedVaultTokens === 'string'
                        ? totalLockedVaultTokens
                        : totalLockedVaultTokens.toString()
                }
            } catch (error) {
                console.error('Error querying LTV queue:', error)
                return null
            }
        },
        enabled: Boolean(client && liquidationLTV && deposit.asset),
        staleTime: 1000 * 60 * 5,
    })

    // Query revenue for selected LTV section to calculate daily revenue
    const revenueData = useQuery({
        queryKey: ['disco', 'ltv_revenue', liquidationLTV, borrowLTV, deposit.asset, appState.rpcUrl],
        queryFn: async () => {
            if (!client || !liquidationLTV || !assets?.assets || assets.assets.length === 0) {
                return null
            }

            try {
                // Query cumulative revenue for LTV pair
                const revenueEntries = await getCumulativeRevenue(
                    client,
                    deposit.asset,
                    liquidationLTV.toString(),
                    borrowLTV?.toString()
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
        enabled: Boolean(client && liquidationLTV && deposit.asset),
        staleTime: 1000 * 60 * 5,
    })

    // Calculate revenue per day using effective MBRN share
    const revenuePerDay = useMemo(() => {
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
    }, [effectiveMBRN, ltvQueueData.data, revenueData.data])

    const handleSubmit = () => {
        if (!canSubmit) return
        onSubmit(liquidationLTV, borrowLTV, lockDays)
    }

    return (
        <Box position="relative" w="100%" h="100%" display="flex" flexDirection="column">
            {/* Scrollable Content */}
            <Box flex={1} overflowY="auto" pb="120px">
                <VStack align="stretch" spacing={4} w="100%">
                    <Text fontSize="xs" color="#F5F5F580" fontWeight="bold" textTransform="uppercase">
                        Edit Deposit
                    </Text>

                    {/* Current Deposit Info */}
                    <Box
                        bg="#1A1D26"
                        border="1px solid"
                        borderColor="#6943FF30"
                        borderRadius="md"
                        p={3}
                    >
                        <VStack align="stretch" spacing={2}>
                            <HStack justify="space-between">
                                <Text fontSize="xs" color="#F5F5F580">
                                    Amount
                                </Text>
                                <Text fontSize="xs" color="purple.300" fontWeight="bold">
                                    {deposit.amount.toFixed(2)} MBRN
                                </Text>
                            </HStack>
                            <HStack justify="space-between">
                                <Text fontSize="xs" color="#F5F5F580">
                                    Current LTV Section
                                </Text>
                                <Text fontSize="xs" color="purple.300" fontWeight="bold">
                                    {Math.round(currentBorrowLTVNum * 100)}% / {Math.round(currentLiqLTV * 100)}%
                                </Text>
                            </HStack>
                            {currentLockDays > 0 && (
                                <HStack justify="space-between">
                                    <Text fontSize="xs" color="#F5F5F580">
                                        Current Lock
                                    </Text>
                                    <Text fontSize="xs" color="purple.300" fontWeight="bold">
                                        {currentLockDays} days remaining
                                    </Text>
                                </HStack>
                            )}
                        </VStack>
                    </Box>

                    {/* LTV Section Selection */}
                    <Box>
                        <HStack justify="space-between" mb={3}>
                            <Text fontSize="xs" color="#F5F5F580" fontWeight="bold">
                                Move LTV Section
                            </Text>
                            <HStack spacing={2}>
                                <Tooltip
                                    label="Autonomously mirrors Mars protocol LTVs"
                                    hasArrow
                                    placement="top"
                                    bg="gray.800"
                                    color="white"
                                    borderRadius="md"
                                >
                                    <HStack spacing={1} cursor="pointer">
                                        <Text fontSize="xs" color="#F5F5F580">
                                            Mars Auto
                                        </Text>
                                        <Icon as={InfoIcon} w={3} h={3} color="#F5F5F580" />
                                    </HStack>
                                </Tooltip>
                                <Switch
                                    size="sm"
                                    isChecked={marsAutomationEnabled}
                                    onChange={(e) => setMarsAutomationEnabled(e.target.checked)}
                                    colorScheme="purple"
                                    isDisabled={!marsMirrorContract || !marsLTVInfo}
                                />
                            </HStack>
                        </HStack>

                        {/* Liquidation LTV Carousel */}
                        <Box mb={4}>
                            <CompactLTVCarousel
                                label="Liquidation LTV"
                                selectedLTV={liquidationLTV}
                                minLTV={0.61}
                                maxLTV={0.90}
                                otherLTV={borrowLTV}
                                isLiquidationLTV={true}
                                onLTVSelect={setLiquidationLTV}
                            />
                        </Box>

                        {/* Borrow LTV Carousel */}
                        <Box>
                            <CompactLTVCarousel
                                label="Borrow LTV"
                                selectedLTV={borrowLTV}
                                minLTV={0.60}
                                maxLTV={0.89}
                                otherLTV={liquidationLTV}
                                isLiquidationLTV={false}
                                onLTVSelect={setBorrowLTV}
                            />
                        </Box>
                    </Box>

                    {/* Lock Duration Extension */}
                    {currentLockDays >= 0 && (
                        <Box>
                            <Text fontSize="xs" color="#F5F5F580" mb={3} fontWeight="bold">
                                Extend Lock Duration
                            </Text>

                            <Box mb={2}>
                                <HStack justify="space-between" mb={2}>
                                    <Text fontSize="xs" color="#F5F5F580">
                                        New Lock Duration
                                    </Text>
                                    <Text fontSize="xs" color={canExtend ? 'cyan.300' : '#F5F5F580'} fontWeight="bold">
                                        {lockDays} days
                                    </Text>
                                </HStack>
                                <Slider
                                    value={lockDays}
                                    onChange={(val) => setLockDays(val)}
                                    min={currentLockDays}
                                    max={maxLockDays}
                                    step={1}
                                >
                                    <SliderTrack bg="#1A1D26" h="6px" borderRadius="full">
                                        <SliderFilledTrack bg={canExtend ? 'blue.400' : 'gray.500'} />
                                    </SliderTrack>
                                    <SliderThumb
                                        boxSize={4}
                                        bg={canExtend ? 'blue.400' : 'gray.500'}
                                        border="2px solid"
                                        borderColor="white"
                                        _focus={{ boxShadow: '0 0 10px rgba(66, 153, 225, 0.5)' }}
                                    />
                                </Slider>
                                <HStack justify="space-between" mt={1}>
                                    <Text fontSize="2xs" color="#F5F5F550">{currentLockDays}</Text>
                                    <Text fontSize="2xs" color="#F5F5F550">{maxLockDays}</Text>
                                </HStack>
                            </Box>

                            {/* Extension Preview */}
                            {canExtend && (
                                <Box
                                    bg="#1A1D26"
                                    border="1px solid"
                                    borderColor="#4299E130"
                                    borderRadius="md"
                                    p={3}
                                >
                                    <VStack align="stretch" spacing={2}>
                                        <HStack justify="space-between">
                                            <Text fontSize="xs" color="#F5F5F580">
                                                Extension
                                            </Text>
                                            <Text fontSize="xs" color="blue.300" fontWeight="bold">
                                                +{lockDays - currentLockDays} days
                                            </Text>
                                        </HStack>
                                        <HStack justify="space-between">
                                            <Text fontSize="xs" color="#F5F5F580">
                                                Effective MBRN Boost
                                            </Text>
                                            <Text fontSize="xs" color="cyan.300" fontWeight="bold">
                                                {(lockDays + 1).toFixed(1)}x
                                            </Text>
                                        </HStack>
                                    </VStack>
                                </Box>
                            )}
                        </Box>
                    )}

                    {/* Info Text */}
                    <Text fontSize="2xs" color="#F5F5F550">
                        Note: Lock days decrease over time as the lock period progresses. You can extend the lock to maintain or increase your boost.
                    </Text>
                </VStack>
            </Box>

            {/* Fixed Revenue Label and Action Buttons */}
            <Box
                position="fixed"
                bottom={0}
                left={0}
                right={0}
                bg="#23252B"
                borderTop="1px solid"
                borderColor="#6943FF30"
                pt={3}
                px={1}
                pb={3}
                zIndex={10}
            >
                <VStack spacing={2} align="stretch">
                    {/* Revenue per Day Label */}
                    <Text
                        fontSize="xs"
                        color={revenuePerDay > 0 ? "green.400" : "whiteAlpha.400"}
                        fontFamily="mono"
                        letterSpacing="0.5px"
                        textAlign="center"
                    >
                        + {revenuePerDay.toFixed(4)} CDT/day
                    </Text>

                    {/* Action Buttons */}
                    <HStack spacing={2}>
                        <Button
                            flex={1}
                            size="sm"
                            variant="outline"
                            borderColor="gray.600"
                            color="gray.400"
                            _hover={{ bg: 'gray.700', color: 'white' }}
                            onClick={onClose}
                        >
                            Cancel
                        </Button>
                        <Button
                            flex={1}
                            size="sm"
                            bg="purple.500"
                            color="white"
                            onClick={handleSubmit}
                            isDisabled={!canSubmit}
                            isLoading={isLoading}
                            _hover={{ bg: 'purple.400', boxShadow: '0 0 15px rgba(166, 146, 255, 0.4)' }}
                            _disabled={{ opacity: 0.5, cursor: 'not-allowed' }}
                        >
                            Save Changes
                        </Button>
                    </HStack>
                </VStack>
            </Box>
        </Box>
    )
}

