import { useMemo, useRef, useState, useCallback } from 'react'
import { useCurrentPosition } from '@/components/Mint/hooks/useCurrentPosition'
import useWallet from '@/hooks/useWallet'
import { useCDPClient, getUserPositions, getDebt } from '@/services/cdp'
import { useChainRoute } from '@/hooks/useChainRoute'
import { VenueSlotsMap, VenueSlotIndex, DeploymentVenue, FlowByVenue } from './types'
import useAppState from '@/persisted-state/useAppState'
import { shiftDigits } from '@/helpers/math'
import { useReverseFlow } from './useReverseFlow'

const HEALTH_TIERS = [
    { max: 30, color: '#ff4d4f' },
    { max: 60, color: '#faad14' },
    { max: 85, color: '#52c41a' },
    { max: 101, color: '#2dc5ff' },
]

export const useNeutronHomeData = () => {
    const { health } = useCurrentPosition()
    const healthPercent = Math.max(0, Math.min(100, Number(health || 0)))
    const healthTierColor = HEALTH_TIERS.find(t => healthPercent < t.max)?.color || '#2dc5ff'

    const { chainName } = useChainRoute()
    const { address } = useWallet()
    const { appState } = useAppState()
    const { data: client } = useCDPClient(appState.rpcUrl)

    const [deployedTo, setDeployedTo] = useState<DeploymentVenue[]>([])
    const [totalDebtCdt, setTotalDebtCdt] = useState<number>(0)

    // Fetch user positions and synthesize deployed venues. Placeholder until backend exposes deployed_to
    // We derive a single venue using total debt for now; extend when API is ready.
    // Wire to your existing query that returns `deployed_to: DeploymentVenue[]` and set both states.
    // For safety, keep this component-side derivation.
    const refreshPositions = useCallback(async () => {
        if (!client || !address) return
        const res = await getUserPositions(address, client)
        const debt = getDebt([res])
        setTotalDebtCdt(debt)
        // Preferred: use deployed_to if provided by backend; fallback: aggregate single venue
        //@ts-ignore expected: { address, deployed_debt_amount }
        const maybeDeployed = res?.deployed_to as { address: string; deployed_debt_amount: string }[] | undefined
        if (maybeDeployed && Array.isArray(maybeDeployed)) {
            setDeployedTo(maybeDeployed.map(v => ({ id: v.address, name: v.address, amountCdt: shiftDigits(v.deployed_debt_amount, -6).toNumber() } as DeploymentVenue)))
        } else {
            // Fallback: single aggregate venue representing the position
            setDeployedTo(debt > 0 ? [{ id: 'position', name: 'Position', amountCdt: debt }] as DeploymentVenue[] : [])
        }
    }, [client, address])

    // call lazily from visible effect in parent if needed

    const computeSlots = useCallback((venues: DeploymentVenue[]): VenueSlotsMap => {
        const slots: VenueSlotsMap = { 1: undefined, 2: undefined, 3: undefined, 4: undefined, 5: undefined }
        let live = venues.slice(0, 3)
        // If no live venues yet, show three default venues in 1,3,5 as selectable starters
        if (live.length === 0) {
            live = [
                { id: 'venue-1', name: 'Venue 1', amountCdt: 0 },
                { id: 'venue-2', name: 'Venue 2', amountCdt: 0 },
                { id: 'venue-3', name: 'Venue 3', amountCdt: 0 },
            ] as DeploymentVenue[]
        }
        if (live.length === 1) {
            slots[2] = { type: 'live', slot: 2, venue: live[0] }
            slots[4] = { type: 'placeholder', slot: 4 }
        } else if (live.length === 2) {
            slots[1] = { type: 'live', slot: 1, venue: live[0] }
            slots[3] = { type: 'live', slot: 3, venue: live[1] }
            slots[5] = { type: 'placeholder', slot: 5 }
        } else if (live.length >= 3) {
            slots[1] = { type: 'live', slot: 1, venue: live[0] }
            slots[3] = { type: 'live', slot: 3, venue: live[1] }
            slots[5] = { type: 'live', slot: 5, venue: live[2] }
        }
        return slots
    }, [])

    const slotAssignments: VenueSlotsMap = useMemo(() => computeSlots(deployedTo), [computeSlots, deployedTo])

    const [flowsState, setFlowsState] = useState<FlowByVenue>({})
    const flowByVenue: FlowByVenue = useMemo(() => {
        const total = Math.max(1, totalDebtCdt)
        const merged: FlowByVenue = { ...flowsState }
        deployedTo.forEach(v => {
            const share = Math.max(0, Math.min(1, Number(v.amountCdt || 0) / total))
            merged[v.id] = { speed: share, direction: merged[v.id]?.direction ?? 1 }
        })
        return merged
    }, [deployedTo, totalDebtCdt, flowsState])

    const { onDeploySuccess: _deployPulse, onRetrievalSuccess: _retrievalPulse } = useReverseFlow(setFlowsState)

    const bundleNodeRef = useRef<HTMLDivElement | null>(null)

    const onDeploySuccess = useCallback((venueId: string, amountCdt: number) => {
        // update UI shares; animation handled by PipesCanvas via prop change
        setDeployedTo(prev => {
            const idx = prev.findIndex(v => v.id === venueId)
            if (idx >= 0) {
                const next = [...prev]
                next[idx] = { ...next[idx], amountCdt: (next[idx].amountCdt || 0) + amountCdt }
                return next
            }
            return [...prev, { id: venueId, name: venueId, amountCdt }]
        })
        setTotalDebtCdt(d => d + amountCdt)
        _deployPulse(venueId, amountCdt)
    }, [])

    const onRetrievalSuccess = useCallback((venueId: string, amountCdt: number) => {
        setDeployedTo(prev => {
            const idx = prev.findIndex(v => v.id === venueId)
            if (idx < 0) return prev
            const next = [...prev]
            next[idx] = { ...next[idx], amountCdt: Math.max(0, (next[idx].amountCdt || 0) - amountCdt) }
            return next
        })
        setTotalDebtCdt(d => Math.max(0, d - amountCdt))
        _retrievalPulse(venueId, amountCdt)
    }, [])

    return {
        healthPercent,
        healthTierColor,
        bundleNodeRef,
        slotAssignments,
        flowByVenue,
        onDeploySuccess,
        onRetrievalSuccess,
        refreshPositions,
    }
}


