import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/components/Carry/fixtures'
import ALIASES from '@/lib/carryScan/onAppAliases.json'
import POOL_ADDRESSES from '@/lib/carryScan/poolAddresses.json'
import {
  buildOnAppSet,
  DEFAULT_ON_APP_INPUTS,
  keyOf,
  morphoMarketKey,
  onAppRouteNotes,
  routeLabel,
  type RouteAlias,
} from '@/lib/carryScan/onApp'
import { upgradeFile } from '@/lib/carryScan/load'
import type { CarryScanFile, Candidate, PoolAddressEntry } from '@/lib/carryScan/types'
import { resolveAddress, stripVenueKeys } from '@/lib/carryScan/verify'
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
const fallbackRaw = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'public', 'data', 'carry-scan-fallback.json'), 'utf8'),
) as CarryScanFile
// The snapshot may predate schema 2: the app reads it through the loader's upgrade, so do the tests.
const fallback = upgradeFile(fallbackRaw)

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

  // Owner ruling 2 (2026-10-11), "we want specific vaults for everything": a venue is on the
  // app ONLY as a specific contract. One contract per label joins the set; a route CLASS
  // (several contracts) joins nothing and annotates; no contract counts as nothing.
  it('every /carry ROUTES label resolves to its seed contract(s) or is unresolved; no waivers', () => {
    const routes = (ALIASES as { routes: Record<string, RouteAlias> }).routes
    for (const r of ROUTES) {
      const e = routes[routeLabel(r)]
      expect(e, routeLabel(r)).toBeDefined()
      expect(e.positions, routeLabel(r)).toBe(r.pos)
      expect(Boolean(e.addresses?.length) !== Boolean(e.unresolved), routeLabel(r)).toBe(true)
      expect('waiver' in e, routeLabel(r)).toBe(false)
      if (e.addresses?.length) expect(e.seedRoute, routeLabel(r)).toBeTruthy()
      for (const a of e.addresses ?? []) expect(a).toMatch(/^0x[0-9a-f]{40}$/)
      expect(new Set(e.addresses ?? []).size).toBe((e.addresses ?? []).length)
    }
    expect(set.unresolvedRoutes.map((u) => u.label)).toEqual(['USDC → Compound'])
    expect(() =>
      buildOnAppSet({ ...DEFAULT_ON_APP_INPUTS, routes: [{ src: 'X', dst: 'Y' }] }, aTokens),
    ).toThrow(/no entry/)
    expect(() =>
      buildOnAppSet(
        {
          ...DEFAULT_ON_APP_INPUTS,
          routes: [{ src: 'X', dst: 'Y' }],
          aliases: { routes: { 'X → Y': { positions: 1 } } },
        },
        aTokens,
      ),
    ).toThrow(/neither addresses nor an unresolved reason/)
  })

  it('a one-contract label is on the app: USDT → Fluid is fLiteUSD, RLUSD → Morpho Vault V2 its one vault', () => {
    const fLiteUSD = '0x273da948aca9261043fbdb2a857bc255ecc29012'
    expect(set.keys.has(keyOf(fLiteUSD))).toBe(true)
    expect(set.bySource.get(keyOf(fLiteUSD))?.has('R4')).toBe(true)
    expect(set.keys.has(keyOf('0x6dc58a0fdfc8d694e571dc59b9a52eeea780e6bf'))).toBe(true)
    // fUSDC is not the /carry route's destination (the seed sends its 15 positions to fLiteUSD).
    expect(set.keys.has(keyOf('0x9fb7b4477576fe5b32be4c1843afb1e55f251b33'))).toBe(false)
  })

  it('a route class never hides a vault: its contracts stay off the on-app set and are annotated', () => {
    const routes = (ALIASES as { routes: Record<string, RouteAlias> }).routes
    const usdc = routes['USDC → Morpho Vault V2'].addresses!
    const pyusd = routes['PYUSD → Morpho Vault V2'].addresses!
    expect(usdc).toHaveLength(33)
    expect(pyusd).toHaveLength(3)
    for (const a of [...usdc, ...pyusd]) {
      expect(set.keys.has(keyOf(a)), a).toBe(false)
      expect(set.routeClassOf.get(keyOf(a))?.length, a).toBeGreaterThan(0)
    }
    expect(set.routeClassOf.get(keyOf(usdc[0]))).toEqual(['USDC → Morpho Vault V2'])
    expect(set.routeClassOf.get(keyOf(pyusd[0]))).toEqual(['PYUSD → Morpho Vault V2'])
    // R4 contributes only one-contract labels: 9 of the 12 /carry routes.
    const r4 = [...set.bySource.entries()].filter(([, s]) => s.has('R4')).length
    expect(r4).toBe(9)
    const notes = onAppRouteNotes(set)
    expect(notes.some((n) => n.includes('class of 33 vaults'))).toBe(true)
    expect(notes.some((n) => n.includes('USDC → Compound'))).toBe(true)
    // A reason that ends in a full stop is not printed as "nothing.).".
    for (const n of notes) expect(n, n).not.toMatch(/\.\)\.$/)
    expect(notes.find((n) => n.includes('USDC → Compound'))).toMatch(/nothing\)\.$/)
  })

  it('a contract named on its own elsewhere is on the app, not annotated as a class destination', () => {
    const a = '0x' + 'ab'.repeat(20)
    const s = buildOnAppSet(
      {
        ...DEFAULT_ON_APP_INPUTS,
        knownVenues: [...DEFAULT_ON_APP_INPUTS.knownVenues, { address: a }],
        routes: [{ src: 'USDC', dst: 'Class' }],
        aliases: {
          routes: { 'USDC → Class': { positions: 2, addresses: [a, '0x' + 'cd'.repeat(20)] } },
        },
      },
      aTokens,
    )
    expect(s.keys.has(keyOf(a))).toBe(true)
    expect(s.routeClassOf.has(keyOf(a))).toBe(false)
    expect(s.routeClassOf.get(keyOf('0x' + 'cd'.repeat(20)))).toEqual(['USDC → Class'])
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

  it('a snapshot row on a /carry route-class vault says so; no other row does', () => {
    for (const r of fallback.rows) {
      const classes = r.key ? (set.routeClassOf.get(r.key) ?? []) : []
      expect(r.alsoBehindRoutes, r.label).toEqual(classes)
    }
    if (fallbackRaw.schemaVersion === 2)
      expect(fallback.rows.some((r) => r.alsoBehindRoutes.length)).toBe(true)
  })

  it('no ranked row in the snapshot is already on the app', () => {
    for (const r of fallback.rows) if (r.key) expect(set.keys.has(r.key)).toBe(false)
  })

  // 2026-10-11 refuter: DeFiLlama's fluid-lite USDC pool is fLiteUSD (0x273da948…), the
  // one-contract /carry route "USDT → Fluid". With no resolver it was listed as an Unverified
  // row (no key) on a page of venues not on the app, and the check above skips keyless rows.
  const FLUID_LITE_USDC = '488f06db-5a36-450e-9ba9-b4321be39c7c'
  const F_LITE_USD = '0x273da948aca9261043fbdb2a857bc255ecc29012'
  const pools = (POOL_ADDRESSES as { pools: Record<string, PoolAddressEntry> }).pools
  const uuidsOf = (r: { aliases: string[] }) =>
    r.aliases.filter((a) => a.startsWith('llama:')).map((a) => a.slice('llama:'.length))

  it('fluid-lite USDC resolves to fLiteUSD, which is on the app, so S5 removes it', async () => {
    const c = { pool: { pool: FLUID_LITE_USDC, project: 'fluid-lite' } } as unknown as Candidate
    const res = await resolveAddress(c, {
      poolAddresses: pools,
      morphoVaults: [],
      aTokenOf: async () => {
        throw new Error('not a lending reserve')
      },
    })
    expect(res.address).toBe(F_LITE_USD)
    expect(set.keys.has(keyOf(res.address!))).toBe(true)
  })

  it('no snapshot row is on the app, keyed or not: a keyless row resolves through poolAddresses.json', () => {
    for (const r of [...fallback.rows, ...fallback.dropped]) {
      const addrs = [
        ...(r.key ? [r.key] : []),
        ...uuidsOf(r).flatMap((u) => (pools[u] ? [keyOf(pools[u].address)] : [])),
      ]
      for (const k of addrs) expect(set.keys.has(k), `${r.label} ${k}`).toBe(false)
    }
    const listed = [...fallback.rows, ...fallback.dropped].flatMap(uuidsOf)
    expect(listed).not.toContain(FLUID_LITE_USDC)
  })
})
