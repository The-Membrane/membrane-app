// Oracle registry UI honesty — S5 (2026-10-12, refuter findings on R5). Each test failed on the
// code before the fix unless it is marked (control). Synthetic fixtures, plus the collected data
// in data/oracle-registry (read-only).
//
// (1) Under the "stale" headline the header still printed a green "● N within band" and the
//     cards stayed green from the Oct 5 read. DESIGN_RULES §2 "One state owns the screen",
//     "Calm is ink only"; §4 "Hatch it, never colour it green".
// (2) consensusStaleAt returned false with no clock, and the page's clock was null during SSR
//     (getServerSideProps), so first paint / no-JS / link previews printed the 6-day-old price in
//     full ink. The page now carries the server's clock; no clock is stale (fail closed).
// (3) The headline went stale only when fewer than minMembers members were fresh, so a median
//     over members past their own limit printed in full ink for hours; a reader clock behind the
//     read was clamped to age 0, so a TWAP member counted as fresh. §4 "Suppress the headline
//     while inputs are stale" — read as ANY input (the more conservative reading).
// (4) The hatch was a background fill with padding behind the figure — §6 "no chips behind
//     figures". It is now the stale glyph ░ before the figure.

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import * as vm from '@/components/OracleRegistry/viewModel'
import { consensusHero, consensusStaleAt } from '@/components/OracleRegistry/viewModel'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import type { CardView } from '@/lib/oracleRegistry/apiTypes'
import { getRegistryModel } from '@/lib/oracleRegistry/server'
import type { Freshness } from '@/lib/oracleRegistry/types'
import { buildAssetView, buildIndex, findAssetKey } from '@/lib/oracleRegistry/view'

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

type HeroInput = Parameters<typeof consensusHero>[0]
type Member = Pick<CardView, 'countedInConsensus' | 'freshness'>
const member = (
  ageSeconds: number | null,
  limitSeconds: number | null,
  p: { counted?: boolean; state?: Freshness['state']; basis?: Freshness['basis'] } = {},
): Member => ({
  countedInConsensus: p.counted ?? true,
  freshness: {
    state: p.state ?? (ageSeconds == null ? 'live' : 'fresh'),
    ageSeconds,
    limitSeconds,
    basis: p.basis ?? (ageSeconds == null ? 'live' : 'heartbeat'),
  },
})
const live = () => member(null, null)

// snapshots/latest.json (2026-10-05T23:10:11Z) and the weETH card read on Oct 12 (02:53:47Z)
const SNAP_TS = 1_791_241_811
const OCT12 = 1_791_773_627
const view = (
  cards: Member[],
  o: { status?: 'ok' | 'insufficient'; snapshotTs?: number | null; minMembers?: number } = {},
): HeroInput => ({
  consensus: { status: o.status ?? 'ok', price: 4_512.33, minMembers: o.minMembers ?? 2 },
  cards,
  snapshot: o.snapshotTs === null ? null : { ts: o.snapshotTs ?? SNAP_TS },
})
// ETH's three clocked members at the snapshot (limits left 1,116 s, 71,148 s, 90,972 s), its TWAP
const ETH_CLOCKED = [member(3_084, 4_200), member(18_852, 90_000), member(4_068, 95_040)]
const ETH = [...ETH_CLOCKED, live()]

describe('S5 (3): ANY member past its own limit suppresses the headline', () => {
  it('three clocked members, one 1 s past its limit at +1,117 s: stale (was fresh — 2 of 3 still inside ≥ minMembers 2, until +71,149 s); +1,116 s is not (control)', () => {
    expect(consensusStaleAt(view(ETH_CLOCKED), SNAP_TS + 1_117)).toBe(true)
    expect(consensusStaleAt(view(ETH_CLOCKED), SNAP_TS + 1_116)).toBe(false)
  })

  it('"limit" is each member\'s own: a pull feed past its 3,600 s, an age-only feed past 90,000 s, a view past its binding leg (each was fresh while two others stayed inside)', () => {
    const two = [member(10, 95_040), member(10, 95_040)]
    const pull = member(3_000, 3_600, { basis: 'pull' })
    const ageOnly = member(89_000, 90_000, { basis: 'age_only' })
    const view_ = member(4_000, 4_200, { basis: 'components' })
    expect(consensusStaleAt(view([...two, pull]), SNAP_TS + 601)).toBe(true)
    expect(consensusStaleAt(view([...two, ageOnly]), SNAP_TS + 1_001)).toBe(true)
    expect(consensusStaleAt(view([...two, view_]), SNAP_TS + 201)).toBe(true)
    // (control) each exactly at its limit is still inside (the policy is "> limit")
    expect(consensusStaleAt(view([...two, pull]), SNAP_TS + 600)).toBe(false)
    expect(consensusStaleAt(view([...two, ageOnly]), SNAP_TS + 1_000)).toBe(false)
    expect(consensusStaleAt(view([...two, view_]), SNAP_TS + 200)).toBe(false)
  })

  it('a member with no update clock (TWAP) vouches only at the read: ETH 1 s after it is stale (was fresh until +71,149 s)', () => {
    expect(consensusStaleAt(view(ETH), SNAP_TS + 1)).toBe(true)
    expect(consensusStaleAt(view(ETH), SNAP_TS)).toBe(false) // (control)
  })

  it('a reader clock behind the read is an unknown age, not a fresh one (was clamped to age 0 — the TWAP counted fresh)', () => {
    expect(consensusStaleAt(view(ETH), SNAP_TS - 30)).toBe(true)
    expect(consensusStaleAt(view(ETH_CLOCKED), SNAP_TS - 1)).toBe(true)
  })

  it('a counted member in any state but fresh / live never keeps the median current (fail closed)', () => {
    const two = [member(10, 95_040), member(10, 95_040)]
    expect(consensusStaleAt(view([...two, member(10, 4_200, { state: 'unknown' })]), SNAP_TS)).toBe(
      true,
    )
    expect(
      consensusStaleAt(view([...two, member(5_000, 4_200, { state: 'stale' })]), SNAP_TS),
    ).toBe(true)
    // (control) uncounted members are not judged
    expect(
      consensusStaleAt(
        view([...two, member(5_000, 4_200, { state: 'stale', counted: false })]),
        SNAP_TS,
      ),
    ).toBe(false)
  })
})

describe('S5 (2): the server render judges staleness at the server clock', () => {
  it('no clock is stale, never full ink (was "$4,512.33" in full ink with now null)', () => {
    expect(consensusStaleAt(view(ETH_CLOCKED), null)).toBe(true)
    expect(consensusHero(view(ETH_CLOCKED), null)).toMatchObject({ text: 'stale', muted: true })
  })

  it('getServerSideProps passes the server clock on all three props paths (was no clock in the props)', () => {
    // A source pin: vitest cannot transform the page's JSX (tsconfig jsx: preserve).
    const page = src('pages/[chain]/oracles.tsx')
    expect(page).toMatch(/serverNow: number\n/)
    expect(page).toMatch(/const serverNow = Math\.floor\(Date\.now\(\) \/ 1000\)/)
    // config-only subject, oracle asset, and the error fallback
    const gssp = page.slice(
      page.indexOf('export const getServerSideProps'),
      page.indexOf('export default function'),
    )
    expect(gssp.match(/^\s+serverNow,$/gm)?.length).toBe(3)
    expect(page).toMatch(/serverNow=\{serverNow\}/)
  })

  it('the page clock starts at the server clock, so hydration renders what the server rendered (was useState(null))', () => {
    const r = src('components/OracleRegistry/OracleRegistry.tsx')
    expect(r).toMatch(/useState<number \| null>\(initial\)/)
    expect(r).toMatch(/useNowSeconds\(serverNow\)/)
    expect(src('pages/[chain]/oracles.tsx')).toMatch(/serverNow=\{serverNow\}/)
  })
})

describe('S5 (1): while the consensus is not current, no green anywhere on the screen', () => {
  it('colourToken draws green in the stale ink under calm ink (was COLOUR_META.green.token, green, everywhere)', () => {
    expect(vm.colourToken?.('green', true)).toBe(SEMANTIC_COLORS.textTertiary)
    // (control) a current screen keeps green; red and gold warnings are never inked
    expect(vm.colourToken?.('green', false)).toBe(SEMANTIC_COLORS.success)
    expect(vm.colourToken?.('red', true)).toBe(SEMANTIC_COLORS.danger)
    expect(vm.colourToken?.('gold', true)).toBe(SEMANTIC_COLORS.warning)
  })

  it('calmInkAt: weETH seen Oct 12, no clock, or no consensus → ink; current → green (control)', () => {
    expect(vm.calmInkAt?.(view(ETH_CLOCKED), OCT12)).toBe(true)
    expect(vm.calmInkAt?.(view(ETH_CLOCKED), null)).toBe(true)
    expect(vm.calmInkAt?.(view(ETH_CLOCKED, { status: 'insufficient' }), SNAP_TS)).toBe(true)
    expect(vm.calmInkAt?.(view(ETH_CLOCKED), SNAP_TS + 1_116)).toBe(false)
  })

  it('an asset tab is green only inside its index freshWindow; no window → ink (fail closed)', () => {
    const tab = (freshWindow?: { from: number; until: number } | null) => ({
      consensus: { status: 'ok' as const, freshWindow },
    })
    const w = { from: SNAP_TS, until: SNAP_TS + 1_116 }
    expect(vm.summaryCalmInkAt?.(tab(w), SNAP_TS + 1_117)).toBe(true)
    expect(vm.summaryCalmInkAt?.(tab(w), SNAP_TS - 1)).toBe(true)
    expect(vm.summaryCalmInkAt?.(tab(null), SNAP_TS)).toBe(true)
    expect(vm.summaryCalmInkAt?.(tab(undefined), SNAP_TS)).toBe(true)
    expect(vm.summaryCalmInkAt?.(tab(w), null)).toBe(true)
    expect(vm.summaryCalmInkAt?.(tab(w), SNAP_TS + 1_116)).toBe(false) // (control)
  })

  it('the collected data seen on Oct 12: every tab and the weETH panel draw calm in ink (was green ● on every calm tab and card)', () => {
    const model = getRegistryModel()
    const index = buildIndex(model)
    const ok = index.assets.filter((a) => a.consensus.status === 'ok')
    expect(ok.length).toBeGreaterThan(0)
    for (const a of ok) {
      expect(a.consensus.freshWindow ?? null, a.key).not.toBeNull()
      expect(vm.summaryCalmInkAt?.(a, OCT12), a.key).toBe(true)
    }
    const key = findAssetKey(model.inputs.catalog, 'weeth')
    expect(key).toBeTruthy()
    const weeth = buildAssetView(model, key as string)
    if (!weeth) throw new Error('no weETH view')
    expect(weeth.consensus.status).toBe('ok')
    expect(vm.calmInkAt?.(weeth, OCT12)).toBe(true)
    // (control) the index window and the panel judge by one rule: same window, same verdict
    const w = index.assets.find((a) => a.key === key)?.consensus.freshWindow
    if (!w) throw new Error('no weETH freshWindow in the index')
    expect(vm.calmInkAt?.(weeth, w.until)).toBe(false)
    expect(vm.calmInkAt?.(weeth, w.until + 1)).toBe(true)
  })

  it('every green on the screen goes through colourToken(…, calmInk) (was COLOUR_META[…].token in the header, cards, strip, basis bar and tabs)', () => {
    const header = src('components/OracleRegistry/ConsensusHeader.tsx')
    expect(header).toMatch(/calmInkAt\(view, now\)/)
    expect(header).toMatch(/token: colourToken\(colour, calmInk\)/)
    const card = src('components/OracleRegistry/OracleCard.tsx')
    expect(card).toMatch(/colourToken\(card\.colour, calmInk\)/)
    expect(card).not.toMatch(/meta\.token/)
    expect(card).toMatch(/calmInk=\{calmInk\}/)
    expect(src('components/OracleRegistry/Sparkline.tsx')).not.toMatch(/COLOUR_META/)
    expect(src('components/OracleRegistry/BasisBar.tsx')).toMatch(/colourToken\(colour, calmInk\)/)
    const tabs = src('components/OracleRegistry/AssetTabs.tsx')
    expect(tabs).toMatch(/summaryCalmInkAt\(a\.oracle, now\)/)
    expect(tabs).not.toMatch(/COLOUR_META\[m\.colour\]\.token/)
    // the selected tab's underline was SEMANTIC_COLORS.primary (--m-primary = the --m-success green)
    expect(tabs).not.toMatch(/SEMANTIC_COLORS\.primary/)
    expect(src('components/OracleRegistry/OracleRegistry.tsx')).toMatch(
      /calmInk = view \? calmInkAt\(view, now\) : true/,
    )
  })
})

describe('S5 (4): the stale price is hatched with the stale glyph, nothing drawn behind it', () => {
  it('no background fill or padding behind the figure; ░ before it in muted ink (was px="3px" bgImage={STALE_HATCH})', () => {
    const h = src('components/OracleRegistry/ConsensusHeader.tsx')
    expect(h).not.toMatch(/bgImage/)
    expect(h).not.toMatch(/repeating-linear-gradient/)
    expect(h).toMatch(/\{STALE_HATCH_GLYPH\}/)
    expect(vm.STALE_HATCH_GLYPH).toBe('░')
    expect(vm.STALE_HATCH_GLYPH).toBe(vm.COLOUR_META.stale.glyph)
  })
})
