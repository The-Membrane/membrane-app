import { describe, expect, it } from 'vitest'
import { buildModeledShortageWindows, type ModeledShortageWindowsInput } from '../../lib/carry/modeledShortageWindows'
const fixture = (): ModeledShortageWindowsInput => ({ currentIdleCashRaw: '0', currentFullEaRaw: '260', idleCashDeltaRaw: '4', entitlementDeltaRaw: '-4', sourceAgeMs: 0, periodMs: 1000, horizonMs: 64000, requestedRaw: '129', competingMRaw: null })
const modeled = (x: ModeledShortageWindowsInput) => { const r = buildModeledShortageWindows(x)!; expect(r).not.toBeNull(); expect(r.status).toBe('modeled'); if (r.status !== 'modeled') throw Error('expected modeled'); return r }
describe('analytical weak-prong shortage windows within the signed-floor linear model', () => {
  it('finds hidden reopening between65 insufficient samples and preserves two exact modeled episodes', () => {
    const r = modeled(fixture())
    expect(r.adequacyWindow).toEqual({ firstIntegerAdequateMs: 32250, lastIntegerAdequateMs: 32750 })
    expect(r.windows.map(w => w.modeledDurationMs)).toEqual([{ lowerMs: 32250, upperMs: 32250 }, { lowerMs: 31250, upperMs: 31250 }])
    expect(r.windows.map(w => [w.leftCensored, w.rightCensored])).toEqual([[true, false], [false, true]])
    expect(r.windows.map(w => w.exactDuration)).toEqual([{ numerator: '32250', denominator: '1' }, { numerator: '31250', denominator: '1' }])
    expect(Array.from({ length: 65 }, (_v, i) => Math.min(Math.floor(4 * i), 260 + Math.floor(-4 * i)) < 129).every(Boolean)).toBe(true)
    expect(Math.min(Math.floor(4 * 32.5), 260 + Math.floor(-4 * 32.5))).toBe(130)
    expect(r.actualHistoricalContinuousDuration).toBe(false); expect(r.guaranteedDurationMs).toBeNull()
  })
  it('agrees with independent tiny-horizon integer enumeration across opposite and signed slopes', () => {
    for (const cash of [0, 3, 8]) for (const dc of [-3, 0, 2]) for (const de of [-2, 0, 3]) {
      const f = { ...fixture(), currentIdleCashRaw: String(cash), currentFullEaRaw: '5', idleCashDeltaRaw: String(dc), entitlementDeltaRaw: String(de), periodMs: 3, horizonMs: 8, sourceAgeMs: 2, requestedRaw: '3', competingMRaw: '1' }
      const r = modeled(f), adequate: number[] = []
      for (let t = 0; t <= f.horizonMs; t++) { const c = Math.max(0, cash + Math.floor(dc * (f.sourceAgeMs + t) / 3)), e = Math.max(0, 5 + Math.floor(de * (f.sourceAgeMs + t) / 3)); if (Math.min(Math.max(0, c - 1), e) >= 3) adequate.push(t) }
      expect(r.adequacyWindow).toEqual(adequate.length ? { firstIntegerAdequateMs: adequate[0], lastIntegerAdequateMs: adequate.at(-1) } : null)
      for (let t = 0; t <= f.horizonMs; t++) {
        const inShortage = r.windows.some(w => {
          const start = Number(w.exactStart.numerator) / Number(w.exactStart.denominator), end = Number(w.exactEnd.numerator) / Number(w.exactEnd.denominator)
          return (t > start || t === start && w.startIncluded) && (t < end || t === end && w.endIncluded)
        })
        expect(inShortage).toBe(!adequate.includes(t))
      }
      expect(r.searchIterations.cash).toBeLessThanOrEqual(31); expect(r.searchIterations.entitlement).toBeLessThanOrEqual(31)
      expect(r.windows.length).toBeLessThanOrEqual(2)
    }
  })
  it('does not erase a sub-millisecond modeled reopening when no integer sample is adequate', () => {
    const r = modeled({ ...fixture(), currentIdleCashRaw: '0', currentFullEaRaw: '3', idleCashDeltaRaw: '3', entitlementDeltaRaw: '-3', periodMs: 1, horizonMs: 2, requestedRaw: '1' })
    expect(r.exactAdequacyWindow).toEqual({ start: { numerator: '1', denominator: '3' }, end: { numerator: '2', denominator: '3' } })
    expect(r.adequacyWindow).toBeNull(); expect(r.windows).toHaveLength(2)
    expect(r.windows[0].modeledDurationMs).toEqual({ lowerMs: 0, upperMs: 1 })
  })
  it('keeps all-adequate and never-adequate outcomes, including edge censors', () => {
    const f = { ...fixture(), currentIdleCashRaw: '200', currentFullEaRaw: '200', idleCashDeltaRaw: '0', entitlementDeltaRaw: '0' }
    expect(modeled(f)).toMatchObject({ neverInsufficient: true, windows: [], adequacyWindow: { firstIntegerAdequateMs: 0, lastIntegerAdequateMs: 64000 } })
    f.currentIdleCashRaw = '0'; const r = modeled(f)
    expect(r.windows[0]).toMatchObject({ leftCensored: true, rightCensored: true, modeledDurationMs: { lowerMs: 64000, upperMs: 64000 } })
  })
  it('applies negative floor, source age and independent reserve once', () => {
    const r = modeled({ ...fixture(), currentIdleCashRaw: '10', currentFullEaRaw: '100', idleCashDeltaRaw: '-1', entitlementDeltaRaw: '0', periodMs: 3, sourceAgeMs: 1, horizonMs: 8, requestedRaw: '8', competingMRaw: '1' })
    expect(r.adequacyWindow).toEqual({ firstIntegerAdequateMs: 0, lastIntegerAdequateMs: 2 })
    expect(r.windows[0].exactStart).toEqual({ numerator: '2', denominator: '1' })
    expect(r.windows[0].modeledDurationMs).toEqual({ lowerMs: 6, upperMs: 6 })
  })
  it('keeps overflowing native-domain projection censored without finite windows', () => {
    const r = buildModeledShortageWindows({ ...fixture(), currentFullEaRaw: ((1n << 256n) - 1n).toString(), entitlementDeltaRaw: '1' })!
    expect(r).toMatchObject({ status: 'censored', reason: 'projected_stock_uint256_overflow', windows: null, adequacyWindow: null })
  })
  it('retains an isolated adequate instant as two distinct episodes with exact open loss boundaries', () => {
    const r = modeled({ ...fixture(), currentIdleCashRaw: '0', currentFullEaRaw: '2', idleCashDeltaRaw: '1', entitlementDeltaRaw: '-1', periodMs: 1, horizonMs: 2, requestedRaw: '1' })
    expect(r.exactAdequacyWindow).toEqual({ start: { numerator: '1', denominator: '1' }, end: { numerator: '1', denominator: '1' } })
    expect(r.windows.map(w => [w.startIncluded, w.endIncluded])).toEqual([[true, false], [false, true]])
    expect(r.windows.map(w => w.modeledDurationMs)).toEqual([{ lowerMs: 1, upperMs: 1 }, { lowerMs: 1, upperMs: 1 }])
  })
  it('bounds seven-day searches and refuses malformed scalars, clocks and accessors', () => {
    const r = modeled({ ...fixture(), horizonMs: 7 * 86400000 })
    expect(r.searchIterations.cash).toBeLessThanOrEqual(31); expect(r.searchIterations.entitlement).toBeLessThanOrEqual(31)
    for (const patch of [{ idleCashDeltaRaw: '-0' }, { currentFullEaRaw: '01' }, { sourceAgeMs: -1 }, { periodMs: 0 }, { horizonMs: 7 * 86400000 + 1 }]) expect(buildModeledShortageWindows({ ...fixture(), ...patch })).toBeNull()
    let accessed = false; const x = { ...fixture() }; Object.defineProperty(x, 'requestedRaw', { enumerable: true, get() { accessed = true; return '1' } })
    expect(buildModeledShortageWindows(x)).toBeNull(); expect(accessed).toBe(false)
  })
})
