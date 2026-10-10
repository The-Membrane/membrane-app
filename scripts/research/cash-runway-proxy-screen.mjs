// Past-only, proxy-only falsification screen. No network access or tunable cohort.
import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  GRID,
  COUNT,
  readCheckpoint as readFive,
  score as scoreFive,
} from './multi-market-exit-prevalence.mjs'
import {
  readCheckpoint as readExpansion,
  score as scoreExpansion,
} from './aave-stable-expansion.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
export const INPUTS = Object.freeze({
  five: {
    path: join(ROOT, '../../data/research/venue-signals/multi-market-exit-prevalence.json'),
    sha256: 'c04b7b1b69d4f39fe8a534130506f3bedefc5ccdf3fe50f5e6815f77b5b0b03c',
  },
  expansion: {
    path: join(ROOT, '../../data/research/venue-signals/aave-stable-expansion-v2.json'),
    sha256: '2e5c47641b74f1c3d5b46cd23976c2ccd47e29a34cb8cd462a98a81ca3ea3849',
  },
})
export const DEFAULT_OUT = join(
  ROOT,
  '../../data/research/venue-signals/cash-runway-proxy-screen.json',
)
const Q = 1_000_000
const STEP = GRID.step
const SPLIT_BLOCK = GRID.first + Math.floor(COUNT * 0.7) * STEP
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const hash = (value) => sha(JSON.stringify(value))
const id = (row) => `${row.market}:${row.block}`
const finite = (v) => Number.isFinite(v)

function pinnedRead({ path, sha256 }, validate) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== sha256) throw new Error(`Frozen source byte SHA mismatch: ${path}`)
  const parsed = validate(path)
  if (!parsed || parsed.status !== 'complete') throw new Error(`Incomplete frozen source: ${path}`)
  return parsed
}

export function readSources() {
  return {
    five: pinnedRead(INPUTS.five, readFive),
    expansion: pinnedRead(INPUTS.expansion, readExpansion),
  }
}

export function deriveCohort(five, expansion) {
  const a = scoreFive(five.rows)
  const b = scoreExpansion(expansion)
  const cash = [],
    pause = []
  for (const result of [a, b])
    for (const [market, part] of Object.entries(result.markets)) {
      for (const cause of ['cash', 'pause']) {
        const target = cause === 'cash' ? cash : pause
        for (const event of part.scenarios['fixed-1m'][cause].events)
          target.push({ market, block: event.block, at: event.at, cause })
      }
    }
  const order = (x, y) => x.at - y.at || x.market.localeCompare(y.market) || x.block - y.block
  cash.sort(order)
  pause.sort(order)
  if (cash.length !== 31 || pause.length !== 4)
    throw new Error(`Frozen scorer cohort changed: ${cash.length} cash, ${pause.length} pause`)
  const all = [...cash, ...pause].sort(order)
  return { cash, pause, all }
}

// The exploratory calendar linkage is rolling: a new group starts only after
// the next onset is >48h after the previous onset. Include pause onsets so the
// group labels match the frozen 35-onset prevalence screen.
export function calendarGroups(all) {
  const ordered = [...all].sort((a, b) => a.at - b.at || a.market.localeCompare(b.market))
  const map = new Map()
  let group = -1,
    prior = null
  for (const e of ordered) {
    if (prior === null || e.at - prior > 48 * 3600) group++
    map.set(id(e), group)
    prior = e.at
  }
  return map
}

function rowReason(row, prefix) {
  if (!row) return `${prefix}-missing-row`
  if (row.kind === 'ineligible') return `${prefix}-${row.reason}`
  if (!finite(row.supplyUsdAssumingPeg) || row.supplyUsdAssumingPeg < Q)
    return `${prefix}-insufficient-supply`
  if (!row.active || row.withdrawPaused) return `${prefix}-inactive-or-paused`
  if (!finite(row.cashUsdAssumingPeg) || row.cashUsdAssumingPeg < Q)
    return `${prefix}-insufficient-cash`
  if (!Number.isSafeInteger(row.at)) return `${prefix}-missing-timestamp`
  return null
}

// Reads only the present row, its t-7200 history, and timestamp of the next
// grid row. The latter's cash, supply, and permission state are never features.
export function features(byBlock, block, prefix = 'event') {
  const now = byBlock.get(block)
  const reason = rowReason(now, prefix)
  if (reason) return { reason }
  const prior = byBlock.get(block - 7200)
  if (
    !prior ||
    prior.kind === 'ineligible' ||
    !finite(prior.cashUsdAssumingPeg) ||
    !Number.isSafeInteger(prior.at) ||
    prior.at >= now.at
  )
    return { reason: `${prefix}-missing-or-invalid-history` }
  const next = byBlock.get(block + STEP)
  if (!next || !Number.isSafeInteger(next.at) || next.at <= now.at)
    return { reason: `${prefix}-missing-or-invalid-lead-timestamp` }
  const leadSeconds = next.at - now.at
  if (leadSeconds < 6 * 3600) return { reason: `${prefix}-lead-under-six-hours`, leadSeconds }
  const cash = now.cashUsdAssumingPeg
  const historicalCash = prior.cashUsdAssumingPeg
  if (historicalCash === 0) return { reason: `${prefix}-zero-history-cash-drop-undefined` }
  const decrease = Math.max(0, historicalCash - cash)
  const elapsedHours = (now.at - prior.at) / 3600
  const outflow24 = decrease / elapsedHours
  const runwayHours = outflow24 === 0 ? 'Infinity' : (cash - Q) / outflow24
  return {
    at: now.at,
    historicalAt: prior.at,
    leadSeconds,
    cash,
    historicalCash,
    buffer: cash - Q,
    outflow24,
    runwayHours,
    cashHeadroom: cash / Q,
    cashDrop24: decrease / historicalCash,
  }
}

export function pairWin(event, control, key) {
  const left = event[key] === 'Infinity' ? Infinity : event[key]
  const right = control[key] === 'Infinity' ? Infinity : control[key]
  if (left === null || right === null || Number.isNaN(left) || Number.isNaN(right))
    throw new Error(`Invalid pair feature: ${key}`)
  const lowerRisk = key !== 'cashDrop24'
  return left === right ? 0.5 : (lowerRisk ? left < right : left > right) ? 1 : 0
}

const WIN_KEYS = ['runway', 'headroom', 'cashDrop']

export function pairWinSummary(records) {
  const eligible = records.filter((r) => r.eligible)
  const totals = Object.fromEntries(
    WIN_KEYS.map((key) => [key, eligible.reduce((sum, r) => sum + r.wins[key], 0)]),
  )
  const rates = Object.fromEntries(
    WIN_KEYS.map((key) => [key, eligible.length ? totals[key] / eligible.length : null]),
  )
  return { eligiblePairs: eligible.length, totals, rates }
}

export function evaluate(five, expansion) {
  const cohort = deriveCohort(five, expansion)
  const groups = calendarGroups(cohort.all)
  const rows = [...five.rows, ...expansion.entries]
  const byMarket = new Map()
  for (const r of rows) {
    if (!byMarket.has(r.market)) byMarket.set(r.market, new Map())
    byMarket.get(r.market).set(r.block, r)
  }
  const boundaryAt = rows.find((r) => r.block === SPLIT_BLOCK)?.at
  if (!Number.isSafeInteger(boundaryAt)) throw new Error('Missing frozen split timestamp')
  const marketCounts = new Map()
  for (const e of cohort.cash) marketCounts.set(e.market, (marketCounts.get(e.market) || 0) + 1)
  const records = cohort.cash.map((e) => {
    const market = byMarket.get(e.market)
    const anchorBlock = e.block - 3600
    const controlBlock = anchorBlock - 50400
    const event = features(market, anchorBlock, 'event')
    const control = features(market, controlBlock, 'control')
    const reason = event.reason || control.reason || null
    // This is annotation only. It never determines pair eligibility or rank.
    const futureControl = market.get(controlBlock + 3600)
    const controlFutureGridRowAdverseState =
      futureControl && futureControl.kind !== 'ineligible'
        ? futureControl.cashUsdAssumingPeg < Q ||
          futureControl.withdrawPaused ||
          !futureControl.active
        : null
    const split = e.at < boundaryAt ? 'train' : 'holdout'
    if (Math.abs(e.at - boundaryAt) <= 86400) throw new Error('Purged onset leaked from scorer')
    return {
      ...e,
      split,
      calendarGroup: groups.get(id(e)),
      repeatedMarketCashOnsets: marketCounts.get(e.market),
      anchorBlock,
      controlBlock,
      event,
      control,
      controlFutureGridBlock: controlBlock + 3600,
      controlFutureGridRowAdverseState,
      eligible: reason === null,
      reason,
      wins: reason
        ? null
        : {
            runway: pairWin(event, control, 'runwayHours'),
            headroom: pairWin(event, control, 'cashHeadroom'),
            cashDrop: pairWin(event, control, 'cashDrop24'),
          },
    }
  })
  const eligibleHoldout = records.filter((r) => r.split === 'holdout' && r.eligible)
  const groupSummaries = [...new Set(groups.values())].map((group) => {
    const members = cohort.all.filter((e) => groups.get(id(e)) === group)
    const cashRecords = records.filter((r) => r.calendarGroup === group)
    return {
      group,
      fromAt: members[0].at,
      throughAt: members.at(-1).at,
      markets: [...new Set(members.map((e) => e.market))].sort(),
      cashOnsets: cashRecords.length,
      pauseOnsets: members.length - cashRecords.length,
      eligibleCashPairs: cashRecords.filter((r) => r.eligible).length,
      holdoutCashPairs: cashRecords.filter((r) => r.split === 'holdout').length,
      pairWins: {
        all: pairWinSummary(cashRecords),
        train: pairWinSummary(cashRecords.filter((r) => r.split === 'train')),
        holdout: pairWinSummary(cashRecords.filter((r) => r.split === 'holdout')),
      },
    }
  })
  const marketSummaries = Object.fromEntries(
    [...marketCounts.keys()].sort().map((market) => {
      const own = records.filter((r) => r.market === market)
      return [
        market,
        {
          cashOnsets: own.length,
          eligiblePairs: own.filter((r) => r.eligible).length,
          holdoutPairs: own.filter((r) => r.split === 'holdout' && r.eligible).length,
          calendarGroups: new Set(own.map((r) => r.calendarGroup)).size,
          pairWins: {
            all: pairWinSummary(own),
            train: pairWinSummary(own.filter((r) => r.split === 'train')),
            holdout: pairWinSummary(own.filter((r) => r.split === 'holdout')),
          },
        },
      ]
    }),
  )
  const rates = pairWinSummary(eligibleHoldout).rates
  const holdoutGroups = new Set(eligibleHoldout.map((r) => r.calendarGroup)).size
  const holdoutEqualWeightGroupWinRates = Object.fromEntries(
    WIN_KEYS.map((key) => {
      const validGroups = groupSummaries.filter((g) => g.pairWins.holdout.eligiblePairs > 0)
      return [
        key,
        validGroups.length
          ? validGroups.reduce((sum, g) => sum + g.pairWins.holdout.rates[key], 0) /
            validGroups.length
          : null,
      ]
    }),
  )
  const gate =
    holdoutGroups < 5
      ? 'inconclusive-too-few-eligible-holdout-groups'
      : rates.runway >= 0.6 &&
          rates.runway - rates.headroom >= 0.1 &&
          rates.runway - rates.cashDrop >= 0.1
        ? 'proxy-triage-pass-only'
        : 'formula-retired'
  return {
    study: 'cash-runway-proxy-only-falsification-v1',
    caveat: 'Cash/pause proxy outcomes only; no historical holder-executable alert validation.',
    frozen: {
      q: Q,
      grid: GRID,
      splitBlock: SPLIT_BLOCK,
      boundaryAt,
      eventLagBlocks: 3600,
      historyLagBlocks: 7200,
      controlLagBlocks: 50400,
      purgeSeconds: 86400,
      groupLinkSeconds: 172800,
    },
    denominator: {
      cashOnsets: cohort.cash.length,
      pauseExcluded: cohort.pause.length,
      eligiblePairs: records.filter((r) => r.eligible).length,
      ineligiblePairs: records.filter((r) => !r.eligible).length,
      eligibleHoldoutPairs: eligibleHoldout.length,
      eligibleHoldoutCalendarGroups: holdoutGroups,
    },
    pairDenominatorInterpretation:
      'All 31 cash onsets retained; pair-win rates divide by eligible paired event/control anchors only. A missing or ineligible fixed control stays in the onset denominator.',
    pauseExcluded: cohort.pause,
    records,
    groupSummaries,
    marketSummaries,
    holdoutPairWinRates: rates,
    holdoutEqualWeightGroupWinRates,
    holdoutEqualWeightGroupSensitivityOnly: true,
    gate,
  }
}

export function checkpoint(
  result,
  inputSha256 = {
    five: INPUTS.five.sha256,
    expansion: INPUTS.expansion.sha256,
  },
) {
  const payload = { ...result, sourceByteSha256: inputSha256 }
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
    throw new Error('Cash-runway checkpoint corruption or frozen identity mismatch')
  return data
}

export function replayCheckpoint(data) {
  verifyCheckpoint(data)
  const { five, expansion } = readSources()
  const expected = checkpoint(evaluate(five, expansion))
  if (data.payloadSha256 !== expected.payloadSha256)
    throw new Error('Cash-runway checkpoint does not replay from frozen inputs')
  return data
}

export function run(out = DEFAULT_OUT) {
  if (!isAbsolute(out)) throw new Error('Output path must be absolute')
  const { five, expansion } = readSources()
  const data = verifyCheckpoint(checkpoint(evaluate(five, expansion)))
  const tmp = `${out}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, out)
  return data
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  if (args.length > 2 || (args.length && args[0] !== '--verify' && args[0] !== '--out'))
    throw new Error('Usage: node cash-runway-proxy-screen.mjs [--out ABS_PATH | --verify ABS_PATH]')
  const out = args[1] || DEFAULT_OUT
  const data =
    args[0] === '--verify' ? replayCheckpoint(JSON.parse(readFileSync(out, 'utf8'))) : run(out)
  console.log(
    JSON.stringify({
      out,
      payloadSha256: data.payloadSha256,
      denominator: data.denominator,
      holdoutPairWinRates: data.holdoutPairWinRates,
      gate: data.gate,
    }),
  )
}
