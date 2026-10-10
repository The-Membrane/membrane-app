// Local public-chain-only due-target sweep for the tracked USDC→USD3 route.
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
import { verifyUsd3Issues } from './research/carry-public-usd3-exit-issue.mjs'
import {
  scorePublicUsd3Exit,
  usd3ScorableBaseline,
  verifyUsd3Scores,
} from './research/carry-public-usd3-exit-score.mjs'

export const MAX_USD3_PLANS_PER_TICK = 6
export const USD3_SWEEP_BUDGET_MS = 5 * 60_000

const hasScorableBaseline = (issue) => issue.cases.some(usd3ScorableBaseline)

export function pendingUsd3ScorePlans(issues, scores, asOfUtc) {
  const nowMs = Date.parse(asOfUtc)
  if (!Number.isFinite(nowMs) || new Date(nowMs).toISOString() !== asOfUtc)
    throw Error('usd3_score_asof_invalid')
  const done = new Set(scores.map((row) => `${row.issueSequence}:${row.horizonHours}`))
  return issues.filter(hasScorableBaseline).flatMap((issue) =>
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

export async function runUsd3ScoreSweep({
  issues,
  scores,
  urls,
  now = () => new Date(),
  score = scorePublicUsd3Exit,
  clientsFor = publicRpcClients,
}) {
  const startMs = now().getTime()
  const due = pendingUsd3ScorePlans(issues, scores, new Date(startMs).toISOString())
  const selected = fairPublicDirectScorePlans(due, new Date(startMs).toISOString()).slice(
    0,
    MAX_USD3_PLANS_PER_TICK,
  )
  const summary = {
    due: due.length,
    attempted: 0,
    scored: 0,
    retries: 0,
    skippedNoBaseline: issues.filter((issue) => !hasScorableBaseline(issue)).length,
  }
  for (const plan of selected) {
    if (now().getTime() - startMs >= USD3_SWEEP_BUDGET_MS) break
    summary.attempted++
    let result = { status: 'retry_target_unavailable' }
    for (const pair of rankedPublicOriginPairs(urls, plan.issue)) {
      if (now().getTime() - startMs >= USD3_SWEEP_BUDGET_MS) break
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
      throw Error('usd3_score_result_invalid')
  }
  return summary
}

async function cli() {
  const mode = process.argv[2]
  const issues = await verifyUsd3Issues()
  const scores = await verifyUsd3Scores()
  if (mode === '--plan') {
    const due = pendingUsd3ScorePlans(issues, scores, new Date().toISOString())
    process.stdout.write(
      `${JSON.stringify({ status: 'usd3_score_plan', due: due.length, scorableIssues: issues.filter(hasScorableBaseline).length })}\n`,
    )
    return
  }
  if (mode !== '--sweep') throw Error('usd3_score_sweep_usage')
  const urls = configuredPublicRpcUrls(readEnv())
  const summary = await runUsd3ScoreSweep({ issues, scores, urls })
  process.stdout.write(`${JSON.stringify({ status: 'usd3_score_sweep', ...summary })}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch(() => {
    // Source errors may contain credential-bearing URLs or public holder data.
    process.stderr.write('public_usd3_score_sweep_failed\n')
    process.exitCode = 1
  })
}
