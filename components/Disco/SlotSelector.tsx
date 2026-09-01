import React, { useMemo } from 'react'
import { Box, VStack, HStack, Text } from '@chakra-ui/react'
import type { SlotData } from './types'
import { shiftDigits } from '@/helpers/math'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { riskRgbAtIndex, riskRgba } from './riskRamp'

// Phosphor. Was named PRIMARY_PURPLE with an rgb() value: the migration swapped the
// value to phosphor but left the name, and `${rgb(...)}80` hex-alpha suffixes built
// on it were invalid CSS that silently did nothing. A hex token makes them valid.
const PHOSPHOR = SEMANTIC_COLORS.primary

// Hue encodes waterfall position; opacity encodes proportional TVL.
const getSlotColor = (index: number, totalSlots: number, tvlRatio: number, isSelected: boolean) => {
    const base = isSelected ? 0.3 : 0.15
    const max = isSelected ? 1 : 0.85
    return riskRgba(riskRgbAtIndex(index, totalSlots), base + (max - base) * tvlRatio)
}

const SCROLLBAR_CSS = {
    '&::-webkit-scrollbar': { width: '4px' },
    '&::-webkit-scrollbar-track': { bg: 'transparent' },
    '&::-webkit-scrollbar-thumb': { bg: 'rgba(155, 220, 79, 0.3)', borderRadius: '2px' },
}

interface SlotSelectorProps {
    slots: SlotData[]
    selectedSlot: number | null
    onSlotSelect: (slot: number) => void
}

export const SlotSelector: React.FC<SlotSelectorProps> = ({ slots, selectedSlot, onSlotSelect }) => {
    // Slots come pre-sorted descending by LTV (highest/riskiest first)
    const totalSlots = slots.length

    // Find max TVL for proportional bar widths
    const maxTvl = useMemo(() => {
        return Math.max(...slots.map(s => s.tvl), 1)
    }, [slots])

    return (
        <VStack spacing={2} align="stretch" w="100%">
            <Text
                fontSize="xs"
                fontWeight="bold"
                color={PHOSPHOR}
                fontFamily="mono"
                letterSpacing="1px"
                textTransform="uppercase"
                mb={1}
            >
                Loss Absorption Waterfall
            </Text>

            <Box
                maxH="450px"
                overflowY="auto"
                css={SCROLLBAR_CSS}
            >
                <VStack spacing={2} align="stretch">
                    {slots.map((slot, idx) => {
                        const isSelected = selectedSlot === slot.slot
                        const fillPct = maxTvl > 0 ? (slot.tvl / maxTvl) * 100 : 0
                        const tvlRatio = maxTvl > 0 ? slot.tvl / maxTvl : 0
                        const tvlDisplay = slot.tvl > 0
                            ? parseFloat(shiftDigits(slot.tvl.toString(), -6).toString()).toLocaleString('en-US', { maximumFractionDigits: 0 })
                            : '0'

                        const barColor = getSlotColor(idx, totalSlots, tvlRatio, isSelected)
                        const borderCol = isSelected ? PHOSPHOR : SEMANTIC_COLORS.borderSubtle

                        return (
                            <Box
                                key={slot.slot}
                                position="relative"
                                px={3}
                                py={2.5}
                                borderRadius={0}
                                cursor="pointer"
                                border="1px solid"
                                borderColor={borderCol}
                                bg={SEMANTIC_COLORS.bgSecondary}
                                overflow="hidden"
                                // Border-only hover: the design system allows colour/border
                                // transitions and bans lift, scale and glow on interactive UI.
                                _hover={{ borderColor: `${PHOSPHOR}80` }}
                                _focusVisible={FOCUS_STYLES.ring}
                                transition={TRANSITIONS.colors}
                                onClick={() => onSlotSelect(slot.slot)}
                                tabIndex={0}
                                role="button"
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault()
                                        onSlotSelect(slot.slot)
                                    }
                                }}
                            >
                                {/* TVL fill bar (background) */}
                                <Box
                                    position="absolute"
                                    top={0}
                                    left={0}
                                    bottom={0}
                                    w={`${Math.max(fillPct, 2)}%`}
                                    bg={barColor}
                                    borderRadius="md"
                                    transition="width 0.4s ease, background 0.2s ease"
                                />

                                {/* Content (above bar) */}
                                <HStack justify="space-between" spacing={2} position="relative" zIndex={1}>
                                    <Text
                                        fontSize="sm"
                                        fontWeight="bold"
                                        color={isSelected ? 'white' : 'whiteAlpha.900'}
                                        fontFamily="mono"
                                        minW="36px"
                                    >
                                        {slot.ltvLabel}
                                    </Text>
                                    <Text
                                        fontSize="xs"
                                        fontWeight="bold"
                                        color={slot.tvl > 0 ? (isSelected ? 'white' : 'whiteAlpha.800') : 'transparent'}
                                        fontFamily="mono"
                                    >
                                        {tvlDisplay}
                                    </Text>
                                </HStack>
                            </Box>
                        )
                    })}
                </VStack>
            </Box>
        </VStack>
    )
}
