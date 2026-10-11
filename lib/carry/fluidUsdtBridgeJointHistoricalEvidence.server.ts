import {
  FLUID_USDT_COMPOSED_HISTORY_ORIGINAL_FILES,
  FLUID_USDT_COMPOSED_HISTORY_ANCHORS,
  createFluidUsdtComposedHistoricalContext,
  prepareFluidUsdtComposedHistoricalOriginals,
  fluidUsdtComposedHistoricalReadPlan,
  replayFluidUsdtComposedHistoricalEvidence,
} from './fluidUsdtBridgeJointComposedHistoricalEvidenceCodec'
import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { decodeFunctionResult, encodeFunctionResult } from 'viem'
import {
  configuredUsd3HypotheticalOrigins,
  createUsd3HypotheticalCaptureControl,
  parseUsd3HypotheticalJson,
} from '@/scripts/research/usd3-hypothetical-history-capture.mjs'
import {
  beginHolderNativeHistoryOriginalSeries,
  recordHolderNativeHistoryOriginalBatch,
  finishHolderNativeHistoryOriginalSeries,
  type HolderNativeHistoryOriginalRetentionStatus,
  type HolderNativeHistoryOriginalSeries,
  type HolderNativeHistoryOriginalReason,
} from './holderNativeHistoryOriginals.server'
import {
  selectedOriginalFluidUsdtBridgeNativeCapacity,
  type FluidUsdtBridgeNativeCapacityBinding,
  type FluidUsdtBridgeNativeCapacityFact,
} from './fluidUsdtBridgeNativeCapacity.server'
import {
  FLUID_USDT_QUOTE_ABI,
  FLUID_USDT_QUOTE_HOSTS,
} from './fluidUsdtBridgeNativeQuoteEvidenceCodec'
import type { FluidUsdtBridgeJointFrame } from './fluidUsdtBridgeJointLiveTimeProcess'

/** Clean unsigned inspection; private original capability is only the returned object's identity. */
export type FluidUsdtBridgeJointHistoricalEvidence = Readonly<{
  schema: 'fluid_usdt_bridge_joint_historical_evidence_v1'
  points: readonly FluidUsdtBridgeJointFrame[]
  sharesRaw: string
  requestedFinalUsdtRaw: string
  acquiredAtUtc: string
  availableAtUtc: string
  owner: null
  historicalOwnership: false
  originalAuthority: false
  authenticated: false
  executionQualified: false
  calibrated: false
  sourceImplementationEquivalence: false
  noUSDTCapacityAmountBand: true
  noLinearScaling: true
  combinedBridgeUSDTExecutionRoute: 'unassessed'
  MRaw: null
}>
export type FluidUsdtBridgeJointHistoricalEvidenceAtIssue = Readonly<{
  evidence: FluidUsdtBridgeJointHistoricalEvidence
  issuedAtUtc: string
  originalAuthority: false
  authenticated: false
  executionQualified: false
}>

const nativeNow = Date.now,
  nativeFetch = globalThis.fetch
const TTL = 1800000,
  MAX = (1n << 256n) - 1n
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')
function check(v: unknown): asserts v {
  if (!v) throw Error('fluid_usdt_native_history_unavailable')
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
function bindingAt(value: unknown, wall: number): FluidUsdtBridgeNativeCapacityBinding {
  let nodes = 0,
    bytes = 0
  const ancestors = new Set<object>()
  const copy = (v: any, depth: number): any => {
    check(++nodes <= 64 && depth <= 3)
    if (typeof v === 'string') {
      check(v.length <= 128 && (bytes += v.length * 2) <= 4096)
      return v
    }
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0))
      return v
    check(
      v &&
        typeof v === 'object' &&
        Object.getPrototypeOf(v) === Object.prototype &&
        !Object.getOwnPropertySymbols(v).length &&
        !ancestors.has(v),
    )
    ancestors.add(v)
    const out: Record<string, unknown> = {}
    for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      check(
        k.length <= 64 &&
          (bytes += k.length * 2) <= 4096 &&
          !['__proto__', 'constructor', 'prototype'].includes(k) &&
          d.enumerable &&
          Object.hasOwn(d, 'value'),
      )
      out[k] = copy(d.value, depth + 1)
    }
    ancestors.delete(v)
    return out
  }
  const b = copy(value, 0) as FluidUsdtBridgeNativeCapacityBinding
  check(Object.keys(b).sort().join(',') === 'asOfMs,owner,requestedFinalUsdtRaw,source')
  check(
    /^0x[0-9a-f]{40}$/.test(b.owner) &&
      !/^0x0{40}$/.test(b.owner) &&
      raw(b.requestedFinalUsdtRaw) &&
      BigInt(b.requestedFinalUsdtRaw) > 0n,
  )
  const s = b.source
  check(
    s && Object.keys(s).sort().join(',') === 'blockHash,blockNumber,blockTime,chainId,finalized',
  )
  check(
    s.chainId === 1 &&
      s.finalized === true &&
      Number.isSafeInteger(s.blockNumber) &&
      s.blockNumber > 0 &&
      /^0x[0-9a-f]{64}$/.test(s.blockHash) &&
      utc(s.blockTime) &&
      Date.parse(s.blockTime) % 1000 === 0,
  )
  check(
    Number.isSafeInteger(wall) &&
      Number.isSafeInteger(b.asOfMs) &&
      b.asOfMs >= 0 &&
      b.asOfMs <= wall &&
      Date.parse(s.blockTime) <= b.asOfMs &&
      wall - Date.parse(s.blockTime) <= TTL,
  )
  check(Date.now === nativeNow && globalThis.fetch === nativeFetch)
  return freeze(b)
}
function tokens(origins: readonly { url: string }[]): string[] {
  const routing = new Set(['v1', 'v2', 'v3', 'eth', 'ethereum', 'mainnet', 'rpc'])
  return [
    ...new Set(
      origins.flatMap((o) => {
        const u = new URL(o.url)
        const decode = (s: string) => {
          try {
            return decodeURIComponent(s)
          } catch {
            return s
          }
        }
        return [
          o.url,
          decode(o.url),
          ...u.pathname
            .split('/')
            .filter((s) => s && !routing.has(s.toLowerCase()))
            .flatMap((s) => [s, decode(s)]),
          ...Array.from(u.searchParams.values()).flatMap((v) => [v, decode(v)]),
        ].filter(Boolean)
      }),
    ),
  ]
}
function privateBytes(text: string, forbidden: readonly string[]): void {
  let nodes = 0
  const test = (s: string) => {
    check(!forbidden.some((t) => s.includes(t)))
    try {
      check(!forbidden.some((t) => decodeURIComponent(s).includes(t)))
    } catch (e) {
      if (e instanceof Error && e.message === 'fluid_usdt_native_history_unavailable') throw e
    }
  }
  test(text)
  let v: unknown
  try {
    v = parseUsd3HypotheticalJson(text)
  } catch {
    check(!text.includes('\\'))
    return
  }
  const visit = (x: any, depth: number): void => {
    check(++nodes <= 100000 && depth <= 24)
    if (typeof x === 'string') test(x)
    else if (x && typeof x === 'object')
      Object.entries(x).forEach(([k, y]) => {
        test(k)
        visit(y, depth + 1)
      })
  }
  visit(v, 0)
}
export const FLUID_USDT_HISTORY_SOURCE_FILES = Object.freeze([
  'lib/carry/conditionalGrossFlowHeadroom.ts',
  'lib/carry/conditionalSampledCashPathProjection.ts',
  'lib/carry/fluidBridgeUsdcJointHistoricalProcess.ts',
  'lib/carry/fluidUsdcBridgeJointNativeEvidenceCodec.ts',
  'lib/carry/fluidUsdcBridgeJointTrustedProfile.ts',
  'lib/carry/fluidUsdcBridgeNativeAbi.ts',
  'lib/carry/fluidUsdcBridgeNativeCapacity.ts',
  'lib/carry/fluidUsdtBridgeJointComposedHistoricalEvidenceCodec.ts',
  'lib/carry/fluidUsdtBridgeJointHistoricalEvidence.server.ts',
  'lib/carry/fluidUsdtBridgeNativeCapacity.server.ts',
  'lib/carry/fluidUsdtBridgeNativeQuoteEvidenceCodec.ts',
  'lib/carry/historicalCashContext.ts',
  'lib/carry/historicalCompetingFlowEstimate.ts',
  'lib/carry/historicalFlowDuration.ts',
  'lib/carry/historicalGrossFlowStress.ts',
  'lib/carry/historicalSampledCashPaths.ts',
  'lib/carry/holderNativeHistoryOriginals.server.ts',
  'lib/carry/localHistoricalSampledCashTimeline.ts',
  'scripts/lib/boundedLocalReceiptFile.mjs',
  'scripts/lib/depth-identity.mjs',
  'scripts/lib/depthCurve.mjs',
  'scripts/lib/historicalDepthQuoteStore.mjs',
  'scripts/lib/venue-reads.mjs',
  'scripts/research/carry-depth-quote-archive.mjs',
  'scripts/research/carry-depth-quote-provider-policy.json',
  'scripts/research/conditional-cash-time-holdout.mjs',
  'scripts/research/usd3-hypothetical-history-capture.mjs',
  'tools/venue-recorder.config.json',
])

// Fixed local reads never accept caller paths. Data bytes remain distinct from the dynamic native ledger.
function fileBytes(relative: string, privateArtifact: boolean): Buffer {
  check(
    typeof relative === 'string' &&
      !relative.startsWith('/') &&
      !relative.split('/').some((p) => !p || p === '.' || p === '..'),
  )
  const root = process.cwd()
  const git = lstatSync(join(root, '.git'))
  check(realpathSync(root) === root && !git.isSymbolicLink() && (git.isDirectory() || git.isFile()))
  const parts = relative.split('/')
  let path = root
  for (const part of parts) {
    path = join(path, part)
    check(!lstatSync(path).isSymbolicLink())
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd, { bigint: true })
    check(
      before.isFile() &&
        before.nlink === 1n &&
        before.size > 0n &&
        before.size <= 8n * 1024n * 1024n,
    )
    if (privateArtifact) check((before.mode & 0o777n) === 0o600n)
    const out = Buffer.alloc(Number(before.size) + 1)
    let count = 0
    while (count < out.length) {
      const n = readSync(fd, out, count, out.length - count, null)
      check(Number.isSafeInteger(n) && n >= 0)
      if (!n) break
      count += n
    }
    const after = fstatSync(fd, { bigint: true }),
      named = lstatSync(path, { bigint: true })
    check(
      named.isFile() &&
        !named.isSymbolicLink() &&
        named.nlink === 1n &&
        count === Number(before.size),
    )
    check(
      ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'].every(
        (k) => (before as any)[k] === (after as any)[k] && (after as any)[k] === (named as any)[k],
      ),
    )
    return out.subarray(0, count)
  } finally {
    closeSync(fd)
  }
}
function sourceDigest(): string {
  let total = 0
  return sha(
    JSON.stringify(
      FLUID_USDT_HISTORY_SOURCE_FILES.map((source) => {
        const bytes = fileBytes(source, false)
        check((total += bytes.length) <= 6 * 1024 * 1024)
        return { source, bytes: bytes.length, sha256: sha(bytes) }
      }),
    ),
  )
}
function oldOriginals() {
  let total = 0
  return FLUID_USDT_COMPOSED_HISTORY_ORIGINAL_FILES.map((d) => {
    const bytes = fileBytes(d.path, true)
    check(
      bytes.length === d.bytes &&
        sha(bytes) === d.fileSha256 &&
        (total += bytes.length) <= 32 * 1024 * 1024,
    )
    const rawText = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { descriptorId: d.id, rawText }
  })
}
type Context = NonNullable<ReturnType<typeof createFluidUsdtComposedHistoricalContext>>
type Spec = { key: string; request: { method: string; params: readonly unknown[] } }
type NativeBatch = {
  controlNamespace: string
  receipt: any
  requests: any[]
  settlements: any[]
  availableAtUtc: string
}
type Entry = {
  context: Context
  key: string
  wire: any
  points: readonly FluidUsdtBridgeJointFrame[]
  acquiredAtUtc: string
  availableAtUtc: string
  closure: string
  retention: HolderNativeHistoryOriginalRetentionStatus
}
const cache = new Map<string, Entry>(),
  pending = new Map<string, Promise<Entry | null>>()
const originals = new WeakMap<
  object,
  { entry: Entry; current: object; binding: FluidUsdtBridgeNativeCapacityBinding; issueMs: number }
>()
let capturing = false
let diagnostic: Readonly<{
  phase: string
  qualified: boolean
  retention?: HolderNativeHistoryOriginalRetentionStatus
}> | null = null
export function getLastFluidUsdtBridgeJointHistoricalEvidenceDiagnostic() {
  return diagnostic
}
function currentAt(
  current: unknown,
  b: FluidUsdtBridgeNativeCapacityBinding,
): FluidUsdtBridgeNativeCapacityFact {
  check(Date.now === nativeNow && globalThis.fetch === nativeFetch)
  const f = selectedOriginalFluidUsdtBridgeNativeCapacity(current, b)
  check(f && /^(?:[1-9][0-9]{0,77})$/.test(f.sharesRaw) && BigInt(f.sharesRaw) <= MAX)
  return f
}
function contextAt(f: FluidUsdtBridgeNativeCapacityFact): Context {
  const context = createFluidUsdtComposedHistoricalContext({
    sharesRaw: f.sharesRaw,
    requestedFinalUsdtRaw: f.requestedFinalUsdtRaw,
    currentSource: { ...f.source },
    profileId: f.profileId,
    runtimeCodeHashes: f.runtimeCodeHashes,
    owner: null,
    historicalOwnership: false,
  })
  check(context)
  check(
    FLUID_USDT_COMPOSED_HISTORY_ANCHORS.length === 8 &&
      FLUID_USDT_COMPOSED_HISTORY_ANCHORS.every(
        (a) =>
          BigInt(a.source.blockNumber) < BigInt(f.source.blockNumber) &&
          Date.parse(a.source.blockTime) < Date.parse(f.source.blockTime),
      ),
  )
  return context
}
function key(f: FluidUsdtBridgeNativeCapacityFact, closure: string) {
  return sha(
    JSON.stringify([
      f.sharesRaw,
      f.requestedFinalUsdtRaw,
      f.profileId,
      f.withdrawalFeeBps,
      Object.entries(f.runtimeCodeHashes).sort(([a], [b]) => a.localeCompare(b)),
      FLUID_USDT_COMPOSED_HISTORY_ANCHORS,
      FLUID_USDT_COMPOSED_HISTORY_ORIGINAL_FILES,
      closure,
    ]),
  )
}
function compatible(entry: Entry, f: FluidUsdtBridgeNativeCapacityFact, closure: string) {
  const old = entry.context.currentSource
  check(entry.closure === closure && entry.key === key(f, closure))
  check(
    BigInt(old.blockNumber) <= BigInt(f.source.blockNumber) &&
      Date.parse(old.blockTime) <= Date.parse(f.source.blockTime),
  )
  if (old.blockNumber === f.source.blockNumber) check(isDeepStrictEqual(old, f.source))
  contextAt(f) // Fresh source chronology is additional to the preserved old reference.
}
function checkedReceipt(batch: NativeBatch, observations: any[], started: number, wall: number) {
  const receipt = batch.receipt
  check(
    receipt.failure === null &&
      receipt.pendingSettlements === 0 &&
      receipt.physicalStarts === 42 &&
      receipt.ledger.length === 42 &&
      receipt.terminalCommitments.length === 42,
  )
  check(
    batch.requests.length === 42 && observations.length === 42 && batch.settlements.length === 42,
  )
  check(
    new Set(receipt.ledger.map((r: any) => r.physicalId)).size === 42 &&
      new Set(observations.map((o) => o.physicalId)).size === 42 &&
      new Set(batch.settlements.map((s: any) => s.physicalId)).size === 42,
  )
  for (const o of observations) {
    const row = receipt.ledger.find((r: any) => r.physicalId === o.physicalId),
      commit = receipt.terminalCommitments.find((r: any) => r.physicalId === o.physicalId),
      settled = batch.settlements.find((s: any) => s.physicalId === o.physicalId)
    check(
      row &&
        row.accepted === true &&
        row.status === 'success' &&
        row.httpStatus === 200 &&
        row.host === o.host &&
        isDeepStrictEqual(row.request, o.request) &&
        commit?.rowSha256 === sha(JSON.stringify(row)),
    )
    const req = Buffer.from(o.requestBodyBase64, 'base64')
    check(
      req.length <= 2048 &&
        req.toString('base64') === o.requestBodyBase64 &&
        sha(req) === o.requestBodySha256 &&
        isDeepStrictEqual(parseUsd3HypotheticalJson(req.toString('utf8')), row.request),
    )
    check(settled)
    const { sha256, ...body } = settled
    check(
      sha256 === sha(JSON.stringify(body)) &&
        settled.captureAcceptance === false &&
        isDeepStrictEqual(settled.observation, row),
    )
    const res = Buffer.from(row.rawBodyBase64, 'base64')
    check(
      res.length <= 65536 &&
        res.toString('base64') === row.rawBodyBase64 &&
        res.length === row.bodyBytes &&
        sha(res) === row.bodySha256,
    )
    const envelope = parseUsd3HypotheticalJson(
      new TextDecoder('utf-8', { fatal: true }).decode(res),
    )
    check(
      Object.keys(envelope).sort().join(',') === 'id,jsonrpc,result' &&
        envelope.jsonrpc === '2.0' &&
        envelope.id === o.request.id &&
        isDeepStrictEqual(envelope.result, o.result),
    )
    check(
      utc(row.startedAtUtc) &&
        utc(row.completedAtUtc) &&
        Date.parse(row.startedAtUtc) >= started &&
        Date.parse(row.completedAtUtc) >= Date.parse(row.startedAtUtc) &&
        Date.parse(row.completedAtUtc) <= wall,
    )
  }
}
function privacy(batch: NativeBatch, forbidden: readonly string[]) {
  for (const row of [
    ...batch.receipt.ledger,
    ...batch.settlements.map((s: any) => s.observation),
  ]) {
    if (row.rawBodyBase64 !== null) {
      check(typeof row.rawBodyBase64 === 'string')
      const raw = Buffer.from(row.rawBodyBase64, 'base64')
      check(
        raw.length <= 65536 &&
          raw.toString('base64') === row.rawBodyBase64 &&
          sha(raw) === row.bodySha256 &&
          raw.length === row.bodyBytes,
      )
      privateBytes(new TextDecoder('utf-8', { fatal: true }).decode(raw), forbidden)
    }
  }
  batch.requests.forEach((r) =>
    privateBytes(Buffer.from(r.requestBodyBase64, 'base64').toString('utf8'), forbidden),
  )
  privateBytes(JSON.stringify(batch), forbidden)
}
async function acquire(
  current: unknown,
  b: FluidUsdtBridgeNativeCapacityBinding,
  closure: string,
): Promise<Entry | null> {
  if (capturing) return null
  capturing = true
  const cohortStarted = nativeNow()
  const cohortTimer = setTimeout(() => controller?.stop('global_deadline'), 120000)
  const within = () => check(nativeNow() >= cohortStarted && nativeNow() - cohortStarted <= 120000)
  let series: HolderNativeHistoryOriginalSeries | undefined,
    controller: ReturnType<typeof createUsd3HypotheticalCaptureControl> | undefined
  let finished = false,
    recorded = 0,
    activeRetained = false,
    unsafe = false,
    phase = 'begin'
  let finalRetention: HolderNativeHistoryOriginalRetentionStatus | undefined
  let reason: HolderNativeHistoryOriginalReason = 'provider_unavailable'
  let forbidden: string[] = []
  let context!: Context
  let active: NativeBatch | undefined
  const batches: NativeBatch[] = [],
    qualifications: boolean[] = []
  const retain = (accepted: boolean) => {
    check(series && active && !activeRetained)
    try {
      privacy(active, forbidden)
    } catch {
      unsafe = true
      reason = 'invalid_input'
      throw Error('fluid_usdt_native_history_unavailable')
    }
    activeRetained = true
    recorded++
    recordHolderNativeHistoryOriginalBatch(series, {
      batchIndex: recorded - 1,
      plan: {
        schema: 'fluid_usdt_bridge_dynamic_history_read_plan_v1',
        context,
        anchors: FLUID_USDT_COMPOSED_HISTORY_ANCHORS.slice((recorded - 1) * 4, recorded * 4),
        oldOriginalFiles: FLUID_USDT_COMPOSED_HISTORY_ORIGINAL_FILES,
        sourceClosureSha256: closure,
        maxPhysicalStarts: 42,
        requests: active.requests,
      },
      receipt: {
        schema: 'fluid_usdt_dynamic_originals_v1',
        controlNamespace: active.controlNamespace,
        receipt: active.receipt,
        requests: active.requests,
        settlements: active.settlements,
        postRetentionAvailableAtUtc: null,
        availabilityBoundary: 'series_retention_pending',
      },
      capturedAccepted: accepted,
    })
  }
  try {
    const fact = currentAt(current, b)
    context = contextAt(fact)
    series = beginHolderNativeHistoryOriginalSeries({
      kind: 'fluid_usdt_bridge_history',
      sharesRaw: fact.sharesRaw,
    })
    within()
    phase = 'fixed_originals'
    reason = 'plan_rejected'
    const old = oldOriginals()
    reason = 'codec_rejected'
    const preparedOriginals = prepareFluidUsdtComposedHistoricalOriginals(old, context)
    check(preparedOriginals && sourceDigest() === closure)
    const origins = await configuredUsd3HypotheticalOrigins()
    within()
    currentAt(current, { ...b, asOfMs: nativeNow() })
    check(
      origins.length === 2 &&
        origins.every((o: { host: string }, i: number) => o.host === FLUID_USDT_QUOTE_HOSTS[i]),
    )
    forbidden = tokens(origins)
    for (let batchIndex = 0; batchIndex < 2; batchIndex++) {
      phase = 'capture'
      reason = 'provider_unavailable'
      currentAt(current, { ...b, asOfMs: nativeNow() })
      check(sourceDigest() === closure)
      controller = createUsd3HypotheticalCaptureControl(origins)
      const control = controller,
        started = nativeNow(),
        observations: any[] = []
      active = {
        controlNamespace: 'fluid_usdt_hist_' + randomUUID(),
        receipt: null,
        requests: [],
        settlements: [],
        availableAtUtc: '',
      }
      activeRetained = false
      unsafe = false
      let rpcId = 0,
        starts = 0
      const request = async (
        origin: { host: string; url: string },
        cashIndex: number | null,
        spec: Spec,
      ) => {
        currentAt(current, { ...b, asOfMs: nativeNow() })
        within()
        check(++starts <= 42 && nativeNow() - started <= 120000 && sourceDigest() === closure)
        const body = { jsonrpc: '2.0', id: ++rpcId, ...spec.request },
          bytes = Buffer.from(JSON.stringify(body))
        check(bytes.length <= 2048)
        const original = {
          host: origin.host,
          cashIndex,
          key: spec.key,
          rpcId: body.id,
          requestBodyBase64: bytes.toString('base64'),
          requestBodySha256: sha(bytes),
        }
        active!.requests.push(original)
        within()
        currentAt(current, { ...b, asOfMs: nativeNow() })
        const response = await control.fetcher(origin.url, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body: bytes.toString('utf8'),
        })
        within()
        currentAt(current, { ...b, asOfMs: nativeNow() })
        const text = await response.text()
        within()
        currentAt(current, { ...b, asOfMs: nativeNow() })
        check(Buffer.byteLength(text) <= 65536)
        const envelope = parseUsd3HypotheticalJson(text)
        check(
          Object.keys(envelope).sort().join(',') === 'id,jsonrpc,result' &&
            envelope.jsonrpc === '2.0' &&
            envelope.id === body.id,
        )
        const physicalId = Number(response.headers.get('x-usd3-physical-id'))
        check(Number.isSafeInteger(physicalId) && physicalId > 0)
        observations.push({ ...original, physicalId, request: body, result: envelope.result })
        return envelope.result
      }
      control.beginStage('usdt_history_chain')
      await Promise.all(
        origins.map((o: any) =>
          request(o, null, { key: 'chain', request: { method: 'eth_chainId', params: [] } }),
        ),
      )
      for (const anchor of FLUID_USDT_COMPOSED_HISTORY_ANCHORS.slice(
        batchIndex * 4,
        batchIndex * 4 + 4,
      )) {
        control.beginStage('usdt_history_' + anchor.cashIndex)
        await Promise.all(
          origins.map(async (o: any) => {
            const initial = fluidUsdtComposedHistoricalReadPlan(context, anchor.cashIndex)
            check(initial && initial.length === 3)
            for (const spec of initial.slice(0, 2)) await request(o, anchor.cashIndex, spec)
            const result = await request(o, anchor.cashIndex, initial[2])
            check(typeof result === 'string')
            const decoded = decodeFunctionResult({
              abi: FLUID_USDT_QUOTE_ABI,
              functionName: 'quoteExactOutputSingle',
              data: result as `0x${string}`,
            })
            check(
              encodeFunctionResult({
                abi: FLUID_USDT_QUOTE_ABI,
                functionName: 'quoteExactOutputSingle',
                result: decoded,
              }) === result,
            )
            const R = String((decoded as any)[0])
            check(/^[1-9][0-9]{0,77}$/.test(R) && BigInt(R) <= MAX)
            const complete = fluidUsdtComposedHistoricalReadPlan(context, anchor.cashIndex, R)
            check(complete && complete.length === 5)
            for (const spec of complete.slice(3)) await request(o, anchor.cashIndex, spec)
          }),
        )
      }
      phase = 'raw_retention'
      active.receipt = await control.finish()
      within()
      currentAt(current, { ...b, asOfMs: nativeNow() })
      active.settlements = structuredClone(control.settlementReceipts) // Exactly one captured late-settlement snapshot.
      retain(
        active.receipt.failure === null &&
          active.receipt.physicalStarts === 42 &&
          active.receipt.pendingSettlements === 0,
      )
      active.availableAtUtc = new Date(nativeNow()).toISOString() // Actual batch write completed; the separate series barrier never retimes this clock.
      reason = 'replay_rejected'
      checkedReceipt(active, observations, started, nativeNow())
      check(starts === 42 && nativeNow() - started <= 120000)
      currentAt(current, { ...b, asOfMs: nativeNow() })
      check(sourceDigest() === closure)
      batches.push(active)
      qualifications.push(true)
      controller = undefined
      active = undefined
    }
    const wire = {
      schema: 'fluid_usdt_composed_history_raw_v1' as const,
      preparedOriginals,
      batches,
      seriesAvailableAtUtc: batches[batches.length - 1].availableAtUtc,
    }
    phase = 'composition'
    reason = 'codec_rejected'
    check(replayFluidUsdtComposedHistoricalEvidence(wire, context))
    oldOriginals()
    check(sourceDigest() === closure)
    currentAt(current, { ...b, asOfMs: nativeNow() })
    phase = 'retention'
    const retention = (finalRetention = finishHolderNativeHistoryOriginalSeries(series, {
      qualification: true,
      reason: 'qualified',
      batchQualifications: qualifications,
    }))
    finished = true
    check(
      retention.status === 'retained' &&
        retention.reason === 'qualified' &&
        retention.producerReplayQualification === true &&
        retention.recordedBatches === 2 &&
        retention.sourceClosureSha256 === closure,
    )
    const availableAtUtc = new Date(nativeNow()).toISOString()
    wire.seriesAvailableAtUtc = availableAtUtc // Only the series fsync barrier advances; batch and native acquisition clocks stay unchanged.
    within()
    const decoded = replayFluidUsdtComposedHistoricalEvidence(wire, context)
    check(decoded && Date.parse(decoded.availableAtUtc) <= Date.parse(availableAtUtc))
    oldOriginals()
    check(sourceDigest() === closure)
    within()
    currentAt(current, { ...b, asOfMs: nativeNow() })
    const entry = freeze({
      context,
      key: key(fact, closure),
      wire,
      points: decoded.points,
      acquiredAtUtc: decoded.acquiredAtUtc,
      availableAtUtc: decoded.availableAtUtc,
      closure,
      retention,
    })
    diagnostic = freeze({ phase: 'complete', qualified: true, retention })
    return entry
  } catch {
    diagnostic = freeze({
      phase,
      qualified: false,
      ...(finalRetention ? { retention: finalRetention } : {}),
    })
    return null
  } finally {
    if (controller) {
      try {
        const receipt = await controller.finish()
        if (!active)
          active = {
            controlNamespace: 'fluid_usdt_hist_' + randomUUID(),
            receipt,
            requests: [],
            settlements: [],
            availableAtUtc: new Date(nativeNow()).toISOString(),
          }
        if (!active.receipt) active.receipt = receipt
        if (!activeRetained) {
          active.settlements = structuredClone(controller.settlementReceipts)
          if (!unsafe) retain(false)
        }
      } catch {
        /* Unsafe bytes never enter raw originals or logs. */
      }
    }
    if (series && !finished) {
      try {
        while (qualifications.length < recorded) qualifications.push(false)
        const retention = finishHolderNativeHistoryOriginalSeries(series, {
          qualification: false,
          reason,
          batchQualifications: qualifications,
        })
        diagnostic = freeze({ phase, qualified: false, retention })
      } catch {
        /* Fixed bounded diagnostic cannot confer authority. */
      }
    }
    clearTimeout(cohortTimer)
    capturing = false
  }
}
/** No transport/provider/profile/clock hooks; only an existing original current capability can acquire. */
export async function readFluidUsdtBridgeJointHistoricalEvidenceAtIssue(
  current: unknown,
  binding: FluidUsdtBridgeNativeCapacityBinding,
): Promise<FluidUsdtBridgeJointHistoricalEvidenceAtIssue | null> {
  try {
    const b = bindingAt(binding, nativeNow()),
      fact = currentAt(current, b),
      closure = sourceDigest(),
      k = key(fact, closure)
    contextAt(fact)
    let entry = cache.get(k)
    if (!entry) {
      let work = pending.get(k)
      if (!work) {
        work = acquire(current, b, closure)
        pending.set(k, work)
      }
      try {
        entry = (await work) ?? undefined
      } finally {
        if (pending.get(k) === work) pending.delete(k)
      }
      if (!entry) return null
      cache.set(k, entry)
      while (cache.size > 2) cache.delete(cache.keys().next().value!)
    }
    const issuedAt = nativeNow(),
      fresh = { ...b, asOfMs: issuedAt }
    const live = currentAt(current, fresh)
    compatible(entry, live, sourceDigest())
    oldOriginals()
    check(
      Date.parse(entry.acquiredAtUtc) <= issuedAt && Date.parse(entry.availableAtUtc) <= issuedAt,
    )
    const evidence = freeze({
      schema: 'fluid_usdt_bridge_joint_historical_evidence_v1' as const,
      points: entry.points,
      sharesRaw: entry.context.sharesRaw,
      requestedFinalUsdtRaw: entry.context.requestedFinalUsdtRaw,
      acquiredAtUtc: entry.acquiredAtUtc,
      availableAtUtc: entry.availableAtUtc,
      owner: null,
      historicalOwnership: false as const,
      originalAuthority: false as const,
      authenticated: false as const,
      executionQualified: false as const,
      calibrated: false as const,
      sourceImplementationEquivalence: false as const,
      noUSDTCapacityAmountBand: true as const,
      noLinearScaling: true as const,
      combinedBridgeUSDTExecutionRoute: 'unassessed' as const,
      MRaw: null,
    })
    // Real issue is sampled after fixed-file and source rechecks; no cache-clock refresh.
    check(sourceDigest() === closure)
    const finalIssue = nativeNow()
    currentAt(current, { ...b, asOfMs: finalIssue })
    const value = freeze({
      evidence,
      issuedAtUtc: new Date(finalIssue).toISOString(),
      originalAuthority: false as const,
      authenticated: false as const,
      executionQualified: false as const,
    })
    originals.set(value, { entry, current: current as object, binding: b, issueMs: finalIssue })
    return value
  } catch {
    return null
  }
}
/** Exact object identity and original current pointer; JSON/clone inputs never register originals. */
export function selectedOriginalFluidUsdtBridgeJointHistoricalEvidence(
  value: unknown,
  current: unknown,
  binding: FluidUsdtBridgeNativeCapacityBinding,
): readonly FluidUsdtBridgeJointFrame[] | null {
  try {
    check(value && typeof value === 'object')
    const original = originals.get(value as object)
    check(original && current === original.current)
    const b = bindingAt(binding, nativeNow())
    check(
      isDeepStrictEqual({ ...b, asOfMs: null }, { ...original.binding, asOfMs: null }) &&
        b.asOfMs >= original.issueMs,
    )
    compatible(original.entry, currentAt(current, b), sourceDigest())
    oldOriginals()
    check(b.asOfMs >= Date.parse(original.entry.availableAtUtc))
    currentAt(current, { ...b, asOfMs: nativeNow() })
    return original.entry.points
  } catch {
    return null
  }
}
