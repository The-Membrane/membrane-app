import { fairPublicDirectScorePlans } from '../record-carry-public-direct-exit-scores.mjs'

export const MAX_SUSDE_PLANS_PER_TICK = 6
export const SUSDE_SWEEP_BUDGET_MS = 5 * 60_000

export function pendingSusdePlans(issues, scores, asOfUtc, eligible) {
  const nowMs = Date.parse(asOfUtc)
  if (!Number.isFinite(nowMs) || new Date(nowMs).toISOString() !== asOfUtc)
    throw Error('susde_score_asof_invalid')
  const done = new Set(scores.map((row) => `${row.issueSequence}:${row.horizonHours}`))
  return issues.filter(eligible).flatMap((issue) =>
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

export function selectSusdePlans(issues, scores, asOfUtc, eligible) {
  const due = pendingSusdePlans(issues, scores, asOfUtc, eligible)
  return {
    due,
    selected: fairPublicDirectScorePlans(due, asOfUtc).slice(0, MAX_SUSDE_PLANS_PER_TICK),
  }
}
