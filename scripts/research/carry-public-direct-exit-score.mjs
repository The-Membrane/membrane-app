// Public-chain-only prospective direct-supply outcomes. The only holder/Q
// inputs are sealed public issues; no private database is opened here.
import { createHash, randomUUID } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { link, mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { selectCarryExitV2FirstFinalizedBlock } from '../lib/carry-exit-v2-block-auditor.mjs'
import { collectCarryExitV2RpcProof } from '../lib/carry-exit-v2-rpc-collector.mjs'
import { verifyCarryExitV2IndependentReplay } from '../lib/carry-exit-v2-independent-replay.mjs'
import { assembleCarryExitV2CallEvidence } from '../lib/carry-exit-v2-proof-assembly.mjs'
import { validateCarryExitV2RpcProof } from '../lib/carry-exit-v2-rpc-proof.mjs'
import { readEnv } from '../lib/venue-reads.mjs'
import {
  DIRECT_MARKETS,
  OUT as ISSUE_OUT,
  configuredPublicRpcUrls,
  publicRpcClients,
  verifyPublicDirectIssues,
} from './carry-public-direct-exit-issue.mjs'

export const STUDY = 'carry_public_direct_exit_score_v1'
export const OUT = resolve('data/research/venue-signals/carry-public-direct-exit-scores')
const MAX_SCORE_BYTES = 256 * 1024
const DISK_RESERVE_BYTES = 1_073_741_824
const HASH = /^[0-9a-f]{64}$/
const BLOCK_HASH = /^0x[0-9a-f]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const scoreName = (sequence) => `${String(sequence).padStart(8, '0')}.json`
const stripSeal = ({ sha256: _seal, ...body }) => body
const utc = (value) => {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value)
    throw Error('score_clock_invalid')
  return ms
}

function frozenCase(issue, entry, block) {
  return {
    ...DIRECT_MARKETS[issue.marketKey],
    holder: issue.candidate.holder,
    assetsRaw: entry.assetsRaw,
    blockNumber: block.targetBlock,
    blockHash: block.targetHash,
  }
}

function validatedMeasurement(issue, entry, target, measurement) {
  const frozen = frozenCase(issue, entry, target)
  const evidence = measurement?.evidence
  if (
    !evidence ||
    evidence.verificationStatus !== 'verified' ||
    !HASH.test(measurement.evidenceSha256 ?? '') ||
    measurement.evidenceSha256 !== sha(JSON.stringify(evidence)) ||
    evidence.identityEvidence?.holder !== frozen.holder ||
    evidence.identityEvidence?.asset !== frozen.asset ||
    evidence.identityEvidence?.destination !== frozen.destination ||
    evidence.identityEvidence?.blockNumber !== frozen.blockNumber ||
    evidence.identityEvidence?.blockHash !== frozen.blockHash ||
    evidence.replayEvidenceDoc?.blockNumber !== frozen.blockNumber ||
    evidence.replayEvidenceDoc?.blockHash !== frozen.blockHash
  )
    throw Error('score_evidence_identity_invalid')
  const decoded = validateCarryExitV2RpcProof({ proof: evidence, ...frozen })
  const reconstructed = assembleCarryExitV2CallEvidence({
    frozen,
    collector: {
      status: 'raw_rpc_collected',
      blockNumber: frozen.blockNumber,
      blockHash: frozen.blockHash,
      routeKind: DIRECT_MARKETS[issue.marketKey].kind,
      provider: evidence.identityEvidence.provider,
      source: evidence.identityEvidence.source,
      proof: evidence,
      identityEvidence: evidence.identityEvidence,
    },
    replay: {
      status: 'verified',
      verdict: {
        simulationStatus: decoded.simulationStatus,
        coveredRevert: decoded.coveredRevert,
      },
      replayEvidenceDoc: evidence.replayEvidenceDoc,
    },
  })
  if (
    !same(reconstructed, evidence) ||
    measurement.simulationStatus !== decoded.simulationStatus ||
    measurement.holderCoverageRaw !== decoded.holderCoverageRaw ||
    measurement.actualConsumedRaw !== decoded.actualConsumedRaw ||
    measurement.coveredRevert !== decoded.coveredRevert
  )
    throw Error('score_evidence_replay_invalid')
  return decoded
}

function validateTarget(issue, targetPlan, target) {
  if (!target) return
  const doc = target.canonicalityEvidenceDoc
  if (
    !DECIMAL.test(target.targetBlock ?? '') ||
    !BLOCK_HASH.test(target.targetHash ?? '') ||
    doc?.schema !== 'carry_exit_v2_headers_v1' ||
    doc.chainId !== '1' ||
    doc.finalityTag !== 'finalized' ||
    doc.targetAt !== targetPlan.targetAtUtc ||
    doc.targetHeader?.number !== target.targetBlock ||
    doc.targetHeader?.hash !== target.targetHash ||
    doc.targetHeader?.timestamp !== target.targetBlockAt ||
    doc.parentHeader?.number !== target.targetParentBlock ||
    doc.parentHeader?.hash !== target.targetParentHash ||
    doc.parentHeader?.timestamp !== target.targetParentBlockAt ||
    doc.targetHeader.parentHash !== target.targetParentHash ||
    doc.baselineHeader?.number !== issue.baseline.targetBlock ||
    doc.baselineHeader?.hash !== issue.baseline.targetHash ||
    doc.observedAt !== target.targetObservedAt ||
    BigInt(target.targetBlock) !== BigInt(target.targetParentBlock) + 1n ||
    BigInt(target.targetBlock) <= BigInt(issue.baseline.targetBlock) ||
    !DECIMAL.test(doc.finalizedHead?.number ?? '') ||
    BigInt(doc.finalizedHead.number) < BigInt(target.targetBlock) ||
    utc(target.targetParentBlockAt) >= utc(targetPlan.targetAtUtc) ||
    utc(target.targetBlockAt) < utc(targetPlan.targetAtUtc) ||
    utc(target.targetBlockAt) > utc(targetPlan.captureDeadlineUtc) ||
    utc(target.targetObservedAt) < utc(target.targetBlockAt)
  )
    throw Error('score_target_invalid')
}

export function classifyPublicDirectExitOutcome(decoded) {
  if (decoded?.simulationStatus === 'success') return 'exit_success'
  if (decoded?.simulationStatus === 'evm_revert' && decoded.coveredRevert === true)
    return 'exit_revert_cause_unknown'
  if (decoded?.simulationStatus === 'evm_revert' && decoded.coveredRevert === false)
    return 'holder_attrition'
  throw Error('score_outcome_unrecognized')
}

function validateScore(score, issues) {
  const issue = issues[score.issueSequence - 1]
  const plan = issue?.targets.find((target) => target.horizonHours === score.horizonHours)
  if (
    score.study !== STUDY ||
    !Number.isSafeInteger(score.sequence) ||
    score.sequence < 1 ||
    !issue ||
    !plan ||
    score.issueSha256 !== issue.sha256 ||
    score.marketKey !== issue.marketKey ||
    score.routeKey !== issue.routeKey ||
    score.destination !== issue.destination ||
    score.originalAsset !== issue.originalAsset ||
    score.holder !== issue.candidate.holder ||
    score.targetAtUtc !== plan.targetAtUtc ||
    score.captureDeadlineUtc !== plan.captureDeadlineUtc ||
    (score.sequence === 1
      ? score.previousSha256 !== null
      : !HASH.test(score.previousSha256 ?? '')) ||
    !Array.isArray(score.cases) ||
    score.cases.length !== issue.cases.length
  )
    throw Error('score_issue_binding_invalid')
  const scoredMs = utc(score.scoredAtUtc)
  if (scoredMs < utc(plan.targetAtUtc) || score.onTime !== scoredMs <= utc(plan.captureDeadlineUtc))
    throw Error('score_clock_invalid')
  validateTarget(issue, plan, score.target)
  if (!score.target && score.onTime) throw Error('score_missing_target_before_deadline')
  if (!score.onTime && score.target !== null) throw Error('score_late_target_invalid')
  if (score.target && utc(score.target.targetObservedAt) > scoredMs)
    throw Error('score_target_after_record')
  for (const [index, row] of score.cases.entries()) {
    const original = issue.cases[index]
    if (row.label !== original.label || row.assetsRaw !== original.assetsRaw)
      throw Error('score_case_binding_invalid')
    if (original.status !== 'measured' || original.measurement?.status !== 'success') {
      if (
        row.status !== 'ineligible' ||
        row.reason !== 'baseline_not_success' ||
        row.outcome !== null ||
        row.measurement !== null
      )
        throw Error('score_case_ineligible_invalid')
      continue
    }
    if (row.status === 'unavailable') {
      if (
        score.onTime ||
        row.reason !== 'capture_window_missed' ||
        row.outcome !== null ||
        row.measurement !== null
      )
        throw Error('score_case_unavailable_invalid')
      continue
    }
    if (!score.target || row.status !== 'measured' || row.reason !== null)
      throw Error('score_case_measurement_invalid')
    const decoded = validatedMeasurement(issue, original, score.target, row.measurement)
    const evidence = row.measurement.evidence
    if (
      evidence.identityEvidence.provider !== score.target.canonicalityEvidenceDoc.provider ||
      evidence.identityEvidence.source !== STUDY ||
      utc(evidence.replayEvidenceDoc.observedAt) < utc(score.target.targetBlockAt) ||
      utc(evidence.replayEvidenceDoc.observedAt) > scoredMs
    )
      throw Error('score_evidence_source_invalid')
    for (const origin of ['primary', 'secondary'])
      for (const phase of ['before', 'after']) {
        const header = evidence.replayEvidenceDoc.headers?.[origin]?.[phase]?.target
        if (
          header?.hash !== score.target.targetHash ||
          header?.parentHash !== score.target.targetParentHash ||
          new Date(Number(BigInt(header?.timestamp ?? -1)) * 1000).toISOString() !==
            score.target.targetBlockAt
        )
          throw Error('score_evidence_header_invalid')
      }
    if (!score.onTime || utc(evidence.replayEvidenceDoc.observedAt) > utc(plan.captureDeadlineUtc))
      throw Error('score_late_measurement_invalid')
    const expected = classifyPublicDirectExitOutcome(decoded)
    if (row.outcome !== expected) throw Error('score_outcome_invalid')
  }
  return score
}

export function buildPublicDirectScore({
  issue,
  issues,
  horizonHours,
  target,
  measurements,
  scoredAtUtc,
  sequence,
  previousSha256,
}) {
  const plan = issue.targets.find((entry) => entry.horizonHours === horizonHours)
  if (!plan) throw Error('score_horizon_invalid')
  const onTime = utc(scoredAtUtc) <= utc(plan.captureDeadlineUtc)
  if (!onTime && (target !== null || Object.keys(measurements ?? {}).length > 0))
    throw Error('score_late_measurement_invalid')
  const cases = issue.cases.map((entry) => {
    if (entry.status !== 'measured' || entry.measurement?.status !== 'success')
      return {
        label: entry.label,
        assetsRaw: entry.assetsRaw,
        status: 'ineligible',
        reason: 'baseline_not_success',
        outcome: null,
        measurement: null,
      }
    const measurement = measurements?.[entry.label] ?? null
    if (!measurement) {
      if (onTime) throw Error('score_pending_replay')
      return {
        label: entry.label,
        assetsRaw: entry.assetsRaw,
        status: 'unavailable',
        reason: 'capture_window_missed',
        outcome: null,
        measurement: null,
      }
    }
    const decoded = validatedMeasurement(issue, entry, target, measurement)
    return {
      label: entry.label,
      assetsRaw: entry.assetsRaw,
      status: 'measured',
      reason: null,
      outcome: classifyPublicDirectExitOutcome(decoded),
      measurement,
    }
  })
  const payload = {
    study: STUDY,
    sequence,
    previousSha256,
    issueSequence: issue.sequence,
    issueSha256: issue.sha256,
    marketKey: issue.marketKey,
    routeKey: issue.routeKey,
    destination: issue.destination,
    originalAsset: issue.originalAsset,
    holder: issue.candidate.holder,
    horizonHours,
    targetAtUtc: plan.targetAtUtc,
    captureDeadlineUtc: plan.captureDeadlineUtc,
    scoredAtUtc,
    onTime,
    target,
    cases,
  }
  validateScore(payload, issues)
  return { ...payload, sha256: sha(JSON.stringify(payload)) }
}

export async function verifyPublicDirectScores(out = OUT, issueOut = ISSUE_OUT) {
  const issues = await verifyPublicDirectIssues(issueOut)
  let names
  try {
    names = (await readdir(out)).filter((name) => name.endsWith('.json')).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const scores = []
  const keys = new Set()
  for (const name of names) {
    if (name !== scoreName(scores.length + 1)) throw Error('score_sequence_gap')
    const bytes = await readFile(join(out, name))
    if (bytes.length > MAX_SCORE_BYTES) throw Error('score_size_invalid')
    const score = JSON.parse(bytes.toString('utf8'))
    if (`${JSON.stringify(score)}\n` !== bytes.toString('utf8')) throw Error('score_noncanonical')
    validateScore(score, issues)
    if (
      score.sequence !== scores.length + 1 ||
      score.previousSha256 !== (scores.at(-1)?.sha256 ?? null) ||
      score.sha256 !== sha(JSON.stringify(stripSeal(score)))
    )
      throw Error('score_chain_invalid')
    const key = `${score.issueSequence}:${score.horizonHours}`
    if (keys.has(key)) throw Error('score_duplicate_target')
    keys.add(key)
    scores.push(score)
  }
  return scores
}

export async function appendPublicDirectScore(
  score,
  out = OUT,
  issueOut = ISSUE_OUT,
  stat = statfsSync,
  { linkFile = link } = {},
) {
  await mkdir(out, { recursive: true })
  const prior = await verifyPublicDirectScores(out, issueOut)
  const issues = await verifyPublicDirectIssues(issueOut)
  validateScore(score, issues)
  if (
    score.sequence !== prior.length + 1 ||
    score.previousSha256 !== (prior.at(-1)?.sha256 ?? null) ||
    prior.some(
      (row) => row.issueSequence === score.issueSequence && row.horizonHours === score.horizonHours,
    ) ||
    score.sha256 !== sha(JSON.stringify(stripSeal(score)))
  )
    throw Error('score_duplicate_or_chain_changed')
  const serialized = `${JSON.stringify(score)}\n`
  const size = Buffer.byteLength(serialized)
  if (size > MAX_SCORE_BYTES) throw Error('score_size_invalid')
  const disk = stat(out)
  if (Number(disk.bavail) * Number(disk.bsize) < DISK_RESERVE_BYTES + size)
    throw Error('score_disk_reserve')
  const temporary = join(out, `.score-${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(serialized)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await linkFile(temporary, join(out, scoreName(score.sequence)))
    const directory = await open(out, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await rm(temporary, { force: true })
  }
  return {
    sequence: score.sequence,
    issueSequence: score.issueSequence,
    horizonHours: score.horizonHours,
    sha256: score.sha256,
  }
}

async function captureOne({ issue, entry, target, primary, secondary }) {
  const route = DIRECT_MARKETS[issue.marketKey]
  const frozen = frozenCase(issue, entry, target)
  const collected = await collectCarryExitV2RpcProof({
    ...route,
    holder: issue.candidate.holder,
    assetsRaw: entry.assetsRaw,
    target,
    provider: primary.provider,
    source: STUDY,
    send: primary.send,
  })
  const replay = await verifyCarryExitV2IndependentReplay({
    ...frozen,
    proof: collected.proof,
    identityEvidence: collected.identityEvidence,
    primary: { url: primary.url, request: primary.send },
    secondary: { url: secondary.url, request: secondary.send },
  })
  if (replay.status !== 'verified') throw Error('score_replay_unavailable')
  const evidence = assembleCarryExitV2CallEvidence({ collector: collected, replay, frozen })
  const decoded = validateCarryExitV2RpcProof({ proof: collected.proof, ...frozen })
  return {
    simulationStatus: decoded.simulationStatus,
    holderCoverageRaw: decoded.holderCoverageRaw,
    actualConsumedRaw: decoded.actualConsumedRaw,
    coveredRevert: decoded.coveredRevert,
    evidence,
    evidenceSha256: sha(JSON.stringify(evidence)),
  }
}

export async function selectMatchingPublicDirectTarget({
  issue,
  plan,
  clients,
  select = selectCarryExitV2FirstFinalizedBlock,
  now = () => new Date(),
}) {
  const first = await select({
    targetAt: plan.targetAtUtc,
    baselineBlock: issue.baseline.targetBlock,
    baselineHash: issue.baseline.targetHash,
    provider: clients[0].provider,
    source: STUDY,
    request: clients[0].request.bind(clients[0]),
    now,
  })
  const second = await select({
    targetAt: plan.targetAtUtc,
    baselineBlock: issue.baseline.targetBlock,
    baselineHash: issue.baseline.targetHash,
    provider: clients[1].provider,
    source: STUDY,
    request: clients[1].request.bind(clients[1]),
    now,
  })
  if (
    first.targetBlock !== second.targetBlock ||
    first.targetHash !== second.targetHash ||
    first.targetBlockAt !== second.targetBlockAt ||
    first.targetParentHash !== second.targetParentHash ||
    first.targetParentBlockAt !== second.targetParentBlockAt
  )
    throw Error('score_target_disagreement')
  return first
}

export async function scorePublicDirectExit({
  issueSequence,
  horizonHours,
  clients,
  out = OUT,
  issueOut = ISSUE_OUT,
  now = () => new Date(),
  select = selectCarryExitV2FirstFinalizedBlock,
  capture = captureOne,
  append = appendPublicDirectScore,
  loadIssues = verifyPublicDirectIssues,
  loadScores = verifyPublicDirectScores,
}) {
  const issues = await loadIssues(issueOut)
  const issue = issues[issueSequence - 1]
  const plan = issue?.targets.find((entry) => entry.horizonHours === horizonHours)
  if (!issue || !plan) throw Error('score_unknown_issue_or_horizon')
  const nowMs = now().getTime()
  if (nowMs < utc(plan.targetAtUtc)) return { status: 'not_due' }
  const prior = await loadScores(out, issueOut)
  if (prior.some((row) => row.issueSequence === issueSequence && row.horizonHours === horizonHours))
    return { status: 'already_scored' }
  if (
    !issue.cases.some(
      (entry) => entry.status === 'measured' && entry.measurement?.status === 'success',
    )
  )
    return { status: 'no_eligible_baseline' }
  if (
    !Array.isArray(clients) ||
    clients.length !== 2 ||
    clients[0].provider === clients[1].provider
  )
    throw Error('independent_public_origins_required')
  const deadlineMs = utc(plan.captureDeadlineUtc)
  let target = null
  const measurements = {}
  if (now().getTime() <= deadlineMs) {
    try {
      target = await selectMatchingPublicDirectTarget({ issue, plan, clients, select, now })
    } catch {
      if (now().getTime() <= deadlineMs) return { status: 'retry_target_unavailable' }
    }
    if (target)
      for (const entry of issue.cases) {
        if (entry.status !== 'measured' || entry.measurement?.status !== 'success') continue
        if (now().getTime() > deadlineMs) break
        try {
          measurements[entry.label] = await capture({
            issue,
            entry,
            target,
            primary: clients[0],
            secondary: clients[1],
          })
        } catch {
          if (now().getTime() <= deadlineMs) return { status: 'retry_replay_unavailable' }
        }
      }
  }
  const scoredAtUtc = now().toISOString()
  if (utc(scoredAtUtc) > deadlineMs) {
    target = null
    for (const label of Object.keys(measurements)) delete measurements[label]
  }
  if (!target && utc(scoredAtUtc) <= deadlineMs) return { status: 'retry_target_unavailable' }
  const score = buildPublicDirectScore({
    issue,
    issues,
    horizonHours,
    target,
    measurements,
    scoredAtUtc,
    sequence: prior.length + 1,
    previousSha256: prior.at(-1)?.sha256 ?? null,
  })
  return { status: 'scored', ...(await append(score, out, issueOut)) }
}

/** Keep an operator's manual score on the two public origins sealed in its issue. */
export function publicScoreUrlsForIssue(issue, urls) {
  const provider = (url) => {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  }
  const primary = urls.find(
    (url) => provider(url) === issue?.baseline?.canonicalityEvidenceDoc?.provider,
  )
  const secondary = urls.find((url) => provider(url) === issue?.baselineWitness?.provider)
  if (!primary || !secondary) throw Error('score_issue_origins_unconfigured')
  return [primary, secondary]
}

async function cli() {
  const [mode, issueRaw, horizonRaw] = process.argv.slice(2)
  if (mode === '--verify') {
    const scores = await verifyPublicDirectScores()
    process.stdout.write(
      `${JSON.stringify({ status: 'verified_local_chain', scores: scores.length })}\n`,
    )
    return
  }
  if (mode !== '--score' || !DECIMAL.test(issueRaw ?? '') || !DECIMAL.test(horizonRaw ?? ''))
    throw Error('score_usage')
  const issue = (await verifyPublicDirectIssues())[Number(issueRaw) - 1]
  if (!issue) throw Error('score_unknown_issue_or_horizon')
  const urls = configuredPublicRpcUrls(readEnv())
  const result = await scorePublicDirectExit({
    issueSequence: Number(issueRaw),
    horizonHours: Number(horizonRaw),
    clients: publicRpcClients(publicScoreUrlsForIssue(issue, urls)),
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch(() => {
    process.stderr.write('public_direct_score_failed\n')
    process.exitCode = 1
  })
}
