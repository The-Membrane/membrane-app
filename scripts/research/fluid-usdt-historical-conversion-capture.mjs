// Manual exact-size public quotes; no integrated withdrawal/swap or mined-payout claim.
// Canonical deployments: https://docs.uniswap.org/contracts/v3/reference/deployments/ethereum-deployments
import { createHash } from 'node:crypto'
import {
  openSync,
  closeSync,
  writeFileSync,
  fstatSync,
  lstatSync,
  unlinkSync,
  statfsSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { encodeFunctionData, decodeFunctionResult, keccak256, parseAbi } from 'viem'
import { readBoundedReceiptFile } from '../lib/boundedLocalReceiptFile.mjs'
export const CONTRACTS = Object.freeze({
  factory: '0x1f98431c8ad98523631ae4a59f267346ea31f984',
  quoter: '0x61ffe014ba17989e743c5f6cb21bf9697530b21e',
  usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  usdt: '0xdac17f958d2ee523a2206206994597c13d831ec7',
  vault: '0x273da948aca9261043fbdb2a857bc255ecc29012',
})
export const HOSTS = Object.freeze(['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'])
export const POLICY = Object.freeze({
  maxRequests: 94,
  deadlineMs: 60000,
  rpcTimeoutMs: 8000,
  cleanupGraceMs: 250,
  maxResponseBytes: 131072,
  maxStoredResponseBytes: 1048576,
  maxInFlightPerHost: 2,
  minStartSpacingMs: 50,
  maxArtifactBytes: 2097152,
  reserveBytes: 1073741824,
})
const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
export const ABI = freeze(
  parseAbi([
    'function getPool(address,address,uint24) view returns(address)',
    'function factory() view returns(address)',
    'function token0() view returns(address)',
    'function token1() view returns(address)',
    'function fee() view returns(uint24)',
    'function liquidity() view returns(uint128)',
    'function decimals() view returns(uint8)',
    'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
  ]),
)
const MAX = (1n << 256n) - 1n,
  HEX = /^0x(?:[0-9a-f]{2})*$/i,
  HASH = /^0x[0-9a-f]{64}$/i,
  ADDRESS = /^0x[0-9a-f]{40}$/i
const check = (ok, code) => {
  if (!ok) throw Error('fluid_usdt_history_' + code)
}
const sha = (v) => createHash('sha256').update(v).digest('hex'),
  same = (a, b) => JSON.stringify(a) === JSON.stringify(b),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const uint = (v) => typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const utc = (v) =>
  typeof v === 'string' &&
  Number.isFinite(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const ISSUE_ROOT = resolve('data/research/venue-signals/carry-fluid-bridge-usdt-holder-v1/issues')
const ISSUES = freeze([
  {
    number: '00000001',
    sha256: '388c7a3c3ea53d4c343249bc813ae659053f895afdf9738f3e1c29f7c002ad14',
    blockNumber: '26101887',
    blockHash: '0x1d7a6a3917c16cb645cf68633ddb2e692aa76150d3748c6b8ecc2924a3c85e82',
    blockTime: '2026-10-02T03:15:35.000Z',
  },
  {
    number: '00000002',
    sha256: 'db3db5ff1af80bb1d29bb122e75dab810e134e76e07855cd31a48687c8304e16',
    blockNumber: '26102143',
    blockHash: '0xd7790f6f48376e330501f1fd5389cb447b0efd04a58331267a88509110eb9306',
    blockTime: '2026-10-02T04:06:47.000Z',
  },
])
const OWNER = '0x3f825bb69af74a4921dd051c80fe8bf8fb7d3a2e',
  ROUTE = 'USDT → FluidBridgeAggregatorProxy [USDC]'
function expectedPlan(includeCurrent) {
  return {
    schema: 'fluid_usdt_conversion_plan_v1',
    routeKey: ROUTE,
    destination: CONTRACTS.vault,
    owner: OWNER,
    usdcInputRaw: '10145',
    protocolUsdcInputRaw: '10000000000',
    inputDecimals: 6,
    outputDecimals: 6,
    fee: 100,
    originalUsdtRequestedRaw: null,
    firstLegEvidence: 'historical_withdrawal_simulation_not_paid',
    anchors: [
      ...ISSUES.map((x) => ({
        source: {
          chainId: 1,
          blockNumber: x.blockNumber,
          blockHash: x.blockHash,
          blockTime: x.blockTime,
        },
        issueSha256: x.sha256,
      })),
      ...(includeCurrent ? [{ currentFinalized: true }] : []),
    ],
  }
}
export function validateFluidUsdtPlan(plan) {
  check(same(plan, expectedPlan(plan?.anchors?.length === 3)), 'fixed_plan')
  return { expectedStarts: 4 + 30 * plan.anchors.length, planSha256: sha(JSON.stringify(plan)) }
}
export function prepareFluidUsdtConversionPlan({ includeCurrent = true } = {}) {
  check(typeof includeCurrent === 'boolean', 'current_option')
  let previous = null
  for (const spec of ISSUES) {
    const raw = readBoundedReceiptFile(resolve(ISSUE_ROOT, spec.number + '.json'), {
        maxFileBytes: 131072,
        maxTotalBytes: 131072,
        totalBytes: 0,
      }),
      v = JSON.parse(raw),
      { sha256, ...body } = v
    check(
      sha(JSON.stringify(body)) === spec.sha256 &&
        sha256 === spec.sha256 &&
        v.previousSha256 === previous,
      'issue_chain',
    )
    check(
      v.routeKey === ROUTE &&
        v.destination === CONTRACTS.vault &&
        v.asset === CONTRACTS.usdc &&
        v.finalAsset === CONTRACTS.usdt &&
        v.holder === OWNER &&
        String(v.baseline.blockNumber) === spec.blockNumber &&
        v.baseline.blockHash === spec.blockHash &&
        new Date(v.baseline.blockTimestamp * 1000).toISOString() === spec.blockTime,
      'issue_identity',
    )
    const c = v.baseline.cases.find((c) => c.qRaw === '10145')?.measurement
    check(
      c?.request?.assetsRaw === '10145' &&
        c.request.assetUnit === 'USDC' &&
        c.vault?.assetDecimals === 6 &&
        c.assayOwner === OWNER &&
        c.simulation?.status === 'success' &&
        c.routeLeg?.usdcToUsdtConversion === 'unassessed' &&
        c.routeLeg.usdtReceipt === 'unassessed',
      'first_leg',
    )
    previous = sha256
  }
  return freeze(expectedPlan(includeCurrent))
}
const call = (key, to, name, args = []) => ({
  key,
  method: 'eth_call',
  params: [{ to, data: encodeFunctionData({ abi: ABI, functionName: name, args }) }],
  name,
})
function initial() {
  return [call('factoryPool', CONTRACTS.factory, 'getPool', [CONTRACTS.usdc, CONTRACTS.usdt, 100])]
}
function rest(pool) {
  return [
    ...['factory', 'quoter'].map((k) => ({
      key: 'code_' + k,
      method: 'eth_getCode',
      params: [CONTRACTS[k]],
    })),
    { key: 'code_pool', method: 'eth_getCode', params: [pool] },
    call('token0', pool, 'token0'),
    call('token1', pool, 'token1'),
    call('fee', pool, 'fee'),
    call('poolFactory', pool, 'factory'),
    call('liquidity', pool, 'liquidity'),
    call('usdcDecimals', CONTRACTS.usdc, 'decimals'),
    call('usdtDecimals', CONTRACTS.usdt, 'decimals'),
    call('usdtQuotedRaw', CONTRACTS.quoter, 'quoteExactInputSingle', [
      {
        tokenIn: CONTRACTS.usdc,
        tokenOut: CONTRACTS.usdt,
        amountIn: 10145n,
        fee: 100,
        sqrtPriceLimitX96: 0n,
      },
    ]),
    call('protocolUsdtQuotedRaw', CONTRACTS.quoter, 'quoteExactInputSingle', [
      {
        tokenIn: CONTRACTS.usdc,
        tokenOut: CONTRACTS.usdt,
        amountIn: 10000000000n,
        fee: 100,
        sqrtPriceLimitX96: 0n,
      },
    ]),
  ]
}
const decode = (name, data) => decodeFunctionResult({ abi: ABI, functionName: name, data })
function validPool(v) {
  return (
    typeof v === 'string' &&
    ADDRESS.test(v) &&
    v !== '0x' + '0'.repeat(40) &&
    v.toLowerCase() !== CONTRACTS.quoter
  )
}
function header(v) {
  check(
    v &&
      !Array.isArray(v) &&
      typeof v === 'object' &&
      typeof v.number === 'string' &&
      typeof v.hash === 'string' &&
      typeof v.timestamp === 'string' &&
      /^0x[0-9a-f]+$/i.test(v.number) &&
      HASH.test(v.hash) &&
      BigInt(v.number) > 0n &&
      BigInt(v.number) <= BigInt(Number.MAX_SAFE_INTEGER) &&
      /^0x[0-9a-f]+$/i.test(v.timestamp) &&
      BigInt(v.timestamp) <= 8640000000000n,
    'header',
  )
  return {
    chainId: 1,
    blockNumber: BigInt(v.number).toString(),
    blockHash: v.hash.toLowerCase(),
    blockTime: new Date(Number(BigInt(v.timestamp)) * 1000).toISOString(),
  }
}
function publicResult(method, v) {
  if (method === 'eth_getBlockByNumber') {
    const h = header(v)
    return {
      number: '0x' + BigInt(h.blockNumber).toString(16),
      hash: h.blockHash,
      timestamp: '0x' + BigInt(Date.parse(h.blockTime) / 1000).toString(16),
    }
  }
  check(
    typeof v === 'string' && (method === 'eth_chainId' ? /^0x[0-9a-f]+$/i.test(v) : HEX.test(v)),
    'public_result',
  )
  return v
}
async function boundedBody(response, controller) {
  check(response.body?.getReader, 'stream_missing')
  const reader = response.body.getReader(),
    chunks = []
  let n = 0
  try {
    for (;;) {
      const x = await reader.read()
      if (x.done) break
      n += x.value.byteLength
      check(n <= POLICY.maxResponseBytes, 'body_limit')
      chunks.push(x.value)
    }
    return Buffer.concat(
      chunks.map((x) => Buffer.from(x)),
      n,
    ).toString('utf8')
  } finally {
    if (n > POLICY.maxResponseBytes) {
      controller.abort()
      void reader.cancel().catch(() => {})
    }
    reader.releaseLock()
  }
}
export async function captureFluidUsdtConversionHistory(
  plan,
  origins,
  { fetcher = fetch, now = Date.now, rpcTimeoutMs = POLICY.rpcTimeoutMs } = {},
) {
  plan = structuredClone(plan)
  const { expectedStarts, planSha256 } = validateFluidUsdtPlan(plan)
  check(
    Number.isSafeInteger(rpcTimeoutMs) && rpcTimeoutMs > 0 && rpcTimeoutMs <= POLICY.rpcTimeoutMs,
    'timeout_lower_only',
  )
  check(
    Array.isArray(origins) &&
      origins.length === 2 &&
      origins.every((o, i) => {
        const u = new URL(o.url)
        return (
          o.host === HOSTS[i] &&
          u.hostname === HOSTS[i] &&
          u.protocol === 'https:' &&
          !u.username &&
          !u.password
        )
      }),
    'origins',
  )
  const started = now(),
    deadline = started + POLICY.deadlineMs,
    traces = [],
    controllers = new Set()
  let starts = 0,
    closed = false,
    captureClosedReason = null,
    storedResponseBytes = 0
  const rpc = async (o, anchor, key, method, params) => {
    if (closed || now() >= deadline || starts >= expectedStarts) return null
    const controller = new AbortController(),
      id = ++starts,
      request = { jsonrpc: '2.0', id, method, params },
      t = {
        origin: o.host,
        anchor,
        key,
        request,
        startedAt: new Date(now()).toISOString(),
        completedAt: null,
        response: null,
        transport: null,
        workSettled: false,
      }
    traces.push(t)
    controllers.add(controller)
    let timer,
      work = null,
      settled = false
    try {
      check(!closed && now() < deadline && starts <= expectedStarts, 'launch_deadline')
      work = (async () => {
        check(!closed && now() < deadline && starts <= expectedStarts, 'physical_launch_deadline')
        const response = await fetcher(o.url, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
          signal: controller.signal,
        })
        check(
          response.ok &&
            response.redirected !== true &&
            (!response.url || new URL(response.url).hostname === o.host),
          'response_origin',
        )
        const raw = JSON.parse(await boundedBody(response, controller))
        check(raw?.jsonrpc === '2.0' && raw.id === id, 'rpc_envelope')
        return raw.error
          ? {
              error: {
                code: Number.isInteger(raw.error.code) ? raw.error.code : null,
                ...(typeof raw.error.data === 'string' && HEX.test(raw.error.data)
                  ? { data: raw.error.data }
                  : {}),
              },
            }
          : { result: publicResult(method, raw.result) }
      })()
      void work.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => {
            controller.abort()
            reject(new Error('timeout'))
          },
          Math.max(1, Math.min(rpcTimeoutMs, deadline - now())),
        )
      })
      const result = await Promise.race([work, timeout])
      const resultBytes = Buffer.byteLength(JSON.stringify(result))
      if (storedResponseBytes + resultBytes > POLICY.maxStoredResponseBytes) {
        closed = true
        for (const c of controllers) c.abort()
        throw new Error('artifact_response_budget')
      }
      storedResponseBytes += resultBytes
      t.response = result
    } catch {
      t.transport = controller.signal.aborted ? 'timeout' : 'transport_unavailable'
    } finally {
      clearTimeout(timer)
      if (work && !settled) {
        await Promise.race([
          work.then(
            () => {},
            () => {},
          ),
          sleep(
            Math.max(0, Math.min(POLICY.cleanupGraceMs, deadline + POLICY.cleanupGraceMs - now())),
          ),
        ])
        if (!settled) {
          closed = true
          captureClosedReason = 'rpc_abort_unsettled'
          for (const c of controllers) c.abort()
        }
      }
      t.workSettled = settled
      if (settled) controllers.delete(controller)
      t.completedAt = new Date(now()).toISOString()
    }
    if (!closed && now() < deadline) await sleep(POLICY.minStartSpacingMs + 1)
    return t
  }

  await Promise.all(
    origins.map(async (o) => {
      await rpc(o, -1, 'chain', 'eth_chainId', [])
      await rpc(o, -1, 'finalized', 'eth_getBlockByNumber', ['finalized', false])
    }),
  )
  const heads = HOSTS.map(
    (h) => traces.find((t) => t.origin === h && t.key === 'finalized')?.response?.result,
  ).map((v) => {
    try {
      return header(v)
    } catch {
      return null
    }
  })
  const headsValid =
    heads.every(Boolean) &&
    !(heads[0].blockNumber === heads[1].blockNumber && !same(heads[0], heads[1]))
  const current = headsValid
    ? heads.reduce((a, b) => (BigInt(a.blockNumber) <= BigInt(b.blockNumber) ? a : b))
    : null
  const sources = plan.anchors.map((a) => (a.currentFinalized ? current : a.source))
  if (!headsValid) {
    closed = true
    captureClosedReason ??= 'finalized_head_unavailable_or_conflicting'
  }
  await Promise.all(
    origins.map(async (o, oi) => {
      for (let i = 0; i < sources.length && !closed; i++) {
        const source = sources[i]
        if (!source) continue
        check(
          BigInt(heads[oi].blockNumber) >= BigInt(source.blockNumber) &&
            (heads[oi].blockNumber !== source.blockNumber || same(heads[oi], source)),
          'finalized_ceiling',
        )
        const pin = { blockHash: source.blockHash, requireCanonical: true },
          tag = '0x' + BigInt(source.blockNumber).toString(16)
        await rpc(o, i, 'header_before', 'eth_getBlockByNumber', [tag, false])
        const spec = initial()[0],
          t = await rpc(o, i, spec.key, spec.method, [...spec.params, pin])
        let pool = null
        try {
          pool = decode('getPool', t?.response?.result).toLowerCase()
        } catch {}
        if (validPool(pool)) {
          for (const s of rest(pool)) await rpc(o, i, s.key, s.method, [...s.params, pin])
        }
        await rpc(o, i, 'header_after', 'eth_getBlockByNumber', [tag, false])
      }
    }),
  )
  closed = true
  for (const c of controllers) c.abort()
  check(now() - started <= POLICY.deadlineMs + POLICY.cleanupGraceMs, 'capture_completion')
  const receipt = seal({
    schema: 'fluid_usdt_conversion_capture_v1',
    planSha256,
    plan,
    sources,
    origins: [...HOSTS],
    policy: { ...POLICY },
    startedAt: new Date(started).toISOString(),
    capturedAt: new Date(now()).toISOString(),
    physicalStarts: starts,
    expectedStarts,
    captureClosedReason,
    traces,
    execution: 'unassessed',
    minedPayout: false,
    sourceImplementationEquivalence: false,
  })
  check(Buffer.byteLength(publicSerialization(receipt)) <= POLICY.maxArtifactBytes, 'artifact_size')
  return receipt
}
export function replayFluidUsdtConversionHistory(receipt, plan) {
  const expected = validateFluidUsdtPlan(plan),
    { sha256, ...body } = receipt
  check(
    sha(JSON.stringify(body)) === sha256 &&
      receipt.schema === 'fluid_usdt_conversion_capture_v1' &&
      same(receipt.plan, plan) &&
      receipt.planSha256 === expected.planSha256 &&
      same(receipt.origins, HOSTS) &&
      same(receipt.policy, POLICY) &&
      receipt.execution === 'unassessed' &&
      receipt.minedPayout === false &&
      receipt.sourceImplementationEquivalence === false,
    'receipt_binding',
  )
  check(Buffer.byteLength(publicSerialization(receipt)) <= POLICY.maxArtifactBytes, 'artifact_size')
  check(
    utc(receipt.startedAt) &&
      utc(receipt.capturedAt) &&
      Date.parse(receipt.capturedAt) >= Date.parse(receipt.startedAt) &&
      Date.parse(receipt.capturedAt) - Date.parse(receipt.startedAt) <=
        POLICY.deadlineMs + POLICY.cleanupGraceMs,
    'capture_clock',
  )
  check(
    receipt.physicalStarts === receipt.traces.length &&
      receipt.physicalStarts <= POLICY.maxRequests &&
      receipt.physicalStarts <= expected.expectedStarts &&
      receipt.expectedStarts === expected.expectedStarts,
    'starts',
  )
  check(
    receipt.traces.reduce((n, t) => n + Buffer.byteLength(JSON.stringify(t.response)), 0) <=
      POLICY.maxStoredResponseBytes,
    'stored_response_budget',
  )
  for (const [i, t] of receipt.traces.entries()) {
    check(
      Buffer.byteLength(JSON.stringify(t.response)) <= POLICY.maxResponseBytes,
      'individual_response_bound',
    )
    if (i)
      check(
        Date.parse(t.startedAt) >= Date.parse(receipt.traces[i - 1].startedAt),
        'global_launch_order',
      )
    check(
      t.request?.id === i + 1 &&
        t.request.jsonrpc === '2.0' &&
        HOSTS.includes(t.origin) &&
        utc(t.startedAt) &&
        utc(t.completedAt) &&
        Date.parse(t.startedAt) >= Date.parse(receipt.startedAt) &&
        Date.parse(t.startedAt) < Date.parse(receipt.startedAt) + POLICY.deadlineMs &&
        Date.parse(t.completedAt) >= Date.parse(t.startedAt) &&
        Date.parse(t.completedAt) - Date.parse(t.startedAt) <=
          POLICY.rpcTimeoutMs + POLICY.cleanupGraceMs &&
        Date.parse(t.completedAt) <= Date.parse(receipt.capturedAt),
      'trace_clock',
    )
    if (t.response?.error) {
      check(
        same(Object.keys(t.response), ['error']) &&
          Object.keys(t.response.error).every((k) => ['code', 'data'].includes(k)) &&
          (t.response.error.code === null || Number.isInteger(t.response.error.code)) &&
          (!Object.hasOwn(t.response.error, 'data') ||
            (typeof t.response.error.data === 'string' && HEX.test(t.response.error.data))),
        'rpc_error_shape',
      )
    }
    if (t.response?.result !== undefined)
      check(
        same(Object.keys(t.response), ['result']) &&
          same(publicResult(t.request.method, t.response.result), t.response.result),
        'trace_public_result',
      )
    check(
      t.transport === null || ['timeout', 'transport_unavailable'].includes(t.transport),
      'transport',
    )
    check(
      typeof t.workSettled === 'boolean' &&
        (t.workSettled ||
          (t.transport === 'timeout' && receipt.captureClosedReason === 'rpc_abort_unsettled')),
      'work_settlement',
    )
    check(
      (t.response === null && t.transport !== null) ||
        (t.response !== null && t.transport === null),
      'transport_response_consistency',
    )
  }
  const unsettled = receipt.traces.filter((t) => !t.workSettled)
  if (unsettled.length) {
    const stop = Math.min(...unsettled.map((t) => Date.parse(t.completedAt)))
    check(
      receipt.traces.every((t) => Date.parse(t.startedAt) <= stop),
      'starts_after_unsettled_close',
    )
  }

  const heads = HOSTS.map(
      (h) => receipt.traces.find((t) => t.origin === h && t.key === 'finalized')?.response?.result,
    ).map((v) => {
      try {
        return header(v)
      } catch {
        return null
      }
    }),
    headsValid =
      heads.every(Boolean) &&
      !(heads[0].blockNumber === heads[1].blockNumber && !same(heads[0], heads[1]))
  const current = headsValid
      ? heads.reduce((a, b) => (BigInt(a.blockNumber) <= BigInt(b.blockNumber) ? a : b))
      : null,
    sources = plan.anchors.map((a) => (a.currentFinalized ? current : a.source))
  check(same(receipt.sources, sources), 'derived_sources')
  const origins = HOSTS.map((host, oi) => {
    const rows = receipt.traces.filter((t) => t.origin === host)
    check(
      rows.every(
        (r, i) =>
          !i ||
          Date.parse(r.startedAt) - Date.parse(rows[i - 1].completedAt) >= POLICY.minStartSpacingMs,
      ),
      'spacing',
    )
    const chain = rows.find((t) => t.key === 'chain'),
      final = rows.find((t) => t.key === 'finalized')
    check(
      rows.filter((t) => t.anchor === -1).every((t) => ['chain', 'finalized'].includes(t.key)) &&
        new Set(rows.filter((t) => t.anchor === -1).map((t) => t.key)).size ===
          rows.filter((t) => t.anchor === -1).length,
      'setup_unique',
    )
    for (const t of rows)
      check(
        Number.isInteger(t.anchor) && t.anchor >= -1 && t.anchor < sources.length,
        'anchor_scope',
      )
    if (chain)
      check(
        chain.request.method === 'eth_chainId' && same(chain.request.params, []),
        'chain_request',
      )
    if (final)
      check(
        final.request.method === 'eth_getBlockByNumber' &&
          same(final.request.params, ['finalized', false]),
        'final_request',
      )
    return sources.map((source, i) => {
      const group = rows.filter((t) => t.anchor === i),
        by = new Map(group.map((t) => [t.key, t]))
      check(by.size === group.length, 'duplicate')
      if (!source) {
        check(group.length === 0, 'missing_source_calls')
        return { source: null, status: 'incomplete', missingLegs: ['finalized_source'] }
      }
      const pin = { blockHash: source.blockHash, requireCanonical: true },
        tag = '0x' + BigInt(source.blockNumber).toString(16)
      let pool = null
      try {
        pool = decode('getPool', by.get('factoryPool')?.response?.result).toLowerCase()
      } catch {}
      const specs = [
        { key: 'header_before', method: 'eth_getBlockByNumber', params: [tag, false] },
        ...initial().map((s) => ({ ...s, params: [...s.params, pin] })),
        ...(validPool(pool) ? rest(pool).map((s) => ({ ...s, params: [...s.params, pin] })) : []),
        { key: 'header_after', method: 'eth_getBlockByNumber', params: [tag, false] },
      ]
      check(
        group.every(
          (t, j) =>
            t.key === specs[j]?.key &&
            t.request.method === specs[j].method &&
            same(t.request.params, specs[j].params),
        ),
        'exact_requests',
      )
      check(
        group.every(
          (t) =>
            Date.parse(t.startedAt) >= Date.parse(chain?.completedAt) &&
            Date.parse(t.startedAt) >= Date.parse(final?.completedAt),
        ),
        'setup_order',
      )
      const before = by.get('header_before'),
        after = by.get('header_after')
      if (after)
        check(
          group
            .filter((t) => !t.key.startsWith('header_'))
            .every(
              (t) =>
                Date.parse(t.startedAt) >= Date.parse(before.completedAt) &&
                Date.parse(t.completedAt) <= Date.parse(after.startedAt),
            ),
          'header_enclosure',
        )
      const missing = specs.filter((s) => !by.get(s.key)?.response?.result).map((s) => s.key)
      let identity = false,
        quoted = null,
        protocolQuoted = null,
        codeHashes = null
      try {
        check(
          headsValid &&
            chain?.response?.result === '0x1' &&
            BigInt(heads[oi].blockNumber) >= BigInt(source.blockNumber) &&
            (heads[oi].blockNumber !== source.blockNumber || same(heads[oi], source)),
          'ceiling',
        )
        check(
          same(header(before.response.result), source) &&
            same(header(after.response.result), source),
          'headers',
        )
        check(
          missing.every((k) => ['usdtQuotedRaw', 'protocolUsdtQuotedRaw'].includes(k)) &&
            validPool(pool),
          'complete',
        )
        check(
          decode('token0', by.get('token0').response.result).toLowerCase() === CONTRACTS.usdc &&
            decode('token1', by.get('token1').response.result).toLowerCase() === CONTRACTS.usdt &&
            decode('fee', by.get('fee').response.result) === 100 &&
            decode('factory', by.get('poolFactory').response.result).toLowerCase() ===
              CONTRACTS.factory &&
            decode('decimals', by.get('usdcDecimals').response.result) === 6 &&
            decode('decimals', by.get('usdtDecimals').response.result) === 6,
          'identity',
        )
        codeHashes = {}
        for (const k of ['factory', 'quoter', 'pool']) {
          const code = by.get('code_' + k).response.result
          check(typeof code === 'string' && HEX.test(code) && code.length > 2, 'code')
          codeHashes[k] = keccak256(code)
        }
        identity = true
      } catch {
        missing.push('identity_or_header_unverified')
      }
      if (identity) {
        for (const key of ['usdtQuotedRaw', 'protocolUsdtQuotedRaw']) {
          try {
            const q = decode('quoteExactInputSingle', by.get(key)?.response?.result)[0]
            check(q >= 0n && q <= MAX, 'quote_uint')
            if (key === 'usdtQuotedRaw') quoted = q.toString()
            else protocolQuoted = q.toString()
          } catch {
            if (!missing.includes(key)) missing.push(key)
          }
        }
      }
      return {
        source,
        pool: validPool(pool) ? pool : null,
        status: identity && quoted !== null ? 'conditional_quote' : 'incomplete',
        usdtQuotedRaw: identity ? quoted : null,
        protocolQuote: {
          inputRaw: '10000000000',
          usdtQuotedRaw: identity ? protocolQuoted : null,
          status: identity && protocolQuoted !== null ? 'conditional_quote' : 'incomplete',
          scope: 'independent_public_quote_not_holder_entitlement',
        },
        identityVerified: identity,
        runtimeCodeHashes: identity ? codeHashes : null,
        missingLegs: missing,
      }
    })
  })
  const points = sources.map((source, i) => {
    const a = origins[0][i],
      b = origins[1][i]
    const basis = (p) => ({
      source: p.source,
      pool: p.pool,
      identityVerified: p.identityVerified,
      runtimeCodeHashes: p.runtimeCodeHashes,
    })
    const agreedIdentity = a.identityVerified && b.identityVerified && same(basis(a), basis(b))
    const small =
      agreedIdentity && a.usdtQuotedRaw !== null && a.usdtQuotedRaw === b.usdtQuotedRaw
        ? a.usdtQuotedRaw
        : null
    const large =
      agreedIdentity &&
      a.protocolQuote?.usdtQuotedRaw !== null &&
      a.protocolQuote?.usdtQuotedRaw === b.protocolQuote?.usdtQuotedRaw
        ? a.protocolQuote.usdtQuotedRaw
        : null
    return {
      source,
      pool: agreedIdentity ? a.pool : null,
      identityVerified: !!agreedIdentity,
      runtimeCodeHashes: agreedIdentity ? a.runtimeCodeHashes : null,
      status: small !== null ? 'conditional_quote' : 'incomplete',
      usdtQuotedRaw: small,
      protocolQuote: {
        inputRaw: '10000000000',
        usdtQuotedRaw: large,
        status: large !== null ? 'conditional_quote' : 'incomplete',
        scope: 'independent_public_quote_not_holder_entitlement',
      },
      missingLegs: [
        ...new Set([
          ...(a.missingLegs ?? []),
          ...(b.missingLegs ?? []),
          ...(!agreedIdentity ? ['two_origin_identity_or_source_unverified'] : []),
          ...(small === null ? ['usdtQuotedRaw'] : []),
          ...(large === null ? ['protocolUsdtQuotedRaw'] : []),
        ]),
      ],
    }
  })
  check(
    Date.parse(receipt.capturedAt) >=
      Math.max(...sources.filter(Boolean).map((s) => Date.parse(s.blockTime))),
    'source_future',
  )
  return freeze({
    status: 'replayed_fluid_usdt_exact_size_quotes',
    knowledgeCutoff: receipt.capturedAt,
    captureReceiptSha256: receipt.sha256,
    input: { asset: CONTRACTS.usdc, decimals: 6, amountRaw: '10145' },
    output: { asset: CONTRACTS.usdt, decimals: 6 },
    originalUsdtRequestedRaw: null,
    firstLegEvidence: plan.firstLegEvidence,
    owner: OWNER,
    protocolInput: {
      asset: CONTRACTS.usdc,
      decimals: 6,
      amountRaw: '10000000000',
      holderBound: false,
      originalUsdtRequestedRaw: null,
    },
    history: { points: points.slice(0, 2), elapsedSeconds: [0, 3072] },
    current: points[2] ?? null,
    execution: 'unassessed',
    minedPayout: false,
    holderCapacity: false,
    sourceImplementationEquivalence: false,
  })
}
function publicSerialization(value) {
  const text = JSON.stringify(value)
  check(!/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(text), 'artifact_url')
  return text
}
export function writeFluidUsdtCapture(out, value, { statfs = statfsSync } = {}) {
  const text = publicSerialization(value) + '\n',
    bytes = Buffer.byteLength(text)
  check(bytes <= POLICY.maxArtifactBytes, 'artifact_size')
  const disk = statfs(resolve(out, '..'))
  check(disk.bavail * disk.bsize - bytes >= POLICY.reserveBytes, 'disk_reserve')
  let fd = null,
    owned = null
  try {
    fd = openSync(out, 'wx')
    owned = fstatSync(fd)
    writeFileSync(fd, text)
  } catch (e) {
    if (owned) {
      try {
        const now = lstatSync(out)
        if (now.isFile() && !now.isSymbolicLink() && now.dev === owned.dev && now.ino === owned.ino)
          unlinkSync(out)
      } catch {}
    }
    throw e
  } finally {
    if (fd !== null) closeSync(fd)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2] ?? '--check-only'
  check(['--check-only', '--capture', '--replay'].includes(mode), 'mode')
  const plan = prepareFluidUsdtConversionPlan({
    includeCurrent: !process.argv.includes('--historical-only'),
  })
  if (mode === '--check-only')
    console.log(
      JSON.stringify({
        status: 'prepared_no_rpc',
        plan,
        ...validateFluidUsdtPlan(plan),
        policy: POLICY,
      }),
    )
  else if (mode === '--capture') {
    const { readProviderPolicy, configuredProviders } =
        await import('./carry-depth-quote-archive.mjs'),
      policy = readProviderPolicy()
    check(
      policy?.status === 'active' && policy.policyId === 'configured-c1-c3-v1',
      'provider_policy',
    )
    const origins = configuredProviders(null, policy),
      out = process.argv.find((x) => x.startsWith('--out='))?.slice(6)
    check(typeof out === 'string' && out.length > 0, 'output')
    const disk = statfsSync(resolve(out, '..'))
    check(
      disk.bavail * disk.bsize - POLICY.maxArtifactBytes >= POLICY.reserveBytes,
      'preflight_reserve',
    )
    const receipt = await captureFluidUsdtConversionHistory(plan, origins)
    replayFluidUsdtConversionHistory(receipt, plan)
    writeFluidUsdtCapture(out, receipt)
    console.log(
      JSON.stringify({
        sha256: receipt.sha256,
        physicalStarts: receipt.physicalStarts,
        capturedAt: receipt.capturedAt,
      }),
    )
  } else {
    const file = process.argv.find((x) => x.startsWith('--file='))?.slice(7)
    check(typeof file === 'string' && file.length > 0, 'file')
    const receipt = JSON.parse(
      readBoundedReceiptFile(file, {
        maxFileBytes: POLICY.maxArtifactBytes,
        maxTotalBytes: POLICY.maxArtifactBytes,
        totalBytes: 0,
      }),
    )
    console.log(JSON.stringify(replayFluidUsdtConversionHistory(receipt, plan)))
  }
}
