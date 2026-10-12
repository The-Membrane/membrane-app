// Oracle registry UI honesty — R5 (2026-10-12, review of round 2). Each test failed on the code
// before the fix unless it is marked (control). Synthetic fixtures.
//
// (c) ConsensusHeader printed the 44px consensus price in full ink however old the snapshot was.
//     data/oracle-registry/snapshots/latest.json was read 2026-10-05T23:10:11Z, so on Oct 12 every
//     asset's hero was a 6-day-old median whose every clocked member was past its own limit.
//     DESIGN_RULES §4 (stale data): "Hatch it", "Suppress the headline while inputs are stale",
//     "Show input ages in the dateline". The threshold is the catalog's own staleness policy
//     ("stale when now − updatedAt > heartbeatSeconds + grace", and a stale entry "never counts
//     toward consensus") judged at the reader's clock: the headline is stale once fewer than
//     `minMembers` of the members that formed it are still inside their own limit.
// (d) `authority_unread` (F1) had no TAG_LABEL entry, so a quiet "authority unread" word printed
//     beside the loud READ GAP chip on the same row — one fact twice (DESIGN_RULES §3).

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { batchLoudChips, rowNoteLine, tagChips } from '@/components/OracleRegistry/configViewModel'
import { consensusHero, consensusStaleAt } from '@/components/OracleRegistry/viewModel'
import type { CardView } from '@/lib/oracleRegistry/apiTypes'
import type { Freshness } from '@/lib/oracleRegistry/types'

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

type HeroInput = Parameters<typeof consensusHero>[0]
const member = (
  ageSeconds: number | null,
  limitSeconds: number | null,
  p: Partial<Pick<CardView, 'countedInConsensus'>> & { state?: Freshness['state'] } = {},
): Pick<CardView, 'countedInConsensus' | 'freshness'> => ({
  countedInConsensus: p.countedInConsensus ?? true,
  freshness: {
    state: p.state ?? (ageSeconds == null ? 'live' : 'fresh'),
    ageSeconds,
    limitSeconds,
    basis: ageSeconds == null ? 'live' : 'heartbeat',
  },
})
const live = () => member(null, null)

// snapshots/latest.json (2026-10-05T23:10:11Z) and the weETH card read on Oct 12 (02:53:47Z)
const SNAP_TS = 1_791_241_811
const OCT12 = 1_791_773_627
const view = (
  cards: Pick<CardView, 'countedInConsensus' | 'freshness'>[],
  o: { price?: number; status?: 'ok' | 'insufficient'; snapshotTs?: number | null } = {},
): HeroInput => ({
  consensus: { status: o.status ?? 'ok', price: o.price ?? 4_512.33, minMembers: 2 },
  cards,
  snapshot: o.snapshotTs === null ? null : { ts: o.snapshotTs ?? SNAP_TS },
})
// the weETH members at that snapshot (buildAssetView, 2026-10-12): three clocked, one TWAP
const WEETH = [member(66_960, 95_040), member(37_920, 95_040), member(18_840, 90_000), live()]
// ETH: limits left at the snapshot 1,116 s, 71,148 s and 90,972 s
const ETH = [member(3_084, 4_200), member(18_852, 90_000), member(4_068, 95_040), live()]

describe('R5 (c): the consensus headline is suppressed and hatched while its inputs are stale', () => {
  it('weETH, read Oct 5 23:10 and seen Oct 12: "stale" in muted ink, the price hatched off the headline (was "$4,512.33" at 44px in full ink)', () => {
    expect(consensusHero(view(WEETH), OCT12)).toEqual({
      text: 'stale',
      muted: true,
      hatchedPrice: '$4,512.33',
      aria: 'Consensus stale: $4,512.33 when read',
    })
  })

  it('stale once fewer than minMembers members are inside their own limit — ETH at 71,149 s (was fresh at any age); 71,148 s is not (control)', () => {
    expect(consensusStaleAt(view(ETH), SNAP_TS + 71_149)).toBe(true)
    expect(consensusStaleAt(view(ETH), SNAP_TS + 71_148)).toBe(false)
    expect(consensusHero(view(ETH), SNAP_TS + 71_148)).toEqual({
      text: '$4,512.33',
      muted: false,
      hatchedPrice: null,
      aria: 'Consensus $4,512.33',
    })
  })

  it('a member with no update clock (TWAP) never vouches past the read; at the read it counts (control)', () => {
    const twaps = view([live(), live(), member(0, 4_200)])
    expect(consensusStaleAt(twaps, SNAP_TS + 60)).toBe(true)
    expect(consensusStaleAt(twaps, SNAP_TS)).toBe(false)
  })

  it('an unknown age or limit never keeps the headline fresh (fail closed)', () => {
    expect(
      consensusStaleAt(
        view([member(10, 4_200), member(null, 4_200, { state: 'fresh' })]),
        SNAP_TS + 1,
      ),
    ).toBe(true)
    expect(consensusStaleAt(view([member(10, 4_200), member(10, null)]), SNAP_TS + 1)).toBe(true)
    // (control) both inside their limits
    expect(consensusStaleAt(view([member(10, 4_200), member(10, 4_200)]), SNAP_TS + 1)).toBe(false)
  })

  it('members not counted in the median do not keep it fresh', () => {
    const v = view([
      member(10, 4_200),
      member(10, 95_040, { countedInConsensus: false }),
      member(10, 95_040),
    ])
    expect(consensusStaleAt(v, SNAP_TS + 5_000)).toBe(true)
    expect(consensusStaleAt(v, SNAP_TS + 4_190)).toBe(false)
  })

  it('(control) no clock yet (server render), no consensus, or no snapshot: not judged stale', () => {
    expect(consensusHero(view(WEETH), null).text).toBe('$4,512.33')
    expect(consensusHero(view(WEETH, { status: 'insufficient' }), OCT12)).toEqual({
      text: 'no consensus',
      muted: true,
      hatchedPrice: null,
      aria: 'No consensus',
    })
    expect(consensusStaleAt(view(WEETH, { snapshotTs: null }), OCT12)).toBe(false)
  })

  it('the header renders its hero from consensusHero, hatches the stale price, and keeps the input ages in the dateline (was its own full-ink ternary)', () => {
    const h = src('components/OracleRegistry/ConsensusHeader.tsx')
    expect(h).toMatch(/consensusHero\(view, now\)/)
    expect(h).toMatch(/hero\.hatchedPrice/)
    expect(h).toMatch(/repeating-linear-gradient/)
    expect(h).not.toMatch(/color=\{ok \? SEMANTIC_COLORS\.textPrimary/)
    // (control) the dateline still carries the input ages
    expect(h).toMatch(/k="Last update"/)
    expect(h).toMatch(/fmtDuration\(snapAge\)/)
  })
})

describe('R5 (d): `authority_unread` is not printed beside READ GAP', () => {
  it('no chip for it (was a quiet "authority unread" chip beside READ GAP)', () => {
    expect(tagChips(['read_gap', 'authority_unread'])).toEqual([
      { label: 'READ GAP', loud: true, tone: 'warning' },
    ])
  })

  it('no word for it in the note line (was "authority unread · …")', () => {
    expect(
      rowNoteLine(['read_gap', 'authority_unread'], ['upgrade holders not read at block 1']),
    ).toBe('upgrade holders not read at block 1')
  })

  it('(control) READ GAP still shouts, and an unlabelled tag still prints as a quiet word', () => {
    expect(
      batchLoudChips([{ tags: ['authority_unread', 'read_gap'] }]).map((c) => c.label),
    ).toEqual(['READ GAP'])
    expect(rowNoteLine(['not_simulated'], [])).toBe('not simulated')
  })
})
