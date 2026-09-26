// THE FLIP HAS TO STAY A FLIP.
//
// config/simulatorMode.ts holds one constant, LANDING_SIM_MODE, that decides which
// simulator `/` and the nav point at (owner ruling 2026-09-12: "keep this build as a
// toggle flip in case we want to go back to borrower-first — or a separate page").
//
// Two ways that breaks silently, and one test each:
//   1. The constant points at a route nobody serves — the landing page 404s.
//   2. Only the landing build makes it into the sitemap, so flipping the constant
//      quietly de-indexes a live page. Both routes are real pages with their own
//      worked example; both belong in the sitemap regardless of which one leads.

import { describe, expect, it } from 'vitest'

import {
  LANDING_SIM_MODE,
  OTHER_MODE,
  SIM_MODE_LINK_LABEL,
  SIM_ROUTE,
  type SimMode,
} from '@/config/simulatorMode'
import { DEFAULT_CHAIN } from '@/config/chains'
import { INDEXABLE_PATHS } from '@/pages/sitemap.xml'

const MODES: SimMode[] = ['carry', 'borrower']

describe('the simulator mode flip', () => {
  it('lands on one of the two routes that exist', () => {
    expect(MODES).toContain(LANDING_SIM_MODE)
    expect([SIM_ROUTE.carry, SIM_ROUTE.borrower]).toContain(SIM_ROUTE[LANDING_SIM_MODE])
    // The two routes are distinct pages, not the same page twice.
    expect(SIM_ROUTE.carry).not.toBe(SIM_ROUTE.borrower)
  })

  it('keeps BOTH routes in the sitemap, whichever one is leading', () => {
    for (const mode of MODES) {
      expect(INDEXABLE_PATHS).toContain(`/${DEFAULT_CHAIN}${SIM_ROUTE[mode]}`)
    }
  })

  it('sends each page at its sibling, and labels the link for the sibling', () => {
    for (const mode of MODES) {
      const other = OTHER_MODE[mode]
      expect(other).not.toBe(mode)
      expect(MODES).toContain(other)
      expect(SIM_MODE_LINK_LABEL[other]).toContain(other === 'carry' ? 'carry' : 'borrower')
    }
  })
})
