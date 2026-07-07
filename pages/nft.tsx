import React from 'react'
import dynamic from 'next/dynamic'

// Client-only: LiveAuction builds an <img> via document.createElement in render,
// which breaks prerender.
const NFT = dynamic(() => import('@/components/NFT'), { ssr: false })

const NFTPage = () => {
    return <NFT />
}

export default NFTPage
