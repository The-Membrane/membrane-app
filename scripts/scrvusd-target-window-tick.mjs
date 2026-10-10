// Small Mac scheduler preflight. The verified capture and scorer run only near
// a frozen v1 target; quiet checks do no RPC work and write no output.
import { execFile } from 'node:child_process'
import { readdir, readFile, rm, statfs, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ISSUE_OUT = join(ROOT, 'data/research/venue-signals/scrvusd-exit-forecast-issues')
const SCORE_OUT = join(ROOT, 'data/research/venue-signals/scrvusd-exit-forecast-scores')
const CAPTURE = join(ROOT, 'scripts/research/scrvusd-target-window-capture.mjs')
const SCORE = join(ROOT, 'scripts/research/scrvusd-exit-forecast-score.mjs')
const NODE = '/opt/homebrew/bin/node'
const EARLY_MS = 30 * 60_000
const MIN_FREE_BYTES = 1_200_000_000n
const SCORE_FAILURE = '/private/tmp/membrane-scrvusd-target-score-failure.json'
const SCORE_BACKOFF_MS = 6 * 60 * 60_000
export function classifyTargetWindows(issues, scoredNames, nowMs) {
  if (!Number.isFinite(nowMs)) throw Error('target_tick_clock_invalid')
  const scored = new Set(scoredNames)
  let active = 0
  let due = 0
  for (const { name, issue } of issues) {
    if (scored.has(name)) continue
    const target = Date.parse(issue?.targetUtc ?? '')
    const deadline = Date.parse(
      issue?.outcomeProtocol?.checkpointSelection?.captureDeadlineUtc ?? '',
    )
    if (!Number.isFinite(target) || deadline !== target + 90 * 60_000)
      throw Error('target_tick_issue_invalid')
    if (nowMs >= target - EARLY_MS && nowMs <= deadline) active++
    if (nowMs > deadline) due++
  }
  return { active, due }
}

export function earliestActiveDeadline(issues, nowMs) {
  const earliest = issues.reduce((value, { issue }) => {
    const target = Date.parse(issue.targetUtc)
    const deadline = Date.parse(issue.outcomeProtocol.checkpointSelection.captureDeadlineUtc)
    return nowMs >= target - EARLY_MS && nowMs <= deadline ? Math.min(value, deadline) : value
  }, Number.POSITIVE_INFINITY)
  return Number.isFinite(earliest) ? earliest : null
}

async function jsonNames(directory) {
  try {
    return (await readdir(directory)).filter((name) => name.endsWith('.json')).sort()
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

export async function preflight(nowMs = Date.now()) {
  const [issueNames, scoredNames] = await Promise.all([jsonNames(ISSUE_OUT), jsonNames(SCORE_OUT)])
  const pending = issueNames.filter((name) => !scoredNames.includes(name))
  const issues = await Promise.all(
    pending.map(async (name) => {
      const bytes = await readFile(join(ISSUE_OUT, name))
      if (bytes.length > 65_536) throw Error('target_tick_issue_oversize')
      return { name, issue: JSON.parse(bytes.toString('utf8')) }
    }),
  )
  const windows = classifyTargetWindows(issues, scoredNames, nowMs)
  return {
    pending: pending.length,
    ...windows,
    earliestActiveDeadlineMs: earliestActiveDeadline(issues, nowMs),
  }
}

export function shouldRetryScore(failure, dueCount, nowMs) {
  return (
    !failure ||
    !Number.isFinite(failure.atMs) ||
    !Number.isSafeInteger(failure.dueCount) ||
    failure.atMs > nowMs ||
    dueCount > failure.dueCount ||
    nowMs - failure.atMs >= SCORE_BACKOFF_MS
  )
}

export function shouldScoreDuringTick(due, deferScoreWhenActive) {
  return due.due > 0 && (!due.active || !deferScoreWhenActive)
}

export function targetActionPlan({ active, scoreAllowed, singleAction }) {
  const capture = active > 0
  return {
    capture,
    score: scoreAllowed && (!singleAction || !capture),
  }
}

async function scoreFailure() {
  try {
    const bytes = await readFile(SCORE_FAILURE)
    if (bytes.length > 256) return null
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    if (error instanceof SyntaxError) return null
    throw error
  }
}

async function run(script, args) {
  try {
    const { stdout } = await exec(NODE, ['--max-old-space-size=512', script, ...args], {
      cwd: ROOT,
      timeout: 360_000,
      maxBuffer: 65_536,
      env: process.env,
    })
    return JSON.parse(stdout.trim())
  } catch (error) {
    return { status: error?.killed ? 'runtime_bound' : 'capture_failed' }
  }
}

export async function tick(
  nowMs = Date.now(),
  { deferScoreWhenActive = false, singleAction = false } = {},
) {
  const due = await preflight(nowMs)
  if (!due.active && !due.due) return null
  const scoreAllowed =
    shouldScoreDuringTick(due, deferScoreWhenActive) &&
    shouldRetryScore(await scoreFailure(), due.due, nowMs)
  if (!due.active && !scoreAllowed) return null
  const disk = await statfs(ROOT, { bigint: true })
  if (disk.bavail * disk.bsize < MIN_FREE_BYTES) return { status: 'disk_reserve', ...due }
  const plan = targetActionPlan({ active: due.active, scoreAllowed, singleAction })
  const capture = plan.capture ? await run(CAPTURE, ['--run']) : null
  const score = plan.score ? await run(SCORE, ['--score']) : null
  if (score) {
    if (score.status === 'capture_failed' || score.status === 'runtime_bound')
      await writeFile(SCORE_FAILURE, JSON.stringify({ atMs: nowMs, dueCount: due.due }))
    else await rm(SCORE_FAILURE, { force: true })
  }
  return { status: 'ran', ...due, capture, score }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--dry') console.log(JSON.stringify(await preflight()))
    else if (process.argv[2] === '--tick') {
      const result = await tick()
      if (result) console.log(JSON.stringify(result))
      if (
        result?.status === 'disk_reserve' ||
        result?.capture?.status === 'capture_failed' ||
        result?.capture?.status === 'runtime_bound' ||
        result?.score?.status === 'capture_failed' ||
        result?.score?.status === 'runtime_bound'
      )
        process.exitCode = 1
    } else throw Error('target_tick_usage')
  } catch {
    console.error(JSON.stringify({ status: 'target_tick_failed' }))
    process.exitCode = 1
  }
}
