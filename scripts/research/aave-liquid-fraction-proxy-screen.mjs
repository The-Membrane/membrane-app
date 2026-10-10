// Historical proxy falsification only. No network, alert, or executable-exit claim.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { INPUTS, evaluate as evaluateRunway, readSources } from './cash-runway-proxy-screen.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const hash = (value) => sha(JSON.stringify(value))
const keys = ['liquidFraction', 'headroom', 'cashDrop']

export const DEFAULT_OUT = new URL(
  '../../data/research/venue-signals/aave-liquid-fraction-proxy-screen.json',
  import.meta.url,
).pathname

function sourceIndex({ five, expansion }) {
  const index = new Map()
  for (const row of [...five.rows, ...expansion.entries]) {
    const key = `${row.market}:${row.block}`
    if (index.has(key)) throw new Error(`Duplicate source anchor ${key}`)
    index.set(key, row)
  }
  return index
}

export function fractionAt(index, market, block, label) {
  const row = index.get(`${market}:${block}`)
  if (!row) return { value: null, reason: `${label}-missing-row` }
  if (row.market !== market || row.block !== block)
    return { value: null, reason: `${label}-identity-mismatch` }
  if (row.kind === 'ineligible') return { value: null, reason: `${label}-${row.reason}` }
  const cash = row.cashUsdAssumingPeg
  const supply = row.supplyUsdAssumingPeg
  if (!Number.isFinite(cash) || cash <= 0) return { value: null, reason: `${label}-invalid-cash` }
  if (!Number.isFinite(supply) || supply <= 0)
    return { value: null, reason: `${label}-invalid-supply` }
  const value = cash / supply
  if (!Number.isFinite(value)) return { value: null, reason: `${label}-invalid-ratio` }
  return { value, reason: null }
}

export function lowerFractionWin(event, control) {
  if (!Number.isFinite(event) || !Number.isFinite(control))
    throw new Error('Invalid liquid-fraction pair')
  return event === control ? 0.5 : event < control ? 1 : 0
}

export function matchedSummary(records) {
  const matched = records.filter((row) => row.eligible)
  const totals = Object.fromEntries(
    keys.map((key) => [key, matched.reduce((sum, row) => sum + row.wins[key], 0)]),
  )
  const rates = Object.fromEntries(
    keys.map((key) => [key, matched.length ? totals[key] / matched.length : null]),
  )
  return { eligiblePairs: matched.length, totals, rates }
}

// The base result is the frozen runway evaluator's output. Its control selection,
// onset denominator, timing, split, grouping, and baseline wins are not rerun here.
export function evaluate(base, sources) {
  const index = sourceIndex(sources)
  const records = base.records.map((row) => {
    if (!row.eligible)
      return {
        ...row,
        baseEligible: false,
        liquidFraction: null,
        liquidFractionReason: `base-${row.reason}`,
      }
    const event = fractionAt(index, row.market, row.anchorBlock, 'event')
    const control = fractionAt(index, row.market, row.controlBlock, 'control')
    const reason = event.reason || control.reason
    return {
      ...row,
      baseEligible: true,
      eligible: !reason,
      reason,
      liquidFraction: { event, control },
      liquidFractionReason: reason,
      // Keep the exact frozen baseline wins, even when the new ratio is invalid.
      wins: {
        ...row.wins,
        liquidFraction: reason ? null : lowerFractionWin(event.value, control.value),
      },
    }
  })
  const holdout = records.filter((row) => row.split === 'holdout' && row.eligible)
  const holdoutSummary = matchedSummary(holdout)
  const holdoutGroups = new Set(holdout.map((row) => row.calendarGroup)).size
  const groupSummaries = base.groupSummaries.map((group) => ({
    ...group,
    matchedPairWins: {
      all: matchedSummary(records.filter((row) => row.calendarGroup === group.group)),
      train: matchedSummary(
        records.filter((row) => row.calendarGroup === group.group && row.split === 'train'),
      ),
      holdout: matchedSummary(
        records.filter((row) => row.calendarGroup === group.group && row.split === 'holdout'),
      ),
    },
  }))
  const eligibleGroups = groupSummaries.filter(
    (group) => group.matchedPairWins.holdout.eligiblePairs,
  )
  const equalWeightGroupRates = Object.fromEntries(
    keys.map((key) => [
      key,
      eligibleGroups.length
        ? eligibleGroups.reduce((sum, group) => sum + group.matchedPairWins.holdout.rates[key], 0) /
          eligibleGroups.length
        : null,
    ]),
  )
  const matchedMarketSummaries = Object.fromEntries(
    [...new Set(records.map((row) => row.market))].sort().map((market) => {
      const own = records.filter((row) => row.market === market)
      return [
        market,
        {
          cashOnsets: own.length,
          all: matchedSummary(own),
          train: matchedSummary(own.filter((row) => row.split === 'train')),
          holdout: matchedSummary(own.filter((row) => row.split === 'holdout')),
        },
      ]
    }),
  )
  const { totals, eligiblePairs } = holdoutSummary
  const gate =
    holdoutGroups < 5
      ? 'inconclusive-too-few-eligible-holdout-groups'
      : totals.liquidFraction * 5 >= eligiblePairs * 3 &&
          (totals.liquidFraction - totals.headroom) * 10 >= eligiblePairs &&
          (totals.liquidFraction - totals.cashDrop) * 10 >= eligiblePairs
        ? 'proxy-triage-pass-only'
        : 'liquid-fraction-retired'

  return {
    study: 'aave-liquid-fraction-proxy-only-falsification-v1',
    caveat:
      'Historical development cash/pause proxies only; known holdout and no first-known or holder-executable validation.',
    frozen: base.frozen,
    denominator: {
      cashOnsets: base.denominator.cashOnsets,
      pauseExcluded: base.denominator.pauseExcluded,
      baseEligiblePairs: base.denominator.eligiblePairs,
      eligiblePairs: records.filter((row) => row.eligible).length,
      ineligiblePairs: records.filter((row) => !row.eligible).length,
      eligibleHoldoutPairs: eligiblePairs,
      eligibleHoldoutCalendarGroups: holdoutGroups,
    },
    pairDenominatorInterpretation:
      'All fixed cash onsets retained. Pair rates use only fixed event/control pairs with finite positive cash and supply at both same-block anchors.',
    pauseExcluded: base.pauseExcluded,
    records,
    groupSummaries,
    originalBaselineMarketSummaries: base.marketSummaries,
    matchedMarketSummaries,
    originalBaselineHoldoutPairWinRates: {
      headroom: base.holdoutPairWinRates.headroom,
      cashDrop: base.holdoutPairWinRates.cashDrop,
    },
    holdoutMatchedPairWinRates: holdoutSummary.rates,
    holdoutEqualWeightGroupWinRates: equalWeightGroupRates,
    holdoutEqualWeightGroupSensitivityOnly: true,
    gate,
  }
}

export function checkpoint(result) {
  const payload = {
    ...result,
    sourceByteSha256: { five: INPUTS.five.sha256, expansion: INPUTS.expansion.sha256 },
  }
  return { ...payload, payloadSha256: hash(payload) }
}

export function verifyCheckpoint(data) {
  const { payloadSha256, ...payload } = data || {}
  if (
    payloadSha256 !== hash(payload) ||
    payload.sourceByteSha256?.five !== INPUTS.five.sha256 ||
    payload.sourceByteSha256?.expansion !== INPUTS.expansion.sha256 ||
    payload.denominator?.cashOnsets !== 31 ||
    payload.denominator?.pauseExcluded !== 4 ||
    payload.records?.length !== 31 ||
    payload.pauseExcluded?.length !== 4
  )
    throw new Error('Liquid-fraction checkpoint corruption or frozen identity mismatch')
  return data
}

export function replayCheckpoint(data) {
  verifyCheckpoint(data)
  const sources = readSources()
  const expected = checkpoint(evaluate(evaluateRunway(sources.five, sources.expansion), sources))
  if (data.payloadSha256 !== expected.payloadSha256)
    throw new Error('Liquid-fraction checkpoint does not replay from frozen inputs')
  return data
}

export function run(out = DEFAULT_OUT) {
  if (!isAbsolute(out)) throw new Error('Output path must be absolute')
  const sources = readSources()
  const data = verifyCheckpoint(
    checkpoint(evaluate(evaluateRunway(sources.five, sources.expansion), sources)),
  )
  // Exclusive creation: a sealed result is never replaced by another run.
  writeFileSync(out, JSON.stringify(data), { flag: 'wx' })
  return data
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  if (args.length !== 2 || !['--run', '--verify'].includes(args[0]))
    throw new Error('Usage: node aave-liquid-fraction-proxy-screen.mjs [--run|--verify] ABS_PATH')
  const out = args[1]
  if (!isAbsolute(out)) throw new Error('Output path must be absolute')
  const data = args[0] === '--verify' ? replayCheckpoint(JSON.parse(readFileSync(out))) : run(out)
  console.log(
    JSON.stringify({
      out,
      physicalSha256: sha(readFileSync(out)),
      payloadSha256: data.payloadSha256,
      denominator: data.denominator,
      holdoutMatchedPairWinRates: data.holdoutMatchedPairWinRates,
      gate: data.gate,
    }),
  )
}
