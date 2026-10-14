import { describe, expect, it } from 'vitest'

import { HOME_COPY, regimeHome } from '@/components/Today/regimeHome'
import {
  DEFAULT_SIZE,
  leadView,
  OPP_COPY,
  SIZES,
  sizeLabel,
  type NetApyList,
} from '@/components/Today/opportunitiesView'
import { SAFETY_COPY } from '@/components/Today/safetyView'
import { DAGGER_NOTE, datelineShort, METHOD_JUMP, TAGLINE } from '@/components/Today/todayCopy'
import { STRIP_COPY, weatherView } from '@/components/Weather/weatherView'
import { HOUR_MS, type M0Result } from '@/lib/regime/m0'
import type { WeatherResponse } from '@/lib/weather/handler'

// THE FIRST SCREEN at 390px, from the view models' own strings (DESIGN_RULES §3: at most
// 60 words). It is the masthead (nameplate, tagline), the dateline as phones print it
// (the short date, regime, reason or hold, the DVOL sentence, gas, the folded ages), and
// the owning body's lead. Every whitespace-separated token with a letter or a digit
// counts, figures included, so this is the strict count. What follows the lead (the dense
// panel) is measured in the browser and reported with the build.
// Banned words (§4) are checked over every string the bodies can print.

const H = Date.UTC(2026, 9, 14, 12)
const NOW = H + 20 * 60_000

const regime = (over: Partial<M0Result> = {}): M0Result => ({
  state: 'calm',
  evaluatedAt: H,
  holdHours: 24,
  triggers: [],
  active: false,
  current: { move24h: null, gap: null },
  since: null,
  sinceTruncated: false,
  holdsUntil: null,
  lastTriggerAt: null,
  coverage: { hoursObserved: 24, window: 24, required: 20 },
  inputs: { oracleAsOf: NOW - 12 * 60_000, marketAsOf: H },
  stale: [],
  liquidationVolume: { counted: false, reason: 'no live source' },
  ...over,
})
const weather = (r: Partial<M0Result>): WeatherResponse =>
  ({
    now: NOW - 30_000,
    gas: { gwei: 0.066797862, block: 26_187_399, asOfMs: NOW - 9_000 },
    dvol: { dvol: 51.69, dailyMovePct: 2.7, candleOpenMs: H - HOUR_MS, asOfMs: H - 20 * 60_000 },
    regime: regime(r),
    oracle: null,
    thresholds: {} as WeatherResponse['thresholds'],
    sources: [] as unknown as WeatherResponse['sources'],
    errors: {},
  }) as WeatherResponse

const STATES: Record<string, { status: 'error' | 'success'; data?: WeatherResponse }> = {
  calm: { status: 'success', data: weather({}) },
  choppyActive: {
    status: 'success',
    data: weather({
      state: 'choppy',
      active: true,
      triggers: [{ t: H, kind: 'move24h', value: -0.0921, threshold: 0.0814 }],
      lastTriggerAt: H,
      since: H - 3 * HOUR_MS,
      holdsUntil: H + 24 * HOUR_MS,
    }),
  },
  choppyHold: {
    status: 'success',
    data: weather({
      state: 'choppy',
      triggers: [{ t: H - 10 * HOUR_MS, kind: 'move24h', value: -0.09, threshold: 0.0814 }],
      lastTriggerAt: H - 10 * HOUR_MS,
      since: H - 30 * HOUR_MS,
      holdsUntil: H + 14 * HOUR_MS,
    }),
  },
  stale: { status: 'success', data: weather({ state: 'stale', stale: ['oracleOld'] }) },
  error: { status: 'error' },
}

/** A long venue label, so the count is the worst case. */
const NET_APY: NetApyList = {
  anchor: { chainId: 1, blockNumber: '26187572', blockTimestamp: String(Math.floor((NOW - 15 * 60_000) / 1000)), blockHash: '0x' },
  rpc: 'env:host',
  side: 'supply',
  sizeUsd: DEFAULT_SIZE,
  venues: [
    {
      venueKey: 'aave-v3-usde',
      label: 'Morpho wstETH/USDC 86%',
      protocol: 'morpho-blue',
      net: { apr: 0.0391, apy: 0.0399, bound: 'upper', withIncentives: false },
      netIncentiveFree: { apr: 0.0391, apy: 0.0399, bound: 'upper' },
      supplyAprNow: 0.0394,
      borrowAprNow: 0.0457,
      borrowAprAtKink: 0.09,
      firstIncentiveEndTs: null,
      reverts: null,
    },
  ],
  errors: [],
  incentivesStatus: { ok: true, fetchedAt: NOW / 1000 },
}

const tokens = (parts: (string | null | undefined)[]): string[] =>
  parts.filter((p): p is string => !!p).flatMap((p) => p.split(/\s+/)).filter((t) => /[\p{L}\p{N}]/u.test(t))

function firstScreen(state: keyof typeof STATES): string[] {
  const { status, data } = STATES[state]
  const v = weatherView({ status, data, nowMs: NOW })
  const home = regimeHome({ status, data, nowMs: NOW })
  const masthead = ['Membrane', TAGLINE]
  // Phones print the short date, the regime, the reason (or the hold), the sentence, then
  // gas and the folded ages (components/Weather/WeatherStrip.tsx).
  const strip = [
    datelineShort('2026-10-14'),
    v.regime.text,
    v.reason ? `${v.reason.lead} ${v.reason.figure} ${v.reason.tail}` : null,
    v.reason ? null : v.holds,
    v.sentence,
    v.gas,
    v.agesBrief,
  ]
  let lead: (string | null)[]
  if (home.owner === 'opportunities') {
    // The worst case: a ready lead whose venue has a page, so "Open venue →" shows too.
    const l = leadView({ netApy: { status: 'success', data: NET_APY }, sizeUsd: DEFAULT_SIZE, chain: 'ethereum', nowMs: NOW })
    lead = [
      home.kicker,
      l.headline ? `${l.headline.lead} ${l.headline.figure} ${l.headline.tail}` : l.withheld,
      l.hero ? `${l.hero.figure} ${l.hero.unit}` : null,
      ...SIZES.map(sizeLabel),
      l.credit,
      l.href ? OPP_COPY.openVenue : null,
    ]
  } else {
    // The worst case: a connected wallet, so its link shows too.
    lead = [
      home.kicker,
      SAFETY_COPY.headline,
      SAFETY_COPY.deck,
      SAFETY_COPY.placeholder,
      SAFETY_COPY.action,
      `${SAFETY_COPY.useWallet} 0x1601…347E →`,
    ]
  }
  return tokens([...masthead, ...strip, ...lead])
}

describe('the first screen at 390px', () => {
  for (const state of Object.keys(STATES) as (keyof typeof STATES)[]) {
    it(`${state}: at most 60 words, figures included`, () => {
      const t = firstScreen(state)
      expect(t.length, t.join(' ')).toBeLessThanOrEqual(60)
    })
  }

  it('calm leads with Opportunities, every other state with Safety', () => {
    expect(firstScreen('calm')).toContain('Opportunities')
    for (const s of ['choppyActive', 'choppyHold', 'stale', 'error'] as const) {
      expect(firstScreen(s).some((t) => t.startsWith('Safety'))).toBe(true)
    }
  })
})

describe('banned words (DESIGN_RULES §4)', () => {
  it('no verdict words, no positive carry, no free borrowing in any copy', () => {
    const all = [
      ...Object.values(OPP_COPY),
      ...Object.values(SAFETY_COPY),
      ...Object.values(HOME_COPY.name),
      ...Object.values(HOME_COPY.jump),
      HOME_COPY.byDefault,
      METHOD_JUMP,
      DAGGER_NOTE,
      ...Object.values(STRIP_COPY),
    ].join(' | ')
    expect(all).not.toMatch(/\b(safe|safely|ok|okay|good|great|best|free)\b/i)
    expect(all).not.toMatch(/positive carry/i)
    expect(all).not.toMatch(/\b0(\.0+)?%/)
  })
})
