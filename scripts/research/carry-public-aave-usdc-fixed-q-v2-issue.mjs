// Prospective, immutable raw-Q follow-up of every covered Aave USDC V1 holder case.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls } from './carry-public-direct-exit-issue.mjs'
import { OUT as V1_OUT, verifyPublicDirectIssues } from './carry-public-direct-exit-issue.mjs'
import {
  HASH,
  appendNumbered,
  readNumbered,
  rotatingSghoOriginPairs,
  same,
  sha,
  utc,
} from './carry-public-sgho-exit-common.mjs'

export const STUDY = 'carry_public_aave_usdc_frozen_q_issue_v2'
export const OUT = resolve('data/research/venue-signals/carry-public-aave-usdc-frozen-q-v2-issues')
export const MARKET = 'aaveV3Usdc'
const MAX_BASELINE_AGE_MS = 45 * 60_000

export function followedAaveCases(parent) {
  if (parent?.marketKey !== MARKET || !parent.candidate?.holder) return []
  return parent.cases.flatMap((entry) => {
    if (entry.status !== 'measured' || !entry.assetsRaw) return []
    const measurement = entry.measurement
    if (!measurement || BigInt(measurement.holderCoverageRaw ?? 0) < BigInt(entry.assetsRaw))
      return []
    const baselineStatus =
      measurement.status === 'success'
        ? 'success'
        : measurement.status === 'evm_revert' && measurement.coveredRevert === true
          ? 'covered_revert'
          : null
    return baselineStatus
      ? [{ label: entry.label, assetsRaw: entry.assetsRaw, baselineStatus }]
      : []
  })
}

export function eligibleAaveParent(parent, atUtc) {
  if (!followedAaveCases(parent).length) return false
  const now = utc(atUtc)
  return (
    now >= utc(parent.issuedAtUtc) &&
    now < utc(parent.targets[0].targetAtUtc) &&
    now - utc(parent.baseline.targetBlockAt) <= MAX_BASELINE_AGE_MS
  )
}

export function validateAaveFrozenQIssue(issue, parents) {
  const parent = parents[issue?.v1IssueSequence - 1]
  if (
    !parent ||
    issue.study !== STUDY ||
    !Number.isSafeInteger(issue.sequence) ||
    issue.sequence < 1 ||
    (issue.sequence === 1
      ? issue.previousSha256 !== null
      : !HASH.test(issue.previousSha256 ?? '')) ||
    issue.v1IssueSha256 !== parent.sha256 ||
    !eligibleAaveParent(parent, issue.issuedAtUtc) ||
    issue.marketKey !== MARKET ||
    issue.routeKey !== parent.routeKey ||
    issue.destination !== parent.destination ||
    issue.originalAsset !== parent.originalAsset ||
    issue.holder !== parent.candidate.holder ||
    !same(issue.targets, parent.targets) ||
    !same(issue.cases, followedAaveCases(parent))
  )
    throw Error('aave_frozen_q_issue_binding_invalid')
  return issue
}

export function buildAaveFrozenQIssue({ parent, parents, issuedAtUtc, sequence, previousSha256 }) {
  const payload = {
    study: STUDY,
    sequence,
    previousSha256,
    v1IssueSequence: parent.sequence,
    v1IssueSha256: parent.sha256,
    marketKey: MARKET,
    routeKey: parent.routeKey,
    destination: parent.destination,
    originalAsset: parent.originalAsset,
    holder: parent.candidate.holder,
    issuedAtUtc,
    targets: parent.targets,
    cases: followedAaveCases(parent),
  }
  validateAaveFrozenQIssue(payload, parents)
  return { ...payload, sha256: sha(JSON.stringify(payload)) }
}

export async function verifyAaveFrozenQIssues(out = OUT, v1Out = V1_OUT) {
  const parents = await verifyPublicDirectIssues(v1Out)
  const rows = await readNumbered(out)
  const seen = new Set()
  for (const row of rows) {
    validateAaveFrozenQIssue(row, parents)
    if (seen.has(row.v1IssueSequence)) throw Error('aave_frozen_q_duplicate_parent')
    seen.add(row.v1IssueSequence)
  }
  return rows
}

export async function appendAaveFrozenQIssue(row, out = OUT, v1Out = V1_OUT) {
  const parents = await verifyPublicDirectIssues(v1Out)
  validateAaveFrozenQIssue(row, parents)
  const prior = await verifyAaveFrozenQIssues(out, v1Out)
  if (prior.some((entry) => entry.v1IssueSequence === row.v1IssueSequence))
    throw Error('aave_frozen_q_duplicate_parent')
  return appendNumbered(row, out, (path) => verifyAaveFrozenQIssues(path, v1Out))
}

export async function issueAaveFrozenQ({
  out = OUT,
  v1Out = V1_OUT,
  now = () => new Date(),
  loadParents = verifyPublicDirectIssues,
  load = verifyAaveFrozenQIssues,
  append = appendAaveFrozenQIssue,
}) {
  const parents = await loadParents(v1Out)
  const prior = await load(out, v1Out)
  const used = new Set(prior.map((row) => row.v1IssueSequence))
  const parent = parents.findLast(
    (entry) => !used.has(entry.sequence) && eligibleAaveParent(entry, now().toISOString()),
  )
  if (!parent) return { status: 'no_eligible_fresh_v1_issue' }
  const row = buildAaveFrozenQIssue({
    parent,
    parents,
    issuedAtUtc: now().toISOString(),
    sequence: prior.length + 1,
    previousSha256: prior.at(-1)?.sha256 ?? null,
  })
  return { status: 'issued', ...(await append(row, out, v1Out)) }
}

async function cli() {
  const mode = process.argv[2]
  if (mode === '--verify') {
    const issues = await verifyAaveFrozenQIssues()
    process.stdout.write(
      `${JSON.stringify({ status: 'verified_local_chain', issues: issues.length })}\n`,
    )
    return
  }
  if (mode !== '--issue-latest') throw Error('aave_frozen_q_issue_usage')
  // Check independently configured origins before recording a follow-up plan.
  rotatingSghoOriginPairs(configuredPublicRpcUrls(readEnv()))
  process.stdout.write(`${JSON.stringify(await issueAaveFrozenQ({}))}\n`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  cli().catch(() => {
    process.stderr.write('public_aave_frozen_q_issue_failed\n')
    process.exitCode = 1
  })
