// Prospective local same-holder/Q Morpho VaultV2 withdrawal simulations.
// These are read-only chain outcomes, never mined asset delivery or a forecast.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  captureFreshMorphoBaseline,
  discoverMorphoIssuerCandidate,
} from '../lib/carry-exit-v2-morpho-issuer-prep.mjs'
import {
  CARRY_EXIT_V2_FROZEN_ROUTES,
  validateCarryExitV2RpcProof,
} from '../lib/carry-exit-v2-rpc-proof.mjs'
import { selectCarryExitV2FirstFinalizedBlock } from '../lib/carry-exit-v2-block-auditor.mjs'
import { assembleCarryExitV2CallEvidence } from '../lib/carry-exit-v2-proof-assembly.mjs'
import { measureCarryExitV2Verified } from '../lib/carry-exit-v2-verified-measurement.mjs'
import { readEnv } from '../lib/venue-reads.mjs'
import {
  configuredPublicRpcUrls,
  publicRpcClients,
  slicedCandidateRequest,
} from './carry-public-direct-exit-issue.mjs'
import {
  ISSUE_DIR,
  ATTEMPT_DIR,
  SCORE_DIR,
  appendChain,
  hash,
  readChain,
} from './carry-local-morpho-holder-store.mjs'

export const ISSUE_STUDY = 'carry_local_morpho_holder_issue_v1'
export const SCORE_STUDY = 'carry_local_morpho_holder_score_v1'
export const ROUTES = Object.freeze(
  CARRY_EXIT_V2_FROZEN_ROUTES.filter((route) => route.kind === 'morpho').sort((a, b) =>
    `${a.destination}:${a.routeKey}`.localeCompare(`${b.destination}:${b.routeKey}`),
  ),
)
export const HORIZONS = Object.freeze([1, 24])
const HOUR = 3_600_000
const SLOT = 15 * 60_000
const HASH = /^[0-9a-f]{64}$/
const BLOCK = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const DECIMAL = /^[1-9][0-9]*$/
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const ms = (value) => {
  const valueMs = Date.parse(value)
  if (!Number.isFinite(valueMs) || new Date(valueMs).toISOString() !== value)
    throw Error('holder_time_invalid')
  return valueMs
}
export function originIdentity(value) {
  const parsed = new URL(value)
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw Error('holder_origin_invalid')
  const hostname = parsed.hostname.replace(/\.$/, '').replace(/^www\./, '')
  return /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/.test(hostname) ? 'loopback' : hostname
}
const hostsDiffer = (a, b) => originIdentity(a) !== originIdentity(b)

export function replayHeaderMatches(replay, blockNumber, blockHash, blockAt) {
  try {
    return (
      replay?.hash === blockHash &&
      BigInt(replay.number) === BigInt(blockNumber) &&
      new Date(Number(BigInt(replay.timestamp)) * 1000).toISOString() === blockAt
    )
  } catch {
    return false
  }
}

export function verifyMeasurement({
  route,
  holder,
  assetsRaw,
  blockNumber,
  blockHash,
  blockAt,
  source,
  evidence,
  before,
  after,
}) {
  if (
    evidence?.verificationStatus !== 'verified' ||
    evidence.identityEvidence?.holder !== holder ||
    evidence.identityEvidence?.destination !== route.destination ||
    evidence.identityEvidence?.asset !== route.asset ||
    evidence.identityEvidence?.blockNumber !== blockNumber ||
    evidence.identityEvidence?.blockHash !== blockHash ||
    evidence.identityEvidence?.source !== source ||
    evidence.replayEvidenceDoc?.blockNumber !== blockNumber ||
    evidence.replayEvidenceDoc?.blockHash !== blockHash ||
    ms(evidence.replayEvidenceDoc?.observedAt) < ms(before) ||
    ms(evidence.replayEvidenceDoc?.observedAt) > ms(after)
  )
    throw Error('holder_measurement_identity_invalid')
  for (const origin of ['primary', 'secondary'])
    for (const phase of ['before', 'after']) {
      const replay = evidence.replayEvidenceDoc.headers?.[origin]?.[phase]?.target
      if (!replayHeaderMatches(replay, blockNumber, blockHash, blockAt))
        throw Error('holder_measurement_header_invalid')
    }
  const frozen = { ...route, holder, assetsRaw, blockNumber, blockHash }
  const decoded = validateCarryExitV2RpcProof({ proof: evidence, ...frozen })
  const reconstructed = assembleCarryExitV2CallEvidence({
    frozen,
    collector: {
      status: 'raw_rpc_collected',
      blockNumber,
      blockHash,
      routeKind: 'morpho',
      provider: evidence.identityEvidence.provider,
      source,
      proof: evidence,
      identityEvidence: evidence.identityEvidence,
    },
    replay: {
      status: 'verified',
      verdict: { simulationStatus: decoded.simulationStatus, coveredRevert: decoded.coveredRevert },
      replayEvidenceDoc: evidence.replayEvidenceDoc,
    },
  })
  if (!equal(reconstructed, evidence)) throw Error('holder_measurement_replay_invalid')
  return decoded
}

export function validateIssue(issue) {
  const route = ROUTES.find(
    (item) =>
      item.routeKey === issue?.routeKey &&
      item.destination === issue.destination &&
      item.asset === issue.asset,
  )
  if (
    !route ||
    issue.study !== ISSUE_STUDY ||
    issue.chainId !== 1 ||
    !Number.isSafeInteger(issue.sequence) ||
    issue.sequence < 1 ||
    !Number.isSafeInteger(issue.slot) ||
    issue.slot < 0 ||
    issue.clock?.kind !== 'local_operator_clock' ||
    issue.clock?.independentWitness !== null ||
    issue.clock?.externalTimestampProof !== false ||
    issue.clock.operatorIssuedAtUtc !== issue.issuedAtUtc ||
    !equal(issue.horizonsHours, HORIZONS) ||
    issue.baseline?.routeKey !== route.routeKey ||
    issue.baseline?.destination !== route.destination ||
    issue.baseline?.asset !== route.asset ||
    !DECIMAL.test(issue.baseline?.targetBlock ?? '') ||
    !BLOCK.test(issue.baseline?.targetHash ?? '') ||
    issue.baseline.canonicalityEvidenceDoc?.targetHeader?.hash !== issue.baseline.targetHash ||
    issue.baseline.canonicalityEvidenceDoc?.targetHeader?.number !== issue.baseline.targetBlock ||
    issue.baseline.canonicalityEvidenceDoc?.source !== ISSUE_STUDY ||
    issue.baselineWitness?.hash !== issue.baseline.targetHash ||
    issue.baselineWitness?.block !== issue.baseline.targetBlock ||
    issue.baselineWitness?.asset !== route.asset ||
    issue.baselineWitness?.totalAssetsRaw !== issue.baseline.totalAssetsRaw ||
    issue.baselineWitness?.assetDecimals !== issue.baseline.assetDecimals ||
    !hostsDiffer(issue.baseline.canonicalityEvidenceDoc.provider, issue.baselineWitness.provider) ||
    !HASH.test(issue.candidate?.digest ?? '') ||
    issue.candidate.digest !== hash(JSON.stringify(issue.candidate.evidenceDoc)) ||
    issue.candidate.evidenceDoc?.baselineHash !== issue.baseline.targetHash ||
    issue.candidate.evidenceDoc?.destination !== route.destination ||
    issue.candidate.evidenceDoc?.asset !== route.asset ||
    issue.candidate.evidenceDoc?.routeKey !== route.routeKey ||
    !equal(
      issue.targets,
      HORIZONS.map((horizonHours) => ({
        horizonHours,
        targetAtUtc: new Date(ms(issue.issuedAtUtc) + horizonHours * HOUR).toISOString(),
        captureDeadlineUtc: new Date(
          ms(issue.issuedAtUtc) + (horizonHours + 2) * HOUR,
        ).toISOString(),
      })),
    )
  )
    throw Error('holder_issue_invalid')
  const issued = ms(issue.issuedAtUtc)
  if (
    Math.floor(issued / SLOT) !== issue.slot ||
    ms(issue.baseline.targetObservedAt) > issued ||
    issued - ms(issue.baseline.targetBlockAt) > HOUR ||
    ms(issue.baselineWitness.observedAtUtc) > issued ||
    !['issued', 'no_holder', 'baseline_unavailable'].includes(issue.status)
  )
    throw Error('holder_issue_clock_invalid')
  const q = issue.case
  if (issue.status === 'issued') {
    const ladder = issue.candidate.evidenceDoc.ladder
    if (
      !ADDRESS.test(issue.holder ?? '') ||
      issue.candidate.evidenceDoc.selectedHolderCommitment !==
        hash(`${route.destination}:${issue.holder}`) ||
      ladder?.basis !== 'frozen_holder_claim_and_vault_total_assets_raw' ||
      ladder.totalAssetsRaw !== issue.baseline.totalAssetsRaw ||
      !DECIMAL.test(ladder.selectedClaimRaw ?? '') ||
      ladder.labels?.find((entry) => entry.label === q?.label)?.assetsRaw !== q?.assetsRaw ||
      BigInt(q?.assetsRaw ?? 0) > BigInt(ladder.selectedClaimRaw) ||
      !DECIMAL.test(q?.assetsRaw ?? '') ||
      q?.label !== 'holder_half_claim_capped_vault_0p001pct' ||
      q.baselineStatus !== 'simulated_withdraw_success' ||
      !HASH.test(q.evidenceSha256 ?? '') ||
      q.evidenceSha256 !== hash(JSON.stringify(q.evidence)) ||
      verifyMeasurement({
        route,
        holder: issue.holder,
        assetsRaw: q.assetsRaw,
        blockNumber: issue.baseline.targetBlock,
        blockHash: issue.baseline.targetHash,
        blockAt: issue.baseline.targetBlockAt,
        source: ISSUE_STUDY,
        evidence: q.evidence,
        before: issue.baseline.targetBlockAt,
        after: issue.issuedAtUtc,
      }).simulationStatus !== 'success'
    )
      throw Error('holder_issue_measurement_invalid')
  } else if (issue.holder !== null || issue.case !== null)
    throw Error('holder_issue_unavailable_invalid')
  return issue
}

export function validateTarget(target, issue, plan, scoredAtUtc, source) {
  const doc = target?.canonicalityEvidenceDoc
  if (
    !target ||
    !doc ||
    doc.schema !== 'carry_exit_v2_headers_v1' ||
    doc.chainId !== '1' ||
    doc.finalityTag !== 'finalized' ||
    doc.source !== source ||
    doc.targetAt !== plan.targetAtUtc ||
    doc.observedAt !== target.targetObservedAt ||
    doc.baselineHeader?.number !== issue.baseline.targetBlock ||
    doc.baselineHeader?.hash !== issue.baseline.targetHash ||
    doc.baselineHeader?.timestamp !== issue.baseline.targetBlockAt ||
    doc.targetHeader?.number !== target.targetBlock ||
    doc.targetHeader?.hash !== target.targetHash ||
    doc.targetHeader?.parentHash !== target.targetParentHash ||
    doc.targetHeader?.timestamp !== target.targetBlockAt ||
    doc.parentHeader?.number !== target.targetParentBlock ||
    doc.parentHeader?.hash !== target.targetParentHash ||
    doc.parentHeader?.timestamp !== target.targetParentBlockAt ||
    target.parentHeaderHash !== target.targetParentHash ||
    !DECIMAL.test(target.targetBlock ?? '') ||
    !DECIMAL.test(target.targetParentBlock ?? '') ||
    !BLOCK.test(target.targetHash ?? '') ||
    !BLOCK.test(target.targetParentHash ?? '') ||
    !DECIMAL.test(doc.finalizedHead?.number ?? '') ||
    BigInt(target.targetBlock) !== BigInt(target.targetParentBlock) + 1n ||
    BigInt(target.targetBlock) <= BigInt(issue.baseline.targetBlock) ||
    BigInt(doc.finalizedHead.number) < BigInt(target.targetBlock) ||
    ms(target.targetParentBlockAt) >= ms(plan.targetAtUtc) ||
    ms(target.targetBlockAt) < ms(plan.targetAtUtc) ||
    ms(target.targetBlockAt) > ms(plan.captureDeadlineUtc) ||
    ms(doc.finalizedHead.timestamp) < ms(target.targetBlockAt) ||
    ms(target.targetObservedAt) < ms(target.targetBlockAt) ||
    ms(target.targetObservedAt) > ms(scoredAtUtc)
  )
    throw Error('holder_score_target_boundary_invalid')
}

export function validateScore(score, issues) {
  const issue = issues[score?.issueSequence - 1]
  const plan = issue?.targets.find((item) => item.horizonHours === score.horizonHours)
  if (
    !issue ||
    !plan ||
    issue.status !== 'issued' ||
    score.study !== SCORE_STUDY ||
    score.issueSha256 !== issue.sha256 ||
    score.routeKey !== issue.routeKey ||
    score.destination !== issue.destination ||
    score.asset !== issue.asset ||
    score.holder !== issue.holder ||
    score.assetsRaw !== issue.case.assetsRaw ||
    score.targetAtUtc !== plan.targetAtUtc ||
    score.captureDeadlineUtc !== plan.captureDeadlineUtc ||
    ![
      'simulated_withdraw_success',
      'covered_revert_cause_unknown',
      'holder_attrition',
      'preview_gap',
      'inconclusive_revert',
      'censored_capture_window_missed',
    ].includes(score.outcome)
  )
    throw Error('holder_score_issue_binding_invalid')
  const scored = ms(score.scoredAtUtc)
  if (scored < ms(plan.targetAtUtc)) throw Error('holder_score_early')
  if (score.outcome === 'censored_capture_window_missed') {
    if (
      scored <= ms(plan.captureDeadlineUtc) ||
      score.target !== null ||
      score.targetWitness !== null ||
      score.evidence !== null
    )
      throw Error('holder_score_censor_invalid')
    return score
  }
  if (
    scored > ms(plan.captureDeadlineUtc) ||
    !score.target ||
    !score.targetWitness ||
    !score.evidence ||
    score.target.targetBlock !== score.targetWitness.targetBlock ||
    score.target.targetHash !== score.targetWitness.targetHash ||
    score.target.targetParentHash !== score.targetWitness.targetParentHash ||
    !hostsDiffer(
      score.target.canonicalityEvidenceDoc?.provider,
      score.targetWitness.canonicalityEvidenceDoc?.provider,
    ) ||
    !HASH.test(score.evidenceSha256 ?? '') ||
    score.evidenceSha256 !== hash(JSON.stringify(score.evidence)) ||
    score.evidence.identityEvidence?.holder !== issue.holder ||
    score.evidence.identityEvidence?.destination !== issue.destination ||
    score.evidence.identityEvidence?.asset !== issue.asset ||
    score.evidence.identityEvidence?.blockNumber !== score.target.targetBlock ||
    score.evidence.identityEvidence?.blockHash !== score.target.targetHash ||
    score.evidence.verificationStatus !== 'verified'
  )
    throw Error('holder_score_measurement_invalid')
  validateTarget(score.target, issue, plan, score.scoredAtUtc, SCORE_STUDY)
  validateTarget(score.targetWitness, issue, plan, score.scoredAtUtc, SCORE_STUDY)
  const decoded = verifyMeasurement({
    route: { routeKey: issue.routeKey, destination: issue.destination, asset: issue.asset },
    holder: issue.holder,
    assetsRaw: issue.case.assetsRaw,
    blockNumber: score.target.targetBlock,
    blockHash: score.target.targetHash,
    blockAt: score.target.targetBlockAt,
    source: SCORE_STUDY,
    evidence: score.evidence,
    before: score.target.targetBlockAt,
    after: score.scoredAtUtc,
  })
  if (classify(decoded) !== score.outcome) throw Error('holder_score_outcome_invalid')
  return score
}

export function classify(decoded) {
  if (decoded.routeKind !== 'morpho') throw Error('holder_route_kind_invalid')
  if (decoded.simulationStatus === 'success') return 'simulated_withdraw_success'
  if (decoded.simulationStatus !== 'evm_revert') throw Error('holder_simulation_invalid')
  if (BigInt(decoded.holderCoverageRaw) === 0n) return 'holder_attrition'
  if (BigInt(decoded.requiredCoverageRaw) < BigInt(decoded.requiredAssetsRaw)) return 'preview_gap'
  return decoded.coveredRevert ? 'covered_revert_cause_unknown' : 'inconclusive_revert'
}

export const readIssues = () => readChain(ISSUE_DIR, validateIssue)
export function validateAttempt(attempt) {
  const route = ROUTES.find(
    (entry) =>
      entry.routeKey === attempt?.routeKey &&
      entry.destination === attempt.destination &&
      entry.asset === attempt.asset,
  )
  if (
    !route ||
    attempt.study !== 'carry_local_morpho_holder_attempt_v1' ||
    !Number.isSafeInteger(attempt.slot) ||
    attempt.slot < 0 ||
    Math.floor(ms(attempt.startedAtUtc) / SLOT) !== attempt.slot ||
    ms(attempt.finishedAtUtc) < ms(attempt.startedAtUtc) ||
    !['issued', 'no_holder', 'baseline_unavailable', 'duplicate', 'origin_unavailable'].includes(
      attempt.status,
    ) ||
    (attempt.issueSha256 !== null && !HASH.test(attempt.issueSha256 ?? '')) ||
    !attempt.originFailures ||
    typeof attempt.originFailures !== 'object' ||
    Object.entries(attempt.originFailures).some(
      ([code, count]) => !/^[a-z0-9_]+$/.test(code) || !Number.isSafeInteger(count) || count < 1,
    )
  )
    throw Error('holder_attempt_invalid')
  return attempt
}
export const readAttempts = () => readChain(ATTEMPT_DIR, validateAttempt)
export async function readScores(issues = null) {
  const issueRows = issues ?? (await readIssues())
  return readChain(SCORE_DIR, (score) => validateScore(score, issueRows))
}

export async function baselineWitness(route, baseline, secondary, now) {
  const request = secondary.request.bind(secondary)
  if ((await request('eth_chainId', [])) !== '0x1') throw Error('holder_witness_chain_invalid')
  const block = await request('eth_getBlockByNumber', [
    `0x${BigInt(baseline.targetBlock).toString(16)}`,
    false,
  ])
  const finalized = await request('eth_getBlockByNumber', ['finalized', false])
  const pin = { blockHash: baseline.targetHash, requireCanonical: true }
  const assetWord = await request('eth_call', [{ to: route.destination, data: '0x38d52e0f' }, pin])
  const assetsWord = await request('eth_call', [{ to: route.destination, data: '0x01e1d114' }, pin])
  const decimalsWord = await request('eth_call', [{ to: route.asset, data: '0x313ce567' }, pin])
  if (
    block?.hash !== baseline.targetHash ||
    block?.parentHash !== baseline.targetParentHash ||
    BigInt(finalized?.number ?? -1) < BigInt(baseline.targetBlock) ||
    !/^0x[0-9a-f]{64}$/.test(assetWord ?? '') ||
    `0x${assetWord.slice(-40)}` !== route.asset ||
    BigInt(assetsWord ?? -1).toString() !== baseline.totalAssetsRaw ||
    Number(BigInt(decimalsWord ?? -1)) !== baseline.assetDecimals
  )
    throw Error('holder_baseline_witness_mismatch')
  return {
    provider: secondary.provider,
    block: baseline.targetBlock,
    hash: baseline.targetHash,
    asset: route.asset,
    totalAssetsRaw: baseline.totalAssetsRaw,
    assetDecimals: baseline.assetDecimals,
    observedAtUtc: now().toISOString(),
  }
}

export async function issueOne({
  route,
  primary,
  secondary,
  now = () => new Date(),
  capture = captureFreshMorphoBaseline,
  discover = discoverMorphoIssuerCandidate,
  measure = measureCarryExitV2Verified,
  append = appendChain,
}) {
  if (
    !ROUTES.some(
      (item) =>
        item.routeKey === route.routeKey &&
        item.destination === route.destination &&
        item.asset === route.asset,
    ) ||
    !hostsDiffer(primary.provider, secondary.provider)
  )
    throw Error('holder_issue_route_or_origins_invalid')
  const baseline = await capture({
    ...route,
    provider: primary.provider,
    source: ISSUE_STUDY,
    request: primary.request.bind(primary),
    now,
  })
  const witness = await baselineWitness(route, baseline, secondary, now)
  const candidate = await discover({ baseline, request: slicedCandidateRequest(primary) })
  const q = candidate.evidenceDoc?.ladder?.labels?.find(
    (row) => row.label === 'holder_half_claim_capped_vault_0p001pct',
  )
  let holder = null
  let caseRow = null
  if (candidate.holder && DECIMAL.test(q?.assetsRaw ?? '')) {
    const measured = await measure({
      ...route,
      holder: candidate.holder,
      assetsRaw: q.assetsRaw,
      target: baseline,
      provider: primary.provider,
      source: ISSUE_STUDY,
      send: primary.send.bind(primary),
      primary: { url: primary.url, request: primary.send.bind(primary) },
      secondary: { url: secondary.url, request: secondary.send.bind(secondary) },
      now,
    })
    if (measured.status === 'verified') {
      const decoded = validateCarryExitV2RpcProof({
        proof: measured.callEvidenceDoc,
        ...route,
        holder: candidate.holder,
        assetsRaw: q.assetsRaw,
        blockNumber: baseline.targetBlock,
        blockHash: baseline.targetHash,
      })
      if (decoded.simulationStatus === 'success') {
        holder = candidate.holder
        caseRow = {
          label: q.label,
          assetsRaw: q.assetsRaw,
          baselineStatus: 'simulated_withdraw_success',
          evidence: measured.callEvidenceDoc,
          evidenceSha256: hash(JSON.stringify(measured.callEvidenceDoc)),
        }
      }
    }
  }
  const issuedAtUtc = now().toISOString()
  const existing = await readIssues()
  const slot = Math.floor(ms(issuedAtUtc) / SLOT)
  if (
    existing.some(
      (row) =>
        row.slot === slot &&
        row.routeKey === route.routeKey &&
        row.destination === route.destination,
    )
  )
    return { status: 'duplicate', sequence: existing.at(-1).sequence }
  const status = holder ? 'issued' : candidate.holder ? 'baseline_unavailable' : 'no_holder'
  const row = await append(
    ISSUE_DIR,
    {
      study: ISSUE_STUDY,
      chainId: 1,
      routeKey: route.routeKey,
      destination: route.destination,
      asset: route.asset,
      slot,
      issuedAtUtc,
      clock: {
        kind: 'local_operator_clock',
        independentWitness: null,
        externalTimestampProof: false,
        operatorIssuedAtUtc: issuedAtUtc,
      },
      horizonsHours: HORIZONS,
      status,
      holder,
      case: caseRow,
      baseline,
      baselineWitness: witness,
      candidate,
      targets: HORIZONS.map((horizonHours) => ({
        horizonHours,
        targetAtUtc: new Date(ms(issuedAtUtc) + horizonHours * HOUR).toISOString(),
        captureDeadlineUtc: new Date(ms(issuedAtUtc) + (horizonHours + 2) * HOUR).toISOString(),
      })),
    },
    validateIssue,
  )
  return {
    status,
    sequence: row.sequence,
    routeKey: route.routeKey,
    baselineBlock: baseline.targetBlock,
    hasHolder: Boolean(holder),
    sha256: row.sha256,
  }
}

export async function scoreDue({
  pairs,
  now = () => new Date(),
  choose = selectCarryExitV2FirstFinalizedBlock,
  measure = measureCarryExitV2Verified,
  append = appendChain,
  decode = validateCarryExitV2RpcProof,
  readIssueRows = readIssues,
  readScoreRows = readScores,
  limit = 4,
}) {
  const issues = await readIssueRows()
  const scores = await readScoreRows(issues)
  if (
    !Array.isArray(pairs) ||
    pairs.length < 1 ||
    pairs.length > 8 ||
    pairs.some(({ primary, secondary }) => !hostsDiffer(primary.provider, secondary.provider))
  )
    throw Error('holder_score_origins_invalid')
  const workDeadline = Date.now() + 210_000
  const pending = issues
    .flatMap((issue) =>
      issue.status === 'issued'
        ? issue.targets
            .filter(
              (target) =>
                !scores.some(
                  (score) =>
                    score.issueSequence === issue.sequence &&
                    score.horizonHours === target.horizonHours,
                ),
            )
            .map((target) => ({ issue, target }))
        : [],
    )
    .filter(({ target }) => ms(target.targetAtUtc) <= now().getTime())
    .sort((a, b) => ms(a.target.captureDeadlineUtc) - ms(b.target.captureDeadlineUtc))
    .slice(0, limit)
  const counts = { measured: 0, censored: 0, retry: 0 }
  for (const { issue, target: plan } of pending) {
    const current = now().toISOString()
    const late = ms(current) > ms(plan.captureDeadlineUtc)
    let selected = null
    let witness = null
    let evidence = null
    let outcome = 'censored_capture_window_missed'
    if (!late) {
      let completed = false
      for (const { primary, secondary } of pairs) {
        if (Date.now() >= workDeadline) break
        try {
          const inputs = {
            targetAt: plan.targetAtUtc,
            baselineBlock: issue.baseline.targetBlock,
            baselineHash: issue.baseline.targetHash,
            provider: primary.provider,
            source: SCORE_STUDY,
            request: primary.request.bind(primary),
            now,
          }
          selected = await choose(inputs)
          witness = await choose({
            ...inputs,
            provider: secondary.provider,
            request: secondary.request.bind(secondary),
          })
          if (
            selected.targetBlock !== witness.targetBlock ||
            selected.targetHash !== witness.targetHash
          )
            throw Error('holder_target_origin_disagreement')
          const measured = await measure({
            routeKey: issue.routeKey,
            destination: issue.destination,
            asset: issue.asset,
            holder: issue.holder,
            assetsRaw: issue.case.assetsRaw,
            target: selected,
            provider: primary.provider,
            source: SCORE_STUDY,
            send: primary.send.bind(primary),
            primary: { url: primary.url, request: primary.send.bind(primary) },
            secondary: { url: secondary.url, request: secondary.send.bind(secondary) },
            now,
          })
          if (measured.status !== 'verified') throw Error('holder_score_replay_unavailable')
          evidence = measured.callEvidenceDoc
          const decoded = decode({
            proof: evidence,
            routeKey: issue.routeKey,
            destination: issue.destination,
            asset: issue.asset,
            holder: issue.holder,
            assetsRaw: issue.case.assetsRaw,
            blockNumber: selected.targetBlock,
            blockHash: selected.targetHash,
          })
          outcome = classify(decoded)
          completed = true
          break
        } catch {
          selected = null
          witness = null
          evidence = null
        }
      }
      if (!completed) {
        counts.retry++
        continue
      }
    }
    const scoredAtUtc = now().toISOString()
    if (!late && ms(scoredAtUtc) > ms(plan.captureDeadlineUtc)) {
      counts.retry++
      continue
    }
    await append(
      SCORE_DIR,
      {
        study: SCORE_STUDY,
        issueSequence: issue.sequence,
        issueSha256: issue.sha256,
        routeKey: issue.routeKey,
        destination: issue.destination,
        asset: issue.asset,
        holder: issue.holder,
        assetsRaw: issue.case.assetsRaw,
        horizonHours: plan.horizonHours,
        targetAtUtc: plan.targetAtUtc,
        captureDeadlineUtc: plan.captureDeadlineUtc,
        scoredAtUtc,
        outcome,
        target: late ? null : selected,
        targetWitness: late ? null : witness,
        evidence: late ? null : evidence,
        evidenceSha256: evidence ? hash(JSON.stringify(evidence)) : null,
      },
      (record) => validateScore(record, issues),
    )
    if (late) counts.censored++
    else counts.measured++
  }
  return { scanned: pending.length, counts, forecastValidated: false }
}

async function main() {
  const mode = process.argv[2]
  if (!['--issue', '--score', '--verify'].includes(mode) || process.argv.length > 4)
    throw Error('usage: --issue [route-index] | --score | --verify')
  const issues = await readIssues()
  const scores = await readScores(issues)
  const attempts = await readAttempts()
  if (mode === '--verify')
    return {
      issues: issues.length,
      scores: scores.length,
      attempts: attempts.length,
      issueSha256: issues.at(-1)?.sha256 ?? null,
      scoreSha256: scores.at(-1)?.sha256 ?? null,
      attemptSha256: attempts.at(-1)?.sha256 ?? null,
    }
  const { get } = readEnv()
  const urls = configuredPublicRpcUrls({ get })
  const origins = [...urls.slice(2), ...urls.slice(0, 2)]
  if (mode === '--score') {
    const pairs = origins.flatMap((url, index) => {
      const other = origins.find(
        (candidate, offset) => offset !== index && hostsDiffer(candidate, url),
      )
      if (!other) return []
      const [primary, secondary] = publicRpcClients([url, other])
      return [{ primary, secondary }]
    })
    return scoreDue({ pairs })
  }
  const routeIndex =
    process.argv[3] == null
      ? Math.floor(Date.now() / SLOT) % ROUTES.length
      : Number(process.argv[3])
  if (!Number.isInteger(routeIndex) || routeIndex < 0 || routeIndex >= ROUTES.length)
    throw Error('holder_route_index_invalid')
  const started = Date.now()
  const startedAtUtc = new Date(started).toISOString()
  const failures = {}
  const recordAttempt = async (status, issueSha256 = null) =>
    appendChain(
      ATTEMPT_DIR,
      {
        study: 'carry_local_morpho_holder_attempt_v1',
        routeKey: ROUTES[routeIndex].routeKey,
        destination: ROUTES[routeIndex].destination,
        asset: ROUTES[routeIndex].asset,
        slot: Math.floor(started / SLOT),
        startedAtUtc,
        finishedAtUtc: new Date().toISOString(),
        status,
        issueSha256,
        originFailures: failures,
      },
      validateAttempt,
    )
  for (let index = 0; index < origins.length && Date.now() - started < 8 * 60_000; index++) {
    const ordered = [origins[index], ...origins.filter((_, offset) => offset !== index)]
    const pair = publicRpcClients(ordered)
    const secondary = pair.find((client) => hostsDiffer(client.provider, pair[0].provider))
    if (!secondary) continue
    let result
    try {
      result = await issueOne({ route: ROUTES[routeIndex], primary: pair[0], secondary })
    } catch (error) {
      // An origin may fail its bounded log scan; retry independent origins.
      const code = /^[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'unavailable'
      failures[code] = (failures[code] ?? 0) + 1
      continue
    }
    await recordAttempt(result.status, result.sha256 ?? null)
    return result
  }
  if (process.env.MORPHO_HOLDER_DIAGNOSTIC === '1')
    process.stderr.write(`${JSON.stringify(failures)}\n`)
  await recordAttempt('origin_unavailable')
  throw Error('holder_all_origins_unavailable')
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      const reason = /^[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'unavailable'
      process.stderr.write(`carry_local_morpho_holder_failed:${reason}\n`)
      process.exitCode = 1
    })
