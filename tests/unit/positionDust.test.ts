// lib/position-exec/dust.ts — which supply positions qualify as dust, the sweep's calls,
// and the warning when the gas costs more than the dust returns. Plus the design states
// built from the captured real reads (components/PositionV0/dev/dustStates.ts).

import { decodeFunctionData, encodeFunctionData, maxUint256 } from 'viem'
import { describe, expect, it } from 'vitest'

import { DUST_STATES } from '@/components/PositionV0/dev/dustStates'
import { aavePoolAbi, morphoAbi } from '@/lib/position-exec/abis'
import {
  DUST_USD,
  aboutUsd,
  dustCalls,
  dustGates,
  dustPrep,
  dustRow,
  dustTotals,
  dustVerdict,
  dustWarningText,
  splitDust,
  type DustCandidate,
} from '@/lib/position-exec/dust'
import { sheetView, TX_IDLE } from '@/lib/position-exec/sheet'
import type { SimResult } from '@/lib/position-exec/simulate'

const OWNER = '0x711a68a82dd80cb0435b281af76b0b80804efab9' as const
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const
const PARAMS = {
  loanToken: USDC,
  collateralToken: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf',
  oracle: '0x663becd10dae6c4a3dcd89f1d76c1174199639b9',
  irm: '0x870ac11d48b15db9a138cf899d20f13f79ba00bc',
  lltv: 860000000000000000n,
} as const

const morpho = (o: Partial<{ assets: bigint; shares: bigint; priceUsd: number | null }> = {}): DustCandidate => ({
  venue: 'morpho-blue',
  label: 'Morpho · cbBTC/USDC 86%',
  symbol: 'USDC',
  token: USDC,
  decimals: 6,
  assets: o.assets ?? 0n,
  priceUsd: o.priceUsd === undefined ? 1 : o.priceUsd,
  morpho: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
  marketId: '0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64',
  params: PARAMS,
  shares: o.shares ?? 123_456n,
})

const aave = (o: Partial<{ assets: bigint; priceUsd: number | null; paused: boolean; decimals: number }> = {}): DustCandidate => ({
  venue: 'aave-v3',
  label: 'Aave V3 · USDT',
  symbol: 'USDT',
  token: '0xdac17f958d2ee523a2206206994597c13d831ec7',
  decimals: o.decimals ?? 6,
  assets: o.assets ?? 983_572n,
  priceUsd: o.priceUsd === undefined ? 0.9987 : o.priceUsd,
  pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  paused: o.paused ?? false,
})

/** A passing simulation of `gas` units at `gwei` per gas (fee cap). */
const sim = (gas: bigint, gwei: number): SimResult => ({
  ok: true,
  method: 'eth_simulateV1',
  gas: [gas],
  bufferedGas: gas,
  maxFeePerGas: BigInt(Math.round(gwei * 1e9)),
})

describe('which positions qualify', () => {
  it('a Morpho supply whose shares round to no asset is dust, priced or not', () => {
    expect(dustVerdict(morpho({ assets: 0n }))).toEqual({ dust: true, why: 'zero' })
    expect(dustVerdict(morpho({ assets: 0n, priceUsd: null }))).toEqual({ dust: true, why: 'zero' })
  })
  it('a priced position under $1 is dust; at $1 or more it is kept', () => {
    expect(DUST_USD).toBe(1)
    expect(dustVerdict(morpho({ assets: 1_193n }))).toEqual({ dust: true, why: 'under' })
    expect(dustVerdict(aave({ assets: 999_999n, priceUsd: 1 }))).toEqual({ dust: true, why: 'under' })
    expect(dustVerdict(aave({ assets: 1_000_000n, priceUsd: 1 }))).toEqual({ dust: false, why: 'worth' })
    expect(dustVerdict(morpho({ assets: 194_838_616n }))).toEqual({ dust: false, why: 'worth' })
  })
  it('a position with assets but no price is never called dust', () => {
    expect(dustVerdict(aave({ assets: 5n, priceUsd: null }))).toEqual({ dust: false, why: 'unpriced' })
  })
  it('a position that holds nothing is not a position', () => {
    expect(dustVerdict(morpho({ shares: 0n }))).toEqual({ dust: false, why: 'empty' })
    expect(dustVerdict(aave({ assets: 0n }))).toEqual({ dust: false, why: 'empty' })
  })
  it('splits held positions into dust and left alone, dropping the empty', () => {
    const { dust, kept } = splitDust([
      morpho({ assets: 0n }),
      morpho({ shares: 0n }),
      morpho({ assets: 194_838_616n }),
      aave({ assets: 5n, priceUsd: null }),
      aave(),
    ])
    expect(dust).toHaveLength(2)
    expect(kept.map((k) => k.why)).toEqual(['worth', 'unpriced'])
  })
})

describe('the sweep', () => {
  it('Morpho withdraws by shares (assets 0) to the owner; Aave withdraws the max', () => {
    const calls = dustCalls(OWNER, [morpho({ assets: 0n, shares: 777n }), aave()])
    const m = decodeFunctionData({ abi: morphoAbi, data: encode(calls[0]) })
    expect(m.functionName).toBe('withdraw')
    expect(m.args!.slice(1).map((x) => (typeof x === 'string' ? x.toLowerCase() : x))).toEqual([
      0n,
      777n,
      OWNER,
      OWNER,
    ])
    const a = decodeFunctionData({ abi: aavePoolAbi, data: encode(calls[1]) })
    expect(a.functionName).toBe('withdraw')
    expect(a.args!.map((x) => (typeof x === 'string' ? x.toLowerCase() : x))).toEqual([
      '0xdac17f958d2ee523a2206206994597c13d831ec7',
      maxUint256,
      OWNER,
    ])
  })
  it('refuses a position that is not dust', () => {
    expect(() => dustCalls(OWNER, [aave({ assets: 50_000_000n, priceUsd: 1 })])).toThrow(/not dust/)
  })
  it('says honestly what each row returns', () => {
    expect(dustRow(morpho({ assets: 0n })).line).toMatch(/You receive 0 USDC.*clears the position/)
    const r = dustRow(morpho({ assets: 1_193n }))
    expect(r.receive).toBe('0.0011 USDC')
    expect(r.line).toMatch(/under 1 unit\. This clears the position/)
  })
  it('a paused Aave reserve blocks the sweep; Morpho has no switch', () => {
    const g = dustGates([morpho(), aave({ paused: true })])
    expect(g.map((x) => x.ok)).toEqual([true, false])
    const prep = dustPrep([aave({ paused: true })], null)
    const v = sheetView(prep, { connected: true, address: OWNER, chainId: 1 }, TX_IDLE, OWNER)
    expect(v.button).toMatchObject({ kind: 'wait', enabled: false })
    expect(v.notice).toMatch(/paused/)
  })
})

describe('dollar wording', () => {
  it('an estimate says "about"; a bound or zero does not', () => {
    expect(aboutUsd(0.43)).toBe('about $0.43')
    expect(aboutUsd(0.0012)).toBe('under $0.01')
    expect(aboutUsd(0)).toBe('$0')
  })
  it('no row, total or warning ever reads "about under"', () => {
    const rows = [morpho({ assets: 1_193n }), morpho({ assets: 0n }), aave()]
    const texts = [
      ...rows.map((c) => dustRow(c).line),
      dustWarningText(dustTotals([morpho({ assets: 1_193n })], sim(400_000n, 0.08), 2_400)),
      dustWarningText(dustTotals([morpho({ assets: 0n })], sim(10_000n, 0.1), 2_400)),
      ...DUST_STATES.flatMap((s) => {
        const t = dustTotals(s.dust, s.sim, s.ethUsd)
        return [...t.rows.map((r) => r.line), dustWarningText(t)]
      }),
    ]
    for (const t of texts) expect(t ?? '').not.toMatch(/about under|about \$0(?!\.)/)
    expect(dustRow(morpho({ assets: 1_193n })).line).toMatch(/0\.0011 USDC, under \$0\.01, under 1 unit/)
  })
})

describe('gas against value', () => {
  const ETH = 2_400
  it('no warning when the dust returns more than the gas costs', () => {
    // 100k gas at 0.1 gwei = 0.00001 ETH = $0.024, for $0.98 back
    const t = dustTotals([aave()], sim(100_000n, 0.1), ETH)
    expect(t.gasUsd).toBeCloseTo(0.024, 6)
    expect(t.receiveUsd).toBeCloseTo(0.9823, 3)
    expect(t.warning).toBeNull()
    expect(dustWarningText(t)).toBeNull()
  })
  it('warns when the gas costs more than the dust returns', () => {
    const t = dustTotals([morpho({ assets: 1_193n })], sim(400_000n, 0.08), ETH)
    expect(t.warning).toBe('gas-exceeds')
    expect(dustWarningText(t)).toMatch(/^Gas costs more than you receive: about \$0\.08 of gas for under \$0\.01 back$/)
  })
  it('says "you receive nothing" when every row pays 0', () => {
    const t = dustTotals([morpho({ assets: 0n }), morpho({ assets: 0n })], sim(180_000n, 0.08), ETH)
    expect(t.warning).toBe('nothing')
    expect(dustWarningText(t)).toMatch(/^You receive nothing\. This only clears 2 positions, for about \$0\.03 of gas$/)
  })
  it('gives no gas figure before the simulation, and so no gas warning', () => {
    const t = dustTotals([morpho({ assets: 1_193n })], null, ETH)
    expect(t.gasUsd).toBeNull()
    expect(t.warning).toBeNull()
  })
})

describe('dust design states (captured real reads)', () => {
  const by = (k: string) => DUST_STATES.find((s) => s.key === k)!
  it('has the three states the owner asked for', () => {
    expect(DUST_STATES.map((s) => s.key)).toEqual([
      'dust-ready',
      'dust-nothing-to-receive',
      'dust-gas-exceeds-value',
    ])
  })
  it('each is ready to sign as read, with its warning', () => {
    const w = (k: string) => dustTotals(by(k).dust, by(k).sim, by(k).ethUsd).warning
    for (const s of DUST_STATES) expect(s.sheet.button).toMatchObject({ kind: 'sign', enabled: true })
    expect(w('dust-ready')).toBeNull()
    expect(w('dust-nothing-to-receive')).toBe('nothing')
    expect(w('dust-gas-exceeds-value')).toBe('gas-exceeds')
    expect(by('dust-nothing-to-receive').dust.every((c) => c.assets === 0n)).toBe(true)
  })
  it('the lender read holds zero-asset Morpho supplies and keeps the one worth more', () => {
    const s = by('dust-gas-exceeds-value')
    expect(s.owner).toBe(OWNER)
    expect(s.dust.filter((c) => c.assets === 0n).length).toBeGreaterThanOrEqual(3)
    expect(s.kept.length).toBeGreaterThanOrEqual(1)
  })
})

function encode(c: ReturnType<typeof dustCalls>[number]) {
  return encodeFunctionData({
    abi: c.abi,
    functionName: c.functionName,
    args: c.args ?? [],
  } as Parameters<typeof encodeFunctionData>[0])
}
