/**
 * Live wavefront engine — the RPC seam: keyed endpoints from the environment (their URLs never
 * shown: the host label is redacted to the hostname), the public endpoints kept as independent
 * groups, the PoolKeeper re-enabling an endpoint after a cooldown, and CountingRpc honouring a
 * cancellation signal.
 */
import { describe, expect, it } from 'vitest'

import {
  AbortedError,
  CountingRpc,
  PoolKeeper,
  buildPool,
  keyedEndpoints,
  liveEndpoints,
  type LiveRpc,
} from '@/lib/wavefront/live'

const ENV = {
  WAVEFRONT_RPC_MAINNET: 'https://eth.example-rpc.io/v2/SECRETKEY123, https://second.example.net/?apikey=XYZ',
  WAVEFRONT_RPC_BASE: 'https://base.example-rpc.io/v2/SECRETKEY123',
}

describe('live engine: RPC endpoints and keys', () => {
  it('keyed endpoints come from WAVEFRONT_RPC_<CHAIN>, first, each its own group; public groups stay', () => {
    const k = keyedEndpoints(ENV)
    expect(k.mainnet.map((e) => e.group)).toEqual(['keyed-eth.example-rpc.io', 'keyed-second.example.net'])
    expect(k.arbitrum).toEqual([])
    const all = liveEndpoints('live', ENV)
    expect(all.mainnet.slice(0, 2).map((e) => e.group)).toEqual(['keyed-eth.example-rpc.io', 'keyed-second.example.net'])
    const publicLogs = new Set(all.mainnet.filter((e) => !e.noLogs && !e.group.startsWith('keyed-')).map((e) => e.group))
    expect(publicLogs.size).toBeGreaterThanOrEqual(2)
    expect(liveEndpoints('live', {}).mainnet.some((e) => e.group.startsWith('keyed-'))).toBe(false)
  })

  it('never shows a keyed URL: host labels are the hostname, errors do not echo the value', () => {
    const { pool, keyedHosts } = buildPool('live', ENV)
    expect(keyedHosts).toEqual(['keyed:eth.example-rpc.io', 'keyed:second.example.net', 'keyed:base.example-rpc.io'])
    const ledger = JSON.stringify(pool.ledger())
    expect(ledger).not.toContain('SECRETKEY123')
    expect(ledger).not.toContain('XYZ')
    expect(() => keyedEndpoints({ WAVEFRONT_RPC_OPTIMISM: 'not a url SECRET' })).toThrow(/an entry is not a URL/)
    expect(() => keyedEndpoints({ WAVEFRONT_RPC_OPTIMISM: 'not a url SECRET' })).not.toThrow(/SECRET/)
    expect(() => keyedEndpoints({ WAVEFRONT_RPC_MAINNET: 'https://rpc.flashbots.net/fast' })).toThrow(/excluded/)
  })

  it('PoolKeeper re-enables an endpoint disabled for capability errors after the cooldown', () => {
    const { pool } = buildPool('live', {})
    let t = 1_000_000
    const keeper = new PoolKeeper(pool, 15 * 60_000, () => t)
    const e = pool.endpoints.base[0]
    e.disabled = 'capability: range limit'
    e.stats.capability = 3
    keeper.tick()
    t += 10 * 60_000
    keeper.tick()
    expect(e.disabled).not.toBeNull()
    t += 6 * 60_000
    keeper.tick()
    expect(e.disabled).toBeNull()
    expect(e.stats.capability).toBe(0)
    expect(keeper.reenabled).toBe(1)
    // A quarantine (false empties) is not undone by the keeper.
    e.disabled = 'quarantined: false empty'
    t += 60 * 60_000
    keeper.tick()
    t += 60 * 60_000
    keeper.tick()
    expect(e.disabled).toBe('quarantined: false empty')
  })

  it('CountingRpc stops waiting at once when the signal aborts', async () => {
    const hang: LiveRpc = { request: () => new Promise(() => {}), groups: () => ['g'] }
    const rpc = new CountingRpc(hang, 60_000)
    const ctrl = new AbortController()
    const p = rpc.request('base', 'eth_getLogs', [], { signal: ctrl.signal })
    setTimeout(() => ctrl.abort(), 20)
    await expect(p).rejects.toThrow(AbortedError)
    expect(rpc.inflight.size).toBe(0)
    await expect(rpc.request('base', 'eth_blockNumber', [], { signal: ctrl.signal })).rejects.toThrow(AbortedError)
  })
})
