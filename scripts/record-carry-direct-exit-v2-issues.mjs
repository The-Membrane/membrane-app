// Direct-market V2 baseline issuer. The separate committed observer witnesses
// issued batches before H1; this module never calls a future target.
import { createHash } from 'node:crypto'
import { mkdir, open, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toEventSelector } from 'viem'
import { neon } from '@neondatabase/serverless'

import { ROOT, readEnv } from './lib/venue-reads.mjs'
import {
  CARRY_EXIT_V2_FROZEN_ROUTES,
  validateCarryExitV2RpcProof,
} from './lib/carry-exit-v2-rpc-proof.mjs'
import {
  captureFreshDirectBaseline,
  discoverDirectIssuerCandidate,
} from './lib/carry-exit-v2-direct-issuer-prep.mjs'
import { collectCarryExitV2RpcProof } from './lib/carry-exit-v2-rpc-collector.mjs'
import { verifyCarryExitV2IndependentReplay } from './lib/carry-exit-v2-independent-replay.mjs'
import { assembleCarryExitV2CallEvidence } from './lib/carry-exit-v2-proof-assembly.mjs'
import {
  appendLocalCarryExitV2IssuerAttempt,
  appendLocalCarryExitV2IssuerIssues,
  recoverLocalCarryExitV2IssuedSlot,
} from './lib/localCarryExitV2Issuer.mjs'
import {
  issuePlan,
  reconcilePriorLocalIssueMirrors,
  digestEvidence,
  recordDatabaseAttempt,
  findIssuedBatch,
  findIssuedSlotBatch,
  findIssuedSlotBatchPlan,
  finalizeRecoveredCurrentLocalMirror,
  rpcTransport,
  configuredRpcUrls,
  readCurrentAttempt,
  recordLocalMirrorCheckpoint,
} from './record-carry-morpho-exit-v2-issues.mjs'

const SLOT_MS = 15 * 60_000
const TICK_BUDGET_MS = 4 * 60_000
const ATTEMPTS_PATH = join(ROOT, 'lib/carry/research/carry-direct-exit-v2-issue-attempts.jsonl')
const LOCK_PATH = join(ROOT, 'lib/carry/research/carry-direct-exit-v2-issue.lock')
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const TRANSFER_TOPIC = toEventSelector('Transfer(address,address,uint256)').toLowerCase()
const SUPPLY_TOPIC = toEventSelector('Supply(address,address,uint256)').toLowerCase()
const ADDRESS = /^0x[0-9a-f]{40}$/
const DIRECT_KINDS = new Set(['aave', 'comet', 'spark'])
const KNOWN_KINDS = new Set(['morpho', 'susds', 'usd3', 'stusds', 'fluid', 'sgho', ...DIRECT_KINDS])

/** Every direct placement in the frozen registry, one per :10/:25/:40/:55 slot. */
export function selectedDirectRoute(nowMs, registry = CARRY_EXIT_V2_FROZEN_ROUTES) {
  if (
    !Array.isArray(registry) ||
    registry.some(
      (route) =>
        !KNOWN_KINDS.has(route?.kind) ||
        typeof route.routeKey !== 'string' ||
        !route.routeKey ||
        !ADDRESS.test(route.destination ?? '') ||
        !ADDRESS.test(route.asset ?? ''),
    )
  )
    throw Error('direct_route_registry_invalid')
  const routes = registry
    .filter((route) => DIRECT_KINDS.has(route.kind))
    .sort((a, b) =>
      `${a.destination}\u0000${a.routeKey}`.localeCompare(`${b.destination}\u0000${b.routeKey}`),
    )
  if (
    !routes.length ||
    [...DIRECT_KINDS].some((kind) => !routes.some((route) => route.kind === kind)) ||
    routes.some(
      (route) =>
        !ADDRESS.test(route.withdrawTarget ?? '') ||
        !ADDRESS.test(route.holderCoverageTarget ?? '') ||
        (route.kind === 'comet' &&
          (route.withdrawTarget !== route.destination ||
            route.holderCoverageTarget !== route.destination)) ||
        (route.kind !== 'comet' && route.withdrawTarget === route.holderCoverageTarget),
    ) ||
    new Set(
      routes.map((route) => `${route.routeKey}\u0000${route.destination}\u0000${route.asset}`),
    ).size !== routes.length
  )
    throw Error('direct_route_roster_changed')
  const slot = Math.floor((nowMs - 10 * 60_000) / SLOT_MS)
  return {
    slot,
    route: routes[((slot % routes.length) + routes.length) % routes.length],
    routeCount: routes.length,
  }
}

export function directCaseFromMeasurement(q, assembled, decoded) {
  const basic = {
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
    unavailableReason: 'quote_unavailable',
  }
  if (
    !assembled ||
    !['aave', 'spark', 'comet'].includes(decoded?.routeKind) ||
    decoded.requiredCoverageRaw !== q
  )
    return basic
  const balance = BigInt(decoded.holderCoverageRaw)
  if (balance < BigInt(q)) {
    // Comet.withdraw can return success by opening debt. This is a measured
    // lack of supplier entitlement, not a successful supplier withdrawal.
    return {
      ...basic,
      baselineStatus: 'ineligible',
      coverageKind: 'assets',
      holderCoverageRaw: decoded.holderCoverageRaw,
      requiredCoverageRaw: q,
      entitlementMethod: 'exact_asset_balance',
      entitlementEvidenceDoc: {
        ...assembled,
        purpose: 'entitlement',
        withdrawRpc: null,
        actualConsumedRaw: null,
        simulationStatus: null,
        entitlementMethod: 'exact_asset_balance',
      },
      unavailableReason: null,
    }
  }
  const status =
    decoded.simulationStatus === 'success'
      ? 'success'
      : decoded.coveredRevert
        ? 'covered_revert'
        : null
  if (!status) return basic
  return {
    ...basic,
    baselineStatus: status,
    coverageKind: 'assets',
    holderCoverageRaw: decoded.holderCoverageRaw,
    requiredCoverageRaw: q,
    simulationStatus: decoded.simulationStatus,
    callEvidenceDoc: assembled,
    unavailableReason: null,
  }
}

export function directAttemptRecord({
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
    schema: 'carry_exit_v2_direct_issue_attempt_v1',
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

export async function appendDirectAttempt(
  record,
  path = ATTEMPTS_PATH,
  appendLocalAttempt = appendLocalCarryExitV2IssuerAttempt,
) {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'a', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await appendLocalAttempt('direct', record)
}

async function withLock(fn, path = LOCK_PATH, nowMs = Date.now()) {
  await mkdir(dirname(path), { recursive: true })
  let handle
  try {
    handle = await open(path, 'wx', 0o600)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const metadata = await stat(path).catch(() => null)
    if (!metadata || nowMs - metadata.mtimeMs < 2 * TICK_BUDGET_MS) return { status: 'locked' }
    await rm(path, { force: true })
    handle = await open(path, 'wx', 0o600)
  }
  try {
    return await fn()
  } finally {
    await handle.close()
    await rm(path, { force: true })
  }
}

/** A failed endpoint probe is an unavailable denominator, not a quiet skip. */
export async function selectDirectOrigin(
  urls,
  route,
  transport = rpcTransport,
  deadlineMs = Date.now() + TICK_BUDGET_MS,
) {
  for (const url of urls) {
    if (Date.now() >= deadlineMs) break
    const client = transport(url)
    try {
      if ((await client.request('eth_chainId', [])) !== '0x1') continue
      const head = await client.request('eth_getBlockByNumber', ['finalized', false])
      const number = BigInt(head.number)
      if (number < 33n) continue
      const topic = route.kind === 'comet' ? SUPPLY_TOPIC : TRANSFER_TOPIC
      const oldFrom = number > 4_096n ? number - 4_096n : 1n
      const ranges = [
        [number - 32n, number - 1n],
        [oldFrom, oldFrom + 31n < number ? oldFrom + 31n : number - 1n],
      ]
      let capable = true
      for (const [from, to] of ranges) {
        if (Date.now() >= deadlineMs) {
          capable = false
          break
        }
        const logs = await client.request('eth_getLogs', [
          {
            address: route.destination,
            topics: [topic],
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
      /* Continue to another configured endpoint. */
    }
  }
  return null
}

/** Public-only preflight: keep one origin that completed both frozen reads. */
export async function prepareDirectOrigin({
  urls,
  route,
  slot,
  transport = rpcTransport,
  chooseOrigin = selectDirectOrigin,
  captureBaseline = captureFreshDirectBaseline,
  discoverCandidate = discoverDirectIssuerCandidate,
  now = () => new Date(),
}) {
  if (!Array.isArray(urls) || !urls.length || !Number.isSafeInteger(slot))
    throw Error('direct_preflight_invalid')
  const slotEndMs = (slot + 1) * SLOT_MS + 10 * 60_000
  const deadline = Math.min(now().getTime() + TICK_BUDGET_MS, slotEndMs - 30_000)
  let best = { primary: null, baseline: null, candidate: null }
  for (const [index, url] of urls.entries()) {
    const start = now().getTime()
    if (start >= deadline) break
    // A failed candidate scan must leave room to try another provider.
    const remaining = deadline - start
    const attemptDeadline = Math.min(
      deadline,
      start + Math.max(30_000, Math.floor(remaining / Math.min(3, urls.length - index))),
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
        source: 'carry_exit_v2_direct_issuer',
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

/** One immutable baseline, candidate, six-Q ladder, and DB-clock issue. */
export async function issueDirectV2Route({
  sql,
  slot,
  route,
  primary,
  secondary,
  appendAttempt = appendDirectAttempt,
  now = () => new Date(),
  captureBaseline = captureFreshDirectBaseline,
  discoverCandidate = discoverDirectIssuerCandidate,
  collect = collectCarryExitV2RpcProof,
  verify = verifyCarryExitV2IndependentReplay,
  assemble = assembleCarryExitV2CallEvidence,
  persist = issuePlan,
  hashEvidence = digestEvidence,
  recordDbAttempt = recordDatabaseAttempt,
  recoverIssuedBatch = findIssuedBatch,
  recoverIssuedSlotBatch = findIssuedSlotBatch,
  recordLocalIssues = appendLocalCarryExitV2IssuerIssues,
}) {
  const slotAt = new Date(slot * SLOT_MS + 10 * 60_000).toISOString()
  const slotEndMs = (slot + 1) * SLOT_MS + 10 * 60_000
  const deadline = Math.min(now().getTime() + TICK_BUDGET_MS, slotEndMs - 30_000)
  const boundedRequest = async (method, params) => {
    if (now().getTime() >= deadline) throw Error('issuer_deadline_elapsed')
    return primary.request(method, params)
  }
  const boundedSend = async (envelope) => {
    if (now().getTime() >= deadline) throw Error('issuer_deadline_elapsed')
    return primary.send(envelope)
  }
  const record = async (status, reason, dbReason, extra = {}) => {
    await appendAttempt(directAttemptRecord({ slot, route, status, reason, at: now(), ...extra }))
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
    if (now().getTime() < slotEndMs) {
      try {
        await record('unavailable', 'native_issue_slot_elapsed', 'plan_invalid')
      } catch {
        /* Local attempt remains durable. */
      }
    } else
      await appendAttempt(
        directAttemptRecord({
          slot,
          route,
          status: 'slot_elapsed',
          reason: 'native_issue_slot_elapsed',
          at: now(),
        }),
      )
    return { status: 'slot_elapsed', reason: 'native_issue_slot_elapsed' }
  }
  if (!primary) {
    await record('unavailable', 'primary_rpc_unavailable', 'rpc_unavailable')
    return { status: 'unavailable', reason: 'primary_rpc_unavailable' }
  }
  let baseline, candidate
  let stage = 'baseline'
  try {
    baseline = await captureBaseline({
      ...route,
      provider: primary.provider,
      source: 'carry_exit_v2_direct_issuer',
      request: boundedRequest,
      now,
    })
    stage = 'candidate'
    candidate = await discoverCandidate({ baseline, request: boundedRequest })
  } catch {
    const reason = `${stage}_unavailable`
    await record('unavailable', reason, reason, { baseline })
    return { status: 'unavailable', reason }
  }
  const ladder = candidate?.evidenceDoc?.ladder?.labels
  if (
    !Array.isArray(ladder) ||
    ladder.length !== 6 ||
    candidate.digest !== sha(candidate.evidenceDoc) ||
    new Set(ladder.map((entry) => entry.label)).size !== 6 ||
    ladder.some((entry) => entry.assetsRaw !== null && !/^[1-9][0-9]*$/.test(entry.assetsRaw ?? ''))
  ) {
    await record('unavailable', 'candidate_evidence_invalid', 'candidate_unavailable', { baseline })
    return { status: 'unavailable', reason: 'candidate_evidence_invalid' }
  }
  const omittedLadder = ladder
    .filter((entry) => entry.reason)
    .map((entry) => ({
      label: entry.label,
      reason: entry.reason,
      duplicateOf: entry.duplicateOf ?? null,
    }))
  if (!candidate.holder) {
    await record('unavailable', candidate.evidenceDoc.unavailableReason, 'no_eligible_holder', {
      baseline,
      candidate,
      omittedLadder,
    })
    return { status: 'unavailable', reason: candidate.evidenceDoc.unavailableReason }
  }
  const positive = ladder.filter((entry) => entry.assetsRaw != null)
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
    let result = directCaseFromMeasurement(entry.assetsRaw, null, null)
    if (secondary && now().getTime() < deadline) {
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
          source: 'carry_exit_v2_direct_issuer',
          send: boundedSend,
          now,
        })
        const replay = await verify({
          ...frozen,
          proof: collected.proof,
          identityEvidence: collected.identityEvidence,
          primary: { url: primary.url, request: boundedSend },
          secondary: { url: secondary.url, request: secondary.send.bind(secondary) },
          now,
        })
        if (replay.status === 'verified') {
          const evidence = assemble({ collector: collected, replay, frozen })
          const decoded = validateCarryExitV2RpcProof({ proof: collected.proof, ...frozen })
          result = directCaseFromMeasurement(entry.assetsRaw, evidence, decoded)
        }
      } catch {
        /* Frozen Q remains explicitly unavailable. */
      }
    }
    cases.push(result)
    caseStatuses.push({
      label: entry.label,
      status: result.baselineStatus,
      reason: result.unavailableReason,
    })
  }
  for (let i = 0; i < cases.length; i++) {
    const evidence = cases[i].callEvidenceDoc ?? cases[i].entitlementEvidenceDoc
    if (!evidence) continue
    try {
      const digest = await hashEvidence(sql, evidence)
      if (cases[i].callEvidenceDoc) cases[i].callEvidenceSha256 = digest
      else cases[i].entitlementEvidenceSha256 = digest
    } catch {
      cases[i] = directCaseFromMeasurement(cases[i].assetsRaw, null, null)
      caseStatuses[i] = { ...caseStatuses[i], status: 'unavailable', reason: 'quote_unavailable' }
    }
  }
  let candidateEvidenceSha256
  try {
    candidateEvidenceSha256 = await hashEvidence(sql, candidate.evidenceDoc)
  } catch {
    await appendAttempt(
      directAttemptRecord({
        slot,
        route,
        status: 'issue_unknown',
        reason: 'candidate_digest_unavailable',
        baseline,
        candidate,
        caseStatuses,
        omittedLadder,
        at: now(),
      }),
    )
    return { status: 'issue_unknown', reason: 'candidate_digest_unavailable' }
  }
  const plan = {
    version: 'carry_exit_v2',
    clock: 'db_issued_at',
    endpointSelection: 'first_finalized_at_or_after_target',
    captureDeadlineHours: 2,
    horizons: [1, 4, 24, 48, 168],
    routeKey: route.routeKey,
    slotAt,
    destination: route.destination,
    asset: route.asset,
    assetDecimals: baseline.assetDecimals,
    holder: candidate.holder,
    baselineBlock: baseline.targetBlock,
    baselineHash: baseline.targetHash,
    baselineBlockAt: baseline.targetBlockAt,
    baselineObservedAt: baseline.targetObservedAt,
    candidateProvenance:
      route.kind === 'comet' ? 'receipt_verified_supply' : 'receipt_verified_transfer',
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
      /* Commit state unknown. */
    }
    if (!batchId) {
      let prior
      try {
        prior = await recoverIssuedSlotBatch(sql, route, slot, plan)
      } catch {
        /* Commit state unknown. */
      }
      if (prior) {
        await recordLocalIssues({
          source: 'direct',
          batchId: prior,
          plan,
          recordedAt: now(),
        })
        await appendAttempt(
          directAttemptRecord({
            slot,
            route,
            status: 'issued_recovered',
            reason: 'slot_batch_reconciled',
            batchId: prior,
            at: now(),
          }),
        )
        await recordDbAttempt(sql, route, slot, 'issued', null, prior)
        return { status: 'issued_recovered', batchId: prior }
      }
    }
    if (!batchId) {
      await appendAttempt(
        directAttemptRecord({
          slot,
          route,
          status: 'issue_unknown',
          reason: 'db_commit_unknown',
          baseline,
          candidate,
          caseStatuses,
          omittedLadder,
          at: now(),
        }),
      )
      return { status: 'issue_unknown', reason: 'db_commit_unknown' }
    }
  }
  await recordLocalIssues({ source: 'direct', batchId, plan, recordedAt: now() })
  await record('issued', null, null, { baseline, candidate, caseStatuses, omittedLadder, batchId })
  return {
    status: 'issued',
    batchId,
    cases: cases.length,
    unavailableCases: caseStatuses.filter((row) => row.status === 'unavailable').length,
    omittedCases: omittedLadder.length,
  }
}

export function issuePreparedDirectV2Route({ prepared, ...options }) {
  return issueDirectV2Route({
    ...options,
    primary: prepared.primary,
    captureBaseline: prepared.baseline
      ? async () => prepared.baseline
      : async () => {
          throw Error('preflight_baseline_unavailable')
        },
    discoverCandidate: prepared.candidate
      ? async () => prepared.candidate
      : async () => {
          throw Error('preflight_candidate_unavailable')
        },
  })
}

export function recoverDirectLocalIssueMirror({
  sql,
  route,
  slot,
  existingAttempt = null,
  loadStoredBatch = (expectedBatchId) => findIssuedSlotBatchPlan(sql, route, slot, expectedBatchId),
  recordLocalIssues = appendLocalCarryExitV2IssuerIssues,
  recordedAt = new Date(),
}) {
  return recoverLocalCarryExitV2IssuedSlot({
    source: 'direct',
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
  if (!db || !rawUrls) throw Error('recorder_configuration_missing')
  return withLock(async () => {
    const sql = neon(db)
    const beforeSlot = selectedDirectRoute(Date.now()).slot
    await reconcilePriorLocalIssueMirrors({
      sql,
      source: 'direct',
      beforeSlot,
      appendAttempt: appendDirectAttempt,
      makeAttempt: directAttemptRecord,
    })
    const { slot, route, routeCount } = selectedDirectRoute(Date.now())
    const existing = await readCurrentAttempt(sql, route, slot)
    const recovered = await recoverDirectLocalIssueMirror({
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
      appendAttempt: appendDirectAttempt,
      makeAttempt: directAttemptRecord,
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
    const prepared = await prepareDirectOrigin({
      urls: configuredRpcUrls(rawUrls),
      route,
      slot,
    })
    const { primary } = prepared
    const verifyOrigin = new URL(verifyUrl).origin
    const secondary = primary && verifyOrigin !== primary.provider ? rpcTransport(verifyUrl) : null
    const result = await issuePreparedDirectV2Route({
      prepared,
      sql,
      slot,
      route,
      secondary,
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
      process.stderr.write('carry_direct_exit_v2_issue_failed\n')
      process.exitCode = 1
    })
}
