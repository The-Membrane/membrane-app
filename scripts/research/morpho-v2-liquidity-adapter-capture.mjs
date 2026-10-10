// One-shot metadata pilot. Source semantics: VaultV2.exit pulls only its configured adapter/data.
// https://github.com/morpho-org/vault-v2/blob/main/src/VaultV2.sol#L697
// https://github.com/morpho-org/vault-v2/blob/main/src/interfaces/IAdapter.sol
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
import { encodeFunctionData, decodeFunctionResult, parseAbi, keccak256 } from 'viem'
import { readBoundedReceiptFile } from '../lib/boundedLocalReceiptFile.mjs'
export const HOSTS = Object.freeze(['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'])
export const POLICY = Object.freeze({
  maxRequests: 94,
  deadlineMs: 60000,
  rpcTimeoutMs: 8000,
  cleanupGraceMs: 250,
  maxResponseBytes: 131072,
  maxStoredResponseBytes: 1572864,
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
export const SUBJECT = freeze({
  routeKey: 'USDC → VaultV2 [USDC]',
  destination: '0x0026038a7fefef439d94bd99b4a10017e839d3a7',
  asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  assetDecimals: 6,
  shareDecimals: 18,
})
export const ABI = freeze(
  parseAbi([
    'function asset() view returns(address)',
    'function decimals() view returns(uint8)',
    'function balanceOf(address) view returns(uint256)',
    'function liquidityAdapter() view returns(address)',
    'function liquidityData() view returns(bytes)',
    'function isAdapter(address) view returns(bool)',
  ]),
)
const ZERO = '0x' + '0'.repeat(40),
  HEX = /^0x(?:[0-9a-f]{2})*$/i,
  HASH = /^0x[0-9a-f]{64}$/i,
  ADDRESS = /^0x[0-9a-f]{40}$/i,
  MAX = (1n << 256n) - 1n
const check = (v, c) => {
    if (!v) throw Error('morpho_v2_capture_' + c)
  },
  sha = (v) => createHash('sha256').update(v).digest('hex'),
  same = (a, b) => JSON.stringify(a) === JSON.stringify(b),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const utc = (v) =>
  typeof v === 'string' &&
  Number.isFinite(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const SEEDS = freeze([
  {
    sequence: 236,
    fileSha256: '0ac9f9d4bddae1b115fcd58d00c28ba995903760b2c2d4f3dc44347806a9ed47',
    receiptSha256: 'dc9ecd89dbe3eb7b96ac780c75c6833dbaefb52ae37a2a7cdd1f77d816dd5307',
    source: {
      chainId: 1,
      blockNumber: '26100913',
      blockHash: '0x2fe9266ceaaea215d32a4c5e0701f3c287705f2b976844cf3131534a814aa272',
      blockTime: '2026-10-01T23:59:59.000Z',
    },
  },
  {
    sequence: 237,
    fileSha256: 'cdc9ccaeee4bdd5c9c381aadc64f703a94227b133f6007e31860c9cc4ad9417f',
    receiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
    source: {
      chainId: 1,
      blockNumber: '26108081',
      blockHash: '0x9f430d0cc4301a9f8ea0315223c2ed6e66373f6454baac771cac7449d725ba37',
      blockTime: '2026-10-02T23:59:59.000Z',
    },
  },
])
const fixedPlan = () => ({
  schema: 'morpho_v2_adapter_plan_v1',
  subject: SUBJECT,
  anchors: [...SEEDS, { currentFinalized: true }],
})
export function prepareMorphoV2AdapterPlan() {
  const budget = { maxFileBytes: 131072, maxTotalBytes: 262144, totalBytes: 0 }
  for (const x of SEEDS) {
    const text = readBoundedReceiptFile(
        resolve(
          'data/research/venue-signals/local-carry-cash-v1',
          String(x.sequence).padStart(12, '0') + '.json',
        ),
        budget,
      ),
      r = JSON.parse(text),
      { sha256, ...body } = r
    check(
      sha(text) === x.fileSha256 &&
        sha256 === x.receiptSha256 &&
        sha(JSON.stringify(body)) === sha256,
      'seed_sha',
    )
    const rows = r.rows.filter((z) => z.destination === SUBJECT.destination)
    check(rows.length === 1, 'seed_subject')
    const z = rows[0]
    check(
      r.chainId === 1 &&
        r.block === x.source.blockNumber &&
        r.blockHash === x.source.blockHash &&
        r.blockAt === x.source.blockTime &&
        z.state === 'observed' &&
        z.routeKey === SUBJECT.routeKey &&
        z.asset === SUBJECT.asset &&
        z.assetDecimals === 6 &&
        z.shareDecimals === 18 &&
        z.block === r.block &&
        z.blockHash === r.blockHash &&
        z.cashRaw === '0',
      'seed_identity',
    )
  }
  return structuredClone(fixedPlan())
}
export function validateMorphoV2AdapterPlan(p) {
  check(same(p, fixedPlan()), 'plan')
  return { expectedStarts: POLICY.maxRequests, planSha256: sha(JSON.stringify(p)) }
}
const call = (key, to, name, args = []) => ({
  key,
  method: 'eth_call',
  params: [{ to, data: encodeFunctionData({ abi: ABI, functionName: name, args }) }],
  name,
})
function first() {
  return [
    { key: 'code_vault', method: 'eth_getCode', params: [SUBJECT.destination] },
    { key: 'code_asset', method: 'eth_getCode', params: [SUBJECT.asset] },
    call('asset', SUBJECT.destination, 'asset'),
    call('shareDecimals', SUBJECT.destination, 'decimals'),
    call('assetDecimals', SUBJECT.asset, 'decimals'),
    call('idleCash', SUBJECT.asset, 'balanceOf', [SUBJECT.destination]),
    call('liquidityAdapter', SUBJECT.destination, 'liquidityAdapter'),
    call('liquidityData', SUBJECT.destination, 'liquidityData'),
  ]
}
const decode = (spec, result) =>
  decodeFunctionResult({ abi: ABI, functionName: spec.name, data: result })
// Only exact canonical minimal-clone runtime gives a proven embedded implementation address.
// Other proxies/custom dispatch remain unknown; zero generic EIP1967 slots are guessed.
const cloneImplementation = (code) =>
  typeof code === 'string' &&
  /^0x363d3d373d3d3d363d73[0-9a-f]{40}5af43d82803e903d91602b57fd5bf3$/i.test(code)
    ? '0x' + code.slice(22, 62).toLowerCase()
    : null
function derived(rows) {
  const m = new Map(rows.map((t) => [t.key, t])),
    more = []
  let adapter = null
  try {
    adapter = decode(
      first().find((x) => x.key === 'liquidityAdapter'),
      m.get('liquidityAdapter')?.response?.result,
    ).toLowerCase()
    check(ADDRESS.test(adapter), 'adapter')
  } catch {
    adapter = null
  }
  if (adapter && adapter !== ZERO)
    more.push(call('isAdapter', SUBJECT.destination, 'isAdapter', [adapter]), {
      key: 'code_adapter',
      method: 'eth_getCode',
      params: [adapter],
    })
  return { adapter, more }
}
function cloneSpecs(rows) {
  return rows
    .filter((t) => ['code_vault', 'code_asset', 'code_adapter'].includes(t.key))
    .flatMap((t) => {
      const a = cloneImplementation(t.response?.result)
      return a && a !== ZERO
        ? [{ key: t.key + '_implementation', method: 'eth_getCode', params: [a] }]
        : []
    })
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
export async function captureMorphoV2AdapterMetadata(
  plan,
  origins,
  { fetcher = fetch, now = Date.now, rpcTimeoutMs = POLICY.rpcTimeoutMs } = {},
) {
  plan = structuredClone(plan)
  const { expectedStarts, planSha256 } = validateMorphoV2AdapterPlan(plan)
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
      heads.every((h) => h && Date.parse(h.blockTime) <= now()) &&
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
        for (const x of first()) await rpc(o, i, x.key, x.method, [...x.params, pin])
        const d = derived(traces.filter((t) => t.origin === o.host && t.anchor === i))
        for (const x of d.more) await rpc(o, i, x.key, x.method, [...x.params, pin])
        for (const x of cloneSpecs(traces.filter((t) => t.origin === o.host && t.anchor === i)))
          await rpc(o, i, x.key, x.method, [...x.params, pin])
        await rpc(o, i, 'header_after', 'eth_getBlockByNumber', [tag, false])
      }
    }),
  )
  closed = true
  for (const c of controllers) c.abort()
  check(now() - started <= POLICY.deadlineMs + POLICY.cleanupGraceMs, 'capture_completion')
  const receipt = seal({
    schema: 'morpho_v2_adapter_capture_v1',
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
function publicSerialization(value) {
  const text = JSON.stringify(value)
  check(!/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(text), 'artifact_url')
  return text
}
export function writeMorphoV2AdapterCapture(out, value, { statfs = statfsSync } = {}) {
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

/** Offline replay of raw calls. Adapter availability remains unknown until its deployed family is identified. */
export function replayMorphoV2AdapterMetadata(receipt, plan) {
  check(receipt && typeof receipt === 'object' && !Array.isArray(receipt), 'receipt')
  const { sha256, ...body } = receipt,
    { expectedStarts, planSha256 } = validateMorphoV2AdapterPlan(plan)
  check(
    sha(JSON.stringify(body)) === sha256 &&
      receipt.schema === 'morpho_v2_adapter_capture_v1' &&
      receipt.planSha256 === planSha256 &&
      same(receipt.plan, plan) &&
      same(receipt.policy, POLICY) &&
      same(receipt.origins, HOSTS),
    'seal_policy',
  )
  publicSerialization(receipt)
  check(
    utc(receipt.startedAt) &&
      utc(receipt.capturedAt) &&
      Date.parse(receipt.capturedAt) >= Date.parse(receipt.startedAt) &&
      Date.parse(receipt.capturedAt) - Date.parse(receipt.startedAt) <=
        POLICY.deadlineMs + POLICY.cleanupGraceMs,
    'clock',
  )
  check(
    Array.isArray(receipt.traces) &&
      receipt.physicalStarts === receipt.traces.length &&
      receipt.expectedStarts === expectedStarts &&
      receipt.physicalStarts <= expectedStarts,
    'starts',
  )
  let resultBytes = 0
  const ids = new Set(),
    start = Date.parse(receipt.startedAt),
    end = Date.parse(receipt.capturedAt)
  for (const t of receipt.traces) {
    check(
      HOSTS.includes(t.origin) &&
        Number.isInteger(t.anchor) &&
        t.anchor >= -1 &&
        t.anchor <= 2 &&
        typeof t.key === 'string' &&
        utc(t.startedAt) &&
        utc(t.completedAt),
      'trace',
    )
    const st = Date.parse(t.startedAt),
      et = Date.parse(t.completedAt)
    check(
      st >= start &&
        st < start + POLICY.deadlineMs &&
        et >= st &&
        et - st <= POLICY.rpcTimeoutMs + POLICY.cleanupGraceMs &&
        et <= end,
      'trace_clock',
    )
    check(
      t.request?.jsonrpc === '2.0' &&
        Number.isSafeInteger(t.request.id) &&
        t.request.id > 0 &&
        !ids.has(t.request.id),
      'id',
    )
    ids.add(t.request.id)
    check(
      typeof t.workSettled === 'boolean' &&
        [null, 'timeout', 'transport_unavailable'].includes(t.transport) &&
        (t.workSettled || t.transport !== null),
      'settlement',
    )
    if (t.response) {
      check(t.transport === null && t.workSettled === true, 'response_work')
      const bytes = Buffer.byteLength(JSON.stringify(t.response))
      check(bytes <= POLICY.maxResponseBytes, 'response_bytes')
      resultBytes += bytes
      if (Object.hasOwn(t.response, 'result')) publicResult(t.request.method, t.response.result)
      else
        check(Number.isInteger(t.response.error?.code) || t.response.error?.code === null, 'error')
    }
  }
  const unsettled = receipt.traces.filter((t) => t.workSettled === false)
  if (unsettled.length > 0) {
    check(receipt.captureClosedReason === 'rpc_abort_unsettled', 'unsettled_abort_reason')
    for (const stopped of unsettled) {
      // Millisecond timestamps cannot establish an earlier launch at the same time.
      // Already launched work may finish later; any start at the closure time is rejected.
      check(
        receipt.traces.every(
          (t) => t === stopped || Date.parse(t.startedAt) < Date.parse(stopped.completedAt),
        ),
        'start_after_unsettled_abort',
      )
    }
  }
  check(resultBytes <= POLICY.maxStoredResponseBytes, 'stored_bytes')
  check(
    [...ids].sort((a, b) => a - b).every((id, i) => id === i + 1),
    'ids',
  )
  const groups = HOSTS.map((host) => receipt.traces.filter((t) => t.origin === host)),
    heads = groups.map((xs) => {
      const chain = xs.find((t) => t.key === 'chain'),
        final = xs.find((t) => t.key === 'finalized')
      check(xs.filter((t) => t.anchor === -1).length <= 2, 'setup_count')
      if (chain) {
        check(
          chain.request.method === 'eth_chainId' && same(chain.request.params, []),
          'chain_request',
        )
      }
      if (final)
        check(
          final.request.method === 'eth_getBlockByNumber' &&
            same(final.request.params, ['finalized', false]),
          'final_request',
        )
      try {
        const h = header(final.response.result)
        return chain.response.result === '0x1' &&
          Date.parse(h.blockTime) <= Date.parse(final.completedAt)
          ? h
          : null
      } catch {
        return null
      }
    })
  const headAgreement =
      heads.every(Boolean) &&
      !(heads[0].blockNumber === heads[1].blockNumber && !same(heads[0], heads[1])),
    common = headAgreement
      ? heads.reduce((a, b) => (BigInt(a.blockNumber) <= BigInt(b.blockNumber) ? a : b))
      : null
  check(
    Array.isArray(receipt.sources) &&
      receipt.sources.length === 3 &&
      same(receipt.sources, [...plan.anchors.slice(0, 2).map((a) => a.source), common]),
    'sources',
  )
  for (const xs of groups) {
    let previous = null
    const events = []
    for (const t of xs) {
      if (previous)
        check(
          Date.parse(t.startedAt) - Date.parse(previous.completedAt) >= POLICY.minStartSpacingMs,
          'host_spacing',
        )
      previous = t
      if (Date.parse(t.completedAt) > Date.parse(t.startedAt))
        events.push([Date.parse(t.startedAt), 1], [Date.parse(t.completedAt), -1])
    }
    let active = 0
    for (const [, d] of events.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
      active += d
      check(active >= 0 && active <= POLICY.maxInFlightPerHost, 'concurrency')
    }
  }
  const points = receipt.sources.map((source, i) => {
    const origins = groups.map((xs, oi) => {
      const rows = xs.filter((t) => t.anchor === i),
        by = new Map(rows.map((t) => [t.key, t]))
      check(by.size === rows.length, 'duplicate_key')
      const d = derived(rows),
        specs = [...first(), ...d.more, ...cloneSpecs(rows)]
      const allowed = new Set(['header_before', 'header_after', ...specs.map((x) => x.key)])
      check(
        rows.every((t) => allowed.has(t.key)),
        'unknown_trace',
      )
      const missing = []
      for (const x of specs) {
        const t = by.get(x.key)
        if (!t) {
          missing.push(x.key)
          continue
        }
        check(
          t.request.method === x.method &&
            same(t.request.params, [
              ...x.params,
              { blockHash: source?.blockHash, requireCanonical: true },
            ]),
          'state_request',
        )
        if (!t.response?.result) missing.push(x.key)
      }
      for (const key of ['header_before', 'header_after']) {
        const t = by.get(key)
        if (!t) {
          missing.push(key)
          continue
        }
        check(
          source &&
            t.request.method === 'eth_getBlockByNumber' &&
            same(t.request.params, ['0x' + BigInt(source.blockNumber).toString(16), false]),
          'header_request',
        )
      }
      const before = by.get('header_before'),
        after = by.get('header_after')
      if (before && after)
        check(
          rows
            .filter((t) => !t.key.startsWith('header_'))
            .every(
              (t) =>
                Date.parse(t.startedAt) >= Date.parse(before.completedAt) &&
                Date.parse(t.completedAt) <= Date.parse(after.startedAt),
            ),
          'header_enclosure',
        )
      let facts = null
      try {
        check(
          headAgreement &&
            source &&
            BigInt(heads[oi].blockNumber) >= BigInt(source.blockNumber) &&
            (heads[oi].blockNumber !== source.blockNumber || same(heads[oi], source)) &&
            same(header(before.response.result), source) &&
            same(header(after.response.result), source),
          'source_proof',
        )
        const get = (key) =>
            decode(
              specs.find((x) => x.key === key),
              by.get(key)?.response?.result,
            ),
          asset = get('asset').toLowerCase(),
          shareDecimals = get('shareDecimals'),
          assetDecimals = get('assetDecimals'),
          cash = get('idleCash'),
          data = get('liquidityData')
        check(
          asset === SUBJECT.asset &&
            shareDecimals === 18 &&
            assetDecimals === 6 &&
            typeof cash === 'bigint' &&
            cash >= 0n &&
            cash <= MAX &&
            typeof data === 'string' &&
            HEX.test(data) &&
            d.adapter !== null,
          'native_identity',
        )
        const runtime = {}
        for (const key of ['vault', 'asset', ...(d.adapter !== ZERO ? ['adapter'] : [])]) {
          const t = by.get('code_' + key),
            code = t?.response?.result
          check(typeof code === 'string' && HEX.test(code) && code.length > 2, 'code')
          const implementation = cloneImplementation(code),
            impl = implementation
              ? by.get('code_' + key + '_implementation')?.response?.result
              : null
          if (implementation)
            check(typeof impl === 'string' && HEX.test(impl) && impl.length > 2, 'clone_code')
          runtime[key] = {
            runtimeCode: code,
            keccak256: keccak256(code),
            proxyInspection: implementation ? 'exact_eip1167_runtime' : 'unknown_direct_or_custom',
            implementationAddress: implementation,
            implementationCodeHash: impl ? keccak256(impl) : null,
          }
        }
        const enrolled = d.adapter === ZERO ? null : get('isAdapter')
        check(enrolled === null || typeof enrolled === 'boolean', 'enrollment')
        facts = {
          asset,
          assetDecimals,
          shareDecimals,
          idleCashRaw: String(cash),
          liquidityAdapter: d.adapter,
          liquidityData: data,
          adapterEnrolled: enrolled,
          adapterState: d.adapter === ZERO ? 'absent' : 'configured',
          runtimeIdentities: runtime,
          configuredAdapterPullableRaw: null,
          pullability: 'unknown_adapter_specific_prongs',
          sourceImplementationEquivalence: false,
        }
      } catch {
        missing.push('source_identity_or_adapter_metadata_unverified')
      }
      return { host: HOSTS[oi], facts, missingFacts: [...new Set(missing)] }
    })
    const agreed =
        origins.every((o) => o.facts !== null) && same(origins[0].facts, origins[1].facts),
      facts = agreed ? origins[0].facts : null
    return {
      source,
      status: agreed ? 'two_origin_configured_adapter_metadata' : 'unavailable',
      facts,
      origins,
      holderEntitlement: null,
      totalExitCapacity: null,
      execution: 'unassessed',
    }
  })
  return freeze({
    status: 'replayed_morpho_v2_adapter_metadata',
    knowledgeCutoff: receipt.capturedAt,
    captureReceiptSha256: receipt.sha256,
    subject: { ...SUBJECT },
    history: { points: points.slice(0, 2), elapsedSeconds: [0, 86400] },
    current: points[2],
    currentSourceAgeSeconds: common ? (end - Date.parse(common.blockTime)) / 1000 : null,
    currentSourceFresh:
      common !== null &&
      Date.parse(common.blockTime) <= end &&
      end - Date.parse(common.blockTime) <= 1800000,
    holderExecutableExit: false,
    forecastValidated: false,
    sourceImplementationEquivalence: false,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2] ?? '--check-only',
    plan = prepareMorphoV2AdapterPlan()
  check(['--check-only', '--capture', '--replay'].includes(mode), 'mode')
  if (mode === '--check-only')
    console.log(
      JSON.stringify({
        status: 'prepared_no_rpc',
        plan,
        ...validateMorphoV2AdapterPlan(plan),
        policy: POLICY,
        baseStartsNonzeroAdapter: 76,
        optionalMinimalCloneStarts: 18,
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
    const receipt = await captureMorphoV2AdapterMetadata(plan, origins)
    replayMorphoV2AdapterMetadata(receipt, plan)
    writeMorphoV2AdapterCapture(out, receipt)
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
    console.log(JSON.stringify(replayMorphoV2AdapterMetadata(receipt, plan)))
  }
}
