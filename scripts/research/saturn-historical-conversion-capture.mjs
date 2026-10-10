// Explicit one-shot historical quote capture. Default/check-only and replay are RPC-free.
import { createHash } from 'node:crypto'
import { statfsSync, writeFileSync } from 'node:fs'
import { readBoundedReceiptFile } from '../lib/boundedLocalReceiptFile.mjs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi } from 'viem'
import { configuredProviders, readProviderPolicy } from './carry-depth-quote-archive.mjs'

export const CONTRACTS = Object.freeze({
  curve: '0xf4d0cf32908b2c7f1021339c43df0f77f06896d7',
  pool: '0xbafead7c60ea473758ed6c6021505e8bbd7e8e5d',
  quoter: '0x61ffe014ba17989e743c5f6cb21bf9697530b21e',
  factory: '0x1f98431c8ad98523631ae4a59f267346ea31f984',
  usdat: '0x23238f20b894f29041f48d88ee91131c395aaa71',
  usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ausd: '0x00000000efe302beaa2b3e6e1b18d08d69a9012a',
  vault: '0xd166337499e176bbc38a1fbd113ab144e5bd2df7',
  queue: '0x4bc9fec04f0f95e9b42a3ef18f3c96fb57923d2e',
})
export const HOSTS = Object.freeze(['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'])
export const POLICY = Object.freeze({
  maxRequests: 224,
  deadlineMs: 90000,
  rpcTimeoutMs: 8000,
  cleanupGraceMs: 250,
  maxResponseBytes: 131072,
  maxInFlightPerHost: 2,
  minStartSpacingMs: 50,
  // Manual one-shot capture writes at most 2MiB; preserve 1GiB after the output.
  reserveBytes: 1073741824,
  maxArtifactBytes: 2 * 1024 * 1024,
  maxStoredResponseBytes: 1536 * 1024,
})
const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
export const ABI = deepFreeze(
  parseAbi([
    'function coins(uint256) view returns(address)',
    'function balances(uint256) view returns(uint256)',
    'function get_dy(int128,int128,uint256) view returns(uint256)',
    'function token0() view returns(address)',
    'function token1() view returns(address)',
    'function fee() view returns(uint24)',
    'function liquidity() view returns(uint128)',
    'function getPool(address,address,uint24) view returns(address)',
    'function decimals() view returns(uint8)',
    'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
    'function getWithdrawalQueue() view returns(address)',
    'function ownerOf(uint256) view returns(address)',
    'function requests(uint256) view returns(uint256 shares,uint256 usdatOwed,uint256 timestamp,uint256 minSharePrice,uint8 status)',
    'function paused() view returns(bool)',
    'function claim(uint256) returns(uint256)',
    'function asset() view returns(address)',
    'function USDAT() view returns(address)',
    'function STAKED_USDAT() view returns(address)',
  ]),
)
const MAX = (1n << 256n) - 1n,
  HEX = /^0x(?:[0-9a-f]{2})*$/i,
  HASH = /^0x[0-9a-f]{64}$/i,
  ADDRESS = /^0x[0-9a-f]{40}$/i
const check = (ok, code) => {
  if (!ok) throw new Error('saturn_history_' + code)
}
const sha = (v) => createHash('sha256').update(v).digest('hex'),
  seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const utc = (v) =>
  typeof v === 'string' &&
  Number.isFinite(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const uint = (v) => typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const call = (key, to, name, args = []) => ({
  key,
  method: 'eth_call',
  to,
  data: encodeFunctionData({ abi: ABI, functionName: name, args }),
  name,
})
function specs(plan, index) {
  const a = plan.anchors[index],
    c = CONTRACTS
  return [
    ...['curve', 'pool', 'quoter'].map((key) => ({
      key: 'code_' + key,
      method: 'eth_getCode',
      to: c[key],
    })),
    call('curve0', c.curve, 'coins', [0n]),
    call('curve1', c.curve, 'coins', [1n]),
    call('curveCashUsdcRaw', c.curve, 'balances', [0n]),
    call('curveCashUsdatRaw', c.curve, 'balances', [1n]),
    call('token0', c.pool, 'token0'),
    call('token1', c.pool, 'token1'),
    call('fee', c.pool, 'fee'),
    call('factoryPool', c.factory, 'getPool', [c.usdc, c.ausd, 100]),
    call('uniswapActiveLiquidityRaw', c.pool, 'liquidity'),
    ...['usdat', 'usdc', 'ausd'].map((k) => call(k + 'Decimals', c[k], 'decimals')),
    ...(a.ticket
      ? [
          { key: 'code_queue', method: 'eth_getCode', to: c.queue },
          { key: 'code_vault', method: 'eth_getCode', to: c.vault },
          call('queueAddress', c.vault, 'getWithdrawalQueue'),
          call('vaultAsset', c.vault, 'asset'),
          call('vaultDecimals', c.vault, 'decimals'),
          call('queueUSDAT', c.queue, 'USDAT'),
          call('queueVault', c.queue, 'STAKED_USDAT'),
          call('ticketOwner', c.queue, 'ownerOf', [BigInt(a.ticket.ticketId)]),
          call('ticketRequest', c.queue, 'requests', [BigInt(a.ticket.ticketId)]),
          call('queuePaused', c.queue, 'paused'),
          call('vaultPaused', c.vault, 'paused'),
          {
            ...call('ticketClaim', c.queue, 'claim', [BigInt(a.ticket.ticketId)]),
            from: a.ticket.owner,
          },
        ]
      : []),
    call('usdcQuotedRaw', c.curve, 'get_dy', [1n, 0n, BigInt(plan.usdatInputRaw)]),
    call('protocolUsdcQuotedRaw', c.curve, 'get_dy', [1n, 0n, 10000000000n]),
  ]
}
function quoter(raw, key = 'ausdQuotedRaw') {
  return call(key, CONTRACTS.quoter, 'quoteExactInputSingle', [
    {
      tokenIn: CONTRACTS.usdc,
      tokenOut: CONTRACTS.ausd,
      amountIn: BigInt(raw),
      fee: 100,
      sqrtPriceLimitX96: 0n,
    },
  ])
}
export function validatePlan(plan) {
  check(
    plan?.schema === 'saturn_historical_conversion_plan_v1' &&
      plan.assetUSDat === CONTRACTS.usdat &&
      plan.assetDecimals === 6 &&
      uint(plan.usdatInputRaw) &&
      BigInt(plan.usdatInputRaw) > 0n,
    'plan_input',
  )
  check(
    Array.isArray(plan.anchors) && plan.anchors.length >= 1 && plan.anchors.length <= 6,
    'anchors',
  )
  for (const [i, a] of plan.anchors.entries()) {
    if (a.currentFinalized === true) {
      check(i === plan.anchors.length - 1, 'current_anchor_order')
      if (a.ticket) check(uint(a.ticket.ticketId) && ADDRESS.test(a.ticket.owner), 'ticket_locator')
      continue
    }
    check(
      a.source?.chainId === 1 &&
        uint(a.source.blockNumber) &&
        BigInt(a.source.blockNumber) > 0n &&
        HASH.test(a.source.blockHash) &&
        utc(a.source.blockTime) &&
        /^[0-9a-f]{64}$/.test(a.receiptSha256),
      'source',
    )
    if (i)
      check(
        BigInt(a.source.blockNumber) > BigInt(plan.anchors[i - 1].source.blockNumber) &&
          Date.parse(a.source.blockTime) > Date.parse(plan.anchors[i - 1].source.blockTime),
        'source_order',
      )
    if (a.ticket) check(uint(a.ticket.ticketId) && ADDRESS.test(a.ticket.owner), 'ticket_locator')
  }
  const expectedStarts =
    6 + plan.anchors.reduce((n, _, i) => n + 2 * (specs(plan, i).length + 4), 0)
  check(expectedStarts <= POLICY.maxRequests, 'plan_request_budget')
  return { expectedStarts, planSha256: sha(JSON.stringify(plan)) }
}
export async function prepareSaturnConversionPlan({ usdatInputRaw = '42103198' } = {}) {
  const path = resolve(
    'data/research/venue-signals/saturn-queue-episodes-26007302-26107302-v1.json',
  )
  const bytes = readBoundedReceiptFile(path, {
    maxFileBytes: 131072,
    maxTotalBytes: 131072,
    totalBytes: 0,
  })
  check(
    sha(bytes) === '62fb276cf26a032d17a6b185a65d116bb9ddef3c51c6aacbf912a27e6cf4f207',
    'locator_file_sha',
  )
  const episodes = JSON.parse(bytes)
  const t = episodes.episodes.find((t) => t.ticketId === '1670')
  check(t && t.usdatOwedRaw === '42103198' && ADDRESS.test(t.currentHolder), 'ticket_locator')
  const anchors = [t.processedBlock, episodes.toBlock].map((n) => {
    const h = episodes.headers.find((h) => h.number === n)
    check(h && HASH.test(h.hash) && Number.isSafeInteger(h.timestamp), 'saved_header')
    return {
      source: {
        chainId: 1,
        blockNumber: String(n),
        blockHash: h.hash,
        blockTime: new Date(h.timestamp * 1000).toISOString(),
      },
      receiptSha256: h.sha256,
      ticket: { ticketId: t.ticketId, owner: t.currentHolder },
    }
  })
  const plan = {
    schema: 'saturn_historical_conversion_plan_v1',
    usdatInputRaw,
    assetUSDat: CONTRACTS.usdat,
    assetDecimals: 6,
    locatorFileSha256: sha(bytes),
    locatorOnly: true,
    anchors: [
      ...anchors,
      { currentFinalized: true, ticket: { ticketId: t.ticketId, owner: t.currentHolder } },
    ],
  }
  validatePlan(plan)
  return plan
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
      /^0x[0-9a-f]+$/i.test(v.timestamp),
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
export async function captureSaturnConversionHistory(
  plan,
  origins,
  { fetcher = fetch, now = Date.now, rpcTimeoutMs = POLICY.rpcTimeoutMs } = {},
) {
  check(
    Number.isSafeInteger(rpcTimeoutMs) && rpcTimeoutMs >= 1 && rpcTimeoutMs <= POLICY.rpcTimeoutMs,
    'timeout_lower_only',
  )
  plan = structuredClone(plan)
  const { expectedStarts, planSha256 } = validatePlan(plan)
  check(
    origins?.length === 2 &&
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
  let effectivePlan = structuredClone(plan)
  if (plan.anchors.some((a) => a.currentFinalized)) {
    const heads = HOSTS.map(
      (host) => traces.find((t) => t.origin === host && t.key === 'finalized')?.response?.result,
    ).map((v) => (v ? header(v) : null))
    if (
      heads.every(Boolean) &&
      !(heads[0].blockNumber === heads[1].blockNumber && !same(heads[0], heads[1]))
    ) {
      const source = heads.reduce((a, b) =>
        BigInt(a.blockNumber) <= BigInt(b.blockNumber) ? a : b,
      )
      effectivePlan.anchors = plan.anchors.map((a) =>
        a.currentFinalized ? { ...a, source, receiptSha256: plan.locatorFileSha256 } : a,
      )
    }
  }
  const setupHeads = HOSTS.map(
    (h) => traces.find((t) => t.origin === h && t.key === 'finalized')?.response?.result,
  ).map((v) => (v ? header(v) : null))
  if (
    setupHeads.every(Boolean) &&
    setupHeads[0].blockNumber === setupHeads[1].blockNumber &&
    !same(setupHeads[0], setupHeads[1])
  ) {
    closed = true
    captureClosedReason = 'finalized_head_conflict'
  }
  await Promise.all(
    origins.map(async (o) => {
      for (let i = 0; i < effectivePlan.anchors.length && !closed; i++) {
        const a = effectivePlan.anchors[i]
        if (!a.source) continue
        const pin = { blockHash: a.source.blockHash, requireCanonical: true },
          tag = '0x' + BigInt(a.source.blockNumber).toString(16)
        await rpc(o, i, 'header_before', 'eth_getBlockByNumber', [tag, false])
        let usdc = null,
          protocolUsdc = null
        for (const s of specs(effectivePlan, i)) {
          const params =
            s.method === 'eth_call'
              ? [{ to: s.to, data: s.data, ...(s.from ? { from: s.from } : {}) }, pin]
              : [s.to, pin]
          const t = await rpc(o, i, s.key, s.method, params)
          if (['usdcQuotedRaw', 'protocolUsdcQuotedRaw'].includes(s.key) && t?.response?.result) {
            try {
              const v = decodeFunctionResult({
                abi: ABI,
                functionName: s.name,
                data: t.response.result,
              })
              if (v > 0n) {
                if (s.key === 'usdcQuotedRaw') usdc = v.toString()
                else protocolUsdc = v.toString()
              }
            } catch {}
          }
        }
        if (usdc) {
          const s = quoter(usdc)
          await rpc(o, i, s.key, s.method, [{ to: s.to, data: s.data }, pin])
        }
        if (protocolUsdc) {
          const s = quoter(protocolUsdc, 'protocolAusdQuotedRaw')
          await rpc(o, i, s.key, s.method, [{ to: s.to, data: s.data }, pin])
        }
        await rpc(o, i, 'header_after', 'eth_getBlockByNumber', [tag, false])
      }
    }),
  )
  closed = true
  for (const c of controllers) c.abort()
  check(now() - started <= POLICY.deadlineMs + POLICY.cleanupGraceMs, 'capture_completion')
  const receipt = seal({
    schema: 'saturn_historical_conversion_capture_v1',
    planSha256,
    plan: structuredClone(plan),
    sources: effectivePlan.anchors.map((a) => a.source ?? null),
    origins: [...HOSTS],
    policy: { ...POLICY },
    startedAt: new Date(started).toISOString(),
    capturedAt: new Date(now()).toISOString(),
    physicalStarts: starts,
    captureClosedReason,
    expectedStarts,
    traces,
    execution: 'unassessed',
    sourceImplementationEquivalence: false,
  })
  check(Buffer.byteLength(publicSerialization(receipt)) <= POLICY.maxArtifactBytes, 'artifact_size')
  return receipt
}
function reconstruct(plan, i, rows) {
  const lookup = (k) => {
      const t = rows.find((t) => t.key === k)
      return t?.response?.result ?? null
    },
    decoded = (s) => {
      const raw = lookup(s.key)
      if (raw === null) return null
      try {
        return decodeFunctionResult({ abi: ABI, functionName: s.name, data: raw })
      } catch {
        return null
      }
    }
  const data = {},
    missing = [],
    missingFacts = []
  for (const s of specs(plan, i)) {
    const raw = lookup(s.key)
    if (s.method === 'eth_getCode') {
      data[s.key] = raw && raw !== '0x' ? keccak256(raw) : null
    } else {
      const v = decoded(s)
      data[s.key] =
        typeof v === 'bigint'
          ? v.toString()
          : typeof v === 'string' && ADDRESS.test(v)
            ? v.toLowerCase()
            : (v ?? null)
    }
    if (data[s.key] === null)
      ([
        'code_curve',
        'code_pool',
        'code_quoter',
        'curve0',
        'curve1',
        'token0',
        'token1',
        'fee',
        'factoryPool',
        'usdatDecimals',
        'usdcDecimals',
        'ausdDecimals',
        'usdcQuotedRaw',
      ].includes(s.key)
        ? missing
        : missingFacts
      ).push(s.key)
  }
  const c = CONTRACTS,
    identity =
      data.curve0?.toLowerCase() === c.usdc &&
      data.curve1?.toLowerCase() === c.usdat &&
      [data.token0?.toLowerCase(), data.token1?.toLowerCase()].sort().join(':') ===
        [c.usdc, c.ausd].sort().join(':') &&
      data.fee === 100 &&
      data.factoryPool?.toLowerCase() === c.pool &&
      ['usdat', 'usdc', 'ausd'].every((k) => data[k + 'Decimals'] === 6) &&
      ['curve', 'pool', 'quoter'].every((k) => data['code_' + k])
  let ausd = null
  if (uint(data.usdcQuotedRaw) && BigInt(data.usdcQuotedRaw) > 0n) {
    const q = decoded(quoter(data.usdcQuotedRaw))
    if (q && q[0] > 0n && q[0] <= MAX) ausd = q[0].toString()
  }
  if (!ausd) missing.push('ausdQuotedRaw')
  let protocolAusd = null
  if (uint(data.protocolUsdcQuotedRaw) && BigInt(data.protocolUsdcQuotedRaw) > 0n) {
    const q = decoded(quoter(data.protocolUsdcQuotedRaw, 'protocolAusdQuotedRaw'))
    if (q && q[0] > 0n && q[0] <= MAX) protocolAusd = q[0].toString()
  }
  let ticket = null
  if (plan.anchors[i].ticket) {
    const r = data.ticketRequest
    const ticketIdentityVerified =
      data.queueAddress?.toLowerCase() === CONTRACTS.queue &&
      data.vaultAsset?.toLowerCase() === CONTRACTS.usdat &&
      data.vaultDecimals === 18 &&
      data.queueUSDAT?.toLowerCase() === CONTRACTS.usdat &&
      data.queueVault?.toLowerCase() === CONTRACTS.vault &&
      Boolean(data.code_queue && data.code_vault)
    ticket = {
      identityVerified: ticketIdentityVerified,
      reportedOwner: data.ticketOwner,
      owner: ticketIdentityVerified ? data.ticketOwner : null,
      ticketId: plan.anchors[i].ticket.ticketId,
      locatorOwnerMatches:
        data.ticketOwner?.toLowerCase() === plan.anchors[i].ticket.owner.toLowerCase(),
      queueAddress: data.queueAddress,
      sharesRaw18: r?.[0]?.toString() ?? null,
      usdatOwedRaw6: r?.[1]?.toString() ?? null,
      requestedAtUnix: r?.[2]?.toString() ?? null,
      minSharePriceRaw: r?.[3]?.toString() ?? null,
      status: r?.[4] ?? null,
      vaultPaused: data.vaultPaused,
      queuePaused: data.queuePaused,
      claimSimulation: uint(data.ticketClaim)
        ? 'success'
        : rows.find((t) => t.key === 'ticketClaim')?.response?.error?.code === 3
          ? 'evm_revert'
          : 'unassessed',
      claimReturnUsdatRaw: uint(data.ticketClaim) ? data.ticketClaim : null,
      amountBasis:
        uint(data.ticketClaim) && data.ticketClaim === r?.[1]?.toString()
          ? 'claim_simulated_net_amount'
          : 'recorded_owed_amount_if_delivered',
      feeDeductionKnown: uint(data.ticketClaim) && data.ticketClaim === r?.[1]?.toString(),
      statusInterpretation: 'unverified_current_implementation',
    }
  }
  return {
    source: { ...plan.anchors[i].source, finalized: true },
    status: identity && ausd ? 'conditional_quote' : 'incomplete',
    identityVerified: Boolean(identity),
    usdcQuotedRaw: identity ? data.usdcQuotedRaw : null,
    ausdQuotedRaw: identity ? ausd : null,
    curveCashUsdcRaw: data.curveCashUsdcRaw,
    curveCashUsdatRaw: data.curveCashUsdatRaw,
    uniswapActiveLiquidityRaw: data.uniswapActiveLiquidityRaw,
    runtimeCodeHashes: {
      curve: data.code_curve,
      pool: data.code_pool,
      quoter: data.code_quoter,
      queue: data.code_queue ?? null,
      vault: data.code_vault ?? null,
    },
    protocolQuote: {
      input: { usdatInputRaw: '10000000000', assetUSDat: CONTRACTS.usdat, assetDecimals: 6 },
      status: identity && protocolAusd ? 'conditional_quote' : 'incomplete',
      usdcQuotedRaw: identity ? data.protocolUsdcQuotedRaw : null,
      ausdQuotedRaw: identity ? protocolAusd : null,
    },
    proxyInspection: 'not_read',
    sourceImplementationEquivalence: false,
    ticket,
    missingLegs: missing,
    missingFacts,
  }
}
export function replaySaturnConversionHistory(receipt, plan) {
  const expected = validatePlan(plan),
    { sha256, ...body } = receipt
  check(
    sha(JSON.stringify(body)) === sha256 &&
      receipt.schema === 'saturn_historical_conversion_capture_v1' &&
      receipt.planSha256 === expected.planSha256 &&
      same(receipt.plan, plan) &&
      same(receipt.origins, HOSTS) &&
      same(receipt.policy, POLICY) &&
      receipt.execution === 'unassessed' &&
      receipt.sourceImplementationEquivalence === false,
    'receipt_binding',
  )
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
  let effectivePlan = structuredClone(plan)
  if (plan.anchors.some((a) => a.currentFinalized)) {
    const heads = HOSTS.map(
      (host) =>
        receipt.traces.find((t) => t.origin === host && t.key === 'finalized')?.response?.result,
    ).map((v) => (v ? header(v) : null))
    if (
      heads.every(Boolean) &&
      !(heads[0].blockNumber === heads[1].blockNumber && !same(heads[0], heads[1]))
    ) {
      const source = heads.reduce((a, b) =>
        BigInt(a.blockNumber) <= BigInt(b.blockNumber) ? a : b,
      )
      effectivePlan.anchors = plan.anchors.map((a) =>
        a.currentFinalized ? { ...a, source, receiptSha256: plan.locatorFileSha256 } : a,
      )
    }
  }
  check(
    same(
      receipt.sources,
      effectivePlan.anchors.map((a) => a.source ?? null),
    ),
    'derived_sources',
  )
  const setupHeads = HOSTS.map(
    (h) => receipt.traces.find((t) => t.origin === h && t.key === 'finalized')?.response?.result,
  ).map((v) => (v ? header(v) : null))
  const globalHeadAgreement =
    setupHeads.every(Boolean) &&
    !(
      setupHeads[0].blockNumber === setupHeads[1].blockNumber && !same(setupHeads[0], setupHeads[1])
    )
  const originPoints = HOSTS.map((host) => {
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
      (!chain || (same(chain.request.params, []) && chain.request.method === 'eth_chainId')) &&
        (!final ||
          (final.request.method === 'eth_getBlockByNumber' &&
            same(final.request.params, ['finalized', false]))),
      'setup_requests',
    )
    check(
      rows.filter((t) => t.anchor === -1).every((t) => ['chain', 'finalized'].includes(t.key)) &&
        new Set(rows.filter((t) => t.anchor === -1).map((t) => t.key)).size ===
          rows.filter((t) => t.anchor === -1).length &&
        rows.every(
          (t) => Number.isInteger(t.anchor) && t.anchor >= -1 && t.anchor < plan.anchors.length,
        ),
      'trace_scope',
    )
    const ceiling = final?.response?.result ? header(final.response.result) : null
    return effectivePlan.anchors.map((a, i) => {
      if (!a.source)
        return {
          source: null,
          status: 'incomplete',
          identityVerified: false,
          usdcQuotedRaw: null,
          ausdQuotedRaw: null,
          missingLegs: ['current_finalized_source'],
        }
      const group = rows.filter((t) => t.anchor === i),
        before = group.find((t) => t.key === 'header_before'),
        after = group.find((t) => t.key === 'header_after'),
        tag = '0x' + BigInt(a.source.blockNumber).toString(16),
        pin = { blockHash: a.source.blockHash, requireCanonical: true }
      if (before && after) {
        check(
          Date.parse(before.startedAt) >= Date.parse(final?.completedAt) &&
            Date.parse(before.startedAt) >= Date.parse(chain?.completedAt),
          'setup_order',
        )
        check(
          before.request.method === 'eth_getBlockByNumber' &&
            after.request.method === 'eth_getBlockByNumber' &&
            same(before.request.params, [tag, false]) &&
            same(after.request.params, [tag, false]),
          'header_request',
        )
        for (const t of group.filter((t) => !t.key.startsWith('header_')))
          check(
            Date.parse(t.startedAt) >= Date.parse(before.completedAt) &&
              Date.parse(t.completedAt) <= Date.parse(after.startedAt),
            'header_enclosure',
          )
      }
      const all = specs(effectivePlan, i)
      const usdc = group.find((t) => t.key === 'usdcQuotedRaw')?.response?.result
      let u = null
      try {
        u = decodeFunctionResult({ abi: ABI, functionName: 'get_dy', data: usdc })
      } catch {}
      if (u > 0n) all.push(quoter(u.toString()))
      let pu = null
      try {
        pu = decodeFunctionResult({
          abi: ABI,
          functionName: 'get_dy',
          data: group.find((t) => t.key === 'protocolUsdcQuotedRaw')?.response?.result,
        })
      } catch {}
      if (pu > 0n) all.push(quoter(pu.toString(), 'protocolAusdQuotedRaw'))
      for (const t of group.filter((t) => !t.key.startsWith('header_'))) {
        const s = all.find((s) => s.key === t.key)
        check(
          s &&
            t.request.method === s.method &&
            same(
              t.request.params,
              s.method === 'eth_call'
                ? [{ to: s.to, data: s.data, ...(s.from ? { from: s.from } : {}) }, pin]
                : [s.to, pin],
            ),
          'state_request',
        )
      }
      check(new Set(group.map((t) => t.key)).size === group.length, 'duplicate_trace')
      const valid =
        globalHeadAgreement &&
        chain?.response?.result === '0x1' &&
        ceiling &&
        BigInt(ceiling.blockNumber) >= BigInt(a.source.blockNumber) &&
        Date.parse(ceiling.blockTime) <= Date.parse(receipt.capturedAt) &&
        before?.response?.result &&
        after?.response?.result &&
        same(header(before.response.result), a.source) &&
        same(header(after.response.result), a.source) &&
        (ceiling.blockNumber !== a.source.blockNumber || same(ceiling, a.source))
      const point = reconstruct(effectivePlan, i, group)
      if (!valid) {
        point.status = 'incomplete'
        point.identityVerified = false
        point.usdcQuotedRaw = null
        point.ausdQuotedRaw = null
        point.source.finalized = false
        point.missingLegs.push('canonical_source_setup')
        point.protocolQuote = {
          ...point.protocolQuote,
          status: 'incomplete',
          usdcQuotedRaw: null,
          ausdQuotedRaw: null,
        }
        if (point.ticket) {
          point.ticket = null
          point.missingFacts.push('canonical_ticket_source')
        }
      }
      return point
    })
  })
  const requiredQuote = (p) => ({
    source: p.source,
    status: p.status,
    identityVerified: p.identityVerified,
    usdcQuotedRaw: p.usdcQuotedRaw,
    ausdQuotedRaw: p.ausdQuotedRaw,
    runtimeCodeHashes: Object.fromEntries(
      ['curve', 'pool', 'quoter'].map((k) => [k, p.runtimeCodeHashes?.[k] ?? null]),
    ),
    missingLegs: p.missingLegs,
  })
  const points = effectivePlan.anchors.map((a, i) => {
    const [x, y] = originPoints.map((p) => p[i])
    if (!same(requiredQuote(x), requiredQuote(y)))
      return {
        source: a.source,
        status: 'incomplete',
        identityVerified: false,
        usdcQuotedRaw: null,
        ausdQuotedRaw: null,
        protocolQuote: {
          input: { usdatInputRaw: '10000000000', assetUSDat: CONTRACTS.usdat, assetDecimals: 6 },
          status: 'incomplete',
          usdcQuotedRaw: null,
          ausdQuotedRaw: null,
        },
        ticket: null,
        missingLegs: ['two_origin_conversion_disagreement'],
        missingFacts: [],
        origins: [x, y],
      }
    const p = structuredClone(x)
    p.missingFacts = [...new Set([...(x.missingFacts ?? []), ...(y.missingFacts ?? [])])]
    if (!p.runtimeCodeHashes) return p
    for (const k of ['queue', 'vault'])
      if (x.runtimeCodeHashes[k] !== y.runtimeCodeHashes[k]) {
        p.runtimeCodeHashes[k] = null
        p.missingFacts.push('two_origin_code_' + k)
      }
    for (const k of ['curveCashUsdcRaw', 'curveCashUsdatRaw', 'uniswapActiveLiquidityRaw'])
      if (x[k] !== y[k]) {
        p[k] = null
        p.missingFacts.push('two_origin_' + k)
      }
    if (!same(x.protocolQuote, y.protocolQuote)) {
      p.protocolQuote = {
        ...x.protocolQuote,
        status: 'incomplete',
        usdcQuotedRaw: null,
        ausdQuotedRaw: null,
      }
      p.missingFacts.push('two_origin_protocol_quote')
      p.originProtocolQuotes = [x.protocolQuote, y.protocolQuote]
    }
    const ticketCore = (t) =>
      t
        ? Object.fromEntries(
            Object.entries(t).filter(
              ([k]) =>
                ![
                  'vaultPaused',
                  'queuePaused',
                  'claimSimulation',
                  'claimReturnUsdatRaw',
                  'amountBasis',
                  'feeDeductionKnown',
                ].includes(k),
            ),
          )
        : null
    if (!same(ticketCore(x.ticket), ticketCore(y.ticket))) {
      p.ticket = null
      p.missingFacts.push('two_origin_ticket_facts')
      p.originTicketFacts = [x.ticket, y.ticket]
    } else if (p.ticket) {
      for (const k of ['vaultPaused', 'queuePaused'])
        if (x.ticket[k] !== y.ticket[k]) {
          p.ticket[k] = null
          p.missingFacts.push('two_origin_' + k)
        }
      const claim = (t) => ({
        claimSimulation: t.claimSimulation,
        claimReturnUsdatRaw: t.claimReturnUsdatRaw,
        amountBasis: t.amountBasis,
        feeDeductionKnown: t.feeDeductionKnown,
      })
      if (!same(claim(x.ticket), claim(y.ticket))) {
        Object.assign(p.ticket, {
          claimSimulation: 'unassessed',
          claimReturnUsdatRaw: null,
          amountBasis: 'recorded_owed_amount_if_delivered',
          feeDeductionKnown: false,
        })
        p.missingFacts.push('two_origin_claim_simulation')
        p.originClaimFacts = [claim(x.ticket), claim(y.ticket)]
      }
    }
    return p
  })

  return {
    status: 'verified_two_origin_saturn_conversion_history',
    captureReceiptSha256: sha256,
    knowledgeCutoff: receipt.capturedAt,
    input: { usdatInputRaw: plan.usdatInputRaw, assetUSDat: CONTRACTS.usdat, assetDecimals: 6 },
    points,
    elapsedSeconds: effectivePlan.anchors
      .slice(1)
      .map((a, i) =>
        a.source && effectivePlan.anchors[i].source
          ? (Date.parse(a.source.blockTime) -
              Date.parse(effectivePlan.anchors[i].source.blockTime)) /
            1000
          : null,
      ),
    completeQuoteCount: points.filter((p) => p.status === 'conditional_quote').length,
    execution: 'unassessed',
    prospectiveValidated: false,
    sourceImplementationEquivalence: false,
  }
}
export function normalizedSaturnEvidence(receipt, plan) {
  const replay = replaySaturnConversionHistory(receipt, plan),
    last = plan.anchors.findIndex((a) => a.currentFinalized)
  const history = {
    ...replay,
    points: replay.points.filter((_, i) => i !== last),
    completeQuoteCount: replay.points.filter(
      (p, i) => i !== last && p.status === 'conditional_quote',
    ).length,
    elapsedSeconds: replay.points
      .filter((_, i) => i !== last)
      .map((p) =>
        p.source && replay.points[0].source
          ? (Date.parse(p.source.blockTime) - Date.parse(replay.points[0].source.blockTime)) / 1000
          : null,
      ),
  }
  const point = last >= 0 ? replay.points[last] : null
  const current = point
    ? {
        captureReceiptSha256: receipt.sha256,
        readAtUtc: receipt.capturedAt,
        input: replay.input,
        point,
        entitlementMethod: 'recorded_usdat_owed',
        physicalPullableUsdatRaw: null,
        claimSimulation: point.ticket?.claimSimulation ?? 'unassessed',
        claimReturnUsdatRaw: point.ticket?.claimReturnUsdatRaw ?? null,
      }
    : null
  return { history, current }
}
function publicSerialization(value) {
  const text = JSON.stringify(value)
  check(!/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(text), 'artifact_url')
  return text
}
export function writeSaturnCapture(out, receipt) {
  const text = publicSerialization(receipt) + '\n'
  check(Buffer.byteLength(text) <= POLICY.maxArtifactBytes, 'artifact_size')
  check(
    statfsSync(resolve(out, '..')).bavail * statfsSync(resolve(out, '..')).bsize -
      Buffer.byteLength(text) >=
      POLICY.reserveBytes,
    'disk_reserve',
  )
  writeFileSync(out, text, { flag: 'wx' })
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2] ?? '--check-only',
    q = process.argv.find((x) => x.startsWith('--usdat-raw='))?.slice(12),
    plan = await prepareSaturnConversionPlan(q ? { usdatInputRaw: q } : {})
  if (mode === '--check-only')
    console.log(
      JSON.stringify({
        status: 'prepared_no_rpc',
        plan,
        ...validatePlan(plan),
        policy: POLICY,
        scope: 'historical_exact_size_public_quote_not_executed_payout',
      }),
    )
  else if (mode === '--capture') {
    const policy = readProviderPolicy()
    check(
      policy?.status === 'active' && policy.policyId === 'configured-c1-c3-v1',
      'inactive_provider_policy',
    )
    const origins = configuredProviders(null, policy)
    const out = process.argv.find((x) => x.startsWith('--out='))?.slice(6)
    check(out, 'output_required')
    check(
      statfsSync(resolve(out, '..')).bavail * statfsSync(resolve(out, '..')).bsize >=
        POLICY.reserveBytes,
      'disk_reserve',
    )
    const receipt = await captureSaturnConversionHistory(plan, origins)
    replaySaturnConversionHistory(receipt, plan)
    writeSaturnCapture(out, receipt)
    console.log(
      JSON.stringify({
        sha256: receipt.sha256,
        physicalStarts: receipt.physicalStarts,
        capturedAt: receipt.capturedAt,
      }),
    )
  } else if (mode === '--replay') {
    const file = process.argv.find((x) => x.startsWith('--file='))?.slice(7)
    check(file, 'replay_file')
    const bytes = readBoundedReceiptFile(file, {
        maxFileBytes: POLICY.maxArtifactBytes,
        maxTotalBytes: POLICY.maxArtifactBytes,
        totalBytes: 0,
      }),
      receipt = JSON.parse(bytes),
      normalized = normalizedSaturnEvidence(receipt, plan)
    const out = process.argv.find((x) => x.startsWith('--export='))?.slice(9)
    if (out) {
      const artifact = {
        schema: 'saturn_historical_conversion_export_v1',
        captureFileSha256: sha(bytes),
        ...normalized,
      }
      writeSaturnCapture(out, artifact)
      console.log(
        JSON.stringify({
          status: 'replayed_no_rpc',
          captureFileSha256: artifact.captureFileSha256,
          historyQuotes: normalized.history.points.filter((p) => p.status === 'conditional_quote')
            .length,
          currentQuote: normalized.current?.point.status ?? 'unavailable',
          exportSha256: sha(publicSerialization(artifact) + '\n'),
        }),
      )
    } else console.log(JSON.stringify(normalized))
  } else throw new Error('usage_check_capture_replay')
}
