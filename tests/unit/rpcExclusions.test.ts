import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// loadRing reads public/data/rpc-ring.json. Serve a scripted table for that one path so
// the test never depends on the committed file; every other read is the real one.
const savedRing = vi.hoisted(() => ({ json: '' }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const readFileSync = ((path: unknown, ...rest: unknown[]) =>
    String(path).endsWith('rpc-ring.json')
      ? savedRing.json
      : (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest)) as typeof actual.readFileSync
  return { ...actual, default: { ...actual, readFileSync }, readFileSync }
})

import {
  EXCLUDED_LOG_HOSTS,
  isExcludedLogHost,
  withoutExcludedLogHosts,
} from '@/lib/position-sim/rpcExclusions'
import { CANDIDATES, loadRing, type RingTable } from '@/lib/position-sim/rpcRing'
import { historyRpcUrls } from '@/lib/position-sim/historyScan'
import { PUBLIC_MAINNET_RPCS } from '@/lib/position-sim/rpc'
import { PUBLIC_LOG_RPCS, Rpc, envRpcUrls } from '@/lib/oracleRegistry/manipulation/chain/rpc'

const FLASHBOTS = 'https://rpc.flashbots.net/fast'
const MEVBLOCKER = 'https://rpc.mevblocker.io'
const ANKR_KEYED = 'https://rpc.ankr.com/eth/TESTKEY'
const POCKET = 'https://eth.api.pocket.network'
const TENDERLY = 'https://gateway.tenderly.co/public/mainnet'

// Every env var the code under test reads, saved and restored around each test.
const ENV_KEYS = ['RECORDER_RPC_URL', 'NEXT_PUBLIC_MAINNET_RPC_URL'] as const
let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('rpc exclusions: the pure helpers', () => {
  it('matches the relay hostnames only, whatever the path, port or case', () => {
    expect(EXCLUDED_LOG_HOSTS).toEqual(['rpc.flashbots.net', 'rpc.mevblocker.io'])
    for (const u of [FLASHBOTS, 'https://rpc.flashbots.net', 'https://RPC.Flashbots.NET:443/x', 'https://rpc.flashbots.net./fast', MEVBLOCKER, 'https://rpc.mevblocker.io/fast']) {
      expect(isExcludedLogHost(u), u).toBe(true)
    }
    for (const u of ['https://eth.llamarpc.com', 'https://flashbots.net', 'https://docs.flashbots.net', 'not a url', '']) {
      expect(isExcludedLogHost(u), u).toBe(false)
    }
  })

  it('withoutExcludedLogHosts keeps the other URLs in their order', () => {
    expect(withoutExcludedLogHosts([TENDERLY, FLASHBOTS, ANKR_KEYED, MEVBLOCKER, POCKET])).toEqual([TENDERLY, ANKR_KEYED, POCKET])
  })

  it('no built-in getLogs list names a relay', () => {
    expect(CANDIDATES.filter(isExcludedLogHost)).toEqual([])
    expect(PUBLIC_MAINNET_RPCS.filter(isExcludedLogHost)).toEqual([])
    expect(PUBLIC_LOG_RPCS.map((e) => e.url).filter(isExcludedLogHost)).toEqual([])
  })
})

describe('rpc exclusions: the scripts client (scripts/lib/venue-reads.mjs)', () => {
  it('keeps the same relay list as lib/position-sim/rpcExclusions.ts', async () => {
    const { EXCLUDED_RPC_HOSTS } = await import('@/scripts/lib/venue-reads.mjs')
    expect([...EXCLUDED_RPC_HOSTS]).toEqual([...EXCLUDED_LOG_HOSTS])
  })

  it('makeClient drops both relays, a trailing-dot host included, and keeps the rest in order', async () => {
    const { makeClient } = await import('@/scripts/lib/venue-reads.mjs')
    const client = makeClient(`${ANKR_KEYED},${FLASHBOTS},https://rpc.flashbots.net./x,${MEVBLOCKER},${POCKET}`)
    expect(client.chain?.rpcUrls.default.http).toEqual([ANKR_KEYED, POCKET])
  })
})

describe('rpc exclusions: env lists drop the relays', () => {
  it('historyRpcUrls drops both relays from RECORDER_RPC_URL and keeps the ankr URL', () => {
    process.env.RECORDER_RPC_URL = `${ANKR_KEYED},${FLASHBOTS},${MEVBLOCKER}`
    const expected = [PUBLIC_MAINNET_RPCS[0], ANKR_KEYED, ...PUBLIC_MAINNET_RPCS.slice(1)]

    delete process.env.NEXT_PUBLIC_MAINNET_RPC_URL
    expect(historyRpcUrls()).toEqual(expected)
    // The other env source it reads is filtered too.
    process.env.NEXT_PUBLIC_MAINNET_RPC_URL = 'https://rpc.flashbots.net'
    expect(historyRpcUrls()).toEqual(expected)
  })

  it('the oracle registry envRpcUrls drops both relays, and so does its Rpc', () => {
    // A set env var wins, so .env.local is never read here.
    process.env.RECORDER_RPC_URL = `${ANKR_KEYED},${FLASHBOTS},${MEVBLOCKER}`
    expect(envRpcUrls()).toEqual([ANKR_KEYED])

    const labels = new Rpc().labels()
    expect(labels).toContain('env:rpc.ankr.com')
    expect(labels.filter((l) => /flashbots|mevblocker/.test(l))).toEqual([])
  })

  it('loadRing drops saved relay rows, plain and env:<host>, even when RECORDER_RPC_URL resolves them', () => {
    process.env.RECORDER_RPC_URL = `${ANKR_KEYED},${FLASHBOTS}`
    const table: RingTable = {
      probedAt: new Date().toISOString(),
      entries: [TENDERLY, FLASHBOTS, 'env:rpc.flashbots.net', 'env:rpc.ankr.com', MEVBLOCKER, POCKET].map((url) => ({
        url,
        cap: 10_000,
        ms: 1,
        alive: true,
      })),
    }
    savedRing.json = JSON.stringify(table)

    expect(loadRing()?.entries.map((e) => e.url)).toEqual([TENDERLY, ANKR_KEYED, POCKET])
  })
})
