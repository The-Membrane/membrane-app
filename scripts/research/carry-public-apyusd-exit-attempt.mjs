// Every native run leaves a private linked receipt, including failures and no-fresh-holder.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { OUT_ROOT, appendChain, readChain, seal, utc } from './carry-public-apyusd-exit-common.mjs'
import { issueApyUsd, verifyApyUsdIssues } from './carry-public-apyusd-exit-issue.mjs'
import { scoreApyUsd, verifyApyUsdScores } from './carry-public-apyusd-exit-score.mjs'

export const STUDY = 'carry_public_apyusd_exit_attempt_v1'
export const OUT = resolve(OUT_ROOT, 'carry-public-apyusd-exit-attempts')

export function validateApyUsdAttempt(row, issues, scores) {
  if (
    row?.study !== STUDY ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1 ||
    !['issue', 'score'].includes(row.mode) ||
    !['completed', 'nothing_due', 'no_fresh_holder', 'deferred', 'failed'].includes(row.status) ||
    (row.failure === null) !== (row.status !== 'failed') ||
    (row.failure !== null && !/^apyusd_[a-z0-9_]+$/.test(row.failure)) ||
    utc(row.finishedAtUtc) < utc(row.startedAtUtc) ||
    !Number.isSafeInteger(row.due) ||
    row.due < 0 ||
    !Number.isSafeInteger(row.attempted) ||
    row.attempted < 0 ||
    !Array.isArray(row.records) ||
    row.records.length > 6 ||
    (row.status === 'nothing_due' && (row.due || row.attempted || row.records.length)) ||
    (row.status === 'no_fresh_holder' && row.mode !== 'issue')
  )
    throw Error('apyusd_attempt_invalid')
  const list = row.mode === 'issue' ? issues : scores
  for (const link of row.records)
    if (list[link.sequence - 1]?.sha256 !== link.sha256) throw Error('apyusd_attempt_link_invalid')
  return row
}

export async function verifyApyUsdAttempts(out = OUT) {
  const [issues, scores, attempts] = await Promise.all([
    verifyApyUsdIssues(),
    verifyApyUsdScores(),
    readChain(out),
  ])
  for (const row of attempts) validateApyUsdAttempt(row, issues, scores)
  return { issues, scores, attempts }
}

export async function tickApyUsd(
  mode,
  { now = () => new Date(), issue = issueApyUsd, score = scoreApyUsd } = {},
) {
  if (!['issue', 'score'].includes(mode)) throw Error('apyusd_attempt_mode_invalid')
  const startedAtUtc = now().toISOString()
  const prior = await verifyApyUsdAttempts()
  const oldCount = mode === 'issue' ? prior.issues.length : prior.scores.length
  let due = mode === 'issue' ? 1 : 0
  let attempted = mode === 'issue' ? 1 : 0
  let status = 'nothing_due',
    failure = null
  try {
    if (mode === 'issue') {
      await issue()
      status = 'completed'
    } else {
      const result = await score()
      due = result.due
      attempted = result.attempted
      status = result.scored ? 'completed' : due ? 'deferred' : 'nothing_due'
      if (attempted && result.retries && !result.scored) {
        status = 'failed'
        failure = 'apyusd_score_retries_exhausted'
      }
    }
  } catch (error) {
    const code = String(error?.message ?? '')
    if (mode === 'issue' && code === 'apyusd_no_fresh_holder') status = 'no_fresh_holder'
    else {
      status = 'failed'
      failure = /^apyusd_[a-z0-9_]+$/.test(code) ? code : 'apyusd_unexpected_failure'
    }
  }
  const [issues, scores] = await Promise.all([verifyApyUsdIssues(), verifyApyUsdScores()])
  const list = mode === 'issue' ? issues : scores
  const records = list
    .slice(oldCount)
    .map((row) => ({ sequence: row.sequence, sha256: row.sha256 }))
  if (status === 'completed' && mode === 'issue' && records.length !== 1)
    throw Error('apyusd_issue_count_invalid')
  const row = seal({
    study: STUDY,
    sequence: prior.attempts.length + 1,
    previousSha256: prior.attempts.at(-1)?.sha256 ?? null,
    mode,
    startedAtUtc,
    finishedAtUtc: now().toISOString(),
    status,
    failure,
    due,
    attempted,
    records,
  })
  validateApyUsdAttempt(row, issues, scores)
  await appendChain(row, OUT, async (out) => (await verifyApyUsdAttempts(out)).attempts)
  if (status === 'failed') throw Error(failure)
  return { status, due, attempted, sealed: records.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === '--verify') {
      const state = await verifyApyUsdAttempts()
      console.log(
        JSON.stringify({
          issues: state.issues.length,
          scores: state.scores.length,
          attempts: state.attempts.length,
        }),
      )
    } else if (['--issue', '--score'].includes(process.argv[2]))
      console.log(JSON.stringify(await tickApyUsd(process.argv[2].slice(2))))
    else throw Error('apyusd_attempt_usage')
  } catch {
    process.stderr.write('public_apyusd_attempt_failed\n')
    process.exitCode = 1
  }
}
