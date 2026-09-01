// Shared helpers/types for the Slot Manage modal.
// Extracted verbatim from SlotManageModal.tsx to keep each component focused.

// Slot colour helper — normalises the slot's LTV against the 50-90% window.
// The interpolation itself now lives in ./riskRamp so all four call sites that
// used to carry their own copy stay in step.
export { riskRgbForLtv as getSlotRGB } from './riskRamp'

export type Tab = 'deposit' | 'withdraw' | 'move'

export interface UnstakeRequestData {
    slot: number
    vault_tokens: string
    unlock_time: number
    [key: string]: any
}

export interface SlotData {
    amount: number
    claimable: number
    lifetime: number
    apr: number
    count: number
}
