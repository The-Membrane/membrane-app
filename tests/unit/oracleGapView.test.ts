import { describe, expect, it } from 'vitest'

import {
  ADDRESS_HINT,
  cardTag,
  commitTyped,
  pickCards,
  viewerOf,
  type PickMarket,
} from '@/components/CuratorFeed/oracleGapView'
import type { Relation } from '@/lib/exposure'

// §07's view logic (components/CuratorFeed/oracleGapView.ts): whose address is read,
// which cards show, what tag each carries.

const A = '0x1eB1994C6de521686f5B97B017fF6AFAB81FF2bb' // wagmi gives checksummed addresses
const B = '0x000000000000000000000000000000000000dEaD'
const id = (i: number) => `0x${i.toString(16).padStart(64, '0')}`

describe('whose address is read', () => {
  it('follows the connected wallet across a switch', () => {
    expect(viewerOf(undefined, null)).toEqual({ address: null, fromWallet: false, error: null })
    expect(viewerOf(A, null)).toEqual({ address: A.toLowerCase(), fromWallet: true, error: null })
    // Switch A → B: B is read, never A's ties.
    expect(viewerOf(B, null).address).toBe(B.toLowerCase())
    // Disconnect: nothing read.
    expect(viewerOf(undefined, null).address).toBeNull()
  })

  it('a typed address wins over the wallet, through a switch; clearing goes back to the wallet', () => {
    const typed = commitTyped(` ${B.toLowerCase()} `)
    expect(typed).toEqual({ address: B.toLowerCase(), error: null })
    expect(viewerOf(A, typed)).toEqual({ address: B.toLowerCase(), fromWallet: false, error: null })
    expect(viewerOf('0x' + '1'.repeat(40), typed).address).toBe(B.toLowerCase())
    expect(commitTyped('   ')).toBeNull()
    expect(viewerOf(A, commitTyped('')).address).toBe(A.toLowerCase())
  })

  it('an invalid entry reads no address (the last highlights clear) and says why', () => {
    for (const bad of ['0x123', 'vitalik.eth', '0x1eb1994C6de521686f5B97B017fF6AFAB81FF2bb']) {
      const t = commitTyped(bad)
      expect(t).toEqual({ address: null, error: ADDRESS_HINT })
      expect(viewerOf(A, t)).toEqual({ address: null, fromWallet: false, error: ADDRESS_HINT })
    }
  })
})

const rel = (o: Partial<Relation> = {}): Relation => ({
  kind: 'via-vault',
  roles: ['vault'],
  path: ['0x' + '1'.repeat(40)],
  vaultNames: ['Alpha USDC'],
  book: false,
  ...o,
})

const mkt = (
  i: number,
  o: { usd?: number; state?: PickMarket['i3']['state']; relation?: Relation } = {},
): PickMarket => ({
  market: id(i),
  curatedUsd: o.usd ?? 5_000_000,
  ...(o.relation ? { relation: o.relation } : {}),
  i3: { state: o.state ?? 'below', hoursAboveConsecutive: o.state === 'building' ? 3 : 0 },
})

describe('a card’s tag', () => {
  it('live, snapshot (as of), dust, and ░ unchecked when the read could not say', () => {
    const none = new Set<string>()
    expect(cardTag(mkt(1), none)).toBeUndefined()
    expect(cardTag(mkt(1), new Set([id(1)]))).toEqual({ text: '░ unchecked', style: 'unchecked' })
    expect(cardTag(mkt(1, { relation: rel() }), none)).toEqual({
      text: 'your vault Alpha USDC',
      style: 'live',
    })
    expect(cardTag(mkt(1, { relation: rel({ asOf: 1_791_500_000 }) }), none)).toEqual({
      text: `your vault Alpha USDC · as of ${new Date(1_791_500_000_000).toISOString().slice(0, 10)}`,
      style: 'snapshot',
    })
    expect(cardTag(mkt(1, { relation: rel({ vaultUsd: 0.4, dustBelow: 1 }) }), none)).toEqual({
      text: 'your vault Alpha USDC · supplies under $1',
      style: 'dust',
    })
    // A known tie outranks "unchecked" (a direct position read while a vault read failed).
    expect(cardTag(mkt(1, { relation: rel() }), new Set([id(1)]))!.style).toBe('live')
  })
})

describe('which cards show', () => {
  const base = { stale: false, all: false, minUsd: 1, unchecked: new Set<string>() }
  const markets = [
    mkt(1, { state: 'building' }), // above the line
    mkt(2, { relation: rel() }), // yours, below the line
    mkt(3, { relation: rel({ asOf: 1 }) }), // yours as of the snapshot
    mkt(4, { usd: 0.2, relation: rel({ usd: 0.3, dustBelow: 1 }) }), // a dust tie, no curated $
    mkt(5), // below, not yours
    mkt(6, { usd: 0.5, state: 'building' }), // above, under $1 curated
  ]

  it('no viewer: the markets above the line, under-$1 ones folded', () => {
    const p = pickCards({ ...base, markets, hasViewer: false, only: false })
    expect(p.held.map((m) => m.market)).toEqual([id(1)])
    expect(p.unheld.map((m) => m.market)).toEqual([id(6)])
    expect(p.mine).toBe(2)
  })

  it('highlight: yours lifted into the grid; a dust tie is not lifted', () => {
    const p = pickCards({ ...base, markets, hasViewer: true, only: false })
    expect(p.held.map((m) => m.market)).toEqual([id(1), id(2), id(3)])
    expect(p.unheld.map((m) => m.market)).toEqual([id(6)])
    expect(p.unchecked).toEqual([])
  })

  it('only mine: every tie, dust under the fold; unchecked markets kept behind their own fold', () => {
    const unchecked = new Set([id(5), id(2)])
    const p = pickCards({ ...base, unchecked, markets, hasViewer: true, only: true })
    expect(p.held.map((m) => m.market)).toEqual([id(2), id(3)])
    expect(p.unheld.map((m) => m.market)).toEqual([id(4)])
    // id(2) has a tie, so it is not "unchecked"; id(5) is.
    expect(p.unchecked.map((m) => m.market)).toEqual([id(5)])
    expect(p.uncheckedCount).toBe(1)
    expect(p.mine).toBe(2)
  })

  it('only mine: a dust tie sits under the fold even where the market’s curated supply is ≥ $1', () => {
    // The LBTC / TSLAon / FLHYon case: other vaults supply millions, yours supplies < $1.
    const withDust = [
      mkt(2, { relation: rel() }),
      mkt(7, { usd: 5_000_000, relation: rel({ vaultUsd: 0.2, dustBelow: 1 }) }),
      mkt(8, { usd: 5_000_000, state: 'building', relation: rel({ vaultUsd: 0.1, dustBelow: 1 }) }),
    ]
    const only = pickCards({ ...base, markets: withDust, hasViewer: true, only: true })
    expect(only.held.map((m) => m.market)).toEqual([id(2)])
    expect(only.unheld.map((m) => m.market)).toEqual([id(7), id(8)])
    expect(only.mine).toBe(1)
    // Highlight: the fold stays the market's, so an above-the-line market with a dust tie
    // is still a grid card (with its "supplies under $1" tag); the dust tie is not lifted.
    const hl = pickCards({ ...base, markets: withDust, hasViewer: true, only: false })
    expect(hl.held.map((m) => m.market)).toEqual([id(2), id(8)])
    expect(hl.unheld).toEqual([])
  })

  it('stale: the markets that were above the line at their last point', () => {
    const p = pickCards({
      ...base,
      stale: true,
      markets: [{ ...mkt(1), i3: { state: 'stale', hoursAboveConsecutive: 5 } }, mkt(2)],
      hasViewer: false,
      only: false,
    })
    expect(p.above.map((m) => m.market)).toEqual([id(1)])
  })
})
