import React from 'react'
import {
    VStack,
    HStack,
    Text,
    Box,
    Radio,
    RadioGroup,
    Select,
    Slider,
    SliderTrack,
    SliderFilledTrack,
    SliderThumb,
} from '@chakra-ui/react'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { FOCUS_STYLES } from '@/config/transitions'
import { getSlotLabel } from '@/components/Disco/types'
import type { IntentConfig } from './hooks/useAcquisitionClaimCard'
import type { useDiscoAssets } from '@/hooks/useDiscoData'

type DiscoAssetsData = ReturnType<typeof useDiscoAssets>['data']

interface AcquisitionClaimIntentSelectorProps {
    radioGroupRef: React.RefObject<HTMLDivElement>
    selectedIntentType: 'stake' | 'deposit' | null
    setSelectedIntentType: React.Dispatch<React.SetStateAction<'stake' | 'deposit' | null>>
    handleRadioChange: (value: string) => void
    intents: IntentConfig[]
    setIntents: React.Dispatch<React.SetStateAction<IntentConfig[]>>
    updateIntent: (type: 'stake' | 'deposit', updates: Partial<IntentConfig>) => void
    discoAssets: DiscoAssetsData
}

export const AcquisitionClaimIntentSelector: React.FC<AcquisitionClaimIntentSelectorProps> = ({
    radioGroupRef,
    selectedIntentType,
    setSelectedIntentType,
    handleRadioChange,
    intents,
    setIntents,
    updateIntent,
    discoAssets,
}) => {
    return (
        <RadioGroup ref={radioGroupRef} value={selectedIntentType || ''} onChange={handleRadioChange}>
            <VStack spacing={3} align="stretch">
                {intents.map((intent, index) => {
                    const isStake = intent.type === 'stake'
                    const isDeposit = intent.type === 'deposit'
                    const isSelected = selectedIntentType === intent.type

                    return (
                        <Box
                            key={index}
                            role="button"
                            tabIndex={0}
                            aria-pressed={isSelected}
                            p={3}
                            bg={SEMANTIC_COLORS.bgTertiary}
                            borderRadius={0}
                            border="1px solid"
                            borderColor={isSelected ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.borderSubtle}
                            cursor="pointer"
                            _focus={FOCUS_STYLES.ring}
                            _focusVisible={FOCUS_STYLES.ring}
                            onClick={(e) => {
                                // If clicking on the box when already selected, deselect it
                                if (isSelected) {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    // Manually uncheck the radio input
                                    const radioInput = e.currentTarget.querySelector(`input[type="radio"][value="${intent.type}"]`) as HTMLInputElement
                                    if (radioInput) {
                                        radioInput.checked = false
                                    }
                                    setSelectedIntentType(null)
                                    const newIntents = intents.map(i => ({
                                        ...i,
                                        enabled: false,
                                    }))
                                    setIntents(newIntents)
                                }
                            }}
                            onKeyDown={(e) => {
                                // Keyboard parity with the click-to-deselect above
                                if ((e.key === 'Enter' || e.key === ' ') && isSelected) {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    const radioInput = e.currentTarget.querySelector(`input[type="radio"][value="${intent.type}"]`) as HTMLInputElement
                                    if (radioInput) {
                                        radioInput.checked = false
                                    }
                                    setSelectedIntentType(null)
                                    const newIntents = intents.map(i => ({
                                        ...i,
                                        enabled: false,
                                    }))
                                    setIntents(newIntents)
                                }
                            }}
                        >
                            <HStack spacing={3} align="flex-start">
                                <Radio
                                    value={intent.type}
                                    colorScheme="primary"
                                    mt={1}
                                    _focus={FOCUS_STYLES.ring}
                                    _focusVisible={FOCUS_STYLES.ring}
                                >
                                    <Text fontSize="xs" color={SEMANTIC_COLORS.textPrimary}>
                                        {isStake && 'Stake MBRN'}
                                        {isDeposit && 'Deposit to Disco'}
                                    </Text>
                                </Radio>
                            </HStack>

                            {isSelected && (
                                <VStack spacing={2} align="stretch" mt={3}>
                                    {/* Deposit-specific fields - only show when deposit is selected, at the top */}
                                    {isDeposit && (
                                        <>
                                            <Box>
                                                <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} mb={1}>
                                                    Asset
                                                </Text>
                                                <Select
                                                    size="xs"
                                                    value={intent.asset || ''}
                                                    onChange={(e) => {
                                                        if (intent.type === 'deposit') {
                                                            updateIntent(intent.type, { asset: e.target.value })
                                                        }
                                                    }}
                                                    bg={SEMANTIC_COLORS.bgSecondary}
                                                    borderColor={SEMANTIC_COLORS.borderSubtle}
                                                    borderRadius={0}
                                                    _focus={FOCUS_STYLES.ring}
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
                                                    onChange={(e) => {
                                                        if (intent.type === 'deposit') {
                                                            updateIntent(intent.type, { slot: parseInt(e.target.value) })
                                                        }
                                                    }}
                                                    bg={SEMANTIC_COLORS.bgSecondary}
                                                    borderColor={SEMANTIC_COLORS.borderSubtle}
                                                    borderRadius={0}
                                                    _focus={FOCUS_STYLES.ring}
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

                                    {/* Lock Duration for Stake and Deposit */}
                                    <Box>
                                        <HStack justify="space-between" mb={2}>
                                            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                                                Lock Duration {isStake && '(3 day unstake)'}
                                            </Text>
                                            <Text fontSize="xs" color={SEMANTIC_COLORS.primary} fontWeight="bold">
                                                {intent.lockDays || 0} days
                                            </Text>
                                        </HStack>
                                        <Slider
                                            value={intent.lockDays || 0}
                                            onChange={(val) => {
                                                if (intent.type === 'stake' || intent.type === 'deposit') {
                                                    updateIntent(intent.type, { lockDays: val })
                                                }
                                            }}
                                            min={0}
                                            max={365}
                                            step={1}
                                        >
                                            <SliderTrack bg={SEMANTIC_COLORS.borderStrong} h="6px" borderRadius={0}>
                                                <SliderFilledTrack bg={SEMANTIC_COLORS.primary} />
                                            </SliderTrack>
                                            <SliderThumb boxSize={4} bg={SEMANTIC_COLORS.primary} border="2px solid" borderColor={SEMANTIC_COLORS.textPrimary} _focus={FOCUS_STYLES.ring} _focusVisible={FOCUS_STYLES.ring} />
                                        </Slider>
                                    </Box>

                                    {/* Boost Display */}
                                    {/* DISABLED: Intent boost display removed */}
                                </VStack>
                            )}
                        </Box>
                    )
                })}
            </VStack>
        </RadioGroup>
    )
}

export default AcquisitionClaimIntentSelector
