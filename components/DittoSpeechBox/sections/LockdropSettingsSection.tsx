import React, { useState, useMemo, useEffect } from 'react'
import {
    VStack,
    HStack,
    Text,
    Box,
    Button,
    Checkbox,
    NumberInput,
    NumberInputField,
    Slider,
    SliderTrack,
    SliderFilledTrack,
    SliderThumb,
    Select,
    Input,
    Divider,
} from '@chakra-ui/react'
import { SectionComponentProps } from '../types'
import { useDittoConfirmation } from '../hooks/useDittoConfirmation'
import useTransLockdropClaim from '@/components/trans-lockdrop/hooks/useTransLockdropClaim'
import { useIntentBoosts } from '@/hooks/useIntentBoosts'
import { useUserLockdropIntents } from '@/hooks/useUserLockdropIntents'
import { useLockdropClaimsReady } from '../hooks/useLockdropNotifications'
import { useDiscoAssets } from '@/hooks/useDiscoData'
import { queryClient } from '@/pages/_app'
import type { MbrnClaimIntent, MbrnIntentOption, MbrnIntentType, Locked } from '@/types/lockdropIntents'

interface IntentConfig {
    type: 'stake' | 'deposit' | 'send'
    enabled: boolean
    ratio: number // 0-100
    lockDays: number // 0-365
    // For deposit
    asset?: string
    targetLtv?: string
    targetMaxBorrowLtv?: string
    // For send
    address?: string
}

export const LockdropSettingsSection: React.FC<SectionComponentProps> = ({ onBack }) => {
    const { openConfirmation } = useDittoConfirmation()
    const { data: discoAssets } = useDiscoAssets()
    const { data: userIntents, refetch: refetchIntents } = useUserLockdropIntents()
    const { claimsReady, claimableAmount } = useLockdropClaimsReady()

    // Intent configurations
    const [intents, setIntents] = useState<IntentConfig[]>([
        { type: 'stake', enabled: false, ratio: 0, lockDays: 0 },
        { type: 'deposit', enabled: false, ratio: 0, lockDays: 0, asset: '', targetLtv: '', targetMaxBorrowLtv: '' },
        { type: 'send', enabled: false, ratio: 0, address: '' },
    ])

    // Load existing intents
    useEffect(() => {
        if (userIntents?.intents && userIntents.intents.length > 0) {
            const newIntents: IntentConfig[] = [
                { type: 'stake', enabled: false, ratio: 0, lockDays: 0 },
                { type: 'deposit', enabled: false, ratio: 0, lockDays: 0, asset: '', targetLtv: '', targetMaxBorrowLtv: '' },
                { type: 'send', enabled: false, ratio: 0, address: '' },
            ]

            userIntents.intents.forEach((intent: MbrnIntentOption) => {
                const ratio = parseFloat(intent.ratio) * 100
                const lockDays = intent.lock
                    ? Math.floor((parseInt(intent.lock.locked_until) - Math.floor(Date.now() / 1000)) / 86400)
                    : 0

                if ('stake' in intent.intent_type) {
                    newIntents[0] = {
                        type: 'stake',
                        enabled: true,
                        ratio,
                        lockDays: Math.max(0, lockDays),
                    }
                } else if ('deposit_via_mars_mirror' in intent.intent_type) {
                    const deposit = intent.intent_type.deposit_via_mars_mirror
                    newIntents[1] = {
                        type: 'deposit',
                        enabled: true,
                        ratio,
                        lockDays: Math.max(0, lockDays),
                        asset: deposit.asset || '',
                        targetLtv: deposit.target_ltv || '',
                        targetMaxBorrowLtv: deposit.target_max_borrow_ltv || '',
                    }
                } else if ('send_to_address' in intent.intent_type) {
                    newIntents[2] = {
                        type: 'send',
                        enabled: true,
                        ratio,
                        address: intent.intent_type.send_to_address.address || '',
                    }
                }
            })

            setIntents(newIntents)
        }
    }, [userIntents])

    // Calculate total ratio
    const totalRatio = useMemo(() => {
        return intents.reduce((sum, intent) => sum + (intent.enabled ? intent.ratio : 0), 0)
    }, [intents])

    // Build MbrnIntentOption array for boost query
    const intentOptionsForBoost = useMemo((): MbrnIntentOption[] => {
        const currentTime = Math.floor(Date.now() / 1000)
        return intents
            .filter(intent => intent.enabled && intent.ratio > 0)
            .map(intent => {
                let intentType: MbrnIntentType
                let lock: Locked | null = null

                if (intent.type === 'stake') {
                    intentType = { stake: {} }
                    if (intent.lockDays > 0) {
                        lock = {
                            locked_until: String(currentTime + intent.lockDays * 86400),
                            intended_lock_days: String(intent.lockDays),
                        }
                    }
                } else if (intent.type === 'deposit') {
                    intentType = {
                        deposit_via_mars_mirror: {
                            asset: intent.asset || '',
                            target_ltv: intent.targetLtv || null,
                            target_max_borrow_ltv: intent.targetMaxBorrowLtv || null,
                        },
                    }
                    if (intent.lockDays > 0) {
                        lock = {
                            locked_until: String(currentTime + intent.lockDays * 86400),
                            intended_lock_days: String(intent.lockDays),
                        }
                    }
                } else {
                    intentType = {
                        send_to_address: {
                            address: intent.address || '',
                        },
                    }
                }

                return {
                    intent_type: intentType,
                    ratio: String(intent.ratio / 100),
                    lock: lock || null,
                }
            })
    }, [intents])

    // Query boosts (using a mock claimable amount of 1000 for preview)
    const { data: boostsData } = useIntentBoosts(intentOptionsForBoost)

    // Update intent
    const updateIntent = (index: number, updates: Partial<IntentConfig>) => {
        const newIntents = [...intents]
        newIntents[index] = { ...newIntents[index], ...updates }
        setIntents(newIntents)
    }

    // Toggle intent
    const toggleIntent = (index: number) => {
        const newIntents = [...intents]
        newIntents[index].enabled = !newIntents[index].enabled
        if (!newIntents[index].enabled) {
            newIntents[index].ratio = 0
        }
        setIntents(newIntents)
    }

    // Normalize ratios
    const normalizeRatios = () => {
        const enabledIntents = intents.filter(i => i.enabled)
        if (enabledIntents.length === 0) return

        const total = enabledIntents.reduce((sum, i) => sum + i.ratio, 0)
        if (total === 0) return

        const newIntents = intents.map(intent => {
            if (intent.enabled) {
                return {
                    ...intent,
                    ratio: (intent.ratio / total) * 100,
                }
            }
            return intent
        })
        setIntents(newIntents)
    }

    // Build MbrnClaimIntent for updating (set_ongoing=true, apply_now=false)
    const buildUpdateIntent = (): MbrnClaimIntent | undefined => {
        const enabledIntents = intents.filter(i => i.enabled && i.ratio > 0)
        if (enabledIntents.length === 0) {
            // If no intents, we still need to clear by setting empty array
            return {
                apply_now: false,
                set_ongoing: true,
                intents: [],
            }
        }

        const currentTime = Math.floor(Date.now() / 1000)
        const intentOptions: MbrnIntentOption[] = enabledIntents.map(intent => {
            let intentType: MbrnIntentType
            let lock: Locked | null = null

            if (intent.type === 'stake') {
                intentType = { stake: {} }
                if (intent.lockDays > 0) {
                    lock = {
                        locked_until: String(currentTime + intent.lockDays * 86400),
                        intended_lock_days: String(intent.lockDays),
                    }
                }
            } else if (intent.type === 'deposit') {
                intentType = {
                    deposit_via_mars_mirror: {
                        asset: intent.asset || '',
                        target_ltv: intent.targetLtv || null,
                        target_max_borrow_ltv: intent.targetMaxBorrowLtv || null,
                    },
                }
                if (intent.lockDays > 0) {
                    lock = {
                        locked_until: String(currentTime + intent.lockDays * 86400),
                        intended_lock_days: String(intent.lockDays),
                    }
                }
            } else {
                intentType = {
                    send_to_address: {
                        address: intent.address || '',
                    },
                }
            }

            return {
                intent_type: intentType,
                ratio: String(intent.ratio / 100),
                lock: lock || null,
            }
        })

        // For settings, we need to actually claim to save intents
        // So we use apply_now=true and set_ongoing=true
        // This will claim (if available) and save the intents
        return {
            apply_now: true,
            set_ongoing: true,
            intents: intentOptions,
        }
    }

    // Update hook (uses claim with set_ongoing=true, apply_now=false)
    const updateHook = useTransLockdropClaim({
        mbrnIntent: buildUpdateIntent(),
        txSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['user_lockdrop_intents'] })
            refetchIntents()
        },
    })

    // Validation
    const isValid = useMemo(() => {
        // Can only update if claims are ready (need to claim to save intents)
        if (!claimsReady || claimableAmount <= 0) return false

        const enabledIntents = intents.filter(i => i.enabled && i.ratio > 0)
        if (enabledIntents.length === 0) return false // Can't clear without claiming

        if (totalRatio < 99 || totalRatio > 101) return false

        // Validate deposit intent
        const depositIntent = intents.find(i => i.type === 'deposit' && i.enabled)
        if (depositIntent && depositIntent.ratio > 0) {
            if (!depositIntent.asset) return false
        }

        // Validate send intent
        const sendIntent = intents.find(i => i.type === 'send' && i.enabled)
        if (sendIntent && sendIntent.ratio > 0) {
            if (!sendIntent.address || sendIntent.address.length < 20) return false
        }

        return true
    }, [intents, totalRatio])

    const handleUpdate = () => {
        if (!isValid || !updateHook.action?.simulate?.data) return

        const enabledIntents = intents.filter(i => i.enabled && i.ratio > 0)

        openConfirmation(
            updateHook.action,
            <VStack spacing={2} align="stretch" p={2}>
                <Text fontSize="sm" color="#F5F5F580">
                    Claiming {claimableAmount.toFixed(2)} MBRN and updating ongoing intents
                </Text>
                <Divider />
                {enabledIntents.map((intent, idx) => (
                    <Box key={idx}>
                        <Text fontSize="xs" color="#F5F5F580">
                            {intent.type === 'stake' && 'Stake'}
                            {intent.type === 'deposit' && 'Deposit to Disco'}
                            {intent.type === 'send' && 'Send to Address'}
                            : {intent.ratio.toFixed(1)}%
                        </Text>
                    </Box>
                ))}
                <Text fontSize="xs" color="purple.400" mt={2}>
                    These intents will be saved for future claims
                </Text>
            </VStack>,
            { label: 'Claim & Update', actionType: 'withdraw' }
        )
    }

    const enabledIntentsCount = intents.filter(i => i.enabled).length

    return (
        <VStack spacing={4} align="stretch" w="100%">
            <Text fontSize="sm" fontWeight="bold" color="purple.400">
                Ongoing Lockdrop Claim Intents
            </Text>

            {/* Info message if claims not ready */}
            {(!claimsReady || claimableAmount <= 0) && (
                <Box p={4} bg="gray.800" borderRadius="md" border="1px solid" borderColor="gray.700">
                    <Text fontSize="xs" color="#F5F5F580" textAlign="center" mb={2}>
                        {claimableAmount <= 0
                            ? 'No claims available. Intents can only be updated when claiming.'
                            : 'Claims will be available after withdrawal period ends. Intents can only be updated when claiming.'}
                    </Text>
                    {userIntents?.intents && userIntents.intents.length > 0 && (
                        <Text fontSize="xs" color="purple.400" textAlign="center" mt={2}>
                            Current ongoing intents will be used for your next claim.
                        </Text>
                    )}
                </Box>
            )}

            {/* Info message if no intents configured */}
            {(!userIntents?.intents || userIntents.intents.length === 0) && (
                <Box p={4} bg="gray.800" borderRadius="md" border="1px solid" borderColor="gray.700">
                    <Text fontSize="xs" color="#F5F5F580" textAlign="center">
                        No ongoing intents configured. Configure intents below and they will be saved when you claim.
                    </Text>
                </Box>
            )}

            {/* Always show intent configuration form */}
            <VStack spacing={3} align="stretch">
                {/* Intent Configuration */}
                {intents.map((intent, index) => {
                    const isStake = intent.type === 'stake'
                    const isDeposit = intent.type === 'deposit'
                    const isSend = intent.type === 'send'
                    // Find boost for this intent (only enabled intents with ratio > 0 have boosts)
                    const enabledBeforeThis = intents.slice(0, index).filter(i => i.enabled && i.ratio > 0).length
                    const currentBoost = intent.enabled && intent.ratio > 0 && boostsData?.boosts && boostsData.boosts.length > enabledBeforeThis
                        ? boostsData.boosts[enabledBeforeThis]
                        : null
                    const boostPercent = currentBoost ? parseFloat(currentBoost) * 100 : 0

                    return (
                        <Box key={index} p={3} bg="gray.800" borderRadius="md" border="1px solid" borderColor="gray.700">
                            <HStack justify="space-between" mb={2}>
                                <Checkbox
                                    isChecked={intent.enabled}
                                    onChange={() => toggleIntent(index)}
                                    colorScheme="purple"
                                >
                                    <Text fontSize="xs" color="#F5F5F5">
                                        {isStake && 'Stake MBRN'}
                                        {isDeposit && 'Deposit to Disco'}
                                        {isSend && 'Send to Address'}
                                    </Text>
                                </Checkbox>
                                {intent.enabled && (
                                    <HStack spacing={2}>
                                        <NumberInput
                                            size="xs"
                                            value={intent.ratio.toFixed(1)}
                                            onChange={(_, value) => {
                                                updateIntent(index, { ratio: isNaN(value) ? 0 : Math.max(0, Math.min(100, value)) })
                                            }}
                                            min={0}
                                            max={100}
                                            w="60px"
                                        >
                                            <NumberInputField />
                                        </NumberInput>
                                        <Text fontSize="xs" color="#F5F5F580">%</Text>
                                    </HStack>
                                )}
                            </HStack>

                            {intent.enabled && (
                                <VStack spacing={2} align="stretch" mt={2}>
                                    {/* Lock Duration for Stake and Deposit */}
                                    {(isStake || isDeposit) && (
                                        <Box>
                                            <HStack justify="space-between" mb={2}>
                                                <Text fontSize="xs" color="#F5F5F580">
                                                    Lock Duration
                                                </Text>
                                                <Text fontSize="xs" color="purple.300" fontWeight="bold">
                                                    {intent.lockDays} days
                                                </Text>
                                            </HStack>
                                            <Slider
                                                value={intent.lockDays}
                                                onChange={(val) => updateIntent(index, { lockDays: val })}
                                                min={0}
                                                max={365}
                                                step={1}
                                            >
                                                <SliderTrack bg="#1A1D26" h="6px" borderRadius="full">
                                                    <SliderFilledTrack bg="purple.400" />
                                                </SliderTrack>
                                                <SliderThumb boxSize={4} bg="purple.400" border="2px solid" borderColor="white" />
                                            </Slider>
                                        </Box>
                                    )}

                                    {/* Deposit-specific fields */}
                                    {isDeposit && (
                                        <>
                                            <Box>
                                                <Text fontSize="xs" color="#F5F5F580" mb={1}>
                                                    Asset
                                                </Text>
                                                <Select
                                                    size="xs"
                                                    value={intent.asset || ''}
                                                    onChange={(e) => updateIntent(index, { asset: e.target.value })}
                                                    bg="#1A1D26"
                                                    borderColor="#6943FF30"
                                                >
                                                    <option value="">Select asset</option>
                                                    {discoAssets?.assets?.map((asset: string) => (
                                                        <option key={asset} value={asset}>
                                                            {asset}
                                                        </option>
                                                    ))}
                                                </Select>
                                            </Box>
                                            <HStack spacing={2}>
                                                <Box flex={1}>
                                                    <Text fontSize="xs" color="#F5F5F580" mb={1}>
                                                        Target LTV (optional)
                                                    </Text>
                                                    <Input
                                                        size="xs"
                                                        value={intent.targetLtv || ''}
                                                        onChange={(e) => updateIntent(index, { targetLtv: e.target.value })}
                                                        placeholder="0.75"
                                                        bg="#1A1D26"
                                                        borderColor="#6943FF30"
                                                    />
                                                </Box>
                                                <Box flex={1}>
                                                    <Text fontSize="xs" color="#F5F5F580" mb={1}>
                                                        Max Borrow LTV (optional)
                                                    </Text>
                                                    <Input
                                                        size="xs"
                                                        value={intent.targetMaxBorrowLtv || ''}
                                                        onChange={(e) => updateIntent(index, { targetMaxBorrowLtv: e.target.value })}
                                                        placeholder="0.70"
                                                        bg="#1A1D26"
                                                        borderColor="#6943FF30"
                                                    />
                                                </Box>
                                            </HStack>
                                        </>
                                    )}

                                    {/* Send-specific fields */}
                                    {isSend && (
                                        <Box>
                                            <Text fontSize="xs" color="#F5F5F580" mb={1}>
                                                Address
                                            </Text>
                                            <Input
                                                size="xs"
                                                value={intent.address || ''}
                                                onChange={(e) => updateIntent(index, { address: e.target.value })}
                                                placeholder="osmo1..."
                                                bg="#1A1D26"
                                                borderColor="#6943FF30"
                                            />
                                        </Box>
                                    )}

                                    {/* Boost Display */}
                                    {boostPercent > 0 && (
                                        <Box p={2} bg="green.900" borderRadius="md" border="1px solid" borderColor="green.500">
                                            <HStack justify="space-between">
                                                <Text fontSize="xs" color="#F5F5F580">
                                                    Boost Preview
                                                </Text>
                                                <Text fontSize="xs" color="green.400" fontWeight="bold">
                                                    +{boostPercent.toFixed(2)}%
                                                </Text>
                                            </HStack>
                                        </Box>
                                    )}
                                </VStack>
                            )}
                        </Box>
                    )
                })}

                {/* Ratio Summary */}
                {enabledIntentsCount > 0 && (
                    <Box p={2} bg={totalRatio >= 99 && totalRatio <= 101 ? 'green.900' : 'red.900'} borderRadius="md" border="1px solid" borderColor={totalRatio >= 99 && totalRatio <= 101 ? 'green.500' : 'red.500'}>
                        <HStack justify="space-between">
                            <Text fontSize="xs" color="#F5F5F580">
                                Total Ratio
                            </Text>
                            <Text fontSize="xs" color={totalRatio >= 99 && totalRatio <= 101 ? 'green.400' : 'red.400'} fontWeight="bold">
                                {totalRatio.toFixed(2)}%
                            </Text>
                        </HStack>
                        {totalRatio !== 100 && enabledIntentsCount > 0 && (
                            <Button size="xs" mt={2} onClick={normalizeRatios} colorScheme="purple">
                                Normalize to 100%
                            </Button>
                        )}
                    </Box>
                )}

                {/* Update Button - disabled if claims not ready */}
                <Button
                    onClick={handleUpdate}
                    isDisabled={!isValid || !updateHook.action?.simulate?.data || !claimsReady || claimableAmount <= 0}
                    isLoading={updateHook.action?.tx?.isPending}
                    colorScheme="purple"
                    size="md"
                >
                    {!claimsReady || claimableAmount <= 0
                        ? 'Update Intents (Requires Available Claims)'
                        : intents.filter(i => i.enabled && i.ratio > 0).length === 0
                            ? 'Clear Ongoing Intents'
                            : `Claim ${claimableAmount.toFixed(2)} MBRN & Update Intents`}
                </Button>
            </VStack>
        </VStack>
    )
}

