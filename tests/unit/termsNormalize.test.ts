import { describe, expect, it } from 'vitest'

// plain .mjs module, exercised directly (same as alarms.test.ts)
import * as T from '../../scripts/lib/termsNormalize.mjs'

// The shape sky.money/susds renders (2026-09-25): a live rate and a live supply
// figure inside otherwise static terms text.
const page = (rate: string, supply: string, extra = '') => `<html><head><title>x</title></head><body>
  <div>sky.money does not control, set, or guarantee the rate.</div>
  <div><span>${rate}</span> APY</div><div>Total sUSDS supply <b>${supply}</b></div>
  <p>The Sky Savings Rate is currently ${rate} APY. ${extra}</p>
  <footer>© 2026 All rights reserved</footer></body></html>`

const hashOf = (html: string) => T.termsHash(T.termsText(html))

describe('termsText / termsHash', () => {
  it('live figures do not move the hash (the sUSDS flap)', () => {
    expect(hashOf(page('3.60%', '4.46B'))).toBe(hashOf(page('3.75%', '4.52B')))
    expect(hashOf(page('3.60%', '4.46B'))).toBe(hashOf(page('3.60%', '$4,461.2 million')))
  })

  it('the copyright year does not move the hash', () => {
    expect(hashOf(page('3.60%', '4.46B'))).toBe(hashOf(page('3.60%', '4.46B').replace('© 2026', '© 2027')))
  })

  it('terms edits still move it: fees, durations, wording', () => {
    const base = hashOf(page('3.60%', '4.46B', 'Withdrawals settle instantly.'))
    expect(hashOf(page('3.60%', '4.46B', 'Withdrawals settle after 7 days.'))).not.toBe(base)
    expect(hashOf(page('3.60%', '4.46B', 'Withdrawals settle instantly. A 0.5% fee applies.'))).not.toBe(base)
    expect(hashOf(page('3.60%', '4.46B', 'Withdrawals may be paused.'))).not.toBe(base)
  })

  it('an untagged percentage is a term, not a live figure', () => {
    expect(T.maskLiveFigures('exit fee 0.5% · 3.60% apy')).toBe('exit fee 0.5% · <rate> apy')
    expect(T.maskLiveFigures('apy: 4.1% then 12 days')).toBe('apy: <rate> then 12 days')
  })

  it('hashes are versioned', () => {
    expect(T.termsHash('x')).toMatch(/^v2:[0-9a-f]{64}$/)
    expect(T.isCurrentTermsHash(T.termsHash('x'))).toBe(true)
    expect(T.isCurrentTermsHash('5ef896f4af87985fac220337f3df5c99e90b3d8637155e510485db44141ce706')).toBe(false)
  })
})

describe('termsDecision', () => {
  const h = T.termsHash('a')
  it('first sight is a baseline', () => expect(T.termsDecision(null, h)).toBe('baseline'))
  it('an old-normalizer hash re-baselines instead of firing', () =>
    expect(T.termsDecision('5ef896f4af87985fac220337f3df5c99e90b3d8637155e510485db44141ce706', h)).toBe('rebaseline'))
  it('same hash is unchanged', () => expect(T.termsDecision(h, h)).toBe('unchanged'))
  it('a different current hash is a change', () => expect(T.termsDecision(h, T.termsHash('b'))).toBe('changed'))
})
