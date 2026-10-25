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
  defineChain,
  encodeAbiParameters,
  keccak256,
  maxUint256,
  parseAbi,
  parseEventLogs,
  type Chain,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { getCapabilities, sendCalls, simulateCalls, waitForCallsStatus } from 'viem/actions'

import { cdpAbi } from '@/contracts/abis/cdp'
import { membraneBundlerAdapterAbi } from '@/contracts/abis/membraneBundlerAdapter'
import { cdpRouterAbi } from '@/contracts/abis/cdpRouter'

import { bundler3Abi, cdpOperatorAbi, collateralLtvAbi, membraneOracleAbi, morphoAbi, permitTokenAbi } from './abis'
import type { MigrateChainConfig } from './addresses'
import {
  buildAaveBundle,
  buildMorphoBundle,
  flashAmountFor,
  borrowCdtFor,
  type BundlerCall,
  type MorphoMarketParams,
  type SignedMorphoAuthorization,
  type SignedPermit,
} from './bundle'
import { signMorphoAuthorization, signPermitExact } from './permit'
import { ACCRUAL_BUFFER_BPS, LTV_MARGIN } from './plan'
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
  /** P: the debt read + ACCRUAL_BUFFER_BPS. Flash amount, exact borrow, exact proceeds permit. */
  flashAmount: bigint
  /** P in CDT units: the exact new Membrane debt. */
  borrowCdt: bigint
  /** The LTV cap passed to the adapter (1e18): live max LTV − 3pp − LTV_MARGIN. */
  maxLtvWad: bigint
  /** The collateral's live max LTV (1e18), Collateral.currentMaxLTV. */
  maxLtvOnchainWad: bigint
  /** The token the owner permits to GA1 (aToken) — null for Morpho. */
  venueToken: Address | null
  /** EXACTLY the aTokens read (the permit and the move use this amount; nothing left allowed). */
  venueTokenAmount: bigint
  morphoParams: MorphoMarketParams | null
  operatorGranted: boolean
  morphoAuthorized: boolean
  /** The owner's allowances BEFORE the run (review: the batch's exact approvals overwrite them;
   *  the batch ends by restoring these, and the leftover read compares against them). */
  prevVenueAllowance: bigint
  prevProceedsAllowance: bigint
  blockTime: bigint
  blockNumber: bigint
  collateralDecimals: number
  /** Membrane's own oracle price for the collateral (USD, 1e18) — the price the Cdp gates on. */
  membranePriceWad: bigint
}

const toNum = (v: bigint, decimals: number): number => {
  const d = 10n ** BigInt(decimals)
  return Number(v / d) + Number(v % d) / Number(d)
}

const WAD = 10n ** 18n
const BORROW_LTV_GAP_WAD = 3n * 10n ** 16n
const LTV_MARGIN_WAD = BigInt(Math.round(LTV_MARGIN * 1e18))

/** The source position re-stated as it stands on the connected chain, valued at Membrane's
 *  oracle price — the exact basis the Cdp's LTV gate uses. */
export function onchainSource(source: MigrateSource, r: ResolvedMigration, chainLabel: string): MigrateSource {
  const price = toNum(r.membranePriceWad, 18)
  const coll = toNum(r.collateralWei, r.collateralDecimals)
  const debt = toNum(r.debtWei, r.debtDecimals)
  const c0 = source.collateral[0]
  const d0 = source.debt[0]
  const collUsd = coll * price
  return {
    ...source,
    label: `${source.label} · read on ${chainLabel}`,
    collateral: [{ ...c0, address: r.collateralToken, decimals: r.collateralDecimals, amount: coll, priceUsd: price, valueUsd: collUsd }],
    debt: [{ ...d0, address: r.debtToken, decimals: r.debtDecimals, amount: debt, priceUsd: 1, valueUsd: debt }],
    totalCollateralUsd: collUsd,
    totalDebtUsd: debt,
    ltv: collUsd > 0 ? debt / collUsd : Number.POSITIVE_INFINITY,
  }
}

/** The plan options a resolved read implies: the live max LTV. */
export const planOptsFor = (r: ResolvedMigration) => ({ onchainMaxLtv: toNum(r.maxLtvOnchainWad, 18) })

/** The borrow's LTV at Membrane's price (1e18), the number the adapter checks. */
export function borrowLtvWad(r: ResolvedMigration): bigint {
  const collUsdWad = (r.collateralWei * r.membranePriceWad) / 10n ** BigInt(r.collateralDecimals)
  return collUsdWad === 0n ? maxUint256 : (r.borrowCdt * WAD) / collUsdWad
}

async function readMaxLtv(client: PublicClient, cfg: MigrateChainConfig, denom: `0x${string}`): Promise<bigint> {
  const collateral = await client.readContract({ address: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'collateral' })
  return client.readContract({ address: collateral, abi: collateralLtvAbi, functionName: 'currentMaxLTV', args: [denom] })
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
  const [block, debtDecimals, collateralDecimals, operatorGranted, oracle, maxLtvOnchainWad] = await Promise.all([
    client.getBlock(),
    client.readContract({ address: debtToken, abi: permitTokenAbi, functionName: 'decimals' }),
    client.readContract({ address: collateralToken, abi: permitTokenAbi, functionName: 'decimals' }),
    client.readContract({ address: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'positionOperator', args: [owner, cfg.membraneAdapter!] }),
    client.readContract({ address: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'oracle' }),
    readMaxLtv(client, cfg, denom),
  ])
  const [membranePriceWad] = await client.readContract({ address: oracle, abi: membraneOracleAbi, functionName: 'getPrice', args: [denom] })

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
  const [prevVenueAllowance, prevProceedsAllowance] = await Promise.all([
    venueToken
      ? client.readContract({ address: venueToken, abi: permitTokenAbi, functionName: 'allowance', args: [owner, cfg.generalAdapter1!] })
      : Promise.resolve(0n),
    client.readContract({ address: debtToken, abi: permitTokenAbi, functionName: 'allowance', args: [owner, cfg.membraneAdapter!] }),
  ])

  const flashAmount = flashAmountFor(debtWei, ACCRUAL_BUFFER_BPS)
  const capWad = maxLtvOnchainWad > BORROW_LTV_GAP_WAD + LTV_MARGIN_WAD ? maxLtvOnchainWad - BORROW_LTV_GAP_WAD - LTV_MARGIN_WAD : 0n
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
    borrowCdt: borrowCdtFor(flashAmount, Number(debtDecimals)),
    maxLtvWad: capWad,
    maxLtvOnchainWad,
    venueToken,
    venueTokenAmount: venueToken ? collateralWei : 0n,
    morphoParams,
    operatorGranted,
    morphoAuthorized,
    prevVenueAllowance,
    prevProceedsAllowance,
    blockTime: block.timestamp,
    blockNumber: block.number,
    collateralDecimals: Number(collateralDecimals),
    membranePriceWad,
  }
}

// ------------------------------------------------------------------ bundle

export function bundleFor(
  cfg: MigrateChainConfig,
  r: ResolvedMigration,
  sigs: { venuePermit: SignedPermit | null; proceedsPermit: SignedPermit | null; morphoAuth: SignedMorphoAuthorization | null },
): BundlerCall[] {
  const membrane = { membraneAdapter: cfg.membraneAdapter!, denom: r.denom, borrowCdt: r.borrowCdt, maxLtvWad: r.maxLtvWad }
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
    aTokenAmount: r.venueTokenAmount,
    membrane,
    aTokenPermit: sigs.venuePermit,
    proceedsPermit: sigs.proceedsPermit,
  })
}

// ------------------------------------------------------------------ simulation

export interface StepGas {
  id: string
  label: string
  gas: bigint
}

export type SimResult =
  | { ok: true; steps: StepGas[]; bufferedGas: bigint; method: 'eth_simulateV1' }
  | { ok: false; step: number; reason: string }

type SimCall = { to: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[]; id?: string; label?: string }

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

/** eth_simulateV1 of `calls` in order from `owner`. Gas is reported per labelled call (+5% each);
 *  unlabelled calls (approves standing in for permits) run but are not reported. */
async function simulate(client: PublicClient, owner: Address, calls: SimCall[]): Promise<SimResult> {
  try {
    const { results } = await simulateCalls(client, {
      account: owner,
      calls: calls.map(({ to, abi, functionName, args }) => ({ to, abi, functionName, args })),
    } as Parameters<typeof simulateCalls>[1])
    const failed = results.findIndex((r) => r.status !== 'success')
    if (failed >= 0) {
      const f = results[failed]
      return { ok: false, step: failed, reason: decodeRevert(f.data) ?? reasonOf(f.error) }
    }
    const steps: StepGas[] = []
    results.forEach((r, i) => {
      const c = calls[i]
      if (c.id && c.label) steps.push({ id: c.id, label: c.label, gas: (r.gasUsed * GAS_BUFFER_PCT) / 100n })
    })
    return { ok: true, steps, bufferedGas: steps.reduce((a, x) => a + x.gas, 0n), method: 'eth_simulateV1' }
  } catch (err) {
    return { ok: false, step: -1, reason: `simulation unavailable: ${reasonOf(err)}` }
  }
}

const operatorCall = (cfg: MigrateChainConfig, approved: boolean): SimCall => ({
  to: cfg.cdp!,
  abi: cdpOperatorAbi,
  functionName: 'setPositionOperator',
  args: [cfg.membraneAdapter!, approved],
  id: approved ? 'operator' : 'revoke-operator',
  label: approved ? 'operator grant' : 'revoke operator',
})

const bundleCall = (cfg: MigrateChainConfig, bundle: BundlerCall[]): SimCall => ({
  to: cfg.bundler3!,
  abi: bundler3Abi,
  functionName: 'multicall',
  args: [bundle],
  id: 'bundle',
  label: 'migrate',
})

/** The pre-signature simulation (review L-1): the operator grant runs as a PRIOR CALL inside the
 *  same eth_simulateV1, and approves stand in for the permits — so nothing is sent or signed until
 *  the whole path has simulated OK. */
export function preSignCalls(cfg: MigrateChainConfig, r: ResolvedMigration): SimCall[] {
  const calls: SimCall[] = []
  if (!r.operatorGranted) calls.push(operatorCall(cfg, true))
  if (r.venue === 'morpho-blue') {
    if (!r.morphoAuthorized) {
      calls.push({ to: cfg.morpho!, abi: setAuthorizationAbi, functionName: 'setAuthorization', args: [cfg.generalAdapter1!, true] })
    }
  } else {
    calls.push({ to: r.venueToken!, abi: permitTokenAbi, functionName: 'approve', args: [cfg.generalAdapter1!, r.venueTokenAmount] })
  }
  calls.push({ to: r.debtToken, abi: permitTokenAbi, functionName: 'approve', args: [cfg.membraneAdapter!, r.flashAmount] })
  calls.push(bundleCall(cfg, bundleFor(cfg, r, { venuePermit: null, proceedsPermit: null, morphoAuth: null })))
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
  /** Read after a settled migration (review L-2): the venue debt left, in debt-token wei. */
  sourceDebtAfter?: bigint
  /** Read back after the run: grants and allowances that differ from before it (see readLeftovers). */
  leftovers?: Leftover[]
}

/** Something the run left standing, and the call that puts it back. */
export interface Leftover {
  id: 'operator' | 'morpho-auth' | 'venue-allowance' | 'proceeds-allowance'
  /** ≤ 3 words, for the sheet. */
  label: string
  undo: SimCall
}

/**
 * Reads the operator grant, the Morpho authorization and the two allowances, and returns each one
 * that differs from the state before the run (`r`, read by resolveMigration). The undo restores the
 * earlier value: revoke a grant the owner did not have, re-set an allowance to what it was.
 */
export async function readLeftovers(client: PublicClient, cfg: MigrateChainConfig, r: ResolvedMigration): Promise<Leftover[]> {
  const [operator, morphoAuth, venueAllowance, proceedsAllowance] = await Promise.all([
    client.readContract({ address: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'positionOperator', args: [r.owner, cfg.membraneAdapter!] }),
    r.venue === 'morpho-blue'
      ? client.readContract({ address: cfg.morpho!, abi: morphoAbi, functionName: 'isAuthorized', args: [r.owner, cfg.generalAdapter1!] })
      : Promise.resolve(false),
    r.venueToken
      ? client.readContract({ address: r.venueToken, abi: permitTokenAbi, functionName: 'allowance', args: [r.owner, cfg.generalAdapter1!] })
      : Promise.resolve(0n),
    client.readContract({ address: r.debtToken, abi: permitTokenAbi, functionName: 'allowance', args: [r.owner, cfg.membraneAdapter!] }),
  ])
  const out: Leftover[] = []
  if (operator && !r.operatorGranted) out.push({ id: 'operator', label: 'adapter grant', undo: operatorCall(cfg, false) })
  if (morphoAuth && !r.morphoAuthorized) out.push({ id: 'morpho-auth', label: 'Morpho auth', undo: morphoAuthCall(cfg, false) })
  if (r.venueToken && venueAllowance !== r.prevVenueAllowance) {
    out.push({ id: 'venue-allowance', label: 'aToken allowance', undo: approveCall(r.venueToken, cfg.generalAdapter1!, r.prevVenueAllowance, 'restore-atoken', 'restore aToken allowance') })
  }
  if (proceedsAllowance !== r.prevProceedsAllowance) {
    out.push({ id: 'proceeds-allowance', label: 'USDC allowance', undo: approveCall(r.debtToken, cfg.membraneAdapter!, r.prevProceedsAllowance, 'restore-proceeds', 'restore USDC allowance') })
  }
  return out
}

async function send(
  client: PublicClient,
  wallet: WalletClient,
  owner: Address,
  c: SimCall,
  emit: (e: RunEvent) => void,
): Promise<{ hash: `0x${string}`; ok: boolean }> {
  const hash = await wallet.writeContract({
    account: owner,
    chain: wallet.chain,
    address: c.to,
    abi: c.abi as typeof cdpOperatorAbi,
    functionName: c.functionName as 'setPositionOperator',
    args: c.args as never,
  })
  emit({ kind: 'submitted', id: c.id ?? c.functionName, hash })
  const rc = await client.waitForTransactionReceipt({ hash })
  emit({ kind: 'mined', id: c.id ?? c.functionName, hash, status: rc.status })
  return { hash, ok: rc.status === 'success' }
}

/** The venue debt left for `r.owner` (0 after a full repay). */
export async function readSourceDebt(client: PublicClient, cfg: MigrateChainConfig, r: ResolvedMigration): Promise<bigint> {
  const fresh = await resolveMigrationDebtOnly(client, cfg, r)
  return fresh
}

async function resolveMigrationDebtOnly(client: PublicClient, cfg: MigrateChainConfig, r: ResolvedMigration): Promise<bigint> {
  if (r.venue === 'morpho-blue') {
    const [, borrowShares] = await client.readContract({ address: cfg.morpho!, abi: morphoAbi, functionName: 'position', args: [morphoMarketId(r.morphoParams!), r.owner] })
    return borrowShares
  }
  const pool = (r.venue === 'aave-v3' ? cfg.aavePool : cfg.sparkPool)!
  const d = await client.readContract({ address: pool, abi: aaveReserveAbi, functionName: 'getReserveData', args: [r.debtToken] })
  return client.readContract({ address: d.variableDebtTokenAddress, abi: permitTokenAbi, functionName: 'balanceOf', args: [r.owner] })
}

/**
 * Prompts, in order (review L-1 / item 3):
 *   0. a FRESH read of the venue and Membrane's price; the open cap is re-checked here
 *   1. venue permit or Morpho authorization (typed data; skipped when standing)
 *   2. proceeds permit (typed data, exact)
 *   3. eth_simulateV1 of [operator grant (when not standing), the exact signed bundle]
 *   4. operator grant (tx; skipped when standing) — only after step 3 passed
 *   5. the bundle (tx)
 * Then the venue debt is read again (L-2).
 */
export async function runMigration(p: {
  client: PublicClient
  wallet: WalletClient
  cfg: MigrateChainConfig
  source: MigrateSource
  r: ResolvedMigration
  onEvent?: (e: RunEvent) => void
}): Promise<RunResult> {
  const { client, wallet, cfg } = p
  const emit = p.onEvent ?? (() => {})
  const fresh = await resolveMigration(client, cfg, p.source, p.r.venue, p.r.owner)
  if ('error' in fresh) return { ok: false, bundleHash: null, reason: fresh.error }
  const r = fresh
  if (borrowLtvWad(r) > r.maxLtvWad) {
    return { ok: false, bundleHash: null, reason: `LtvAboveCap(${borrowLtvWad(r)}, ${r.maxLtvWad}) — the price or the debt moved since the plan; re-open the sheet` }
  }
  const steps = [
    r.venue === 'morpho-blue' ? !r.morphoAuthorized && 'morpho-auth' : 'atoken-permit',
    'proceeds-permit',
    !r.operatorGranted && 'operator',
    'bundle',
  ].filter(Boolean) as string[]
  let i = 0
  const prompt = (id: string) => emit({ kind: 'prompt', id, index: ++i, total: steps.length })

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
  const simCalls = [...(r.operatorGranted ? [] : [operatorCall(cfg, true)]), bundleCall(cfg, bundle)]
  const sim = await simulate(client, r.owner, simCalls)
  emit({ kind: 'simulated', result: sim })
  if (!sim.ok) return { ok: false, bundleHash: null, reason: sim.reason }

  if (!r.operatorGranted) {
    prompt('operator')
    const g = await send(client, wallet, r.owner, operatorCall(cfg, true), emit)
    if (!g.ok) return { ok: false, bundleHash: null, reason: 'the operator grant reverted', leftovers: await readLeftovers(client, cfg, r) }
  }
  prompt('bundle')
  const b = await send(client, wallet, r.owner, bundleCall(cfg, bundle), emit)
  if (!b.ok) return { ok: false, bundleHash: b.hash, reason: 'the bundle reverted on-chain', leftovers: await readLeftovers(client, cfg, r) }
  const sourceDebtAfter = await readSourceDebt(client, cfg, r)
  return { ok: true, bundleHash: b.hash, sourceDebtAfter }
}

/** OPTIONAL after a run: revoke the standing grants (one tx each). With `r` (the pre-run read)
 *  it also puts back every allowance readLeftovers finds changed. */
export async function runRevoke(p: {
  client: PublicClient
  wallet: WalletClient
  cfg: MigrateChainConfig
  owner: Address
  venue: MigrateVenue
  r?: ResolvedMigration
  onEvent?: (e: RunEvent) => void
}): Promise<RunResult> {
  const { client, wallet, cfg, owner } = p
  const emit = p.onEvent ?? (() => {})
  const calls: SimCall[] = []
  if (await client.readContract({ address: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'positionOperator', args: [owner, cfg.membraneAdapter!] })) {
    calls.push(operatorCall(cfg, false))
  }
  if (p.venue === 'morpho-blue' && (await client.readContract({ address: cfg.morpho!, abi: morphoAbi, functionName: 'isAuthorized', args: [owner, cfg.generalAdapter1!] }))) {
    calls.push(morphoAuthCall(cfg, false))
  }
  if (p.r) {
    for (const l of await readLeftovers(client, cfg, p.r)) if (l.id === 'venue-allowance' || l.id === 'proceeds-allowance') calls.push(l.undo)
  }
  let last: `0x${string}` | null = null
  for (let i = 0; i < calls.length; i++) {
    emit({ kind: 'prompt', id: calls[i].id!, index: i + 1, total: calls.length })
    const r = await send(client, wallet, owner, calls[i], emit)
    last = r.hash
    if (!r.ok) return { ok: false, bundleHash: r.hash, reason: `${calls[i].id} reverted` }
  }
  return { ok: true, bundleHash: last }
}

// ------------------------------------------------------------------ deploy fresh (Cdp direct)

export interface ResolvedDeploy {
  owner: Address
  collateralToken: Address
  collateralDecimals: number
  denom: `0x${string}`
  /** What the replay held, in wei, and what the wallet holds. The deposit is the smaller. */
  prefillWei: bigint
  walletWei: bigint
  depositWei: bigint
  borrowCdt: bigint
  allowance: bigint
  membranePriceWad: bigint
  maxLtvOnchainWad: bigint
  blockNumber: bigint
  /** CdpRouter's operator grant from this owner; null when no router is deployed on the chain. */
  routerOperator: boolean | null
  /** The owner's collateral allowance to CdpRouter (0 without a router). */
  routerAllowance: bigint
}

/** Reads the wallet and Membrane for a deploy-fresh plan: the deposit is the replay's collateral
 *  capped at the wallet balance; the borrow is `targetLtv` (the replay's LTV, capped at the
 *  borrow LTV by buildDeployPlan) of that deposit at Membrane's own oracle price. */
export async function resolveDeploy(
  client: PublicClient,
  cfg: MigrateChainConfig,
  source: MigrateSource,
  owner: Address,
  targetLtv: number,
): Promise<ResolvedDeploy | { error: string }> {
  const c0 = source.collateral[0]
  const token = c0 ? cfg.tokens[c0.symbol] : undefined
  if (!token) return { error: `${c0?.symbol ?? 'collateral'} has no token address on ${cfg.label}.` }
  const denom = cfg.denoms[token.toLowerCase()]
  if (!denom) return { error: `${c0.symbol} is not listed on Membrane on ${cfg.label}.` }
  const [decimals, walletWei, allowance, oracle, block] = await Promise.all([
    client.readContract({ address: token, abi: permitTokenAbi, functionName: 'decimals' }),
    client.readContract({ address: token, abi: permitTokenAbi, functionName: 'balanceOf', args: [owner] }),
    client.readContract({ address: token, abi: permitTokenAbi, functionName: 'allowance', args: [owner, cfg.cdp!] }),
    client.readContract({ address: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'oracle' }),
    client.getBlock(),
  ])
  const router = cfg.cdpRouter
  const [[membranePriceWad], maxLtvOnchainWad, routerOperator, routerAllowance] = await Promise.all([
    client.readContract({ address: oracle, abi: membraneOracleAbi, functionName: 'getPrice', args: [denom] }),
    readMaxLtv(client, cfg, denom),
    router
      ? client.readContract({ address: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'positionOperator', args: [owner, router] })
      : Promise.resolve(null),
    router ? client.readContract({ address: token, abi: permitTokenAbi, functionName: 'allowance', args: [owner, router] }) : Promise.resolve(0n),
  ])
  // the Cdp gates only on max LTV (review H-1): cap the fresh borrow at max − 3pp − margin, on-chain
  const openCapWad = maxLtvOnchainWad > BORROW_LTV_GAP_WAD + LTV_MARGIN_WAD ? maxLtvOnchainWad - BORROW_LTV_GAP_WAD - LTV_MARGIN_WAD : 0n
  const targetWad = BigInt(Math.floor(targetLtv * 1e4)) * 10n ** 14n
  const ltvWad = targetWad < openCapWad ? targetWad : openCapWad
  const scale = 10n ** BigInt(decimals)
  // the replay amount in wei, from its human amount (micro-unit precision is enough to prefill)
  const prefillWei = (BigInt(Math.round(c0.amount * 1e6)) * scale) / 1_000_000n
  const depositWei = prefillWei < walletWei ? prefillWei : walletWei
  if (depositWei === 0n) return { error: `This wallet holds no ${c0.symbol} on ${cfg.label}.` }
  const depositUsdWad = (depositWei * membranePriceWad) / scale
  // floor to whole bps of LTV and whole CDT so the borrow never rounds above the target
  const borrowCdt = ((depositUsdWad * ltvWad) / WAD / WAD) * WAD
  return {
    owner, collateralToken: token, collateralDecimals: Number(decimals), denom, prefillWei, walletWei, depositWei, borrowCdt,
    allowance, membranePriceWad, maxLtvOnchainWad, blockNumber: block.number, routerOperator, routerAllowance,
  }
}

/**
 * Which deploy path has the fewest prompts without leaving a new standing grant:
 *   batch-router  wallet batches atomically and a CdpRouter exists:
 *                 [approve(router) · grant router · depositAndBorrow · revoke router] = 1 prompt
 *   router        the router's operator grant is ALREADY standing: [approve when short] + depositAndBorrow
 *                 = 2 prompts (1 when the allowance covers it)
 *   direct        otherwise: [approve when short] + deposit + borrow = 3 (2). The router would need
 *                 its own operator grant (CdpRouter.sol RouterNotApprovedOperator) — also 3 prompts
 *                 and a grant left standing — so the direct path wins the tie.
 */
export type DeployPath = 'batch-router' | 'router' | 'direct'

export function deployPathFor(d: ResolvedDeploy, atomic: boolean): DeployPath {
  if (d.routerOperator === null) return 'direct'
  if (atomic) return 'batch-router'
  return d.routerOperator ? 'router' : 'direct'
}

const routerCall = (cfg: MigrateChainConfig, d: ResolvedDeploy): SimCall => ({
  to: cfg.cdpRouter!,
  abi: cdpRouterAbi,
  functionName: 'depositAndBorrow',
  args: [0n, [{ denom: d.denom, amount: d.depositWei }], d.denom, d.borrowCdt, []],
  id: 'router',
  label: 'deposit + borrow',
})

const routerGrant = (cfg: MigrateChainConfig, approved: boolean): SimCall => ({
  to: cfg.cdp!,
  abi: cdpOperatorAbi,
  functionName: 'setPositionOperator',
  args: [cfg.cdpRouter!, approved],
  id: approved ? 'router-grant' : 'router-revoke',
  label: approved ? 'router grant' : 'router revoke',
})

export function deployCallsFor(cfg: MigrateChainConfig, d: ResolvedDeploy, path: DeployPath, nextPositionId: bigint): SimCall[] {
  if (path === 'direct') return deployCalls(cfg, d, nextPositionId)
  const calls: SimCall[] = []
  if (path === 'batch-router') {
    calls.push(approveCall(d.collateralToken, cfg.cdpRouter!, d.depositWei, 'approve', 'approve'))
    if (!d.routerOperator) calls.push(routerGrant(cfg, true))
    calls.push(routerCall(cfg, d))
    if (!d.routerOperator) calls.push(routerGrant(cfg, false))
    return calls
  }
  if (d.routerAllowance < d.depositWei) calls.push(approveCall(d.collateralToken, cfg.cdpRouter!, d.depositWei, 'approve', 'approve'))
  calls.push(routerCall(cfg, d))
  return calls
}

const depositEventAbi = parseAbi(['event Deposit(address indexed owner, uint256 indexed positionId, bytes32 asset, uint256 amount)'])

export function deployCalls(cfg: MigrateChainConfig, d: ResolvedDeploy, nextPositionId: bigint): SimCall[] {
  const calls: SimCall[] = []
  if (d.allowance < d.depositWei) {
    calls.push({ to: d.collateralToken, abi: permitTokenAbi, functionName: 'approve', args: [cfg.cdp!, d.depositWei], id: 'approve', label: 'approve' })
  }
  calls.push({ to: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'deposit', args: [0n, d.owner, [{ denom: d.denom, amount: d.depositWei }]], id: 'deposit', label: 'deposit' })
  if (d.borrowCdt > 0n) {
    calls.push({ to: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'increaseDebt', args: [nextPositionId, d.denom, d.borrowCdt], id: 'borrow', label: 'borrow' })
  }
  return calls
}

export async function simulateDeploy(client: PublicClient, cfg: MigrateChainConfig, d: ResolvedDeploy, path: DeployPath = 'direct'): Promise<SimResult> {
  const next = await client.readContract({ address: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'currentPositionId' })
  return simulate(client, d.owner, deployCallsFor(cfg, d, path, next))
}

/** Sends approve (when short), deposit, borrow — one prompt each. */
export async function runDeploy(p: {
  client: PublicClient
  wallet: WalletClient
  cfg: MigrateChainConfig
  d: ResolvedDeploy
  path?: DeployPath
  onEvent?: (e: RunEvent) => void
  send?: SendBatch
}): Promise<RunResult> {
  const { client, wallet, cfg, d } = p
  const path = p.path ?? 'direct'
  const emit = p.onEvent ?? (() => {})
  const next = await client.readContract({ address: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'currentPositionId' })
  const calls = deployCallsFor(cfg, d, path, next)
  if (path === 'batch-router') {
    const sim = await simulate(client, d.owner, calls)
    emit({ kind: 'simulated', result: sim })
    if (!sim.ok) return { ok: false, bundleHash: null, reason: sim.reason }
    emit({ kind: 'prompt', id: 'batch', index: 1, total: 1 })
    const res = await (p.send ?? sendBatch5792)({ client, wallet, owner: d.owner, calls, chain: chainFor(cfg) })
    emit({ kind: 'mined', id: 'batch', hash: res.hash, status: res.ok ? 'success' : 'reverted' })
    return res.ok ? { ok: true, bundleHash: res.hash } : { ok: false, bundleHash: res.hash, reason: 'the batch reverted' }
  }
  const ids = calls.map((c) => c.id ?? (c.functionName === 'approve' ? 'approve' : c.functionName === 'deposit' ? 'deposit' : 'borrow'))
  let last: `0x${string}` | null = null
  let pid: bigint | null = null
  for (let i = 0; i < calls.length; i++) {
    let c = calls[i]
    if (ids[i] === 'borrow') {
      if (pid === null) return { ok: false, bundleHash: last, reason: 'the deposit receipt carried no Deposit event' }
      c = { ...c, args: [pid, d.denom, d.borrowCdt] }
    }
    emit({ kind: 'prompt', id: ids[i], index: i + 1, total: calls.length })
    const hash = await wallet.writeContract({
      account: d.owner,
      chain: wallet.chain,
      address: c.to,
      abi: c.abi as typeof cdpOperatorAbi,
      functionName: c.functionName as 'deposit',
      args: c.args as never,
    })
    emit({ kind: 'submitted', id: ids[i], hash })
    const rc = await client.waitForTransactionReceipt({ hash })
    emit({ kind: 'mined', id: ids[i], hash, status: rc.status })
    last = hash
    if (rc.status !== 'success') return { ok: false, bundleHash: hash, reason: `${ids[i]} reverted on-chain` }
    if (ids[i] === 'deposit') {
      // the position id the deposit actually created, from its own Deposit event
      const ev = parseEventLogs({ abi: depositEventAbi, logs: rc.logs, eventName: 'Deposit' }).find(
        (l) => l.address.toLowerCase() === cfg.cdp!.toLowerCase() && l.args.owner.toLowerCase() === d.owner.toLowerCase(),
      )
      pid = ev ? ev.args.positionId : null
    }
  }
  return { ok: true, bundleHash: last }
}

// ------------------------------------------------------------------ EIP-5792 one-prompt batch

/**
 * True only when the wallet reports atomic batching as `supported` on `chainId` (EIP-5792
 * wallet_getCapabilities). `ready` (an EIP-7702 account upgrade the wallet would ask for first)
 * and any error count as not supported, so the sheet falls back to the per-prompt flow — the
 * same rule feat/q27-lever-exec settled on. The legacy `atomicBatch.supported` shape is accepted.
 */
export async function detectAtomic(wallet: WalletClient | undefined, chainId: number | undefined): Promise<boolean> {
  if (!wallet || chainId === undefined) return false
  try {
    const caps = (await getCapabilities(wallet, { account: wallet.account, chainId })) as Record<string, unknown>
    const atomic = caps?.atomic as { status?: string } | undefined
    if (atomic?.status) return atomic.status === 'supported'
    const legacy = caps?.atomicBatch as { supported?: boolean } | undefined
    return legacy?.supported === true
  } catch {
    return false
  }
}

const morphoAuthCall = (cfg: MigrateChainConfig, on: boolean): SimCall => ({
  to: cfg.morpho!,
  abi: setAuthorizationAbi,
  functionName: 'setAuthorization',
  args: [cfg.generalAdapter1!, on],
  id: on ? 'morpho-auth' : 'revoke-morpho',
  label: on ? 'Morpho auth' : 'revoke Morpho',
})

function approveCall(token: Address, spender: Address, amount: bigint, id: string, label: string): SimCall {
  return {
  to: token,
  abi: permitTokenAbi,
  functionName: 'approve',
    args: [spender, amount],
    id,
    label,
  }
}

/**
 * The whole migration as ONE atomic batch: exact approvals in place of the permits, the grants
 * and their revokes inside the same batch, so nothing stays standing afterwards. A grant the
 * owner already had is left as it was (neither re-granted nor revoked).
 *   Aave    approve(aToken→GA1, A) · approve(USDC→adapter, P) · grant · Bundler3.multicall · revoke
 *           · approve(aToken→GA1, prev) · approve(USDC→adapter, prev)
 *   Morpho  setAuthorization(GA1, true) · approve(USDC→adapter, P) · grant · multicall · revoke ·
 *           setAuthorization(GA1, false) · approve(USDC→adapter, prev)
 * The exact approvals OVERWRITE any allowance the owner already gave the same spender, and the
 * proceeds pull can leave P − received behind. So the batch ENDS by re-setting each allowance to
 * the value read before the run (`prev*Allowance`): afterwards both equal what they were before.
 */
export function batchCallsFor(cfg: MigrateChainConfig, r: ResolvedMigration): SimCall[] {
  const calls: SimCall[] = []
  const morphoAuth = r.venue === 'morpho-blue' && !r.morphoAuthorized
  if (morphoAuth) {
    calls.push(morphoAuthCall(cfg, true))
  }
  if (r.venue !== 'morpho-blue') calls.push(approveCall(r.venueToken!, cfg.generalAdapter1!, r.venueTokenAmount, 'atoken-approve', 'aToken approve'))
  calls.push(approveCall(r.debtToken, cfg.membraneAdapter!, r.flashAmount, 'proceeds-approve', 'USDC approve'))
  if (!r.operatorGranted) calls.push(operatorCall(cfg, true))
  calls.push(bundleCall(cfg, bundleFor(cfg, r, { venuePermit: null, proceedsPermit: null, morphoAuth: null })))
  if (!r.operatorGranted) calls.push(operatorCall(cfg, false))
  if (morphoAuth) calls.push(morphoAuthCall(cfg, false))
  if (r.venue !== 'morpho-blue') calls.push(approveCall(r.venueToken!, cfg.generalAdapter1!, r.prevVenueAllowance, 'restore-atoken', 'restore aToken allowance'))
  calls.push(approveCall(r.debtToken, cfg.membraneAdapter!, r.prevProceedsAllowance, 'restore-proceeds', 'restore USDC allowance'))
  return calls
}

/** eth_simulateV1 of the whole batch, in sequence, from the owner — before the one prompt. */
export function simulateBatch(client: PublicClient, owner: Address, calls: SimCall[]): Promise<SimResult> {
  return simulate(client, owner, calls)
}

/** How a batch reaches the chain. The default is the wallet's EIP-5792 wallet_sendCalls with
 *  forceAtomic; tests inject an EIP-7702 delegation instead (anvil has no wallet_sendCalls).
 *  `chain` is built from the plan's config (chainFor), never taken from the wallet. */
export type SendBatch = (p: { client: PublicClient; wallet: WalletClient; owner: Address; calls: SimCall[]; chain: Chain }) => Promise<{ hash: `0x${string}`; ok: boolean }>

/** The viem chain for a config: the batch is sent for THIS chain id or not at all. */
export function chainFor(cfg: MigrateChainConfig): Chain {
  return defineChain({ id: cfg.chainId, name: cfg.label, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } })
}

/** The fields of a wallet_getCallsStatus result the settlement check reads. */
export interface CallsStatusLike {
  id?: string
  atomic?: boolean
  status?: string
  receipts?: { status?: string; transactionHash?: `0x${string}` }[]
}

/**
 * Settled only when the wallet says the batch ran ATOMICALLY (`atomic === true`), says it
 * succeeded, and returned at least one receipt with every receipt `success`. The legacy
 * `CONFIRMED` status counts only under the same receipt check. Anything else is a failure, and
 * the caller reads back what was left standing.
 */
export function batchSettlement(res: CallsStatusLike): { ok: boolean; hash: `0x${string}` } {
  const receipts = res.receipts ?? []
  const hash = (receipts[receipts.length - 1]?.transactionHash ?? res.id ?? '0x') as `0x${string}`
  const said = res.status === 'success' || res.status === 'CONFIRMED'
  const allOk = receipts.length > 0 && receipts.every((x) => x.status === 'success' || x.status === '0x1')
  return { ok: res.atomic === true && said && allOk, hash }
}

/** Refuses unless the wallet is on `chain` (eth_chainId, not the client's cached chain). */
export async function assertWalletChain(wallet: WalletClient, chain: Chain): Promise<void> {
  const id = await wallet.getChainId()
  if (id !== chain.id) throw new Error(`Wallet is on chain ${id}, the plan is for chain ${chain.id} (${chain.name}). Switch network.`)
}

export const sendBatch5792: SendBatch = async ({ wallet, owner, calls, chain }) => {
  await assertWalletChain(wallet, chain)
  const { id } = await sendCalls(wallet, {
    account: owner,
    chain,
    forceAtomic: true,
    calls: calls.map((c) => ({ to: c.to, abi: c.abi, functionName: c.functionName, args: c.args })),
  } as Parameters<typeof sendCalls>[1])
  const res = await waitForCallsStatus(wallet, { id })
  return batchSettlement({ ...(res as CallsStatusLike), id })
}

/** The one-prompt path: fresh read + cap check (as runMigration), simulate the batch, one prompt. */
export async function runMigrationBatch(p: {
  client: PublicClient
  wallet: WalletClient
  cfg: MigrateChainConfig
  source: MigrateSource
  r: ResolvedMigration
  onEvent?: (e: RunEvent) => void
  send?: SendBatch
}): Promise<RunResult> {
  const { client, wallet, cfg } = p
  const emit = p.onEvent ?? (() => {})
  const fresh = await resolveMigration(client, cfg, p.source, p.r.venue, p.r.owner)
  if ('error' in fresh) return { ok: false, bundleHash: null, reason: fresh.error }
  const r = fresh
  if (borrowLtvWad(r) > r.maxLtvWad) {
    return { ok: false, bundleHash: null, reason: `LtvAboveCap(${borrowLtvWad(r)}, ${r.maxLtvWad}) — the price or the debt moved since the plan; re-open the sheet` }
  }
  const calls = batchCallsFor(cfg, r)
  const sim = await simulateBatch(client, r.owner, calls)
  emit({ kind: 'simulated', result: sim })
  if (!sim.ok) return { ok: false, bundleHash: null, reason: sim.reason }
  emit({ kind: 'prompt', id: 'batch', index: 1, total: 1 })
  let res: { hash: `0x${string}`; ok: boolean }
  try {
    res = await (p.send ?? sendBatch5792)({ client, wallet, owner: r.owner, calls, chain: chainFor(cfg) })
  } catch (err) {
    // a rejected prompt or a wrong chain usually moves nothing; read it back anyway
    const leftovers = await readLeftovers(client, cfg, r).catch(() => undefined)
    if (leftovers?.length) return { ok: false, bundleHash: null, reason: err instanceof Error ? err.message : String(err), leftovers }
    throw err
  }
  emit({ kind: 'mined', id: 'batch', hash: res.hash, status: res.ok ? 'success' : 'reverted' })
  const leftovers = await readLeftovers(client, cfg, r)
  if (!res.ok) return { ok: false, bundleHash: res.hash, reason: 'the batch did not settle atomically', leftovers }
  const sourceDebtAfter = await readSourceDebt(client, cfg, r)
  return { ok: true, bundleHash: res.hash, sourceDebtAfter, leftovers }
}
