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
  it('renders S, T, O, R, Y in order', async () => {
    const { default: ForecastLanding } = await import('@/components/Landing/ForecastLanding')
    const { summariseCensus } = await import('@/lib/landing/objections')
    const evidence = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/data/oct10-2025/evidence.json'), 'utf8'))
    const { ChakraProvider } = await import('@chakra-ui/react')
    const { default: theme } = await import('@/theme')
    const html = renderToString(
      React.createElement(ChakraProvider, { theme }, React.createElement(ForecastLanding, { headline: 'default', census: summariseCensus(evidence) })),
    )
    const order = Array.from(html.matchAll(/data-story="([STORY])"/g)).map((m) => m[1])
    expect(order).toEqual(['S', 'T', 'O', 'R', 'Y'])
  })
})
