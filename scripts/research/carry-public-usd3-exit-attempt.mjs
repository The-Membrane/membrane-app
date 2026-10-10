// Private append-only run receipts for the local USD3 issue and score jobs.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import {
  HASH,
  appendNumbered,
  readNumbered,
  rotatingUsd3OriginPairs,
  sha,
  utc,
} from './carry-public-usd3-exit-common.mjs'
import { issuePublicUsd3Exit, verifyUsd3Issues } from './carry-public-usd3-exit-issue.mjs'
import { verifyUsd3Scores } from './carry-public-usd3-exit-score.mjs'
import { runUsd3ScoreSweep } from '../record-carry-public-usd3-exit-scores.mjs'

export const STUDY = 'carry_public_usd3_exit_attempt_v1'
export const OUT = resolve('data/research/venue-signals/carry-public-usd3-exit-attempts')
const STATUS = new Set(['completed', 'nothing_due', 'no_fresh_holder', 'deferred', 'failed'])

export function validateUsd3Attempt(row, issues, scores) {
  if (
    row?.study !== STUDY ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1 ||
    (row.sequence === 1 ? row.previousSha256 !== null : !HASH.test(row.previousSha256 ?? '')) ||
    !['issue', 'score'].includes(row.mode) ||
    !STATUS.has(row.status) ||
    !Array.isArray(row.records) ||
    row.records.length > 6 ||
    !Number.isSafeInteger(row.due) ||
    row.due < 0 ||
    !Number.isSafeInteger(row.attempted) ||
    row.attempted < 0 ||
    utc(row.finishedAtUtc) < utc(row.startedAtUtc) ||
    (row.status === 'failed') !== (row.failure !== null) ||
    (row.failure !== null && !/^usd3_[a-z0-9_]+$/.test(row.failure)) ||
    (row.status === 'nothing_due' && (row.records.length || row.due || row.attempted)) ||
    (row.status === 'no_fresh_holder' && (row.mode !== 'issue' || row.records.length)) ||
    (row.status === 'completed' && row.mode === 'issue' && row.records.length !== 1) ||
    (row.mode === 'issue' && row.attempted > 1) ||
    (row.mode === 'score' && row.attempted > 6)
  )
    throw Error('usd3_attempt_invalid')
  const list = row.mode === 'issue' ? issues : scores
  for (const record of row.records) {
    const sealed = list[record.sequence - 1]
    if (
      !Number.isSafeInteger(record.sequence) ||
      record.sequence < 1 ||
      !HASH.test(record.sha256 ?? '') ||
      sealed?.sha256 !== record.sha256
    )
      throw Error('usd3_attempt_link_invalid')
  }
  if (new Set(row.records.map((record) => record.sequence)).size !== row.records.length)
    throw Error('usd3_attempt_duplicate_link')
  return row
}

export async function verifyUsd3Attempts(
  out = OUT,
  loadIssues = verifyUsd3Issues,
  loadScores = verifyUsd3Scores,
) {
  const [issues, scores] = await Promise.all([loadIssues(), loadScores()])
  const attempts = await readNumbered(out)
  for (const row of attempts) validateUsd3Attempt(row, issues, scores)
  return { issues, scores, attempts }
}

export async function tickUsd3(
  mode,
  {
    now = () => new Date(),
    urls = configuredPublicRpcUrls(readEnv()),
    clientsFor = publicRpcClients,
    issue = issuePublicUsd3Exit,
    score = runUsd3ScoreSweep,
    out = OUT,
    loadIssues = verifyUsd3Issues,
    loadScores = verifyUsd3Scores,
    append = appendNumbered,
  } = {},
) {
  if (!['issue', 'score'].includes(mode)) throw Error('usd3_attempt_mode_invalid')
  const startedAtUtc = now().toISOString()
  const prior = await verifyUsd3Attempts(out, loadIssues, loadScores)
  const priorIssueCount = prior.issues.length
  const priorScoreCount = prior.scores.length
  let due = 0
  let attempted = 0
  let status = 'nothing_due'
  let failure = null
  try {
    if (mode === 'issue') {
      due = attempted = 1
      await issue({ originPairs: rotatingUsd3OriginPairs(urls, clientsFor) })
      status = 'completed'
    } else {
      const summary = await score({
        issues: prior.issues,
        scores: prior.scores,
        urls,
        now,
        clientsFor,
      })
      due = summary.due
      attempted = summary.attempted
      status = attempted ? 'completed' : due ? 'deferred' : 'nothing_due'
    }
  } catch (error) {
    const code = String(error?.message ?? '')
    if (mode === 'issue' && code === 'usd3_no_fresh_holder') {
      status = 'no_fresh_holder'
    } else {
      status = 'failed'
      failure = /^usd3_[a-z0-9_]+$/.test(code) ? code : 'usd3_unexpected_failure'
    }
  }
  const [issues, scores] = await Promise.all([loadIssues(), loadScores()])
  const before = mode === 'issue' ? priorIssueCount : priorScoreCount
  const after = mode === 'issue' ? issues : scores
  const records = after.slice(before).map((row) => ({ sequence: row.sequence, sha256: row.sha256 }))
  if (mode === 'issue' && status === 'completed' && records.length !== 1)
    throw Error('usd3_attempt_issue_count_invalid')
  const row = {
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
  }
  row.sha256 = sha(JSON.stringify(row))
  validateUsd3Attempt(row, issues, scores)
  await append(
    row,
    out,
    async (path) => (await verifyUsd3Attempts(path, loadIssues, loadScores)).attempts,
  )
  if (status === 'failed') throw Error(failure)
  return { status, due, attempted, sealed: records.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2]
  try {
    if (mode === '--verify') {
      const state = await verifyUsd3Attempts()
      console.log(
        JSON.stringify({
          issues: state.issues.length,
          scores: state.scores.length,
          attempts: state.attempts.length,
        }),
      )
    } else if (mode === '--issue' || mode === '--score') {
      console.log(JSON.stringify(await tickUsd3(mode.slice(2))))
    } else throw Error('usd3_attempt_usage')
  } catch {
    process.stderr.write('public_usd3_attempt_failed\n')
    process.exitCode = 1
  }
}
