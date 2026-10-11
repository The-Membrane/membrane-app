import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult, keccak256 } from 'viem'
import { FLUID_USDC_BRIDGE_NATIVE_ABI } from './fluidUsdcBridgeNativeAbi'
import { FLUID_BRIDGE_USDC_PRONGS } from './fluidBridgeUsdcJointHistoricalProcess'

export const FLUID_USDC_BRIDGE_NATIVE_ROUTE = 'USDC → FluidBridgeAggregatorProxy [USDC]'
export const FLUID_USDC_BRIDGE_NATIVE_VAULT = '0x273da948aca9261043fbdb2a857bc255ecc29012'
export const FLUID_USDC_BRIDGE_NATIVE_ASSET = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
export const FLUID_USDC_BRIDGE_IMPLEMENTATION = '0xe16ccc91a8134d428e7b6240177f9e2b227b9743'
export const FLUID_USDC_BRIDGE_FUSDC = '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33'
export const FLUID_USDC_BRIDGE_BANK = '0x52aa899454998be5b000ad077a46bbe360f4e497'
export const FLUID_USDC_BRIDGE_RESOLVER = '0xca13a15de31235a37134b4717021c35a3cf25c60'
export const FLUID_USDC_BRIDGE_NATIVE_RUNTIME_ADDRESSES = [
  FLUID_USDC_BRIDGE_NATIVE_VAULT,
  FLUID_USDC_BRIDGE_IMPLEMENTATION,
  FLUID_USDC_BRIDGE_FUSDC,
  FLUID_USDC_BRIDGE_NATIVE_ASSET,
  FLUID_USDC_BRIDGE_BANK,
  FLUID_USDC_BRIDGE_RESOLVER,
] as const
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const MAX = (1n << 256n) - 1n
type Source = {
  chainId: 1
  blockNumber: number
  blockHash: string
  blockTime: string
  finalized: true
}
type Trace = { key: string; request: { method: string; params: unknown[] }; result: unknown }
export type FluidUsdcBridgeNativeCapacityFact = {
  schema: 'fluid_usdc_bridge_native_capacity_v1'
  routeKey: typeof FLUID_USDC_BRIDGE_NATIVE_ROUTE
  destination: typeof FLUID_USDC_BRIDGE_NATIVE_VAULT
  owner: string
  asset: typeof FLUID_USDC_BRIDGE_NATIVE_ASSET
  assetDecimals: 6
  shareDecimals: 18
  source: Source
  readAtUtc: string
  sharesRaw: string
  fullNetEaRaw: string
  feeBps: number
  paused: boolean
  nativeProngs: Record<(typeof FLUID_BRIDGE_USDC_PRONGS)[number], string>
  runtimeCodeHashes: Record<string, string>
  traces: Trace[]
}
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const address = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v)
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const same = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, n) => same(v, b[n]))
    )
  if (record(a) || record(b))
    return (
      record(a) &&
      record(b) &&
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => Object.hasOwn(b, k) && same(a[k], b[k]))
    )
  return Object.is(a, b)
}
function sourceValid(source: Source, now: number) {
  return (
    source.chainId === 1 &&
    source.finalized === true &&
    Number.isSafeInteger(source.blockNumber) &&
    source.blockNumber > 0 &&
    /^0x[0-9a-f]{64}$/.test(source.blockHash) &&
    utc(source.blockTime) &&
    Date.parse(source.blockTime) % 1000 === 0 &&
    Number.isSafeInteger(now) &&
    now >= Date.parse(source.blockTime) &&
    now - Date.parse(source.blockTime) <= 1800000
  )
}
export function fluidUsdcBridgeNativeCapacityReadPlan(owner: string, source: Source) {
  const pin = { blockHash: source.blockHash, requireCanonical: true }
  const call = (key: string, to: string, name: string, args: unknown[] = []) => ({
    key,
    request: {
      method: 'eth_call',
      params: [
        {
          to,
          data: encodeFunctionData({
            abi: FLUID_USDC_BRIDGE_NATIVE_ABI,
            functionName: name,
            args,
          } as never),
        },
        pin,
      ],
    },
  })
  return [
    ...FLUID_USDC_BRIDGE_NATIVE_RUNTIME_ADDRESSES.map((to) => ({
      key: 'code:' + to,
      request: { method: 'eth_getCode', params: [to, pin] },
    })),
    {
      key: 'implementation_slot',
      request: { method: 'eth_getStorageAt', params: [FLUID_USDC_BRIDGE_NATIVE_VAULT, SLOT, pin] },
    },
    call('asset', FLUID_USDC_BRIDGE_NATIVE_VAULT, 'asset'),
    call('asset_decimals', FLUID_USDC_BRIDGE_NATIVE_ASSET, 'decimals'),
    call('share_decimals', FLUID_USDC_BRIDGE_NATIVE_VAULT, 'decimals'),
    call('holder_shares', FLUID_USDC_BRIDGE_NATIVE_VAULT, 'balanceOf', [owner]),
    call('fusdc', FLUID_USDC_BRIDGE_NATIVE_VAULT, 'getFUSDC'),
    call('fee', FLUID_USDC_BRIDGE_NATIVE_VAULT, 'getWithdrawalFeeBPS'),
    call('pause', FLUID_USDC_BRIDGE_NATIVE_VAULT, 'isWithdrawalsPaused'),
    call('bridge_funding', FLUID_USDC_BRIDGE_FUSDC, 'maxWithdraw', [
      FLUID_USDC_BRIDGE_NATIVE_VAULT,
    ]),
    call('bank_data', FLUID_USDC_BRIDGE_FUSDC, 'getData'),
    call('resolver_bank', FLUID_USDC_BRIDGE_RESOLVER, 'LIQUIDITY'),
    call('bank_supply', FLUID_USDC_BRIDGE_RESOLVER, 'getUserSupplyData', [
      FLUID_USDC_BRIDGE_FUSDC,
      FLUID_USDC_BRIDGE_NATIVE_ASSET,
    ]),
    call('bank_cash', FLUID_USDC_BRIDGE_NATIVE_ASSET, 'balanceOf', [FLUID_USDC_BRIDGE_BANK]),
  ]
}
function fullEaRequest(shares: string, source: Source) {
  return {
    key: 'full_net_ea',
    request: {
      method: 'eth_call',
      params: [
        {
          to: FLUID_USDC_BRIDGE_NATIVE_VAULT,
          data: encodeFunctionData({
            abi: FLUID_USDC_BRIDGE_NATIVE_ABI,
            functionName: 'previewRedeem',
            args: [BigInt(shares)],
          }),
        },
        { blockHash: source.blockHash, requireCanonical: true },
      ],
    },
  }
}
const NAMES: Record<string, string> = {
  asset: 'asset',
  asset_decimals: 'decimals',
  share_decimals: 'decimals',
  holder_shares: 'balanceOf',
  fusdc: 'getFUSDC',
  fee: 'getWithdrawalFeeBPS',
  pause: 'isWithdrawalsPaused',
  bridge_funding: 'maxWithdraw',
  bank_data: 'getData',
  resolver_bank: 'LIQUIDITY',
  bank_supply: 'getUserSupplyData',
  bank_cash: 'balanceOf',
  full_net_ea: 'previewRedeem',
}
function decode(trace: Trace) {
  if (
    typeof trace.result !== 'string' ||
    !/^0x(?:[0-9a-f]{2})*$/.test(trace.result) ||
    trace.result.length > 262146
  )
    throw Error('fluid_native_hex')
  const result = decodeFunctionResult({
    abi: FLUID_USDC_BRIDGE_NATIVE_ABI,
    functionName: NAMES[trace.key],
    data: trace.result,
  } as never)
  if (
    encodeFunctionResult({
      abi: FLUID_USDC_BRIDGE_NATIVE_ABI,
      functionName: NAMES[trace.key],
      result,
    } as never) !== trace.result
  )
    throw Error('fluid_native_canonical_abi')
  return result
}
function derive(
  owner: string,
  source: Source,
  readAtUtc: string,
  traces: Trace[],
): FluidUsdcBridgeNativeCapacityFact {
  const plan = fluidUsdcBridgeNativeCapacityReadPlan(owner, source)
  if (traces.length !== plan.length + 1 || Object.keys(traces).length !== traces.length)
    throw Error('fluid_native_trace_count')
  const decoded: Record<string, unknown> = {},
    hashes: Record<string, string> = {}
  for (let n = 0; n < plan.length; n++) {
    const trace = traces[n],
      spec = plan[n]
    if (
      !trace ||
      !same(trace.request, spec.request) ||
      trace.key !== spec.key ||
      Object.keys(trace).length !== 3
    )
      throw Error('fluid_native_plan')
    if (trace.key.startsWith('code:')) {
      if (
        typeof trace.result !== 'string' ||
        !/^0x(?:[0-9a-f]{2})+$/.test(trace.result) ||
        trace.result.length > 262146
      )
        throw Error('fluid_native_code')
      hashes[trace.key.slice(5)] = keccak256(trace.result as `0x${string}`)
    } else if (trace.key === 'implementation_slot') {
      if (trace.result !== '0x' + '0'.repeat(24) + FLUID_USDC_BRIDGE_IMPLEMENTATION.slice(2))
        throw Error('fluid_native_implementation')
    } else decoded[trace.key] = decode(trace)
  }
  const shares = String(decoded.holder_shares)
  const full = traces.at(-1)!
  if (
    !raw(shares) ||
    !same({ key: full.key, request: full.request }, fullEaRequest(shares, source)) ||
    Object.keys(full).length !== 3
  )
    throw Error('fluid_native_full_S')
  const ea = decode(full),
    data = decoded.bank_data as unknown[],
    supply = (decoded.bank_supply as unknown[])[0] as Record<string, bigint>
  if (
    String(decoded.asset).toLowerCase() !== FLUID_USDC_BRIDGE_NATIVE_ASSET ||
    decoded.asset_decimals !== 6 ||
    decoded.share_decimals !== 18 ||
    String(decoded.fusdc).toLowerCase() !== FLUID_USDC_BRIDGE_FUSDC ||
    String(data[0]).toLowerCase() !== FLUID_USDC_BRIDGE_BANK ||
    String(decoded.resolver_bank).toLowerCase() !== FLUID_USDC_BRIDGE_BANK ||
    typeof decoded.fee !== 'bigint' ||
    decoded.fee < 0n ||
    decoded.fee >= 10000n ||
    typeof decoded.pause !== 'boolean'
  )
    throw Error('fluid_native_identity_units')
  const nativeProngs = {
    bridgeFunding: String(decoded.bridge_funding),
    bankCash: String(decoded.bank_cash),
    bankSupply: String(data[6]),
    bankWithdrawableUntilLimit: String(supply.withdrawableUntilLimit),
    bankResolverWithdrawable: String(supply.withdrawable),
  }
  if (!Object.values(nativeProngs).every(raw) || !raw(String(ea)))
    throw Error('fluid_native_prongs')
  return {
    schema: 'fluid_usdc_bridge_native_capacity_v1',
    routeKey: FLUID_USDC_BRIDGE_NATIVE_ROUTE,
    destination: FLUID_USDC_BRIDGE_NATIVE_VAULT,
    owner,
    asset: FLUID_USDC_BRIDGE_NATIVE_ASSET,
    assetDecimals: 6,
    shareDecimals: 18,
    source: { ...source },
    readAtUtc,
    sharesRaw: shares,
    fullNetEaRaw: String(ea),
    feeBps: Number(decoded.fee),
    paused: decoded.pause,
    nativeProngs,
    runtimeCodeHashes: hashes,
    traces: structuredClone(traces),
  }
}
function snapshot(value: unknown): unknown {
  let bytes = 0,
    nodes = 0
  const seen = new WeakSet<object>()
  const copy = (v: unknown, depth: number): unknown => {
    if (++nodes > 10000 || depth > 20) throw Error('fluid_native_tree_bound')
    if (typeof v === 'string') {
      bytes += v.length * 3
      if (bytes > 4 * 1024 * 1024) throw Error('fluid_native_bytes')
      return v
    }
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
      return v
    if (
      !v ||
      typeof v !== 'object' ||
      seen.has(v) ||
      Object.getOwnPropertySymbols(v).length ||
      Object.getPrototypeOf(v) !== (Array.isArray(v) ? Array.prototype : Object.prototype)
    )
      throw Error('fluid_native_plain')
    seen.add(v)
    const ds = Object.getOwnPropertyDescriptors(v)
    if (Object.values(ds).some((d) => !Object.hasOwn(d, 'value')))
      throw Error('fluid_native_accessor')
    let out: unknown
    if (Array.isArray(v)) {
      if (v.length > 100 || Object.getOwnPropertyNames(v).length !== v.length + 1)
        throw Error('fluid_native_array')
      out = Array.from({ length: v.length }, (_, n) => {
        if (!ds[n]?.enumerable) throw Error('fluid_native_sparse')
        return copy(ds[n].value, depth + 1)
      })
    } else {
      const result: Record<string, unknown> = {}
      for (const [key, d] of Object.entries(ds)) {
        if (!d.enumerable || ['__proto__', 'constructor', 'prototype'].includes(key))
          throw Error('fluid_native_key')
        bytes += key.length * 3
        if (bytes > 4 * 1024 * 1024) throw Error('fluid_native_bytes')
        result[key] = copy(d.value, depth + 1)
      }
      out = result
    }
    seen.delete(v)
    return out
  }
  return copy(value, 0)
}
/** Exact ABI/source replay only. It grants no original acquisition authority. */
export function replayFluidUsdcBridgeNativeCapacityFact(
  value: unknown,
  owner: string,
  source: Source,
  now: number,
): FluidUsdcBridgeNativeCapacityFact | null {
  try {
    value = snapshot(value)
    source = snapshot(source) as Source
    if (
      !record(value) ||
      !address(owner) ||
      !sourceValid(source, now) ||
      !utc(value.readAtUtc) ||
      Date.parse(value.readAtUtc) < Date.parse(source.blockTime) ||
      Date.parse(value.readAtUtc) > now ||
      !Array.isArray(value.traces)
    )
      return null
    const rebuilt = derive(owner, source, value.readAtUtc, value.traces as Trace[])
    return same(rebuilt, value) ? rebuilt : null
  } catch {
    return null
  }
}
/** Optional current-only native getter path; owner/full S are independent of Q. */
export async function readFluidUsdcBridgeNativeCapacityFact(
  request: (request: { method: string; params: unknown[] }) => Promise<unknown>,
  owner: string,
  suppliedSource: Source,
  now: () => number,
): Promise<FluidUsdcBridgeNativeCapacityFact | null> {
  try {
    const source = structuredClone(suppliedSource),
      start = now()
    if (!address(owner) || !sourceValid(source, start)) return null
    const traces: Trace[] = []
    for (const spec of fluidUsdcBridgeNativeCapacityReadPlan(owner, source))
      traces.push({ ...spec, result: await request(spec.request) })
    const holder = traces.find((t) => t.key === 'holder_shares')!,
      shares = String(decode(holder))
    if (!raw(shares)) return null
    const full = fullEaRequest(shares, source)
    traces.push({ ...full, result: await request(full.request) })
    const completed = now()
    if (!sourceValid(source, completed) || completed < start) return null
    return derive(owner, source, new Date(completed).toISOString(), traces)
  } catch {
    return null
  }
}
