export type DeploymentVenue = {
    id: string
    name: string
    apr?: number
    minHealth?: number
    amountCdt: number
}

export type VenueSlotIndex = 1 | 2 | 3 | 4 | 5

export type VenueSlot =
    | { type: 'live'; slot: VenueSlotIndex; venue: DeploymentVenue }
    | { type: 'placeholder'; slot: VenueSlotIndex }

export type VenueSlotsMap = Record<VenueSlotIndex, VenueSlot | undefined>

export type FlowByVenue = Record<string, {
    speed: number // 0..1 normalized
    direction: 1 | -1
}>





