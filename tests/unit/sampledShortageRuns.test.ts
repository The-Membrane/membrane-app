import { describe, expect, it } from 'vitest'
import { buildSampledShortageRuns } from '../../lib/carry/sampledShortageRuns'
const input = (possible: boolean[], definite = possible) => ({ horizonMs: (possible.length - 1) * 1000, checkpoints: possible.map((x, i) => ({ elapsedMs: i * 1000, possibleInsufficiency: x, definiteInsufficiency: definite[i] })) })
describe('modeled sampled shortage runs, recovery and horizon censors', () => {
  it('preserves a zero-time issue shortage and its bounded sampled recovery', () => {
    const r = buildSampledShortageRuns(input([true, true, false]))!
    expect(r.possible.runs).toEqual([{ onsetBracket: null, recoveryBracket: { earliestElapsedMs: 1000, latestElapsedMs: 2000 }, firstSampledInsufficiencyMs: 0, lastSampledInsufficiencyMs: 1000, sampleSpanDurationMs: 1000, leftCensored: true, rightCensored: false, guaranteedDurationMs: null }])
    expect(r.possible).toEqual(r.definite); expect(r.unknownBetweenCheckpoints).toBe(true)
  })
  it('retains previous-false onset and last-true recovery brackets', () => {
    const r = buildSampledShortageRuns(input([false, true, true, false]))!
    expect(r.possible.runs[0]).toMatchObject({ onsetBracket: { earliestElapsedMs: 0, latestElapsedMs: 1000 }, recoveryBracket: { earliestElapsedMs: 2000, latestElapsedMs: 3000 }, sampleSpanDurationMs: 1000, leftCensored: false, rightCensored: false })
  })
  it('retains two separate loss/recovery runs instead of a single continuous window', () => {
    const r = buildSampledShortageRuns(input([false, true, false, true, false]))!
    expect(r.possible.runs).toHaveLength(2)
    expect(r.possible.runs.map(x => [x.firstSampledInsufficiencyMs, x.lastSampledInsufficiencyMs, x.sampleSpanDurationMs])).toEqual([[1000, 1000, 0], [3000, 3000, 0]])
    expect(r.continuousProof).toBe(false); expect(r.measuredHistoryDuration).toBe(false)
  })
  it('keeps unfinished horizon loss right-censored, including one appearing at the final sample', () => {
    const r = buildSampledShortageRuns(input([false, false, true]))!
    expect(r.possible.runs[0]).toMatchObject({ firstSampledInsufficiencyMs: 2000, lastSampledInsufficiencyMs: 2000, sampleSpanDurationMs: 0, rightCensored: true, recoveryBracket: null })
    expect(r.possible.insufficientAtHorizon).toBe(true); expect(r.guaranteedDurationMs).toBeNull()
  })
  it('separates possible loss and recovery from a definite lane that never loses', () => {
    const r = buildSampledShortageRuns(input([false, true, false], [false, false, false]))!
    expect(r.possible.runs).toHaveLength(1); expect(r.definite.neverSampledInsufficient).toBe(true); expect(r.definite.runs).toEqual([])
    expect(r.maxCheckpointGapMs).toBe(1000); expect(r.modeled).toBe(true)
  })
  it('preserves both left and right censoring when shortage holds at every modeled checkpoint', () => {
    const r = buildSampledShortageRuns(input([true, true, true]))!
    expect(r.possible.runs[0]).toMatchObject({ leftCensored: true, rightCensored: true, onsetBracket: null, recoveryBracket: null, sampleSpanDurationMs: 2000 })
  })
  it.each(['nonchronological', 'definite without possible', 'missing horizon', 'extra field', 'more than65', 'sparse', 'accessor'])('denies %s without granting duration authority', kind => {
    const x = input([false, true, false]); let accessed = false
    if (kind === 'nonchronological') x.checkpoints[1].elapsedMs = 0
    if (kind === 'definite without possible') x.checkpoints[0].definiteInsufficiency = true
    if (kind === 'missing horizon') x.horizonMs++
    if (kind === 'extra field') Object.assign(x, { sourceApproved: true })
    if (kind === 'more than65') { x.checkpoints = Array.from({ length: 66 }, (_v, i) => ({ elapsedMs: i, possibleInsufficiency: false, definiteInsufficiency: false })); x.horizonMs = 65 }
    if (kind === 'sparse') delete (x.checkpoints as Partial<typeof x.checkpoints>)[1]
    if (kind === 'accessor') Object.defineProperty(x.checkpoints[1], 'possibleInsufficiency', { enumerable: true, get() { accessed = true; return true } })
    expect(buildSampledShortageRuns(x)).toBeNull(); expect(accessed).toBe(false)
  })
})
