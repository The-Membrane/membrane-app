import { readFileSync } from 'fs'
import { join } from 'path'
import { decodeAbiParameters } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  ctaEnabled,
  ctaFor,
  ctaLabel,
  NOT_DEPLOYABLE_LABEL,
  readinessFor,
  READINESS_BLOCKERS,
  scoutReadiness,
  segueFor,
} from '@/lib/carryScan/readiness'
import type { CarryScanFile, ScoutKind } from '@/lib/carryScan/types'

const fallback = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'public', 'data', 'carry-scan-fallback.json'), 'utf8'),
) as CarryScanFile
const LIVE = { launched: true, factoriesConfigured: true }

const tier = (kind: ScoutKind, stables = ['USDC'], withdraw?: 'instant' | 'queued') =>
  readinessFor({ kind, stables, withdraw }).tier

describe('readiness tiers', () => {
  it('maps venue types', () => {
    expect(tier('metamorpho')).toBe('ready-cv')
    expect(tier('euler')).toBe('ready-cv')
    expect(tier('erc4626')).toBe('ready-cv')
    expect(tier('aave-reserve')).toBe('ready-dv')
    expect(tier('spark-reserve')).toBe('ready-dv')
    expect(tier('morpho-vault-v2')).toBe('needs-adapter')
    expect(tier('compound')).toBe('needs-adapter')
    expect(tier('other')).toBe('needs-adapter')
    expect(tier('erc4626', ['USDC'], 'queued')).toBe('needs-adapter')
  })

  it('owner Q3: any non-USDC asset is "not deployable yet (vaults hold USDC)", LPs included', () => {
    for (const k of ['metamorpho', 'aave-reserve', 'erc4626'] as ScoutKind[]) {
      const r = readinessFor({ kind: k, stables: ['USDT'] })
      expect(r.tier).toBe('not-deployable')
      expect(r.route).toBe(NOT_DEPLOYABLE_LABEL)
    }
    expect(NOT_DEPLOYABLE_LABEL).toBe('not deployable yet (vaults hold USDC)')
    expect(tier('lp', ['USDC', 'USDT'])).toBe('not-deployable')
  })

  it('every ready-* row carries the G1 and G3 blockers, so no CTA is live before launch', () => {
    const r = readinessFor({ kind: 'metamorpho', stables: ['USDC'] })
    expect(r.blockers).toEqual([READINESS_BLOCKERS.G1, READINESS_BLOCKERS.G3])
    expect(ctaEnabled(r, { launched: true, factoriesConfigured: true })).toBe(false)
    expect(ctaEnabled({ ...r, blockers: [] }, { launched: false, factoriesConfigured: true })).toBe(
      false,
    )
    expect(ctaEnabled({ ...r, blockers: [] }, { launched: true, factoriesConfigured: false })).toBe(
      false,
    )
    expect(ctaEnabled({ ...r, blockers: [] }, { launched: true, factoriesConfigured: true })).toBe(
      true,
    )
    expect(ctaLabel(r, { launched: false, factoriesConfigured: false })).toMatch(/^After launch: /)
  })
})

describe('segue', () => {
  const vault = '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33'
  it('a ready-cv row proposes the vault itself; venueData = abi.encode(venue)', () => {
    const s = segueFor(
      { kind: 'erc4626', address: vault },
      readinessFor({ kind: 'erc4626', stables: ['USDC'] }),
    )
    expect(s).toMatchObject({ kind: 'cv-propose', implId: 'erc4626' })
    expect(
      decodeAbiParameters([{ type: 'address' }], s.venueData as `0x${string}`)[0].toLowerCase(),
    ).toBe(vault)
  })
  it('a ready-dv Aave reserve encodes (pool, aToken)', () => {
    const pool = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
    const aToken = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c'
    const s = segueFor(
      { kind: 'aave-reserve', address: aToken, aavePool: pool },
      readinessFor({ kind: 'aave-reserve', stables: ['USDC'] }),
    )
    expect(s.kind).toBe('dv-create')
    const [p, a] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }],
      s.venueData as `0x${string}`,
    )
    expect([p.toLowerCase(), a.toLowerCase()]).toEqual([pool.toLowerCase(), aToken])
  })
  it('no segue for a row that is not ready', () => {
    expect(
      segueFor(
        { kind: 'morpho-vault-v2', address: vault },
        readinessFor({ kind: 'morpho-vault-v2', stables: ['USDC'] }),
      ).kind,
    ).toBe('none')
  })
})

describe('unverified rows and unresolved addresses (design: an Unverified row gets no CTA)', () => {
  const vault = '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33'

  it('a row whose address did not resolve reads "address not resolved", not a venue-type verdict', () => {
    const { readiness } = scoutReadiness({
      list: 'unverified',
      kind: 'other',
      stables: ['USDC'],
      address: null,
    })
    expect(readiness.tier).toBe('unresolved')
    expect(readiness.route).toMatch(/^address not resolved/)
    expect(readiness.route).not.toMatch(/not an ERC-4626/)
    // Non-USDC stays "not deployable yet": that is true whatever the address.
    expect(
      scoutReadiness({ list: 'unverified', kind: 'other', stables: ['USDT'], address: null })
        .readiness.tier,
    ).toBe('not-deployable')
  })

  it('an Unverified row gets no segue and no CTA, even when its venue type would be ready', () => {
    const row = {
      kind: 'erc4626' as const,
      stables: ['USDC'],
      address: vault,
      withdraw: 'instant' as const,
    }
    const unverified = scoutReadiness({ ...row, list: 'unverified' })
    expect(unverified.readiness.tier).toBe('ready-cv')
    expect(unverified.segue.kind).toBe('none')
    const unblocked = { ...unverified.readiness, blockers: [] }
    expect(ctaFor({ list: 'unverified', readiness: unblocked }, LIVE)).toBeNull()

    const ranked = scoutReadiness({ ...row, list: 'ranked' })
    expect(ranked.segue.kind).toBe('cv-propose')
    expect(
      ctaFor(
        { list: 'ranked', readiness: ranked.readiness },
        { launched: false, factoriesConfigured: false },
      ),
    ).toEqual({
      enabled: false,
      label: `After launch: ${ranked.readiness.route}`,
    })
    expect(
      ctaFor({ list: 'ranked', readiness: { ...ranked.readiness, blockers: [] } }, LIVE)?.enabled,
    ).toBe(true)
  })

  it('the snapshot: no unverified row has a segue; no unresolved row claims a venue type', () => {
    for (const r of fallback.rows) {
      if (r.list === 'unverified') expect(r.segue.kind).toBe('none')
      if (r.address === null && r.kind !== 'lp' && r.readiness.tier !== 'not-deployable')
        expect(r.readiness.tier).toBe('unresolved')
    }
  })
})
