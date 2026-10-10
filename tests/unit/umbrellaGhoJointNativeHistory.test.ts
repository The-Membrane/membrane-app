import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeFunctionData, encodeFunctionResult } from 'viem'
import {
  UMBRELLA_GHO_JOINT_NATIVE_HISTORY_ANCHORS,
  resolveUmbrellaGhoJointNativeHistoryAnchor,
  umbrellaGhoJointNativeHistoryReadPlan,
  replayUmbrellaGhoJointNativeHistoryPoint,
  type UmbrellaGhoJointNativeHistoryBinding,
  type UmbrellaGhoJointNativeHistoryWire,
} from '@/lib/carry/umbrellaGhoJointNativeHistory'
import { UMBRELLA_GHO_NATIVE_ABI } from '@/lib/carry/umbrellaGhoNativeCapacity'
import { UMBRELLA_STKGHO } from '@/lib/carry/umbrellaGhoExit'

const archive = join(
  process.cwd(),
  'data/research/venue-signals/umbrella-gho-joint-native-evidence-2026-10-08',
)
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const indexBytes = readFileSync(join(archive, 'evidence-index.json'))
if (sha(indexBytes) !== '98b80e938432a08511ef163040cf24285dacdb61031465b2a8c3dd54cad86e6b')
  throw Error('expected independently retained archive index')
const index = JSON.parse(indexBytes.toString())
function original<T>(name: string): T {
  const row = index.files.find((r: { destination: string }) => r.destination === name)
  const b = readFileSync(join(archive, name))
  if (!row || row.bytes !== b.length || row.sha256 !== sha(b))
    throw Error('original fixture byte drift')
  return JSON.parse(b.toString()) as T
}
// Read sealed archived codes/raw facts once. Mutated copies are unsigned structural controls.
const plan = original<any>('history-292/plan.json')
const prior = original<any>('current-74/qualified-current.json')
// Reconstruct chain/finality from both archived native bootstrap witnesses.
// The compact qualified-current source intentionally contains only three identity fields.
const currentWitnesses = [1, 2, 3, 4].map((id) => ({
  start: original<any>('current-74/rpc-start-' + String(id).padStart(4, '0') + '.json'),
  response: original<any>('current-74/rpc-response-' + String(id).padStart(4, '0') + '.bin'),
}))
for (let origin = 0; origin < 2; origin++) {
  const chain = currentWitnesses[origin * 2],
    finalized = currentWitnesses[origin * 2 + 1]
  const host = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'][origin]
  if (
    chain.start.host !== host ||
    finalized.start.host !== host ||
    chain.start.request.method !== 'eth_chainId' ||
    JSON.stringify(chain.start.request.params) !== '[]' ||
    chain.response.jsonrpc !== '2.0' ||
    chain.response.id !== chain.start.request.id ||
    chain.response.result !== '0x1' ||
    finalized.start.request.method !== 'eth_getBlockByNumber' ||
    JSON.stringify(finalized.start.request.params) !== '["finalized",false]' ||
    finalized.response.jsonrpc !== '2.0' ||
    finalized.response.id !== finalized.start.request.id ||
    Number(BigInt(finalized.response.result.number)) !== prior.source.blockNumber ||
    finalized.response.result.hash !== prior.source.blockHash ||
    new Date(Number(BigInt(finalized.response.result.timestamp)) * 1000).toISOString() !==
      prior.source.blockTime
  )
    throw Error('archived current chain/finalized source witness mismatch')
}
const currentSource = { ...prior.source, chainId: 1 as const, finalized: true as const }
const legacy = original<any[]>('history-292/replayed-native-points.json')
const terminals = [
  original<any>('history-292/batch-0-terminal.json'),
  original<any>('history-292/batch-1-terminal.json'),
]
const BASELINES = Array.from({ length: 8 }, (_, anchor) => {
  const terminal = terminals[Math.floor(anchor / 4)],
    point = legacy[anchor]
  const wire: UmbrellaGhoJointNativeHistoryWire = {
    origins: ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'].map((host, origin) => {
      const traces = terminal.ledger
        .slice(2 + (anchor % 4) * 36 + origin * 18, 2 + (anchor % 4) * 36 + (origin + 1) * 18)
        .map((row: any, i: number) => ({
          key: [
            'headerBefore',
            'implementationSlot',
            'proxyCode',
            'implementationCode',
            'assetCode',
            'asset',
            'shareDecimals',
            'assetDecimals',
            'fullEaRaw',
            'coveredEaRaw',
            'cashRaw',
            'paused',
            'totalAssetsRaw',
            'totalSupplyRaw',
            'cooldownSeconds',
            'unstakeWindowSeconds',
            'maxSlashableAssetsRaw',
            'headerAfter',
          ][i],
          request: { method: row.request.method, params: row.request.params },
          result: JSON.parse(Buffer.from(row.rawBodyBase64, 'base64').toString()).result,
          completedAtUtc: row.completedAtUtc,
        }))
      return {
        host,
        chainIdTrace: {
          key: 'chain',
          request: { method: 'eth_chainId', params: [] },
          result: JSON.parse(
            Buffer.from(terminal.ledger[origin].rawBodyBase64, 'base64').toString(),
          ).result,
        },
        traces,
        acquiredAtUtc: point.originAcquiredAtUtc[origin].acquiredAtUtc,
      }
    }),
  }
  const binding: UmbrellaGhoJointNativeHistoryBinding = {
    cashIndex: point.cashIndex,
    source: point.source,
    currentSource,
    fullSharesRaw: plan.sharesRaw,
    cooldownSharesRaw: plan.cooldownCoveredSharesRaw,
    acquiredAtUtc: point.acquiredAtUtc,
  }
  return { wire, binding }
})
function fixture(anchor = 0) {
  return structuredClone(BASELINES[anchor])
}
function replay(v = fixture()) {
  return replayUmbrellaGhoJointNativeHistoryPoint(v.wire, v.binding)
}
function point(v = fixture()) {
  const p = replay(v)
  if (!p) throw Error('expected structurally valid archived native point')
  return p
}
function trace(v: ReturnType<typeof fixture>, key: string, origin = 0) {
  const row = v.wire.origins[origin].traces.find((t) => t.key === key)
  if (!row) throw Error('missing fixture trace')
  return row
}
function result(
  v: ReturnType<typeof fixture>,
  key: string,
  name: string,
  value: unknown,
  origin?: number,
) {
  for (const n of origin === undefined ? [0, 1] : [origin])
    trace(v, key, n).result = encodeFunctionResult({
      abi: UMBRELLA_GHO_NATIVE_ABI,
      functionName: name,
      result: value,
    } as never)
}
function rebind(v: ReturnType<typeof fixture>, S: string, CS: string) {
  v.binding.fullSharesRaw = S
  v.binding.cooldownSharesRaw = CS
  const reads = umbrellaGhoJointNativeHistoryReadPlan(v.binding)!
  for (const o of v.wire.origins)
    o.traces.forEach((t, i) => {
      t.request = structuredClone(reads[i].request)
    })
  result(v, 'fullEaRaw', 'previewRedeem', BigInt(S) * 2n)
  result(v, 'coveredEaRaw', 'previewRedeem', BigInt(CS) * 2n)
}

describe('unsigned paired Umbrella native historical point replay', () => {
  it.each(Array.from({ length: 8 }, (_, i) => i))(
    'reconstructs actual approved native anchor %s',
    (i) => {
      const v = fixture(i),
        specs = umbrellaGhoJointNativeHistoryReadPlan(v.binding)!
      expect(specs).toHaveLength(18)
      expect(specs).toEqual(v.wire.origins[0].traces.map(({ key, request }) => ({ key, request })))
      const p = point(v),
        { MRaw, ...actual } = p
      expect(actual).toEqual(legacy[i])
      expect(MRaw).toBeNull()
      expect(Object.isFrozen(p.runtimeCodeHashes)).toBe(true)
    },
  )

  it('binds distinct full S and partial CS without a requested-Q or past-owner getter', () => {
    const v = fixture()
    rebind(v, '100', '40')
    const p = point(v),
      specs = umbrellaGhoJointNativeHistoryReadPlan(v.binding)!
    expect(p).toMatchObject({
      sharesRaw: '100',
      cooldownCoveredSharesRaw: '40',
      fullEaRaw: '200',
      coveredEaRaw: '80',
      owner: null,
      historicalOwnership: false,
    })
    const calls = specs
      .filter((t) => t.request.method === 'eth_call')
      .map((t) =>
        decodeFunctionData({
          abi: UMBRELLA_GHO_NATIVE_ABI,
          data: (t.request.params[0] as { data: never }).data,
        }),
      )
    expect(calls.filter((t) => t.functionName === 'previewRedeem').map((t) => t.args![0])).toEqual([
      100n,
      40n,
    ])
    expect(calls.some((t) => ['getStakerCooldown', 'maxRedeem'].includes(t.functionName))).toBe(
      false,
    )
    const balance = specs.find((t) => t.key === 'cashRaw')!
    expect(
      decodeFunctionData({
        abi: UMBRELLA_GHO_NATIVE_ABI,
        data: (balance.request.params[0] as { data: never }).data,
      }).args?.map((address) => String(address).toLowerCase()),
    ).toEqual([UMBRELLA_STKGHO])
    expect(Object.values(p.authority!).every((v) => v === false)).toBe(true)
  })

  it('allows explicit zero CS while keeping the positive full S quote independent', () => {
    const v = fixture()
    rebind(v, '100', '0')
    expect(point(v)).toMatchObject({
      sharesRaw: '100',
      fullEaRaw: '200',
      cooldownCoveredSharesRaw: '0',
      coveredEaRaw: '0',
    })
    v.binding.fullSharesRaw = '0'
    expect(umbrellaGhoJointNativeHistoryReadPlan(v.binding)).toBeNull()
  })

  it.each(['fullSharesRaw', 'cooldownSharesRaw'] as const)(
    'rejects metadata-only %s rebinding',
    (key) => {
      const v = fixture()
      v.binding[key] = '100'
      expect(replay(v)).toBeNull()
    },
  )

  it.each([
    ['fullEaRaw', 'previewRedeem'],
    ['coveredEaRaw', 'previewRedeem'],
    ['totalAssetsRaw', 'totalAssets'],
    ['totalSupplyRaw', 'totalSupply'],
    ['cooldownSeconds', 'getCooldown'],
    ['unstakeWindowSeconds', 'getUnstakeWindow'],
    ['maxSlashableAssetsRaw', 'getMaxSlashableAssets'],
  ])('rejects cross-origin %s disagreement', (key, name) => {
    const v = fixture()
    result(v, key, name, 1n, 1)
    expect(replay(v)).toBeNull()
  })

  it.each(['proxyCode', 'implementationCode', 'assetCode'])(
    'rejects changed or mismatched %s',
    (key) => {
      const v = fixture()
      trace(v, key, 1).result = '0x00'
      expect(replay(v)).toBeNull()
      trace(v, key, 0).result = '0x00'
      expect(replay(v)).toBeNull()
    },
  )

  it.each(['headerBefore', 'headerAfter'])(
    'projects a real 93-transaction %s without losing identity',
    (key) => {
      const v = fixture()
      for (const o of v.wire.origins) {
        const h = o.traces.find((t) => t.key === key)!.result as Record<string, unknown>
        h.transactions = Array(93).fill({ hash: '0x' + 'a'.repeat(64) })
      }
      expect(point(v).source).toEqual(v.binding.source)
      ;(trace(v, key, 1).result as Record<string, unknown>).hash = '0x' + '0'.repeat(64)
      expect(replay(v)).toBeNull()
    },
  )

  it.each([
    ['implementationSlot', '0x' + '0'.repeat(64)],
    ['fullEaRaw', '0x01'],
    ['coveredEaRaw', '0x' + '0'.repeat(128)],
    ['paused', '0x' + '0'.repeat(63) + '2'],
  ])('rejects noncanonical or wrong %s native output', (key, bad) => {
    const v = fixture()
    trace(v, key).result = bad
    expect(replay(v)).toBeNull()
  })

  it('rejects an unsupported getter as unknown instead of substituting native zero', () => {
    const v = fixture()
    trace(v, 'coveredEaRaw', 1).result = { error: { code: -32000 } }
    expect(replay(v)).toBeNull()
  })

  it.each(['assetDecimals', 'shareDecimals'])('rejects mismatched %s', (key) => {
    const v = fixture()
    result(v, key, 'decimals', 6)
    expect(replay(v)).toBeNull()
  })

  it('rejects wrong final asset and a cash quote inconsistent with its authenticated cash anchor', () => {
    const v = fixture()
    result(v, 'asset', 'asset', UMBRELLA_STKGHO)
    expect(replay(v)).toBeNull()
    const cash = fixture()
    result(cash, 'cashRaw', 'balanceOf', 0n)
    expect(replay(cash)).toBeNull()
  })

  it('retains an actually read paused flag only with canonical zero slashable output', () => {
    const v = fixture()
    result(v, 'paused', 'paused', true)
    expect(replay(v)).toBeNull()
    result(v, 'maxSlashableAssetsRaw', 'getMaxSlashableAssets', 0n)
    expect(point(v).paused).toBe(true)
    expect(point(v).maxSlashableAssetsRaw).toBe('0')
    result(v, 'paused', 'paused', false, 1)
    expect(replay(v)).toBeNull()
  })

  it('rejects altered native request pin, method, shareholder calldata and diagnostic subject', () => {
    const pin = fixture()
    ;(trace(pin, 'fullEaRaw').request.params[1] as { requireCanonical: boolean }).requireCanonical =
      false
    expect(replay(pin)).toBeNull()
    const method = fixture()
    trace(method, 'cashRaw').request.method = 'eth_estimateGas'
    expect(replay(method)).toBeNull()
    const swapped = fixture()
    rebind(swapped, '100', '40')
    trace(swapped, 'fullEaRaw').request = trace(swapped, 'coveredEaRaw').request
    expect(replay(swapped)).toBeNull()
    const subject = fixture()
    ;(trace(subject, 'cashRaw').request.params[0] as { to: string }).to = UMBRELLA_STKGHO
    expect(replay(subject)).toBeNull()
  })

  it('rejects chain/origin substitutions and extra, duplicate or missing getter traces', () => {
    const chain = fixture()
    chain.wire.origins[1].chainIdTrace.result = '0x2'
    expect(replay(chain)).toBeNull()
    const host = fixture()
    host.wire.origins[1].host = 'eth-mainnet.g.alchemy.com'
    expect(replay(host)).toBeNull()
    const extra = fixture()
    extra.wire.origins[0].traces.push(structuredClone(trace(extra, 'cashRaw')))
    expect(replay(extra)).toBeNull()
    const dup = fixture()
    dup.wire.origins[0].traces[8] = structuredClone(trace(dup, 'coveredEaRaw'))
    expect(replay(dup)).toBeNull()
    const missing = fixture()
    missing.wire.origins[0].traces.pop()
    expect(replay(missing)).toBeNull()
  })

  it('binds actual maximum completion clocks and source-before-current without inventing fresh live qualification', () => {
    const v = fixture(),
      p = point(v)
    expect(p.acquiredAtUtc).toBe(v.binding.acquiredAtUtc)
    expect(p.originAcquiredAtUtc).toEqual(
      v.wire.origins.map((o) => ({ host: o.host, acquiredAtUtc: o.acquiredAtUtc })),
    )
    const clock = fixture()
    clock.binding.acquiredAtUtc = new Date(
      Date.parse(clock.binding.acquiredAtUtc) + 1,
    ).toISOString()
    expect(replay(clock)).toBeNull()
    const origin = fixture()
    origin.wire.origins[0].acquiredAtUtc = origin.binding.acquiredAtUtc
    expect(replay(origin)).toBeNull()
    const chronology = fixture()
    chronology.binding.currentSource = chronology.binding.source
    expect(replay(chronology)).toBeNull()
    const source = fixture()
    source.binding.source.blockHash = '0x' + '0'.repeat(64)
    expect(umbrellaGhoJointNativeHistoryReadPlan(source.binding)).toBeNull()
    const staleCurrent = fixture()
    // This original historical replayer has no live TTL authority; current chronology is all it claims.
    expect(point(staleCurrent).authority?.forecastIssued).toBe(false)
  })

  it('rejects acquisition clocks before the source or out of native completion order', () => {
    const v = fixture()
    trace(v, 'headerBefore').completedAtUtc = new Date(
      Date.parse(v.binding.source.blockTime) - 1,
    ).toISOString()
    expect(replay(v)).toBeNull()
    const order = fixture()
    trace(order, 'coveredEaRaw').completedAtUtc = trace(order, 'headerBefore').completedAtUtc
    expect(replay(order)).toBeNull()
  })

  it('snapshots aliased native data and binding primitives, without executing accessors or accepting cycles/sparse arrays', () => {
    const v = fixture()
    v.wire.origins[1].chainIdTrace = v.wire.origins[0].chainIdTrace
    const p = point(v)
    v.binding.fullSharesRaw = '1'
    trace(v, 'cashRaw').result = '0x'
    expect(p.sharesRaw).toBe(plan.sharesRaw)
    expect(p.cashRaw).toBe(legacy[0].cashRaw)
    expect(Object.isFrozen(p)).toBe(true)
    const b = fixture()
    let called = false
    Object.defineProperty(b.binding, 'fullSharesRaw', {
      enumerable: true,
      get() {
        called = true
        return plan.sharesRaw
      },
    })
    expect(replay(b)).toBeNull()
    expect(called).toBe(false)
    const h = fixture()
    Object.defineProperty(trace(h, 'headerBefore').result as object, 'hash', {
      enumerable: true,
      get() {
        called = true
        return h.binding.source.blockHash
      },
    })
    expect(replay(h)).toBeNull()
    expect(called).toBe(false)
    const cycle = fixture()
    ;(cycle.wire as unknown as { cycle: unknown }).cycle = cycle.wire
    expect(replay(cycle)).toBeNull()
    const sparse = fixture()
    delete sparse.wire.origins[0].traces[3]
    expect(replay(sparse)).toBeNull()
  })

  it('rejects oversized input, native policy overflow and malformed canonical share words', () => {
    const huge = fixture()
    trace(huge, 'assetCode').result = '0x' + '0'.repeat(65536)
    expect(replay(huge)).toBeNull()
    const policy = fixture()
    result(policy, 'cooldownSeconds', 'getCooldown', 0x100000000n)
    expect(replay(policy)).toBeNull()
    for (const bad of ['01', '-1', String(1n << 256n)]) {
      const shares = fixture()
      shares.binding.fullSharesRaw = bad
      expect(umbrellaGhoJointNativeHistoryReadPlan(shares.binding)).toBeNull()
    }
  })

  it('allows only the immutable published eight anchor literals and no ownership/Q authority metadata', () => {
    expect(UMBRELLA_GHO_JOINT_NATIVE_HISTORY_ANCHORS).toHaveLength(8)
    expect(Object.isFrozen(UMBRELLA_GHO_JOINT_NATIVE_HISTORY_ANCHORS[0].source)).toBe(true)
    expect(resolveUmbrellaGhoJointNativeHistoryAnchor(111)).toBeNull()
    const extra = fixture()
    ;(extra.binding as unknown as { owner: string }).owner = '0x' + '1'.repeat(40)
    expect(replay(extra)).toBeNull()
    const Q = fixture()
    ;(Q.binding as unknown as { requestedRaw: string }).requestedRaw = '1'
    expect(umbrellaGhoJointNativeHistoryReadPlan(Q.binding)).toBeNull()
  })
})
