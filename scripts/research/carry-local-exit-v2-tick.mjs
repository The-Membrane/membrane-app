import { createUmbrellaGhoV2ScorerAdapter } from '../lib/carry-exit-v2-umbrella-gho-scorer.mjs'
import { classifyUmbrellaGhoScore } from '../lib/carry-exit-v2-umbrella-gho-classifier.mjs'
// No-database local Carry Exit V2 readback and score tick.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { selectCarryExitV2FirstFinalizedBlock } from '../lib/carry-exit-v2-block-auditor.mjs'
import { measureCarryExitV2Verified } from '../lib/carry-exit-v2-verified-measurement.mjs'
import {
  LOCAL_CARRY_EXIT_V2_ROOT,
  verifyLocalCarryExitV2Ledger,
} from '../lib/localCarryExitV2Store.mjs'
import { scoreDueLocalCarryExitV2 } from '../lib/localCarryExitV2Scorer.mjs'
import { recordLocalCarryExitV2Readbacks } from '../lib/localCarryExitV2Witness.mjs'
import { readEnv } from '../lib/venue-reads.mjs'
import { classifyDirectScore } from '../record-carry-direct-exit-v2-scores.mjs'
import { classifyMorphoScore } from '../record-carry-morpho-exit-v2-scores.mjs'
import { classifySyncVaultScore } from '../record-carry-sync-vault-exit-v2-scores.mjs'

const MAX_URLS = 8
const MAX_RESPONSE_BYTES = 64 * 1024
const RPC_TIMEOUT_MS = 15_000
const VERIFY_RPC_FALLBACK = 'https://eth.drpc.org'

function rpcOrigin(url) {
  const parsed = new URL(url)
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  )
    throw Error('local_exit_v2_rpc_url_invalid')
  return `${parsed.protocol}//${parsed.host}`
}

function rpcHost(url) {
  const hostname = new URL(url).hostname
    .replace(/\.$/, '')
    .replace(/^www\./, '')
    .toLowerCase()
  return /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/.test(hostname) ? 'loopback' : hostname
}

export function configuredLocalExitV2RpcUrls(value) {
  const urls = String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (!urls.length || urls.length > MAX_URLS || new Set(urls).size !== urls.length)
    throw Error('local_exit_v2_rpc_urls_invalid')
  urls.forEach(rpcOrigin)
  return urls
}

export function configuredLocalExitV2RpcUrlsWithVerification({
  urls,
  verificationUrl = VERIFY_RPC_FALLBACK,
} = {}) {
  const primaryUrls = configuredLocalExitV2RpcUrls(urls)
  const [verification] = configuredLocalExitV2RpcUrls(verificationUrl)
  if (primaryUrls.includes(verification))
    return primaryUrls[0] === verification
      ? primaryUrls
      : [
          primaryUrls[0],
          verification,
          ...primaryUrls.slice(1).filter((url) => url !== verification),
        ]
  if (rpcHost(primaryUrls[0]) === rpcHost(verification)) return primaryUrls
  if (primaryUrls.length >= MAX_URLS) throw Error('local_exit_v2_rpc_urls_invalid')
  return [primaryUrls[0], verification, ...primaryUrls.slice(1)]
}

export function localExitV2RpcTransport(url, fetchImpl = fetch) {
  const provider = rpcOrigin(url)
  let nextId = 0
  const send = async (envelope) => {
    const response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    })
    if (!response.ok) throw Error(`local_exit_v2_rpc_http_${response.status}`)
    const body = await response.text()
    if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES)
      throw Error('local_exit_v2_rpc_response_too_large')
    const parsed = JSON.parse(body)
    if (
      parsed?.jsonrpc !== '2.0' ||
      parsed.id !== envelope.id ||
      Object.hasOwn(parsed, 'result') === Object.hasOwn(parsed, 'error')
    )
      throw Error('local_exit_v2_rpc_response_invalid')
    return parsed
  }
  return {
    url,
    provider,
    send,
    async request(method, params) {
      const response = await send({ jsonrpc: '2.0', id: ++nextId, method, params })
      if (Object.hasOwn(response, 'error')) throw Error('local_exit_v2_rpc_response_error')
      return response.result
    },
  }
}

/** Reuse the source classifiers while keeping all database readers/writers out. */
export function createLocalCarryExitV2Adapters({
  primary,
  secondary,
  origins = [primary, secondary],
  now = () => new Date(),
  deadlineMs = now().getTime() + 90_000,
  wallDeadlineMs = Date.now() + Math.max(0, deadlineMs - now().getTime()),
  select = selectCarryExitV2FirstFinalizedBlock,
  measure = measureCarryExitV2Verified,
  classifiers = {
    morpho: classifyMorphoScore,
    direct: classifyDirectScore,
    sync_vault: classifySyncVaultScore,
    umbrella_gho: classifyUmbrellaGhoScore,
  },
} = {}) {
  if (
    !primary?.provider ||
    !secondary?.provider ||
    typeof primary.request !== 'function' ||
    typeof primary.send !== 'function' ||
    typeof secondary.send !== 'function' ||
    rpcHost(primary.url) === rpcHost(secondary.url)
  )
    throw Error('local_exit_v2_independent_origins_required')

  const build = (source) => ({
    id: `carry_local_exit_v2_${source}_classifier_v1`,
    chooseTarget: (context) =>
      select({
        targetAt: context.plan.targetAtUtc,
        baselineBlock: context.issue.payload.baselineBlock,
        baselineHash: context.issue.payload.baselineHash,
        provider: primary.provider,
        source: `carry_local_exit_v2_${source}_target`,
        request: (method, params) => primary.request(method, params),
        now,
      }),
    measure: (context, target) =>
      measure({
        ...context.row,
        target,
        provider: primary.provider,
        source: `carry_local_exit_v2_${source}_score`,
        send: (envelope) => primary.send(envelope),
        primary: { url: primary.url, request: (envelope) => primary.send(envelope) },
        secondary: { url: secondary.url, request: (envelope) => secondary.send(envelope) },
        now,
      }),
    classify: classifiers[source],
  })
  return {
    morpho: build('morpho'),
    direct: build('direct'),
    sync_vault: build('sync_vault'),
    umbrella_gho: createUmbrellaGhoV2ScorerAdapter({
      origins,
      preferredSecondaryUrl: secondary.url,
      now,
      select,
      measure,
      classify: classifiers.umbrella_gho,
      deadlineMs,
      wallDeadlineMs,
    }),
  }
}

export async function runLocalCarryExitV2Tick({
  root = LOCAL_CARRY_EXIT_V2_ROOT,
  urls = [],
  now = () => new Date(),
  fetchImpl = fetch,
  deadlineMs = now().getTime() + 90_000,
  readback = recordLocalCarryExitV2Readbacks,
  score = scoreDueLocalCarryExitV2,
  minFreeBytes,
} = {}) {
  const readbackResult = readback({ root, now, minFreeBytes })
  let adapters = {}
  let rpcStatus = 'unavailable'
  try {
    const configured = Array.isArray(urls) ? urls : configuredLocalExitV2RpcUrls(urls)
    const clients = configured.map((url) => localExitV2RpcTransport(url, fetchImpl))
    const primary = clients[0]
    const secondary = clients.find((client) => rpcHost(client.url) !== rpcHost(primary.url))
    if (!secondary) throw Error('local_exit_v2_independent_origins_required')
    adapters = createLocalCarryExitV2Adapters({
      primary,
      secondary,
      origins: clients,
      now,
      deadlineMs,
    })
    rpcStatus = 'configured_two_origin'
  } catch {
    // Live cells remain pending until their deadline; overdue cells become a
    // typed unavailable denominator through the generic scorer.
  }
  const scoreResult = await score({ root, adapters, now, minFreeBytes })
  return {
    status: 'local_tick_complete',
    rpcStatus,
    readback: readbackResult,
    score: scoreResult,
    databaseUsed: false,
    sqlBatchIdsUsed: false,
    independentTimestamp: false,
    independentWitness: false,
    minedPayoutProven: false,
    prospectiveValidated: false,
    forecastValidated: false,
    holderExecutableExit: false,
  }
}

function verificationSummary(root) {
  const state = verifyLocalCarryExitV2Ledger({ root })
  return {
    status: 'verified_local_chain',
    records: state.records.length,
    issues: state.issues.size,
    readbacks: state.readbacks.size,
    outcomes: state.outcomes.size,
    headSha256: state.head?.lastSha256 ?? null,
    independentTimestamp: false,
    independentWitness: false,
    forecastValidated: false,
    holderExecutableExit: false,
  }
}

async function main() {
  const [mode = '--tick'] = process.argv.slice(2)
  if (!['--tick', '--readback', '--score', '--verify'].includes(mode))
    throw Error('usage: --tick|--readback|--score|--verify')
  const { get } = readEnv()
  const root = process.env.CARRY_LOCAL_EXIT_V2_ROOT || LOCAL_CARRY_EXIT_V2_ROOT
  if (mode === '--verify') return verificationSummary(root)
  if (mode === '--readback') return recordLocalCarryExitV2Readbacks({ root })
  let urls = []
  const rawUrls =
    process.env.RECORDER_RPC_URLS ||
    process.env.RECORDER_RPC_URL ||
    get('RECORDER_RPC_URLS') ||
    get('RECORDER_RPC_URL')
  try {
    urls = configuredLocalExitV2RpcUrlsWithVerification({
      urls: rawUrls,
      verificationUrl:
        process.env.CARRY_EXIT_V2_VERIFY_RPC_URL ||
        get('CARRY_EXIT_V2_VERIFY_RPC_URL') ||
        VERIFY_RPC_FALLBACK,
    })
  } catch {
    // The scorer emits typed adapter-unavailable states and keeps all claims false.
  }
  if (mode === '--score') {
    let adapters = {}
    if (urls.length) {
      const clients = urls.map((url) => localExitV2RpcTransport(url))
      const secondary = clients.find((client) => rpcHost(client.url) !== rpcHost(clients[0].url))
      if (secondary)
        adapters = createLocalCarryExitV2Adapters({
          primary: clients[0],
          secondary,
          origins: clients,
        })
    }
    return scoreDueLocalCarryExitV2({ root, adapters })
  }
  return runLocalCarryExitV2Tick({ root, urls })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => {
      process.stderr.write('carry_local_exit_v2_tick_failed\n')
      process.exitCode = 1
    })
}
