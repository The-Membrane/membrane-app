import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ExitPressureCard,
  formatExitPressureSignedRaw,
  type ExitPressureCardProps,
  type ExitPressureFluidUsdcBridgeJointIssue,
} from '@/components/Carry/ExitPressureCard'
import { holderFluidUsdcBridgeJointIssueFromResponse } from '@/components/Carry/ForecastWorkbench'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, encodeFunctionResult, type AbiParameter } from 'viem'
import { FLUID_USDC_BRIDGE_NATIVE_ABI } from '@/lib/carry/fluidUsdcBridgeNativeAbi'
import {
  readFluidUsdcBridgeNativeCapacityFact,
  FLUID_USDC_BRIDGE_NATIVE_ASSET as ASSET,
  FLUID_USDC_BRIDGE_NATIVE_VAULT as VAULT,
  FLUID_USDC_BRIDGE_FUSDC as FUSDC,
  FLUID_USDC_BRIDGE_BANK as BANK,
  FLUID_USDC_BRIDGE_IMPLEMENTATION as IMPLEMENTATION,
} from '@/lib/carry/fluidUsdcBridgeNativeCapacity'
import {
  buildHolderExitCapacityQuote,
  agreeHolderExitCapacityQuotes,
} from '@/lib/carry/holderExitCapacity'
import type { HolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import type { FluidBridgeUsdcFrame } from '@/lib/carry/fluidBridgeUsdcJointHistoricalProcess'
import {
  issuedFluidUsdcBridgeJointHolderForecast,
  selectedFluidUsdcBridgeJointHolderForecastFromIssue,
  FLUID_USDC_BRIDGE_JOINT_ROUTE as ROUTE,
} from '@/lib/carry/fluidUsdcBridgeJointHolderForecastBinding'

// Isolated issuer orchestration controls. Decoder/profile are mocked; current
// facts use real canonical ABI replay. This is not native acquisition evidence.
const fixtures = vi.hoisted(() => ({ profile: null as unknown }))
vi.mock('@/lib/carry/fluidUsdcBridgeJointTrustedProfile', () => ({
  resolveFluidUsdcBridgeJointTrustedProfile: () => fixtures.profile,
}))
vi.mock('@/lib/carry/fluidUsdcBridgeJointNativeEvidenceCodec', () => ({
  decodeFluidUsdcBridgeJointNativeHistoryEvidence: (v: {
    schema?: string
    acquiredAtUtc: string
    frames: FluidBridgeUsdcFrame[]
  }) =>
    v?.schema === 'controlled_native_history_fixture'
      ? {
          profileId: 'controlled-profile',
          acquiredAtUtc: v.acquiredAtUtc,
          frames: structuredClone(v.frames),
          originalAuthority: false,
          authenticated: false,
        }
      : null,
}))
const NOW = Date.parse('2026-10-08T12:00:00.000Z'),
  owner = '0x1234567890123456789012345678901234567890'
const source = {
  chainId: 1 as const,
  blockNumber: 26000000,
  blockHash: '0x' + 'a'.repeat(64),
  blockTime: new Date(NOW - 120000).toISOString(),
  finalized: true as const,
}
function zero(p: AbiParameter): unknown {
  if (p.type === 'tuple')
    return (p as AbiParameter & { components: AbiParameter[] }).components.map(zero)
  return p.type === 'address' ? '0x' + '0'.repeat(40) : p.type === 'bool' ? false : 0n
}
async function fixture() {
  const request = async (r: { method: string; params: unknown[] }) => {
    if (r.method === 'eth_getCode') return '0x6000'
    if (r.method === 'eth_getStorageAt') return '0x' + '0'.repeat(24) + IMPLEMENTATION.slice(2)
    const c = r.params[0] as { to: string; data: `0x${string}` },
      d = decodeFunctionData({ abi: FLUID_USDC_BRIDGE_NATIVE_ABI, data: c.data })
    let result: unknown
    switch (d.functionName) {
      case 'asset':
        result = ASSET
        break
      case 'decimals':
        result = c.to === VAULT ? 18 : 6
        break
      case 'getFUSDC':
        result = FUSDC
        break
      case 'getWithdrawalFeeBPS':
        result = 5n
        break
      case 'isWithdrawalsPaused':
        result = false
        break
      case 'balanceOf':
        result = c.to === VAULT ? 3000000000000000000n : 9000000n
        break
      case 'previewRedeem':
        expect(d.args).toEqual([3000000000000000000n])
        result = 7000000n
        break
      case 'maxWithdraw':
        result = 5000000n
        break
      case 'LIQUIDITY':
        result = BANK
        break
      case 'getData':
        result = [BANK, ...Array(4).fill('0x' + '0'.repeat(40)), false, 8000000n, 1n, 1n]
        break
      case 'getUserSupplyData': {
        const a = FLUID_USDC_BRIDGE_NATIVE_ABI.find(
          (a) => a.type === 'function' && a.name === d.functionName,
        ) as unknown as { outputs: AbiParameter[] }
        const supply = zero(a.outputs[0]) as unknown[]
        supply[7] = 6000000n
        supply[8] = 5500000n
        result = [supply, zero(a.outputs[1])]
        break
      }
      default:
        throw Error('unexpected controlled native call')
    }
    return encodeFunctionResult({
      abi: FLUID_USDC_BRIDGE_NATIVE_ABI,
      functionName: d.functionName,
      result,
    } as never)
  }
  const native = await readFluidUsdcBridgeNativeCapacityFact(
    request,
    owner,
    source,
    () => NOW - 60000,
  )
  expect(native).not.toBeNull()
  const n = native!
  fixtures.profile = {
    profileId: 'controlled-profile',
    routeKey: ROUTE,
    destination: VAULT,
    asset: ASSET,
    assetDecimals: 6,
    shareDecimals: 18,
    runtimeCodeHashes: n.runtimeCodeHashes,
    feeBps: 5,
    maxHistoricalGapSeconds: 91800,
  }
  const assessment: HolderExitAssessment = {
    status: 'assessed',
    routeKey: ROUTE,
    destinationAddress: VAULT,
    owner,
    request: { assetsRaw: '1000000', assetAddress: ASSET, horizonHours: 24 },
    source: {
      ...source,
      blockHash: source.blockHash as `0x${string}`,
      originValidation: 'single_provider',
    },
    stages: [
      {
        name: 'withdrawal',
        assetAddress: ASSET,
        amountRaw: '1000000',
        status: 'reverted',
        relatedToRequest: true,
      },
    ],
    finalPayout: { assetAddress: ASSET, amountRaw: null, status: 'unassessed' },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
  }
  const quote = buildHolderExitCapacityQuote(
    assessment,
    {
      entitlementRaw: n.fullNetEaRaw,
      quotedMaxWithdrawRaw: '5000000',
      quotedMaxWithdrawStatus: 'quoted',
      effectiveLimitRaw: null,
      withdrawalsPaused: null,
      sourceHolderPosition: {
        sharesRaw: n.sharesRaw,
        shareDecimals: 18,
        method: 'balance_of_owner_at_source',
      },
      fluidUsdcBridgeNativeCapacity: n,
    },
    NOW,
  )!
  expect(quote).not.toBeNull()
  const capacity = agreeHolderExitCapacityQuotes(
    { host: 'eth-mainnet.g.alchemy.com', quote },
    { host: 'rpc.ankr.com', quote },
    NOW,
  )!
  const frame = (day: number, C: string): FluidBridgeUsdcFrame => ({
    source: {
      chainId: 1,
      blockNumber: String(source.blockNumber + day),
      blockHash: '0x' + String(day + 5).repeat(64),
      blockTime: new Date(Date.parse(source.blockTime) + day * 86400000).toISOString(),
    },
    availableAtUtc: new Date(NOW - 30000).toISOString(),
    acquiredAtUtc: new Date(NOW - 30000).toISOString(),
    provenanceRef: 'controlled:' + day,
    holderSharesRaw: n.sharesRaw,
    shareDecimals: 18,
    asset: ASSET,
    assetDecimals: 6,
    fundingUnit: 'gross_native_USDC',
    entitlementUnit: 'net_native_USDC',
    runtimeCodeHashes: { ...n.runtimeCodeHashes },
    regime: 'controlled-profile',
    paused: false,
    withdrawalFeeBps: 5,
    fullHolderNetUsdcRaw: n.fullNetEaRaw,
    nativeProngs: { ...n.nativeProngs, bridgeFunding: C },
    provenanceKind: 'native_hypothetical_shares',
    owner: null,
    historicalOwnership: false,
  })
  const history = {
    schema: 'controlled_native_history_fixture',
    acquiredAtUtc: new Date(NOW - 30000).toISOString(),
    frames: [frame(-3, '3000000'), frame(-2, '3100000'), frame(-1, '3200000')],
  }
  const q = {
    routeKey: ROUTE,
    destination: VAULT,
    requestedHolderAddress: owner,
    requestedRaw: '1000000',
    requestedAssetAddress: ASSET,
    requestedAssetDecimals: 6,
    horizonHours: 24,
    asOfMs: NOW,
    independentSource: source,
  }
  return { capacity, history, q }
}

beforeEach(() => {
  fixtures.profile = null
})
function base(q: ExitPressureFluidUsdcBridgeJointIssue['question']): ExitPressureCardProps {
  return {
    routeKey: q.routeKey,
    destination: q.destination,
    requestedAmount: '1',
    requestedRaw: q.requestedRaw,
    requestedAssetSymbol: 'USDC',
    requestedAssetAddress: q.requestedAssetAddress,
    requestedAssetDecimals: 6,
    requestedHolderAddress: q.requestedHolderAddress,
    horizonHours: q.horizonHours,
    asOfMs: NOW,
    currentCash: null,
    prospectiveCashModel: null,
    historicalScenario: null,
    grossWithdrawals: null,
    grossInflows: null,
    historicalGrossFlow: null,
    morphoPayout: null,
    holderAssessment: null,
    expectedEventEnrollment: null,
    eventContext: null,
    historicalOutlook: null,
  }
}
function render(
  retained: ExitPressureFluidUsdcBridgeJointIssue,
  overrides: Partial<ExitPressureCardProps> = {},
) {
  return renderToStaticMarkup(
    <ChakraProvider>
      <ExitPressureCard
        {...base(retained.question)}
        holderFluidUsdcBridgeJointIssue={retained}
        {...overrides}
      />
    </ChakraProvider>,
  ).replaceAll(/<style[\s\S]*?<\/style>/g, '')
}
async function retainedFixture() {
  const f = await fixture()
  const response = {
    capacityAgreement: f.capacity,
    fluidUsdcBridgeJointHistoricalEvidence: f.history,
    fluidUsdcBridgeJointIssuedAtUtc: new Date(NOW).toISOString(),
  }
  const retained = holderFluidUsdcBridgeJointIssueFromResponse(response, 200, f.q, NOW + 1)!
  expect(retained).not.toBeNull()
  const original = selectedFluidUsdcBridgeJointHolderForecastFromIssue(
    retained.issue,
    retained.question,
    NOW,
  )!
  expect(original).not.toBeNull()
  const summary = original.process.targetSummary!
  const band = `${formatExitPressureSignedRaw(summary.empiricalP10HeadroomRaw, 6)}–${formatExitPressureSignedRaw(summary.empiricalP90HeadroomRaw, 6)} USDC`
  return { ...f, retained, original, band }
}
describe('Fluid bridge genuine private issuer SSR (controlled unsigned decoder and native wire fixtures)', () => {
  it('renders only the original private empirical band and actual issue+H target', async () => {
    const f = await retainedFixture()
    expect(render(f.retained)).toContain(f.band)
    expect(render(f.retained)).toContain('Expected headroom')
    expect(f.original.targetAtUtc).toBe(new Date(NOW + 86400000).toISOString())
    expect(f.original.originalAuthority).toBe(false)
    expect(f.original.authenticated).toBe(false)
    expect(f.original.executionProven).toBe(false)
  })
  it('retained same-source C and historical mutations cannot replace original band', async () => {
    const f = await retainedFixture()
    for (const origin of f.capacity.origins)
      origin.quote.fluidUsdcBridgeNativeCapacity!.nativeProngs.bridgeFunding = '0'
    for (const frame of f.history.frames) frame.nativeProngs.bridgeFunding = '0'
    f.retained.capacityAgreement = f.capacity
    f.retained.historicalEvidence = f.history
    expect(render(f.retained)).toContain(f.band)
    expect(
      selectedFluidUsdcBridgeJointHolderForecastFromIssue(
        f.retained.issue,
        f.retained.question,
        NOW,
      ),
    ).toBe(f.original)
    expect(issuedFluidUsdcBridgeJointHolderForecast(f.capacity, f.history, f.q)).toBeNull()
  })
  it('cloned/forged receipts, wrong complete question and advancing expired clock cannot headline', async () => {
    const f = await retainedFixture()
    expect(render({ ...f.retained, issue: structuredClone(f.retained.issue) })).not.toContain(
      f.band,
    )
    expect(render({ ...f.retained, issue: { ...f.retained.issue } })).not.toContain(f.band)
    expect(
      render({ ...f.retained, question: { ...f.retained.question, asOfMs: NOW + 1 } }),
    ).not.toContain(f.band)
    expect(
      render({
        ...f.retained,
        question: {
          ...f.retained.question,
          independentSource: { ...source, blockHash: '0x' + 'b'.repeat(64) },
        },
      }),
    ).not.toContain(f.band)
    for (const overrides of [
      { requestedRaw: '2000000' },
      { horizonHours: 48 },
      { requestedHolderAddress: '0x' + '2'.repeat(40) },
      { requestedAssetAddress: '0x' + '2'.repeat(40) },
      { destination: '0x' + '2'.repeat(40) },
      { asOfMs: Date.parse(source.blockTime) + 1800001 },
    ])
      expect(render(f.retained, overrides)).not.toContain(f.band)
    expect(render({ ...f.retained, issue: structuredClone(f.retained.issue) })).toContain(
      'Expected headroom',
    )
  })
})
