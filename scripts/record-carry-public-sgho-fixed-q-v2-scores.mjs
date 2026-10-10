// Bounded local due-score sweep for the fixed one-GHO sGHO cohort.
import { pathToFileURL } from 'node:url'

import { readEnv } from './lib/venue-reads.mjs'
import { configuredPublicRpcUrls } from './research/carry-public-direct-exit-issue.mjs'
import { verifySghoFixedQIssues } from './research/carry-public-sgho-fixed-q-v2-issue.mjs'
import {
  scoreSghoFixedQ,
  verifySghoFixedQScores,
} from './research/carry-public-sgho-fixed-q-v2-score.mjs'
import { rotatingSghoOriginPairs } from './research/carry-public-sgho-exit-common.mjs'

export const MAX_PLANS = 6
export const BUDGET_MS = 5 * 60_000

export function pendingSghoFixedQPlans(issues, scores, asOfUtc) {
  const now = Date.parse(asOfUtc)
  if (!Number.isFinite(now) || new Date(now).toISOString() !== asOfUtc)
    throw Error('sgho_fixed_q_asof_invalid')
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

export async function runSghoFixedQSweep({
  issues,
  scores,
  urls,
  now = () => new Date(),
  score = scoreSghoFixedQ,
  makePairs = rotatingSghoOriginPairs,
}) {
  const start = now().getTime()
  const due = pendingSghoFixedQPlans(issues, scores, new Date(start).toISOString())
  const summary = { due: due.length, attempted: 0, scored: 0, retries: 0 }
  if (!due.length) return summary
  for (const plan of due.slice(0, MAX_PLANS)) {
    if (now().getTime() - start >= BUDGET_MS) break
    summary.attempted++
    const result = await score({
      issueSequence: plan.issueSequence,
      horizonHours: plan.horizonHours,
      originPairs: makePairs(urls),
    })
    if (['scored', 'already_scored'].includes(result.status)) summary.scored++
    else if (result.status.startsWith('retry_')) summary.retries++
    else if (result.status !== 'not_due') throw Error('sgho_fixed_q_sweep_result_invalid')
  }
  return summary
}

async function cli() {
  const mode = process.argv[2]
  const [issues, scores] = await Promise.all([verifySghoFixedQIssues(), verifySghoFixedQScores()])
  if (mode === '--plan') {
    const due = pendingSghoFixedQPlans(issues, scores, new Date().toISOString())
    process.stdout.write(
      `${JSON.stringify({ status: 'sgho_fixed_q_plan', due: due.length, issues: issues.length })}\n`,
    )
    return
  }
  if (mode !== '--sweep') throw Error('sgho_fixed_q_sweep_usage')
  const summary = await runSghoFixedQSweep({
    issues,
    scores,
    urls: configuredPublicRpcUrls(readEnv()),
  })
  process.stdout.write(`${JSON.stringify({ status: 'sgho_fixed_q_sweep', ...summary })}\n`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  cli().catch(() => {
    process.stderr.write('public_sgho_fixed_q_sweep_failed\n')
    process.exitCode = 1
  })
