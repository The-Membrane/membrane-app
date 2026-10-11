import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { decodeFunctionResult, encodeFunctionResult } from 'viem'
import {
  configuredUsd3HypotheticalOrigins,
  createUsd3HypotheticalCaptureControl,
  parseUsd3HypotheticalJson,
} from '@/scripts/research/usd3-hypothetical-history-capture.mjs'
import { ORIGINAL_GHO, UMBRELLA_GHO_ROUTE, UMBRELLA_STKGHO } from './umbrellaGhoExit'
import {
  beginHolderNativeHistoryOriginalSeries,
  recordHolderNativeHistoryOriginalBatch,
  finishHolderNativeHistoryOriginalSeries,
  type HolderNativeHistoryOriginalSeries,
  type HolderNativeHistoryOriginalReason,
  type HolderNativeHistoryOriginalRetentionStatus,
} from './holderNativeHistoryOriginals.server'
import {
  UMBRELLA_GHO_NATIVE_ABI,
  projectUmbrellaGhoNativeHeader,
  replayUmbrellaGhoNativeCapacityFact,
  umbrellaGhoNativeCapacityReadPlan,
  umbrellaGhoNativeCapacityEntitlementReadPlan,
  type UmbrellaGhoNativeCapacityBinding,
  type UmbrellaGhoNativeCapacityFact,
  type UmbrellaGhoNativeTrace,
} from './umbrellaGhoNativeCapacity'

/** Server-only original read identity. JSON/inspection facts remain unsigned.
 * Exact raw originals are retained by the bounded diagnostic sink before full qualification replay.
 * Sink seals do not authenticate acquisition; only this module owns the original read identity.
 * This identity grants neither operator authentication nor execution/forecast authority. */
export type UmbrellaGhoNativeCapacityAcquisition = Readonly<{
  fact: UmbrellaGhoNativeCapacityFact
  originFacts: readonly UmbrellaGhoNativeCapacityFact[]
  finalizedHeaders: readonly { number: string; hash: string; timestamp: string }[]
  readAtUtc: string
  availableAtUtc: string
  /** Server-only diagnostic paths/seals; never serialize this acquisition into an API response. */
  retention: HolderNativeHistoryOriginalRetentionStatus
  originalAuthority: false
  authenticated: false
  executionAuthority: false
}>
const TTL = 1800000
const HOSTS = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']
const originals = new WeakMap<
  object,
  {
    binding: UmbrellaGhoNativeCapacityBinding
    fact: UmbrellaGhoNativeCapacityFact
    availableAtMs: number
    // Exact original native bodies and finality witnesses remain private and ephemeral.
    receipt: unknown
  }
>()
type CurrentPhase =
  | 'binding'
  | 'origins'
  | 'current_reads'
  | 'finalized_header'
  | 'position_reads'
  | 'full_shares_decode'
  | 'cooldown_shares_decode'
  | 'entitlement_reads'
  | 'raw_receipt'
  | 'native_replay'
  | 'agreement'
  | 'retention'
  | 'freshness'
  | 'complete'
let lastDiagnostic: Readonly<{ phase: CurrentPhase; qualified: boolean }> | null = null
/** Fixed server-only stages, no provider error text, holder fields, paths or credentials. */
export function getLastUmbrellaGhoNativeCapacityDiagnostic() {
  return lastDiagnostic
}
let busy = false
function check(v: unknown): asserts v {
  if (!v) throw Error('umbrella_native_current_unavailable')
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
function snapshot(value: unknown): unknown {
  let nodes = 0
  const seen = new WeakSet<object>()
  const copy = (v: unknown, depth: number): unknown => {
    check(++nodes <= 64 && depth <= 3)
    if (typeof v === 'string') {
      check(v.length <= 128)
      return v
    }
    if (typeof v === 'number') {
      check(Number.isSafeInteger(v) && v >= 0)
      return v
    }
    if (typeof v === 'boolean') return v
    check(v && typeof v === 'object' && !Array.isArray(v) && !seen.has(v))
    check(
      Object.getPrototypeOf(v) === Object.prototype && Object.getOwnPropertySymbols(v).length === 0,
    )
    seen.add(v)
    const out: Record<string, unknown> = {}
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      check(
        !['__proto__', 'constructor', 'prototype'].includes(key) &&
          descriptor.enumerable &&
          Object.hasOwn(descriptor, 'value'),
      )
      out[key] = copy(descriptor.value, depth + 1)
    }
    return out
  }
  return copy(value, 0)
}
function bindingAt(value: unknown, wall: number): UmbrellaGhoNativeCapacityBinding {
  const b = snapshot(value) as UmbrellaGhoNativeCapacityBinding
  check(
    Object.keys(b).sort().join(',') ===
      'asOfMs,asset,assetDecimals,destination,owner,routeKey,shareDecimals,source',
  )
  check(
    b.routeKey === UMBRELLA_GHO_ROUTE &&
      b.destination === UMBRELLA_STKGHO &&
      b.asset === ORIGINAL_GHO &&
      b.assetDecimals === 18 &&
      b.shareDecimals === 18,
  )
  check(
    typeof b.owner === 'string' && /^0x[0-9a-f]{40}$/.test(b.owner) && !/^0x0{40}$/.test(b.owner),
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
      /^0x[0-9a-f]{64}$/.test(s.blockHash),
  )
  const at = Date.parse(s.blockTime)
  check(
    Number.isSafeInteger(at) &&
      at >= 0 &&
      new Date(at).toISOString() === s.blockTime &&
      at % 1000 === 0,
  )
  check(
    Number.isSafeInteger(wall) &&
      wall >= 0 &&
      b.asOfMs <= wall &&
      at <= b.asOfMs &&
      wall - at <= TTL,
  )
  return freeze(b)
}
const digest = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')
function shareResult(
  trace: UmbrellaGhoNativeTrace,
  name: 'balanceOf' | 'getStakerCooldown',
): string {
  const raw = trace.result
  check(typeof raw === 'string' && raw.length <= 194 && /^0x[0-9a-f]*$/.test(raw))
  const decoded = decodeFunctionResult({
    abi: UMBRELLA_GHO_NATIVE_ABI,
    functionName: name,
    data: raw as `0x${string}`,
  })
  check(
    encodeFunctionResult({
      abi: UMBRELLA_GHO_NATIVE_ABI,
      functionName: name,
      result: decoded,
    } as never) === raw,
  )
  const shares = name === 'balanceOf' ? decoded : (decoded as readonly unknown[])[0]
  check(typeof shares === 'bigint' && shares >= 0n)
  return shares.toString()
}

/** No caller fetch/client/clock/profile callback. Only the original approved native pair is used. */
export async function acquireUmbrellaGhoNativeCapacity(
  binding: UmbrellaGhoNativeCapacityBinding,
): Promise<UmbrellaGhoNativeCapacityAcquisition | null> {
  let control: ReturnType<typeof createUsd3HypotheticalCaptureControl> | undefined
  let series: HolderNativeHistoryOriginalSeries | undefined
  let recorded = false,
    finalized = false
  let failureReason: HolderNativeHistoryOriginalReason = 'provider_unavailable'
  let currentBinding: UmbrellaGhoNativeCapacityBinding | undefined
  let phase: CurrentPhase = 'binding'
  let failedReadPhase: CurrentPhase | undefined
  let credentialTokens: string[] = []
  let privacyRejected = false
  const retain = (receipt: any, accepted: boolean) => {
    if (!series || recorded) return
    // Reject configured URL/credential echoes rather than redact and call them originals.
    const forbidden = (text: string) => credentialTokens.some((token) => text.includes(token))
    for (const row of receipt.ledger) {
      if (typeof row.rawBodyBase64 !== 'string') continue
      const bytes = Buffer.from(row.rawBodyBase64, 'base64')
      check(bytes.length <= 65536)
      const text = bytes.toString('utf8')
      let echoed = forbidden(text)
      let parsed: unknown
      try {
        parsed = parseUsd3HypotheticalJson(text)
      } catch {
        // A malformed escaped body cannot be decoded safely to exclude a credential echo.
        if (text.includes('\\')) {
          privacyRejected = true
          failureReason = 'invalid_input'
          throw Error('umbrella_native_current_unavailable')
        }
        // Ordinary unescaped malformed bytes still undergo the literal configured-token scan.
      }
      let nodes = 0
      const inspect = (v: unknown, depth: number): void => {
        if (++nodes > 5000 || depth > 12) {
          privacyRejected = true
          failureReason = 'invalid_input'
          throw Error('umbrella_native_current_unavailable')
        }
        if (typeof v === 'string') {
          if (forbidden(v)) echoed = true
          return
        }
        if (v && typeof v === 'object')
          Object.entries(v).forEach(([key, item]) => {
            inspect(key, depth + 1)
            inspect(item, depth + 1)
          })
      }
      inspect(parsed, 0)
      if (echoed) {
        privacyRejected = true
        failureReason = 'invalid_input'
        throw Error('umbrella_native_current_unavailable')
      }
    }
    recorded = true
    recordHolderNativeHistoryOriginalBatch(series, {
      batchIndex: 0,
      plan: {
        schema: 'umbrella_gho_current_native_read_plan_v1',
        binding: currentBinding,
        maxPhysicalStarts: 46,
        requests: receipt.ledger.map((row: any) => ({
          host: row.host,
          request: structuredClone(row.request),
        })),
      },
      receipt,
      capturedAccepted: accepted,
    })
  }
  if (busy) return null
  try {
    const started = Date.now(),
      b = bindingAt(binding, started)
    busy = true
    currentBinding = b
    // S is not caller-supplied or known yet. Source originals are captured synchronously.
    series = beginHolderNativeHistoryOriginalSeries({
      kind: 'umbrella_gho_current',
      sharesRaw: null,
    })
    phase = 'origins'
    const origins = await configuredUsd3HypotheticalOrigins()
    check(
      origins.length === 2 &&
        origins.every((o: { host: string }, i: number) => o.host === HOSTS[i]),
    )
    credentialTokens = origins.flatMap((origin: { url: string }) => {
      const url = new URL(origin.url)
      const segments = url.pathname.split('/').filter(Boolean)
      const routing = new Set(['v1', 'v2', 'v3', 'eth', 'ethereum', 'mainnet', 'rpc'])
      const privateParts = segments.filter((segment) => !routing.has(segment.toLowerCase()))
      return [
        origin.url,
        ...privateParts.flatMap((part) => [part, decodeURIComponent(part)]),
        ...Array.from(url.searchParams.values()),
      ].filter((token) => token.length > 0)
    })
    bindingAt(b, Date.now())
    phase = 'current_reads'
    control = createUsd3HypotheticalCaptureControl(origins)
    const controller = control
    let starts = 0,
      id = 0
    const observations: { host: string; request: unknown; result: unknown; physicalId: number }[] =
      []
    const request = async (
      origin: { host: string; url: string },
      spec: { key: string; request: { method: string; params: unknown[] } },
    ): Promise<UmbrellaGhoNativeTrace> => {
      check(++starts <= 46 && Date.now() >= started && Date.now() - started <= 120000)
      const body = { jsonrpc: '2.0', id: ++id, ...spec.request }
      const response = await controller.fetcher(origin.url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const text = await response.text()
      check(Buffer.byteLength(text) <= 65536)
      const envelope = parseUsd3HypotheticalJson(text)
      check(
        Object.keys(envelope).sort().join(',') === 'id,jsonrpc,result' &&
          envelope.jsonrpc === '2.0' &&
          envelope.id === body.id,
      )
      const physicalId = Number(response.headers.get('x-usd3-physical-id'))
      check(Number.isSafeInteger(physicalId) && physicalId > 0)
      observations.push({ host: origin.host, request: body, result: envelope.result, physicalId })
      return { ...spec, result: envelope.result }
    }
    controller.beginStage('umbrella_current')
    const wires = await Promise.all(
      origins.map(async (origin: { host: string; url: string }) => {
        let readPhase: CurrentPhase = 'finalized_header'
        try {
          const finalized = await request(origin, {
            key: 'finalized',
            request: { method: 'eth_getBlockByNumber', params: ['finalized', false] },
          })
          const head = projectUmbrellaGhoNativeHeader(finalized.result)
          check(
            head &&
              Number(BigInt(head.number)) >= b.source.blockNumber &&
              Number(BigInt(head.timestamp)) * 1000 >= Date.parse(b.source.blockTime) &&
              Number(BigInt(head.timestamp)) * 1000 <= Date.now(),
          )
          check(
            Number(BigInt(head.number)) !== b.source.blockNumber ||
              (head.hash === b.source.blockHash &&
                Number(BigInt(head.timestamp)) * 1000 === Date.parse(b.source.blockTime)),
          )
          const traces: UmbrellaGhoNativeTrace[] = []
          readPhase = 'position_reads'
          for (const spec of umbrellaGhoNativeCapacityReadPlan(b.owner, b.source))
            traces.push(await request(origin, spec))
          // Preliminary canonical S/CS decoding is needed to dispatch the measured preview arguments.
          // Durable retention precedes full qualification replay, not every JSON/ABI decode.
          readPhase = 'full_shares_decode'
          const S = shareResult(traces.find((t) => t.key === 'full_shares')!, 'balanceOf')
          readPhase = 'cooldown_shares_decode'
          const CS = shareResult(traces.find((t) => t.key === 'snapshot')!, 'getStakerCooldown')
          readPhase = 'entitlement_reads'
          for (const spec of umbrellaGhoNativeCapacityEntitlementReadPlan(S, CS, b.source))
            traces.push(await request(origin, spec))
          return { finalized: head, readAtUtc: new Date(Date.now()).toISOString(), traces }
        } catch (error) {
          failedReadPhase ??= readPhase
          throw error
        }
      }),
    )
    phase = 'raw_receipt'
    const receipt = await controller.finish()
    retain(
      receipt,
      receipt.physicalStarts === 46 && receipt.pendingSettlements === 0 && receipt.failure === null,
    )
    failureReason = 'replay_rejected'
    const finished = Date.now()
    check(
      finished >= started &&
        finished - started <= 120000 &&
        receipt.physicalStarts === 46 &&
        receipt.pendingSettlements === 0 &&
        receipt.failure === null,
    )
    check(
      receipt.ledger.length === 46 &&
        receipt.terminalCommitments.length === 46 &&
        observations.length === 46 &&
        new Set(observations.map((o) => o.physicalId)).size === 46,
    )
    check(
      new Set(receipt.terminalCommitments.map((c: { physicalId: number }) => c.physicalId)).size ===
        46,
    )
    for (const observation of observations) {
      const row = receipt.ledger.find(
        (r: { physicalId: number }) => r.physicalId === observation.physicalId,
      )
      const commitment = receipt.terminalCommitments.find(
        (c: { physicalId: number }) => c.physicalId === observation.physicalId,
      )
      check(
        row &&
          row.accepted === true &&
          row.status === 'success' &&
          row.host === observation.host &&
          isDeepStrictEqual(row.request, observation.request),
      )
      check(commitment?.rowSha256 === digest(JSON.stringify(row)))
      const bytes = Buffer.from(row.rawBodyBase64, 'base64')
      check(
        bytes.length === row.bodyBytes &&
          bytes.toString('base64') === row.rawBodyBase64 &&
          digest(bytes) === row.bodySha256,
      )
      const envelope = parseUsd3HypotheticalJson(bytes.toString('utf8'))
      check(isDeepStrictEqual(envelope.result, observation.result))
      check(
        Date.parse(row.startedAtUtc) >= started &&
          Date.parse(row.completedAtUtc) >= Date.parse(row.startedAtUtc) &&
          Date.parse(row.completedAtUtc) <= finished,
      )
    }
    for (let i = 0; i < wires.length; i++) {
      const read = Date.parse(wires[i].readAtUtc)
      const hostRows = receipt.ledger.filter((r: { host: string }) => r.host === origins[i].host)
      check(
        hostRows.length === 23 &&
          read >= started &&
          read <= finished &&
          hostRows.every((r: { completedAtUtc: string }) => Date.parse(r.completedAtUtc) <= read),
      )
    }
    bindingAt(b, finished)
    phase = 'native_replay'
    const facts = wires.map((w) =>
      replayUmbrellaGhoNativeCapacityFact(
        { readAtUtc: w.readAtUtc, traces: w.traces },
        { ...b, asOfMs: finished },
      ),
    )
    check(
      facts.every(
        (f): f is UmbrellaGhoNativeCapacityFact => f !== null && f.runtimeProfileQualified,
      ),
    )
    phase = 'agreement'
    const [first, second] = facts as UmbrellaGhoNativeCapacityFact[]
    check(isDeepStrictEqual({ ...first, readAtUtc: null }, { ...second, readAtUtc: null }))
    const readAtUtc = new Date(
      Math.max(...facts.map((f) => Date.parse(f!.readAtUtc))),
    ).toISOString()
    const fact = freeze({ ...first, readAtUtc })
    phase = 'retention'
    const retention = finishHolderNativeHistoryOriginalSeries(series, {
      qualification: true,
      reason: 'qualified',
      batchQualifications: [true],
    })
    finalized = true
    check(retention.reason !== 'source_changed' && retention.reason !== 'artifact_changed')
    const availableAtMs = Date.now()
    check(availableAtMs >= finished)
    phase = 'freshness'
    bindingAt(b, availableAtMs)
    const acquisition = freeze({
      fact,
      availableAtUtc: new Date(availableAtMs).toISOString(),
      retention,
      originFacts: facts as UmbrellaGhoNativeCapacityFact[],
      finalizedHeaders: wires.map((w) => w.finalized),
      readAtUtc,
      originalAuthority: false as const,
      authenticated: false as const,
      executionAuthority: false as const,
    })
    originals.set(acquisition, { binding: b, fact, availableAtMs, receipt })
    phase = 'complete'
    lastDiagnostic = Object.freeze({ phase, qualified: true })
    return acquisition
  } catch {
    lastDiagnostic = Object.freeze({ phase: failedReadPhase ?? phase, qualified: false })
    return null
  } finally {
    if (control && !recorded && !privacyRejected) {
      try {
        retain(await control.finish(), false)
      } catch {
        /* Fixed failure diagnostic; no provider error text. */
      }
    }
    if (series && !finalized)
      finishHolderNativeHistoryOriginalSeries(series, {
        qualification: false,
        reason: failureReason,
        batchQualifications: recorded ? [false] : [],
      })
    busy = false
  }
}

/** Selects only this server's exact original acquisition under the complete current binding. */
export function selectedOriginalUmbrellaGhoNativeCapacity(
  value: unknown,
  binding: UmbrellaGhoNativeCapacityBinding,
): UmbrellaGhoNativeCapacityFact | null {
  try {
    check(value && typeof value === 'object')
    const original = originals.get(value as object)
    check(original)
    const b = bindingAt(binding, Date.now())
    check(isDeepStrictEqual({ ...b, asOfMs: null }, { ...original.binding, asOfMs: null }))
    check(
      b.asOfMs >= original.availableAtMs &&
        b.asOfMs >= Date.parse(original.fact.readAtUtc) &&
        b.asOfMs >= original.binding.asOfMs,
    )
    return original.fact
  } catch {
    return null
  }
}
