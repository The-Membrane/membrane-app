import Dashboard from '@/components/Dashboard/Dashboard'
import React from 'react'
import PageSeo from '@/components/PageSeo'

const DashboardPage = () => {
    return (
        <>
            {/* Rule 0 (docs/SEO_RULESET.md): app — wallet-gated protocol management dashboard */}
            <PageSeo
                seoClass="app"
                title="Membrane — Control Room"
                description="Manage protocol basket operations from your connected wallet: revenue distribution, range-bound LP positions, oracle health, and supply cap monitoring tools."
            />
            <Dashboard />
        </>
    )
}

export default DashboardPage
