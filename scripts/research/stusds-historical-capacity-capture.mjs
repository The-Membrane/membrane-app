// One-shot StUSDS contract-reported prongs; exact historical clocks, no execution forecast.
// Primary rule reference: https://github.com/sky-ecosystem/stusds/blob/master/src/StUsds.sol#L431
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
  vault: '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9',
  usds: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
  historicalImplementation: '0x7a61b7adcfd493f7cf0f86dfcecb94b72c227f22',
})
export const HOSTS = Object.freeze(['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'])
export const POLICY = Object.freeze({
  maxRequests: 190,
  deadlineMs: 90000,
  rpcTimeoutMs: 8000,
  cleanupGraceMs: 250,
  maxResponseBytes: 131072,
  maxStoredResponseBytes: 1572864,
  maxInFlightPerHost: 2,
  minStartSpacingMs: 50,
  maxArtifactBytes: 2097152,
  reserveBytes: 1073741824,
})
export const IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
export const HISTORICAL_IMPLEMENTATION_CODE_SHA256 =
  '32dd3d97bb8edaeead53dcf7c1d7a7aba4bbaa594782353b7beb2b9acd2c8b6b'
const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
export const ABI = freeze(
  parseAbi([
    'function vat() view returns(address)',
    'function jug() view returns(address)',
    'function clip() view returns(address)',
    'function ilk() view returns(bytes32)',
    'function asset() view returns(address)',
    'function decimals() view returns(uint8)',
    'function totalSupply() view returns(uint256)',
    'function chi() view returns(uint192)',
    'function str() view returns(uint256)',
    'function rho() view returns(uint64)',
    'function convertToAssets(uint256) view returns(uint256)',
    'function balanceOf(address) view returns(uint256)',
    'function previewRedeem(uint256) view returns(uint256)',
    'function maxWithdraw(address) view returns(uint256)',
    'function base() view returns(uint256)',
    'function drip(bytes32) returns(uint256)',
    'function Due() view returns(uint256)',
  ]),
)
export const VAT_ABI = freeze(
  parseAbi([
    'function ilks(bytes32) view returns(uint256 Art,uint256 rate,uint256 spot,uint256 line,uint256 dust)',
  ]),
)
export const JUG_ABI = freeze(
  parseAbi(['function ilks(bytes32) view returns(uint256 duty,uint256 rho)']),
)
const abis = { main: ABI, vat: VAT_ABI, jug: JUG_ABI },
  MAX = (1n << 256n) - 1n,
  RAY = 10n ** 27n,
  HEX = /^0x(?:[0-9a-f]{2})*$/i,
  HASH = /^0x[0-9a-f]{64}$/i,
  ADDRESS = /^0x[0-9a-f]{40}$/i
const check = (ok, code) => {
    if (!ok) throw Error('stusds_capacity_' + code)
  },
  sha = (v) => createHash('sha256').update(v).digest('hex'),
  same = (a, b) => JSON.stringify(a) === JSON.stringify(b),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  seal = (b) => ({ ...b, sha256: sha(JSON.stringify(b)) })
const utc = (v) =>
  typeof v === 'string' &&
  Number.isFinite(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const ISSUES = freeze([
  {
    number: '00000001',
    sha256: '9ca7a448fe845c7302698bcef0a76478b8154eae4e9442a5b755e865a759150c',
    source: {
      chainId: 1,
      blockNumber: '26095225',
      blockHash: '0xd89cf9d7bd2805135bc60f22faa270e8548a1a0a67cb53fbb87d4fb6ebcbc78e',
      blockTime: '2026-10-01T04:57:59.000Z',
    },
    owner: '0x912dbf3e58232de54f3d108dbb05d87b47c2fb61',
  },
  {
    number: '00000002',
    sha256: '527743555f9412804b2467c04bf9d4a1679133aceb5b1b00c358b3d3a5237649',
    source: {
      chainId: 1,
      blockNumber: '26095320',
      blockHash: '0xd0157a367fa9ab12e25ac6883d8ada269dea7778197e35050aa8634393a6c9c4',
      blockTime: '2026-10-01T05:17:11.000Z',
    },
    owner: '0x7c6211ab60fda17eecb0f7f5d3d252dcb84924c8',
  },
])
function fixedPlan(includeCurrent) {
  return {
    schema: 'stusds_capacity_plan_v1',
    routeKey: 'USDS → StUsds [USDS]',
    destination: CONTRACTS.vault,
    asset: CONTRACTS.usds,
    assetDecimals: 18,
    anchors: [
      ...ISSUES.map((x) => ({ source: x.source, owner: x.owner, issueSha256: x.sha256 })),
      ...(includeCurrent ? [{ currentFinalized: true, owner: ISSUES[0].owner }] : []),
    ],
  }
}
export function validateStusdsCapacityPlan(plan) {
  check(same(plan, fixedPlan(plan?.anchors?.length === 3)), 'fixed_plan')
  return { expectedStarts: 4 + 62 * plan.anchors.length, planSha256: sha(JSON.stringify(plan)) }
}
export function prepareStusdsCapacityPlan({ includeCurrent = true } = {}) {
  check(typeof includeCurrent === 'boolean', 'current_option')
  let previous = null
  for (const spec of ISSUES) {
    const bytes = readBoundedReceiptFile(
        resolve(
          'data/research/venue-signals/carry-public-stusds-exit-issues',
          spec.number + '.json',
        ),
        { maxFileBytes: 262144, maxTotalBytes: 262144, totalBytes: 0 },
      ),
      v = JSON.parse(bytes),
      { sha256, ...body } = v
    check(
      sha(JSON.stringify(body)) === spec.sha256 &&
        sha256 === spec.sha256 &&
        v.previousSha256 === previous,
      'issue_chain',
    )
    const b = v.baseline
    check(
      v.destination === CONTRACTS.vault &&
        v.routeKey === 'USDS → StUsds [USDS]' &&
        v.originalAsset === CONTRACTS.usds &&
        v.candidate.holder === spec.owner &&
        b.targetBlock === spec.source.blockNumber &&
        b.targetHash === spec.source.blockHash &&
        b.targetBlockAt === spec.source.blockTime &&
        b.assetDecimals === 18 &&
        b.shareDecimals === 18,
      'issue_identity',
    )
    previous = sha256
  }
  return freeze(fixedPlan(includeCurrent))
}
const call = (key, to, name, args = [], abi = 'main') => ({
  key,
  method: 'eth_call',
  params: [{ to, data: encodeFunctionData({ abi: abis[abi], functionName: name, args }) }],
  name,
  abi,
})
function first(owner) {
  return [
    { key: 'code_proxy', method: 'eth_getCode', params: [CONTRACTS.vault] },
    {
      key: 'implementation_slot',
      method: 'eth_getStorageAt',
      params: [CONTRACTS.vault, IMPLEMENTATION_SLOT],
    },
    ...['vat', 'jug', 'clip', 'ilk', 'asset', 'decimals', 'totalSupply', 'chi', 'str', 'rho'].map(
      (n) => call(n, CONTRACTS.vault, n),
    ),
    call('chiNow', CONTRACTS.vault, 'convertToAssets', [RAY]),
    call('ownerShares', CONTRACTS.vault, 'balanceOf', [owner]),
    call('ownerMaxWithdraw', CONTRACTS.vault, 'maxWithdraw', [owner]),
  ]
}
const decode = (spec, data) =>
  decodeFunctionResult({ abi: abis[spec.abi ?? 'main'], functionName: spec.name, data })
const validAddress = (v) => typeof v === 'string' && ADDRESS.test(v) && v !== '0x' + '0'.repeat(40)
function derived(rows) {
  const by = new Map(rows.map((t) => [t.key, t]))
  const addr = (k) => {
    try {
      const v = decode(
        first(ISSUES[0].owner).find((s) => s.key === k),
        by.get(k)?.response?.result,
      ).toLowerCase()
      return validAddress(v) ? v : null
    } catch {
      return null
    }
  }
  let implementation = null,
    ilk = null,
    shares = null
  const word = by.get('implementation_slot')?.response?.result
  if (typeof word === 'string' && /^0x0{24}[0-9a-f]{40}$/i.test(word)) {
    const a = '0x' + word.slice(-40).toLowerCase()
    if (validAddress(a)) implementation = a
  }
  try {
    ilk = decode(
      first(ISSUES[0].owner).find((s) => s.key === 'ilk'),
      by.get('ilk')?.response?.result,
    )
    if (typeof ilk !== 'string' || !HASH.test(ilk)) ilk = null
  } catch {}
  try {
    shares = decode(
      first(ISSUES[0].owner).find((s) => s.key === 'ownerShares'),
      by.get('ownerShares')?.response?.result,
    )
    if (typeof shares !== 'bigint' || shares < 0n || shares > MAX) shares = null
  } catch {}
  return { vat: addr('vat'), jug: addr('jug'), clip: addr('clip'), implementation, ilk, shares }
}
function second(d) {
  if (!d.vat || !d.jug || !d.clip || !d.implementation || !d.ilk) return []
  return [
    ...['implementation', 'vat', 'jug', 'clip'].map((k) => ({
      key: 'code_' + k,
      method: 'eth_getCode',
      params: [d[k]],
    })),
    { key: 'code_asset', method: 'eth_getCode', params: [CONTRACTS.usds] },
    call('assetDecimals', CONTRACTS.usds, 'decimals'),
    call('vatIlks', d.vat, 'ilks', [d.ilk], 'vat'),
    call('jugIlks', d.jug, 'ilks', [d.ilk], 'jug'),
    call('jugBase', d.jug, 'base'),
    call('burnRateNow', d.jug, 'drip', [d.ilk]),
    call('clipDue', d.clip, 'Due'),
    call('clipIlk', d.clip, 'ilk'),
    call('jugVat', d.jug, 'vat'),
    ...(d.shares !== null
      ? [call('ownerFullEntitlement', CONTRACTS.vault, 'previewRedeem', [d.shares])]
      : []),
  ]
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
export async function captureStusdsCapacity(
  plan,
  origins,
  { fetcher = fetch, now = Date.now, rpcTimeoutMs = POLICY.rpcTimeoutMs } = {},
) {
  plan = structuredClone(plan)
  const { expectedStarts, planSha256 } = validateStusdsCapacityPlan(plan)
  check(
    Number.isSafeInteger(rpcTimeoutMs) && rpcTimeoutMs > 0 && rpcTimeoutMs <= POLICY.rpcTimeoutMs,
    'timeout',
  )
  check(Array.isArray(origins) && origins.length === 2, 'origins')
  // Keep validated primitive endpoints private across awaits and caller mutation.
  const captureOrigins = Object.freeze(
    origins.map((o) => {
      const host = o?.host,
        url = o?.url
      check(typeof host === 'string' && typeof url === 'string', 'origins')
      return Object.freeze({ host, url })
    }),
  )
  check(
    captureOrigins.every((o, i) => {
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
    captureOrigins.map(async (o) => {
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
    }),
    headAgreement =
      heads.every(Boolean) &&
      !(heads[0].blockNumber === heads[1].blockNumber && !same(heads[0], heads[1])),
    current = headAgreement
      ? heads.reduce((a, b) => (BigInt(a.blockNumber) <= BigInt(b.blockNumber) ? a : b))
      : null,
    sources = plan.anchors.map((a) => (a.currentFinalized ? current : a.source))
  if (!headAgreement) {
    closed = true
    captureClosedReason ??= 'finalized_head_unavailable_or_conflicting'
  }
  await Promise.all(
    captureOrigins.map(async (o, oi) => {
      for (let i = 0; i < sources.length && !closed; i++) {
        const source = sources[i]
        if (!source) continue
        if (
          BigInt(heads[oi].blockNumber) < BigInt(source.blockNumber) ||
          (heads[oi].blockNumber === source.blockNumber && !same(heads[oi], source))
        )
          continue
        const pin = { blockHash: source.blockHash, requireCanonical: true },
          tag = '0x' + BigInt(source.blockNumber).toString(16)
        await rpc(o, i, 'header_before', 'eth_getBlockByNumber', [tag, false])
        for (const x of first(plan.anchors[i].owner))
          await rpc(o, i, x.key, x.method, [...x.params, pin])
        const d = derived(traces.filter((t) => t.origin === o.host && t.anchor === i))
        for (const x of second(d)) await rpc(o, i, x.key, x.method, [...x.params, pin])
        await rpc(o, i, 'header_after', 'eth_getBlockByNumber', [tag, false])
      }
    }),
  )
  closed = true
  for (const c of controllers) c.abort()
  check(now() - started <= POLICY.deadlineMs + POLICY.cleanupGraceMs, 'capture_completion')
  const receipt = seal({
    schema: 'stusds_capacity_capture_v1',
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
    sourceImplementationEquivalence: false,
  })
  check(Buffer.byteLength(publicSerialization(receipt)) <= POLICY.maxArtifactBytes, 'artifact_size')
  return receipt
}
/** Arithmetic only; callers must independently qualify the runtime/rule. Not source evidence. */
export function stusdsUnusedFundsArithmetic({ supplyRaw, chiNowRaw, artRaw, rateRaw, dueRaw }) {
  try {
    const values = [supplyRaw, chiNowRaw, artRaw, rateRaw, dueRaw]
    check(
      values.every(
        (v) => typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX,
      ),
      'arithmetic_input',
    )
    const [S, chi, A, rate, Due] = values.map(BigInt),
      gross = S * chi,
      debt = A * rate
    check(gross <= MAX && debt <= MAX && debt + Due <= MAX, 'arithmetic_uint256')
    return ((gross > debt + Due ? gross - debt - Due : 0n) / RAY).toString()
  } catch {
    return null
  }
}
export function replayStusdsCapacity(receipt, plan) {
  const expected = validateStusdsCapacityPlan(plan),
    { sha256, ...body } = receipt
  check(
    sha(JSON.stringify(body)) === sha256 &&
      receipt.schema === 'stusds_capacity_capture_v1' &&
      same(receipt.plan, plan) &&
      receipt.planSha256 === expected.planSha256 &&
      same(receipt.origins, HOSTS) &&
      same(receipt.policy, POLICY) &&
      receipt.execution === 'unassessed' &&
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
    headAgreement =
      heads.every(Boolean) &&
      !(heads[0].blockNumber === heads[1].blockNumber && !same(heads[0], heads[1])),
    current = headAgreement
      ? heads.reduce((a, b) => (BigInt(a.blockNumber) <= BigInt(b.blockNumber) ? a : b))
      : null,
    sources = plan.anchors.map((a) => (a.currentFinalized ? current : a.source))
  check(same(sources, receipt.sources), 'derived_sources')
  const originPoints = HOSTS.map((host, oi) => {
    const rows = receipt.traces.filter((t) => t.origin === host)
    check(
      rows.every(
        (t, i) =>
          !i ||
          Date.parse(t.startedAt) - Date.parse(rows[i - 1].completedAt) >= POLICY.minStartSpacingMs,
      ),
      'spacing',
    )
    const setup = rows.filter((t) => t.anchor === -1),
      chain = setup.find((t) => t.key === 'chain'),
      final = setup.find((t) => t.key === 'finalized')
    check(
      setup.every((t) => ['chain', 'finalized'].includes(t.key)) &&
        new Set(setup.map((t) => t.key)).size === setup.length,
      'setup_unique',
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
    check(
      rows.every((t) => Number.isInteger(t.anchor) && t.anchor >= -1 && t.anchor < sources.length),
      'anchor_scope',
    )
    return sources.map((source, i) => {
      const group = rows.filter((t) => t.anchor === i),
        by = new Map(group.map((t) => [t.key, t])),
        d = derived(group)
      check(group.length === by.size, 'duplicate')
      if (!source) {
        check(group.length === 0, 'missing_source_calls')
        return { source: null, status: 'incomplete', missingLegs: ['current_source'] }
      }
      const tag = '0x' + BigInt(source.blockNumber).toString(16),
        pin = { blockHash: source.blockHash, requireCanonical: true },
        specs = [
          { key: 'header_before', method: 'eth_getBlockByNumber', params: [tag, false] },
          ...first(plan.anchors[i].owner).map((x) => ({ ...x, params: [...x.params, pin] })),
          ...second(d).map((x) => ({ ...x, params: [...x.params, pin] })),
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
      const missing = specs.filter((x) => !by.get(x.key)?.response?.result).map((x) => x.key)
      let facts = null,
        holder = null,
        runtime = null
      try {
        check(
          headAgreement &&
            chain.response.result === '0x1' &&
            BigInt(heads[oi].blockNumber) >= BigInt(source.blockNumber) &&
            (heads[oi].blockNumber !== source.blockNumber || same(heads[oi], source)) &&
            same(header(before.response.result), source) &&
            same(header(after.response.result), source),
          'headers',
        )
        const get = (key) =>
          decode(
            specs.find((x) => x.key === key),
            by.get(key)?.response?.result,
          )
        check(
          get('asset').toLowerCase() === CONTRACTS.usds &&
            get('decimals') === 18 &&
            get('assetDecimals') === 18 &&
            get('clipIlk') === d.ilk &&
            get('jugVat').toLowerCase() === d.vat,
          'identity',
        )
        runtime = {}
        for (const key of ['proxy', 'implementation', 'vat', 'jug', 'clip', 'asset']) {
          const code = by.get('code_' + key)?.response?.result
          check(typeof code === 'string' && HEX.test(code) && code.length > 2, 'runtime_code')
          runtime[key] = { keccak256: keccak256(code), sha256: sha(code) }
        }
        const retainedImplementationMatches =
          d.implementation === CONTRACTS.historicalImplementation &&
          runtime.implementation.sha256 === HISTORICAL_IMPLEMENTATION_CODE_SHA256
        const u = (key) => {
          const v = get(key)
          check(typeof v === 'bigint' && v >= 0n && v <= MAX, 'uint')
          return v
        }
        const supply = u('totalSupply'),
          chi = u('chi'),
          str = u('str'),
          rho = u('rho'),
          chiNow = u('chiNow'),
          [Art, storedRate] = get('vatIlks'),
          [duty, jugRho] = get('jugIlks'),
          base = u('jugBase'),
          burnRate = u('burnRateNow'),
          Due = u('clipDue'),
          at = BigInt(Date.parse(source.blockTime) / 1000)
        check(
          [Art, storedRate, duty, jugRho].every(
            (v) => typeof v === 'bigint' && v >= 0n && v <= MAX,
          ) &&
            rho <= at &&
            jugRho <= at,
          'rate_times',
        )
        const unused = (rate) => {
          const amount = stusdsUnusedFundsArithmetic({
            supplyRaw: supply.toString(),
            chiNowRaw: chiNow.toString(),
            artRaw: Art.toString(),
            rateRaw: rate.toString(),
            dueRaw: Due.toString(),
          })
          return amount
        }
        const getterRate = base === 0n || jugRho === at ? burnRate : null
        facts = {
          totalSupplyRaw: supply.toString(),
          chiRaw: chi.toString(),
          strRaw: str.toString(),
          rhoUnix: rho.toString(),
          chiNowRaw: chiNow.toString(),
          vatArtRaw: Art.toString(),
          vatStoredRateRaw: storedRate.toString(),
          jugDutyRaw: duty.toString(),
          jugRhoUnix: jugRho.toString(),
          jugBaseRaw: base.toString(),
          burnRateNowRaw: burnRate.toString(),
          clipDueRaw: Due.toString(),
          units: {
            supply: 'wad18',
            chi: 'ray27',
            str: 'ray27',
            Art: 'wad18',
            rates: 'ray27',
            Due: 'rad45',
          },
          unusedFundsBurnRaw: retainedImplementationMatches ? unused(burnRate) : null,
          unusedFundsGetterRaw:
            !retainedImplementationMatches || getterRate === null ? null : unused(getterRate),
          getterRateBasis:
            getterRate === null
              ? 'unknown_base_nonzero_elapsed'
              : 'conditional_official_rule_same_as_burn',
          method: 'source_pinned_supply_times_chi_less_accrued_debt_and_auction_due_floor_ray',
          sourceRuleEquivalence: 'unverified',
          retainedImplementationMatches,
          derivationEligibility: retainedImplementationMatches
            ? 'conditional_retained_runtime_class'
            : 'censored_changed_or_unknown_implementation',
        }
        try {
          const full = u('ownerFullEntitlement'),
            max = u('ownerMaxWithdraw')
          holder = {
            owner: plan.anchors[i].owner,
            sharesRaw: d.shares.toString(),
            fullPositionEntitlementRaw: full.toString(),
            quotedMaxWithdrawRaw: max.toString(),
            quotedMinRuleMatches:
              facts.unusedFundsGetterRaw === null
                ? null
                : max ===
                  (full < BigInt(facts.unusedFundsGetterRaw)
                    ? full
                    : BigInt(facts.unusedFundsGetterRaw)),
            execution: 'unassessed',
          }
        } catch {}
      } catch {
        missing.push('source_identity_or_global_prongs_unverified')
      }
      return {
        source,
        status: facts ? 'conditional_contract_reported_prongs' : 'incomplete',
        addresses: { vat: d.vat, jug: d.jug, clip: d.clip, implementation: d.implementation },
        ilk: d.ilk,
        runtimeIdentities: runtime,
        globalProngs: facts,
        holderQuote: holder,
        missingLegs: missing,
      }
    })
  })
  const points = sources.map((source, i) => {
    const a = originPoints[0][i],
      b = originPoints[1][i],
      basis = (x) => ({
        source: x.source,
        addresses: x.addresses,
        ilk: x.ilk,
        runtimeIdentities: x.runtimeIdentities,
        globalProngs: x.globalProngs,
      })
    if (!a.globalProngs || !b.globalProngs || !same(basis(a), basis(b)))
      return {
        source,
        status: 'incomplete',
        globalProngs: null,
        holderQuote: null,
        missingLegs: ['two_origin_global_disagreement_or_unavailable'],
      }
    return {
      ...a,
      holderQuote: same(a.holderQuote, b.holderQuote) ? a.holderQuote : null,
      missingLegs: [...new Set([...a.missingLegs, ...b.missingLegs])],
      sourceImplementationEquivalence: false,
      holderExecutableExit: false,
      forecastValidated: false,
    }
  })
  check(
    Date.parse(receipt.capturedAt) >=
      Math.max(...sources.filter(Boolean).map((s) => Date.parse(s.blockTime))),
    'source_future',
  )
  const regimes = points.map((p) =>
    p.status === 'conditional_contract_reported_prongs'
      ? { addresses: p.addresses, ilk: p.ilk, runtime: p.runtimeIdentities }
      : null,
  )
  const historyRegimeMatch =
    regimes[0] !== null && regimes[1] !== null && same(regimes[0], regimes[1])
  const currentRegimeMatchesHistory =
    historyRegimeMatch && regimes[2] !== null && same(regimes[0], regimes[2])
  return freeze({
    status: 'replayed_stusds_capacity_prongs',
    historyRegimeMatch,
    currentRegimeMatchesHistory,
    capacityTranslationEligible:
      !!currentRegimeMatchesHistory &&
      points.every(
        (p) =>
          p.globalProngs?.retainedImplementationMatches === true &&
          p.globalProngs?.unusedFundsBurnRaw !== null,
      ),
    knowledgeCutoff: receipt.capturedAt,
    captureReceiptSha256: receipt.sha256,
    asset: CONTRACTS.usds,
    assetDecimals: 18,
    history: { points: points.slice(0, 2), elapsedSeconds: [0, 1152], sameHolder: false },
    current: points[2] ?? null,
    execution: 'unassessed',
    sourceImplementationEquivalence: false,
    holderExecutableExit: false,
    forecastValidated: false,
  })
}
function publicSerialization(value) {
  const text = JSON.stringify(value)
  check(!/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(text), 'artifact_url')
  return text
}
export function writeStusdsCapacityCapture(out, value, { statfs = statfsSync } = {}) {
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
  const plan = prepareStusdsCapacityPlan({
    includeCurrent: !process.argv.includes('--historical-only'),
  })
  if (mode === '--check-only')
    console.log(
      JSON.stringify({
        status: 'prepared_no_rpc',
        plan,
        ...validateStusdsCapacityPlan(plan),
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
    const receipt = await captureStusdsCapacity(plan, origins)
    replayStusdsCapacity(receipt, plan)
    writeStusdsCapacityCapture(out, receipt)
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
    console.log(JSON.stringify(replayStusdsCapacity(receipt, plan)))
  }
}
