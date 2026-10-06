// Mechanism-panel parameter formatting (components/OracleRegistry/paramFormat.ts): known
// parameters render in their unit — a price cap at its decimals, WAD (1e18) and Aave
// PERCENTAGE_FACTOR (1e4) percents, seconds as durations, unix times as dates — and the raw
// value is always kept beside the formatted one; an unknown scale stays raw.

import { describe, expect, it } from 'vitest'

import {
  formatParam,
  onchainContext,
  paramRows,
  type ParamDisplay,
} from '@/components/OracleRegistry/paramFormat'
import { getOracleCatalog } from '@/lib/oracleRegistry/catalog'

const shown = (d: ParamDisplay) => [d.text, d.raw]

describe('formatParam', () => {
  it('renders an 8-decimal USD price cap as dollars, raw kept (usde.aave.capped-usdt)', () => {
    expect(shown(formatParam('priceCap', '104000000', { priceDecimals: 8 }))).toEqual([
      '$1.04',
      '104000000',
    ])
    expect(formatParam('priceCap', '104000000', { priceDecimals: 8 }).unit).toBe('usd')
    // No known decimals → no guess: the raw integer stays as is.
    expect(shown(formatParam('priceCap', '104000000'))).toEqual(['104000000', null])
    expect(shown(formatParam('priceCap', '1.04', { priceDecimals: 8 }))).toEqual(['1.04', null])
  })

  it('renders a WAD (1e18 = 100%) threshold as a percent (cbBTC meta-oracle)', () => {
    expect(shown(formatParam('deviationThreshold', '20000000000000000'))).toEqual([
      '2%',
      '20000000000000000',
    ])
    expect(formatParam('deviationThreshold', '20000000000000000').unit).toBe('percent')
    expect(formatParam('deviationThreshold', '2500000000000000').text).toBe('0.25%')
  })

  it('renders Aave CAPO growth caps by their source: on-chain 1e4 vs the catalog’s percent', () => {
    expect(shown(formatParam('getMaxYearlyGrowthRatePercent', '880'))).toEqual(['8.8%/yr', '880'])
    expect(formatParam('getMaxYearlyGrowthRatePercent', 875).text).toBe('8.75%/yr')
    expect(formatParam('maxYearlyRatioGrowthPercent', 1117).text).toBe('11.17%/yr')
    // The catalog's map already stores a percent: 8.8 is 8.8%/yr, never 0.088%.
    expect(shown(formatParam('maxYearlyGrowthPercent', 8.8))).toEqual(['8.8%/yr', '8.8'])
  })

  it('renders seconds as durations and unix times as dates', () => {
    expect(shown(formatParam('challengeTimelockDuration', '7200'))).toEqual(['2h', '7200'])
    expect(shown(formatParam('healingTimelockDuration', '28800'))).toEqual(['8h', '28800'])
    expect(shown(formatParam('minimumSnapshotDelaySeconds', 604800))).toEqual(['7d', '604800'])
    expect(formatParam('someWindowSeconds', 1800).text).toBe('30m')
    expect(shown(formatParam('getSnapshotTimestamp', 1776098051))).toEqual([
      '2026-04-13',
      '1776098051',
    ])
    expect(formatParam('MATURITY', '1792627200').text).toBe('2026-10-22')
    // Not a plausible unix time / not whole seconds → raw.
    expect(shown(formatParam('snapshotTimestamp', 12))).toEqual(['12', null])
    expect(shown(formatParam('challengeTimelockDuration', '-5'))).toEqual(['-5', null])
  })

  it('renders 1e18 ratios and yearly rates at their scale', () => {
    expect(shown(formatParam('getSnapshotRatio', '1092511275951548029'))).toEqual([
      '1.09251',
      '1092511275951548029',
    ])
    expect(formatParam('snapshotRatio', '1092511275', { ratioDecimals: 9 }).text).toBe('1.09251')
    expect(formatParam('discountRatePerYear', '37700000000000000').text).toBe('3.77%/yr')
    expect(formatParam('discountRatePerYear', '377', { rateScale: 1e4 }).text).toBe('3.77%/yr')
  })

  it('leaves unknown scales, flags and nulls raw', () => {
    expect(shown(formatParam('phaseId', '123456789012345678'))).toEqual([
      '123456789012345678',
      null,
    ])
    expect(shown(formatParam('bar', 13))).toEqual(['13', null])
    expect(shown(formatParam('bar', null))).toEqual(['—', null])
    expect(shown(formatParam('paused', false))).toEqual(['false', null])
    expect(formatParam('observedAt', '2026-10-05').unit).toBe('raw')
  })
})

describe('paramRows', () => {
  it('formats a price-cap map with its decimals sibling consumed', () => {
    const rows = paramRows({
      kind: 'price_cap',
      priceCap: '104000000',
      priceCapDecimals: 8,
      observedAt: '2026-10-05',
      note: 'read from storage slot 2',
    })
    expect(rows.map(([k, d]) => [k, d.text, d.raw])).toEqual([
      ['kind', 'price_cap', null],
      ['priceCap', '$1.04', '104000000'],
      ['observedAt', '2026-10-05', null],
      ['note', 'read from storage slot 2', null],
    ])
  })

  it('formats a CAPO map (ratioDecimals consumed, percent growth cap, delay, date)', () => {
    const rows = paramRows({
      kind: 'ratio_growth',
      snapshotRatio: '1228282498700325540',
      snapshotTimestamp: 1772535659,
      maxYearlyGrowthPercent: 8.8,
      minimumSnapshotDelaySeconds: 604800,
      ratioDecimals: 18,
    })
    expect(rows.map(([k, d]) => [k, d.text])).toEqual([
      ['kind', 'ratio_growth'],
      ['snapshotRatio', '1.22828'],
      ['snapshotTimestamp', '2026-03-03'],
      ['maxYearlyGrowthPercent', '8.8%/yr'],
      ['minimumSnapshotDelaySeconds', '7d'],
    ])
    expect(paramRows(undefined)).toEqual([])
  })

  it('formats a PT discount schedule at the map’s own scale', () => {
    const rows = paramRows({
      discountRatePerYear: '37700000000000000',
      maxDiscountRatePerYear: '102200000000000000',
      maturity: 1792627200,
      scale: 1000000000000000000,
      observedAt: '2026-10-05',
    })
    expect(rows.map(([k, d]) => [k, d.text])).toEqual([
      ['discountRatePerYear', '3.77%/yr'],
      ['maxDiscountRatePerYear', '10.22%/yr'],
      ['maturity', '2026-10-22'],
      ['scale', '1e18'],
      ['observedAt', '2026-10-05'],
    ])
  })
})

describe('real catalog', () => {
  const catalog = getOracleCatalog()
  const entry = (id: string) => {
    const e = catalog.entries.find((x) => x.id === id)
    if (!e) throw new Error(`missing ${id}`)
    return e
  }

  it('renders the USDe capped adapter’s cap as $1.04, on-chain and in the catalog map', () => {
    const e = entry('usde.aave.capped-usdt')
    const card = { decimals: e.decimals ?? null, mechanism: e.mechanism }
    const cap = paramRows(e.mechanism.cap).find(([k]) => k === 'priceCap')?.[1]
    expect(cap && shown(cap)).toEqual(['$1.04', '104000000'])
    expect(shown(formatParam('priceCap', '104000000', onchainContext(card)))).toEqual([
      '$1.04',
      '104000000',
    ])
  })

  it('every cap / discount parameter in the catalog renders without leaking a bare scaled integer', () => {
    for (const e of catalog.entries) {
      for (const map of [e.mechanism.cap, e.mechanism.discount]) {
        for (const [k, d] of paramRows(map)) {
          expect(/^\d{8,}$/.test(d.text), `${e.id} ${k} = ${d.text}`).toBe(false)
        }
      }
    }
  })
})
