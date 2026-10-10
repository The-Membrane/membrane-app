// Read-only NOW-origin exit labels. A row is an issue, including unscored issues.
// This table is descriptive; it is not a duration estimate or user alert.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { OUT as ISSUE_OUT, STUDY as ISSUE_STUDY } from './scrvusd-exit-forecast-issue.mjs'
import {
  OUT as SCORE_OUT,
  STUDY as SCORE_STUDY,
  verify as verifyScores,
} from './scrvusd-exit-forecast-score.mjs'

export const SCHEMA = 'scrvusd-prospective-exit-labels-v1'
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const validUtc = (value) =>
  typeof value === 'string' &&
  Number.isSafeInteger(Date.parse(value)) &&
  new Date(value).toISOString() === value
const observedBy = (value, cutoff) => validUtc(value) && Date.parse(value) <= cutoff
const ref = (row) => ({
  filename: row.filename,
  logicalSha256: row.issue.sha256,
  physicalSha256: row.physicalSha256,
})
const nameFor = (issue) =>
  `${String(issue.anchorBlock.number).padStart(12, '0')}-${issue.anchorBlock.hash.slice(2)}-${issue.horizonSeconds}s.json`

function readRows(out) {
  if (!existsSync(out)) return []
  return readdirSync(out)
    .filter((filename) => filename.endsWith('.json'))
    .sort()
    .map((filename) => {
      const bytes = readFileSync(join(out, filename))
      const issue = JSON.parse(bytes)
      const { sha256, ...payload } = issue
      if (
        !bytes.equals(Buffer.from(`${JSON.stringify(issue)}\n`)) ||
        sha256 !== sha(JSON.stringify(payload))
      )
        throw new Error('Exit label source physical or logical seal mismatch')
      return { filename, issue, physicalSha256: sha(bytes) }
    })
}

const snapshotIdentity = (rows) => rows.map((row) => [row.filename, row.physicalSha256])

// Read on both sides of the ledger verifier. A verifier observes files itself;
// accepting a later filesystem read would allow an unverified concurrent write.
// Return the pre-verification rows only when the exact filename/hash set stayed stable.
export function verifiedStableRows({ issueOut, scoreOut, verifyLedger }) {
  const before = { issues: readRows(issueOut), scores: readRows(scoreOut) }
  verifyLedger()
  const after = { issues: readRows(issueOut), scores: readRows(scoreOut) }
  if (
    JSON.stringify(snapshotIdentity(before.issues)) !==
      JSON.stringify(snapshotIdentity(after.issues)) ||
    JSON.stringify(snapshotIdentity(before.scores)) !==
      JSON.stringify(snapshotIdentity(after.scores))
  )
    throw new Error('Exit label ledger changed during verification')
  return before
}

// For deterministic synthetic checks. Production callers must use readLabels,
// which first replays both source ledgers through their existing verifiers.
export function labelsFromVerifiedRows({ issues, scores, asOfUtc }) {
  if (!validUtc(asOfUtc)) throw new Error('Invalid as-of UTC')
  if (!Array.isArray(issues) || !Array.isArray(scores)) throw new Error('Invalid label rows')
  const cutoff = Date.parse(asOfUtc)
  const byName = new Map()
  const bySemanticIssue = new Set()
  for (const row of issues) {
    const issue = row?.issue
    if (
      issue?.study !== ISSUE_STUDY ||
      row.filename !== nameFor(issue) ||
      !validUtc(issue.issuedAtUtc) ||
      !validUtc(issue.targetUtc) ||
      issue.targetUtc !==
        new Date(Date.parse(issue.issuedAtUtc) + issue.horizonSeconds * 1000).toISOString() ||
      issue.horizonOrigin !== 'issue_time' ||
      issue.route !== 'direct_erc4626_withdraw_crvusd_from_scrvusd' ||
      typeof issue.holder !== 'string' ||
      !/^[0-9]+$/.test(issue.qAssetsRaw ?? '') ||
      !['as_of_context', 'unavailable'].includes(issue.historicalContext?.flowStatus) ||
      (issue.historicalContext.flowStatus === 'as_of_context' && !issue.historicalContext.flow) ||
      !/^[0-9a-f]{64}$/.test(row.physicalSha256 ?? '')
    )
      throw new Error('Invalid verified exit issue row')
    const semanticKey = JSON.stringify([
      issue.anchorBlock.number,
      issue.anchorBlock.hash,
      issue.horizonSeconds,
    ])
    if (byName.has(row.filename) || bySemanticIssue.has(semanticKey))
      throw new Error('Duplicate exit issue')
    byName.set(row.filename, row)
    bySemanticIssue.add(semanticKey)
  }
  const scoreByIssue = new Map()
  for (const row of scores) {
    const score = row?.issue
    const issueRow = byName.get(row.filename)
    if (
      score?.study !== SCORE_STUDY ||
      !issueRow ||
      !validUtc(score.scoredAtUtc) ||
      !/^[0-9a-f]{64}$/.test(row.physicalSha256 ?? '') ||
      JSON.stringify(score.issue) !== JSON.stringify(ref(issueRow)) ||
      score.targetUtc !== issueRow.issue.targetUtc ||
      score.horizonSeconds !== issueRow.issue.horizonSeconds ||
      score.pointOutcome?.holder !== issueRow.issue.holder ||
      score.pointOutcome?.qAssetsRaw !== issueRow.issue.qAssetsRaw ||
      score.pointOutcome?.route !== issueRow.issue.route ||
      Date.parse(score.scoredAtUtc) < Date.parse(issueRow.issue.issuedAtUtc)
    )
      throw new Error('Exit score does not match its verified issue')
    if (scoreByIssue.has(row.filename)) throw new Error('Duplicate exit score')
    scoreByIssue.set(row.filename, row)
  }
  const rows = issues
    .filter((row) => observedBy(row.issue.issuedAtUtc, cutoff))
    .map((row) => {
      const issue = row.issue
      const scoreRow = scoreByIssue.get(row.filename)
      const visibleScore =
        scoreRow && observedBy(scoreRow.issue.scoredAtUtc, cutoff) ? scoreRow : null
      const score = visibleScore?.issue
      return {
        issue: ref(row),
        issuedAtUtc: issue.issuedAtUtc,
        anchorBlock: issue.anchorBlock,
        holder: issue.holder,
        qAssetsRaw: issue.qAssetsRaw,
        route: issue.route,
        horizonOrigin: issue.horizonOrigin,
        horizonSeconds: issue.horizonSeconds,
        targetUtc: issue.targetUtc,
        baseline: issue.currentExecutableAbility,
        baselineCodeIdentity: issue.currentMechanismContext,
        historicalFlowStatus: issue.historicalContext.flowStatus,
        historicalFlowContext: issue.historicalContext.flow,
        score: score
          ? {
              status: 'observed',
              ref: ref(visibleScore),
              scoredAtUtc: score.scoredAtUtc,
              evidenceCutoffUtc: score.evidenceCutoffUtc,
              sourceFrontier: score.sourceFrontier,
              selectedQuote: score.selectedQuote,
              pointOutcome: score.pointOutcome,
              trajectory: score.trajectory,
              sampledCodeIdentity: score.sampledCodeIdentity,
            }
          : {
              status: 'pending',
              ref: null,
              scoredAtUtc: null,
              evidenceCutoffUtc: null,
              sourceFrontier: null,
              selectedQuote: null,
              pointOutcome: null,
              trajectory: null,
              sampledCodeIdentity: null,
            },
      }
    })
  return {
    schema: SCHEMA,
    asOfUtc,
    status: rows.length ? 'descriptive_uncalibrated' : 'unavailable',
    denominators: {
      issues: rows.length,
      scored: rows.filter((row) => row.score.status === 'observed').length,
      pending: rows.filter((row) => row.score.status === 'pending').length,
    },
    forecast: { status: 'unavailable', probability: null, likelyDurationSeconds: null },
    caveat:
      'Point outcomes are discrete same-block read-only simulations; pending and missing evidence are not exit failures. No continuous ability, independent calibration, or alert is inferred.',
    rows,
  }
}

export function readLabels({
  asOfUtc,
  issueOut = ISSUE_OUT,
  scoreOut = SCORE_OUT,
  roots = {},
  now = () => new Date(),
} = {}) {
  if (!validUtc(asOfUtc)) throw new Error('Invalid as-of UTC')
  if (Date.parse(asOfUtc) > now().getTime()) throw new Error('Future as-of UTC')
  const rows = verifiedStableRows({
    issueOut,
    scoreOut,
    verifyLedger: () => verifyScores({ out: scoreOut, issueOut, roots, now }),
  })
  return labelsFromVerifiedRows({ ...rows, asOfUtc })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [asOfUtc = new Date().toISOString()] = process.argv.slice(2)
    console.log(JSON.stringify(readLabels({ asOfUtc })))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
