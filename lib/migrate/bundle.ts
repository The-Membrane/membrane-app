/**
 * THE BUNDLE. Pure: resolved addresses, exact bigint amounts and signed permits in, the
 * Bundler3.multicall argument out. contracts/migrator/test/MembraneMigration.t.sol builds the
 * same calls in Solidity (_aaveBundle / _morphoBundle) and runs them against real Bundler3,
 * GeneralAdapter1, AaveV3MigrationAdapter, Morpho Blue and Membrane's Cdp + Transmuter;
 * tests/unit/migrateBundle.test.ts decodes every call here back and checks each argument.
 *
 *   P = the proceeds: the debt read at build time plus ACCRUAL_BUFFER_BPS. It is the flash amount,
 *   the exact Membrane borrow (P × 10^(18 − decimals) CDT) and the exact proceeds permit, so the
 *   permit is consumed to zero. What the venue did not need is swept back to the owner.
 *
 *   outer   [permit/authorization calls (skipRevert: a front-run permit must not brick the
 *            bundle — the allowance is then already set)]
 *           GA1.morphoFlashLoan(token, P, inner)
 *           GA1.erc20Transfer(token → owner, max)                     the unspent buffer back
 *   inner   (run by Bundler3.reenter inside Morpho's callback; callbackHash = keccak256(inner))
 *     Aave/Spark  GA1.erc20Transfer(debt → aaveAdapter, max)
 *                 aaveAdapter.aaveV3Repay(debt, max, 2, owner)       repays min(balance, debt)
 *                 aaveAdapter.erc20Transfer(debt → GA1, max)          leftover back to the repayer
 *                 GA1.erc20TransferFrom(aToken → aaveAdapter, A)     EXACTLY the permitted aTokens
 *                 aaveAdapter.aaveV3Withdraw(collateral, max, membraneAdapter)
 *                 membraneAdapter.depositAndBorrowFor(denom, P·scale, debt, maxLtvWad)
 *     Morpho      GA1.morphoRepay(params, 0, max shares, maxSharePrice, owner, 0x)
 *                 GA1.morphoWithdrawCollateral(params, max, membraneAdapter)
 *                 membraneAdapter.depositAndBorrowFor(...)
 *   The adapter pays the borrow back only to GeneralAdapter1 (immutable REPAY_TO) and only opens a
 *   NEW position.
 */

import { encodeAbiParameters, encodeFunctionData, keccak256, maxUint256, type Hex } from 'viem'

import { membraneBundlerAdapterAbi } from '@/contracts/abis/membraneBundlerAdapter'

import { aaveV3MigrationAdapterAbi, generalAdapter1Abi, morphoAbi, permitTokenAbi } from './abis'
import type { Address } from './types'

export interface BundlerCall {
  to: Address
  data: Hex
  value: bigint
  skipRevert: boolean
  callbackHash: Hex
}

export const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex
export const AAVE_VARIABLE_RATE_MODE = 2n

/** ERC-2612 permit, already signed. */
export interface SignedPermit {
  token: Address
  owner: Address
  spender: Address
  value: bigint
  deadline: bigint
  v: number
  r: Hex
  s: Hex
}

export interface MorphoMarketParams {
  loanToken: Address
  collateralToken: Address
  oracle: Address
  irm: Address
  lltv: bigint
}

export interface SignedMorphoAuthorization {
  authorizer: Address
  authorized: Address
  isAuthorized: boolean
  nonce: bigint
  deadline: bigint
  v: number
  r: Hex
  s: Hex
}

const CALL_TUPLE = [
  {
    type: 'tuple[]',
    components: [
      { name: 'to', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'value', type: 'uint256' },
      { name: 'skipRevert', type: 'bool' },
      { name: 'callbackHash', type: 'bytes32' },
    ],
  },
] as const

export const encodeCalls = (calls: readonly BundlerCall[]): Hex => encodeAbiParameters(CALL_TUPLE, [calls])

const call = (to: Address, data: Hex): BundlerCall => ({ to, data, value: 0n, skipRevert: false, callbackHash: ZERO_HASH })

export function permitCall(p: SignedPermit): BundlerCall {
  return {
    to: p.token,
    data: encodeFunctionData({
      abi: permitTokenAbi,
      functionName: 'permit',
      args: [p.owner, p.spender, p.value, p.deadline, p.v, p.r, p.s],
    }),
    value: 0n,
    skipRevert: true,
    callbackHash: ZERO_HASH,
  }
}

export function morphoAuthorizationCall(morpho: Address, a: SignedMorphoAuthorization): BundlerCall {
  return {
    to: morpho,
    data: encodeFunctionData({
      abi: morphoAbi,
      functionName: 'setAuthorizationWithSig',
      args: [
        { authorizer: a.authorizer, authorized: a.authorized, isAuthorized: a.isAuthorized, nonce: a.nonce, deadline: a.deadline },
        { v: a.v, r: a.r, s: a.s },
      ],
    }),
    value: 0n,
    skipRevert: true,
    callbackHash: ZERO_HASH,
  }
}

export function flashLoanCall(ga1: Address, token: Address, amount: bigint, inner: readonly BundlerCall[]): BundlerCall {
  if (amount <= 0n) throw new Error('flash loan: amount must be positive')
  const data = encodeCalls(inner)
  return {
    to: ga1,
    data: encodeFunctionData({ abi: generalAdapter1Abi, functionName: 'morphoFlashLoan', args: [token, amount, data] }),
    value: 0n,
    skipRevert: false,
    callbackHash: keccak256(data),
  }
}

export interface MembraneLeg {
  membraneAdapter: Address
  denom: Hex
  /** The exact new Membrane debt, CDT (18 decimals). */
  borrowCdt: bigint
  /** The owner's LTV cap (1e18), checked on-chain after the borrow at Membrane's prices. */
  maxLtvWad: bigint
}

function membraneLegCall(m: MembraneLeg, debtToken: Address): BundlerCall {
  return call(
    m.membraneAdapter,
    encodeFunctionData({
      abi: membraneBundlerAdapterAbi,
      functionName: 'depositAndBorrowFor',
      args: [m.denom, m.borrowCdt, debtToken, m.maxLtvWad],
    }),
  )
}

function sweepCall(ga1: Address, token: Address, owner: Address): BundlerCall {
  return call(ga1, encodeFunctionData({ abi: generalAdapter1Abi, functionName: 'erc20Transfer', args: [token, owner, maxUint256] }))
}

export interface AaveBundleInput {
  generalAdapter1: Address
  aaveAdapter: Address
  owner: Address
  debtToken: Address
  collateralToken: Address
  aToken: Address
  /** P: flash amount = exact proceeds pulled back. */
  flashAmount: bigint
  /** A: exactly the aTokens permitted and moved. */
  aTokenAmount: bigint
  membrane: MembraneLeg
  aTokenPermit: SignedPermit | null
  proceedsPermit: SignedPermit | null
}

export function buildAaveBundle(i: AaveBundleInput): BundlerCall[] {
  const ga = i.generalAdapter1
  const inner: BundlerCall[] = [
    call(ga, encodeFunctionData({ abi: generalAdapter1Abi, functionName: 'erc20Transfer', args: [i.debtToken, i.aaveAdapter, maxUint256] })),
    call(i.aaveAdapter, encodeFunctionData({ abi: aaveV3MigrationAdapterAbi, functionName: 'aaveV3Repay', args: [i.debtToken, maxUint256, AAVE_VARIABLE_RATE_MODE, i.owner] })),
    call(i.aaveAdapter, encodeFunctionData({ abi: aaveV3MigrationAdapterAbi, functionName: 'erc20Transfer', args: [i.debtToken, ga, maxUint256] })),
    call(ga, encodeFunctionData({ abi: generalAdapter1Abi, functionName: 'erc20TransferFrom', args: [i.aToken, i.aaveAdapter, i.aTokenAmount] })),
    call(i.aaveAdapter, encodeFunctionData({ abi: aaveV3MigrationAdapterAbi, functionName: 'aaveV3Withdraw', args: [i.collateralToken, maxUint256, i.membrane.membraneAdapter] })),
    membraneLegCall(i.membrane, i.debtToken),
  ]
  const outer: BundlerCall[] = []
  if (i.aTokenPermit) outer.push(permitCall(i.aTokenPermit))
  if (i.proceedsPermit) outer.push(permitCall(i.proceedsPermit))
  outer.push(flashLoanCall(ga, i.debtToken, i.flashAmount, inner))
  outer.push(sweepCall(ga, i.debtToken, i.owner))
  return outer
}

export interface MorphoBundleInput {
  generalAdapter1: Address
  morpho: Address
  owner: Address
  params: MorphoMarketParams
  flashAmount: bigint
  /** Slippage bound on the repay (assets per share, 1e27). maxUint256 = no bound. */
  maxSharePriceE27: bigint
  membrane: MembraneLeg
  authorization: SignedMorphoAuthorization | null
  proceedsPermit: SignedPermit | null
}

export function buildMorphoBundle(i: MorphoBundleInput): BundlerCall[] {
  const ga = i.generalAdapter1
  const inner: BundlerCall[] = [
    call(ga, encodeFunctionData({ abi: generalAdapter1Abi, functionName: 'morphoRepay', args: [i.params, 0n, maxUint256, i.maxSharePriceE27, i.owner, '0x'] })),
    call(ga, encodeFunctionData({ abi: generalAdapter1Abi, functionName: 'morphoWithdrawCollateral', args: [i.params, maxUint256, i.membrane.membraneAdapter] })),
    membraneLegCall(i.membrane, i.params.loanToken),
  ]
  const outer: BundlerCall[] = []
  if (i.authorization) outer.push(morphoAuthorizationCall(i.morpho, i.authorization))
  if (i.proceedsPermit) outer.push(permitCall(i.proceedsPermit))
  outer.push(flashLoanCall(ga, i.params.loanToken, i.flashAmount, inner))
  outer.push(sweepCall(ga, i.params.loanToken, i.owner))
  return outer
}

/** flash = debt × (1 + buffer), rounded up. */
export function flashAmountFor(debtWei: bigint, bufferBps: number): bigint {
  const b = BigInt(bufferBps)
  return (debtWei * (10_000n + b) + 9_999n) / 10_000n
}

/** The exact Membrane borrow: the proceeds in CDT units (CDT has 18 decimals). */
export function borrowCdtFor(flashWei: bigint, debtDecimals: number): bigint {
  if (debtDecimals > 18) throw new Error(`debt decimals ${debtDecimals} > 18`)
  return flashWei * 10n ** BigInt(18 - debtDecimals)
}
