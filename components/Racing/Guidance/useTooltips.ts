import { useState, useCallback } from 'react'

export interface TooltipState {
    energyBar: boolean
    carTraits: boolean
    racingControls: boolean
    trackCreation: boolean
}

export const useTooltips = () => {
    const [tooltipStates, setTooltipStates] = useState<TooltipState>({
        energyBar: false,
        carTraits: false,
        racingControls: false,
        trackCreation: false,
    })

    const showTooltip = useCallback((tooltipKey: keyof TooltipState) => {
        setTooltipStates(prev => ({
            ...prev,
            [tooltipKey]: true,
        }))
    }, [])

    const hideTooltip = useCallback((tooltipKey: keyof TooltipState) => {
        setTooltipStates(prev => ({
            ...prev,
            [tooltipKey]: false,
        }))
    }, [])

    const hideAllTooltips = useCallback(() => {
        setTooltipStates({
            energyBar: false,
            carTraits: false,
            racingControls: false,
            trackCreation: false,
        })
    }, [])

    return {
        tooltipStates,
        showTooltip,
        hideTooltip,
        hideAllTooltips,
    }
}
