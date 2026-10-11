// Public-chain-only, prospective direct-supply ISSUE records. This module does
// not read a private database, inspect a future target, or score an outcome.
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { statfsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  CARRY_EXIT_V2_FROZEN_ROUTES,
  validateCarryExitV2RpcProof,
} from '../lib/carry-exit-v2-rpc-proof.mjs'
import {
  captureFreshDirectBaseline,
  discoverDirectIssuerCandidate,
  freezeDirectQLadder,
} from '../lib/carry-exit-v2-direct-issuer-prep.mjs'
import { collectCarryExitV2RpcProof } from '../lib/carry-exit-v2-rpc-collector.mjs'
import { verifyCarryExitV2IndependentReplay } from '../lib/carry-exit-v2-independent-replay.mjs'
import { assembleCarryExitV2CallEvidence } from '../lib/carry-exit-v2-proof-assembly.mjs'
import { readEnv } from '../lib/venue-reads.mjs'
import {
  buildIssueDirectFlowSnapshot,
  captureIssueDirectFlowCandidates,
  requireFreshIssueDirectFlowSnapshot,
  verifyIssueDirectFlowSnapshot,
} from './holder-exit-direct-flow-issue-snapshot.mjs'
import {
  captureIssueDirectFlowAncestry,
  verifyIssueDirectFlowAncestry,
} from './holder-exit-direct-flow-issue-ancestry.mjs'

export const STUDY = 'carry_public_direct_exit_issue_v1'
export const OUT = resolve('data/research/venue-signals/carry-public-direct-exit-issues')
export const HORIZONS_HOURS = Object.freeze([1, 4, 24, 48, 168])
export const CAPTURE_DEADLINE_HOURS = 2
export const MAX_ISSUE_BYTES = 512 * 1024
const DISK_RESERVE_BYTES = 1_073_741_824
const SLOT_MS = 15 * 60_000
const HOUR_MS = 3_600_000
const MAX_RUN_MS = 8 * 60_000
const MAX_RPC_CALLS = 1_200
const MAX_RPC_RESPONSE_BYTES = 1_000_000
const CANDIDATE_LOG_SLICE_BLOCKS = 10n
const HASH = /^[0-9a-f]{64}$/
const BLOCK_HASH = /^0x[0-9a-f]{64}$/
const WORD = /^0x[0-9a-f]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const stripSeal = ({ sha256: _seal, ...body }) => body
const issueName = (sequence) => `${String(sequence).padStart(8, '0')}.json`
const utc = (value) => {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value)
    throw Error('invalid_issue_clock')
  return ms
}
const targetPlans = (basisMs) =>
  HORIZONS_HOURS.map((hours) => ({
    horizonHours: hours,
    targetAtUtc: new Date(basisMs + hours * HOUR_MS).toISOString(),
    captureDeadlineUtc: new Date(
      basisMs + (hours + CAPTURE_DEADLINE_HOURS) * HOUR_MS,
    ).toISOString(),
  }))

export const DIRECT_MARKETS = Object.freeze({
  aaveV3Usdc: CARRY_EXIT_V2_FROZEN_ROUTES.find(
    (route) => route.kind === 'aave' && route.routeKey === 'USDC → supply on Aave V3',
  ),
  aaveV3Usde: CARRY_EXIT_V2_FROZEN_ROUTES.find(
    (route) => route.kind === 'aave' && route.routeKey === 'USDe → supply on Aave V3',
  ),
  sparkLendUsdt: CARRY_EXIT_V2_FROZEN_ROUTES.find((route) => route.kind === 'spark'),
})

function routeFor(marketKey) {
  const route = DIRECT_MARKETS[marketKey]
  if (!route || !['aaveV3Usdc', 'aaveV3Usde', 'sparkLendUsdt'].includes(marketKey))
    throw Error('unsupported_public_direct_market')
  return route
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function origin(url) {
  const parsed = new URL(url)
  if (
    !['https:', 'http:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  )
    throw Error('invalid_public_rpc_origin')
  const hostname = parsed.hostname.replace(/\.$/, '').replace(/^www\./, '')
  return {
    label: `${parsed.protocol}//${parsed.host}`,
    host: /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/.test(hostname) ? 'loopback' : hostname,
  }
}

export function configuredPublicRpcUrls(env, overrides = process.env) {
  const urls = String(
    overrides.RECORDER_RPC_URLS ??
      overrides.RECORDER_RPC_URL ??
      env.get('RECORDER_RPC_URLS') ??
      env.get('RECORDER_RPC_URL') ??
      '',
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (urls.length < 2 || urls.length > 8) throw Error('two_public_origins_required')
  if (new Set(urls.map((url) => origin(url).host)).size < 2)
    throw Error('independent_public_origins_required')
  return urls
}

export function publicRpcClients(urls, fetchImpl = fetch, nowMs = Date.now) {
  if (!Array.isArray(urls) || urls.length < 2 || urls.length > 8)
    throw Error('two_public_origins_required')
  const origins = urls.map(origin)
  if (new Set(origins.map((entry) => entry.host)).size < 2)
    throw Error('independent_public_origins_required')
  const deadline = nowMs() + MAX_RUN_MS
  let calls = 0
  return urls.map((url, index) => {
    const provider = origins[index].label
    const send = async (envelope) => {
      if (++calls > MAX_RPC_CALLS || nowMs() >= deadline) throw Error('public_rpc_budget_exhausted')
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw Error('public_rpc_unavailable')
      const body = await response.text()
      if (Buffer.byteLength(body) > MAX_RPC_RESPONSE_BYTES) throw Error('public_rpc_unavailable')
      const parsed = JSON.parse(body)
      if (
        parsed?.jsonrpc !== '2.0' ||
        parsed.id !== envelope.id ||
        Object.hasOwn(parsed, 'result') === Object.hasOwn(parsed, 'error')
      )
        throw Error('public_rpc_unavailable')
      if (Object.hasOwn(parsed, 'error')) {
        // Never preserve arbitrary vendor text, endpoint paths, or credentials.
        const message = String(parsed.error?.message ?? '')
        return {
          jsonrpc: '2.0',
          id: envelope.id,
          error: {
            code: Number.isSafeInteger(parsed.error?.code) ? parsed.error.code : -32000,
            message: /\b(?:execution reverted|revert(?:ed)?)\b/i.test(message)
              ? 'execution reverted'
              : 'public rpc error',
          },
        }
      }
      return parsed
    }
    return {
      url,
      provider,
      send,
      async request(method, params) {
        const response = await send({ jsonrpc: '2.0', id: 1, method, params })
        if (Object.hasOwn(response, 'error')) {
          const error = Error('public_rpc_unavailable')
          error.code = response.error.code
          throw error
        }
        return response.result
      },
    }
  })
}

/** Adapt the shared candidate scan to RPCs with a ten-block log-range cap. */
export function slicedCandidateRequest(client) {
  return async (method, params) => {
    if (method !== 'eth_getLogs') return client.request(method, params)
    const filter = params?.[0]
    if (!filter || typeof filter.fromBlock !== 'string' || typeof filter.toBlock !== 'string')
      throw Error('candidate_log_filter_invalid')
    const from = BigInt(filter.fromBlock)
    const to = BigInt(filter.toBlock)
    if (to < from || to - from >= 512n) throw Error('candidate_log_range_invalid')
    const logs = []
    for (let start = from; start <= to; start += CANDIDATE_LOG_SLICE_BLOCKS) {
      const end =
        start + CANDIDATE_LOG_SLICE_BLOCKS - 1n < to ? start + CANDIDATE_LOG_SLICE_BLOCKS - 1n : to
      const rows = await client.request('eth_getLogs', [
        {
          ...filter,
          fromBlock: `0x${start.toString(16)}`,
          toBlock: `0x${end.toString(16)}`,
        },
      ])
      if (!Array.isArray(rows) || logs.length + rows.length > 4_096)
        throw Error('candidate_logs_unavailable')
      logs.push(...rows)
    }
    return logs
  }
}

async function witnessBaseline(route, baseline, secondary) {
  const request = secondary.request.bind(secondary)
  if ((await request('eth_chainId', [])) !== '0x1') throw Error('secondary_chain_mismatch')
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
    throw Error('secondary_baseline_mismatch')
  const pin = { blockHash: baseline.targetHash, requireCanonical: true }
  const call = (to, data) => request('eth_call', [{ to, data }, pin])
  const [code, supply, decimals, underlying] = await Promise.all([
    request('eth_getCode', [route.destination, pin]),
    call(route.destination, '0x18160ddd'),
    call(route.asset, '0x313ce567'),
    call(route.destination, '0xb16a19de'),
  ])
  if (
    typeof code !== 'string' ||
    !/^0x(?:[0-9a-f]{2})+$/.test(code) ||
    !WORD.test(supply ?? '') ||
    !WORD.test(decimals ?? '') ||
    !WORD.test(underlying ?? '') ||
    BigInt(supply).toString() !== baseline.marketSupplyRaw ||
    Number(BigInt(decimals)) !== baseline.assetDecimals ||
    `0x${underlying.slice(-40)}` !== route.asset
  )
    throw Error('secondary_baseline_mismatch')
  return {
    provider: secondary.provider,
    block: baseline.targetBlock,
    hash: baseline.targetHash,
    marketSupplyRaw: baseline.marketSupplyRaw,
    assetDecimals: baseline.assetDecimals,
    underlying: route.asset,
    observedAtUtc: new Date().toISOString(),
  }
}

function unavailableCandidate(route, baseline) {
  const evidenceDoc = {
    schema: 'carry_public_direct_candidate_unavailable_v1',
    chainId: '1',
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    baselineBlock: baseline.targetBlock,
    baselineHash: baseline.targetHash,
    selectedHolderCommitment: null,
    selectedAssetBalanceRaw: null,
    unavailableReason: 'candidate_scan_unavailable',
    ladder: freezeDirectQLadder({ marketSupplyRaw: baseline.marketSupplyRaw }),
  }
  return { holder: null, evidenceDoc }
}

async function measureCase({ route, baseline, candidate, assetsRaw, primary, secondary }) {
  const frozen = {
    ...route,
    holder: candidate.holder,
    assetsRaw,
    blockNumber: baseline.targetBlock,
    blockHash: baseline.targetHash,
  }
  const collected = await collectCarryExitV2RpcProof({
    ...route,
    holder: candidate.holder,
    assetsRaw,
    target: baseline,
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
  if (replay.status !== 'verified') throw Error('baseline_replay_unavailable')
  const evidence = assembleCarryExitV2CallEvidence({ collector: collected, replay, frozen })
  const decoded = validateCarryExitV2RpcProof({ proof: collected.proof, ...frozen })
  return {
    status: decoded.simulationStatus,
    holderCoverageRaw: decoded.holderCoverageRaw,
    actualConsumedRaw: decoded.actualConsumedRaw,
    coveredRevert: decoded.coveredRevert,
    evidence,
    evidenceSha256: sha(JSON.stringify(evidence)),
  }
}

function validateIssue(issue) {
  const route = routeFor(issue.marketKey)
  if (
    issue.study !== STUDY ||
    !Number.isSafeInteger(issue.sequence) ||
    issue.sequence < 1 ||
    !Number.isSafeInteger(issue.slot) ||
    issue.slot < 0 ||
    issue.chainId !== 1 ||
    issue.routeKey !== route.routeKey ||
    issue.destination !== route.destination ||
    issue.originalAsset !== route.asset ||
    !BLOCK_HASH.test(issue.baseline?.targetHash ?? '') ||
    issue.baseline?.routeKey !== route.routeKey ||
    issue.baseline?.destination !== route.destination ||
    issue.baseline?.asset !== route.asset ||
    issue.baseline?.kind !== route.kind ||
    !DECIMAL.test(issue.baseline?.targetBlock ?? '') ||
    !DECIMAL.test(issue.baseline?.marketSupplyRaw ?? '') ||
    issue.baseline?.canonicalityEvidenceDoc?.schema !== 'carry_exit_v2_headers_v1' ||
    issue.baseline.canonicalityEvidenceDoc.targetHeader?.hash !== issue.baseline.targetHash ||
    issue.baseline.canonicalityEvidenceDoc.targetHeader?.number !== issue.baseline.targetBlock ||
    issue.baseline.canonicalityEvidenceDoc.targetHeader?.parentHash !==
      issue.baseline.targetParentHash ||
    issue.baseline.canonicalityEvidenceDoc.parentHeader?.number !==
      issue.baseline.targetParentBlock ||
    issue.baseline.canonicalityEvidenceDoc.parentHeader?.hash !== issue.baseline.targetParentHash ||
    !DECIMAL.test(issue.baseline.targetParentBlock ?? '') ||
    BigInt(issue.baseline.targetParentBlock) + 1n !== BigInt(issue.baseline.targetBlock) ||
    issue.baseline.canonicalityEvidenceDoc.targetHeader?.timestamp !==
      issue.baseline.targetBlockAt ||
    issue.baseline.canonicalityEvidenceDoc.observedAt !== issue.baseline.targetObservedAt ||
    issue.clock?.kind !== 'local_operator_clock' ||
    issue.clock?.independentWitness !== null ||
    issue.clock?.externalTimestampProof !== false ||
    issue.clock?.operatorIssuedAtUtc !== issue.issuedAtUtc ||
    (issue.targetClockBasis !== undefined &&
      issue.targetClockBasis !== 'baseline_block_timestamp') ||
    !same(issue.horizonsHours, HORIZONS_HOURS)
  )
    throw Error('public_issue_identity_invalid')
  const issuedMs = utc(issue.issuedAtUtc)
  const observedMs = utc(issue.baseline.targetObservedAt)
  const blockMs = utc(issue.baseline.targetBlockAt)
  // Missing basis belongs to already-sealed V1 issue records. New records
  // explicitly anchor horizons to the finalized baseline block timestamp.
  const targetBasisMs = issue.targetClockBasis === 'baseline_block_timestamp' ? blockMs : issuedMs
  if (
    Math.floor(issuedMs / SLOT_MS) !== issue.slot ||
    observedMs > issuedMs ||
    issuedMs - observedMs > 45 * 60_000 ||
    blockMs > observedMs ||
    issuedMs - blockMs > 60 * 60_000 ||
    (issue.targetClockBasis === 'baseline_block_timestamp' &&
      targetBasisMs + HORIZONS_HOURS[0] * HOUR_MS <= issuedMs) ||
    !same(issue.targets, targetPlans(targetBasisMs))
  )
    throw Error('public_issue_asof_invalid')
  verifyIssueDirectFlowSnapshot(issue)
  verifyIssueDirectFlowAncestry(issue)
  const candidate = issue.candidate
  const ladder = freezeDirectQLadder({
    marketSupplyRaw: issue.baseline.marketSupplyRaw,
    selectedAssetBalanceRaw: candidate.holder ? candidate.selectedAssetBalanceRaw : null,
  })
  if (
    candidate.selectionKind !== 'bounded_one_origin_event_nomination' ||
    candidate.representativeCensus !== false ||
    candidate.status !==
      (candidate.holder
        ? 'selected'
        : candidate.evidenceDoc?.schema === 'carry_public_direct_candidate_unavailable_v1'
          ? 'unavailable'
          : 'no_eligible_holder') ||
    (candidate.holder !== null && !ADDRESS.test(candidate.holder)) ||
    candidate.evidenceDoc?.selectedHolderCommitment !==
      (candidate.holder ? sha(`${route.destination}:${candidate.holder}`) : null) ||
    !['carry_exit_v2_direct_candidate_v1', 'carry_public_direct_candidate_unavailable_v1'].includes(
      candidate.evidenceDoc?.schema,
    ) ||
    (candidate.evidenceDoc?.schema === 'carry_public_direct_candidate_unavailable_v1' &&
      (candidate.holder !== null ||
        candidate.evidenceDoc.unavailableReason !== 'candidate_scan_unavailable')) ||
    candidate.evidenceDoc?.routeKey !== route.routeKey ||
    candidate.evidenceDoc?.destination !== route.destination ||
    candidate.evidenceDoc?.asset !== route.asset ||
    candidate.evidenceDoc?.baselineBlock !== issue.baseline.targetBlock ||
    candidate.evidenceDoc?.baselineHash !== issue.baseline.targetHash ||
    (candidate.evidenceDoc?.schema === 'carry_exit_v2_direct_candidate_v1' &&
      (candidate.evidenceDoc.parentHash !== issue.baseline.targetParentHash ||
        !same(candidate.evidenceDoc.baselineState, {
          marketSupplyRaw: issue.baseline.marketSupplyRaw,
          assetDecimals: issue.baseline.assetDecimals,
        }))) ||
    candidate.evidenceDoc?.selectedAssetBalanceRaw !==
      (candidate.holder ? candidate.selectedAssetBalanceRaw : null) ||
    !HASH.test(candidate.evidenceSha256 ?? '') ||
    candidate.evidenceSha256 !== sha(JSON.stringify(candidate.evidenceDoc)) ||
    !same(candidate.evidenceDoc.ladder, ladder) ||
    !same(issue.qLabels, ladder.labels) ||
    !Array.isArray(issue.cases) ||
    issue.cases.length !== 6
  )
    throw Error('public_issue_candidate_invalid')
  if (
    !same(issue.baselineWitness, {
      provider: issue.baselineWitness?.provider,
      block: issue.baseline.targetBlock,
      hash: issue.baseline.targetHash,
      marketSupplyRaw: issue.baseline.marketSupplyRaw,
      assetDecimals: issue.baseline.assetDecimals,
      underlying: route.asset,
      observedAtUtc: issue.baselineWitness?.observedAtUtc,
    }) ||
    origin(issue.baselineWitness.provider).host ===
      origin(issue.baseline.canonicalityEvidenceDoc.provider).host ||
    utc(issue.baselineWitness.observedAtUtc) < observedMs ||
    utc(issue.baselineWitness.observedAtUtc) > issuedMs
  )
    throw Error('public_issue_witness_invalid')
  for (let index = 0; index < 6; index++) {
    const label = ladder.labels[index]
    const entry = issue.cases[index]
    if (entry.label !== label.label || entry.assetsRaw !== label.assetsRaw)
      throw Error('public_issue_case_invalid')
    if (label.assetsRaw === null) {
      if (entry.status !== 'omitted' || entry.reason !== label.reason || entry.measurement !== null)
        throw Error('public_issue_case_invalid')
    } else if (entry.status === 'unavailable') {
      if (entry.reason !== 'baseline_measurement_unavailable' || entry.measurement !== null)
        throw Error('public_issue_case_invalid')
    } else if (entry.status === 'measured') {
      const measurement = entry.measurement
      const evidence = measurement?.evidence
      const identity = evidence?.identityEvidence
      const replay = evidence?.replayEvidenceDoc
      if (
        entry.reason !== null ||
        !HASH.test(measurement?.evidenceSha256 ?? '') ||
        measurement.evidenceSha256 !== sha(JSON.stringify(evidence)) ||
        evidence?.verificationStatus !== 'verified' ||
        identity?.chainId !== '1' ||
        identity?.kind !== route.kind ||
        identity?.routeKey !== route.routeKey ||
        identity?.holder !== candidate.holder ||
        identity?.asset !== route.asset ||
        identity?.destination !== route.destination ||
        identity?.blockNumber !== issue.baseline.targetBlock ||
        identity?.blockHash !== issue.baseline.targetHash ||
        identity?.provider !== issue.baseline.canonicalityEvidenceDoc.provider ||
        replay?.blockNumber !== issue.baseline.targetBlock ||
        replay?.blockHash !== issue.baseline.targetHash ||
        replay?.origins?.primary !== issue.baseline.canonicalityEvidenceDoc.provider ||
        replay?.origins?.secondary !== issue.baselineWitness.provider ||
        utc(replay?.observedAt) > issuedMs
      )
        throw Error('public_issue_case_invalid')
      let decoded
      try {
        decoded = validateCarryExitV2RpcProof({
          proof: evidence,
          routeKey: route.routeKey,
          destination: route.destination,
          asset: route.asset,
          holder: candidate.holder,
          assetsRaw: label.assetsRaw,
          blockNumber: issue.baseline.targetBlock,
          blockHash: issue.baseline.targetHash,
        })
      } catch {
        throw Error('public_issue_case_invalid')
      }
      if (
        measurement.status !== decoded.simulationStatus ||
        measurement.holderCoverageRaw !== decoded.holderCoverageRaw ||
        measurement.actualConsumedRaw !== decoded.actualConsumedRaw ||
        measurement.coveredRevert !== decoded.coveredRevert ||
        !same(replay.decoded, {
          holderCoverageRaw: decoded.holderCoverageRaw,
          requiredCoverageRaw: decoded.requiredCoverageRaw,
          actualConsumedRaw: decoded.actualConsumedRaw,
          simulationStatus: decoded.simulationStatus,
          coveredRevert: decoded.coveredRevert,
        })
      )
        throw Error('public_issue_case_invalid')
    } else throw Error('public_issue_case_invalid')
  }
  if (issue.sequence === 1 ? issue.previousSha256 !== null : !HASH.test(issue.previousSha256 ?? ''))
    throw Error('public_issue_chain_invalid')
  return issue
}

export function buildPublicDirectIssue({
  marketKey,
  baseline,
  baselineWitness,
  candidate,
  measurements,
  issuedAtUtc,
  sequence,
  previousSha256,
  flowCapture,
  flowSnapshot,
  flowAncestry,
}) {
  const route = routeFor(marketKey)
  const issuedMs = utc(issuedAtUtc)
  const blockMs = utc(baseline.targetBlockAt)
  if (blockMs + HORIZONS_HOURS[0] * HOUR_MS <= issuedMs) throw Error('public_issue_asof_invalid')
  const labels = candidate.evidenceDoc.ladder.labels
  const cases = labels.map((label) => {
    if (label.assetsRaw === null)
      return {
        label: label.label,
        assetsRaw: null,
        status: 'omitted',
        reason: label.reason,
        measurement: null,
      }
    const result = measurements[label.label] ?? null
    return result
      ? {
          label: label.label,
          assetsRaw: label.assetsRaw,
          status: 'measured',
          reason: null,
          measurement: result,
        }
      : {
          label: label.label,
          assetsRaw: label.assetsRaw,
          status: 'unavailable',
          reason: 'baseline_measurement_unavailable',
          measurement: null,
        }
  })
  const payload = {
    study: STUDY,
    sequence,
    previousSha256,
    marketKey,
    chainId: 1,
    routeKey: route.routeKey,
    destination: route.destination,
    originalAsset: route.asset,
    clock: {
      kind: 'local_operator_clock',
      operatorIssuedAtUtc: issuedAtUtc,
      independentWitness: null,
      externalTimestampProof: false,
    },
    issuedAtUtc,
    targetClockBasis: 'baseline_block_timestamp',
    slot: Math.floor(issuedMs / SLOT_MS),
    horizonsHours: [...HORIZONS_HOURS],
    targets: targetPlans(blockMs),
    baseline,
    baselineWitness,
    candidate: {
      selectionKind: 'bounded_one_origin_event_nomination',
      representativeCensus: false,
      status: candidate.holder
        ? 'selected'
        : candidate.evidenceDoc.schema === 'carry_public_direct_candidate_unavailable_v1'
          ? 'unavailable'
          : 'no_eligible_holder',
      holder: candidate.holder,
      selectedAssetBalanceRaw: candidate.evidenceDoc.selectedAssetBalanceRaw,
      evidenceSha256: sha(JSON.stringify(candidate.evidenceDoc)),
      evidenceDoc: candidate.evidenceDoc,
    },
    qLabels: labels,
    cases,
  }
  if (flowCapture !== undefined && flowSnapshot !== undefined)
    throw Error('public_issue_flow_selection_ambiguous')
  if (flowCapture !== undefined)
    payload.flowSnapshot = buildIssueDirectFlowSnapshot(payload, flowCapture)
  if (flowSnapshot !== undefined) payload.flowSnapshot = flowSnapshot
  if (flowAncestry !== undefined) payload.flowAncestry = flowAncestry
  validateIssue(payload)
  return { ...payload, sha256: sha(JSON.stringify(payload)) }
}

export async function verifyPublicDirectIssues(out = OUT) {
  let names
  try {
    names = (await readdir(out)).filter((name) => name.endsWith('.json')).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const issues = []
  let previousSha256 = null
  const slots = new Set()
  for (const name of names) {
    if (name !== issueName(issues.length + 1)) throw Error('public_issue_sequence_gap')
    const bytes = await readFile(join(out, name))
    if (bytes.length > MAX_ISSUE_BYTES) throw Error('public_issue_size_invalid')
    const saved = JSON.parse(bytes.toString('utf8'))
    if (`${JSON.stringify(saved)}\n` !== bytes.toString('utf8'))
      throw Error('public_issue_noncanonical')
    validateIssue(saved)
    if (
      saved.sequence !== issues.length + 1 ||
      saved.previousSha256 !== previousSha256 ||
      saved.sha256 !== sha(JSON.stringify(stripSeal(saved)))
    )
      throw Error('public_issue_chain_invalid')
    const slotKey = `${saved.marketKey}:${saved.slot}`
    if (slots.has(slotKey)) throw Error('public_issue_duplicate_slot')
    slots.add(slotKey)
    previousSha256 = saved.sha256
    issues.push(saved)
  }
  return issues
}

export async function appendPublicDirectIssue(
  issue,
  out = OUT,
  stat = statfsSync,
  { linkFile = link } = {},
) {
  await mkdir(out, { recursive: true })
  const prior = await verifyPublicDirectIssues(out)
  if (
    issue.sequence !== prior.length + 1 ||
    issue.previousSha256 !== (prior.at(-1)?.sha256 ?? null) ||
    prior.some((row) => row.marketKey === issue.marketKey && row.slot === issue.slot)
  )
    throw Error('public_issue_duplicate_or_chain_changed')
  validateIssue(issue)
  if (issue.sha256 !== sha(JSON.stringify(stripSeal(issue))))
    throw Error('public_issue_seal_invalid')
  const serialized = `${JSON.stringify(issue)}\n`
  const bytes = Buffer.byteLength(serialized)
  if (bytes > MAX_ISSUE_BYTES) throw Error('public_issue_size_invalid')
  const disk = stat(out)
  if (Number(disk.bavail) * Number(disk.bsize) < DISK_RESERVE_BYTES + bytes)
    throw Error('public_issue_disk_reserve')
  const temporary = join(out, `.issue-${randomUUID()}.tmp`)
  const final = join(out, issueName(issue.sequence))
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(serialized)
      await handle.sync()
    } finally {
      await handle.close()
    }
    // Hard-link is atomic and refuses to overwrite an existing issue. A crash
    // before this point leaves only an ignored hidden temp file. The filename
    // collision is also the cross-process sequence lock; no stale lock remains.
    await linkFile(temporary, final)
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
    sequence: issue.sequence,
    marketKey: issue.marketKey,
    slot: issue.slot,
    sha256: issue.sha256,
  }
}

/** One invocation issues one route at one current local slot; no future reads. */
export async function issuePublicDirectExit({
  marketKey,
  clients,
  out = OUT,
  now = () => new Date(),
  capture = captureFreshDirectBaseline,
  discover = discoverDirectIssuerCandidate,
  witness = witnessBaseline,
  measure = measureCase,
  append = appendPublicDirectIssue,
  readFlow,
  requireFreshFlow = process.env.HOLDER_EXIT_REQUIRE_FRESH_FLOW === '1',
}) {
  const route = routeFor(marketKey)
  if (!Array.isArray(clients) || clients.length < 2 || clients.length > 8)
    throw Error('independent_public_origins_required')
  const prior = await verifyPublicDirectIssues(out)
  let selected = null
  let fallback = null
  for (const primary of clients) {
    if (!primary?.provider || typeof primary.request !== 'function') continue
    let baseline
    try {
      baseline = await capture({
        ...route,
        provider: primary.provider,
        source: STUDY,
        request: primary.request.bind(primary),
        now,
      })
    } catch {
      continue
    }
    for (const secondary of clients) {
      if (
        secondary === primary ||
        !secondary?.provider ||
        typeof secondary.request !== 'function' ||
        origin(primary.url ?? primary.provider).host ===
          origin(secondary.url ?? secondary.provider).host
      )
        continue
      let baselineWitness
      try {
        baselineWitness = await witness(route, baseline, secondary)
      } catch {
        continue
      }
      let candidate
      try {
        candidate = await discover({ baseline, request: slicedCandidateRequest(primary) })
      } catch {
        if (!fallback)
          fallback = {
            primary,
            secondary,
            baseline,
            baselineWitness,
            candidate: unavailableCandidate(route, baseline),
          }
        break
      }
      selected = { primary, secondary, baseline, baselineWitness, candidate }
      break
    }
    if (selected) break
  }
  const prepared = selected ?? fallback
  if (!prepared) throw Error('public_origin_pair_unavailable')
  const { primary, secondary, baseline, baselineWitness, candidate } = prepared
  const measurements = {}
  for (const label of candidate.evidenceDoc.ladder.labels) {
    if (label.assetsRaw === null) continue
    try {
      measurements[label.label] = await measure({
        route,
        baseline,
        candidate,
        assetsRaw: label.assetsRaw,
        primary,
        secondary,
      })
    } catch {
      // A declared positive Q remains an explicit unavailable denominator.
    }
  }
  const flowCapture = captureIssueDirectFlowCandidates({ marketKey, readFlow })
  const provisionalIssuedAtUtc = now().toISOString()
  const provisional = buildPublicDirectIssue({
    marketKey,
    baseline,
    baselineWitness,
    candidate,
    measurements,
    issuedAtUtc: provisionalIssuedAtUtc,
    sequence: prior.length + 1,
    previousSha256: prior.at(-1)?.sha256 ?? null,
    flowCapture,
  })
  const ancestryStartMs = Date.now()
  const ancestryHeaders = new Map()
  const readHeader = (number, originIndex) => {
    if (Date.now() - ancestryStartMs > 30_000) throw Error('ancestry_read_budget_exhausted')
    const key = `${number}:${originIndex}`
    if (!ancestryHeaders.has(key)) {
      const client = originIndex === 0 ? primary : secondary
      ancestryHeaders.set(
        key,
        client.request('eth_getBlockByNumber', [`0x${number.toString(16)}`, false]),
      )
    }
    return ancestryHeaders.get(key)
  }
  const flowAncestry = await captureIssueDirectFlowAncestry(provisional, { readHeader })
  const issuedAtUtc = now().toISOString()
  if (utc(issuedAtUtc) < utc(provisionalIssuedAtUtc)) throw Error('public_issue_clock_regressed')
  const issue = buildPublicDirectIssue({
    marketKey,
    baseline,
    baselineWitness,
    candidate,
    measurements,
    issuedAtUtc,
    sequence: prior.length + 1,
    previousSha256: prior.at(-1)?.sha256 ?? null,
    flowSnapshot: provisional.flowSnapshot,
    flowAncestry,
  })
  if (requireFreshFlow) requireFreshIssueDirectFlowSnapshot(issue)
  return append(issue, out)
}

async function cli() {
  const [mode, marketKey] = process.argv.slice(2)
  if (mode === '--verify') {
    const issues = await verifyPublicDirectIssues()
    process.stdout.write(
      `${JSON.stringify({ status: 'verified_local_chain', issues: issues.length })}\n`,
    )
    return
  }
  if (mode === '--dry-run') {
    routeFor(marketKey)
    process.stdout.write(
      `${JSON.stringify({ status: 'dry_run_no_rpc', marketKey, horizonsHours: HORIZONS_HOURS })}\n`,
    )
    return
  }
  if (mode !== '--issue') throw Error('public_issue_usage')
  routeFor(marketKey)
  const env = readEnv()
  const urls = configuredPublicRpcUrls(env)
  const clients = publicRpcClients(urls)
  const result = await issuePublicDirectExit({ marketKey, clients })
  process.stdout.write(`${JSON.stringify({ status: 'locally_issued', ...result })}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch(() => {
    // Never print a raw RPC/vendor exception: it can contain an API key URL.
    process.stderr.write('public_direct_issue_failed\n')
    process.exitCode = 1
  })
}
