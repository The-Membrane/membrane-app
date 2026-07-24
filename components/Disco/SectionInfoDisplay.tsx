import React from 'react'
import { VStack, Text } from '@chakra-ui/react'
import { shiftDigits } from '@/helpers/math'
import { getSlotLabel } from './types'
import type { SlotData } from './types'
import type { LossAbsorptionData } from './hooks/useSectionInfoData'

// Color constants
const PRIMARY_PURPLE = 'rgb(155, 220, 79)'

// Format ordinal number (1st, 2nd, 3rd, etc.)
const formatOrdinal = (n: number) => {
    const s = ['th', 'st', 'nd', 'rd']
    const v = n % 100
    return n + (s[(v - 20) % 10] || s[v] || s[0])
}

interface SectionInfoDisplayProps {
    selectedSlot: SlotData | null
    lossAbsorptionData: LossAbsorptionData
    revenueMultiplier: number | null
}

export const SectionInfoDisplay: React.FC<SectionInfoDisplayProps> = ({ selectedSlot, lossAbsorptionData, revenueMultiplier }) => {
    return selectedSlot ? (
        <VStack spacing={3} align="stretch">
            <Text
                fontSize="sm"
                fontWeight="bold"
                color={PRIMARY_PURPLE}
                fontFamily="mono"
                letterSpacing="1px"
                textTransform="uppercase"
                mb={2}
            >
                Slot {getSlotLabel(selectedSlot.slot)}
            </Text>

            {/* Loss Absorption Order */}
            <VStack spacing={0} align="flex-start">
                <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                    Loss Absorption Order
                </Text>
                <Text
                    fontSize="lg"
                    fontWeight={500}
                    color={lossAbsorptionData.position === 1 ? "red.400" : "white"}
                    fontFamily="'Neon Tubes', monospace"
                >
                    {lossAbsorptionData.position !== null
                        ? `${formatOrdinal(lossAbsorptionData.position)} Loss`
                        : 'N/A'}
                </Text>
            </VStack>

            {/* MBRN Defense Ahead */}
            <VStack spacing={0} align="flex-start">
                <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                    MBRN Defense Ahead
                </Text>
                <Text
                    fontSize="lg"
                    fontWeight={500}
                    color="white"
                    fontFamily="'Neon Tubes', monospace"
                >
                    {parseFloat(shiftDigits(lossAbsorptionData.mbrnAhead.toString(), -6).toString()).toLocaleString(undefined, { maximumFractionDigits: 0 })} MBRN
                </Text>
            </VStack>

            {/* Revenue Multiplier */}
            {revenueMultiplier !== null && (
                <VStack spacing={0} align="flex-start">
                    <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                        Revenue Multiplier
                    </Text>
                    <Text
                        fontSize="lg"
                        fontWeight={500}
                        color="secondary.400"
                        fontFamily="'Neon Tubes', monospace"
                    >
                        {revenueMultiplier.toFixed(2)}x
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
                Click a Slot to see info
            </Text>
        </VStack>
    )
}
