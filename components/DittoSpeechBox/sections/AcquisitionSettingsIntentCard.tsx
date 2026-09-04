import React from 'react'
import {
    VStack,
    HStack,
    Text,
    Box,
    Checkbox,
    NumberInput,
    NumberInputField,
    Slider,
    SliderTrack,
    SliderFilledTrack,
    SliderThumb,
    Select,
    Input,
} from '@chakra-ui/react'
import { useDiscoAssets } from '@/hooks/useDiscoData'
import { getSlotLabel } from '@/components/Disco/types'
import type { IntentConfig } from './AcquisitionSettingsTypes'

import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'

interface AcquisitionSettingsIntentCardProps {
    intent: IntentConfig
    index: number
    discoAssets: ReturnType<typeof useDiscoAssets>['data']
    updateIntent: (index: number, updates: Partial<IntentConfig>) => void
    toggleIntent: (index: number) => void
}

export const AcquisitionSettingsIntentCard: React.FC<AcquisitionSettingsIntentCardProps> = ({
    intent,
    index,
    discoAssets,
    updateIntent,
    toggleIntent,
}) => {
    const isStake = intent.type === 'stake'
    const isDeposit = intent.type === 'deposit'
    const isSend = intent.type === 'send'
    // DISABLED: Intent boosts disabled
    // const enabledBeforeThis = intents.slice(0, index).filter(i => i.enabled && i.ratio > 0).length
    // const currentBoost = ...
    // const boostPercent = ...

    return (
        <Box p={SPACING.md} bg={SEMANTIC_COLORS.bgSecondary} borderRadius={0} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
            <HStack justify="space-between" mb={2}>
                <Checkbox
                    isChecked={intent.enabled}
                    onChange={() => toggleIntent(index)}
                    colorScheme="primary"
                >
                    <Text fontSize="xs" color={SEMANTIC_COLORS.textPrimary}>
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
                        <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>%</Text>
                    </HStack>
                )}
            </HStack>

            {intent.enabled && (
                <VStack spacing={2} align="stretch" mt={2}>
                    {/* Lock Duration for Stake and Deposit */}
                    {(isStake || isDeposit) && (
                        <Box>
                            <HStack justify="space-between" mb={2}>
                                <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                                    Lock Duration
                                </Text>
                                <Text fontSize="xs" color={SEMANTIC_COLORS.primary} fontWeight="bold">
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
                                <SliderTrack bg={SEMANTIC_COLORS.bgSecondary} h="6px" borderRadius={0}>
                                    <SliderFilledTrack bg={SEMANTIC_COLORS.primary} />
                                </SliderTrack>
                                <SliderThumb
                                    boxSize={4}
                                    bg={SEMANTIC_COLORS.primary}
                                    border="2px solid"
                                    borderColor={SEMANTIC_COLORS.bgPrimary}
                                    _focus={FOCUS_STYLES.ring}
                                    _focusVisible={FOCUS_STYLES.ring}
                                />
                            </Slider>
                        </Box>
                    )}

                    {/* Deposit-specific fields */}
                    {isDeposit && (
                        <>
                            <Box>
                                <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} mb={1}>
                                    Asset
                                </Text>
                                <Select
                                    size="xs"
                                    value={intent.asset || ''}
                                    onChange={(e) => updateIntent(index, { asset: e.target.value })}
                                    bg={SEMANTIC_COLORS.bgSecondary}
                                    borderColor="color-mix(in srgb, var(--m-primary) 19%, transparent)"
                                >
                                    <option value="">Select asset</option>
                                    {discoAssets?.assets?.map((asset: string) => (
                                        <option key={asset} value={asset}>
                                            {asset}
                                        </option>
                                    ))}
                                </Select>
                            </Box>
                            <Box>
                                <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} mb={1}>
                                    Insurance Slot
                                </Text>
                                <Select
                                    size="xs"
                                    value={intent.slot || 5}
                                    onChange={(e) => updateIntent(index, { slot: parseInt(e.target.value) })}
                                    bg={SEMANTIC_COLORS.bgSecondary}
                                    borderColor="color-mix(in srgb, var(--m-primary) 19%, transparent)"
                                >
                                    {[90, 85, 80, 75, 70, 65, 60, 55, 50].map((slot) => (
                                        <option key={slot} value={slot}>
                                            Slot {getSlotLabel(slot)}
                                        </option>
                                    ))}
                                </Select>
                            </Box>
                        </>
                    )}

                    {/* Send-specific fields */}
                    {isSend && (
                        <Box>
                            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} mb={1}>
                                Address
                            </Text>
                            <Input
                                size="xs"
                                value={intent.address || ''}
                                onChange={(e) => updateIntent(index, { address: e.target.value })}
                                placeholder="osmo1..."
                                bg={SEMANTIC_COLORS.bgSecondary}
                                borderColor="color-mix(in srgb, var(--m-primary) 19%, transparent)"
                            />
                        </Box>
                    )}

                    {/* DISABLED: Intent boost display removed */}
                </VStack>
            )}
        </Box>
    )
}
