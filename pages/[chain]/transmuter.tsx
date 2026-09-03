import React from 'react'
import ChainLayout from '@/components/ChainLayout'
import Seo from '@/components/Seo'
import { AcquisitionVisualizer } from '@/components/acquisition/AcquisitionVisualizer'

export default function TransmutationPage() {
    return (
        <ChainLayout>
            <Seo
                title="Membrane Transmuter Lockdrop: Lock Deposits, Earn Allocation"
                description="Lock deposits into the Membrane Transmuter's lockdrop and see your projected allocation against everyone else's, live."
            />
            <AcquisitionVisualizer />
        </ChainLayout>
    )
}
