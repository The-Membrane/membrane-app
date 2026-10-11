// Read-only, current aggregate cash for one exact frozen Carry subject.
// This is an operator read at a common finalized block, not a sealed receipt,
// holder-executable amount, or forecast.
import {
  DIRECT_CASH_MARKETS,
  readDirectCash,
  readVaultCash,
  validateManifest,
} from '../backfill-carry-cash-archive.mjs'
import { buildSubjectManifest } from '../record-carry-cash-issues.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { createHash } from 'node:crypto'

const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const RAW = /^(0|[1-9][0-9]*)$/
const MAX_U256 = (1n << 256n) - 1n
const MAX_FINALIZED_AGE_MS = 2 * 60 * 60 * 1000
const FUTURE_CLOCK_TOLERANCE_MS = 2 * 60 * 1000
const SOURCE_KIND = 'live_read_only_two_origin_finalized'
const CACHE_TTL_MS = 5 * 60 * 1000
const CACHE_MAX_SUBJECTS = 67
const availableCache = new Map()
const pendingReads = new Map()

const unavailable = (reason) => ({ status: 'unavailable', reason })

function sourceAgePolicy(value) {
  const age = value === undefined ? MAX_FINALIZED_AGE_MS : value
  return typeof age === 'number' &&
    Number.isSafeInteger(age) &&
    age > 0 &&
    age <= MAX_FINALIZED_AGE_MS
    ? age
    : null
}

function hostOf(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password)
      return null
    const host = parsed.hostname
      .toLowerCase()
      .replace(/\.$/, '')
      .replace(/^www\./, '')
    if (/^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/.test(host)) return null
    return host
  } catch {
    return null
  }
}

function validOrigins(origins) {
  if (!Array.isArray(origins) || origins.length !== 2) return false
  const hosts = origins.map((origin) => hostOf(origin?.url))
  return hosts.every(Boolean) && hosts[0] !== hosts[1] && origins.every((origin) => origin.client)
}

function header(block) {
  if (
    typeof block?.number !== 'bigint' ||
    block.number < 1n ||
    typeof block.hash !== 'string' ||
    !HASH.test(block.hash.toLowerCase()) ||
    typeof block.timestamp !== 'bigint' ||
    block.timestamp < 1n
  )
    return null
  const milliseconds = Number(block.timestamp) * 1000
  if (!Number.isSafeInteger(milliseconds)) return null
  const at = new Date(milliseconds).toISOString()
  return { number: block.number, hash: block.hash.toLowerCase(), timestamp: block.timestamp, at }
}

function sameHeader(left, right) {
  return (
    left !== null &&
    right !== null &&
    left.number === right.number &&
    left.hash === right.hash &&
    left.timestamp === right.timestamp
  )
}

function freshCached(snapshot, nowMs, maxSourceAgeMs) {
  const readAgeMs = nowMs - Date.parse(snapshot.readAtUtc)
  const blockAgeMs = nowMs - Date.parse(snapshot.blockAt)
  return (
    Number.isSafeInteger(nowMs) &&
    Number.isSafeInteger(readAgeMs) &&
    Number.isSafeInteger(blockAgeMs) &&
    readAgeMs >= -FUTURE_CLOCK_TOLERANCE_MS &&
    readAgeMs <= CACHE_TTL_MS &&
    blockAgeMs >= -FUTURE_CLOCK_TOLERANCE_MS &&
    blockAgeMs <= maxSourceAgeMs
  )
}

function validCash(state, subject) {
  if (
    state?.state !== 'observed' ||
    typeof state.asset !== 'string' ||
    state.asset.toLowerCase() !== subject.asset ||
    !Number.isInteger(state.assetDecimals) ||
    state.assetDecimals < 0 ||
    state.assetDecimals > 255 ||
    !Number.isInteger(state.shareDecimals) ||
    state.shareDecimals < 0 ||
    state.shareDecimals > 255 ||
    typeof state.cashRaw !== 'string' ||
    !RAW.test(state.cashRaw)
  )
    return false
  try {
    return BigInt(state.cashRaw) <= MAX_U256
  } catch {
    return false
  }
}

function selectSubject(manifest, query) {
  const byKey = validateManifest(manifest)
  if (
    typeof query?.routeKey !== 'string' ||
    typeof query?.destination !== 'string' ||
    !ADDRESS.test(query.destination.toLowerCase())
  )
    return null
  const destination = query.destination.toLowerCase()
  const subject = byKey.get(`${query.routeKey}\0${destination}`)
  if (!subject || (query.asset !== undefined && query.asset?.toLowerCase() !== subject.asset))
    return null
  return subject
}

/**
 * One bounded live read. Both origins must be distinct configured HTTPS hosts.
 * The lower finalized head is already finalized on both origins; state and
 * after-read headers are pinned to its exact block number.
 */
export async function readLiveCurrentCash(
  query,
  {
    origins,
    manifest,
    clock = Date.now,
    readVault = readVaultCash,
    readDirect = readDirectCash,
    maxSourceAgeMs,
  } = {},
) {
  const sourceAgeMs = sourceAgePolicy(maxSourceAgeMs)
  if (sourceAgeMs === null) return unavailable('source_age_policy_invalid')
  if (!validOrigins(origins)) return unavailable('rpc_origins_unavailable')
  let subject
  try {
    subject = selectSubject(manifest ?? (await buildSubjectManifest()), query)
  } catch {
    return unavailable('subject_manifest_unavailable')
  }
  if (!subject) return unavailable('subject_not_frozen')

  let heads
  try {
    heads = await Promise.all(
      origins.map(async ({ client }) => {
        if ((await client.getChainId()) !== 1) return { chainId: false }
        return { chainId: true, head: header(await client.getBlock({ blockTag: 'finalized' })) }
      }),
    )
  } catch {
    return unavailable('finalized_head_unavailable')
  }
  if (heads.some((origin) => !origin.chainId)) return unavailable('wrong_chain')
  if (heads.some((origin) => !origin.head)) return unavailable('invalid_finalized_header')
  const blockNumber =
    heads[0].head.number < heads[1].head.number ? heads[0].head.number : heads[1].head.number

  let pinned
  try {
    pinned = await Promise.all(
      origins.map(({ client }) => client.getBlock({ blockNumber }).then(header)),
    )
  } catch {
    return unavailable('pinned_header_unavailable')
  }
  if (!sameHeader(pinned[0], pinned[1]) || pinned[0].number !== blockNumber)
    return unavailable('finalized_block_disagreement')
  for (let i = 0; i < 2; i++) {
    if (heads[i].head.number === blockNumber && !sameHeader(heads[i].head, pinned[i]))
      return unavailable('finalized_block_disagreement')
  }

  const market =
    subject.source_kind === 'market'
      ? DIRECT_CASH_MARKETS.find(
          (entry) =>
            entry.routeKey === subject.route_key &&
            entry.destination.toLowerCase() === subject.destination &&
            entry.underlying.toLowerCase() === subject.asset &&
            entry.venueKind === subject.venue_kind,
        )
      : null
  if (subject.source_kind === 'market' && !market) return unavailable('market_config_mismatch')

  let states
  try {
    states = await Promise.all(
      origins.map(({ client }) =>
        market
          ? readDirect(client, market, blockNumber)
          : readVault(client, subject.destination, blockNumber),
      ),
    )
  } catch {
    return unavailable('cash_state_unavailable')
  }
  if (states.some((state) => state?.state === 'identity_mismatch'))
    return unavailable('cash_identity_mismatch')
  if (states.some((state) => state?.state !== 'observed'))
    return unavailable('cash_state_unavailable')
  if (states.some((state) => !validCash(state, subject)))
    return unavailable('cash_identity_mismatch')
  if (
    states[0].cashRaw !== states[1].cashRaw ||
    states[0].assetDecimals !== states[1].assetDecimals ||
    states[0].shareDecimals !== states[1].shareDecimals ||
    (market &&
      (states[0].assetDecimals !== market.decimals || states[0].shareDecimals !== market.decimals))
  )
    return unavailable('cash_origin_disagreement')

  let after
  try {
    after = await Promise.all(
      origins.map(({ client }) => client.getBlock({ blockNumber }).then(header)),
    )
  } catch {
    return unavailable('after_read_header_unavailable')
  }
  if (after.some((value) => !sameHeader(value, pinned[0])))
    return unavailable('pinned_header_changed')

  let readAtMs
  try {
    readAtMs = clock()
  } catch {
    return unavailable('operator_clock_unavailable')
  }
  const ageMs = readAtMs - Number(pinned[0].timestamp) * 1000
  if (!Number.isSafeInteger(readAtMs) || !Number.isSafeInteger(ageMs))
    return unavailable('operator_clock_unavailable')
  if (ageMs < -FUTURE_CLOCK_TOLERANCE_MS) return unavailable('finalized_clock_invalid')
  if (ageMs > sourceAgeMs) return unavailable('finalized_block_stale')

  return {
    status: 'available',
    routeKey: subject.route_key,
    destination: subject.destination,
    asset: subject.asset,
    assetDecimals: states[0].assetDecimals,
    cashRaw: states[0].cashRaw,
    block: blockNumber.toString(),
    blockHash: pinned[0].hash,
    blockAt: pinned[0].at,
    readAtUtc: new Date(readAtMs).toISOString(),
    sourceKind: SOURCE_KIND,
  }
}

/** Selects exactly two distinct configured hosts; never returns the URLs. */
export async function readConfiguredLiveCurrentCash(query, options = {}) {
  const sourceAgeMs = sourceAgePolicy(options.maxSourceAgeMs)
  if (sourceAgeMs === null) return unavailable('source_age_policy_invalid')
  if (options.manifest) {
    try {
      validateManifest(options.manifest)
    } catch {
      return unavailable('subject_manifest_unavailable')
    }
  }
  let raw = options.rpcUrls
  if (raw === undefined) {
    try {
      const env = readEnv()
      const { configuredProviders, readProviderPolicy } =
        await import('./carry-depth-quote-archive.mjs')
      const policy = readProviderPolicy()
      if (policy.status !== 'active') return unavailable('rpc_origins_unavailable')
      // The reviewed configured policy selects existing origins without changing the environment.
      raw = configuredProviders({ get: (key) => process.env[key] ?? env.get(key) }, policy)
        .map((origin) => origin.url)
        .join(',')
    } catch {
      return unavailable('rpc_origins_unavailable')
    }
  }
  const selected = []
  const hosts = new Set()
  for (const value of String(raw ?? '').split(',')) {
    const url = value.trim()
    const host = hostOf(url)
    if (!host || hosts.has(host)) continue
    selected.push(url)
    hosts.add(host)
    if (selected.length === 2) break
  }
  if (selected.length !== 2) return unavailable('rpc_origins_unavailable')
  const cacheEnabled =
    options.cache === true ||
    (options.cache !== false &&
      !options.clientFactory &&
      !options.clock &&
      !options.readVault &&
      !options.readDirect &&
      !options.manifest)
  const key =
    cacheEnabled &&
    typeof query?.routeKey === 'string' &&
    query.routeKey.length <= 255 &&
    query.asset === undefined &&
    typeof query?.destination === 'string' &&
    ADDRESS.test(query.destination.toLowerCase())
      ? `${query.routeKey}\0${query.destination.toLowerCase()}\0${createHash('sha256').update(selected.join('\0')).digest('hex')}${options.manifest ? `\0${options.manifest.sha256}` : ''}\0${sourceAgeMs}`
      : null
  if (key) {
    let nowMs
    try {
      nowMs = (options.clock ?? Date.now)()
    } catch {
      return unavailable('operator_clock_unavailable')
    }
    const cached = availableCache.get(key)
    if (cached && freshCached(cached, nowMs, sourceAgeMs)) return { ...cached }
    if (cached) availableCache.delete(key)
    if (pendingReads.has(key)) return pendingReads.get(key)
    if (pendingReads.size >= CACHE_MAX_SUBJECTS) return unavailable('too_many_live_cash_reads')
  }
  const read = async () => {
    let origins
    try {
      origins = selected.map((url) => ({ url, client: (options.clientFactory ?? makeClient)(url) }))
    } catch {
      return unavailable('rpc_origins_unavailable')
    }
    const result = await readLiveCurrentCash(query, {
      ...options,
      origins,
      maxSourceAgeMs: sourceAgeMs,
    })
    if (key && result.status === 'available') {
      if (availableCache.size >= CACHE_MAX_SUBJECTS)
        availableCache.delete(availableCache.keys().next().value)
      availableCache.set(key, { ...result })
    }
    return result
  }
  if (!key) return read()
  const pending = read()
  pendingReads.set(key, pending)
  try {
    return await pending
  } finally {
    pendingReads.delete(key)
  }
}
