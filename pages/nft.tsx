import React from 'react'
import dynamic from 'next/dynamic'
import PageSeo from '@/components/PageSeo'

// Client-only: LiveAuction builds an <img> via document.createElement in render,
// which breaks prerender.
const NFT = dynamic(() => import('@/components/NFT'), { ssr: false })

const NFTPage = () => {
    return (
        <>
            {/* Rule 0 (docs/SEO_RULESET.md): internal — legacy NFT auction event page */}
            <PageSeo
                seoClass="internal"
                title="Membrane — NFT Auction"
                description="Live NFT and asset auction page: view the current highest bid on the featured NFT and paired asset, place your own bid, and track the auction countdown."
            />
            <NFT />
        </>
    )
}

export default NFTPage
