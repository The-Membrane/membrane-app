// Offline sampled reserve-cash persistence. This is not a holder exit-duration forecast.
// node scripts/research/aave-cash-shortage-durations.mjs --amount-usd 1000000
import { pathToFileURL } from 'node:url'
import {
  COUNT,
  GRID,
  MARKETS,
  readCheckpoint,
  validateCheckpoint,
} from './aave-stable-expansion.mjs'
import { MAX_GAP_SECONDS, SOURCE } from './aave-cash-horizon-labels.mjs'

export const EXPECTED_SOURCE_ENTRIES_SHA256 =
  '46833aba9b016e04abd3c621f2f5528cdd19b9fe33d964bb841884fa8d420856'

function validateAmount(amountUsd) {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0)
    throw new Error('amountUsd must be a finite number > 0')
}

function censorReason(row, gap) {
  if (!row) return 'series_edge'
  if (gap > MAX_GAP_SECONDS) return 'gap'
  if (row.kind !== 'observed') return 'ineligible_sample'
  return null
}

// Input may be a short synthetic series; the real checkpoint is separately validated.
export function analyzeMarketSeries(rows, { amountUsd }) {
  validateAmount(amountUsd)
  if (!Array.isArray(rows)) throw new Error('Market rows must be an array')
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!Number.isSafeInteger(row?.at) || row.at <= 0)
      throw new Error('Market timestamps must be positive Unix seconds')
    if (i && row.at <= rows[i - 1].at) throw new Error('Market rows must be time-ordered')
    if (row.kind !== 'observed' && row.kind !== 'ineligible')
      throw new Error('Market row kind must be observed or ineligible')
    if (
      row.kind === 'observed' &&
      (!Number.isFinite(row.cashUsdAssumingPeg) || row.cashUsdAssumingPeg < 0)
    )
      throw new Error('Observed cash must be finite and nonnegative')
  }
  const runs = []
  let observedSamples = 0
  let belowSamples = 0
  for (let i = 0; i < rows.length; i++) {
    const first = rows[i]
    if (first.kind !== 'observed') continue
    observedSamples++
    if (first.cashUsdAssumingPeg >= amountUsd) continue
    belowSamples++
    const prior = rows[i - 1]
    const leftReason = censorReason(prior, prior ? first.at - prior.at : Infinity)
    const leftBracketed = leftReason === null && prior.cashUsdAssumingPeg >= amountUsd
    // A preceding below-q row would have been part of this run. The branch
    // below only starts after an observed recovery, an edge, or a censor.
    let j = i
    while (j + 1 < rows.length) {
      const next = rows[j + 1]
      if (
        next.at - rows[j].at > MAX_GAP_SECONDS ||
        next.kind !== 'observed' ||
        next.cashUsdAssumingPeg >= amountUsd
      )
        break
      j++
      observedSamples++
      belowSamples++
    }
    const last = rows[j]
    const next = rows[j + 1]
    const rightReason = censorReason(next, next ? next.at - last.at : Infinity)
    const rightBracketed = rightReason === null && next.cashUsdAssumingPeg >= amountUsd
    runs.push({
      market: first.market,
      firstBelowAt: first.at,
      lastBelowAt: last.at,
      firstBelowBlock: first.block ?? null,
      lastBelowBlock: last.block ?? null,
      belowSampleCount: j - i + 1,
      sampledSpanHours: (last.at - first.at) / 3600,
      leftBracketed,
      leftCensorReason: leftBracketed ? null : leftReason,
      priorObservedAt: leftBracketed ? prior.at : null,
      leftBracketWidthHours: leftBracketed ? (first.at - prior.at) / 3600 : null,
      rightBracketed,
      rightCensorReason: rightBracketed ? null : rightReason,
      recoveryObservedAt: rightBracketed ? next.at : null,
      rightBracketWidthHours: rightBracketed ? (next.at - last.at) / 3600 : null,
      firstBelowToRecoveryHours: rightBracketed ? (next.at - first.at) / 3600 : null,
      fullyBracketed: leftBracketed && rightBracketed,
    })
    i = j
  }
  // Above loop skips a run's internal rows but still visits every observed
  // recovery row and every ineligible row.
  return { runs, observedSamples, belowSamples }
}

function percentile(sorted, p) {
  return sorted[Math.ceil(sorted.length * p) - 1]
}

export function summarizeTotal(analysis) {
  const { runs, observedSamples, belowSamples } = analysis
  const belowSamplesInCensoredRuns = runs
    .filter((run) => !run.fullyBracketed)
    .reduce((sum, run) => sum + run.belowSampleCount, 0)
  return {
    runCount: runs.length,
    fullyBracketedRunCount: runs.filter((run) => run.fullyBracketed).length,
    leftCensoredRunCount: runs.length - runs.filter((run) => run.leftBracketed).length,
    rightCensoredRunCount: runs.length - runs.filter((run) => run.rightBracketed).length,
    observedSamples,
    belowSamples,
    belowSamplesInCensoredRuns,
    fractionOfBelowSamplesInCensoredRuns: belowSamples
      ? belowSamplesInCensoredRuns / belowSamples
      : null,
    fractionOfObservedSamplesBelow: observedSamples ? belowSamples / observedSamples : null,
  }
}

export function summarizeMarket(analysis) {
  const full = analysis.runs.filter((run) => run.fullyBracketed)
  const durations = full.map((run) => run.firstBelowToRecoveryHours).sort((a, b) => a - b)
  return {
    ...summarizeTotal(analysis),
    fullyBracketedFirstBelowToRecoveryHours: durations.length
      ? {
          min: durations[0],
          median: percentile(durations, 0.5),
          p90: percentile(durations, 0.9),
          max: durations.at(-1),
        }
      : null,
    maxSampledRunSpanHours: analysis.runs.length
      ? Math.max(...analysis.runs.map((run) => run.sampledSpanHours))
      : null,
  }
}

export function evaluateShortageDurations(checkpoint, { amountUsd }) {
  validateAmount(amountUsd)
  validateCheckpoint(checkpoint)
  if (checkpoint.entriesSha256 !== EXPECTED_SOURCE_ENTRIES_SHA256)
    throw new Error('Aave cash source cohort digest differs from frozen local source')
  if (
    checkpoint.status !== 'complete' ||
    checkpoint.entries.length !== COUNT * MARKETS.length ||
    checkpoint.failures.length
  )
    throw new Error('Complete 1569-sample grid for all eight markets required')
  const markets = {}
  const allRuns = []
  let observedSamples = 0
  let belowSamples = 0
  for (const market of MARKETS) {
    const rows = checkpoint.entries
      .filter((row) => row.market === market.name)
      .sort((a, b) => a.block - b.block)
    if (rows.length !== COUNT) throw new Error(`Incomplete ${market.name} grid`)
    for (let i = 0; i < rows.length; i++)
      if (rows[i].block !== GRID.first + i * GRID.step)
        throw new Error(`Incomplete ${market.name} grid`)
    const analysis = analyzeMarketSeries(rows, { amountUsd })
    markets[market.name] = { summary: summarizeMarket(analysis), runs: analysis.runs }
    allRuns.push(...analysis.runs)
    observedSamples += analysis.observedSamples
    belowSamples += analysis.belowSamples
  }
  return {
    study: 'aave-v3-sampled-cash-shortage-persistence-v1',
    source: SOURCE,
    sourceEntriesSha256: checkpoint.entriesSha256,
    sourceAttestation: 'locally-hash-verified-checkpoint; not independently chain-attested',
    amountUsd,
    maxAdjacentSampleGapSeconds: MAX_GAP_SECONDS,
    markets,
    total: summarizeTotal({ runs: allRuns, observedSamples, belowSamples }),
    caveats: [
      'Only sampled reserve cash below the chosen amount is measured. This is not a holder-specific executable exit outcome.',
      'Cash may cross or recover between observations, and may fluctuate between them; runs are sampled persistence, not continuous shortage or true exit durations.',
      'First-below-to-recovery observation spans describe fully bracketed historical runs only; censored runs remain in run counts.',
      'Completed-run quantiles are selected toward recovered runs and are not typical or likely shortage durations. Duration statistics are per market only; do not pool unlike reserves for a forecast.',
      'These summaries are descriptive historical evidence, not calibrated forecast probabilities, alerts, or future duration estimates.',
    ],
  }
}

function cli(argv) {
  if (argv.length !== 2 || argv[0] !== '--amount-usd') throw new Error('Usage: --amount-usd Q')
  const checkpoint = readCheckpoint(SOURCE)
  if (!checkpoint) throw new Error(`Missing verified source ${SOURCE}`)
  return evaluateShortageDurations(checkpoint, { amountUsd: Number(argv[1]) })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(cli(process.argv.slice(2))))
