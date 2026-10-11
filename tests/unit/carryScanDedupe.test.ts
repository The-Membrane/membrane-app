import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/components/Carry/fixtures'
import ALIASES from '@/lib/carryScan/onAppAliases.json'
import {
  buildOnAppSet,
  DEFAULT_ON_APP_INPUTS,
  keyOf,
  morphoMarketKey,
  routeLabel,
} from '@/lib/carryScan/onApp'
import type { CarryScanFile } from '@/lib/carryScan/types'
import { stripVenueKeys } from '@/lib/carryScan/verify'
import { netBreakdown } from '@/lib/netApy/breakdown'
import { bigintReviver } from '@/lib/netApy/fixedPoint'
import { serialize } from '@/lib/netApy/service'
import type { VenueSnapshot } from '@/lib/netApy/types'

const irm = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'net-apy-irm.json'), 'utf8'),
  bigintReviver,
) as { snapshots: VenueSnapshot[] }
const aTokens = new Map<string, string>()
for (const s of irm.snapshots)
  if (s.state.kind === 'aave-virtual' || s.state.kind === 'spark')
    aTokens.set(s.venueKey, s.state.aToken)
const set = buildOnAppSet(DEFAULT_ON_APP_INPUTS, aTokens)
const fallback = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'public', 'data', 'carry-scan-fallback.json'), 'utf8'),
) as CarryScanFile

describe('S5 the on-app set', () => {
  it('each of R1–R4 contributes keys', () => {
    const by = (src: string) =>
      [...set.bySource.entries()].filter(([, s]) => s.has(src as never)).length
    for (const src of ['R1', 'R2', 'R3', 'R4']) expect(by(src)).toBeGreaterThan(0)
    expect(set.unresolved).toEqual([])
  })

  it('compares keys lowercase', () => {
    for (const k of set.keys) expect(k).toBe(k.toLowerCase())
    expect(keyOf('0x9D39A5DE30e57443BfF2A8307A4256c8797A3497')).toBe(
      '1:0x9d39a5de30e57443bff2a8307a4256c8797a3497',
    )
  })

  it('excludes sUSDe, aEthUSDe, sUSDS, scrvUSD, sDAI and sfrxUSD', () => {
    const on = (a: string) => set.keys.has(keyOf(a))
    expect(on('0x9d39a5de30e57443bff2a8307a4256c8797a3497')).toBe(true) // sUSDe
    expect(on('0x4f5923fc5fd4a93352581b38b7cd26943012decf')).toBe(true) // aEthUSDe
    expect(on('0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD')).toBe(true) // sUSDS
    expect(on('0x0655977FEb2f289A4aB78af67BAB0d17aAb84367')).toBe(true) // scrvUSD
    expect(on('0x83F20F44975D03b1b09e64809B757c47f942BEeA')).toBe(true) // sDAI
    expect(on('0xcF62F305562bA0170A4fa456be9BcB6fa6Ca6A70')).toBe(true) // sfrxUSD as KNOWN_VENUES lists it
  })

  it('R2: Aave/Spark resolve to the aToken read on-chain; Morpho markets key on the market id', () => {
    expect(set.keys.has(keyOf(aTokens.get('spark-usdc')!))).toBe(true)
    expect(
      set.keys.has(
        morphoMarketKey('0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64'),
      ),
    ).toBe(true)
    const missing = buildOnAppSet(DEFAULT_ON_APP_INPUTS, new Map())
    expect(missing.unresolved).toContain('aave-v3-usdc')
  })

  it('every /carry ROUTES label resolves to an address or is an explicit waiver', () => {
    const routes = (
      ALIASES as { routes: Record<string, { addresses?: string[]; waiver?: string }> }
    ).routes
    for (const r of ROUTES) {
      const e = routes[routeLabel(r)]
      expect(e, routeLabel(r)).toBeDefined()
      expect(Boolean(e.addresses?.length) !== Boolean(e.waiver), routeLabel(r)).toBe(true)
      for (const a of e.addresses ?? []) expect(a).toMatch(/^0x[0-9a-f]{40}$/)
    }
    expect(set.waivers.map((w) => w.label).sort()).toEqual([
      'USDC → Compound',
      'USDC → Morpho Vault V2',
      'USDT → Fluid',
    ])
    expect(() =>
      buildOnAppSet({ ...DEFAULT_ON_APP_INPUTS, routes: [{ src: 'X', dst: 'Y' }] }, aTokens),
    ).toThrow(/no entry/)
  })
})

describe('scout output never mints a venue key', () => {
  const hasKey = (v: unknown, k: string): boolean =>
    Array.isArray(v)
      ? v.some((x) => hasKey(x, k))
      : !!v &&
        typeof v === 'object' &&
        Object.entries(v).some(([kk, x]) => kk === k || hasKey(x, k))

  it('rows carry 1:<address> keys and no venueKey/name field', () => {
    for (const r of [...fallback.rows, ...fallback.dropped, ...fallback.nowOnApp]) {
      expect(hasKey(r, 'venueKey')).toBe(false)
      expect(hasKey(r, 'name')).toBe(false)
      if (r.key) expect(r.key).toMatch(/^1:0x[0-9a-f]{40}(:0x[0-9a-f]{64})?$/)
    }
  })

  it('a serialized breakdown is stripped of venueKey at every depth', () => {
    const s = irm.snapshots.find((x) => x.venueKey === 'aave-v3-usdc')!
    const raw = serialize(netBreakdown(s, { side: 'supply', sizeUsd: 1e5 }))
    expect(hasKey(raw, 'venueKey')).toBe(true)
    expect(hasKey(stripVenueKeys(raw), 'venueKey')).toBe(false)
  })

  it('no ranked row in the snapshot is already on the app', () => {
    for (const r of fallback.rows) if (r.key) expect(set.keys.has(r.key)).toBe(false)
  })
})
