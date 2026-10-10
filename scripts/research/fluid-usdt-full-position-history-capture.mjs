// Manual historical full-position reads. No withdrawal, conversion or payment is executed.
import { createHash } from 'node:crypto'
import { openSync, closeSync, writeFileSync, statfsSync, constants } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readBoundedReceiptFile } from '../lib/boundedLocalReceiptFile.mjs'

const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
const check = (ok, code) => {
  if (!ok) throw Error('fluid_full_position_' + code)
}
const sha = (text) => createHash('sha256').update(text).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const bytes = (value) => Buffer.byteLength(JSON.stringify(value))
const utc = (value) =>
  typeof value === 'string' &&
  Number.isSafeInteger(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value
const word = (value) => {
  check(typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value), 'canonical_abi_word')
  return BigInt(value)
}
const uintWord = (value) => value.toString(16).padStart(64, '0')
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value, expected) =>
  record(value) &&
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key))

export const FLUID_FULL_POSITION_POLICY = freeze({
  maxRequests: 24,
  maxInFlightPerHost: 1,
  rpcTimeoutMs: 8000,
  retries: 0,
  maxResponseBytes: 65536,
  maxArtifactBytes: 65536,
  reserveBytes: 128 * 1024 * 1024,
})
const HOSTS = freeze(['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'])
const SUBJECT = freeze({
  routeKey: 'USDT → FluidBridgeAggregatorProxy [USDC]',
  destination: '0x273da948aca9261043fbdb2a857bc255ecc29012',
  owner: '0x3f825bb69af74a4921dd051c80fe8bf8fb7d3a2e',
  asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  assetDecimals: 6,
  shareDecimalsFromOriginalIssues: 18,
})
const ANCHORS = freeze([
  {
    issueFile: '00000001.json',
    fileSha256: 'ed9879f7bd271fac0b39fc140bf87839dc04995374ea97e034f022952fa71356',
    bodySha256: '388c7a3c3ea53d4c343249bc813ae659053f895afdf9738f3e1c29f7c002ad14',
    issuedAtUtc: '2026-10-02T03:32:46.286Z',
    source: {
      chainId: 1,
      blockNumber: '26101887',
      blockHash: '0x1d7a6a3917c16cb645cf68633ddb2e692aa76150d3748c6b8ecc2924a3c85e82',
      blockTime: '2026-10-02T03:15:35.000Z',
    },
    originalHolderSharesRaw: '967573479322309282',
  },
  {
    issueFile: '00000002.json',
    fileSha256: 'e7cb0e58d3849202387856279b774e5026349e5f46f8fecbffe55bdbbeb64dbc',
    bodySha256: 'db3db5ff1af80bb1d29bb122e75dab810e134e76e07855cd31a48687c8304e16',
    issuedAtUtc: '2026-10-02T04:22:39.299Z',
    source: {
      chainId: 1,
      blockNumber: '26102143',
      blockHash: '0xd7790f6f48376e330501f1fd5389cb447b0efd04a58331267a88509110eb9306',
      blockTime: '2026-10-02T04:06:47.000Z',
    },
    originalHolderSharesRaw: '967573479322309282',
  },
])
const fixedPlan = () => ({
  schema: 'fluid_usdt_full_position_history_plan_v1',
  subject: structuredClone(SUBJECT),
  anchors: structuredClone(ANCHORS),
  originHosts: [...HOSTS],
  policy: structuredClone(FLUID_FULL_POSITION_POLICY),
  historicalOnly: true,
  headerRetention: 'native_number_hash_timestamp_only',
  newlyObservedFinalizedHead: false,
  sourceImplementationEquivalence: false,
})

/** File/body hashes and old issue identities are external fixed anchors, not candidate seals. */
export function prepareFluidFullPositionHistoryPlan({ root = process.cwd() } = {}) {
  const budget = { maxFileBytes: 16384, maxTotalBytes: 32768, totalBytes: 0 }
  let previous = null
  for (const anchor of ANCHORS) {
    const text = readBoundedReceiptFile(
      resolve(
        root,
        'data/research/venue-signals/carry-fluid-bridge-usdt-holder-v1/issues',
        anchor.issueFile,
      ),
      budget,
    )
    const issue = JSON.parse(text)
    const { sha256, ...body } = issue
    const position = issue.baseline?.cases?.find((row) => row.qRaw === '10145')?.measurement
    check(
      sha(text) === anchor.fileSha256 &&
        sha(JSON.stringify(body)) === anchor.bodySha256 &&
        sha256 === anchor.bodySha256 &&
        issue.previousSha256 === previous,
      'original_issue_hashes',
    )
    check(
      issue.issuedAtUtc === anchor.issuedAtUtc &&
        issue.routeKey === SUBJECT.routeKey &&
        issue.destination === SUBJECT.destination &&
        issue.holder === SUBJECT.owner &&
        issue.asset === SUBJECT.asset &&
        String(issue.baseline.blockNumber) === anchor.source.blockNumber &&
        issue.baseline.blockHash === anchor.source.blockHash &&
        new Date(issue.baseline.blockTimestamp * 1000).toISOString() === anchor.source.blockTime &&
        position?.vault?.assetDecimals === 6 &&
        position.vault.shareDecimals === SUBJECT.shareDecimalsFromOriginalIssues &&
        position.position?.holderSharesRaw === anchor.originalHolderSharesRaw,
      'original_issue_identity',
    )
    previous = sha256
  }
  return freeze(fixedPlan())
}

function header(result, source) {
  check(record(result), 'header')
  const normalized = { number: result.number, hash: result.hash, timestamp: result.timestamp }
  check(
    /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(normalized.number) &&
      /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(normalized.timestamp) &&
      BigInt(normalized.number).toString() === source.blockNumber &&
      normalized.hash === source.blockHash &&
      new Date(Number(BigInt(normalized.timestamp)) * 1000).toISOString() === source.blockTime,
    'canonical_header',
  )
  return normalized
}
function readPlan(source, shares) {
  const pin = { blockHash: source.blockHash, requireCanonical: true }
  const call = (key, to, data) => ({ key, method: 'eth_call', params: [{ to, data }, pin] })
  const tag = '0x' + BigInt(source.blockNumber).toString(16)
  return [
    { key: 'header_before', method: 'eth_getBlockByNumber', params: [tag, false] },
    call('asset', SUBJECT.destination, '0x38d52e0f'),
    call('asset_decimals', SUBJECT.asset, '0x313ce567'),
    call(
      'full_holder_balance',
      SUBJECT.destination,
      '0x70a08231' + SUBJECT.owner.slice(2).padStart(64, '0'),
    ),
    ...(shares === undefined
      ? []
      : [
          call(
            'preview_redeem_full_position',
            SUBJECT.destination,
            '0x4cdad506' + uintWord(shares),
          ),
        ]),
    { key: 'header_after', method: 'eth_getBlockByNumber', params: [tag, false] },
  ]
}

/** Decoding a capture is historical measurement only; its checksum is not approval. */
export function replayFluidFullPositionHistory(value, expectedPlan) {
  const v = structuredClone(value)
  const plan = structuredClone(expectedPlan)
  check(same(plan, fixedPlan()) && same(v.plan, plan), 'fixed_plan')
  const { sha256, ...body } = v
  check(
    sha(JSON.stringify(body)) === sha256 && v.planSha256 === sha(JSON.stringify(plan)),
    'integrity',
  )
  check(
    keys(v, [
      'schema',
      'plan',
      'planSha256',
      'startedAtUtc',
      'availableAtUtc',
      'physicalStarts',
      'origins',
      'historicalOnly',
      'execution',
      'minedPayout',
      'sourceImplementationEquivalence',
      'sha256',
    ]) &&
      v.schema === 'fluid_usdt_full_position_history_capture_v1' &&
      v.historicalOnly === true &&
      v.execution === 'unassessed' &&
      v.minedPayout === false &&
      v.sourceImplementationEquivalence === false &&
      v.physicalStarts === 24 &&
      bytes(v) + 1 <= FLUID_FULL_POSITION_POLICY.maxArtifactBytes &&
      utc(v.startedAtUtc) &&
      utc(v.availableAtUtc) &&
      Date.parse(v.availableAtUtc) >= Date.parse(v.startedAtUtc) &&
      ANCHORS.every((anchor) => Date.parse(v.startedAtUtc) > Date.parse(anchor.issuedAtUtc)) &&
      Array.isArray(v.origins) &&
      v.origins.length === 2 &&
      same(v.origins.map((origin) => origin.host).sort(), [...HOSTS].sort()),
    'capture_shape',
  )
  const ids = new Set()
  const points = v.origins.map((origin) => {
    check(
      keys(origin, ['host', 'observations']) &&
        Array.isArray(origin.observations) &&
        origin.observations.length === 2,
      'anchors',
    )
    let priorCompletion = Date.parse(v.startedAtUtc)
    return origin.observations.map((observation, index) => {
      const anchor = ANCHORS[index]
      check(
        keys(observation, ['source', 'traces']) &&
          same(observation.source, anchor.source) &&
          observation.traces.length === 6,
        'source',
      )
      const sharesTrace = observation.traces[3]
      const shares = word(sharesTrace.response.result)
      check(shares.toString() === anchor.originalHolderSharesRaw, 'independent_full_balance')
      const specs = readPlan(anchor.source, shares)
      observation.traces.forEach((trace, i) => {
        const spec = specs[i]
        check(
          keys(trace, ['key', 'request', 'response', 'startedAtUtc', 'completedAtUtc']) &&
            keys(trace.request, ['jsonrpc', 'id', 'method', 'params']) &&
            trace.key === spec.key &&
            trace.request.jsonrpc === '2.0' &&
            Number.isSafeInteger(trace.request.id) &&
            trace.request.id >= 1 &&
            trace.request.id <= 24 &&
            !ids.has(trace.request.id) &&
            trace.request.method === spec.method &&
            same(trace.request.params, spec.params) &&
            trace.response.jsonrpc === '2.0' &&
            trace.response.id === trace.request.id &&
            Object.keys(trace.response).sort().join(',') === 'id,jsonrpc,result' &&
            utc(trace.startedAtUtc) &&
            utc(trace.completedAtUtc) &&
            Date.parse(trace.startedAtUtc) >= priorCompletion &&
            Date.parse(trace.completedAtUtc) >= Date.parse(trace.startedAtUtc) &&
            Date.parse(trace.completedAtUtc) - Date.parse(trace.startedAtUtc) <= 8000 &&
            Date.parse(trace.completedAtUtc) <= Date.parse(v.availableAtUtc),
          'native_trace',
        )
        ids.add(trace.request.id)
        priorCompletion = Date.parse(trace.completedAtUtc)
        if (spec.key.startsWith('header_')) {
          check(
            same(trace.response.result, header(trace.response.result, anchor.source)),
            'header_fields',
          )
        } else word(trace.response.result)
      })
      check(
        observation.traces[1].response.result === '0x' + SUBJECT.asset.slice(2).padStart(64, '0') &&
          word(observation.traces[2].response.result) === 6n,
        'native_asset_units',
      )
      return {
        source: structuredClone(anchor.source),
        owner: SUBJECT.owner,
        holderSharesRaw: shares.toString(),
        fullPositionEntitlementRaw: word(observation.traces[4].response.result).toString(),
        asset: SUBJECT.asset,
        assetDecimals: 6,
        availableAtUtc: v.availableAtUtc,
      }
    })
  })
  check(same(points[0], points[1]), 'two_origin_native_agreement')
  return freeze({
    historicalOnly: true,
    points: points[0],
    availableAtUtc: v.availableAtUtc,
    execution: 'unassessed',
    minedPayout: false,
    sourceImplementationEquivalence: false,
  })
}

function safeOrigins(values) {
  check(Array.isArray(values) && values.length === 2, 'configured_origins')
  const origins = values.map((value) => {
    const url = new URL(value.url)
    check(
      url.protocol === 'https:' && !url.username && !url.password && HOSTS.includes(url.hostname),
      'configured_origin',
    )
    return { host: url.hostname, url: url.href }
  })
  check(new Set(origins.map((origin) => origin.host)).size === 2, 'distinct_origins')
  return freeze(origins)
}
async function boundedRpc(url, request, fetchImpl) {
  const controller = new AbortController()
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(Error('fluid_full_position_rpc_timeout'))
    }, 8000)
  })
  try {
    return await Promise.race([
      timeout,
      (async () => {
        const response = await fetchImpl(url, {
          method: 'POST',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          signal: controller.signal,
        })
        check(response.ok && response.body, 'rpc_http')
        const reader = response.body.getReader()
        let size = 0
        const chunks = []
        try {
          for (;;) {
            const next = await reader.read()
            if (next.done) break
            size += next.value.byteLength
            check(size <= FLUID_FULL_POSITION_POLICY.maxResponseBytes, 'rpc_response_bound')
            chunks.push(Buffer.from(next.value))
          }
        } finally {
          await reader.cancel().catch(() => {})
        }
        const text = Buffer.concat(chunks).toString('utf8')
        const parsed = JSON.parse(text)
        check(
          parsed.jsonrpc === '2.0' &&
            parsed.id === request.id &&
            Object.hasOwn(parsed, 'result') &&
            !Object.hasOwn(parsed, 'error'),
          'rpc_response',
        )
        return parsed.result
      })(),
    ])
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/** Finite manual capture; each approved host has one request in flight and no retries. */
export async function captureFluidFullPositionHistory(
  plan,
  providers,
  { fetchImpl = fetch, now = () => Date.now() } = {},
) {
  const privatePlan = freeze(structuredClone(plan))
  check(same(privatePlan, fixedPlan()), 'fixed_plan')
  const origins = safeOrigins(structuredClone(providers))
  const startedAtUtc = new Date(now()).toISOString()
  let physicalStarts = 0
  let closed = false
  const acquired = await Promise.all(
    origins.map(async (origin) => {
      const observations = []
      for (const anchor of privatePlan.anchors) {
        const traces = []
        const launch = async (spec) => {
          check(!closed && physicalStarts < 24, 'physical_start_bound')
          const request = freeze({
            jsonrpc: '2.0',
            id: ++physicalStarts,
            method: spec.method,
            params: structuredClone(spec.params),
          })
          const started = now()
          const raw = await boundedRpc(origin.url, request, fetchImpl)
          const completed = now()
          check(completed >= started && completed - started <= 8000, 'read_clock')
          const result = spec.key.startsWith('header_') ? header(raw, anchor.source) : raw
          if (!spec.key.startsWith('header_')) word(result)
          traces.push({
            key: spec.key,
            request: structuredClone(request),
            response: { jsonrpc: '2.0', id: request.id, result: structuredClone(result) },
            startedAtUtc: new Date(started).toISOString(),
            completedAtUtc: new Date(completed).toISOString(),
          })
          check(
            bytes({ observations, traces }) < FLUID_FULL_POSITION_POLICY.maxArtifactBytes / 2,
            'retained_origin_bound',
          )
          return result
        }
        try {
          const initial = readPlan(anchor.source)
          for (const spec of initial.slice(0, 4)) await launch(spec)
          check(
            traces[1].response.result === '0x' + SUBJECT.asset.slice(2).padStart(64, '0') &&
              word(traces[2].response.result) === 6n,
            'native_asset_units',
          )
          const shares = word(traces[3].response.result)
          check(shares.toString() === anchor.originalHolderSharesRaw, 'independent_full_balance')
          const complete = readPlan(anchor.source, shares)
          await launch(complete[4])
          await launch(complete[5])
          observations.push({ source: structuredClone(anchor.source), traces })
        } catch (error) {
          closed = true
          throw error
        }
      }
      return { host: origin.host, observations }
    }),
  )
  closed = true
  const body = {
    schema: 'fluid_usdt_full_position_history_capture_v1',
    plan: structuredClone(privatePlan),
    planSha256: sha(JSON.stringify(privatePlan)),
    startedAtUtc,
    availableAtUtc: new Date(now()).toISOString(),
    physicalStarts,
    origins: acquired,
    historicalOnly: true,
    execution: 'unassessed',
    minedPayout: false,
    sourceImplementationEquivalence: false,
  }
  const value = { ...body, sha256: sha(JSON.stringify(body)) }
  replayFluidFullPositionHistory(value, privatePlan)
  return freeze(value)
}

export function writeFluidFullPositionHistory(path, value) {
  replayFluidFullPositionHistory(value, fixedPlan())
  const text = JSON.stringify(value) + '\n'
  check(Buffer.byteLength(text) <= FLUID_FULL_POSITION_POLICY.maxArtifactBytes, 'artifact_bound')
  const disk = statfsSync(dirname(resolve(path)), { bigint: true })
  check(
    disk.bavail * disk.bsize - BigInt(Buffer.byteLength(text)) >=
      BigInt(FLUID_FULL_POSITION_POLICY.reserveBytes),
    'post_output_reserve',
  )
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    writeFileSync(fd, text)
  } finally {
    closeSync(fd)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2] ?? '--plan'
    const plan = prepareFluidFullPositionHistoryPlan()
    if (mode === '--plan')
      console.log(
        JSON.stringify({
          status: 'prepared_no_rpc',
          plan,
          planSha256: sha(JSON.stringify(plan)),
          maximumPhysicalStarts: 24,
        }),
      )
    else if (mode === '--replay') {
      const file = process.argv.find((arg) => arg.startsWith('--file='))?.slice(7)
      check(typeof file === 'string' && file.length > 0, 'input_file')
      const raw = readBoundedReceiptFile(file, {
        maxFileBytes: 65536,
        maxTotalBytes: 65536,
        totalBytes: 0,
      })
      console.log(JSON.stringify(replayFluidFullPositionHistory(JSON.parse(raw), plan)))
    } else if (mode === '--capture') {
      const out = process.argv.find((arg) => arg.startsWith('--out='))?.slice(6)
      check(typeof out === 'string' && out.length > 0, 'output_file')
      const disk = statfsSync(dirname(resolve(out)), { bigint: true })
      check(
        disk.bavail * disk.bsize - 65536n >= BigInt(FLUID_FULL_POSITION_POLICY.reserveBytes),
        'preflight_reserve',
      )
      const { readProviderPolicy, configuredProviders } =
        await import('./carry-depth-quote-archive.mjs')
      const policy = readProviderPolicy()
      check(
        policy.status === 'active' && policy.policyId === 'configured-c1-c3-v1',
        'provider_policy',
      )
      const value = await captureFluidFullPositionHistory(plan, configuredProviders(null, policy))
      writeFluidFullPositionHistory(out, value)
      console.log(
        JSON.stringify({
          sha256: value.sha256,
          physicalStarts: value.physicalStarts,
          availableAtUtc: value.availableAtUtc,
          artifactBytes: bytes(value) + 1,
        }),
      )
    } else check(false, 'mode')
  } catch {
    console.error('fluid_full_position_capture_failed')
    process.exitCode = 1
  }
}
