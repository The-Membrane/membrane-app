import {
  decodeFunctionResult,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  parseAbi,
} from 'viem'
import {
  UMBRELLA_GHO_ROUTE,
  UMBRELLA_STKGHO,
  ORIGINAL_GHO,
  VERIFIED_STKGHO_IMPLEMENTATION,
} from './umbrellaGhoExit'

export const UMBRELLA_GHO_NATIVE_ABI = parseAbi([
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
  'function paused() view returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function getCooldown() view returns (uint256)',
  'function getUnstakeWindow() view returns (uint256)',
  'function getStakerCooldown(address) view returns (uint192 amount,uint32 endOfCooldown,uint32 withdrawalWindow)',
  'function maxRedeem(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function getMaxSlashableAssets() view returns (uint256)',
])
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const MAX = (1n << 256n) - 1n
const TTL = 1800000
// Runtime hashes retained in independently reviewed native current captures, 2026-10-08.
// GHO runtime: actual74 physical IDs57/70, exact8046-byte code; identity is not acquisition authority.
const PROFILE = Object.freeze({
  id: 'umbrella_stkgho_v1_native_2026_10_08',
  proxyRuntimeHash: '0x5fa5d4889c27130d81c0afb814238692ca6b8774d690db729865fca3e3722a52',
  implementationRuntimeHash: '0x553314ff37b47c42c33fc80c155f04cf1f0163967003f2a0bac7ccbb1dd22a21',
  assetRuntimeHash: '0xdd51428dd1ef13362e52bfc1689ed8e011730e6c6d5b50aaf96165ccd7bf0172' as
    | string
    | null,
})
export type UmbrellaGhoNativeSource = {
  chainId: 1
  blockNumber: number
  blockHash: string
  blockTime: string
  finalized: true
}
export type UmbrellaGhoNativeCapacityBinding = {
  routeKey: string
  destination: string
  owner: string
  asset: string
  assetDecimals: 18
  shareDecimals: 18
  source: UmbrellaGhoNativeSource
  asOfMs: number
}
export type UmbrellaGhoNativeTrace = {
  key: string
  request: { method: string; params: unknown[] }
  result: unknown
}
export type UmbrellaGhoNativeCapacityFact = {
  schema: 'umbrella_gho_native_capacity_v1'
  profileId: string
  routeKey: typeof UMBRELLA_GHO_ROUTE
  destination: typeof UMBRELLA_STKGHO
  owner: string
  asset: typeof ORIGINAL_GHO
  assetDecimals: 18
  shareDecimals: 18
  source: UmbrellaGhoNativeSource
  readAtUtc: string
  fullSharesRaw: string
  fullEaRaw: string
  fullEaMethod: 'preview_redeem_full_position'
  cooldownSharesRaw: string
  cooldownSnapshotEaRaw: string
  cooldownEnd: number
  withdrawalWindowSeconds: number
  windowEndInclusive: number
  cooldownStartedAt: null
  currentCooldownSeconds: number
  currentUnstakeWindowSeconds: number
  maxRedeemSharesRaw: string
  totalAssetsGhoRaw: string
  totalSupplySharesRaw: string
  ghoCashRaw: string
  maxSlashableAssetsRaw: string
  paused: boolean
  state: 'paused' | 'cooldown_not_started' | 'waiting' | 'window_open' | 'window_expired'
  MRaw: null
  runtimeCodeHashes: Record<string, string>
  runtimeProfileQualified: boolean
  qualification: 'asset_runtime_unpinned' | 'runtime_profile_qualified'
  traces: UmbrellaGhoNativeTrace[]
  originalAuthority: false
  authenticated: false
  executionAuthority: false
  historicalOwnership: false
  guaranteedDelivery: false
}
const uint = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const address = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v)
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  Date.parse(v) >= 0 &&
  new Date(Date.parse(v)).toISOString() === v
const eq = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const x = Object.keys(a),
    y = Object.keys(b)
  return (
    Array.isArray(a) === Array.isArray(b) &&
    x.length === y.length &&
    x.every(
      (k) =>
        Object.hasOwn(b, k) &&
        eq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  )
}
function check(ok: unknown) {
  if (!ok) throw Error('umbrella_native_invalid')
}
/** Header traces retain only these identity fields. Original raw RPC bodies belong in the server recorder.
 * Inspect all own descriptors without invoking header getters or traversing unrelated transactions. */
export function projectUmbrellaGhoNativeHeader(
  value: unknown,
): { number: string; hash: string; timestamp: string } | null {
  try {
    check(value && typeof value === 'object' && !Array.isArray(value))
    const o = value as object,
      prototype = Object.getPrototypeOf(o)
    check(prototype === Object.prototype || prototype === null)
    const own = Reflect.ownKeys(o)
    check(own.length >= 3 && own.length <= 64)
    for (const key of own) {
      check(
        typeof key === 'string' &&
          !['__proto__', 'constructor', 'prototype'].includes(key as string),
      )
      const d = Object.getOwnPropertyDescriptor(o, key)!
      check(Object.hasOwn(d, 'value') && d.enumerable)
    }
    const number = Object.getOwnPropertyDescriptor(o, 'number')?.value
    const hash = Object.getOwnPropertyDescriptor(o, 'hash')?.value
    const timestamp = Object.getOwnPropertyDescriptor(o, 'timestamp')?.value
    check(
      typeof number === 'string' && number.length <= 16 && /^0x(0|[1-9a-f][0-9a-f]*)$/.test(number),
    )
    check(
      typeof timestamp === 'string' &&
        timestamp.length <= 16 &&
        /^0x(0|[1-9a-f][0-9a-f]*)$/.test(timestamp),
    )
    check(typeof hash === 'string' && hash.length === 66 && /^0x[0-9a-f]{64}$/.test(hash))
    check(
      BigInt(number as string) > 0n &&
        BigInt(number as string) <= BigInt(Number.MAX_SAFE_INTEGER) &&
        BigInt(timestamp as string) * 1000n <= BigInt(Number.MAX_SAFE_INTEGER),
    )
    return Object.freeze({
      number: number as string,
      hash: hash as string,
      timestamp: timestamp as string,
    })
  } catch {
    return null
  }
}
function snapshot(value: unknown, projectNativeHeaders = false): unknown {
  const seen = new Set<object>()
  let nodes = 0,
    bytes = 0
  const walk = (v: unknown, depth: number): unknown => {
    check(++nodes <= 5000 && depth <= 12)
    if (v === null || typeof v === 'boolean') return v
    if (typeof v === 'number') {
      check(Number.isSafeInteger(v) && v >= 0)
      return v
    }
    if (typeof v === 'string') {
      bytes += v.length
      check(bytes <= 262144)
      return v
    }
    check(v && typeof v === 'object' && !seen.has(v as object))
    const o = v as object,
      p = Object.getPrototypeOf(o)
    check(Array.isArray(o) ? p === Array.prototype : p === Object.prototype || p === null)
    seen.add(o)
    const traceKey = projectNativeHeaders
      ? Object.getOwnPropertyDescriptor(o, 'key')?.value
      : undefined
    const headerTrace = traceKey === 'header_before' || traceKey === 'header_after'
    const out: unknown[] = [],
      rec: Record<string, unknown> = {}
    if (Array.isArray(o)) check(o.length <= 64 && Object.keys(o).length === o.length)
    for (const key of Reflect.ownKeys(o)) {
      if (Array.isArray(o) && key === 'length') continue
      check(
        typeof key === 'string' &&
          !['__proto__', 'constructor', 'prototype'].includes(key as string),
      )
      const d = Object.getOwnPropertyDescriptor(o, key)!
      check(Object.hasOwn(d, 'value') && d.enumerable)
      let field = d.value
      if (headerTrace && key === 'result') {
        field = projectUmbrellaGhoNativeHeader(field)
        check(field !== null)
      }
      if (Array.isArray(o)) {
        check(/^(0|[1-9][0-9]*)$/.test(key as string))
        out[Number(key)] = walk(field, depth + 1)
      } else rec[key as string] = walk(field, depth + 1)
    }
    seen.delete(o)
    return Array.isArray(o) ? out : rec
  }
  return walk(value, 0)
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
function validBinding(b: UmbrellaGhoNativeCapacityBinding) {
  const s = b.source,
    t = Date.parse(s.blockTime)
  return (
    b.routeKey === UMBRELLA_GHO_ROUTE &&
    b.destination === UMBRELLA_STKGHO &&
    b.asset === ORIGINAL_GHO &&
    b.assetDecimals === 18 &&
    b.shareDecimals === 18 &&
    address(b.owner) &&
    b.owner !== '0x' + '0'.repeat(40) &&
    s.chainId === 1 &&
    s.finalized === true &&
    Number.isSafeInteger(s.blockNumber) &&
    s.blockNumber > 0 &&
    /^0x[0-9a-f]{64}$/.test(s.blockHash) &&
    utc(s.blockTime) &&
    t % 1000 === 0 &&
    Number.isSafeInteger(b.asOfMs) &&
    b.asOfMs >= t &&
    b.asOfMs - t <= TTL
  )
}
const pin = (s: UmbrellaGhoNativeSource) => ({ blockHash: s.blockHash, requireCanonical: true })
function call(key: string, to: string, name: string, args: unknown[], s: UmbrellaGhoNativeSource) {
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
        pin(s),
      ],
    },
  }
}
const header = (key: string, s: UmbrellaGhoNativeSource) => ({
  key,
  request: { method: 'eth_getBlockByNumber', params: ['0x' + s.blockNumber.toString(16), false] },
})
/** Static allowed native reads. Q never enters this plan. Entitlements follow measured balances. */
export function umbrellaGhoNativeCapacityReadPlan(owner: string, s: UmbrellaGhoNativeSource) {
  return [
    header('header_before', s),
    { key: 'chain', request: { method: 'eth_chainId', params: [] } },
    ...[UMBRELLA_STKGHO, VERIFIED_STKGHO_IMPLEMENTATION, ORIGINAL_GHO].map((to) => ({
      key: 'code:' + to,
      request: { method: 'eth_getCode', params: [to, pin(s)] },
    })),
    {
      key: 'implementation_slot',
      request: { method: 'eth_getStorageAt', params: [UMBRELLA_STKGHO, SLOT, pin(s)] },
    },
    call('asset', UMBRELLA_STKGHO, 'asset', [], s),
    call('asset_decimals', ORIGINAL_GHO, 'decimals', [], s),
    call('share_decimals', UMBRELLA_STKGHO, 'decimals', [], s),
    call('paused', UMBRELLA_STKGHO, 'paused', [], s),
    call('full_shares', UMBRELLA_STKGHO, 'balanceOf', [owner], s),
    call('total_assets', UMBRELLA_STKGHO, 'totalAssets', [], s),
    call('total_supply', UMBRELLA_STKGHO, 'totalSupply', [], s),
    call('cooldown', UMBRELLA_STKGHO, 'getCooldown', [], s),
    call('global_window', UMBRELLA_STKGHO, 'getUnstakeWindow', [], s),
    call('snapshot', UMBRELLA_STKGHO, 'getStakerCooldown', [owner], s),
    call('max_redeem', UMBRELLA_STKGHO, 'maxRedeem', [owner], s),
    call('slashable', UMBRELLA_STKGHO, 'getMaxSlashableAssets', [], s),
    call('cash', ORIGINAL_GHO, 'balanceOf', [UMBRELLA_STKGHO], s),
  ]
}
export function umbrellaGhoNativeCapacityEntitlementReadPlan(
  fullSharesRaw: string,
  cooldownSharesRaw: string,
  s: UmbrellaGhoNativeSource,
) {
  check(uint(fullSharesRaw) && BigInt(fullSharesRaw) > 0n && uint(cooldownSharesRaw))
  return [
    call('full_ea', UMBRELLA_STKGHO, 'previewRedeem', [BigInt(fullSharesRaw)], s),
    call('snapshot_ea', UMBRELLA_STKGHO, 'previewRedeem', [BigInt(cooldownSharesRaw)], s),
    header('header_after', s),
  ]
}
const names: Record<string, string> = {
  asset: 'asset',
  asset_decimals: 'decimals',
  share_decimals: 'decimals',
  paused: 'paused',
  full_shares: 'balanceOf',
  total_assets: 'totalAssets',
  total_supply: 'totalSupply',
  cooldown: 'getCooldown',
  global_window: 'getUnstakeWindow',
  snapshot: 'getStakerCooldown',
  max_redeem: 'maxRedeem',
  slashable: 'getMaxSlashableAssets',
  cash: 'balanceOf',
  full_ea: 'previewRedeem',
  snapshot_ea: 'previewRedeem',
}
function decoded(t: UmbrellaGhoNativeTrace): unknown {
  check(
    typeof t.result === 'string' &&
      /^0x(?:[0-9a-f]{2})*$/.test(t.result) &&
      t.result.length <= 4098,
  )
  const v = decodeFunctionResult({
    abi: UMBRELLA_GHO_NATIVE_ABI,
    functionName: names[t.key],
    data: t.result,
  } as never)
  check(
    encodeFunctionResult({
      abi: UMBRELLA_GHO_NATIVE_ABI,
      functionName: names[t.key],
      result: v,
    } as never) === t.result,
  )
  return v
}
function asUint(v: unknown): bigint {
  check(
    (typeof v === 'bigint' && v >= 0n && v <= MAX) ||
      (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0),
  )
  return BigInt(v as bigint | number)
}
function checkHeader(v: unknown, s: UmbrellaGhoNativeSource) {
  const h = v as { number?: string; hash?: string; timestamp?: string }
  check(
    h &&
      typeof h.number === 'string' &&
      /^0x(0|[1-9a-f][0-9a-f]*)$/.test(h.number) &&
      typeof h.timestamp === 'string' &&
      /^0x(0|[1-9a-f][0-9a-f]*)$/.test(h.timestamp),
  )
  check(
    BigInt(h.number!) === BigInt(s.blockNumber) &&
      h.hash === s.blockHash &&
      BigInt(h.timestamp!) * 1000n === BigInt(Date.parse(s.blockTime)),
  )
}
/** Unsigned raw replay. Canonical getter bytes do not establish acquisition authority. */
export function replayUmbrellaGhoNativeCapacityFact(
  value: unknown,
  binding: UmbrellaGhoNativeCapacityBinding,
): UmbrellaGhoNativeCapacityFact | null {
  try {
    const b = snapshot(binding) as UmbrellaGhoNativeCapacityBinding,
      wire = snapshot(value, true) as { readAtUtc: string; traces: UmbrellaGhoNativeTrace[] }
    if (
      !validBinding(b) ||
      !utc(wire.readAtUtc) ||
      Date.parse(wire.readAtUtc) < Date.parse(b.source.blockTime) ||
      Date.parse(wire.readAtUtc) > b.asOfMs ||
      !Array.isArray(wire.traces)
    )
      return null
    const traces = wire.traces,
      plan = umbrellaGhoNativeCapacityReadPlan(b.owner, b.source),
      values: Record<string, unknown> = {},
      hashes: Record<string, string> = {}
    const consume = (
      spec: { key: string; request: { method: string; params: unknown[] } },
      i: number,
    ) => {
      const t = traces[i]
      check(t && Object.keys(t).length === 3 && t.key === spec.key && eq(t.request, spec.request))
      if (t.key === 'header_before' || t.key === 'header_after') checkHeader(t.result, b.source)
      else if (t.key === 'chain') check(t.result === '0x1')
      else if (t.key.startsWith('code:')) {
        check(
          typeof t.result === 'string' &&
            /^0x(?:[0-9a-f]{2})+$/.test(t.result) &&
            t.result.length <= 131074,
        )
        hashes[t.key.slice(5)] = keccak256(t.result as `0x${string}`)
      } else if (t.key === 'implementation_slot')
        check(t.result === '0x' + '0'.repeat(24) + VERIFIED_STKGHO_IMPLEMENTATION.slice(2))
      else values[t.key] = decoded(t)
    }
    plan.forEach(consume)
    check(
      hashes[UMBRELLA_STKGHO] === PROFILE.proxyRuntimeHash &&
        hashes[VERIFIED_STKGHO_IMPLEMENTATION] === PROFILE.implementationRuntimeHash,
    )
    check(
      typeof values.asset === 'string' &&
        /^0x[0-9a-fA-F]{40}$/.test(values.asset) &&
        values.asset.toLowerCase() === ORIGINAL_GHO,
    )
    check(
      asUint(values.asset_decimals) === 18n &&
        asUint(values.share_decimals) === 18n &&
        typeof values.paused === 'boolean',
    )
    const S = asUint(values.full_shares)
    check(S > 0n)
    const snap = values.snapshot as unknown[]
    check(Array.isArray(snap) && snap.length === 3)
    const CS = asUint(snap[0]),
      end = asUint(snap[1]),
      window = asUint(snap[2]),
      endWindow = end + window
    check(CS < 1n << 192n && end <= 0xffffffffn && window <= 0xffffffffn)
    const cooldown = asUint(values.cooldown),
      globalWindow = asUint(values.global_window),
      maxRedeem = asUint(values.max_redeem),
      at = BigInt(Date.parse(b.source.blockTime) / 1000)
    check(cooldown <= 0xffffffffn && globalWindow <= 0xffffffffn && maxRedeem <= S)
    if (at <= endWindow) check(CS <= S)
    const inWindow = CS > 0n && at >= end && at <= endWindow,
      paused = values.paused as boolean
    check(maxRedeem === (paused ? 0n : inWindow ? CS : 0n))
    const slashable = asUint(values.slashable)
    if (paused) check(slashable === 0n)
    const extra = umbrellaGhoNativeCapacityEntitlementReadPlan(
      S.toString(),
      CS.toString(),
      b.source,
    )
    check(traces.length === plan.length + extra.length)
    extra.forEach((spec, i) => consume(spec, plan.length + i))
    const fullEa = asUint(values.full_ea),
      snapshotEa = asUint(values.snapshot_ea)
    const qualified =
      PROFILE.assetRuntimeHash !== null && hashes[ORIGINAL_GHO] === PROFILE.assetRuntimeHash
    if (PROFILE.assetRuntimeHash !== null) check(qualified)
    const state = paused
      ? 'paused'
      : CS === 0n || end === 0n
        ? 'cooldown_not_started'
        : at < end
          ? 'waiting'
          : at <= endWindow
            ? 'window_open'
            : 'window_expired'
    return freeze<UmbrellaGhoNativeCapacityFact>({
      schema: 'umbrella_gho_native_capacity_v1',
      profileId: PROFILE.id,
      routeKey: UMBRELLA_GHO_ROUTE,
      destination: UMBRELLA_STKGHO,
      owner: b.owner,
      asset: ORIGINAL_GHO,
      assetDecimals: 18,
      shareDecimals: 18,
      source: b.source,
      readAtUtc: wire.readAtUtc,
      fullSharesRaw: S.toString(),
      fullEaRaw: fullEa.toString(),
      fullEaMethod: 'preview_redeem_full_position',
      cooldownSharesRaw: CS.toString(),
      cooldownSnapshotEaRaw: snapshotEa.toString(),
      cooldownEnd: Number(end),
      withdrawalWindowSeconds: Number(window),
      windowEndInclusive: Number(endWindow),
      cooldownStartedAt: null,
      currentCooldownSeconds: Number(cooldown),
      currentUnstakeWindowSeconds: Number(globalWindow),
      maxRedeemSharesRaw: maxRedeem.toString(),
      totalAssetsGhoRaw: asUint(values.total_assets).toString(),
      totalSupplySharesRaw: asUint(values.total_supply).toString(),
      ghoCashRaw: asUint(values.cash).toString(),
      maxSlashableAssetsRaw: slashable.toString(),
      paused,
      state,
      MRaw: null,
      runtimeCodeHashes: hashes,
      runtimeProfileQualified: qualified,
      qualification: qualified ? 'runtime_profile_qualified' : 'asset_runtime_unpinned',
      traces,
      originalAuthority: false,
      authenticated: false,
      executionAuthority: false,
      historicalOwnership: false,
      guaranteedDelivery: false,
    })
  } catch {
    return null
  }
}
/** Current-only forecast eligibility. Historical replay must use a separate acquisition contract. */
export function selectedUmbrellaGhoNativeCapacityFact(
  value: unknown,
  binding: UmbrellaGhoNativeCapacityBinding,
): UmbrellaGhoNativeCapacityFact | null {
  try {
    const v = snapshot(value) as UmbrellaGhoNativeCapacityFact
    const rebuilt = replayUmbrellaGhoNativeCapacityFact(
      { readAtUtc: v.readAtUtc, traces: v.traces },
      binding,
    )
    return rebuilt?.runtimeProfileQualified && eq(v, rebuilt) ? rebuilt : null
  } catch {
    return null
  }
}
