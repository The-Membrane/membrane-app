import { describe, expect, it } from 'vitest'

import { nameplateSize } from '@/components/Today/newsStyle'

// The masthead nameplate's size: Today's "Membrane" keeps its plate; a longer page name
// (the Radar page's "Carry Radar") is scaled to the same measure.

describe('nameplateSize', () => {
  it('"Membrane" (and anything shorter) keeps the original plate', () => {
    expect(nameplateSize('Membrane')).toBe('clamp(56px, 16vw, 120px)')
    expect(nameplateSize('Today')).toBe('clamp(56px, 16vw, 120px)')
  })

  it('a longer name scales every bound by 8 / its length', () => {
    expect(nameplateSize('Carry Radar')).toBe('clamp(41px, 11.6vw, 87px)')
    expect(nameplateSize('')).toBe('clamp(56px, 16vw, 120px)')
  })
})
