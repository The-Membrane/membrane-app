import { describe, expect, it } from 'vitest'

import {
  computeRadar,
  computeVenueVerdict,
  fmtMultiple,
  fmtUsd,
  shareLine,
  type VenueInputs,
} from '@/components/Radar/radarLogic'

// Real corpus numbers (queried from Neon 2026-09-04) so the tests exercise the
// same shapes the API serves.
const AAVE_INSTANT = 331_961_674 // aave-v3-usde latest instant_usd (USD)
const AAVE_WORST1D = 53_191_176 // worst single-day outflow, trailing 90d
const AAVE_WORST7D = 111_408_735
const SUSDE_WORST1D = 70_191_284
const SUSDE_WORST7D = 170_590_299
const SUSDE_TVL = 1_430_431_205 // totalAssets / 1e18

const aave = (usd: number): VenueInputs => ({
  venue: 'aave-v3-usde',
  label: 'Aave',
  kind: 'atoken-liquidity',
  usd,
  tvlUsd: null, // aToken TVL not read
  instantUsd: AAVE_INSTANT,
  cooldownSeconds: null,
  flow: { worst1dUsd: AAVE_WORST1D, worst7dUsd: AAVE_WORST7D, dayCount: 91 },
})

const susde = (usd: number): VenueInputs => ({
  venue: 'sUSDe',
  label: 'sUSDe',
  kind: 'erc4626-cooldown',
  usd,
  tvlUsd: SUSDE_TVL,
  instantUsd: null, // cooldown vault — NOT derivable
  cooldownSeconds: 86_400, // 1-day gate
  flow: { worst1dUsd: SUSDE_WORST1D, worst7dUsd: SUSDE_WORST7D, dayCount: 91 },
})

describe('inventory proxy thresholds — both sides', () => {
  it('keeps a position at caution even when recorded inventory dwarfs it (coverage ≥ 10x)', () => {
    const v = computeVenueVerdict(aave(2_100_000)) // instant 158x
    expect(v.verdict).toBe('caution')
    expect(v.prongs.instant?.level).toBe('caution')
    expect(v.prongs.flow).toBeNull()
    expect(v.reason).toMatch(/recorded instant inventory/)
    expect(v.reason).toMatch(/holder path and health remain unverified/)
    expect(v.reason).not.toMatch(/can exit|clears|covers/i)
  })

  it('flags a size that exceeds capacity (coverage < 1x)', () => {
    const v = computeVenueVerdict(aave(400_000_000)) // instant 0.83x
    expect(v.verdict).toBe('exposed')
    expect(v.prongs.instant?.level).toBe('exposed')
    expect(v.reason).toMatch(/exceeds recorded instant inventory/)
    expect(v.reason).not.toMatch(/can exit|clears/i)
  })

  it('is exactly at the band edges', () => {
    // Inventory ≥1x is caution (holder execution unresolved); just under 1x is exposed.
    const at10 = computeVenueVerdict({ ...aave(0), usd: AAVE_INSTANT / 10 })
    const at1 = computeVenueVerdict({ ...aave(0), usd: AAVE_INSTANT })
    const under1 = computeVenueVerdict({ ...aave(0), usd: AAVE_INSTANT + 1 })
    expect(at10.prongs.instant?.level).toBe('caution')
    expect(at1.prongs.instant?.level).toBe('caution')
    expect(under1.prongs.instant?.level).toBe('exposed')
  })
})

describe('weakest-prong selection — verdict is never averaged', () => {
  it('a 1-day cooldown is caution and does not promise withdrawal after the gate', () => {
    // sUSDe at a tiny size: the cooldown gate applies regardless of size.
    const v = computeVenueVerdict(susde(1_000))
    expect(v.prongs.flow).toBeNull()
    expect(v.prongs.cooldown?.level).toBe('caution')
    expect(v.verdict).toBe('caution')
    expect(v.reason).toMatch(/cooldown/)
    expect(v.reason).toMatch(/before withdrawal eligibility/)
    expect(v.reason).toMatch(/completion after the gate is unverified/)
  })

  it('a small historical outflow cannot drag an inventory-caution venue to exposed', () => {
    const v = computeVenueVerdict({
      venue: 'x',
      label: 'X',
      kind: 'atoken-liquidity',
      usd: 50,
      tvlUsd: null,
      instantUsd: 1000, // 20x inventory → caution, not executable clearance
      cooldownSeconds: null,
      flow: { worst1dUsd: 10, worst7dUsd: 10, dayCount: 1 },
    })
    expect(v.prongs.instant?.level).toBe('caution')
    expect(v.prongs.flow).toBeNull()
    expect(v.verdict).toBe('caution')
    expect(v.reason).not.toMatch(/outflow|worst|served/i)
  })

  it('a large historical outflow alone cannot clear a holder or generate a size claim', () => {
    const onlyFlow = {
      ...aave(50_000_000),
      instantUsd: null,
      flow: { worst1dUsd: 500_000_000, worst7dUsd: 900_000_000, dayCount: 91 },
    }
    const v = computeVenueVerdict(onlyFlow)
    expect(v.prongs.flow).toBeNull()
    expect(v.verdict).toBe('caution')
    expect(v.reason).toMatch(/no instant capacity or cooldown gate recorded/)
    expect(shareLine(computeRadar([onlyFlow]))).not.toMatch(/clears my size|worst exit day/)
  })

  it('changing aggregate flow cannot alter a gate or instant-capacity verdict', () => {
    const withoutFlow = computeVenueVerdict({ ...aave(2_100_000), flow: null })
    const withFlow = computeVenueVerdict(aave(2_100_000))
    expect(withFlow).toEqual(withoutFlow)
  })
})

describe('honesty — no fabricated instant claim for cooldown vaults', () => {
  it('leaves the instant prong null when instantUsd is null', () => {
    const v = computeVenueVerdict(susde(5_000_000))
    expect(v.prongs.instant).toBeNull()
    // The rendered reason must never assert an instant number for this venue.
    expect(v.reason).not.toMatch(/instant liquidity/)
  })

  it('shows share_of_tvl only where a TVL was actually read', () => {
    const s = computeVenueVerdict(susde(14_304_312)) // ~1% of sUSDe TVL
    expect(s.shareOfTvl).toBeCloseTo(0.01, 3)
    const a = computeVenueVerdict(aave(2_100_000)) // aToken TVL not read
    expect(a.shareOfTvl).toBeNull()
  })
})

describe('zero-position', () => {
  it('returns a benign verdict with no prongs and no fabricated numbers', () => {
    const v = computeVenueVerdict(susde(0))
    expect(v.verdict).toBe('clear')
    expect(v.reason).toBe('no position in this venue')
    expect(v.prongs.instant).toBeNull()
    expect(v.prongs.cooldown).toBeNull()
    expect(v.prongs.flow).toBeNull()
  })

  it('is excluded from held positions but still appears in the comparator', () => {
    const r = computeRadar([aave(2_100_000), susde(0)])
    expect(r.heldCount).toBe(1)
    expect(r.positions.map((p) => p.venue)).toEqual(['aave-v3-usde'])
    expect(r.comparator.map((p) => p.venue).sort()).toEqual(['aave-v3-usde', 'sUSDe'])
  })
})

describe('share-line rendering — the user’s own result, never a plug', () => {
  it('summarizes held venues by their governing prong', () => {
    const r = computeRadar([aave(2_100_000), susde(1_000_000)])
    const line = shareLine(r)
    expect(line).toContain('My $3.1M across 2 venues')
    expect(line).toContain('Aave recorded instant inventory is')
    expect(line).toContain('withdrawal unverified')
    expect(line).toContain('sUSDe requires a 1d cooldown before withdrawal eligibility')
    expect(line).not.toMatch(/clears my size|can exit|served/i)
    expect(line.endsWith('Membrane Carry Radar')).toBe(true)
    expect(line).not.toMatch(/sign up|try |visit /i)
  })

  it('says so plainly when nothing is held', () => {
    const r = computeRadar([aave(0), susde(0)])
    expect(r.heldCount).toBe(0)
    expect(shareLine(r)).toBe(
      'No position in any instrumented Membrane venue — Membrane Carry Radar',
    )
  })
})

describe('formatters — two significant figures, reader units', () => {
  it('formats USD with a suffix at 2 sig figs', () => {
    expect(fmtUsd(331_961_674)).toBe('$330M')
    expect(fmtUsd(2_100_000)).toBe('$2.1M')
    expect(fmtUsd(53_191_176)).toBe('$53M')
    expect(fmtUsd(1_430_431_205)).toBe('$1.4B')
  })

  it('formats x-multiples cleanly', () => {
    expect(fmtMultiple(25.3)).toBe('25x')
    expect(fmtMultiple(3.4)).toBe('3.4x')
    expect(fmtMultiple(158)).toBe('160x')
    expect(fmtMultiple(Infinity)).toBe('∞')
  })
})
