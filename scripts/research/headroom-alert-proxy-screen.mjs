// Offline falsification of the fixed $1m, 1.5x cash-headroom warning.
// The held-out period was previously inspected; this is exploratory proxy evidence only.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  COUNT,
  GRID,
  MARKETS as BASE_MARKETS,
  readCheckpoint as readBase,
  score as scoreBase,
} from './multi-market-exit-prevalence.mjs'
import {
  MARKETS as EXTRA_MARKETS,
  readCheckpoint as readExtra,
  score as scoreExtra,
} from './aave-stable-expansion.mjs'

const DIR = dirname(fileURLToPath(import.meta.url))
export const SOURCES = Object.freeze([
  {
    path: join(DIR, '../../data/research/venue-signals/multi-market-exit-prevalence.json'),
    sha256: 'c04b7b1b69d4f39fe8a534130506f3bedefc5ccdf3fe50f5e6815f77b5b0b03c',
  },
  {
    path: join(DIR, '../../data/research/venue-signals/aave-stable-expansion-v2.json'),
    sha256: '2e5c47641b74f1c3d5b46cd23976c2ccd47e29a34cb8cd462a98a81ca3ea3849',
  },
])
export const Q = 1_000_000
export const HEADROOM_CEILING = 1.5
export const COOLDOWN_SECONDS = 86400
export const LEAD_SECONDS = 6 * 3600
export const GROUP_SECONDS = 48 * 3600
const hash = (x) => createHash('sha256').update(x).digest('hex')
const key = (e) => `${e.market}:${e.block}`
const splitAt = (at, boundaryAt) =>
  at < boundaryAt - 86400 ? 'train' : at > boundaryAt + 86400 ? 'holdout' : 'purged'
const eligible = (r) =>
  r &&
  r.kind !== 'ineligible' &&
  r.active &&
  !r.withdrawPaused &&
  r.supplyUsdAssumingPeg >= Q &&
  r.cashUsdAssumingPeg >= Q
const week = (at) => Math.floor(at / (7 * 86400))

export function groupEvents(events) {
  const sorted = [...events].sort((a, b) => a.at - b.at || a.market.localeCompare(b.market))
  const groups = []
  for (const event of sorted) {
    let group = groups.at(-1)
    if (!group || event.at - group.lastAt > GROUP_SECONDS) {
      group = { firstAt: event.at, lastAt: event.at, events: [] }
      groups.push(group)
    }
    group.lastAt = event.at
    group.events.push(key(event))
  }
  return groups
}

export function evaluateWarning(rows, index, eventByBlock, boundaryAt) {
  const anchor = rows[index]
  const part = splitAt(anchor.at, boundaryAt)
  if (part === 'purged') return { status: 'boundaryPurge' }
  let first = null
  for (let n = 1; n <= 4; n++) {
    const next = rows[index + n]
    if (
      !next ||
      next.block !== anchor.block + n * GRID.step ||
      next.at <= rows[index + n - 1].at ||
      next.at - rows[index + n - 1].at > 8 * 3600 ||
      next.kind === 'ineligible'
    )
      return { status: 'missingHorizon' }
    if (splitAt(next.at, boundaryAt) !== part) return { status: 'boundaryPurge' }
    if (next.withdrawPaused || !next.active) return { status: 'pauseInterference' }
    if (eventByBlock.has(next.block)) {
      first = { event: eventByBlock.get(next.block), n, previous: rows[index + n - 1] }
      break
    }
  }
  if (!first) return { status: 'false' }
  if (
    first.n >= 2 &&
    first.n <= 4 &&
    first.event.at - anchor.at <= COOLDOWN_SECONDS &&
    first.previous.at - anchor.at >= LEAD_SECONDS
  )
    return {
      status: 'hit',
      event: key(first.event),
      leadToPreOnsetSeconds: first.previous.at - anchor.at,
    }
  return { status: 'false', firstOnset: key(first.event), reason: 'late' }
}

export function screen(rows, cashEvents, pauseEvents, boundaryAt, expectedMarkets = null) {
  if (!Number.isSafeInteger(boundaryAt)) throw new Error('Missing chronological boundary timestamp')
  const names = expectedMarkets ?? [...new Set(rows.map((r) => r.market))].sort()
  const seen = new Set(),
    allCash = new Map(),
    allPause = new Set()
  for (const event of cashEvents) {
    if (allCash.has(key(event))) throw new Error('Duplicate cash onset')
    allCash.set(key(event), event)
  }
  for (const event of pauseEvents) {
    if (allPause.has(key(event))) throw new Error('Duplicate pause onset')
    allPause.add(key(event))
  }
  const byMarket = new Map(names.map((m) => [m, []]))
  for (const row of rows) {
    if (!byMarket.has(row.market) || seen.has(key(row)))
      throw new Error('Unknown/duplicate market row')
    seen.add(key(row))
    byMarket.get(row.market).push(row)
  }
  const totals = Object.fromEntries(
    ['train', 'holdout', 'purged'].map((part) => [
      part,
      {
        eligibleAnchors: 0,
        candidateAnchors: 0,
        warnings: 0,
        hits: 0,
        falseWarnings: 0,
        exclusions: { missingHorizon: 0, pauseInterference: 0, boundaryPurge: 0 },
        atRiskMarketWeeks: 0,
      },
    ]),
  )
  const weeks = { train: new Set(), holdout: new Set(), purged: new Set() }
  const warnings = []
  for (const [market, marketRows] of byMarket) {
    marketRows.sort((a, b) => a.block - b.block)
    const events = new Map(cashEvents.filter((e) => e.market === market).map((e) => [e.block, e]))
    let lastWarningAt = -Infinity
    for (let i = 0; i < marketRows.length; i++) {
      const r = marketRows[i]
      if (!eligible(r)) continue
      const part = splitAt(r.at, boundaryAt)
      totals[part].eligibleAnchors++
      weeks[part].add(`${market}:${week(r.at)}`)
      if (r.cashUsdAssumingPeg >= Q * HEADROOM_CEILING) continue
      totals[part].candidateAnchors++
      if (r.at - lastWarningAt < COOLDOWN_SECONDS) continue
      lastWarningAt = r.at
      const verdict = evaluateWarning(marketRows, i, events, boundaryAt)
      const w = {
        market,
        block: r.block,
        at: r.at,
        split: part,
        cashUsdAssumingPeg: r.cashUsdAssumingPeg,
        ...verdict,
      }
      warnings.push(w)
      totals[part].warnings++
      if (verdict.status === 'hit') totals[part].hits++
      else if (verdict.status === 'false') totals[part].falseWarnings++
      else totals[part].exclusions[verdict.status]++
    }
  }
  const retainedCash = cashEvents.filter((e) => splitAt(e.at, boundaryAt) !== 'purged')
  const groups = {
    train: groupEvents(retainedCash.filter((e) => splitAt(e.at, boundaryAt) === 'train')),
    holdout: groupEvents(retainedCash.filter((e) => splitAt(e.at, boundaryAt) === 'holdout')),
  }
  const hitKeys = new Set(warnings.filter((w) => w.status === 'hit').map((w) => w.event))
  const sections = {}
  for (const part of ['train', 'holdout']) {
    const t = totals[part],
      events = retainedCash.filter((e) => splitAt(e.at, boundaryAt) === part)
    const groupSet = groups[part]
    const hitGroups = groupSet.filter((g) => g.events.some((k) => hitKeys.has(k)))
    sections[part] = {
      ...t,
      atRiskMarketWeeks: weeks[part].size,
      cashOnsets: events.length,
      hitOnsets: events.filter((e) => hitKeys.has(key(e))).length,
      cashGroups48h: groupSet.length,
      hitGroups48h: hitGroups.length,
      warningPrecision: t.hits / Math.max(1, t.hits + t.falseWarnings),
      onsetRecall: events.filter((e) => hitKeys.has(key(e))).length / Math.max(1, events.length),
      groupRecall: hitGroups.length / Math.max(1, groupSet.length),
      falseWarningsPerMarketWeek: t.falseWarnings / Math.max(1, weeks[part].size),
    }
  }
  const h = sections.holdout
  const gate =
    h.cashGroups48h >= 5 &&
    h.warningPrecision >= 0.5 &&
    h.groupRecall >= 0.5 &&
    h.falseWarningsPerMarketWeek <= 1
  return {
    parameters: {
      q: Q,
      headroomCeiling: HEADROOM_CEILING,
      cooldownSeconds: COOLDOWN_SECONDS,
      leadToPreOnsetSeconds: LEAD_SECONDS,
      groupSeconds: GROUP_SECONDS,
    },
    boundaryAt,
    coverage: {
      markets: names.length,
      rows: rows.length,
      expectedRows: names.length * COUNT,
      cashOnsets: cashEvents.length,
      pauseOnsets: pauseEvents.length,
    },
    train: sections.train,
    holdout: sections.holdout,
    purged: totals.purged,
    groups,
    warnings,
    exploratoryTriage: {
      minimumHoldoutGroups: h.cashGroups48h >= 5,
      passed: gate,
      disposition: gate ? 'candidate-for-fresh-executable-study' : 'retire-fixed-1.5x-warning',
    },
    caveat:
      'Cash/permission proxy only; reused holdout was inspected before this candidate was frozen. No executable-outcome or product alert validation.',
  }
}

export function run() {
  const [baseFile, extraFile] = SOURCES.map((s) => {
    const bytes = readFileSync(s.path)
    if (hash(bytes) !== s.sha256) throw new Error(`Frozen source SHA mismatch: ${s.path}`)
    return s.path
  })
  const base = readBase(baseFile),
    extra = readExtra(extraFile)
  if (base?.status !== 'complete' || extra?.status !== 'complete')
    throw new Error('Incomplete source checkpoint')
  const baseScore = scoreBase(base.rows),
    extraScore = scoreExtra(extra)
  if (baseScore.status !== 'complete' || extraScore.status !== 'complete')
    throw new Error('Incomplete source score')
  const boundaryBlock = GRID.first + Math.floor(COUNT * 0.7) * GRID.step
  const boundaryAt = base.rows.find((r) => r.block === boundaryBlock)?.at
  if (!boundaryAt || extra.entries.find((r) => r.block === boundaryBlock)?.at !== boundaryAt)
    throw new Error('Source boundary disagreement')
  const markets = [...BASE_MARKETS.map((m) => m.name), ...EXTRA_MARKETS.map((m) => m.name)]
  const scores = [baseScore, extraScore],
    cash = [],
    pause = []
  for (const score of scores)
    for (const market of Object.values(score.markets)) {
      cash.push(...market.scenarios['fixed-1m'].cash.events)
      pause.push(...market.scenarios['fixed-1m'].pause.events)
    }
  const result = screen([...base.rows, ...extra.entries], cash, pause, boundaryAt, markets)
  if (
    result.coverage.rows !== result.coverage.expectedRows ||
    result.coverage.cashOnsets !== 31 ||
    result.coverage.pauseOnsets !== 4
  )
    throw new Error('Frozen cohort/scorer count drift')
  return {
    study: 'fixed-headroom-alert-proxy-screen-v1',
    sourceSha256: SOURCES.map(({ path, sha256 }) => ({ file: path.split('/').at(-1), sha256 })),
    ...result,
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length !== 2 && !(process.argv.length === 3 && process.argv[2] === '--verify'))
    throw new Error('Only offline run or --verify is supported')
  const out = join(DIR, '../../data/research/venue-signals/headroom-alert-proxy-screen.json')
  const result = run()
  if (process.argv[2] === '--verify') {
    const saved = JSON.parse(readFileSync(out, 'utf8'))
    if (hash(JSON.stringify(saved)) !== hash(JSON.stringify(result)))
      throw new Error('Output/source replay mismatch')
  } else writeFileSync(out, JSON.stringify(result))
  console.log(
    JSON.stringify({
      output: out,
      outputSha256: hash(readFileSync(out)),
      train: result.train,
      holdout: result.holdout,
      exploratoryTriage: result.exploratoryTriage,
    }),
  )
}
