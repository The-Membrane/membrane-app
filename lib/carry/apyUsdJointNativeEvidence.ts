import {
  decodeFunctionResult,
  encodeErrorResult,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  parseAbi,
  sha256,
  stringToHex,
  type Abi,
} from 'viem'
import { projectApyUsdNet, validApyUsdFeeCurve, type ApyUsdFeeCurve } from './apyUsdFeeOutlook'
import type {
  ApyUsdJointCurrent,
  ApyUsdJointHistoryPoint,
  ApyUsdJointReceipt,
  ApyUsdJointSource,
} from './apyUsdJointStockProjection'
import { parseUsd3JointNativeEvidenceJson } from './usd3JointNativeEvidenceCodec'

export const APY_USD_JOINT_NATIVE_PROFILE_ID = 'apyusd_joint_native_v1'
export const APY_USD_JOINT_NATIVE_SUBJECT = Object.freeze({
  routeKey: 'apxUSD → ApyUSD [apxUSD]',
  destination: '0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a',
  receipt: '0x9bf51f33955ec70f87c4b5c49441815589043237',
  asset: '0x98a878b1cd98131b271883b390f68d2c90674665',
  assetDecimals: 18,
  shareDecimals: 18,
})
export const APY_USD_JOINT_NATIVE_LIMITS = Object.freeze({
  // Per current wire / individual historical point, not private raw-capture retention.
  // A 64-NFT wire with maximum accepted revert payloads has a 2,366,244-byte upper bound.
  transportBytes: 4 * 1024 * 1024,
  responseBytes: 65536,
  runtimeBytes: 65536,
  receipts: 64,
  currentPhases: 6,
  currentTracesPerOrigin: 390,
  historyTracesPerOrigin: 27,
  readMs: 8000,
  phaseMs: 120000,
  currentSourceAgeMs: 1800000,
})
const HOSTS = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'] as const
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const ZERO = '0x' + '0'.repeat(40)
const VAULT_IMPL = '0xfd616567ecc1607f61073951a1e822f7315bb112'
const RECEIPT_IMPL = '0x54f1c7ffe10bc392f08ae9432a7e21a6e86bb982'
const PINS = Object.freeze([
  [
    'vault_code',
    APY_USD_JOINT_NATIVE_SUBJECT.destination,
    '0x748fde5d195af5984cc16c81df36137e6599c6f50f9f5113d05994c1b90ebad7',
  ],
  [
    'receipt_code',
    APY_USD_JOINT_NATIVE_SUBJECT.receipt,
    '0x76f9f10f52a301cd5472850a4ac1f5421c8bb57f126e7bd171bd9d3ae70dc30b',
  ],
  [
    'vault_implementation_code',
    VAULT_IMPL,
    '0x7427a665f82e79f9e1e3a5592339de70bffab25517bbad2f7127549874fbf670',
  ],
  [
    'receipt_implementation_code',
    RECEIPT_IMPL,
    '0xae89d4b99f8590a5045c314350c7e1a0a7fdd69fd1adeb11aa554d6e2edeb1eb',
  ],
  [
    'asset_code',
    APY_USD_JOINT_NATIVE_SUBJECT.asset,
    '0x223e499501c0b9733c0b452729d097c5e5020682697e21e64c4420b03faea60a',
  ],
] as const)
export const APY_USD_JOINT_NATIVE_ABI: Abi = parseAbi([
  'function asset() view returns (address)',
  'function receipt() view returns (address)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function unlockingFee() view returns (uint256)',
  'function feeCurve() view returns (uint256 minFee,uint256 maxFee,uint48 minDuration,uint48 maxDuration,uint256 curvature)',
  'function paused() view returns (bool)',
  'function ownerOf(uint256) view returns (address)',
  'function getReceipt(uint256) view returns (uint208,uint208,uint48,uint48)',
  'function isClaimable(uint256) view returns (bool)',
  'function previewClaim(uint256) view returns (uint256)',
  'function claim(uint256,address) returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
  'function convertToAssets(uint256) view returns (uint256)',
  'function withdrawForReceipt(uint256,address,address) returns (uint256 shares,uint256 tokenId)',
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function vesting() view returns (address)',
  'function vestedAmount() view returns (uint256)',
  'error NotClaimable(uint256 tokenId)',
  'error ERC721NonexistentToken(uint256 tokenId)',
  'error ERC20InsufficientBalance(address sender,uint256 balance,uint256 needed)',
])
export type ApyUsdJointNativeRead = { key: string; request: { method: string; params: unknown[] } }
export type ApyUsdJointNativeTrace = ApyUsdJointNativeRead & {
  result?: unknown
  error?: { code: number; message: 'native_error'; data?: string }
  startedAtUtc: string
  completedAtUtc: string
  requestBodySha256: string
  responseBodySha256: string
}
export type ApyUsdJointNativePhase = {
  chainIdTrace: ApyUsdJointNativeTrace
  finalizedTrace: ApyUsdJointNativeTrace
  headerBeforeTrace: ApyUsdJointNativeTrace
  headerAfterTrace: ApyUsdJointNativeTrace
  acquiredAtUtc: string
}
export type ApyUsdJointNativeCurrentWire = {
  origins: {
    host: string
    acquiredAtUtc: string
    phases: ApyUsdJointNativePhase[]
    traces: ApyUsdJointNativeTrace[]
  }[]
}
export type ApyUsdJointNativeHistoryWire = {
  origins: {
    host: string
    acquiredAtUtc: string
    chainIdTrace: ApyUsdJointNativeTrace
    traces: ApyUsdJointNativeTrace[]
  }[]
}
export type ApyUsdJointNativeCurrentBinding = {
  routeKey: string
  destination: string
  asset: string
  owner: string
  candidateReceiptIds: readonly string[]
  source: ApyUsdJointSource
  acquiredAtUtc: string
}
export type ApyUsdJointNativeHistoryBinding = {
  cashIndex: number
  source: ApyUsdJointSource
  currentSource: ApyUsdJointSource
  fullSharesRaw: string
  currentRuntimeRegime: string
  vestingAddress: string | null
  vaultUnlockingFeeWad: string
  owner: null
  acquiredAtUtc: string
}
export type ApyUsdJointNativeRuntimeIdentity = { address: string; runtimeKeccak256: string }
const MAX = (1n << 256n) - 1n,
  WAD = 10n ** 18n
const ADDRESS = /^0x[0-9a-f]{40}$/,
  HEX = /^0x(?:[0-9a-f]{2})*$/,
  DIGEST = /^[0-9a-f]{64}$/
const utf8 = new TextEncoder()
function check(v: unknown, code: string): asserts v {
  if (!v) throw Error('apy_joint_native_' + code)
}
function exact(v: unknown, names: readonly string[]): Record<string, unknown> {
  check(v && typeof v === 'object' && !Array.isArray(v), 'object')
  const o = v as Record<string, unknown>
  check(Object.keys(o).length === names.length && names.every((k) => Object.hasOwn(o, k)), 'keys')
  return o
}
function uint(v: unknown): bigint {
  check(typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX, 'uint')
  return BigInt(v)
}
function clock(v: unknown): number {
  check(
    typeof v === 'string' &&
      v.length <= 32 &&
      Number.isSafeInteger(Date.parse(v)) &&
      new Date(v).toISOString() === v,
    'clock',
  )
  return Date.parse(v)
}
function source(v: unknown): ApyUsdJointSource {
  const s = exact(v, ['chainId', 'blockNumber', 'blockHash', 'blockTime', 'finalized'])
  check(
    s.chainId === 1 &&
      s.finalized === true &&
      Number.isSafeInteger(s.blockNumber) &&
      Number(s.blockNumber) > 0 &&
      typeof s.blockHash === 'string' &&
      /^0x[0-9a-f]{64}$/.test(s.blockHash) &&
      clock(s.blockTime) % 1000 === 0,
    'source',
  )
  return s as ApyUsdJointSource
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (
    !a ||
    !b ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false
  const x = a as Record<string, unknown>,
    y = b as Record<string, unknown>
  return (
    Object.keys(x).length === Object.keys(y).length &&
    Object.keys(x).every((k) => Object.hasOwn(y, k) && same(x[k], y[k]))
  )
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
/** Copy only bounded plain own-data trees; callers cannot run getters during replay. */
function snapshot<T>(value: T): T {
  let nodes = 0,
    bytes = 0
  const seen = new WeakSet<object>()
  const copy = (v: unknown, depth: number): unknown => {
    check(++nodes <= 50000 && depth <= 24, 'tree_limit')
    if (v === null || typeof v === 'boolean') return v
    if (typeof v === 'number') {
      check(Number.isSafeInteger(v), 'number')
      return v
    }
    if (typeof v === 'string') {
      bytes += utf8.encode(v).length
      check(v.length <= 131074 && bytes <= APY_USD_JOINT_NATIVE_LIMITS.transportBytes, 'tree_bytes')
      return v
    }
    check(
      v &&
        typeof v === 'object' &&
        !seen.has(v) &&
        Object.getOwnPropertySymbols(v).length === 0 &&
        Object.getPrototypeOf(v) === (Array.isArray(v) ? Array.prototype : Object.prototype),
      'plain_tree',
    )
    seen.add(v)
    const descriptors = Object.getOwnPropertyDescriptors(v)
    check(
      Object.values(descriptors).every((d) => Object.hasOwn(d, 'value')),
      'accessor',
    )
    if (Array.isArray(v)) {
      check(v.length <= 512 && Object.getOwnPropertyNames(v).length === v.length + 1, 'dense_array')
      const out = Array.from({ length: v.length }, (_, i) => {
        check(descriptors[i]?.enumerable, 'dense_array')
        return copy(descriptors[i].value, depth + 1)
      })
      seen.delete(v)
      return out
    }
    const out: Record<string, unknown> = {}
    for (const [k, d] of Object.entries(descriptors)) {
      check(d.enumerable && !['__proto__', 'constructor', 'prototype'].includes(k), 'hidden_key')
      bytes += k.length
      out[k] = copy(d.value, depth + 1)
    }
    seen.delete(v)
    return out
  }
  const out = copy(value, 0)
  check(
    utf8.encode(JSON.stringify(out)).length <= APY_USD_JOINT_NATIVE_LIMITS.transportBytes,
    'transport_bytes',
  )
  return out as T
}
export function parseApyUsdJointNativeEvidenceJson(text: string): unknown {
  return parseUsd3JointNativeEvidenceJson(text, APY_USD_JOINT_NATIVE_LIMITS.transportBytes)
}
function receiptIds(v: unknown): string[] {
  check(
    Array.isArray(v) &&
      v.length <= APY_USD_JOINT_NATIVE_LIMITS.receipts &&
      new Set(v).size === v.length,
    'receipt_ids',
  )
  v.forEach(uint)
  return v as string[]
}
function bindingCurrent(v: unknown): ApyUsdJointNativeCurrentBinding {
  const b = exact(v, [
    'routeKey',
    'destination',
    'asset',
    'owner',
    'candidateReceiptIds',
    'source',
    'acquiredAtUtc',
  ])
  check(
    b.routeKey === APY_USD_JOINT_NATIVE_SUBJECT.routeKey &&
      b.destination === APY_USD_JOINT_NATIVE_SUBJECT.destination &&
      b.asset === APY_USD_JOINT_NATIVE_SUBJECT.asset &&
      typeof b.owner === 'string' &&
      ADDRESS.test(b.owner) &&
      b.owner !== ZERO,
    'subject',
  )
  receiptIds(b.candidateReceiptIds)
  const s = source(b.source),
    age = clock(b.acquiredAtUtc) - clock(s.blockTime)
  check(age >= 0 && age <= APY_USD_JOINT_NATIVE_LIMITS.currentSourceAgeMs, 'current_source_age')
  return b as ApyUsdJointNativeCurrentBinding
}
const quantity = (n: number) => '0x' + n.toString(16)
const header = (key: string, s: ApyUsdJointSource): ApyUsdJointNativeRead => ({
  key,
  request: { method: 'eth_getBlockByNumber', params: [quantity(s.blockNumber), false] },
})
const call = (
  key: string,
  to: string,
  name: string,
  s: ApyUsdJointSource,
  args: readonly unknown[] = [],
  owner?: string,
): ApyUsdJointNativeRead => ({
  key,
  request: {
    method: 'eth_call',
    params: [
      {
        to,
        data: encodeFunctionData({ abi: APY_USD_JOINT_NATIVE_ABI, functionName: name, args }),
        ...(owner ? { from: owner, gas: '0xe4e1c0' } : {}),
      },
      { blockHash: s.blockHash, requireCanonical: true },
    ],
  },
})
function corePlan(s: ApyUsdJointSource): ApyUsdJointNativeRead[] {
  const { destination: v, receipt: r, asset: a } = APY_USD_JOINT_NATIVE_SUBJECT,
    pin = { blockHash: s.blockHash, requireCanonical: true }
  return [
    header('header_before', s),
    ...[
      [v, 'vault_implementation_slot'],
      [r, 'receipt_implementation_slot'],
    ].map(([to, key]) => ({
      key,
      request: { method: 'eth_getStorageAt', params: [to, SLOT, pin] },
    })),
    ...PINS.map(([key, to]) => ({ key, request: { method: 'eth_getCode', params: [to, pin] } })),
    call('vault_asset', v, 'asset', s),
    call('vault_receipt', v, 'receipt', s),
    call('receipt_asset', r, 'asset', s),
    call('share_decimals', v, 'decimals', s),
    call('asset_decimals', a, 'decimals', s),
    call('vault_paused', v, 'paused', s),
    call('receipt_paused', r, 'paused', s),
    call('unlocking_fee', v, 'unlockingFee', s),
    call('fee_curve', r, 'feeCurve', s),
    call('vault_cash', a, 'balanceOf', s, [v]),
    call('receipt_cash', a, 'balanceOf', s, [r]),
    call('total_assets', v, 'totalAssets', s),
    call('total_supply', v, 'totalSupply', s),
    call('vesting_address', v, 'vesting', s),
  ]
}
export type ApyUsdJointNativeCurrentStage = {
  stage:
    | 'base'
    | 'candidate_owners'
    | 'owned_receipts'
    | 'share_quote'
    | 'initiation_simulation'
    | 'vesting'
    | 'end'
  fullSharesRaw?: string
  fullEscrowEaRaw?: string
  vestingAddress?: string | null
  ownedReceiptIds?: readonly string[]
}
export function apyUsdJointNativeCurrentReadPlan(
  input: ApyUsdJointNativeCurrentBinding,
  options: ApyUsdJointNativeCurrentStage,
): readonly ApyUsdJointNativeRead[] {
  const b = bindingCurrent(snapshot(input)),
    o = snapshot(options),
    { destination: v, receipt: r } = APY_USD_JOINT_NATIVE_SUBJECT,
    s = b.source
  let out: ApyUsdJointNativeRead[]
  switch (o.stage) {
    case 'base':
      out = [
        ...corePlan(s),
        call('full_shares', v, 'balanceOf', s, [b.owner]),
        call('owned_count', r, 'balanceOf', s, [b.owner]),
        {
          key: 'owner_code',
          request: {
            method: 'eth_getCode',
            params: [b.owner, { blockHash: s.blockHash, requireCanonical: true }],
          },
        },
      ]
      break
    case 'candidate_owners':
      out = b.candidateReceiptIds.map((id) =>
        call('candidate_owner_' + id, r, 'ownerOf', s, [uint(id)]),
      )
      break
    case 'owned_receipts':
      out = receiptIds(o.ownedReceiptIds).flatMap((id) => [
        call('receipt_tuple_' + id, r, 'getReceipt', s, [uint(id)]),
        call('receipt_preview_' + id, r, 'previewClaim', s, [uint(id)]),
        call('receipt_claimable_' + id, r, 'isClaimable', s, [uint(id)]),
        call('receipt_claim_' + id, r, 'claim', s, [uint(id), b.owner], b.owner),
      ])
      break
    case 'share_quote': {
      const full = uint(o.fullSharesRaw)
      out = [
        call('full_escrow_ea', v, 'previewRedeem', s, [full]),
        call('full_gross_assets', v, 'convertToAssets', s, [full]),
      ]
      break
    }
    case 'initiation_simulation': {
      const ea = uint(o.fullEscrowEaRaw)
      out = [
        call('full_withdraw_shares', v, 'previewWithdraw', s, [ea]),
        call('full_share_sim', v, 'withdrawForReceipt', s, [ea, b.owner, b.owner], b.owner),
      ]
      break
    }
    case 'vesting':
      out = vestingPlan(s, o.vestingAddress)
      break
    case 'end':
      out = [header('header_after', s)]
      break
    default:
      throw Error('apy_joint_native_stage')
  }
  return freeze(out)
}
function vestingPlan(s: ApyUsdJointSource, address: unknown): ApyUsdJointNativeRead[] {
  if (address === null || address === ZERO) return []
  check(typeof address === 'string' && ADDRESS.test(address), 'vesting_address')
  return [
    {
      key: 'vesting_code',
      request: {
        method: 'eth_getCode',
        params: [address, { blockHash: s.blockHash, requireCanonical: true }],
      },
    },
    call('vested_amount', address, 'vestedAmount', s),
  ]
}
function historyBinding(v: unknown): ApyUsdJointNativeHistoryBinding {
  const b = exact(v, [
    'cashIndex',
    'source',
    'currentSource',
    'fullSharesRaw',
    'currentRuntimeRegime',
    'vestingAddress',
    'vaultUnlockingFeeWad',
    'owner',
    'acquiredAtUtc',
  ])
  const anchor = APY_USD_JOINT_NATIVE_ANCHORS.find((a) => a.cashIndex === b.cashIndex)
  check(anchor && same(source(b.source), anchor.source) && b.owner === null, 'history_anchor')
  const current = source(b.currentSource)
  check(
    current.blockNumber > anchor.source.blockNumber &&
      clock(current.blockTime) > clock(anchor.source.blockTime) &&
      clock(b.acquiredAtUtc) >= clock(anchor.source.blockTime) &&
      typeof b.currentRuntimeRegime === 'string' &&
      DIGEST.test(b.currentRuntimeRegime),
    'history_chronology',
  )
  uint(b.fullSharesRaw)
  uint(b.vaultUnlockingFeeWad)
  check(
    b.vestingAddress === null ||
      (typeof b.vestingAddress === 'string' && ADDRESS.test(b.vestingAddress)),
    'vesting_address',
  )
  return b as ApyUsdJointNativeHistoryBinding
}
export function apyUsdJointNativeHistoryReadPlan(
  input: ApyUsdJointNativeHistoryBinding,
): readonly ApyUsdJointNativeRead[] {
  const b = historyBinding(snapshot(input)),
    s = b.source,
    v = APY_USD_JOINT_NATIVE_SUBJECT.destination,
    full = uint(b.fullSharesRaw)
  return freeze([
    ...corePlan(s),
    call('full_escrow_ea', v, 'previewRedeem', s, [full]),
    call('full_gross_assets', v, 'convertToAssets', s, [full]),
    ...vestingPlan(s, b.vestingAddress),
    header('header_after', s),
  ])
}
function trace(
  v: unknown,
  expected: ApyUsdJointNativeRead,
  acquired: string,
): ApyUsdJointNativeTrace {
  check(v && typeof v === 'object', 'trace')
  const o = v as Record<string, unknown>,
    failure = Object.hasOwn(o, 'error')
  exact(o, [
    'key',
    'request',
    failure ? 'error' : 'result',
    'startedAtUtc',
    'completedAtUtc',
    'requestBodySha256',
    'responseBodySha256',
  ])
  check(same({ key: o.key, request: o.request }, expected), 'request')
  const start = clock(o.startedAtUtc),
    end = clock(o.completedAtUtc)
  check(
    start <= end &&
      end <= clock(acquired) &&
      end - start <= APY_USD_JOINT_NATIVE_LIMITS.readMs &&
      typeof o.requestBodySha256 === 'string' &&
      DIGEST.test(o.requestBodySha256) &&
      typeof o.responseBodySha256 === 'string' &&
      DIGEST.test(o.responseBodySha256),
    'trace_clock_commitments',
  )
  if (failure) {
    const e = o.error as Record<string, unknown>
    exact(e, Object.hasOwn(e, 'data') ? ['code', 'message', 'data'] : ['code', 'message'])
    check(
      Number.isSafeInteger(e.code) &&
        [3, -32000, -32015].includes(e.code as number) &&
        e.message === 'native_error' &&
        (e.data === undefined ||
          (typeof e.data === 'string' && HEX.test(e.data) && e.data.length <= 8194)),
      'error',
    )
  } else
    check(
      utf8.encode(JSON.stringify(o.result)).length <= APY_USD_JOINT_NATIVE_LIMITS.responseBytes,
      'response_bytes',
    )
  return o as ApyUsdJointNativeTrace
}
function projectedHeader(v: unknown): { number: string; hash: string; timestamp: string } {
  const h = exact(v, ['number', 'hash', 'timestamp'])
  check(
    typeof h.number === 'string' &&
      /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(h.number) &&
      typeof h.timestamp === 'string' &&
      /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(h.timestamp) &&
      typeof h.hash === 'string' &&
      /^0x[0-9a-f]{64}$/.test(h.hash) &&
      BigInt(h.number) <= BigInt(Number.MAX_SAFE_INTEGER) &&
      BigInt(h.timestamp) <= BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000)),
    'header',
  )
  return h as { number: string; hash: string; timestamp: string }
}
function exactHeader(v: unknown, s: ApyUsdJointSource): void {
  check(
    same(projectedHeader(v), {
      number: quantity(s.blockNumber),
      hash: s.blockHash,
      timestamp: quantity(clock(s.blockTime) / 1000),
    }),
    'source_header',
  )
}
function decodeAbi(t: ApyUsdJointNativeTrace, name: string): unknown {
  check(!t.error && typeof t.result === 'string' && HEX.test(t.result), 'abi_result')
  const value = decodeFunctionResult({
    abi: APY_USD_JOINT_NATIVE_ABI,
    functionName: name,
    data: t.result as `0x${string}`,
  })
  check(
    encodeFunctionResult({ abi: APY_USD_JOINT_NATIVE_ABI, functionName: name, result: value }) ===
      t.result,
    'canonical_abi',
  )
  const canonical = (v: unknown): unknown =>
    typeof v === 'bigint'
      ? v.toString()
      : Array.isArray(v)
        ? v.map(canonical)
        : typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)
          ? v.toLowerCase()
          : typeof v === 'number'
            ? String(v)
            : v
  return canonical(value)
}
const ABI_NAMES: Record<string, string> = {
  vault_asset: 'asset',
  vault_receipt: 'receipt',
  receipt_asset: 'asset',
  share_decimals: 'decimals',
  asset_decimals: 'decimals',
  vault_paused: 'paused',
  receipt_paused: 'paused',
  unlocking_fee: 'unlockingFee',
  fee_curve: 'feeCurve',
  vault_cash: 'balanceOf',
  receipt_cash: 'balanceOf',
  total_assets: 'totalAssets',
  total_supply: 'totalSupply',
  vesting_address: 'vesting',
  full_shares: 'balanceOf',
  owned_count: 'balanceOf',
  full_escrow_ea: 'previewRedeem',
  full_gross_assets: 'convertToAssets',
  full_withdraw_shares: 'previewWithdraw',
  full_share_sim: 'withdrawForReceipt',
  vested_amount: 'vestedAmount',
}
function decoded(t: ApyUsdJointNativeTrace, s: ApyUsdJointSource): unknown {
  if (t.error) {
    check(t.request.method === 'eth_call', 'required_rpc_result')
    return { error: true, data: t.error.data ?? null }
  }
  if (t.key === 'header_before' || t.key === 'header_after') {
    exactHeader(t.result, s)
    return projectedHeader(t.result)
  }
  if (t.request.method === 'eth_getCode') {
    check(
      typeof t.result === 'string' &&
        HEX.test(t.result) &&
        (t.result.length - 2) / 2 <= APY_USD_JOINT_NATIVE_LIMITS.runtimeBytes,
      'runtime',
    )
    if (t.key !== 'owner_code') check(t.result !== '0x', 'runtime_empty')
    const pin = PINS.find((p) => p[0] === t.key)
    if (pin) check(keccak256(t.result as `0x${string}`) === pin[2], 'runtime_pin')
    return t.result
  }
  if (t.request.method === 'eth_getStorageAt') {
    check(
      t.result ===
        '0x' +
          '0'.repeat(24) +
          (t.key === 'vault_implementation_slot' ? VAULT_IMPL : RECEIPT_IMPL).slice(2),
      'implementation_slot',
    )
    return t.result
  }
  const name =
    ABI_NAMES[t.key] ??
    (t.key.startsWith('candidate_owner_')
      ? 'ownerOf'
      : t.key.startsWith('receipt_tuple_')
        ? 'getReceipt'
        : t.key.startsWith('receipt_preview_')
          ? 'previewClaim'
          : t.key.startsWith('receipt_claimable_')
            ? 'isClaimable'
            : t.key.startsWith('receipt_claim_')
              ? 'claim'
              : null)
  check(name, 'getter')
  return decodeAbi(t, name)
}
function validateIdentity(d: Record<string, unknown>): ApyUsdJointNativeRuntimeIdentity[] {
  const s = APY_USD_JOINT_NATIVE_SUBJECT
  check(
    d.vault_asset === s.asset &&
      d.receipt_asset === s.asset &&
      d.vault_receipt === s.receipt &&
      d.asset_decimals === '18' &&
      d.share_decimals === '18',
    'native_identity',
  )
  return PINS.map(([key, address]) => ({
    address,
    runtimeKeccak256: keccak256(d[key] as `0x${string}`),
  }))
}
function nullableUint(d: Record<string, unknown>, key: string): string | null {
  if (d[key] && typeof d[key] === 'object') return null
  uint(d[key])
  return d[key] as string
}
function feeCurve(d: Record<string, unknown>): ApyUsdFeeCurve {
  check(Array.isArray(d.fee_curve) && d.fee_curve.length === 5, 'fee_curve')
  const values = d.fee_curve as string[]
  values.forEach(uint)
  const curve = {
    minFeeWad: values[0],
    maxFeeWad: values[1],
    minDurationSeconds: Number(values[2]),
    maxDurationSeconds: Number(values[3]),
    curvatureWad: values[4],
  }
  check(validApyUsdFeeCurve(curve), 'fee_curve')
  return curve
}
function checkQuotes(d: Record<string, unknown>): void {
  const gross = nullableUint(d, 'full_gross_assets'),
    ea = nullableUint(d, 'full_escrow_ea'),
    fee = uint(d.unlocking_fee)
  check(fee <= WAD, 'unlocking_fee')
  if (gross !== null && ea !== null) {
    const g = uint(gross),
      f = (g * fee + WAD + fee - 1n) / (WAD + fee)
    check(g - f === uint(ea), 'vault_quote_fee')
  }
}
function vestingFacts(d: Record<string, unknown>) {
  const raw = d.vesting_address
  if (raw && typeof raw === 'object')
    return { vestingAddress: null, vestedAmountRaw: null, identity: null }
  check(typeof raw === 'string' && ADDRESS.test(raw), 'vesting_address')
  if (raw === ZERO) return { vestingAddress: null, vestedAmountRaw: null, identity: null }
  check(typeof d.vesting_code === 'string' && HEX.test(d.vesting_code), 'vesting_code')
  return {
    vestingAddress: raw,
    vestedAmountRaw: nullableUint(d, 'vested_amount'),
    identity: { address: raw, runtimeKeccak256: keccak256(d.vesting_code as `0x${string}`) },
  }
}
function regime(
  ids: ApyUsdJointNativeRuntimeIdentity[],
  vesting: ApyUsdJointNativeRuntimeIdentity | null,
): string {
  return sha256(stringToHex(JSON.stringify([...ids, ...(vesting ? [vesting] : [])]))).slice(2)
}
function phaseWitness(
  v: unknown,
  s: ApyUsdJointSource,
  outerAcquired: string,
): ApyUsdJointNativePhase {
  const p = exact(v, [
      'chainIdTrace',
      'finalizedTrace',
      'headerBeforeTrace',
      'headerAfterTrace',
      'acquiredAtUtc',
    ]),
    acquired = String(p.acquiredAtUtc)
  check(clock(acquired) <= clock(outerAcquired), 'phase_acquired')
  const chain = trace(
      p.chainIdTrace,
      { key: 'chain', request: { method: 'eth_chainId', params: [] } },
      acquired,
    ),
    finalized = trace(
      p.finalizedTrace,
      {
        key: 'finalized',
        request: { method: 'eth_getBlockByNumber', params: ['finalized', false] },
      },
      acquired,
    ),
    before = trace(p.headerBeforeTrace, header('phase_header_before', s), acquired),
    after = trace(p.headerAfterTrace, header('phase_header_after', s), acquired)
  check(
    !chain.error && chain.result === '0x1' && !finalized.error && !before.error && !after.error,
    'phase_results',
  )
  const f = projectedHeader(finalized.result)
  check(
    BigInt(f.number) >= BigInt(s.blockNumber) &&
      BigInt(f.timestamp) * 1000n >= BigInt(clock(s.blockTime)) &&
      BigInt(f.timestamp) * 1000n <= BigInt(clock(finalized.completedAtUtc)) &&
      (BigInt(f.number) !== BigInt(s.blockNumber) ||
        (f.hash === s.blockHash && BigInt(f.timestamp) * 1000n === BigInt(clock(s.blockTime)))),
    'finalized_witness',
  )
  exactHeader(before.result, s)
  exactHeader(after.result, s)
  check(
    clock(chain.completedAtUtc) <= clock(finalized.startedAtUtc) &&
      clock(finalized.completedAtUtc) <= clock(before.startedAtUtc) &&
      clock(before.completedAtUtc) <= clock(after.startedAtUtc) &&
      clock(acquired) - clock(chain.startedAtUtc) <= APY_USD_JOINT_NATIVE_LIMITS.phaseMs,
    'phase_chronology',
  )
  return p as ApyUsdJointNativePhase
}
function traceMap(
  o: Record<string, unknown>,
  s: ApyUsdJointSource,
  acquired: string,
): { rows: ApyUsdJointNativeTrace[]; facts: Record<string, unknown> } {
  check(
    Array.isArray(o.traces) &&
      o.traces.length <= APY_USD_JOINT_NATIVE_LIMITS.currentTracesPerOrigin,
    'trace_count',
  )
  const rows = o.traces as ApyUsdJointNativeTrace[],
    facts: Record<string, unknown> = {}
  let end = 0
  for (const row of rows) {
    check(row && typeof row.key === 'string' && !Object.hasOwn(facts, row.key), 'duplicate_trace')
    trace(row, { key: row.key, request: row.request }, acquired)
    check(
      clock(row.startedAtUtc) >= end && clock(row.startedAtUtc) >= clock(s.blockTime),
      'trace_chronology',
    )
    end = clock(row.completedAtUtc)
    facts[row.key] = decoded(row, s)
  }
  return { rows, facts }
}
const UNSIGNED = Object.freeze({
  authenticated: false as const,
  originalAuthority: false as const,
  executionAuthority: false as const,
  nativeCommitmentAuthentication: false as const,
  sourceImplementationEquivalence: false as const,
  vestedYieldPullabilityProven: false as const,
  calibrated: false as const,
  historicalOwnership: false as const,
})
export type ApyUsdJointNativeCurrentReplay = typeof UNSIGNED & {
  current: ApyUsdJointCurrent
  owner: string
  candidateReceiptIds: readonly string[]
  ownedReceiptIds: readonly string[]
  vestingAddress: string | null
  runtimeIdentities: readonly ApyUsdJointNativeRuntimeIdentity[]
  fullShareSimulationTokenIdRaw: string | null
  fullWithdrawalSharesRaw: string
  initiationAction: 'asset_denominated_withdrawForReceipt'
  ownerIsContract: boolean
  primaryAbiVersion: 'official_mutable_HEAD'
}
/** Replays an unsigned wire. Private native acquisition authority must be established separately. */
export function replayApyUsdJointNativeCurrent(
  input: unknown,
  binding: ApyUsdJointNativeCurrentBinding,
): ApyUsdJointNativeCurrentReplay {
  const b = bindingCurrent(snapshot(binding)),
    wire = exact(
      snapshot(typeof input === 'string' ? parseApyUsdJointNativeEvidenceJson(input) : input),
      ['origins'],
    )
  check(Array.isArray(wire.origins) && wire.origins.length === 2, 'origins')
  const peers = wire.origins.map((value, n) => {
    const o = exact(value, ['host', 'acquiredAtUtc', 'phases', 'traces'])
    check(
      o.host === HOSTS[n] &&
        clock(o.acquiredAtUtc) <= clock(b.acquiredAtUtc) &&
        Array.isArray(o.phases) &&
        o.phases.length > 0 &&
        o.phases.length <= APY_USD_JOINT_NATIVE_LIMITS.currentPhases,
      'origin',
    )
    const phases = o.phases.map((p) => phaseWitness(p, b.source, o.acquiredAtUtc as string)),
      data = traceMap(o, b.source, o.acquiredAtUtc as string),
      d = data.facts
    for (const [i, p] of phases.entries())
      check(
        i === 0 ||
          clock(p.chainIdTrace.startedAtUtc) >=
            clock(phases[i - 1].headerAfterTrace.completedAtUtc),
        'phase_order',
      )
    for (const row of data.rows)
      check(
        phases.some(
          (p) =>
            clock(row.startedAtUtc) >= clock(p.headerBeforeTrace.completedAtUtc) &&
            clock(row.completedAtUtc) <= clock(p.headerAfterTrace.startedAtUtc),
        ),
        'trace_phase_join',
      )
    check(
      clock(o.acquiredAtUtc) ===
        Math.max(...phases.map((p) => clock(p.headerAfterTrace.completedAtUtc))) &&
        phases.every((p) => clock(p.acquiredAtUtc) === clock(p.headerAfterTrace.completedAtUtc)),
      'native_origin_acquired',
    )
    uint(d.full_shares)
    uint(d.owned_count)
    const owned = b.candidateReceiptIds.filter((id) => {
      const owner = d['candidate_owner_' + id]
      check(owner !== undefined, 'candidate_missing')
      if (typeof owner === 'object') {
        const row = data.rows.find((t) => t.key === 'candidate_owner_' + id)!
        check(
          row.error?.data ===
            encodeErrorResult({
              abi: APY_USD_JOINT_NATIVE_ABI,
              errorName: 'ERC721NonexistentToken',
              args: [uint(id)],
            }),
          'candidate_revert',
        )
        return false
      }
      check(typeof owner === 'string' && ADDRESS.test(owner) && owner !== ZERO, 'candidate_owner')
      return owner === b.owner
    })
    const vestingAddress = typeof d.vesting_address === 'string' ? d.vesting_address : null
    const expected = [
      'base',
      'candidate_owners',
      'owned_receipts',
      'share_quote',
      'initiation_simulation',
      'vesting',
      'end',
    ].flatMap((stage) =>
      apyUsdJointNativeCurrentReadPlan(b, {
        stage: stage as ApyUsdJointNativeCurrentStage['stage'],
        fullSharesRaw: d.full_shares as string,
        fullEscrowEaRaw: d.full_escrow_ea as string,
        ownedReceiptIds: owned,
        vestingAddress,
      }),
    )
    check(
      data.rows.length === expected.length &&
        expected.every((spec, i) =>
          same({ key: data.rows[i].key, request: data.rows[i].request }, spec),
        ),
      'plan_join',
    )
    return { ...data, phases, owned }
  })
  check(
    same(peers[0].facts, peers[1].facts) &&
      same(peers[0].owned, peers[1].owned) &&
      peers[0].phases.length === peers[1].phases.length,
    'origin_consensus',
  )
  check(
    clock(b.acquiredAtUtc) ===
      Math.max(...peers.map((p) => clock(p.phases.at(-1)!.headerAfterTrace.completedAtUtc))),
    'native_pair_acquired',
  )
  const d = peers[0].facts,
    ids = validateIdentity(d),
    vesting = vestingFacts(d),
    curve = feeCurve(d),
    at = clock(b.source.blockTime),
    owned = peers[0].owned
  checkQuotes(d)
  check(typeof d.vault_paused === 'boolean' && typeof d.receipt_paused === 'boolean', 'paused')
  const receipts = owned.map((id): ApyUsdJointReceipt => {
    const tuple = d['receipt_tuple_' + id]
    check(Array.isArray(tuple) && tuple.length === 4, 'receipt_tuple')
    tuple.forEach(uint)
    const [escrow, fee, creation, opening] = tuple as string[],
      preview = nullableUint(d, 'receipt_preview_' + id),
      claimable = d['receipt_claimable_' + id],
      row = peers[0].rows.find((t) => t.key === 'receipt_claim_' + id)!
    check(
      preview !== null &&
        typeof claimable === 'boolean' &&
        uint(fee) <= uint(escrow) &&
        uint(preview) === uint(escrow) - uint(fee),
      'receipt_quote',
    )
    if (uint(escrow) === 0n && uint(creation) === 0n && uint(opening) === 0n)
      check(preview === '0' && fee === '0', 'zero_receipt')
    else {
      check(
        uint(creation) > 0n &&
          uint(creation) * 1000n <= BigInt(at) &&
          uint(opening) === uint(creation) + BigInt(curve.minDurationSeconds) &&
          uint(opening) * 1000n <= BigInt(Number.MAX_SAFE_INTEGER),
        'receipt_clock',
      )
      const net = projectApyUsdNet(escrow, Math.floor(at / 1000) - Number(creation), curve)
      check(
        net &&
          net.netRaw === preview &&
          net.feeRaw === fee &&
          claimable === (!d.receipt_paused && BigInt(Math.floor(at / 1000)) >= uint(opening)),
        'receipt_fee',
      )
    }
    const claimSuccess = !row.error
    if (claimSuccess)
      check(
        decodeAbi(row, 'claim') === preview && claimable && !d.receipt_paused,
        'claim_simulation',
      )
    const timeGate =
      !claimSuccess &&
      row.error?.data ===
        encodeErrorResult({
          abi: APY_USD_JOINT_NATIVE_ABI,
          errorName: 'NotClaimable',
          args: [uint(id)],
        }) &&
      !d.receipt_paused &&
      claimable === false &&
      uint(creation) > 0n &&
      BigInt(at) < uint(opening) * 1000n
    return {
      tokenId: id,
      escrowRaw: escrow,
      fullNetEaRaw: preview,
      createdAtUtc: new Date(Number(creation) * 1000).toISOString(),
      claimableAtUtc: new Date(Number(opening) * 1000).toISOString(),
      fullClaimSimulation: claimSuccess,
      claimSimulationStatus: claimSuccess
        ? 'succeeded'
        : timeGate
          ? 'native_time_gate'
          : 'unexplained_revert',
    }
  })
  const fullEa = nullableUint(d, 'full_escrow_ea'),
    gross = nullableUint(d, 'full_gross_assets')
  check(fullEa !== null && gross !== null, 'current_full_quote')
  const withdrawShares = uint(d.full_withdraw_shares)
  check(withdrawShares <= uint(d.full_shares), 'full_withdraw_share_budget')
  if (uint(d.full_shares) === 0n)
    check(fullEa === '0' && gross === '0' && withdrawShares === 0n, 'zero_full_position_quotes')
  const sim = peers[0].rows.find((t) => t.key === 'full_share_sim')!,
    simulation = !sim.error ? decodeAbi(sim, 'withdrawForReceipt') : null
  if (simulation)
    check(
      Array.isArray(simulation) &&
        uint(d.full_shares) > 0n &&
        uint(fullEa) > 0n &&
        uint(fullEa) <= (1n << 208n) - 1n &&
        uint(simulation[0]) === withdrawShares &&
        withdrawShares > 0n &&
        uint(simulation[1]) > 0n &&
        !d.vault_paused &&
        !d.receipt_paused,
      'full_share_simulation',
    )
  if (simulation && uint(d.full_shares) > 0n)
    check(
      !b.candidateReceiptIds.some(
        (id) => id === simulation[1] && typeof d['candidate_owner_' + id] === 'string',
      ),
      'minted_id_collision',
    )
  const cash = nullableUint(d, 'vault_cash'),
    net = uint(fullEa),
    needed = net + (net * uint(d.unlocking_fee) + WAD - 1n) / WAD
  check(needed <= MAX, 'full_funding_overflow')
  const fundingGate =
    !!sim.error &&
    cash !== null &&
    uint(d.full_shares) > 0n &&
    !d.vault_paused &&
    !d.receipt_paused &&
    uint(cash) < needed &&
    sim.error.data ===
      encodeErrorResult({
        abi: APY_USD_JOINT_NATIVE_ABI,
        errorName: 'ERC20InsufficientBalance',
        args: [APY_USD_JOINT_NATIVE_SUBJECT.destination, uint(cash), needed],
      })
  const current: ApyUsdJointCurrent = {
    source: b.source,
    readAtUtc: b.acquiredAtUtc,
    profileId: APY_USD_JOINT_NATIVE_PROFILE_ID,
    runtimeRegime: regime(ids, vesting.identity),
    assetDecimals: 18,
    shareDecimals: 18,
    fullSharesRaw: d.full_shares as string,
    fullEscrowEaRaw: fullEa,
    fullGrossAssetsRaw: gross,
    vaultUnlockingFeeWad: d.unlocking_fee as string,
    vaultCashRaw: cash,
    receiptCashRaw: nullableUint(d, 'receipt_cash'),
    vestedAmountRaw: vesting.vestedAmountRaw,
    ...(nullableUint(d, 'total_assets') !== null
      ? { totalAssetsAccountingRaw: d.total_assets as string }
      : {}),
    vaultPaused: d.vault_paused,
    receiptPaused: d.receipt_paused,
    fullShareInitiationSimulation: simulation !== null && uint(d.full_shares) > 0n,
    shareInitiationSimulationStatus:
      simulation !== null && uint(d.full_shares) > 0n
        ? 'succeeded'
        : fundingGate
          ? 'native_funding_gate'
          : 'unexplained_revert',
    feeCurve: curve,
    existingReceipt: null,
    receiptInventory: {
      nativeOwnedCountRaw: d.owned_count as string,
      complete: uint(d.owned_count) === BigInt(receipts.length),
      receipts,
    },
  }
  check(uint(d.owned_count) >= BigInt(receipts.length), 'owner_count')
  return freeze({
    ...UNSIGNED,
    current,
    owner: b.owner,
    candidateReceiptIds: b.candidateReceiptIds,
    ownedReceiptIds: owned,
    vestingAddress: vesting.vestingAddress,
    runtimeIdentities: [...ids, ...(vesting.identity ? [vesting.identity] : [])],
    fullShareSimulationTokenIdRaw:
      simulation && uint(d.full_shares) > 0n ? (simulation[1] as string) : null,
    fullWithdrawalSharesRaw: withdrawShares.toString(),
    initiationAction: 'asset_denominated_withdrawForReceipt',
    ownerIsContract: d.owner_code !== '0x',
    primaryAbiVersion: 'official_mutable_HEAD',
  })
}
export type ApyUsdJointNativeHistoryReplay = ApyUsdJointHistoryPoint &
  typeof UNSIGNED & {
    runtimeIdentities: readonly ApyUsdJointNativeRuntimeIdentity[]
    feeCurve: ApyUsdFeeCurve
    vaultUnlockingFeeWad: string
    vestingAddress: string | null
    primaryAbiVersion: 'official_mutable_HEAD'
  }
export function replayApyUsdJointNativeHistoryPoint(
  input: unknown,
  binding: ApyUsdJointNativeHistoryBinding,
): ApyUsdJointNativeHistoryReplay {
  const b = historyBinding(snapshot(binding)),
    wire = exact(
      snapshot(typeof input === 'string' ? parseApyUsdJointNativeEvidenceJson(input) : input),
      ['origins'],
    ),
    expected = apyUsdJointNativeHistoryReadPlan(b)
  check(
    Array.isArray(wire.origins) &&
      wire.origins.length === 2 &&
      expected.length <= APY_USD_JOINT_NATIVE_LIMITS.historyTracesPerOrigin,
    'origins',
  )
  const peers = wire.origins.map((v, i) => {
    const o = exact(v, ['host', 'acquiredAtUtc', 'chainIdTrace', 'traces'])
    check(o.host === HOSTS[i] && clock(o.acquiredAtUtc) <= clock(b.acquiredAtUtc), 'origin')
    const chain = trace(
      o.chainIdTrace,
      { key: 'chain', request: { method: 'eth_chainId', params: [] } },
      o.acquiredAtUtc as string,
    )
    check(!chain.error && chain.result === '0x1', 'chain')
    const data = traceMap(o, b.source, o.acquiredAtUtc as string)
    check(
      data.rows.length === expected.length &&
        expected.every((r, n) =>
          same({ key: data.rows[n].key, request: data.rows[n].request }, r),
        ) &&
        clock(data.rows[0].startedAtUtc) >= clock(chain.completedAtUtc) &&
        clock(data.rows.at(-1)!.completedAtUtc) - clock(chain.startedAtUtc) <=
          APY_USD_JOINT_NATIVE_LIMITS.phaseMs,
      'history_plan',
    )
    check(
      clock(o.acquiredAtUtc) === clock(data.rows.at(-1)!.completedAtUtc),
      'native_origin_acquired',
    )
    return data
  })
  check(same(peers[0].facts, peers[1].facts), 'origin_consensus')
  check(
    clock(b.acquiredAtUtc) === Math.max(...peers.map((p) => clock(p.rows.at(-1)!.completedAtUtc))),
    'native_pair_acquired',
  )
  const d = peers[0].facts,
    ids = validateIdentity(d),
    vesting = vestingFacts(d),
    runtimeRegime = regime(ids, vesting.identity),
    anchor = APY_USD_JOINT_NATIVE_ANCHORS.find((a) => a.cashIndex === b.cashIndex)!
  check(
    runtimeRegime === b.currentRuntimeRegime &&
      vesting.vestingAddress === b.vestingAddress &&
      d.unlocking_fee === b.vaultUnlockingFeeWad &&
      d.vault_cash === anchor.cashRaw,
    'history_regime_cash',
  )
  checkQuotes(d)
  return freeze({
    ...UNSIGNED,
    source: b.source,
    acquiredAtUtc: b.acquiredAtUtc,
    profileId: APY_USD_JOINT_NATIVE_PROFILE_ID,
    runtimeRegime,
    assetDecimals: 18,
    shareDecimals: 18,
    fullSharesRaw: b.fullSharesRaw,
    fullEscrowEaRaw: nullableUint(d, 'full_escrow_ea'),
    fullGrossAssetsRaw: nullableUint(d, 'full_gross_assets'),
    vaultCashRaw: nullableUint(d, 'vault_cash'),
    vestedAmountRaw: vesting.vestedAmountRaw,
    receiptCashRaw: nullableUint(d, 'receipt_cash'),
    owner: null,
    runtimeIdentities: [...ids, ...(vesting.identity ? [vesting.identity] : [])],
    feeCurve: feeCurve(d),
    vaultUnlockingFeeWad: d.unlocking_fee as string,
    vestingAddress: vesting.vestingAddress,
    primaryAbiVersion: 'official_mutable_HEAD',
  })
}

/** Archived grid metadata only; each value must be reread natively by both origins. */
export const APY_USD_JOINT_NATIVE_ANCHORS = freeze([
  {
    cashIndex: 112,
    cashRaw: '168700267250573381807687697',
    source: {
      chainId: 1,
      finalized: true,
      blockNumber: 26057904,
      blockHash: '0xbb95ecc279a68df05a23fe4537046f3d4c129535059f55399293791370e20fb6',
      blockTime: '2026-09-25T23:59:59.000Z',
    },
  },
  {
    cashIndex: 113,
    cashRaw: '168575321779546008265227032',
    source: {
      chainId: 1,
      finalized: true,
      blockNumber: 26065069,
      blockHash: '0xb4e0fe4909fd2d5628301ab0483cb6c7f0dd30ffaa661d8fd888510ff3757998',
      blockTime: '2026-09-26T23:59:59.000Z',
    },
  },
  {
    cashIndex: 114,
    cashRaw: '168595366131662389692897666',
    source: {
      chainId: 1,
      finalized: true,
      blockNumber: 26072221,
      blockHash: '0x2680b61b94bf2651ac4603f6d93b5b2815f515f81d4a3077e65103f0fc82dc14',
      blockTime: '2026-09-27T23:59:59.000Z',
    },
  },
  {
    cashIndex: 115,
    cashRaw: '167680648970192583086565311',
    source: {
      chainId: 1,
      finalized: true,
      blockNumber: 26079396,
      blockHash: '0x31868801c3f7242338e7f191929032c3fc9387e9ec07ace2c0264f13c7914bae',
      blockTime: '2026-09-28T23:59:59.000Z',
    },
  },
  {
    cashIndex: 116,
    cashRaw: '167697744736797113812314409',
    source: {
      chainId: 1,
      finalized: true,
      blockNumber: 26086569,
      blockHash: '0x47f2ef87e05d0a9f6d4f9cc1c47cfa504b8dc94bb1a52a8b8f778a409328c250',
      blockTime: '2026-09-29T23:59:59.000Z',
    },
  },
  {
    cashIndex: 117,
    cashRaw: '167573535316086141779416918',
    source: {
      chainId: 1,
      finalized: true,
      blockNumber: 26093737,
      blockHash: '0xcd26204e996dceb606ccf0bc6f5bf8ea6747a471df8be73b5855f01624d5d743',
      blockTime: '2026-09-30T23:59:59.000Z',
    },
  },
  {
    cashIndex: 118,
    cashRaw: '167605980408008908512249772',
    source: {
      chainId: 1,
      finalized: true,
      blockNumber: 26100913,
      blockHash: '0x2fe9266ceaaea215d32a4c5e0701f3c287705f2b976844cf3131534a814aa272',
      blockTime: '2026-10-01T23:59:59.000Z',
    },
  },
  {
    cashIndex: 119,
    cashRaw: '167042053298576258220185632',
    source: {
      chainId: 1,
      finalized: true,
      blockNumber: 26108081,
      blockHash: '0x9f430d0cc4301a9f8ea0315223c2ed6e66373f6454baac771cac7449d725ba37',
      blockTime: '2026-10-02T23:59:59.000Z',
    },
  },
] as const)
