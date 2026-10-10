// Local public-only due sweep for hypothetical new cooldown initiation.
import { pathToFileURL } from 'node:url'

import { readEnv } from './lib/venue-reads.mjs'
import { selectSusdePlans, SUSDE_SWEEP_BUDGET_MS } from './lib/susde-public-due-sweep.mjs'
import { configuredPublicRpcUrls } from './research/carry-public-direct-exit-issue.mjs'
import { rotatingSusdeOriginPairs } from './research/susde-public-initiation-common.mjs'
import { verifySusdeIssues } from './research/susde-public-initiation-issue.mjs'
import {
  scorePublicSusdeInitiation,
  verifySusdeScores,
} from './research/susde-public-initiation-score.mjs'

const eligible = (issue) =>
  issue.cases.some((row) => row.measurement?.status === 'simulated_initiation_success')

export function rankedSusdeInitiationPairs(pairs, issue) {
  const preferred = issue.baseline.witnesses.map((row) => row.provider)
  const ordered = [...pairs].sort((a, b) => {
    const rank = (pair) =>
      Number(pair[0].provider !== preferred[0]) * 2 + Number(pair[1].provider !== preferred[1])
    return rank(a) - rank(b)
  })
  const selected = []
  const original = ordered.find(
    (pair) => pair[0].provider === preferred[0] && pair[1].provider === preferred[1],
  )
  if (original) selected.push(original)
  const alternate = ordered.find((pair) => pair[0].provider !== preferred[0])
  if (alternate) selected.push(alternate)
  for (const pair of ordered) {
    if (selected.length === 3) break
    if (!selected.includes(pair)) selected.push(pair)
  }
  return selected
}

export async function runSusdeInitiationScoreSweep({
  issues,
  scores,
  urls,
  now = () => new Date(),
  score = scorePublicSusdeInitiation,
  pairsFor = rotatingSusdeOriginPairs,
}) {
  const started = now().getTime()
  const { due, selected } = selectSusdePlans(
    issues,
    scores,
    new Date(started).toISOString(),
    eligible,
  )
  const summary = {
    due: due.length,
    attempted: 0,
    scored: 0,
    retries: 0,
    skippedNoBaseline: issues.filter((issue) => !eligible(issue)).length,
  }
  for (const plan of selected) {
    if (now().getTime() - started >= SUSDE_SWEEP_BUDGET_MS) break
    summary.attempted++
    const result = await score({
      issueSequence: plan.issueSequence,
      horizonHours: plan.horizonHours,
      originPairs: rankedSusdeInitiationPairs(pairsFor(urls), plan.issue),
    })
    if (['scored', 'already_scored'].includes(result.status)) summary.scored++
    else if (result.status === 'retry_target_or_replay_unavailable') summary.retries++
    else if (!['not_due', 'no_eligible_baseline'].includes(result.status))
      throw Error('susde_initiation_sweep_result_invalid')
  }
  return summary
}

async function cli() {
  const mode = process.argv[2]
  const [issues, scores] = await Promise.all([verifySusdeIssues(), verifySusdeScores()])
  if (mode === '--plan') {
    const { due } = selectSusdePlans(issues, scores, new Date().toISOString(), eligible)
    process.stdout.write(
      `${JSON.stringify({ status: 'susde_initiation_score_plan', due: due.length, eligibleIssues: issues.filter(eligible).length })}\n`,
    )
    return
  }
  if (mode !== '--sweep') throw Error('susde_initiation_sweep_usage')
  const urls = configuredPublicRpcUrls(readEnv())
  const result = await runSusdeInitiationScoreSweep({ issues, scores, urls })
  process.stdout.write(`${JSON.stringify({ status: 'susde_initiation_score_sweep', ...result })}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch(() => {
    process.stderr.write('susde_initiation_score_sweep_failed\n')
    process.exitCode = 1
  })
}
