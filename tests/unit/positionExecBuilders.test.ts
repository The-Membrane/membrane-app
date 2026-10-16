// lib/position-exec/builders.ts and amount.ts — every call decoded back from its calldata.
// The selectors are the canonical signatures; the read-only mainnet check
// (scripts/position/lever-exec-ethcall.ts) ran each one from a real borrower without a revert.

import { describe, expect, it } from 'vitest'
import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  maxUint256,
  slice,
  toFunctionSelector,
} from 'viem'

import type { EvmCall } from '@/services/chain/types'
import { aavePoolAbi, cometAbi, erc20ApproveNoReturnAbi, morphoAbi } from '@/lib/position-exec/abis'
import { fmtUnits, leverDecimalString, leverUnits } from '@/lib/position-exec/amount'
import {
  AAVE_VARIABLE_RATE_MODE,
  aaveRepayCall,
  aaveSupplyCall,
  actionCall,
  approveCalls,
  cometSupplyCall,
  leverCalls,
  morphoMarketId,
  morphoRepayCall,
  morphoSupplyCollateralCall,
  spenderOf,
  tokenOf,
  type LeverAction,
  type MorphoMarketParams,
} from '@/lib/position-exec/builders'
import { ceilTo } from '@/lib/position/format'

const OWNER = getAddress('0x7ada000000000000000000000000000000d14200')
const POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' as const
const COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3' as const
const MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as const
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7' as const
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const
const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0' as const

/** wstETH/USDC 86%: idToMarketParams(0xb323…86cc) read on mainnet 2026-10-16. */
const WSTETH_USDC: MorphoMarketParams = {
  loanToken: USDC,
  collateralToken: WSTETH,
  oracle: '0x48F7E36EB6B826B2dF4B2E630B62Cd25e89E40e2',
  irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC',
  lltv: 860000000000000000n,
}
const WSTETH_USDC_ID = '0xb323495f7e4148be5643a4ea4a8221eef163e4bccfdedc2a6f4696baacbc86cc'

/** Encode, then decode with the same ABI: what the wallet will be asked to sign. */
function decoded(c: EvmCall) {
  const data = encodeFunctionData({
    abi: c.abi,
    functionName: c.functionName,
    args: c.args as never,
  })
  const { functionName, args } = decodeFunctionData({ abi: c.abi, data })
  return { to: c.address, selector: slice(data, 0, 4), functionName, args: args ?? [] }
}

describe('lever amounts: the display string, parsed once at the token decimals', () => {
  it('converts at 6 decimals (USDC) and 18 decimals (WETH) exactly', () => {
    expect(leverUnits(460, 0, 6)).toBe(460_000_000n)
    expect(leverUnits(15_680, 0, 6)).toBe(15_680_000_000n)
    expect(leverUnits(0.29, 2, 18)).toBe(290_000_000_000_000_000n)
    expect(leverUnits(4_810, 0, 18)).toBe(4_810n * 10n ** 18n)
    expect(leverUnits(0.0001, 4, 8)).toBe(10_000n) // a BTC-family step at WBTC's 8 decimals
  })
  it('never carries float noise into units', () => {
    // 0.1 + 0.2 and a ceilTo multiple both print as their step's decimals.
    expect(leverUnits(0.1 + 0.2, 2, 18)).toBe(300_000_000_000_000_000n)
    const x = ceilTo(0.2800000001, 0.01)
    expect(leverDecimalString(x, 2)).toBe('0.29')
    expect(leverUnits(x, 2, 6)).toBe(290_000n)
  })
  it('refuses a display with more decimals than the token, a zero, and a non-number', () => {
    expect(() => leverUnits(0.123, 3, 2)).toThrow(/more decimals than the token/)
    expect(() => leverUnits(0, 0, 6)).toThrow(/positive/)
    expect(() => leverUnits(Number.NaN, 0, 6)).toThrow(/positive/)
    expect(() => leverUnits(1, 1.5, 6)).toThrow(/integer/)
  })
  it('prints units cut down, never rounded up', () => {
    expect(fmtUnits(12_400_529_999n, 6, 2)).toBe('12,400.52')
    expect(fmtUnits(965_664n, 6, 2)).toBe('0.96')
    expect(fmtUnits(10n ** 18n, 18, 0)).toBe('1')
  })
})

describe('approvals: exact amount, never unlimited; USDT zero-first', () => {
  const amount = 460_000_000n
  it('emits nothing when the standing allowance covers the amount', () => {
    expect(approveCalls({ token: USDC, spender: POOL, amount, allowance: amount })).toEqual([])
    expect(approveCalls({ token: USDC, spender: POOL, amount, allowance: maxUint256 })).toEqual([])
  })
  it('approves exactly the amount from zero', () => {
    const calls = approveCalls({ token: USDC, spender: POOL, amount, allowance: 0n })
    expect(calls).toHaveLength(1)
    const d = decoded(calls[0])
    expect(d.to).toBe(USDC)
    expect(d.selector).toBe(toFunctionSelector('approve(address,uint256)'))
    expect(d.selector).toBe('0x095ea7b3')
    expect(d.args).toEqual([POOL, amount])
    expect(d.args[1]).not.toBe(maxUint256)
  })
  it('resets a smaller standing allowance to 0 first (USDT reverts on non-zero → non-zero)', () => {
    const calls = approveCalls({ token: USDT, spender: COMET, amount, allowance: 1n })
    expect(calls.map((c) => decoded(c).args)).toEqual([
      [COMET, 0n],
      [COMET, amount],
    ])
    expect(calls.every((c) => c.address === USDT)).toBe(true)
  })
  it("declares no return value, so USDT's empty return decodes (viem's erc20Abi would not)", () => {
    expect(erc20ApproveNoReturnAbi[0].outputs).toEqual([])
    expect(
      decodeFunctionResult({ abi: erc20ApproveNoReturnAbi, functionName: 'approve', data: '0x' }),
    ).toBeUndefined()
    expect(() =>
      decodeFunctionResult({ abi: erc20Abi, functionName: 'approve', data: '0x' }),
    ).toThrow()
  })
  it('refuses a zero or negative lever amount', () => {
    expect(() => approveCalls({ token: USDC, spender: POOL, amount: 0n, allowance: 0n })).toThrow(
      /positive/,
    )
  })
})

describe('Aave V3 / Spark', () => {
  it('repay(asset, amount, 2, onBehalfOf): variable rate, the owner', () => {
    const d = decoded(
      aaveRepayCall({ pool: POOL, asset: USDC, amount: 460_000_000n, onBehalfOf: OWNER }),
    )
    expect(d.to).toBe(POOL)
    expect(d.selector).toBe('0x573ade81')
    expect(d.selector).toBe(toFunctionSelector('repay(address,uint256,uint256,address)'))
    expect(d.functionName).toBe('repay')
    expect(d.args).toEqual([USDC, 460_000_000n, 2n, OWNER])
    expect(AAVE_VARIABLE_RATE_MODE).toBe(2n)
  })
  it('supply(asset, amount, onBehalfOf, 0)', () => {
    const d = decoded(
      aaveSupplyCall({
        pool: POOL,
        asset: WETH,
        amount: 290_000_000_000_000_000n,
        onBehalfOf: OWNER,
      }),
    )
    expect(d.selector).toBe('0x617ba037')
    expect(d.args).toEqual([WETH, 290_000_000_000_000_000n, OWNER, 0])
  })
})

describe('Compound V3', () => {
  it('supply(asset, amount) on the Comet', () => {
    const d = decoded(cometSupplyCall({ comet: COMET, asset: USDC, amount: 1_440_000_000n }))
    expect(d.to).toBe(COMET)
    expect(d.selector).toBe('0xf2b9fdb8')
    expect(d.args).toEqual([USDC, 1_440_000_000n])
  })
})

describe('Morpho Blue', () => {
  it('derives the market id from its params (MarketParamsLib.id)', () => {
    expect(morphoMarketId(WSTETH_USDC)).toBe(WSTETH_USDC_ID)
    expect(morphoMarketId({ ...WSTETH_USDC, lltv: 915000000000000000n })).not.toBe(WSTETH_USDC_ID)
  })
  it('repay(marketParams, assets, 0, onBehalf, 0x): by assets, shares zero', () => {
    const d = decoded(
      morphoRepayCall({
        morpho: MORPHO,
        params: WSTETH_USDC,
        assets: 5_980_000_000n,
        onBehalf: OWNER,
      }),
    )
    expect(d.to).toBe(MORPHO)
    expect(d.selector).toBe(
      toFunctionSelector(
        'repay((address,address,address,address,uint256),uint256,uint256,address,bytes)',
      ),
    )
    expect(d.args).toEqual([WSTETH_USDC, 5_980_000_000n, 0n, OWNER, '0x'])
  })
  it('supplyCollateral(marketParams, assets, onBehalf, 0x)', () => {
    const d = decoded(
      morphoSupplyCollateralCall({
        morpho: MORPHO,
        params: WSTETH_USDC,
        assets: 10n ** 17n,
        onBehalf: OWNER,
      }),
    )
    expect(d.selector).toBe(
      toFunctionSelector(
        'supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)',
      ),
    )
    expect(d.args).toEqual([WSTETH_USDC, 10n ** 17n, OWNER, '0x'])
  })
})

describe('one lever: approvals, then the action, pulled by the contract approved', () => {
  const cases: [string, LeverAction, string, string][] = [
    [
      'aave repay',
      { venue: 'aave', kind: 'repay', pool: POOL, asset: USDC, amount: 460_000_000n, owner: OWNER },
      USDC,
      POOL,
    ],
    [
      'aave add',
      { venue: 'aave', kind: 'add', pool: POOL, asset: WETH, amount: 10n ** 17n, owner: OWNER },
      WETH,
      POOL,
    ],
    [
      'comet repay',
      { venue: 'compound', kind: 'repay', comet: COMET, asset: USDC, amount: 1_440_000_000n },
      USDC,
      COMET,
    ],
    [
      'morpho repay',
      {
        venue: 'morpho',
        kind: 'repay',
        morpho: MORPHO,
        params: WSTETH_USDC,
        amount: 5_980_000_000n,
        owner: OWNER,
      },
      USDC,
      MORPHO,
    ],
    [
      'morpho add',
      {
        venue: 'morpho',
        kind: 'add',
        morpho: MORPHO,
        params: WSTETH_USDC,
        amount: 10n ** 17n,
        owner: OWNER,
      },
      WSTETH,
      MORPHO,
    ],
  ]
  it.each(cases)('%s', (_name, action, token, spender) => {
    expect(tokenOf(action)).toBe(token)
    expect(spenderOf(action)).toBe(spender)
    const fromZero = leverCalls(action, 0n).map(decoded)
    expect(fromZero).toHaveLength(2)
    expect(fromZero[0]).toMatchObject({
      to: token,
      functionName: 'approve',
      args: [spender, action.amount],
    })
    expect(fromZero[1].to).toBe(spender)
    expect(fromZero[1]).toEqual(decoded(actionCall(action)))
    // The action's amount is the approval's amount, to the unit.
    expect(fromZero[1].args).toContain(action.amount)
    expect(leverCalls(action, action.amount).map(decoded)).toEqual([fromZero[1]])
    expect(leverCalls(action, 1n)).toHaveLength(3)
  })
  it('names the owner as onBehalfOf wherever the venue takes one', () => {
    for (const [, action] of cases) {
      const d = decoded(actionCall(action))
      if (action.venue === 'compound') expect(d.args).not.toContain(OWNER)
      else expect(d.args).toContain(OWNER)
    }
  })
  it('uses only the fragments it declares', () => {
    expect(aavePoolAbi.some((x) => x.type === 'function' && x.name === 'repay')).toBe(true)
    expect(cometAbi.some((x) => x.type === 'function' && x.name === 'supply')).toBe(true)
    expect(morphoAbi.some((x) => x.type === 'function' && x.name === 'supplyCollateral')).toBe(true)
  })
})
