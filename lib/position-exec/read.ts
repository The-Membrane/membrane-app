/**
 * THE EXECUTION-TIME READ. Everything a lever's gates and calls need, read from the chain
 * at one block, right before the sheet shows them: the token's decimals, the owner's
 * balance and standing allowance, and each venue's own switches.
 *
 *   Aave V3 / Spark  Pool from PoolAddressesProvider.getPool() (never hardcoded); the
 *                    reserve's configuration bitmap (active, frozen, paused, supply cap,
 *                    ReserveConfiguration.sol bit layout); the owner's variable and stable
 *                    debt-token balances; the supplied total for the cap
 *                    ((scaledTotalSupply + accruedToTreasury) × normalized income).
 *   Compound V3      the Comet (the position's marketId): baseToken, isSupplyPaused,
 *                    borrowBalanceOf; for collateral, its supplyCap and totalsCollateral.
 *   Morpho Blue      idToMarketParams(id) re-read, checked to hash back to the id; the
 *                    owner's borrow shares and the market totals (repay-by-assets burns
 *                    assets × (shares + 1e6) / (assets + 1) shares, rounded down).
 *
 * A failed read throws with the call named; nothing is defaulted.
 */

import type { PublicClient } from 'viem'

import {
  AAVE_V3_MAINNET_ADDRESSES_PROVIDER,
  MORPHO_BLUE_MAINNET,
  SPARK_MAINNET_ADDRESSES_PROVIDER,
} from '@/lib/position-sim/adapters'
import { mc, unwrap, type Call } from '@/lib/position-sim/adapters/types'

import {
  aaveAddressesProviderAbi,
  aavePoolAbi,
  aaveScaledSupplyAbi,
  cometAbi,
  erc20ReadAbi,
  morphoAbi,
} from './abis'
import {
  morphoMarketId,
  spenderOf,
  type Address,
  type LeverAction,
  type MorphoMarketParams,
} from './builders'

export type ExecProtocol = 'aave-v3' | 'spark' | 'compound-v3' | 'morpho-blue'

export const EXEC_PROTOCOLS: readonly ExecProtocol[] = [
  'aave-v3',
  'spark',
  'compound-v3',
  'morpho-blue',
]

export const isExecProtocol = (p: string): p is ExecProtocol =>
  (EXEC_PROTOCOLS as readonly string[]).includes(p)

export interface LeverReadInput {
  protocol: ExecProtocol
  kind: 'repay' | 'add'
  owner: Address
  /** The leg's token, from the position re-read. */
  token: Address
  /** The lever's amount in token units (amount.ts leverUnits). */
  amount: bigint
  /** Comet address (Compound) or market id (Morpho). */
  marketId?: string
  /** The block the position was re-read at; null reads latest. */
  block: bigint | null
}

/** Aave's ReserveConfigurationMap, the fields a repay or a supply checks. */
export interface AaveReserveFlags {
  decimals: number
  active: boolean
  frozen: boolean
  paused: boolean
  /** Whole tokens; 0 means no cap. */
  supplyCap: bigint
}

export type VenueRead =
  | {
      venue: 'aave'
      pool: Address
      flags: AaveReserveFlags
      variableDebt: bigint
      stableDebt: bigint
      /** Units that can still be supplied; null when the reserve has no cap. */
      capRoom: bigint | null
    }
  | {
      venue: 'compound'
      comet: Address
      baseToken: Address
      supplyPaused: boolean
      borrow: bigint
      /** Collateral units under the cap (0 when the cap is 0); null for the base asset. */
      capRoom: bigint | null
    }
  | {
      venue: 'morpho'
      params: MorphoMarketParams
      /** keccak256(abi.encode(params)) equals the position's market id. */
      idMatches: boolean
      borrowShares: bigint
      /** Shares a repay of `amount` assets would burn, at the read's totals. */
      sharesForAmount: bigint
    }

export interface LeverChainRead {
  block: bigint | null
  /** decimals() on the token, re-read now. */
  decimals: number
  balance: bigint
  allowance: bigint
  venue: VenueRead
  action: LeverAction
}

const ZERO = /^0x0{40}$/i
const RAY = 10n ** 27n
/** Aave WadRayMath.rayMul: half up. */
export const rayMul = (a: bigint, b: bigint): bigint => (a * b + RAY / 2n) / RAY

/** ReserveConfiguration.sol: decimals 48–55, active 56, frozen 57, paused 60, supply cap 116–151. */
export function decodeAaveConfig(data: bigint): AaveReserveFlags {
  const bit = (n: bigint) => ((data >> n) & 1n) === 1n
  return {
    decimals: Number((data >> 48n) & 0xffn),
    active: bit(56n),
    frozen: bit(57n),
    paused: bit(60n),
    supplyCap: (data >> 116n) & ((1n << 36n) - 1n),
  }
}

/** Units under an Aave supply cap: cap × 10^decimals − supplied, floored at 0; null with no cap. */
export function aaveCapRoom(
  flags: AaveReserveFlags,
  scaledTotalSupply: bigint,
  accruedToTreasury: bigint,
  normalizedIncome: bigint,
): bigint | null {
  if (flags.supplyCap === 0n) return null
  const cap = flags.supplyCap * 10n ** BigInt(flags.decimals)
  const supplied = rayMul(scaledTotalSupply + accruedToTreasury, normalizedIncome)
  return cap > supplied ? cap - supplied : 0n
}

/** Morpho SharesMathLib.toSharesDown with VIRTUAL_SHARES 1e6, VIRTUAL_ASSETS 1. */
export const morphoSharesDown = (
  assets: bigint,
  totalAssets: bigint,
  totalShares: bigint,
): bigint => (assets * (totalShares + 10n ** 6n)) / (totalAssets + 1n)

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

async function readAave(
  client: PublicClient,
  input: LeverReadInput,
): Promise<{ venue: VenueRead; action: LeverAction }> {
  const tag = input.protocol === 'spark' ? 'spark' : 'aave v3'
  const provider =
    input.protocol === 'spark'
      ? SPARK_MAINNET_ADDRESSES_PROVIDER
      : AAVE_V3_MAINNET_ADDRESSES_PROVIDER
  const head = await mc<Address>(
    client,
    [{ address: provider, abi: aaveAddressesProviderAbi, functionName: 'getPool' }],
    input.block,
  )
  const pool = unwrap(head[0], `${tag}: PoolAddressesProvider.getPool()`)
  if (ZERO.test(pool))
    throw new Error(`${tag}: PoolAddressesProvider returned the zero address for the pool`)

  const rd = await mc<{
    configuration: bigint
    aTokenAddress: Address
    stableDebtTokenAddress: Address
    variableDebtTokenAddress: Address
    accruedToTreasury: bigint
  }>(
    client,
    [{ address: pool, abi: aavePoolAbi, functionName: 'getReserveData', args: [input.token] }],
    input.block,
  )
  const reserve = unwrap(rd[0], `${tag}: Pool.getReserveData(${input.token})`)
  if (ZERO.test(reserve.aTokenAddress))
    throw new Error(`${tag}: ${input.token} is not a reserve of this pool`)
  const flags = decodeAaveConfig(reserve.configuration)

  const calls: Call[] = [
    {
      address: reserve.variableDebtTokenAddress,
      abi: erc20ReadAbi,
      functionName: 'balanceOf',
      args: [input.owner],
    },
    { address: reserve.aTokenAddress, abi: aaveScaledSupplyAbi, functionName: 'scaledTotalSupply' },
    {
      address: pool,
      abi: aavePoolAbi,
      functionName: 'getReserveNormalizedIncome',
      args: [input.token],
    },
  ]
  // v3.2+ keeps the field but no stable debt token behind it on some reserves.
  const hasStable = !ZERO.test(reserve.stableDebtTokenAddress)
  if (hasStable)
    calls.push({
      address: reserve.stableDebtTokenAddress,
      abi: erc20ReadAbi,
      functionName: 'balanceOf',
      args: [input.owner],
    })
  const res = await mc<bigint>(client, calls, input.block)
  const variableDebt = unwrap(res[0], `${tag}: variable debt token balanceOf(owner)`)
  const scaled = unwrap(res[1], `${tag}: aToken.scaledTotalSupply()`)
  const income = unwrap(res[2], `${tag}: Pool.getReserveNormalizedIncome()`)
  const stableDebt = hasStable ? unwrap(res[3], `${tag}: stable debt token balanceOf(owner)`) : 0n

  return {
    venue: {
      venue: 'aave',
      pool,
      flags,
      variableDebt,
      stableDebt,
      capRoom: aaveCapRoom(flags, scaled, reserve.accruedToTreasury, income),
    },
    action: {
      venue: 'aave',
      kind: input.kind,
      pool,
      asset: input.token,
      amount: input.amount,
      owner: input.owner,
    },
  }
}

async function readCompound(
  client: PublicClient,
  input: LeverReadInput,
): Promise<{ venue: VenueRead; action: LeverAction }> {
  const comet = input.marketId as Address | undefined
  if (!comet || !/^0x[0-9a-fA-F]{40}$/.test(comet))
    throw new Error('compound v3: the position names no Comet')
  const calls: Call[] = [
    { address: comet, abi: cometAbi, functionName: 'baseToken' },
    { address: comet, abi: cometAbi, functionName: 'isSupplyPaused' },
    { address: comet, abi: cometAbi, functionName: 'borrowBalanceOf', args: [input.owner] },
  ]
  if (input.kind === 'add') {
    calls.push({
      address: comet,
      abi: cometAbi,
      functionName: 'getAssetInfoByAddress',
      args: [input.token],
    })
    calls.push({
      address: comet,
      abi: cometAbi,
      functionName: 'totalsCollateral',
      args: [input.token],
    })
  }
  const res = await mc<unknown>(client, calls, input.block)
  const tag = `compound v3 (${comet})`
  const baseToken = unwrap(res[0], `${tag}: baseToken()`) as Address
  const supplyPaused = unwrap(res[1], `${tag}: isSupplyPaused()`) as boolean
  const borrow = unwrap(res[2], `${tag}: borrowBalanceOf(owner)`) as bigint
  let capRoom: bigint | null = null
  if (input.kind === 'add') {
    const info = unwrap(res[3], `${tag}: getAssetInfoByAddress(${input.token})`) as {
      supplyCap: bigint
    }
    const totals = unwrap(res[4], `${tag}: totalsCollateral(${input.token})`) as readonly bigint[]
    const total = totals[0]
    capRoom = info.supplyCap > total ? info.supplyCap - total : 0n
  }
  return {
    venue: { venue: 'compound', comet, baseToken, supplyPaused, borrow, capRoom },
    action: {
      venue: 'compound',
      kind: input.kind,
      comet,
      asset: input.token,
      amount: input.amount,
    },
  }
}

async function readMorpho(
  client: PublicClient,
  input: LeverReadInput,
): Promise<{ venue: VenueRead; action: LeverAction }> {
  const id = input.marketId as `0x${string}` | undefined
  if (!id || !/^0x[0-9a-fA-F]{64}$/.test(id))
    throw new Error('morpho blue: the position names no market id')
  const res = await mc<readonly unknown[]>(
    client,
    [
      {
        address: MORPHO_BLUE_MAINNET,
        abi: morphoAbi,
        functionName: 'idToMarketParams',
        args: [id],
      },
      {
        address: MORPHO_BLUE_MAINNET,
        abi: morphoAbi,
        functionName: 'position',
        args: [id, input.owner],
      },
      { address: MORPHO_BLUE_MAINNET, abi: morphoAbi, functionName: 'market', args: [id] },
    ],
    input.block,
  )
  const p = unwrap(res[0], `morpho blue: idToMarketParams(${id})`)
  const params: MorphoMarketParams = {
    loanToken: p[0] as Address,
    collateralToken: p[1] as Address,
    oracle: p[2] as Address,
    irm: p[3] as Address,
    lltv: p[4] as bigint,
  }
  const pos = unwrap(res[1], `morpho blue: position(${id}, owner)`)
  const market = unwrap(res[2], `morpho blue: market(${id})`)
  const borrowShares = pos[1] as bigint
  const sharesForAmount = morphoSharesDown(input.amount, market[2] as bigint, market[3] as bigint)
  return {
    venue: {
      venue: 'morpho',
      params,
      idMatches: same(morphoMarketId(params), id),
      borrowShares,
      sharesForAmount,
    },
    action: {
      venue: 'morpho',
      kind: input.kind,
      morpho: MORPHO_BLUE_MAINNET,
      params,
      amount: input.amount,
      owner: input.owner,
    },
  }
}

/** The read for one lever. Throws, naming the call, on any failure. */
export async function readLeverChain(
  client: PublicClient,
  input: LeverReadInput,
): Promise<LeverChainRead> {
  const { venue, action } =
    input.protocol === 'compound-v3'
      ? await readCompound(client, input)
      : input.protocol === 'morpho-blue'
        ? await readMorpho(client, input)
        : await readAave(client, input)
  const spender = spenderOf(action)
  const res = await mc<bigint | number>(
    client,
    [
      { address: input.token, abi: erc20ReadAbi, functionName: 'decimals' },
      { address: input.token, abi: erc20ReadAbi, functionName: 'balanceOf', args: [input.owner] },
      {
        address: input.token,
        abi: erc20ReadAbi,
        functionName: 'allowance',
        args: [input.owner, spender],
      },
    ],
    input.block,
  )
  return {
    block: input.block,
    decimals: Number(unwrap(res[0], `decimals() on ${input.token}`)),
    balance: BigInt(unwrap(res[1], `balanceOf(owner) on ${input.token}`)),
    allowance: BigInt(unwrap(res[2], `allowance(owner, ${spender}) on ${input.token}`)),
    venue,
    action,
  }
}
