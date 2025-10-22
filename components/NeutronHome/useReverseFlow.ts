import { useCallback, useRef } from 'react'
import { FlowByVenue } from './types'

export const useReverseFlow = (setFlow: (updater: (prev: FlowByVenue) => FlowByVenue) => void) => {
    const timers = useRef<Record<string, any>>({})

    const reverseFlowForVenue = useCallback((venueId: string, ms: number = 1200) => {
        setFlow(prev => ({ ...prev, [venueId]: { ...(prev[venueId] || { speed: 0 }), direction: -1 as const } }))
        clearTimeout(timers.current[venueId])
        timers.current[venueId] = setTimeout(() => {
            setFlow(prev => ({ ...prev, [venueId]: { ...(prev[venueId] || { speed: 0 }), direction: 1 as const } }))
        }, ms)
    }, [setFlow])

    const onDeploySuccess = useCallback((venueId: string, amountCdt: number) => {
        reverseFlowForVenue(venueId, 500) // quick pulse
    }, [reverseFlowForVenue])

    const onRetrievalSuccess = useCallback((venueId: string, amountCdt: number) => {
        reverseFlowForVenue(venueId, 1200)
    }, [reverseFlowForVenue])

    return { reverseFlowForVenue, onDeploySuccess, onRetrievalSuccess }
}





