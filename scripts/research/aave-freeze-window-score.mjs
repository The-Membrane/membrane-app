// Offline falsification of the frozen, exploratory Aave two-stage rule.
// The rule and the matched controls were selected before these missing dense
// windows were collected. Do not optimize the rule against their outcomes.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DAY, HOUR, empiricalQuantile, rollingSixHourDrops } from './aave-freeze-event-logic.mjs'

const Q = 100_000_000
const HOURS = [3, 6]
const MAX_GAP = 4 * HOUR
const CHECKPOINT_TOLERANCE = 90 * 60

function coverageFor(window) {
  const { anchorAt, anchorBlock } = window
  const start = anchorAt - 14 * DAY
  const rows = window.rows || []
  const pre = rows.filter((r) => r.at >= start - 7 * HOUR && r.at < anchorAt)
  const gaps = pre.slice(1).map((r, i) => r.at - pre[i].at)
  const anchor = rows.find((r) => r.block === anchorBlock)
  const coverage = {
    preRows: pre.length,
    firstPreAt: pre[0]?.at ?? null,
    lastPreAt: pre.at(-1)?.at ?? null,
    maxPreGapSeconds: gaps.length ? Math.max(...gaps) : null,
    anchorAt: anchor?.at ?? null,
    complete:
      window.coverage?.complete === true &&
      rows.length === window.coverage.scheduled &&
      rows.every((r) => r.status === 'ok' && Number.isFinite(r.cash)) &&
      rows.every((r, i) => i === 0 || r.at > rows[i - 1].at) &&
      pre.length >= 75 &&
      pre[0]?.at <= start + MAX_GAP &&
      pre.at(-1)?.at >= anchorAt - MAX_GAP &&
      gaps.length > 0 &&
      Math.max(...gaps) <= MAX_GAP &&
      anchor?.at === anchorAt,
  }
  return { coverage, pre }
}

function sampleNear(rows, targetAt) {
  const nearest = rows.reduce(
    (best, row) =>
      !best || Math.abs(row.at - targetAt) < Math.abs(best.at - targetAt) ? row : best,
    null,
  )
  return nearest && Math.abs(nearest.at - targetAt) <= CHECKPOINT_TOLERANCE ? nearest : null
}

export function scoreDenseWindow(window) {
  const { coverage, pre } = coverageFor(window)
  const base = {
    kind: window.kind,
    incidentAt: window.incidentAt,
    anchorAt: window.anchorAt,
    anchorBlock: window.anchorBlock,
    source: 'newly collected dense archive samples',
    coverage,
  }
  if (!coverage.complete) return { ...base, status: 'unscorable', reason: 'pre-anchor coverage' }
  const drops = rollingSixHourDrops(pre, window.anchorAt, 14)
  if (drops.length < 60)
    return { ...base, status: 'unscorable', reason: 'fewer than 60 valid six-hour pairs' }
  const p95 = empiricalQuantile(
    drops.map((r) => r.drop),
    0.95,
  )
  const checkpoints = []
  for (const hour of HOURS) {
    const now = sampleNear(window.rows, window.anchorAt + hour * HOUR)
    const prior = sampleNear(window.rows, window.anchorAt + (hour - 6) * HOUR)
    if (!now || !prior || now.at - prior.at < 5 * HOUR || now.at - prior.at > 7 * HOUR)
      return { ...base, status: 'unscorable', reason: `misaligned +${hour}h checkpoint` }
    const delta = prior.cash - now.cash
    checkpoints.push({
      hour,
      targetAt: window.anchorAt + hour * HOUR,
      prior: { block: prior.block, at: prior.at, cash: prior.cash, cashRaw: prior.cashRaw },
      now: { block: now.block, at: now.at, cash: now.cash, cashRaw: now.cashRaw },
      elapsedSeconds: now.at - prior.at,
      sixHourDropUsd: delta,
      flagged: delta > p95,
    })
  }
  return {
    ...base,
    status: 'scored',
    baseline: {
      definition: 'strictly pre-anchor 14-day empirical p95 of trailing six-hour cash drops',
      pairs: drops.length,
      p95Usd: p95,
      drops,
    },
    checkpoints,
    flagged: checkpoints.some((r) => r.flagged),
  }
}

function preserveApril(result, kind, incidentAt, anchorAt) {
  if (
    result.anchorAt !== anchorAt ||
    result.baseline !== '14d pre-anchor p95' ||
    !Number.isFinite(result.p95) ||
    !Array.isArray(result.checkpoints) ||
    result.checkpoints.length !== 2
  )
    throw new Error(`Missing or mismatched April ${kind} result`)
  return {
    kind,
    incidentAt,
    anchorAt,
    source: 'previously cached April two-stage result; not recomputed',
    status: 'scored',
    coverage: result.coverage,
    baseline: { definition: result.baseline, pairs: result.pairs, p95Usd: result.p95 },
    checkpoints: result.checkpoints.map((r) => ({ ...r, sixHourDropUsd: r.sixHourDrop })),
    flagged: result.checkpoints.some((r) => r.flagged),
  }
}

export function scoreExpanded({ windows, april, study }) {
  if (windows.status !== 'complete' || windows.windows?.length !== 6)
    throw new Error('Expected six complete missing incident/control windows')
  if (april.status !== 'complete' || !april.exploratory || study.status !== 'complete')
    throw new Error('Prior April and incident study must be complete')
  const eligible = study.incidents.filter((r) => r.response?.[Q]?.eligible)
  if (eligible.length !== 4 || eligible.some((r) => !r.control?.response?.[Q]?.eligible))
    throw new Error('Expected four q=$100m eligible incidents and matched controls')
  const distinct = new Set(windows.windows.map((w) => `${w.kind}:${w.incidentAt}`))
  if (distinct.size !== 6 || windows.windows.some((w) => !['incident', 'control'].includes(w.kind)))
    throw new Error('Duplicate or unexpected dense window')
  const results = []
  for (const incident of eligible) {
    for (const kind of ['incident', 'control']) {
      const anchorAt = kind === 'incident' ? incident.at : incident.control.at
      const anchorBlock = kind === 'incident' ? incident.block : incident.control.block
      const dense = windows.windows.find((w) => w.kind === kind && w.incidentAt === incident.at)
      let scored
      if (dense) {
        if (dense.anchorAt !== anchorAt || dense.anchorBlock !== anchorBlock)
          throw new Error(`Dense ${kind} anchor does not match frozen study`)
        scored = scoreDenseWindow(dense)
      } else {
        const prior = april.results.find((r) => r.anchorAt === anchorAt)
        if (incident.at !== 1776539039 || !prior)
          throw new Error(`Missing non-April dense ${kind} window`)
        scored = preserveApril(prior, kind, incident.at, anchorAt)
      }
      results.push({
        ...scored,
        crossedQ100m:
          kind === 'incident' ? incident.response[Q].crossed : incident.control.response[Q].crossed,
      })
    }
  }
  const scoredIncidents = results.filter((r) => r.kind === 'incident' && r.status === 'scored')
  const scoredControls = results.filter((r) => r.kind === 'control' && r.status === 'scored')
  const nonCrossingIncidentFlags = scoredIncidents.filter(
    (r) => r.flagged && !r.crossedQ100m,
  ).length
  return {
    status: results.every((r) => r.status === 'scored') ? 'complete' : 'partial',
    exploratory: true,
    ruleFrozenBeforeMissingWindowCollection: true,
    target: 'q=$100m USDe cash crossing at 6–24h sampled outcome points',
    signal:
      'cross-reserve positive freeze/pause, then at +3h or +6h past-six-hour USDe cash drop > strictly pre-anchor 14d p95',
    results,
    summary: {
      eligibleIncidents: eligible.length,
      eligibleControls: eligible.length,
      scoredIncidents: scoredIncidents.length,
      scoredControls: scoredControls.length,
      incidentFlags: scoredIncidents.filter((r) => r.flagged).length,
      incidentTruePositives: scoredIncidents.filter((r) => r.flagged && r.crossedQ100m).length,
      incidentFalsePositives: nonCrossingIncidentFlags,
      incidentFalseNegatives: scoredIncidents.filter((r) => !r.flagged && r.crossedQ100m).length,
      controlFlags: scoredControls.filter((r) => r.flagged).length,
      controlCrossings: scoredControls.filter((r) => r.crossedQ100m).length,
      retireCandidateAsAlert: nonCrossingIncidentFlags > 0,
      minimumSampleGatePassed:
        eligible.length >= 20 && scoredIncidents.length >= 20 && scoredControls.length >= 20,
    },
  }
}

function main() {
  const args = Object.fromEntries(
    process.argv
      .slice(2)
      .flatMap((arg, i, all) => (arg.startsWith('--') ? [[arg.slice(2), all[i + 1]]] : [])),
  )
  if (!args['windows-in'] || !args['april-in'] || !args['study-in'] || !args.out)
    throw new Error('Pass --windows-in, --april-in, --study-in, and --out')
  const result = scoreExpanded({
    windows: JSON.parse(readFileSync(args['windows-in'], 'utf8')),
    april: JSON.parse(readFileSync(args['april-in'], 'utf8')),
    study: JSON.parse(readFileSync(args['study-in'], 'utf8')),
  })
  const tmp = `${args.out}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(result))
  renameSync(tmp, args.out)
  console.log(JSON.stringify(result.summary, null, 2))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
