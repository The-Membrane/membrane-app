// lib/position-sim/rpc.ts + adapters/index.ts runAdapter: a throttled or CORS-blocked public
// RPC must not leave a venue "reading…". The client moves past a 429 and a blocked endpoint
// at once, and every venue read has a deadline past which it is a named, retryable failure.

import { describe, expect, it } from 'vitest'

import { noneCopy, readStatus, statusWord } from '@/components/PositionV0/viewModel'
import { ADAPTERS, VENUE_DEADLINE_MS, runAdapter, type LendingAdapter } from '@/lib/position-sim/adapters'
import { BROWSER_MAINNET_RPCS, PUBLIC_MAINNET_RPCS, createMainnetClient } from '@/lib/position-sim/rpc'
import type { AdapterResult, ProtocolId } from '@/lib/position-sim/types'

const THROTTLED = 'https://throttled.example/rpc'
const BLOCKED = 'https://cors-blocked.example/rpc'
const GOOD = 'https://good.example/rpc'

/** First endpoint 429s, second fails like a CORS-blocked preflight, third answers. */
function endpoints() {
  const hits: Record<string, number> = { [THROTTLED]: 0, [BLOCKED]: 0, [GOOD]: 0 }
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    hits[url] = (hits[url] ?? 0) + 1
    if (url === THROTTLED) return new Response('Too Many Requests', { status: 429 })
    // What a blocked preflight looks like to fetch: a TypeError, no response at all.
    if (url === BLOCKED) throw new TypeError('Failed to fetch')
    const body = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x18fe508' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { hits, fetchFn }
}

describe('public RPC failover', () => {
  it('a 429-ing first endpoint and a CORS-failing second: the read completes via the third, within the deadline', async () => {
    const { hits, fetchFn } = endpoints()
    const client = createMainnetClient([THROTTLED, BLOCKED, GOOD], { fetchFn })
    const adapter: LendingAdapter = {
      id: 'aave-v3',
      label: 'Aave V3',
      read: async () => {
        expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(26_207_496n)
        return []
      },
    }
    const t0 = Date.now()
    const r = await runAdapter(adapter, '0x0000000000000000000000000000000000000001')
    expect(r.status).toBe('empty')
    expect(r.timedOut).toBeUndefined()
    expect(Date.now() - t0).toBeLessThan(VENUE_DEADLINE_MS)
    // Each bad endpoint was tried once, not retried: the third answered.
    expect(hits).toEqual({ [THROTTLED]: 1, [BLOCKED]: 1, [GOOD]: 1 })
  })

  it('the browser list holds only endpoints that pass a real CORS preflight; Tenderly is not first', () => {
    expect(BROWSER_MAINNET_RPCS).not.toContain('https://eth.llamarpc.com')
    expect(BROWSER_MAINNET_RPCS[0]).toBe('https://ethereum-rpc.publicnode.com')
    expect(BROWSER_MAINNET_RPCS).toContain('https://gateway.tenderly.co/public/mainnet')
    // Server and script archive reads keep Tenderly first.
    expect(PUBLIC_MAINNET_RPCS[0]).toBe('https://gateway.tenderly.co/public/mainnet')
  })
})

describe('venue deadline', () => {
  it('a read that never answers is a named, timed-out failure, and the page never says "No open position found"', async () => {
    const stuck: LendingAdapter = { id: 'aave-v3', label: 'Aave V3', read: () => new Promise(() => {}) }
    const t0 = Date.now()
    const r = await runAdapter(stuck, '0x0000000000000000000000000000000000000001', 40)
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(r).toMatchObject({ status: 'error', timedOut: true, message: "couldn't read Aave V3: public RPC busy (no answer in 0.04 s)" })
    expect(VENUE_DEADLINE_MS).toBe(25_000)

    const order = ADAPTERS.map((a) => ({ id: a.id, label: a.label }))
    const empty = (protocol: ProtocolId): AdapterResult => ({ protocol, label: protocol, status: 'empty', positions: [], fetchedAt: 1 })
    const results: Partial<Record<ProtocolId, AdapterResult>> = {
      'aave-v3': r,
      spark: empty('spark'),
      'morpho-blue': empty('morpho-blue'),
      'compound-v3': empty('compound-v3'),
      fluid: { ...empty('fluid'), status: 'unsupported' },
    }
    const items = readStatus(order, results)
    expect(items[0].timedOut).toBe(true)
    expect(statusWord(items[0])).toBe("couldn't read Aave V3: public RPC busy")
    expect(items.some((i) => i.state === 'pending')).toBe(false)
    expect(noneCopy(items).headline).toBe('Not every venue could be read')
  })
})
