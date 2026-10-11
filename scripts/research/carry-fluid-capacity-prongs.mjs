// Parent-authorized capture only. Default CLI and --check-only never call RPC.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statfsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  decodeFunctionResult,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  parseAbi,
} from 'viem'
import * as fluidModule from '../../lib/carry/fluidExitCapacity.ts'
const pick = (name) => fluidModule[name] ?? fluidModule.default?.[name]
const agreeFluidExitCapacity = pick('agreeFluidExitCapacity')
const isFluidExitCapacitySubject = pick('isFluidExitCapacitySubject')
const FLUID_LIQUIDITY = pick('FLUID_LIQUIDITY')
const FLUID_LIQUIDITY_RESOLVER = pick('FLUID_LIQUIDITY_RESOLVER')
const FLUID_CAPACITY_ORIGIN_HOSTS = pick('FLUID_CAPACITY_ORIGIN_HOSTS')
const SOURCE_CITATIONS = Object.freeze({
  resolverAbi: 'https://etherscan.io/address/0xca13A15de31235A37134B4717021C35A3CF25C60#code',
  deploymentRegistry:
    'https://github.com/Instadapp/fluid-contracts-public/blob/main/deployments/deployments.md',
  referenceFToken:
    'https://github.com/Instadapp/fluid-contracts-public/blob/d96dad8960144f26580bda246f64d4555702da94/contracts/protocols/lending/fToken/main.sol',
})
import { configuredProviders, readProviderPolicy } from './carry-depth-quote-archive.mjs'
import { readEnv } from '../lib/venue-reads.mjs'
export const FLUID_CAPACITY_POLICY = Object.freeze({
  maxRequests: 64,
  rpcTimeoutMs: 8000,
  cleanupGraceMs: 250,
  deadlineMs: 60000,
  maxResponseBytes: 128 * 1024,
  maxInFlightPerHost: 2,
  minStartSpacingMs: 50,
  reserveBytes: 1342177280,
})
const check = (ok, code) => {
  if (!ok) throw Object.assign(new Error(code), { safeCode: code })
}
const sha = (v) => createHash('sha256').update(v).digest('hex')
const ADDRESS = /^0x[0-9a-f]{40}$/,
  HASH = /^0x[0-9a-f]{64}$/
const BASE_ABI = parseAbi([
  'function asset() view returns(address)',
  'function decimals() view returns(uint8)',
  'function balanceOf(address) view returns(uint256)',
  'function getData() view returns(address liquidity,address factory,address rewards,address permit2,address rebalancer,bool rewardsActive,uint256 liquidityBalance,uint256 liquidityExchangePrice,uint256 tokenExchangePrice)',
])
export const FLUID_RESOLVER_ABI = [
  {
    inputs: [],
    name: 'LIQUIDITY',
    outputs: [
      {
        internalType: 'contract IFluidLiquidity',
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'user_',
        type: 'address',
      },
      {
        internalType: 'address',
        name: 'token_',
        type: 'address',
      },
    ],
    name: 'getUserSupplyData',
    outputs: [
      {
        components: [
          {
            internalType: 'bool',
            name: 'modeWithInterest',
            type: 'bool',
          },
          {
            internalType: 'uint256',
            name: 'supply',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'withdrawalLimit',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'lastUpdateTimestamp',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'expandPercent',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'expandDuration',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'baseWithdrawalLimit',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'withdrawableUntilLimit',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'withdrawable',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'decayEndTimestamp',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'decayAmount',
            type: 'uint256',
          },
        ],
        internalType: 'struct Structs.UserSupplyData',
        name: 'userSupplyData_',
        type: 'tuple',
      },
      {
        components: [
          {
            internalType: 'uint256',
            name: 'borrowRate',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'supplyRate',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'fee',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'lastStoredUtilization',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'storageUpdateThreshold',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'lastUpdateTimestamp',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'supplyExchangePrice',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'borrowExchangePrice',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'supplyRawInterest',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'supplyInterestFree',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'borrowRawInterest',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'borrowInterestFree',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'totalSupply',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'totalBorrow',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'revenue',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'maxUtilization',
            type: 'uint256',
          },
          {
            components: [
              {
                internalType: 'uint256',
                name: 'version',
                type: 'uint256',
              },
              {
                components: [
                  {
                    internalType: 'address',
                    name: 'token',
                    type: 'address',
                  },
                  {
                    internalType: 'uint256',
                    name: 'kink',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'rateAtUtilizationZero',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'rateAtUtilizationKink',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'rateAtUtilizationMax',
                    type: 'uint256',
                  },
                ],
                internalType: 'struct Structs.RateDataV1Params',
                name: 'rateDataV1',
                type: 'tuple',
              },
              {
                components: [
                  {
                    internalType: 'address',
                    name: 'token',
                    type: 'address',
                  },
                  {
                    internalType: 'uint256',
                    name: 'kink1',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'kink2',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'rateAtUtilizationZero',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'rateAtUtilizationKink1',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'rateAtUtilizationKink2',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'rateAtUtilizationMax',
                    type: 'uint256',
                  },
                ],
                internalType: 'struct Structs.RateDataV2Params',
                name: 'rateDataV2',
                type: 'tuple',
              },
            ],
            internalType: 'struct Structs.RateData',
            name: 'rateData',
            type: 'tuple',
          },
        ],
        internalType: 'struct Structs.OverallTokenData',
        name: 'overallTokenData_',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
]
export const FLUID_CAPACITY_ABI = [...BASE_ABI, ...FLUID_RESOLVER_ABI]
const native = (v) => typeof v === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(v)
const canonical = (abi, name, result) => {
  check(native(result), 'call_result_invalid')
  const decoded = decodeFunctionResult({ abi, functionName: name, data: result })
  check(
    encodeFunctionResult({ abi, functionName: name, result: decoded }).toLowerCase() ===
      result.toLowerCase(),
    'call_result_noncanonical',
  )
  return decoded
}
const header = (r) => {
  check(
    r &&
      typeof r === 'object' &&
      !Array.isArray(r) &&
      typeof r.hash === 'string' &&
      HASH.test(r.hash) &&
      typeof r.number === 'string' &&
      /^0x[0-9a-f]+$/.test(r.number) &&
      typeof r.timestamp === 'string' &&
      /^0x[0-9a-f]+$/.test(r.timestamp),
    'header_invalid',
  )
  const blockNumber = Number(BigInt(r.number)),
    time = Number(BigInt(r.timestamp)) * 1000
  check(
    Number.isSafeInteger(blockNumber) && blockNumber > 0 && Number.isSafeInteger(time),
    'header_overflow',
  )
  return {
    chainId: 1,
    blockNumber,
    blockHash: r.hash,
    blockTime: new Date(time).toISOString(),
    finalized: true,
  }
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
async function settledPair(jobs) {
  const results = await Promise.allSettled(jobs)
  const failed = results.find((r) => r.status === 'rejected')
  if (failed) throw failed.reason
  return results.map((r) => r.value)
}
function validateSubject(s) {
  check(isFluidExitCapacitySubject(s), 'subject_not_canonical')
  check(
    Object.keys(s).length === 4 &&
      Object.keys(s).every((k) =>
        ['routeKey', 'destination', 'asset', 'assetDecimals'].includes(k),
      ),
    'subject_keys_invalid',
  )
  check(
    s &&
      typeof s === 'object' &&
      !Array.isArray(s) &&
      typeof s.routeKey === 'string' &&
      typeof s.destination === 'string' &&
      ADDRESS.test(s.destination) &&
      typeof s.asset === 'string' &&
      ADDRESS.test(s.asset) &&
      Number.isInteger(s.assetDecimals),
    'subject_invalid',
  )
  // Central issued registry/native binding is also checked by the pure agreement after decoding.
  check(
    ['USDC → Fluid USD Coin [USDC]', 'USDT → fToken [USDT]', 'GHO → fToken [GHO]'].includes(
      s.routeKey,
    ),
    'subject_unsupported',
  )
}
function validateSource(s) {
  check(
    s &&
      typeof s === 'object' &&
      !Array.isArray(s) &&
      Object.keys(s).length === 5 &&
      Object.keys(s).every((k) =>
        ['chainId', 'blockNumber', 'blockHash', 'blockTime', 'finalized'].includes(k),
      ),
    'source_keys_invalid',
  )
  check(
    s &&
      s.chainId === 1 &&
      s.finalized === true &&
      Number.isSafeInteger(s.blockNumber) &&
      s.blockNumber > 0 &&
      typeof s.blockHash === 'string' &&
      HASH.test(s.blockHash) &&
      typeof s.blockTime === 'string' &&
      Number.isSafeInteger(Date.parse(s.blockTime)) &&
      new Date(Date.parse(s.blockTime)).toISOString() === s.blockTime,
    'source_invalid',
  )
}
async function boundedResponseText(response, controller) {
  check(response.body?.getReader, 'response_stream_unavailable')
  const reader = response.body.getReader(),
    chunks = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      check(bytes <= FLUID_CAPACITY_POLICY.maxResponseBytes, 'response_oversize')
      chunks.push(value)
    }
    return Buffer.concat(
      chunks.map((c) => Buffer.from(c)),
      bytes,
    ).toString('utf8')
  } catch (error) {
    controller.abort()
    void reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
}
/** No global fetch/env mutation; historical source clocks are independently checked, never retimed. */
export async function captureFluidCapacityProngs(
  subject,
  origins,
  {
    source: requestedSource,
    fetcher = fetch,
    now = Date.now,
    maxRequests = 64,
    deadlineMs = 60000,
  } = {},
) {
  validateSubject(subject)
  if (requestedSource) validateSource(requestedSource)
  if (requestedSource) check(Date.parse(requestedSource.blockTime) <= now(), 'source_future')
  check(
    Array.isArray(origins) &&
      origins.length === 2 &&
      new Set(origins.map((o) => o.host)).size === 2 &&
      origins.every((o) => {
        try {
          const u = new URL(o.url)
          return (
            /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(o.host) &&
            FLUID_CAPACITY_ORIGIN_HOSTS.includes(o.host) &&
            u.hostname === o.host &&
            u.protocol === 'https:' &&
            !u.username &&
            !u.password
          )
        } catch {
          return false
        }
      }),
    'origins_invalid',
  )
  check(
    Number.isSafeInteger(maxRequests) &&
      maxRequests >= 28 &&
      maxRequests <= 64 &&
      Number.isSafeInteger(deadlineMs) &&
      deadlineMs >= 1000 &&
      deadlineMs <= 60000,
    'budget_invalid',
  )
  const started = now(),
    deadline = started + deadlineMs,
    traces = [],
    controllers = new Set(),
    lastStart = new Map()
  let starts = 0
  const rpc = async (o, phase, request) => {
    const wait = 51 - (performance.now() - (lastStart.get(o.host) ?? -Infinity))
    if (wait > 0) await new Promise((r) => setTimeout(r, Math.ceil(wait)))
    check(now() < deadline && starts < maxRequests, 'budget_exhausted')
    lastStart.set(o.host, performance.now())
    const id = ++starts,
      body = { jsonrpc: '2.0', id, ...request },
      controller = new AbortController()
    controllers.add(controller)
    const trace = {
      host: o.host,
      phase,
      request: body,
      startedAt: new Date(now()).toISOString(),
      completedAt: null,
      response: null,
      transport: null,
    }
    traces.push(trace)
    let abortTimer, cleanupTimer
    const timeout = Math.max(1, Math.min(8000, deadline - now()))
    const operation = (async () => {
      const response = await fetcher(o.url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      check(
        response.ok &&
          !response.redirected &&
          (!response.url || new URL(response.url).hostname === o.host),
        'http_origin_unavailable',
      )
      const raw = JSON.parse(await boundedResponseText(response, controller))
      check(raw?.jsonrpc === '2.0' && raw.id === id, 'rpc_envelope_invalid')
      if (raw.error) {
        trace.response = {
          jsonrpc: '2.0',
          id,
          error: { code: Number.isSafeInteger(raw.error.code) ? raw.error.code : null },
        }
        throw Object.assign(Error('rpc_error'), { safeCode: 'rpc_error' })
      }
      check(Object.hasOwn(raw, 'result'), 'rpc_result_missing')
      trace.response = { jsonrpc: '2.0', id, result: raw.result }
      return raw.result
    })()
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => {
          abortTimer = setTimeout(() => {
            controller.abort()
            cleanupTimer = setTimeout(
              () => reject(Object.assign(Error('rpc_timeout'), { safeCode: 'rpc_timeout' })),
              250,
            )
          }, timeout)
        }),
      ])
    } catch (error) {
      trace.transport = error.safeCode ?? 'transport_unavailable'
      throw Object.assign(Error(trace.transport), { safeCode: trace.transport })
    } finally {
      clearTimeout(abortTimer)
      clearTimeout(cleanupTimer)
      controller.abort()
      controllers.delete(controller)
      trace.completedAt = new Date(now()).toISOString()
    }
  }
  const call = (o, phase, to, name, args, s) =>
    rpc(o, phase, {
      method: 'eth_call',
      params: [
        { to, data: encodeFunctionData({ abi: FLUID_CAPACITY_ABI, functionName: name, args }) },
        { blockHash: s.blockHash, requireCanonical: true },
      ],
    })
  try {
    const heads = await settledPair(
      origins.map(async (o) => {
        check(
          (await rpc(o, 'chain', { method: 'eth_chainId', params: [] })) === '0x1',
          'chain_mismatch',
        )
        return header(
          await rpc(o, 'finalized', {
            method: 'eth_getBlockByNumber',
            params: ['finalized', false],
          }),
        )
      }),
    )
    const block = requestedSource?.blockNumber ?? Math.min(...heads.map((h) => h.blockNumber))
    check(
      heads.every((h) => h.blockNumber >= block),
      'source_not_finalized',
    )
    const snapshots = await settledPair(
      origins.map(async (o) => {
        const s = header(
          await rpc(o, 'header_before', {
            method: 'eth_getBlockByNumber',
            params: ['0x' + block.toString(16), false],
          }),
        )
        if (requestedSource) check(equal(s, requestedSource), 'source_header_mismatch')
        check(
          heads.every((head) => head.blockNumber !== s.blockNumber || equal(head, s)),
          'finalized_header_conflict',
        )
        if (!requestedSource)
          check(
            now() >= Date.parse(s.blockTime) && now() - Date.parse(s.blockTime) <= 1800000,
            'current_source_stale',
          )
        const pin = { blockHash: s.blockHash, requireCanonical: true }
        for (const address of [
          subject.destination,
          subject.asset,
          FLUID_LIQUIDITY,
          FLUID_LIQUIDITY_RESOLVER,
        ]) {
          await rpc(o, 'code:' + address, { method: 'eth_getCode', params: [address, pin] })
        }
        await call(o, 'asset', subject.destination, 'asset', [], s)
        await call(o, 'decimals', subject.asset, 'decimals', [], s)
        await call(o, 'getData', subject.destination, 'getData', [], s)
        await call(o, 'resolver_liquidity', FLUID_LIQUIDITY_RESOLVER, 'LIQUIDITY', [], s)
        await call(
          o,
          'supplyData',
          FLUID_LIQUIDITY_RESOLVER,
          'getUserSupplyData',
          [subject.destination, subject.asset],
          s,
        )
        await call(o, 'cash', subject.asset, 'balanceOf', [FLUID_LIQUIDITY], s)
        const after = header(
          await rpc(o, 'header_after', {
            method: 'eth_getBlockByNumber',
            params: ['0x' + block.toString(16), false],
          }),
        )
        check(equal(s, after), 'header_changed')
        if (!requestedSource)
          check(
            now() >= Date.parse(s.blockTime) && now() - Date.parse(s.blockTime) <= 1800000,
            'current_source_expired',
          )
        return s
      }),
    )
    check(equal(snapshots[0], snapshots[1]), 'source_disagreement')
    const receipt = {
      schema: 'fluid_protocol_capacity_prongs_v1',
      subject,
      mode: requestedSource ? 'historical_exact_header' : 'current_finalized',
      source: snapshots[0],
      capturedAt: new Date(now()).toISOString(),
      startedAt: new Date(started).toISOString(),
      origins: origins.map((o) => o.host),
      budget: { ...FLUID_CAPACITY_POLICY, maxRequests, deadlineMs, physicalRequestStarts: starts },
      traces,
      sourceEvidence: {
        candidateSourceReferences: SOURCE_CITATIONS,
        resolverAbiSha256: sha(JSON.stringify(FLUID_RESOLVER_ABI)),
        runtimeSourceEquivalenceVerified: false,
      },
    }
    receipt.prongs = replayFluidCapacityProngs(receipt, subject, requestedSource)
    receipt.sha256 = sha(JSON.stringify(receipt))
    return receipt
  } catch (error) {
    const failedReceipt = {
      schema: 'fluid_protocol_capacity_prongs_failure_v1',
      status: 'unavailable',
      reason: error.safeCode ?? 'capture_failed',
      subject,
      requestedSource: requestedSource ?? null,
      mode: requestedSource ? 'historical_exact_header' : 'current_finalized',
      startedAt: new Date(started).toISOString(),
      capturedAt: new Date(now()).toISOString(),
      origins: origins.map((o) => o.host),
      budget: { ...FLUID_CAPACITY_POLICY, maxRequests, deadlineMs, physicalRequestStarts: starts },
      traces,
    }
    failedReceipt.sha256 = sha(JSON.stringify(failedReceipt))
    throw Object.assign(error, { failedReceipt })
  } finally {
    for (const c of controllers) c.abort()
  }
}
export function replayFluidCapacityProngs(receipt, subject, expectedSource) {
  if (receipt.sha256 !== undefined) {
    const { sha256, ...body } = receipt
    check(
      typeof sha256 === 'string' && sha(JSON.stringify(body)) === sha256,
      'receipt_seal_invalid',
    )
  }
  validateSubject(subject)
  validateSource(receipt.source)
  check(
    ['historical_exact_header', 'current_finalized'].includes(receipt.mode),
    'receipt_mode_invalid',
  )
  check(
    receipt.sourceEvidence?.runtimeSourceEquivalenceVerified === false &&
      equal(receipt.sourceEvidence.candidateSourceReferences, SOURCE_CITATIONS) &&
      receipt.sourceEvidence.resolverAbiSha256 === sha(JSON.stringify(FLUID_RESOLVER_ABI)),
    'source_equivalence_unproved',
  )
  if (expectedSource) check(equal(receipt.source, expectedSource), 'source_binding')
  check(
    receipt.schema === 'fluid_protocol_capacity_prongs_v1' &&
      equal(receipt.subject, subject) &&
      Array.isArray(receipt.origins) &&
      receipt.origins.length === 2 &&
      receipt.origins.every((host) => FLUID_CAPACITY_ORIGIN_HOSTS.includes(host)) &&
      new Set(receipt.origins).size === 2,
    'receipt_invalid',
  )
  check(
    Array.isArray(receipt.traces) &&
      receipt.traces.length === receipt.budget.physicalRequestStarts &&
      receipt.traces.length <= 64 &&
      typeof receipt.startedAt === 'string' &&
      new Date(Date.parse(receipt.startedAt)).toISOString() === receipt.startedAt &&
      typeof receipt.capturedAt === 'string' &&
      new Date(Date.parse(receipt.capturedAt)).toISOString() === receipt.capturedAt &&
      Date.parse(receipt.capturedAt) >= Date.parse(receipt.startedAt) &&
      Date.parse(receipt.capturedAt) - Date.parse(receipt.startedAt) <=
        receipt.budget.deadlineMs + 250,
    'receipt_budget_invalid',
  )
  const ids = new Set()
  const budget = receipt.budget
  check(
    budget &&
      typeof budget === 'object' &&
      !Array.isArray(budget) &&
      Object.keys(budget).length === Object.keys(FLUID_CAPACITY_POLICY).length + 1 &&
      Object.keys(FLUID_CAPACITY_POLICY).every(
        (k) => ['maxRequests', 'deadlineMs'].includes(k) || budget[k] === FLUID_CAPACITY_POLICY[k],
      ) &&
      Number.isSafeInteger(budget.maxRequests) &&
      budget.maxRequests >= 28 &&
      budget.maxRequests <= 64 &&
      Number.isSafeInteger(budget.deadlineMs) &&
      budget.deadlineMs >= 1000 &&
      budget.deadlineMs <= 60000 &&
      receipt.traces.length <= budget.maxRequests,
    'budget_policy_invalid',
  )
  const startedMs = Date.parse(receipt.startedAt),
    capturedMs = Date.parse(receipt.capturedAt)
  let previousStart = startedMs
  const perHost = new Map()
  for (const t of receipt.traces) {
    const start = typeof t.startedAt === 'string' ? Date.parse(t.startedAt) : NaN
    const end = typeof t.completedAt === 'string' ? Date.parse(t.completedAt) : NaN
    check(
      Number.isSafeInteger(start) &&
        Number.isSafeInteger(end) &&
        new Date(start).toISOString() === t.startedAt &&
        new Date(end).toISOString() === t.completedAt &&
        start >= previousStart &&
        start >= startedMs &&
        start < startedMs + budget.deadlineMs &&
        end >= start &&
        end <= capturedMs &&
        end <= startedMs + budget.deadlineMs + 250 &&
        end - start <= 8250,
      'trace_clock_invalid',
    )
    previousStart = start
    const hostTraces = perHost.get(t.host) ?? []
    if (hostTraces.length)
      check(start - Date.parse(hostTraces.at(-1).startedAt) >= 50, 'trace_spacing_invalid')
    check(
      hostTraces.filter((prior) => Date.parse(prior.completedAt) > start).length < 2,
      'trace_parallelism_invalid',
    )
    hostTraces.push(t)
    perHost.set(t.host, hostTraces)
    check(
      receipt.origins.includes(t.host) &&
        Number.isSafeInteger(t.request.id) &&
        t.request.id === ids.size + 1 &&
        !ids.has(t.request.id) &&
        t.request.jsonrpc === '2.0' &&
        t.response?.jsonrpc === '2.0' &&
        t.response.id === t.request.id &&
        !t.response.error &&
        t.transport === null,
      'trace_invalid',
    )
    ids.add(t.request.id)
  }
  const source = receipt.source,
    pin = { blockHash: source.blockHash, requireCanonical: true }
  const reports = receipt.origins.map((host) => {
    const hostRows = receipt.traces.filter((t) => t.host === host)
    const phase = (name) => {
      const rows = hostRows.filter((t) => t.phase === name)
      check(rows.length === 1, 'phase_missing_or_duplicate')
      return rows[0]
    }
    check(
      Date.parse(phase('chain').completedAt) <= Date.parse(phase('finalized').startedAt) &&
        Date.parse(phase('finalized').completedAt) <= Date.parse(phase('header_before').startedAt),
      'setup_order_invalid',
    )
    const beforeEnd = Date.parse(phase('header_before').completedAt),
      afterStart = Date.parse(phase('header_after').startedAt)
    check(
      hostRows
        .filter((t) => ['eth_call', 'eth_getCode'].includes(t.request.method))
        .every(
          (t) => Date.parse(t.startedAt) >= beforeEnd && Date.parse(t.completedAt) <= afterStart,
        ),
      'header_enclosure_invalid',
    )
    const used = new Set(),
      get = (phase, request) => {
        const matches = receipt.traces.filter((t) => t.host === host && t.phase === phase)
        check(matches.length === 1, 'phase_missing_or_duplicate')
        const t = matches[0]
        used.add(t)
        const { id, jsonrpc, ...actual } = t.request
        check(equal(actual, request), 'request_binding')
        return t.response.result
      }
    check(get('chain', { method: 'eth_chainId', params: [] }) === '0x1', 'chain_mismatch')
    const finalized = header(
      get('finalized', { method: 'eth_getBlockByNumber', params: ['finalized', false] }),
    )
    check(finalized.blockNumber >= source.blockNumber, 'source_not_finalized')
    check(
      finalized.blockNumber !== source.blockNumber || equal(finalized, source),
      'finalized_header_conflict',
    )
    const block = '0x' + source.blockNumber.toString(16)
    for (const phase of ['header_before', 'header_after'])
      check(
        equal(
          header(get(phase, { method: 'eth_getBlockByNumber', params: [block, false] })),
          source,
        ),
        'header_mismatch',
      )
    const identities = [
      subject.destination,
      subject.asset,
      FLUID_LIQUIDITY,
      FLUID_LIQUIDITY_RESOLVER,
    ].map((address) => {
      const code = get('code:' + address, { method: 'eth_getCode', params: [address, pin] })
      check(native(code), 'code_empty')
      const implementationAddress = null,
        implementationCodeHash = null,
        beaconAddress = null

      return {
        address,
        codeHash: keccak256(code),
        implementationAddress,
        implementationCodeHash,
        beaconAddress,
        proxyInspection: 'not_read',
      }
    })
    const read = (phase, to, name, args, abi = FLUID_CAPACITY_ABI) =>
      canonical(
        abi,
        name,
        get(phase, {
          method: 'eth_call',
          params: [
            { to, data: encodeFunctionData({ abi: FLUID_CAPACITY_ABI, functionName: name, args }) },
            pin,
          ],
        }),
      )
    check(
      read('asset', subject.destination, 'asset', []).toLowerCase() === subject.asset &&
        Number(read('decimals', subject.asset, 'decimals', [])) === subject.assetDecimals,
      'native_identity_mismatch',
    )
    const data = read('getData', subject.destination, 'getData', [])
    check(data[0].toLowerCase() === FLUID_LIQUIDITY, 'fToken_liquidity_mismatch')
    check(
      read('resolver_liquidity', FLUID_LIQUIDITY_RESOLVER, 'LIQUIDITY', []).toLowerCase() ===
        FLUID_LIQUIDITY,
      'resolver_liquidity_mismatch',
    )
    const [supply] = read('supplyData', FLUID_LIQUIDITY_RESOLVER, 'getUserSupplyData', [
        subject.destination,
        subject.asset,
      ]),
      cash = read('cash', subject.asset, 'balanceOf', [FLUID_LIQUIDITY])
    check(used.size === receipt.traces.filter((t) => t.host === host).length, 'unexpected_trace')
    return {
      host,
      source,
      routeKey: subject.routeKey,
      destination: subject.destination,
      asset: subject.asset,
      assetDecimals: subject.assetDecimals,
      identities,
      fTokenReportedSupplyRaw: data[6].toString(),
      resolverSupplyRaw: supply.supply.toString(),
      expandedWithdrawalLimitRaw: supply.withdrawalLimit.toString(),
      withdrawableUntilLimitRaw: supply.withdrawableUntilLimit.toString(),
      resolverReportedWithdrawableRaw: supply.withdrawable.toString(),
      sharedLiquidityCashRaw: cash.toString(),
      limitParameters: {
        lastUpdateTimestamp: supply.lastUpdateTimestamp.toString(),
        expandPercent: supply.expandPercent.toString(),
        expandDuration: supply.expandDuration.toString(),
        baseWithdrawalLimitRaw: supply.baseWithdrawalLimit.toString(),
        decayEndTimestamp: supply.decayEndTimestamp.toString(),
        reportedDecayAmountRaw: supply.decayAmount.toString(),
      },
    }
  })
  const agreement = agreeFluidExitCapacity(reports[0], reports[1])
  check(agreement, 'prongs_disagreement')
  if (receipt.prongs !== undefined) check(equal(receipt.prongs, agreement), 'prongs_binding')
  const age = Date.parse(receipt.capturedAt) - Date.parse(receipt.source.blockTime)
  check(
    age >= 0 && (receipt.mode !== 'current_finalized' || age <= 1800000),
    'source_clock_invalid',
  )
  return agreement
}
export function writeFluidCapacityProof(path, receipt) {
  const text = JSON.stringify(receipt, null, 2) + '\n'
  check(Buffer.byteLength(text) <= 2 * 1024 * 1024, 'proof_oversize')
  const safePayload = structuredClone(receipt)
  if (safePayload.sourceEvidence?.candidateSourceReferences !== undefined) {
    check(
      equal(safePayload.sourceEvidence.candidateSourceReferences, SOURCE_CITATIONS),
      'source_citations_invalid',
    )
    delete safePayload.sourceEvidence.candidateSourceReferences
  }
  check(!/https?:\/\//i.test(JSON.stringify(safePayload)), 'proof_url_rejected')
  const disk = statfsSync(resolve('.'), { bigint: true })
  check(disk.bavail * disk.bsize >= 1342177280n + BigInt(Buffer.byteLength(text)), 'disk_reserve')
  writeFileSync(path, text, { flag: 'wx' })
  return { path, sha256: sha(text), bytes: Buffer.byteLength(text) }
}
async function main() {
  const args = process.argv.slice(2),
    value = (k) => args.find((a) => a.startsWith('--' + k + '='))?.slice(k.length + 3),
    file = value('subject')
  check(file, 'subject_file_required')
  const input = JSON.parse(readFileSync(file, 'utf8'))
  const subject = input.subject ?? input
  validateSubject(subject)
  const source = input.source
  if (source) validateSource(source)
  if (!args.includes('--capture')) {
    process.stdout.write(
      JSON.stringify({
        status: 'prepared_no_network',
        subject,
        source: source ?? null,
        policy: FLUID_CAPACITY_POLICY,
      }) + '\n',
    )
    return
  }
  const policy = readProviderPolicy()
  check(
    policy.status === 'active' && policy.policyId === 'configured-c1-c3-v1',
    'provider_policy_invalid',
  )
  const origins = configuredProviders(readEnv(), policy)
  const output = value('output')
  check(output, 'unique_output_required')
  check(!existsSync(output), 'output_exists')
  const disk = statfsSync(resolve('.'), { bigint: true })
  check(disk.bavail * disk.bsize >= 1342177280n + 2097152n, 'disk_reserve')
  const receipt = await captureFluidCapacityProngs(subject, origins, { source })
  process.stdout.write(JSON.stringify(writeFluidCapacityProof(output, receipt)) + '\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    process.stderr.write(
      JSON.stringify({ status: 'unavailable', reason: error.safeCode ?? 'capture_failed' }) + '\n',
    )
    process.exitCode = 1
  })
