import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import type { GetServerSideProps } from 'next'
import Head from 'next/head'

import PageSeo from '@/components/PageSeo'
import { SITE_URL } from '@/components/Seo'
import { SeniorityLanding } from '@/components/Seniority'
import type { EvidenceDoc } from '@/components/Evidence'
import { supportedChains, DEFAULT_CHAIN } from '@/config/chains'
import {
    LANDING_VARIANT_COOKIE,
    resolveLandingVariant,
    type LandingVariant,
} from '@/lib/landingVariant'

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

    // Owner ruling 2026-09-15: the H1 is randomised on every load. No cookie is read or
    // written; ?v=a|b|c pins a variant for that request only; a known crawler always gets
    // C so the indexed H1 stays one headline. Cache-Control is private, no-store, so a
    // per-request split is never cached.
const { variant } = resolveLandingVariant({
        query: context.query?.v,
        userAgent: context.req.headers['user-agent'],
        randomId: randomUUID(),
    })
    // The page is per-reader from here on: two readers get two headlines at one URL,
    // so no shared cache may hold either of them.
    context.res.setHeader('Cache-Control', 'private, no-store')

    return { props: { summary, variant } }
}

/**
 * The landing page is the seniority argument.
 *
 * A stranger arriving with no wallet gets a fully populated page: where a borrower
 * sits in the loss waterfall, what that order buys them, and the 2,350 real Aave
 * accounts liquidated on 10 Oct 2025 replayed through Membrane's own engine in the
 * close. Every factual sentence comes from components/Seniority/facts.ts with a
 * contract citation. The full filterable cohort tool lives at /[chain]/evidence; the
 * per-address simulator is at /[chain]/simulator.
 *
 * seoClass is `indexable` (not `internal`) because this is the entry page a
 * stranger should find via search — docs/SEO_RULESET.md Rule 0. `path` is passed
 * explicitly so the canonical + og:url resolve to the chain root rather than to
 * whatever URL the visitor happened to arrive on.
 *
 * The server-rendered summary is still read here: the Close band mounts the Evidence
 * DebtLens on it, so a crawler sees real figures rather than a spinner (R1).
 */
const IndexPage = ({
    summary,
    variant,
}: {
    summary: EvidenceDoc | null
    variant: LandingVariant
}) => {
    return (
        <>
            <PageSeo
                seoClass="indexable"
                path={`/${DEFAULT_CHAIN}`}
                title="Membrane: Borrowers are senior here"
                description="Four layers take a loss before it reaches a Membrane borrower: the reserve, MBRN staked under the asset, junior lenders, then senior lenders. The bad-debt cascade never writes to a position, and redemption is served by curator vaults. Every claim cites the contract line behind it."
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
            <SeniorityLanding initialDoc={summary} variant={variant} />
        </>
    )
}

export default IndexPage
