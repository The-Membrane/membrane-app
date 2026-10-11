import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult, keccak256 } from 'viem'
import {
  UMBRELLA_GHO_NATIVE_ABI,
  projectUmbrellaGhoNativeHeader,
  type UmbrellaGhoNativeSource,
} from './umbrellaGhoNativeCapacity'
import { UMBRELLA_STKGHO, ORIGINAL_GHO, VERIFIED_STKGHO_IMPLEMENTATION } from './umbrellaGhoExit'
import type { UmbrellaGhoJointHistoryPoint } from './umbrellaGhoJointStockProjection'

export type UmbrellaGhoJointNativeHistoryBinding = {
  cashIndex: number
  source: UmbrellaGhoNativeSource
  /** Chronology only: this is not a current holder/runtime authentication assertion. */
  currentSource: UmbrellaGhoNativeSource
  fullSharesRaw: string
  cooldownSharesRaw: string
  acquiredAtUtc: string
}
export type UmbrellaGhoJointNativeHistoryRead = {
  key: string
  request: { method: string; params: unknown[] }
}
export type UmbrellaGhoJointNativeHistoryTrace = UmbrellaGhoJointNativeHistoryRead & {
  result: unknown
  completedAtUtc: string
}
export type UmbrellaGhoJointNativeHistoryWire = {
  origins: {
    host: string
    chainIdTrace: UmbrellaGhoJointNativeHistoryRead & { result: unknown }
    acquiredAtUtc: string
    traces: UmbrellaGhoJointNativeHistoryTrace[]
  }[]
}
export type UmbrellaGhoJointNativeHistoryPoint = UmbrellaGhoJointHistoryPoint & { MRaw: null }

const MAX = (1n << 256n) - 1n
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const HOSTS = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'] as const
const HASHES: Record<string, string> = {
  [UMBRELLA_STKGHO]: '0x5fa5d4889c27130d81c0afb814238692ca6b8774d690db729865fca3e3722a52',
  [VERIFIED_STKGHO_IMPLEMENTATION]:
    '0x553314ff37b47c42c33fc80c155f04cf1f0163967003f2a0bac7ccbb1dd22a21',
  [ORIGINAL_GHO]: '0xdd51428dd1ef13362e52bfc1689ed8e011730e6c6d5b50aaf96165ccd7bf0172',
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
/** Eight independently archived native anchors; immutable metadata is not acquisition authority. */
export const UMBRELLA_GHO_JOINT_NATIVE_HISTORY_ANCHORS = freeze([
  {
    cashIndex: 112,
    cashRaw: '2144948169881611752509715',
    source: {
      chainId: 1 as const,
      finalized: true as const,
      blockNumber: 26057904,
      blockHash: '0xbb95ecc279a68df05a23fe4537046f3d4c129535059f55399293791370e20fb6',
      blockTime: '2026-09-25T23:59:59.000Z',
    },
  },
  {
    cashIndex: 113,
    cashRaw: '2130734542653665486503032',
    source: {
      chainId: 1 as const,
      finalized: true as const,
      blockNumber: 26065069,
      blockHash: '0xb4e0fe4909fd2d5628301ab0483cb6c7f0dd30ffaa661d8fd888510ff3757998',
      blockTime: '2026-09-26T23:59:59.000Z',
    },
  },
  {
    cashIndex: 114,
    cashRaw: '2130734542653665486503032',
    source: {
      chainId: 1 as const,
      finalized: true as const,
      blockNumber: 26072221,
      blockHash: '0x2680b61b94bf2651ac4603f6d93b5b2815f515f81d4a3077e65103f0fc82dc14',
      blockTime: '2026-09-27T23:59:59.000Z',
    },
  },
  {
    cashIndex: 115,
    cashRaw: '2125936195988173645342283',
    source: {
      chainId: 1 as const,
      finalized: true as const,
      blockNumber: 26079396,
      blockHash: '0x31868801c3f7242338e7f191929032c3fc9387e9ec07ace2c0264f13c7914bae',
      blockTime: '2026-09-28T23:59:59.000Z',
    },
  },
  {
    cashIndex: 116,
    cashRaw: '2113008861083951861266494',
    source: {
      chainId: 1 as const,
      finalized: true as const,
      blockNumber: 26086569,
      blockHash: '0x47f2ef87e05d0a9f6d4f9cc1c47cfa504b8dc94bb1a52a8b8f778a409328c250',
      blockTime: '2026-09-29T23:59:59.000Z',
    },
  },
  {
    cashIndex: 117,
    cashRaw: '2108693158261864399041527',
    source: {
      chainId: 1 as const,
      finalized: true as const,
      blockNumber: 26093737,
      blockHash: '0xcd26204e996dceb606ccf0bc6f5bf8ea6747a471df8be73b5855f01624d5d743',
      blockTime: '2026-09-30T23:59:59.000Z',
    },
  },
  {
    cashIndex: 118,
    cashRaw: '2101663632763250518748084',
    source: {
      chainId: 1 as const,
      finalized: true as const,
      blockNumber: 26100913,
      blockHash: '0x2fe9266ceaaea215d32a4c5e0701f3c287705f2b976844cf3131534a814aa272',
      blockTime: '2026-10-01T23:59:59.000Z',
    },
  },
  {
    cashIndex: 119,
    cashRaw: '2101663632763250518748084',
    source: {
      chainId: 1 as const,
      finalized: true as const,
      blockNumber: 26108081,
      blockHash: '0x9f430d0cc4301a9f8ea0315223c2ed6e66373f6454baac771cac7449d725ba37',
      blockTime: '2026-10-02T23:59:59.000Z',
    },
  },
] as const)
export function resolveUmbrellaGhoJointNativeHistoryAnchor(cashIndex: number) {
  return Number.isSafeInteger(cashIndex)
    ? (UMBRELLA_GHO_JOINT_NATIVE_HISTORY_ANCHORS.find((a) => a.cashIndex === cashIndex) ?? null)
    : null
}
function check(v: unknown): asserts v {
  if (!v) throw Error('umbrella_history_invalid')
}
function uint(v: unknown): bigint {
  check(typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v))
  const n = BigInt(v)
  check(n <= MAX)
  return n
}
function time(v: unknown): number {
  check(typeof v === 'string')
  const n = Date.parse(v)
  check(Number.isSafeInteger(n) && n > 0 && new Date(n).toISOString() === v)
  return n
}
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const ak = Object.keys(a),
    bk = Object.keys(b)
  return (
    Array.isArray(a) === Array.isArray(b) &&
    ak.length === bk.length &&
    ak.every(
      (k) =>
        Object.hasOwn(b, k) &&
        equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  )
}
function keys(v: unknown, names: string[]): void {
  check(v && typeof v === 'object' && !Array.isArray(v))
  const own = Object.keys(v)
  check(own.length === names.length && names.every((k) => Object.hasOwn(v, k)))
}
/** Project header identity before traversing bulky transactions; never invoke caller accessors. */
function snapshot(value: unknown, headers = false): unknown {
  let nodes = 0,
    chars = 0
  const path = new WeakSet<object>()
  const copy = (v: unknown, depth: number): unknown => {
    check(++nodes <= 10000 && depth <= 16)
    if (v === null || typeof v === 'boolean') return v
    if (typeof v === 'number') {
      check(Number.isSafeInteger(v) && v >= 0)
      return v
    }
    if (typeof v === 'string') {
      chars += v.length
      check(v.length <= 65536 && chars <= 262144)
      return v
    }
    check(v && typeof v === 'object' && !path.has(v))
    const proto = Object.getPrototypeOf(v)
    check(
      Array.isArray(v) ? proto === Array.prototype : proto === Object.prototype || proto === null,
    )
    path.add(v)
    const own = Reflect.ownKeys(v)
    check(own.length <= 65)
    if (Array.isArray(v)) check(v.length <= 64 && own.length === v.length + 1)
    const out: unknown[] = [],
      record: Record<string, unknown> = {}
    const traceKey = headers ? Object.getOwnPropertyDescriptor(v, 'key')?.value : null
    for (const k of own) {
      if (Array.isArray(v) && k === 'length') continue
      check(typeof k === 'string' && !['__proto__', 'constructor', 'prototype'].includes(k))
      const d = Object.getOwnPropertyDescriptor(v, k)
      check(d && d.enumerable && Object.hasOwn(d, 'value'))
      let field = d.value
      if ((traceKey === 'headerBefore' || traceKey === 'headerAfter') && k === 'result') {
        field = projectUmbrellaGhoNativeHeader(field)
        check(field !== null)
      }
      if (Array.isArray(v)) {
        check(/^(0|[1-9][0-9]*)$/.test(k))
        out[Number(k)] = copy(field, depth + 1)
      } else record[k] = copy(field, depth + 1)
    }
    path.delete(v)
    return Array.isArray(v) ? out : record
  }
  return copy(value, 0)
}
function nativeSource(s: UmbrellaGhoNativeSource): number {
  keys(s, ['chainId', 'blockNumber', 'blockHash', 'blockTime', 'finalized'])
  check(
    s.chainId === 1 &&
      s.finalized === true &&
      Number.isSafeInteger(s.blockNumber) &&
      s.blockNumber > 0 &&
      /^0x[0-9a-f]{64}$/.test(s.blockHash),
  )
  const at = time(s.blockTime)
  check(at % 1000 === 0)
  return at
}
function binding(value: unknown): UmbrellaGhoJointNativeHistoryBinding {
  const b = snapshot(value) as UmbrellaGhoJointNativeHistoryBinding
  keys(b, [
    'cashIndex',
    'source',
    'currentSource',
    'fullSharesRaw',
    'cooldownSharesRaw',
    'acquiredAtUtc',
  ])
  const a = resolveUmbrellaGhoJointNativeHistoryAnchor(b.cashIndex)
  check(a && equal(b.source, a.source))
  const at = nativeSource(b.source),
    current = nativeSource(b.currentSource)
  check(
    at < current &&
      b.source.blockNumber < b.currentSource.blockNumber &&
      time(b.acquiredAtUtc) >= at &&
      uint(b.fullSharesRaw) > 0n &&
      uint(b.cooldownSharesRaw) < 1n << 192n,
  )
  return b
}
function call(
  key: string,
  to: string,
  name: string,
  args: unknown[],
  s: UmbrellaGhoNativeSource,
): UmbrellaGhoJointNativeHistoryRead {
  return {
    key,
    request: {
      method: 'eth_call',
      params: [
        {
          to,
          data: encodeFunctionData({
            abi: UMBRELLA_GHO_NATIVE_ABI,
            functionName: name,
            args,
          } as never),
        },
        { blockHash: s.blockHash, requireCanonical: true },
      ],
    },
  }
}
function plan(b: UmbrellaGhoJointNativeHistoryBinding): UmbrellaGhoJointNativeHistoryRead[] {
  const s = b.source,
    pin = { blockHash: s.blockHash, requireCanonical: true },
    header = {
      method: 'eth_getBlockByNumber',
      params: ['0x' + BigInt(s.blockNumber).toString(16), false],
    }
  return [
    { key: 'headerBefore', request: header },
    {
      key: 'implementationSlot',
      request: { method: 'eth_getStorageAt', params: [UMBRELLA_STKGHO, SLOT, pin] },
    },
    ...[
      [UMBRELLA_STKGHO, 'proxyCode'],
      [VERIFIED_STKGHO_IMPLEMENTATION, 'implementationCode'],
      [ORIGINAL_GHO, 'assetCode'],
    ].map(([to, key]) => ({
      key,
      request: { method: 'eth_getCode', params: [to, pin] },
    })),
    call('asset', UMBRELLA_STKGHO, 'asset', [], s),
    call('shareDecimals', UMBRELLA_STKGHO, 'decimals', [], s),
    call('assetDecimals', ORIGINAL_GHO, 'decimals', [], s),
    call('fullEaRaw', UMBRELLA_STKGHO, 'previewRedeem', [BigInt(b.fullSharesRaw)], s),
    call('coveredEaRaw', UMBRELLA_STKGHO, 'previewRedeem', [BigInt(b.cooldownSharesRaw)], s),
    call('cashRaw', ORIGINAL_GHO, 'balanceOf', [UMBRELLA_STKGHO], s),
    call('paused', UMBRELLA_STKGHO, 'paused', [], s),
    call('totalAssetsRaw', UMBRELLA_STKGHO, 'totalAssets', [], s),
    call('totalSupplyRaw', UMBRELLA_STKGHO, 'totalSupply', [], s),
    call('cooldownSeconds', UMBRELLA_STKGHO, 'getCooldown', [], s),
    call('unstakeWindowSeconds', UMBRELLA_STKGHO, 'getUnstakeWindow', [], s),
    call('maxSlashableAssetsRaw', UMBRELLA_STKGHO, 'getMaxSlashableAssets', [], s),
    { key: 'headerAfter', request: header },
  ]
}
/** Pure bounded plan only; no client, discovery, caller hooks or native authority registration. */
export function umbrellaGhoJointNativeHistoryReadPlan(
  value: UmbrellaGhoJointNativeHistoryBinding,
): readonly UmbrellaGhoJointNativeHistoryRead[] | null {
  try {
    return freeze(plan(binding(value)))
  } catch {
    return null
  }
}
const NAMES: Record<string, string> = {
  asset: 'asset',
  shareDecimals: 'decimals',
  assetDecimals: 'decimals',
  fullEaRaw: 'previewRedeem',
  coveredEaRaw: 'previewRedeem',
  cashRaw: 'balanceOf',
  paused: 'paused',
  totalAssetsRaw: 'totalAssets',
  totalSupplyRaw: 'totalSupply',
  cooldownSeconds: 'getCooldown',
  unstakeWindowSeconds: 'getUnstakeWindow',
  maxSlashableAssetsRaw: 'getMaxSlashableAssets',
}
function decode(t: UmbrellaGhoJointNativeHistoryTrace): unknown {
  check(
    typeof t.result === 'string' && /^0x(?:[0-9a-f]{2})*$/.test(t.result) && t.result.length <= 194,
  )
  const name = NAMES[t.key]
  check(name)
  const v = decodeFunctionResult({
    abi: UMBRELLA_GHO_NATIVE_ABI,
    functionName: name,
    data: t.result,
  } as never)
  check(
    encodeFunctionResult({
      abi: UMBRELLA_GHO_NATIVE_ABI,
      functionName: name,
      result: v,
    } as never) === t.result,
  )
  if (typeof v === 'bigint') return String(v)
  if (typeof v === 'number') {
    check(Number.isSafeInteger(v) && v >= 0)
    return String(v)
  }
  return typeof v === 'string' ? v.toLowerCase() : v
}
function header(v: unknown, s: UmbrellaGhoNativeSource): void {
  const h = projectUmbrellaGhoNativeHeader(v)
  check(
    h &&
      BigInt(h.number) === BigInt(s.blockNumber) &&
      h.hash === s.blockHash &&
      BigInt(h.timestamp) * 1000n === BigInt(time(s.blockTime)),
  )
}
/** Paired native structural replay only; unsigned traces never grant original acquisition authority. */
export function replayUmbrellaGhoJointNativeHistoryPoint(
  value: unknown,
  suppliedBinding: UmbrellaGhoJointNativeHistoryBinding,
): UmbrellaGhoJointNativeHistoryPoint | null {
  try {
    // Both snapshots complete before any ABI/header/runtime interpretation.
    const b = binding(suppliedBinding),
      wire = snapshot(value, true) as UmbrellaGhoJointNativeHistoryWire
    keys(wire, ['origins'])
    check(Array.isArray(wire.origins) && wire.origins.length === 2)
    const specs = plan(b),
      a = resolveUmbrellaGhoJointNativeHistoryAnchor(b.cashIndex)!
    const results = wire.origins.map((origin, n) => {
      keys(origin, ['host', 'chainIdTrace', 'acquiredAtUtc', 'traces'])
      check(origin.host === HOSTS[n])
      keys(origin.chainIdTrace, ['key', 'request', 'result'])
      check(
        equal(origin.chainIdTrace, {
          key: 'chain',
          request: { method: 'eth_chainId', params: [] },
          result: '0x1',
        }),
      )
      check(Array.isArray(origin.traces) && origin.traces.length === 18)
      const acquired = time(origin.acquiredAtUtc),
        raw: Record<string, unknown> = {},
        clocks: number[] = [],
        code: Record<string, string> = {},
        hashes: Record<string, string> = {}
      origin.traces.forEach((t, i) => {
        keys(t, ['key', 'request', 'result', 'completedAtUtc'])
        check(t.key === specs[i].key && equal(t.request, specs[i].request))
        const completed = time(t.completedAtUtc)
        check(
          completed >= time(b.source.blockTime) &&
            completed <= acquired &&
            (i === 0 || completed >= clocks[i - 1]),
        )
        clocks.push(completed)
        if (t.key === 'headerBefore' || t.key === 'headerAfter') header(t.result, b.source)
        else if (t.key === 'implementationSlot')
          check(t.result === '0x' + '0'.repeat(24) + VERIFIED_STKGHO_IMPLEMENTATION.slice(2))
        else if (['proxyCode', 'implementationCode', 'assetCode'].includes(t.key)) {
          check(typeof t.result === 'string' && /^0x(?:[0-9a-f]{2})+$/.test(t.result))
          const addr = [UMBRELLA_STKGHO, VERIFIED_STKGHO_IMPLEMENTATION, ORIGINAL_GHO][i - 2]
          code[addr] = t.result
          hashes[addr] = keccak256(t.result as never)
          check(hashes[addr] === HASHES[addr])
        } else raw[t.key] = decode(t)
      })
      check(
        Math.max(...clocks) === acquired &&
          raw.asset === ORIGINAL_GHO &&
          raw.shareDecimals === '18' &&
          raw.assetDecimals === '18' &&
          typeof raw.paused === 'boolean' &&
          raw.cashRaw === a.cashRaw,
      )
      for (const k of [
        'fullEaRaw',
        'coveredEaRaw',
        'cashRaw',
        'totalAssetsRaw',
        'totalSupplyRaw',
        'cooldownSeconds',
        'unstakeWindowSeconds',
        'maxSlashableAssetsRaw',
      ])
        uint(raw[k])
      check(
        uint(raw.cooldownSeconds) <= 0xffffffffn && uint(raw.unstakeWindowSeconds) <= 0xffffffffn,
      )
      if (raw.paused) check(raw.maxSlashableAssetsRaw === '0')
      return { raw, code, hashes, acquired }
    })
    check(
      equal(results[0].raw, results[1].raw) &&
        equal(results[0].code, results[1].code) &&
        Math.max(...results.map((r) => r.acquired)) === time(b.acquiredAtUtc),
    )
    const r = results[0].raw
    return freeze<UmbrellaGhoJointNativeHistoryPoint>({
      cashIndex: b.cashIndex,
      source: b.source,
      acquiredAtUtc: b.acquiredAtUtc,
      sharesRaw: b.fullSharesRaw,
      cooldownCoveredSharesRaw: b.cooldownSharesRaw,
      fullEaRaw: r.fullEaRaw as string,
      coveredEaRaw: r.coveredEaRaw as string,
      cashRaw: r.cashRaw as string,
      paused: r.paused as boolean,
      totalAssetsRaw: r.totalAssetsRaw as string,
      totalSupplyRaw: r.totalSupplyRaw as string,
      cooldownSeconds: r.cooldownSeconds as string,
      unstakeWindowSeconds: r.unstakeWindowSeconds as string,
      maxSlashableAssetsRaw: r.maxSlashableAssetsRaw as string,
      runtimeCodeHashes: results[0].hashes,
      owner: null,
      historicalOwnership: false,
      sourceClass: 'captured_identical_runtimes_only',
      MRaw: null,
      originAcquiredAtUtc: results.map((r, i) => ({
        host: HOSTS[i],
        acquiredAtUtc: new Date(r.acquired).toISOString(),
      })),
      authority: {
        originalAuthority: false,
        authenticated: false,
        historicalOwnership: false,
        signingAuthority: false,
        forecastIssued: false,
        executionObserved: false,
        prospectiveValidated: false,
        calibration: false,
        browserAcceptance: false,
        coverageCountPromotion: false,
      },
    })
  } catch {
    return null
  }
}
