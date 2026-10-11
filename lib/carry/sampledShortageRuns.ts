/** Deterministic summaries of modeled checkpoints; no token, source or native authority. */
export type SampledShortageBracket = Readonly<{ earliestElapsedMs: number; latestElapsedMs: number }>
export type SampledShortageRun = Readonly<{
  onsetBracket: SampledShortageBracket | null
  recoveryBracket: SampledShortageBracket | null
  firstSampledInsufficiencyMs: number
  lastSampledInsufficiencyMs: number
  sampleSpanDurationMs: number
  leftCensored: boolean
  rightCensored: boolean
  guaranteedDurationMs: null
}>
export type SampledShortageLane = Readonly<{
  runs: readonly SampledShortageRun[]
  neverSampledInsufficient: boolean
  insufficientAtIssue: boolean
  insufficientAtHorizon: boolean
}>
export type SampledShortageRuns = Readonly<{
  possible: SampledShortageLane
  definite: SampledShortageLane
  maxCheckpointGapMs: number
  modeled: true
  unknownBetweenCheckpoints: true
  measuredHistoryDuration: false
  continuousProof: false
  guaranteedDurationMs: null
}>
type Checkpoint = Readonly<{ elapsedMs: number; possibleInsufficiency: boolean; definiteInsufficiency: boolean }>
function data(x: unknown, keys: string[]): x is Record<string, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x) || Object.getPrototypeOf(x) !== Object.prototype && Object.getPrototypeOf(x) !== null || Object.getOwnPropertySymbols(x).length) return false
  const ds = Object.getOwnPropertyDescriptors(x)
  return Object.keys(ds).length === keys.length && keys.every(k => ds[k] && Object.hasOwn(ds[k], 'value') && ds[k].enumerable)
}
function lane(points: readonly Checkpoint[], key: 'possibleInsufficiency' | 'definiteInsufficiency'): SampledShortageLane {
  const runs: SampledShortageRun[] = []
  let first = -1
  const retain = (last: number, recovery: number | null) => {
    const leftCensored = first === 0, rightCensored = recovery === null
    runs.push({ onsetBracket: leftCensored ? null : { earliestElapsedMs: points[first - 1].elapsedMs, latestElapsedMs: points[first].elapsedMs },
      recoveryBracket: recovery === null ? null : { earliestElapsedMs: points[last].elapsedMs, latestElapsedMs: points[recovery].elapsedMs },
      firstSampledInsufficiencyMs: points[first].elapsedMs, lastSampledInsufficiencyMs: points[last].elapsedMs,
      sampleSpanDurationMs: points[last].elapsedMs - points[first].elapsedMs, leftCensored, rightCensored, guaranteedDurationMs: null })
    first = -1
  }
  for (let i = 0; i < points.length; i++) {
    if (points[i][key] && first === -1) first = i
    if (!points[i][key] && first !== -1) retain(i - 1, i)
  }
  if (first !== -1) retain(points.length - 1, null)
  return { runs, neverSampledInsufficient: runs.length === 0, insufficientAtIssue: points[0][key], insufficientAtHorizon: points.at(-1)![key] }
}
export function buildSampledShortageRuns(value: unknown): SampledShortageRuns | null {
  try {
  if (!data(value, ['horizonMs', 'checkpoints']) || !Number.isSafeInteger(value.horizonMs) || Number(value.horizonMs) < 1 || Number(value.horizonMs) > 7 * 86400000 || !Array.isArray(value.checkpoints) || value.checkpoints.length < 2 || value.checkpoints.length > 65 || Object.keys(value.checkpoints).length !== value.checkpoints.length) return null
  if (Object.getPrototypeOf(value.checkpoints) !== Array.prototype || Object.getOwnPropertySymbols(value.checkpoints).length) return null
  const points: Checkpoint[] = [], horizon = Number(value.horizonMs)
  let previous = -1, gap = 0
  for (let i = 0; i < value.checkpoints.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value.checkpoints, String(i))
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null
    const p = descriptor.value
    if (!data(p, ['elapsedMs', 'possibleInsufficiency', 'definiteInsufficiency']) || !Number.isSafeInteger(p.elapsedMs) || Number(p.elapsedMs) <= previous || Number(p.elapsedMs) > horizon || i === 0 && p.elapsedMs !== 0 || typeof p.possibleInsufficiency !== 'boolean' || typeof p.definiteInsufficiency !== 'boolean' || p.definiteInsufficiency && !p.possibleInsufficiency) return null
    if (i) gap = Math.max(gap, Number(p.elapsedMs) - previous)
    previous = Number(p.elapsedMs)
    points.push({ elapsedMs: previous, possibleInsufficiency: p.possibleInsufficiency, definiteInsufficiency: p.definiteInsufficiency })
  }
  if (previous !== horizon) return null
  return { possible: lane(points, 'possibleInsufficiency'), definite: lane(points, 'definiteInsufficiency'), maxCheckpointGapMs: gap,
    modeled: true, unknownBetweenCheckpoints: true, measuredHistoryDuration: false, continuousProof: false, guaranteedDurationMs: null }
  } catch { return null }
}
