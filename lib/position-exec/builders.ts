/**
 * THE LEVER BUILDERS. Pure functions: exact bigint amounts and addresses in, the calls the
 * wallet signs out. No reads, no defaults, no float. tests/unit/positionExecBuilders.test.ts
 * decodes every call back and checks each argument.
 *
 *   Aave V3 / Spark   Pool.repay(asset, amount, 2, onBehalfOf)       variable-rate debt only
 *                     Pool.supply(asset, amount, onBehalfOf, 0)      referral code 0
 *   Compound V3       Comet.supply(asset, amount)                     base asset repays the
 *                                                                     borrow; collateral adds
 *   Morpho Blue       repay(marketParams, assets, 0, onBehalf, 0x)    exactly one of assets /
 *                     supplyCollateral(marketParams, assets, onBehalf, 0x)        shares
 *
 * Every action is preceded by the approval it needs and no more: nothing when the standing
 * allowance covers the amount, else an approve of EXACTLY the amount (never unlimited).
 * When a smaller allowance is already standing, it is set to 0 first: USDT reverts on a
 * non-zero to non-zero approve, and the reset is harmless on any other token (the same
 * order OpenZeppelin's forceApprove falls back to).
 *
 * onBehalfOf is always the position's owner, and the page only lets the owner sign
 * (lib/position-exec/sheet.ts), so no address acts on another's position.
 */

import { encodeAbiParameters, keccak256 } from 'viem'

import type { EvmCall } from '@/services/chain/types'

import { aavePoolAbi, cometAbi, erc20ApproveNoReturnAbi, morphoAbi } from './abis'

export type Address = `0x${string}`

export interface MorphoMarketParams {
  loanToken: Address
  collateralToken: Address
  oracle: Address
  irm: Address
  lltv: bigint
}

/** Aave's InterestRateMode.VARIABLE. Stable (1) is never built: see read.ts. */
export const AAVE_VARIABLE_RATE_MODE = 2n
export const AAVE_REFERRAL_CODE = 0

/** One lever, fully resolved: every address read at execution time, the amount exact. */
export type LeverAction =
  | {
      venue: 'aave'
      kind: 'repay' | 'add'
      pool: Address
      asset: Address
      amount: bigint
      owner: Address
    }
  | { venue: 'compound'; kind: 'repay' | 'add'; comet: Address; asset: Address; amount: bigint }
  | {
      venue: 'morpho'
      kind: 'repay' | 'add'
      morpho: Address
      params: MorphoMarketParams
      amount: bigint
      owner: Address
    }

const positive = (amount: bigint, what: string) => {
  if (amount <= 0n) throw new Error(`${what}: amount must be positive, got ${amount}`)
}

// ------------------------------------------------------------------ approvals

export function approveCall(token: Address, spender: Address, amount: bigint): EvmCall {
  if (amount < 0n) throw new Error(`approve: negative amount ${amount}`)
  return {
    address: token,
    abi: erc20ApproveNoReturnAbi,
    functionName: 'approve',
    args: [spender, amount],
  }
}

/** [] when `allowance` covers `amount`; [approve(amount)] from 0; [approve(0), approve(amount)] otherwise. */
export function approveCalls(p: {
  token: Address
  spender: Address
  amount: bigint
  allowance: bigint
}): EvmCall[] {
  positive(p.amount, 'approve')
  if (p.allowance >= p.amount) return []
  if (p.allowance === 0n) return [approveCall(p.token, p.spender, p.amount)]
  return [approveCall(p.token, p.spender, 0n), approveCall(p.token, p.spender, p.amount)]
}

// ------------------------------------------------------------------ actions

export function aaveRepayCall(p: {
  pool: Address
  asset: Address
  amount: bigint
  onBehalfOf: Address
}): EvmCall {
  positive(p.amount, 'aave repay')
  return {
    address: p.pool,
    abi: aavePoolAbi,
    functionName: 'repay',
    args: [p.asset, p.amount, AAVE_VARIABLE_RATE_MODE, p.onBehalfOf],
  }
}

export function aaveSupplyCall(p: {
  pool: Address
  asset: Address
  amount: bigint
  onBehalfOf: Address
}): EvmCall {
  positive(p.amount, 'aave supply')
  return {
    address: p.pool,
    abi: aavePoolAbi,
    functionName: 'supply',
    args: [p.asset, p.amount, p.onBehalfOf, AAVE_REFERRAL_CODE],
  }
}

/** Comet supplies to msg.sender's own account: the signer is the owner (sheet.ts). */
export function cometSupplyCall(p: { comet: Address; asset: Address; amount: bigint }): EvmCall {
  positive(p.amount, 'comet supply')
  return { address: p.comet, abi: cometAbi, functionName: 'supply', args: [p.asset, p.amount] }
}

const tupleOf = (m: MorphoMarketParams) => ({
  loanToken: m.loanToken,
  collateralToken: m.collateralToken,
  oracle: m.oracle,
  irm: m.irm,
  lltv: m.lltv,
})

/** repay by ASSETS (shares = 0): Morpho takes exactly `assets` and burns the shares they buy, rounded down. */
export function morphoRepayCall(p: {
  morpho: Address
  params: MorphoMarketParams
  assets: bigint
  onBehalf: Address
}): EvmCall {
  positive(p.assets, 'morpho repay')
  return {
    address: p.morpho,
    abi: morphoAbi,
    functionName: 'repay',
    args: [tupleOf(p.params), p.assets, 0n, p.onBehalf, '0x'],
  }
}

export function morphoSupplyCollateralCall(p: {
  morpho: Address
  params: MorphoMarketParams
  assets: bigint
  onBehalf: Address
}): EvmCall {
  positive(p.assets, 'morpho supplyCollateral')
  return {
    address: p.morpho,
    abi: morphoAbi,
    functionName: 'supplyCollateral',
    args: [tupleOf(p.params), p.assets, p.onBehalf, '0x'],
  }
}

/** Morpho's market id: keccak256(abi.encode(MarketParams)) (MarketParamsLib.id). */
export function morphoMarketId(m: MorphoMarketParams): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
      ],
      [m.loanToken, m.collateralToken, m.oracle, m.irm, m.lltv],
    ),
  )
}

// ------------------------------------------------------------------ one lever

/** The token the action pulls from the signer. */
export function tokenOf(a: LeverAction): Address {
  if (a.venue === 'morpho')
    return a.kind === 'repay' ? a.params.loanToken : a.params.collateralToken
  return a.asset
}

/** The contract that pulls the token, so the one the approval names. */
export function spenderOf(a: LeverAction): Address {
  return a.venue === 'aave' ? a.pool : a.venue === 'compound' ? a.comet : a.morpho
}

export function actionCall(a: LeverAction): EvmCall {
  switch (a.venue) {
    case 'aave':
      return a.kind === 'repay'
        ? aaveRepayCall({ pool: a.pool, asset: a.asset, amount: a.amount, onBehalfOf: a.owner })
        : aaveSupplyCall({ pool: a.pool, asset: a.asset, amount: a.amount, onBehalfOf: a.owner })
    case 'compound':
      return cometSupplyCall({ comet: a.comet, asset: a.asset, amount: a.amount })
    case 'morpho':
      return a.kind === 'repay'
        ? morphoRepayCall({
            morpho: a.morpho,
            params: a.params,
            assets: a.amount,
            onBehalf: a.owner,
          })
        : morphoSupplyCollateralCall({
            morpho: a.morpho,
            params: a.params,
            assets: a.amount,
            onBehalf: a.owner,
          })
  }
}

/** The whole batch the wallet signs: the approvals the allowance needs, then the action. */
export function leverCalls(a: LeverAction, allowance: bigint): EvmCall[] {
  return [
    ...approveCalls({ token: tokenOf(a), spender: spenderOf(a), amount: a.amount, allowance }),
    actionCall(a),
  ]
}
