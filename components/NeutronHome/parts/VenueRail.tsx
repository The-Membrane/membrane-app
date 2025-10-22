import React from 'react'
import { HStack } from '@chakra-ui/react'
import { VenueSlotsMap } from '../types'
import { VenueSlot } from './VenueSlot'

export const VenueRail = ({
    slots,
    onDeploySuccess,
    onRetrievalSuccess,
    healthPercent,
    defaultAmount = 10,
}: {
    slots: VenueSlotsMap
    onDeploySuccess: (venueId: string, amountCdt: number) => void
    onRetrievalSuccess: (venueId: string, amountCdt: number) => void
    healthPercent?: number
    defaultAmount?: number
}) => {
    const order = [1, 3, 5] as const
    return (
        <HStack spacing={28} align="stretch" justify="center">
            {order.map((i) => {
                const slot = slots[i]
                if (!slot) return <div key={i} />
                return (
                    <VenueSlot
                        key={(slot.type === 'live' ? slot.venue.id : `p-${i}`)}
                        slot={slot}
                        onDeploy={(id) => onDeploySuccess(id, defaultAmount)}
                        onRetrieve={(id) => onRetrievalSuccess(id, 5)}
                        healthPercent={healthPercent}
                    />
                )
            })}
        </HStack>
    )
}


