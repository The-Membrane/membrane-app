import { describe, expect, it } from 'vitest'

import {
  alertLine,
  ALERTS_PAGE_CTA,
  ALERTS_PAGE_NOTE,
  capText,
  CONSENT_TEXT,
  controlTitle,
  draftErrors,
  feedStorageKey,
  LINK_WARNING,
  manageHref,
  MORE_WAYS,
  NEW_PAGE_CTA,
  NO_VALUE_LINE,
  outcomeView,
  parseInput,
  parseNumber,
  RSS_NOTE,
  SET_LINE,
  STALE_LINE,
  stampText,
  STOPPED_LINE,
  prefillText,
  relationLine,
  requestBody,
  submitOutcome,
  TELEGRAM_CTA,
  thresholdError,
  tokenFromFeedUrl,
  visibleErrors,
  WHERE_LABEL,
  type Draft,
} from '@/components/Alerts/alertMeAtLogic'
import { MAX_ACTIVE_PER_OWNER } from '@/lib/userAlerts/metrics'

// The "Alert me at X" view-model: what the control prefills, how it validates, the
// distance-from-now line, and how each API answer maps to a state.

const ADDR = '0x52908400098527886E0F7030069857D2E4169EE7'
const draft = (o: Partial<Draft> = {}): Draft => ({ input: '50', direction: 'above', address: ADDR, ...o })

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
  it('a STALE value is no prefill, no "now" line, and the stamp says, plainly, it is not checked', () => {
    expect(prefillText('utilization', 44.2, true)).toBe('')
    expect(relationLine('utilization', 'above', 44, 44.2, true)).toBeNull()
    expect(stampText('2026-10-14T09:00:00.000Z', true, true)).toBe(STALE_LINE)
    expect(STALE_LINE).toBe('The live number is out of date. Alerts are not checked until it updates.')
    expect(stampText('2026-10-14T09:00:00.000Z', true, false)).toBe('Live number as of 2026-10-14 09:00 UTC.')
    expect(stampText(null, false, false)).toBe(NO_VALUE_LINE)
    expect(NO_VALUE_LINE).toBe('No live number right now.')
    expect(stampText(null, true, false)).toBe('')
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
  it('every field: threshold and address (only when asked) — there is no opt-in box', () => {
    expect(draftErrors('utilization', draft(), true)).toEqual([])
    expect(draftErrors('utilization', draft({ input: '' }), false)).toEqual([{ field: 'threshold', message: 'Enter a number.' }])
    expect(draftErrors('utilization', draft({ input: '120' }), false)[0]).toEqual({ field: 'threshold', message: 'Enter a % from 0 to 100.' })
    expect(draftErrors('price', draft({ input: '0' }), false)[0].field).toBe('threshold')
    expect(draftErrors('utilization', draft({ address: '0x12' }), true)).toEqual([{ field: 'address', message: 'Enter a 0x address.' }])
    expect(draftErrors('utilization', draft({ address: '' }), false)).toEqual([])
  })
  it('thresholdError is the one number rule (set and edit share it)', () => {
    expect(thresholdError('utilization', '87,5')).toBeNull()
    expect(thresholdError('utilization', '1,23,4')).toEqual({ field: 'threshold', message: 'Use a dot for decimals, like 4.5.' })
    expect(thresholdError('apr', '501')).toEqual({ field: 'threshold', message: 'Enter a % from 0 to 500.' })
    expect(thresholdError('price', '$2,500.50')).toBeNull()
  })
  it('shows nothing before a submit attempt, then the draft errors, else the server field', () => {
    const bad = draft({ input: '' })
    expect(visibleErrors('utilization', bad, false, false, null)).toEqual({ threshold: null, address: null })
    const shown = visibleErrors('utilization', bad, false, true, null)
    expect(shown.threshold?.message).toBe('Enter a number.')
    const server = { field: 'threshold' as const, message: 'Enter a % from 0 to 100.' }
    expect(visibleErrors('utilization', draft(), false, true, server).threshold).toEqual(server)
  })
  it('pressing "Set alert" is the opt-in: one consent line beside it', () => {
    expect(CONSENT_TEXT).toBe('We keep this number so we can alert you. Only you get the link.')
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
    // A full page, in plain words; the number is the API's (else the shared constant).
    const full = 'You have 25 alerts, the most one link holds. Remove one on your alerts page to add another.'
    expect(submitOutcome(409, { error: 'cap', max: 25 })).toEqual({ phase: 'cap', message: full })
    expect(submitOutcome(409, null)).toEqual({ phase: 'cap', message: capText(MAX_ACTIVE_PER_OWNER) })
    expect(capText(MAX_ACTIVE_PER_OWNER)).toBe(full)
    expect(full).not.toMatch(/feed/i)
    expect(submitOutcome(400, { error: 'invalid', field: 'threshold', message: 'Enter a % from 0 to 100.' })).toEqual({
      phase: 'invalid',
      field: 'threshold',
      message: 'Enter a % from 0 to 100.',
    })
    expect(submitOutcome(400, { error: 'invalid', field: 'ownerKey', message: 'Enter a 0x address.' })).toMatchObject({ field: 'address' })
    expect(submitOutcome(400, { error: 'invalid', field: 'subject', message: 'No live apr for that subject.' })).toMatchObject({ field: null })
    // the API's opt-in error has no field on screen any more: one line under the form
    expect(submitOutcome(400, { error: 'invalid', field: 'optIn', message: 'm' })).toMatchObject({ field: null })
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
    // a full page is not a dead end: the control links to it, and offers a second page
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
    expect(alertLine('apr', 'venue:aave-v3-usde', 'below', 4)).toBe('Aave v3 USDe supply APR below 4.00%')
  })
})

describe('copy — one mental model: set an alert, then where you get it', () => {
  it('the first layer and the after-set panel', () => {
    expect(SET_LINE).toBe('Alert set.')
    expect(STOPPED_LINE).toBe('Alert stopped.')
    expect(WHERE_LABEL).toBe("where you'll get it")
    expect(TELEGRAM_CTA).toBe('Get it in Telegram')
    expect(ALERTS_PAGE_CTA).toBe('Your alerts page')
    expect(ALERTS_PAGE_NOTE).toBe('Bookmark it. It shows when your number is reached.')
    expect(NEW_PAGE_CTA).toBe('Start a second alerts page')
  })
  it('RSS is the second layer, behind one disclosure', () => {
    expect(MORE_WAYS).toBe('More ways to get alerts')
    expect(RSS_NOTE).toBe('For a feed reader. Keep it private, like your alerts page.')
  })
  it('no first-layer string says feed, store, threshold, safe or odds', () => {
    const firstLayer = [
      CONSENT_TEXT,
      SET_LINE,
      STOPPED_LINE,
      WHERE_LABEL,
      TELEGRAM_CTA,
      ALERTS_PAGE_CTA,
      ALERTS_PAGE_NOTE,
      LINK_WARNING,
      MORE_WAYS,
      NEW_PAGE_CTA,
      STALE_LINE,
      NO_VALUE_LINE,
      capText(MAX_ACTIVE_PER_OWNER),
    ]
    for (const s of firstLayer) expect(s).not.toMatch(/\b(feed|stor(e|ed|ing)|threshold|safe|odds)\b/i)
  })
})
