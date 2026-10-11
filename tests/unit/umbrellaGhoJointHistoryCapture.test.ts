import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData } from 'viem'
import { UMBRELLA_GHO_NATIVE_ABI } from '@/lib/carry/umbrellaGhoNativeCapacity'

// Simulated native transports are unit controls, never real acquisition evidence.
vi.mock('@/scripts/research/usd3-hypothetical-history-capture.mjs', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configuredUsd3HypotheticalOrigins: async () =>
    Object.freeze([
      Object.freeze({
        host: 'eth-mainnet.g.alchemy.com',
        url: 'https://eth-mainnet.g.alchemy.com/v2/testNativeKey',
      }),
      Object.freeze({ host: 'rpc.ankr.com', url: 'https://rpc.ankr.com/eth/testAnkrKey' }),
    ]),
}))
const base = join(
  process.cwd(),
  'data/research/venue-signals/umbrella-gho-joint-native-evidence-2026-10-08',
)
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const indexBytes = readFileSync(join(base, 'evidence-index.json'))
if (sha(indexBytes) !== '98b80e938432a08511ef163040cf24285dacdb61031465b2a8c3dd54cad86e6b')
  throw Error('archive index drift')
const index = JSON.parse(indexBytes.toString())
function original(name: string) {
  const bytes = readFileSync(join(base, name)),
    pin = index.files.find((r: any) => r.destination === name)
  if (!pin || pin.bytes !== bytes.length || pin.sha256 !== sha(bytes))
    throw Error('archive original drift')
  return JSON.parse(bytes.toString())
}
const terminals = [
  original('history-292/batch-0-terminal.json'),
  original('history-292/batch-1-terminal.json'),
]
const prior = original('current-74/qualified-current.json'),
  historicalPlan = original('history-292/plan.json')
function canonical(v: any): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  if (v && typeof v === 'object')
    return (
      '{' +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
        .join(',') +
      '}'
    )
  return JSON.stringify(v)
}
const dictionary = new Map(
  terminals.flatMap((t) =>
    t.ledger.map(
      (r: any) =>
        [
          canonical({ method: r.request.method, params: r.request.params }),
          JSON.parse(Buffer.from(r.rawBodyBase64, 'base64').toString()).result,
        ] as const,
    ),
  ),
)
const opts = (batchIndex = 0) => ({
  batchIndex,
  fullSharesRaw: historicalPlan.sharesRaw,
  cooldownSharesRaw: historicalPlan.cooldownCoveredSharesRaw,
  currentSource: { ...prior.source, chainId: 1, finalized: true },
})
let calls: { host: string; request: any; at: number; redirect: unknown }[]
let mode:
  | 'native'
  | 'oversize'
  | 'duplicate'
  | 'escaped'
  | 'escaped_key'
  | 'escaped_value'
  | 'percent'
  | 'timeout'
  | 'rpc_error'
let api: typeof import('@/scripts/research/umbrella-gho-joint-history-capture.mjs')
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(new Date('2026-10-08T20:05:00.000Z'))
  calls = []
  mode = 'native'
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: any) => {
      const request = JSON.parse(options.body)
      calls.push({
        host: new URL(url).hostname,
        request,
        at: performance.now(),
        redirect: options.redirect,
      })
      if (mode === 'timeout')
        return await new Promise((_, reject) =>
          options.signal.addEventListener('abort', () => reject(Error('unit native abort')), {
            once: true,
          }),
        )
      if (mode === 'oversize') return new Response('x'.repeat(65537))
      if (mode === 'duplicate')
        return new Response(
          '{"jsonrpc":"2.0","id":' + request.id + ',"result":"0x1","result":"0x1"}',
        )
      if (mode === 'escaped') return new Response('{"echo":"\\u0074estNativeKey"')
      if (mode === 'escaped_key') return new Response('{"\\u0074estNativeKey":"echo"}')
      if (mode === 'escaped_value') return new Response('{"echo":"\\u0074estNativeKey"}')
      if (mode === 'percent') return new Response('{"echo":"%74estNativeKey"}')
      if (mode === 'rpc_error')
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32601, message: 'unit unsupported getter' },
          }),
        )
      const result = dictionary.get(canonical({ method: request.method, params: request.params }))
      if (result === undefined) throw Error('unit unexpected actual read plan')
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
    }),
  )
  api = await import('@/scripts/research/umbrella-gho-joint-history-capture.mjs')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
async function drive<T>(promise: Promise<T>) {
  let complete = false
  promise.then(
    () => {
      complete = true
    },
    () => {
      complete = true
    },
  )
  for (let i = 0; i < 600 && !complete; i++) await vi.advanceTimersByTimeAsync(250)
  expect(complete).toBe(true)
  return await promise
}
describe('fixed native Umbrella history physical controls', () => {
  it('captures exactly146 starts and reauthenticates its original only', async () => {
    const plan = api.prepareUmbrellaGhoJointHistoryCapturePlan(opts()),
      captured = await drive(api.captureUmbrellaGhoJointHistoryBatch(plan))
    expect(captured.receipt.physicalStarts).toBe(146)
    expect(captured.receipt.pendingSettlements).toBe(0)
    expect(captured.settlements).toHaveLength(146)
    expect(api.selectedOriginalUmbrellaGhoJointHistoryBatch(captured, plan)).toBe(captured)
    expect(api.selectedOriginalUmbrellaGhoJointHistoryReceiptForRetention(captured)).toBe(
      captured.receipt,
    )
    expect(
      api.selectedOriginalUmbrellaGhoJointHistoryReceiptForRetention(structuredClone(captured)),
    ).toBeNull()
    expect(
      api.selectedOriginalUmbrellaGhoJointHistoryBatch(structuredClone(captured), plan),
    ).toBeNull()
    expect(
      api.selectedOriginalUmbrellaGhoJointHistoryBatch(captured, structuredClone(plan)),
    ).toBeNull()
    expect(captured.originalAuthority).toBe(false)
    expect(captured.authenticated).toBe(false)
    expect(calls).toHaveLength(146)
    expect(calls.every((c) => c.redirect === 'error')).toBe(true)
    expect(Object.isFrozen(captured.receipt.ledger[0])).toBe(true)
  })
  it('uses four other authenticated anchors in batch1 without discovery reads', async () => {
    const plan = api.prepareUmbrellaGhoJointHistoryCapturePlan(opts(1)),
      captured = await drive(api.captureUmbrellaGhoJointHistoryBatch(plan))
    expect(plan.anchors.map((a: any) => a.cashIndex)).toEqual([116, 117, 118, 119])
    expect(api.selectedOriginalUmbrellaGhoJointHistoryBatch(captured, plan)).toBe(captured)
    expect(calls.filter((c) => c.request.method === 'eth_chainId')).toHaveLength(2)
  })
  it('records actual dispatch times and never rounds per-origin pacing below250ms', async () => {
    const plan = api.prepareUmbrellaGhoJointHistoryCapturePlan(opts()),
      captured = await drive(api.captureUmbrellaGhoJointHistoryBatch(plan))
    for (const host of ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']) {
      const physical = calls.filter((c) => c.host === host),
        ledger = captured.receipt.ledger.filter((r: any) => r.host === host)
      expect(physical).toHaveLength(73)
      for (let i = 1; i < physical.length; i++)
        expect(physical[i].at - physical[i - 1].at).toBeGreaterThanOrEqual(250)
      expect(ledger.map((r: any) => r.startedElapsedMs)).toEqual(physical.map((c) => c.at))
    }
  })
  it('counts a fetch that fails before response and retains the prefetch request bytes', async () => {
    mode = 'timeout'
    const plan = api.prepareUmbrellaGhoJointHistoryCapturePlan(opts())
    const captured = await drive(api.captureUmbrellaGhoJointHistoryBatch(plan))
    expect(captured.receipt.physicalStarts).toBe(1)
    expect(captured.receipt.failure).toBe('read_timeout')
    expect(
      JSON.parse(Buffer.from(captured.receipt.ledger[0].requestBodyBase64, 'base64').toString()),
    ).toEqual(calls[0].request)
    expect(captured.receipt.ledger[0].status).toBe('failed')
    expect(captured.receipt.pendingSettlements).toBe(0)
    const committed = JSON.stringify(captured.receipt)
    await vi.advanceTimersByTimeAsync(120000)
    expect(calls).toHaveLength(1)
    expect(JSON.stringify(captured.receipt)).toBe(committed)
  })
  it('caps the response stream at64KiB and reports received byte length without fabricated data', async () => {
    mode = 'oversize'
    const plan = api.prepareUmbrellaGhoJointHistoryCapturePlan(opts()),
      captured = await drive(api.captureUmbrellaGhoJointHistoryBatch(plan))
    expect(captured.receipt.physicalStarts).toBe(1)
    expect(captured.receipt.ledger[0].bodyBytes).toBe(65537)
    expect(captured.receipt.ledger[0].rawBodyBase64).toBeNull()
    expect(captured.accepted).toBe(false)
  })
  it('keeps exact duplicate-key response originals but fails qualification', async () => {
    mode = 'duplicate'
    const plan = api.prepareUmbrellaGhoJointHistoryCapturePlan(opts()),
      captured = await drive(api.captureUmbrellaGhoJointHistoryBatch(plan))
    const body = Buffer.from(captured.receipt.ledger[0].rawBodyBase64, 'base64').toString()
    expect(body.match(/"result"/g)).toHaveLength(2)
    expect(captured.accepted).toBe(false)
    expect(api.selectedOriginalUmbrellaGhoJointHistoryBatch(captured, plan)).toBeNull()
  })
  it('rejects malformed escaped configured credentials before raw-original retention', async () => {
    mode = 'escaped'
    const plan = api.prepareUmbrellaGhoJointHistoryCapturePlan(opts()),
      captured = await drive(api.captureUmbrellaGhoJointHistoryBatch(plan))
    expect(captured.receipt.ledger[0].safeCode).toBe('configured_secret_rejected')
    expect(captured.receipt.ledger[0].rawBodyBase64).toBeNull()
    expect(JSON.stringify(captured)).not.toContain('testNativeKey')
    expect(captured.receipt.ledger[0].bodySha256).toMatch(/^[a-f0-9]{64}$/)
  })
  it.each(['escaped_key', 'escaped_value', 'percent'] as const)(
    'rejects %s configured credential echoes before disk eligibility',
    async (variant) => {
      mode = variant
      const plan = api.prepareUmbrellaGhoJointHistoryCapturePlan(opts()),
        captured = await drive(api.captureUmbrellaGhoJointHistoryBatch(plan))
      expect(captured.receipt.physicalStarts).toBe(1)
      expect(captured.accepted).toBe(false)
      expect(captured.receipt.ledger[0].safeCode).toBe('configured_secret_rejected')
      expect(captured.receipt.ledger[0].rawBodyBase64).toBeNull()
      expect(api.selectedOriginalUmbrellaGhoJointHistoryReceiptForRetention(captured)).toBe(
        captured.receipt,
      )
      expect(JSON.stringify(captured)).not.toContain('testNativeKey')
    },
  )
  it('preserves unsupported getter errors and cannot reinterpret them as zero', async () => {
    mode = 'rpc_error'
    const plan = api.prepareUmbrellaGhoJointHistoryCapturePlan(opts()),
      captured = await drive(api.captureUmbrellaGhoJointHistoryBatch(plan))
    expect(captured.receipt.physicalStarts).toBe(146)
    const decoded = JSON.parse(
      Buffer.from(captured.receipt.ledger[0].rawBodyBase64, 'base64').toString(),
    )
    expect(decoded.error.code).toBe(-32601)
    expect(decoded.result).toBeUndefined()
    expect(api.selectedOriginalUmbrellaGhoJointHistoryBatch(captured, plan)).toBeNull()
    expect(api.selectedOriginalUmbrellaGhoJointHistoryReceiptForRetention(captured)).toBe(
      captured.receipt,
    )
    expect(
      api.selectedOriginalUmbrellaGhoJointHistoryReceiptForRetention(structuredClone(captured)),
    ).toBeNull()
  })
  it('copies S and CS separately, including zeroCS, with no requested-Q input', () => {
    const options = { ...opts(), fullSharesRaw: '100', cooldownSharesRaw: '0' },
      plan = api.prepareUmbrellaGhoJointHistoryCapturePlan(options)
    options.fullSharesRaw = '999'
    options.cooldownSharesRaw = '999'
    const reads = plan.anchors[0].requests.filter((s: any) =>
      ['fullEaRaw', 'coveredEaRaw'].includes(s.key),
    )
    expect(
      reads.map(
        (s: any) =>
          decodeFunctionData({ abi: UMBRELLA_GHO_NATIVE_ABI, data: s.request.params[0].data })
            .args![0],
      ),
    ).toEqual([100n, 0n])
    expect(plan.fullSharesRaw).toBe('100')
    expect(plan.cooldownSharesRaw).toBe('0')
    expect(() =>
      api.prepareUmbrellaGhoJointHistoryCapturePlan({ ...opts(), requestedRaw: '1' }),
    ).toThrow()
  })
  it('rejects accessors without calling them and refuses copied plans before fetch', async () => {
    const getter = vi.fn(() => opts().currentSource),
      options = { ...opts() }
    Object.defineProperty(options, 'currentSource', { get: getter, enumerable: true })
    expect(() => api.prepareUmbrellaGhoJointHistoryCapturePlan(options)).toThrow()
    expect(getter).not.toHaveBeenCalled()
    const plan = api.prepareUmbrellaGhoJointHistoryCapturePlan(opts())
    await expect(api.captureUmbrellaGhoJointHistoryBatch(structuredClone(plan))).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
  it('does not allow native-global replacement after import to become capture authority', async () => {
    const plan = api.prepareUmbrellaGhoJointHistoryCapturePlan(opts())
    vi.stubGlobal('fetch', vi.fn())
    await expect(api.captureUmbrellaGhoJointHistoryBatch(plan)).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})
