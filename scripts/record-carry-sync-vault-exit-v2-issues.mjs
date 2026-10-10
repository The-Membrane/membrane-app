// Prospective exact-holder synchronous-vault baselines. No scheduler activation.
// A separate autocommit observer witnesses committed batches before H1.
import { createHash } from 'node:crypto'
import { mkdir, open, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { neon } from '@neondatabase/serverless'

import { ROOT, readEnv } from './lib/venue-reads.mjs'
import {
  CARRY_EXIT_V2_FROZEN_ROUTES,
  validateCarryExitV2RpcProof,
} from './lib/carry-exit-v2-rpc-proof.mjs'
import {
  captureFreshSyncVaultBaseline,
  discoverSyncVaultIssuerCandidate,
} from './lib/carry-exit-v2-sync-vault-issuer-prep.mjs'
import { collectCarryExitV2RpcProof } from './lib/carry-exit-v2-rpc-collector.mjs'
import { verifyCarryExitV2IndependentReplay } from './lib/carry-exit-v2-independent-replay.mjs'
import { assembleCarryExitV2CallEvidence } from './lib/carry-exit-v2-proof-assembly.mjs'
import {
  appendLocalCarryExitV2IssuerAttempt,
  appendLocalCarryExitV2IssuerIssues,
  recoverLocalCarryExitV2IssuedSlot,
} from './lib/localCarryExitV2Issuer.mjs'
import {
  configuredRpcUrls,
  digestEvidence,
  findIssuedBatch,
  findIssuedSlotBatch,
  findIssuedSlotBatchPlan,
  finalizeRecoveredCurrentLocalMirror,
  issuePlan,
  readCurrentAttempt,
  reconcilePriorLocalIssueMirrors,
  recordDatabaseAttempt,
  recordLocalMirrorCheckpoint,
  rpcTransport,
} from './record-carry-morpho-exit-v2-issues.mjs'

const SLOT_MS = 15 * 60_000
const TICK_BUDGET_MS = 4 * 60_000
const ATTEMPTS_PATH = join(ROOT, 'lib/carry/research/carry-sync-vault-exit-v2-issue-attempts.jsonl')
const LOCK_PATH = join(ROOT, 'lib/carry/research/carry-sync-vault-exit-v2-issue.lock')
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const sha = (doc) => createHash('sha256').update(JSON.stringify(doc)).digest('hex')
const origin = (url) => {
  const parsed = new URL(url)
  return `${parsed.protocol}//${parsed.host}`
}

export function selectedSyncVaultRoute(nowMs) {
  const routes = CARRY_EXIT_V2_FROZEN_ROUTES.filter((route) =>
    ['susds', 'usd3', 'stusds', 'fluid', 'sgho'].includes(route.kind),
  ).sort((a, b) =>
    `${a.destination}\u0000${a.routeKey}`.localeCompare(`${b.destination}\u0000${b.routeKey}`),
  )
  if (
    routes.length !== 8 ||
    new Set(routes.map((r) => `${r.routeKey}\u0000${r.destination}\u0000${r.asset}`)).size !== 8
  )
    throw Error('sync_vault_roster_changed')
  const slot = Math.floor((nowMs - 10 * 60_000) / SLOT_MS)
  return { slot, route: routes[((slot % 8) + 8) % 8], routeCount: 8 }
}

// Fluid fTokens can return a successful ERC4626-shaped simulation while the
// actual delivered underlying differs from requested Q. The frozen decoder
// only sees shares burned; no transfer amount is in the proof. Preserve these
// four exact subjects as explicit unavailable attempts until independently
// established delivery semantics can be included in the proof and scorer.
export function syncVaultRouteSupport(route) {
  if (route.kind === 'fluid') return { supported: false, reason: 'fluid_delivery_unproven' }
  if (['susds', 'usd3', 'stusds', 'sgho'].includes(route.kind))
    return { supported: true, reason: null }
  throw Error('sync_vault_route_required')
}

const emptyCase = (q, reason = 'quote_unavailable') => ({
  assetsRaw: q,
  baselineStatus: 'unavailable',
  coverageKind: null,
  holderCoverageRaw: null,
  requiredCoverageRaw: null,
  actualConsumedRaw: null,
  simulationStatus: null,
  callEvidenceDoc: null,
  callEvidenceSha256: null,
  entitlementMethod: null,
  entitlementEvidenceDoc: null,
  entitlementEvidenceSha256: null,
  inconclusiveReason: null,
  unavailableReason: reason,
})

/** Success outranks a preview gap: the actual returned burned shares decide. */
export function syncVaultCaseFromMeasurement(q, assembled, decoded) {
  const basic = emptyCase(q)
  if (!assembled || !['susds', 'usd3', 'stusds', 'sgho'].includes(decoded?.routeKind)) return basic
  const shares = BigInt(decoded.holderCoverageRaw)
  const required = BigInt(decoded.requiredCoverageRaw)
  // The issue table requires a positive exact-share requirement. A zero
  // preview cannot establish an assessable Q, even if withdraw returns success.
  if (required === 0n) return basic
  const entitlement = {
    ...assembled,
    purpose: 'entitlement',
    withdrawRpc: null,
    actualConsumedRaw: null,
    simulationStatus: null,
  }
  if (decoded.simulationStatus === 'success' && decoded.actualConsumedRaw != null) {
    return {
      ...basic,
      baselineStatus: 'success',
      coverageKind: 'shares',
      holderCoverageRaw: decoded.holderCoverageRaw,
      requiredCoverageRaw: decoded.requiredCoverageRaw,
      actualConsumedRaw: decoded.actualConsumedRaw,
      simulationStatus: 'success',
      callEvidenceDoc: assembled,
      unavailableReason: null,
    }
  }
  if (shares === 0n) {
    return {
      ...basic,
      baselineStatus: 'ineligible',
      coverageKind: 'shares',
      holderCoverageRaw: decoded.holderCoverageRaw,
      requiredCoverageRaw: decoded.requiredCoverageRaw,
      entitlementMethod: 'zero_shares',
      entitlementEvidenceDoc: { ...entitlement, entitlementMethod: 'zero_shares' },
      unavailableReason: null,
    }
  }
  if (decoded.simulationStatus !== 'evm_revert') return basic
  if (required > 0n && shares >= required) {
    return {
      ...basic,
      baselineStatus: 'covered_revert',
      coverageKind: 'shares',
      holderCoverageRaw: decoded.holderCoverageRaw,
      requiredCoverageRaw: decoded.requiredCoverageRaw,
      simulationStatus: 'evm_revert',
      callEvidenceDoc: assembled,
      unavailableReason: null,
    }
  }
  const inconclusiveReason = required > shares ? 'preview_gap' : 'ambiguous_revert'
  return {
    ...basic,
    baselineStatus: 'inconclusive',
    coverageKind: 'shares',
    holderCoverageRaw: decoded.holderCoverageRaw,
    requiredCoverageRaw: decoded.requiredCoverageRaw,
    simulationStatus: 'evm_revert',
    callEvidenceDoc: { ...assembled, inconclusiveReason },
    entitlementEvidenceDoc: {
      ...entitlement,
      simulationStatus: 'evm_revert',
      inconclusiveReason,
    },
    inconclusiveReason,
    unavailableReason: null,
  }
}

export function syncVaultAttemptRecord({
  slot,
  route,
  status,
  reason = null,
  baseline = null,
  candidate = null,
  caseStatuses = [],
  omittedLadder = [],
  batchId = null,
  at = new Date(),
}) {
  return {
    schema: 'carry_exit_v2_sync_vault_issue_attempt_v1',
    slot,
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    at: at.toISOString(),
    status,
    reason,
    baselineEvidenceDoc: baseline?.canonicalityEvidenceDoc ?? null,
    candidateEvidenceSha256: candidate?.digest ?? null,
    candidateEvidenceDoc: candidate?.evidenceDoc ?? null,
    caseStatuses,
    omittedLadder,
    batchId: batchId == null ? null : String(batchId),
  }
}

export async function appendSyncVaultAttempt(
  record,
  path = ATTEMPTS_PATH,
  appendLocalAttempt = appendLocalCarryExitV2IssuerAttempt,
) {
  await mkdir(dirname(path), { recursive: true })
  const file = await open(path, 'a', 0o600)
  try {
    await file.writeFile(`${JSON.stringify(record)}\n`)
    await file.sync()
  } finally {
    await file.close()
  }
  await appendLocalAttempt('sync_vault', record)
}

async function withLock(fn, path = LOCK_PATH, nowMs = Date.now()) {
  await mkdir(dirname(path), { recursive: true })
  let file
  try {
    file = await open(path, 'wx', 0o600)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const metadata = await stat(path).catch(() => null)
    if (!metadata || nowMs - metadata.mtimeMs < 2 * TICK_BUDGET_MS) return { status: 'locked' }
    await rm(path, { force: true })
    file = await open(path, 'wx', 0o600)
  }
  try {
    return await fn()
  } finally {
    await file.close()
    await rm(path, { force: true })
  }
}

/** Reject origins that can read the head but cannot scan the candidate window. */
export async function selectSyncVaultOrigin(
  urls,
  route,
  transport = rpcTransport,
  deadlineMs = Date.now() + TICK_BUDGET_MS,
) {
  if (!syncVaultRouteSupport(route).supported) return null
  for (const url of urls) {
    if (Date.now() >= deadlineMs) break
    const client = transport(url)
    try {
      if ((await client.request('eth_chainId', [])) !== '0x1') continue
      const head = await client.request('eth_getBlockByNumber', ['finalized', false])
      const number = BigInt(head.number)
      if (number <= 4_096n) continue
      let capable = true
      for (const [from, to] of [
        [number - 4_096n, number - 4_065n],
        [number - 32n, number - 1n],
      ]) {
        if (Date.now() >= deadlineMs) {
          capable = false
          break
        }
        const logs = await client.request('eth_getLogs', [
          {
            address: route.destination,
            topics: [TRANSFER_TOPIC],
            fromBlock: `0x${from.toString(16)}`,
            toBlock: `0x${to.toString(16)}`,
          },
        ])
        if (!Array.isArray(logs)) {
          capable = false
          break
        }
      }
      if (capable) return client
    } catch {
      // A healthy finalized header does not establish historical log access.
    }
  }
  return null
}

/** Public-chain preflight selects one origin with a fresh baseline and candidate. */
export async function prepareSyncVaultOrigin({
  urls,
  route,
  slot,
  deadlineMs,
  transport = rpcTransport,
  chooseOrigin = selectSyncVaultOrigin,
  captureBaseline = captureFreshSyncVaultBaseline,
  discoverCandidate = discoverSyncVaultIssuerCandidate,
  now = () => new Date(),
}) {
  if (
    !Array.isArray(urls) ||
    !urls.length ||
    !Number.isSafeInteger(slot) ||
    !Number.isSafeInteger(deadlineMs) ||
    !syncVaultRouteSupport(route).supported
  )
    throw Error('sync_vault_preflight_invalid')
  let best = { primary: null, baseline: null, candidate: null }
  for (const [index, url] of urls.entries()) {
    const started = now().getTime()
    if (started >= deadlineMs) break
    const remaining = deadlineMs - started
    const attemptDeadline = Math.min(
      deadlineMs,
      started + Math.max(20_000, Math.floor(remaining / Math.min(3, urls.length - index))),
    )
    const primary = await chooseOrigin([url], route, transport, attemptDeadline)
    if (!primary) continue
    if (!best.primary) best = { primary, baseline: null, candidate: null }
    const request = async (method, params) => {
      if (now().getTime() >= attemptDeadline) throw Error('origin_preflight_deadline')
      return primary.request(method, params)
    }
    let baseline
    try {
      baseline = await captureBaseline({
        ...route,
        provider: primary.provider,
        source: 'carry_exit_v2_sync_vault_issuer',
        request,
        now,
      })
    } catch {
      continue
    }
    if (!best.baseline) best = { primary, baseline, candidate: null }
    let candidate
    try {
      candidate = await discoverCandidate({ baseline, request })
    } catch {
      continue
    }
    if (candidate?.holder) return { primary, baseline, candidate }
    if (candidate && !best.candidate) best = { primary, baseline, candidate }
  }
  return best
}

/** One frozen route and slot; no private holder/Q is read from SQL before RPC. */
export async function issueSyncVaultV2Route({
  sql,
  slot,
  route,
  primary,
  secondary,
  preflight = null,
  deadlineMs = null,
  appendAttempt = appendSyncVaultAttempt,
  captureBaseline = captureFreshSyncVaultBaseline,
  discoverCandidate = discoverSyncVaultIssuerCandidate,
  collect = collectCarryExitV2RpcProof,
  verify = verifyCarryExitV2IndependentReplay,
  assemble = assembleCarryExitV2CallEvidence,
  persist = issuePlan,
  hashEvidence = digestEvidence,
  recordDbAttempt = recordDatabaseAttempt,
  recoverIssuedBatch = findIssuedBatch,
  recoverIssuedSlotBatch = findIssuedSlotBatch,
  recordLocalIssues = appendLocalCarryExitV2IssuerIssues,
  now = () => new Date(),
}) {
  const support = syncVaultRouteSupport(route)
  const slotEndMs = (slot + 1) * SLOT_MS + 10 * 60_000
  const deadline = Math.min(deadlineMs ?? now().getTime() + TICK_BUDGET_MS, slotEndMs - 30_000)
  const local = async (status, reason, extra = {}) =>
    appendAttempt(syncVaultAttemptRecord({ slot, route, status, reason, at: now(), ...extra }))
  const record = async (status, reason, dbReason, extra = {}) => {
    await local(status, reason, extra)
    await recordDbAttempt(
      sql,
      route,
      slot,
      status === 'issued' ? 'issued' : 'unavailable',
      status === 'issued' ? null : dbReason,
      extra.batchId ?? null,
    )
  }
  if (now().getTime() >= deadline) {
    if (now().getTime() < slotEndMs)
      await record('unavailable', 'native_issue_slot_elapsed', 'plan_invalid')
    else await local('slot_elapsed', 'native_issue_slot_elapsed')
    return { status: 'slot_elapsed', reason: 'native_issue_slot_elapsed' }
  }
  if (!support.supported) {
    await record('unavailable', support.reason, 'identity_unavailable')
    return { status: 'unavailable', reason: support.reason }
  }
  if (!primary || !secondary || origin(primary.url) === origin(secondary.url)) {
    await record('unavailable', 'independent_rpc_unavailable', 'rpc_unavailable')
    return { status: 'unavailable', reason: 'independent_rpc_unavailable' }
  }
  const request = async (method, params) => {
    if (now().getTime() >= deadline) throw Error('issuer_deadline_elapsed')
    return primary.request(method, params)
  }
  const send = async (envelope) => {
    if (now().getTime() >= deadline) throw Error('issuer_deadline_elapsed')
    return primary.send(envelope)
  }
  let baseline, candidate
  let stage = 'baseline'
  try {
    baseline = preflight
      ? preflight.baseline
      : await captureBaseline({
          ...route,
          provider: primary.provider,
          source: 'carry_exit_v2_sync_vault_issuer',
          request,
          now,
        })
    if (
      !baseline ||
      baseline.routeKey !== route.routeKey ||
      baseline.destination !== route.destination ||
      baseline.asset !== route.asset
    )
      throw Error('preflight_baseline_invalid')
    stage = 'candidate'
    candidate = preflight ? preflight.candidate : await discoverCandidate({ baseline, request })
    if (!candidate) throw Error('preflight_candidate_unavailable')
  } catch {
    const reason = `${stage}_unavailable`
    await record('unavailable', reason, reason, { baseline })
    return { status: 'unavailable', reason }
  }
  const ladder = candidate?.evidenceDoc?.ladder?.labels
  if (
    !Array.isArray(ladder) ||
    ladder.length !== 6 ||
    new Set(ladder.map((x) => x.label)).size !== 6 ||
    sha(candidate.evidenceDoc) !== candidate.digest ||
    ladder.some((x) => x.assetsRaw !== null && !/^[1-9][0-9]*$/.test(x.assetsRaw ?? ''))
  ) {
    await record('unavailable', 'candidate_evidence_invalid', 'candidate_unavailable', { baseline })
    return { status: 'unavailable', reason: 'candidate_evidence_invalid' }
  }
  const omittedLadder = ladder
    .filter((x) => x.reason)
    .map((x) => ({ label: x.label, reason: x.reason, duplicateOf: x.duplicateOf ?? null }))
  if (!candidate.holder) {
    await record('unavailable', candidate.evidenceDoc.unavailableReason, 'no_eligible_holder', {
      baseline,
      candidate,
      omittedLadder,
    })
    return { status: 'unavailable', reason: candidate.evidenceDoc.unavailableReason }
  }
  const positive = ladder.filter((x) => x.assetsRaw !== null)
  if (!positive.length) {
    await record('unavailable', 'no_positive_unique_q', 'zero_or_duplicate_q', {
      baseline,
      candidate,
      omittedLadder,
    })
    return { status: 'unavailable', reason: 'no_positive_unique_q' }
  }
  const cases = []
  const caseStatuses = []
  for (const entry of positive) {
    let result = emptyCase(entry.assetsRaw)
    if (now().getTime() < deadline) {
      try {
        const frozen = {
          ...route,
          holder: candidate.holder,
          assetsRaw: entry.assetsRaw,
          blockNumber: baseline.targetBlock,
          blockHash: baseline.targetHash,
        }
        const collected = await collect({
          ...route,
          holder: candidate.holder,
          assetsRaw: entry.assetsRaw,
          target: baseline,
          provider: primary.provider,
          source: 'carry_exit_v2_sync_vault_issuer',
          send,
          now,
        })
        const replay = await verify({
          ...frozen,
          proof: collected.proof,
          identityEvidence: collected.identityEvidence,
          primary: { url: primary.url, request: send },
          secondary: { url: secondary.url, request: secondary.send.bind(secondary) },
          now,
        })
        if (replay.status === 'verified') {
          const evidence = assemble({ collector: collected, replay, frozen })
          result = syncVaultCaseFromMeasurement(
            entry.assetsRaw,
            evidence,
            validateCarryExitV2RpcProof({ proof: collected.proof, ...frozen }),
          )
        }
      } catch {
        /* Keep a Q-specific unavailable denominator. */
      }
    }
    if (result.callEvidenceDoc || result.entitlementEvidenceDoc) {
      try {
        if (result.callEvidenceDoc)
          result.callEvidenceSha256 = await hashEvidence(sql, result.callEvidenceDoc)
        if (result.entitlementEvidenceDoc)
          result.entitlementEvidenceSha256 = await hashEvidence(sql, result.entitlementEvidenceDoc)
      } catch {
        result = emptyCase(entry.assetsRaw)
      }
    }
    cases.push(result)
    caseStatuses.push({
      label: entry.label,
      status: result.baselineStatus,
      reason: result.unavailableReason,
    })
  }
  let candidateEvidenceSha256
  try {
    candidateEvidenceSha256 = await hashEvidence(sql, candidate.evidenceDoc)
  } catch {
    await local('issue_unknown', 'candidate_digest_unavailable', {
      baseline,
      candidate,
      caseStatuses,
      omittedLadder,
    })
    return { status: 'issue_unknown', reason: 'candidate_digest_unavailable' }
  }
  const plan = {
    version: 'carry_exit_v2',
    clock: 'db_issued_at',
    endpointSelection: 'first_finalized_at_or_after_target',
    captureDeadlineHours: 2,
    horizons: [1, 4, 24, 48, 168],
    routeKey: route.routeKey,
    slotAt: new Date(slot * SLOT_MS + 10 * 60_000).toISOString(),
    destination: route.destination,
    asset: route.asset,
    assetDecimals: baseline.assetDecimals,
    holder: candidate.holder,
    baselineBlock: baseline.targetBlock,
    baselineHash: baseline.targetHash,
    baselineBlockAt: baseline.targetBlockAt,
    baselineObservedAt: baseline.targetObservedAt,
    candidateProvenance: 'receipt_verified_transfer',
    candidateEvidenceSha256,
    candidateEvidenceDoc: candidate.evidenceDoc,
    canonicalityEvidenceDoc: baseline.canonicalityEvidenceDoc,
    omittedLadder,
    cases,
  }
  let batchId
  try {
    batchId = await persist(sql, plan)
  } catch {
    try {
      batchId = await recoverIssuedBatch(sql, plan)
    } catch {
      /* Unknown commit. */
    }
    if (!batchId) {
      try {
        batchId = await recoverIssuedSlotBatch(sql, route, slot, plan)
      } catch {
        /* Unknown commit. */
      }
      if (batchId) {
        await recordLocalIssues({
          source: 'sync_vault',
          batchId,
          plan,
          recordedAt: now(),
        })
        await local('issued_recovered', 'slot_batch_reconciled', { batchId })
        await recordDbAttempt(sql, route, slot, 'issued', null, batchId)
        return { status: 'issued_recovered', batchId }
      }
      await local('issue_unknown', 'db_commit_unknown', {
        baseline,
        candidate,
        caseStatuses,
        omittedLadder,
      })
      return { status: 'issue_unknown', reason: 'db_commit_unknown' }
    }
  }
  await recordLocalIssues({ source: 'sync_vault', batchId, plan, recordedAt: now() })
  await record('issued', null, null, { baseline, candidate, caseStatuses, omittedLadder, batchId })
  return {
    status: 'issued',
    batchId,
    cases: cases.length,
    unavailableCases: cases.filter((x) => x.baselineStatus === 'unavailable').length,
    omittedCases: omittedLadder.length,
  }
}

export function recoverSyncVaultLocalIssueMirror({
  sql,
  route,
  slot,
  existingAttempt = null,
  loadStoredBatch = (expectedBatchId) => findIssuedSlotBatchPlan(sql, route, slot, expectedBatchId),
  recordLocalIssues = appendLocalCarryExitV2IssuerIssues,
  recordedAt = new Date(),
}) {
  return recoverLocalCarryExitV2IssuedSlot({
    source: 'sync_vault',
    route,
    slotAt: new Date(slot * SLOT_MS + 10 * 60_000).toISOString(),
    existingAttempt,
    loadStoredBatch,
    recordLocalIssues,
    recordedAt,
  })
}

async function main() {
  if (process.argv.length !== 2) throw Error('usage: no arguments')
  const { get } = readEnv()
  const db =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  const rawUrls =
    process.env.RECORDER_RPC_URLS ||
    process.env.RECORDER_RPC_URL ||
    get('RECORDER_RPC_URLS') ||
    get('RECORDER_RPC_URL')
  const verifyUrl =
    process.env.CARRY_EXIT_V2_VERIFY_RPC_URL ||
    get('CARRY_EXIT_V2_VERIFY_RPC_URL') ||
    'https://eth.drpc.org'
  if (!db) throw Error('recorder_configuration_missing')
  return withLock(async () => {
    const sql = neon(db)
    const beforeSlot = selectedSyncVaultRoute(Date.now()).slot
    await reconcilePriorLocalIssueMirrors({
      sql,
      source: 'sync_vault',
      beforeSlot,
      appendAttempt: appendSyncVaultAttempt,
      makeAttempt: syncVaultAttemptRecord,
    })
    const { slot, route, routeCount } = selectedSyncVaultRoute(Date.now())
    const existing = await readCurrentAttempt(sql, route, slot)
    const recovered = await recoverSyncVaultLocalIssueMirror({
      sql,
      route,
      slot,
      existingAttempt: existing,
    })
    await finalizeRecoveredCurrentLocalMirror({
      sql,
      route,
      slot,
      recovered,
      existingAttempt: existing,
      appendAttempt: appendSyncVaultAttempt,
      makeAttempt: syncVaultAttemptRecord,
    })
    if (existing)
      return {
        slot,
        routeCount,
        routeKey: route.routeKey,
        status: 'already_recorded',
        recordedStatus: existing.status,
        prospectivelyValidated: false,
        futureExitForecast: false,
      }
    if (recovered) {
      return {
        slot,
        routeCount,
        routeKey: route.routeKey,
        status: 'issued_recovered',
        batchId: recovered.batchId,
        prospectivelyValidated: false,
        futureExitForecast: false,
      }
    }
    // Unsupported Fluid rows are recorded before any RPC request.
    let primary = null
    let secondary = null
    let preflight = null
    const deadlineMs = Math.min(
      Date.now() + TICK_BUDGET_MS,
      (slot + 1) * SLOT_MS + 10 * 60_000 - 30_000,
    )
    if (syncVaultRouteSupport(route).supported) {
      try {
        if (rawUrls) {
          preflight = await prepareSyncVaultOrigin({
            urls: configuredRpcUrls(rawUrls),
            route,
            slot,
            deadlineMs: deadlineMs - 90_000,
          })
          primary = preflight.primary
        }
        if (primary && origin(verifyUrl) !== primary.provider) secondary = rpcTransport(verifyUrl)
      } catch {
        // The selected route still gets an unavailable attempt denominator.
        primary = null
        secondary = null
      }
    }
    const result = await issueSyncVaultV2Route({
      sql,
      slot,
      route,
      primary,
      secondary,
      preflight,
      deadlineMs,
    })
    if (result.batchId) await recordLocalMirrorCheckpoint(sql, route, slot, result.batchId)
    return {
      slot,
      routeCount,
      routeKey: route.routeKey,
      ...result,
      prospectivelyValidated: false,
      futureExitForecast: false,
    }
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => {
      process.stderr.write('carry_sync_vault_exit_v2_issue_failed\n')
      process.exitCode = 1
    })
}
