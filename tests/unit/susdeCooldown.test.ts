// sUSDe'S COOLDOWN IS ONE DAY, AND EVERY SURFACE THAT STATES IT SAYS SO.
//
// StakedUSDeV2 cooldownDuration() went 604,800 → 86,400 s at block 24,669,809
// (tx 0x05856199ceddbfb1b8231c8bfa3bf4c967e5156122b2f1eb11a473fdf5f2d9f9). The simulator
// kept printing "a 7-day cooldown" for months after. Three things this file pins:
//
//  1. The venue's exit copy states the 1-day gate and where it was read.
//  2. The modelled rates did NOT move with the copy. 0.3 / 0 were never derived from
//     seven days (they came from the proto Builder tile), so a copy fix must not change
//     them. Changing recallRate is an owner call; this test makes that change explicit.
//  3. The committed demo snapshot cannot resurrect stale copy: its venue descriptions are
//     re-read from KNOWN_VENUES, only the balances come from the snapshot.

import { describe, expect, it } from 'vitest'

import { TILES } from '@/components/Builder/fixtures'
import { demoDetection } from '@/lib/position-sim/demo'
import { KNOWN_VENUES } from '@/lib/position-sim/venues'
import snapshot from '@/public/data/demo-carry.json'

const SUSDE = '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497'.toLowerCase()
const susde = () => {
  const v = KNOWN_VENUES.find((k) => k.address.toLowerCase() === SUSDE)
  if (!v) throw new Error('sUSDe is missing from KNOWN_VENUES')
  return v
}

describe('sUSDe exit copy', () => {
  it('states the 1-day cooldown with its on-chain source', () => {
    const { exit } = susde()
    expect(exit).toContain('1-day cooldown')
    expect(exit).toContain('86,400 s')
    expect(exit).toContain('24,669,809')
    expect(exit).toContain('0x05856199')
    expect(exit).not.toMatch(/\b7-day cooldown must\b/)
  })

  it('keeps the modelled rates — the copy fix is not a rate change', () => {
    const { recallRate, fastRate } = susde()
    expect(recallRate).toBe(0.3)
    // A 24 h gate is still longer than the 8 h cure window: nothing arrives fast.
    expect(fastRate).toBe(0)
  })

  it('the Builder tile no longer says seven days', () => {
    const tile = TILES.find((t) => t.id === 'susde')
    expect(tile?.note).toContain('1-day cooldown')
    expect(tile?.note).not.toContain('7-day')
  })
})

describe('demo snapshot venue copy', () => {
  it('re-reads every detected venue from KNOWN_VENUES', () => {
    const d = demoDetection()
    for (const x of d.detected) {
      const live = KNOWN_VENUES.find(
        (k) => k.address.toLowerCase() === x.venue.address.toLowerCase(),
      )
      expect(live, `${x.venue.symbol} is in KNOWN_VENUES`).toBeDefined()
      expect(x.venue).toEqual(live)
    }
  })

  it('shows the 1-day sUSDe copy, not the snapshot-time 7-day copy', () => {
    // The committed snapshot holds sUSDe dust and froze the 7-day copy with it. The rows
    // the page renders must carry the current copy instead.
    const frozen = snapshot.detection.detected.some((x) => x.venue.address.toLowerCase() === SUSDE)
    const row = demoDetection().detected.find((x) => x.venue.address.toLowerCase() === SUSDE)
    expect(Boolean(row)).toBe(frozen)
    if (row) expect(row.venue.exit).toBe(susde().exit)
  })
})
