// Local public-only due sweep for an already pending whole-queue claim.
import { pathToFileURL } from 'node:url'

import { readEnv } from './lib/venue-reads.mjs'
import { selectSusdePlans, SUSDE_SWEEP_BUDGET_MS } from './lib/susde-public-due-sweep.mjs'
import { configuredPublicRpcUrls } from './research/carry-public-direct-exit-issue.mjs'
import { verifyIssues } from './research/susde-public-pending-exit-issue.mjs'
import { scorePending, verifyScores } from './research/susde-public-pending-exit-score.mjs'

const eligible = (issue) => BigInt(issue.pendingAssetsRaw) > 0n
const RETRYABLE = new Set([
  'susde_score_rpc_unavailable',
  'susde_score_target_not_finalized',
  'susde_score_origin_target_disagreement',
  'susde_rpc_budget_exhausted',
])

export async function runSusdePendingScoreSweep({
  issues,
  scores,
  urls,
  now = () => new Date(),
  score = scorePending,
}) {
  const started = now().getTime()
  const { due, selected } = selectSusdePlans(
    issues,
    scores,
    new Date(started).toISOString(),
    eligible,
  )
  const summary = { due: due.length, attempted: 0, scored: 0, retries: 0 }
  for (const plan of selected) {
    if (now().getTime() - started >= SUSDE_SWEEP_BUDGET_MS) break
    summary.attempted++
    try {
      const result = await score({
        issueSequence: plan.issueSequence,
        horizonHours: plan.horizonHours,
        urls,
      })
      if (!Number.isSafeInteger(result.sequence) || typeof result.outcome !== 'string')
        throw Error('susde_pending_sweep_result_invalid')
      summary.scored++
    } catch (error) {
      if (!RETRYABLE.has(error?.message)) throw error
      summary.retries++
    }
  }
  return summary
}

async function cli() {
  const mode = process.argv[2]
  const [issues, scores] = await Promise.all([verifyIssues(), verifyScores()])
  if (mode === '--plan') {
    const { due } = selectSusdePlans(issues, scores, new Date().toISOString(), eligible)
    process.stdout.write(
      `${JSON.stringify({ status: 'susde_pending_score_plan', due: due.length })}\n`,
    )
    return
  }
  if (mode !== '--sweep') throw Error('susde_pending_sweep_usage')
  const urls = configuredPublicRpcUrls(readEnv())
  const result = await runSusdePendingScoreSweep({ issues, scores, urls })
  process.stdout.write(`${JSON.stringify({ status: 'susde_pending_score_sweep', ...result })}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch(() => {
    process.stderr.write('susde_pending_score_sweep_failed\n')
    process.exitCode = 1
  })
}
