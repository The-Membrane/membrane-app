import { describe, expect, it } from 'vitest'

import { venueSlug } from '@/components/Carry/venueSlug'

// venueSlug maps a venue display label to its /venue permalink slug (the recorder
// config `name`), or null when the venue has no tracked permalink. Only the four
// instrumented venues have a permalink; a label with no match must return null so
// callers render plain text, never a link into the 404-card.
describe('venueSlug', () => {
  it('passes through the four tracked recorder slugs unchanged', () => {
    expect(venueSlug('sUSDe')).toBe('sUSDe')
    expect(venueSlug('sUSDS')).toBe('sUSDS')
    expect(venueSlug('scrvUSD')).toBe('scrvUSD')
    expect(venueSlug('aave-v3-usde')).toBe('aave-v3-usde')
  })

  it('maps Aave display labels to the aave-v3-usde slug', () => {
    expect(venueSlug('Aave')).toBe('aave-v3-usde')
    expect(venueSlug('Aave V3')).toBe('aave-v3-usde')
    expect(venueSlug('Aave USDe')).toBe('aave-v3-usde')
  })

  it('is case-insensitive on the label match', () => {
    expect(venueSlug('susde')).toBe('sUSDe')
    expect(venueSlug('AAVE V3')).toBe('aave-v3-usde')
  })

  it('returns null for untracked venues so they never link into a 404-card', () => {
    expect(venueSlug('VaultV2')).toBeNull()
    expect(venueSlug('PT (fixed maturity)')).toBeNull()
    expect(venueSlug('')).toBeNull()
    expect(venueSlug(undefined)).toBeNull()
    expect(venueSlug(null)).toBeNull()
  })
})
