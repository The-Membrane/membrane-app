/**
 * EXECUTION. Reads on the CONNECTED chain at execution time, the pre-signature simulation, and
 * the runner that sends the prompts in order. Builders stay pure (bundle.ts); this file is the
 * only one that talks to an RPC or a wallet.
 *
 * PRE-SIGNATURE SIMULATION: before any prompt, eth_simulateV1 runs, from the owner's address,
 *   [setPositionOperator (when not granted), approve(venue token → GA1), approve(proceeds → adapter),
 *    Bundler3.multicall(bundle without permit calls)]
 * An approve grants the same allowance a permit does, so this is the signed path with the
 * typed-data replaced by its effect. After the permits are signed, the exact bundle is simulated
 * again before the bundle prompt.
 *
 * Ported from feat/q27-lever-exec lib/position-exec/simulate.ts (eth_simulateV1 via viem
 * simulateCalls); that branch is not merged, so the minimal piece lives here.
 */

import {
  BaseError,
  decodeErrorResult,
  encodeAbiParameters,
  keccak256,
  maxUint256,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { simulateCalls } from 'viem/actions'

import { cdpAbi } from '@/contracts/abis/cdp'
import { membraneBundlerAdapterAbi } from '@/contracts/abis/membraneBundlerAdapter'

import { bundler3Abi, cdpOperatorAbi, morphoAbi, permitTokenAbi } from './abis'
import type { MigrateChainConfig } from './addresses'
import {
  buildAaveBundle,
  buildMorphoBundle,
  flashAmountFor,
  maxBorrowCdtFor,
  type BundlerCall,
  type MorphoMarketParams,
  type SignedMorphoAuthorization,
  type SignedPermit,
} from './bundle'
import { signMorphoAuthorization, signPermitExact } from './permit'
import { FLASH_BUFFER_BPS } from './plan'
import type { Address, MigrateSource, MigrateVenue } from './types'

export const GAS_BUFFER_PCT = 105n

const aaveReserveAbi = [
  {
    type: 'function',
    name: 'getReserveData',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'configuration', type: 'uint256' },
          { name: 'liquidityIndex', type: 'uint128' },
          { name: 'currentLiquidityRate', type: 'uint128' },
          { name: 'variableBorrowIndex', type: 'uint128' },
          { name: 'currentVariableBorrowRate', type: 'uint128' },
          { name: 'currentStableBorrowRate', type: 'uint128' },
          { name: 'lastUpdateTimestamp', type: 'uint40' },
          { name: 'id', type: 'uint16' },
          { name: 'aTokenAddress', type: 'address' },
          { name: 'stableDebtTokenAddress', type: 'address' },
          { name: 'variableDebtTokenAddress', type: 'address' },
          { name: 'interestRateStrategyAddress', type: 'address' },
          { name: 'accruedToTreasury', type: 'uint128' },
          { name: 'unbacked', type: 'uint128' },
          { name: 'isolationModeTotalDebt', type: 'uint128' },
        ],
      },
    ],
  },
] as const

const morphoMarketAbi = [
  {
    type: 'function',
    name: 'market',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'totalSupplyAssets', type: 'uint128' },
      { name: 'totalSupplyShares', type: 'uint128' },
      { name: 'totalBorrowAssets', type: 'uint128' },
      { name: 'totalBorrowShares', type: 'uint128' },
      { name: 'lastUpdate', type: 'uint128' },
      { name: 'fee', type: 'uint128' },
    ],
  },
] as const

export function morphoMarketId(p: MorphoMarketParams): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
      ],
      [p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv],
    ),
  )
}

// ------------------------------------------------------------------ chain readiness

export type Readiness =
  | { ok: true; cfg: MigrateChainConfig }
  | { ok: false; reason: string }

/** Plain reason when the connected chain cannot run this venue's migration. */
export function readiness(cfg: MigrateChainConfig | null, chainLabel: string, venue: MigrateVenue | null): Readiness {
  if (!cfg) return { ok: false, reason: `Membrane is not deployed on ${chainLabel}. Switch to a chain with a Membrane deployment.` }
  if (!cfg.cdp || !cfg.membraneAdapter) {
    return { ok: false, reason: `Membrane is not deployed on ${cfg.label} yet (pre-launch). The migration needs a Membrane Cdp and the migration adapter on the same chain as your position.` }
  }
  if (!cfg.bundler3 || !cfg.generalAdapter1 || !cfg.morpho) return { ok: false, reason: `Bundler3 is not deployed on ${cfg.label}.` }
  if (venue === 'aave-v3' && (!cfg.aaveV3Adapter || !cfg.aavePool)) return { ok: false, reason: `No Aave V3 migration adapter on ${cfg.label}.` }
  if (venue === 'spark' && (!cfg.sparkAdapter || !cfg.sparkPool)) return { ok: false, reason: `No Spark migration adapter on ${cfg.label}.` }
  return { ok: true, cfg }
}

// ------------------------------------------------------------------ reads

export interface ResolvedMigration {
  venue: MigrateVenue
  owner: Address
  debtToken: Address
  debtDecimals: number
  collateralToken: Address
  denom: `0x${string}`
  /** Exact debt read on the venue, in debt-token wei. */
  debtWei: bigint
  /** Exact collateral on the venue, in collateral-token wei. */
  collateralWei: bigint
  flashAmount: bigint
  maxBorrowCdt: bigint
  /** The token the owner permits to GA1 (aToken) — null for Morpho. */
  venueToken: Address | null
  venueTokenAmount: bigint
  morphoParams: MorphoMarketParams | null
  operatorGranted: boolean
  morphoAuthorized: boolean
  blockTime: bigint
}

export async function resolveMigration(
  client: PublicClient,
  cfg: MigrateChainConfig,
  source: MigrateSource,
  venue: MigrateVenue,
  owner: Address,
): Promise<ResolvedMigration | { error: string }> {
  const collSym = source.collateral[0]?.symbol
  const debtSym = source.debt[0]?.symbol
  const debtToken = debtSym ? cfg.tokens[debtSym] : undefined
  const collateralToken = collSym ? cfg.tokens[collSym] : undefined
  if (!debtToken || !collateralToken) return { error: `${collSym}/${debtSym} has no token address on ${cfg.label}.` }
  const denom = cfg.denoms[collateralToken.toLowerCase()]
  if (!denom) return { error: `${collSym} is not listed on Membrane on ${cfg.label}.` }
  if (!cfg.pairedAsset || cfg.pairedAsset.toLowerCase() !== debtToken.toLowerCase()) {
    return { error: `${debtSym} is not the peg asset on ${cfg.label}.` }
  }
  const [block, debtDecimals, operatorGranted] = await Promise.all([
    client.getBlock(),
    client.readContract({ address: debtToken, abi: permitTokenAbi, functionName: 'decimals' }),
    client.readContract({ address: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'positionOperator', args: [owner, cfg.membraneAdapter!] }),
  ])

  let debtWei: bigint
  let collateralWei: bigint
  let venueToken: Address | null = null
  let morphoParams: MorphoMarketParams | null = null
  let morphoAuthorized = false

  if (venue === 'aave-v3' || venue === 'spark') {
    const pool = (venue === 'aave-v3' ? cfg.aavePool : cfg.sparkPool)!
    const [collRes, debtRes] = await Promise.all([
      client.readContract({ address: pool, abi: aaveReserveAbi, functionName: 'getReserveData', args: [collateralToken] }),
      client.readContract({ address: pool, abi: aaveReserveAbi, functionName: 'getReserveData', args: [debtToken] }),
    ])
    venueToken = collRes.aTokenAddress
    ;[collateralWei, debtWei] = await Promise.all([
      client.readContract({ address: collRes.aTokenAddress, abi: permitTokenAbi, functionName: 'balanceOf', args: [owner] }),
      client.readContract({ address: debtRes.variableDebtTokenAddress, abi: permitTokenAbi, functionName: 'balanceOf', args: [owner] }),
    ])
  } else {
    const params = cfg.morphoMarket
    if (!params) return { error: `No Morpho market for ${collSym}/${debtSym} on ${cfg.label}.` }
    morphoParams = params
    const id = morphoMarketId(params)
    const [pos, mkt, authorized] = await Promise.all([
      client.readContract({ address: cfg.morpho!, abi: morphoAbi, functionName: 'position', args: [id, owner] }),
      client.readContract({ address: cfg.morpho!, abi: morphoMarketAbi, functionName: 'market', args: [id] }),
      client.readContract({ address: cfg.morpho!, abi: morphoAbi, functionName: 'isAuthorized', args: [owner, cfg.generalAdapter1!] }),
    ])
    const [, borrowShares, coll] = pos
    const [, , totalBorrowAssets, totalBorrowShares] = mkt
    // Morpho SharesMathLib.toAssetsUp with VIRTUAL_SHARES 1e6 / VIRTUAL_ASSETS 1
    debtWei = (borrowShares * (totalBorrowAssets + 1n) + (totalBorrowShares + 1_000_000n) - 1n) / (totalBorrowShares + 1_000_000n)
    collateralWei = coll
    morphoAuthorized = authorized
  }
  if (debtWei === 0n) return { error: `No ${debtSym} debt for this wallet on ${venue} on ${cfg.label}.` }
  if (collateralWei === 0n) return { error: `No ${collSym} collateral for this wallet on ${venue} on ${cfg.label}.` }

  const flashAmount = flashAmountFor(debtWei, FLASH_BUFFER_BPS)
  return {
    venue,
    owner,
    debtToken,
    debtDecimals: Number(debtDecimals),
    collateralToken,
    denom,
    debtWei,
    collateralWei,
    flashAmount,
    maxBorrowCdt: maxBorrowCdtFor(flashAmount, Number(debtDecimals)),
    venueToken,
    venueTokenAmount: venueToken ? flashAmountFor(collateralWei, FLASH_BUFFER_BPS) : 0n,
    morphoParams,
    operatorGranted,
    morphoAuthorized,
    blockTime: block.timestamp,
  }
}

// ------------------------------------------------------------------ bundle

export function bundleFor(
  cfg: MigrateChainConfig,
  r: ResolvedMigration,
  sigs: { venuePermit: SignedPermit | null; proceedsPermit: SignedPermit | null; morphoAuth: SignedMorphoAuthorization | null },
): BundlerCall[] {
  const membrane = { membraneAdapter: cfg.membraneAdapter!, positionId: 0n, denom: r.denom, maxBorrowCdt: r.maxBorrowCdt }
  if (r.venue === 'morpho-blue') {
    return buildMorphoBundle({
      generalAdapter1: cfg.generalAdapter1!,
      morpho: cfg.morpho!,
      owner: r.owner,
      params: r.morphoParams!,
      flashAmount: r.flashAmount,
      maxSharePriceE27: maxUint256,
      membrane,
      authorization: sigs.morphoAuth,
      proceedsPermit: sigs.proceedsPermit,
    })
  }
  return buildAaveBundle({
    generalAdapter1: cfg.generalAdapter1!,
    aaveAdapter: (r.venue === 'aave-v3' ? cfg.aaveV3Adapter : cfg.sparkAdapter)!,
    owner: r.owner,
    debtToken: r.debtToken,
    collateralToken: r.collateralToken,
    aToken: r.venueToken!,
    flashAmount: r.flashAmount,
    membrane,
    aTokenPermit: sigs.venuePermit,
    proceedsPermit: sigs.proceedsPermit,
  })
}

// ------------------------------------------------------------------ simulation

export type SimResult =
  | { ok: true; gas: bigint; bufferedGas: bigint; method: 'eth_simulateV1' }
  | { ok: false; step: number; reason: string }

type SimCall = { to: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }

/** Every custom error the bundle can surface: Cdp's and the adapter's. */
const ERROR_ABI = [...cdpAbi, ...membraneBundlerAdapterAbi].filter((e) => e.type === 'error')

/** Decoded custom-error name (and args) from raw revert data, else null. */
export function decodeRevert(data: `0x${string}` | undefined): string | null {
  if (!data || data === '0x') return null
  try {
    const d = decodeErrorResult({ abi: ERROR_ABI, data })
    const args = (d.args ?? []).map(String).join(', ')
    return args ? `${d.errorName}(${args})` : d.errorName
  } catch {
    return null
  }
}

function reasonOf(err: unknown): string {
  if (err instanceof BaseError) return err.shortMessage || err.message
  return err instanceof Error ? err.message : String(err)
}

async function simulate(client: PublicClient, owner: Address, calls: SimCall[]): Promise<SimResult> {
  try {
    const { results } = await simulateCalls(client, { account: owner, calls } as Parameters<typeof simulateCalls>[1])
    const failed = results.findIndex((r) => r.status !== 'success')
    if (failed >= 0) {
      const f = results[failed]
      return { ok: false, step: failed, reason: decodeRevert(f.data) ?? reasonOf(f.error) }
    }
    const gas = results.reduce((a, r) => a + r.gasUsed, 0n)
    return { ok: true, gas, bufferedGas: (gas * GAS_BUFFER_PCT) / 100n, method: 'eth_simulateV1' }
  } catch (err) {
    return { ok: false, step: -1, reason: `simulation unavailable: ${reasonOf(err)}` }
  }
}

/** The pre-signature simulation: approves stand in for the permits. */
export function preSignCalls(cfg: MigrateChainConfig, r: ResolvedMigration): SimCall[] {
  const calls: SimCall[] = []
  if (!r.operatorGranted) {
    calls.push({ to: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'setPositionOperator', args: [cfg.membraneAdapter!, true] })
  }
  if (r.venue === 'morpho-blue') {
    if (!r.morphoAuthorized) {
      calls.push({ to: cfg.morpho!, abi: setAuthorizationAbi, functionName: 'setAuthorization', args: [cfg.generalAdapter1!, true] })
    }
  } else {
    calls.push({ to: r.venueToken!, abi: permitTokenAbi, functionName: 'approve', args: [cfg.generalAdapter1!, r.venueTokenAmount] })
  }
  calls.push({ to: r.debtToken, abi: permitTokenAbi, functionName: 'approve', args: [cfg.membraneAdapter!, r.flashAmount] })
  calls.push({ to: cfg.bundler3!, abi: bundler3Abi, functionName: 'multicall', args: [bundleFor(cfg, r, { venuePermit: null, proceedsPermit: null, morphoAuth: null })] })
  return calls
}

const setAuthorizationAbi = [
  {
    type: 'function',
    name: 'setAuthorization',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'authorized', type: 'address' },
      { name: 'newIsAuthorized', type: 'bool' },
    ],
    outputs: [],
  },
] as const

export function simulatePreSign(client: PublicClient, cfg: MigrateChainConfig, r: ResolvedMigration): Promise<SimResult> {
  return simulate(client, r.owner, preSignCalls(cfg, r))
}

// ------------------------------------------------------------------ runner

export type RunEvent =
  | { kind: 'prompt'; id: string; index: number; total: number }
  | { kind: 'submitted'; id: string; hash: `0x${string}` }
  | { kind: 'mined'; id: string; hash: `0x${string}`; status: 'success' | 'reverted' }
  | { kind: 'simulated'; result: SimResult }

export interface RunResult {
  ok: boolean
  bundleHash: `0x${string}` | null
  reason?: string
}

/**
 * Prompts, in order: operator grant (skipped when standing), venue permit or Morpho authorization
 * (skipped when standing), proceeds permit, then — after a re-simulation of the exact bundle —
 * the bundle transaction.
 */
export async function runMigration(p: {
  client: PublicClient
  wallet: WalletClient
  cfg: MigrateChainConfig
  r: ResolvedMigration
  onEvent?: (e: RunEvent) => void
}): Promise<RunResult> {
  const { client, wallet, cfg, r } = p
  const emit = p.onEvent ?? (() => {})
  const steps = [
    !r.operatorGranted && 'operator',
    r.venue === 'morpho-blue' ? !r.morphoAuthorized && 'morpho-auth' : 'atoken-permit',
    'proceeds-permit',
    'bundle',
  ].filter(Boolean) as string[]
  let i = 0
  const prompt = (id: string) => emit({ kind: 'prompt', id, index: ++i, total: steps.length })

  if (!r.operatorGranted) {
    prompt('operator')
    const hash = await wallet.writeContract({
      account: r.owner,
      chain: wallet.chain,
      address: cfg.cdp!,
      abi: cdpOperatorAbi,
      functionName: 'setPositionOperator',
      args: [cfg.membraneAdapter!, true],
    })
    emit({ kind: 'submitted', id: 'operator', hash })
    const rc = await client.waitForTransactionReceipt({ hash })
    emit({ kind: 'mined', id: 'operator', hash, status: rc.status })
    if (rc.status !== 'success') return { ok: false, bundleHash: null, reason: 'the operator grant reverted' }
  }

  const now = (await client.getBlock()).timestamp
  let venuePermit: SignedPermit | null = null
  let morphoAuth: SignedMorphoAuthorization | null = null
  if (r.venue === 'morpho-blue') {
    if (!r.morphoAuthorized) {
      prompt('morpho-auth')
      morphoAuth = await signMorphoAuthorization({ client, wallet, morpho: cfg.morpho!, owner: r.owner, authorized: cfg.generalAdapter1!, now })
    }
  } else {
    prompt('atoken-permit')
    venuePermit = await signPermitExact({ client, wallet, token: r.venueToken!, owner: r.owner, spender: cfg.generalAdapter1!, value: r.venueTokenAmount, now })
  }
  prompt('proceeds-permit')
  const proceedsPermit = await signPermitExact({ client, wallet, token: r.debtToken, owner: r.owner, spender: cfg.membraneAdapter!, value: r.flashAmount, now })

  const bundle = bundleFor(cfg, r, { venuePermit, proceedsPermit, morphoAuth })
  const sim = await simulate(client, r.owner, [{ to: cfg.bundler3!, abi: bundler3Abi, functionName: 'multicall', args: [bundle] }])
  emit({ kind: 'simulated', result: sim })
  if (!sim.ok) return { ok: false, bundleHash: null, reason: sim.reason }

  prompt('bundle')
  const hash = await wallet.writeContract({
    account: r.owner,
    chain: wallet.chain,
    address: cfg.bundler3!,
    abi: bundler3Abi,
    functionName: 'multicall',
    args: [bundle],
  })
  emit({ kind: 'submitted', id: 'bundle', hash })
  const rc = await client.waitForTransactionReceipt({ hash })
  emit({ kind: 'mined', id: 'bundle', hash, status: rc.status })
  return rc.status === 'success' ? { ok: true, bundleHash: hash } : { ok: false, bundleHash: hash, reason: 'the bundle reverted on-chain' }
}
