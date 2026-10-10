// Local public-chain-only due-target sweep for the tracked GHO→sGHO route.
import { pathToFileURL } from 'node:url'

import { readEnv } from './lib/venue-reads.mjs'
import {
  fairPublicDirectScorePlans,
  rankedPublicOriginPairs,
} from './record-carry-public-direct-exit-scores.mjs'
import {
  configuredPublicRpcUrls,
  publicRpcClients,
} from './research/carry-public-direct-exit-issue.mjs'
import { verifySghoIssues } from './research/carry-public-sgho-exit-issue.mjs'
import { scorePublicSghoExit, verifySghoScores } from './research/carry-public-sgho-exit-score.mjs'

export const MAX_SGHO_PLANS_PER_TICK = 6
export const SGHO_SWEEP_BUDGET_MS = 5 * 60_000

const hasPositiveBaseline = (issue) =>
  issue.cases.some(
    (entry) => entry.status === 'measured' && entry.measurement?.baselineStatus === 'success',
  )

export function pendingSghoScorePlans(issues, scores, asOfUtc) {
  const nowMs = Date.parse(asOfUtc)
  if (!Number.isFinite(nowMs) || new Date(nowMs).toISOString() !== asOfUtc)
    throw Error('sgho_score_asof_invalid')
  const done = new Set(scores.map((row) => `${row.issueSequence}:${row.horizonHours}`))
  return issues.filter(hasPositiveBaseline).flatMap((issue) =>
    issue.targets
      .filter(
        (target) =>
          Date.parse(target.targetAtUtc) <= nowMs &&
          !done.has(`${issue.sequence}:${target.horizonHours}`),
      )
      .map((target) => ({
        issue,
        issueSequence: issue.sequence,
        horizonHours: target.horizonHours,
        targetMs: Date.parse(target.targetAtUtc),
        deadlineMs: Date.parse(target.captureDeadlineUtc),
        active: nowMs <= Date.parse(target.captureDeadlineUtc),
      })),
  )
}

export async function runSghoScoreSweep({
  issues,
  scores,
  urls,
  now = () => new Date(),
  score = scorePublicSghoExit,
  clientsFor = publicRpcClients,
}) {
  const startMs = now().getTime()
  const due = pendingSghoScorePlans(issues, scores, new Date(startMs).toISOString())
  const selected = fairPublicDirectScorePlans(due, new Date(startMs).toISOString()).slice(
    0,
    MAX_SGHO_PLANS_PER_TICK,
  )
  const summary = {
    due: due.length,
    attempted: 0,
    scored: 0,
    retries: 0,
    skippedNoBaseline: issues.filter((issue) => !hasPositiveBaseline(issue)).length,
  }
  for (const plan of selected) {
    if (now().getTime() - startMs >= SGHO_SWEEP_BUDGET_MS) break
    summary.attempted++
    let result = { status: 'retry_target_unavailable' }
    for (const pair of rankedPublicOriginPairs(urls, plan.issue)) {
      if (now().getTime() - startMs >= SGHO_SWEEP_BUDGET_MS) break
      result = await score({
        issueSequence: plan.issueSequence,
        horizonHours: plan.horizonHours,
        clients: clientsFor(pair),
      })
      if (!['retry_target_unavailable', 'retry_replay_unavailable'].includes(result.status)) break
    }
    if (['scored', 'already_scored'].includes(result.status)) summary.scored++
    else if (['retry_target_unavailable', 'retry_replay_unavailable'].includes(result.status))
      summary.retries++
    else if (!['not_due', 'no_eligible_baseline'].includes(result.status))
      throw Error('sgho_score_result_invalid')
  }
  return summary
}

async function cli() {
  const mode = process.argv[2]
  const issues = await verifySghoIssues()
  const scores = await verifySghoScores()
  if (mode === '--plan') {
    const due = pendingSghoScorePlans(issues, scores, new Date().toISOString())
    process.stdout.write(
      `${JSON.stringify({ status: 'sgho_score_plan', due: due.length, eligibleIssues: issues.filter(hasPositiveBaseline).length })}\n`,
    )
    return
  }
  if (mode !== '--sweep') throw Error('sgho_score_sweep_usage')
  const urls = configuredPublicRpcUrls(readEnv())
  const summary = await runSghoScoreSweep({ issues, scores, urls })
  process.stdout.write(`${JSON.stringify({ status: 'sgho_score_sweep', ...summary })}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch(() => {
    // Source errors may contain credential-bearing URLs or public holder data.
    process.stderr.write('public_sgho_score_sweep_failed\n')
    process.exitCode = 1
  })
}
