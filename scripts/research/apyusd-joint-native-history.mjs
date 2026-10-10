// Preparation and replay are offline. Only explicit executePlan contacts injected origins.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { performance } from 'node:perf_hooks'
import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult, parseAbi } from 'viem'
import {
  ROUTE,
  VAULT,
  ASSET,
  RECEIPT,
  attestIdentity,
  pin,
} from './carry-public-apyusd-exit-common.mjs'

const sha = (s) => createHash('sha256').update(s).digest('hex')
const same = isDeepStrictEqual
const check = (ok, reason) => {
  if (!ok) throw Error(`apyusd_joint_${reason}`)
}
const prepared = new WeakSet()
const clients = new WeakMap()
const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
const utc = (v) =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v
const uint = (v) =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < 2n ** 256n
const HASH = /^0x[0-9a-f]{64}$/
const quantity = /^0x(?:0|[1-9a-f][0-9a-f]*)$/
const HOSTS = freeze(['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'])
export const POLICY = freeze({
  pilotIndexes: [118, 119],
  anchors: 2,
  origins: 2,
  requestsPerAnchorOrigin: 19,
  maxRequests: 76,
  maxInFlightPerHost: 1,
  retries: 0,
  timeoutMs: 8000,
  maxRunMs: 120000,
  maxResponseBytes: 65536,
  maxArtifactBytes: 1024 * 1024,
})
export const ABI = freeze(
  parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function unlockingFee() view returns (uint256)',
    'function feeCurve() view returns (uint256 minFee,uint256 maxFee,uint48 minDuration,uint48 maxDuration,uint256 curvature)',
    'function paused() view returns (bool)',
  ]),
)
export const SEMANTICS = freeze({
  vaultFeeStage: {
    input: 'receipt_escrow_apxusd_raw',
    output: 'gross_vault_withdraw_apxusd_raw',
    formula: 'escrow + ceil(escrow * unlockingFeeWad / 1e18)',
    authority: 'scripts/research/apyusd-receipt-cohort-escrow.mjs:91-119',
    qualification: 'locally_reconstructed_and_transaction_event_checked',
  },
  receiptFeeStage: {
    input: 'receipt_escrow_apxusd_raw',
    output: 'net_receipt_claim_apxusd_raw',
    authority: 'lib/carry/apyUsdExit.ts:40-49',
    qualification: 'fee_curve_getter_only_no_age_or_claim_quote_in_this_capture',
  },
  fullHolderEntitlement: {
    status: 'unverified_callable_source_semantics',
    valueRaw: null,
    required:
      'pinned implementation authority for convertToAssets(full holder shares) and previewRedeem(full holder shares)',
  },
  inferenceLimits: [
    'cash_is_not_holder_entitlement',
    'two_fee_stages_are_not_one_fee',
    'no_queue_or_fixed_wait_inferred',
  ],
})
export function grossVaultWithdrawForEscrow(escrowRaw, unlockingFeeWad) {
  check(uint(escrowRaw) && uint(unlockingFeeWad), 'fee_input')
  const escrow = BigInt(escrowRaw),
    wad = 10n ** 18n
  const vaultFee = (escrow * BigInt(unlockingFeeWad) + wad - 1n) / wad
  check(escrow + vaultFee < 2n ** 256n, 'fee_overflow')
  return {
    receiptEscrowRaw: escrowRaw,
    vaultFeeRaw: String(vaultFee),
    grossVaultWithdrawRaw: String(escrow + vaultFee),
  }
}

/** Qualifies sealed historical single-provider cash receipts before selecting hashes.
 * These old receipts establish the grid and cash witness, not independent RPC evidence.
 * The new pilot re-reads each old cash value through both new origins.
 */
export async function createPlan({ intervalEndIndex = 119 } = {}) {
  check(
    Number.isInteger(intervalEndIndex) && intervalEndIndex >= 1 && intervalEndIndex <= 119,
    'interval_index',
  )
  await import('tsx')
  const [{ buildSubjectManifest }, store, pins, holdout] = await Promise.all([
    import('../record-carry-cash-issues.mjs'),
    import('../lib/localCarryCashStore.mjs'),
    import('./carry-sampled-cash-history-pins.mjs'),
    import('./conditional-cash-time-holdout.mjs'),
  ])
  const manifest = await buildSubjectManifest(),
    lane = pins.PROFILE.lanes[0]
  check(manifest.sha256 === lane.manifestSha256, 'manifest_pin')
  const verified = store.verifyLocalCarryCash(manifest, lane.root, {
    maxRecords: 512,
    maxTotalBytes: 96 * 1024 * 1024,
  })
  const prefix = pins.frozenPrefix(verified, lane)
  const observations = store.localCarryCashObservationsFromVerified(prefix)
  const audit = holdout.loadPinnedAudit()
  const key = `${ROUTE}\0${VAULT}\0${ASSET}`,
    history = audit.histories[key]
  check(
    history && history.points.length === 120 && history.identity.assetDecimals === 18,
    'history_identity',
  )
  check(
    sha(JSON.stringify(history)) ===
      'b530b2ad053670a0e7848217a6ebd4cd320e18ad2c0a923d2c333ffd1be93768',
    'history_pin',
  )
  const indexes = [intervalEndIndex - 1, intervalEndIndex]
  const anchors = indexes.map((index) => {
    const point = history.points[index]
    const found = observations.filter(
      (o) =>
        o.collectionMode === 'retrospective' &&
        o.source.block === point[1] &&
        o.source.blockHash === point[2] &&
        o.source.blockAt === point[3],
    )
    check(found.length === 1, 'raw_anchor_join')
    const observation = found[0],
      rows = observation.subjects.filter((r) => r.routeKey === ROUTE && r.destination === VAULT)
    check(
      rows.length === 1 &&
        rows[0].state === 'observed' &&
        rows[0].asset === ASSET &&
        rows[0].assetDecimals === 18 &&
        rows[0].cashRaw === point[4],
      'raw_cash_join',
    )
    return {
      index,
      blockNumber: point[1],
      blockHash: point[2],
      blockAtUtc: point[3],
      oldVaultCashRaw: point[4],
      receiptSha256: observation.receiptSha256,
    }
  })
  const plan = freeze({
    schema: 'apyusd_joint_native_history_plan_v1',
    subject: { route: ROUTE, vault: VAULT, receipt: RECEIPT, asset: ASSET, decimals: 18 },
    priorHistoryAvailableAtUtc: history.witness.availableAt,
    rawPrefixHeadSha256: lane.prefixHeadSha256,
    priorCashProvenance: 'sealed_single_provider_cash_receipts',
    pilotPurpose: 'latest_contiguous_daily_interval_then_extend_all_119_intervals',
    expansion: {
      mode: 'one_consecutive_daily_interval_per_bounded_run',
      intervalEndIndexes: [1, 119],
      totalUniqueAnchors: 120,
      furtherQualification:
        'reviewed_external_immutable_file_and_body_pins_for_each_capture_before_joint_fit',
    },
    anchors,
    originHosts: HOSTS,
    policy: { ...POLICY, pilotIndexes: indexes },
    semantics: SEMANTICS,
  })
  prepared.add(plan)
  return plan
}

function assertPlan(plan) {
  check(prepared.has(plan), 'prepared_plan_required')
}
function header(raw, anchor) {
  check(
    raw &&
      HASH.test(raw.hash ?? '') &&
      quantity.test(raw.number ?? '') &&
      quantity.test(raw.timestamp ?? '') &&
      HASH.test(raw.parentHash ?? ''),
    'header_shape',
  )
  check(
    raw.hash === anchor.blockHash &&
      String(BigInt(raw.number)) === anchor.blockNumber &&
      new Date(Number(BigInt(raw.timestamp)) * 1000).toISOString() === anchor.blockAtUtc,
    'header_changed',
  )
}
async function readAnchor(origin, anchor) {
  check((await origin.request('eth_chainId', [])) === '0x1', 'chain')
  const tag = `0x${BigInt(anchor.blockNumber).toString(16)}`
  const before = await origin.request('eth_getBlockByNumber', [tag, false])
  header(before, anchor)
  const identity = await attestIdentity(origin, anchor.blockHash)
  const call = async (to, functionName, args = []) => {
    const data = encodeFunctionData({ abi: ABI, functionName, args })
    const raw = await origin.request('eth_call', [{ to, data }, pin(anchor.blockHash)])
    const value = decodeFunctionResult({ abi: ABI, functionName, data: raw })
    check(
      encodeFunctionResult({ abi: ABI, functionName, result: value }) === raw,
      'canonical_call_result',
    )
    return value
  }
  const vaultCashRaw = String(await call(ASSET, 'balanceOf', [VAULT]))
  const receiptCashRaw = String(await call(ASSET, 'balanceOf', [RECEIPT]))
  const unlockingFeeWad = String(await call(VAULT, 'unlockingFee'))
  const curve = await call(RECEIPT, 'feeCurve')
  const vaultPaused = await call(VAULT, 'paused'),
    receiptPaused = await call(RECEIPT, 'paused')
  const after = await origin.request('eth_getBlockByNumber', [tag, false])
  header(after, anchor)
  check(same(before, after), 'header_bracket')
  check(vaultCashRaw === anchor.oldVaultCashRaw, 'old_cash_changed')
  return {
    identity,
    vaultCashRaw,
    receiptCashRaw,
    unlockingFeeWad,
    feeCurve: Object.fromEntries(
      ['minFee', 'maxFee', 'minDuration', 'maxDuration', 'curvature'].map((k, i) => [
        k,
        String(curve[i]),
      ]),
    ),
    vaultPaused,
    receiptPaused,
  }
}
async function collect(plan, origins) {
  const points = []
  for (const anchor of plan.anchors) {
    const readings = []
    for (const origin of origins) readings.push(await readAnchor(origin, anchor))
    check(same(readings[0], readings[1]), 'two_origin_disagreement')
    points.push({
      source: anchor,
      ...readings[0],
      fullHolderEntitlement: SEMANTICS.fullHolderEntitlement,
    })
  }
  return points
}

/** Explicit configured URLs stay private; returned identities cannot be forged or cloned. */
export function createRpcClients(urls, { fetchImpl = globalThis.fetch } = {}) {
  check(
    Array.isArray(urls) && urls.length === 2 && typeof fetchImpl === 'function',
    'client_factory',
  )
  return freeze(
    urls.map((url, index) => {
      let parsed
      try {
        parsed = new URL(url)
      } catch {
        throw Error('apyusd_joint_client_url')
      }
      check(
        parsed.protocol === 'https:' &&
          parsed.hostname === HOSTS[index] &&
          !parsed.port &&
          !parsed.username &&
          !parsed.password &&
          !parsed.hash,
        'client_url',
      )
      const client = freeze({ provider: HOSTS[index] })
      clients.set(client, { url, fetchImpl })
      return client
    }),
  )
}
function decodeBody(bodyText, bytes, id) {
  check(
    typeof bodyText === 'string' &&
      Number.isSafeInteger(bytes) &&
      bytes > 0 &&
      bytes <= POLICY.maxResponseBytes &&
      Buffer.byteLength(bodyText) === bytes,
    'body_limit',
  )
  let envelope
  try {
    envelope = JSON.parse(bodyText)
  } catch {
    throw Error('apyusd_joint_json')
  }
  check(
    envelope &&
      Object.keys(envelope).length === 3 &&
      envelope.jsonrpc === '2.0' &&
      envelope.id === id &&
      Object.hasOwn(envelope, 'result'),
    'rpc_envelope',
  )
  return envelope.result
}
function regimes(points) {
  return points.map((point, index) => {
    const previous = points[index - 1]
    const terms = (p) => [p.identity, p.unlockingFeeWad, p.feeCurve, p.vaultPaused, p.receiptPaused]
    return {
      ...point,
      stockSemantics: 'two_cash_stocks_not_gross_flows',
      regime: previous
        ? {
            status: same(terms(previous), terms(point))
              ? 'same_observed_endpoint_terms'
              : 'regime_change',
            transitionDuration: 'unknown_between_anchors',
          }
        : { status: 'first_observed_terms', transitionDuration: 'unknown' },
    }
  })
}
/** Executes only factory clients, with a monotonic deadline and capped streamed bodies. */
export async function executePlan(
  plan,
  origins,
  { nowUtc = () => new Date().toISOString(), monotonicNow = () => performance.now() } = {},
) {
  assertPlan(plan)
  check(
    Array.isArray(origins) &&
      origins.length === 2 &&
      origins.every((o, i) => clients.has(o) && o.provider === HOSTS[i]) &&
      origins[0] !== origins[1],
    'trusted_independent_clients',
  )
  const startedAtUtc = nowUtc(),
    runStart = monotonicNow()
  check(
    utc(startedAtUtc) &&
      startedAtUtc >= plan.priorHistoryAvailableAtUtc &&
      Number.isFinite(runStart),
    'start_clock',
  )
  let lastElapsed = 0,
    physicalStarts = 0,
    totalResponseBytes = 0
  const elapsed = () => {
    const n = monotonicNow() - runStart
    check(Number.isFinite(n) && n >= lastElapsed && n < POLICY.maxRunMs, 'run_deadline')
    lastElapsed = n
    return n
  }
  const transcript = [],
    controllers = new Set()
  const wrappers = origins.map((origin, originIndex) => {
    const { url, fetchImpl } = clients.get(origin)
    let tail = Promise.resolve()
    return {
      request(method, params) {
        const task = tail.then(async () => {
          const beganElapsedMs = elapsed(),
            timeoutMs = Math.min(POLICY.timeoutMs, POLICY.maxRunMs - beganElapsedMs)
          check(physicalStarts < POLICY.maxRequests, 'call_budget')
          const beganAtUtc = nowUtc(),
            controller = new AbortController()
          controllers.add(controller)
          const id = ++physicalStarts
          let timer, reader
          try {
            const work = (async () => {
              const response = await fetchImpl(url, {
                method: 'POST',
                redirect: 'error',
                signal: controller.signal,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
              })
              elapsed()
              check(!controller.signal.aborted, 'aborted')
              check(
                response?.ok &&
                  !response.redirected &&
                  response.body &&
                  typeof response.body.getReader === 'function',
                'http_response',
              )
              const length = response.headers?.get('content-length')
              check(
                length === null ||
                  length === undefined ||
                  (/^[0-9]+$/.test(length) && Number(length) <= POLICY.maxResponseBytes),
                'body_limit',
              )
              reader = response.body.getReader()
              const chunks = []
              let bytes = 0
              for (;;) {
                const chunk = await reader.read()
                elapsed()
                check(!controller.signal.aborted, 'aborted')
                if (chunk.done) break
                check(chunk.value instanceof Uint8Array, 'stream_chunk')
                bytes += chunk.value.byteLength
                totalResponseBytes += chunk.value.byteLength
                check(bytes <= POLICY.maxResponseBytes, 'body_limit')
                chunks.push(chunk.value)
              }
              const bodyText = new TextDecoder('utf-8', { fatal: true }).decode(
                Buffer.concat(chunks),
              )
              const result = decodeBody(bodyText, bytes, id)
              const endedElapsedMs = elapsed(),
                endedAtUtc = nowUtc()
              check(
                endedElapsedMs - beganElapsedMs <= timeoutMs &&
                  utc(beganAtUtc) &&
                  utc(endedAtUtc) &&
                  beganAtUtc >= (transcript.at(-1)?.endedAtUtc ?? startedAtUtc) &&
                  endedAtUtc >= beganAtUtc,
                'request_deadline_or_clock',
              )
              transcript.push({
                originIndex,
                method,
                params: structuredClone(params),
                bodyText,
                bodyBytes: bytes,
                beganAtUtc,
                endedAtUtc,
                beganElapsedMs,
                endedElapsedMs,
              })
              return result
            })()
            return await Promise.race([
              work,
              new Promise((_, reject) => {
                timer = setTimeout(() => {
                  controller.abort()
                  reject(Error('apyusd_joint_request_timeout'))
                }, timeoutMs)
              }),
            ])
          } catch {
            controller.abort()
            throw Error('apyusd_joint_request_failed')
          } finally {
            clearTimeout(timer)
            controllers.delete(controller)
            if (reader) {
              try {
                Promise.resolve(reader.cancel()).catch(() => {})
              } catch {}
            }
          }
        })
        tail = task
        return task
      },
    }
  })
  let points
  try {
    points = regimes(await collect(plan, wrappers))
  } catch (error) {
    controllers.forEach((controller) => controller.abort())
    error.captureDiagnostics = freeze({
      physicalStarts,
      totalResponseBytes,
      completedResponses: transcript.length,
      lastElapsedMs: lastElapsed,
      maxRunMs: POLICY.maxRunMs,
      aborted: true,
    })
    throw error
  }
  const durationMs = elapsed(),
    finishedAtUtc = nowUtc()
  check(
    physicalStarts === POLICY.maxRequests &&
      transcript.length === physicalStarts &&
      utc(finishedAtUtc) &&
      finishedAtUtc >= transcript.at(-1).endedAtUtc &&
      Date.parse(finishedAtUtc) - Date.parse(startedAtUtc) < POLICY.maxRunMs,
    'finish_clock_or_count',
  )
  const body = {
    schema: 'apyusd_joint_native_history_raw_v1',
    planSha256: sha(JSON.stringify(plan)),
    authority: 'internal_transcript_consistency_only_external_immutable_file_and_body_pin_required',
    startedAtUtc,
    finishedAtUtc,
    availableAtUtc: finishedAtUtc,
    originHosts: HOSTS,
    physicalStarts,
    totalResponseBytes,
    durationMs,
    transcript,
    points,
  }
  const raw = { ...body, sha256: sha(JSON.stringify(body)) }
  check(Buffer.byteLength(JSON.stringify(raw)) <= POLICY.maxArtifactBytes, 'artifact_size')
  return freeze(raw)
}

/** Replay establishes internal consistency, not authenticity of a caller's self seal. */
export async function replay(raw, plan) {
  assertPlan(plan)
  check(Buffer.byteLength(JSON.stringify(raw)) <= POLICY.maxArtifactBytes, 'artifact_size')
  const { sha256, ...body } = raw
  check(
    sha(JSON.stringify(body)) === sha256 &&
      raw.schema === 'apyusd_joint_native_history_raw_v1' &&
      raw.planSha256 === sha(JSON.stringify(plan)) &&
      same(raw.originHosts, HOSTS) &&
      raw.authority ===
        'internal_transcript_consistency_only_external_immutable_file_and_body_pin_required',
    'seal_or_plan',
  )
  check(
    utc(raw.startedAtUtc) &&
      utc(raw.finishedAtUtc) &&
      raw.startedAtUtc >= plan.priorHistoryAvailableAtUtc &&
      raw.finishedAtUtc >= raw.startedAtUtc &&
      Date.parse(raw.finishedAtUtc) - Date.parse(raw.startedAtUtc) < POLICY.maxRunMs &&
      raw.availableAtUtc === raw.finishedAtUtc &&
      raw.transcript.length === POLICY.maxRequests &&
      raw.physicalStarts === POLICY.maxRequests &&
      Number.isFinite(raw.durationMs) &&
      raw.durationMs >= 0 &&
      raw.durationMs < POLICY.maxRunMs,
    'capture_clock_or_count',
  )
  let cursor = 0,
    lastClock = raw.startedAtUtc,
    lastElapsed = 0,
    bytes = 0
  const origins = HOSTS.map((_, index) => ({
    async request(method, params) {
      const row = raw.transcript[cursor++]
      check(
        row && row.originIndex === index && row.method === method && same(row.params, params),
        'exact_request',
      )
      check(
        utc(row.beganAtUtc) &&
          utc(row.endedAtUtc) &&
          row.beganAtUtc >= lastClock &&
          row.endedAtUtc >= row.beganAtUtc &&
          row.endedAtUtc <= raw.finishedAtUtc &&
          Number.isFinite(row.beganElapsedMs) &&
          Number.isFinite(row.endedElapsedMs) &&
          row.beganElapsedMs >= lastElapsed &&
          row.endedElapsedMs >= row.beganElapsedMs &&
          row.endedElapsedMs <= raw.durationMs &&
          row.endedElapsedMs - row.beganElapsedMs <=
            Math.min(POLICY.timeoutMs, POLICY.maxRunMs - row.beganElapsedMs),
        'replay_clock_or_deadline',
      )
      lastClock = row.endedAtUtc
      lastElapsed = row.endedElapsedMs
      bytes += row.bodyBytes
      return decodeBody(row.bodyText, row.bodyBytes, cursor)
    },
  }))
  const points = regimes(await collect(plan, origins))
  check(
    cursor === POLICY.maxRequests && bytes === raw.totalResponseBytes && same(points, raw.points),
    'replayed_facts',
  )
  return freeze({
    status: 'internally_consistent_paired_native_history',
    authority: raw.authority,
    availableAtUtc: raw.availableAtUtc,
    physicalStarts: cursor,
    points,
    semantics: SEMANTICS,
  })
}
