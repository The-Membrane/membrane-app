import { describe, expect, it } from 'vitest'

import { cleanDisplayName } from '@/lib/game/cleanName'

describe('cleanDisplayName', () => {
  it('passes a clean name through unchanged', () => {
    const result = cleanDisplayName('Speedy Gonzalez')
    expect(result).toEqual({ clean: 'Speedy Gonzalez', flagged: false })
  })

  it('trims and collapses internal whitespace', () => {
    const result = cleanDisplayName('  Track   Star  ')
    expect(result).toEqual({ clean: 'Track Star', flagged: false })
  })

  it('replaces a profane name with the fallback', () => {
    const result = cleanDisplayName('fuck you')
    expect(result.flagged).toBe(true)
    expect(result.clean).toBe('a racer')
  })

  it('catches a leetspeak profanity variant', () => {
    const result = cleanDisplayName('fu(k')
    expect(result.flagged).toBe(true)
    expect(result.clean).toBe('a racer')
  })

  it('caps length at 24 characters', () => {
    const raw = 'a'.repeat(40)
    const result = cleanDisplayName(raw)
    expect(result.clean.length).toBe(24)
    expect(result.flagged).toBe(false)
  })

  it('treats an empty (or whitespace-only) name as flagged', () => {
    const result = cleanDisplayName('   ')
    expect(result).toEqual({ clean: 'a racer', flagged: true })
  })
})
