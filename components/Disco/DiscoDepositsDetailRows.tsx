import React from 'react'
import { HStack, Text } from '@chakra-ui/react'
import { getSlotLabel } from './types'
import { PRIMARY_PURPLE } from './DiscoDepositsShared'
import type { DiscoDepositsData } from './hooks/useDiscoDepositsData'

type DiscoDepositsDetailRowsProps = Pick<DiscoDepositsData, 'currentDeposit'>

export const DiscoDepositsDetailRows: React.FC<DiscoDepositsDetailRowsProps> = ({ currentDeposit }) => {
    return (
        <>
            <HStack justify="space-between">
                <Text fontSize="sm" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                    Asset
                </Text>
                <Text fontSize="md" color={PRIMARY_PURPLE} fontWeight="bold" fontFamily="mono">
                    {currentDeposit?.asset || '—'}
                </Text>
            </HStack>
            <HStack justify="space-between">
                <Text fontSize="sm" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                    Slot
                </Text>
                <Text fontSize="md" color={PRIMARY_PURPLE} fontWeight="bold" fontFamily="mono">
                    {getSlotLabel(currentDeposit?.slot || 0)}
                </Text>
            </HStack>
            <HStack justify="space-between">
                <Text fontSize="sm" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                    Amount
                </Text>
                <Text fontSize="md" color="white" fontFamily="mono">
                    {currentDeposit?.amount.toFixed(2) || '0.00'} MBRN
                </Text>
            </HStack>
            <HStack justify="space-between">
                <Text fontSize="sm" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                    Lifetime
                </Text>
                <Text fontSize="md" fontWeight="bold" color="secondary.400" fontFamily="mono">
                    {currentDeposit?.lifetime.toFixed(2) || '0.00'} CDT
                </Text>
            </HStack>
            <HStack justify="space-between">
                <Text fontSize="sm" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                    Current APR
                </Text>
                <Text fontSize="md" fontWeight="bold" color="secondary.400" fontFamily="mono">
                    {currentDeposit?.apr.toFixed(2) || '0.00'}%
                </Text>
            </HStack>
            <HStack justify="space-between">
                <Text fontSize="sm" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                    Claimable
                </Text>
                <Text fontSize="md" color="green.400" fontWeight="bold" fontFamily="mono">
                    +{currentDeposit?.claimable.toFixed(2) || '0.00'} CDT
                </Text>
            </HStack>
        </>
    )
}
