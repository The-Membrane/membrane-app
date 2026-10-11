import { resolveIssuedHolderExitSubject } from './holderExitMechanisms'

export const FLUID_LIQUIDITY = '0x52aa899454998be5b000ad077a46bbe360f4e497'
export const FLUID_LIQUIDITY_RESOLVER = '0xca13a15de31235a37134b4717021c35a3cf25c60'
export const FLUID_CAPACITY_ORIGIN_HOSTS = Object.freeze([
  'eth-mainnet.g.alchemy.com',
  'rpc.ankr.com',
])
export const FLUID_SOURCE_REFERENCES = Object.freeze({
  resolver: 'https://etherscan.io/address/0xca13A15de31235A37134B4717021C35A3CF25C60#code',
  registry:
    'https://github.com/Instadapp/fluid-contracts-public/blob/main/deployments/deployments.md',
  baseFToken:
    'https://github.com/Instadapp/fluid-contracts-public/blob/d96dad8960144f26580bda246f64d4555702da94/contracts/protocols/lending/fToken/main.sol',
})
const ROUTES = ['USDC → Fluid USD Coin [USDC]', 'USDT → fToken [USDT]', 'GHO → fToken [GHO]']
export type FluidCapacitySource = {
  chainId: 1
  blockNumber: number
  blockHash: string
  blockTime: string
  finalized: true
}
export type FluidRuntimeIdentity = {
  address: string
  codeHash: string
  proxyInspection: 'not_read'
  implementationAddress: string | null
  implementationCodeHash: string | null
  beaconAddress: string | null
}
export type FluidCapacityOrigin = {
  host: string
  source: FluidCapacitySource
  routeKey: string
  destination: string
  asset: string
  assetDecimals: number
  identities: FluidRuntimeIdentity[]
  fTokenReportedSupplyRaw: string
  resolverSupplyRaw: string
  expandedWithdrawalLimitRaw: string
  withdrawableUntilLimitRaw: string
  resolverReportedWithdrawableRaw: string
  sharedLiquidityCashRaw: string
  limitParameters: {
    lastUpdateTimestamp: string
    expandPercent: string
    expandDuration: string
    baseWithdrawalLimitRaw: string
    decayEndTimestamp: string
    /** Resolver stored-space amount; not exchange-price normalized native assets. */
    reportedDecayAmountRaw: string
  }
}
export type FluidExitCapacity = {
  status: 'two_origin_fluid_protocol_capacity_prongs'
  routeKey: string
  destination: string
  asset: string
  assetDecimals: number
  source: FluidCapacitySource
  origins: [FluidCapacityOrigin, FluidCapacityOrigin]
  prongs: {
    fTokenReportedSupplyRaw: string
    resolverSupplyRaw: string
    expandedWithdrawalLimitRaw: string
    withdrawableUntilLimitRaw: string
    resolverReportedWithdrawableRaw: string
    sharedLiquidityCashRaw: string
    resolverExceedsDirectCash: boolean
  }
  methods: {
    supply: 'getData.liquidityBalance'
    withdrawalLimit: 'getUserSupplyData(fToken,asset)'
    cash: 'balanceOf(Liquidity)'
  }
  sourceEquivalence: 'unverified_at_captured_runtime'
  resolverExternalBalances: 'may_be_included_version_dependent'
  pause: 'unknown'
  authority: 'unknown'
  exactQSimulation: 'not_requested'
  executableMaximumRaw: null
  hypotheticalDepositCapacityRaw: null
  holderExecutableExit: false
  forecastValidated: false
  prospectiveValidated: false
  minedPayoutObserved: false
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const address = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v)
const hash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v)
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < 1n << 256n
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
export function isFluidExitCapacitySubject(v: unknown): boolean {
  if (
    !record(v) ||
    typeof v.routeKey !== 'string' ||
    !ROUTES.includes(v.routeKey) ||
    !address(v.destination) ||
    !address(v.asset)
  )
    return false
  const subject = resolveIssuedHolderExitSubject(v.routeKey, v.destination)
  return (
    !!subject?.canonicalFinalAsset &&
    subject.mechanism === 'atomic' &&
    subject.canonicalFinalAsset.address === v.asset &&
    subject.canonicalFinalAsset.decimals === v.assetDecimals
  )
}
const exact = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => exact(v, b[i]))
    )
  if (record(a) || record(b))
    return (
      record(a) &&
      record(b) &&
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => Object.hasOwn(b, k) && exact(a[k], b[k]))
    )
  return Object.is(a, b)
}
function validOrigin(v: unknown): v is FluidCapacityOrigin {
  if (
    !record(v) ||
    typeof v.host !== 'string' ||
    !FLUID_CAPACITY_ORIGIN_HOSTS.includes(v.host) ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(v.host) ||
    !record(v.source)
  )
    return false
  const s = v.source
  if (
    s.chainId !== 1 ||
    s.finalized !== true ||
    !Number.isSafeInteger(s.blockNumber) ||
    (s.blockNumber as number) <= 0 ||
    !hash(s.blockHash) ||
    !utc(s.blockTime) ||
    typeof v.routeKey !== 'string' ||
    !ROUTES.includes(v.routeKey) ||
    !address(v.destination) ||
    !address(v.asset)
  )
    return false
  const subject = resolveIssuedHolderExitSubject(v.routeKey, v.destination)
  if (
    !subject?.canonicalFinalAsset ||
    subject.mechanism !== 'atomic' ||
    subject.canonicalFinalAsset.address !== v.asset ||
    subject.canonicalFinalAsset.decimals !== v.assetDecimals
  )
    return false
  if (!Array.isArray(v.identities) || v.identities.length !== 4) return false
  const expected = [v.destination, v.asset, FLUID_LIQUIDITY, FLUID_LIQUIDITY_RESOLVER]
  if (
    !v.identities.every(
      (id, i) =>
        record(id) &&
        id.address === expected[i] &&
        hash(id.codeHash) &&
        id.proxyInspection === 'not_read' &&
        id.implementationAddress === null &&
        id.implementationCodeHash === null &&
        id.beaconAddress === null,
    )
  )
    return false
  const fields = [
    'fTokenReportedSupplyRaw',
    'resolverSupplyRaw',
    'expandedWithdrawalLimitRaw',
    'withdrawableUntilLimitRaw',
    'resolverReportedWithdrawableRaw',
    'sharedLiquidityCashRaw',
  ] as const
  if (
    !fields.every((k) => raw(v[k])) ||
    !record(v.limitParameters) ||
    Object.keys(v.limitParameters).length !== 6 ||
    ![
      'lastUpdateTimestamp',
      'expandPercent',
      'expandDuration',
      'baseWithdrawalLimitRaw',
      'decayEndTimestamp',
      'reportedDecayAmountRaw',
    ].every((k) => raw((v.limitParameters as Record<string, unknown>)[k]))
  )
    return false
  const S = BigInt(v.resolverSupplyRaw as string),
    W = BigInt(v.expandedWithdrawalLimitRaw as string)
  return (
    BigInt(v.withdrawableUntilLimitRaw as string) === (S > W ? S - W : 0n) &&
    BigInt(v.resolverReportedWithdrawableRaw as string) <=
      BigInt(v.withdrawableUntilLimitRaw as string)
  )
}
/** Contract-reported prongs only: source-equivalence and executable capacity remain unproved. */
export function agreeFluidExitCapacity(first: unknown, second: unknown): FluidExitCapacity | null {
  try {
    if (!validOrigin(first) || !validOrigin(second) || first.host === second.host) return null
    const { host: _a, ...a } = first,
      { host: _b, ...b } = second
    if (!exact(a, b)) return null
    return {
      status: 'two_origin_fluid_protocol_capacity_prongs',
      routeKey: first.routeKey,
      destination: first.destination,
      asset: first.asset,
      assetDecimals: first.assetDecimals,
      source: structuredClone(first.source),
      origins: [structuredClone(first), structuredClone(second)],
      prongs: {
        fTokenReportedSupplyRaw: first.fTokenReportedSupplyRaw,
        resolverSupplyRaw: first.resolverSupplyRaw,
        expandedWithdrawalLimitRaw: first.expandedWithdrawalLimitRaw,
        withdrawableUntilLimitRaw: first.withdrawableUntilLimitRaw,
        resolverReportedWithdrawableRaw: first.resolverReportedWithdrawableRaw,
        sharedLiquidityCashRaw: first.sharedLiquidityCashRaw,
        resolverExceedsDirectCash:
          BigInt(first.resolverReportedWithdrawableRaw) > BigInt(first.sharedLiquidityCashRaw),
      },
      methods: {
        supply: 'getData.liquidityBalance',
        withdrawalLimit: 'getUserSupplyData(fToken,asset)',
        cash: 'balanceOf(Liquidity)',
      },
      sourceEquivalence: 'unverified_at_captured_runtime',
      resolverExternalBalances: 'may_be_included_version_dependent',
      pause: 'unknown',
      authority: 'unknown',
      exactQSimulation: 'not_requested',
      executableMaximumRaw: null,
      hypotheticalDepositCapacityRaw: null,
      holderExecutableExit: false,
      forecastValidated: false,
      prospectiveValidated: false,
      minedPayoutObserved: false,
    }
  } catch {
    return null
  }
}
export function selectedFluidExitCapacity(
  value: unknown,
  expected: {
    routeKey: string
    destination: string
    asset: string
    assetDecimals: number
    source: FluidCapacitySource
  },
): FluidExitCapacity | null {
  try {
    if (
      !record(value) ||
      !Array.isArray(value.origins) ||
      value.origins.length !== 2 ||
      !record(expected)
    )
      return null
    const result = agreeFluidExitCapacity(value.origins[0], value.origins[1])
    if (
      !result ||
      !exact(result, value) ||
      result.routeKey !== expected.routeKey ||
      result.destination !== expected.destination ||
      result.asset !== expected.asset ||
      result.assetDecimals !== expected.assetDecimals ||
      !exact(result.source, expected.source)
    )
      return null
    return result
  } catch {
    return null
  }
}
