#!/usr/bin/env node
// Bounded daily archive of historical on-chain exit quotes. This ledger is
// separate from the live hourly depth recorder and never edits its append order.
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { getHeapStatistics } from 'node:v8'
import { setTimeout as delay } from 'node:timers/promises'
import { createPublicClient, custom, defineChain, keccak256 } from 'viem'
import { readEnv, loadConfig } from '../lib/venue-reads.mjs'
import { COST_LEVELS_PCT, readMarketCurve, readVenueNav } from '../lib/depthCurve.mjs'
import { depthRouteIdentity } from '../lib/depth-identity.mjs'
import {
  appendHistoricalQuoteAttempt,
  HISTORICAL_DEPTH_QUOTE_ROOT,
  listHistoricalQuoteAttempts,
  listHistoricalQuoteRosters,
  appendHistoricalQuoteAnchorFailure,
  appendHistoricalQuoteSetupFailure,
  acquireHistoricalQuoteWriterLock,
  readHistoricalQuoteAnchorFailures,
  readHistoricalQuoteAnchor,
  readHistoricalQuoteAttempts,
  resolveHistoricalQuoteCaptures,
  validateHistoricalQuoteCapture,
  historicalQuoteCaptureSha256,
  encodeHistoricalQuoteCapture,
  decodeHistoricalQuoteCapture,
  MAX_HISTORICAL_QUOTE_CAPTURE_BYTES,
  readHistoricalQuoteRoster,
  readHistoricalQuoteSetupFailures,
  sealHistoricalQuoteRoster,
  writeHistoricalQuoteAnchor,
  writeHistoricalQuoteRoster,
  isValidHistoricalQuoteHeaderProjection,
  isValidHistoricalQuoteBlockHeader,
  assertHistoricalQuoteWriteCapacity,
  MAX_HISTORICAL_QUOTE_ATTEMPTS_PER_SLOT,
} from '../lib/historicalDepthQuoteStore.mjs'

export const REQUIRED_RESERVED_RECORDS = 3
const venueSlotEligible = (attempts) =>
  attempts + REQUIRED_RESERVED_RECORDS <= MAX_HISTORICAL_QUOTE_ATTEMPTS_PER_SLOT

export const MAX_TICK_MS = 150_000
export const MAX_RPC_STARTS = 1_024
export const HTTP_TIMEOUT_MS = 10_000
export const MAX_RPC_RESPONSE_BYTES = 1024 * 1024
export const RPC_START_INTERVAL_MS = 250
export const MAX_HISTORY_DAYS = 120
export const MAX_ARCHIVE_CODE_ADDRESSES = 16
export const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
export const EIP1967_BEACON_SLOT =
  '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const ROOT = resolve('data/research/venue-signals/historical-depth-quotes')
const mainnet = defineChain({
  id: 1,
  name: 'Ethereum',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [] } },
})
const sha = (value) => createHash('sha256').update(value).digest('hex')
const iso = (ms) => new Date(ms).toISOString()

function typed(reason) {
  const error = new Error(`historical_depth_quote_${reason}`)
  error.reason = reason
  return error
}

function failureReason(error, fallback) {
  // viem wraps transport errors; recover our bounded typed reason through causes.
  for (let depth = 0; error && depth < 8; depth += 1, error = error.cause)
    if (typeof error.reason === 'string') return error.reason
  return fallback
}

export function parseProviderPool(raw) {
  if (typeof raw !== 'string') throw typed('provider_url_invalid')
  const urls = String(raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  const providers = urls.map((value) => {
    let url
    try {
      url = new URL(value)
    } catch {
      throw typed('provider_url_invalid')
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw typed('provider_url_invalid')
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (!host || host.endsWith('.')) throw typed('provider_url_invalid')
    return {
      url: value,
      host,
      uriSha256: sha(value),
    }
  })
  if (providers.length < 2) throw typed('two_archive_hosts_required')
  return providers
}

export function parseProviderUrls(raw) {
  const providers = parseProviderPool(raw).slice(0, 2)
  if (providers[0].host === providers[1].host) throw typed('archive_hosts_not_distinct')
  return providers
}

export function resolveProviderPolicy(pool, policy) {
  const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected.sort())
  if (!keys(policy, ['schema', 'policyId', 'status', 'providers']) ||
      policy.schema !== 'historical_depth_quote_provider_policy_v1' ||
      !['pending', 'active'].includes(policy.status) ||
      typeof policy.policyId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(policy.policyId) ||
      !Array.isArray(policy.providers) || policy.providers.length !== 2) throw typed('provider_policy_invalid')
  const selected = policy.providers.map((binding) => {
    if (!keys(binding, ['alias', 'hostSha256', 'uriSha256']) ||
        typeof binding.alias !== 'string' || !/^C[1-9][0-9]?$/.test(binding.alias) ||
        ![binding.hostSha256, binding.uriSha256].every((s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)))
      throw typed('provider_policy_invalid')
    const matches = pool.filter((p) => p.uriSha256 === binding.uriSha256 && sha(p.host) === binding.hostSha256)
    if (matches.length !== 1 || new URL(matches[0].url).protocol !== 'https:') throw typed('provider_policy_binding_missing')
    return matches[0]
  })
  if (selected[0].host === selected[1].host || selected[0].uriSha256 === selected[1].uriSha256 ||
      policy.providers[0].alias === policy.providers[1].alias) throw typed('provider_policy_not_distinct')
  return selected
}

function safeVenue(venue) {
  const markets = (venue.depthMarkets ?? []).filter((market) => market.enabled)
  return {
    name: venue.name,
    kind: venue.kind,
    address: venue.address,
    underlying: venue.underlying,
    decimals: venue.decimals,
    markets: markets.map((market) => ({
      enabled: true,
      ...Object.fromEntries(
        [
          'name',
          'kind',
          'address',
          'token0',
          'token1',
          'exitFrom',
          'wrapper',
          'buffer',
          'bufferToken',
        ]
          .filter((key) => market[key] !== undefined)
          .map((key) => [key, market[key]]),
      ),
    })),
    configIdentity: sha(
      JSON.stringify({
        name: venue.name,
        kind: venue.kind,
        address: venue.address?.toLowerCase(),
        underlying: venue.underlying?.toLowerCase(),
        decimals: venue.decimals,
        markets: markets.map((market) => depthRouteIdentity(venue, market)),
      }),
    ),
    marketIdentities: Object.fromEntries(
      markets.map((market) => [market.name, depthRouteIdentity(venue, market)]),
    ),
  }
}

export function dailyUtcAnchors(now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  return Array.from({ length: MAX_HISTORY_DAYS }, (_, index) => {
    const date = new Date(today.getTime() - (MAX_HISTORY_DAYS - 1 - index) * 86_400_000)
    return date.toISOString().slice(0, 10)
  })
}

export function buildRoster({ venues, providers, now = new Date() }) {
  const selected = venues.filter(
    (venue) => ['sUSDe', 'sUSDS', 'scrvUSD'].includes(venue.name) && venue.enabled,
  )
  if (selected.length !== 3) throw typed('configured_venue_set_mismatch')
  const roster = sealHistoricalQuoteRoster({
    createdAtUtc: now.toISOString(),
    anchors: dailyUtcAnchors(now),
    venues: selected.map(safeVenue),
    providers: providers.map(({ host, uriSha256 }) => ({ host, uriSha256 })),
  })
  return roster
}

function samePlan(roster, plan) {
  return (
    JSON.stringify(roster.venues) === JSON.stringify(plan.record.venues) &&
    JSON.stringify(roster.providers) === JSON.stringify(plan.record.providers)
  )
}

export function createSharedBudget({
  now = () => Date.now(),
  deadlineMs = MAX_TICK_MS,
  maxStarts = MAX_RPC_STARTS,
  ownership,
}) {
  const endAt = now() + deadlineMs
  return {
    starts: 0,
    endAt,
    terminal: null,
    ownership,
    signal: ownership?.signal,
    assertOwned() {
      this.ownership?.assertHeld?.()
    },
    assertAlive() {
      if (this.terminal) throw this.terminal
      this.assertOwned()
      if (now() >= endAt) {
        this.terminal = typed('deadline_elapsed')
        throw this.terminal
      }
      if (this.starts >= maxStarts) {
        this.terminal = typed('rpc_start_cap')
        throw this.terminal
      }
    },
    started() {
      this.assertAlive()
      this.starts += 1
    },
    afterCall() {
      this.assertOwned()
      if (now() >= endAt) {
        this.terminal = typed('deadline_elapsed')
        throw this.terminal
      }
    },
  }
}

export function makeRpcProvider(
  provider,
  budget,
  { fetchImpl = fetch, now = () => Date.now(), projectBlockHeaders = false,
    requestIntervalMs = RPC_START_INTERVAL_MS,
    waitImpl = (ms, signal) => delay(ms, undefined, { signal }),
  } = {},
) {
  if (!Number.isSafeInteger(requestIntervalMs) || requestIntervalMs < 0 || requestIntervalMs > 1000)
    throw typed('rpc_start_interval_invalid')
  const trace = []
  let requestId = 0
  let pending = Promise.resolve()
  let nextStartAt = 0
  let providerFailure = null
  const chain = { ...mainnet, rpcUrls: { default: { http: [provider.url] } } }
  const transport = custom(
    {
      request: async ({ method, params }) => {
        const previous = pending
        let release
        pending = new Promise((resolve) => { release = resolve })
        await previous
        try {
          budget.assertAlive()
          if (providerFailure) throw providerFailure
          const waitMs = Math.max(0, nextStartAt - now())
          if (waitMs) {
            if (now() + waitMs >= budget.endAt) {
              budget.terminal = typed('deadline_elapsed')
              throw budget.terminal
            }
            await waitImpl(waitMs, budget.signal)
            budget.assertAlive()
            if (providerFailure) throw providerFailure
          }
          budget.started()
          nextStartAt = now() + requestIntervalMs
          const id = ++requestId
          const request = { jsonrpc: '2.0', id, method, params: params ?? [] }
          const entry = { request, response: null }
          trace.push(entry)
          try {
            const remaining = budget.endAt - now()
            const timeout = Math.max(1, Math.min(HTTP_TIMEOUT_MS, remaining))
            const response = await fetchImpl(provider.url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(request),
              signal: budget.signal
                ? AbortSignal.any([AbortSignal.timeout(timeout), budget.signal])
                : AbortSignal.timeout(timeout),
            })
            if (!response.ok) {
              if (response.status === 429) providerFailure = typed('http_429')
              throw providerFailure ?? typed(`http_${response.status}`)
            }
            const responseText = await response.text()
            if (projectBlockHeaders) {
              entry.evidenceType = 'response_commitment_only'
              entry.fullResponseSha256 = sha(responseText)
              entry.fullResponseBytes = Buffer.byteLength(responseText)
            }
            if (Buffer.byteLength(responseText) > MAX_RPC_RESPONSE_BYTES)
              throw typed('rpc_response_size_limit')
            let payload
            try {
              payload = JSON.parse(responseText)
            } catch {
              entry.invalidResponseText = responseText.slice(0, 16 * 1024)
              throw typed('rpc_envelope_invalid')
            }
            if (!projectBlockHeaders) entry.response = payload
            if (!payload || typeof payload !== 'object' || Array.isArray(payload))
              throw typed('rpc_envelope_invalid')
            const hasResult = Object.hasOwn(payload, 'result')
            const hasError = Object.hasOwn(payload, 'error')
            if (
              payload?.jsonrpc !== '2.0' ||
              payload.id !== id ||
              hasResult === hasError ||
              (hasError &&
                (!payload.error ||
                  !Number.isInteger(payload.error.code) ||
                  typeof payload.error.message !== 'string'))
            )
              throw typed('rpc_envelope_invalid')
            if (hasError) {
              if (projectBlockHeaders) {
                entry.evidenceType = 'rpc_error_envelope_v1'
                entry.response = payload
              }
              if (payload.error.code === -32603 && payload.error.message === 'Internal error' &&
                JSON.stringify(Object.keys(payload.error).sort()) === JSON.stringify(['code', 'message']) &&
                JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(['error', 'id', 'jsonrpc']))
                providerFailure = typed('provider_rpc_internal_error')
              throw providerFailure ?? typed('provider_rpc_error')
            }
            if (projectBlockHeaders) {
              if (method !== 'eth_getBlockByNumber' || request.params[1] !== false)
                throw typed('anchor_header_request_invalid')
              entry.evidenceType = 'block_header_projection_v1'
              entry.response = {
                jsonrpc: payload.jsonrpc,
                id: payload.id,
                result: Object.fromEntries(
                  ['number', 'hash', 'parentHash', 'timestamp'].map((key) => [key, payload.result?.[key]]),
                ),
              }
              if (!isValidHistoricalQuoteHeaderProjection(entry)) {
                entry.evidenceType = 'response_commitment_only'
                entry.response = null
                throw typed('anchor_header_projection_invalid')
              }
            }
            budget.afterCall()
            return payload.result
          } catch (error) {
            if (!entry.response && !entry.invalidResponseText) {
              entry.transportError ??= {
                message: String(error?.message ?? 'provider_request_failed').slice(0, 256),
              }
            }
            try {
              budget.afterCall()
            } catch (deadlineError) {
              throw deadlineError
            }
            if (error?.reason) throw error
            const wrapped = typed(
              error?.name === 'TimeoutError' ? 'provider_timeout' : 'provider_unavailable',
            )
            wrapped.cause = error
            throw wrapped
          }
        } finally { release() }
      },
    },
    { retryCount: 0 },
  )
  return {
    id: provider.host,
    uriSha256: provider.uriSha256,
    client: createPublicClient({ chain, transport, retryCount: 0 }),
    trace,
    get terminalReason() { return providerFailure?.reason ?? null },
  }
}

function isoBlockTime(seconds) {
  return iso(Number(seconds) * 1000)
}

export async function resolveUtcAnchor(provider, day, budget) {
  const targetAtUtc = `${day}T00:00:00.000Z`
  const targetSeconds = Math.floor(Date.parse(targetAtUtc) / 1000)
  const head = await provider.client.getBlock({ blockTag: 'finalized' })
  if (!head?.number || !head.hash || !head.timestamp) throw typed('archive_head_unavailable')
  if (Number(head.timestamp) <= targetSeconds) throw typed('archive_anchor_not_yet_available')
  let low = head.number > 1_100_000n ? head.number - 1_100_000n : 1n
  let lower = await provider.client.getBlock({ blockNumber: low })
  if (!lower?.timestamp || Number(lower.timestamp) > targetSeconds)
    throw typed('archive_window_pruned')
  let high = head.number
  while (high - low > 1n) {
    budget.assertAlive()
    const mid = (high + low) / 2n
    const candidate = await provider.client.getBlock({ blockNumber: mid })
    if (!candidate?.timestamp) throw typed('archive_header_unavailable')
    if (Number(candidate.timestamp) <= targetSeconds) {
      low = mid
      lower = candidate
    } else high = mid
  }
  budget.assertAlive()
  if (!lower?.hash || Number(lower.timestamp) > targetSeconds)
    throw typed('archive_anchor_unavailable')
  const anchor = {
    day,
    targetAtUtc,
    selectedProviderId: provider.id,
    block: low.toString(),
    blockHash: lower.hash.toLowerCase(),
    blockTimeUtc: isoBlockTime(lower.timestamp),
    offsetSeconds: targetSeconds - Number(lower.timestamp),
    ...(provider.trace.some((entry) => entry.evidenceType === 'block_header_projection_v1')
      ? { headerEvidenceType: 'block_header_projection_v1' } : {}),
    headerEvidence: provider.trace,
  }
  if (!anchorSearchMatches(anchor, true) ||
    !sourceHeaderMatches(anchor.headerEvidence, anchor.block, anchor.blockHash, anchor.blockTimeUtc, 1, true))
    throw typed('anchor_header_search_invalid')
  return anchor
}

export function codeAddresses(venue) {
  const all = new Set([venue.address, venue.underlying])
  for (const market of venue.depthMarkets ?? []) {
    for (const value of [
      market.address,
      market.token0,
      market.token1,
      market.wrapper,
      // A PSM pocket holds tokens and need not execute code. Its identity and
      // balance remain bound by pinned pocket()/balanceOf() calls in the quote.
      market.kind === 'psm-buffer' ? undefined : market.buffer,
      market.bufferToken,
    ])
      if (value && ADDRESS.test(value)) all.add(value)
  }
  const result = [...all].map((address) => address.toLowerCase()).sort()
  if (result.length > MAX_ARCHIVE_CODE_ADDRESSES) throw typed('code_identity_count')
  return result
}

function storageAddress(value) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value ?? '')) throw typed('proxy_storage_invalid')
  const address = `0x${value.slice(-40)}`.toLowerCase()
  return /^0x0{40}$/.test(address) ? null : address
}

function resultAddress(value) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value ?? '')) throw typed('beacon_implementation_invalid')
  const address = `0x${value.slice(-40)}`.toLowerCase()
  if (/^0x0{40}$/.test(address)) throw typed('beacon_implementation_invalid')
  return address
}

async function recordCode(provider, address, blockNumber, code, codeBytes) {
  if (code[address]) return
  const bytecode = await provider.client.getCode({ address, blockNumber })
  if (!bytecode || bytecode === '0x') throw typed('referent_code_absent')
  codeBytes.set(address, bytecode)
  code[address] = { keccak256: keccak256(bytecode) }
}

export async function captureProvider(provider, venue, frozenVenue, anchor, budget) {
  const startedAtUtc = new Date().toISOString()
  const sourceNumber = BigInt(anchor.block)
  let output = null
  let reason = null
  const code = {}
  const codeBytes = new Map()
  const beaconImplementations = new Map()
  try {
    const before = await provider.client.getBlock({ blockNumber: sourceNumber })
    if (
      before?.hash?.toLowerCase() !== anchor.blockHash ||
      isoBlockTime(before.timestamp) !== anchor.blockTimeUtc
    )
      throw typed('source_header_mismatch')
    const configuredAddresses = codeAddresses(venue)
    for (const address of configuredAddresses) {
      let bytecode = codeBytes.get(address)
      if (!bytecode) {
        bytecode = await provider.client.getCode({ address, blockNumber: sourceNumber })
        codeBytes.set(address, bytecode)
        code[address] = { keccak256: bytecode ? keccak256(bytecode) : '' }
      }
      if (!bytecode || bytecode === '0x') throw typed('predeployment_code_absent')
      const [implementationSlot, beaconSlot] = await Promise.all([
        provider.client.getStorageAt({
          address,
          slot: EIP1967_IMPLEMENTATION_SLOT,
          blockNumber: sourceNumber,
        }),
        provider.client.getStorageAt({
          address,
          slot: EIP1967_BEACON_SLOT,
          blockNumber: sourceNumber,
        }),
      ])
      code[address] = {
        keccak256: keccak256(bytecode),
        eip1967Implementation: implementationSlot,
        eip1967Beacon: beaconSlot,
      }
      const implementation = storageAddress(implementationSlot)
      const beacon = storageAddress(beaconSlot)
      if (implementation) await recordCode(provider, implementation, sourceNumber, code, codeBytes)
      if (beacon) {
        await recordCode(provider, beacon, sourceNumber, code, codeBytes)
        let beaconImplementation = beaconImplementations.get(beacon)
        if (!beaconImplementation) {
          const beaconCall = await provider.client.call({
            to: beacon,
            data: '0x5c60da1b',
            blockNumber: sourceNumber,
          })
          beaconImplementation = resultAddress(beaconCall.data)
          beaconImplementations.set(beacon, beaconImplementation)
          await recordCode(provider, beaconImplementation, sourceNumber, code, codeBytes)
        }
        code[address].beaconImplementation = beaconImplementation
      }
    }
    const nav = await readVenueNav(provider.client, venue, sourceNumber)
    if (!nav) throw typed('venue_nav_unavailable')
    const markets = []
    for (const market of venue.depthMarkets.filter((entry) => entry.enabled)) {
      const result = await readMarketCurve(provider.client, venue, market, sourceNumber, nav)
      if (result.error)
        throw typed(
          /coins|configured|exitFrom|reader/.test(result.error)
            ? 'route_config_mismatch'
            : 'quote_unavailable',
        )
      if (
        !Array.isArray(result.points) ||
        result.points.length !== COST_LEVELS_PCT.length ||
        result.points.some(
          (point, index) =>
            point.costPct !== COST_LEVELS_PCT[index] ||
            !Number.isFinite(point.capacityUsd) ||
            point.capacityUsd < 0,
        )
      )
        throw typed('quote_output_incomplete')
      markets.push({
        market: market.name,
        configIdentity: depthRouteIdentity(venue, market),
        points: result.points,
        meta: result.meta,
      })
    }
    const after = await provider.client.getBlock({ blockNumber: sourceNumber })
    if (
      after?.hash?.toLowerCase() !== anchor.blockHash ||
      isoBlockTime(after.timestamp) !== anchor.blockTimeUtc
    )
      throw typed('source_header_changed')
    budget.assertAlive()
    output = { nav, markets }
  } catch (error) {
    reason = provider.terminalReason ?? failureReason(error, 'provider_unavailable')
    if (budget.terminal) reason = budget.terminal.reason
  }
  return {
    host: provider.id,
    uriSha256: provider.uriSha256,
    startedAtUtc,
    completedAtUtc: new Date().toISOString(),
    code,
    output,
    reason,
    rawRpcTrace: provider.trace,
  }
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function currentPlan({ now = new Date(), venues = loadConfig(), providers }) {
  return buildRoster({ now, venues, providers })
}

export function readProviderPolicy() {
  return JSON.parse(readFileSync(new URL('./carry-depth-quote-provider-policy.json', import.meta.url), 'utf8'))
}

export function configuredProviders(env = null, policy = null) {
  let values = env
  if (!values) {
    try {
      values = readEnv()
    } catch {
      values = { get: () => undefined }
    }
  }
  const raw = values.get('RECORDER_RPC_URLS') ||
      values.get('RECORDER_RPC_URL') ||
      process.env.RECORDER_RPC_URLS ||
      process.env.RECORDER_RPC_URL
  const configuredPolicy = policy ?? readProviderPolicy()
  // Pending enrollment never changes the native default pair.
  if (policy === null && configuredPolicy.status === 'pending') return parseProviderUrls(raw)
  return resolveProviderPolicy(parseProviderPool(raw), configuredPolicy)
}

export async function enrollHistoricalQuoteProviderPolicy({ sourceRosterId, root = HISTORICAL_DEPTH_QUOTE_ROOT,
  providers = configuredProviders(null, readProviderPolicy()), venues = loadConfig(), now = () => Date.now() } = {}) {
  const release = await acquireHistoricalQuoteWriterLock(root)
  try {
    release.assertHeld()
    const source = readHistoricalQuoteRoster(sourceRosterId, { root })
    const plan = currentPlan({ now: new Date(now()), providers, venues })
    if (!sameJson(source.venues, plan.record.venues) || sameJson(source.providers, plan.record.providers) ||
        !sameJson(source.providers[0], plan.record.providers[0]))
      throw typed('provider_enrollment_identity_invalid')
    const anchors = source.anchors.filter((day) => existsSync(resolve(root, `roster-${sourceRosterId}`, 'anchors', `${day}.json`)))
      .map((day) => readHistoricalQuoteAnchor(sourceRosterId, day, { root }))
    for (const anchor of anchors) if (!anchorSearchMatches(anchor, true) || !sourceHeaderMatches(anchor.headerEvidence,
      anchor.block, anchor.blockHash, anchor.blockTimeUtc, 1, true)) throw typed('enrollment_anchor_invalid')
    assertHistoricalQuoteWriteCapacity((anchors.length + 1) * 512 * 1024, { root })
    const roster = writeHistoricalQuoteRoster({ createdAtUtc: new Date(now()).toISOString(), anchors: source.anchors,
      venues: source.venues, providers: plan.record.providers }, { root })
    for (const anchor of anchors) {
      release.assertHeld()
      writeHistoricalQuoteAnchor(roster.rosterId, anchor, { root })
    }
    return { status: 'policy_enrolled', rosterId: roster.rosterId, copiedAnchors: anchors.length }
  } finally { await release() }
}

function rosterHasWork(roster, root = ROOT) {
  const records = listHistoricalQuoteAttempts(roster.rosterId, { root })
  const attemptMap = new Map()
  for (const record of records) {
    const key = `${record.venue}:${record.anchorDay}`
    attemptMap.set(key, (attemptMap.get(key) ?? 0) + 1)
  }
  for (const day of roster.anchors) {
    let anchorAvailable = true
    try {
      readHistoricalQuoteAnchor(roster.rosterId, day, { root })
    } catch {
      anchorAvailable = false
    }
    if (!anchorAvailable) {
      if (readHistoricalQuoteAnchorFailures(roster.rosterId, day, { root }).length < MAX_HISTORICAL_QUOTE_ATTEMPTS_PER_SLOT) return true
      continue
    }
    for (const venue of roster.venues) {
      const attempts = attemptMap.get(`${venue.name}:${day}`) ?? 0
      const completed = records.some(
        (record) =>
          record.venue === venue.name && record.anchorDay === day && record.status === 'verified',
      )
      if (!completed && venueSlotEligible(attempts)) return true
    }
  }
  return false
}

export function findOrCreateRoster(plan, root = ROOT) {
  const compatible = listHistoricalQuoteRosters({ root })
    .map((id) => readHistoricalQuoteRoster(id, { root }))
    .filter((roster) => samePlan(roster, plan) && rosterHasWork(roster, root))
    .sort((left, right) => right.createdAtUtc.localeCompare(left.createdAtUtc))
  if (compatible.length) return compatible[0]
  return writeHistoricalQuoteRoster(
    {
      createdAtUtc: plan.record.createdAtUtc,
      anchors: plan.record.anchors,
      venues: plan.record.venues,
      providers: plan.record.providers,
    },
    { root },
  )
}

export function estimateWorstCase(venues = loadConfig()) {
  const anchorResolutionStarts = 23 // finalized head + lower-bound probe + 21 bisection headers
  const configured = venues.filter((venue) => ['sUSDe', 'sUSDS', 'scrvUSD'].includes(venue.name))
  const details = Object.fromEntries(
    configured.map((venue) => {
      const markets = (venue.depthMarkets ?? []).filter((market) => market.enabled)
      const marketStarts = markets.reduce(
        (sum, market) => sum + (market.kind === 'psm-buffer' ? 8 : 8 + 7 * 20),
        0,
      )
      const callsPerHost = 5 + marketStarts + codeAddresses(venue).length * 7 + 2
      return [
        venue.name,
        {
          callsPerHost,
          twoHostStarts: callsPerHost * 2,
          startsIncludingAnchorResolution: callsPerHost * 2 + anchorResolutionStarts,
        },
      ]
    }),
  )
  return details
}

export function chooseNextSlot(roster, records, root = ROOT) {
  const verified = new Set(
    records
      .filter((record) => record.status === 'verified')
      .map((record) => `${record.venue}:${record.anchorDay}`),
  )
  const attempted = new Set(records.map((record) => `${record.venue}:${record.anchorDay}`))
  const missingAnchors = roster.anchors.filter((day) => {
    try {
      readHistoricalQuoteAnchor(roster.rosterId, day, { root })
      return false
    } catch {
      return true
    }
  })
  const availableDays = roster.anchors.filter((day) => {
    try {
      readHistoricalQuoteAnchor(roster.rosterId, day, { root })
      return true
    } catch {
      return false
    }
  })
  for (const day of availableDays) {
    for (const venue of roster.venues) {
      const key = `${venue.name}:${day}`
      if (!verified.has(key) && !attempted.has(key))
        return { type: 'venue', day, venue: venue.name }
    }
  }
  for (const day of missingAnchors)
    if (readHistoricalQuoteAnchorFailures(roster.rosterId, day, { root }).length === 0)
      return { type: 'anchor', day }
  const anchorRetries = missingAnchors
    .map((day) => ({
      day,
      attempts: readHistoricalQuoteAnchorFailures(roster.rosterId, day, { root }),
    }))
    .filter(({ attempts }) => attempts.length > 0 && attempts.length < MAX_HISTORICAL_QUOTE_ATTEMPTS_PER_SLOT)
    .sort((a, b) => a.attempts.length - b.attempts.length || a.day.localeCompare(b.day))
  if (anchorRetries.length) return { type: 'anchor', day: anchorRetries[0].day }
  const venueRetries = []
  for (const day of availableDays) {
    for (const venue of roster.venues) {
      const key = `${venue.name}:${day}`
      if (verified.has(key)) continue
      const attempts = readHistoricalQuoteAttempts(roster.rosterId, venue.name, day, { root })
      if (attempts.length > 0 && venueSlotEligible(attempts.length))
        venueRetries.push({ day, venue: venue.name, attempts: attempts.length })
    }
  }
  venueRetries.sort((a, b) => a.attempts - b.attempts || a.day.localeCompare(b.day))
  if (venueRetries.length)
    return { type: 'venue', day: venueRetries[0].day, venue: venueRetries[0].venue }
  return null
}

async function runTickUnlocked({
  now = () => Date.now(),
  fetchImpl = fetch,
  root = ROOT,
  providers: injectedProviders,
  venues = loadConfig(),
  ownership,
  retrySlot,
  targetSlot,
  requestIntervalMs = RPC_START_INTERVAL_MS,
  waitImpl,
} = {}) {
  let providerUrls = injectedProviders
  if (!providerUrls) {
    try {
      providerUrls = configuredProviders()
    } catch (error) {
      const reason = error?.reason ?? 'provider_configuration_invalid'
      return {
        status: 'setup_failed',
        ...appendHistoricalQuoteSetupFailure(reason, { root, now: () => new Date(now()) }),
      }
    }
  }
  const plan = currentPlan({ now: new Date(now()), venues, providers: providerUrls })
  let roster
  if (retrySlot !== undefined && targetSlot !== undefined) throw typed('target_slot_invalid')
  const explicitSlot = targetSlot ?? retrySlot
  if (explicitSlot !== undefined) {
    const retrySlot = explicitSlot
    if (!retrySlot || typeof retrySlot !== 'object' || Array.isArray(retrySlot) ||
      JSON.stringify(Object.keys(retrySlot).sort()) !== JSON.stringify(['day', 'rosterId', 'venue']) ||
      !['rosterId', 'venue', 'day'].every((key) => typeof retrySlot[key] === 'string') ||
      !/^[0-9a-f]{64}$/.test(retrySlot.rosterId)) throw typed('retry_slot_invalid')
    roster = readHistoricalQuoteRoster(retrySlot.rosterId, { root })
    if (!samePlan(roster, plan) || !roster.anchors.includes(retrySlot.day) ||
      !roster.venues.some((venue) => venue.name === retrySlot.venue) ||
      retrySlot.day > iso(now()).slice(0, 10)) throw typed('retry_slot_invalid')
    const anchor = readHistoricalQuoteAnchor(roster.rosterId, retrySlot.day, { root })
    if (!anchorSearchMatches(anchor) || !sourceHeaderMatches(anchor.headerEvidence,
      anchor.block, anchor.blockHash, anchor.blockTimeUtc, 1, true)) throw typed('retry_anchor_invalid')
    const previous = readHistoricalQuoteAttempts(roster.rosterId, retrySlot.venue, retrySlot.day, { root })
    if ((targetSlot === undefined && !previous.length) || !venueSlotEligible(previous.length) || previous.some((attempt) => attempt.status === 'verified'))
      throw typed('retry_slot_not_failed')
  } else roster = findOrCreateRoster(plan, root)
  const records = listHistoricalQuoteAttempts(roster.rosterId, { root })
  const slot = explicitSlot === undefined ? chooseNextSlot(roster, records, root) :
    { type: 'venue', day: explicitSlot.day, venue: explicitSlot.venue }
  if (!slot) {
    const verified = records.filter((record) => record.status === 'verified').length
    const missingAnchors = roster.anchors.filter((day) => {
      try {
        readHistoricalQuoteAnchor(roster.rosterId, day, { root })
        return false
      } catch {
        return true
      }
    })
    const failures = records.length - verified
    return {
      status: verified === roster.anchors.length * roster.venues.length ? 'complete' : 'partial',
      rosterId: roster.rosterId,
      verified,
      failures,
      unresolvedAnchors: missingAnchors,
    }
  }
  if (slot.type === 'venue' && !venueSlotEligible(
    readHistoricalQuoteAttempts(roster.rosterId, slot.venue, slot.day, { root }).length,
  )) throw typed('attempt_limit')
  const budget = createSharedBudget({ now, ownership })
  const providers = providerUrls.map((provider) =>
    makeRpcProvider(provider, budget, { fetchImpl, now, projectBlockHeaders: slot.type === 'anchor', requestIntervalMs, waitImpl }),
  )
  try {
    if (slot.type === 'anchor') {
      const selected = await resolveUtcAnchor(providers[0], slot.day, budget)
      budget.assertAlive()
      const anchor = writeHistoricalQuoteAnchor(roster.rosterId, selected, { root })
      return { status: 'anchor_sealed', day: slot.day, block: anchor.block, starts: budget.starts }
    }
    const anchor = readHistoricalQuoteAnchor(roster.rosterId, slot.day, { root })
    const venueRecord = roster.venues.find((item) => item.name === slot.venue)
    const venue = { ...venueRecord, depthMarkets: venueRecord.markets }
    const previous = readHistoricalQuoteAttempts(roster.rosterId, slot.venue, slot.day, { root })
    assertHistoricalQuoteWriteCapacity(REQUIRED_RESERVED_RECORDS * 512 * 1024, { root })
    const reused = new Map()
    // Only embedded evidence can be a source: references never form a chain.
    for (const attempt of [...previous].reverse()) {
      for (const [captureIndex, stored] of (attempt.captures ?? []).entries()) {
        if (stored?.evidenceType === 'capture_reference_v1') continue
        budget.assertAlive()
        const capture = decodeHistoricalQuoteCapture(stored)
        if (!capture || capture.reason !== null || reused.has(capture.host) ||
            capture.rawEvidenceStatus !== undefined || !capture.rawRpcTrace?.length) continue
        budget.assertAlive()
        await validateCompleteHistoricalQuoteCapture(capture, attempt, roster, anchor, venueRecord)
        budget.assertAlive()
        reused.set(capture.host, { capture, reference: {
          evidenceType: 'capture_reference_v1', sourceAttemptSequence: attempt.sequence,
          sourceAttemptSha256: attempt.sha256, captureIndex,
          captureSha256: historicalQuoteCaptureSha256(capture),
        } })
      }
    }
    const captures = await Promise.all(providers.map((provider) =>
      reused.get(provider.id)?.capture ?? captureProvider(provider, venue, venueRecord, anchor, budget)))
    budget.assertAlive()
    const failures = captures.filter((capture) => capture.reason)
    let status = 'verified'
    let reason = null
    if (failures.length) {
      status = 'failed'
      reason = budget.terminal?.reason ?? failures[0].reason
    } else if (
      captures[0].host === captures[1].host ||
      captures[0].uriSha256 === captures[1].uriSha256
    ) {
      status = 'failed'
      reason = 'archive_hosts_not_distinct'
    } else if (!sameJson(captures[0].code, captures[1].code)) {
      status = 'failed'
      reason = 'provider_code_identity_mismatch'
    } else if (!sameJson(captures[0].output, captures[1].output)) {
      status = 'failed'
      reason = 'provider_output_mismatch'
    }
    // Compression cannot make an individually over-bound raw capture eligible.
    for (const capture of captures) {
      if (Buffer.byteLength(JSON.stringify(capture)) > MAX_HISTORICAL_QUOTE_CAPTURE_BYTES)
        throw typed('evidence_over_limit_individual_capture')
    }
    if (status === 'verified') {
      const receiptContext = {
        rosterId: roster.rosterId, rosterSha256: roster.sha256, anchorSha256: anchor.sha256,
        venue: slot.venue, anchorDay: slot.day, configIdentity: venueRecord.configIdentity,
        marketIdentities: venueRecord.marketIdentities, levels: COST_LEVELS_PCT,
        source: { block: anchor.block, hash: anchor.blockHash, time: anchor.blockTimeUtc },
        firstLocalReceiptAtUtc: new Date().toISOString(),
      }
      for (const capture of captures) {
        budget.assertAlive()
        await validateCompleteHistoricalQuoteCapture(capture, receiptContext, roster, anchor, venueRecord)
      }
    }
    const attemptBase = {
      rosterId: roster.rosterId, anchorDay: slot.day, venue: slot.venue,
      source: { block: anchor.block, hash: anchor.blockHash, time: anchor.blockTimeUtc, offsetSeconds: anchor.offsetSeconds },
      configIdentity: venueRecord.configIdentity, marketIdentities: venueRecord.marketIdentities,
      implementationIdentity: null, levels: COST_LEVELS_PCT,
    }
    const concreteStored = []
    for (const capture of captures) {
      budget.assertAlive()
      if (capture.reason === null) {
        if (status !== 'verified') await validateCompleteHistoricalQuoteCapture(capture, {
          ...attemptBase, rosterSha256: roster.sha256, anchorSha256: anchor.sha256,
          firstLocalReceiptAtUtc: new Date().toISOString(),
        }, roster, anchor, venueRecord)
        concreteStored.push(encodeHistoricalQuoteCapture(capture))
      } else concreteStored.push(capture)
      budget.assertAlive()
    }
    let storedCaptures = captures.map((capture, index) =>
      reused.get(capture.host)?.reference ?? concreteStored[index])
    if (Buffer.byteLength(JSON.stringify(storedCaptures)) > MAX_HISTORICAL_QUOTE_CAPTURE_BYTES) {
      for (const capture of captures.filter((capture) => capture.reason === null))
        await validateCompleteHistoricalQuoteCapture(capture, {
          ...attemptBase, rosterSha256: roster.sha256, anchorSha256: anchor.sha256,
          firstLocalReceiptAtUtc: new Date().toISOString(),
        }, roster, anchor, venueRecord)
      assertHistoricalQuoteWriteCapacity(REQUIRED_RESERVED_RECORDS * 512 * 1024, { root })
      storedCaptures = captures.map((capture, index) => {
        if (reused.has(capture.host)) return reused.get(capture.host).reference
        if (capture.reason !== null) return capture
        budget.assertAlive()
        const source = appendHistoricalQuoteAttempt(roster.rosterId, slot.venue, slot.day,
          { ...attemptBase, status: 'failed', reason: 'pair_pending', captures: [concreteStored[index]], rpcStarts: 0 }, { root })
        return { evidenceType: 'capture_reference_v1', sourceAttemptSequence: source.sequence,
          sourceAttemptSha256: source.sha256, captureIndex: 0, captureSha256: historicalQuoteCaptureSha256(capture) }
      })
      if (Buffer.byteLength(JSON.stringify(storedCaptures)) > MAX_HISTORICAL_QUOTE_CAPTURE_BYTES)
        throw typed('evidence_over_limit_individual_capture')
    }
    budget.assertAlive()
    return appendHistoricalQuoteAttempt(
      roster.rosterId,
      slot.venue,
      slot.day,
      {
        rosterId: roster.rosterId,
        anchorDay: slot.day,
        venue: slot.venue,
        status,
        reason,
        source: {
          block: anchor.block,
          hash: anchor.blockHash,
          time: anchor.blockTimeUtc,
          offsetSeconds: anchor.offsetSeconds,
        },
        configIdentity: venueRecord.configIdentity,
        marketIdentities: venueRecord.marketIdentities,
        implementationIdentity:
          status === 'verified' ? sha(JSON.stringify(captures[0].code)) : null,
        levels: COST_LEVELS_PCT,
        captures: storedCaptures,
        rpcStarts: budget.starts,
        reusedCaptures: reused.size,
      },
      { root },
    )
  } catch (error) {
    budget.assertOwned()
    const reason = failureReason(error, 'collector_failure')
    if (slot.type === 'anchor') {
      const evidence = {
        providerId: providers[0]?.id ?? null,
        evidenceType: 'anchor_header_trace_v1',
        headerEvidence: providers[0]?.trace ?? [],
      }
      return appendHistoricalQuoteAnchorFailure(
        roster.rosterId,
        slot.day,
        { reason, evidence },
        { root, now: () => new Date(now()) },
      )
    }
    return appendHistoricalQuoteAttempt(
      roster.rosterId,
      slot.venue,
      slot.day,
      {
        rosterId: roster.rosterId,
        anchorDay: slot.day,
        venue: slot.venue,
        status: 'failed',
        reason,
        source: (() => {
          const anchor = readHistoricalQuoteAnchor(roster.rosterId, slot.day, { root })
          return {
            block: anchor.block,
            hash: anchor.blockHash,
            time: anchor.blockTimeUtc,
            offsetSeconds: anchor.offsetSeconds,
          }
        })(),
        configIdentity: roster.venues.find((item) => item.name === slot.venue).configIdentity,
        marketIdentities: roster.venues.find((item) => item.name === slot.venue).marketIdentities,
        implementationIdentity: null,
        levels: COST_LEVELS_PCT,
        captures: [],
        rpcStarts: budget.starts,
      },
      { root },
    )
  }
}

export async function runTick(options = {}) {
  const root = options.root ?? HISTORICAL_DEPTH_QUOTE_ROOT
  const release = await acquireHistoricalQuoteWriterLock(root)
  try {
    release.assertHeld()
    return await runTickUnlocked({ ...options, ownership: release })
  } finally {
    await release()
  }
}

export function replayProviderCapture(capture, venue, sourceBlock) {
  const calls = capture.rawRpcTrace.filter(
    (entry) =>
      entry.request?.method === 'eth_call' &&
      String(entry.request.params?.[0]?.data ?? '').toLowerCase() !== '0x5c60da1b',
  )
  let cursor = 0
  const transport = custom(
    {
      request: async ({ method, params }) => {
        if (method !== 'eth_call') throw typed('replay_unexpected_rpc_method')
        const expected = calls[cursor++]
        if (!expected || !sameJson(expected.request.params, params))
          throw typed('replay_call_mismatch')
        if (Object.hasOwn(expected.response, 'error')) throw typed('replay_source_call_failed')
        return expected.response.result
      },
    },
    { retryCount: 0 },
  )
  const chain = { ...mainnet, rpcUrls: { default: { http: [] } } }
  const client = createPublicClient({ chain, transport, retryCount: 0 })
  return readVenueNav(client, venue, sourceBlock).then(async (nav) => {
    if (!nav) throw typed('replay_nav_unavailable')
    const markets = []
    for (const market of venue.depthMarkets.filter((entry) => entry.enabled)) {
      const result = await readMarketCurve(client, venue, market, sourceBlock, nav)
      if (result.error) throw typed('replay_quote_unavailable')
      markets.push({
        market: market.name,
        configIdentity: depthRouteIdentity(venue, market),
        points: result.points,
        meta: result.meta,
      })
    }
    if (cursor !== calls.length) throw typed('replay_trace_unused')
    return { nav, markets }
  })
}

function sourceHeaderMatches(trace, block, hash, timeUtc, minimumMatches = 1, allowProjection = false) {
  if (!validRpcTrace(trace)) return false
  if (trace.some((entry) => entry.evidenceType !== undefined &&
    (!allowProjection || !isValidHistoricalQuoteHeaderProjection(entry)))) return false
  const target = BigInt(block)
  const timestamp = BigInt(Math.floor(Date.parse(timeUtc) / 1000))
  const matches = trace.filter((entry) => {
    if (entry.request?.method !== 'eth_getBlockByNumber' || !entry.response?.result) return false
    try {
      if (BigInt(entry.request.params?.[0]) !== target || entry.request.params?.[1] !== false)
        return false
      return (
        BigInt(entry.response.result.number) === target &&
        entry.response.result.hash?.toLowerCase() === hash.toLowerCase() &&
        BigInt(entry.response.result.timestamp) === timestamp
      )
    } catch {
      return false
    }
  })
  return matches.length >= minimumMatches
}

function anchorSearchMatches(anchor, requireSearch = false) {
  const trace = anchor.headerEvidence
  if (!trace.some((entry) => entry.evidenceType !== undefined)) {
    if (!requireSearch) return true // legacy full envelopes already published
    if (!validRpcTrace(trace) || !trace.every(isValidHistoricalQuoteBlockHeader)) return false
  } else if (!trace.every(isValidHistoricalQuoteHeaderProjection)) return false
  if (trace.length < 2 ||
    trace[0].request.params[0] !== 'finalized') return false
  const target = BigInt(Math.floor(Date.parse(anchor.targetAtUtc) / 1000))
  let high = BigInt(trace[0].response.result.number)
  let low = high > 1_100_000n ? high - 1_100_000n : 1n
  if (BigInt(trace[0].response.result.timestamp) <= target ||
    BigInt(trace[1].request.params[0]) !== low ||
    BigInt(trace[1].response.result.timestamp) > target) return false
  for (const entry of trace.slice(2)) {
    if (high - low <= 1n) return false
    const mid = (high + low) / 2n
    if (BigInt(entry.request.params[0]) !== mid) return false
    if (BigInt(entry.response.result.timestamp) <= target) low = mid
    else high = mid
  }
  return high - low === 1n && low === BigInt(anchor.block)
}

function validRpcTrace(trace) {
  if (!Array.isArray(trace) || !trace.length) return false
  const ids = new Set()
  return trace.every((entry) => {
    const request = entry?.request
    const response = entry?.response
    if (
      request?.jsonrpc !== '2.0' ||
      JSON.stringify(Object.keys(request).sort()) !==
        JSON.stringify(['id', 'jsonrpc', 'method', 'params']) ||
      !Number.isSafeInteger(request.id) ||
      request.id < 1 ||
      ids.has(request.id) ||
      typeof request.method !== 'string' ||
      !Array.isArray(request.params) ||
      response?.jsonrpc !== '2.0' ||
      response.id !== request.id
    )
      return false
    ids.add(request.id)
    const hasResult = Object.hasOwn(response, 'result')
    const hasError = Object.hasOwn(response, 'error')
    const expectedKeys = hasResult ? ['id', 'jsonrpc', 'result'] : ['error', 'id', 'jsonrpc']
    return (
      hasResult !== hasError &&
      hasResult &&
      JSON.stringify(Object.keys(response).sort()) === JSON.stringify(expectedKeys)
    )
  })
}

export function codeEvidenceMatches(capture, block, venue) {
  if (!validRpcTrace(capture.rawRpcTrace) || !capture.code || typeof capture.code !== 'object')
    return false
  const expectedConfigured = codeAddresses(venue)
  const codeCalls = capture.rawRpcTrace.filter((entry) => entry.request.method === 'eth_getCode')
  const storageCalls = capture.rawRpcTrace.filter(
    (entry) => entry.request.method === 'eth_getStorageAt',
  )
  const blockTag = `0x${BigInt(block).toString(16)}`
  const callsPinned = capture.rawRpcTrace
    .filter((entry) => entry.request.method === 'eth_call')
    .every((entry) => entry.request.params?.[1] === blockTag)
  const codePinned = codeCalls.every((entry) => entry.request.params?.[1] === blockTag)
  const storagePinned = storageCalls.every((entry) => entry.request.params?.[2] === blockTag)
  if (!callsPinned || !codePinned || !storagePinned) return false
  const codeByAddress = new Map()
  for (const entry of codeCalls) {
    const address = String(entry.request.params?.[0] ?? '').toLowerCase()
    if (!ADDRESS.test(address) || codeByAddress.has(address)) return false
    codeByAddress.set(address, entry.response.result)
  }
  const storageByAddressSlot = new Map()
  for (const entry of storageCalls) {
    const address = String(entry.request.params?.[0] ?? '').toLowerCase()
    const slot = String(entry.request.params?.[1] ?? '').toLowerCase()
    const key = `${address}:${slot}`
    if (!ADDRESS.test(address) || storageByAddressSlot.has(key)) return false
    storageByAddressSlot.set(key, entry.response.result)
  }
  const requiredCode = new Set(expectedConfigured)
  const beacons = new Map()
  for (const address of expectedConfigured) {
    const implementationSlot = storageByAddressSlot.get(`${address}:${EIP1967_IMPLEMENTATION_SLOT}`)
    const beaconSlot = storageByAddressSlot.get(`${address}:${EIP1967_BEACON_SLOT}`)
    const item = capture.code[address]
    if (
      typeof implementationSlot !== 'string' ||
      typeof beaconSlot !== 'string' ||
      !item ||
      item.eip1967Implementation !== implementationSlot ||
      item.eip1967Beacon !== beaconSlot
    )
      return false
    try {
      const implementation = storageAddress(implementationSlot)
      const beacon = storageAddress(beaconSlot)
      if (implementation) requiredCode.add(implementation)
      if (beacon) {
        requiredCode.add(beacon)
        beacons.set(address, beacon)
      }
    } catch {
      return false
    }
  }
  for (const beacon of beacons.values()) {
    const matches = capture.rawRpcTrace.filter(
      (entry) =>
        entry.request.method === 'eth_call' &&
        String(entry.request.params?.[0]?.to ?? '').toLowerCase() === beacon &&
        String(entry.request.params?.[0]?.data ?? '').toLowerCase() === '0x5c60da1b' &&
        entry.request.params?.[1] === blockTag,
    )
    if (matches.length !== 1) return false
    try {
      const implementation = resultAddress(matches[0].response.result)
      requiredCode.add(implementation)
      const proxies = [...beacons]
        .filter(([, value]) => value === beacon)
        .map(([address]) => address)
      if (
        !proxies.length ||
        proxies.some((address) => capture.code[address]?.beaconImplementation !== implementation)
      )
        return false
    } catch {
      return false
    }
  }
  const addresses = Object.keys(capture.code)
    .map((address) => address.toLowerCase())
    .sort()
  const expectedAddresses = [...requiredCode].sort()
  if (
    JSON.stringify(addresses) !== JSON.stringify(expectedAddresses) ||
    codeByAddress.size !== requiredCode.size ||
    storageCalls.length !== expectedConfigured.length * 2
  )
    return false
  return [...requiredCode].every((address) => {
    const rawCode = codeByAddress.get(address)
    return (
      typeof rawCode === 'string' &&
      rawCode !== '0x' &&
      capture.code[address]?.keccak256 === keccak256(rawCode)
    )
  })
}

// Full proof validation is shared by candidate reuse and offline paired replay.
export async function validateCompleteHistoricalQuoteCapture(capture, attempt, roster, anchor, venueRecord) {
  validateHistoricalQuoteCapture(capture, attempt, roster, anchor, venueRecord)
  const venue = { ...venueRecord, depthMarkets: venueRecord.markets }
  const headers = capture.rawRpcTrace.filter((entry) => entry.request.method === 'eth_getBlockByNumber')
  if (headers.some((entry) =>
      typeof entry.request.params[0] !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/.test(entry.request.params[0]) ||
      !['number', 'timestamp'].every((key) => typeof entry.response.result?.[key] === 'string' &&
        /^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/.test(entry.response.result[key])) ||
      typeof entry.response.result?.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(entry.response.result.hash) ||
      !sourceHeaderMatches([entry], anchor.block, anchor.blockHash, anchor.blockTimeUtc, 1)) ||
      !sourceHeaderMatches(capture.rawRpcTrace, anchor.block, anchor.blockHash, anchor.blockTimeUtc, 2) ||
      !codeEvidenceMatches(capture, anchor.block, venue))
    throw typed('verified_record_raw_source_mismatch')
  const output = await replayProviderCapture(capture, venue, BigInt(anchor.block))
  if (!sameJson(output, capture.output)) throw typed('verified_record_replay_mismatch')
  return output
}

export async function verifyArchive({ root = ROOT } = {}) {
  const summary = {
    rosters: 0,
    verified: 0,
    failed: 0,
    anchorFailures: 0,
    setupFailures: readHistoricalQuoteSetupFailures({ root }).length,
    replayed: 0,
  }
  for (const rosterId of listHistoricalQuoteRosters({ root })) {
    const roster = readHistoricalQuoteRoster(rosterId, { root })
    summary.rosters += 1
    for (const day of roster.anchors) {
      summary.anchorFailures += readHistoricalQuoteAnchorFailures(rosterId, day, { root }).length
      try {
        const anchor = readHistoricalQuoteAnchor(rosterId, day, { root })
        if (
          anchor.rosterId !== rosterId ||
          anchor.day !== day ||
          !anchorSearchMatches(anchor) ||
          !sourceHeaderMatches(
            anchor.headerEvidence,
            anchor.block,
            anchor.blockHash,
            anchor.blockTimeUtc,
            1,
            true,
          )
        )
          throw typed('anchor_raw_header_mismatch')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    for (const attempt of listHistoricalQuoteAttempts(rosterId, { root })) {
      if (attempt.status !== 'verified') {
        if (['historical-depth-quote-attempt-v2', 'historical-depth-quote-attempt-v3'].includes(attempt.study)) {
          const resolved = resolveHistoricalQuoteCaptures(attempt, { root })
          const anchor = readHistoricalQuoteAnchor(rosterId, attempt.anchorDay, { root })
          const venueRecord = roster.venues.find((venue) => venue.name === attempt.venue)
          for (const [index, entry] of attempt.captures.entries()) {
            if (entry.evidenceType !== undefined)
              await validateCompleteHistoricalQuoteCapture(resolved[index], attempt, roster, anchor, venueRecord)
          }
        }
        summary.failed += 1
        continue
      }
      const captures = resolveHistoricalQuoteCaptures(attempt, { root })
      const anchor = readHistoricalQuoteAnchor(rosterId, attempt.anchorDay, { root })
      const venueRecord = roster.venues.find((item) => item.name === attempt.venue)
      const venue = { ...venueRecord, depthMarkets: venueRecord.markets }
      const outputs = await Promise.all(captures.map((capture) =>
        validateCompleteHistoricalQuoteCapture(capture, attempt, roster, anchor, venueRecord)))
      if (!sameJson(outputs[0], outputs[1])) throw typed('verified_record_replay_mismatch')
      summary.verified += 1
      summary.replayed += 1
    }
  }
  return summary
}

export function dryRun({ now = new Date(), venues = loadConfig(), providers }) {
  const plan = buildRoster({ now, venues, providers })
  return {
    rosterId: plan.rosterId,
    anchorCount: plan.record.anchors.length,
    venueCount: plan.record.venues.length,
    dailyCadenceHours: 24,
    perVenueWorstCase: estimateWorstCase(venues),
    anchorResolutionWorstCase: 23,
    maxStartsPerTick: MAX_RPC_STARTS,
    maxTickMs: MAX_TICK_MS,
    maxRecordBytes: 512 * 1024,
  }
}

async function main(args) {
  if (args.length === 4 && args[0] === '--enroll-policy' && args[2] === '--from-roster') {
    const policy = readProviderPolicy()
    if (args[1] !== policy.policyId || !/^[0-9a-f]{64}$/.test(args[3])) throw typed('provider_policy_invalid')
    console.log(JSON.stringify(await enrollHistoricalQuoteProviderPolicy({ sourceRosterId: args[3], providers: configuredProviders(null, policy) })))
    return
  }
  if (args.length !== 1 || !['--tick', '--dry-run', '--verify'].includes(args[0]))
    throw typed('usage')
  if (args[0] === '--dry-run') {
    const providers = configuredProviders()
    console.log(JSON.stringify(dryRun({ providers }), null, 2))
  } else if (args[0] === '--tick') {
    console.log(JSON.stringify(await runTick(), null, 2))
  } else {
    console.log(JSON.stringify(await verifyArchive(), null, 2))
  }
}

function assertHeapCap() {
  const requested = `${process.env.NODE_OPTIONS ?? ''} ${process.execArgv.join(' ')}`
  if (!/(^|\s)--max-old-space-size=384(\s|$)/.test(requested)) {
    throw typed('node_384mib_cap_required')
  }
  if (getHeapStatistics().heap_size_limit > 450 * 1024 * 1024)
    throw typed('node_heap_cap_not_applied')
}

async function runCli() {
  try {
    assertHeapCap()
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error?.message ?? 'historical_depth_quote_failed')
    process.exitCode = 1
  }
}

if (typeof import.meta.url === 'string' && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runCli()
}
