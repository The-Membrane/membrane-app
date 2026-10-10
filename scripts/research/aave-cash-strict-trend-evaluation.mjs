// Exploratory replay of a sealed trend rule against strict sampled first breach by H.
import { pathToFileURL } from 'node:url'
import { MARKETS, readCheckpoint } from './aave-stable-expansion.mjs'
import { MAX_GAP_SECONDS, SOURCE } from './aave-cash-horizon-labels.mjs'
import { evaluateStrictBreach, strictBreachSeries } from './aave-cash-strict-breach-backtest.mjs'
import { predictAnchor } from './aave-cash-trend-candidate.mjs'

const ARMS = ['trend', 'alwaysNoBreach', 'cashRatioBelowTwo']

export function evaluateStrictMarketSeries(rows, options) {
  const labels = strictBreachSeries(rows, options)
  const indexByBlock = new Map(rows.map((row, index) => [row.block, index]))
  return labels.map((label) => {
    const index = indexByBlock.get(label.anchorBlock)
    if (index === undefined) throw new Error('Strict label anchor absent from market series')
    return {
      label,
      predictions: {
        trend: predictAnchor(rows, index, options.amountUsd, options.horizonSeconds),
        alwaysNoBreach: false,
        cashRatioBelowTwo: rows[index].cashUsdAssumingPeg / options.amountUsd < 2,
      },
    }
  })
}

export function nonoverlapRecords(records) {
  const selected = []
  const lastWindowEnd = new Map()
  for (const record of [...records].sort(
    (a, b) => a.label.market.localeCompare(b.label.market) || a.label.anchorAt - b.label.anchorAt,
  )) {
    const { label } = record
    // Predeclared rule: include the earliest eligible anchor in each market
    // and split, then skip every anchor through its full H + 8h window.
    const key = `${label.market}:${label.split}`
    if (label.anchorAt <= (lastWindowEnd.get(key) ?? -Infinity)) continue
    selected.push(record)
    lastWindowEnd.set(key, label.targetAt + MAX_GAP_SECONDS)
  }
  return selected
}

export function scoreStrictRecords(records) {
  const labels = {
    eligible: records.length,
    observed: 0,
    breachedByH: 0,
    noSampledBreachByH: 0,
    censored: 0,
    pending: 0,
  }
  const arms = Object.fromEntries(
    ARMS.map((name) => [
      name,
      {
        tp: 0,
        fp: 0,
        tn: 0,
        fn: 0,
        abstainedObserved: 0,
        abstainedCensored: 0,
        abstainedPending: 0,
        warningsOnCensored: 0,
        warningsOnPending: 0,
      },
    ]),
  )
  for (const { label, predictions } of records) {
    if (label.status === 'observed') {
      labels.observed++
      labels[label.breachedByH ? 'breachedByH' : 'noSampledBreachByH']++
    } else if (label.status === 'censored' || label.status === 'pending') labels[label.status]++
    else throw new Error(`Unknown strict label status ${label.status}`)
    for (const name of ARMS) {
      const prediction = predictions[name]
      if (![true, false, null].includes(prediction)) throw new Error(`Invalid ${name} prediction`)
      const score = arms[name]
      if (label.status !== 'observed') {
        if (prediction === null)
          score[label.status === 'pending' ? 'abstainedPending' : 'abstainedCensored']++
        if (prediction === true)
          score[label.status === 'pending' ? 'warningsOnPending' : 'warningsOnCensored']++
      } else if (prediction === null) score.abstainedObserved++
      else if (prediction && label.breachedByH) score.tp++
      else if (prediction) score.fp++
      else if (label.breachedByH) score.fn++
      else score.tn++
    }
  }
  return { labels, ...arms }
}

export function evaluateStrictTrend(checkpoint, options) {
  // Authenticates the exact complete frozen cohort and split before replay.
  const provenance = evaluateStrictBreach(checkpoint, options)
  const pooled = { train: [], holdout: [] }
  const markets = {}
  for (const market of MARKETS) {
    const rows = checkpoint.entries
      .filter((row) => row.market === market.name)
      .sort((a, b) => a.block - b.block)
    const records = evaluateStrictMarketSeries(rows, {
      ...options,
      boundaryAt: provenance.boundaryAt,
    })
    markets[market.name] = {}
    for (const split of ['train', 'holdout']) {
      const splitRecords = records.filter((record) => record.label.split === split)
      pooled[split].push(...splitRecords)
      markets[market.name][split] = {
        allAnchors: scoreStrictRecords(splitRecords),
        nonoverlap: scoreStrictRecords(nonoverlapRecords(splitRecords)),
      }
    }
  }
  return {
    study: 'aave-v3-retrospective-strict-first-breach-trend-v1',
    exploratory: true,
    predictiveGatePassed: false,
    source: provenance.source,
    sourceEntriesSha256: provenance.sourceEntriesSha256,
    amountUsd: options.amountUsd,
    horizonSeconds: options.horizonSeconds,
    boundaryAt: provenance.boundaryAt,
    purgeSeconds: provenance.purgeSeconds,
    maxGapSeconds: provenance.maxGapSeconds,
    asOfAt: provenance.asOfAt,
    total: Object.fromEntries(
      ['train', 'holdout'].map((split) => [
        split,
        {
          allAnchors: scoreStrictRecords(pooled[split]),
          nonoverlap: scoreStrictRecords(nonoverlapRecords(pooled[split])),
        },
      ]),
    ),
    markets,
    caveats: [
      'The archived holdout has already been seen, and the trend rule was previously inspected against related endpoints; this is exploratory sensitivity, not blind validation.',
      'All-anchor counts overlap. Nonoverlap selects the earliest eligible anchor per market/split and excludes anchors through that anchor’s H + 8h window; it is a sensitivity count, not a probability estimate.',
      'Strict outcome is first sampled reserve cash below q at or before H on a complete observed path. It is not an unobserved crossing time or same-holder executable exit.',
      'The eight frozen markets exclude USDe; block timestamps cannot attest first local data availability at decision time.',
      'No calibrated risk, likely exit duration, forecast warning, or alert is enabled.',
    ],
  }
}

function cli(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (!['--amount-usd', '--horizon-hours', '--as-of'].includes(key) || argv[i + 1] === undefined)
      throw new Error(`Unknown or incomplete argument ${key}`)
    opts[key] = argv[++i]
  }
  if (!opts['--amount-usd'] || !opts['--horizon-hours'])
    throw new Error('Usage: --amount-usd Q --horizon-hours H [--as-of UnixSeconds]')
  const checkpoint = readCheckpoint(SOURCE)
  if (!checkpoint) throw new Error(`Missing verified source ${SOURCE}`)
  return evaluateStrictTrend(checkpoint, {
    amountUsd: Number(opts['--amount-usd']),
    horizonSeconds: Number(opts['--horizon-hours']) * 3600,
    asOfAt: opts['--as-of'] === undefined ? undefined : Number(opts['--as-of']),
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(cli(process.argv.slice(2))))
