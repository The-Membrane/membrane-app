import { describe, expect, it } from 'vitest'

import {
  composeRecap,
  deltaSummary,
  flowToBeats,
  rankPhrase,
  type AddressFlow,
  type RecapInputs,
} from '@/components/Radar/recapLogic'
import type { Entry as VenueLogEntry } from '@/components/Carry/venueLogLogic'

// A recorded corpus + chain-log fixture (shapes the recap route hands in).
const susdeExit = (over: Partial<AddressFlow> = {}): AddressFlow => ({
  venue: 'sUSDe',
  label: 'sUSDe',
  direction: 'withdraw',
  at: '2026-06-01T12:00:00.000Z',
  usd: 1_938_219,
  txHash: '0x5f7422b6ff',
  cooldownSecondsAtEvent: 86_400, // 1-day gate recorded at that block
  dayOutflowUsd: 70_191_284,
  dayRank: 3,
  dayRankTotal: 91,
  ...over,
})

const susdsExit = (over: Partial<AddressFlow> = {}): AddressFlow => ({
  venue: 'sUSDS',
  label: 'sUSDS',
  direction: 'withdraw',
  at: '2026-06-02T09:00:00.000Z',
  usd: 500_000,
  txHash: '0xabc',
  cooldownSecondsAtEvent: null, // no cooldown method → instant exit
  dayOutflowUsd: 12_000_000,
  dayRank: 10,
  dayRankTotal: 88,
  ...over,
})

const deposit = (over: Partial<AddressFlow> = {}): AddressFlow => ({
  venue: 'sUSDe',
  label: 'sUSDe',
  direction: 'deposit',
  at: '2026-01-15T08:00:00.000Z',
  usd: 2_000_000,
  txHash: '0xdep',
  cooldownSecondsAtEvent: null,
  dayOutflowUsd: null,
  dayRank: null,
  dayRankTotal: null,
  ...over,
})

describe('rankPhrase — English ordinals, 1 = biggest', () => {
  it('names the top day plainly and the rest ordinally', () => {
    expect(rankPhrase(1)).toBe('biggest')
    expect(rankPhrase(2)).toBe('2nd-biggest')
    expect(rankPhrase(3)).toBe('3rd-biggest')
    expect(rankPhrase(11)).toBe('11th-biggest')
    expect(rankPhrase(21)).toBe('21st-biggest')
  })
})

describe('cooldown-gated exit beat — states the gate + projected landing', () => {
  it('renders a sUSDe exit as INITIATED, gated, with an arithmetic landing date', () => {
    const [beat, ...rest] = flowToBeats(susdeExit())
    expect(rest).toHaveLength(0)
    expect(beat.kind).toBe('exit_initiated')
    expect(beat.provenance).toBe('observed')
    expect(beat.text).toMatch(/exit initiated on sUSDe/)
    expect(beat.text).toMatch(/gated 1d/)
    // 2026-06-01 + 1 day = 2026-06-02 landing (block-time + recorded gate).
    expect(beat.text).toMatch(/landed ~2026-06-02/)
  })
})

describe('instant exit beat — no cooldown recorded', () => {
  it('renders a sUSDS exit as landed instantly, never asserting a gate', () => {
    const [beat] = flowToBeats(susdsExit())
    expect(beat.kind).toBe('exit_landed')
    expect(beat.text).toMatch(/instant, no cooldown gate/)
    expect(beat.text).not.toMatch(/gated/)
  })
})

describe('exit-on-worst-day context ranking — from the recorded corpus', () => {
  it('folds the day rank + outflow into the exit beat', () => {
    const [beat] = flowToBeats(susdeExit())
    expect(beat.text).toMatch(/3rd-biggest exit day/)
    expect(beat.text).toMatch(/of 91 recorded exit days/)
    expect(beat.text).toMatch(/\$70M left the venue/)
  })

  it('omits the rank clause when the corpus has no ranking (honesty)', () => {
    const [beat] = flowToBeats(susdeExit({ dayRank: null, dayOutflowUsd: null, dayRankTotal: null }))
    expect(beat.text).not.toMatch(/exit day/)
    expect(beat.text).toMatch(/exit initiated on sUSDe/)
  })
})

describe('entered/now delta — the portfolio story close', () => {
  it('summarizes a tracked address as entered → now with the move', () => {
    const inp: RecapInputs = {
      address: '0x4615cd2d869c2c7483832ba727602fd571d66874',
      watchedSinceISO: '2026-05-01T00:00:00.000Z',
      lookbackLabel: '180d',
      entryTotalUsd: 2_000_000,
      currentTotalUsd: 500_000,
      flows: [susdeExit()],
      venueEvents: [],
    }
    const { beats, summary } = composeRecap(inp)
    expect(summary).toMatch(/Tracked since 2026-05-01/)
    expect(summary).toMatch(/entered \$2M → now \$500k/)
    expect(summary).toMatch(/down \$1\.5M/)
    // A context beat anchors the delta in the timeline.
    const ctx = beats.find((b) => b.kind === 'context')
    expect(ctx).toBeDefined()
    expect(ctx?.text).toMatch(/started tracking here/)
  })
})

describe('unwatched-address fallback — lookback recap, no entry baseline', () => {
  it('states there is no baseline and emits no delta context beat', () => {
    const inp: RecapInputs = {
      address: '0xabc',
      watchedSinceISO: null,
      lookbackLabel: '180d',
      entryTotalUsd: null,
      currentTotalUsd: 750_000,
      flows: [susdeExit()],
      venueEvents: [],
    }
    const { beats, summary } = composeRecap(inp)
    expect(summary).toMatch(/trailing 180d/)
    expect(summary).toMatch(/not yet tracked/)
    expect(summary).toMatch(/now holding \$750k/)
    expect(beats.find((b) => b.kind === 'context')).toBeUndefined()
    // The flow beats still render.
    expect(beats.some((b) => b.kind === 'exit_initiated')).toBe(true)
  })
})

describe('empty history — no flows, no events', () => {
  it('returns no beats and a benign summary without throwing', () => {
    const inp: RecapInputs = {
      address: '0xabc',
      watchedSinceISO: null,
      lookbackLabel: '180d',
      entryTotalUsd: null,
      currentTotalUsd: 0,
      flows: [],
      venueEvents: [],
    }
    const { beats, summary } = composeRecap(inp)
    expect(beats).toEqual([])
    expect(summary).toMatch(/trailing 180d/)
    expect(summary).toMatch(/now holding \$0/)
  })

  it('a tracked address with no activity still shows the delta beat + summary', () => {
    const inp: RecapInputs = {
      address: '0xabc',
      watchedSinceISO: '2026-05-01T00:00:00.000Z',
      lookbackLabel: '180d',
      entryTotalUsd: 1_000_000,
      currentTotalUsd: 1_000_000,
      flows: [],
      venueEvents: [],
    }
    const { beats, summary } = composeRecap(inp)
    expect(summary).toMatch(/entered \$1M → now \$1M/)
    expect(beats).toHaveLength(1)
    expect(beats[0].kind).toBe('context')
    expect(beats[0].text).toMatch(/flat/)
  })
})

describe('composeRecap ordering + venue events', () => {
  it('merges venue events and sorts newest-first', () => {
    const venueEvents: VenueLogEntry[] = [
      {
        venue: 'sUSDe',
        kind: 'cooldown_duration_changed',
        at: '2026-06-15T00:00:00.000Z',
        prev: { cooldownDuration: 604800 },
        next: { cooldownDuration: 86400 },
        provenance: 'reconstructed',
      },
    ]
    const inp: RecapInputs = {
      address: '0xabc',
      watchedSinceISO: null,
      lookbackLabel: '180d',
      entryTotalUsd: null,
      currentTotalUsd: 100,
      flows: [deposit(), susdeExit()],
      venueEvents,
    }
    const { beats } = composeRecap(inp)
    // Newest first: 2026-06-15 event, 2026-06-01 exit, 2026-01-15 deposit.
    expect(beats.map((b) => b.kind)).toEqual(['venue_param_changed', 'exit_initiated', 'entered'])
    const ev = beats[0]
    expect(ev.text).toMatch(/cooldown 7d → 1d/)
    expect(ev.provenance).toBe('reconstructed')
  })
})
