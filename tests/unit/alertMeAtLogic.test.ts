import { describe, expect, it } from 'vitest'

import {
  controlTitle,
  draftErrors,
  feedStorageKey,
  LINK_WARNING,
  manageHref,
  OPT_IN_TEXT,
  outcomeView,
  parseInput,
  parseNumber,
  STALE_LINE,
  stampText,
  prefillText,
  relationLine,
  requestBody,
  submitOutcome,
  successLine,
  tokenFromFeedUrl,
  visibleErrors,
  type Draft,
} from '@/components/Alerts/alertMeAtLogic'

// The "Alert me at X" view-model: what the control prefills, how it validates, the
// distance-from-now line, and how each API answer maps to a state.

const ADDR = '0x52908400098527886E0F7030069857D2E4169EE7'
const draft = (o: Partial<Draft> = {}): Draft => ({ input: '50', direction: 'above', optIn: true, address: ADDR, ...o })

describe('prefill — the live value, never a made-up default', () => {
  it('formats at the metric display precision', () => {
    expect(prefillText('utilization', 44.234)).toBe('44.2')
    expect(prefillText('apr', 4.3712)).toBe('4.37')
    expect(prefillText('price', 2510.73456)).toBe('2510.73')
  })
  it('no live value → empty input', () => {
    expect(prefillText('price', null)).toBe('')
    expect(prefillText('price', undefined)).toBe('')
    expect(prefillText('apr', NaN)).toBe('')
  })
  it('a STALE value is no prefill, no "now" line, and the stamp says it is not checked', () => {
    expect(prefillText('utilization', 44.2, true)).toBe('')
    expect(relationLine('utilization', 'above', 44, 44.2, true)).toBeNull()
    expect(stampText('2026-10-14T09:00:00.000Z', true, true)).toBe(STALE_LINE)
    expect(STALE_LINE).toBe('Not checked until the value is fresh.')
    expect(stampText('2026-10-14T09:00:00.000Z', true, false)).toBe('value as of 2026-10-14 09:00 UTC · checked each time your feed is read')
    expect(stampText(null, false, false)).toBe('checked each time your feed is read')
  })
})

describe('validation', () => {
  it('parses what people type', () => {
    expect(parseInput('$2,500.50')).toBe(2500.5)
    expect(parseInput(' 50 % ')).toBe(50)
    expect(Number.isNaN(parseInput(''))).toBe(true)
  })
  it('a comma is a thousands separator only in groups of three; a lone comma is the decimal mark', () => {
    expect(parseNumber('4,5')).toEqual({ ok: true, value: 4.5 })
    expect(parseNumber('87,5')).toEqual({ ok: true, value: 87.5 })
    expect(parseNumber('1,234.5')).toEqual({ ok: true, value: 1234.5 })
    expect(parseNumber('12,345,678')).toEqual({ ok: true, value: 12345678 })
    expect(parseNumber('1,23,4')).toEqual({ ok: false, message: 'Use a dot for decimals, like 4.5.' })
    expect(parseNumber('4,5.6')).toEqual({ ok: false, message: 'Use a dot for decimals, like 4.5.' })
    expect(parseNumber('0x10')).toEqual({ ok: false, message: 'Enter a plain number, like 4.5.' })
    expect(parseNumber('1e2').ok).toBe(false)
    expect(parseNumber('')).toEqual({ ok: false, message: 'Enter a number.' })
    // the 10x trap: "87,5" must never become 875
    expect(draftErrors('utilization', draft({ input: '87,5' }), false)).toEqual([])
    expect(draftErrors('utilization', draft({ input: '1,23,4' }), false)[0].message).toBe('Use a dot for decimals, like 4.5.')
  })
  it('every field: threshold, address (only when asked), opt-in', () => {
    expect(draftErrors('utilization', draft(), true)).toEqual([])
    expect(draftErrors('utilization', draft({ input: '' }), false)).toEqual([{ field: 'threshold', message: 'Enter a number.' }])
    expect(draftErrors('utilization', draft({ input: '120' }), false)[0]).toEqual({ field: 'threshold', message: 'Enter a % from 0 to 100.' })
    expect(draftErrors('price', draft({ input: '0' }), false)[0].field).toBe('threshold')
    expect(draftErrors('utilization', draft({ address: '0x12' }), true)).toEqual([{ field: 'address', message: 'Enter a 0x address.' }])
    expect(draftErrors('utilization', draft({ address: '' }), false)).toEqual([])
    expect(draftErrors('utilization', draft({ optIn: false }), false)).toEqual([{ field: 'optIn', message: 'Tick the box to store this alert.' }])
  })
  it('shows nothing before a submit attempt, then the draft errors, else the server field', () => {
    const bad = draft({ input: '', optIn: false })
    expect(visibleErrors('utilization', bad, false, false, null)).toEqual({ threshold: null, address: null, optIn: null })
    const shown = visibleErrors('utilization', bad, false, true, null)
    expect([shown.threshold?.message, shown.optIn?.message]).toEqual(['Enter a number.', 'Tick the box to store this alert.'])
    const server = { field: 'threshold' as const, message: 'Enter a % from 0 to 100.' }
    expect(visibleErrors('utilization', draft(), false, true, server).threshold).toEqual(server)
  })
  it('the opt-in words are the owner-approved sentence', () => {
    expect(OPT_IN_TEXT).toBe('Store this threshold to alert me. Only you get the feed link.')
  })
})

describe('relationLine — distance from now, whole units, floored', () => {
  it('pp for utilization / APR, % for price', () => {
    expect(relationLine('utilization', 'above', 50, 44.2)).toBe('Fires 5 pp above now (44.2%).')
    expect(relationLine('price', 'below', 2400, 2510)).toBe('Fires 4% below now ($2,510.00).')
    expect(relationLine('apr', 'below', 4.2, 4.37)).toBe('Fires under 1 pp below now (4.37%).')
  })
  it('already past (incl. exactly at the line) fires on the first check', () => {
    expect(relationLine('utilization', 'above', 44.2, 44.2)).toBe('Now 44.2%: already at or above it. Fires on the first check.')
    expect(relationLine('price', 'below', 2600, 2510)).toBe('Now $2,510.00: already at or below it. Fires on the first check.')
  })
  it('nothing to compare → no line', () => {
    expect(relationLine('price', 'below', 2400, null)).toBeNull()
    expect(relationLine('price', 'below', NaN, 2510)).toBeNull()
  })
})

describe('submitOutcome — every API answer has a state', () => {
  it('success carries the feed, the telegram link only when given', () => {
    expect(submitOutcome(200, { id: 'x', feedUrl: 'https://m/api/alerts/feed/abc?format=rss' })).toEqual({
      phase: 'success',
      feedUrl: 'https://m/api/alerts/feed/abc?format=rss',
      telegramLink: null,
      id: 'x',
    })
    expect(submitOutcome(200, { feedUrl: 'f', telegramLink: 't' })).toMatchObject({ telegramLink: 't' })
  })
  it('cap, invalid, unknown feed, rate limit, down', () => {
    expect(submitOutcome(409, { error: 'cap', max: 25 })).toEqual({ phase: 'cap', message: '25 alerts max per feed. Stop one, or start a new feed.' })
    expect(submitOutcome(409, null)).toEqual({ phase: 'cap', message: '25 alerts max per feed. Stop one, or start a new feed.' })
    expect(submitOutcome(400, { error: 'invalid', field: 'threshold', message: 'Enter a % from 0 to 100.' })).toEqual({
      phase: 'invalid',
      field: 'threshold',
      message: 'Enter a % from 0 to 100.',
    })
    expect(submitOutcome(400, { error: 'invalid', field: 'ownerKey', message: 'Enter a 0x address.' })).toMatchObject({ field: 'address' })
    expect(submitOutcome(400, { error: 'invalid', field: 'subject', message: 'No live apr for that subject.' })).toMatchObject({ field: null })
    expect(submitOutcome(404, { error: 'unknown feed' })).toEqual({ phase: 'unknownFeed' })
    expect(submitOutcome(429, null)).toEqual({ phase: 'error', message: 'Too many tries. Wait a few minutes.' })
    expect(submitOutcome(503, null)).toEqual({ phase: 'error', message: 'Alerts are down right now. Try later.' })
    expect(submitOutcome(0, null).phase).toBe('error')
    expect(submitOutcome(200, null).phase).toBe('error')
  })
})

describe('outcomeView — where each answer shows', () => {
  it('stored panel, the named field when it is on screen, else one line', () => {
    expect(outcomeView({ phase: 'success', feedUrl: 'f', telegramLink: null, id: 'x' }, false)).toEqual({ kind: 'stored', feedUrl: 'f', telegramLink: null, id: 'x' })
    const th = { phase: 'invalid' as const, field: 'threshold' as const, message: 'Enter a number.' }
    expect(outcomeView(th, false)).toEqual({ kind: 'field', error: { field: 'threshold', message: 'Enter a number.' } })
    const addr = { phase: 'invalid' as const, field: 'address' as const, message: 'Enter a 0x address.' }
    expect(outcomeView(addr, true).kind).toBe('field')
    expect(outcomeView(addr, false)).toEqual({ kind: 'message', message: 'Enter a 0x address.' })
    // a full feed is not a dead end: the control offers manage + start a new feed
    expect(outcomeView({ phase: 'cap', message: 'm' }, false)).toEqual({ kind: 'cap', message: 'm' })
    expect(outcomeView({ phase: 'error', message: 'down' }, false)).toEqual({ kind: 'message', message: 'down' })
    expect(outcomeView({ phase: 'unknownFeed' }, false)).toEqual({ kind: 'message', message: 'Alerts are down right now. Try later.' })
  })
})

describe('request and feed plumbing', () => {
  const token = 'ab'.repeat(32)
  it('the body always opts in, and carries the feed token only when this browser has one', () => {
    const base = { metric: 'apr' as const, subject: 'venue:aave-v3-usde', direction: 'below' as const, threshold: 4, address: ` ${ADDR} ` }
    expect(requestBody({ ...base, feedToken: null })).toEqual({
      ownerKind: 'address',
      ownerKey: ADDR,
      metric: 'apr',
      subject: 'venue:aave-v3-usde',
      direction: 'below',
      threshold: 4,
      optIn: true,
    })
    expect(requestBody({ ...base, feedToken: token }).feedToken).toBe(token)
  })
  it('token from a feed URL; storage key per address', () => {
    expect(tokenFromFeedUrl(`https://membrane.money/api/alerts/feed/${token}?format=rss`)).toBe(token)
    expect(tokenFromFeedUrl('https://membrane.money/api/alerts/feed/nope')).toBeNull()
    expect(feedStorageKey(ADDR)).toBe(`membrane:alerts:feed:${ADDR.toLowerCase()}`)
    expect(manageHref(token)).toBe(`/alerts/${token}`)
    expect(LINK_WARNING).toBe('Anyone with this link can read these alerts.')
  })
  it('titles', () => {
    expect(controlTitle('utilization', 'venue:aave-v3-usde')).toBe('Aave v3 USDe utilization')
    expect(controlTitle('price', 'asset:ETH')).toBe('ETH price')
    expect(successLine('apr', 'venue:aave-v3-usde', 'below', 4)).toBe('Stored: Aave v3 USDe supply APR below 4.00%')
  })
})
