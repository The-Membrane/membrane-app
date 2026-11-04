// Q41 bundle builder: decode every call back and check each argument against the Solidity test's
// bundle (contracts/migrator/test/MembraneMigration.t.sol _aaveBundle / _morphoBundle).

import { describe, expect, it } from 'vitest'
import { decodeAbiParameters, decodeFunctionData, keccak256, maxUint256, type Hex } from 'viem'

import { membraneBundlerAdapterAbi } from '@/contracts/abis/membraneBundlerAdapter'
import { aaveV3MigrationAdapterAbi, generalAdapter1Abi, morphoAbi, permitTokenAbi } from '@/lib/migrate/abis'
import {
  ZERO_HASH,
  buildAaveBundle,
  buildMorphoBundle,
  flashAmountFor,
  borrowCdtFor,
  type BundlerCall,
} from '@/lib/migrate/bundle'
import { matchPermitDomain } from '@/lib/migrate/permit'

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`
const GA1 = A(1), AAVE_AD = A(2), OWNER = A(3), USDC = A(4), WETH = A(5), AWETH = A(6), M_AD = A(7), MORPHO = A(8)
const DENOM = `0x${Buffer.from('WETH').toString('hex').padEnd(64, '0')}` as Hex

const CALLS = [
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

const sig = { v: 27, r: `0x${'11'.repeat(32)}` as Hex, s: `0x${'22'.repeat(32)}` as Hex }
const permit = (token: `0x${string}`, spender: `0x${string}`, value: bigint) => ({ token, owner: OWNER, spender, value, deadline: 99n, ...sig })

function inner(flash: BundlerCall): readonly BundlerCall[] {
  const d = decodeFunctionData({ abi: generalAdapter1Abi, data: flash.data })
  expect(d.functionName).toBe('morphoFlashLoan')
  const data = d.args![2] as Hex
  expect(flash.callbackHash).toBe(keccak256(data))
  return decodeAbiParameters(CALLS, data)[0] as readonly BundlerCall[]
}

describe('buildAaveBundle', () => {
  const flash = flashAmountFor(12_000_000_000n, 2)
  const b = buildAaveBundle({
    generalAdapter1: GA1,
    aaveAdapter: AAVE_AD,
    owner: OWNER,
    debtToken: USDC,
    collateralToken: WETH,
    aToken: AWETH,
    flashAmount: flash,
    aTokenAmount: 10n,
    membrane: { membraneAdapter: M_AD, denom: DENOM, borrowCdt: borrowCdtFor(flash, 6), maxLtvWad: 765n * 10n ** 15n },
    aTokenPermit: permit(AWETH, GA1, 10n),
    proceedsPermit: permit(USDC, M_AD, flash),
  })

  it('outer: two skipRevert permits, the flash loan, then the sweep of the unspent buffer', () => {
    expect(b).toHaveLength(4)
    const sw = decodeFunctionData({ abi: generalAdapter1Abi, data: b[3].data })
    expect(b[3].to).toBe(GA1)
    expect(sw).toMatchObject({ functionName: 'erc20Transfer', args: [USDC, OWNER, maxUint256] })
    expect(b[0]).toMatchObject({ to: AWETH, skipRevert: true, callbackHash: ZERO_HASH })
    expect(b[1]).toMatchObject({ to: USDC, skipRevert: true })
    const p = decodeFunctionData({ abi: permitTokenAbi, data: b[1].data })
    expect(p.functionName).toBe('permit')
    expect(p.args).toEqual([OWNER, M_AD, flash, 99n, 27, sig.r, sig.s])
    expect(b[2]).toMatchObject({ to: GA1, skipRevert: false })
    const f = decodeFunctionData({ abi: generalAdapter1Abi, data: b[2].data })
    expect(f.args!.slice(0, 2)).toEqual([USDC, flash])
  })

  it('inner: repay, sweep, aTokens in, withdraw to the Membrane adapter, Membrane leg', () => {
    const c = inner(b[2])
    expect(c.map((x) => x.to)).toEqual([GA1, AAVE_AD, AAVE_AD, GA1, AAVE_AD, M_AD])
    expect(c.every((x) => !x.skipRevert && x.callbackHash === ZERO_HASH)).toBe(true)
    const d = c.map((x, i) =>
      decodeFunctionData({ abi: i === 5 ? membraneBundlerAdapterAbi : x.to === GA1 ? generalAdapter1Abi : aaveV3MigrationAdapterAbi, data: x.data }),
    )
    expect(d[0]).toMatchObject({ functionName: 'erc20Transfer', args: [USDC, AAVE_AD, maxUint256] })
    expect(d[1]).toMatchObject({ functionName: 'aaveV3Repay', args: [USDC, maxUint256, 2n, OWNER] })
    expect(d[2]).toMatchObject({ functionName: 'erc20Transfer', args: [USDC, GA1, maxUint256] })
    expect(d[3]).toMatchObject({ functionName: 'erc20TransferFrom', args: [AWETH, AAVE_AD, 10n] }) // exactly the permitted aTokens
    expect(d[4]).toMatchObject({ functionName: 'aaveV3Withdraw', args: [WETH, maxUint256, M_AD] })
    // new position only (no id), exact borrow, LTV cap; the payout goes to the adapter's immutable GA1
    expect(d[5]).toMatchObject({ functionName: 'depositAndBorrowFor', args: [DENOM, flash * 10n ** 12n, USDC, 765n * 10n ** 15n] })
  })
})

describe('buildMorphoBundle', () => {
  const params = { loanToken: USDC, collateralToken: WETH, oracle: A(9), irm: A(10), lltv: 860000000000000000n }
  const b = buildMorphoBundle({
    generalAdapter1: GA1,
    morpho: MORPHO,
    owner: OWNER,
    params,
    flashAmount: 100n,
    maxSharePriceE27: maxUint256,
    membrane: { membraneAdapter: M_AD, denom: DENOM, borrowCdt: 100n * 10n ** 12n, maxLtvWad: 765n * 10n ** 15n },
    authorization: { authorizer: OWNER, authorized: GA1, isAuthorized: true, nonce: 0n, deadline: 99n, ...sig },
    proceedsPermit: null,
  })
  it('authorization first (skipRevert), the flash loan, then the sweep', () => {
    expect(b).toHaveLength(3)
    expect(b[0]).toMatchObject({ to: MORPHO, skipRevert: true })
    expect(decodeFunctionData({ abi: morphoAbi, data: b[0].data }).functionName).toBe('setAuthorizationWithSig')
  })
  it('inner: repay all shares, withdraw all collateral to the adapter, Membrane leg', () => {
    const c = inner(b[1])
    const d0 = decodeFunctionData({ abi: generalAdapter1Abi, data: c[0].data })
    expect(d0.functionName).toBe('morphoRepay')
    expect(d0.args!.slice(1, 5)).toEqual([0n, maxUint256, maxUint256, OWNER])
    const d1 = decodeFunctionData({ abi: generalAdapter1Abi, data: c[1].data })
    expect(d1).toMatchObject({ functionName: 'morphoWithdrawCollateral' })
    expect(d1.args!.slice(1)).toEqual([maxUint256, M_AD])
    expect(c[2].to).toBe(M_AD)
  })
})

describe('amounts', () => {
  it('proceeds = debt × (1 + 2 bps), rounded up', () => {
    expect(flashAmountFor(10_000n, 2)).toBe(10_002n)
    expect(flashAmountFor(1n, 2)).toBe(2n)
  })
  it('the borrow scales 6-decimal proceeds to 18', () => {
    expect(borrowCdtFor(1_000_000n, 6)).toBe(10n ** 18n)
    expect(borrowCdtFor(5n, 18)).toBe(5n)
  })
})

describe('permit domain', () => {
  it('picks the version whose hash matches DOMAIN_SEPARATOR (mainnet USDC uses "2")', () => {
    // USDC FiatTokenV2 on mainnet: DOMAIN_SEPARATOR() read 2026-10-25 via publicnode
    const sep = '0x06c37168a7db5138defc7866392bb87a741f9b3d104deb5094588ce041cae335' as Hex
    const d = matchPermitDomain('USD Coin', 1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', sep)
    expect(d?.version).toBe('2')
    expect(matchPermitDomain('USD Coin', 1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', ZERO_HASH)).toBeNull()
  })
})
