import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// THE STORY ORDER (owner ruling 2026-10-25): `/` renders its beats S, T, O, R, Y in that
// order, each on a section with data-story. Rendered server-side, as a crawler sees it,
// with the wallet and router hooks stubbed.

vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: false, asPath: '/', replace: () => {} }) }))
vi.mock('@/hooks/useWallet', () => ({
  default: () => ({ address: undefined, isWalletConnected: false, isConnecting: false, connect: () => {} }),
}))
vi.mock('@/components/Simulator/hooks/useSimHistory', () => ({ useSimHistory: () => ({ data: undefined, isPending: true }) }))

describe('landing STORY order', () => {
  for (const page of ['borrower', 'carry'] as const)
  it(`renders S, T, O, R, Y in order (${page})`, async () => {
    const { default: ForecastLanding } = await import('@/components/Landing/ForecastLanding')
    const { summariseCensus } = await import('@/lib/landing/objections')
    const evidence = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/data/oct10-2025/evidence.json'), 'utf8'))
    const { ChakraProvider } = await import('@chakra-ui/react')
    const { default: theme } = await import('@/theme')
    const { comparisonRows } = await import('@/lib/landing/comparison')
    const protocols = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/data/oct10-2025/protocols.json'), 'utf8'))
    const rows = comparisonRows(protocols, page === 'carry')
    const html = renderToString(
      React.createElement(ChakraProvider, { theme }, React.createElement(ForecastLanding, { page, headline: 'default', census: summariseCensus(evidence), comparisonRows: rows })),
    )
    const order = Array.from(html.matchAll(/data-story="([STORY])"/g)).map((m) => m[1])
    expect(order).toEqual(['S', 'T', 'O', 'R', 'Y'])
    // SEO R1: the table, proof bar and closing band are in the server HTML.
    for (const r of rows) expect(html).toContain(r.label)
    for (const id of ['landing-proof', 'landing-compare', 'landing-bars', 'landing-stat', 'landing-closing', 'hero-preview']) expect(html).toContain(`data-testid="${id}"`)
    expect(html.match(/<h1/g)?.length).toBe(1)
  }, 60_000)
})
