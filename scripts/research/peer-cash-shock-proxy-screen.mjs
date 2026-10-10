// Offline falsification only: a same-asset peer cash drop is not an executable exit warning.
// The feature uses t-7,200 BLOCKS (four 1,800-block grid steps), not seconds.
import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COUNT,
  GRID,
  readCheckpoint as readBase,
  score as scoreBase,
} from './multi-market-exit-prevalence.mjs'
import { readCheckpoint as readExtra, score as scoreExtra } from './aave-stable-expansion.mjs'

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
export const PAIRS = Object.freeze([
  ['aave-usdc', 'cUSDCv3'],
  ['cUSDCv3', 'aave-usdc'],
  ['USDT', 'cUSDTv3'],
  ['cUSDTv3', 'USDT'],
  ['USDS', 'cUSDSv3'],
  ['cUSDSv3', 'USDS'],
])
export const Q = 1_000_000
export const SHOCK = 0.2
export const LOOKBACK_BLOCKS = 7_200
export const COOLDOWN_SECONDS = 24 * 3600
export const LEAD_SECONDS = 6 * 3600
export const HORIZON_SECONDS = 24 * 3600
export const GROUP_SECONDS = 48 * 3600
export const HEADROOM_CEILING = 1.5
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const eventKey = (event) => `${event.market}:${event.block}`
const week = (at) => Math.floor(at / (7 * 86400))
const splitAt = (at, boundaryAt) =>
  at < boundaryAt - 86400 ? 'train' : at > boundaryAt + 86400 ? 'holdout' : 'purged'
const observedKind = (row) => row.kind === undefined || row.kind === 'observed'
const eligible = (row) =>
  row &&
  observedKind(row) &&
  row.active === true &&
  row.withdrawPaused === false &&
  Number.isFinite(row.supplyUsdAssumingPeg) &&
  row.supplyUsdAssumingPeg >= Q &&
  Number.isFinite(row.cashUsdAssumingPeg) &&
  row.cashUsdAssumingPeg >= Q

export function pastCashDrop(current, prior, anchorAt) {
  if (!current || !prior) return { status: 'missingPeer' }
  if (
    !observedKind(current) ||
    !observedKind(prior) ||
    current.active !== true ||
    prior.active !== true ||
    current.withdrawPaused !== false ||
    prior.withdrawPaused !== false ||
    !Number.isFinite(current.cashUsdAssumingPeg) ||
    !Number.isFinite(prior.cashUsdAssumingPeg) ||
    prior.cashUsdAssumingPeg <= 0 ||
    !Number.isSafeInteger(current.at) ||
    !Number.isSafeInteger(prior.at) ||
    current.at > anchorAt ||
    prior.at >= current.at
  )
    return { status: 'invalidPeer' }
  return {
    status: 'scorable',
    drop: Math.max(
      0,
      (prior.cashUsdAssumingPeg - current.cashUsdAssumingPeg) / prior.cashUsdAssumingPeg,
    ),
    lookbackSeconds: current.at - prior.at,
  }
}

export function evaluateWarning(rows, index, eventByBlock, boundaryAt) {
  const anchor = rows[index],
    part = splitAt(anchor.at, boundaryAt)
  if (part === 'purged') return { status: 'boundaryPurge' }
  for (let n = 1; n <= 4; n++) {
    const next = rows[index + n],
      previous = rows[index + n - 1]
    if (
      !next ||
      !previous ||
      next.block !== anchor.block + n * GRID.step ||
      !observedKind(next) ||
      next.at <= previous.at ||
      next.at - previous.at > 8 * 3600
    )
      return { status: 'missingHorizon' }
    if (splitAt(next.at, boundaryAt) !== part) return { status: 'boundaryPurge' }
    if (!next.active || next.withdrawPaused) return { status: 'pauseInterference' }
    const event = eventByBlock.get(next.block)
    if (event) {
      const secondsToPreOnset = previous.at - anchor.at
      const secondsToOnset = event.at - anchor.at
      if (
        n >= 2 &&
        n <= 4 &&
        secondsToPreOnset >= LEAD_SECONDS &&
        secondsToOnset <= HORIZON_SECONDS
      )
        return { status: 'hit', event: eventKey(event), secondsToPreOnset, secondsToOnset }
      return { status: 'late', event: eventKey(event), secondsToPreOnset, secondsToOnset }
    }
    if (next.cashUsdAssumingPeg < Q) return { status: 'unlabelledLow' }
  }
  return { status: 'quietFalse', observedThroughSeconds: rows[index + 4].at - anchor.at }
}

export function groupEvents(events) {
  const groups = []
  for (const event of [...events].sort((a, b) => a.at - b.at || a.market.localeCompare(b.market))) {
    let group = groups.at(-1)
    if (!group || event.at - group.lastAt > GROUP_SECONDS) {
      group = { firstAt: event.at, lastAt: event.at, events: [] }
      groups.push(group)
    }
    group.lastAt = event.at
    group.events.push(eventKey(event))
  }
  return groups
}

function emptyTotals() {
  return {
    eligibleAnchors: 0,
    peerScorableAnchors: 0,
    candidateAnchors: 0,
    emittedWarnings: 0,
    hits: 0,
    late: 0,
    quietFalse: 0,
    scorableWarnings: 0,
    atRiskMarketWeeks: 0,
    exclusions: {
      missingPeer: 0,
      invalidPeer: 0,
      missingTargetHistory: 0,
      missingHorizon: 0,
      pauseInterference: 0,
      boundaryPurge: 0,
      unlabelledLow: 0,
    },
  }
}

function scoreRule({ rule, pairs, byMarket, eventMaps, boundaryAt, commonRows }) {
  const totals = { train: emptyTotals(), holdout: emptyTotals(), purged: emptyTotals() }
  const weeks = { train: new Set(), holdout: new Set(), purged: new Set() }
  const warnings = []
  for (const [target, peer] of pairs) {
    const rows = byMarket.get(target),
      events = eventMaps.get(target)
    let lastWarningAt = -Infinity
    for (let i = 0; i < rows.length; i++) {
      const anchor = rows[i]
      if (!eligible(anchor)) continue
      const part = splitAt(anchor.at, boundaryAt),
        t = totals[part]
      t.eligibleAnchors++
      weeks[part].add(`${target}:${week(anchor.at)}`)
      const common = commonRows.get(`${target}:${anchor.block}`)
      if (!common || common.status !== 'scorable') {
        t.exclusions[common?.status || 'missingPeer']++
        continue
      }
      t.peerScorableAnchors++
      if (rule === 'targetMomentum' && common.targetDrop?.status !== 'scorable') {
        t.exclusions.missingTargetHistory++
        continue
      }
      let signal
      if (rule === 'peerShock') signal = common.peerDrop >= SHOCK
      else if (rule === 'headroom') signal = anchor.cashUsdAssumingPeg < Q * HEADROOM_CEILING
      else if (rule === 'targetMomentum')
        signal = common.targetDrop?.status === 'scorable' && common.targetDrop.drop >= SHOCK
      else throw new Error('Unknown rule')
      if (!signal) continue
      t.candidateAnchors++
      if (anchor.at - lastWarningAt < COOLDOWN_SECONDS) continue
      lastWarningAt = anchor.at
      const verdict = evaluateWarning(rows, i, events, boundaryAt)
      t.emittedWarnings++
      if (verdict.status === 'hit') t.hits++
      else if (verdict.status === 'late') t.late++
      else if (verdict.status === 'quietFalse') t.quietFalse++
      else t.exclusions[verdict.status]++
      if (['hit', 'late', 'quietFalse'].includes(verdict.status)) t.scorableWarnings++
      warnings.push({
        rule,
        target,
        peer,
        block: anchor.block,
        at: anchor.at,
        split: part,
        peerDrop: common.peerDrop,
        peerLookbackSeconds: common.peerLookbackSeconds,
        targetDrop: common.targetDrop?.drop ?? null,
        ...verdict,
      })
    }
  }
  const hitKeys = new Set(warnings.filter((w) => w.status === 'hit').map((w) => w.event))
  const sections = {}
  for (const part of ['train', 'holdout']) {
    const events = [...eventMaps.values()]
      .flatMap((map) => [...map.values()])
      .filter((e) => splitAt(e.at, boundaryAt) === part)
    const groups = groupEvents(events)
    const hitGroups = groups.filter((group) => group.events.some((key) => hitKeys.has(key)))
    const t = totals[part]
    sections[part] = {
      ...t,
      atRiskMarketWeeks: weeks[part].size,
      cashOnsets: events.length,
      cashGroups48h: groups.length,
      hitOnsets: events.filter((e) => hitKeys.has(eventKey(e))).length,
      hitGroups48h: hitGroups.length,
      scorablePrecision: t.hits / Math.max(1, t.scorableWarnings),
      onsetRecall:
        events.filter((e) => hitKeys.has(eventKey(e))).length / Math.max(1, events.length),
      groupRecall: hitGroups.length / Math.max(1, groups.length),
      quietFalsePerMarketWeek: t.quietFalse / Math.max(1, weeks[part].size),
      allNonhitsPerMarketWeek: (t.late + t.quietFalse) / Math.max(1, weeks[part].size),
    }
  }
  return { rule, train: sections.train, holdout: sections.holdout, purged: totals.purged, warnings }
}

export function screen(rows, cashEvents, boundaryAt, pairs = PAIRS) {
  if (!Number.isSafeInteger(boundaryAt)) throw new Error('Missing chronological boundary timestamp')
  const names = new Set(pairs.flat())
  if (pairs.length !== 6 || names.size !== 6)
    throw new Error('Expected six fixed directional pair markets')
  const byMarket = new Map([...names].map((name) => [name, []]))
  const seen = new Set()
  for (const row of rows) {
    if (!byMarket.has(row.market)) throw new Error('Unknown paired market')
    const key = `${row.market}:${row.block}`
    if (seen.has(key)) throw new Error('Duplicate paired market row')
    seen.add(key)
    byMarket.get(row.market).push(row)
  }
  for (const [market, marketRows] of byMarket) {
    if (marketRows.length !== COUNT) throw new Error(`Incomplete paired market: ${market}`)
    marketRows.sort((a, b) => a.block - b.block)
  }
  const eventMaps = new Map([...names].map((name) => [name, new Map()]))
  for (const event of cashEvents) {
    const map = eventMaps.get(event.market)
    if (!map || map.has(event.block)) throw new Error('Unknown/duplicate paired cash onset')
    map.set(event.block, event)
  }
  const mapByBlock = new Map(
    [...byMarket].map(([name, marketRows]) => [
      name,
      new Map(marketRows.map((row) => [row.block, row])),
    ]),
  )
  const commonRows = new Map(),
    missing = { missingPeer: 0, invalidPeer: 0 }
  for (const [target, peer] of pairs) {
    for (const anchor of byMarket.get(target)) {
      if (!eligible(anchor)) continue
      const peerRows = mapByBlock.get(peer)
      const feature = pastCashDrop(
        peerRows.get(anchor.block),
        peerRows.get(anchor.block - LOOKBACK_BLOCKS),
        anchor.at,
      )
      const targetRows = mapByBlock.get(target)
      const targetDrop = pastCashDrop(
        anchor,
        targetRows.get(anchor.block - LOOKBACK_BLOCKS),
        anchor.at,
      )
      if (feature.status !== 'scorable') missing[feature.status]++
      commonRows.set(`${target}:${anchor.block}`, {
        status: feature.status,
        peerDrop: feature.drop ?? null,
        peerLookbackSeconds: feature.lookbackSeconds ?? null,
        targetDrop,
      })
    }
  }
  const rules = Object.fromEntries(
    ['peerShock', 'headroom', 'targetMomentum'].map((rule) => [
      rule,
      scoreRule({ rule, pairs, byMarket, eventMaps, boundaryAt, commonRows }),
    ]),
  )
  const peer = rules.peerShock
  const pooledScorable = peer.train.scorableWarnings + peer.holdout.scorableWarnings
  const pooledHits = peer.train.hits + peer.holdout.hits
  const pooledNonhits =
    peer.train.late + peer.train.quietFalse + peer.holdout.late + peer.holdout.quietFalse
  const pooledWeeks = new Set(
    rows
      .filter((row) => eligible(row) && splitAt(row.at, boundaryAt) !== 'purged')
      .map((row) => `${row.market}:${week(row.at)}`),
  ).size
  const pooledPrecision = pooledScorable ? pooledHits / pooledScorable : null
  const falsePerWeek = pooledNonhits / Math.max(1, pooledWeeks)
  const retired = pooledScorable > 0 && (pooledPrecision < 0.5 || falsePerWeek > 1)
  return {
    parameters: {
      qUsdAssumingPeg: Q,
      shockThreshold: SHOCK,
      lookbackBlocks: LOOKBACK_BLOCKS,
      cooldownSeconds: COOLDOWN_SECONDS,
      leadToPreOnsetSeconds: LEAD_SECONDS,
      horizonSeconds: HORIZON_SECONDS,
      groupSeconds: GROUP_SECONDS,
      headroomCeiling: HEADROOM_CEILING,
    },
    boundaryAt,
    coverage: {
      markets: names.size,
      rows: rows.length,
      expectedRows: names.size * COUNT,
      cashOnsets: cashEvents.length,
      peerMissingness: missing,
    },
    rules,
    pooledScorable: {
      warnings: pooledScorable,
      hits: pooledHits,
      nonhits: pooledNonhits,
      atRiskMarketWeeks: pooledWeeks,
      precision: pooledPrecision,
      nonhitsPerMarketWeek: falsePerWeek,
    },
    exploratoryFalsification: {
      retired,
      reason: !pooledScorable
        ? 'no-scorable-warnings'
        : pooledPrecision < 0.5
          ? 'pooled-scorable-precision-below-50pct'
          : falsePerWeek > 1
            ? 'nonhits-over-one-per-at-risk-market-week'
            : 'not-retired-by-fixed-noise-rule-only',
      notShippingGate: true,
    },
    caveat:
      'Pinned cash/permission proxy only; no executable wallet exit outcome. Pooled event count is too small for validated prediction, and holdout was previously inspected.',
  }
}

export function run() {
  const [baseFile, extraFile] = SOURCES.map((source) => {
    const bytes = readFileSync(source.path)
    if (hash(bytes) !== source.sha256) throw new Error('Frozen source SHA mismatch')
    return source.path
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
  const boundaryAt = base.rows.find((row) => row.block === boundaryBlock)?.at
  if (!boundaryAt || extra.entries.find((row) => row.block === boundaryBlock)?.at !== boundaryAt)
    throw new Error('Source boundary disagreement')
  const names = new Set(PAIRS.flat())
  const cashEvents = [baseScore, extraScore].flatMap((score) =>
    Object.entries(score.markets)
      .filter(([name]) => names.has(name))
      .flatMap(([, market]) => market.scenarios['fixed-1m'].cash.events),
  )
  if (cashEvents.length !== 17) throw new Error('Frozen paired-onset count drift')
  const rows = [...base.rows, ...extra.entries].filter((row) => names.has(row.market))
  const result = screen(rows, cashEvents, boundaryAt)
  return {
    study: 'same-asset-peer-cash-shock-proxy-screen-v1',
    sourceSha256: SOURCES.map((source) => ({
      file: source.path.split('/').at(-1),
      sha256: source.sha256,
    })),
    ...result,
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length !== 2 && !(process.argv.length === 3 && process.argv[2] === '--verify'))
    throw new Error('Only offline run or --verify is supported')
  const out = join(DIR, '../../data/research/venue-signals/peer-cash-shock-proxy-screen.json')
  const result = run()
  if (process.argv[2] === '--verify') {
    const saved = JSON.parse(readFileSync(out, 'utf8'))
    if (hash(JSON.stringify(saved)) !== hash(JSON.stringify(result)))
      throw new Error('Output/source replay mismatch')
  } else {
    const temp = `${out}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(result), { mode: 0o600 })
    renameSync(temp, out)
  }
  console.log(
    JSON.stringify({
      output: out,
      outputSha256: hash(readFileSync(out)),
      coverage: result.coverage,
      pooledScorable: result.pooledScorable,
      exploratoryFalsification: result.exploratoryFalsification,
    }),
  )
}
