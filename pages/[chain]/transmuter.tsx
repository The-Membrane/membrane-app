import React from 'react'
import ChainLayout from '@/components/ChainLayout'
import PageSeo from '@/components/PageSeo'
import { AcquisitionVisualizer } from '@/components/acquisition/AcquisitionVisualizer'
import { DEFAULT_CHAIN } from '@/config/chains'

export default function TransmutationPage() {
    return (
        <ChainLayout>
            {/* Rule 0 (docs/SEO_RULESET.md): indexable — marketing entry page for the Transmuter lockdrop */}
            <PageSeo
                seoClass="indexable"
                title="Membrane Transmuter Lockdrop: Lock Deposits, Earn Allocation"
                description="Lock deposits into the Membrane Transmuter's lockdrop and see your projected allocation against everyone else's, live."
                path={`/${DEFAULT_CHAIN}/transmuter`}
            />
            <AcquisitionVisualizer />
        </ChainLayout>
    )
}
