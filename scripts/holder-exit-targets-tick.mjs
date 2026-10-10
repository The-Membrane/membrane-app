// One bounded Mac schedule for existing prospective holder observations.
// Quiet ticks never construct RPC clients or write a ledger.
import { execFile } from 'node:child_process'
import { readdir, statfs } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  preflight as scrvusdPreflight,
  tick as tickScrvusd,
} from './scrvusd-target-window-tick.mjs'

const exec = promisify(execFile)
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const MORPHO_QUEUE = join(ROOT, 'data/research/venue-signals/carry-morpho-requested-intake-v1')
const MORPHO_ISSUES = join(
  ROOT,
  'data/research/venue-signals/carry-morpho-requested-holder-v1/issues',
)
const MORPHO_WORKER = join(ROOT, 'scripts/carry-morpho-requested-tick.sh')
const MIN_FREE_BYTES = 1_200_000_000n
function eligibleMorphoTargets(study, nowMs) {
  const scored = new Set(study.scores.map((row) => `${row.issueId}:${row.horizonHours}`))
  const attemptsByTarget = new Map()
  for (const attempt of study.attempts) {
    const key = `${attempt.issueId}:${attempt.horizonHours}`
    const prior = attemptsByTarget.get(key) ?? { count: 0, latest: 0 }
    attemptsByTarget.set(key, {
      count: prior.count + 1,
      latest: Math.max(prior.latest, Date.parse(attempt.attemptedAtUtc)),
    })
  }
  return study.issues.flatMap((issue) =>
    issue.targets.filter((target) => {
      const key = `${issue.issueId}:${target.horizonHours}`
      const attempts = attemptsByTarget.get(key) ?? { count: 0, latest: 0 }
      return (
        !scored.has(key) &&
        Date.parse(target.targetAtUtc) <= nowMs &&
        (nowMs > Date.parse(target.deadlineUtc) ||
          (attempts.count < 2 && nowMs - attempts.latest >= 30 * 60_000))
      )
    }),
  )
}

export function morphoHasWork(queue, study, nowMs, failures = new Map()) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw Error('holder_targets_clock_invalid')
  if (
    queue.some((row) => {
      if (
        study.issues.some((issue) => JSON.stringify(issue.request) === JSON.stringify(row.request))
      )
        return false
      const nextAttemptAtMs = failures.get(row.id)?.at(-1)?.nextAttemptAtMs
      return nextAttemptAtMs === undefined || (nextAttemptAtMs !== null && nextAttemptAtMs <= nowMs)
    })
  )
    return true
  return eligibleMorphoTargets(study, nowMs).length > 0
}

export function morphoEarliestLiveDeadline(study, nowMs) {
  const deadlines = eligibleMorphoTargets(study, nowMs)
    .map((target) => Date.parse(target.deadlineUtc))
    .filter((deadline) => nowMs <= deadline)
  return deadlines.length ? Math.min(...deadlines) : null
}

export function firstLane(scrvusdDeadlineMs, morphoDeadlineMs) {
  return morphoDeadlineMs !== null &&
    (scrvusdDeadlineMs === null || morphoDeadlineMs < scrvusdDeadlineMs)
    ? 'morpho'
    : 'scrvusd'
}

export async function runInDeadlineOrder(
  scrvusdDeadlineMs,
  morphoDeadlineMs,
  runScrvusd,
  runMorpho,
) {
  if (firstLane(scrvusdDeadlineMs, morphoDeadlineMs) === 'morpho') {
    await runMorpho()
    await runScrvusd()
  } else {
    await runScrvusd()
    await runMorpho()
  }
}

export async function runFirstHandledInDeadlineOrder(
  scrvusdDeadlineMs,
  morphoDeadlineMs,
  runScrvusd,
  runMorpho,
) {
  const ordered =
    firstLane(scrvusdDeadlineMs, morphoDeadlineMs) === 'morpho'
      ? [runMorpho, runScrvusd]
      : [runScrvusd, runMorpho]
  for (const run of ordered) {
    const result = await run()
    if (result !== null && result !== undefined) return result
  }
  return null
}

async function hasRecords(directory, pattern) {
  let names
  try {
    names = await readdir(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  return names.some((name) => pattern.test(name))
}

async function morphoPreflight(nowMs) {
  const [queued, issued] = await Promise.all([
    hasRecords(MORPHO_QUEUE, /^[0-9a-f]{64}\.json$/),
    hasRecords(MORPHO_ISSUES, /^[0-9]{8}\.json$/),
  ])
  if (!queued && !issued) return { hasWork: false, earliestLiveDeadlineMs: null }
  const [{ readQueue, readFailures }, { verify }] = await Promise.all([
    import('./research/carry-morpho-requested-native.mjs'),
    import('./research/carry-morpho-requested-holder.mjs'),
  ])
  const study = await verify()
  const hasWork = morphoHasWork(readQueue(), study, nowMs, readFailures())
  return {
    hasWork,
    earliestLiveDeadlineMs: hasWork ? morphoEarliestLiveDeadline(study, nowMs) : null,
  }
}

async function runMorpho({ singleAction = false } = {}) {
  const disk = await statfs(ROOT, { bigint: true })
  if (disk.bavail * disk.bsize < MIN_FREE_BYTES) return { status: 'disk_reserve' }
  try {
    const { stdout } = await exec('/bin/sh', [MORPHO_WORKER, '--tick'], {
      cwd: ROOT,
      timeout: 240_000,
      maxBuffer: 1024,
      env: singleAction ? { ...process.env, MORPHO_REQUESTED_SINGLE_ACTION: '1' } : process.env,
    })
    const summary = stdout.trim()
    if (
      !/^requested-native:queued=\d+ issued=\d+ scored=\d+ pending=\d+ intake-failed=\d+$/.test(
        summary,
      ) &&
      summary !== 'requested-native:already-running'
    )
      return { status: 'worker_failed' }
    return { status: 'ran', summary }
  } catch (error) {
    return { status: error?.killed ? 'runtime_bound' : 'worker_failed' }
  }
}

export async function tick(
  nowMs = Date.now(),
  { singleLane = true, singleAction = singleLane, blockedLanes = [] } = {},
) {
  const blocked = new Set(blockedLanes)
  if ([...blocked].some((lane) => lane !== 'scrvusd' && lane !== 'morpho'))
    throw Error('holder_targets_blocked_lane_invalid')
  let scrvusdDeadlineMs = null
  if (!blocked.has('scrvusd')) {
    try {
      scrvusdDeadlineMs = (await scrvusdPreflight(nowMs)).earliestActiveDeadlineMs
    } catch {
      // The bounded scrvUSD tick reports its own verification failure below.
    }
  }
  let morphoPlan = { hasWork: false, earliestLiveDeadlineMs: null }
  let morpho = null
  if (!blocked.has('morpho')) {
    try {
      morphoPlan = await morphoPreflight(nowMs)
    } catch {
      morpho = { status: 'preflight_failed' }
    }
  }
  let scrvusd = null
  const runScrvusd = async () => {
    if (blocked.has('scrvusd')) return null
    try {
      scrvusd = await tickScrvusd(nowMs, {
        deferScoreWhenActive: morphoPlan.earliestLiveDeadlineMs !== null,
        singleAction,
      })
    } catch {
      scrvusd = { status: 'target_tick_failed' }
    }
    return scrvusd
  }
  const runDueMorpho = async () => {
    if (blocked.has('morpho')) return null
    if (!morphoPlan.hasWork) return null
    try {
      morpho = await runMorpho({ singleAction })
    } catch {
      morpho = { status: 'worker_failed' }
    }
    return morpho
  }
  if (singleLane)
    await runFirstHandledInDeadlineOrder(
      scrvusdDeadlineMs,
      morphoPlan.earliestLiveDeadlineMs,
      runScrvusd,
      runDueMorpho,
    )
  else
    await runInDeadlineOrder(
      scrvusdDeadlineMs,
      morphoPlan.earliestLiveDeadlineMs,
      runScrvusd,
      runDueMorpho,
    )
  return scrvusd || morpho ? { scrvusd, morpho } : null
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--tick' || process.argv.length !== 3) throw Error('holder_targets_usage')
  const result = await tick(Date.now(), { singleLane: true, singleAction: true })
  if (result)
    console.log(
      `holder-targets:scrvusd=${result.scrvusd?.status ?? 'idle'} morpho=${result.morpho?.status ?? 'idle'}`,
    )
  if (
    ['target_tick_failed', 'disk_reserve', 'capture_failed', 'runtime_bound'].includes(
      result?.scrvusd?.status,
    ) ||
    ['capture_failed', 'runtime_bound'].includes(result?.scrvusd?.capture?.status) ||
    ['capture_failed', 'runtime_bound'].includes(result?.scrvusd?.score?.status) ||
    ['disk_reserve', 'runtime_bound', 'worker_failed', 'preflight_failed'].includes(
      result?.morpho?.status,
    )
  )
    process.exitCode = 1
}
