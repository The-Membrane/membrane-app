// Bounded due-score sweep for prospectively frozen Aave USDC holder/Q cases.
import { pathToFileURL } from 'node:url'

import { readEnv } from './lib/venue-reads.mjs'
import { configuredPublicRpcUrls } from './research/carry-public-direct-exit-issue.mjs'
import { verifyAaveFrozenQIssues } from './research/carry-public-aave-usdc-fixed-q-v2-issue.mjs'
import {
  scoreAaveFrozenQ,
  verifyAaveFrozenQScores,
} from './research/carry-public-aave-usdc-fixed-q-v2-score.mjs'
import { rotatingSghoOriginPairs } from './research/carry-public-sgho-exit-common.mjs'

export const MAX_PLANS = 4
export const MAX_PAIRS_PER_PLAN = 2
export const BUDGET_MS = 110_000
const BUCKET_MS = 10 * 60_000

function rotate(rows, offset) {
  if (!rows.length) return []
  const start = offset % rows.length
  return [...rows.slice(start), ...rows.slice(0, start)]
}

/** Rotate the first attempt too: one slow replay must not lead every sweep. */
export function fairAaveFrozenQPlans(due, asOfUtc) {
  const now = Date.parse(asOfUtc)
  if (!Number.isFinite(now) || new Date(now).toISOString() !== asOfUtc)
    throw Error('aave_frozen_q_asof_invalid')
  const bucket = Math.floor(now / BUCKET_MS)
  const active = rotate(
    due.filter((plan) => plan.deadlineMs >= now),
    bucket,
  )
  const expired = rotate(
    due.filter((plan) => plan.deadlineMs < now),
    bucket,
  )
  if (!expired.length) return active.slice(0, MAX_PLANS)
  if (!active.length) return expired.slice(0, MAX_PLANS)
  const selected = [
    ...active.slice(0, MAX_PLANS - 1),
    ...expired.slice(0, MAX_PLANS - Math.min(active.length, MAX_PLANS - 1)),
    ...active.slice(MAX_PLANS - 1),
  ].slice(0, MAX_PLANS)
  // Give overdue censoring a first attempt every fourth tick, even if the
  // first active replay repeatedly consumes the entire process budget.
  return bucket % MAX_PLANS === 0
    ? [expired[0], ...selected.filter((plan) => plan !== expired[0])]
    : selected
}

export function selectAaveFrozenQPairs(pairs, plan, asOfUtc) {
  const now = Date.parse(asOfUtc)
  if (!Number.isFinite(now) || new Date(now).toISOString() !== asOfUtc)
    throw Error('aave_frozen_q_asof_invalid')
  if (!Array.isArray(pairs) || !pairs.length) throw Error('aave_frozen_q_pairs_invalid')
  const bucket = Math.floor(now / BUCKET_MS)
  return rotate(pairs, bucket + plan.issueSequence + plan.horizonHours).slice(0, MAX_PAIRS_PER_PLAN)
}

export function pendingAaveFrozenQPlans(issues, scores, asOfUtc) {
  const now = Date.parse(asOfUtc)
  if (!Number.isFinite(now) || new Date(now).toISOString() !== asOfUtc)
    throw Error('aave_frozen_q_asof_invalid')
  const done = new Set(scores.map((score) => `${score.issueSequence}:${score.horizonHours}`))
  return issues
    .flatMap((issue) =>
      issue.targets
        .filter(
          (target) =>
            Date.parse(target.targetAtUtc) <= now &&
            !done.has(`${issue.sequence}:${target.horizonHours}`),
        )
        .map((target) => ({
          issueSequence: issue.sequence,
          horizonHours: target.horizonHours,
          deadlineMs: Date.parse(target.captureDeadlineUtc),
          targetMs: Date.parse(target.targetAtUtc),
        })),
    )
    .sort(
      (a, b) =>
        Number(now <= b.deadlineMs) - Number(now <= a.deadlineMs) ||
        a.deadlineMs - b.deadlineMs ||
        a.targetMs - b.targetMs,
    )
}

export async function runAaveFrozenQSweep({
  issues,
  scores,
  urls,
  now = () => new Date(),
  score = scoreAaveFrozenQ,
  makePairs = rotatingSghoOriginPairs,
}) {
  const start = now().getTime()
  const due = pendingAaveFrozenQPlans(issues, scores, new Date(start).toISOString())
  const summary = { due: due.length, attempted: 0, scored: 0, retries: 0, retryCauses: {} }
  if (!due.length) return summary
  for (const plan of fairAaveFrozenQPlans(due, new Date(start).toISOString())) {
    if (now().getTime() - start >= BUDGET_MS) break
    summary.attempted++
    const pairs = selectAaveFrozenQPairs(makePairs(urls), plan, new Date(start).toISOString())
    const result = await score({
      issueSequence: plan.issueSequence,
      horizonHours: plan.horizonHours,
      originPairs: pairs,
    })
    if (['scored', 'already_scored'].includes(result.status)) summary.scored++
    else if (result.status.startsWith('retry_')) {
      summary.retries++
      for (const cause of result.causes ?? [result.status])
        summary.retryCauses[cause] = (summary.retryCauses[cause] ?? 0) + 1
    } else if (result.status !== 'not_due') throw Error('aave_frozen_q_sweep_result_invalid')
  }
  return summary
}

async function cli() {
  const mode = process.argv[2]
  const [issues, scores] = await Promise.all([verifyAaveFrozenQIssues(), verifyAaveFrozenQScores()])
  if (mode === '--plan') {
    const due = pendingAaveFrozenQPlans(issues, scores, new Date().toISOString())
    process.stdout.write(
      `${JSON.stringify({ status: 'aave_frozen_q_plan', due: due.length, issues: issues.length })}\n`,
    )
    return
  }
  if (mode !== '--sweep') throw Error('aave_frozen_q_sweep_usage')
  const summary = await runAaveFrozenQSweep({
    issues,
    scores,
    urls: configuredPublicRpcUrls(readEnv()),
  })
  process.stdout.write(`${JSON.stringify({ status: 'aave_frozen_q_sweep', ...summary })}\n`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  cli().catch(() => {
    process.stderr.write('public_aave_frozen_q_sweep_failed\n')
    process.exitCode = 1
  })
