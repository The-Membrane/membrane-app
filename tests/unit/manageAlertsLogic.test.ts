import { describe, expect, it } from 'vitest'

import {
  CANCEL_CTA,
  cardState,
  EDIT_CTA,
  EDIT_NOTE,
  editBody,
  editError,
  editOutcome,
  editPrefill,
  GONE_TEXT,
  SAVE_CTA,
  STOP_CTA,
} from '@/components/Alerts/manageLogic'

// The edit form on the alerts page (/alerts/<token>): its prefill, its validation
// (the same rule as "Set alert") and how each PATCH answer maps to a state.

describe('edit prefill — the stored number exactly, never rounded', () => {
  it('keeps every stored decimal, so editing only the direction cannot move the line', () => {
    expect(editPrefill(50)).toBe('50')
    expect(editPrefill(4.375)).toBe('4.375')
    expect(editPrefill(2500.505)).toBe('2500.505')
    expect(editPrefill(0.000001)).toBe('0.000001')
    expect(editPrefill(NaN)).toBe('')
  })
})

describe('edit validation — the same parsing and bounds as setting an alert', () => {
  it('decimal comma, thousands groups, refused commas, bounds per metric', () => {
    expect(editError('utilization', '87,5')).toBeNull()
    expect(editBody('above', '87,5')).toEqual({ direction: 'above', threshold: 87.5 })
    expect(editBody('below', '$2,500.50')).toEqual({ direction: 'below', threshold: 2500.5 })
    expect(editError('utilization', '1,23,4')?.message).toBe('Use a dot for decimals, like 4.5.')
    expect(editError('utilization', '101')?.message).toBe('Enter a % from 0 to 100.')
    expect(editError('apr', '501')?.message).toBe('Enter a % from 0 to 500.')
    expect(editError('price', '0')?.message).toBe('Enter a USD price up to 10,000,000.')
    expect(editError('price', '')?.message).toBe('Enter a number.')
  })
})

describe('editOutcome — every PATCH answer has a state', () => {
  it('saved (changed or not), invalid, gone, rate limit, down', () => {
    expect(editOutcome(200, { id: 'n', changed: true })).toEqual({ phase: 'saved', id: 'n', changed: true })
    expect(editOutcome(200, { id: 'o', changed: false })).toEqual({ phase: 'saved', id: 'o', changed: false })
    expect(editOutcome(200, null)).toEqual({ phase: 'error', message: 'Could not save it. Try again.' })
    expect(editOutcome(400, { error: 'invalid', field: 'threshold', message: 'Enter a % from 0 to 100.' })).toEqual({
      phase: 'invalid',
      message: 'Enter a % from 0 to 100.',
    })
    expect(editOutcome(404, { error: 'unknown alert' })).toEqual({ phase: 'gone' })
    expect(editOutcome(429, null)).toEqual({ phase: 'error', message: 'Too many tries. Wait a minute.' })
    expect(editOutcome(503, null).phase).toBe('error')
    expect(editOutcome(0, null).phase).toBe('error')
  })
  it('the words', () => {
    expect([EDIT_CTA, SAVE_CTA, CANCEL_CTA, STOP_CTA]).toEqual(['Edit', 'Save', 'Cancel', 'Stop'])
    expect(EDIT_NOTE).toBe('Saving starts this alert fresh. Its past alerts stay under Recent.')
    expect(GONE_TEXT).toBe('This alert is no longer active. The list is up to date.')
    for (const s of [EDIT_NOTE, GONE_TEXT]) expect(s).not.toMatch(/\b(feed|threshold|safe|odds)\b/i)
  })
})

describe('card state — the face each alert card wears', () => {
  const t = (crossed: boolean, status: string) => ({ crossed, reading: { status } })
  it('a crossed alert is reached, even when this read could not check it', () => {
    expect(cardState(t(true, 'ok'))).toBe('reached')
    expect(cardState(t(true, 'stale'))).toBe('reached')
  })
  it('an uncrossed alert this read could not check is unchecked', () => {
    expect(cardState(t(false, 'stale'))).toBe('unchecked')
    expect(cardState(t(false, 'unavailable'))).toBe('unchecked')
  })
  it('otherwise it is watching', () => {
    expect(cardState(t(false, 'ok'))).toBe('watching')
    expect(cardState(t(false, 'superseded'))).toBe('watching')
  })
})
