import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi } from 'viem'
import {
  stusdsPinnedProtocolHistory,
  type StusdsProtocolPoint,
} from './stusdsProtocolCapacityHistoryPins'
import {
  stusdsRayPow,
  type StusdsCurrentCapacityEvidence,
} from './stusdsHistoricalHolderCapacityProjection'

const MAX = (1n << 256n) - 1n,
  RAY = 10n ** 27n
const VAULT = '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9'
const ASSET = '0xdc035d45d973e3ec169d2276ddab16f1e407384f'
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const abi = parseAbi([
  'function vat() view returns(address)',
  'function jug() view returns(address)',
  'function clip() view returns(address)',
  'function ilk() view returns(bytes32)',
  'function totalSupply() view returns(uint256)',
  'function chi() view returns(uint192)',
  'function str() view returns(uint256)',
  'function rho() view returns(uint64)',
  'function convertToAssets(uint256) view returns(uint256)',
  'function base() view returns(uint256)',
  'function drip(bytes32) returns(uint256)',
  'function Due() view returns(uint256)',
])
const vatAbi = parseAbi([
  'function ilks(bytes32) view returns(uint256 Art,uint256 rate,uint256 spot,uint256 line,uint256 dust)',
])
const jugAbi = parseAbi(['function ilks(bytes32) view returns(uint256 duty,uint256 rho)'])
export type StusdsProtocolSource = {
  chainId: 1
  blockNumber: number
  blockHash: string
  blockTime: string
  finalized: true
}
export type StusdsProtocolTrace = {
  key: string
  method: string
  params: unknown[]
  result: unknown
}
export type StusdsProtocolOriginObservation = {
  source: StusdsProtocolSource
  readAtUtc: string
  nativeIdentity: { assetAddress: string; assetDecimals: 18; shareDecimals: 18 }
  coreRuntimeCodes: { proxy: string; asset: string }
  traces: StusdsProtocolTrace[]
}
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const hashHex = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v)
const code = (v: unknown): v is `0x${string}` =>
  typeof v === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(v) && v.length <= 262146
const address = (v: unknown): v is string =>
  typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v) && v !== '0x' + '0'.repeat(40)
const equal = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => equal(v, b[i]))
    )
  if ((a !== null && typeof a === 'object') || (b !== null && typeof b === 'object'))
    return (
      a !== null &&
      b !== null &&
      typeof a === 'object' &&
      typeof b === 'object' &&
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => Object.hasOwn(b, k) && equal((a as any)[k], (b as any)[k]))
    )
  return Object.is(a, b)
}
const uint = (v: unknown): bigint => {
  if (typeof v !== 'bigint' || v < 0n || v > MAX) throw Error('uint')
  return v
}
const checked = (v: bigint) => {
  if (v < 0n || v > MAX) throw Error('overflow')
  return v
}
function call(key: string, to: string, name: string, args: unknown[] = [], a = abi) {
  return {
    key,
    method: 'eth_call',
    params: [{ to, data: encodeFunctionData({ abi: a, functionName: name, args } as any) }],
    name,
    abi: a,
  }
}
export function stusdsProtocolReadPlan(source: StusdsProtocolSource) {
  const s = structuredClone(source),
    pin = { blockHash: s.blockHash, requireCanonical: true }
  const p = stusdsPinnedProtocolHistory().history.points[0]
  const specs = [
    { key: 'implementation_slot', method: 'eth_getStorageAt', params: [VAULT, SLOT] },
    ...['vat', 'jug', 'clip', 'ilk', 'totalSupply', 'chi', 'str', 'rho'].map((n) =>
      call(n, VAULT, n),
    ),
    call('chiNow', VAULT, 'convertToAssets', [RAY]),
    ...['implementation', 'vat', 'jug', 'clip'].map((k) => ({
      key: 'code_' + k,
      method: 'eth_getCode',
      params: [p.addresses[k as keyof typeof p.addresses]],
    })),
    call('vatIlks', p.addresses.vat, 'ilks', [p.ilk], vatAbi),
    call('jugIlks', p.addresses.jug, 'ilks', [p.ilk], jugAbi),
    call('jugBase', p.addresses.jug, 'base'),
    call('burnRateNow', p.addresses.jug, 'drip', [p.ilk]),
    call('clipDue', p.addresses.clip, 'Due'),
    call('clipIlk', p.addresses.clip, 'ilk'),
    call('jugVat', p.addresses.jug, 'vat'),
  ]
  return specs.map((x) => ({ ...x, params: [...x.params, pin] }))
}
/** Raw observations are issued by the native reader's independently finalized/header-enclosed boundary.
 * Hosts and source must come from that server boundary, never a client envelope's own defaults.
 * Code hashes identify the observed class; they do not prove published-source equivalence. */
export function replayStusdsCurrentProtocolOrigin(
  value: unknown,
  expectedSource: StusdsProtocolSource,
  asOfMs: number,
  hash: (s: string) => string,
): StusdsProtocolPoint | null {
  try {
    const o = structuredClone(value) as StusdsProtocolOriginObservation,
      s = structuredClone(expectedSource)
    if (
      !Number.isSafeInteger(asOfMs) ||
      s.chainId !== 1 ||
      s.finalized !== true ||
      !Number.isSafeInteger(s.blockNumber) ||
      s.blockNumber < 1 ||
      !hashHex(s.blockHash) ||
      !utc(s.blockTime) ||
      !equal(o.source, s) ||
      !utc(o.readAtUtc) ||
      Date.parse(s.blockTime) > Date.parse(o.readAtUtc) ||
      Date.parse(o.readAtUtc) > asOfMs ||
      asOfMs - Date.parse(s.blockTime) > 1800000
    )
      return null
    if (!equal(o.nativeIdentity, { assetAddress: ASSET, assetDecimals: 18, shareDecimals: 18 }))
      return null
    const plan = stusdsProtocolReadPlan(s),
      pinned = stusdsPinnedProtocolHistory().history.points[0]
    if (!Array.isArray(o.traces) || o.traces.length !== 21 || JSON.stringify(o).length > 1500000)
      return null
    const by = new Map(o.traces.map((t) => [t.key, t]))
    if (by.size !== 21) return null
    for (const p of plan) {
      const t = by.get(p.key)
      if (!t || t.method !== p.method || !equal(t.params, p.params) || typeof t.result !== 'string')
        return null
    }
    const get = (key: string) => {
      const p = plan.find((x) => x.key === key) as any
      const result = by.get(key)!.result
      if (!code(result)) throw Error('hex')
      return decodeFunctionResult({ abi: p.abi, functionName: p.name, data: result })
    }
    const d = pinned.addresses
    for (const k of ['vat', 'jug', 'clip'] as const)
      if (String(get(k)).toLowerCase() !== d[k] || !address(d[k])) return null
    if (
      get('ilk') !== pinned.ilk ||
      get('clipIlk') !== pinned.ilk ||
      String(get('jugVat')).toLowerCase() !== d.vat
    )
      return null
    if (by.get('implementation_slot')!.result !== '0x' + '0'.repeat(24) + d.implementation.slice(2))
      return null
    const runtime: any = {}
    for (const k of ['proxy', 'asset', 'implementation', 'vat', 'jug', 'clip'] as const) {
      const c = k === 'proxy' || k === 'asset' ? o.coreRuntimeCodes[k] : by.get('code_' + k)!.result
      if (!code(c)) return null
      runtime[k] = { keccak256: keccak256(c), sha256: hash(c) }
      if (!equal(runtime[k], pinned.runtimeIdentities[k])) return null
    }
    const S = uint(get('totalSupply')),
      chi = uint(get('chi')),
      str = uint(get('str')),
      rho = uint(get('rho')),
      chiNow = uint(get('chiNow'))
    const [Art, rate] = get('vatIlks') as readonly bigint[],
      [duty, jugRho] = get('jugIlks') as readonly bigint[]
    const base = uint(get('jugBase')),
      burn = uint(get('burnRateNow')),
      Due = uint(get('clipDue')),
      at = Date.parse(s.blockTime) / 1000
    ;[Art, rate, duty, jugRho].forEach(uint)
    if (rho > BigInt(at) || jugRho > BigInt(at) || chiNow === 0n) return null
    const accrue = (b: bigint, index: bigint, t: bigint) => {
      const power = stusdsRayPow(String(b), Number(t))
      if (power === null) throw Error('rpow')
      return checked(BigInt(power) * index) / RAY
    }
    if (
      accrue(str, chi, BigInt(at) - rho) !== chiNow ||
      accrue(checked(base + duty), rate, BigInt(at) - jugRho) !== burn
    )
      return null
    const unused = (r: bigint) => {
      const assets = checked(S * chiNow),
        debt = checked(checked(Art * r) + Due)
      return String(assets > debt ? (assets - debt) / RAY : 0n)
    }
    const getterKnown = base === 0n || jugRho === BigInt(at)
    return {
      source: {
        chainId: 1,
        blockNumber: String(s.blockNumber),
        blockHash: s.blockHash,
        blockTime: s.blockTime,
        finalized: true,
      },
      status: 'conditional_contract_reported_prongs',
      addresses: structuredClone(d),
      ilk: pinned.ilk,
      runtimeIdentities: runtime,
      globalProngs: {
        totalSupplyRaw: String(S),
        chiRaw: String(chi),
        strRaw: String(str),
        rhoUnix: String(rho),
        chiNowRaw: String(chiNow),
        vatArtRaw: String(Art),
        vatStoredRateRaw: String(rate),
        jugDutyRaw: String(duty),
        jugRhoUnix: String(jugRho),
        jugBaseRaw: String(base),
        burnRateNowRaw: String(burn),
        clipDueRaw: String(Due),
        units: structuredClone(pinned.globalProngs.units),
        unusedFundsBurnRaw: unused(burn),
        unusedFundsGetterRaw: getterKnown ? unused(burn) : null,
        getterRateBasis: getterKnown
          ? 'conditional_official_rule_same_as_burn'
          : 'unknown_base_nonzero_elapsed',
        method: pinned.globalProngs.method,
        sourceRuleEquivalence: 'unverified',
        retainedImplementationMatches: true,
        derivationEligibility: 'conditional_retained_runtime_class',
      },
      missingLegs: [],
      sourceImplementationEquivalence: false,
      holderExecutableExit: false,
      forecastValidated: false,
    } as StusdsProtocolPoint
  } catch {
    return null
  }
}
export function replayStusdsCurrentProtocolCapacityEvidence(
  value: unknown,
  expected: { source: StusdsProtocolSource; asOfMs: number; originHosts: readonly string[] },
  hash: (s: string) => string,
): StusdsCurrentCapacityEvidence | null {
  try {
    const v = structuredClone(value) as {
        origins: { host: string; observation: StusdsProtocolOriginObservation }[]
      },
      e = structuredClone(expected)
    if (
      !Array.isArray(e.originHosts) ||
      e.originHosts.length !== 2 ||
      e.originHosts.some(
        (h) => typeof h !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(h),
      ) ||
      new Set(e.originHosts).size !== 2 ||
      !Array.isArray(v.origins) ||
      v.origins.length !== 2 ||
      !equal(v.origins.map((x) => x.host).sort(), [...e.originHosts].sort())
    )
      return null
    const points = v.origins.map((x) =>
      replayStusdsCurrentProtocolOrigin(x.observation, e.source, e.asOfMs, hash),
    )
    if (!points[0] || !points[1] || !equal(points[0], points[1])) return null
    const readAtUtc = v.origins
      .map((x) => x.observation.readAtUtc)
      .sort()
      .at(-1)!
    const captureReceiptSha256 = hash(JSON.stringify(v))
    if (typeof captureReceiptSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(captureReceiptSha256))
      return null
    return { point: points[0], readAtUtc, captureReceiptSha256 }
  } catch {
    return null
  }
}

/** Adapter for the model's mandatory callback; authority remains the external native read boundary. */
export function acceptStusdsCurrentProtocolCapacityEvidence(
  current: StusdsCurrentCapacityEvidence,
  record: unknown,
  expected: { source: StusdsProtocolSource; asOfMs: number; originHosts: readonly string[] },
  hash: (s: string) => string,
): boolean {
  try {
    const selected = structuredClone(current)
    const approved = replayStusdsCurrentProtocolCapacityEvidence(record, expected, hash)
    return approved !== null && equal(selected, approved)
  } catch {
    return false
  }
}
