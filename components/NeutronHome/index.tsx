import React, { useState, useCallback } from 'react'
import { HealthEnergyBar } from './parts/HealthEnergyBar'
import { VenueRail } from './parts/VenueRail'
import { PipesCanvas } from './pipes/PipesCanvas'
import { useNeutronHomeData } from './useNeutronHomeData'
import { InitialCDPDeposit } from '@/components/Mint/InitialCDPDeposit'
import useMintState from '@/components/Mint/hooks/useMintState'
import useAssets from '@/hooks/useAssets'
import Mycelium from './Mycelium'

export const NeutronHome = () => {
    const assets = (useAssets() as any[]) || []
    const { mintState, setMintState } = useMintState()
    if (!mintState.assets || mintState.assets.length === 0) {
        const defaults = assets.slice(0, 3).map((a: any) => ({ ...a, amount: 0, amountValue: 0, sliderValue: 0 }))
        if (defaults.length > 0) setMintState({ assets: defaults })
    }
    const {
        healthPercent,
        healthTierColor,
        bundleNodeRef,
        slotAssignments,
        flowByVenue,
        onDeploySuccess,
        onRetrievalSuccess,
    } = useNeutronHomeData()

    const [liveAnnounce, setLiveAnnounce] = useState('')
    const [depositAmount, setDepositAmount] = useState<number>(10)

    const handleDeploySuccess = useCallback((venueId: string, amount: number) => {
        onDeploySuccess(venueId, amount)
        setLiveAnnounce(`Deployed ${amount} CDT to ${venueId}`)
    }, [onDeploySuccess])

    const handleRetrievalSuccess = useCallback((venueId: string, amount: number) => {
        onRetrievalSuccess(venueId, amount)
        setLiveAnnounce(`Retrieved ${amount} CDT from ${venueId}`)
    }, [onRetrievalSuccess])


    return (
        <div style={{ position: 'relative', width: '100%', minHeight: 640 }}>
            <Mycelium logo={''} symbol={''} marketContract={''} asset={undefined} />
        </div>
    )
    // return (
    //     <div style={{ position: 'relative', width: '100%', minHeight: 640 }}>
    //         <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 24 }}>
    //             <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
    //                 <div ref={bundleNodeRef as any} style={{ width: 420 }}>
    //                     <InitialCDPDeposit />
    //                 </div>
    //                 <HealthEnergyBar percent={healthPercent} color={healthTierColor} />
    //             </div>
    //         </div>

    //         <div style={{ marginTop: '30vh' }}>
    //             <VenueRail
    //                 slots={slotAssignments}
    //                 onDeploySuccess={handleDeploySuccess}
    //                 onRetrievalSuccess={handleRetrievalSuccess}
    //                 healthPercent={healthPercent}
    //                 defaultAmount={depositAmount}
    //             />
    //         </div>

    //         <PipesCanvas bundleRef={bundleNodeRef} slots={slotAssignments} flowByVenue={flowByVenue} healthIntensity={Math.max(0, Math.min(1, healthPercent / 100))} />

    //         {/* Screen reader live announcements */}
    //         <div aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(1px, 1px, 1px, 1px)' }}>{liveAnnounce}</div>
    //     </div>
    // )
}

export default NeutronHome


