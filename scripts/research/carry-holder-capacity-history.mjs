// Archival getter revalidation. Old holder summaries locate sources; only raw replay proves E/M.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statfsSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decodeFunctionResult,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  parseAbi,
} from 'viem'
import { readEnv } from '../lib/venue-reads.mjs'
import { ROUTES } from './carry-fluid-ftoken-payout.mjs'
import { verifyIssues, verifyScores } from './carry-fluid-ftoken-holder.mjs'
export const CAPACITY_HISTORY_VERSION = 'fluid-holder-capacity-history-v1'
const HOSTS = Object.freeze(['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'])
const DECIMALS = [6, 6, 18]
const TRANSPORT_POLICY = Object.freeze({
  redirect: 'error',
  maxResponseBytes: 128 * 1024,
  rpcTimeoutMs: 8000,
  cleanupGraceMs: 250,
  maxInFlightPerOrigin: 2,
  minStartSpacingMs: 50,
})
async function boundedResponseText(response, controller, controlledStub = false) {
  if (!response.body?.getReader) {
    check(controlledStub, 'response_stream_unavailable')
    const text = await response.text()
    check(Buffer.byteLength(text) <= TRANSPORT_POLICY.maxResponseBytes, 'response_oversize')
    return text
  }
  const reader = response.body.getReader(),
    chunks = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      check(bytes <= TRANSPORT_POLICY.maxResponseBytes, 'response_oversize')
      chunks.push(value)
    }
    return Buffer.concat(
      chunks.map((c) => Buffer.from(c)),
      bytes,
    ).toString('utf8')
  } catch (error) {
    controller.abort()
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
}

const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const implementationAddress = (word) =>
  typeof word === 'string' && /^0x0{24}[0-9a-f]{40}$/.test(word) && !/^0x0{64}$/.test(word)
    ? '0x' + word.slice(-40)
    : null
const codeHash = (code) =>
  typeof code === 'string' && /^0x(?:[0-9a-f]{2})+$/.test(code) ? keccak256(code) : null
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const uint = (v) =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < 1n << 256n
const hex = (v) => typeof v === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(v)
const hash = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v)
const utc = (v) =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const check = (v, reason) => {
  if (!v) throw Error(reason)
}
const header = (raw) => {
  check(raw && hex(raw.number) && hex(raw.timestamp) && hash(raw.hash), 'invalid_header')
  const number = Number(BigInt(raw.number)),
    timestamp = Number(BigInt(raw.timestamp))
  check(Number.isSafeInteger(number) && Number.isSafeInteger(timestamp), 'unsafe_header')
  return {
    blockNumber: number,
    blockHash: raw.hash,
    blockTime: new Date(timestamp * 1000).toISOString(),
  }
}
const sameHeader = (a, b) =>
  a.blockNumber === b.blockNumber && a.blockHash === b.blockHash && a.blockTime === b.blockTime
const locatorHeader = (h) => ({ blockNumber: h.number, blockHash: h.hash, blockTime: h.atUtc })

export function locateCapacityHistoryCandidates() {
  const rows = []
  for (let routeIndex = 0; routeIndex < ROUTES.length; routeIndex++) {
    const issues = verifyIssues(routeIndex),
      scores = verifyScores(routeIndex, issues)
    for (const issue of issues)
      for (const horizonHours of [1, 4, 24, 48]) {
        const score = scores.find(
          (s) => s.issueSequence === issue.sequence && s.horizonHours === horizonHours,
        )
        const stable =
          score?.status === 'measured' &&
          score.positionAtTarget?.sharesRaw === issue.position.sharesRaw
        rows.push({
          id: `${routeIndex}:${issue.sequence}:${horizonHours}`,
          routeIndex,
          routeKey: issue.routeKey,
          destination: issue.vault,
          asset: issue.asset,
          assetDecimals: DECIMALS[routeIndex],
          owner: issue.holder,
          plannedHorizonHours: horizonHours,
          issueSha256: issue.sha256,
          scoreSha256: score?.sha256 ?? null,
          baseline: { source: locatorHeader(issue.baseline), summary: issue.position },
          target: score?.block
            ? { source: locatorHeader(score.block), summary: score.positionAtTarget }
            : null,
          locatorStatus: !score
            ? 'missing_score'
            : score.status !== 'measured'
              ? score.status
              : !stable
                ? 'shares_changed'
                : 'same_shares_candidate',
          summaryOnly: true,
          oldRequestedQProof: 'not_revalidated',
          oldSummaryNormalizedChange:
            stable &&
            issue.position.maxWithdrawRaw !== null &&
            score.positionAtTarget.maxWithdrawRaw !== null
              ? {
                  numeratorRaw: (
                    BigInt(score.positionAtTarget.maxWithdrawRaw) *
                      BigInt(issue.position.claimAssetsRaw) -
                    BigInt(issue.position.maxWithdrawRaw) *
                      BigInt(score.positionAtTarget.claimAssetsRaw)
                  ).toString(),
                  denominatorRaw: (
                    BigInt(issue.position.claimAssetsRaw) *
                    BigInt(score.positionAtTarget.claimAssetsRaw)
                  ).toString(),
                }
              : null,
        })
      }
  }
  return rows
}
const calldata = (name, args = []) => encodeFunctionData({ abi: ABI, functionName: name, args })
const call = (to, owner, name, args, source) => ({
  method: 'eth_call',
  params: [
    { to, from: owner, data: calldata(name, args) },
    { blockHash: source.blockHash, requireCanonical: true },
  ],
})
function configuredOrigins() {
  const env = readEnv(),
    urls = (
      process.env.RECORDER_RPC_URLS ||
      process.env.RECORDER_RPC_URL ||
      env.get('RECORDER_RPC_URLS') ||
      env.get('RECORDER_RPC_URL') ||
      ''
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  return HOSTS.map((host) => {
    const url = urls.find((u) => {
      try {
        return new URL(u).hostname === host
      } catch {
        return false
      }
    })
    check(url, 'configured_origin_missing')
    const u = new URL(url)
    check(u.protocol === 'https:' && !u.username && !u.password, 'configured_origin_invalid')
    return { host, url }
  })
}
export async function captureCapacityHistoryPair(
  candidate,
  origins,
  {
    fetcher = fetch,
    now = Date.now,
    maxRequests = 64,
    deadlineMs = 60000,
    simulateFullEntitlement = false,
  } = {},
) {
  check(candidate.locatorStatus === 'same_shares_candidate', 'candidate_not_complete')
  check(
    origins?.length === 2 &&
      origins.every((o, i) => {
        const url = new URL(o.url)
        return (
          o.host === HOSTS[i] &&
          url.hostname === HOSTS[i] &&
          url.protocol === 'https:' &&
          !url.username &&
          !url.password
        )
      }),
    'origins_invalid',
  )
  check(
    Number.isInteger(maxRequests) &&
      maxRequests >= 36 &&
      maxRequests <= 64 &&
      typeof simulateFullEntitlement === 'boolean' &&
      deadlineMs >= 1000 &&
      deadlineMs <= 60000,
    'budget_invalid',
  )
  const started = now(),
    deadline = started + deadlineMs,
    traces = [],
    controllers = new Set()
  let starts = 0
  const rates = new Map(
    HOSTS.map((host) => [
      host,
      { active: 0, waiting: [], launch: Promise.resolve(), lastStart: -Infinity },
    ]),
  )
  const acquire = async (host) => {
    const rate = rates.get(host)
    if (rate.active >= TRANSPORT_POLICY.maxInFlightPerOrigin)
      await new Promise((resolve) => rate.waiting.push(resolve))
    else rate.active++
    const release = () => {
      const next = rate.waiting.shift()
      if (next) next()
      else rate.active--
    }
    const launched = rate.launch.then(async () => {
      if (now() >= deadline || starts >= maxRequests) return
      let delay = TRANSPORT_POLICY.minStartSpacingMs + 1 - (performance.now() - rate.lastStart)
      while (delay > 0 && now() < deadline && starts < maxRequests) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.ceil(delay))))
        delay = TRANSPORT_POLICY.minStartSpacingMs + 1 - (performance.now() - rate.lastStart)
      }
      if (now() < deadline && starts < maxRequests) rate.lastStart = performance.now()
    })
    rate.launch = launched.catch(() => {})
    await launched
    return release
  }
  const rpc = async (origin, phase, request) => {
    const release = await acquire(origin.host)
    if (starts >= maxRequests || now() >= deadline) {
      release()
      return { unavailable: 'budget_exhausted' }
    }
    const id = ++starts,
      body = { jsonrpc: '2.0', id, ...request },
      controller = new AbortController()
    controllers.add(controller)
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, Math.min(TRANSPORT_POLICY.rpcTimeoutMs, deadline - now())),
    )
    const trace = {
      origin: origin.host,
      phase,
      request: body,
      startedAt: new Date(now()).toISOString(),
      response: null,
      transport: null,
    }
    traces.push(trace)
    try {
      rates.get(origin.host).lastStart = performance.now()
      const response = await fetcher(origin.url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      check(response.ok, 'http_unavailable')
      check(
        response.redirected !== true &&
          (!response.url || new URL(response.url).hostname === origin.host),
        'response_origin_mismatch',
      )
      const text = await boundedResponseText(response, controller, fetcher !== fetch)
      const raw = JSON.parse(text)
      check(raw?.jsonrpc === '2.0' && raw.id === id, 'rpc_envelope_invalid')
      if (raw.error) {
        trace.response = {
          jsonrpc: '2.0',
          id,
          error: {
            code: Number.isInteger(raw.error.code) ? raw.error.code : null,
            ...(typeof raw.error.data === 'string' && /^0x[0-9a-f]*$/i.test(raw.error.data)
              ? { data: raw.error.data }
              : {}),
          },
        }
      } else {
        check(Object.hasOwn(raw, 'result'), 'rpc_result_missing')
        trace.response = { jsonrpc: '2.0', id, result: raw.result }
      }
    } catch (error) {
      trace.transport =
        error?.message === 'response_oversize'
          ? 'response_oversize'
          : controller.signal.aborted
            ? 'timeout'
            : 'transport_unavailable'
    } finally {
      clearTimeout(timer)
      controllers.delete(controller)
      trace.completedAt = new Date(now()).toISOString()
      release()
    }
    return trace.response?.result
  }
  try {
    await Promise.all(
      origins.flatMap((o) => [
        rpc(o, 'chain', { method: 'eth_chainId', params: [] }),
        rpc(o, 'finalized', { method: 'eth_getBlockByNumber', params: ['finalized', false] }),
      ]),
    )
    await Promise.all(
      origins.flatMap((o) =>
        ['baseline', 'target'].map(async (name) => {
          const source = candidate[name].source,
            phase = `${name}:`,
            number = `0x${source.blockNumber.toString(16)}`
          await rpc(o, phase + 'header_before', {
            method: 'eth_getBlockByNumber',
            params: [number, false],
          })
          const readings = await Promise.all([
            rpc(
              o,
              phase + 'asset',
              call(candidate.destination, candidate.owner, 'asset', [], source),
            ),
            rpc(
              o,
              phase + 'asset_decimals',
              call(candidate.asset, candidate.owner, 'decimals', [], source),
            ),
            rpc(
              o,
              phase + 'share_decimals',
              call(candidate.destination, candidate.owner, 'decimals', [], source),
            ),
            rpc(
              o,
              phase + 'balance',
              call(candidate.destination, candidate.owner, 'balanceOf', [candidate.owner], source),
            ),
            rpc(
              o,
              phase + 'max',
              call(
                candidate.destination,
                candidate.owner,
                'maxWithdraw',
                [candidate.owner],
                source,
              ),
            ),
            rpc(o, phase + 'vault_code', {
              method: 'eth_getCode',
              params: [
                candidate.destination,
                { blockHash: source.blockHash, requireCanonical: true },
              ],
            }),
            rpc(o, phase + 'implementation_slot', {
              method: 'eth_getStorageAt',
              params: [
                candidate.destination,
                IMPLEMENTATION_SLOT,
                { blockHash: source.blockHash, requireCanonical: true },
              ],
            }),
            ...(simulateFullEntitlement
              ? [
                  rpc(o, phase + 'owner_code', {
                    method: 'eth_getCode',
                    params: [
                      candidate.owner,
                      { blockHash: source.blockHash, requireCanonical: true },
                    ],
                  }),
                ]
              : []),
          ])
          const implementation = implementationAddress(readings[6])
          const implementationRead = implementation
            ? rpc(o, phase + 'implementation_code', {
                method: 'eth_getCode',
                params: [implementation, { blockHash: source.blockHash, requireCanonical: true }],
              })
            : Promise.resolve()
          try {
            const shares = decodeFunctionResult({
              abi: ABI,
              functionName: 'balanceOf',
              data: readings[3],
            })
            const entitlementData = await rpc(
              o,
              phase + 'entitlement',
              call(candidate.destination, candidate.owner, 'previewRedeem', [shares], source),
            )
            if (simulateFullEntitlement) {
              const E = decodeFunctionResult({
                abi: ABI,
                functionName: 'previewRedeem',
                data: entitlementData,
              })
              if (E > 0n)
                await rpc(
                  o,
                  phase + 'withdraw_full_entitlement',
                  call(
                    candidate.destination,
                    candidate.owner,
                    'withdraw',
                    [E, candidate.owner, candidate.owner],
                    source,
                  ),
                )
            }
          } catch {
            /* Missing balance cannot produce an invented previewRedeem input. */
          }
          await implementationRead
          await rpc(o, phase + 'header_after', {
            method: 'eth_getBlockByNumber',
            params: [number, false],
          })
        }),
      ),
    )
  } finally {
    for (const c of controllers) c.abort()
  }
  const receipt = {
    version: CAPACITY_HISTORY_VERSION,
    candidate: structuredClone(candidate),
    startedAt: new Date(started).toISOString(),
    capturedAt: new Date(now()).toISOString(),
    budget: { maxRequests, deadlineMs, physicalRequestStarts: starts },
    simulateFullEntitlement,
    origins: [...HOSTS],
    originPolicy: 'fixed_configured_hostname_pair_no_active_health_witness',
    transportPolicy: TRANSPORT_POLICY,
    traces,
    interpretation: 'historical_getter_revalidation_not_execution_or_prospective_evidence',
  }
  return { ...receipt, sha256: sha(receipt) }
}

/** Raw replay against independently located old sources; sealed summaries never replace getter traces. */
export function replayCapacityHistoryPair(receipt, candidates) {
  const censored = (reason) => ({
    status: 'censored_historical_holder_getter_pair',
    reason,
    candidateId: receipt?.candidate?.id ?? null,
    captureReceiptSha256: receipt?.sha256 ?? null,
    capturedAt: receipt?.capturedAt ?? null,
    oldRequestedQProof: 'not_revalidated',
  })
  try {
    const { sha256, ...body } = receipt
    check(receipt.version === CAPACITY_HISTORY_VERSION && sha(body) === sha256, 'receipt_integrity')
    const candidate = candidates.find((c) => c.id === receipt.candidate?.id)
    check(
      candidate &&
        sha(candidate) === sha(receipt.candidate) &&
        candidate.locatorStatus === 'same_shares_candidate',
      'locator_binding',
    )
    check(
      utc(receipt.startedAt) &&
        utc(receipt.capturedAt) &&
        Date.parse(receipt.capturedAt) >= Date.parse(receipt.startedAt),
      'receipt_clock',
    )
    check(
      Number.isInteger(receipt.budget?.maxRequests) &&
        receipt.budget.maxRequests >= 36 &&
        receipt.budget.maxRequests <= 64 &&
        Number.isInteger(receipt.budget.deadlineMs) &&
        receipt.budget.deadlineMs >= 1000 &&
        receipt.budget.deadlineMs <= 60000 &&
        Array.isArray(receipt.traces) &&
        receipt.traces.length === receipt.budget.physicalRequestStarts &&
        receipt.traces.length <= receipt.budget.maxRequests,
      'budget_binding',
    )
    check(
      Array.isArray(receipt.origins) &&
        receipt.origins.length === 2 &&
        new Set(receipt.origins).size === 2 &&
        receipt.origins.every((host, i) => typeof host === 'string' && host === HOSTS[i]),
      'origin_binding',
    )
    check(
      JSON.stringify(receipt.transportPolicy) === JSON.stringify(TRANSPORT_POLICY) &&
        receipt.originPolicy === 'fixed_configured_hostname_pair_no_active_health_witness',
      'transport_policy_binding',
    )
    check(
      Date.parse(receipt.capturedAt) - Date.parse(receipt.startedAt) <=
        receipt.budget.deadlineMs + TRANSPORT_POLICY.cleanupGraceMs,
      'capture_duration',
    )
    const ids = new Set(),
      slots = new Set()
    for (const t of receipt.traces) {
      check(
        HOSTS.includes(t.origin) &&
          utc(t.startedAt) &&
          utc(t.completedAt) &&
          Date.parse(t.startedAt) >= Date.parse(receipt.startedAt) &&
          Date.parse(t.completedAt) >= Date.parse(t.startedAt) &&
          Date.parse(t.completedAt) - Date.parse(t.startedAt) <=
            TRANSPORT_POLICY.rpcTimeoutMs + TRANSPORT_POLICY.cleanupGraceMs &&
          Date.parse(t.completedAt) <= Date.parse(receipt.capturedAt) &&
          Date.parse(t.startedAt) < Date.parse(receipt.startedAt) + receipt.budget.deadlineMs,
        'trace_clock',
      )
      check(
        t.request?.jsonrpc === '2.0' &&
          Number.isSafeInteger(t.request.id) &&
          t.request.id > 0 &&
          t.request.id <= receipt.budget.physicalRequestStarts &&
          !ids.has(t.request.id),
        'trace_id',
      )
      ids.add(t.request.id)
      check(
        t.phase === 'chain' ||
          t.phase === 'finalized' ||
          /^(baseline|target):(header_before|header_after|asset|asset_decimals|share_decimals|balance|max|entitlement|vault_code|implementation_slot|implementation_code)$/.test(
            t.phase,
          ) ||
          (receipt.simulateFullEntitlement === true &&
            /^(baseline|target):(withdraw_full_entitlement|owner_code)$/.test(t.phase)),
        'unexpected_trace',
      )
      const slot = `${t.origin}:${t.phase}`
      check(!slots.has(slot), 'duplicate_trace')
      slots.add(slot)
      check(
        t.response === null || (t.response.jsonrpc === '2.0' && t.response.id === t.request.id),
        'response_binding',
      )
    }

    for (const host of HOSTS)
      for (const endpoint of ['baseline', 'target']) {
        const before = receipt.traces.find(
            (t) => t.origin === host && t.phase === endpoint + ':header_before',
          ),
          after = receipt.traces.find(
            (t) => t.origin === host && t.phase === endpoint + ':header_after',
          )
        const state = receipt.traces.filter(
          (t) =>
            t.origin === host &&
            t.phase.startsWith(endpoint + ':') &&
            !t.phase.startsWith(endpoint + ':header_'),
        )
        check(
          before &&
            after &&
            state.every(
              (t) =>
                Date.parse(t.startedAt) >= Date.parse(before.completedAt) &&
                Date.parse(t.completedAt) <= Date.parse(after.startedAt),
            ),
          'endpoint_order',
        )
        for (const parent of ['chain', 'finalized']) {
          const prerequisite = receipt.traces.find((t) => t.origin === host && t.phase === parent)
          check(
            prerequisite && Date.parse(prerequisite.completedAt) <= Date.parse(before.startedAt),
            'finality_order',
          )
        }
        for (const [child, parent] of [
          ['entitlement', 'balance'],
          ['implementation_code', 'implementation_slot'],
          ['withdraw_full_entitlement', 'entitlement'],
          ['withdraw_full_entitlement', 'owner_code'],
        ]) {
          const c = state.find((t) => t.phase === endpoint + ':' + child),
            p = state.find((t) => t.phase === endpoint + ':' + parent)
          if (c)
            check(
              p && Date.parse(c.startedAt) >= Date.parse(p.completedAt),
              'getter_dependency_order',
            )
        }
      }
    const get = (host, phase, expected) => {
      const t = receipt.traces.find((t) => t.origin === host && t.phase === phase)
      check(t, 'missing_trace')
      const { id, jsonrpc, ...request } = t.request
      check(JSON.stringify(request) === JSON.stringify(expected), 'request_binding')
      check(
        t.transport === null &&
          t.response &&
          !t.response.error &&
          Object.hasOwn(t.response, 'result'),
        'getter_unavailable',
      )
      return t.response.result
    }
    const snapshots = { baseline: [], target: [] }
    for (const host of HOSTS) {
      check(get(host, 'chain', { method: 'eth_chainId', params: [] }) === '0x1', 'chain_mismatch')
      const ceiling = header(
        get(host, 'finalized', { method: 'eth_getBlockByNumber', params: ['finalized', false] }),
      )
      check(Date.parse(ceiling.blockTime) <= Date.parse(receipt.capturedAt), 'finalized_future')
      for (const name of ['baseline', 'target']) {
        const source = candidate[name].source,
          number = `0x${source.blockNumber.toString(16)}`,
          phase = name + ':'
        const before = header(
            get(host, phase + 'header_before', {
              method: 'eth_getBlockByNumber',
              params: [number, false],
            }),
          ),
          after = header(
            get(host, phase + 'header_after', {
              method: 'eth_getBlockByNumber',
              params: [number, false],
            }),
          )
        check(
          sameHeader(before, source) &&
            sameHeader(after, source) &&
            source.blockNumber <= ceiling.blockNumber &&
            Date.parse(source.blockTime) <= Date.parse(ceiling.blockTime),
          'historical_header_mismatch',
        )
        const decode = (phaseName, to, name, args = []) => {
          const data = get(host, phase + phaseName, call(to, candidate.owner, name, args, source))
          const result = decodeFunctionResult({ abi: ABI, functionName: name, data })
          check(
            data.toLowerCase() ===
              encodeFunctionResult({ abi: ABI, functionName: name, result }).toLowerCase(),
            'noncanonical_getter_result',
          )
          return result
        }
        check(
          decode('asset', candidate.destination, 'asset').toLowerCase() === candidate.asset,
          'native_asset_mismatch',
        )
        check(
          Number(decode('asset_decimals', candidate.asset, 'decimals')) === candidate.assetDecimals,
          'native_units_mismatch',
        )
        const shares = decode('balance', candidate.destination, 'balanceOf', [
            candidate.owner,
          ]).toString(),
          shareDecimals = Number(decode('share_decimals', candidate.destination, 'decimals'))
        check(
          uint(shares) &&
            BigInt(shares) > 0n &&
            Number.isInteger(shareDecimals) &&
            shareDecimals <= 36,
          'invalid_position',
        )
        const entitlementRaw = decode('entitlement', candidate.destination, 'previewRedeem', [
          BigInt(shares),
        ]).toString()
        let quotedMaxWithdrawRaw = null,
          quotedMaxWithdrawStatus = 'unavailable'
        try {
          quotedMaxWithdrawRaw = decode('max', candidate.destination, 'maxWithdraw', [
            candidate.owner,
          ]).toString()
          check(uint(quotedMaxWithdrawRaw), 'invalid_max')
          quotedMaxWithdrawStatus = 'quoted'
        } catch (error) {
          if (error.message !== 'getter_unavailable') throw error
        }
        let fullEntitlementSimulation = {
          status: 'not_requested',
          requestedRaw: entitlementRaw,
          sharesBurnedRaw: null,
        }
        if (receipt.simulateFullEntitlement) {
          try {
            const ownerCode = get(host, phase + 'owner_code', {
              method: 'eth_getCode',
              params: [candidate.owner, { blockHash: source.blockHash, requireCanonical: true }],
            })
            check(ownerCode === '0x', 'owner_origin_unverified')
            const burned = decode('withdraw_full_entitlement', candidate.destination, 'withdraw', [
              BigInt(entitlementRaw),
              candidate.owner,
              candidate.owner,
            ]).toString()
            check(
              uint(burned) && BigInt(burned) > 0n && BigInt(burned) <= BigInt(shares),
              'invalid_burn',
            )
            fullEntitlementSimulation = {
              status: 'simulated',
              requestedRaw: entitlementRaw,
              sharesBurnedRaw: burned,
            }
          } catch (error) {
            if (
              error.message !== 'getter_unavailable' &&
              error.message !== 'missing_trace' &&
              error.message !== 'owner_origin_unverified'
            )
              throw error
            fullEntitlementSimulation = {
              status: 'unavailable',
              requestedRaw: entitlementRaw,
              sharesBurnedRaw: null,
            }
          }
        }
        const optionalRead = (phaseName, request) => {
          try {
            return get(host, phase + phaseName, request)
          } catch (error) {
            if (error.message !== 'getter_unavailable' && error.message !== 'missing_trace')
              throw error
            return null
          }
        }
        const vaultCode = optionalRead('vault_code', {
          method: 'eth_getCode',
          params: [candidate.destination, { blockHash: source.blockHash, requireCanonical: true }],
        })
        const implementationSlotRaw = optionalRead('implementation_slot', {
          method: 'eth_getStorageAt',
          params: [
            candidate.destination,
            IMPLEMENTATION_SLOT,
            { blockHash: source.blockHash, requireCanonical: true },
          ],
        })
        const implementation = implementationAddress(implementationSlotRaw)
        const implementationCode = implementation
          ? optionalRead('implementation_code', {
              method: 'eth_getCode',
              params: [implementation, { blockHash: source.blockHash, requireCanonical: true }],
            })
          : null
        check(
          vaultCode === null ||
            (typeof vaultCode === 'string' && /^0x(?:[0-9a-f]{2})+$/.test(vaultCode)),
          'vault_code_invalid',
        )
        check(
          implementationSlotRaw === null ||
            (typeof implementationSlotRaw === 'string' &&
              /^0x[0-9a-f]{64}$/.test(implementationSlotRaw)),
          'implementation_slot_invalid',
        )
        check(
          implementationCode === null ||
            (typeof implementationCode === 'string' &&
              /^0x(?:[0-9a-f]{2})*$/.test(implementationCode)),
          'implementation_code_invalid',
        )
        const mechanismIdentity = {
          vaultRuntimeCodeHash: codeHash(vaultCode),
          implementationSlotRaw,
          implementationAddress: implementation,
          implementationCodeHash: codeHash(implementationCode),
        }
        const measured = {
          mechanismIdentity,
          fullEntitlementSimulation,
          source: { chainId: 1, ...source, finalized: true },
          sharesRaw: shares,
          shareDecimals,
          entitlementRaw,
          entitlementMethod: 'preview_redeem_full_position',
          quotedMaxWithdrawRaw,
          quotedMaxWithdrawStatus,
          quotedLimitMethod:
            quotedMaxWithdrawStatus === 'quoted' ? 'max_withdraw_owner' : 'unavailable',
        }
        snapshots[name].push(measured)
      }
    }
    for (const name of ['baseline', 'target']) {
      const { fullEntitlementSimulation: a, ...first } = snapshots[name][0]
      const { fullEntitlementSimulation: b, ...second } = snapshots[name][1]
      check(JSON.stringify(first) === JSON.stringify(second), 'origin_disagreement')
      snapshots[name][0].fullEntitlementSimulation =
        JSON.stringify(a) === JSON.stringify(b)
          ? a
          : {
              status: 'origin_disagreement',
              requestedRaw: first.entitlementRaw,
              originOutcomes: [a, b],
            }
    }
    const baseline = snapshots.baseline[0],
      target = snapshots.target[0]
    check(
      baseline.sharesRaw === target.sharesRaw && baseline.shareDecimals === target.shareDecimals,
      'position_changed',
    )
    check(
      baseline.source.blockNumber < target.source.blockNumber &&
        Date.parse(baseline.source.blockTime) < Date.parse(target.source.blockTime),
      'unordered_sources',
    )
    const bIdentity = baseline.mechanismIdentity,
      tIdentity = target.mechanismIdentity
    const identityComplete = [bIdentity, tIdentity].every(
      (i) => i.vaultRuntimeCodeHash && i.implementationAddress && i.implementationCodeHash,
    )
    const mechanismContinuity = !identityComplete
      ? 'unknown'
      : JSON.stringify(bIdentity) === JSON.stringify(tIdentity)
        ? 'same_observed_eip1967_identity'
        : 'changed'
    const summaryComparison = ['baseline', 'target'].map((name) => ({
      endpoint: name,
      sharesMatch: snapshots[name][0].sharesRaw === candidate[name].summary?.sharesRaw,
      entitlementMatch:
        snapshots[name][0].entitlementRaw === candidate[name].summary?.claimAssetsRaw,
      maxWithdrawMatch:
        snapshots[name][0].quotedMaxWithdrawRaw === candidate[name].summary?.maxWithdrawRaw,
    }))
    const positive = BigInt(baseline.entitlementRaw) > 0n && BigInt(target.entitlementRaw) > 0n
    const quoted =
      baseline.quotedMaxWithdrawStatus === 'quoted' && target.quotedMaxWithdrawStatus === 'quoted'
    const Eb = BigInt(baseline.entitlementRaw),
      Et = BigInt(target.entitlementRaw)
    return {
      status:
        positive && quoted
          ? 'verified_historical_holder_getter_pair'
          : 'censored_historical_holder_getter_pair',
      reason: !positive ? 'zero_entitlement' : !quoted ? 'max_getter_unavailable' : null,
      semantics: 'conditional_getter_quote_movement',
      mechanismContinuity,
      sameObservedContractIdentity: mechanismContinuity === 'same_observed_eip1967_identity',
      mechanismSourceSemantics: 'implementation_source_unattested',
      mechanism: 'fluid_ftoken_atomic',
      routeKey: candidate.routeKey,
      destination: candidate.destination,
      owner: candidate.owner,
      asset: candidate.asset,
      assetDecimals: candidate.assetDecimals,
      sharesRaw: baseline.sharesRaw,
      plannedHorizonHours: candidate.plannedHorizonHours,
      actualElapsedSeconds:
        (Date.parse(target.source.blockTime) - Date.parse(baseline.source.blockTime)) / 1000,
      baseline,
      target,
      summaryComparison,
      normalizedChange:
        positive && quoted
          ? {
              numeratorRaw: (
                BigInt(target.quotedMaxWithdrawRaw) * Eb -
                BigInt(baseline.quotedMaxWithdrawRaw) * Et
              ).toString(),
              denominatorRaw: (Et * Eb).toString(),
            }
          : null,
      capturedAt: receipt.capturedAt,
      knowledgeCutoff: receipt.capturedAt,
      captureReceiptSha256: sha256,
      oldRequestedQProof: 'not_revalidated',
      successfulRequestedRawLowerBound: null,
      fullEntitlementSourceSimulationsVerified:
        baseline.fullEntitlementSimulation.status === 'simulated' &&
        target.fullEntitlementSimulation.status === 'simulated',
      implementationSourceAttested: false,
      aggregateAccessibleLiquidityRaw: null,
      hypotheticalDepositCapacityRaw: null,
      futureCapacityForecast: false,
      forecastValidated: false,
      holderExecutableExit: false,
      prospectiveValidated: false,
      minedPayoutObserved: false,
    }
  } catch (error) {
    return censored(/^[a-z_]+$/.test(error.message) ? error.message : 'malformed_getter_response')
  }
}
function reserveDisk(file, bytes) {
  let parent = dirname(resolve(file))
  while (!existsSync(parent)) parent = dirname(parent)
  const stat = statfsSync(parent, { bigint: true })
  check(stat.bavail * stat.bsize - BigInt(bytes) >= (5n * 1024n ** 3n) / 4n, 'disk_reserve')
}
function appendProof(file, value) {
  const bytes = JSON.stringify(value) + '\n'
  check(Buffer.byteLength(bytes) <= 9 * 1024 * 1024, 'receipt_oversize')
  reserveDisk(file, Buffer.byteLength(bytes))
  mkdirSync(dirname(resolve(file)), { recursive: true })
  writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 })
}
async function main() {
  const [mode, ...args] = process.argv.slice(2)
  const option = (name) => args[args.indexOf(name) + 1]
  const candidates = locateCapacityHistoryCandidates()
  if (mode === 'list') {
    console.log(
      JSON.stringify({
        candidates: candidates.length,
        sameShares: candidates.filter((c) => c.locatorStatus === 'same_shares_candidate').length,
        oldSummaryConstantRatioPairs: candidates.filter(
          (c) => c.oldSummaryNormalizedChange?.numeratorRaw === '0',
        ).length,
        summarySemantics: 'unproved_candidate_getters_not_shrink_recovery_or_forecast',
        byRoute: ROUTES.map((r, i) => ({
          routeIndex: i,
          routeKey: r.key,
          candidates: candidates
            .filter((c) => c.routeIndex === i && c.locatorStatus === 'same_shares_candidate')
            .map((c) => ({
              id: c.id,
              horizon: c.plannedHorizonHours,
              baselineBlock: c.baseline.source.blockNumber,
              targetBlock: c.target.source.blockNumber,
            })),
        })),
      }),
    )
    return
  }
  if (mode === 'capture') {
    const index = Number(option('--route')),
      candidate = candidates.find(
        (c) =>
          c.routeIndex === index &&
          c.locatorStatus === 'same_shares_candidate' &&
          (!args.includes('--candidate') || c.id === option('--candidate')),
      )
    check(candidate, 'candidate_missing')
    const output = option('--output')
    check(output && args.includes('--output'), 'output_required')
    check(!existsSync(output) && !existsSync(output + '.export.json'), 'output_exists')
    reserveDisk(output, 9 * 1024 * 1024)
    const receipt = await captureCapacityHistoryPair(candidate, configuredOrigins(), {
      simulateFullEntitlement: args.includes('--simulate-full-entitlement'),
    })
    appendProof(output, receipt)
    const replay = replayCapacityHistoryPair(receipt, candidates)
    appendProof(output + '.export.json', replay)
    console.log(
      JSON.stringify({
        receipt: resolve(output),
        export: resolve(output + '.export.json'),
        status: replay.status,
        reason: replay.reason,
        requestStarts: receipt.budget.physicalRequestStarts,
      }),
    )
    return
  }
  if (mode === 'replay') {
    const input = option('--input')
    check(input && args.includes('--input'), 'input_required')
    check(
      statSync(input).isFile() && statSync(input).size <= 9 * 1024 * 1024,
      'receipt_file_invalid',
    )
    const receipt = JSON.parse(readFileSync(input, 'utf8')),
      result = replayCapacityHistoryPair(receipt, candidates)
    if (args.includes('--output')) appendProof(option('--output'), result)
    console.log(JSON.stringify(result))
    return
  }
  throw Error('usage_list_capture_replay')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error('capacity_history_command_failed')
    process.exitCode = 1
  })
