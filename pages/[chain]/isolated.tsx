import ManagedTable from '@/components/ManagedMarkets/ManagedTable'
import React from 'react'
import PageSeo from '@/components/PageSeo'

const ManagedPage = () => {
    return (
        <>
            {/* Rule 0 (docs/SEO_RULESET.md): app — wallet-gated isolated markets management tool */}
            <PageSeo
                seoClass="app"
                title="Membrane — Isolated Markets"
                description="Browse and manage isolated markets on Membrane: create new markets, filter and sort existing ones, and open management actions from your connected wallet."
            />
            <ManagedTable />
        </>
    )
}

export default ManagedPage
