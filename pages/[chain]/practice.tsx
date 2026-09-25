import React from 'react'
import type { GetServerSideProps } from 'next'

import PageSeo from '@/components/PageSeo'
import { Practice } from '@/components/Practice/Practice'
import { supportedChains, DEFAULT_CHAIN } from '@/config/chains'

// Practice mode (docs/PRACTICE_MODE_DESIGN.md): replay the recorded Oct 10 tape
// against Membrane's delay window and choose at each stop. Indexable — a stranger
// should be able to find it. Invalid chains redirect server-side, as evidence.tsx does.
export const getServerSideProps: GetServerSideProps = async (context) => {
    const chainParam = context.params?.chain
    const chainName = typeof chainParam === 'string' ? chainParam : DEFAULT_CHAIN
    if (!supportedChains.some((c) => c.name === chainName)) {
        return { redirect: { destination: `/${DEFAULT_CHAIN}/practice`, permanent: false } }
    }
    return { props: {} }
}

const PracticePage = () => (
    <>
        <PageSeo
            seoClass="indexable"
            path={`/${DEFAULT_CHAIN}/practice`}
            title="Membrane — Practice the crossing"
            description="Replay the recorded Oct 10 2025 oracle tape against Membrane's 8-hour window and 4% band. Stop at each classification, choose, and compare the collateral you keep with doing nothing and with what liquidators took."
        />
        <Practice />
    </>
)

export default PracticePage
