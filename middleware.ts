import { NextRequest, NextResponse } from 'next/server'
import { supportedChains } from '@/config/chains'

/**
 * Server-side answer to the two soft-404 holes found in docs/GEO_AUDIT.md:
 *
 *  1. An unknown top-level path (e.g. /this-page-does-not-exist) matched
 *     pages/[chain]/index.tsx, whose getServerSideProps 307'd it to /ethereum —
 *     a 200 homepage for every typo'd URL. AI engines send ~2.87x more
 *     hallucinated-URL traffic than Google; each of those must see a real 404.
 *  2. A legacy chain deep link (/osmosis/borrow) rendered an empty 200 body and
 *     repaired itself only via client JS (components/ChainLayout.tsx) — invisible
 *     to crawlers that skip JS, which includes ChatGPT's.
 *
 * ChainLayout's useEffect stays as the client backstop; [chain]/index.tsx keeps its
 * own redirect as defense in depth. This file is the layer that makes both cases
 * correct for a crawler before any HTML is rendered.
 */

// Chains that once had real URLs in the wild (Cosmos era). Their bookmarks and any
// residual index entries redirect into the EVM path instead of 404ing.
const LEGACY_CHAINS = new Set(['osmosis', 'osmosis-v2', 'neutron'])

// Every legitimate top-level segment under pages/ that is not the [chain] dynamic
// route. Keep in sync with the pages/ directory; a segment missing here 404s.
const TOP_LEVEL_ROUTES = new Set([
    'blog',
    'borrow',
    'stake',
    'terms',
    'lockdrop',
    'nft',
    'tournament',
    'proto',
    'sensory',
])

const CHAIN_NAMES = new Set(supportedChains.map((c) => c.name))

export function middleware(request: NextRequest) {
    const { pathname } = request.nextUrl
    const [, first, ...rest] = pathname.split('/')

    // Root, valid chain, or known top-level route: let Next.js route it.
    if (first === '' || CHAIN_NAMES.has(first) || TOP_LEVEL_ROUTES.has(first)) {
        return NextResponse.next()
    }

    // Legacy chain segment: preserve the deep link, swap the chain, redirect
    // permanently so crawlers update their index.
    if (LEGACY_CHAINS.has(first)) {
        const url = request.nextUrl.clone()
        url.pathname = `/ethereum${rest.length ? `/${rest.join('/')}` : ''}`
        return NextResponse.redirect(url, 308)
    }

    // Anything else is a typo or hallucinated URL: serve a real 404 instead of
    // letting it fall into [chain] routing. The rewrite target must be TWO
    // segments — any single segment (including '/404') matches pages/[chain] and
    // gets redirect-rescued by its getServerSideProps. Two segments with an
    // unknown second part match no route, so Next.js renders its 404 page with
    // HTTP status 404.
    const url = request.nextUrl.clone()
    url.pathname = '/_404/not-found'
    return NextResponse.rewrite(url)
}

export const config = {
    // Skip api routes, Next internals, and any dotted path (static assets,
    // robots.txt/sitemap.xml which are real routes reached before this check).
    matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
}
