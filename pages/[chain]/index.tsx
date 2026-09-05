import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import type { GetServerSideProps } from 'next'
import Head from 'next/head'

import PageSeo from '@/components/PageSeo'
import { SITE_URL } from '@/components/Seo'
import { Evidence } from '@/components/Evidence'
import type { EvidenceDoc } from '@/components/Evidence'
import { supportedChains, DEFAULT_CHAIN } from '@/config/chains'

// R8 (docs/SEO_RULESET.md): Organization + WebSite JSON-LD on the landing page
// only, and conservatively — name/url/logo/description are facts we can stand
// behind; contactPoint/address are omitted until real ones exist (R14: no
// invented specifics). Emitted only when the canonical origin is known.
const structuredData = SITE_URL
    ? JSON.stringify([
        {
            '@context': 'https://schema.org',
            '@type': 'Organization',
            name: 'Membrane',
            url: SITE_URL,
            logo: `${SITE_URL}/images/mbrn.svg`,
            description:
                'Membrane is a collateralized debt protocol on Ethereum: post crypto collateral, mint the CDT stablecoin, and face partial liquidations that repay to the cap instead of closing the whole loan.',
        },
        {
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: 'Membrane',
            url: SITE_URL,
        },
    ])
    : null

// EVM-only: a single chain path (/ethereum). Stale bookmarks (/osmosis, /neutron)
// land here with an invalid chain — redirect server-side to /ethereum before any HTML
// is sent, so there's no client-side flash and crawlers see the real destination
// directly (nextjs-no-client-side-redirect fix: getServerSideProps redirect).
export const getServerSideProps: GetServerSideProps = async (context) => {
    const chainParam = context.params?.chain
    const chainName = typeof chainParam === 'string' ? chainParam : DEFAULT_CHAIN
    const isValidChain = supportedChains.some((c) => c.name === chainName)

    if (!isValidChain) {
        return { redirect: { destination: `/${DEFAULT_CHAIN}`, permanent: false } }
    }

    // Server-render the SUMMARY (meta/debt/time/byAsset, ~2KB) so a crawler and the
    // first paint both see real figures instead of a spinner — docs/SEO_RULESET.md R1.
    // The 2,350-row cohort is deliberately NOT inlined; the client fetches it.
    let summary: Omit<EvidenceDoc, 'cohort'> & { cohort: [] } | null = null
    try {
        const raw = fs.readFileSync(
            path.join(process.cwd(), 'public/data/oct10-2025/evidence.json'),
            'utf8',
        )
        const { cohort, ...rest } = JSON.parse(raw) as EvidenceDoc
        summary = { ...rest, cohort: [] }
    } catch {
        // Missing/unreadable dataset must not 500 the landing page. The component
        // falls back to its client fetch, and to its error state if that fails too.
        summary = null
    }

    return { props: { summary } }
}

/**
 * The landing page is the counterfactual tool.
 *
 * A stranger arriving with no wallet gets the strongest thing we have: 2,350 real
 * Aave accounts liquidated on 10 Oct 2025, replayed through Membrane's own engine —
 * including the 105 accounts where Membrane does worse. The former marketing home
 * moved to /[chain]/home; the per-address simulator is at /[chain]/simulator.
 *
 * seoClass is `indexable` (not `internal`) because this is now the entry page a
 * stranger should find via search — docs/SEO_RULESET.md Rule 0. `path` is passed
 * explicitly so the canonical + og:url resolve to the chain root rather than to
 * whatever URL the visitor happened to arrive on.
 */
const IndexPage = ({ summary }: { summary: EvidenceDoc | null }) => {
    return (
        <>
            <PageSeo
                seoClass="indexable"
                path={`/${DEFAULT_CHAIN}`}
                title="Membrane — What Our Engine Would Have Done"
                description="Every account Aave liquidated on 10 October 2025, replayed through Membrane's liquidation engine on the same measured prices. Aave closed a median 71% of each loan; Membrane's partial repay-to-cap closes 17.8%. Includes the accounts where Membrane does worse."
            />
            {structuredData && (
                <Head>
                    <script
                        key="ld-org"
                        type="application/ld+json"
                        dangerouslySetInnerHTML={{ __html: structuredData }}
                    />
                </Head>
            )}
            <Evidence initialDoc={summary} />
        </>
    )
}

export default IndexPage
