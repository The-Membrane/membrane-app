/**
 * Live wavefront engine — event decoding of both liquidation topics on REAL logs (an Arbitrum
 * Aave V3 LiquidationCall and a Base Morpho Blue Liquidate from 2025-10-10, as eth_getLogs
 * returned them), token-unit normalisation, and the state JSON codec.
 */
import { describe, expect, it } from 'vitest'

import {
  AAVE_LIQUIDATION_CALL_TOPIC,
  CHAIN_CONFIG,
  aaveProtocolFee,
  type ChainKey,
  MORPHO_LIQUIDATE_TOPIC,
  decodeLiquidation,
  eventKey,
  liveEndpoints,
  normUnits,
  parseState,
  stringifyState,
  type RawLog,
} from '@/lib/wavefront/live'
import { isExcludedLogHost } from '@/lib/position-sim/rpcExclusions'
import { aavePid, legacyPid, morphoPid, parseAnyPid } from '@/lib/wavefront/pid'

const EM = (c: ChainKey) => ({ aavePools: new Set([CHAIN_CONFIG[c].aavePool]), morpho: CHAIN_CONFIG[c].morpho })

// arbitrum block 387914928 (0x171f1cb0), tx 0x06556e0c…0b22 log 15: the first row of
// aave_liquidations_enriched.csv (USDC.e against USDC.e, debt_to_cover 29745612, liquidated
// 31084165, user 0x4a12…77a3).
const AAVE_LOG: RawLog = {
  address: '0x794a61358d6845594f94dc1db02a252b5b4814ad',
  topics: [
    '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286',
    '0x000000000000000000000000ff970a61a04b1ca14834a43f5de4533ebddb5cc8',
    '0x000000000000000000000000ff970a61a04b1ca14834a43f5de4533ebddb5cc8',
    '0x0000000000000000000000004a12850573836260d8103134698e343e42af77a3',
  ],
  data: '0x0000000000000000000000000000000000000000000000000000000001c5e1cc0000000000000000000000000000000000000000000000000000000001da4e85000000000000000000000000545875b6975eb527726c87b82b5f031ed861de8a0000000000000000000000000000000000000000000000000000000000000000',
  blockNumber: '0x171f1cb0',
  transactionHash: '0x06556e0c190bbbb69ef9841b41b6b468ae4185ef382d2b3919c640012d950b22',
  blockHash: '0x8b3373e3c75115ae6ae467a8d716eeb8b7191c56731d95aef539f1092b8fe32c',
  logIndex: '0xf',
  removed: false,
}

// base block 36642938 (0x22f207a), tx 0xe9b73136…2eee log 524: the first Base row of
// morpho_liquidations.csv (repaid 99235741, shares 98000000000000, seized
// 312811395451210564930300, no bad debt).
const MORPHO_LOG: RawLog = {
  address: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb',
  topics: [
    '0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41',
    '0xf4254bb9db550a5e61302b0db6d90f29ceda324496e9783b93d7da054bb33635',
    '0x000000000000000000000000be3b7e4e4a69b4c8b66fd28eddc9a5776b597ed8',
    '0x00000000000000000000000005324573250a1ea61249ac04f0cf9208bade4950',
  ],
  data: '0x0000000000000000000000000000000000000000000000000000000005ea379d000000000000000000000000000000000000000000000000000059216730200000000000000000000000000000000000000000000000423d8a2b811280848afc00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  blockNumber: '0x22f207a',
  transactionHash: '0xe9b73136a6b8f4f17aa922b183c1961b08a02503a7be384c9374dc7898442eee',
  blockHash: '0x0e7a90efc7e23b7cf3925525c0036d1387221526e495684338258ca2635c304c',
  logIndex: '0x20c',
  removed: false,
}

describe('live engine: event decoding', () => {
  it('topics are the verified ones', () => {
    expect(AAVE_LIQUIDATION_CALL_TOPIC).toBe(AAVE_LOG.topics[0])
    expect(MORPHO_LIQUIDATE_TOPIC).toBe(MORPHO_LOG.topics[0])
  })

  it('decodes an Aave V3 LiquidationCall to the CSV row', () => {
    const e = decodeLiquidation('arbitrum', AAVE_LOG, EM('arbitrum'))
    expect(e).toMatchObject({
      protocol: 'aave-v3',
      chain: 'arbitrum',
      block: 387914928,
      logIndex: 15,
      tx: '0x06556e0c190bbbb69ef9841b41b6b468ae4185ef382d2b3919c640012d950b22',
      pool: '0x794a61358d6845594f94dc1db02a252b5b4814ad',
      pid: 'aave-v3:arbitrum:0x794a61358d6845594f94dc1db02a252b5b4814ad:0x4a12850573836260d8103134698e343e42af77a3',
      collateralAsset: '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8',
      debtAsset: '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8',
      user: '0x4a12850573836260d8103134698e343e42af77a3',
      debtToCover: '29745612',
      liquidatedCollateralAmount: '31084165',
      liquidator: '0x545875b6975eb527726c87b82b5f031ed861de8a',
      receiveAToken: false,
    })
    expect(eventKey(e)).toBe('arbitrum:0x06556e0c190bbbb69ef9841b41b6b468ae4185ef382d2b3919c640012d950b22:15')
    // The CSV's normalised columns.
    expect(normUnits(e.protocol === 'aave-v3' ? e.debtToCover : '', 6)).toBe(29.745612)
  })

  it('decodes a Morpho Blue Liquidate to the CSV row', () => {
    const e = decodeLiquidation('base', MORPHO_LOG, EM('base'))
    expect(e).toMatchObject({
      protocol: 'morpho-blue',
      chain: 'base',
      block: 36642938,
      logIndex: 524,
      marketId: '0xf4254bb9db550a5e61302b0db6d90f29ceda324496e9783b93d7da054bb33635',
      pid: 'morpho-blue:base:0xf4254bb9db550a5e61302b0db6d90f29ceda324496e9783b93d7da054bb33635:0x05324573250a1ea61249ac04f0cf9208bade4950',
      caller: '0xbe3b7e4e4a69b4c8b66fd28eddc9a5776b597ed8',
      borrower: '0x05324573250a1ea61249ac04f0cf9208bade4950',
      repaidAssets: '99235741',
      repaidShares: '98000000000000',
      seizedAssets: '312811395451210564930300',
      badDebtAssets: '0',
      badDebtShares: '0',
    })
  })

  it('refuses a log from another emitter, a foreign topic or a bad shape', () => {
    expect(() =>
      decodeLiquidation('arbitrum', { ...AAVE_LOG, address: '0x0000000000000000000000000000000000000001' }, EM('arbitrum')),
    ).toThrow(/not an Aave V3 pool/)
    expect(() =>
      decodeLiquidation('base', { ...MORPHO_LOG, address: CHAIN_CONFIG.base.aavePool }, EM('base')),
    ).toThrow(/not Morpho Blue/)
    expect(() =>
      decodeLiquidation('arbitrum', { ...AAVE_LOG, topics: ['0x' + '12'.repeat(32)] }, EM('arbitrum')),
    ).toThrow(/unexpected topic/)
    expect(() =>
      decodeLiquidation('arbitrum', { ...AAVE_LOG, data: AAVE_LOG.data.slice(0, 130) }, EM('arbitrum')),
    ).toThrow(/bad shape/)
  })

  it('a LiquidationCall from another registry pool decodes to that pool\'s pid', () => {
    const lido = '0x4e033931ad43597d96d6bcc25c280717730b58b1'
    const e = decodeLiquidation(
      'mainnet',
      { ...AAVE_LOG, address: lido },
      { aavePools: new Set([CHAIN_CONFIG.mainnet.aavePool, lido]), morpho: CHAIN_CONFIG.mainnet.morpho },
    )
    expect(e.pid).toBe(`aave-v3:mainnet:${lido}:0x4a12850573836260d8103134698e343e42af77a3`)
  })
})

describe('live engine: position ids', () => {
  it('Aave pids carry the pool; the legacy (census) id is recoverable', () => {
    const pid = aavePid('mainnet', '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', '0xABC')
    expect(pid).toBe('aave-v3:mainnet:0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2:0xabc')
    expect(parseAnyPid(pid)).toEqual({
      protocol: 'aave-v3',
      chain: 'mainnet',
      market: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
      addr: '0xabc',
    })
    expect(legacyPid(pid)).toBe('aave-v3:mainnet:0xabc')
    expect(parseAnyPid('aave-v3:base:0xabc').market).toBeNull()
    const m = morphoPid('base', '0xF4', '0xB0')
    expect(m).toBe('morpho-blue:base:0xf4:0xb0')
    expect(legacyPid(m)).toBe(m)
    expect(() => parseAnyPid('aave-v3:base')).toThrow(/bad pid/)
  })
})

describe('live engine: the Aave liquidation protocol fee', () => {
  // Oct 10 2025 LiquidationCalls (pool revision 9): the event's liquidatedCollateralAmount (L),
  // the collateral reserve's liquidation bonus and protocol fee at N-1 (the e-mode category's
  // bonus for the Optimism e-mode one), and the fee the receipt shows going to the treasury
  // (the collateral aToken's Transfer(user -> RESERVE_TREASURY_ADDRESS)). Every one exact.
  const CASES: [string, bigint, bigint, bigint, bigint][] = [
    ['arbitrum 0x06556e0c', 31084165n, 10500n, 1000n, 148728n],
    ['arbitrum 0x7133b19d', 44739703232314899n, 10500n, 1000n, 214065565704856n],
    ['arbitrum 0xcca397fa', 23125796n, 10700n, 1000n, 152287n],
    ['arbitrum 0x905cfcb1', 94078413116279966673n, 11000n, 1000n, 863104707488807034n],
    ['base 0xaa5e9f66', 369359236398749394n, 10500n, 1000n, 1767269073678227n],
    ['mainnet 0x2b943680', 185493629n, 10500n, 1000n, 887529n],
    ['mainnet 0x4911e0f3', 14314158799842254917n, 10500n, 1000n, 68488798085369641n],
    ['optimism 0x60148a44', 462833704999520321248n, 11000n, 1000n, 4246180779812113039n],
    ['optimism 0xd77f78b1 (e-mode)', 7528203613149237039334n, 11000n, 1000n, 69066088194029697609n],
    ['optimism 0xdef49f30', 289359505370925606660n, 11000n, 1000n, 2654674361201152355n],
    ['optimism 0x5ba61451', 103299548234263789n, 11000n, 1000n, 947702277378567n],
  ]
  it.each(CASES)('%s', (_n, L, bonus, feePct, onChain) => {
    expect(aaveProtocolFee(L, bonus, feePct, 9)).toBe(onChain)
  })
  it('no fee when the reserve charges none or the bonus is nil', () => {
    expect(aaveProtocolFee(10n ** 18n, 10500n, 0n, 9)).toBe(0n)
    expect(aaveProtocolFee(10n ** 18n, 10000n, 1000n, 9)).toBe(0n)
  })
})

describe('live engine: units, state codec, endpoints', () => {
  it('normUnits is the correctly rounded exact decimal (the CSV values)', () => {
    // CSV row 2 of aave_liquidations_enriched.csv: 416176339453362158 wei -> 0.41617633945336213
    expect(normUnits('416176339453362158', 18)).toBe(0.41617633945336213)
    expect(normUnits('43102162337902', 18)).toBe(4.3102162337902e-5)
    expect(normUnits(0n, 6)).toBe(0)
  })

  it('state JSON keeps non-finite numbers and bigints', () => {
    const v = { a: -Infinity, b: [Infinity, NaN, 1.5], c: { d: 10n }, e: null }
    const back = parseState<typeof v>(stringifyState(v))
    expect(back.a).toBe(-Infinity)
    expect(back.b[0]).toBe(Infinity)
    expect(Number.isNaN(back.b[1])).toBe(true)
    expect(back.b[2]).toBe(1.5)
    expect(back.c.d).toBe('10')
    expect(back.e).toBeNull()
  })

  it('the endpoint tables never ask an excluded relay or Pocket for logs', () => {
    for (const mode of ['live', 'historical'] as const) {
      const t = liveEndpoints(mode)
      for (const [chain, list] of Object.entries(t)) {
        const logs = list.filter((e) => !e.noLogs)
        expect(logs.length, `${mode} ${chain}`).toBeGreaterThan(0)
        for (const e of logs) {
          expect(isExcludedLogHost(e.url)).toBe(false)
          expect(e.group).not.toBe('pokt')
        }
        // At least two independent logs groups, so every empty answer can be re-asked.
        expect(new Set(logs.map((e) => e.group)).size, `${mode} ${chain}`).toBeGreaterThanOrEqual(2)
      }
    }
  })
})
