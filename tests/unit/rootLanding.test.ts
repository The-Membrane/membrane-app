// '/' IS THE LANDING PAGE.
//
// Owner ruling 2026-10-28: "'/' is the landing page and will be the only page that
// showcases our borrower suite." docs/SEO_RULESET.md R2: the root serves content,
// never a bare redirect; R3: the old URL gets a 308. So:
//   1. middleware.ts REWRITES '/' to the chain root (200, URL stays '/'), and no longer
//      307s it to the simulator.
//   2. next.config.mjs 308s /ethereum to '/', so the landing has one URL.
//   3. No redirect chains: a bare legacy chain goes straight to '/'.
//   4. The sitemap lists '/' and not the redirecting /ethereum.

import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'

import { DEFAULT_CHAIN } from '@/config/chains'
import { SIM_ROUTE } from '@/config/simulatorMode'
import { middleware } from '@/middleware'
import nextConfig from '@/next.config.mjs'
import { INDEXABLE_PATHS } from '@/pages/sitemap.xml'

const ORIGIN = 'https://example.test'
const run = (path: string) => middleware(new NextRequest(`${ORIGIN}${path}`))

describe("'/' serves the borrower-suite landing", () => {
  it('rewrites / to the chain root instead of redirecting', () => {
    const res = run('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('x-middleware-rewrite')).toBe(`${ORIGIN}/${DEFAULT_CHAIN}`)
  })

  it('keeps the query string on the rewrite (?v= pins a headline variant)', () => {
    expect(run('/?v=d').headers.get('x-middleware-rewrite')).toBe(`${ORIGIN}/${DEFAULT_CHAIN}?v=d`)
  })

  it('leaves the simulator on its own route', () => {
    const res = run(`/${DEFAULT_CHAIN}${SIM_ROUTE.borrower}`)
    expect(res.headers.get('x-middleware-rewrite')).toBeNull()
    expect(res.headers.get('location')).toBeNull()
  })

  it('sends a bare legacy chain straight to / (one hop, no chain)', () => {
    const res = run('/osmosis')
    expect(res.status).toBe(308)
    expect(res.headers.get('location')).toBe(`${ORIGIN}/`)
    // Deep links keep their path on the supported chain.
    expect(run('/neutron/borrow').headers.get('location')).toBe(`${ORIGIN}/${DEFAULT_CHAIN}/borrow`)
  })

  it('308s the old landing URL, /ethereum, to /', async () => {
    const redirects = await nextConfig.redirects!()
    const rule = redirects.find((r) => r.source === `/${DEFAULT_CHAIN}`)
    expect(rule).toMatchObject({ destination: '/', permanent: true })
    // No rule may point at the old landing URL: that would be a redirect chain.
    for (const r of redirects) {
      expect(r.destination).not.toMatch(/^\/:chain$|^\/ethereum$/)
    }
  })

  it('lists / in the sitemap and not the redirecting /ethereum', () => {
    expect(INDEXABLE_PATHS).toContain('/')
    expect(INDEXABLE_PATHS).not.toContain(`/${DEFAULT_CHAIN}`)
  })
})
