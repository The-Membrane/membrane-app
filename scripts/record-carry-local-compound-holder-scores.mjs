// Local public-only due-target sweep. Inputs are sealed public issues; no
// database, private holder source, Codex schedule, or future-target inference.
import { pathToFileURL } from 'node:url'

import { readEnv } from './lib/venue-reads.mjs'
import {
  configuredPublicRpcUrls,
  publicRpcClients,
  verifyPublicDirectIssues,
} from './research/carry-local-compound-holder-issue.mjs'
import {
  scorePublicDirectExit,
  verifyPublicDirectScores,
  hasSuppliedBaseline,
} from './research/carry-local-compound-holder-score.mjs'

export const MAX_PLANS_PER_TICK = 6
export const MAX_PAIR_ATTEMPTS = 3
export const SWEEP_BUDGET_MS = 5 * 60_000
const SWEEP_INTERVAL_MS = 10 * 60_000
const FRESH_H1_MS = 20 * 60_000
const H1_RESERVED_SLOTS = 4
const OTHER_ACTIVE_RESERVED_SLOTS = MAX_PLANS_PER_TICK - H1_RESERVED_SLOTS

const eligible = (issue) => issue.cases.some(hasSuppliedBaseline)

/** Capture-window work outranks old missed windows. Never score an unmeasured issue. */
export function pendingPublicDirectScorePlans(issues, scores, asOfUtc) {
  const nowMs = Date.parse(asOfUtc)
  if (!Number.isFinite(nowMs) || new Date(nowMs).toISOString() !== asOfUtc)
    throw Error('public_score_asof_invalid')
  const done = new Set(scores.map((row) => `${row.issueSequence}:${row.horizonHours}`))
  return issues
    .filter(eligible)
    .flatMap((issue) =>
      issue.targets
        .filter(
          (target) =>
            Date.parse(target.targetAtUtc) <= nowMs &&
            !done.has(`${issue.sequence}:${target.horizonHours}`),
        )
        .map((target) => ({
          issueSequence: issue.sequence,
          issue,
          horizonHours: target.horizonHours,
          targetMs: Date.parse(target.targetAtUtc),
          deadlineMs: Date.parse(target.captureDeadlineUtc),
          active: nowMs <= Date.parse(target.captureDeadlineUtc),
        })),
    )
    .sort((a, b) =>
      a.active !== b.active
        ? a.active
          ? -1
          : 1
        : a.active
          ? a.deadlineMs - b.deadlineMs || a.issueSequence - b.issueSequence
          : a.deadlineMs - b.deadlineMs || a.issueSequence - b.issueSequence,
    )
}

function rotate(rows, step) {
  if (rows.length === 0) return []
  const offset = step % rows.length
  return [...rows.slice(offset), ...rows.slice(0, offset)]
}

/** Reserve H1 and other active slots, then rotate retries on each ten-minute tick. */
export function fairPublicDirectScorePlans(due, asOfUtc) {
  const nowMs = Date.parse(asOfUtc)
  if (!Number.isFinite(nowMs) || new Date(nowMs).toISOString() !== asOfUtc)
    throw Error('public_score_asof_invalid')
  const tick = Math.floor(nowMs / SWEEP_INTERVAL_MS)
  const freshH1 = due
    .filter((row) => row.active && row.horizonHours === 1 && nowMs - row.targetMs <= FRESH_H1_MS)
    .sort((a, b) => b.deadlineMs - a.deadlineMs || b.issueSequence - a.issueSequence)
  const olderH1 = rotate(
    due.filter((row) => row.active && row.horizonHours === 1 && !freshH1.includes(row)),
    tick * H1_RESERVED_SLOTS,
  )
  const activeOther = rotate(
    due.filter((row) => row.active && row.horizonHours !== 1),
    tick * OTHER_ACTIVE_RESERVED_SLOTS,
  )
  const expired = rotate(
    due.filter((row) => !row.active),
    tick * MAX_PLANS_PER_TICK,
  )
  const h1 = [...freshH1, ...olderH1]
  const selected = [
    ...h1.slice(0, H1_RESERVED_SLOTS),
    ...activeOther.slice(0, OTHER_ACTIVE_RESERVED_SLOTS),
  ]
  for (const row of [...h1, ...activeOther, ...expired]) {
    if (selected.length >= MAX_PLANS_PER_TICK) break
    if (!selected.includes(row)) selected.push(row)
  }
  return selected
}

function host(url) {
  const hostname = new URL(url).hostname.replace(/\.$/, '').replace(/^www\./, '')
  return /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/.test(hostname) ? 'loopback' : hostname
}

function provider(url) {
  const parsed = new URL(url)
  return `${parsed.protocol}//${parsed.host}`
}

/** Prefer the original issue's successful public pair, then bounded fallbacks. */
export function rankedPublicOriginPairs(urls, issue) {
  if (!Array.isArray(urls) || urls.length < 2 || urls.length > 8)
    throw Error('public_score_origins_invalid')
  const pairs = []
  for (let first = 0; first < urls.length; first++) {
    for (let second = 0; second < urls.length; second++) {
      if (first !== second && host(urls[first]) !== host(urls[second])) pairs.push([first, second])
    }
  }
  const preferredPrimary = issue.baseline.canonicalityEvidenceDoc.provider
  const preferredSecondary = issue.baselineWitness.provider
  const ordered = pairs.sort((a, b) => {
    const rank = ([first, second]) =>
      Number(provider(urls[first]) !== preferredPrimary) * 2 +
      Number(provider(urls[second]) !== preferredSecondary)
    return rank(a) - rank(b) || a[0] - b[0] || a[1] - b[1]
  })
  const selected = []
  const preferred = ordered.find(
    ([first, second]) =>
      provider(urls[first]) === preferredPrimary && provider(urls[second]) === preferredSecondary,
  )
  if (preferred) selected.push(preferred)
  const alternatePrimary = ordered.find(([first]) => provider(urls[first]) !== preferredPrimary)
  if (alternatePrimary) selected.push(alternatePrimary)
  for (const pair of ordered) {
    if (selected.length >= MAX_PAIR_ATTEMPTS) break
    if (!selected.includes(pair)) selected.push(pair)
  }
  return selected.map(([first, second]) => [urls[first], urls[second]])
}

export async function runPublicDirectScoreSweep({
  issues,
  scores,
  urls,
  now = () => new Date(),
  score = scorePublicDirectExit,
  clientsFor = publicRpcClients,
}) {
  const startMs = now().getTime()
  const due = pendingPublicDirectScorePlans(issues, scores, new Date(startMs).toISOString())
  const selected = fairPublicDirectScorePlans(due, new Date(startMs).toISOString())
  const summary = {
    due: due.length,
    attempted: 0,
    scored: 0,
    retries: 0,
    skippedNoBaseline: issues.filter((issue) => !eligible(issue)).length,
  }
  // Each pair attempt re-verifies the full local issue/score ledgers through
  // scorePublicDirectExit. This is a bounded-tick capacity limit as they grow.
  for (const plan of selected) {
    if (now().getTime() - startMs >= SWEEP_BUDGET_MS) break
    summary.attempted++
    let result = { status: 'retry_target_unavailable' }
    for (const pair of rankedPublicOriginPairs(urls, plan.issue)) {
      if (now().getTime() - startMs >= SWEEP_BUDGET_MS) break
      const clients = clientsFor(pair)
      result = await score({
        issueSequence: plan.issueSequence,
        horizonHours: plan.horizonHours,
        clients,
      })
      if (!['retry_target_unavailable', 'retry_replay_unavailable'].includes(result.status)) break
    }
    if (result.status === 'scored' || result.status === 'already_scored') summary.scored++
    else if (['retry_target_unavailable', 'retry_replay_unavailable'].includes(result.status))
      summary.retries++
    else if (result.status !== 'no_eligible_baseline' && result.status !== 'not_due')
      throw Error('public_score_result_invalid')
  }
  return summary
}

async function cli() {
  const mode = process.argv[2]
  const issues = await verifyPublicDirectIssues()
  const scores = await verifyPublicDirectScores()
  if (mode === '--plan') {
    const due = pendingPublicDirectScorePlans(issues, scores, new Date().toISOString())
    process.stdout.write(
      `${JSON.stringify({ status: 'public_score_plan', due: due.length, eligibleIssues: issues.filter(eligible).length })}\n`,
    )
    return
  }
  if (mode !== '--sweep') throw Error('public_score_sweep_usage')
  const urls = configuredPublicRpcUrls(readEnv())
  const summary = await runPublicDirectScoreSweep({ issues, scores, urls })
  process.stdout.write(`${JSON.stringify({ status: 'public_score_sweep', ...summary })}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch(() => {
    // Source errors may contain credential-bearing URLs or public holders.
    process.stderr.write('local_compound_holder_score_sweep_failed\n')
    process.exitCode = 1
  })
}
