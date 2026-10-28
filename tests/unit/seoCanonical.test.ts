import { describe, expect, it } from 'vitest'

import { canonicalUrl } from '@/helpers/canonicalUrl'

const SITE = 'https://membrane.example'

describe('canonicalUrl', () => {
  it('resolves the [chain] pattern a statically optimized page server-renders', () => {
    expect(canonicalUrl(SITE, '/[chain]/simulator', 'ethereum')).toBe(`${SITE}/ethereum/simulator`)
  })

  it('maps the root to the bare site URL and strips query and hash', () => {
    expect(canonicalUrl(SITE, '/?v=2', 'ethereum')).toBe(SITE)
    expect(canonicalUrl(SITE, '/ethereum/borrow#x', 'ethereum')).toBe(`${SITE}/ethereum/borrow`)
  })

  it('omits the tag for any other unresolved segment or without a site URL', () => {
    expect(canonicalUrl(SITE, '/[chain]/radar/[address]', 'ethereum')).toBeUndefined()
    expect(canonicalUrl('', '/ethereum/simulator', 'ethereum')).toBeUndefined()
  })
})
