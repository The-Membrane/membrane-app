import { describe, expect, it } from 'vitest'

import { buildHolderView, curatedVaults, CUT_KINDS, isCut, WEEK_S } from '@/lib/curatorFeed/holder'
import type { FeedFile } from '@/lib/curatorFeed/store'
import type { ActionKind, Entities, FeedAction, Scope } from '@/lib/curatorFeed/types'
import { CURATORS_COPY, curatorsHeadline, curatorsView, dayMonth, MAX_DOTS, MAX_VAULT_ROWS } from '@/components/Today/curatorsView'
import type { HolderResponse } from '@/pages/api/curator-feed/holder'

// ── fixture: three curated vaults, one Aave configurator, a week of actions ─────

const STEAK = '0xbeef01735c132ada46aa9aa4c54623caa92a64cb'
const GAUNT = '0x2371e134e3455e0593363cbf89d3b6cf53740618'
const OTHER = '0x1111111111111111111111111111111111111111'
const AAVE = '0x64b761d848206f447fe2dd461b0c635ec39ebb27'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const WSTETH = '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0'
const id = (n: number) => '0x' + n.toString(16).padStart(64, '0')
const M1 = id(1)
const M2 = id(2)
const M3 = id(3)
const TO = 1_791_741_143

const entities: Entities = {
  tokens: {
    [USDC]: { symbol: 'USDC', decimals: 6 },
    [WETH]: { symbol: 'WETH', decimals: 18 },
    [WSTETH]: { symbol: 'wstETH', decimals: 18 },
  },
  markets: {
    [M1]: { loan: USDC, collateral: WETH, oracle: OTHER, irm: OTHER, lltv: '860000000000000000' },
    [M2]: { loan: USDC, collateral: WSTETH, oracle: OTHER, irm: OTHER, lltv: '860000000000000000' },
    [M3]: { loan: WETH, collateral: WSTETH, oracle: OTHER, irm: OTHER, lltv: '965000000000000000' },
  },
  vaults: {
    [STEAK]: { protocol: 'morpho-v1', name: 'Steakhouse USDC', asset: USDC, curatorKey: 'steak' },
    [GAUNT]: { protocol: 'morpho-v1', name: 'Gauntlet WETH Prime', asset: WETH, curatorKey: 'gauntlet' },
    [OTHER]: { protocol: 'morpho-v2', name: 'Other Vault', asset: USDC, curatorKey: 'other' },
  },
  curators: {
    steak: { name: 'Steakhouse Financial', source: 'morpho-api' },
    gauntlet: { name: 'Gauntlet', source: 'morpho-api' },
    other: { name: 'Other', source: 'morpho-api' },
  },
  strategies: {},
  aaveMarkets: { [AAVE]: 'Aave v3 Core' },
  v2Ids: {},
}

let seq = 0
const act = (
  vault: string,
  kind: ActionKind,
  ageS: number,
  target?: string,
  scope: Scope = 'market',
  protocol: FeedAction['protocol'] = 'morpho-v1',
): FeedAction => {
  seq++
  const tx = '0x' + seq.toString(16).padStart(64, 'a')
  return {
    id: `${tx}:${seq}`,
    protocol,
    vault,
    kind,
    scope,
    target,
    collateral: [],
    from: '100',
    to: '0',
    block: 1_000_000 - ageS,
    ts: TO - ageS,
    tx,
  }
}

const H = 3600
const actions: FeedAction[] = [
  // Steakhouse: a cap cut and a raise on M1, a raise on M2, a timelock change (vault-wide).
  act(STEAK, 'cap_cut', 2 * H, M1),
  act(STEAK, 'cap_raise', 5 * H, M1),
  act(STEAK, 'cap_raise', 30 * H, M2),
  act(STEAK, 'timelock_set', 40 * H, undefined, 'vault'),
  // Gauntlet: a supply-queue removal (a cut) on M3.
  act(GAUNT, 'supply_queue_remove', 3 * H, M3),
  // Outside the week (8 days before the newest block): never counted.
  act(GAUNT, 'cap_zero', 8 * 24 * H, M3),
  // Exactly at the window's opening edge (excluded: the window is (to − 7d, to]).
  act(GAUNT, 'cap_zero', WEEK_S, M3),
  // A vault the reader does not hold, on the same market: never counted.
  act(OTHER, 'cap_zero', 1 * H, M1, 'market', 'morpho-v2'),
  // Aave governance: not a curated vault.
  act(AAVE, 'freeze', 1 * H, USDC, 'reserve', 'aave-v3'),
]

const feed: Pick<FeedFile, 'entities' | 'actions' | 'meta'> = {
  entities,
  actions,
  meta: { toTs: TO, collectedAt: '2026-10-11T18:05:47.554Z' } as FeedFile['meta'],
}

// ── the filter ──────────────────────────────────────────────────────────────────

describe('buildHolderView: filtered to the reader’s own vaults', () => {
  it('returns null when the address holds no curated vault (the block prints nothing)', () => {
    expect(buildHolderView(feed, [])).toBeNull()
    // An Aave configurator, or an address the feed does not know, is not a curated vault.
    expect(buildHolderView(feed, [AAVE, '0x9999999999999999999999999999999999999999'])).toBeNull()
  })

  it('counts only actions emitted by held vaults inside (to − 7d, to]', () => {
    const v = buildHolderView(feed, [STEAK, GAUNT])!
    expect(v.held).toBe(2)
    expect(v.from).toBe(TO - WEEK_S)
    expect(v.to).toBe(TO)
    // 4 Steakhouse + 1 Gauntlet; the 8-day-old cut, the edge cut, the other vault's cut
    // on M1 and the Aave freeze are excluded.
    expect(v.changes).toBe(5)
    expect(v.cuts).toBe(2)
  })

  it('matches addresses case-insensitively (the chain read returns checksummed input)', () => {
    const v = buildHolderView(feed, [STEAK.toUpperCase().replace('0X', '0x')])!
    expect(v.held).toBe(1)
    expect(v.changes).toBe(4)
  })

  it('groups by vault: one dot per market touched, a cut wins, vault-wide set apart', () => {
    const v = buildHolderView(feed, [STEAK, GAUNT])!
    expect(v.vaults.map((x) => x.vaultName)).toEqual(['Steakhouse USDC', 'Gauntlet WETH Prime'])
    const steak = v.vaults[0]
    expect(steak.curatorName).toBe('Steakhouse Financial')
    expect(steak.targets.map((t) => [t.target, t.cut, t.changes])).toEqual([
      [M1, true, 2],
      [M2, false, 1],
    ])
    expect(steak.vaultWide).toBe(1)
    expect(steak.cuts).toBe(1)
    expect(v.vaults[1].targets).toEqual([
      expect.objectContaining({ target: M3, cut: true, changes: 1, name: expect.stringContaining('wstETH/WETH') }),
    ])
  })

  it('lists the latest three, newest first, with cut flags', () => {
    const v = buildHolderView(feed, [STEAK, GAUNT])!
    expect(v.latest).toHaveLength(3)
    expect(v.latest.map((l) => [l.vaultName, l.cut])).toEqual([
      ['Steakhouse USDC', true],
      ['Gauntlet WETH Prime', true],
      ['Steakhouse USDC', false],
    ])
    expect(v.latest[0].ts).toBe(TO - 2 * H)
  })

  it('a held vault with nothing this week: held, zero changes, no rows', () => {
    const quiet = { ...feed, actions: actions.filter((a) => a.vault !== GAUNT || a.ts < TO - WEEK_S) }
    const v = buildHolderView(quiet, [GAUNT])!
    expect(v).not.toBeNull()
    expect(v.held).toBe(1)
    expect(v.changes).toBe(0)
    expect(v.vaults).toEqual([])
  })

  it('curatedVaults lists every MetaMorpho / Vault V2 / Euler Earn vault the feed knows', () => {
    expect(curatedVaults(feed)).toEqual([OTHER, GAUNT, STEAK].sort())
  })

  it('a cut is a cap cut or an exit, never a raise, add or config change', () => {
    for (const k of ['cap_cut', 'cap_zero', 'removal_submit', 'market_removed', 'supply_queue_remove'] as const)
      expect(isCut({ kind: k })).toBe(true)
    for (const k of ['cap_raise', 'cap_submit', 'market_added', 'supply_queue_add', 'timelock_set'] as const)
      expect(isCut({ kind: k })).toBe(false)
    expect(CUT_KINDS.has('freeze')).toBe(false)
  })
})

// ── the Today module's words ──────────────────────────────────────────────────

const NOW = Date.parse('2026-10-18T12:00:00Z')
const response = (held: string[], f = feed): HolderResponse => ({
  address: '0x9fC3dc011b461664c835F2527fffb1169b3C213e',
  readAt: '2026-10-18T11:58:00.000Z',
  view: buildHolderView(f, held),
})

describe('curatorsView', () => {
  it('prints nothing while loading and for an address with no curated vault', () => {
    expect(curatorsView({ data: undefined, error: false, nowMs: NOW }).state).toBe('hidden')
    expect(curatorsView({ data: response([]), error: false, nowMs: NOW }).state).toBe('hidden')
  })

  it('says so when the read fails (never silence that looks like all-clear)', () => {
    expect(curatorsView({ data: undefined, error: true, nowMs: NOW })).toEqual({
      state: 'unavailable',
      headline: CURATORS_COPY.unavailable,
    })
  })

  it('the no-change line when held vaults had nothing this week', () => {
    const quiet = { ...feed, actions: [] }
    const v = curatorsView({ data: response([GAUNT], quiet), error: false, nowMs: NOW })
    expect(v.state).toBe('none')
    if (v.state !== 'none') return
    expect(v.headline).toBe('No changes by your curators this week')
    expect(v.rows).toEqual([])
    expect(v.credit).toBe('7 days to 11 Oct 17:52 UTC · curator feed · 1 vault held, read 11:58 UTC')
  })

  it('the changes line, dot rows and dated latest list', () => {
    const v = curatorsView({ data: response([STEAK, GAUNT]), error: false, nowMs: NOW })
    expect(v.state).toBe('changes')
    if (v.state !== 'changes') return
    expect(v.headline).toBe('5 changes by the curators of the vaults you hold · 2 were cuts')
    expect(v.rows[0].summary).toBe('2 markets · 1 cut · 1 vault setting')
    expect(v.rows[0].dots.map((d) => d.cut)).toEqual([true, false])
    expect(v.rows[0].dots[0].label).toMatch(/· cut · 2 changes$/)
    expect(v.latest.map((l) => l.date)).toEqual(['11 Oct', '11 Oct', '11 Oct'])
    expect(new Set(v.latest.map((l) => l.key)).size).toBe(3)
    expect(v.moreVaults).toBeNull()
  })

  it('headline grammar', () => {
    expect(curatorsHeadline(0, 0)).toBe(CURATORS_COPY.none)
    expect(curatorsHeadline(1, 0)).toBe('1 change by the curators of the vaults you hold · none were cuts')
    expect(curatorsHeadline(3, 1)).toBe('3 changes by the curators of the vaults you hold · 1 was a cut')
  })

  it('folds dots past MAX_DOTS into +n', () => {
    const many = Array.from({ length: MAX_DOTS + 5 }, (_, i) => act(STEAK, 'cap_raise', H + i, id(100 + i)))
    const v = curatorsView({ data: response([STEAK], { ...feed, actions: many }), error: false, nowMs: NOW })
    if (v.state !== 'changes') throw new Error(v.state)
    expect(v.rows[0].dots).toHaveLength(MAX_DOTS)
    expect(v.rows[0].more).toBe(5)
  })

  it('folds vault rows past MAX_VAULT_ROWS into one line', () => {
    const n = MAX_VAULT_ROWS + 2
    const vaults = Object.fromEntries(
      Array.from({ length: n }, (_, i) => [
        '0x' + (0xa0 + i).toString(16).padStart(40, '0'),
        { protocol: 'morpho-v1' as const, name: `Vault ${i}`, asset: USDC, curatorKey: 'steak' },
      ]),
    )
    const many = { ...feed, entities: { ...entities, vaults }, actions: Object.keys(vaults).map((v) => act(v, 'cap_raise', H, M1)) }
    const v = curatorsView({ data: response(Object.keys(vaults), many), error: false, nowMs: NOW })
    if (v.state !== 'changes') throw new Error(v.state)
    expect(v.rows).toHaveLength(MAX_VAULT_ROWS)
    expect(v.moreVaults).toBe('+2 more vaults with changes')
  })

  it('dayMonth is UTC', () => {
    expect(dayMonth(Date.parse('2026-10-06T23:30:00Z') / 1000)).toBe('6 Oct')
  })
})
