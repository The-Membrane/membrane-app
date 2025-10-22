import Home from '@/components/Home/Home'
import React from 'react'
import dynamic from 'next/dynamic'
import { useChainRoute } from '@/hooks/useChainRoute'

const NeutronHome = dynamic(() => import('@/components/NeutronHome').then(m => m.default || m.NeutronHome), { ssr: false })

const IndexPage = () => {
    const { chainName } = useChainRoute()
    if (chainName === 'neutron') {
        return <NeutronHome />
    }
    return <Home />
}

export default IndexPage
