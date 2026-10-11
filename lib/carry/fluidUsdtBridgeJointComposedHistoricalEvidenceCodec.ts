import {
  decodeFunctionResult,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  sha256,
  stringToHex,
} from 'viem'
import {
  decodeFluidUsdcBridgeJointNativeHistoryEvidence,
  encodeFluidUsdcBridgeJointNativeHistoryEvidence,
  parseFluidUsdcBridgeJointNativeEvidenceJson,
} from './fluidUsdcBridgeJointNativeEvidenceCodec'
import { FLUID_USDC_BRIDGE_NATIVE_ABI } from './fluidUsdcBridgeNativeAbi'
import { resolveFluidUsdcBridgeJointTrustedProfile } from './fluidUsdcBridgeJointTrustedProfile'
import {
  FLUID_USDT_QUOTE_ABI,
  FLUID_USDT_QUOTE_CONTRACTS,
  FLUID_USDT_QUOTE_HOSTS,
} from './fluidUsdtBridgeNativeQuoteEvidenceCodec'
import type { FluidUsdtBridgeJointFrame } from './fluidUsdtBridgeJointLiveTimeProcess'

const MB = 1024 * 1024
const BRIDGE = '0x273da948aca9261043fbdb2a857bc255ecc29012'
const PROFILE = 'fluid-usdt-bridge-same-pool-quote-funding-v1'
// Observed actual result clock from the retained Oct9 conversion run. This is
// a retention floor, never a retimed source/header/row clock or authority claim.
export const FLUID_USDT_COMPOSED_OLD_RETENTION_FLOOR = '2026-10-09T04:42:24.260Z'
const OLD_S = '967573479322309282'
const C = FLUID_USDT_QUOTE_CONTRACTS
const USDC_PROFILE = resolveFluidUsdcBridgeJointTrustedProfile(
  'USDC → FluidBridgeAggregatorProxy [USDC]',
  BRIDGE,
  C.usdc,
)!
const EXTRA_RUNTIME = {
  [C.factory]: '0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69',
  [C.quoter]: '0x06148f47d0f41a68d3bc970030a7150e5d608cfbc28d372440a2e41ce543d92b',
  [C.pool]: '0x2ff673bacc60a73fc85c678888296c6bce3de2a9d7475c032fe7aa6e0eacba86',
  [C.usdt]: '0xb44fb4e949d0f78f87f79ee46428f23a2a5713ce6fc6e0beb3dda78c2ac1ea55',
}
const RUNTIMES: Readonly<Record<string, string>> = Object.freeze({
  ...USDC_PROFILE.runtimeCodeHashes,
  ...EXTRA_RUNTIME,
})
export const FLUID_USDT_COMPOSED_HISTORY_ANCHORS = Object.freeze(
  USDC_PROFILE.anchors.filter((a) => a.cashIndex >= 111 && a.cashIndex <= 118),
)
export const FLUID_USDT_COMPOSED_HISTORY_LIMITS = Object.freeze({
  originalFileBytes: 8 * MB,
  totalOriginalBytes: 32 * MB,
  isolatedOriginalUtf16Bytes: 16 * MB,
  dynamicJsonBytes: 8 * MB,
  reducedSnapshotUtf16Bytes: 32 * MB,
  responseBytes: 65536,
  requestBytes: 2048,
  physicalStarts: 84,
})
/* Fixed paths are server load instructions only. Callers cannot select another file.
 * Literal FILE pins preserve every original byte, including old clocks and old S. */
export const FLUID_USDT_COMPOSED_HISTORY_ORIGINAL_FILES = Object.freeze(
  [
    {
      id: 'usdc_111_114',
      path: 'data/research/venue-signals/fluid-usdc-bridge-joint-history-evidence-2026-10-08/expanded-originals/28-native-historical-capture.json',
      fileSha256: 'acf5bf100a49b45134b480837ce00966bcf026a30b7e0ad6198e95bdcd2e9b81',
      bytes: 5327049,
    },
    {
      id: 'usdc_115_118',
      path: 'data/research/venue-signals/fluid-usdc-bridge-joint-history-evidence-2026-10-08/originals/20-native-historical-capture.json',
      fileSha256: 'd24fc380e4fcbefa98136b6975f7c694387a601fd01b586035a99b8d92a1729b',
      bytes: 5412273,
    },
    {
      id: 'quote_receipt_0',
      path: 'data/research/venue-signals/fluid-usdt-native-conversion-extension-2026-10-09T04-41-15.376Z-c422e99c-0485-4706-90a0-975df770ffee/batch-0-original-receipt.json',
      fileSha256: '7530ed42f19931f2800bd74800e27745b37e03b540fd1d8604828742193fce97',
      bytes: 1527078,
    },
    {
      id: 'quote_receipt_1',
      path: 'data/research/venue-signals/fluid-usdt-native-conversion-extension-2026-10-09T04-41-15.376Z-c422e99c-0485-4706-90a0-975df770ffee/batch-1-original-receipt.json',
      fileSha256: '64f9f55b76d1811e29b70515fbb3c11337aeb6b6600670de744f5fda5bf28f12',
      bytes: 1462667,
    },
    {
      id: 'quote_receipt_2',
      path: 'data/research/venue-signals/fluid-usdt-native-conversion-extension-2026-10-09T04-41-15.376Z-c422e99c-0485-4706-90a0-975df770ffee/batch-2-original-receipt.json',
      fileSha256: 'f35b94c436e031ee700debd8e0c90e2d98c03d28dc916762f5bc9a6cd92d02f9',
      bytes: 1061201,
    },
    {
      id: 'quote_settlements_0',
      path: 'data/research/venue-signals/fluid-usdt-native-conversion-extension-2026-10-09T04-41-15.376Z-c422e99c-0485-4706-90a0-975df770ffee/batch-0-original-settlements.json',
      fileSha256: 'b53734f8383d1ea43e43f7856766c50e78506d476fc40c9bf885b5eedf37aab0',
      bytes: 1536657,
    },
    {
      id: 'quote_settlements_1',
      path: 'data/research/venue-signals/fluid-usdt-native-conversion-extension-2026-10-09T04-41-15.376Z-c422e99c-0485-4706-90a0-975df770ffee/batch-1-original-settlements.json',
      fileSha256: 'd8d7cd73001d7f445d107feb272c71e7a4134121b32fe1863f44d02dcfc2ea5a',
      bytes: 1472246,
    },
    {
      id: 'quote_settlements_2',
      path: 'data/research/venue-signals/fluid-usdt-native-conversion-extension-2026-10-09T04-41-15.376Z-c422e99c-0485-4706-90a0-975df770ffee/batch-2-original-settlements.json',
      fileSha256: '2eefe35057adf78a029d1a4c3450d994ca43dae8b38615bf68bd3294d61401b8',
      bytes: 1067578,
    },
    {
      id: 'quote_point_111',
      path: 'data/research/venue-signals/fluid-usdt-native-conversion-extension-2026-10-09T04-41-15.376Z-c422e99c-0485-4706-90a0-975df770ffee/point-26050748-wire.json',
      fileSha256: '04978577e7107e234ece618a1a9d47e3159bd0ab4122f2ec309a6d7734cc058d',
      bytes: 407019,
    },
    {
      id: 'quote_point_112',
      path: 'data/research/venue-signals/fluid-usdt-native-conversion-extension-2026-10-09T04-41-15.376Z-c422e99c-0485-4706-90a0-975df770ffee/point-26057904-wire.json',
      fileSha256: 'e5d86f8c502e61b8d9aed81b12125735e1de8f62da4510e97bdbb774863f56b8',
      bytes: 379157,
    },
    {
      id: 'quote_point_113',
      path: 'data/research/venue-signals/fluid-usdt-native-conversion-extension-2026-10-09T04-41-15.376Z-c422e99c-0485-4706-90a0-975df770ffee/point-26065069-wire.json',
      fileSha256: '35c2144b3c89b58f138a8d42045b0c6c804c54170cb15f8ef4443f7515fe2a10',
      bytes: 355455,
    },
    {
      id: 'quote_point_114',
      path: 'data/research/venue-signals/fluid-usdt-native-conversion-extension-2026-10-09T04-41-15.376Z-c422e99c-0485-4706-90a0-975df770ffee/point-26072221-wire.json',
      fileSha256: 'c067457309175dcdb06f31fa96922caaaa2adea99b68bbc2d3529f65b2fa9c96',
      bytes: 366723,
    },
    {
      id: 'quote_point_115',
      path: 'data/research/venue-signals/fluid-usdt-native-conversion-extension-2026-10-09T04-41-15.376Z-c422e99c-0485-4706-90a0-975df770ffee/point-26079396-wire.json',
      fileSha256: 'ffd80de4c4c8d4dbf12281d50de49a6d99f39c65e0f02f3132261e62f1eda798',
      bytes: 360337,
    },
    {
      id: 'quote_point_116',
      path: 'data/research/venue-signals/fluid-usdt-native-conversion-extension-2026-10-09T04-41-15.376Z-c422e99c-0485-4706-90a0-975df770ffee/point-26086569-wire.json',
      fileSha256: '98007f6f622e39a7095d6ec0b1327a8bfa4d753654f2a8d4c8cf293ab0745ccd',
      bytes: 366091,
    },
    {
      id: 'quote_point_117',
      path: 'data/research/venue-signals/fluid-usdt-native-conversion-extension-2026-10-09T04-41-15.376Z-c422e99c-0485-4706-90a0-975df770ffee/point-26093737-wire.json',
      fileSha256: '82ab33c8bc25c5816a182cc8dde9865f839cc314bf5cd81534379c2a6cd603df',
      bytes: 375291,
    },
    {
      id: 'quote_point_118',
      path: 'data/research/venue-signals/fluid-usdt-native-conversion-extension-2026-10-09T04-41-15.376Z-c422e99c-0485-4706-90a0-975df770ffee/point-26100913-wire.json',
      fileSha256: 'cc3f7f65e562d48eb9a27226904aa280e70729e13f0ec94d6fced646fc0694d7',
      bytes: 417689,
    },
  ].map((d) => Object.freeze(d)),
)
export type FluidUsdtComposedHistoricalContext = Readonly<{
  sharesRaw: string
  requestedFinalUsdtRaw: string
  currentSource: {
    chainId: 1
    blockNumber: number
    blockHash: string
    blockTime: string
    finalized: true
  }
  profileId: typeof PROFILE
  runtimeCodeHashes: Readonly<Record<string, string>>
  owner: null
  historicalOwnership: false
}>
export type FluidUsdtComposedHistoricalRequest = Readonly<{
  key: string
  request: { method: string; params: readonly unknown[] }
}>
export type FluidUsdtComposedHistoricalRequestOriginal = Readonly<{
  host: string
  cashIndex: number | null
  key: string
  rpcId: number
  requestBodyBase64: string
  requestBodySha256: string
}>
export type FluidUsdtComposedHistoricalBatch = Readonly<{
  controlNamespace: string
  receipt: unknown
  requests: readonly FluidUsdtComposedHistoricalRequestOriginal[]
  settlements: unknown
  availableAtUtc: string
}>
export type FluidUsdtComposedHistoricalPreparedOriginals = Readonly<{
  schema: 'fluid_usdt_composed_unsigned_preparation_v1'
  originalAuthority: false
  authenticated: false
}>
export type FluidUsdtComposedHistoricalRawEvidence = Readonly<{
  schema: 'fluid_usdt_composed_history_raw_v1'
  preparedOriginals: FluidUsdtComposedHistoricalPreparedOriginals
  batches: readonly FluidUsdtComposedHistoricalBatch[]
  seriesAvailableAtUtc: string
}>
export type FluidUsdtComposedHistoricalEvidence = Readonly<{
  schema: 'fluid_usdt_joint_composed_history_evidence_v1'
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
  MRaw: null
}>
type Obj = Record<string, any>
type Row = Obj
type OldPoint = {
  cashIndex: number
  source: FluidUsdtBridgeJointFrame['source']
  nativeProngs: FluidUsdtBridgeJointFrame['nativeProngs']
  withdrawalFeeBps: number
  paused: boolean
  acquiredAtUtc: string
  availableAtUtc: string
}
type Preparation = {
  profileId: string
  runtimeCodeHashes: Readonly<Record<string, string>>
  points: readonly OldPoint[]
  acquiredAtUtc: string
  availableAtUtc: string
}
const prepared = new WeakMap<object, Preparation>()
const MAX = (1n << 256n) - 1n
function check(v: unknown): asserts v {
  if (!v) throw Error('fluid_usdt_composed_history_invalid')
}
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const digest = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const hex = (v: unknown): v is '0x' => typeof v === 'string' && /^0x(?:[0-9a-f]{2})*$/.test(v)
const qty = (v: unknown): v is string =>
  typeof v === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(v) && BigInt(v) <= MAX
const bytes = (v: string) => new TextEncoder().encode(v).length
const hashText = (v: string) => sha256(stringToHex(v)).slice(2)
const equal = (a: any, b: any): boolean => {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => equal(v, b[i]))
    )
  return (
    !!a &&
    !!b &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
  )
}
function exact(v: any, keys: string[]) {
  check(
    v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      Object.keys(v).sort().join('|') === [...keys].sort().join('|'),
  )
}
function own(v: unknown): Obj {
  check(
    v &&
      typeof v === 'object' &&
      Object.getPrototypeOf(v) === Object.prototype &&
      Object.getOwnPropertySymbols(v).length === 0,
  )
  const descriptors = Object.getOwnPropertyDescriptors(v)
  check(Object.values(descriptors).every((d) => d.enumerable && Object.hasOwn(d, 'value')))
  return Object.fromEntries(Object.entries(descriptors).map(([k, d]) => [k, d.value]))
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
function snapshot(v: unknown, cap: number): any {
  let count = 0,
    size = 0
  const ancestry = new Set<object>()
  const copy = (x: any, depth: number): any => {
    check(++count <= 100000 && depth <= 32)
    if (typeof x === 'string') {
      size += x.length * 2
      check(size <= cap)
      return x
    }
    if (x === null || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x)))
      return x
    check(
      x &&
        typeof x === 'object' &&
        !ancestry.has(x) &&
        Object.getOwnPropertySymbols(x).length === 0,
    )
    check(Object.getPrototypeOf(x) === (Array.isArray(x) ? Array.prototype : Object.prototype))
    ancestry.add(x)
    try {
      const ds = Object.getOwnPropertyDescriptors(x)
      if (Array.isArray(x)) {
        check(x.length <= 2048 && Object.keys(ds).length === x.length + 1)
        return Array.from({ length: x.length }, (_, i) => {
          const d = ds[String(i)]
          check(d && d.enumerable && Object.hasOwn(d, 'value'))
          return copy(d.value, depth + 1)
        })
      }
      const out: Obj = {}
      for (const [k, d] of Object.entries(ds)) {
        check(
          d.enumerable &&
            Object.hasOwn(d, 'value') &&
            !['__proto__', 'constructor', 'prototype'].includes(k),
        )
        size += k.length * 2
        check(size <= cap)
        out[k] = copy(d.value, depth + 1)
      }
      return out
    } finally {
      ancestry.delete(x)
    }
  }
  return copy(v, 0)
}
const parse = (text: string, cap: number): any =>
  parseFluidUsdcBridgeJointNativeEvidenceJson(text, cap)
function unbase64(text: unknown, cap: number): string {
  check(
    typeof text === 'string' &&
      text.length <= Math.ceil(cap / 3) * 4 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text),
  )
  const binary = atob(text as string)
  check(binary.length <= cap && btoa(binary) === text)
  return new TextDecoder('utf-8', { fatal: true }).decode(
    Uint8Array.from(binary, (c) => c.charCodeAt(0)),
  )
}
const maxUtc = (times: string[]): string =>
  new Date(
    Math.max(
      ...times.map((t) => {
        check(utc(t))
        return Date.parse(t)
      }),
    ),
  ).toISOString()
function context(input: unknown): FluidUsdtComposedHistoricalContext {
  const v = snapshot(input, 32768)
  exact(v, [
    'sharesRaw',
    'requestedFinalUsdtRaw',
    'currentSource',
    'profileId',
    'runtimeCodeHashes',
    'owner',
    'historicalOwnership',
  ])
  check(
    raw(v.sharesRaw) &&
      BigInt(v.sharesRaw) > 0n &&
      raw(v.requestedFinalUsdtRaw) &&
      BigInt(v.requestedFinalUsdtRaw) > 0n &&
      v.profileId === PROFILE &&
      equal(v.runtimeCodeHashes, RUNTIMES) &&
      v.owner === null &&
      v.historicalOwnership === false,
  )
  exact(v.currentSource, ['chainId', 'blockNumber', 'blockHash', 'blockTime', 'finalized'])
  check(
    v.currentSource.chainId === 1 &&
      Number.isSafeInteger(v.currentSource.blockNumber) &&
      v.currentSource.blockNumber > FLUID_USDT_COMPOSED_HISTORY_ANCHORS[7].source.blockNumber &&
      /^0x[0-9a-f]{64}$/.test(v.currentSource.blockHash) &&
      utc(v.currentSource.blockTime) &&
      Date.parse(v.currentSource.blockTime) >
        Date.parse(FLUID_USDT_COMPOSED_HISTORY_ANCHORS[7].source.blockTime) &&
      v.currentSource.finalized === true,
  )
  return freeze(v)
}
export function createFluidUsdtComposedHistoricalContext(
  input: unknown,
): FluidUsdtComposedHistoricalContext | null {
  try {
    return context(input)
  } catch {
    return null
  }
}
const anchor = (i: number) => {
  const a = FLUID_USDT_COMPOSED_HISTORY_ANCHORS.find((a) => a.cashIndex === i)
  check(a)
  return a!
}
const headerSpec = (key: string, i: number): FluidUsdtComposedHistoricalRequest => ({
  key,
  request: {
    method: 'eth_getBlockByNumber',
    params: ['0x' + anchor(i).source.blockNumber.toString(16), false],
  },
})
function nativeCall(
  key: string,
  i: number,
  to: string,
  abi: any,
  name: string,
  args: readonly unknown[] = [],
): FluidUsdtComposedHistoricalRequest {
  return {
    key,
    request: {
      method: 'eth_call',
      params: [
        { to, data: encodeFunctionData({ abi, functionName: name, args } as any) },
        { blockHash: anchor(i).source.blockHash, requireCanonical: true },
      ],
    },
  }
}
export function fluidUsdtComposedHistoricalReadPlan(
  input: unknown,
  cashIndex: number,
  R?: string,
): readonly FluidUsdtComposedHistoricalRequest[] {
  const c = context(input)
  anchor(cashIndex)
  const plans = [
    headerSpec('header_before', cashIndex),
    nativeCall('full_net_ea', cashIndex, BRIDGE, FLUID_USDC_BRIDGE_NATIVE_ABI, 'previewRedeem', [
      BigInt(c.sharesRaw),
    ]),
    nativeCall(
      'required_usdc',
      cashIndex,
      C.quoter,
      FLUID_USDT_QUOTE_ABI,
      'quoteExactOutputSingle',
      [
        {
          tokenIn: C.usdc,
          tokenOut: C.usdt,
          amount: BigInt(c.requestedFinalUsdtRaw),
          fee: 100,
          sqrtPriceLimitX96: 0n,
        },
      ],
    ),
  ]
  if (R !== undefined) {
    check(raw(R) && BigInt(R) > 0n)
    plans.push(
      nativeCall(
        'roundtrip_usdt',
        cashIndex,
        C.quoter,
        FLUID_USDT_QUOTE_ABI,
        'quoteExactInputSingle',
        [
          {
            tokenIn: C.usdc,
            tokenOut: C.usdt,
            amountIn: BigInt(R),
            fee: 100,
            sqrtPriceLimitX96: 0n,
          },
        ],
      ),
      headerSpec('header_after', cashIndex),
    )
  }
  return freeze(plans)
}
function decode(abi: any, name: string, result: any): any {
  check(hex(result))
  const v = decodeFunctionResult({ abi, functionName: name, data: result } as any)
  check(
    encodeFunctionResult({ abi, functionName: name, result: v } as any).toLowerCase() === result,
  )
  return v
}
function validateHeader(result: any, i: number) {
  const s = anchor(i).source
  check(
    result &&
      typeof result === 'object' &&
      qty(result.number) &&
      BigInt(result.number) === BigInt(s.blockNumber) &&
      result.hash === s.blockHash &&
      qty(result.timestamp) &&
      Number(BigInt(result.timestamp)) * 1000 === Date.parse(s.blockTime),
  )
}
/** Validates unmodified default-controller receipts. Its seals use JSON.stringify,
 * unlike canonical serializers used by other collectors. No resealing occurs here. */
function validateReceipt(
  receipt: any,
  settlements: any,
  count: number,
  chainStage = 'chain',
): Map<number, { row: Row; response: any }> {
  exact(receipt, [
    'startedAtUtc',
    'availableAtUtc',
    'elapsedMs',
    'physicalStarts',
    'pendingSettlements',
    'failure',
    'ledger',
    'terminalCommitments',
  ])
  check(
    utc(receipt.startedAtUtc) &&
      utc(receipt.availableAtUtc) &&
      Math.abs(
        Date.parse(receipt.availableAtUtc) -
          Date.parse(receipt.startedAtUtc) -
          Math.floor(receipt.elapsedMs),
      ) <= 1 &&
      Date.parse(receipt.availableAtUtc) >= Date.parse(receipt.startedAtUtc) &&
      Number.isFinite(receipt.elapsedMs) &&
      receipt.elapsedMs >= 0 &&
      receipt.elapsedMs <= 120000 &&
      receipt.physicalStarts === count &&
      receipt.pendingSettlements === 0 &&
      receipt.failure === null &&
      Array.isArray(receipt.ledger) &&
      receipt.ledger.length === count &&
      Array.isArray(receipt.terminalCommitments) &&
      receipt.terminalCommitments.length === count &&
      Array.isArray(settlements) &&
      settlements.length === count,
  )
  const rows = new Map<number, { row: Row; response: any }>(),
    commitments = new Map<number, string>(),
    seals = new Map<number, any>()
  for (const commitment of receipt.terminalCommitments) {
    exact(commitment, ['physicalId', 'rowSha256'])
    check(
      Number.isSafeInteger(commitment.physicalId) &&
        digest(commitment.rowSha256) &&
        !commitments.has(commitment.physicalId),
    )
    commitments.set(commitment.physicalId, commitment.rowSha256)
  }
  for (const s of settlements) {
    exact(s, ['schema', 'physicalId', 'captureAcceptance', 'observation', 'sha256'])
    const { sha256: seal, ...body } = s
    check(
      s.schema === 'usd3_hypothetical_physical_settlement_v1' &&
        s.captureAcceptance === false &&
        digest(seal) &&
        hashText(JSON.stringify(body)) === seal &&
        !seals.has(s.physicalId),
    )
    seals.set(s.physicalId, s.observation)
  }
  for (const row of receipt.ledger) {
    exact(row, [
      'physicalId',
      'host',
      'stage',
      'request',
      'startedAtUtc',
      'startedElapsedMs',
      'completedAtUtc',
      'completedElapsedMs',
      'status',
      'httpStatus',
      'bodyBytes',
      'bodySha256',
      'rawBodyBase64',
      'safeCode',
      'accepted',
    ])
    check(
      Number.isSafeInteger(row.physicalId) &&
        row.physicalId >= 1 &&
        row.physicalId <= 138 &&
        !rows.has(row.physicalId) &&
        FLUID_USDT_QUOTE_HOSTS.includes(row.host) &&
        typeof row.stage === 'string' &&
        row.stage.length <= 128 &&
        utc(row.startedAtUtc) &&
        utc(row.completedAtUtc) &&
        Date.parse(row.startedAtUtc) >= Date.parse(receipt.startedAtUtc) &&
        Date.parse(row.completedAtUtc) >= Date.parse(row.startedAtUtc) &&
        Date.parse(row.completedAtUtc) <= Date.parse(receipt.availableAtUtc) &&
        Number.isFinite(row.startedElapsedMs) &&
        Number.isFinite(row.completedElapsedMs) &&
        row.startedElapsedMs >= 0 &&
        row.completedElapsedMs >= row.startedElapsedMs &&
        row.completedElapsedMs - row.startedElapsedMs <= 8000 &&
        row.completedElapsedMs <= receipt.elapsedMs &&
        row.status === 'success' &&
        row.httpStatus === 200 &&
        row.safeCode === null &&
        row.accepted === true &&
        digest(row.bodySha256),
    )
    check(
      Math.abs(
        Date.parse(row.startedAtUtc) -
          Date.parse(receipt.startedAtUtc) -
          Math.floor(row.startedElapsedMs),
      ) <= 1 &&
        Math.abs(
          Date.parse(row.completedAtUtc) -
            Date.parse(receipt.startedAtUtc) -
            Math.floor(row.completedElapsedMs),
        ) <= 1,
    )
    check(
      commitments.get(row.physicalId) === hashText(JSON.stringify(row)) &&
        equal(seals.get(row.physicalId), row),
    )
    exact(row.request, ['jsonrpc', 'id', 'method', 'params'])
    check(
      row.request.jsonrpc === '2.0' &&
        Number.isSafeInteger(row.request.id) &&
        row.request.id >= 0 &&
        Array.isArray(row.request.params),
    )
    const responseText = unbase64(row.rawBodyBase64, 65536)
    check(bytes(responseText) === row.bodyBytes && hashText(responseText) === row.bodySha256)
    const response = parse(responseText, 65536)
    exact(response, ['jsonrpc', 'id', 'result'])
    check(response.jsonrpc === '2.0' && response.id === row.request.id)
    rows.set(row.physicalId, { row, response })
  }
  for (const host of FLUID_USDT_QUOTE_HOSTS) {
    const list = [...rows.values()]
      .map((v) => v.row)
      .filter((r) => r.host === host)
      .sort((a, b) => a.startedElapsedMs - b.startedElapsedMs)
    check(
      list.length === count / 2 &&
        list.every(
          (r, i) =>
            i === 0 ||
            (r.startedElapsedMs >= list[i - 1].completedElapsedMs &&
              r.startedElapsedMs - list[i - 1].startedElapsedMs >= 250 &&
              Date.parse(r.startedAtUtc) >= Date.parse(list[i - 1].completedAtUtc)),
        ),
    )
    const first = list[0]
    check(
      first.stage === chainStage &&
        equal(
          { method: first.request.method, params: first.request.params },
          { method: 'eth_chainId', params: [] },
        ) &&
        rows.get(first.physicalId)!.response.result === '0x1',
    )
  }
  for (const stage of new Set([...rows.values()].map((v) => v.row.stage))) {
    const group = [...rows.values()].map((v) => v.row).filter((r) => r.stage === stage)
    check(
      Math.max(...group.map((r) => r.completedElapsedMs)) -
        Math.min(...group.map((r) => r.startedElapsedMs)) <=
        12000,
    )
  }
  return rows
}
const OLD_KEYS = [
  'header_before',
  'code_factory',
  'code_quoter',
  'code_pool',
  'code_usdc',
  'code_usdt',
  'factory_pool',
  'token0',
  'token1',
  'pool_fee',
  'pool_factory',
  'usdc_decimals',
  'usdt_decimals',
  'pool_liquidity',
  'full_ea_usdt',
  'clipped_capacity_usdt',
  'required_usdc_for_research_q',
  'header_after',
]
function oldIdentitySpec(i: number, key: string): FluidUsdtComposedHistoricalRequest | null {
  if (key === 'header_before' || key === 'header_after') return headerSpec(key, i)
  const codes: Record<string, string> = {
    code_factory: C.factory,
    code_quoter: C.quoter,
    code_pool: C.pool,
    code_usdc: C.usdc,
    code_usdt: C.usdt,
  }
  if (codes[key])
    return {
      key,
      request: {
        method: 'eth_getCode',
        params: [codes[key], { blockHash: anchor(i).source.blockHash, requireCanonical: true }],
      },
    }
  const calls: Record<string, [string, string, readonly unknown[]]> = {
    factory_pool: [C.factory, 'getPool', [C.usdc, C.usdt, 100]],
    token0: [C.pool, 'token0', []],
    token1: [C.pool, 'token1', []],
    pool_fee: [C.pool, 'fee', []],
    pool_factory: [C.pool, 'factory', []],
    usdc_decimals: [C.usdc, 'decimals', []],
    usdt_decimals: [C.usdt, 'decimals', []],
  }
  return calls[key]
    ? nativeCall(key, i, calls[key][0], FLUID_USDT_QUOTE_ABI, calls[key][1], calls[key][2])
    : null
}
function oldIdentityResult(i: number, key: string, result: any) {
  if (key === 'header_before' || key === 'header_after') {
    validateHeader(result, i)
    return
  }
  if (key.startsWith('code_')) {
    const addr = (
      {
        code_factory: C.factory,
        code_quoter: C.quoter,
        code_pool: C.pool,
        code_usdc: C.usdc,
        code_usdt: C.usdt,
      } as Record<string, string>
    )[key]
    check(hex(result) && result !== '0x' && keccak256(result) === RUNTIMES[addr])
    return
  }
  const fns: Record<string, string> = {
    factory_pool: 'getPool',
    token0: 'token0',
    token1: 'token1',
    pool_fee: 'fee',
    pool_factory: 'factory',
    usdc_decimals: 'decimals',
    usdt_decimals: 'decimals',
  }
  const expected: Record<string, any> = {
    factory_pool: C.pool,
    token0: C.usdc,
    token1: C.usdt,
    pool_fee: 100,
    pool_factory: C.factory,
    usdc_decimals: 6,
    usdt_decimals: 6,
  }
  const d = decode(FLUID_USDT_QUOTE_ABI, fns[key], result)
  check(typeof d === 'string' ? d.toLowerCase() === expected[key] : d === expected[key])
}
/** Staged literal admission avoids copying 21,894,511 UTF8 original bytes into a
 * falsely claimed 32MiB UTF16 transport. The handle is unsigned and not serializable. */
export function prepareFluidUsdtComposedHistoricalOriginals(
  input: unknown,
  inputContext: unknown,
): FluidUsdtComposedHistoricalPreparedOriginals | null {
  try {
    const c = context(inputContext)
    check(
      Array.isArray(input) &&
        Object.getPrototypeOf(input) === Array.prototype &&
        Object.getOwnPropertySymbols(input).length === 0 &&
        input.length === 16,
    )
    const ads = Object.getOwnPropertyDescriptors(input)
    check(Object.keys(ads).length === 17)
    const supplied = new Map<string, string>()
    let total = 0
    for (let n = 0; n < 16; n++) {
      const d = ads[String(n)]
      check(d && d.enumerable && Object.hasOwn(d, 'value'))
      const v = own(d.value)
      exact(v, ['descriptorId', 'rawText'])
      check(
        typeof v.descriptorId === 'string' &&
          typeof v.rawText === 'string' &&
          !supplied.has(v.descriptorId),
      )
      const pin = FLUID_USDT_COMPOSED_HISTORY_ORIGINAL_FILES.find((p) => p.id === v.descriptorId)
      check(pin)
      check(v.rawText.length * 2 <= 16 * MB)
      const size = bytes(v.rawText)
      total += size
      check(
        size <= 8 * MB &&
          total <= 32 * MB &&
          size === pin!.bytes &&
          hashText(v.rawText) === pin!.fileSha256,
      )
      supplied.set(v.descriptorId, v.rawText)
    }
    check(total === 21894511)
    const get = (id: string) => {
      const text = supplied.get(id)
      check(text !== undefined)
      return parse(text!, 8 * MB)
    }
    // Reverse acquisition order is real. Decode each old native capture independently.
    const frames = ['usdc_111_114', 'usdc_115_118']
      .flatMap((id) => {
        const decoded = decodeFluidUsdcBridgeJointNativeHistoryEvidence(
          encodeFluidUsdcBridgeJointNativeHistoryEvidence(get(id)),
        )
        check(
          decoded &&
            decoded.frames.length === 4 &&
            decoded.frames.every(
              (f) =>
                f.holderSharesRaw === OLD_S &&
                equal(f.runtimeCodeHashes, USDC_PROFILE.runtimeCodeHashes) &&
                f.withdrawalFeeBps === 5 &&
                f.paused === false,
            ),
        )
        return decoded!.frames
      })
      .sort((a, b) => Date.parse(a.source.blockTime) - Date.parse(b.source.blockTime))
    check(frames.length === 8)
    const oldRows = [0, 1, 2].map((i) => {
      const receipt = get('quote_receipt_' + i)
      return {
        receipt,
        rows: validateReceipt(receipt, get('quote_settlements_' + i), i === 2 ? 74 : 110),
      }
    })
    const used = oldRows.map(() => new Set<number>())
    const points: OldPoint[] = FLUID_USDT_COMPOSED_HISTORY_ANCHORS.map((a, n) => {
      const f = frames[n]
      check(
        equal(f.source, {
          chainId: 1,
          blockNumber: String(a.source.blockNumber),
          blockHash: a.source.blockHash,
          blockTime: a.source.blockTime,
        }),
      )
      const wire = get('quote_point_' + a.cashIndex),
        batch = Math.floor(n / 3),
        store = oldRows[batch]
      check(Array.isArray(wire) && wire.length === 2)
      const identityResults: any[] = []
      for (let h = 0; h < 2; h++) {
        const o = wire[h]
        exact(o, ['host', 'traces'])
        check(
          o.host === FLUID_USDT_QUOTE_HOSTS[h] && Array.isArray(o.traces) && o.traces.length === 18,
        )
        const identity: Obj = {}
        for (let k = 0; k < 18; k++) {
          const t = o.traces[k]
          exact(t, [
            'key',
            'request',
            'envelope',
            'physicalId',
            'requestBodySha256',
            'responseBodySha256',
            'startedAtUtc',
            'completedAtUtc',
          ])
          check(t.key === OLD_KEYS[k] && !used[batch].has(t.physicalId))
          used[batch].add(t.physicalId)
          const native = store.rows.get(t.physicalId)
          check(native)
          const row = native!.row
          check(
            row.host === o.host &&
              equal(t.request, { method: row.request.method, params: row.request.params }) &&
              equal(t.envelope, native!.response) &&
              t.startedAtUtc === row.startedAtUtc &&
              t.completedAtUtc === row.completedAtUtc &&
              t.responseBodySha256 === row.bodySha256 &&
              t.requestBodySha256 === hashText(JSON.stringify(row.request)),
          )
          const spec = oldIdentitySpec(a.cashIndex, t.key)
          if (spec) {
            check(equal(t.request, spec.request))
            oldIdentityResult(a.cashIndex, t.key, native!.response.result)
            identity[t.key] = t.key.startsWith('header_')
              ? {
                  number: native!.response.result.number,
                  hash: native!.response.result.hash,
                  timestamp: native!.response.result.timestamp,
                }
              : native!.response.result
          }
        }
        identityResults.push(identity)
      }
      check(equal(identityResults[0], identityResults[1]))
      const acquiredAtUtc = maxUtc([f.acquiredAtUtc, store.receipt.availableAtUtc])
      return {
        cashIndex: a.cashIndex,
        source: { ...f.source },
        nativeProngs: { ...f.nativeProngs },
        withdrawalFeeBps: 5,
        paused: false,
        acquiredAtUtc,
        availableAtUtc: maxUtc([f.availableAtUtc, store.receipt.availableAtUtc]),
      }
    })
    check(used.every((u, i) => u.size === (i === 2 ? 72 : 108)))
    const reduced = freeze({
      profileId: c.profileId,
      runtimeCodeHashes: { ...c.runtimeCodeHashes },
      points,
      acquiredAtUtc: maxUtc(points.map((p) => p.acquiredAtUtc)),
      availableAtUtc: maxUtc([
        FLUID_USDT_COMPOSED_OLD_RETENTION_FLOOR,
        ...points.map((p) => p.availableAtUtc),
      ]),
    })
    const handle = freeze({
      schema: 'fluid_usdt_composed_unsigned_preparation_v1' as const,
      originalAuthority: false as const,
      authenticated: false as const,
    })
    prepared.set(handle, reduced)
    return handle
  } catch {
    return null
  }
}
/** Pure structural replay never grants original capture or execution authority. */
export function replayFluidUsdtComposedHistoricalEvidence(
  input: unknown,
  inputContext: unknown,
): FluidUsdtComposedHistoricalEvidence | null {
  try {
    const c = context(inputContext),
      top = own(input)
    exact(top, ['schema', 'preparedOriginals', 'batches', 'seriesAvailableAtUtc'])
    check(top.schema === 'fluid_usdt_composed_history_raw_v1')
    const old = prepared.get(top.preparedOriginals)
    check(old && old.profileId === c.profileId && equal(old.runtimeCodeHashes, c.runtimeCodeHashes))
    check(
      typeof top.seriesAvailableAtUtc === 'string' &&
        top.seriesAvailableAtUtc.length <= 32 &&
        utc(top.seriesAvailableAtUtc) &&
        Date.parse(top.seriesAvailableAtUtc) >= Date.parse(old!.availableAtUtc),
    )
    const seriesAvailableAtUtc = top.seriesAvailableAtUtc as string
    const batches = snapshot(top.batches, 32 * MB)
    check(
      Array.isArray(batches) && batches.length === 2 && bytes(JSON.stringify(batches)) <= 8 * MB,
    )
    let firstBatchStart = 0,
      previousBatchAvailable = 0
    const namespace = new Set<string>(),
      points: FluidUsdtBridgeJointFrame[] = [],
      allAcquired = [old!.acquiredAtUtc],
      allAvailable = [old!.availableAtUtc]
    for (let b = 0; b < 2; b++) {
      const batch = batches[b]
      exact(batch, ['controlNamespace', 'receipt', 'requests', 'settlements', 'availableAtUtc'])
      check(
        typeof batch.controlNamespace === 'string' &&
          /^[a-zA-Z0-9_-]{1,128}$/.test(batch.controlNamespace) &&
          !namespace.has(batch.controlNamespace) &&
          utc(batch.availableAtUtc),
      )
      namespace.add(batch.controlNamespace)
      const rows = validateReceipt(batch.receipt, batch.settlements, 42, 'usdt_history_chain')
      const start = Date.parse(batch.receipt.startedAtUtc),
        available = Date.parse(batch.availableAtUtc)
      if (b === 0) firstBatchStart = start
      check(
        start >= Date.parse(old!.availableAtUtc) &&
          start >= previousBatchAvailable &&
          available - firstBatchStart <= 120000 &&
          Date.parse(seriesAvailableAtUtc) >= available &&
          Date.parse(seriesAvailableAtUtc) - firstBatchStart <= 120000,
      )
      previousBatchAvailable = available
      check(
        Date.parse(batch.availableAtUtc) >= Date.parse(old!.availableAtUtc) &&
          Date.parse(batch.availableAtUtc) >= Date.parse(batch.receipt.availableAtUtc) &&
          Array.isArray(batch.requests) &&
          batch.requests.length === 42,
      )
      const requests = new Map<string, { row: Row; response: any }>(),
        used = new Set<number>()
      for (const r of batch.requests) {
        exact(r, ['host', 'cashIndex', 'key', 'rpcId', 'requestBodyBase64', 'requestBodySha256'])
        check(
          FLUID_USDT_QUOTE_HOSTS.includes(r.host) &&
            Number.isSafeInteger(r.rpcId) &&
            digest(r.requestBodySha256),
        )
        const text = unbase64(r.requestBodyBase64, 2048)
        check(hashText(text) === r.requestBodySha256)
        const request = parse(text, 2048)
        exact(request, ['jsonrpc', 'id', 'method', 'params'])
        check(request.jsonrpc === '2.0' && request.id === r.rpcId)
        const matches = [...rows.values()].filter(
          (v) => v.row.host === r.host && equal(v.row.request, request),
        )
        check(matches.length === 1)
        const native = matches[0]
        check(!used.has(native.row.physicalId))
        used.add(native.row.physicalId)
        const key = r.host + ':' + String(r.cashIndex) + ':' + r.key
        check(!requests.has(key))
        if (r.cashIndex === null) {
          check(
            r.key === 'chain' &&
              equal(
                { method: request.method, params: request.params },
                { method: 'eth_chainId', params: [] },
              ) &&
              native.response.result === '0x1' &&
              native.row.stage === 'usdt_history_chain',
          )
        } else
          check(
            Number.isInteger(r.cashIndex) &&
              r.cashIndex >= 111 + b * 4 &&
              r.cashIndex <= 114 + b * 4 &&
              [
                'header_before',
                'full_net_ea',
                'required_usdc',
                'roundtrip_usdt',
                'header_after',
              ].includes(r.key) &&
              native.row.stage === 'usdt_history_' + r.cashIndex,
          )
        requests.set(key, native)
      }
      check(
        used.size === 42 && FLUID_USDT_QUOTE_HOSTS.every((h) => requests.has(h + ':null:chain')),
      )
      for (let n = b * 4; n < b * 4 + 4; n++) {
        const base = old!.points[n],
          i = base.cashIndex,
          originFacts: any[] = [],
          times: string[] = []
        for (const host of FLUID_USDT_QUOTE_HOSTS) {
          const get = (key: string) => {
            const v = requests.get(host + ':' + i + ':' + key)
            check(v)
            return v!
          }
          const initial = fluidUsdtComposedHistoricalReadPlan(c, i)
          for (const spec of initial) {
            const v = get(spec.key)
            check(
              equal({ method: v.row.request.method, params: v.row.request.params }, spec.request),
            )
            times.push(v.row.completedAtUtc)
          }
          validateHeader(get('header_before').response.result, i)
          const Ea = decode(
            FLUID_USDC_BRIDGE_NATIVE_ABI,
            'previewRedeem',
            get('full_net_ea').response.result,
          )
          check(typeof Ea === 'bigint' && Ea >= 0n && Ea <= MAX)
          const output = decode(
            FLUID_USDT_QUOTE_ABI,
            'quoteExactOutputSingle',
            get('required_usdc').response.result,
          )
          check(
            Array.isArray(output) &&
              typeof output[0] === 'bigint' &&
              output[0] > 0n &&
              output[0] <= MAX,
          )
          const R = output[0].toString(),
            full = fluidUsdtComposedHistoricalReadPlan(c, i, R)
          for (const spec of full.slice(3)) {
            const v = get(spec.key)
            check(
              equal({ method: v.row.request.method, params: v.row.request.params }, spec.request),
            )
            times.push(v.row.completedAtUtc)
          }
          const round = decode(
            FLUID_USDT_QUOTE_ABI,
            'quoteExactInputSingle',
            get('roundtrip_usdt').response.result,
          )
          check(
            Array.isArray(round) &&
              typeof round[0] === 'bigint' &&
              round[0] >= BigInt(c.requestedFinalUsdtRaw) &&
              round[0] <= MAX,
          )
          validateHeader(get('header_after').response.result, i)
          const ordered = full.map((s) => get(s.key).row)
          check(
            ordered.every(
              (r, k) =>
                k === 0 || Date.parse(r.startedAtUtc) >= Date.parse(ordered[k - 1].completedAtUtc),
            ) && Date.parse(ordered[0].startedAtUtc) >= Date.parse(base.source.blockTime),
          )
          // Full tuples are compared, including native tick/price/gas witnesses.
          originFacts.push({ Ea: Ea.toString(), R, output, round })
        }
        check(equal(originFacts[0], originFacts[1]))
        const acquired = maxUtc([base.acquiredAtUtc, ...times]),
          available = maxUtc([
            base.availableAtUtc,
            batch.availableAtUtc,
            acquired,
            seriesAvailableAtUtc,
          ])
        points.push({
          source: { ...base.source },
          acquiredAtUtc: acquired,
          availableAtUtc: available,
          provenanceRef: 'unsigned_composed_native:' + i + ':' + batch.controlNamespace,
          profileId: c.profileId,
          holderSharesRaw: c.sharesRaw,
          shareDecimals: 18,
          fullHolderNetUsdcRaw: originFacts[0].Ea,
          nativeProngs: { ...base.nativeProngs },
          withdrawalFeeBps: base.withdrawalFeeBps,
          paused: base.paused,
          runtimeCodeHashes: { ...c.runtimeCodeHashes },
          sourceClass: 'captured_identical_runtimes_only',
          owner: null,
          historicalOwnership: false,
          provenanceKind: 'native_hypothetical_shares',
          conversion: {
            factory: C.factory,
            quoter: C.quoter,
            pool: C.pool,
            fee: 100,
            method: 'quoteExactOutputSingle',
            inputAsset: C.usdc,
            inputDecimals: 6,
            outputAsset: C.usdt,
            outputDecimals: 6,
            fixedFinalUsdtOutputRaw: c.requestedFinalUsdtRaw,
            requiredNetUsdcRaw: originFacts[0].R,
          },
        })
        allAcquired.push(acquired)
        allAvailable.push(available)
      }
    }
    check(points.length === 8)
    const result = {
      schema: 'fluid_usdt_joint_composed_history_evidence_v1' as const,
      points,
      sharesRaw: c.sharesRaw,
      requestedFinalUsdtRaw: c.requestedFinalUsdtRaw,
      acquiredAtUtc: maxUtc(allAcquired),
      availableAtUtc: maxUtc([...allAvailable, seriesAvailableAtUtc]),
      owner: null,
      historicalOwnership: false as const,
      originalAuthority: false as const,
      authenticated: false as const,
      executionQualified: false as const,
      calibrated: false as const,
      sourceImplementationEquivalence: false as const,
      MRaw: null,
    }
    check(bytes(JSON.stringify(result)) <= 8 * MB)
    return freeze(result)
  } catch {
    return null
  }
}
