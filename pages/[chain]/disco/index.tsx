import React from 'react'
import ChainLayout from '@/components/ChainLayout'
import { DiscoPage } from '@/components/Disco'
import PageSeo from '@/components/PageSeo'

export default function DiscoIndexPage() {
    return (
        <ChainLayout>
            {/* Rule 0 (docs/SEO_RULESET.md): app — wallet-gated deposit/management tool */}
            <PageSeo
                seoClass="app"
                title="Membrane — Disco Deposits"
                description="Deposit assets into Membrane's Disco LTV slots, track your position across the waterfall, and manage deposits and unstaking from your connected wallet."
            />
            <DiscoPage />
        </ChainLayout>
    )
}

