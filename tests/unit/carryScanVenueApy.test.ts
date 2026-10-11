// Owner ruling 1 (2026-10-11): "Vaults should average the APYs with hoverable data to show
// data sources". The rule (lib/carryScan/venueApy.ts), the at-size dilution, the disagreement
// flag, and the popover's open/close logic (tap, hover, focus) — the last as a pure reducer,
// since the unit suite runs without a DOM.

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import {
  averagedSummary,
  CLOSED,
  hoverEventFor,
  isOpen,
  layoutViewportWidth,
  methodTag,
  panelShiftX,
  popoverReducer,
  type PopoverEvent,
  type PopoverState,
} from '@/components/CarryScout/ApySources'
import { carryAOf, venueColumnsFromLlama } from '@/lib/carryScan/columns'
import { upgradeFile } from '@/lib/carryScan/load'
import type { CarryScanFile, LlamaPool, MorphoVaultInfo } from '@/lib/carryScan/types'
import {
  averagedVenueApy,
  isVaultKind,
  llamaVenueApy,
  onchainIrmVenueApy,
  sourcesDisagree,
  venueColumnsFromAverage,
} from '@/lib/carryScan/venueApy'

const VAULT = '0x' + 'aa'.repeat(20)
const pool = (o: Partial<LlamaPool> = {}): LlamaPool => ({
  pool: 'pool-vault',
  chain: 'Ethereum',
  project: 'morpho-blue',
  symbol: 'XUSDC',
  tvlUsd: 50e6,
  apy: 7.6,
  apyBase: 4.9,
  apyReward: 2.7,
  apyMean30d: 6,
  stablecoin: true,
  exposure: 'single',
  ilRisk: 'no',
  poolMeta: null,
  count: 200,
  outlier: false,
  underlyingTokens: null,
  ...o,
})
const morpho = (o: Partial<MorphoVaultInfo> = {}): MorphoVaultInfo => ({
  address: VAULT,
  symbol: 'XUSDC',
  name: 'X',
  assetAddress: '0x' + 'bb'.repeat(20),
  version: 'v1',
  netApy: 0.0767,
  netApyExcludingRewards: 0.0488,
  fee: 0.05,
  totalAssetsUsd: 50e6,
  ...o,
})
const T = 1_786_000_000
const close = (a: number | null, b: number) => expect(a).toBeCloseTo(b, 12)

describe('the averaged venue APY of a vault row', () => {
  it('base = mean of DeFiLlama apyBase, Morpho no-rewards and on-chain 7d; with rewards = base mean + mean reward', () => {
    const va = averagedVenueApy({
      pool: pool(),
      fetchedAt: T,
      morpho: morpho(),
      onchain: { value: 0.049, asOf: T - 60, address: VAULT },
    })
    expect(va.method).toBe('average')
    close(va.base, (0.049 + 0.0488 + 0.049) / 3)
    const rBar = (0.076 - 0.049 + (0.0767 - 0.0488)) / 2
    close(va.withRewards, va.base! + rBar)
    // ≡ the mean of DeFiLlama apy, Morpho netApy, and on-chain 7d + the mean reward.
    close(va.withRewards, (0.076 + 0.0767 + (0.049 + rBar)) / 3)
    expect(va.sources.map((s) => `${s.source}:${s.basis}:${s.averaged}`)).toEqual([
      'defillama:base:true',
      'defillama:with-rewards:true',
      'morpho-api:base:true',
      'morpho-api:with-rewards:true',
      'onchain-7d:base:true',
    ])
    const o = va.sources.find((s) => s.source === 'onchain-7d')!
    expect(o.asOf).toBe(T - 60)
    expect(o.url).toBe(`https://etherscan.io/address/${VAULT}`)
    expect(o.note).toMatch(/mean reward/)
    expect(va.sources[0].url).toBe('https://defillama.com/yields/pool/pool-vault')
    expect(va.sources[2].url).toBe(`https://app.morpho.org/ethereum/vault/${VAULT}`)
    expect(methodTag(va)).toBe('avg of 3')
  })

  it('a missing source is left out of the mean and listed as missing — never counted as 0', () => {
    const va = averagedVenueApy({
      pool: pool(),
      fetchedAt: T,
      morpho: morpho({ netApyExcludingRewards: null }),
    })
    close(va.base, 0.049) // DeFiLlama alone: a 0 would have halved it
    const m = va.sources.find((s) => s.source === 'morpho-api' && s.basis === 'base')!
    expect(m).toMatchObject({ value: null, status: 'missing', averaged: false })
    // Morpho reports no base, so it gives no reward figure; its with-rewards view still counts.
    close(va.withRewards, (0.076 + 0.0767) / 2)
  })

  it('a failed on-chain read is listed as failed, with its reason, and not averaged', () => {
    const va = averagedVenueApy({
      pool: pool(),
      fetchedAt: T,
      morpho: null,
      onchain: {
        error: '7-day share-price read failed: missing trie node',
        asOf: T,
        address: VAULT,
      },
    })
    const o = va.sources.find((s) => s.source === 'onchain-7d')!
    expect(o).toMatchObject({ status: 'failed', value: null, averaged: false })
    expect(o.note).toContain('missing trie node')
    close(va.base, 0.049)
    close(va.withRewards, 0.076)
    expect(methodTag(va)).toBe('avg of 1')
  })

  it('with no reward reported anywhere, with rewards IS the base mean', () => {
    const va = averagedVenueApy({
      pool: pool({ apy: 5, apyBase: 5, apyReward: null }),
      fetchedAt: T,
      morpho: morpho({ netApy: 0.052, netApyExcludingRewards: 0.052 }),
      onchain: { value: 0.049, asOf: T, address: VAULT },
    })
    close(va.base, (0.05 + 0.052 + 0.049) / 3)
    close(va.withRewards, va.base!)
  })

  it('a non-Morpho ERC-4626 vault averages DeFiLlama and on-chain only; Morpho is not listed', () => {
    const va = averagedVenueApy({
      pool: pool({ project: 'sky', apy: 4.5, apyBase: 4.5, apyReward: null }),
      fetchedAt: T,
      morpho: null,
      onchain: { value: 0.0462, asOf: T, address: VAULT },
    })
    expect(va.sources.some((s) => s.source === 'morpho-api')).toBe(false)
    close(va.base, (0.045 + 0.0462) / 2)
    close(va.withRewards, va.base!)
  })

  it('a Morpho vault with no Morpho API entry lists Morpho as missing (not silently absent)', () => {
    for (const kind of ['metamorpho', 'morpho-vault-v2'] as const) {
      const va = averagedVenueApy({
        pool: pool(),
        fetchedAt: T,
        morpho: null,
        kind,
        address: VAULT,
        onchain: { value: 0.05, asOf: T, address: VAULT },
      })
      const m = va.sources.filter((s) => s.source === 'morpho-api')
      expect(m.map((s) => s.basis)).toEqual(['base', 'with-rewards'])
      for (const s of m) {
        expect(s.status).toBe('missing')
        expect(s.value).toBeNull()
        expect(s.averaged).toBe(false)
        expect(s.note).toMatch(/no Morpho API entry/)
        expect(s.url).toContain(VAULT)
      }
      // Left out of the mean: DeFiLlama and on-chain only.
      close(va.base, (0.049 + 0.05) / 2)
      expect(methodTag(va)).toBe('avg of 2')
    }
    // A non-Morpho ERC-4626 vault still lists no Morpho source.
    const plain = averagedVenueApy({ pool: pool(), fetchedAt: T, morpho: null, kind: 'erc4626' })
    expect(plain.sources.some((s) => s.source === 'morpho-api')).toBe(false)
  })

  it('a mean reward that rounds to zero prints as 0.00pp, never -0.00pp', () => {
    // 2026-10-11 snapshot: BBQUSDC, BBQUSDT and GTMSUSDC read "(-0.00pp)" (DeFiLlama apy a hair
    // under apyBase).
    const va = averagedVenueApy({
      pool: pool({ apy: 4.8999, apyBase: 4.9, apyReward: null }),
      fetchedAt: T,
      morpho: morpho({ netApy: 0.0488, netApyExcludingRewards: 0.0488 }),
      onchain: { value: 0.05, asOf: T, address: VAULT },
    })
    const note = va.sources.find((s) => s.source === 'onchain-7d')!.note!
    expect(note).not.toContain('-0.00')
    expect(note).toContain('(0.00pp)')
  })

  it('at size: the averaged figure × TVL/(TVL+size), unpriced above 5% of TVL; (a) follows it', () => {
    const va = averagedVenueApy({
      pool: pool(),
      fetchedAt: T,
      morpho: morpho(),
      onchain: { value: 0.049, asOf: T, address: VAULT },
    })
    const cols = venueColumnsFromAverage(va, 50e6)
    close(cols.venueNet['100k'].apy, (va.withRewards! * 50e6) / (50e6 + 1e5))
    close(cols.venueNetBase['1m'].apy, (va.base! * 50e6) / (50e6 + 1e6))
    expect(cols.venueNet['100k'].note).toBe('averaged APY × TVL/(TVL+size)')
    expect(cols.venueNet['100k'].labelClass).toBe('projected')
    expect(cols.venueNet['10m'].apy).toBeNull() // $10M > 5% of $50M
    const bench = {
      venue: 'b',
      stable: 'USDC',
      apy: 0.05,
      labelClass: 'derived' as const,
      source: 'onchain' as const,
    }
    close(carryAOf(cols.venueNet['100k'], bench)!.apy, cols.venueNet['100k'].apy! - 0.05)
  })

  it('the rank follows the average: a vault DeFiLlama overstates falls below one it does not', () => {
    const bench = {
      venue: 'b',
      stable: 'USDC',
      apy: 0.04,
      labelClass: 'derived' as const,
      source: 'onchain' as const,
    }
    // DeFiLlama says 7.6% for X and 7.0% for Y; Morpho and the chain say X realizes ~5%.
    const x = averagedVenueApy({
      pool: pool({ apy: 7.6, apyBase: 7.6, apyReward: null }),
      fetchedAt: T,
      morpho: morpho({ netApy: 0.05, netApyExcludingRewards: 0.05 }),
      onchain: { value: 0.05, asOf: T, address: VAULT },
    })
    const y = averagedVenueApy({
      pool: pool({ pool: 'pool-y', apy: 7.0, apyBase: 7.0, apyReward: null }),
      fetchedAt: T,
      morpho: morpho({ netApy: 0.07, netApyExcludingRewards: 0.07 }),
      onchain: { value: 0.07, asOf: T, address: VAULT },
    })
    const a = (va: typeof x) =>
      carryAOf(venueColumnsFromAverage(va, 50e6).venueNet['100k'], bench)!.apy!
    const llamaA = (p: LlamaPool) =>
      carryAOf(venueColumnsFromLlama(p).venueNet['100k'], bench)!.apy!
    expect(llamaA(pool({ apy: 7.6 }))).toBeGreaterThan(llamaA(pool({ apy: 7.0 })))
    expect(a(y)).toBeGreaterThan(a(x))
  })

  it('flags "source disagreement" when one basis spreads more than 1pp, and keeps the spread', () => {
    const wide = averagedVenueApy({
      pool: pool(),
      fetchedAt: T,
      morpho: morpho(),
      onchain: { value: 0.0345, asOf: T, address: VAULT },
    })
    close(wide.spread.base, 0.049 - 0.0345)
    close(wide.spread.withRewards, 0.0767 - 0.076)
    expect(sourcesDisagree(wide)).toBe(true)
    const tight = averagedVenueApy({
      pool: pool(),
      fetchedAt: T,
      morpho: morpho(),
      onchain: { value: 0.0485, asOf: T, address: VAULT },
    })
    expect(sourcesDisagree(tight)).toBe(false)
    const single = averagedVenueApy({ pool: pool(), fetchedAt: T, morpho: null })
    expect(single.spread).toEqual({ base: null, withRewards: null })
    expect(sourcesDisagree(single)).toBe(false)
  })

  it('only MetaMorpho, Morpho Vault V2 and other ERC-4626 kinds are averaged', () => {
    for (const k of ['metamorpho', 'morpho-vault-v2', 'erc4626'] as const)
      expect(isVaultKind(k)).toBe(true)
    for (const k of ['aave-reserve', 'spark-reserve', 'euler', 'lp', 'compound', 'other'] as const)
      expect(isVaultKind(k)).toBe(false)
  })

  it('stores nothing that reads as a venue-registry key or name', () => {
    const va = averagedVenueApy({
      pool: pool(),
      fetchedAt: T,
      morpho: morpho(),
      onchain: { value: 0.049, asOf: T, address: VAULT },
    })
    for (const s of va.sources) {
      expect(Object.keys(s)).not.toContain('name')
      expect(Object.keys(s)).not.toContain('venueKey')
    }
  })
})

describe('the committed snapshot (a schema-2 dry run)', () => {
  const raw = JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'public', 'data', 'carry-scan-fallback.json'), 'utf8'),
  ) as CarryScanFile
  const file = upgradeFile(raw)

  it('prices every vault row from its average, × TVL/(TVL+size), and stamps the rule', () => {
    if (raw.schemaVersion !== 2) return // an older snapshot is upgraded, not re-averaged
    expect(file.venueApyRule).toMatch(/average of their sources/)
    const vaults = file.rows.filter(
      (r) => r.list !== 'unverified' && isVaultKind(r.kind) && r.exposure === 'single',
    )
    expect(vaults.length).toBeGreaterThan(0)
    for (const r of vaults) {
      expect(r.venueApy.method, r.label).toBe('average')
      const at = r.venueNet['100k']
      if (at.apy !== null)
        expect(at.apy).toBeCloseTo((r.venueApy.withRewards! * r.tvlUsd) / (r.tvlUsd + 1e5), 12)
      // (a) is that figure minus the benchmark.
      if (r.carryA['100k'] && at.apy !== null)
        expect(r.carryA['100k'].apy).toBeCloseTo(at.apy - r.bench['100k']!.apy, 12)
      for (const s of r.venueApy.sources) if (s.status !== 'ok') expect(s.averaged).toBe(false)
    }
  })

  it('ranks on the averaged (a), in order', () => {
    const ranked = file.rows.filter((r) => r.list === 'ranked')
    for (let i = 1; i < ranked.length; i++)
      expect(ranked[i - 1].carryA['100k']!.apy!).toBeGreaterThanOrEqual(
        ranked[i].carryA['100k']!.apy!,
      )
  })
})

describe('rows that are not averaged', () => {
  it('a DeFiLlama-priced row uses DeFiLlama’s two figures, the same as before', () => {
    const p = pool({ project: 'curve-dex' })
    const va = llamaVenueApy(p, T)
    expect(va.method).toBe('defillama')
    close(va.withRewards, 0.076)
    close(va.base, 0.049)
    expect(va.sources.every((s) => s.source === 'defillama' && s.averaged)).toBe(true)
    expect(methodTag(va)).toBe('DeFiLlama')
  })

  it('a lending reserve is priced on-chain; DeFiLlama is listed for reference, not averaged', () => {
    const va = onchainIrmVenueApy(pool({ project: 'aave-v3' }), T, {
      base: 0.041,
      withRewards: 0.043,
      asOf: T - 12,
      address: VAULT,
    })
    expect(va.method).toBe('onchain-irm')
    expect(va.base).toBe(0.041)
    expect(va.sources.filter((s) => s.averaged).map((s) => s.source)).toEqual([
      'onchain-irm',
      'onchain-irm',
    ])
    expect(va.sources.filter((s) => s.source === 'defillama').every((s) => !s.averaged)).toBe(true)
    expect(methodTag(va)).toBe('on-chain')
  })
})

describe('the sources popover opens on hover, focus AND tap', () => {
  const run = (events: PopoverEvent[], from: PopoverState = CLOSED) =>
    events.reduce(popoverReducer, from)

  it('a touch tap (emulated enter + focus + click) opens and pins it; a second tap closes it', () => {
    const tapped = run(['enter', 'focus', 'click'])
    expect(isOpen(tapped)).toBe(true)
    expect(tapped.pinned).toBe(true)
    expect(isOpen(run(['click'], tapped))).toBe(false)
    // iOS Safari does not focus a tapped button: the click alone still opens it.
    expect(isOpen(run(['enter', 'click']))).toBe(true)
    expect(isOpen(run(['click']))).toBe(true)
  })

  it('a tap outside closes it', () => {
    expect(isOpen(run(['enter', 'focus', 'click', 'outside']))).toBe(false)
  })

  it('hover opens it and leaving closes it, unless it was clicked open', () => {
    expect(isOpen(run(['enter']))).toBe(true)
    expect(isOpen(run(['enter', 'leave']))).toBe(false)
    expect(isOpen(run(['enter', 'click', 'leave']))).toBe(true)
  })

  it('keyboard: focus opens it, Escape closes it, focus leaving the cell closes it', () => {
    expect(isOpen(run(['focus']))).toBe(true)
    expect(isOpen(run(['focus', 'escape']))).toBe(false)
    expect(isOpen(run(['focus', 'click', 'blur']))).toBe(false)
  })

  it('a touch pointer is never a hover: one tap opens, the next closes', () => {
    // iOS Safari withholds the click from a tap whose mouseover changed the page, so opening on
    // a touch "hover" made tap 1 open (hover), tap 2 pin (no change) and only tap 3 close.
    expect(hoverEventFor('touch', 'enter')).toBeNull()
    expect(hoverEventFor('touch', 'leave')).toBeNull()
    expect(hoverEventFor('mouse', 'enter')).toBe('enter')
    expect(hoverEventFor('pen', 'leave')).toBe('leave')
    // A tap is then its click alone (iOS focuses no button) or focus + click (Android).
    expect(isOpen(run(['click']))).toBe(true)
    expect(isOpen(run(['click', 'click']))).toBe(false)
    expect(isOpen(run(['focus', 'click', 'click']))).toBe(false)
  })
})

describe('the popover stays on a phone screen', () => {
  it('measures the layout viewport, not window.innerWidth, which the open panel widens', () => {
    // 2026-10-11 refuter, 375×812 emulation: a "Venue net" trigger at x=194 opened a 343px
    // panel at left 177, right 520. The overflow widened the page to 536px, so innerWidth read
    // 536 and the panel moved 16.5px left instead of 177.5px, 145px past the screen edge.
    const w = layoutViewportWidth({
      documentElement: { clientWidth: 375 },
      innerWidth: 536,
      visualViewport: { width: 375 },
    })
    expect(w).toBe(375)
    const dx = panelShiftX({ left: 177, right: 520 }, w)
    expect(177 + dx).toBe(16)
    expect(520 + dx).toBeLessThanOrEqual(375 - 16)
  })

  it('falls back to visualViewport, then innerWidth; a panel that fits does not move', () => {
    expect(
      layoutViewportWidth({
        documentElement: { clientWidth: 0 },
        innerWidth: 536,
        visualViewport: { width: 375 },
      }),
    ).toBe(375)
    expect(layoutViewportWidth({ documentElement: null, innerWidth: 400 })).toBe(400)
    expect(panelShiftX({ left: 20, right: 300 }, 375)).toBe(0)
    expect(panelShiftX({ left: 4, right: 300 }, 375)).toBe(12)
    // Wider than the screen: the left gutter wins.
    expect(panelShiftX({ left: 100, right: 500 }, 375)).toBe(-84)
  })
})

describe('the popover counts what the cell counts', () => {
  it('"avg of 3" in the cell is "3 sources averaged" in the panel, with the figures behind them', () => {
    const va = averagedVenueApy({
      pool: pool(),
      fetchedAt: T,
      morpho: morpho(),
      onchain: { value: 0.0501, asOf: T, address: VAULT },
    })
    expect(methodTag(va)).toBe('avg of 3')
    expect(averagedSummary(va)).toBe('3 sources averaged (5 figures)')
    const one = averagedVenueApy({
      pool: pool({ apy: 4.9, apyReward: null }),
      fetchedAt: T,
      morpho: null,
    })
    expect(methodTag(one)).toBe('avg of 1')
    expect(averagedSummary(one)).toBe('1 source averaged (2 figures)')
  })
})
