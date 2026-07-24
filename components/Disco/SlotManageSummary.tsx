import React from 'react'
import { HStack, Stack, Text } from '@chakra-ui/react'
import type { SlotData } from './SlotManageHelpers'

interface SlotManageSummaryProps {
    slotData: SlotData
    unstakingAmount: number
    isLiquidationLockout: boolean
    unstakeHoursLeft: number
}

// Slot summary stats row (Deposited / APR / Claimable / Unstaking).
export const SlotManageSummary: React.FC<SlotManageSummaryProps> = ({
    slotData,
    unstakingAmount,
    isLiquidationLockout,
    unstakeHoursLeft,
}) => {
    return (
        <HStack spacing={3} justify="space-around" py={2}>
            <Stack spacing={0} align="center">
                <Text color="whiteAlpha.500" fontSize="xs" fontFamily="mono">
                    Deposited
                </Text>
                <Text color="white" fontSize="md" fontWeight="bold" fontFamily="'Neon Tubes', mono">
                    {slotData.amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </Text>
            </Stack>
            <Stack spacing={0} align="center">
                <Text color="whiteAlpha.500" fontSize="xs" fontFamily="mono">
                    APR
                </Text>
                <Text color="secondary.400" fontSize="md" fontWeight="bold" fontFamily="'Neon Tubes', mono">
                    {slotData.apr.toFixed(1)}%
                </Text>
            </Stack>
            <Stack spacing={0} align="center">
                <Text color="whiteAlpha.500" fontSize="xs" fontFamily="mono">
                    Claimable
                </Text>
                <Text color="secondary.400" fontSize="md" fontWeight="bold" fontFamily="'Neon Tubes', mono">
                    {slotData.claimable.toFixed(2)}
                </Text>
            </Stack>
            {unstakingAmount > 0 && (
                <Stack spacing={0} align="center" position="relative">
                    <Text color="whiteAlpha.500" fontSize="xs" fontFamily="mono">
                        Unstaking
                    </Text>
                    <Text color="orange.300" fontSize="md" fontWeight="bold" fontFamily="'Neon Tubes', mono">
                        {unstakingAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </Text>
                    <Text
                        color={isLiquidationLockout ? "orange.400" : "whiteAlpha.400"}
                        fontSize="10px"
                        fontFamily="mono"
                        position="absolute"
                        top="100%"
                        whiteSpace="nowrap"
                    >
                        {isLiquidationLockout ? `Liq lockout · ${unstakeHoursLeft}h` : `${unstakeHoursLeft}h left`}
                    </Text>
                </Stack>
            )}
        </HStack>
    )
}
