// Fixed one-GHO holder exit cohort. A V2 issue links to a verified V1 public-holder issue.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { measureCarryExitV2Verified } from '../lib/carry-exit-v2-verified-measurement.mjs'
import { validateCarryExitV2RpcProof } from '../lib/carry-exit-v2-rpc-proof.mjs'
import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls } from './carry-public-direct-exit-issue.mjs'
import { OUT as V1_OUT, verifySghoIssues } from './carry-public-sgho-exit-issue.mjs'
import {
  CAPTURE_DEADLINE_HOURS,
  HASH,
  HORIZONS_HOURS,
  ROUTE,
  appendNumbered,
  readNumbered,
  rotatingSghoOriginPairs,
  same,
  sha,
  utc,
  verifySghoMeasurement,
} from './carry-public-sgho-exit-common.mjs'

export const STUDY = 'carry_public_sgho_fixed_q_issue_v2'
export const OUT = resolve('data/research/venue-signals/carry-public-sgho-fixed-q-v2-issues')
export const FIXED_Q_RAW = '1000000000000000000'
const MAX_BASELINE_AGE_MS = 45 * 60_000

export function eligibleSghoV1Issue(v1, atUtc) {
  return Boolean(
    v1?.candidate?.holder &&
    BigInt(v1.candidate.evidenceDoc?.selectedClaimRaw ?? 0) >= BigInt(FIXED_Q_RAW) &&
    utc(atUtc) >= utc(v1.issuedAtUtc) &&
    utc(atUtc) - utc(v1.baseline.targetBlockAt) <= MAX_BASELINE_AGE_MS,
  )
}

/** One fixed-Q child per V1 parent; the 45-minute clock starts at the V1 baseline block. */
export function pendingSghoFixedQParentPlans(v1Issues, fixedQIssues, atUtc) {
  const used = new Set(fixedQIssues.map((row) => row.v1IssueSequence))
  return v1Issues
    .filter((parent) => !used.has(parent.sequence) && eligibleSghoV1Issue(parent, atUtc))
    .map((parent) => ({
      parent,
      issueDeadlineUtc: new Date(
        utc(parent.baseline.targetBlockAt) + MAX_BASELINE_AGE_MS,
      ).toISOString(),
    }))
    .sort(
      (a, b) =>
        utc(a.issueDeadlineUtc) - utc(b.issueDeadlineUtc) || a.parent.sequence - b.parent.sequence,
    )
}

export function validateSghoFixedQIssue(issue, v1Issues) {
  const parent = v1Issues[issue?.v1IssueSequence - 1]
  if (
    !parent ||
    issue.study !== STUDY ||
    !Number.isSafeInteger(issue.sequence) ||
    issue.sequence < 1 ||
    (issue.sequence === 1
      ? issue.previousSha256 !== null
      : !HASH.test(issue.previousSha256 ?? '')) ||
    issue.v1IssueSha256 !== parent.sha256 ||
    !eligibleSghoV1Issue(parent, issue.issuedAtUtc) ||
    issue.routeKey !== ROUTE.routeKey ||
    issue.destination !== ROUTE.destination ||
    issue.originalAsset !== ROUTE.asset ||
    issue.holder !== parent.candidate.holder ||
    issue.assetsRaw !== FIXED_Q_RAW ||
    !same(issue.horizonsHours, HORIZONS_HOURS) ||
    !same(
      issue.targets,
      HORIZONS_HOURS.map((hours) => ({
        horizonHours: hours,
        targetAtUtc: new Date(utc(issue.issuedAtUtc) + hours * 3_600_000).toISOString(),
        captureDeadlineUtc: new Date(
          utc(issue.issuedAtUtc) + (hours + CAPTURE_DEADLINE_HOURS) * 3_600_000,
        ).toISOString(),
      })),
    )
  )
    throw Error('sgho_fixed_q_issue_binding_invalid')
  const decoded = verifySghoMeasurement({
    holder: issue.holder,
    assetsRaw: FIXED_Q_RAW,
    blockNumber: parent.baseline.targetBlock,
    blockHash: parent.baseline.targetHash,
    blockAtUtc: parent.baseline.targetBlockAt,
    source: STUDY,
    measurement: issue.measurement,
    beforeAtUtc: parent.baseline.targetBlockAt,
    afterAtUtc: issue.issuedAtUtc,
  })
  if (
    BigInt(decoded.requiredCoverageRaw) === 0n ||
    issue.measurement.evidence.identityEvidence.provider !==
      parent.baseline.canonicalityEvidenceDoc.provider ||
    !['success', 'covered_revert'].includes(issue.baselineStatus) ||
    issue.baselineStatus !==
      (decoded.simulationStatus === 'success'
        ? 'success'
        : decoded.coveredRevert
          ? 'covered_revert'
          : 'inconclusive')
  )
    throw Error('sgho_fixed_q_issue_measurement_invalid')
  return issue
}

export function buildSghoFixedQIssue({
  parent,
  v1Issues,
  measurement,
  issuedAtUtc,
  sequence,
  previousSha256,
}) {
  const payload = {
    study: STUDY,
    sequence,
    previousSha256,
    v1IssueSequence: parent.sequence,
    v1IssueSha256: parent.sha256,
    routeKey: ROUTE.routeKey,
    destination: ROUTE.destination,
    originalAsset: ROUTE.asset,
    holder: parent.candidate.holder,
    assetsRaw: FIXED_Q_RAW,
    issuedAtUtc,
    horizonsHours: [...HORIZONS_HOURS],
    targets: HORIZONS_HOURS.map((hours) => ({
      horizonHours: hours,
      targetAtUtc: new Date(utc(issuedAtUtc) + hours * 3_600_000).toISOString(),
      captureDeadlineUtc: new Date(
        utc(issuedAtUtc) + (hours + CAPTURE_DEADLINE_HOURS) * 3_600_000,
      ).toISOString(),
    })),
    baselineStatus: measurement.baselineStatus,
    measurement,
  }
  validateSghoFixedQIssue(payload, v1Issues)
  return { ...payload, sha256: sha(JSON.stringify(payload)) }
}

export async function verifySghoFixedQIssues(out = OUT, v1Out = V1_OUT) {
  const v1Issues = await verifySghoIssues(v1Out)
  const rows = await readNumbered(out)
  const seen = new Set()
  for (const row of rows) {
    validateSghoFixedQIssue(row, v1Issues)
    if (seen.has(row.v1IssueSequence)) throw Error('sgho_fixed_q_duplicate_parent')
    seen.add(row.v1IssueSequence)
  }
  return rows
}

export async function appendSghoFixedQIssue(row, out = OUT, v1Out = V1_OUT, stat, options) {
  const parents = await verifySghoIssues(v1Out)
  validateSghoFixedQIssue(row, parents)
  const prior = await verifySghoFixedQIssues(out, v1Out)
  if (prior.some((entry) => entry.v1IssueSequence === row.v1IssueSequence))
    throw Error('sgho_fixed_q_duplicate_parent')
  return appendNumbered(row, out, (path) => verifySghoFixedQIssues(path, v1Out), stat, options)
}

export async function issueSghoFixedQ({
  originPairs,
  out = OUT,
  v1Out = V1_OUT,
  now = () => new Date(),
  loadParents = verifySghoIssues,
  load = verifySghoFixedQIssues,
  measure = measureCarryExitV2Verified,
  append = appendSghoFixedQIssue,
  oldestDeadlineFirst = false,
}) {
  const parents = await loadParents(v1Out)
  const prior = await load(out, v1Out)
  const pending = pendingSghoFixedQParentPlans(parents, prior, now().toISOString())
  if (!pending.length) return { status: 'no_eligible_fresh_v1_issue' }
  if (!Array.isArray(originPairs) || !originPairs.length || originPairs.length > 24)
    throw Error('sgho_fixed_q_two_origins_required')
  for (const { parent } of oldestDeadlineFirst ? pending : pending.slice(-1)) {
    const preferred = [
      parent.baseline.canonicalityEvidenceDoc.provider,
      parent.baselineWitness.provider,
    ]
    const pairs = originPairs.filter(
      (pair) =>
        pair?.length === 2 &&
        pair[0]?.provider === preferred[0] &&
        pair[1]?.provider === preferred[1],
    )
    for (const pair of pairs) {
      let measurement = null
      try {
        const verified = await measure({
          ...ROUTE,
          holder: parent.candidate.holder,
          assetsRaw: FIXED_Q_RAW,
          target: parent.baseline,
          provider: pair[0].provider,
          source: STUDY,
          send: pair[0].send,
          primary: { url: pair[0].url, request: pair[0].send },
          secondary: { url: pair[1].url, request: pair[1].send },
          now,
        })
        if (verified.status !== 'verified') continue
        const evidence = verified.callEvidenceDoc
        const decoded = validateCarryExitV2RpcProof({
          proof: evidence,
          ...ROUTE,
          holder: parent.candidate.holder,
          assetsRaw: FIXED_Q_RAW,
          blockNumber: parent.baseline.targetBlock,
          blockHash: parent.baseline.targetHash,
        })
        measurement = {
          baselineStatus:
            decoded.simulationStatus === 'success'
              ? 'success'
              : decoded.coveredRevert
                ? 'covered_revert'
                : 'inconclusive',
          simulationStatus: decoded.simulationStatus,
          holderSharesRaw: decoded.holderCoverageRaw,
          previewWithdrawSharesRaw: decoded.requiredCoverageRaw,
          burnedSharesRaw: decoded.actualConsumedRaw,
          coveredRevert: decoded.coveredRevert,
          evidence,
          evidenceSha256: sha(JSON.stringify(evidence)),
        }
      } catch {
        /* Another matching pair or parent may provide a verified replay. */
        continue
      }
      if (measurement.baselineStatus === 'inconclusive') continue
      if (!eligibleSghoV1Issue(parent, now().toISOString())) break
      const row = buildSghoFixedQIssue({
        parent,
        v1Issues: parents,
        measurement,
        issuedAtUtc: now().toISOString(),
        sequence: prior.length + 1,
        previousSha256: prior.at(-1)?.sha256 ?? null,
      })
      return { status: 'issued', ...(await append(row, out, v1Out)) }
    }
  }
  return { status: 'retry_baseline_replay' }
}

async function cli() {
  const mode = process.argv[2]
  if (mode === '--verify') {
    const issues = await verifySghoFixedQIssues()
    process.stdout.write(
      `${JSON.stringify({ status: 'verified_local_chain', issues: issues.length })}\n`,
    )
    return
  }
  if (!['--issue-latest', '--issue-due'].includes(mode)) throw Error('sgho_fixed_q_issue_usage')
  const originPairs = rotatingSghoOriginPairs(configuredPublicRpcUrls(readEnv()))
  process.stdout.write(
    `${JSON.stringify(await issueSghoFixedQ({ originPairs, oldestDeadlineFirst: mode === '--issue-due' }))}\n`,
  )
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  cli().catch(() => {
    process.stderr.write('public_sgho_fixed_q_issue_failed\n')
    process.exitCode = 1
  })
