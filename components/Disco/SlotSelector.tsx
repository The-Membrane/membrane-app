import React, { useMemo } from 'react'
import { Box, VStack, HStack, Text } from '@chakra-ui/react'
import type { SlotData } from './types'
import { shiftDigits } from '@/helpers/math'

// Color constants
const PRIMARY_PURPLE = 'rgb(155, 220, 79)'

// Cyan-to-purple gradient: highest LTV (index 0) = cyan, lowest LTV (last) = purple
// Opacity encodes proportional TVL ratio
const getSlotColor = (index: number, totalSlots: number, tvlRatio: number, isSelected: boolean) => {
    const t = totalSlots > 1 ? index / (totalSlots - 1) : 0 // 0 = cyan, 1 = purple
    const r = Math.round(34 + (166 - 34) * t)
    const g = Math.round(211 + (146 - 211) * t)
    const b = Math.round(238 + (255 - 238) * t)
    // Opacity: base 0.15 for empty, scales up to 0.85 with TVL ratio
    const baseOpacity = isSelected ? 0.3 : 0.15
    const maxOpacity = isSelected ? 1 : 0.85
    const opacity = baseOpacity + (maxOpacity - baseOpacity) * tvlRatio
    return `rgba(${r}, ${g}, ${b}, ${opacity.toFixed(2)})`
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
                color={PRIMARY_PURPLE}
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
                        const borderCol = isSelected ? PRIMARY_PURPLE : 'rgba(155, 220, 79, 0.15)'

                        return (
                            <Box
                                key={slot.slot}
                                position="relative"
                                px={3}
                                py={2.5}
                                borderRadius="md"
                                cursor="pointer"
                                border="1px solid"
                                borderColor={borderCol}
                                bg="rgba(10, 10, 10, 0.6)"
                                overflow="hidden"
                                _hover={{
                                    borderColor: `${PRIMARY_PURPLE}80`,
                                    bg: 'rgba(10, 10, 10, 0.8)',
                                }}
                                transition="all 0.15s ease"
                                onClick={() => onSlotSelect(slot.slot)}
                                boxShadow={isSelected ? `0 0 12px ${PRIMARY_PURPLE}30` : undefined}
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
