import {
  carryExitV2RpcBudgetReason,
  startCarryExitV2BudgetedRpc,
} from '../lib/carry-exit-v2-rpc-budget.mjs'
import { UMBRELLA_GHO_ROUTE } from '../lib/carry-exit-v2-umbrella-gho-proof.mjs'
import {
  issueUmbrellaGhoV2Route,
  discoverUmbrellaGhoV2Candidate,
} from '../lib/carry-exit-v2-umbrella-gho-issuer.mjs'
// App-native Carry Exit V2 issuer. It reuses the frozen RPC/candidate/proof
// orchestration while replacing every database seam with the local journal.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CARRY_EXIT_V2_FROZEN_ROUTES } from '../lib/carry-exit-v2-rpc-proof.mjs'
import {
  buildLocalCarryExitV2HistoricalUnavailableAttempt,
  selectLocalCarryExitV2HistoricalSubjects,
  summarizeLocalCarryExitV2HistoricalRoster,
} from '../lib/localCarryExitV2HistoricalRoster.mjs'
import {
  createLocalCarryExitV2NoNeonPersistence,
  hashLocalCarryExitV2Json,
  localCarryExitV2NativeSlotAt,
  resumeLocalCarryExitV2UnfinishedSealedEpisodes,
} from '../lib/localCarryExitV2NoNeonIssuer.mjs'
import {
  appendLocalCarryExitV2Record,
  LOCAL_CARRY_EXIT_V2_ROOT,
  verifyLocalCarryExitV2Ledger,
} from '../lib/localCarryExitV2Store.mjs'
import { readEnv } from '../lib/venue-reads.mjs'
import {
  captureFreshDirectBaseline,
  discoverDirectIssuerCandidate,
} from '../lib/carry-exit-v2-direct-issuer-prep.mjs'
import { issueDirectV2Route, selectDirectOrigin } from '../record-carry-direct-exit-v2-issues.mjs'
import {
  captureFreshMorphoBaseline,
  discoverMorphoIssuerCandidate,
} from '../lib/carry-exit-v2-morpho-issuer-prep.mjs'
import {
  issueMorphoV2Route,
  rpcTransport,
  selectHealthyOrigin,
} from '../record-carry-morpho-exit-v2-issues.mjs'
import {
  captureFreshSyncVaultBaseline,
  discoverSyncVaultIssuerCandidate,
} from '../lib/carry-exit-v2-sync-vault-issuer-prep.mjs'
import {
  issueSyncVaultV2Route,
  selectSyncVaultOrigin,
  syncVaultRouteSupport,
} from '../record-carry-sync-vault-exit-v2-issues.mjs'

const SLOT_MS = 15 * 60_000
const SLOT_OFFSET_MS = 10 * 60_000
const TICK_BUDGET_MS = 4 * 60_000
const MAX_URLS = 8
const MAX_FAMILY_RPC_STARTS = 256
const VERIFY_RPC_FALLBACK = 'https://eth.drpc.org'
const HISTORICAL_DECISION_UNITS = 10_000n
const ADDRESS = /^0x[0-9a-f]{40}$/
const MORPHO_KINDS = new Set(['morpho'])
const DIRECT_KINDS = new Set(['aave', 'spark', 'comet'])
const SYNC_VAULT_KINDS = new Set(['sgho', 'susds', 'usd3', 'stusds', 'fluid'])
const KNOWN_KINDS = new Set([...MORPHO_KINDS, ...DIRECT_KINDS, ...SYNC_VAULT_KINDS, 'umbrella_gho'])

function positiveMod(value, divisor) {
  return ((value % divisor) + divisor) % divisor
}

function routeIdentity(route) {
  return `${route.routeKey}\u0000${route.destination}\u0000${route.asset}`
}

function assertRegistry(registry) {
  if (
    !Array.isArray(registry) ||
    !registry.length ||
    registry.some(
      (route) =>
        !route ||
        !KNOWN_KINDS.has(route.kind) ||
        typeof route.routeKey !== 'string' ||
        !route.routeKey ||
        !ADDRESS.test(route.destination ?? '') ||
        !ADDRESS.test(route.asset ?? ''),
    ) ||
    new Set(registry.map(routeIdentity)).size !== registry.length
  )
    throw Error('local_exit_v2_no_neon_registry_invalid')
  return registry
}

function ordered(registry, kinds) {
  return registry
    .filter((route) => kinds.has(route.kind))
    .sort((left, right) =>
      `${left.destination}\u0000${left.routeKey}`.localeCompare(
        `${right.destination}\u0000${right.routeKey}`,
      ),
    )
}

export function localCarryExitV2NoNeonRoster(registry = CARRY_EXIT_V2_FROZEN_ROUTES) {
  assertRegistry(registry)
  const morpho = ordered(registry, MORPHO_KINDS)
  const direct = ordered(registry, DIRECT_KINDS)
  const syncVault = ordered(registry, SYNC_VAULT_KINDS)
  const umbrellaGho = ordered(registry, new Set(['umbrella_gho']))
  if (
    !morpho.length ||
    !direct.length ||
    !syncVault.length ||
    !direct.some((route) => route.routeKey === 'USDe → supply on Aave V3')
  )
    throw Error('local_exit_v2_no_neon_roster_incomplete')
  return Object.freeze({ morpho, direct, syncVault, umbrellaGho })
}

/**
 * Keep the issuer's native 15-minute slot, but rotate routes once per two
 * native slots. The app scheduler runs at :15/:45, so its observed native
 * slots advance by two; dividing by two makes every roster index reachable.
 */
export function selectLocalCarryExitV2NoNeonRoutes(nowMs, registry = CARRY_EXIT_V2_FROZEN_ROUTES) {
  if (!Number.isSafeInteger(nowMs)) throw Error('local_exit_v2_no_neon_clock_invalid')
  const roster = localCarryExitV2NoNeonRoster(registry)
  const slot = Math.floor((nowMs - SLOT_OFFSET_MS) / SLOT_MS)
  const rotationIndex = Math.floor(slot / 2)
  return {
    slot,
    rotationIndex,
    morpho: roster.morpho[positiveMod(rotationIndex, roster.morpho.length)],
    direct: roster.direct[positiveMod(rotationIndex, roster.direct.length)],
    syncVault: roster.syncVault[positiveMod(rotationIndex, roster.syncVault.length)],
    umbrellaGho: roster.umbrellaGho[0] ?? null,
    routeCounts: {
      morpho: roster.morpho.length,
      direct: roster.direct.length,
      syncVault: roster.syncVault.length,
      umbrellaGho: roster.umbrellaGho.length,
    },
  }
}

function originHost(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password)
    throw Error('local_exit_v2_no_neon_rpc_url_invalid')
  const hostname = url.hostname
    .replace(/\.$/, '')
    .replace(/^www\./, '')
    .toLowerCase()
  return /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/.test(hostname) ? 'loopback' : hostname
}

export function configuredLocalCarryExitV2NoNeonRpcUrls(value) {
  const urls = String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (urls.length > MAX_URLS || new Set(urls).size !== urls.length)
    throw Error('local_exit_v2_no_neon_rpc_urls_invalid')
  urls.forEach(originHost)
  return urls
}

export function configuredLocalCarryExitV2NoNeonRpcUrlsWithVerification({
  urls,
  verificationUrl = VERIFY_RPC_FALLBACK,
} = {}) {
  const primaryUrls = configuredLocalCarryExitV2NoNeonRpcUrls(urls)
  const [verification] = configuredLocalCarryExitV2NoNeonRpcUrls(verificationUrl)
  if (!primaryUrls.length || !verification) return primaryUrls
  if (primaryUrls.includes(verification))
    return primaryUrls[0] === verification
      ? primaryUrls
      : [
          primaryUrls[0],
          verification,
          ...primaryUrls.slice(1).filter((url) => url !== verification),
        ]
  if (originHost(primaryUrls[0]) === originHost(verification)) return primaryUrls
  if (primaryUrls.length >= MAX_URLS) throw Error('local_exit_v2_no_neon_rpc_urls_invalid')
  return [primaryUrls[0], verification, ...primaryUrls.slice(1)]
}

function originClients({ urls = [], clients = null, transport = rpcTransport } = {}) {
  const rows = clients ?? configuredLocalCarryExitV2NoNeonRpcUrls(urls).map((url) => transport(url))
  if (!Array.isArray(rows) || rows.length > MAX_URLS)
    throw Error('local_exit_v2_no_neon_clients_invalid')
  return rows.filter(
    (client) =>
      client &&
      typeof client.url === 'string' &&
      typeof client.provider === 'string' &&
      typeof client.request === 'function' &&
      typeof client.send === 'function',
  )
}

export function selectLocalCarryExitV2NoNeonOriginPair({
  urls = [],
  clients = null,
  transport = rpcTransport,
  primary: selectedPrimary,
  verificationUrl = VERIFY_RPC_FALLBACK,
  verificationClient = null,
} = {}) {
  const valid = originClients({ urls, clients, transport })
  const [designated] = verificationClient ? originClients({ clients: [verificationClient] }) : []
  const primary = selectedPrimary === undefined ? (valid[0] ?? null) : selectedPrimary
  const independent = primary
    ? valid.filter((client) => originHost(client.url) !== originHost(primary.url))
    : []
  const secondary = primary
    ? (independent.find((client) => client.url === verificationUrl) ??
      (designated && originHost(designated.url) !== originHost(primary.url) ? designated : null) ??
      independent[0] ??
      null)
    : null
  return { primary, secondary }
}

// Selectors use the wall clock; the injected issue clock also pins the native
// slot. Bound both probes and subsequent proof RPC to the same family budget.
async function selectFamilyOriginPair({
  clients,
  verificationClient,
  verificationUrl,
  route,
  slot,
  now,
  choose,
  callerDeadlineMs = Infinity,
  callerWallDeadlineMs = Infinity,
}) {
  const startedAtMs = now().getTime()
  const deadlineMs = Math.min(
    startedAtMs + TICK_BUDGET_MS,
    callerDeadlineMs,
    (slot + 1) * SLOT_MS + SLOT_OFFSET_MS - 30_000,
  )
  const wallDeadlineMs = Math.min(
    callerWallDeadlineMs,
    Date.now() + Math.max(0, deadlineMs - startedAtMs),
  )
  const budget = { starts: 0, limit: MAX_FAMILY_RPC_STARTS, deadlineMs, wallDeadlineMs }
  const codes = { cap: 'issuer_rpc_start_limit', deadline: 'issuer_deadline_elapsed' }
  const bounded = [...clients, ...(verificationClient ? [verificationClient] : [])].map(
    (client) => {
      const call =
        (fn) =>
        async (...args) => {
          startCarryExitV2BudgetedRpc(budget, now().getTime(), codes)
          let timer
          try {
            const remaining = Math.min(
              15000,
              budget.deadlineMs - now().getTime(),
              budget.wallDeadlineMs - Date.now(),
            )
            const result = await Promise.race([
              fn(...args),
              new Promise((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      Error(
                        carryExitV2RpcBudgetReason(budget, now().getTime(), codes) ??
                          'provider_rpc_timeout',
                      ),
                    ),
                  Math.max(1, remaining),
                )
              }),
            ])
            const reason = carryExitV2RpcBudgetReason(budget, now().getTime(), codes)
            if (reason) throw Error(reason)
            return result
          } finally {
            clearTimeout(timer)
          }
        }
      return {
        ...client,
        rpcBudget: budget,
        request: call(client.request.bind(client)),
        send: call(client.send.bind(client)),
      }
    },
  )
  const primary = choose
    ? await choose(
        bounded.slice(0, clients.length).map((client) => client.url),
        route,
        (url) => bounded.find((client) => client.url === url),
        wallDeadlineMs,
      )
    : (bounded[0] ?? null)
  const pair = selectLocalCarryExitV2NoNeonOriginPair({
    clients: bounded.slice(0, clients.length),
    primary,
    verificationUrl,
    verificationClient: bounded[clients.length] ?? null,
  })
  return {
    ...pair,
    clients: bounded.slice(0, clients.length),
    verificationClient: bounded[clients.length] ?? null,
    deadlineMs,
    wallDeadlineMs,
    budget,
  }
}

function candidateFailureReason(error, stage) {
  const message = error?.message
  if (
    stage === 'candidate' &&
    [
      'candidate_log_throttle_exhausted',
      'candidate_log_request_limit',
      'candidate_logs_unavailable',
    ].includes(message)
  )
    return message
  if (message === 'issuer_deadline_elapsed' || message === 'issuer_rpc_start_limit') return message
  return `${stage}_unavailable`
}

async function prepareFamilyPrimary({ route, pair, choose, preparation, source, now }) {
  let failure = 'primary_rpc_unavailable'
  const exhausted = () =>
    carryExitV2RpcBudgetReason(pair.budget, now().getTime(), {
      cap: 'issuer_rpc_start_limit',
      deadline: 'issuer_deadline_elapsed',
    })
  for (const [index, client] of pair.clients.entries()) {
    if (now().getTime() >= pair.deadlineMs || Date.now() >= pair.wallDeadlineMs) {
      failure = 'issuer_deadline_elapsed'
      break
    }
    const remainingSources = pair.clients.length - index
    const startedAt = now().getTime()
    const providerDeadlineMs = Math.min(
      pair.deadlineMs,
      startedAt + Math.max(1, Math.floor((pair.deadlineMs - startedAt) / remainingSources)),
    )
    const providerWallDeadlineMs = Math.min(
      pair.wallDeadlineMs,
      Date.now() + Math.max(0, providerDeadlineMs - startedAt),
    )
    const transport = (url) => {
      const selected = pair.clients.find((entry) => entry.url === url)
      if (!selected) return null
      const guard = (method, params) => {
        if (now().getTime() >= providerDeadlineMs || Date.now() >= providerWallDeadlineMs)
          throw Error('issuer_deadline_elapsed')
        return selected.request(method, params)
      }
      return {
        ...selected,
        request: guard,
        async send(envelope) {
          if (now().getTime() >= providerDeadlineMs || Date.now() >= providerWallDeadlineMs)
            throw Error('issuer_deadline_elapsed')
          return selected.send(envelope)
        },
      }
    }
    let stage = 'baseline'
    try {
      const primary = await choose([client.url], route, transport, providerWallDeadlineMs)
      if (exhausted()) {
        failure = exhausted()
        break
      }
      if (now().getTime() >= pair.deadlineMs || Date.now() >= pair.wallDeadlineMs) {
        failure = 'issuer_deadline_elapsed'
        break
      }
      if (now().getTime() >= providerDeadlineMs || Date.now() >= providerWallDeadlineMs) {
        failure = 'provider_preparation_deadline_elapsed'
        continue
      }
      if (!primary) continue
      const boundedPrimary = transport(primary.url)
      if (!boundedPrimary) throw Error('primary_rpc_unavailable')
      const baseline = await preparation.captureBaseline({
        ...route,
        provider: boundedPrimary.provider,
        source:
          source === 'umbrella_gho'
            ? 'carry_exit_v2_umbrella_gho_issuer'
            : source === 'direct'
              ? 'carry_exit_v2_direct_issuer'
              : source === 'sync_vault'
                ? 'carry_exit_v2_sync_vault_issuer'
                : 'carry_exit_v2_issuer',
        request: boundedPrimary.request,
        now,
      })
      stage = 'candidate'
      const candidate = await preparation.discoverCandidate({
        baseline,
        request: boundedPrimary.request,
      })
      if (
        !baseline ||
        baseline.routeKey !== route.routeKey ||
        baseline.destination !== route.destination ||
        baseline.asset !== route.asset ||
        !candidate
      )
        throw Error('preflight_candidate_unavailable')
      if (exhausted()) {
        failure = exhausted()
        break
      }
      if (now().getTime() >= pair.deadlineMs || Date.now() >= pair.wallDeadlineMs) {
        failure = 'issuer_deadline_elapsed'
        break
      }
      if (now().getTime() >= providerDeadlineMs || Date.now() >= providerWallDeadlineMs) {
        failure = 'provider_preparation_deadline_elapsed'
        continue
      }
      return { primary: boundedPrimary, baseline, candidate }
    } catch (error) {
      const budgetReason = exhausted()
      if (budgetReason || error?.message === 'issuer_rpc_start_limit') {
        failure = budgetReason ?? 'issuer_rpc_start_limit'
        break
      }
      if (now().getTime() >= providerDeadlineMs || Date.now() >= providerWallDeadlineMs) {
        failure = 'provider_preparation_deadline_elapsed'
        continue
      }
      failure = candidateFailureReason(error, stage)
      if (failure === 'issuer_deadline_elapsed' || failure === 'issuer_rpc_start_limit') break
    }
  }
  return { reason: failure }
}

function boundPreparedPrimary(pair, prepared) {
  if (!prepared?.url) return null
  return pair.clients.find((client) => client.url === prepared.url) ?? null
}

async function recordPreparationFailure(persistence, route, family, slot, now, reason) {
  const at = now()
  await persistence.appendAttempt({
    schema: 'carry_exit_v2_no_neon_preparation_attempt_v1',
    family,
    slot,
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    at: at.toISOString(),
    status: 'unavailable',
    reason,
    batchId: null,
  })
  return publicResult(family, route, { status: 'unavailable', reason })
}

function issuerOptions(persistence) {
  return {
    sql: persistence.sql,
    appendAttempt: persistence.appendAttempt,
    persist: persistence.persist,
    hashEvidence: persistence.hashEvidence,
    recordDbAttempt: persistence.recordDbAttempt,
    recoverIssuedBatch: persistence.recoverIssuedBatch,
    recoverIssuedSlotBatch: persistence.recoverIssuedSlotBatch,
    recordLocalIssues: persistence.recordLocalIssues,
  }
}

function publicResult(family, route, result) {
  const { batchId, ...rest } = result ?? {}
  return {
    family,
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    ...rest,
    localEpisodeId: batchId ?? null,
    authoritativeStore: 'local_carry_exit_v2',
    databaseUsed: false,
  }
}

function historicalDenominatorCounts() {
  const summary = summarizeLocalCarryExitV2HistoricalRoster()
  return Object.freeze({
    routeGroups: summary.routeGroups,
    exactSubjects: summary.exactSubjects,
    supportedSubjects: summary.supportedDispatchSubjects,
    unavailableAttemptSubjects:
      summary.presentDispatchUnprovenSubjects + summary.missingFinalDeliverySubjects,
  })
}

export function recordLocalCarryExitV2HistoricalDenominator({
  root = LOCAL_CARRY_EXIT_V2_ROOT,
  rotationIndex,
  nativeSlot,
  recordedAtMs,
  minFreeBytes,
  append = appendLocalCarryExitV2Record,
} = {}) {
  if (!Number.isSafeInteger(rotationIndex) || !Number.isSafeInteger(recordedAtMs))
    throw Error('local_exit_v2_no_neon_historical_clock_invalid')
  const slotAtUtc = localCarryExitV2NativeSlotAt(nativeSlot)
  if (recordedAtMs < Date.parse(slotAtUtc))
    throw Error('local_exit_v2_no_neon_historical_clock_invalid')
  const subject = selectLocalCarryExitV2HistoricalSubjects({
    slotIndex: positiveMod(rotationIndex, 68),
  })[0]
  const counts = historicalDenominatorCounts()
  if (!subject.unavailableReason)
    return Object.freeze({
      status: 'supported_issuer_lane',
      historicalSubjectId: subject.subjectId,
      slotAtUtc,
      attemptId: null,
      assetsRaw: null,
      counts,
    })
  const assetsRaw = (
    HISTORICAL_DECISION_UNITS *
    10n ** BigInt(subject.originalPayoutDecimals)
  ).toString()
  const base = buildLocalCarryExitV2HistoricalUnavailableAttempt({
    subjectId: subject.subjectId,
    slotAtUtc,
    assetsRaw,
  })
  const payload = {
    ...base,
    databaseUsed: false,
    databaseTimestamp: null,
    sqlBatchId: null,
    localOperatorClockOnly: true,
    independentTimestamp: false,
    externalMonotonicCheckpoint: false,
    rollbackProof: false,
  }
  const options = { root, now: recordedAtMs }
  if (minFreeBytes !== undefined) options.minFreeBytes = minFreeBytes
  append('attempt', payload, options)
  return Object.freeze({
    status: 'unavailable_attempt_recorded',
    historicalSubjectId: subject.subjectId,
    slotAtUtc,
    attemptId: payload.attemptId,
    assetsRaw,
    decimals: subject.originalPayoutDecimals,
    reason: subject.unavailableReason,
    counts,
  })
}

async function safeIssue({ family, route, issue, appendAttempt, slot, now }) {
  try {
    return publicResult(family, route, await issue())
  } catch {
    const attemptedAt = now()
    if (!(attemptedAt instanceof Date) || !Number.isFinite(attemptedAt.getTime()))
      throw Error('local_exit_v2_no_neon_clock_invalid')
    await appendAttempt({
      schema: 'carry_exit_v2_no_neon_unexpected_attempt_v1',
      slot,
      routeKey: route.routeKey,
      destination: route.destination,
      asset: route.asset,
      at: attemptedAt.toISOString(),
      status: 'unavailable',
      reason: 'issuer_unavailable',
      batchId: null,
    })
    return publicResult(family, route, {
      status: 'unavailable',
      reason: 'issuer_unavailable',
    })
  }
}

async function resumeOrIssue({ family, route, persistence, slot, now, issue }) {
  const resumed = await persistence.resumeSealedEpisode({ route, slot })
  if (resumed)
    return publicResult(family, route, {
      status: 'issued_recovered',
      reason: 'local_sealed_plan_resumed',
      batchId: resumed.episodeId,
      resumedIssues: resumed.appended,
    })
  return safeIssue({
    family,
    route,
    appendAttempt: persistence.appendAttempt,
    slot,
    now,
    issue,
  })
}

/**
 * Run the three independent registry families without constructing a Neon
 * client. The imported issuers retain their verified RPC and proof path; only
 * their persistence, hash and attempt callbacks are replaced.
 */
export async function runLocalCarryExitV2NoNeonIssueTick({
  root = LOCAL_CARRY_EXIT_V2_ROOT,
  now = () => new Date(),
  urls = [],
  clients = null,
  transport = rpcTransport,
  verificationUrl = VERIFY_RPC_FALLBACK,
  registry = CARRY_EXIT_V2_FROZEN_ROUTES,
  minFreeBytes,
  issueMorpho = issueMorphoV2Route,
  issueDirect = issueDirectV2Route,
  issueSyncVault = issueSyncVaultV2Route,
  issueUmbrellaGho = issueUmbrellaGhoV2Route,
  deadlineMs = null,
  wallDeadlineMs = null,
  chooseMorphoOrigin = selectHealthyOrigin,
  chooseDirectOrigin = selectDirectOrigin,
  sourcePreparation = { enabled: true, morpho: {}, direct: {}, syncVault: {} },
} = {}) {
  const at = now()
  if (!(at instanceof Date) || !Number.isFinite(at.getTime()))
    throw Error('local_exit_v2_no_neon_clock_invalid')
  const umbrellaDeadlineMs = Math.min(deadlineMs ?? Infinity, at.getTime() + 90_000)
  const umbrellaWallDeadlineMs = Math.min(
    wallDeadlineMs ?? Infinity,
    Date.now() + Math.max(0, umbrellaDeadlineMs - at.getTime()),
  )
  if (!Number.isSafeInteger(umbrellaDeadlineMs) || !Number.isSafeInteger(umbrellaWallDeadlineMs))
    throw Error('umbrella_budget_invalid')
  const selection = selectLocalCarryExitV2NoNeonRoutes(at.getTime(), registry)
  const historicalDenominator = recordLocalCarryExitV2HistoricalDenominator({
    root,
    rotationIndex: selection.rotationIndex,
    nativeSlot: selection.slot,
    recordedAtMs: at.getTime(),
    minFreeBytes,
  })
  const sealedEpisodeSweep = await resumeLocalCarryExitV2UnfinishedSealedEpisodes({
    root,
    now,
    minFreeBytes,
  })
  const availableClients = originClients({ urls, clients, transport })
  const [verification] = configuredLocalCarryExitV2NoNeonRpcUrls(verificationUrl)
  const verificationClient =
    availableClients.length &&
    verification &&
    !availableClients.some((client) => client.url === verification)
      ? transport(verification)
      : null
  let originCount = 0
  const selectPair = async (route, choose) => {
    const pair = await selectFamilyOriginPair({
      clients: availableClients,
      verificationClient,
      verificationUrl: verification,
      route,
      slot: selection.slot,
      now,
      choose,
    })
    originCount = Math.max(originCount, [pair.primary, pair.secondary].filter(Boolean).length)
    return pair
  }
  const unprobedFamily = async (route) => {
    const pair = await selectFamilyOriginPair({
      clients: availableClients,
      verificationClient,
      verificationUrl: verification,
      route,
      slot: selection.slot,
      now,
      ...(route.routeKey === UMBRELLA_GHO_ROUTE.routeKey
        ? { callerDeadlineMs: umbrellaDeadlineMs, callerWallDeadlineMs: umbrellaWallDeadlineMs }
        : {}),
    })
    return pair
  }
  const common = { root, now, minFreeBytes }
  const morphoPersistence = createLocalCarryExitV2NoNeonPersistence({
    source: 'morpho',
    ...common,
  })
  const directPersistence = createLocalCarryExitV2NoNeonPersistence({
    source: 'direct',
    ...common,
  })
  const syncPersistence = createLocalCarryExitV2NoNeonPersistence({
    source: 'sync_vault',
    ...common,
  })

  const morpho = await resumeOrIssue({
    family: 'morpho',
    route: selection.morpho,
    persistence: morphoPersistence,
    slot: selection.slot,
    now,
    issue: async () => {
      const pair = sourcePreparation?.enabled
        ? await unprobedFamily(selection.morpho)
        : await selectPair(selection.morpho, chooseMorphoOrigin)
      if (sourcePreparation?.enabled) {
        const prepared = await prepareFamilyPrimary({
          route: selection.morpho,
          pair,
          choose: chooseMorphoOrigin,
          preparation: {
            captureBaseline: captureFreshMorphoBaseline,
            discoverCandidate: discoverMorphoIssuerCandidate,
            ...sourcePreparation.morpho,
          },
          source: 'morpho',
          now,
        })
        const primary = boundPreparedPrimary(pair, prepared.primary)
        if (!primary)
          return recordPreparationFailure(
            morphoPersistence,
            selection.morpho,
            'morpho',
            selection.slot,
            now,
            prepared.reason,
          )
        const proofPair = selectLocalCarryExitV2NoNeonOriginPair({
          clients: pair.clients,
          primary,
          verificationUrl: verification,
          verificationClient: pair.verificationClient,
        })
        originCount = Math.max(
          originCount,
          [proofPair.primary, proofPair.secondary].filter(Boolean).length,
        )
        return issueMorpho({
          ...issuerOptions(morphoPersistence),
          slot: selection.slot,
          route: selection.morpho,
          primary: proofPair.primary,
          secondary: proofPair.secondary,
          captureBaseline: async () => prepared.baseline,
          discoverCandidate: async () => prepared.candidate,
          now,
        })
      }
      return issueMorpho({
        ...issuerOptions(morphoPersistence),
        slot: selection.slot,
        route: selection.morpho,
        primary: pair.primary,
        secondary: pair.secondary,
        now,
      })
    },
  })
  const direct = await resumeOrIssue({
    family: 'direct',
    route: selection.direct,
    persistence: directPersistence,
    slot: selection.slot,
    now,
    issue: async () => {
      const pair = sourcePreparation?.enabled
        ? await unprobedFamily(selection.direct)
        : await selectPair(selection.direct, chooseDirectOrigin)
      if (sourcePreparation?.enabled) {
        const prepared = await prepareFamilyPrimary({
          route: selection.direct,
          pair,
          choose: chooseDirectOrigin,
          source: 'direct',
          preparation: {
            captureBaseline: captureFreshDirectBaseline,
            discoverCandidate: discoverDirectIssuerCandidate,
            ...sourcePreparation.direct,
          },
          now,
        })
        const primary = boundPreparedPrimary(pair, prepared.primary)
        if (!primary || !prepared.baseline || !prepared.candidate)
          return recordPreparationFailure(
            directPersistence,
            selection.direct,
            'direct',
            selection.slot,
            now,
            prepared.reason ?? 'candidate_logs_unavailable',
          )
        const proofPair = selectLocalCarryExitV2NoNeonOriginPair({
          clients: pair.clients,
          primary,
          verificationUrl: verification,
          verificationClient: pair.verificationClient,
        })
        originCount = Math.max(
          originCount,
          [proofPair.primary, proofPair.secondary].filter(Boolean).length,
        )
        return issueDirect({
          ...issuerOptions(directPersistence),
          slot: selection.slot,
          route: selection.direct,
          primary: proofPair.primary,
          secondary: proofPair.secondary,
          captureBaseline: async () => prepared.baseline,
          discoverCandidate: async () => prepared.candidate,
          now,
        })
      }
      return issueDirect({
        ...issuerOptions(directPersistence),
        slot: selection.slot,
        route: selection.direct,
        primary: pair.primary,
        secondary: pair.secondary,
        now,
      })
    },
  })
  const syncVault = await resumeOrIssue({
    family: 'sync_vault',
    route: selection.syncVault,
    persistence: syncPersistence,
    slot: selection.slot,
    now,
    issue: async () => {
      const pair = sourcePreparation?.enabled
        ? await unprobedFamily(selection.syncVault)
        : await selectPair(selection.syncVault)
      if (sourcePreparation?.enabled) {
        if (!syncVaultRouteSupport(selection.syncVault).supported)
          return issueSyncVault({
            ...issuerOptions(syncPersistence),
            slot: selection.slot,
            route: selection.syncVault,
            primary: pair.clients[0] ?? null,
            secondary: null,
            now,
          })
        const prepared = await prepareFamilyPrimary({
          route: selection.syncVault,
          pair,
          choose: sourcePreparation.syncVault?.chooseOrigin ?? selectSyncVaultOrigin,
          source: 'sync_vault',
          preparation: {
            captureBaseline: captureFreshSyncVaultBaseline,
            discoverCandidate: discoverSyncVaultIssuerCandidate,
            ...sourcePreparation.syncVault,
          },
          now,
        })
        const primary = boundPreparedPrimary(pair, prepared.primary)
        if (!primary || !prepared.baseline || !prepared.candidate)
          return recordPreparationFailure(
            syncPersistence,
            selection.syncVault,
            'sync_vault',
            selection.slot,
            now,
            prepared.reason ?? 'candidate_logs_unavailable',
          )
        const proofPair = selectLocalCarryExitV2NoNeonOriginPair({
          clients: pair.clients,
          primary,
          verificationUrl: verification,
          verificationClient: pair.verificationClient,
        })
        originCount = Math.max(
          originCount,
          [proofPair.primary, proofPair.secondary].filter(Boolean).length,
        )
        return issueSyncVault({
          ...issuerOptions(syncPersistence),
          slot: selection.slot,
          route: selection.syncVault,
          primary: proofPair.primary,
          secondary: proofPair.secondary,
          preflight: {
            primary,
            baseline: prepared.baseline,
            candidate: prepared.candidate,
          },
          deadlineMs: pair.deadlineMs,
          now,
        })
      }
      return issueSyncVault({
        ...issuerOptions(syncPersistence),
        slot: selection.slot,
        route: selection.syncVault,
        primary: pair.primary,
        secondary: pair.secondary,
        now,
      })
    },
  })

  const umbrellaResults = []
  if (selection.umbrellaGho) {
    const persistence = createLocalCarryExitV2NoNeonPersistence({
      source: 'umbrella_gho',
      ...common,
    })
    umbrellaResults.push(
      await resumeOrIssue({
        family: 'umbrella_gho',
        route: selection.umbrellaGho,
        persistence,
        slot: selection.slot,
        now,
        issue: async () => {
          const pair = await unprobedFamily(selection.umbrellaGho)
          const prepared = sourcePreparation?.enabled
            ? await prepareFamilyPrimary({
                route: selection.umbrellaGho,
                pair,
                source: 'umbrella_gho',
                now,
                choose: async (urls, _route, transport) => transport(urls[0]),
                preparation: {
                  captureBaseline: captureFreshSyncVaultBaseline,
                  discoverCandidate: discoverUmbrellaGhoV2Candidate,
                  ...sourcePreparation.umbrellaGho,
                },
              })
            : null
          if (prepared && !prepared.primary)
            return recordPreparationFailure(
              persistence,
              selection.umbrellaGho,
              'umbrella_gho',
              selection.slot,
              now,
              prepared.reason,
            )
          const primary = prepared ? boundPreparedPrimary(pair, prepared.primary) : pair.primary
          const proofPair = selectLocalCarryExitV2NoNeonOriginPair({
            clients: pair.clients,
            primary,
            verificationUrl: verification,
            verificationClient: pair.verificationClient,
          })
          return issueUmbrellaGho({
            ...issuerOptions(persistence),
            resumeSealedEpisode: persistence.resumeSealedEpisode,
            route: selection.umbrellaGho,
            slot: selection.slot,
            primary: proofPair.primary,
            secondary: proofPair.secondary,
            ...(prepared
              ? {
                  captureBaseline: async () => prepared.baseline,
                  discoverCandidate: async () => prepared.candidate,
                }
              : {}),
            deadlineMs: pair.deadlineMs,
            rpcBudget: pair.budget,
            now,
          })
        },
      }),
    )
  }
  return {
    status: 'local_issue_tick_complete',
    slot: selection.slot,
    rotationIndex: selection.rotationIndex,
    routeCounts: selection.routeCounts,
    registryRouteCounts: selection.routeCounts,
    historicalDenominator,
    historicalDenominatorCounts: historicalDenominator.counts,
    sealedEpisodeSweep,
    results: [morpho, direct, syncVault, ...umbrellaResults],
    originCount,
    authoritativeStore: 'local_carry_exit_v2',
    databaseUsed: false,
    sqlBatchIdsUsed: false,
    databaseTimestampUsed: false,
    localOperatorClockOnly: true,
    independentTimestamp: false,
    externalMonotonicCheckpoint: false,
    rollbackProof: false,
    minedPayoutProven: false,
    holderExecutableExit: false,
    prospectiveValidated: false,
    forecastValidated: false,
  }
}

function verificationSummary(root) {
  const state = verifyLocalCarryExitV2Ledger({ root })
  return {
    status: 'verified_local_chain',
    records: state.records.length,
    attempts: state.attempts.size,
    issues: state.issues.size,
    headSha256: state.head?.lastSha256 ?? null,
    authoritativeStore: 'local_carry_exit_v2',
    databaseUsed: false,
  }
}

async function cli() {
  const [mode = '--tick'] = process.argv.slice(2)
  if (!['--tick', '--dry-run', '--verify'].includes(mode) || process.argv.length > 3)
    throw Error('local_exit_v2_no_neon_usage')
  if (mode === '--verify') {
    process.stdout.write(`${JSON.stringify(verificationSummary(LOCAL_CARRY_EXIT_V2_ROOT))}\n`)
    return
  }
  if (mode === '--dry-run') {
    const roster = localCarryExitV2NoNeonRoster()
    process.stdout.write(
      `${JSON.stringify({
        status: 'dry_run',
        rosterSha256: hashLocalCarryExitV2Json(
          [...roster.morpho, ...roster.direct, ...roster.syncVault, ...roster.umbrellaGho].map(
            routeIdentity,
          ),
        ),
        routeCounts: {
          morpho: roster.morpho.length,
          direct: roster.direct.length,
          syncVault: roster.syncVault.length,
          umbrellaGho: roster.umbrellaGho.length,
        },
        historicalDenominatorCounts: historicalDenominatorCounts(),
        unsupported: roster.syncVault
          .filter((route) => !syncVaultRouteSupport(route).supported)
          .map((route) => ({
            routeKey: route.routeKey,
            reason: syncVaultRouteSupport(route).reason,
          })),
        databaseRequired: false,
      })}\n`,
    )
    return
  }
  const { get } = readEnv()
  const rawUrls =
    process.env.CARRY_EXIT_V2_RPC_URLS ||
    process.env.RECORDER_RPC_URLS ||
    process.env.RECORDER_RPC_URL ||
    get('CARRY_EXIT_V2_RPC_URLS') ||
    get('RECORDER_RPC_URLS') ||
    get('RECORDER_RPC_URL') ||
    ''
  const verificationUrl =
    process.env.CARRY_EXIT_V2_VERIFY_RPC_URL ||
    get('CARRY_EXIT_V2_VERIFY_RPC_URL') ||
    VERIFY_RPC_FALLBACK
  const urls = configuredLocalCarryExitV2NoNeonRpcUrls(rawUrls)
  const result = await runLocalCarryExitV2NoNeonIssueTick({ urls, verificationUrl })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch(() => {
    process.stderr.write('local_exit_v2_no_neon_issue_failed\n')
    process.exitCode = 1
  })
}
