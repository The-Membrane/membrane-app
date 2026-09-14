import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import type { GetServerSideProps } from 'next'

import PageSeo from '@/components/PageSeo'
import { Evidence } from '@/components/Evidence'
import type { EvidenceDoc } from '@/components/Evidence'
import { supportedChains, DEFAULT_CHAIN } from '@/config/chains'

// The Evidence tool has its own URL again. The chain root is now the seniority
// landing (pages/[chain]/index.tsx), which links here for the filterable cohort, so
// the two surfaces are different pages rather than one served at two URLs — the
// one-canonical-URL rule still holds (docs/SEO_RULESET.md R1/R2).
//
// EVM-only: a single chain path (/ethereum). Stale bookmarks with an invalid chain
// redirect server-side before any HTML is sent, so there is no client-side flash and
// crawlers see the real destination directly.
export const getServerSideProps: GetServerSideProps = async (context) => {
    const chainParam = context.params?.chain
    const chainName = typeof chainParam === 'string' ? chainParam : DEFAULT_CHAIN
    const isValidChain = supportedChains.some((c) => c.name === chainName)

    if (!isValidChain) {
        return { redirect: { destination: `/${DEFAULT_CHAIN}/evidence`, permanent: false } }
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
        // Missing/unreadable dataset must not 500 the page. The component falls back
        // to its client fetch, and to its error state if that fails too.
        summary = null
    }

    return { props: { summary } }
}

/**
 * The counterfactual tool, in full: every account Aave liquidated on 10 Oct 2025,
 * filterable, including the ones where Membrane does worse.
 *
 * seoClass is `indexable` — this is a surface a stranger should be able to find and
 * check. `path` is passed explicitly so the canonical + og:url resolve to the chain
 * evidence route rather than to whatever URL the visitor arrived on.
 */
const EvidencePage = ({ summary }: { summary: EvidenceDoc | null }) => {
    return (
        <>
            <PageSeo
                seoClass="indexable"
                path={`/${DEFAULT_CHAIN}/evidence`}
                title="Membrane: What our engine would have done"
                description="Every account Aave liquidated on 10 October 2025, replayed through Membrane's liquidation engine on the same measured prices. Aave closed a median 71% of each loan; Membrane's partial repay-to-cap closes 17.8%. Includes the accounts where Membrane does worse."
            />
            <Evidence initialDoc={summary} />
        </>
    )
}

export default EvidencePage
