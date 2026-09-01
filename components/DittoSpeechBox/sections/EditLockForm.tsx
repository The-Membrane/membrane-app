import React, { useState } from 'react'
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
} from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

interface EditLockFormProps {
    depositType: 'staking' | 'disco'
    currentLockDays: number
    onSubmit: (newLockDays: number) => void
}

export const EditLockForm: React.FC<EditLockFormProps> = ({ depositType, currentLockDays, onSubmit }) => {
    const [lockDays, setLockDays] = useState(currentLockDays)

    const handleSubmit = () => {
        if (lockDays <= currentLockDays) return
        onSubmit(lockDays)
    }

    const isStaking = depositType === 'staking'
    const maxLockDays = 365
    const canExtend = lockDays > currentLockDays

    return (
        <VStack align="stretch" spacing={4} w="100%" h="100%" pb="50px" overflowY="auto">
            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontWeight="bold" textTransform="uppercase">
                Extend Lock Duration
            </Text>

            {/* Current Lock Info */}
            <Box
                bg={SEMANTIC_COLORS.bgSecondary}
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                borderRadius={0}
                p={SPACING.md}
            >
                <HStack justify="space-between">
                    <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                        Current Lock
                    </Text>
                    <Text fontSize="xs" color={SEMANTIC_COLORS.primary} fontWeight="bold">
                        {currentLockDays} days remaining
                    </Text>
                </HStack>
            </Box>

            {/* Lock Days Slider */}
            <Box>
                <HStack justify="space-between" mb={2}>
                    <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                        New Lock Duration
                    </Text>
                    <Text fontSize="xs" color={canExtend ? SEMANTIC_COLORS.info : SEMANTIC_COLORS.textSecondary} fontWeight="bold">
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
                    <SliderTrack bg={SEMANTIC_COLORS.bgSecondary} h="6px" borderRadius={0}>
                        <SliderFilledTrack bg={canExtend ? SEMANTIC_COLORS.info : SEMANTIC_COLORS.textTertiary} />
                    </SliderTrack>
                    <SliderThumb
                        boxSize={4}
                        bg={canExtend ? SEMANTIC_COLORS.info : SEMANTIC_COLORS.textTertiary}
                        border="2px solid"
                        borderColor={SEMANTIC_COLORS.bgPrimary}
                        _focus={FOCUS_STYLES.ring}
                        _focusVisible={FOCUS_STYLES.ring}
                    />
                </Slider>
                <HStack justify="space-between" mt={1}>
                    <Text fontSize="2xs" color={SEMANTIC_COLORS.textTertiary}>{currentLockDays}</Text>
                    <Text fontSize="2xs" color={SEMANTIC_COLORS.textTertiary}>{maxLockDays}</Text>
                </HStack>
            </Box>

            {/* Extension Preview */}
            {canExtend && (
                <Box
                    bg={SEMANTIC_COLORS.bgSecondary}
                    border="1px solid"
                    borderColor={SEMANTIC_COLORS.borderSubtle}
                    borderRadius={0}
                    p={SPACING.md}
                >
                    <VStack align="stretch" spacing={2}>
                        <HStack justify="space-between">
                            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                                Extension
                            </Text>
                            <Text fontSize="xs" color={SEMANTIC_COLORS.info} fontWeight="bold">
                                +{lockDays - currentLockDays} days
                            </Text>
                        </HStack>
                        <HStack justify="space-between">
                            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                                Effective MBRN Boost
                            </Text>
                            <Text fontSize="xs" color={SEMANTIC_COLORS.info} fontWeight="bold">
                                {(lockDays + 1).toFixed(1)}x
                            </Text>
                        </HStack>
                    </VStack>
                </Box>
            )}

            {/* Info Text */}
            <Text fontSize="2xs" color={SEMANTIC_COLORS.textTertiary}>
                Note: Lock days decrease over time as the lock period progresses. You can extend the lock to maintain or increase your boost.
            </Text>

            {/* Submit Button */}
            <Button
                position="fixed"
                bottom={0}
                left={0}
                right={0}
                size="sm"
                bg={SEMANTIC_COLORS.info}
                color={SEMANTIC_COLORS.bgPrimary}
                borderRadius={0}
                fontFamily={TYPOGRAPHY.fontMono}
                onClick={handleSubmit}
                isDisabled={!canExtend}
                transition={TRANSITIONS.colors}
                _hover={HOVER_EFFECTS.borderHighlight}
                _active={ACTIVE_EFFECTS.dim}
                _focus={FOCUS_STYLES.ring}
                _focusVisible={FOCUS_STYLES.ring}
                _disabled={{ opacity: 0.5, cursor: 'not-allowed' }}
            >
                Extend Lock
            </Button>
        </VStack>
    )
}

