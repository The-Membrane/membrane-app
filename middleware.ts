import { NextRequest, NextResponse } from 'next/server'
import { DEFAULT_CHAIN, supportedChains } from '@/config/chains'

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

    // Owner ruling 2026-10-28: '/' is the landing page — the one page that shows the
    // borrower suite. Serve it here with a 200 (docs/SEO_RULESET.md R2: the root
    // serves content, never a bare redirect) by rewriting internally to the chain
    // root, pages/[chain]/index.tsx, which sets its canonical to '/'. The browser
    // URL stays '/'. The old chain-root URL, /ethereum, 308s back to '/' from
    // next.config.mjs redirects() (R3), so the landing has exactly one URL.
    // The simulator, which '/' used to 307 to, keeps its own route.
    // Cloning the URL preserves query params (?v= pins a headline variant).
    if (first === '') {
        const url = request.nextUrl.clone()
        url.pathname = `/${DEFAULT_CHAIN}`
        return NextResponse.rewrite(url)
    }

    // Valid chain or known top-level route: let Next.js route it.
    if (CHAIN_NAMES.has(first) || TOP_LEVEL_ROUTES.has(first)) {
        return NextResponse.next()
    }

    // Legacy chain segment: preserve the deep link, swap the chain, redirect
    // permanently so crawlers update their index.
    if (LEGACY_CHAINS.has(first)) {
        const url = request.nextUrl.clone()
        // A bare legacy chain (/osmosis) goes straight to '/', not to /ethereum,
        // which would 308 again to '/' — R2: never chain redirects.
        url.pathname = rest.length ? `/${DEFAULT_CHAIN}/${rest.join('/')}` : '/'
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
