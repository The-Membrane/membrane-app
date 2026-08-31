import React from 'react'
import type { GetServerSideProps } from 'next'

import Home from '@/components/Home/Home'
import Seo from '@/components/Seo'
import { supportedChains, DEFAULT_CHAIN } from '@/config/chains'

// The former landing page. `/[chain]` now renders the Evidence counterfactual tool
// (owner ruling, Aug 31 2026 — the sim goes in front of the marketing copy), so this
// content moved here rather than being deleted. Reachable from the nav as "Home".
export const getServerSideProps: GetServerSideProps = async (context) => {
    const chainParam = context.params?.chain
    const chainName = typeof chainParam === 'string' ? chainParam : DEFAULT_CHAIN
    const isValidChain = supportedChains.some((c) => c.name === chainName)

    if (!isValidChain) {
        return { redirect: { destination: `/${DEFAULT_CHAIN}/home`, permanent: false } }
    }

    return { props: {} }
}

const HomePage = () => {
    return (
        <>
            <Seo
                title="Membrane — Borrow Against Crypto with a CDP Stablecoin"
                description="Deposit crypto collateral, borrow the CDT stablecoin, and keep an 8-hour cure window before any liquidation. Build looped yield positions on Membrane."
            />
            <Home />
        </>
    )
}

export default HomePage
