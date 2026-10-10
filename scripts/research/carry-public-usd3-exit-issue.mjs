// Public-chain-only USDC→USD3 prospective issue lane. It reads no future block.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  captureFreshSyncVaultBaseline,
  discoverSyncVaultIssuerCandidate,
  freezeSyncVaultQLadder,
} from '../lib/carry-exit-v2-sync-vault-issuer-prep.mjs'
import { measureCarryExitV2Verified } from '../lib/carry-exit-v2-verified-measurement.mjs'
import { validateCarryExitV2RpcProof } from '../lib/carry-exit-v2-rpc-proof.mjs'
import { readEnv } from '../lib/venue-reads.mjs'
import {
  configuredPublicRpcUrls,
  slicedCandidateRequest,
} from './carry-public-direct-exit-issue.mjs'
import {
  ADDRESS,
  BLOCK_HASH,
  CAPTURE_DEADLINE_HOURS,
  DECIMAL,
  HASH,
  HORIZONS_HOURS,
  ROUTE,
  assertUsd3ImplementationPair,
  appendNumbered,
  readNumbered,
  rotatingUsd3OriginPairs,
  same,
  sha,
  utc,
  verifyUsd3Measurement,
} from './carry-public-usd3-exit-common.mjs'

export const STUDY = 'carry_public_usd3_exit_issue_v1'
export const OUT = resolve('data/research/venue-signals/carry-public-usd3-exit-issues')
const SLOT_MS = 15 * 60_000
const WORD = /^0x[0-9a-f]{64}$/

export async function witnessUsd3Baseline(baseline, secondary, now = () => new Date()) {
  const request = secondary.request.bind(secondary)
  if ((await request('eth_chainId', [])) !== '0x1') throw Error('usd3_witness_chain_invalid')
  const block = await request('eth_getBlockByNumber', [
    `0x${BigInt(baseline.targetBlock).toString(16)}`,
    false,
  ])
  const finalized = await request('eth_getBlockByNumber', ['finalized', false])
  if (
    block?.hash !== baseline.targetHash ||
    block?.parentHash !== baseline.targetParentHash ||
    BigInt(block?.number ?? -1) !== BigInt(baseline.targetBlock) ||
    BigInt(finalized?.number ?? -1) < BigInt(baseline.targetBlock) ||
    (BigInt(finalized.number) === BigInt(baseline.targetBlock) &&
      finalized.hash !== baseline.targetHash)
  )
    throw Error('usd3_witness_header_disagreement')
  const pin = { blockHash: baseline.targetHash, requireCanonical: true }
  const call = (to, data) => request('eth_call', [{ to, data }, pin])
  const [vaultCode, assetCode, assetWord, totalAssets, totalSupply, shareDecimals, assetDecimals] =
    await Promise.all([
      request('eth_getCode', [ROUTE.destination, pin]),
      request('eth_getCode', [ROUTE.asset, pin]),
      call(ROUTE.destination, '0x38d52e0f'),
      call(ROUTE.destination, '0x01e1d114'),
      call(ROUTE.destination, '0x18160ddd'),
      call(ROUTE.destination, '0x313ce567'),
      call(ROUTE.asset, '0x313ce567'),
    ])
  if (
    ![assetWord, totalAssets, totalSupply, shareDecimals, assetDecimals].every((value) =>
      WORD.test(value ?? ''),
    ) ||
    !/^0x(?:[0-9a-f]{2})+$/.test(vaultCode ?? '') ||
    !/^0x(?:[0-9a-f]{2})+$/.test(assetCode ?? '') ||
    assetWord.slice(2, 26) !== '0'.repeat(24) ||
    `0x${assetWord.slice(-40)}` !== ROUTE.asset ||
    BigInt(totalAssets).toString() !== baseline.totalAssetsRaw ||
    BigInt(totalSupply).toString() !== baseline.totalSupplyRaw ||
    Number(BigInt(shareDecimals)) !== baseline.shareDecimals ||
    Number(BigInt(assetDecimals)) !== baseline.assetDecimals
  )
    throw Error('usd3_witness_state_disagreement')
  return {
    provider: secondary.provider,
    block: baseline.targetBlock,
    hash: baseline.targetHash,
    totalAssetsRaw: baseline.totalAssetsRaw,
    totalSupplyRaw: baseline.totalSupplyRaw,
    assetDecimals: baseline.assetDecimals,
    shareDecimals: baseline.shareDecimals,
    asset: ROUTE.asset,
    observedAtUtc: now().toISOString(),
  }
}

function unavailableCandidate(baseline) {
  const evidenceDoc = {
    schema: 'carry_public_usd3_candidate_unavailable_v1',
    chainId: '1',
    routeKey: ROUTE.routeKey,
    destination: ROUTE.destination,
    asset: ROUTE.asset,
    baselineBlock: baseline.targetBlock,
    baselineHash: baseline.targetHash,
    selectedHolderCommitment: null,
    selectedSharesRaw: null,
    selectedClaimRaw: null,
    unavailableReason: 'candidate_scan_unavailable',
    ladder: freezeSyncVaultQLadder({ totalAssetsRaw: baseline.totalAssetsRaw }),
  }
  return { holder: null, evidenceDoc, digest: sha(JSON.stringify(evidenceDoc)) }
}

export function validateUsd3Issue(issue) {
  if (
    !issue ||
    issue.study !== STUDY ||
    !Number.isSafeInteger(issue.sequence) ||
    issue.sequence < 1 ||
    issue.chainId !== 1 ||
    issue.routeKey !== ROUTE.routeKey ||
    issue.destination !== ROUTE.destination ||
    issue.originalAsset !== ROUTE.asset ||
    (issue.sequence === 1
      ? issue.previousSha256 !== null
      : !HASH.test(issue.previousSha256 ?? '')) ||
    !Number.isSafeInteger(issue.slot) ||
    issue.slot < 0 ||
    issue.clock?.kind !== 'local_operator_clock' ||
    issue.clock?.independentWitness !== null ||
    issue.clock?.externalTimestampProof !== false ||
    issue.clock?.operatorIssuedAtUtc !== issue.issuedAtUtc ||
    !same(issue.horizonsHours, HORIZONS_HOURS) ||
    issue.baseline?.routeKey !== ROUTE.routeKey ||
    issue.baseline?.destination !== ROUTE.destination ||
    issue.baseline?.asset !== ROUTE.asset ||
    !DECIMAL.test(issue.baseline?.targetBlock ?? '') ||
    !BLOCK_HASH.test(issue.baseline?.targetHash ?? '') ||
    !DECIMAL.test(issue.baseline?.totalAssetsRaw ?? '') ||
    !DECIMAL.test(issue.baseline?.totalSupplyRaw ?? '') ||
    issue.baseline.assetDecimals !== 6 ||
    issue.baseline.shareDecimals !== 6 ||
    issue.baseline.canonicalityEvidenceDoc?.schema !== 'carry_exit_v2_headers_v1' ||
    issue.baseline.canonicalityEvidenceDoc.source !== STUDY ||
    issue.baseline.canonicalityEvidenceDoc.targetHeader?.hash !== issue.baseline.targetHash ||
    issue.baseline.canonicalityEvidenceDoc.targetHeader?.number !== issue.baseline.targetBlock ||
    issue.baseline.canonicalityEvidenceDoc.observedAt !== issue.baseline.targetObservedAt
  )
    throw Error('usd3_issue_identity_invalid')
  const issued = utc(issue.issuedAtUtc)
  const observed = utc(issue.baseline.targetObservedAt)
  if (
    Math.floor(issued / SLOT_MS) !== issue.slot ||
    observed > issued ||
    issued - observed > 45 * 60_000 ||
    utc(issue.baseline.targetBlockAt) > observed ||
    issued - utc(issue.baseline.targetBlockAt) > 60 * 60_000 ||
    !same(
      issue.targets,
      HORIZONS_HOURS.map((hours) => ({
        horizonHours: hours,
        targetAtUtc: new Date(issued + hours * 3_600_000).toISOString(),
        captureDeadlineUtc: new Date(
          issued + (hours + CAPTURE_DEADLINE_HOURS) * 3_600_000,
        ).toISOString(),
      })),
    )
  )
    throw Error('usd3_issue_time_invalid')
  const witness = issue.baselineWitness
  let primaryHost
  let secondaryHost
  try {
    const primary = new URL(issue.baseline.canonicalityEvidenceDoc.provider)
    const secondary = new URL(witness?.provider)
    if (
      ![primary, secondary].every(
        (entry) =>
          ['https:', 'http:'].includes(entry.protocol) &&
          !entry.username &&
          !entry.password &&
          entry.pathname === '/' &&
          !entry.search &&
          !entry.hash,
      )
    )
      throw Error('invalid_provider')
    primaryHost = primary.hostname.replace(/\.$/, '').replace(/^www\./, '')
    secondaryHost = secondary.hostname.replace(/\.$/, '').replace(/^www\./, '')
  } catch {
    throw Error('usd3_issue_witness_invalid')
  }
  if (
    !witness ||
    primaryHost === secondaryHost ||
    !same(witness, {
      provider: witness.provider,
      block: issue.baseline.targetBlock,
      hash: issue.baseline.targetHash,
      totalAssetsRaw: issue.baseline.totalAssetsRaw,
      totalSupplyRaw: issue.baseline.totalSupplyRaw,
      assetDecimals: issue.baseline.assetDecimals,
      shareDecimals: issue.baseline.shareDecimals,
      asset: ROUTE.asset,
      observedAtUtc: witness.observedAtUtc,
    }) ||
    utc(witness.observedAtUtc) < observed ||
    utc(witness.observedAtUtc) > issued
  )
    throw Error('usd3_issue_witness_invalid')
  const candidate = issue.candidate
  const selected = candidate?.holder
  const candidateDoc = candidate?.evidenceDoc
  const ladder = freezeSyncVaultQLadder({
    totalAssetsRaw: issue.baseline.totalAssetsRaw,
    selectedClaimRaw: selected ? candidateDoc?.selectedClaimRaw : null,
  })
  if (
    (selected !== null && !ADDRESS.test(selected ?? '')) ||
    ![
      'carry_exit_v2_sync_vault_candidate_v1',
      'carry_public_usd3_candidate_unavailable_v1',
    ].includes(candidateDoc?.schema) ||
    candidateDoc.routeKey !== ROUTE.routeKey ||
    candidateDoc.destination !== ROUTE.destination ||
    candidateDoc.asset !== ROUTE.asset ||
    candidateDoc.baselineHash !== issue.baseline.targetHash ||
    candidateDoc.baselineBlock !== issue.baseline.targetBlock ||
    candidateDoc.selectedHolderCommitment !==
      (selected ? sha(`${ROUTE.destination}:${selected}`) : null) ||
    (selected &&
      (!DECIMAL.test(candidateDoc.selectedSharesRaw ?? '') ||
        !DECIMAL.test(candidateDoc.selectedClaimRaw ?? '') ||
        BigInt(candidateDoc.selectedSharesRaw) === 0n ||
        BigInt(candidateDoc.selectedClaimRaw) === 0n ||
        candidateDoc.baselineState?.totalAssetsRaw !== issue.baseline.totalAssetsRaw ||
        candidateDoc.baselineState?.totalSupplyRaw !== issue.baseline.totalSupplyRaw ||
        candidateDoc.baselineState?.shareDecimals !== 6 ||
        candidateDoc.baselineState?.assetDecimals !== 6 ||
        !Array.isArray(candidateDoc.screenedCandidates) ||
        !candidateDoc.screenedCandidates.some(
          (entry) =>
            entry.holderCommitment === candidateDoc.selectedHolderCommitment &&
            entry.status === 'eligible_holder' &&
            entry.sharesRaw === candidateDoc.selectedSharesRaw &&
            entry.claimRaw === candidateDoc.selectedClaimRaw &&
            HASH.test(entry.receiptDigest ?? ''),
        ))) ||
    (candidateDoc.schema === 'carry_public_usd3_candidate_unavailable_v1' &&
      (selected !== null || candidateDoc.unavailableReason !== 'candidate_scan_unavailable')) ||
    candidate.evidenceSha256 !== sha(JSON.stringify(candidateDoc)) ||
    !same(candidateDoc.ladder, ladder) ||
    !same(issue.qLabels, ladder.labels) ||
    !Array.isArray(issue.cases) ||
    issue.cases.length !== 6
  )
    throw Error('usd3_issue_candidate_invalid')
  for (const [index, entry] of issue.cases.entries()) {
    const label = ladder.labels[index]
    if (entry.label !== label.label || entry.assetsRaw !== label.assetsRaw)
      throw Error('usd3_issue_q_invalid')
    if (entry.assetsRaw === null) {
      if (entry.status !== 'omitted' || entry.reason !== label.reason || entry.measurement !== null)
        throw Error('usd3_issue_case_invalid')
    } else if (entry.status === 'unavailable') {
      if (entry.reason !== 'baseline_measurement_unavailable' || entry.measurement !== null)
        throw Error('usd3_issue_case_invalid')
    } else if (entry.status === 'measured') {
      if (entry.reason !== null || !selected) throw Error('usd3_issue_case_invalid')
      const decoded = verifyUsd3Measurement({
        holder: selected,
        assetsRaw: entry.assetsRaw,
        blockNumber: issue.baseline.targetBlock,
        blockHash: issue.baseline.targetHash,
        blockAtUtc: issue.baseline.targetBlockAt,
        source: STUDY,
        measurement: entry.measurement,
        beforeAtUtc: issue.baseline.targetBlockAt,
        afterAtUtc: issue.issuedAtUtc,
      })
      if (BigInt(decoded.requiredCoverageRaw) === 0n) throw Error('usd3_issue_zero_preview_invalid')
      if (
        entry.measurement.baselineStatus !==
        (decoded.simulationStatus === 'success'
          ? 'success'
          : decoded.coveredRevert
            ? 'covered_revert'
            : 'inconclusive')
      )
        throw Error('usd3_issue_case_invalid')
    } else throw Error('usd3_issue_case_invalid')
  }
  return issue
}

export function buildUsd3Issue({
  baseline,
  baselineWitness,
  candidate,
  measurements,
  issuedAtUtc,
  sequence,
  previousSha256,
}) {
  const issued = utc(issuedAtUtc)
  const labels = candidate.evidenceDoc.ladder.labels
  const payload = {
    study: STUDY,
    sequence,
    previousSha256,
    chainId: 1,
    routeKey: ROUTE.routeKey,
    destination: ROUTE.destination,
    originalAsset: ROUTE.asset,
    clock: {
      kind: 'local_operator_clock',
      operatorIssuedAtUtc: issuedAtUtc,
      independentWitness: null,
      externalTimestampProof: false,
    },
    issuedAtUtc,
    slot: Math.floor(issued / SLOT_MS),
    horizonsHours: [...HORIZONS_HOURS],
    targets: HORIZONS_HOURS.map((hours) => ({
      horizonHours: hours,
      targetAtUtc: new Date(issued + hours * 3_600_000).toISOString(),
      captureDeadlineUtc: new Date(
        issued + (hours + CAPTURE_DEADLINE_HOURS) * 3_600_000,
      ).toISOString(),
    })),
    baseline,
    baselineWitness,
    candidate: {
      holder: candidate.holder,
      evidenceDoc: candidate.evidenceDoc,
      evidenceSha256: sha(JSON.stringify(candidate.evidenceDoc)),
    },
    qLabels: labels,
    cases: labels.map((label) => {
      if (label.assetsRaw === null)
        return {
          label: label.label,
          assetsRaw: null,
          status: 'omitted',
          reason: label.reason,
          measurement: null,
        }
      const measured = measurements?.[label.label] ?? null
      return measured
        ? {
            label: label.label,
            assetsRaw: label.assetsRaw,
            status: 'measured',
            reason: null,
            measurement: measured,
          }
        : {
            label: label.label,
            assetsRaw: label.assetsRaw,
            status: 'unavailable',
            reason: 'baseline_measurement_unavailable',
            measurement: null,
          }
    }),
  }
  validateUsd3Issue(payload)
  return { ...payload, sha256: sha(JSON.stringify(payload)) }
}

export async function verifyUsd3Issues(out = OUT) {
  const issues = await readNumbered(out)
  const slots = new Set()
  const holders = new Set()
  for (const issue of issues) {
    validateUsd3Issue(issue)
    if (slots.has(issue.slot)) throw Error('usd3_issue_duplicate_slot')
    slots.add(issue.slot)
    if (issue.candidate.holder) {
      if (holders.has(issue.candidate.holder)) throw Error('usd3_issue_duplicate_holder')
      holders.add(issue.candidate.holder)
    }
  }
  return issues
}

export async function appendUsd3Issue(issue, out = OUT, stat, options) {
  validateUsd3Issue(issue)
  const prior = await verifyUsd3Issues(out)
  if (prior.some((entry) => entry.slot === issue.slot)) throw Error('usd3_issue_duplicate_slot')
  return appendNumbered(issue, out, verifyUsd3Issues, stat, options)
}

async function measureBaseline({ baseline, candidate, label, primary, secondary, now }) {
  const measured = await measureCarryExitV2Verified({
    ...ROUTE,
    holder: candidate.holder,
    assetsRaw: label.assetsRaw,
    target: baseline,
    provider: primary.provider,
    source: STUDY,
    send: primary.send,
    primary: { url: primary.url, request: primary.send },
    secondary: { url: secondary.url, request: secondary.send },
    now,
  })
  if (measured.status !== 'verified') throw Error('usd3_baseline_measurement_unavailable')
  const frozen = {
    ...ROUTE,
    holder: candidate.holder,
    assetsRaw: label.assetsRaw,
    blockNumber: baseline.targetBlock,
    blockHash: baseline.targetHash,
  }
  const decoded = validateCarryExitV2RpcProof({ proof: measured.callEvidenceDoc, ...frozen })
  if (BigInt(decoded.requiredCoverageRaw) === 0n) throw Error('usd3_baseline_preview_unavailable')
  return {
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
    evidence: measured.callEvidenceDoc,
    evidenceSha256: sha(JSON.stringify(measured.callEvidenceDoc)),
  }
}

export async function issuePublicUsd3Exit({
  clients,
  originPairs,
  out = OUT,
  now = () => new Date(),
  capture = captureFreshSyncVaultBaseline,
  discover = discoverSyncVaultIssuerCandidate,
  witness = witnessUsd3Baseline,
  assertImplementation = assertUsd3ImplementationPair,
  measure = measureBaseline,
  append = appendUsd3Issue,
  load = verifyUsd3Issues,
}) {
  const pairs =
    originPairs ??
    (Array.isArray(clients) && clients.length === 2
      ? [
          [clients[0], clients[1]],
          [clients[1], clients[0]],
        ]
      : null)
  if (!Array.isArray(pairs) || !pairs.length || pairs.length > 24)
    throw Error('usd3_two_public_origins_required')
  const prior = await load(out)
  const excludedHolders = new Set(prior.map((issue) => issue.candidate.holder).filter(Boolean))
  let prepared = null
  let bestRank = -1
  let noFreshHolder = false
  for (const [primary, secondary] of pairs) {
    if (!primary || !secondary || primary.provider === secondary.provider) continue
    let baseline
    try {
      baseline = await capture({
        ...ROUTE,
        provider: primary.provider,
        source: STUDY,
        request: primary.request.bind(primary),
        now,
      })
      const baselineWitness = await witness(baseline, secondary, now)
      await assertImplementation(primary, secondary, baseline.targetHash)
      const candidate = await discover({
        baseline,
        request: slicedCandidateRequest(primary),
        excludedHolders,
      })
      if (candidate.evidenceDoc.unavailableReason === 'all_recent_recipients_previously_sampled') {
        noFreshHolder = true
        continue
      }
      if (candidate.holder && excludedHolders.has(candidate.holder))
        throw Error('usd3_no_fresh_holder')
      const measurements = {}
      if (candidate.holder)
        for (const label of candidate.evidenceDoc.ladder.labels) {
          if (label.assetsRaw === null) continue
          try {
            measurements[label.label] = await measure({
              baseline,
              candidate,
              label,
              primary,
              secondary,
              now,
            })
          } catch {
            /* Keep Q unavailable; try another independent pair. */
          }
        }
      const measured = Object.values(measurements)
      const rank =
        (measured.some((entry) => entry.baselineStatus === 'success') ? 100 : 0) +
        measured.length * 10 +
        (candidate.holder ? 1 : 0)
      if (rank > bestRank) {
        bestRank = rank
        prepared = { baseline, baselineWitness, candidate, measurements }
      }
      if (rank >= 100) break
    } catch {
      if (baseline && bestRank < 0) {
        try {
          const baselineWitness = await witness(baseline, secondary, now)
          await assertImplementation(primary, secondary, baseline.targetHash)
          prepared = {
            baseline,
            baselineWitness,
            candidate: unavailableCandidate(baseline),
            measurements: {},
          }
          bestRank = 0
        } catch {
          /* No independently witnessed issue. */
        }
      }
    }
  }
  if (!prepared)
    throw Error(noFreshHolder ? 'usd3_no_fresh_holder' : 'usd3_public_issue_unavailable')
  const { baseline, baselineWitness, candidate, measurements } = prepared
  const issuedAtUtc = now().toISOString()
  const issue = buildUsd3Issue({
    baseline,
    baselineWitness,
    candidate,
    measurements,
    issuedAtUtc,
    sequence: prior.length + 1,
    previousSha256: prior.at(-1)?.sha256 ?? null,
  })
  return append(issue, out)
}

async function cli() {
  const [mode] = process.argv.slice(2)
  if (mode === '--verify') {
    const issues = await verifyUsd3Issues()
    process.stdout.write(
      `${JSON.stringify({ status: 'verified_local_chain', issues: issues.length })}\n`,
    )
    return
  }
  if (mode === '--dry-run') {
    process.stdout.write(
      `${JSON.stringify({ status: 'dry_run_no_rpc', routeKey: ROUTE.routeKey, horizonsHours: HORIZONS_HOURS })}\n`,
    )
    return
  }
  if (mode !== '--issue') throw Error('usd3_issue_usage')
  const originPairs = rotatingUsd3OriginPairs(configuredPublicRpcUrls(readEnv()))
  const result = await issuePublicUsd3Exit({ originPairs })
  process.stdout.write(`${JSON.stringify({ status: 'locally_issued', ...result })}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch(() => {
    process.stderr.write('public_usd3_issue_failed\n')
    process.exitCode = 1
  })
}
